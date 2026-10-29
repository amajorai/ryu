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
                "proposalHint": {
                    "method": "POST",
                    "endpoint": PROPOSALS_ENDPOINT,
                    "discover": DISCOVER_ENDPOINT,
                },
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

    // ── CONNECT ───────────────────────────────────────────────────────────

    async fn connect(
        self: Arc<Self>,
        session: BrokerSession,
        request: Request<Incoming>,
    ) -> Response<ProxyBody> {
        let started = Instant::now();
        let Some(authority) = request.uri().authority() else {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_connect",
                "CONNECT needs host:port",
            );
        };
        let target = Target {
            scheme: "https",
            host: authority.host().to_ascii_lowercase(),
            port: authority.port_u16().unwrap_or(443),
        };
        let opened = match self.limiter.check(&session.id) {
            Err(wait) => Err(rate_limited(wait)),
            Ok(()) => self.clone().open_tunnel(&session, &target, request).await,
        };
        let (response, outcome) = match opened {
            Ok(outcome) => (Response::new(empty()), outcome),
            Err(refusal) => (refusal.response, refusal.outcome),
        };
        let row = Self::log_row(
            &session,
            &Method::CONNECT,
            &target,
            "",
            None,
            response.status(),
            started,
            outcome,
        );
        self.record(row).await;
        response
    }

    /// Decide how to handle a CONNECT and start the tunnel task. The client
    /// gets `200` only after the decision.
    async fn open_tunnel(
        self: Arc<Self>,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Result<&'static str, Refusal> {
        let (services, settings, cards) = self.environment_view(&session.environment).await?;
        // A merchant host of a card this session may use is intercepted too,
        // so card placeholders can be substituted there.
        let brokered = services::host_is_brokered(&services, &target.host, target.port)
            || self.usable_merchant(session, &cards, &target.host).await?;
        if !brokered && settings.unmatched_host_policy == UnmatchedHostPolicy::Deny {
            return Err(forbidden_unmatched(&target.host));
        }
        let permit = self.acquire_tunnel(&session.id).ok_or_else(|| {
            Refusal::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_tunnels",
                "the broker session has too many open tunnels",
            )
        })?;
        if !brokered {
            let addrs = self
                .guard
                .resolve(&target.host, target.port)
                .await
                .map_err(|error| {
                    Refusal::new(
                        StatusCode::FORBIDDEN,
                        "netguard_blocked",
                        &error.to_string(),
                    )
                })?;
            let broker = self.clone();
            let session = session.clone();
            tokio::spawn(async move { broker.raw_tunnel(request, addrs, session, permit).await });
            return Ok("tunneled");
        }
        let leaves = self.leaf_cache().await.map_err(|error| {
            let sealed = error
                .downcast_ref::<VaultError>()
                .is_some_and(|e| matches!(e, VaultError::Sealed));
            tracing::warn!("broker CA unavailable: {error:#}");
            if sealed {
                Refusal::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "vault_sealed",
                    "the vault is sealed",
                )
            } else {
                Refusal::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "broker_ca_unavailable",
                    "the broker CA is unavailable",
                )
            }
        })?;
        let leaf = leaves.leaf(&target.host).map_err(|_| {
            Refusal::new(
                StatusCode::BAD_REQUEST,
                "invalid_connect",
                "invalid CONNECT host",
            )
        })?;
        let broker = self.clone();
        let session = session.clone();
        let target = target.clone();
        tokio::spawn(async move {
            let _permit = permit;
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    broker
                        .serve_intercepted(upgraded, leaf, session, target)
                        .await
                }
                Err(error) => tracing::debug!("broker CONNECT upgrade failed: {error}"),
            }
        });
        Ok("intercepted")
    }

    /// A raw (passthrough) tunnel, closed when its session ends.
    async fn raw_tunnel(
        self: Arc<Self>,
        request: Request<Incoming>,
        addrs: Vec<SocketAddr>,
        session: BrokerSession,
        _permit: TunnelPermit,
    ) {
        let upgraded = match hyper::upgrade::on(request).await {
            Ok(upgraded) => upgraded,
            Err(error) => {
                tracing::debug!("broker tunnel upgrade failed: {error}");
                return;
            }
        };
        let mut upstream = match TcpStream::connect(&addrs[..]).await {
            Ok(stream) => stream,
            Err(error) => {
                tracing::debug!("broker tunnel connect failed: {error}");
                return;
            }
        };
        let mut client = TokioIo::new(upgraded);
        tokio::select! {
            _ = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {}
            () = self.session_ended(&session.id, session.expires_at) => {
                tracing::debug!(session = session.id, "closing broker tunnel: session ended");
            }
        }
    }

    async fn serve_intercepted(
        self: Arc<Self>,
        upgraded: hyper::upgrade::Upgraded,
        leaf: Arc<CertifiedKey>,
        session: BrokerSession,
        target: Target,
    ) {
        let config = match rustls::ServerConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
        {
            Ok(builder) => {
                let mut config = builder
                    .with_no_client_auth()
                    .with_cert_resolver(Arc::new(FixedCert(leaf)));
                config.alpn_protocols = vec![b"http/1.1".to_vec()];
                config
            }
            Err(error) => {
                tracing::warn!("broker TLS config failed: {error}");
                return;
            }
        };
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let tls = match acceptor.accept(TokioIo::new(upgraded)).await {
            Ok(tls) => tls,
            Err(error) => {
                tracing::debug!(host = target.host, "broker TLS handshake failed: {error}");
                return;
            }
        };
        let session_id: Arc<str> = Arc::from(session.id.as_str());
        let target = Arc::new(target);
        let broker = self.clone();
        let id = session_id.clone();
        // The CONNECT authenticated the session once; every request on the
        // kept-alive connection re-checks it, so a revoked or expired session
        // gets no further credentials.
        let service = service_fn(move |request: Request<Incoming>| {
            let broker = broker.clone();
            let id = id.clone();
            let target = target.clone();
            async move {
                let Some(session) = broker.live_session(&id).await else {
                    return Ok::<_, Infallible>(proxy_auth_required());
                };
                Ok(broker.forward(&session, &target, request).await)
            }
        });
        let connection =
            hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), service);
        tokio::select! {
            result = connection => {
                if let Err(error) = result {
                    tracing::debug!("broker intercepted connection ended: {error}");
                }
            }
            () = self.session_ended(&session_id, session.expires_at) => {
                tracing::debug!(session = &*session_id, "closing intercepted tunnel: session ended");
            }
        }
    }

    // ── Forwarding ────────────────────────────────────────────────────────

    async fn forward(
        &self,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Response<ProxyBody> {
        let started = Instant::now();
        let method = request.method().clone();
        // Logged as sent: placeholders, never values, and no query string.
        let path = request.uri().path().to_owned();
        let (response, service, outcome) = match self.forward_inner(session, target, request).await
        {
            Ok((response, service)) => (response, service, "forwarded"),
            Err((refusal, service)) => (refusal.response, service, refusal.outcome),
        };
        let row = Self::log_row(
            session,
            &method,
            target,
            &path,
            service,
            response.status(),
            started,
            outcome,
        );
        self.record(row).await;
        response
    }

    async fn forward_inner(
        &self,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Result<(Response<ProxyBody>, Option<String>), (Refusal, Option<String>)> {
        if let Err(wait) = self.limiter.check(&session.id) {
            return Err((rate_limited(wait), None));
        }
        let path = request.uri().path().to_owned();
        // The upstream URL is normalized (dot segments resolved, `%2e` and
        // `\` included) after matching, so such a path could leave the
        // matched service's prefix upstream.
        if services::has_dot_segment(&path) {
            return Err((
                Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_path",
                    "paths with `.` or `..` segments (raw or percent-encoded) are not brokered",
                ),
                None,
            ));
        }
        let (services, settings, cards) = self
            .environment_view(&session.environment)
            .await
            .map_err(|refusal| (refusal, None))?;
        let merchant_host = self
            .usable_merchant(session, &cards, &target.host)
            .await
            .map_err(|refusal| (refusal, None))?;
        // Under `deny`, a host covered only by a card's merchant allowlist is
        // forwarded only when a card placeholder was actually substituted
        // (which needs HTTPS and an approval); anything else is refused like
        // any unmatched host.
        let mut merchant_only = false;
        let service = match services::match_request(&services, &target.host, target.port, &path) {
            MatchOutcome::Matched(service) => Some(service.clone()),
            MatchOutcome::Disabled(service) => {
                return Err((
                    Refusal::new(
                        StatusCode::FORBIDDEN,
                        "service_disabled",
                        &format!("broker service `{}` is disabled", service.name()),
                    ),
                    Some(service.name().to_owned()),
                ))
            }
            MatchOutcome::Ambiguous(names) => {
                return Err((
                    Refusal::new(
                        StatusCode::CONFLICT,
                        "ambiguous_service",
                        &format!("equally specific services match: {}", names.join(", ")),
                    ),
                    None,
                ))
            }
            MatchOutcome::Unmatched => match settings.unmatched_host_policy {
                UnmatchedHostPolicy::Deny if merchant_host => {
                    merchant_only = true;
                    None
                }
                UnmatchedHostPolicy::Deny => return Err((forbidden_unmatched(&target.host), None)),
                UnmatchedHostPolicy::Passthrough => None,
            },
        };
        let name = service.as_ref().map(|s| s.name().to_owned());
        let fail = |refusal: Refusal| (refusal, name.clone());
        if let Some(service) = &service {
            if !session.allows(service.name()) {
                return Err(fail(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "service_not_in_session",
                    &format!(
                        "this session may not use broker service `{}`",
                        service.name()
                    ),
                )));
            }
            if target.scheme == "http" && !service.input.allow_insecure_http {
                return Err(fail(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "insecure_scheme",
                    "this service only brokers https; plain http would expose the credential",
                )));
            }
        }
        // Checked before any credential is resolved; the guarded resolver
        // checks again at dial time.
        self.guard
            .resolve(&target.host, target.port)
            .await
            .map_err(|error| {
                fail(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "netguard_blocked",
                    &error.to_string(),
                ))
            })?;
        let mut outgoing = self.read_request(request).await.map_err(fail)?;
        // Service credentials first, so a failed injection never spends a
        // card approval.
        if let Some(service) = &service {
            self.inject(session, service, &mut outgoing)
                .await
                .map_err(fail)?;
        }
        let spend = self
            .substitute_card(session, target, &cards, &mut outgoing)
            .await
            .map_err(fail)?;
        if merchant_only && spend.is_none() {
            return Err(fail(forbidden_unmatched(&target.host)));
        }
        match self.send(target, outgoing).await {
            Ok(response) => Ok((response, name)),
            Err((refusal, delivered)) => {
                // Nothing reached the merchant: the approval keeps its use.
                if let (Some(spend), false) = (&spend, delivered) {
                    if let Err(error) = self
                        .store
                        .card_use_refund(&spend.request, &spend.approval_id, refusal.outcome)
                        .await
                    {
                        tracing::warn!("returning a card use failed: {error:#}");
                    }
                }
                Err(fail(refusal))
            }
        }
    }

    async fn read_request(&self, request: Request<Incoming>) -> Result<Outgoing, Refusal> {
        let (parts, body) = request.into_parts();
        let body = match Limited::new(body, self.config.max_request_bytes)
            .collect()
            .await
        {
            Ok(collected) => collected.to_bytes(),
            Err(error) if error.is::<http_body_util::LengthLimitError>() => {
                return Err(Refusal::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request_too_large",
                    "the request body exceeds the broker limit",
                ))
            }
            Err(_) => {
                return Err(Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_body",
                    "the request body could not be read",
                ))
            }
        };
        Ok(Outgoing {
            method: parts.method,
            path: parts.uri.path().to_owned(),
            query: parts.uri.query().map(str::to_owned),
            headers: end_to_end(&parts.headers, true),
            body,
        })
    }

    /// Send upstream. A failure says whether the request may have reached
    /// the upstream (`false` only when the connection was never made).
    async fn send(
        &self,
        target: &Target,
        outgoing: Outgoing,
    ) -> Result<Response<ProxyBody>, (Refusal, bool)> {
        let query = outgoing
            .query
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        let url = format!(
            "{}://{}:{}{}{}",
            target.scheme, target.host, target.port, outgoing.path, query
        );
        let url = reqwest::Url::parse(&url).map_err(|_| {
            (
                Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_target",
                    "invalid upstream URL",
                ),
                false,
            )
        })?;
        let upstream = self
            .client
            .request(outgoing.method, url)
            .headers(outgoing.headers)
            .body(outgoing.body)
            .send()
            .await
            .map_err(|error| {
                // The error text can echo the URL, which may now hold a
                // substituted value; report only its class.
                let class = if error.is_timeout() {
                    "timed out"
                } else if error.is_connect() {
                    "connection failed"
                } else {
                    "request failed"
                };
                (
                    Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "upstream_unreachable",
                        &format!("upstream {class}"),
                    ),
                    !error.is_connect(),
                )
            })?;
        let mut response = Response::builder().status(upstream.status());
        if let Some(headers) = response.headers_mut() {
            *headers = end_to_end(upstream.headers(), false);
        }
        let stream = upstream.bytes_stream().map(|chunk| {
            chunk
                .map(Frame::data)
                .map_err(|error| Box::new(error) as BoxError)
        });
        response
            .body(StreamBody::new(stream).boxed_unsync())
            .map_err(|_| {
                (
                    Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "upstream_invalid",
                        "invalid upstream response",
                    ),
                    true,
                )
            })
    }

    // ── Credential injection ──────────────────────────────────────────────

    async fn inject(
        &self,
        session: &BrokerSession,
        service: &BrokerService,
        outgoing: &mut Outgoing,
    ) -> Result<(), Refusal> {
        let machine_policies = self.minting_machine_policies(session).await?;
        // A human minter's role and team subjects, captured at mint, so their
        // `role:`/`team:` deny rules hold here as they do in management.
        let minter_subjects = session
            .minter_scope
            .as_ref()
            .map(|scope| scope.subjects.clone());
        let roles = minter_subjects
            .iter()
            .flatten()
            .filter_map(|subject| subject.strip_prefix("role:"))
            .map(str::to_owned)
            .collect();
        let context = SecretResolutionContext {
            user_id: session.user_id().map(str::to_owned),
            environment: Some(session.environment.clone()),
            conversation_id: Some(format!("broker:{}", session.id)),
            roles,
            minted_subjects: session
                .minter_scope
                .as_ref()
                .map(|scope| scope.subjects.clone())
                .unwrap_or_default(),
            ..SecretResolutionContext::node_only(super::local_node_id(), Vec::new())
        };
        let mut resolver = Resolver {
            store: self.store,
            context,
            environment: session.environment.clone(),
            machine_policies,
            minter_subjects,
            cache: HashMap::new(),
            subject: session.minted_by.clone(),
            session_id: session.id.clone(),
        };
        self.substitute(service, outgoing, &mut resolver).await?;
        self.apply_auth(&service.input.auth, outgoing, &mut resolver)
            .await
    }

    /// For a machine-minted session, the minting token's current policies
    /// (`None` for sessions a human or the operator minted, whose user
    /// subject the resolver applies itself). A token revoked since minting
    /// ends the session.
    async fn minting_machine_policies(
        &self,
        session: &BrokerSession,
    ) -> Result<Option<Vec<Policy>>, Refusal> {
        let Some(accessor) = &session.minted_token else {
            return Ok(None);
        };
        let conn = self.store.conn.lock().await;
        let policies = crate::vault::machine::principal_by_accessor_locked(&conn, accessor)
            .and_then(|principal| {
                principal
                    .map(|principal| {
                        crate::vault::machine::principal_policies_locked(&conn, &principal)
                    })
                    .transpose()
            });
        match policies {
            Ok(Some(policies)) => Ok(Some(policies)),
            Ok(None) => Err(Refusal {
                response: proxy_auth_required(),
                outcome: "proxy_auth_required",
            }),
            Err(error) => {
                tracing::warn!("broker machine policy lookup failed: {error:#}");
                Err(Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "broker_internal",
                    "policy lookup failed",
                ))
            }
        }
    }

    async fn substitute(
        &self,
        service: &BrokerService,
        outgoing: &mut Outgoing,
        resolver: &mut Resolver,
    ) -> Result<(), Refusal> {
        let body_kind = substitute::body_kind(
            header_str(&outgoing.headers, hyper::header::CONTENT_TYPE.as_str()),
            header_str(&outgoing.headers, hyper::header::CONTENT_ENCODING.as_str()),
        );
        let mut by_surface: HashMap<Surface, Vec<(String, String)>> = HashMap::new();
        for substitution in &service.input.substitutions {
            let placeholder = substitution.placeholder.as_str();
            let present = substitution.surfaces.iter().any(|surface| match surface {
                Surface::Path => outgoing.path.contains(placeholder),
                Surface::Query => outgoing
                    .query
                    .as_deref()
                    .is_some_and(|query| query.contains(placeholder)),
                Surface::Header => outgoing
                    .headers
                    .values()
                    .any(|value| contains_bytes(value.as_bytes(), placeholder.as_bytes())),
                Surface::Body => {
                    body_kind != substitute::BodyKind::Opaque
                        && contains_bytes(&outgoing.body, placeholder.as_bytes())
                }
            });
            if !present {
                continue;
            }
            let value = resolver.resolve(&substitution.reference).await?;
            for surface in &substitution.surfaces {
                by_surface
                    .entry(*surface)
                    .or_default()
                    .push((substitution.placeholder.clone(), value.clone()));
            }
        }
        if let Some(pairs) = by_surface.get(&Surface::Path) {
            if let Some(path) =
                substitute::replace_all(&outgoing.path, pairs, substitute::encode_url)
            {
                outgoing.path = path;
            }
        }
        if let Some(pairs) = by_surface.get(&Surface::Query) {
            if let Some(query) = outgoing
                .query
                .as_deref()
                .and_then(|query| substitute::replace_all(query, pairs, substitute::encode_url))
            {
                outgoing.query = Some(query);
            }
        }
        if let Some(pairs) = by_surface.get(&Surface::Header) {
            substitute_headers(&mut outgoing.headers, pairs)?;
        }
        if let Some(pairs) = by_surface.get(&Surface::Body) {
            if let Some(body) = substitute::substitute_body(&outgoing.body, body_kind, pairs) {
                outgoing.body = Bytes::from(body);
            }
        }
        Ok(())
    }

    /// Whether `host` is a merchant host of a card this session may use.
    async fn usable_merchant(
        &self,
        session: &BrokerSession,
        bindings: &[CardBinding],
        host: &str,
    ) -> Result<bool, Refusal> {
        let candidates: Vec<&CardBinding> =
            bindings.iter().filter(|card| card.allows(host)).collect();
        if candidates.is_empty() {
            return Ok(false);
        }
        let (authority, _) = self.card_principal(session).await?;
        Ok(candidates
            .iter()
            .any(|card| authority.may_use(&card.coords.policy_key())))
    }

    /// Substitute `__CARD_<KEY>_<FIELD>__` placeholders in headers and the
    /// body. Only an HTTPS request to a host on the card's merchant
    /// allowlist, from a session whose minter may `use` the card, is
    /// eligible; anything else leaves the placeholders untouched and records
    /// a blocked use. An eligible use needs a live approval grant: without
    /// one the request is not forwarded and the agent gets a
    /// `428 card_approval_required` naming the pending approval request.
    /// Returns the use when values were substituted.
    async fn substitute_card(
        &self,
        session: &BrokerSession,
        target: &Target,
        bindings: &[CardBinding],
        outgoing: &mut Outgoing,
    ) -> Result<Option<CardSpend>, Refusal> {
        let body_kind = substitute::body_kind(
            header_str(&outgoing.headers, hyper::header::CONTENT_TYPE.as_str()),
            header_str(&outgoing.headers, hyper::header::CONTENT_ENCODING.as_str()),
        );
        let mut found = Vec::new();
        for value in outgoing.headers.values() {
            if let Ok(text) = value.to_str() {
                cards::find_placeholders(text, &mut found);
            }
        }
        if body_kind != substitute::BodyKind::Opaque
            && outgoing.body.len() <= substitute::MAX_BODY_SUBSTITUTION_BYTES
        {
            if let Ok(text) = std::str::from_utf8(&outgoing.body) {
                cards::find_placeholders(text, &mut found);
            }
        }
        found.retain(|placeholder| {
            bindings
                .iter()
                .any(|binding| binding.coords.key == placeholder.key)
        });
        let Some(first) = found.first() else {
            return Ok(None);
        };
        if found.iter().any(|placeholder| placeholder.key != first.key) {
            return Err(Refusal::new(
                StatusCode::BAD_REQUEST,
                "one_card_per_request",
                "a brokered request may use placeholders of one card only",
            ));
        }
        let matching: Vec<&CardBinding> = bindings
            .iter()
            .filter(|binding| binding.coords.key == first.key)
            .collect();
        let [binding] = matching.as_slice() else {
            return Err(Refusal::new(
                StatusCode::CONFLICT,
                "ambiguous_card",
                &format!(
                    "more than one card item named `{}` exists in this environment",
                    first.key
                ),
            ));
        };
        let (authority, agent) = self.card_principal(session).await?;
        let request = CardUseRequest {
            coords: binding.coords.clone(),
            channel: CardChannel::Broker,
            merchant_host: target.host.clone(),
            requester: format!("broker_session:{}", session.id),
            agent,
            actor: session.actor(),
        };
        let denied = !authority.may_use(&binding.coords.policy_key());
        let blocked = if binding.merchants.is_empty() {
            Some("no_merchants")
        } else if !binding.allows(&target.host) {
            Some("merchant_not_allowed")
        } else if target.scheme != "https" {
            Some("insecure_scheme")
        } else if denied {
            Some("denied")
        } else {
            None
        };
        if let Some(reason) = blocked {
            if let Err(error) = self.store.card_use_blocked(&request, reason).await {
                tracing::warn!("recording a blocked card use failed: {error:#}");
            }
            return Ok(None);
        }
        let (values, approval_id) = match self.store.card_use(&request, None).await {
            Ok(CardUseOutcome::Granted {
                values,
                approval_id,
                ..
            }) => (values, approval_id),
            Ok(CardUseOutcome::Blocked(_)) => return Ok(None),
            Ok(CardUseOutcome::Pending(approval)) => {
                return Err(Refusal {
                    response: json_response(
                        StatusCode::PRECONDITION_REQUIRED,
                        "card_approval_required",
                        json!({
                            "error": "card_approval_required",
                            "message": format!(
                                "using card `{}` at `{}` needs a human approval; the request was not forwarded",
                                binding.coords.key, target.host
                            ),
                            "approvalId": approval.id,
                            "approvePath": approval.approve_path(),
                            "statusPath": approval.agent_status_path(),
                            "card": {
                                "key": binding.coords.key,
                                "brand": approval.brand,
                                "last4": approval.last4,
                            },
                            "merchant": target.host,
                        }),
                    ),
                    outcome: "card_approval_required",
                })
            }
            Err(error) => return Err(card_refusal(&error)),
        };
        let spend = CardSpend {
            request,
            approval_id,
        };
        // Every placeholder must resolve: a field the card does not store
        // (an optional security code, say) would otherwise be forwarded as
        // the literal placeholder while the approval is spent. Return the
        // use and refuse instead of sending.
        let mut pairs: Vec<(String, String)> = Vec::with_capacity(found.len());
        for placeholder in &found {
            let Some(value) = values.get(placeholder.field) else {
                let refusal = Refusal::new(
                    StatusCode::CONFLICT,
                    "card_field_missing",
                    &format!(
                        "card `{}` has no `{}` value; the request was not forwarded",
                        binding.coords.key, placeholder.field
                    ),
                );
                return Err(self.refund_on_refusal(&spend, refusal).await);
            };
            pairs.push((placeholder.token.clone(), value.clone()));
        }
        if let Err(refusal) = substitute_headers(&mut outgoing.headers, &pairs) {
            return Err(self.refund_on_refusal(&spend, refusal).await);
        }
        if let Some(body) = substitute::substitute_body(&outgoing.body, body_kind, &pairs) {
            outgoing.body = Bytes::from(body);
        }
        Ok(Some(spend))
    }

    /// Return a card use whose substitution failed before sending, then
    /// pass the refusal on.
    async fn refund_on_refusal(&self, spend: &CardSpend, refusal: Refusal) -> Refusal {
        if let Err(error) = self
            .store
            .card_use_refund(&spend.request, &spend.approval_id, refusal.outcome)
            .await
        {
            tracing::warn!("returning a card use failed: {error:#}");
        }
        refusal
    }

    /// Who may use cards through `session`, and the agent subject a card
    /// grant can bind to: the minting machine identity, or whoever minted
    /// the session.
    async fn card_principal(
        &self,
        session: &BrokerSession,
    ) -> Result<(CardAuthority, String), Refusal> {
        let Some(accessor) = &session.minted_token else {
            let authority = match &session.minter_scope {
                Some(scope) => {
                    let conn = self.store.conn.lock().await;
                    let policies = crate::vault::policy::policies_for(&conn, &scope.subjects)
                        .map_err(|error| {
                            tracing::warn!("broker minter policy lookup failed: {error:#}");
                            Refusal::new(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                "broker_internal",
                                "policy lookup failed",
                            )
                        })?;
                    CardAuthority::Human {
                        policies,
                        scope: scope.clone(),
                    }
                }
                None => CardAuthority::Nobody,
            };
            return Ok((authority, session.minted_by.clone()));
        };
        let policies = self.minting_machine_policies(session).await?;
        let conn = self.store.conn.lock().await;
        let subject = crate::vault::machine::principal_by_accessor_locked(&conn, accessor)
            .ok()
            .flatten()
            .map_or_else(
                || session.minted_by.clone(),
                |principal| principal.subject(),
            );
        let authority = policies.map_or(CardAuthority::Nobody, |policies| CardAuthority::Machine {
            policies,
            subject: subject.clone(),
        });
        Ok((authority, subject))
    }

    async fn apply_auth(
        &self,
        auth: &ServiceAuth,
        outgoing: &mut Outgoing,
        resolver: &mut Resolver,
    ) -> Result<(), Refusal> {
        let headers: Vec<(String, String)> = match auth {
            ServiceAuth::Passthrough => Vec::new(),
            ServiceAuth::Bearer { token } => vec![(
                "authorization".to_owned(),
                format!("Bearer {}", resolver.resolve(token).await?),
            )],
            ServiceAuth::Basic { username, password } => {
                use base64::Engine as _;
                let username = if substitute::is_credential_ref(username) {
                    resolver.resolve(username).await?
                } else {
                    username.clone()
                };
                let password = resolver.resolve(password).await?;
                let encoded = base64::engine::general_purpose::STANDARD
                    .encode(format!("{username}:{password}"));
                vec![("authorization".to_owned(), format!("Basic {encoded}"))]
            }
            ServiceAuth::ApiKey {
                header,
                value,
                prefix,
            } => vec![(
                header.to_ascii_lowercase(),
                format!("{prefix}{}", resolver.resolve(value).await?),
            )],
            ServiceAuth::Custom { headers } => {
                let mut rendered = Vec::with_capacity(headers.len());
                for (name, template) in headers {
                    let mut value = String::new();
                    let segments = substitute::parse_template(template).map_err(|_| {
                        Refusal::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "invalid_service",
                            "the service header template is invalid",
                        )
                    })?;
                    for segment in segments {
                        match segment {
                            substitute::Segment::Literal(text) => value.push_str(&text),
                            substitute::Segment::Ref(reference) => {
                                value.push_str(&resolver.resolve(&reference).await?);
                            }
                        }
                    }
                    rendered.push((name.to_ascii_lowercase(), value));
                }
                rendered
            }
        };
        for (name, value) in headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| {
                Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_service",
                    "invalid header name",
                )
            })?;
            outgoing.headers.insert(name, sensitive_value(&value)?);
        }
        Ok(())
    }
}

