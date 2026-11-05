//! The broker listener: a loopback HTTP forward proxy.
//!
//! * Absolute-form requests (`GET http://host/path`) are forwarded directly.
//! * `CONNECT host:port` to a host some service covers is intercepted: the
//!   broker answers `200`, terminates TLS with a leaf from its CA, and serves
//!   the tunneled HTTP/1.1 requests itself.
//! * `CONNECT` to any other host follows the environment's unmatched-host
//!   policy: a raw tunnel (`passthrough`) or a 403 (`deny`).
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
use super::ratelimit::RateLimiter;
use super::services::{self, BrokerService, MatchOutcome, ServiceAuth};
use super::sessions::{self, BrokerSession, MinterScope};
use super::settings::{self, EnvironmentSettings, UnmatchedHostPolicy};
use super::substitute::{self, Surface};
use super::BrokerConfig;
use crate::plugin_secrets::{PluginSecretStore, SecretResolutionContext};
use crate::vault::items::cards::{self, CardBinding, CardChannel, CardUseOutcome, CardUseRequest};
use crate::vault::policy::{Capability, CapabilitySet, Policy};
use crate::vault::{now_millis, SecretRef, VaultError};

#[path = "proxy_card_use.rs"]
mod card_use;
#[path = "proxy_connect.rs"]
mod connect;
#[path = "proxy_forward.rs"]
mod forward;
#[path = "proxy_inject.rs"]
mod inject;
#[path = "proxy_resolver.rs"]
mod resolver;
#[path = "proxy_support.rs"]
mod support;

use self::support::*;

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
struct Outgoing {
    method: Method,
    path: String,
    query: Option<String>,
    headers: HeaderMap,
    body: Bytes,
}

/// Who may use cards through one session.
enum CardAuthority {
    /// A machine-minted session: the minting token's policies (no baseline),
    /// with identity templates expanded for its machine subject.
    Machine {
        policies: Vec<Policy>,
        subject: String,
    },
    /// A human-minted session: the minter's current policies under the
    /// subjects recorded at mint.
    Human {
        policies: Vec<Policy>,
        scope: MinterScope,
    },
    /// A session with no recorded minter: no card use.
    Nobody,
}

impl CardAuthority {
    /// Whether the session may use the card at this `sys/items/...` key.
    fn may_use(&self, key: &str) -> bool {
        match self {
            Self::Machine { policies, subject } => crate::vault::policy::evaluate_with(
                &CapabilitySet::new(),
                policies,
                key,
                &crate::vault::policy_ext::TemplateContext::from_subjects(&[subject.clone()]),
            )
            .contains(&Capability::Use),
            Self::Human { policies, scope } => {
                let baseline: CapabilitySet = if scope.manager {
                    Capability::ALL.into_iter().collect()
                } else {
                    CapabilitySet::new()
                };
                crate::vault::policy::evaluate_with(
                    &baseline,
                    policies,
                    key,
                    &crate::vault::policy_ext::TemplateContext::from_subjects(&scope.subjects),
                )
                .contains(&Capability::Use)
            }
            Self::Nobody => false,
        }
    }
}

