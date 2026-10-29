//! Transparent passthrough proxy for native-format agent CLIs (M2 / subscription
//! governance).
//!
//! Some agents — notably **Claude Code** — speak a provider-native wire format
//! (Anthropic Messages) and authenticate with the user's **own** subscription
//! credential (a Pro/Max OAuth bearer), not an API key. The regular gateway chat
//! path can't govern them: it speaks OpenAI-compat and substitutes its *own*
//! provider key. Reverse-engineering each ACP transport is also a dead end — the
//! LLM HTTP call happens *inside* the agent subprocess, invisible to ACP.
//!
//! The mechanism that *does* work is a **same-format transparent reverse proxy**.
//! The agent is pointed at this endpoint via a base-URL env (`ANTHROPIC_BASE_URL`
//! for Claude Code). Because Claude Code speaks Anthropic and forwards to
//! Anthropic, we don't translate formats at all: we accept the native request,
//! apply request-side DLP/firewall + audit, then forward it upstream to
//! `api.anthropic.com` with the caller's **own** `Authorization` header
//! **unchanged** — preserving their subscription billing. We never inject a BYOK
//! key (that would flip auth off the subscription).
//!
//! ## Security boundary
//! This endpoint forwards the user's subscription bearer in transit, so it is
//! bound **loopback-only** — a request from a non-loopback peer is refused. A
//! remote gateway must never carry a user's subscription credential, so the
//! route is also refused outright in fleet mode, where external callers reach
//! the process through a co-located proxy and appear as loopback.
//!
//! The route takes no Gateway credential (the `Authorization` header is the
//! user's own subscription bearer), so loopback is not an identity:
//! `x-ryu-user-id` / `x-ryu-agent-id` / `x-ryu-feature` are recorded only when
//! the request also presents the master key or a `trusted_forwarder` key in
//! `x-ryu-gateway-key`, and no `x-ryu-*` header is forwarded upstream.
//!
//! ## Supported agents
//! - **Claude Code** → Anthropic Messages (`/passthrough/anthropic/*`), upstream
//!   `api.anthropic.com`, auth = subscription OAuth bearer.
//! - **Codex** (ChatGPT-login) → OpenAI Responses (`/passthrough/openai-responses/*`),
//!   upstream `chatgpt.com/backend-api/codex`, auth = OAuth bearer **plus** the
//!   `ChatGPT-Account-ID` header. Both are forwarded UNCHANGED; dropping the
//!   account id yields a backend 401/403, so it is explicitly never stripped.
//!
//! ## Redaction scope
//! - **Request-side** redaction (what goes upstream) buffers cleanly and is the
//!   primary DLP win — applied here with the resolved (node → org → trusted
//!   agent) scanner when the firewall is enabled. It covers every
//!   prompt-bearing string, including tool results, tool inputs, replayed
//!   function-call output and tool definitions
//!   (`ryu_gw_passthrough::visit_request_strings_mut`). Agent traffic always
//!   redacts rather than following a Block policy: a blocked turn would re-send
//!   the same history and stall the session. A PII/secret match that survives
//!   redaction refuses the request, and control-plane locked guardrails and the
//!   model allowlist are enforced as on the chat path.
//! - **Provider and region policy** applies to every passthrough endpoint before
//!   the body is read: the fixed upstream (`anthropic` for Claude Code,
//!   `openai` for Codex) must be in `approvedProviders`, and because neither
//!   upstream has verified region metadata, any `allowedRegions` restriction
//!   refuses the route. When a trusted credential vouches for `x-ryu-user-id`,
//!   the node policy is narrowed by that caller's own rules first.
//! - **Response-side** redaction (#455): as the upstream SSE response streams
//!   back, each complete event is reassembled across network-chunk boundaries and
//!   its assistant-text delta (`text_delta` for Anthropic,
//!   `output_text.delta` for Responses) is run through the firewall's
//!   config-gated `sanitize` — matched PII/secret spans are rewritten to
//!   `[REDACTED:…]` *before* the bytes reach the caller. All non-text events
//!   (message_start/stop, ping, function-call deltas, …) pass through verbatim,
//!   and SSE framing is preserved. The accumulated redacted text is still scanned
//!   once at stream end to audit any residual outbound violation. Fail-open on a
//!   scanner-less config or an unparseable event (the raw bytes pass through).
//!   The firewall's stable-marker `redact_outbound` secret scrubber (GitHub PATs,
//!   `sk-` keys, AWS AKIAs, `Bearer`/`token=`/`password=` params) also runs per
//!   text-delta and over any non-streaming (JSON) response body at stream end.
//!   Response redaction uses a bounded contiguous pass so a secret split across
//!   adjacent text-delta events is handled before any bytes are returned.

use std::net::SocketAddr;