/// A refusal for a card use that failed. Messages name the card and state,
/// never a value.
fn card_refusal(error: &anyhow::Error) -> Refusal {
    match error.downcast_ref::<VaultError>() {
        Some(VaultError::AuditUnavailable) => Refusal::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "audit_unavailable",
            "no audit device accepted the card use; nothing was released",
        ),
        Some(VaultError::Sealed) => Refusal::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "vault_sealed",
            "the vault is sealed",
        ),
        Some(VaultError::Conflict(message) | VaultError::Invalid(message)) => {
            Refusal::new(StatusCode::CONFLICT, "card_unusable", message)
        }
        _ => {
            tracing::warn!("broker card use failed: {error:#}");
            Refusal::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "broker_internal",
                "card use failed",
            )
        }
    }
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// A header value marked sensitive; a credential containing CR, LF, or NUL
/// fails closed instead of splitting the request.
fn sensitive_value(value: &str) -> Result<HeaderValue, Refusal> {
    if !substitute::is_safe_header_value(value) {
        return Err(Refusal::new(
            StatusCode::BAD_GATEWAY,
            "credential_invalid",
            "a credential is not a valid header value",
        ));
    }
    let mut header = HeaderValue::from_bytes(value.as_bytes()).map_err(|_| {
        Refusal::new(
            StatusCode::BAD_GATEWAY,
            "credential_invalid",
            "a credential is not a valid header value",
        )
    })?;
    header.set_sensitive(true);
    Ok(header)
}