/// A card use whose values were substituted into an outgoing request.
struct CardSpend {
    request: CardUseRequest,
    approval_id: String,
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

impl Broker {
    /// Bind the loopback listener and build the upstream client.
    pub async fn bind(
        store: &'static PluginSecretStore,
        config: BrokerConfig,
    ) -> Result<(Arc<Self>, TcpListener)> {
        let listener = TcpListener::bind(("127.0.0.1", config.port))
            .await
            .with_context(|| format!("binding the broker on 127.0.0.1:{}", config.port))?;
        let port = listener.local_addr()?.port();
        let guard = Arc::new(config.guard.clone());
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(GuardedResolver(guard.clone())))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(300));
        for pem in &config.extra_upstream_roots_pem {
            builder = builder.add_root_certificate(
                reqwest::Certificate::from_pem(pem.as_bytes())
                    .context("parsing an extra upstream root")?,
            );
        }
        let broker = Self {
            store,
            port,
            guard,
            limiter: RateLimiter::new(config.rps, config.burst),
            client: builder
                .build()
                .context("building the broker upstream client")?,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
            leaves: tokio::sync::Mutex::new(None),
            tunnels: std::sync::Mutex::new(HashMap::new()),
            config,
        };
        Ok((Arc::new(broker), listener))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Accept connections until the listener fails.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    tracing::warn!("broker accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            // Nagle + delayed ACK would stall each small relayed write ~40 ms.
            if let Err(error) = stream.set_nodelay(true) {
                tracing::debug!("broker could not set TCP_NODELAY: {error}");
            }
            let broker = self.clone();
            tokio::spawn(async move { broker.serve_connection(stream, peer).await });
        }
    }

    async fn serve_connection(self: Arc<Self>, stream: TcpStream, peer: SocketAddr) {
        let broker = self.clone();
        let service = service_fn(move |request: Request<Incoming>| {
            let broker = broker.clone();
            async move { Ok::<_, Infallible>(broker.handle(request, peer).await) }
        });
        if let Err(error) = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades()
            .await
        {
            tracing::debug!("broker connection ended: {error}");
        }
    }

    async fn handle(
        self: Arc<Self>,
        request: Request<Incoming>,
        peer: SocketAddr,
    ) -> Response<ProxyBody> {
        let session = match self.authenticate(request.headers(), peer).await {
            Ok(session) => session,
            Err(response) => return response,
        };
        if request.method() == Method::CONNECT {
            return self.connect(session, request).await;
        }
        let uri = request.uri();
        let (Some(scheme), Some(host)) = (uri.scheme_str(), uri.host()) else {
            return error_response(
                StatusCode::BAD_REQUEST,
                "absolute_form_required",
                "send absolute-form requests (http://host/path) or CONNECT",
            );
        };
        let target = match scheme {
            "http" => Target {
                scheme: "http",
                host: host.to_ascii_lowercase(),
                port: uri.port_u16().unwrap_or(80),
            },
            "https" => Target {
                scheme: "https",
                host: host.to_ascii_lowercase(),
                port: uri.port_u16().unwrap_or(443),
            },
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "unsupported_scheme",
                    "only http and https are brokered",
                )
            }
        };
        self.forward(&session, &target, request).await
    }

    /// The live session named by `Proxy-Authorization`, presented from
    /// `peer` (a machine-minted session keeps its token's CIDR binding).
    async fn authenticate(
        &self,
        headers: &HeaderMap,
        peer: SocketAddr,
    ) -> Result<BrokerSession, Response<ProxyBody>> {
        let Some(token) = headers
            .get(hyper::header::PROXY_AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(sessions::parse_authorization)
        else {
            return Err(proxy_auth_required());
        };
        let conn = self.store.conn.lock().await;
        match sessions::lookup(&conn, &token, Some(peer.ip())) {
            Ok(Some(session)) => Ok(session),
            Ok(None) => Err(proxy_auth_required()),
            Err(error) => {
                tracing::warn!("broker session lookup failed: {error:#}");
                Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "broker_internal",
                    "session lookup failed",
                ))
            }
        }
    }

    /// The environment's services, settings, and merchant-locked cards.
    async fn environment_view(
        &self,
        environment: &str,
    ) -> Result<(Vec<BrokerService>, EnvironmentSettings, Vec<CardBinding>), Refusal> {
        let conn = self.store.conn.lock().await;
        let view = services::list(&conn, Some(environment)).and_then(|services| {
            Ok((
                services,
                settings::get(&conn, environment)?,
                cards::bindings_locked(&conn, environment)?,
            ))
        });
        view.map_err(|error| {
            tracing::warn!("broker could not read services: {error:#}");
            Refusal::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "broker_internal",
                "service lookup failed",
            )
        })
    }

    /// The leaf issuer. A sealed vault drops the cached (unsealed) CA key
    /// and refuses, so sealing stops interception immediately; the next use
    /// after unsealing reloads the key through the keyring.
    async fn leaf_cache(&self) -> Result<Arc<LeafCache>> {
        let mut cached = self.leaves.lock().await;
        if self.store.keyring.is_sealed() {
            *cached = None;
            return Err(VaultError::Sealed.into());
        }
        if let Some(cache) = cached.as_ref() {
            return Ok(cache.clone());
        }
        let material = ca::ensure(self.store).await?;
        let cache = Arc::new(LeafCache::new(&material, self.provider.clone())?);
        *cached = Some(cache.clone());
        Ok(cache)
    }

    /// The session with this id if it is still live.
    async fn live_session(&self, id: &str) -> Option<BrokerSession> {
        let conn = self.store.conn.lock().await;
        match sessions::live(&conn, id) {
            Ok(session) => session,
            Err(error) => {
                tracing::warn!("broker session re-check failed: {error:#}");
                None
            }
        }
    }

    /// Completes once the session is no longer live (revoked, expired, or its
    /// minting token revoked), checking every `session_check_interval`.
    async fn session_ended(&self, id: &str, expires_at: i64) {
        loop {
            let remaining = expires_at.saturating_sub(now_millis());
            if remaining <= 0 {
                return;
            }
            let until_expiry = Duration::from_millis(u64::try_from(remaining).unwrap_or(u64::MAX));
            tokio::time::sleep(self.config.session_check_interval.min(until_expiry)).await;
            if self.live_session(id).await.is_none() {
                return;
            }
        }
    }

    /// Count a tunnel against its session, or `None` at the cap.
    fn acquire_tunnel(self: &Arc<Self>, session_id: &str) -> Option<TunnelPermit> {
        let mut tunnels = self.tunnels.lock().ok()?;
        let count = tunnels.entry(session_id.to_owned()).or_insert(0);
        if *count >= self.config.max_tunnels_per_session {
            return None;
        }
        *count += 1;
        Some(TunnelPermit {
            broker: self.clone(),
            session_id: session_id.to_owned(),
        })
    }

    async fn record(&self, row: LogRow) {
        let conn = self.store.conn.lock().await;
        if let Err(error) = log::insert(&conn, &row) {
            tracing::warn!("broker log write failed: {error:#}");
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn log_row(
        session: &BrokerSession,
        method: &Method,
        target: &Target,
        path: &str,
        service: Option<String>,
        status: StatusCode,
        started: Instant,
        outcome: &str,
    ) -> LogRow {
        LogRow {
            id: 0,
            at: now_millis(),
            session_id: Some(session.id.clone()),
            environment: session.environment.clone(),
            method: method.to_string(),
            scheme: target.scheme.to_owned(),
            host: target.host.clone(),
            port: target.port,
            path: path.to_owned(),
            service,
            status: status.as_u16(),
            latency_ms: started.elapsed().as_millis() as i64,
            outcome: outcome.to_owned(),
        }
    }
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
