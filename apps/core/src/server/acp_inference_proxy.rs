//! Refreshable Gateway inference credential for long-lived ACP agents.
//!
//! Core scopes Gateway inference to an agent, user and session with a
//! short-lived `gws1` bearer. Putting that bearer in an agent's spawn
//! environment froze it for the life of the process, so a pooled agent had to
//! be respawned whenever the bearer was reminted. Instead, a pooled agent gets a
//! per-instance local credential and its OpenAI-compatible base URL points at
//! `/api/acp/inference/v1` on Core. For every request Core resolves the
//! credential to the scope it was issued for and forwards to the local Gateway
//! with the current `gws1` bearer for that scope, so the bearer keeps its normal
//! lifetime while the process keeps running.
//!
//! The credential is not an authority of its own. It resolves to exactly one
//! scope fixed at issue, is accepted only on this route, only from loopback,
//! only while its instance is in a turn (or briefly after one), and is revoked
//! when its grant drops: the instance exiting for any reason, or the pool
//! evicting it. Only the hash of the credential is stored.

use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{ConnectInfo, Path, Request},
    http::{HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use futures_util::TryStreamExt as _;
use rand::RngCore as _;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::sidecar::adapters::acp::AcpInstanceActivity;

/// Prefix of a per-instance credential, so the route can tell it from a raw
/// `gws1` bearer without a lookup.
pub(crate) const CREDENTIAL_PREFIX: &str = "ryuacpi_";
/// Route prefix the agent's OpenAI-compatible base URL points at.
pub(crate) const PROXY_PREFIX: &str = "/api/acp/inference";
/// Hard ceiling on one grant, however busy its instance stays. A pooled
/// instance whose grant reached it is replaced on its next turn.
const MAX_GRANT_LIFETIME: Duration = Duration::from_secs(12 * 60 * 60);
/// A pooled instance is reused for a new turn only while its grant has at
/// least this long left.
const TURN_LIFETIME_MARGIN: Duration = Duration::from_secs(60 * 60);
/// An idle instance may finish trailing calls for this long after its turn
/// ended; after that a process it left behind cannot spend as the agent.
const IDLE_GRACE_MS: u64 = 2 * 60 * 1000;
/// Largest inference request body the proxy forwards.
const MAX_BODY_BYTES: usize = 32 * 1024 * 1024;
/// The only Gateway endpoints an ACP agent reaches through the proxy.
const FORWARDED_ENDPOINTS: [(&str, &str); 5] = [
    ("POST", "chat/completions"),
    ("POST", "responses"),
    ("POST", "completions"),
    ("POST", "embeddings"),
    ("GET", "models"),
];
/// Request headers forwarded to the Gateway besides the bearer. Identity
/// headers are still checked against the bearer's scope by the Gateway.
const FORWARDED_HEADERS: [&str; 12] = [
    "content-type",
    "accept",
    "user-agent",
    "openai-beta",
    "x-ryu-session-id",
    "x-ryu-user-id",
    "x-ryu-agent-id",
    "x-ryu-node-routing",
    "x-ryu-feature",
    "x-ryu-priority",
    "x-ryu-prompt-cache",
    "x-ryu-prompt-cache-ttl",
];
/// Headers a reverse proxy or tunnel adds; their presence means the request did
/// not come from a local agent process.
const FORWARDING_HEADERS: [&str; 4] = [
    "forwarded",
    "x-forwarded-for",
    "x-real-ip",
    "cf-connecting-ip",
];

/// The Gateway identity a credential resolves to. Fixed at issue; nothing in a
/// request can change it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AcpInferenceScope {
    pub(crate) agent_id: String,
    pub(crate) user_id: Option<String>,
    pub(crate) session_id: Option<String>,
    /// The agent's signed model provider access, carried from the bearer this
    /// credential was redeemed from. The proxy re-signs the bearer on every
    /// request, so it must sign this list back in or a limited agent would get
    /// an unrestricted Gateway bearer. `None` means no provider limit.
    pub(crate) provider_access: Option<Vec<String>>,
}

