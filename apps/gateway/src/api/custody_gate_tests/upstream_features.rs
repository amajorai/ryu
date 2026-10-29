//! Anthropic server tools and betas on the hosted Gateway.
//!
//! The upstream is a real `AnthropicProvider` pointed at a local mock that
//! records every request it receives, so a refusal proves nothing was sent and
//! a control proves what the provider would have forwarded. Every refused case
//! asserts 403 `feature_not_permitted`, zero upstream requests and one audit
//! row, and has a benign control that dispatches.
use super::*;

const ANTHROPIC_MODEL: &str = "claude-fixture";
/// A real beta identifier outside the fleet allowlist. It names a feature,
/// not content, so it is a safe trigger.
const CODE_EXECUTION_BETA: &str = "code-execution-2025-08-25";
const CACHING_BETAS: &str = "prompt-caching-2024-07-31,extended-cache-ttl-2025-04-11";

/// One request the mock Anthropic upstream received.
#[derive(Clone, Debug)]
struct Captured {
    beta: Option<String>,
    body: Value,
}

struct AnthropicUpstream {
    base: String,
    requests: Arc<Mutex<Vec<Captured>>>,
    task: tokio::task::JoinHandle<()>,
}

impl AnthropicUpstream {
    fn requests(&self) -> Vec<Captured> {
        self.requests.lock().expect("captured lock").clone()
    }
}

impl Drop for AnthropicUpstream {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn anthropic_message() -> Value {
    json!({
        "id": "msg_fixture",
        "type": "message",
        "role": "assistant",
        "model": ANTHROPIC_MODEL,
        "content": [{ "type": "text", "text": "ok" }],
        "stop_reason": "end_turn",
        "usage": { "input_tokens": 3, "output_tokens": 1 }
    })
}

fn anthropic_sse() -> String {
    let events = [
        (
            "message_start",
            json!({ "type": "message_start", "message": {
                "id": "msg_fixture", "type": "message", "role": "assistant",
                "model": ANTHROPIC_MODEL, "content": [],
                "usage": { "input_tokens": 3, "output_tokens": 0 } } }),
        ),
        (
            "content_block_start",
            json!({ "type": "content_block_start", "index": 0,
                "content_block": { "type": "text", "text": "" } }),
        ),
        (
            "content_block_delta",
            json!({ "type": "content_block_delta", "index": 0,
                "delta": { "type": "text_delta", "text": "ok" } }),
        ),
        (
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        (
            "message_delta",
            json!({ "type": "message_delta", "delta": { "stop_reason": "end_turn" },
                "usage": { "output_tokens": 1 } }),
        ),
        ("message_stop", json!({ "type": "message_stop" })),
    ];
    events
        .iter()
        .map(|(event, data)| format!("event: {event}\ndata: {data}\n\n"))
        .collect()
}

async fn spawn_anthropic_upstream() -> AnthropicUpstream {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("mock Anthropic binds");
    let base = format!("http://{}", listener.local_addr().expect("mock address"));
    let requests: Arc<Mutex<Vec<Captured>>> = Arc::default();
    let captured = Arc::clone(&requests);
    let router = Router::new().route(
        "/v1/messages",
        post(
            move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                let captured = Arc::clone(&captured);
                async move {
                    let stream = body["stream"].as_bool().unwrap_or(false);
                    captured.lock().expect("captured lock").push(Captured {
                        beta: headers
                            .get("anthropic-beta")
                            .and_then(|value| value.to_str().ok())
                            .map(str::to_owned),
                        body,
                    });
                    if stream {
                        axum::response::Response::builder()
                            .header("content-type", "text/event-stream")
                            .body(Body::from(anthropic_sse()))
                            .expect("sse response builds")
                    } else {
                        axum::response::IntoResponse::into_response(Json(anthropic_message()))
                    }
                }
            },
        ),
    );
    let task = tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("mock Anthropic serves");
    });
    AnthropicUpstream {
        base,
        requests,
        task,
    }
}

