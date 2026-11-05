use super::*;
use crate::config::FirewallConfig;

#[tokio::test]
async fn inbound_scanning_refuses_uninspectable_prompts_before_forwarding() {
    let mut state = crate::state::AppState::new_for_test_default();
    state.firewall = crate::firewall::FirewallRegistry::new(FirewallConfig {
        enabled: true,
        scan_inbound: true,
        ..FirewallConfig::default()
    });
    let state = std::sync::Arc::new(state);
    for (encoding, body, expected) in [
        (None, "not-json", StatusCode::BAD_REQUEST),
        (Some("gzip"), "{}", StatusCode::UNSUPPORTED_MEDIA_TYPE),
    ] {
        let mut headers = HeaderMap::new();
        if let Some(encoding) = encoding {
            headers.insert("content-encoding", encoding.parse().unwrap());
        }
        let response = forward(
            WireFormat::Anthropic,
            "http://127.0.0.1:1",
            PassthroughRoute::Prompt,
            state.clone(),
            "127.0.0.1:10000".parse().unwrap(),
            "v1/messages".into(),
            Method::POST,
            headers,
            axum::extract::RawQuery(None),
            Bytes::from(body),
        )
        .await;
        assert_eq!(response.status(), expected);
    }
}

/// What a local stand-in upstream received from `forward`.
#[derive(Clone, Default)]
pub(super) struct Captured {
    pub(super) bodies: std::sync::Arc<std::sync::Mutex<Vec<(HeaderMap, Bytes)>>>,
}