impl AcpInferenceScope {
    pub(crate) fn from_bearer_scope(scope: &ryu_gw_credentials::InferenceScope) -> Self {
        Self {
            agent_id: scope.agent_id.clone(),
            user_id: scope.user_id.clone(),
            session_id: scope.session_id.clone(),
            provider_access: scope.provider_access.clone(),
        }
    }

    /// Stable, unambiguous text for a pool security key.
    pub(crate) fn fingerprint(&self) -> String {
        serde_json::json!({
            "agentId": self.agent_id,
            "userId": self.user_id,
            "sessionId": self.session_id,
            "providerAccess": self.provider_access,
        })
        .to_string()
    }
}

struct GrantRecord {
    scope: AcpInferenceScope,
    issued_at: Instant,
    activity: Option<Arc<AcpInstanceActivity>>,
}

#[derive(Default)]
struct BrokerState {
    records: HashMap<[u8; 32], GrantRecord>,
    grants: HashMap<Uuid, [u8; 32]>,
}

#[derive(Clone, Default)]
struct AcpInferenceBroker {
    state: Arc<Mutex<BrokerState>>,
}

/// The credential is deliberately absent from Debug/Serialize and is never
/// logged. Its Drop revokes the record, so the credential dies with the
/// instance task that holds it, including on error and panic.
pub(crate) struct AcpInferenceGrant {
    grant_id: Uuid,
    credential: String,
    broker: AcpInferenceBroker,
}

impl AcpInferenceGrant {
    pub(crate) fn grant_id(&self) -> Uuid {
        self.grant_id
    }

    pub(crate) fn credential(&self) -> &str {
        &self.credential
    }
}

impl Drop for AcpInferenceGrant {
    fn drop(&mut self) {
        self.broker.revoke(self.grant_id);
    }
}

fn global_broker() -> &'static AcpInferenceBroker {
    static BROKER: OnceLock<AcpInferenceBroker> = OnceLock::new();
    BROKER.get_or_init(AcpInferenceBroker::default)
}

/// Issue a credential for one instance. `activity` gates it to the instance's
/// turns; `None` is for an unpooled instance that lives for one turn.
pub(crate) fn issue(
    scope: AcpInferenceScope,
    activity: Option<Arc<AcpInstanceActivity>>,
) -> AcpInferenceGrant {
    global_broker().issue(scope, activity, Instant::now())
}

pub(crate) fn revoke(grant_id: Uuid) {
    global_broker().revoke(grant_id);
}

/// Whether a pooled instance's grant can still serve another turn: it is live
/// and has [`TURN_LIFETIME_MARGIN`] left, so the turn does not outlive it.
pub(crate) fn is_current(grant_id: Uuid) -> bool {
    global_broker().is_current(grant_id, Instant::now())
}

/// Resolve a presented credential to the scope it was issued for, if it is
/// live and its instance is in a turn.
pub(crate) fn authorize(credential: &str) -> Option<AcpInferenceScope> {
    global_broker().authorize(credential, Instant::now(), unix_now_ms())
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

impl AcpInferenceBroker {
    fn issue(
        &self,
        scope: AcpInferenceScope,
        activity: Option<Arc<AcpInstanceActivity>>,
        now: Instant,
    ) -> AcpInferenceGrant {
        let mut random = [0_u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut random);
        let credential = format!(
            "{CREDENTIAL_PREFIX}{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random)
        );
        random.fill(0);
        let hash: [u8; 32] = Sha256::digest(credential.as_bytes()).into();
        let grant_id = Uuid::new_v4();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.grants.insert(grant_id, hash);
        state.records.insert(
            hash,
            GrantRecord {
                scope,
                issued_at: now,
                activity,
            },
        );
        AcpInferenceGrant {
            grant_id,
            credential,
            broker: self.clone(),
        }
    }

    fn revoke(&self, grant_id: Uuid) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(hash) = state.grants.remove(&grant_id) {
            state.records.remove(&hash);
        }
    }

    fn is_current(&self, grant_id: Uuid, now: Instant) -> bool {
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .grants
            .get(&grant_id)
            .and_then(|hash| state.records.get(hash))
            .is_some_and(|record| within_lifetime(record, now + TURN_LIFETIME_MARGIN))
    }

    fn authorize(&self, credential: &str, now: Instant, now_ms: u64) -> Option<AcpInferenceScope> {
        if !credential.starts_with(CREDENTIAL_PREFIX) {
            return None;
        }
        let hash: [u8; 32] = Sha256::digest(credential.as_bytes()).into();
        let state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let record = state.records.get(&hash)?;
        if !within_lifetime(record, now) {
            return None;
        }
        let in_turn = record.activity.as_ref().is_none_or(|activity| {
            activity
                .idle_since()
                .is_none_or(|since| now_ms.saturating_sub(since) <= IDLE_GRACE_MS)
        });
        in_turn.then(|| record.scope.clone())
    }
}