fn substitute_headers(headers: &mut HeaderMap, pairs: &[(String, String)]) -> Result<(), Refusal> {
    let mut rewritten = Vec::new();
    for (name, value) in headers.iter() {
        let Ok(text) = value.to_str() else {
            continue;
        };
        if let Some(replaced) = substitute::replace_all(text, pairs, str::to_owned) {
            rewritten.push((name.clone(), sensitive_value(&replaced)?));
        }
    }
    for (name, value) in rewritten {
        headers.insert(name, value);
    }
    Ok(())
}

/// Per-request credential resolution with a small cache, so a reference used
/// twice is resolved (and audited) once.
struct Resolver {
    store: &'static PluginSecretStore,
    context: SecretResolutionContext,
    /// The session's environment, for unqualified references.
    environment: String,
    /// The minting machine token's policies: each reference needs `use`
    /// under them (no baseline), so the machine's own grants and denies
    /// bound what its sessions can inject.
    machine_policies: Option<Vec<Policy>>,
    /// A human minter's policy subjects (`user:`, `role:`, `team:`) captured
    /// at mint; `None` for machine sessions and sessions minted before they
    /// were recorded.
    minter_subjects: Option<Vec<String>>,
    cache: HashMap<String, String>,
    /// The session's minting principal: the consumer a password-manager
    /// grant names.
    subject: String,
    session_id: String,
}