use axum::{
    body::{Body, Bytes},
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, HeaderName, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use tracing::warn;

use crate::{audit::AuditRecord, firewall::FirewallBackend, state::SharedState};

// The pure passthrough wire-format redaction engine — the request-body DLP
// redactors, the streaming-SSE response redactor (event reassembly + per-delta
// sanitize), the upstream URL / path helpers, and the `WireFormat` marker — was
// extracted to the `ryu-gw-passthrough` crate ("engine moves, wiring stays",
// mirroring `ryu-gw-firewall`). The reverse-proxy `forward` orchestration below,
// audit emission, the loopback boundary, and the `PassthroughBackend` /
// `PassthroughRegistry` pipeline wiring stay here and consume the crate. The
// engine reaches the firewall only through the crate's narrow
// [`ryu_gw_passthrough::PassthroughFirewall`] trait, implemented just below for
// the gateway's `dyn FirewallBackend` (the `with_firewall` closure type) and its
// concrete `FirewallScanner` (the redaction unit tests). `WireFormat` is
// re-exported so `crate::passthrough::WireFormat` paths resolve unchanged.
use ryu_gw_passthrough::{
    build_upstream_url, classify_path, is_safe_upstream_path, redact_sse_stream,
    visit_request_conversation_strings_mut, visit_request_strings_mut, PassthroughFirewall,
};
pub(crate) use ryu_gw_passthrough::{PassthroughRoute, WireFormat};

impl PassthroughFirewall for dyn FirewallBackend + '_ {
    fn sanitize(&self, text: &str) -> String {
        FirewallBackend::sanitize(self, text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        FirewallBackend::redact_outbound(self, text)
    }
}

impl PassthroughFirewall for crate::firewall::FirewallScanner {
    fn sanitize(&self, text: &str) -> String {
        FirewallBackend::sanitize(self, text)
    }
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
        FirewallBackend::redact_outbound(self, text)
    }
}

/// Default upstream the Anthropic passthrough forwards to. Overridable via
/// `RYU_PASSTHROUGH_ANTHROPIC_UPSTREAM` (the "nothing hardcoded" knob — point it
/// at a regional endpoint or a test double without a rebuild).
const DEFAULT_ANTHROPIC_UPSTREAM: &str = "https://api.anthropic.com";

/// Default upstream the Codex (ChatGPT-login) passthrough forwards to. This is
/// OpenAI's special Codex backend for subscription accounts. Overridable via
/// `RYU_PASSTHROUGH_CODEX_UPSTREAM` (the "nothing hardcoded" knob).
const DEFAULT_CODEX_UPSTREAM: &str = "https://chatgpt.com/backend-api/codex";

/// Hop-by-hop / connection headers that must NOT be forwarded verbatim — reqwest
/// recomputes host/length and manages the connection itself. Everything else
/// (notably `authorization`, `anthropic-version`, `anthropic-beta`, `x-api-key`)
/// is forwarded UNCHANGED so the caller's own subscription auth reaches upstream.
const STRIPPED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "content-length",
    "connection",
    "accept-encoding",
    "transfer-encoding",
];

// Provider credentials and prompt bodies must never follow an upstream redirect.
fn passthrough_http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .expect("failed to build passthrough HTTP client")
    })
}

/// Set by Core on a cloud node: its provider egress proxy, and the state file
/// that says which provider routes currently leave through the owner's desktop.
const PROVIDER_PROXY_ENV: &str = "RYU_PROVIDER_EGRESS_PROXY_URL";
const PROVIDER_STATE_ENV: &str = "RYU_PROVIDER_EGRESS_STATE";

/// The provider proxy as a `reqwest` proxy. Loopback upstreams (test doubles)
/// never go through it.
fn provider_proxy(value: Option<String>) -> Option<reqwest::Proxy> {
    let url = value.filter(|value| !value.trim().is_empty())?;
    let proxy = reqwest::Proxy::all(url.trim()).ok()?;
    Some(proxy.no_proxy(reqwest::NoProxy::from_string("localhost,127.0.0.1,::1")))
}

/// What Core's state file says about the Claude route.
#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaudeRoute {
    /// Whether Claude must leave through the owner's desktop.
    active: bool,
    /// Core's current provider listener, when the file names one.
    proxy: Option<String>,
}

/// Parse the state file. A file that cannot be read or parsed counts as active
/// with no proxy named, so the Gateway falls back to the proxy Core passed at
/// spawn and never leaves directly while a route may apply.
fn claude_route(contents: Option<&str>) -> ClaudeRoute {
    let Some(parsed) = contents.and_then(|text| serde_json::from_str::<Value>(text).ok()) else {
        return ClaudeRoute {
            active: true,
            proxy: None,
        };
    };
    let active = parsed
        .get("active")
        .and_then(Value::as_array)
        .is_none_or(|active| active.iter().any(|id| id.as_str() == Some("claude")));
    let proxy = parsed
        .get("proxy")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|proxy| !proxy.is_empty())
        .map(str::to_owned);
    ClaudeRoute { active, proxy }
}

/// Read the state file for this request. It is a few bytes and model requests
/// are long, so reading it every time costs nothing noticeable and a route the
/// owner just turned on applies to the very next request. `None` when Core set
/// no state file: this node does not route providers.
async fn claude_route_now() -> Option<ClaudeRoute> {
    let path = std::env::var_os(PROVIDER_STATE_ENV)?;
    Some(claude_route(
        tokio::fs::read_to_string(path).await.ok().as_deref(),
    ))
}

/// Why an Anthropic passthrough call was refused: the Claude route applies but
/// the Gateway has no working provider proxy.
const CLAUDE_ROUTE_UNAVAILABLE: &str = "Claude traffic must leave through the owner's computer, but this node's route for it is not running";

