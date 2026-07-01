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

use crate::{audit::AuditRecord, state::SharedState};

/// Which native wire format a passthrough route speaks. Drives request-side
/// redaction (different body shapes) and response-side SSE text extraction
/// (different streaming event shapes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WireFormat {
    /// Anthropic Messages (`/v1/messages`) — Claude Code.
    Anthropic,
    /// OpenAI Responses (`/responses`) — Codex ChatGPT-login mode.
    OpenAiResponses,
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
    forward(
        WireFormat::Anthropic,
        &anthropic_upstream(),
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
    forward(
        WireFormat::OpenAiResponses,
        &codex_upstream(),
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
        redact_response_passthrough(upstream_body, format, state.clone())
    } else {
        upstream_body
    };
    out.body(response_body)
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// True for the Messages endpoint (`.../v1/messages`), the only Anthropic path
/// with a JSON prompt body. `count_tokens` and other sub-paths are proxied
/// untouched.
fn is_messages_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p == "v1/messages" || p.ends_with("/v1/messages")
}

/// True for the Codex Responses endpoint (`.../responses`), the path carrying the
/// prompt body. Other sub-paths are proxied untouched.
fn is_responses_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p == "responses" || p.ends_with("/responses")
}

fn build_upstream_url(base: &str, path: &str, query: Option<&str>) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match query {
        Some(q) if !q.is_empty() => format!("{base}/{path}?{q}"),
        _ => format!("{base}/{path}"),
    }
}

/// Redact a request body in place per its wire format. Both reuse the firewall's
/// config-gated `sanitize` over the prompt-bearing fields.
fn redact_request_body(
    format: WireFormat,
    fw: &crate::firewall::FirewallScanner,
    body: &mut Value,
) {
    match format {
        WireFormat::Anthropic => redact_anthropic_body(fw, body),
        WireFormat::OpenAiResponses => redact_responses_body(fw, body),
    }
}

/// Redact PII/secrets from an OpenAI Responses request body in place: the
/// top-level `instructions` field and each `input` item's `content`. The Responses
/// API accepts `input` as either a plain string or an array of items, each with a
/// `content` that is a string or an array of `{ "type": "input_text", "text": … }`
/// parts. Reuses the firewall's config-gated `sanitize`.
fn redact_responses_body(fw: &crate::firewall::FirewallScanner, body: &mut Value) {
    if let Some(instructions) = body.get_mut("instructions") {
        redact_content(fw, instructions);
    }
    match body.get_mut("input") {
        Some(Value::String(s)) => {
            *s = fw.sanitize(s);
        }
        Some(Value::Array(items)) => {
            for item in items.iter_mut() {
                if let Some(content) = item.get_mut("content") {
                    redact_content(fw, content);
                }
            }
        }
        _ => {}
    }
}

/// Redact PII/secrets from an Anthropic Messages request body in place: the
/// top-level `system` field and each message's `content` (string or content-block
/// array). Reuses the firewall's config-gated `sanitize`.
fn redact_anthropic_body(fw: &crate::firewall::FirewallScanner, body: &mut Value) {
    if let Some(sys) = body.get_mut("system") {
        redact_content(fw, sys);
    }
    if let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) {
        for msg in messages.iter_mut() {
            if let Some(content) = msg.get_mut("content") {
                redact_content(fw, content);
            }
        }
    }
}

/// Redact a content node that may be a plain string or an array of content blocks
/// (`[{ "type": "text", "text": "…" }, …]`).
fn redact_content(fw: &crate::firewall::FirewallScanner, content: &mut Value) {
    match content {
        Value::String(s) => {
            *s = fw.sanitize(s);
        }
        Value::Array(parts) => {
            for part in parts.iter_mut() {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    let redacted = fw.sanitize(text);
                    part["text"] = Value::String(redacted);
                }
            }
        }
        _ => {}
    }
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
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
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
}

