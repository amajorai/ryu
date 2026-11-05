//! The Gateway's own response path: `forward` against a stand-in upstream, so
//! these pin what reaches the caller, not what the crate's engine does alone.

use super::tests::{forward_json, passthrough_state};
use super::*;

/// A GitHub PAT whose two halves are each too short to match `gh_pat`.
const SPLIT_HEAD: &str = "ghp_ABCDEFGHIJ";
const SPLIT_TAIL: &str = "KLMNOPQRSTUVWXYZ0123456789abcd";

/// Spawn a loopback upstream that answers every request with `body`.
async fn answering_upstream(
    content_type: &'static str,
    body: String,
) -> (String, tokio::task::JoinHandle<()>) {
    let app = axum::Router::new().fallback(move || {
        let body = body.clone();
        async move { ([(axum::http::header::CONTENT_TYPE, content_type)], body) }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), server)
}

/// Send one Anthropic prompt through `forward` and return the response text.
async fn call(state: &SharedState, upstream: &str) -> String {
    let body = serde_json::json!({
        "model": "claude-test",
        "messages": [{ "role": "user", "content": "hi" }],
    });
    let response = forward_json(
        state,
        WireFormat::Anthropic,
        upstream,
        "v1/messages",
        HeaderMap::new(),
        body,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    String::from_utf8(bytes.to_vec()).unwrap()
}

fn text_delta(text: &str) -> String {
    let data = serde_json::json!({
        "type": "content_block_delta",
        "index": 0,
        "delta": { "type": "text_delta", "text": text },
    });
    format!("event: content_block_delta\ndata: {data}\n\n")
}

/// With the resolved scanner enabled, a secret split across two text deltas is
/// redacted before the caller sees it. With `enabled = false` the response
/// redactor does not run and the body reaches the caller byte for byte.
#[tokio::test]
async fn passthrough_response_redaction_follows_enabled() {
    let transcript = format!(
        "event: message_start\ndata: {{\"type\":\"message_start\"}}\n\n{}{}",
        text_delta(&format!("token {SPLIT_HEAD}")),
        text_delta(&format!("{SPLIT_TAIL} done")),
    );
    let (upstream, server) = answering_upstream("text/event-stream", transcript.clone()).await;

    let enabled = call(&passthrough_state(|_| {}), &upstream).await;
    assert!(!enabled.contains(SPLIT_HEAD), "{enabled}");
    assert!(!enabled.contains(SPLIT_TAIL), "{enabled}");
    assert!(enabled.contains("[REDACTED:"), "{enabled}");
    assert!(enabled.contains("\"type\":\"message_start\""), "{enabled}");

    let disabled = call(
        &passthrough_state(|config| config.firewall.enabled = false),
        &upstream,
    )
    .await;
    assert_eq!(disabled, transcript);
    server.abort();
}

/// A non-SSE body gets `redact_outbound` only: the secret is scrubbed, but the
/// config-gated `sanitize` (here, email PII) does not run on it. This pins the
/// scope the module doc states; change both together.
#[tokio::test]
async fn passthrough_json_response_gets_only_the_outbound_scrub() {
    let secret = format!("{SPLIT_HEAD}{SPLIT_TAIL}");
    let body = serde_json::json!({
        "content": [{ "type": "text", "text": format!("{secret} alice@example.com") }],
    })
    .to_string();
    let (upstream, server) = answering_upstream("application/json", body).await;
    let state = passthrough_state(|config| {
        config.firewall.redact_pii = true;
        config.firewall.redact_secrets = true;
    });
    let out = call(&state, &upstream).await;
    assert!(!out.contains(&secret), "{out}");
    assert!(out.contains("[REDACTED:gh_pat]"), "{out}");
    assert!(out.contains("alice@example.com"), "{out}");
    server.abort();
}