fn anthropic_harness(custody: GatewayCustody, upstream: &AnthropicUpstream) -> Harness {
    let base_url = upstream.base.clone();
    let (state, audit) = state_with(custody, |config| {
        config.providers.anthropic = Some(crate::config::AnthropicProviderConfig {
            api_key: "sk-ant-mock".to_owned(),
            api_keys: Vec::new(),
            base_url,
        });
        config.routing.default_provider = ProviderId::from("anthropic");
        config.routing.fallback_chain = vec![];
    });
    Harness {
        app: crate::api::router(Arc::new(state)),
        audit,
    }
}

async fn send_chat(
    app: &Router,
    uri: &str,
    beta: Option<&str>,
    body: &Value,
) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {MASTER}"))
        .extension(peer(true));
    if let Some(beta) = beta {
        request = request.header("anthropic-beta", beta);
    }
    let response = app
        .clone()
        .oneshot(
            request
                .body(Body::from(body.to_string()))
                .expect("request builds"),
        )
        .await
        .expect("router responds");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body reads");
    (
        status,
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned())),
    )
}

fn function_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "lookup_order",
            "description": "Look up an order by id.",
            "parameters": {
                "type": "object",
                "properties": { "id": { "type": "string" } }
            }
        }
    })
}

/// Section 02.17 B32: a server tool declared on the OpenAI-compatible route.
fn web_fetch_tool() -> Value {
    json!({ "type": "web_fetch_20250910", "name": "web_fetch" })
}

fn chat_with_tools(tools: Vec<Value>, stream: bool) -> Value {
    json!({
        "model": ANTHROPIC_MODEL,
        "stream": stream,
        "messages": [{ "role": "user", "content": "Hi" }],
        "tools": tools
    })
}

fn assert_refused(
    status: StatusCode,
    body: &Value,
    harness: &Harness,
    upstream: &AnthropicUpstream,
    case: &str,
) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{case}: {body}");
    assert_eq!(body["error"]["type"], "policy_violation", "{case}");
    assert_eq!(body["error"]["code"], "feature_not_permitted", "{case}");
    assert_eq!(body["error"]["layer"], "platform", "{case}");
    assert_eq!(body["error"]["remedy"], "none", "{case}");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(!message.contains("web_fetch"), "{case}: {message}");
    assert!(!message.contains(CODE_EXECUTION_BETA), "{case}: {message}");
    assert!(
        upstream.requests().is_empty(),
        "{case}: upstream was called: {:?}",
        upstream.requests()
    );
    let rows = harness.audit.rows();
    assert_eq!(rows.len(), 1, "{case}: {rows:?}");
    assert!(
        rows[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("feature_not_permitted")),
        "{case}: {rows:?}"
    );
}

// ── /v1/chat/completions ─────────────────────────────────────────────────────

#[tokio::test]
async fn fleet_refuses_a_server_tool_on_chat() {
    for stream in [false, true] {
        let upstream = spawn_anthropic_upstream().await;
        let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
        let body = chat_with_tools(vec![function_tool(), web_fetch_tool()], stream);
        let (status, response) = send_chat(&harness.app, "/v1/chat/completions", None, &body).await;
        assert_refused(
            status,
            &response,
            &harness,
            &upstream,
            &format!("server tool, stream={stream}"),
        );
    }
}

#[tokio::test]
async fn fleet_refuses_a_beta_outside_the_allowlist() {
    let mixed = format!("{CACHING_BETAS},{CODE_EXECUTION_BETA}");
    for (beta, stream) in [
        (CODE_EXECUTION_BETA, false),
        (mixed.as_str(), false),
        (CODE_EXECUTION_BETA, true),
    ] {
        let upstream = spawn_anthropic_upstream().await;
        let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
        let body = chat_with_tools(vec![function_tool()], stream);
        let (status, response) =
            send_chat(&harness.app, "/v1/chat/completions", Some(beta), &body).await;
        assert_refused(
            status,
            &response,
            &harness,
            &upstream,
            &format!("beta {beta}, stream={stream}"),
        );
    }
}