/// Whether `policies` grant `use` on a `secret:` reference body, starting
/// from no capabilities (the machine-token baseline), with identity templates
/// expanded for the minting `subject` (`machine:<id>`).
fn machine_may_use(policies: &[Policy], subject: &str, body: &str, environment: &str) -> bool {
    let Some(parsed) = SecretRef::parse(body) else {
        return false;
    };
    let key = crate::vault::policy_key(
        &parsed.environment_or(environment),
        &parsed.path,
        &parsed.name,
    );
    crate::vault::policy::evaluate_with(
        &CapabilitySet::new(),
        policies,
        &key,
        &crate::vault::policy_ext::TemplateContext::from_subjects(&[subject.to_owned()]),
    )
    .contains(&Capability::Use)
}

/// Whether a human minter's `subjects` keep `use` on a `secret:` reference
/// body. The baseline is `use`, so only explicit deny rules (including
/// `role:`/`team:` ones) refuse it.
fn minter_may_use(policies: &[Policy], subjects: &[String], body: &str, environment: &str) -> bool {
    let body = body
        .strip_suffix(crate::plugin_secrets::kv::TOTP_SUFFIX)
        .unwrap_or(body);
    let Some(parsed) = SecretRef::parse(body) else {
        return false;
    };
    let key = crate::vault::policy_key(
        &parsed.environment_or(environment),
        &parsed.path,
        &parsed.name,
    );
    let use_only: CapabilitySet = [Capability::Use].into_iter().collect();
    crate::vault::policy::evaluate_with(
        &use_only,
        policies,
        &key,
        &crate::vault::policy_ext::TemplateContext::from_subjects(subjects),
    )
    .contains(&Capability::Use)
}