/// Spawn a loopback upstream that records each request and answers `{}`.
pub(super) async fn capturing_upstream() -> (String, Captured, tokio::task::JoinHandle<()>) {
    let captured = Captured::default();
    let sink = captured.clone();
    let app = axum::Router::new().fallback(move |headers: HeaderMap, body: Bytes| {
        let sink = sink.clone();
        async move {
            sink.bodies.lock().unwrap().push((headers, body));
            (
                [(axum::http::header::CONTENT_TYPE, "application/json")],
                "{}",
            )
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{address}"), captured, server)
}

pub(super) fn passthrough_state(
    configure: impl FnOnce(&mut crate::config::GatewayConfig),
) -> SharedState {
    passthrough_state_with_custody(crate::custody::GatewayCustody::SelfHosted, configure)
}

pub(super) fn passthrough_state_with_custody(
    custody: crate::custody::GatewayCustody,
    configure: impl FnOnce(&mut crate::config::GatewayConfig),
) -> SharedState {
    let mut config = crate::config::GatewayConfig {
        firewall: FirewallConfig {
            enabled: true,
            scan_inbound: true,
            ..FirewallConfig::default()
        },
        ..crate::config::GatewayConfig::default()
    };
    configure(&mut config);
    let audit = crate::audit::AuditLogger::new(&crate::config::AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let evals = crate::evals::EvalsRunner::new(crate::config::EvalsConfig::default());
    let mut state = crate::state::AppState::new_for_test(config, audit, evals);
    state.custody = custody;
    std::sync::Arc::new(state)
}

pub(super) async fn forward_json(
    state: &SharedState,
    format: WireFormat,
    upstream: &str,
    path: &str,
    headers: HeaderMap,
    body: Value,
) -> Response {
    forward(
        format,
        upstream,
        classify_path(format, "POST", path),
        state.clone(),
        "127.0.0.1:10000".parse().unwrap(),
        path.into(),
        Method::POST,
        headers,
        axum::extract::RawQuery(None),
        Bytes::from(body.to_string()),
    )
    .await
}

#[tokio::test]
async fn fleet_gateway_refuses_the_passthrough_even_from_loopback() {
    let state = passthrough_state(|config| config.fleet = true);
    let (upstream, captured, server) = capturing_upstream().await;
    let response = forward_json(
        &state,
        WireFormat::Anthropic,
        &upstream,
        "v1/messages",
        HeaderMap::new(),
        serde_json::json!({ "model": "m", "messages": [] }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(captured.bodies.lock().unwrap().is_empty());
    server.abort();
}

/// Fleet custody detected from the environment closes the passthrough even
/// when `gateway.toml` leaves `fleet = false`; the self-hosted control on the
/// same config still forwards.
#[tokio::test]
async fn env_detected_fleet_custody_refuses_the_passthrough_from_loopback() {
    let state = passthrough_state_with_custody(crate::custody::GatewayCustody::Fleet, |config| {
        config.fleet = false;
    });
    let (upstream, captured, server) = capturing_upstream().await;
    let response = forward_json(
        &state,
        WireFormat::Anthropic,
        &upstream,
        "v1/messages",
        HeaderMap::new(),
        serde_json::json!({ "model": "m", "messages": [] }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(captured.bodies.lock().unwrap().is_empty());

    let control = passthrough_state(|config| config.fleet = false);
    let response = forward_json(
        &control,
        WireFormat::Anthropic,
        &upstream,
        "v1/messages",
        HeaderMap::new(),
        serde_json::json!({ "model": "m", "messages": [] }),
    )
    .await;
    assert_ne!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(captured.bodies.lock().unwrap().len(), 1);
    server.abort();
}

/// Claude Code's tool traffic (`cat .env` output in a `tool_result`, the
/// command in `tool_use.input`) is redacted before it reaches Anthropic, and
/// Gateway-local `x-ryu-*` headers never leave the Gateway.
#[tokio::test]
async fn anthropic_tool_traffic_is_redacted_and_ryu_headers_are_stripped() {
    let state = passthrough_state(|_| {});
    let (upstream, captured, server) = capturing_upstream().await;
    let mut headers = HeaderMap::new();
    headers.insert("authorization", "Bearer subscription".parse().unwrap());
    headers.insert("x-ryu-user-id", "spoofed-user".parse().unwrap());
    headers.insert("x-ryu-agent-id", "spoofed-agent".parse().unwrap());
    let response = forward_json(
        &state,
        WireFormat::Anthropic,
        &upstream,
        "v1/messages",
        headers,
        serde_json::json!({
            "model": "claude-test",
            "messages": [
                { "role": "assistant", "content": [{
                    "type": "tool_use", "id": "toolu_1", "name": "Bash",
                    "input": { "command": "grep admin@example.com .env" }
                }] },
                { "role": "user", "content": [{
                    "type": "tool_result", "tool_use_id": "toolu_1",
                    "content": "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
                }] }
            ]
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let recorded = captured.bodies.lock().unwrap();
    let (sent_headers, sent_body) = &recorded[0];
    let sent = String::from_utf8_lossy(sent_body);
    assert!(!sent.contains("AKIAIOSFODNN7EXAMPLE"), "{sent}");
    assert!(!sent.contains("admin@example.com"), "{sent}");
    assert!(sent.contains("[REDACTED:"), "{sent}");
    assert!(sent.contains("toolu_1"), "ids must be preserved: {sent}");
    assert_eq!(sent_headers["authorization"], "Bearer subscription");
    assert!(
        sent_headers
            .keys()
            .all(|name| !name.as_str().starts_with("x-ryu-")),
        "x-ryu-* headers must not be forwarded upstream: {sent_headers:?}"
    );
    drop(recorded);
    server.abort();
}

/// Codex replays shell output as `function_call_output`; it is redacted too.
#[tokio::test]
async fn codex_function_call_output_is_redacted() {
    let state = passthrough_state(|_| {});
    let (upstream, captured, server) = capturing_upstream().await;
    let response = forward_json(
        &state,
        WireFormat::OpenAiResponses,
        &upstream,
        "responses",
        HeaderMap::new(),
        serde_json::json!({
            "model": "gpt-codex",
            "input": [
                { "type": "function_call", "call_id": "call_1", "name": "shell",
                  "arguments": "{\"cmd\":\"cat .env\"}" },
                { "type": "function_call_output", "call_id": "call_1",
                  "output": "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx" }
            ]
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let recorded = captured.bodies.lock().unwrap();
    let sent = String::from_utf8_lossy(&recorded[0].1);
    assert!(!sent.contains("sk-abcdefghijklmnopqrstuvwx"), "{sent}");
    assert!(sent.contains("call_1"), "{sent}");
    drop(recorded);
    server.abort();
}

/// A secret the raw-text redaction cannot rewrite (zero-width split) refuses
/// the request instead of reaching the provider.
#[tokio::test]
async fn unredactable_secret_is_refused_before_forwarding() {
    let state = passthrough_state(|_| {});
    let (upstream, captured, server) = capturing_upstream().await;
    let response = forward_json(
        &state,
        WireFormat::Anthropic,
        &upstream,
        "v1/messages",
        HeaderMap::new(),
        serde_json::json!({
            "model": "claude-test",
            "messages": [{ "role": "user", "content": "key AKIA\u{200B}IOSFODNN7EXAMPLE" }]
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(captured.bodies.lock().unwrap().is_empty());
    server.abort();
}