fn within_lifetime(record: &GrantRecord, now: Instant) -> bool {
    now.saturating_duration_since(record.issued_at) < MAX_GRANT_LIFETIME
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({ "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// Only an agent process on this machine holds a credential, so refuse a
/// remote peer and anything relayed by a tunnel or reverse proxy.
fn request_is_local(request: &Request) -> bool {
    if FORWARDING_HEADERS
        .iter()
        .any(|name| request.headers().contains_key(*name))
    {
        return false;
    }
    let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() else {
        // In-process callers (tests) carry no connection info.
        return true;
    };
    peer.ip().is_loopback() || core_listens_on(peer.ip())
}

/// Core bound to one specific address dials itself on that address.
fn core_listens_on(ip: std::net::IpAddr) -> bool {
    reqwest::Url::parse(&crate::sidecar::gateway::core_self_url())
        .ok()
        .and_then(|url| match url.host()? {
            url::Host::Ipv4(host) => Some(std::net::IpAddr::V4(host)),
            url::Host::Ipv6(host) => Some(std::net::IpAddr::V6(host)),
            url::Host::Domain(_) => None,
        })
        .is_some_and(|host| host == ip)
}

/// The fixed endpoint path for an allowed request; the caller's path text is
/// never forwarded, so it cannot escape `/v1/`.
fn forwarded_endpoint(method: &Method, rest: &str) -> Option<&'static str> {
    FORWARDED_ENDPOINTS
        .iter()
        .find(|(allowed_method, path)| method.as_str() == *allowed_method && rest == *path)
        .map(|(_, path)| *path)
}

/// Why no upstream bearer is presented.
enum Refusal {
    Unauthorized,
    Unavailable,
}

impl Refusal {
    fn into_response(self) -> Response {
        match self {
            Self::Unauthorized => unauthorized(),
            Self::Unavailable => error(
                StatusCode::SERVICE_UNAVAILABLE,
                "acp_inference_unavailable",
                "The Gateway credential for this agent could not be issued.",
            ),
        }
    }
}

/// The bearer to present upstream: the current one for a per-instance
/// credential's scope, or a raw Core-signed `gws1` bearer passed through
/// unchanged (an agent started without a pooled grant, such as a probe).
fn upstream_bearer(presented: &str) -> Result<String, Refusal> {
    if presented.starts_with(CREDENTIAL_PREFIX) {
        let scope = authorize(presented).ok_or(Refusal::Unauthorized)?;
        return crate::sidecar::gateway::scoped_inference_bearer(
            &scope.agent_id,
            scope.user_id.as_deref(),
            scope.session_id.as_deref(),
            scope.provider_access.as_deref(),
        )
        .map_err(|_| Refusal::Unavailable);
    }
    // A tunnel re-originates remote streams as loopback connections, so while
    // one is forwarding a raw bearer could come from off this machine. Only a
    // per-instance credential, held by a live local agent, is accepted then.
    if !crate::sidecar::forwarding_tunnel_active()
        && crate::sidecar::gateway::verify_scoped_inference_bearer(presented).is_some()
    {
        return Ok(presented.to_owned());
    }
    Err(Refusal::Unauthorized)
}

fn unauthorized() -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        "acp_inference_unauthorized",
        "A live ACP agent inference credential is required.",
    )
}