impl Resolver {
    async fn resolve(&mut self, reference: &str) -> Result<String, Refusal> {
        if let Some(value) = self.cache.get(reference) {
            return Ok(value.clone());
        }
        let unavailable = || {
            Refusal::new(
                StatusCode::BAD_GATEWAY,
                "credential_unavailable",
                &format!("`{reference}` could not be resolved for this session"),
            )
        };
        if let Some(text) = substitute::pm_ref_text(reference) {
            let value = self.resolve_password_manager(reference, text).await?;
            self.cache.insert(reference.to_owned(), value.clone());
            return Ok(value);
        }
        let body = reference.strip_prefix("secret:").ok_or_else(unavailable)?;
        if let Some(policies) = &self.machine_policies {
            if !machine_may_use(policies, &self.subject, body, &self.environment) {
                return Err(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "credential_denied",
                    &format!("the session's machine identity lacks `use` on `{reference}`"),
                ));
            }
        }
        if let Some(subjects) = self.minter_subjects.as_ref().filter(|s| !s.is_empty()) {
            let policies = {
                let conn = self.store.conn.lock().await;
                crate::vault::policy::policies_for(&conn, subjects)
            };
            let policies = policies.map_err(|error| {
                tracing::warn!("broker minter policy lookup failed: {error:#}");
                Refusal::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "broker_internal",
                    "policy lookup failed",
                )
            })?;
            if !minter_may_use(&policies, subjects, body, &self.environment) {
                return Err(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "credential_denied",
                    &format!("the session's minter may not use `{reference}`"),
                ));
            }
        }
        match self.store.resolve_vault_secret(body, &self.context).await {
            Ok(Some(value)) => {
                self.cache.insert(reference.to_owned(), value.clone());
                Ok(value)
            }
            Ok(None) => Err(unavailable()),
            Err(error) => {
                if error
                    .downcast_ref::<VaultError>()
                    .is_some_and(|e| matches!(e, VaultError::Sealed))
                {
                    return Err(Refusal::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "vault_sealed",
                        "the vault is sealed",
                    ));
                }
                tracing::warn!("broker credential resolution failed: {error:#}");
                Err(unavailable())
            }
        }
    }
}

