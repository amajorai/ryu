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
//! remote gateway must never carry a user's subscription credential.
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
//!   primary DLP win — applied here when the firewall is enabled (Anthropic
//!   Messages `system`/`messages`, Codex Responses `instructions`/`input`).
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
//!   **Known limitation:** redaction is per-delta, so a secret split across two
//!   separate text-delta events (`sk-` in one, the rest in the next) is not
//!   caught — a cross-delta hold-back buffer is a deliberate follow-on.

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
pub(crate) use ryu_gw_passthrough::WireFormat;
use ryu_gw_passthrough::{
    build_upstream_url, drain_complete_events, is_messages_path, is_responses_path,
    redact_request_body, redact_sse_event, PassthroughFirewall,
};

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
            is_messages_path(&path),
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
            is_responses_path(&path),
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
/// loopback boundary, request-side DLP (when `redact_body` and the firewall are
/// on), forwards with the caller's own credentials unchanged, emits audit, and
/// streams the response through a scan-and-audit tee (no response redaction).
#[allow(clippy::too_many_arguments)]
async fn forward(
    format: WireFormat,
    upstream_base: &str,
    redact_body: bool,
    state: SharedState,
    peer: SocketAddr,
    path: String,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: Bytes,
) -> Response {
    // ── Security boundary: loopback only ──────────────────────────────────────
    // This path forwards the user's subscription bearer; never expose it to a
    // remote peer even if the gateway itself binds 0.0.0.0.
    if !peer.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "passthrough proxy is loopback-only").into_response();
    }

    let started = std::time::Instant::now();
    let url = build_upstream_url(upstream_base, &path, raw_query.0.as_deref());

    // Control-plane attribution (profiles / usage-points): tag the audit row with
    // the forwarded end-user id + product surface when Core relays them. `None`
    // for a bare subscription CLI (self-hosted) — the row is still recorded.
    let user_id = header_string(&headers, "x-ryu-user-id");
    let agent_id = header_string(&headers, "x-ryu-agent-id");
    let feature = header_string(&headers, "x-ryu-feature");

    // ── Request-side DLP: redact the outbound body when the firewall is on ─────
    // Only the prompt-carrying endpoint is scanned; other sub-paths (token
    // counting, etc.) are proxied untouched.
    let mut model = "unknown".to_string();
    let forward_body: Bytes = if redact_body {
        match serde_json::from_slice::<Value>(&body) {
            Ok(mut json) => {
                if let Some(m) = json.get("model").and_then(Value::as_str) {
                    model = m.to_string();
                }
                let redacted = state.with_firewall(|fw| {
                    let cfg = fw.config();
                    if cfg.enabled && cfg.scan_inbound {
                        redact_request_body(format, fw, &mut json);
                        true
                    } else {
                        false
                    }
                });
                if redacted {
                    serde_json::to_vec(&json).map(Bytes::from).unwrap_or(body)
                } else {
                    body
                }
            }
            // Non-JSON or unparseable body: forward as-is (fail open).
            Err(_) => body,
        }
    } else {
        body
    };

    // ── Forward upstream with the caller's OWN credentials unchanged ───────────
    let mut req = state.http.request(method.clone(), &url).body(forward_body);
    let mut req_headers = reqwest::header::HeaderMap::new();
    for (name, value) in &headers {
        if STRIPPED_REQUEST_HEADERS.contains(&name.as_str()) {
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
    let scan_enabled = state.with_firewall(|fw| fw.config().enabled);
    let upstream_body = Body::from_stream(resp.bytes_stream());
    let response_body = if scan_enabled {
        redact_response_passthrough(
            upstream_body,
            format,
            state.clone(),
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
    state.audit.log(AuditRecord {
        request_id: format!(
            "pt-{}-{}",
            provider_label(format),
            chrono::Utc::now().timestamp_millis()
        ),
        api_key: "passthrough".to_string(),
        user_name: None,
        org_id: None,
        team_id: None,
        project_id: None,
        provider: provider_label(format).to_string(),
        model: model.to_string(),
        input_tokens: 0,
        output_tokens: 0,
        cache_hit: false,
        latency_ms,
        eval_score: None,
        error,
        skill_ids: None,
        session_id: None,
        user_id,
        agent_id,
        feature,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });
}

// ── Response-side redaction + audit (#455) ────────────────────────────────────

/// Tee state for the streaming response redaction. Buffers raw bytes until a
/// complete SSE event (`\n\n`-terminated) is available, redacts the assistant
/// text in each complete event, and emits the rewritten framing. Accumulates the
/// (already-redacted) assistant text for a single end-of-stream audit scan.
struct ResponseRedactState {
    inner: axum::body::BodyDataStream,
    state: SharedState,
    format: WireFormat,
    /// Raw bytes not yet split into a complete `\n\n`-terminated event. Kept as
    /// bytes (not a `String`) so a multibyte UTF-8 char split across a network
    /// chunk is never corrupted — events split on the ASCII `\n\n` boundary.
    pending: Vec<u8>,
    /// Concatenated, already-redacted assistant text, scanned once at stream end.
    accumulated: String,
    /// Set once the trailing remainder + audit have been flushed at stream end.
    flushed: bool,
    /// Forwarded end-user id (`x-ryu-user-id`) for the end-of-stream audit row.
    user_id: Option<String>,
    /// Forwarded agent id (`x-ryu-agent-id`) for the end-of-stream audit row.
    agent_id: Option<String>,
    /// Forwarded product surface (`x-ryu-feature`) for the end-of-stream audit row.
    feature: Option<String>,
}

/// Stream the upstream SSE response to the client, redacting matched PII/secrets
/// in each assistant-text delta *before* the bytes leave the gateway. Complete
/// events are reassembled across network-chunk boundaries; non-text events pass
/// verbatim; unparseable events fail open (pass verbatim). The accumulated
/// redacted text is scanned once at stream end to audit any residual outbound
/// violation. Mirrors the request-side `redact_content` per-text-node `sanitize`.
fn redact_response_passthrough(
    body: Body,
    format: WireFormat,
    state: SharedState,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) -> Body {
    use futures_util::StreamExt;

    let init = ResponseRedactState {
        inner: body.into_data_stream(),
        state,
        format,
        pending: Vec::new(),
        accumulated: String::new(),
        flushed: false,
        user_id,
        agent_id,
        feature,
    };

    let transformed = futures_util::stream::unfold(init, |mut s| async move {
        loop {
            match s.inner.next().await {
                Some(Ok(bytes)) => {
                    s.pending.extend_from_slice(&bytes);
                    let (out, text) = s
                        .state
                        .with_firewall(|fw| drain_complete_events(s.format, fw, &mut s.pending));
                    s.accumulated.push_str(&text);
                    if out.is_empty() {
                        // No complete event yet — keep reading without emitting an
                        // empty chunk (which would just churn the stream).
                        continue;
                    }
                    return Some((Ok(Bytes::from(out)), s));
                }
                Some(Err(e)) => {
                    return Some((Err(std::io::Error::other(e.to_string())), s));
                }
                None => {
                    if s.flushed {
                        return None;
                    }
                    s.flushed = true;
                    // Flush any trailing partial event (no final `\n\n`) — redact it
                    // best-effort, then run the single end-of-stream audit scan.
                    let tail = std::mem::take(&mut s.pending);
                    let tail_out = if tail.is_empty() {
                        Vec::new()
                    } else {
                        let raw = String::from_utf8_lossy(&tail).to_string();
                        // SSE events are processed incrementally above; a non-empty
                        // tail with no `data:` line is a non-streaming (JSON) body —
                        // redact the FULL body once (OUTBOUND-DLP contract). Heuristic
                        // note: a JSON body that itself contains the literal `data:`
                        // (e.g. a data: URI in output) routes to the SSE path and is
                        // passed through un-redacted — acceptable best-effort.
                        if raw.contains("data:") {
                            let (redacted, text) = s
                                .state
                                .with_firewall(|fw| redact_sse_event(s.format, fw, &raw));
                            s.accumulated.push_str(&text);
                            redacted.into_bytes()
                        } else {
                            let (redacted, _hits) =
                                s.state.with_firewall(|fw| fw.redact_outbound(&raw));
                            s.accumulated.push_str(&redacted);
                            redacted.into_bytes()
                        }
                    };
                    audit_outbound(
                        &s.state,
                        s.format,
                        &s.accumulated,
                        s.user_id.clone(),
                        s.agent_id.clone(),
                        s.feature.clone(),
                    );
                    if tail_out.is_empty() {
                        return None;
                    }
                    return Some((Ok(Bytes::from(tail_out)), s));
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
    format: WireFormat,
    text: &str,
    user_id: Option<String>,
    agent_id: Option<String>,
    feature: Option<String>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(violation) = state.with_firewall(|fw| fw.scan_outbound(text)) {
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
mod tests {
    use super::*;
    use crate::config::{FirewallConfig, FirewallPolicy};
    use crate::firewall::FirewallScanner;
    // Request-body redactors are consumed only by these tests (the non-test path
    // calls `redact_request_body`); import them test-locally to avoid an unused
    // import in the non-test build.
    use ryu_gw_passthrough::{redact_anthropic_body, redact_responses_body};

    fn enabled_scanner() -> FirewallScanner {
        FirewallScanner::new(FirewallConfig {
            enabled: true,
            scan_inbound: true,
            policy: FirewallPolicy::Sanitize,
            redact_pii: true,
            redact_secrets: true,
            ..FirewallConfig::default()
        })
    }

    #[test]
    fn redacts_string_content_and_system() {
        let fw = enabled_scanner();
        let mut body = serde_json::json!({
            "model": "claude-opus-4-8",
            "system": "Reach me at admin@example.com",
            "messages": [
                { "role": "user", "content": "my key is sk-abcdefghijklmnopqrstuvwx" }
            ]
        });
        redact_anthropic_body(&fw, &mut body);
        assert!(!body["system"]
            .as_str()
            .unwrap()
            .contains("admin@example.com"));
        assert!(!body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("sk-abcdefghijklmnopqrstuvwx"));
    }

    #[test]
    fn redacts_content_block_array() {
        let fw = enabled_scanner();
        let mut body = serde_json::json!({
            "messages": [
                { "role": "user", "content": [
                    { "type": "text", "text": "ssn 123-45-6789 here" }
                ]}
            ]
        });
        redact_anthropic_body(&fw, &mut body);
        let text = body["messages"][0]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("123-45-6789"), "got: {text}");
    }

    // ── Codex (OpenAI Responses) passthrough (#455) ──────────────────────────

    #[test]
    fn redacts_responses_instructions_and_input_string() {
        let fw = enabled_scanner();
        let mut body = serde_json::json!({
            "model": "gpt-5.5-codex",
            "instructions": "Email admin@example.com if stuck",
            "input": "my key is sk-abcdefghijklmnopqrstuvwx"
        });
        redact_responses_body(&fw, &mut body);
        assert!(!body["instructions"]
            .as_str()
            .unwrap()
            .contains("admin@example.com"));
        assert!(!body["input"]
            .as_str()
            .unwrap()
            .contains("sk-abcdefghijklmnopqrstuvwx"));
    }

    #[test]
    fn redacts_responses_input_item_array() {
        let fw = enabled_scanner();
        let mut body = serde_json::json!({
            "input": [
                { "role": "user", "content": [
                    { "type": "input_text", "text": "ssn 123-45-6789 here" }
                ]}
            ]
        });
        redact_responses_body(&fw, &mut body);
        let text = body["input"][0]["content"][0]["text"].as_str().unwrap();
        assert!(!text.contains("123-45-6789"), "got: {text}");
    }

    // ── Response-side streaming redaction (#455) ──────────────────────────────

    /// Feed `raw` through the redactor one chunk at a time (mimicking arbitrary
    /// network-chunk boundaries, including a split mid-event) and return the full
    /// emitted output, asserting nothing is dropped and framing is reassembled.
    fn redact_in_chunks(
        format: WireFormat,
        fw: &FirewallScanner,
        raw: &[u8],
        chunk: usize,
    ) -> String {
        let mut pending: Vec<u8> = Vec::new();
        let mut out: Vec<u8> = Vec::new();
        for piece in raw.chunks(chunk) {
            pending.extend_from_slice(piece);
            let (emitted, _) = drain_complete_events(format, fw, &mut pending);
            out.extend_from_slice(&emitted);
        }
        // Flush any trailing partial event at stream end.
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).to_string();
            let (emitted, _) = redact_sse_event(format, fw, &tail);
            out.extend_from_slice(emitted.as_bytes());
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn anthropic_response_redacts_secret_in_text_delta() {
        let fw = enabled_scanner();
        let transcript = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\"}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"my key is sk-abcdefghijklmnopqrstuvwx ok\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        // Split the transcript into small chunks so events span chunk boundaries.
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 7);
        assert!(
            !out.contains("sk-abcdefghijklmnopqrstuvwx"),
            "secret should be redacted, got: {out}"
        );
        assert!(
            out.contains("[REDACTED:"),
            "expected a redaction marker: {out}"
        );
        // Non-text events pass through verbatim, framing preserved.
        assert!(out.contains("\"type\":\"message_start\""));
        assert!(out.contains("event: content_block_delta\n"));
    }

    #[test]
    fn responses_response_redacts_secret_in_text_delta() {
        let fw = enabled_scanner();
        let transcript = concat!(
            "data: {\"type\":\"response.created\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"here sk-abcdefghijklmnopqrstuvwx done\"}\n\n",
            "data: {\"type\":\"response.completed\"}\n\n",
            "data: [DONE]\n\n",
        );
        let out = redact_in_chunks(WireFormat::OpenAiResponses, &fw, transcript.as_bytes(), 5);
        assert!(
            !out.contains("sk-abcdefghijklmnopqrstuvwx"),
            "secret should be redacted, got: {out}"
        );
        assert!(
            out.contains("[REDACTED:"),
            "expected a redaction marker: {out}"
        );
        // Sentinel and non-text events untouched.
        assert!(out.contains("[DONE]"));
        assert!(out.contains("\"type\":\"response.created\""));
    }

    #[test]
    fn non_text_events_pass_through_unchanged() {
        let fw = enabled_scanner();
        // A ping + a non-text-delta event: must be byte-identical after redaction.
        let transcript =
            "event: ping\ndata: {\"type\":\"ping\"}\n\ndata: {\"type\":\"response.created\"}\n\n";
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 3);
        assert_eq!(out, transcript);
    }

    #[test]
    fn unparseable_data_line_passes_through() {
        let fw = enabled_scanner();
        let event = "data: not-json-at-all\n\n";
        let (out, text) = redact_sse_event(WireFormat::Anthropic, &fw, event);
        assert_eq!(out, event);
        assert!(text.is_empty());
    }

    /// OUTBOUND-DLP wiring proof: a GitHub OAuth PAT (`gho_…`) inside an
    /// Anthropic `text_delta` survives a small network-chunk split and is redacted
    /// by `redact_outbound`. `gho_` is deliberately chosen because the config-gated
    /// `sanitize` secret set does NOT match it — only the new outbound rule does —
    /// so a passing assertion proves the wiring, not pre-existing behavior.
    #[test]
    fn anthropic_response_redacts_outbound_only_secret_across_chunks() {
        let fw = enabled_scanner();
        let secret = "gho_abcdefghijklmnopqrstuvwxyz0123456789";
        let transcript = format!(
            concat!(
                "event: content_block_delta\n",
                "data: {{\"type\":\"content_block_delta\",\"delta\":{{\"type\":\"text_delta\",\"text\":\"here is {} done\"}}}}\n\n",
            ),
            secret
        );
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 7);
        assert!(
            !out.contains(secret),
            "outbound-only secret must be redacted, got: {out}"
        );
        assert!(
            out.contains("[REDACTED:gh_pat]"),
            "expected stable outbound marker: {out}"
        );
    }

    #[test]
    fn codex_upstream_is_swappable() {
        std::env::set_var(
            "RYU_PASSTHROUGH_CODEX_UPSTREAM",
            "http://test-upstream.local",
        );
        assert_eq!(codex_upstream(), "http://test-upstream.local");
        std::env::remove_var("RYU_PASSTHROUGH_CODEX_UPSTREAM");
    }
}

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
        redact_body: bool,
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
        redact_body: bool,
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
            redact_body,
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
mod passthrough_registry_tests {
    use super::*;

    /// A stub backend answering with a fixed sentinel response — proof the registry
    /// dispatches to a swapped-in impl.
    struct StubPassthrough;
    #[async_trait::async_trait]
    impl PassthroughBackend for StubPassthrough {
        async fn forward(
            &self,
            _format: WireFormat,
            _upstream_base: String,
            _redact_body: bool,
            _state: SharedState,
            _peer: SocketAddr,
            _path: String,
            _method: Method,
            _headers: HeaderMap,
            _raw_query: axum::extract::RawQuery,
            _body: Bytes,
        ) -> Response {
            (StatusCode::IM_A_TEAPOT, "stub").into_response()
        }
    }

    #[test]
    fn builtin_is_the_default_active_backend() {
        let reg = PassthroughRegistry::new();
        assert_eq!(reg.active_id(), PassthroughRegistry::BUILTIN);
        assert_eq!(
            reg.available(),
            vec![PassthroughRegistry::BUILTIN.to_string()]
        );
    }

    #[test]
    fn register_then_set_active_swaps_the_live_backend() {
        let reg = PassthroughRegistry::new();
        reg.register(
            "stub",
            std::sync::Arc::new(StubPassthrough) as std::sync::Arc<dyn PassthroughBackend>,
        );
        // Registered but not active: built-in is still the active id.
        assert_eq!(reg.active_id(), PassthroughRegistry::BUILTIN);
        assert_eq!(reg.available().len(), 2);

        assert!(reg.set_active("stub"));
        assert_eq!(reg.active_id(), "stub");

        // Unknown id is a no-op keeping the current active backend.
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), "stub");
    }
}