/// Which proxy, if any, carries Anthropic: `Ok(None)` is the direct client,
/// `Err` refuses. The state file's proxy (Core's current listener) wins over
/// the one passed at spawn, which a Core restart may have replaced.
fn anthropic_proxy(
    route: Option<ClaudeRoute>,
    spawn_proxy: Option<String>,
) -> Result<Option<String>, &'static str> {
    let Some(route) = route else {
        return Ok(None);
    };
    if !route.active {
        return Ok(None);
    }
    route
        .proxy
        .or(spawn_proxy.filter(|proxy| !proxy.trim().is_empty()))
        .map(Some)
        .ok_or(CLAUDE_ROUTE_UNAVAILABLE)
}

/// The client for one passthrough format: Anthropic uses the node's provider
/// proxy while the Claude route is in effect; everything else, and Anthropic
/// the rest of the time, uses the direct client. `Err` refuses the call: the
/// route applies but cannot carry it, and it must not go out directly.
async fn passthrough_client_for(format: WireFormat) -> Result<reqwest::Client, &'static str> {
    use std::sync::Mutex;
    static ANTHROPIC: Mutex<Option<(String, reqwest::Client)>> = Mutex::new(None);
    if format != WireFormat::Anthropic {
        return Ok(passthrough_http_client().clone());
    }
    let Some(url) = anthropic_proxy(
        claude_route_now().await,
        std::env::var(PROVIDER_PROXY_ENV).ok(),
    )?
    else {
        return Ok(passthrough_http_client().clone());
    };
    let mut cached = ANTHROPIC
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some((cached_url, client)) = cached.as_ref() {
        if *cached_url == url {
            return Ok(client.clone());
        }
    }
    let proxy = provider_proxy(Some(url.clone())).ok_or(CLAUDE_ROUTE_UNAVAILABLE)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(60))
        .proxy(proxy)
        .build()
        .map_err(|_| CLAUDE_ROUTE_UNAVAILABLE)?;
    *cached = Some((url, client.clone()));
    Ok(client)
}

fn anthropic_upstream() -> String {
    std::env::var("RYU_PASSTHROUGH_ANTHROPIC_UPSTREAM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ANTHROPIC_UPSTREAM.to_string())
}

fn codex_upstream() -> String {
    std::env::var("RYU_PASSTHROUGH_CODEX_UPSTREAM")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CODEX_UPSTREAM.to_string())
}

/// `ANY /passthrough/anthropic/{*path}` — transparent reverse proxy to Anthropic.
///
/// Pointed at by Claude Code via `ANTHROPIC_BASE_URL=<gateway>/passthrough/anthropic`;
/// the CLI appends `/v1/messages` (and `/v1/messages/count_tokens`, etc.), which
/// arrive here as `path`.
pub async fn anthropic(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(path): Path<String>,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: Bytes,
) -> Response {
    let backend = state.passthrough.active();
    backend
        .forward(
            WireFormat::Anthropic,
            anthropic_upstream(),
            classify_path(WireFormat::Anthropic, method.as_str(), &path),
            state,
            peer,
            path,
            method,
            headers,
            raw_query,
            body,
        )
        .await
}

/// `ANY /passthrough/openai-responses/{*path}` — transparent reverse proxy to the
/// OpenAI Codex backend for ChatGPT-login (subscription) accounts.
///
/// Pointed at by Codex via an isolated `CODEX_HOME` whose `config.toml` sets a
/// custom `model_provider.base_url = <gateway>/passthrough/openai-responses` with
/// `wire_api = "responses"` and no `env_key`; Codex appends `/responses` and
/// sends its OAuth bearer + `ChatGPT-Account-ID` header, which we forward
/// upstream UNCHANGED (subscription-preserving).
pub async fn codex(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(path): Path<String>,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: Bytes,
) -> Response {
    let backend = state.passthrough.active();
    backend
        .forward(
            WireFormat::OpenAiResponses,
            codex_upstream(),
            classify_path(WireFormat::OpenAiResponses, method.as_str(), &path),
            state,
            peer,
            path,
            method,
            headers,
            raw_query,
            body,
        )
        .await
}