/// Stream the upstream SSE response to the client, redacting matched PII/secrets
/// in each assistant-text delta *before* the bytes leave the gateway. Complete
/// events are reassembled across network-chunk boundaries; non-text events pass
/// verbatim; unparseable events fail open (pass verbatim). The accumulated
/// redacted text is scanned once at stream end to audit any residual outbound
/// violation. Mirrors the request-side `redact_content` per-text-node `sanitize`.
fn redact_response_passthrough(body: Body, format: WireFormat, state: SharedState) -> Body {
    use futures_util::StreamExt;

    let init = ResponseRedactState {
        inner: body.into_data_stream(),
        state,
        format,
        pending: Vec::new(),
        accumulated: String::new(),
        flushed: false,
    };

    let transformed = futures_util::stream::unfold(init, |mut s| async move {
        loop {
            match s.inner.next().await {
                Some(Ok(bytes)) => {
                    s.pending.extend_from_slice(&bytes);
                    let (out, text) = s.state.with_firewall(|fw| {
                        drain_complete_events(s.format, fw, &mut s.pending)
                    });
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
                            let (redacted, text) =
                                s.state.with_firewall(|fw| redact_sse_event(s.format, fw, &raw));
                            s.accumulated.push_str(&text);
                            redacted.into_bytes()
                        } else {
                            let (redacted, _hits) =
                                s.state.with_firewall(|fw| fw.redact_outbound(&raw));
                            s.accumulated.push_str(&redacted);
                            redacted.into_bytes()
                        }
                    };
                    audit_outbound(&s.state, s.format, &s.accumulated);
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
fn audit_outbound(state: &SharedState, format: WireFormat, text: &str) {
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
        );
    }
}

/// Split off every complete `\n\n`-terminated SSE event from `pending`, redact
/// each, and return the rewritten bytes plus the concatenated redacted assistant
/// text (for the end-of-stream audit). The trailing incomplete remainder is left
/// in `pending` for the next chunk.
fn drain_complete_events(
    format: WireFormat,
    fw: &crate::firewall::FirewallScanner,
    pending: &mut Vec<u8>,
) -> (Vec<u8>, String) {
    let mut out = Vec::new();
    let mut text = String::new();
    // Find each `\n\n` boundary and process the event up to and including it.
    while let Some(idx) = find_event_boundary(pending) {
        let event: Vec<u8> = pending.drain(..idx).collect();
        let raw = String::from_utf8_lossy(&event).to_string();
        let (redacted, t) = redact_sse_event(format, fw, &raw);
        out.extend_from_slice(redacted.as_bytes());
        text.push_str(&t);
    }
    (out, text)
}

/// Index just past the first `\n\n` event terminator in `buf`, if any. Returns
/// the length to drain (boundary inclusive) so SSE framing is preserved exactly.
fn find_event_boundary(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n").map(|p| p + 2)
}

/// Redact the assistant-text delta inside a single complete SSE event, returning
/// the rewritten event text and the redacted assistant text it carried (empty for
/// non-text events). The `event:` line and framing are preserved; only the JSON
/// on a text-delta `data:` line is rewritten. Unparseable JSON / non-text events
/// pass through verbatim (fail open).
fn redact_sse_event(
    format: WireFormat,
    fw: &crate::firewall::FirewallScanner,
    raw: &str,
) -> (String, String) {
    let mut out = String::with_capacity(raw.len());
    let mut redacted_text = String::new();
    for line in raw.split_inclusive('\n') {
        // Preserve the line's own terminator (split_inclusive keeps it).
        let (content, newline) = match line.strip_suffix('\n') {
            Some(c) => (c, "\n"),
            None => (line, ""),
        };
        let Some(data) = content.strip_prefix("data:") else {
            out.push_str(line);
            continue;
        };
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            out.push_str(line);
            continue;
        }
        match redact_sse_data_json(format, fw, trimmed) {
            Some((rewritten, text)) => {
                redacted_text.push_str(&text);
                // Rebuild the `data:` line, preserving the original separator
                // (`data:` vs `data: `) by re-using the leading whitespace.
                let lead_ws = &data[..data.len() - data.trim_start().len()];
                out.push_str("data:");
                out.push_str(lead_ws);
                out.push_str(&rewritten);
                out.push_str(newline);
            }
            None => out.push_str(line),
        }
    }
    (out, redacted_text)
}

/// Redact the assistant-text field of a single SSE `data:` JSON payload per
/// format. Returns the re-serialized JSON + the redacted text, or `None` if the
/// event is not a text delta or fails to parse (caller passes it through).
fn redact_sse_data_json(
    format: WireFormat,
    fw: &crate::firewall::FirewallScanner,
    data: &str,
) -> Option<(String, String)> {
    let mut json: Value = serde_json::from_str(data).ok()?;
    match format {
        WireFormat::Anthropic => {
            // content_block_delta → { "delta": { "type": "text_delta", "text": … } }
            let text = json
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)?;
            let redacted = fw.sanitize(text);
            let (redacted, _) = fw.redact_outbound(&redacted);
            json["delta"]["text"] = Value::String(redacted.clone());
            Some((serde_json::to_string(&json).ok()?, redacted))
        }
        WireFormat::OpenAiResponses => {
            // response.output_text.delta → top-level `delta` string.
            let is_text_delta = json
                .get("type")
                .and_then(Value::as_str)
                .map(|t| t.ends_with("output_text.delta"))
                .unwrap_or(false);
            if !is_text_delta {
                return None;
            }
            let delta = json.get("delta").and_then(Value::as_str)?;
            let redacted = fw.sanitize(delta);
            let (redacted, _) = fw.redact_outbound(&redacted);
            json["delta"] = Value::String(redacted.clone());
            Some((serde_json::to_string(&json).ok()?, redacted))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{FirewallConfig, FirewallPolicy};
    use crate::firewall::FirewallScanner;

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
    fn messages_path_detection() {
        assert!(is_messages_path("v1/messages"));
        assert!(is_messages_path("v1/messages/"));
        assert!(!is_messages_path("v1/messages/count_tokens"));
        assert!(!is_messages_path("v1/models"));
    }

    #[test]
    fn upstream_url_joins_path_and_query() {
        assert_eq!(
            build_upstream_url("https://api.anthropic.com/", "v1/messages", None),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_upstream_url(
                "https://api.anthropic.com",
                "/v1/messages",
                Some("beta=true")
            ),
            "https://api.anthropic.com/v1/messages?beta=true"
        );
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
    fn responses_path_detection() {
        assert!(is_responses_path("responses"));
        assert!(is_responses_path("responses/"));
        assert!(is_responses_path("v1/responses"));
        assert!(!is_responses_path("v1/models"));
        assert!(!is_responses_path("responses/123/cancel"));
    }

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
        assert!(out.contains("[REDACTED:"), "expected a redaction marker: {out}");
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
        assert!(out.contains("[REDACTED:"), "expected a redaction marker: {out}");
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
        std::env::set_var("RYU_PASSTHROUGH_CODEX_UPSTREAM", "http://test-upstream.local");
        assert_eq!(codex_upstream(), "http://test-upstream.local");
        std::env::remove_var("RYU_PASSTHROUGH_CODEX_UPSTREAM");
    }
}
