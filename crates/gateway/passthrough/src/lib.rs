//! Passthrough wire-format redaction engine (extracted from
//! `apps/gateway/src/passthrough`, decomposition W6).
//!
//! This crate holds the *pure* text-processing core of the native-format
//! passthrough proxy: request-body DLP redaction (Anthropic Messages /
//! OpenAI Responses shapes), the streaming-SSE response redactor
//! (event reassembly across network-chunk boundaries + per-text-delta
//! sanitize), and the upstream URL / path helpers. It touches the firewall
//! only through the narrow [`PassthroughFirewall`] interface (`sanitize` +
//! `redact_outbound`), so it carries no `SharedState` / `reqwest` / `axum`
//! dependency.
//!
//! The SharedState-bound wiring — the `forward` reverse-proxy orchestration,
//! audit emission, the loopback boundary, and the `PassthroughBackend` trait +
//! `PassthroughRegistry` — stays in `apps/gateway/src/passthrough` and consumes
//! this crate ("engine moves, wiring stays", mirroring `ryu-gw-firewall`).

use serde_json::Value;

/// The narrow firewall interface the passthrough redaction engine needs. The
/// gateway's `FirewallScanner` / `dyn FirewallBackend` implement it, so the pure
/// engine here reuses the real config-gated redaction without depending on the
/// gateway's `AppState` / firewall module.
pub trait PassthroughFirewall {
    /// Config-gated PII/secret sanitization of a single text node (the same
    /// `sanitize` the chat path uses).
    fn sanitize(&self, text: &str) -> String;
    /// The stable-marker outbound secret scrubber (GitHub PATs, `sk-` keys, AWS
    /// AKIAs, `Bearer`/`token=`/`password=` params). Returns the scrubbed text and
    /// the list of matched stable markers.
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>);
}

/// Which native wire format a passthrough route speaks. Drives request-side
/// redaction (different body shapes) and response-side SSE text extraction
/// (different streaming event shapes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireFormat {
    /// Anthropic Messages (`/v1/messages`) — Claude Code.
    Anthropic,
    /// OpenAI Responses (`/responses`) — Codex ChatGPT-login mode.
    OpenAiResponses,
}

/// True for the Messages endpoint (`.../v1/messages`), the only Anthropic path
/// with a JSON prompt body. `count_tokens` and other sub-paths are proxied
/// untouched.
pub fn is_messages_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p == "v1/messages" || p.ends_with("/v1/messages")
}

/// True for the Codex Responses endpoint (`.../responses`), the path carrying the
/// prompt body. Other sub-paths are proxied untouched.
pub fn is_responses_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p == "responses" || p.ends_with("/responses")
}

pub fn build_upstream_url(base: &str, path: &str, query: Option<&str>) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match query {
        Some(q) if !q.is_empty() => format!("{base}/{path}?{q}"),
        _ => format!("{base}/{path}"),
    }
}

/// Redact a request body in place per its wire format. Both reuse the firewall's
/// config-gated `sanitize` over the prompt-bearing fields.
pub fn redact_request_body<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
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
pub fn redact_responses_body<F: PassthroughFirewall + ?Sized>(fw: &F, body: &mut Value) {
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
pub fn redact_anthropic_body<F: PassthroughFirewall + ?Sized>(fw: &F, body: &mut Value) {
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
fn redact_content<F: PassthroughFirewall + ?Sized>(fw: &F, content: &mut Value) {
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

/// Split off every complete `\n\n`-terminated SSE event from `pending`, redact
/// each, and return the rewritten bytes plus the concatenated redacted assistant
/// text (for the end-of-stream audit). The trailing incomplete remainder is left
/// in `pending` for the next chunk.
pub fn drain_complete_events<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
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
pub fn redact_sse_event<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
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
fn redact_sse_data_json<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
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

    /// A trivial [`PassthroughFirewall`] stub proving the SSE framing / reassembly
    /// / passthrough plumbing without depending on the gateway's real
    /// `FirewallScanner` (the behavior-asserting redaction tests that need the real
    /// regex engine stay with the scanner in `apps/gateway`). `sanitize` rewrites a
    /// fixed sentinel token; `redact_outbound` is identity.
    struct StubFirewall;
    impl PassthroughFirewall for StubFirewall {
        fn sanitize(&self, text: &str) -> String {
            text.replace("SECRET", "[REDACTED:test]")
        }
        fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
            (text.to_string(), Vec::new())
        }
    }

    #[test]
    fn messages_path_detection() {
        assert!(is_messages_path("v1/messages"));
        assert!(is_messages_path("v1/messages/"));
        assert!(!is_messages_path("v1/messages/count_tokens"));
        assert!(!is_messages_path("v1/models"));
    }

    #[test]
    fn responses_path_detection() {
        assert!(is_responses_path("responses"));
        assert!(is_responses_path("responses/"));
        assert!(is_responses_path("v1/responses"));
        assert!(!is_responses_path("v1/models"));
        assert!(!is_responses_path("responses/123/cancel"));
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
    fn request_body_redaction_reaches_the_firewall() {
        let fw = StubFirewall;
        let mut body = serde_json::json!({
            "system": "sentinel SECRET here",
            "messages": [
                { "role": "user", "content": "another SECRET token" }
            ]
        });
        redact_anthropic_body(&fw, &mut body);
        assert!(!body["system"].as_str().unwrap().contains("SECRET"));
        assert!(!body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("SECRET"));
    }

    /// Feed `raw` through the redactor one chunk at a time (mimicking arbitrary
    /// network-chunk boundaries, including a split mid-event) and return the full
    /// emitted output, asserting nothing is dropped and framing is reassembled.
    fn redact_in_chunks<F: PassthroughFirewall + ?Sized>(
        format: WireFormat,
        fw: &F,
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
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).to_string();
            let (emitted, _) = redact_sse_event(format, fw, &tail);
            out.extend_from_slice(emitted.as_bytes());
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn sse_text_delta_is_redacted_across_chunk_boundaries() {
        let fw = StubFirewall;
        let transcript = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\"}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"my SECRET ok\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 7);
        assert!(!out.contains("my SECRET ok"), "got: {out}");
        assert!(out.contains("[REDACTED:test]"), "got: {out}");
        // Non-text events pass through verbatim, framing preserved.
        assert!(out.contains("\"type\":\"message_start\""));
        assert!(out.contains("event: content_block_delta\n"));
    }

    #[test]
    fn non_text_events_pass_through_unchanged() {
        let fw = StubFirewall;
        // A ping + a non-text-delta event: must be byte-identical after redaction.
        let transcript =
            "event: ping\ndata: {\"type\":\"ping\"}\n\ndata: {\"type\":\"response.created\"}\n\n";
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 3);
        assert_eq!(out, transcript);
    }

    #[test]
    fn unparseable_data_line_passes_through() {
        let fw = StubFirewall;
        let event = "data: not-json-at-all\n\n";
        let (out, text) = redact_sse_event(WireFormat::Anthropic, &fw, event);
        assert_eq!(out, event);
        assert!(text.is_empty());
    }
}
