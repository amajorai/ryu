//! The broker listener: a loopback HTTP forward proxy.
//!
//! * Absolute-form requests (`GET http://host/path`) are forwarded directly.
//! * `CONNECT host:port` to a host some service covers is intercepted: the
//!   broker answers `200`, terminates TLS with a leaf from its CA, and serves
//!   the tunneled HTTP/1.1 requests itself.
//! * `CONNECT` to any other host follows the environment's unmatched-host
//!   policy: a raw tunnel (`passthrough`) or a 403 (`deny`).
//! * A WebSocket upgrade (absolute-form or inside an intercepted tunnel) is
//!   authorized like any request and gets its handshake credentials; the
//!   upgraded connection is then relayed, with `websocket` placeholders
//!   substituted in client text messages (see `websocket.rs`).
//!
//! Every request is authenticated by an `rvb_` session in
//! `Proxy-Authorization`, rate limited per session, matched against the
//! session environment's services, and logged without values. A session is
//! re-checked on every request inside an intercepted tunnel, and every open
//! tunnel closes once its session is revoked or expires (or the machine token
//! that minted it is revoked); each session holds a bounded number of
//! concurrent tunnels. Paths with dot segments are refused, so URL
//! normalization cannot move a request outside a service's path prefix. Upstream
//! connections use normal certificate verification and the dial-time
//! [`NetGuard`]; the broker never follows redirects, so a `Location` cannot
//! carry an injected credential to another host.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use bytes::Bytes;
use futures_util::StreamExt as _;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt as _, Empty, Full, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rustls::crypto::CryptoProvider;
use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};

use super::ca::{self, LeafCache};
use super::log::{self, LogRow};
use super::netguard::{GuardedResolver, NetGuard};
use super::oauth::OAuthTokens;
use super::ratelimit::RateLimiter;
use super::services::{self, BrokerService, MatchOutcome, ServiceAuth};
use super::sessions::{self, BrokerSession, MinterScope};
use super::settings::{self, EnvironmentSettings, UnmatchedHostPolicy};
use super::substitute::{self, Surface};
use super::BrokerConfig;
use crate::identity::ConnectionAction;
use crate::plugin_secrets::{PluginSecretStore, SecretResolutionContext};
use crate::vault::items::cards::{self, CardBinding, CardChannel, CardUseOutcome, CardUseRequest};
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::{now_millis, SecretRef, VaultError};

type BoxError = Box<dyn std::error::Error + Send + Sync>;
/// Body type of every broker response.
pub type ProxyBody = UnsyncBoxBody<Bytes, BoxError>;

/// Where proposals are filed; returned in deny responses.
pub const PROPOSALS_ENDPOINT: &str = "/api/vault/agent/broker/proposals";
/// Where agents list services and placeholders.
pub const DISCOVER_ENDPOINT: &str = "/api/vault/agent/broker/discover";
const ERROR_HEADER: &str = "x-ryu-broker-error";

/// Hop-by-hop and proxy headers never forwarded in either direction.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// A running broker.
pub struct Broker {
    store: &'static PluginSecretStore,
    config: BrokerConfig,
    port: u16,
    guard: Arc<NetGuard>,
    limiter: RateLimiter,
    client: reqwest::Client,
    provider: Arc<CryptoProvider>,
    /// Leaf issuer built from the unsealed CA key; dropped whenever the
    /// vault is seen sealed.
    leaves: tokio::sync::Mutex<Option<Arc<LeafCache>>>,
    /// Open tunnels per session id.
    tunnels: std::sync::Mutex<HashMap<String, usize>>,
    /// Status and access tokens for OAuth services.
    oauth: Arc<dyn OAuthTokens>,
}

/// One open tunnel counted against its session; released on drop.
struct TunnelPermit {
    broker: Arc<Broker>,
    session_id: String,
}

impl Drop for TunnelPermit {
    fn drop(&mut self) {
        let Ok(mut tunnels) = self.broker.tunnels.lock() else {
            return;
        };
        if let Some(count) = tunnels.get_mut(&self.session_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                tunnels.remove(&self.session_id);
            }
        }
    }
}

/// The upstream a request goes to.
#[derive(Debug, Clone)]
struct Target {
    scheme: &'static str,
    host: String,
    port: u16,
}

/// A request being prepared for upstream.
#[derive(Clone)]
struct Outgoing {
    method: Method,
    path: String,
    query: Option<String>,
    headers: HeaderMap,
    body: Bytes,
}

