use super::*;
use crate::config::{FirewallConfig, FirewallPolicy};
use crate::firewall::FirewallScanner;
use ryu_gw_passthrough::{drain_complete_events, redact_sse_event};
// Request-body redactors are consumed only by these tests (the non-test path
// walks the body with `visit_request_strings_mut` in `request::inspect_request`);
// import them test-locally to avoid an unused import in the non-test build.
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

// ── Per-event SSE engine (#455) ───────────────────────────────────────────
// These drive the crate's per-event `drain_complete_events`/`redact_sse_event`
// with the Gateway's scanner. The Gateway's response path does not use them: it
// buffers the whole body and calls `redact_sse_stream` (see `response_tests`).

/// Feed `raw` through the redactor one chunk at a time (mimicking arbitrary
/// network-chunk boundaries, including a split mid-event) and return the full
/// emitted output, asserting nothing is dropped and framing is reassembled.
fn redact_in_chunks(format: WireFormat, fw: &FirewallScanner, raw: &[u8], chunk: usize) -> String {
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

/// Outbound-rule proof on the per-event engine: a GitHub OAuth PAT (`gho_…`)
/// inside an Anthropic `text_delta` survives a small network-chunk split and is
/// redacted by `redact_outbound`. `gho_` is deliberately chosen because the
/// config-gated `sanitize` secret set does NOT match it — only the outbound
/// rule does — so a passing assertion proves `redact_outbound` ran, not
/// pre-existing behavior.
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
