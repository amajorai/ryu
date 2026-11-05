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
//! - **Response-side** redaction (#455) runs only when the resolved scanner is
//!   `enabled` (`scan_outbound` is not consulted); otherwise the upstream body
//!   streams through untouched. When it runs, the whole response is buffered
//!   (capped at 8 MiB; past the cap, or on an upstream read error, the body
//!   fails with nothing delivered), so the caller gets no byte until the
//!   upstream finishes. An SSE body (any body containing `data:`) has its
//!   assistant text (`text_delta` for Anthropic, `output_text.delta` for
//!   Responses) joined across events and passed once through `sanitize` (gated
//!   by `redact_pii`/`redact_secrets`) and the stable-marker `redact_outbound`
//!   scrub, so a secret split across deltas is caught; the result goes into
//!   the first text event and later text events are emptied. Other events
//!   (tool-call and thinking deltas, unparseable `data:` lines) keep their
//!   bytes apart from a final `redact_outbound` over the whole body. Any other
//!   body (JSON) gets only `redact_outbound`. The redacted text is then scanned
//!   once for an outbound audit row; nothing is blocked.

use std::net::SocketAddr;

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderName, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use tracing::warn;

use crate::{firewall::FirewallBackend, state::SharedState};

// The pure passthrough wire-format redaction engine (the request-body DLP
// redactors, the SSE response redactors: the contiguous `redact_sse_stream` the
// Gateway uses and the per-event `redact_sse_event`, the upstream URL / path
// helpers, and the `WireFormat` marker) was extracted to the
// `ryu-gw-passthrough` crate ("engine moves, wiring stays", mirroring
// `ryu-gw-firewall`). The reverse-proxy `forward` orchestration below, audit
// emission, the loopback boundary, and the `PassthroughBackend` /
// `PassthroughRegistry` pipeline wiring stay in this module and its submodules.
// The engine reaches the firewall only through the crate's narrow
// [`ryu_gw_passthrough::PassthroughFirewall`] trait, implemented just below for
// the gateway's `dyn FirewallBackend` (the `with_firewall` closure type) and its
// concrete `FirewallScanner` (the resolved per-request scanner that response
// redaction and the redaction tests use). `WireFormat` is re-exported so
// `crate::passthrough::WireFormat` paths resolve unchanged.
use ryu_gw_passthrough::{
    build_upstream_url, classify_path, is_safe_upstream_path, PassthroughFirewall,
};
pub(crate) use ryu_gw_passthrough::{PassthroughRoute, WireFormat};

mod audit_rows;
mod registry;
mod request;
mod response;
mod routes;
mod upstream;

use audit_rows::{emit_audit, provider_label, refuse_request};
pub(crate) use registry::PassthroughRegistry;
// Kept at their pre-split paths (`crate::passthrough::BuiltinPassthrough` is a
// doc link; the trait is implemented by the registry tests).
#[allow(unused_imports)]
pub(crate) use registry::{BuiltinPassthrough, PassthroughBackend};
use request::{
    authorize_upstream, govern_message_batch, govern_prompt, passthrough_policy,
    PassthroughIdentity,
};
use response::redact_response_passthrough;
pub use routes::{anthropic, codex};
use upstream::{passthrough_client_for, STRIPPED_REQUEST_HEADERS};

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
/// Shared transparent reverse-proxy core for every passthrough route. Applies the
/// loopback boundary, the provider and data-region policy (narrowed by a vouched
/// caller's rules), the deny-by-default endpoint classification (`route`),
/// the model allowlist and request-side DLP on prompt endpoints, forwards with
/// the caller's own credentials unchanged, emits audit, and, when the resolved
/// scanner is enabled, holds the response for one redact-and-audit pass.
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

    // ── Response: one buffered redact-and-audit pass, or verbatim ──────────────
    // With the resolved scanner enabled, the whole (bounded) body is redacted in
    // one contiguous pass before any byte reaches the caller, then audited
    // (`response::redact_response_passthrough`, #455). Disabled, it streams
    // through untouched.
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

#[cfg(test)]
mod passthrough_registry_tests;
#[cfg(test)]
mod policy_tests;
#[cfg(test)]
mod redaction_tests;
#[cfg(test)]
mod response_tests;
#[cfg(test)]
mod tests;