/// Shared transparent reverse-proxy core for every passthrough route. Applies the
/// loopback boundary, the provider and data-region policy (narrowed by a vouched
/// caller's rules), the deny-by-default endpoint classification (`route`),
/// the model allowlist and request-side DLP on prompt endpoints, forwards with
/// the caller's own credentials unchanged, emits audit, and
/// streams the response through a scan-and-audit tee (no response redaction).
#[allow(clippy::too_many_arguments)]
async fn forward(
    format: WireFormat,
    upstream_base: &str,
    route: PassthroughRoute,
    state: SharedState,
    peer: SocketAddr,
    path: String,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: Bytes,
) -> Response {
    // ── Security boundary: loopback only, never on a hosted gateway ───────────
    // This path forwards the user's subscription bearer; never expose it to a
    // remote peer even if the gateway itself binds 0.0.0.0. In fleet mode an
    // external caller arrives through the co-located proxy and appears as
    // 127.0.0.1, so loopback proves nothing there: a hosted gateway must never
    // carry a subscription credential at all.
    if !peer.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "passthrough proxy is loopback-only").into_response();
    }
    if crate::custody::exposure_hardened(state.config.fleet, state.custody) {
        return (
            StatusCode::FORBIDDEN,
            "passthrough proxy is disabled in fleet mode",
        )
            .into_response();
    }

    if !is_safe_upstream_path(&path) {
        return (StatusCode::BAD_REQUEST, "invalid passthrough path").into_response();
    }

    let started = std::time::Instant::now();
    let url = build_upstream_url(upstream_base, &path, raw_query.0.as_deref());

    // Control-plane attribution (profiles / usage-points): tag the audit row with
    // the forwarded end-user id + product surface only when a trusted forwarder
    // vouches for them. The route itself takes no Gateway credential, so a bare
    // `x-ryu-user-id` is self-asserted and is never recorded.
    let PassthroughIdentity {
        user_id,
        agent_id,
        feature,
    } = PassthroughIdentity::from_headers(&state, &headers);

    // ── Request-side DLP ───────────────────────────────────────────────────────
    // The resolved scanner (node → org → trusted agent overlay) redacts every
    // prompt-bearing string on prompt endpoints. Only the short inert allow-list
    // (model listing, batch status) is proxied uninspected; any other endpoint
    // cannot be evaluated, so it is refused while a prompt policy is in force.
    // Agent traffic always redacts (it never blocks on a redactable match,
    // whatever the firewall policy), because a blocked turn would re-send the
    // same history and stall the agent session for good.
    let scanner = state.passthrough_scanner(agent_id.as_deref());
    let policy = passthrough_policy(&state, user_id.as_deref()).await;
    // ── Provider and data-region policy ───────────────────────────────────────
    // Enforced on every passthrough endpoint, before the body is read, as on
    // every other Gateway PEP (`inference_governance::authorize_provider_region`).
    if let Err(reason) = authorize_upstream(format, &policy) {
        return refuse_request(
            &state,
            format,
            "unknown",
            started,
            reason,
            (user_id, agent_id, feature),
        );
    }
    let redact = scanner.config().enabled && scanner.config().scan_inbound;
    // An inert endpoint carries no prompt; a body on one is not inert.
    let route = match route {
        PassthroughRoute::Inert if !body.is_empty() => PassthroughRoute::Unknown,
        route => route,
    };
    let governed = redact
        || policy.requires_firewall()
        || !policy.approved_models.is_empty()
        || !policy.available;
    if route == PassthroughRoute::Unknown {
        let reason =
            format!("passthrough endpoint '{method} {path}' carries no inspectable prompt");
        if governed {
            return refuse_request(
                &state,
                format,
                "unknown",
                started,
                format!("{reason} and is not allowed while prompt policy is enforced"),
                (user_id, agent_id, feature),
            );
        }
        warn!(
            provider = provider_label(format),
            %reason,
            "passthrough: proxying an uninspected endpoint"
        );
    }
    let prompt_route = matches!(
        route,
        PassthroughRoute::Prompt | PassthroughRoute::MessageBatch
    );
    let inspect = prompt_route && (redact || policy.requires_firewall());
    if inspect
        && headers.get_all("content-encoding").iter().any(|value| {
            value
                .to_str()
                .map_or(true, |value| !value.eq_ignore_ascii_case("identity"))
        })
    {
        return (
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "compressed passthrough prompts cannot be inspected",
        )
            .into_response();
    }
    let mut model = "unknown".to_string();
    let forward_body: Bytes = if prompt_route {
        match serde_json::from_slice::<Value>(&body) {
            Ok(mut json) => {
                let governed_prompt = if route == PassthroughRoute::MessageBatch {
                    govern_message_batch(
                        scanner.as_ref(),
                        &policy,
                        redact,
                        governed,
                        &mut json,
                        &mut model,
                    )
                } else {
                    govern_prompt(
                        format,
                        scanner.as_ref(),
                        &policy,
                        redact,
                        &mut json,
                        &mut model,
                    )
                };
                match governed_prompt {
                    Ok(true) => serde_json::to_vec(&json).map(Bytes::from).unwrap_or(body),
                    Ok(false) => body,
                    Err(reason) => {
                        return refuse_request(
                            &state,
                            format,
                            &model,
                            started,
                            reason,
                            (user_id, agent_id, feature),
                        );
                    }
                }
            }
            // While any prompt policy applies, a body it cannot read is refused.
            Err(_) if governed => {
                return (
                    StatusCode::BAD_REQUEST,
                    "passthrough prompt must be valid JSON",
                )
                    .into_response();
            }
            Err(_) => body,
        }
    } else {
        body
    };

    // ── Forward upstream with the caller's OWN credentials unchanged ───────────
    let client = match passthrough_client_for(format).await {
        Ok(client) => client,
        Err(reason) => {
            emit_audit(
                &state,
                format,
                &model,
                started.elapsed().as_millis() as u64,
                Some(reason.to_owned()),
                user_id.clone(),
                agent_id.clone(),
                feature.clone(),
            );
            return (StatusCode::SERVICE_UNAVAILABLE, reason).into_response();
        }
    };
    let mut req = client.request(method.clone(), &url).body(forward_body);
    let mut req_headers = reqwest::header::HeaderMap::new();
    for (name, value) in &headers {
        // `x-ryu-*` headers are Gateway-local attribution and proof headers; the
        // provider never needs them.
        if STRIPPED_REQUEST_HEADERS.contains(&name.as_str()) || name.as_str().starts_with("x-ryu-")
        {
            continue;
        }
        if let Ok(v) = reqwest::header::HeaderValue::from_bytes(value.as_bytes()) {
            if let Ok(n) = reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()) {
                req_headers.insert(n, v);
            }
        }
    }
    req = req.headers(req_headers);

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            emit_audit(
                &state,
                format,
                &model,
                started.elapsed().as_millis() as u64,
                Some(format!("upstream request failed: {e}")),
                user_id.clone(),
                agent_id.clone(),
                feature.clone(),
            );
            return (
                StatusCode::BAD_GATEWAY,
                format!("passthrough upstream error: {e}"),
            )
                .into_response();
        }
    };

    let status = resp.status();
    emit_audit(
        &state,
        format,
        &model,
        started.elapsed().as_millis() as u64,
        (!status.is_success()).then(|| format!("upstream status {status}")),
        user_id.clone(),
        agent_id.clone(),
        feature.clone(),
    );

    // ── Stream the upstream response through a redact-and-audit tee ────────────
    // Each complete SSE event is reassembled across network-chunk boundaries; the
    // assistant-text delta is sanitized in place (matched PII/secrets → [REDACTED])
    // before reaching the caller, all other events pass verbatim, and the
    // accumulated redacted text is scanned once at stream end to audit any
    // residual outbound violation (#455).
    let mut out = Response::builder().status(status);
    for (name, value) in resp.headers() {
        // Drop framing headers reqwest already decoded; copy the rest (notably
        // content-type so SSE stays `text/event-stream`).
        if matches!(
            name.as_str(),
            "transfer-encoding" | "content-length" | "connection"
        ) {
            continue;
        }
        if let Ok(n) = HeaderName::from_bytes(name.as_str().as_bytes()) {
            if let Ok(v) = axum::http::HeaderValue::from_bytes(value.as_bytes()) {
                out = out.header(n, v);
            }
        }
    }
    let upstream_body = Body::from_stream(resp.bytes_stream());
    let response_body = if scanner.config().enabled {
        redact_response_passthrough(
            upstream_body,
            format,
            state.clone(),
            scanner,
            user_id,
            agent_id,
            feature,
        )
    } else {
        upstream_body
    };
    out.body(response_body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// Header a trusted forwarder uses to authenticate on the passthrough. The
/// `Authorization` header already carries the user's subscription bearer, so the
/// Gateway credential travels separately; it is stripped before forwarding.
const GATEWAY_KEY_HEADER: &str = "x-ryu-gateway-key";

/// Attribution recorded on passthrough audit rows.
#[derive(Debug, Default, PartialEq, Eq)]
struct PassthroughIdentity {
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
}

impl PassthroughIdentity {
    /// Honor `x-ryu-user-id` / `x-ryu-agent-id` / `x-ryu-feature` only when the
    /// request also presents the master key or a `trusted_forwarder` API key in
    /// [`GATEWAY_KEY_HEADER`]; otherwise record no identity. Loopback alone is not
    /// an identity: any local process (or, under userspace mesh networking, a
    /// tailnet peer) can reach this route.
    fn from_headers(state: &SharedState, headers: &HeaderMap) -> Self {
        let Some(key) = header_string(headers, GATEWAY_KEY_HEADER) else {
            return Self::default();
        };
        let key = key.strip_prefix("Bearer ").unwrap_or(&key);
        let trusted = state.with_auth(|auth| {
            auth.master_key
                .as_deref()
                .is_some_and(|master| crate::pipeline::ct_eq(key, master))
                || auth
                    .api_keys
                    .iter()
                    .any(|entry| entry.trusted_forwarder && crate::pipeline::ct_eq(key, &entry.key))
        });
        if !trusted {
            return Self::default();
        }
        Self {
            user_id: header_string(headers, "x-ryu-user-id"),
            agent_id: header_string(headers, "x-ryu-agent-id"),
            feature: header_string(headers, "x-ryu-feature"),
        }
    }
}

/// Apply request-side DLP and locked guardrails to a parsed prompt body in place.
///
/// When `redact` is on, every prompt-bearing string is sanitized; the redacted
/// text is then re-scanned, and a PII/secret match that survived redaction (for
/// example a zero-width split the raw-text regexes miss) refuses the request
/// rather than forwarding it. Control-plane locked guardrails are enforced on
/// the outgoing text even when the local firewall is off, as on the chat path.
/// Returns whether the body changed, or the refusal reason.
fn inspect_request(
    format: WireFormat,
    scanner: &crate::firewall::FirewallScanner,
    policy: &crate::policy::EffectivePolicy,
    redact: bool,
    body: &mut Value,
) -> Result<bool, String> {
    if !redact && policy.locked_guardrails.is_empty() {
        return Ok(false);
    }
    let mut changed = false;
    let mut outgoing = String::new();
    visit_request_strings_mut(format, body, &mut |text| {
        if redact {
            let sanitized = FirewallBackend::sanitize(scanner, text);
            if sanitized != *text {
                *text = sanitized;
                changed = true;
            }
        }
        if !outgoing.is_empty() {
            outgoing.push('\n');
        }
        outgoing.push_str(text);
    });
    if redact {
        let config = scanner.config();
        let mut categories: Vec<String> = Vec::with_capacity(2);
        if config.redact_pii {
            categories.push("pii".to_owned());
        }
        if config.redact_secrets {
            categories.push("secrets".to_owned());
        }
        if let Some(survivor) = scanner.scan_locked_guardrails(&outgoing, &categories) {
            return Err(format!(
                "passthrough prompt content could not be redacted: {} ({:?})",
                survivor.pattern_name, survivor.kind
            ));
        }
    }
    // Locked DLP categories (secrets, PII) scan every outgoing string. The
    // content categories (prompt and code injection, toxicity, bias) scan only
    // the conversation: the agent's own system prompt and tool definitions are
    // agent-authored and would trip them on every turn (Claude Code's Bash tool
    // text matches both the instruction-override and `$(cat …)` patterns).
    let (dlp, content): (Vec<String>, Vec<String>) = policy
        .locked_guardrails
        .iter()
        .cloned()
        .partition(|name| crate::pipeline::is_dlp_guardrail(name));
    let mut violation = scanner.scan_locked_guardrails(&outgoing, &dlp);
    if violation.is_none() && !content.is_empty() {
        let mut conversation = String::new();
        visit_request_conversation_strings_mut(format, body, &mut |text| {
            if !conversation.is_empty() {
                conversation.push('\n');
            }
            conversation.push_str(text);
        });
        violation = scanner.scan_locked_guardrails(&conversation, &content);
    }
    if let Some(violation) = violation {
        return Err(format!(
            "passthrough prompt violates a locked guardrail: {} ({:?})",
            violation.pattern_name, violation.kind
        ));
    }
    Ok(changed)
}

/// Apply the model allowlist and [`inspect_request`] to one native prompt body.
/// A prompt that names no model is refused while the policy restricts models
/// (or is unavailable), so omitting `model` cannot skip the allowlist.
/// Records the first model seen in `model` for the audit row.
fn govern_prompt(
    format: WireFormat,
    scanner: &crate::firewall::FirewallScanner,
    policy: &crate::policy::EffectivePolicy,
    redact: bool,
    prompt: &mut Value,
    model: &mut String,
) -> Result<bool, String> {
    match prompt.get("model").and_then(Value::as_str) {
        Some(requested) => {
            if *model == "unknown" {
                *model = requested.to_owned();
            }
            if !policy.allows_model(requested) {
                return Err(format!(
                    "Model '{requested}' is not approved by control-plane policy"
                ));
            }
        }
        None if !policy.available || !policy.approved_models.is_empty() => {
            return Err(
                "passthrough prompt names no model and control-plane policy restricts models"
                    .to_owned(),
            );
        }
        None => {}
    }
    inspect_request(format, scanner, policy, redact, prompt)
}

/// Govern an Anthropic Message Batches create body: every `requests[].params`
/// is a Messages request and gets the same model allowlist and DLP as
/// `v1/messages`. While any prompt policy is in force, a body that is not a
/// `requests` array of objects with `params` cannot be evaluated and is refused.
fn govern_message_batch(
    scanner: &crate::firewall::FirewallScanner,
    policy: &crate::policy::EffectivePolicy,
    redact: bool,
    governed: bool,
    body: &mut Value,
    model: &mut String,
) -> Result<bool, String> {
    const MALFORMED: &str =
        "passthrough message batch must be a `requests` array of objects with `params`";
    let Some(requests) = body.get_mut("requests").and_then(Value::as_array_mut) else {
        return if governed {
            Err(MALFORMED.to_owned())
        } else {
            Ok(false)
        };
    };
    let mut changed = false;
    for request in requests {
        match request
            .get_mut("params")
            .filter(|params| params.is_object())
        {
            Some(params) => {
                changed |= govern_prompt(
                    WireFormat::Anthropic,
                    scanner,
                    policy,
                    redact,
                    params,
                    model,
                )?;
            }
            None if governed => return Err(MALFORMED.to_owned()),
            None => {}
        }
    }
    Ok(changed)
}

/// The control-plane provider id a passthrough wire format reaches upstream.
fn upstream_provider_id(format: WireFormat) -> &'static str {
    match format {
        WireFormat::Anthropic => "anthropic",
        WireFormat::OpenAiResponses => "openai",
    }
}