#[tokio::test]
async fn control_fleet_dispatches_function_tools_with_caching_betas() {
    for stream in [false, true] {
        let upstream = spawn_anthropic_upstream().await;
        let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
        let body = chat_with_tools(vec![function_tool()], stream);
        let (status, response) = send_chat(
            &harness.app,
            "/v1/chat/completions",
            Some(CACHING_BETAS),
            &body,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "stream={stream}: {response}");
        let requests = upstream.requests();
        assert_eq!(requests.len(), 1, "stream={stream}");
        assert_eq!(
            requests[0].beta.as_deref(),
            Some(CACHING_BETAS),
            "stream={stream}"
        );
        assert_eq!(requests[0].body["tools"][0]["name"], "lookup_order");
        assert!(requests[0].body.get("ryu_anthropic_beta").is_none());
    }
}

#[tokio::test]
async fn control_server_tools_and_betas_pass_off_fleet() {
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_anthropic_upstream().await;
        let harness = anthropic_harness(custody, &upstream);
        let body = chat_with_tools(vec![function_tool(), web_fetch_tool()], false);
        let (status, response) = send_chat(
            &harness.app,
            "/v1/chat/completions",
            Some(CODE_EXECUTION_BETA),
            &body,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {response}");
        let requests = upstream.requests();
        assert_eq!(requests.len(), 1, "{custody:?}");
        assert_eq!(
            requests[0].beta.as_deref(),
            Some(CODE_EXECUTION_BETA),
            "{custody:?}"
        );
        assert_eq!(
            requests[0].body["tools"][1],
            web_fetch_tool(),
            "{custody:?}: the server tool is forwarded verbatim"
        );
    }
}

// ── /v1/messages ─────────────────────────────────────────────────────────────

fn messages_with_tools(tools: Vec<Value>) -> Value {
    json!({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 64,
        "messages": [{ "role": "user", "content": "Hi" }],
        "tools": tools
    })
}

fn custom_tool() -> Value {
    json!({
        "name": "lookup_order",
        "description": "Look up an order by id.",
        "input_schema": { "type": "object", "properties": { "id": { "type": "string" } } }
    })
}

#[tokio::test]
async fn fleet_refuses_a_native_server_tool_on_messages() {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let body = messages_with_tools(vec![
        custom_tool(),
        json!({ "type": "web_search_20250305", "name": "web_search" }),
    ]);
    let (status, response) = send_chat(&harness.app, "/v1/messages", None, &body).await;
    assert_refused(status, &response, &harness, &upstream, "native server tool");
    assert_eq!(harness.audit.rows()[0].model, ANTHROPIC_MODEL);
}

#[tokio::test]
async fn control_messages_custom_tools_dispatch_on_fleet_and_server_tools_off_fleet() {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let body = messages_with_tools(vec![custom_tool()]);
    let (status, response) = send_chat(&harness.app, "/v1/messages", None, &body).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(upstream.requests().len(), 1);

    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let upstream = spawn_anthropic_upstream().await;
        let harness = anthropic_harness(custody, &upstream);
        let body = messages_with_tools(vec![
            custom_tool(),
            json!({ "type": "web_search_20250305", "name": "web_search" }),
        ]);
        let (status, response) = send_chat(&harness.app, "/v1/messages", None, &body).await;
        assert_eq!(status, StatusCode::OK, "{custody:?}: {response}");
        assert_eq!(upstream.requests().len(), 1, "{custody:?}");
    }
}

#[tokio::test]
async fn fleet_refuses_a_beta_header_on_messages() {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let body = messages_with_tools(vec![custom_tool()]);
    let (status, response) = send_chat(
        &harness.app,
        "/v1/messages",
        Some(CODE_EXECUTION_BETA),
        &body,
    )
    .await;
    assert_refused(status, &response, &harness, &upstream, "messages beta");
}

#[tokio::test]
async fn control_messages_caching_betas_dispatch_on_fleet() {
    let upstream = spawn_anthropic_upstream().await;
    let harness = anthropic_harness(GatewayCustody::Fleet, &upstream);
    let body = messages_with_tools(vec![custom_tool()]);
    let (status, response) =
        send_chat(&harness.app, "/v1/messages", Some(CACHING_BETAS), &body).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(upstream.requests().len(), 1);
}

#[cfg(test)]
mod probe;