impl Resolver {
    /// Resolve a password-manager reference for the session's minting
    /// principal. Without a grant the request is refused with the pending
    /// approval's id and the provider is not contacted.
    async fn resolve_password_manager(
        &self,
        reference: &str,
        text: &str,
    ) -> Result<String, Refusal> {
        use crate::vault::password_managers::{Consumer, PmOutcome};
        let consumer = Consumer {
            subject: crate::vault::password_managers::broker_subject(&self.subject),
            requested_by: format!("broker_session:{}", self.session_id),
            environment: self.environment.clone(),
            machine_policies: self.machine_policies.clone(),
            // A user-minted session carries its user's policies, including
            // the role and team subjects recorded at mint (deny rules hold); a
            // machine's are checked above, the operator has none.
            policy_subjects: if self.subject.starts_with("user:") {
                PluginSecretStore::context_subjects(&self.context)
            } else {
                Vec::new()
            },
        };
        let actor = crate::vault::audit::AuditActor::new("broker_session", Some(&self.session_id));
        match self.store.pm_resolve(text, &consumer, &actor).await {
            Ok(PmOutcome::Value(value)) => value.into_string().ok_or_else(|| {
                Refusal::new(
                    StatusCode::BAD_GATEWAY,
                    "credential_invalid",
                    "a credential is not valid UTF-8",
                )
            }),
            Ok(PmOutcome::Pending(proposal)) => Err(Refusal {
                response: json_response(
                    StatusCode::FORBIDDEN,
                    "credential_approval_required",
                    serde_json::json!({
                        "error": "credential_approval_required",
                        "message": format!(
                            "`{reference}` needs a human approval before this session can use it"
                        ),
                        "approvalId": proposal.id,
                        "pollUrl": format!("{PROPOSALS_ENDPOINT}/{}", proposal.id),
                    }),
                ),
                outcome: "credential_approval_required",
            }),
            Err(error) => {
                let refusal = match error.downcast_ref::<VaultError>() {
                    Some(VaultError::Sealed) => Refusal::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "vault_sealed",
                        "the vault is sealed",
                    ),
                    Some(VaultError::AuditUnavailable) => Refusal::new(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "vault_audit_unavailable",
                        "the credential use could not be audited",
                    ),
                    Some(VaultError::Denied(_)) => Refusal::new(
                        StatusCode::FORBIDDEN,
                        "credential_denied",
                        &format!("the session's principal may not use `{reference}`"),
                    ),
                    _ => Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "credential_unavailable",
                        &format!("`{reference}` could not be resolved for this session"),
                    ),
                };
                tracing::warn!("broker password-manager resolution failed: {error:#}");
                Err(refusal)
            }
        }
    }
}

#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