/// The policy that governs one passthrough request: the node's effective
/// policy, narrowed by the caller's own rules when a trusted credential vouched
/// for an end-user id (as the chat path narrows `resolved_policy`). Unresolved
/// caller rules yield an unavailable policy, which denies.
async fn passthrough_policy(
    state: &SharedState,
    user_id: Option<&str>,
) -> crate::policy::EffectivePolicy {
    let base = state.policy_snapshot();
    let (Some(cache), Some(user_id)) = (state.user_policy.as_ref(), user_id) else {
        return base;
    };
    let Some(token) = cache.static_key() else {
        return base;
    };
    let rules = cache.rules_for(token, user_id).await;
    crate::policy::policy_for_caller(&base, rules.as_deref())
}

/// Refuse the request unless the policy approves the fixed upstream provider
/// and its data region. The passthrough upstreams carry no verified region
/// metadata, so any `allowed_regions` restriction denies them (fail closed).
fn authorize_upstream(
    format: WireFormat,
    policy: &crate::policy::EffectivePolicy,
) -> Result<(), String> {
    let provider = upstream_provider_id(format);
    if policy.allows_provider(provider) && policy.allows_region(None) {
        return Ok(());
    }
    Err(format!(
        "Provider '{provider}' is not authorized for the control-plane provider or region policy"
    ))
}