/// A refusal: the response and its log outcome.
struct Refusal {
    response: Response<ProxyBody>,
    outcome: &'static str,
}

impl Refusal {
    fn new(status: StatusCode, code: &'static str, message: &str) -> Self {
        Self {
            response: error_response(status, code, message),
            outcome: code,
        }
    }
}

fn full(body: impl Into<Bytes>) -> ProxyBody {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed_unsync()
}

fn empty() -> ProxyBody {
    Empty::new().map_err(|never| match never {}).boxed_unsync()
}

fn json_response(status: StatusCode, code: &str, body: serde_json::Value) -> Response<ProxyBody> {
    let mut response = Response::new(full(body.to_string()));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        hyper::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    if let Ok(value) = HeaderValue::from_str(code) {
        headers.insert(ERROR_HEADER, value);
    }
    response
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response<ProxyBody> {
    json_response(status, code, json!({ "error": code, "message": message }))
}

fn proxy_auth_required() -> Response<ProxyBody> {
    let mut response = error_response(
        StatusCode::PROXY_AUTHENTICATION_REQUIRED,
        "proxy_auth_required",
        "a live rvb_ broker session is required in Proxy-Authorization",
    );
    response.headers_mut().insert(
        hyper::header::PROXY_AUTHENTICATE,
        HeaderValue::from_static("Basic realm=\"ryu-vault-broker\""),
    );
    response
}

fn rate_limited(wait: Duration) -> Refusal {
    let mut response = error_response(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        "the broker session exceeded its request rate",
    );
    let secs = wait.as_secs().max(1).to_string();
    if let Ok(value) = HeaderValue::from_str(&secs) {
        response
            .headers_mut()
            .insert(hyper::header::RETRY_AFTER, value);
    }
    Refusal {
        response,
        outcome: "rate_limited",
    }
}

/// How an agent refused for `host` asks a human for it: the agent routes,
/// the `ryu-cli` command, and the `ryu-mcp` tools that call them.
pub fn proposal_hint(host: &str) -> serde_json::Value {
    json!({
        "method": "POST",
        "endpoint": PROPOSALS_ENDPOINT,
        "discover": DISCOVER_ENDPOINT,
        "cli": format!("ryu-cli secrets broker propose --host {host} --message \"<why>\""),
        "mcpTools": ["ryu_broker_discover", "ryu_broker_propose", "ryu_broker_proposal"],
    })
}

fn forbidden_unmatched(host: &str) -> Refusal {
    Refusal {
        response: json_response(
            StatusCode::FORBIDDEN,
            "forbidden",
            json!({
                "error": "forbidden",
                "message": format!(
                    "no broker service covers `{host}` and this environment denies unmatched hosts"
                ),
                "host": host,
                "proposalHint": proposal_hint(host),
            }),
        ),
        outcome: "forbidden",
    }
}

fn is_hop_by_hop(name: &HeaderName, connection_tokens: &[String]) -> bool {
    let name = name.as_str();
    HOP_BY_HOP.contains(&name) || connection_tokens.iter().any(|token| token == name)
}

/// Copy end-to-end headers, dropping hop-by-hop ones, those the `Connection`
/// header names, and (for requests) `Host` and `Content-Length`, which the
/// upstream client sets.
fn end_to_end(headers: &HeaderMap, request: bool) -> HeaderMap {
    let connection_tokens: Vec<String> = headers
        .get_all(hyper::header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .map(|token| token.trim().to_ascii_lowercase())
        .collect();
    let mut out = HeaderMap::with_capacity(headers.len());
    for (name, value) in headers {
        if is_hop_by_hop(name, &connection_tokens)
            || (request && (name == hyper::header::HOST || name == hyper::header::CONTENT_LENGTH))
        {
            continue;
        }
        out.append(name.clone(), value.clone());
    }
    out
}

/// Serves one fixed certificate (the leaf for the CONNECT target).
#[derive(Debug)]
struct FixedCert(Arc<CertifiedKey>);

impl ResolvesServerCert for FixedCert {
    fn resolve(&self, _client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
}

mod card_use;
mod forward;
mod inject;
mod listener;
mod oauth;
mod resolver;
mod tunnel;
mod websocket;
mod ws_frame;

use inject::{header_str, sensitive_value, substitute_headers};
use resolver::Resolver;

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