/// Two shared clients: the local Gateway is dialed directly (a system proxy must
/// not see loopback inference), any other Gateway honours the system proxy.
/// Connect timeout only, so long streamed responses are not cut off.
fn upstream_client(gateway_url: &str) -> &'static reqwest::Client {
    static DIRECT: OnceLock<reqwest::Client> = OnceLock::new();
    static PROXIED: OnceLock<reqwest::Client> = OnceLock::new();
    let loopback = reqwest::Url::parse(gateway_url)
        .ok()
        .is_some_and(|url| match url.host() {
            Some(url::Host::Ipv4(host)) => host.is_loopback(),
            Some(url::Host::Ipv6(host)) => host.is_loopback(),
            Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
            None => false,
        });
    let build = |direct: bool| {
        let builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(10));
        let builder = if direct { builder.no_proxy() } else { builder };
        builder.build().unwrap_or_default()
    };
    if loopback {
        DIRECT.get_or_init(|| build(true))
    } else {
        PROXIED.get_or_init(|| build(false))
    }
}

/// `ANY /api/acp/inference/v1/*rest`: forward an ACP agent's model call to the
/// local Gateway with the current scoped bearer.
pub(crate) async fn proxy(Path(rest): Path<String>, request: Request) -> Response {
    if !request_is_local(&request) {
        return error(
            StatusCode::FORBIDDEN,
            "acp_inference_local_only",
            "ACP agent inference is accepted only from this machine.",
        );
    }
    if !crate::sidecar::gateway::scoped_inference_proxy_enabled()
        || crate::sidecar::gateway::local_gateway_quarantined()
    {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "acp_inference_unavailable",
            "The local Gateway is not available for ACP agent inference.",
        );
    }
    let (parts, body) = request.into_parts();
    let Some(presented) = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
    else {
        return unauthorized();
    };
    let bearer = match upstream_bearer(presented) {
        Ok(bearer) => bearer,
        Err(refusal) => return refusal.into_response(),
    };
    let Some(endpoint) = forwarded_endpoint(&parts.method, &rest) else {
        return error(
            StatusCode::NOT_FOUND,
            "acp_inference_not_found",
            "This endpoint is not available to ACP agents.",
        );
    };
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "invalid_request",
            "The request body is too large.",
        );
    };
    let gateway = crate::sidecar::gateway::configured_gateway_url();
    let mut url = format!("{}/v1/{endpoint}", gateway.trim_end_matches('/'));
    if let Some(query) = parts.uri.query() {
        url.push('?');
        url.push_str(query);
    }
    let mut upstream = upstream_client(&gateway)
        .request(parts.method.clone(), url)
        .bearer_auth(&bearer)
        .body(body);
    for name in FORWARDED_HEADERS {
        if let Some(value) = parts.headers.get(name) {
            upstream = upstream.header(name, value.clone());
        }
    }
    let response = match upstream.send().await {
        Ok(response) => response,
        Err(_) => {
            return error(
                StatusCode::BAD_GATEWAY,
                "acp_inference_unavailable",
                "The Gateway could not be reached.",
            )
        }
    };
    let status = response.status();
    let content_type = response.headers().get("content-type").cloned();
    let stream = response.bytes_stream().map_err(std::io::Error::other);
    let mut relayed = Response::new(Body::from_stream(stream));
    *relayed.status_mut() = status;
    relayed.headers_mut().insert(
        "content-type",
        content_type.unwrap_or_else(|| HeaderValue::from_static("application/json")),
    );
    relayed
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    relayed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(agent: &str, session: Option<&str>) -> AcpInferenceScope {
        AcpInferenceScope {
            agent_id: agent.into(),
            user_id: None,
            session_id: session.map(str::to_owned),
            provider_access: None,
        }
    }

    #[test]
    fn each_credential_resolves_only_its_own_scope() {
        let broker = AcpInferenceBroker::default();
        let now = Instant::now();
        let a = broker.issue(scope("agent-a", Some("chat-1")), None, now);
        let b = broker.issue(scope("agent-b", Some("chat-2")), None, now);
        assert_ne!(a.credential(), b.credential());
        assert!(a.credential().starts_with(CREDENTIAL_PREFIX));
        assert_eq!(
            broker.authorize(a.credential(), now, 0),
            Some(scope("agent-a", Some("chat-1")))
        );
        assert_eq!(
            broker.authorize(b.credential(), now, 0),
            Some(scope("agent-b", Some("chat-2")))
        );
        let forged = format!("{CREDENTIAL_PREFIX}{}", "A".repeat(43));
        for refused in [
            forged.as_str(),
            "",
            CREDENTIAL_PREFIX,
            &a.credential()[CREDENTIAL_PREFIX.len()..],
        ] {
            assert_eq!(broker.authorize(refused, now, 0), None);
        }
        // A raw scoped bearer is never a per-instance credential.
        assert_eq!(broker.authorize("gws1.00.00", now, 0), None);
    }

    #[test]
    fn revocation_and_the_lifetime_cap_end_a_credential() {
        let broker = AcpInferenceBroker::default();
        let now = Instant::now();
        let revoked = broker.issue(scope("agent-a", None), None, now);
        let kept = broker.issue(scope("agent-a", None), None, now);
        broker.revoke(revoked.grant_id());
        assert_eq!(broker.authorize(revoked.credential(), now, 0), None);
        assert!(!broker.is_current(revoked.grant_id(), now));
        // Revoking one instance leaves another instance of the same scope alone.
        assert!(broker.authorize(kept.credential(), now, 0).is_some());
        // A new turn is not started on a grant that could expire during it.
        let near_cap = now + MAX_GRANT_LIFETIME - TURN_LIFETIME_MARGIN;
        assert!(broker.authorize(kept.credential(), near_cap, 0).is_some());
        assert!(!broker.is_current(kept.grant_id(), near_cap));
        let later = now + MAX_GRANT_LIFETIME;
        assert_eq!(broker.authorize(kept.credential(), later, 0), None);
        let credential = kept.credential().to_owned();
        drop(kept);
        assert_eq!(broker.authorize(&credential, now, 0), None);
        assert!(broker.state.lock().unwrap().records.is_empty());
    }

    #[test]
    fn only_fixed_inference_endpoints_are_forwarded() {
        assert_eq!(
            forwarded_endpoint(&Method::POST, "responses"),
            Some("responses")
        );
        assert_eq!(
            forwarded_endpoint(&Method::POST, "chat/completions"),
            Some("chat/completions")
        );
        assert_eq!(forwarded_endpoint(&Method::GET, "models"), Some("models"));
        for (method, rest) in [
            (Method::GET, "responses"),
            (Method::POST, "models"),
            (Method::POST, "../admin"),
            (Method::POST, "responses/../budget/charge"),
            (Method::POST, "chat/completions/"),
            (Method::POST, "chat\\completions"),
            (Method::POST, "..\\budget\\charge"),
            (Method::POST, "responses?x=1"),
            (Method::POST, "responses#x"),
            (Method::POST, "budget/charge"),
            (Method::POST, "agents/x/chat/completions"),
            (Method::GET, "models/gpt"),
            (Method::DELETE, "responses"),
        ] {
            assert_eq!(forwarded_endpoint(&method, rest), None, "{method} {rest}");
        }
    }

    fn request_from(peer: Option<&str>, header: Option<&str>) -> Request {
        let mut builder = axum::http::Request::builder().uri("/api/acp/inference/v1/responses");
        if let Some(name) = header {
            builder = builder.header(name, "203.0.113.9");
        }
        let mut request = builder.body(Body::empty()).unwrap();
        if let Some(peer) = peer {
            request
                .extensions_mut()
                .insert(ConnectInfo(peer.parse::<SocketAddr>().unwrap()));
        }
        request
    }

    #[test]
    fn only_local_unrelayed_requests_are_served() {
        assert!(request_is_local(&request_from(
            Some("127.0.0.1:5000"),
            None
        )));
        assert!(request_is_local(&request_from(Some("[::1]:5000"), None)));
        assert!(!request_is_local(&request_from(
            Some("203.0.113.9:5000"),
            None
        )));
        for header in FORWARDING_HEADERS {
            assert!(
                !request_is_local(&request_from(Some("127.0.0.1:5000"), Some(header))),
                "{header}"
            );
        }
    }

    #[tokio::test]
    async fn a_remote_peer_is_refused_before_any_credential_check() {
        let response = proxy(
            Path("responses".to_owned()),
            request_from(Some("203.0.113.9:5000"), None),
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[test]
    fn a_limited_agents_reminted_bearer_keeps_its_provider_list() {
        use crate::sidecar::gateway::{cached_inference_bearer, InferenceBearerCache};
        let signer = "gwcore_fixture_signing_1234567890";
        let list = vec!["openai".to_owned()];
        let limited = ryu_gw_credentials::InferenceScope {
            agent_id: "agent-a".into(),
            user_id: Some("user-a".into()),
            session_id: Some("conv-a".into()),
            expires_at: u64::MAX / 2,
            provider_access: Some(list.clone()),
        };
        // The proxy keeps only what the grant stored, so the list must survive it.
        let stored = AcpInferenceScope::from_bearer_scope(&limited);
        assert_eq!(stored.provider_access.as_deref(), Some(list.as_slice()));
        let mut cache = InferenceBearerCache::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let reminted = cached_inference_bearer(
            &mut cache,
            signer,
            &stored.agent_id,
            stored.user_id.as_deref(),
            stored.session_id.as_deref(),
            stored.provider_access.as_deref(),
            now,
        )
        .unwrap();
        let verified = ryu_gw_credentials::InferenceScope::verify(&reminted, signer).unwrap();
        assert_eq!(verified.provider_access.as_deref(), Some(list.as_slice()));
        // An unrestricted agent's bearer is a different scope and stays unlimited.
        let unlimited =
            cached_inference_bearer(&mut cache, signer, "agent-a", None, None, None, now).unwrap();
        let unlimited = ryu_gw_credentials::InferenceScope::verify(&unlimited, signer).unwrap();
        assert_eq!(unlimited.provider_access, None);
    }

    #[test]
    fn provider_access_is_part_of_the_scope_fingerprint() {
        let base = scope("a", Some("s"));
        let limited = AcpInferenceScope {
            provider_access: Some(vec!["openai".into()]),
            ..base.clone()
        };
        let other = AcpInferenceScope {
            provider_access: Some(vec!["anthropic".into()]),
            ..base.clone()
        };
        let empty = AcpInferenceScope {
            provider_access: Some(Vec::new()),
            ..base.clone()
        };
        let fingerprints = [
            base.fingerprint(),
            limited.fingerprint(),
            other.fingerprint(),
            empty.fingerprint(),
        ];
        for (index, left) in fingerprints.iter().enumerate() {
            for right in &fingerprints[index + 1..] {
                assert_ne!(left, right);
            }
        }
    }

    #[test]
    fn scope_fingerprints_are_distinct_per_field() {
        let base = scope("a", Some("s")).fingerprint();
        assert_ne!(base, scope("b", Some("s")).fingerprint());
        assert_ne!(base, scope("a", None).fingerprint());
        assert_ne!(
            base,
            AcpInferenceScope {
                user_id: Some("u".into()),
                ..scope("a", Some("s"))
            }
            .fingerprint()
        );
    }
}