/// Refuse a passthrough request before it is forwarded: audit the refusal and
/// return 403 with the reason.
fn refuse_request(
    state: &SharedState,
    format: WireFormat,
    model: &str,
    started: std::time::Instant,
    reason: String,
    (user_id, agent_id, feature): (Option<String>, Option<String>, Option<String>),
) -> Response {
    warn!(provider = provider_label(format), %reason, "passthrough: request refused");
    state.metrics.inc_firewall_blocked();
    emit_audit(
        state,
        format,
        model,
        started.elapsed().as_millis() as u64,
        Some(reason.clone()),
        user_id,
        agent_id,
        feature,
    );
    (StatusCode::FORBIDDEN, reason).into_response()
}

/// Read an optional non-empty header value as an owned string. Mirrors the
/// `x-ryu-*` tag extraction used on the chat path so passthrough audit rows carry
/// the same control-plane attribution.
fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A short, format-specific provider label for audit rows.
fn provider_label(format: WireFormat) -> &'static str {
    match format {
        WireFormat::Anthropic => "anthropic-passthrough",
        WireFormat::OpenAiResponses => "codex-passthrough",
    }
}

fn emit_audit(
    state: &SharedState,
    format: WireFormat,
    model: &str,
    latency_ms: u64,
    error: Option<String>,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) {
    state.log_audit(AuditRecord {
        key_id: None,
        request_id: format!(
            "pt-{}-{}",
            provider_label(format),
            chrono::Utc::now().timestamp_millis()
        ),
        api_key: "passthrough".to_string(),
        user_name: None,
        org_id: None,
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: provider_label(format).to_string(),
        model: model.to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms,
        eval_score: None,
        error,
        skill_ids: None,
        session_id: None,
        user_id,
        agent_id,
        feature,
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

// ── Response-side redaction + audit (#455) ────────────────────────────────────

const MAX_REDACT_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// Tee state for the response redaction. The whole response is held to give the
/// DLP pass one contiguous assistant-text stream; a bounded cap prevents this
/// security fix from becoming an unbounded buffering DoS.
struct ResponseRedactState {
    inner: axum::body::BodyDataStream,
    state: SharedState,
    /// The request's resolved scanner, so response redaction applies the same
    /// overlays as the request side.
    scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    format: WireFormat,
    /// Raw response bytes held until the single contiguous DLP pass. Holding a
    /// bounded response is deliberate: per-delta redaction can miss a secret
    /// split across two SSE events, while an unbounded hold would be a DoS.
    raw: Vec<u8>,
    /// Set once the trailing remainder + audit have been flushed at stream end.
    flushed: bool,
    /// Forwarded end-user id (`x-ryu-user-id`) for the end-of-stream audit row.
    user_id: Option<String>,
    /// Forwarded agent id (`x-ryu-agent-id`) for the end-of-stream audit row.
    agent_id: Option<String>,
    /// Forwarded product surface (`x-ryu-feature`) for the end-of-stream audit row.
    feature: Option<String>,
}

/// Stream the upstream response to the client after one contiguous, bounded DLP
/// pass. This catches credentials split across SSE text-delta events before any
/// response bytes leave the Gateway.
fn redact_response_passthrough(
    body: Body,
    format: WireFormat,
    state: SharedState,
    scanner: std::sync::Arc<crate::firewall::FirewallScanner>,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) -> Body {
    use futures_util::StreamExt;

    let init = ResponseRedactState {
        inner: body.into_data_stream(),
        state,
        scanner,
        format,
        raw: Vec::new(),
        flushed: false,
        user_id,
        agent_id,
        feature,
    };

    let transformed = futures_util::stream::unfold(init, |mut s| async move {
        loop {
            if s.flushed {
                return None;
            }
            match s.inner.next().await {
                Some(Ok(bytes)) => {
                    if s.raw.len().saturating_add(bytes.len()) > MAX_REDACT_RESPONSE_BYTES {
                        s.flushed = true;
                        return Some((
                            Err(std::io::Error::other(
                                "passthrough response exceeded the DLP buffer cap",
                            )),
                            s,
                        ));
                    }
                    s.raw.extend_from_slice(&bytes);
                    continue;
                }
                Some(Err(e)) => {
                    return Some((Err(std::io::Error::other(e.to_string())), s));
                }
                None => {
                    if s.flushed {
                        return None;
                    }
                    s.flushed = true;
                    let raw = String::from_utf8_lossy(&s.raw).to_string();
                    let scanner = s.scanner.as_ref();
                    let (redacted, audit_text) = if raw.contains("data:") {
                        redact_sse_stream(s.format, scanner, &raw)
                    } else {
                        let (redacted, _) = FirewallBackend::redact_outbound(scanner, &raw);
                        (redacted.clone(), redacted)
                    };
                    audit_outbound(
                        &s.state,
                        scanner,
                        s.format,
                        &audit_text,
                        s.user_id.clone(),
                        s.agent_id.clone(),
                        s.feature.clone(),
                    );
                    if redacted.is_empty() {
                        return None;
                    }
                    return Some((Ok(Bytes::from(redacted.into_bytes())), s));
                }
            }
        }
    });

    Body::from_stream(transformed)
}

/// Run the single end-of-stream outbound audit over the accumulated (already
/// redacted) assistant text. A residual hit here means a secret slipped through
/// per-delta redaction (e.g. split across two deltas — the known limitation).
fn audit_outbound(
    state: &SharedState,
    scanner: &crate::firewall::FirewallScanner,
    format: WireFormat,
    text: &str,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(violation) = scanner.scan_outbound(text) {
        warn!(
            provider = provider_label(format),
            pattern = %violation.pattern_name,
            "passthrough: residual outbound firewall violation after streaming redaction"
        );
        emit_audit(
            state,
            format,
            "unknown",
            0,
            Some(format!(
                "outbound firewall violation: {}",
                violation.pattern_name
            )),
            user_id,
            agent_id,
            feature,
        );
    }
}

#[cfg(test)]
mod tests;

// ─── Swappable passthrough proxy backend (W6c decomposition) ─────────────────

/// The native-format passthrough reverse proxy as a swappable capability. The
/// built-in [`BuiltinPassthrough`] (the transparent loopback [`forward`] core) is
/// the default; an alternative (e.g. a mesh-relayed or policy-augmented proxy)
/// can register without touching the route handlers, mirroring the
/// [`crate::budget::BudgetRegistry`] inversion. Async because the proxy streams
/// the upstream response, so it follows the [`crate::providers`] async-trait shape
/// rather than the sync budget closure.
#[async_trait::async_trait]
pub(crate) trait PassthroughBackend: Send + Sync {
    /// Proxy one native-format request upstream and stream the response back.
    #[allow(clippy::too_many_arguments)]
    async fn forward(
        &self,
        format: WireFormat,
        upstream_base: String,
        route: PassthroughRoute,
        state: SharedState,
        peer: SocketAddr,
        path: String,
        method: Method,
        headers: HeaderMap,
        raw_query: axum::extract::RawQuery,
        body: Bytes,
    ) -> Response;
}

/// The built-in passthrough proxy: delegates to the module's transparent
/// loopback [`forward`] core. Byte-identical to the pre-inversion behavior.
pub(crate) struct BuiltinPassthrough;

#[async_trait::async_trait]
impl PassthroughBackend for BuiltinPassthrough {
    async fn forward(
        &self,
        format: WireFormat,
        upstream_base: String,
        route: PassthroughRoute,
        state: SharedState,
        peer: SocketAddr,
        path: String,
        method: Method,
        headers: HeaderMap,
        raw_query: axum::extract::RawQuery,
        body: Bytes,
    ) -> Response {
        forward(
            format,
            &upstream_base,
            route,
            state,
            peer,
            path,
            method,
            headers,
            raw_query,
            body,
        )
        .await
    }
}

/// Id-keyed registry over [`PassthroughBackend`] implementations with a live-swap
/// discipline, matching [`crate::budget::BudgetRegistry`] in shape but yielding an
/// `Arc<dyn PassthroughBackend>` (not a borrowing closure) so the active backend
/// survives the streamed `.await` — the same discipline the async smart router
/// uses. The built-in [`BuiltinPassthrough`] is registered under
/// [`PassthroughRegistry::BUILTIN`] and active by default.
pub(crate) struct PassthroughRegistry {
    inner: std::sync::RwLock<PassthroughRegistryInner>,
}

struct PassthroughRegistryInner {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn PassthroughBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn PassthroughBackend>,
}

impl PassthroughRegistry {
    /// Stable id of the built-in in-process passthrough proxy.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry with the built-in passthrough proxy as the default
    /// active backend.
    pub fn new() -> Self {
        let builtin: std::sync::Arc<dyn PassthroughBackend> =
            std::sync::Arc::new(BuiltinPassthrough);
        let mut backends = std::collections::HashMap::new();
        backends.insert(Self::BUILTIN.to_string(), std::sync::Arc::clone(&builtin));
        Self {
            inner: std::sync::RwLock::new(PassthroughRegistryInner {
                backends,
                order: vec![Self::BUILTIN.to_string()],
                active_id: Self::BUILTIN.to_string(),
                active: builtin,
            }),
        }
    }

    /// Clone the active backend out under a brief read lock (recovering from a
    /// poisoned lock). The returned `Arc` holds no lock, so the handler can keep
    /// it across the streamed `.await`.
    pub fn active(&self) -> std::sync::Arc<dyn PassthroughBackend> {
        match self.inner.read() {
            Ok(guard) => std::sync::Arc::clone(&guard.active),
            Err(poisoned) => std::sync::Arc::clone(&poisoned.into_inner().active),
        }
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    #[allow(dead_code)]
    pub fn register(&self, id: impl Into<String>, backend: std::sync::Arc<dyn PassthroughBackend>) {
        let id = id.into();
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if !guard.backends.contains_key(&id) {
            guard.order.push(id.clone());
        }
        let is_active = id == guard.active_id;
        guard.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            guard.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.
    pub fn set_active(&self, id: &str) -> bool {
        let mut guard = match self.inner.write() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.backends.get(id).map(std::sync::Arc::clone) {
            Some(backend) => {
                guard.active = backend;
                guard.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.
    #[allow(dead_code)]
    pub fn active_id(&self) -> String {
        match self.inner.read() {
            Ok(g) => g.active_id.clone(),
            Err(p) => p.into_inner().active_id.clone(),
        }
    }

    /// The registered backend ids in registration order.
    pub fn available(&self) -> Vec<String> {
        match self.inner.read() {
            Ok(g) => g.order.clone(),
            Err(p) => p.into_inner().order.clone(),
        }
    }
}

impl Default for PassthroughRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod passthrough_registry_tests;
