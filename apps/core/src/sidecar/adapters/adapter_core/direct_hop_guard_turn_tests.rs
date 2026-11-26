//! The chat legs on the wire (CE-37). A stand-in endpoint on 127.0.0.1 records
//! every request it gets, so each test says what left Core. The Gateway address
//! is a local port that refuses connections. No test reaches a live service.
//! The rule's own cases are in `direct_hop_guard_tests.rs`; the sub-agent leg is
//! in `workflow/delegation/tests/direct_hop.rs`.
use crate::sidecar::adapters::*;
use axum::extract::State;
use axum::Router;

/// The text of the one user message, so a recorded request is known as ours.
const TURN_TEXT: &str = "hello from the CE-37 test";

/// What the stand-in endpoint received: one row per request.
#[derive(Clone, Default)]
struct Received(std::sync::Arc<tokio::sync::Mutex<Vec<serde_json::Value>>>);

impl Received {
    async fn rows(&self) -> Vec<serde_json::Value> {
        self.0.lock().await.clone()
    }
}

/// Records the request and answers as an OpenAI-compatible endpoint would.
async fn record(
    State(received): State<Received>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null);
    let streamed = body["stream"].as_bool().unwrap_or(false);
    received.0.lock().await.push(serde_json::json!({
        "uri": uri.to_string(),
        "authorization": authorization,
        "body": body,
    }));
    let (content_type, text) = if streamed {
        let chunk = serde_json::json!({"choices":[{"delta":{"content":"stand-in answer"}}]});
        (
            "text/event-stream",
            format!("data: {chunk}\n\ndata: [DONE]\n\n"),
        )
    } else {
        let reply = serde_json::json!({"choices":[{"message":{"content":"stand-in answer"}}]});
        ("application/json", reply.to_string())
    };
    axum::response::Response::builder()
        .header("content-type", content_type)
        .body(axum::body::Body::from(text))
        .unwrap()
}

/// A recording endpoint on a free local port. The server stops with the value.
struct StandIn {
    origin: String,
    received: Received,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for StandIn {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn stand_in() -> StandIn {
    let received = Received::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let router: Router = Router::new().fallback(record).with_state(received.clone());
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    StandIn {
        origin,
        received,
        server,
    }
}

/// A local address that refuses connections: a port that was free a moment ago.
fn closed_origin() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    origin
}

/// Sets the variables of one test and puts the old values back when dropped.
struct Environment(Vec<(&'static str, Option<std::ffi::OsString>)>);

impl Environment {
    fn set(values: &[(&'static str, Option<&str>)]) -> Self {
        let previous = values
            .iter()
            .map(|(name, _)| (*name, std::env::var_os(name)))
            .collect();
        for (name, value) in values {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        Self(previous)
    }
}

impl Drop for Environment {
    fn drop(&mut self) {
        for (name, previous) in &self.0 {
            match previous {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

/// The environment of a default-agent turn while the Gateway does not answer:
/// the Gateway and the fallback entry on closed ports, the default route on
/// `base_url` with `api_key`. The default address is a registry variable, so
/// the caller holds `lock_registry_env` besides the Gateway lock.
fn gateway_out(base_url: &str, api_key: Option<&str>) -> Environment {
    let closed = closed_origin();
    Environment::set(&[
        ("RYU_GATEWAY_URL", Some(closed.as_str())),
        ("RYU_DEFAULT_LLM_BASE_URL", Some(base_url)),
        ("RYU_DEFAULT_LLM_API_KEY", api_key),
        ("OPENAI_API_KEY", None),
        ("RYU_FALLBACK_LLM_BASE_URL", Some(closed.as_str())),
        ("RYU_FALLBACK_LLM_API_KEY", None),
    ])
}

fn default_turn_request() -> ChatStreamRequest {
    serde_json::from_value(serde_json::json!({
        "agent_id": "default",
        "messages": [{ "role": "user", "parts": [{ "type": "text", "text": TURN_TEXT }] }],
        "enable_long_term": false,
        "persist": false,
    }))
    .unwrap()
}

/// The agent store of a default turn. A turn's agent is looked up before any
/// route is chosen (`ensure_foreground_run_allowed`), and no built-in row has
/// the id `default`, so the test adds that row. The route is still picked by
/// the id alone (`is_default_agent`).
async fn agents_with_a_default_row() -> crate::agents::AgentStore {
    let agents = crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    agents
        .create_with_id(
            "default".to_owned(),
            crate::agents::CreateAgent {
                name: "Default".to_owned(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    agents
}

/// One chat turn through the production route, read to its end.
async fn run_turn(request: ChatStreamRequest) -> String {
    let turn = async {
        let response = route_chat_stream(
            request,
            std::sync::Arc::new(AcpAgentRegistry::new()),
            crate::server::conversations::ConversationStore::open_in_memory().unwrap(),
            agents_with_a_default_row().await,
            crate::sidecar::SidecarManager::new_noop(),
            crate::server::memory::MemoryStore::open_in_memory().unwrap(),
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
            ryu_skills::SkillRegistry::empty(),
            ryu_tracing::TraceStore::open_in_memory().unwrap(),
            None,
            None,
            crate::routing_policy::reactive::TurnWatch::off(),
            None,
        )
        .await;
        let body = axum::body::to_bytes(response.into_body(), 2_000_000)
            .await
            .unwrap();
        String::from_utf8_lossy(&body).into_owned()
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), turn)
        .await
        .expect("the turn ended")
}

/// The connect step of a turn whose first hop is the Gateway at `gateway`, with
/// the default agent's fallback chain as the registry reads it from the
/// environment.
async fn connect_through(
    gateway: &str,
) -> Result<reqwest::Response, crate::sidecar::adapters::acp::AcpFailure> {
    let chain = AcpAgentRegistry::new().fallback_chain_for_default();
    let messages = vec![serde_json::json!({ "role": "user", "content": TURN_TEXT })];
    connect_with_fallback(
        &messages,
        gateway,
        "primary-model",
        Some("gateway-token"),
        None,
        None,
        None,
        &[],
        &[],
        None,
        &chain,
        &AgentSlots::default(),
        false,
        false,
        &crate::inference::SamplingConfig::default(),
        crate::inference::Engine::Other,
        &[],
        None,
        None,
        None,
        None,
        false,
        false,
        StreamHop::Provider,
        None,
    )
    .await
}

/// The environment of a turn whose Gateway connection fails and whose fallback
/// entry is `base_url` with `api_key`. Returns the Gateway address too.
fn gateway_connection_fails(base_url: &str, api_key: Option<&str>) -> (Environment, String) {
    let closed = closed_origin();
    let environment = Environment::set(&[
        ("RYU_GATEWAY_URL", Some(closed.as_str())),
        ("RYU_FALLBACK_LLM_BASE_URL", Some(base_url)),
        ("RYU_FALLBACK_LLM_API_KEY", api_key),
        ("RYU_FALLBACK_LLM_MODEL", None),
    ]);
    (environment, closed)
}

fn assert_refusal_text(text: &str) {
    assert!(text.contains(KEYED_DIRECT_HOP_REFUSAL), "{text}");
    assert!(
        text.contains("The Gateway did not answer in time"),
        "{text}"
    );
    assert!(text.contains("Trying again may work"), "{text}");
}

// Leg 1: the chat plane's direct leg after a failed Gateway health probe.

#[tokio::test]
async fn a_keyed_default_turn_is_refused_when_the_gateway_does_not_answer() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _registry = crate::registry::lock_registry_env();
    let provider = stand_in().await;
    let _environment = gateway_out(&provider.origin, Some("sk-ce37-default"));

    let stream = run_turn(default_turn_request()).await;

    let rows = provider.received.rows().await;
    assert!(
        rows.is_empty(),
        "a keyed turn went around the Gateway: {rows:?}"
    );
    assert_refusal_text(&stream);
    assert!(!stream.contains("stand-in answer"), "{stream}");
}

#[tokio::test]
async fn credentials_in_the_default_address_are_refused_on_the_direct_leg() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _registry = crate::registry::lock_registry_env();
    let provider = stand_in().await;
    let with_userinfo = provider.origin.replace("http://", "http://user:secret@");
    let _environment = gateway_out(&with_userinfo, None);

    let stream = run_turn(default_turn_request()).await;

    let rows = provider.received.rows().await;
    assert!(
        rows.is_empty(),
        "the credential in the address went around the Gateway: {rows:?}"
    );
    assert_refusal_text(&stream);
}

#[tokio::test]
async fn a_keyless_default_turn_still_reaches_its_endpoint_when_the_gateway_does_not_answer() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _registry = crate::registry::lock_registry_env();
    let engine = stand_in().await;
    let _environment = gateway_out(&engine.origin, None);

    let stream = run_turn(default_turn_request()).await;

    let rows = engine.received.rows().await;
    let turns: Vec<_> = rows
        .iter()
        .filter(|row| row["body"]["messages"].to_string().contains(TURN_TEXT))
        .collect();
    assert!(
        !turns.is_empty(),
        "the keyless endpoint got no turn: {rows:?}"
    );
    assert_eq!(turns[0]["uri"], "/v1/chat/completions");
    assert!(
        rows.iter().all(|row| row["authorization"].is_null()),
        "{rows:?}"
    );
    assert!(stream.contains("stand-in answer"), "{stream}");
    assert!(!stream.contains(KEYED_DIRECT_HOP_REFUSAL), "{stream}");
}

#[tokio::test]
async fn a_public_tool_run_keeps_its_own_refusal_when_the_gateway_does_not_answer() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let _registry = crate::registry::lock_registry_env();
    let provider = stand_in().await;
    let _environment = gateway_out(&provider.origin, Some("sk-ce37-default"));
    let mut request = default_turn_request();
    request.public_agent_policy = Some(PublicAgentRunPolicy {
        published_agent_id: "published-ce37".to_owned(),
        agent_id: "default".to_owned(),
        capabilities: ["tool:web_search".to_owned()].into_iter().collect(),
    });

    let stream = run_turn(request).await;

    let rows = provider.received.rows().await;
    assert!(rows.is_empty(), "{rows:?}");
    assert!(
        stream.contains("Public tool access requires a healthy Gateway connection."),
        "{stream}"
    );
    assert!(!stream.contains(KEYED_DIRECT_HOP_REFUSAL), "{stream}");
}

// Leg 2: the fallback entry after a failed Gateway connection.

#[tokio::test]
async fn a_keyed_fallback_entry_is_refused_after_a_failed_gateway_connection() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let provider = stand_in().await;
    let (_environment, gateway) =
        gateway_connection_fails(&provider.origin, Some("sk-ce37-fallback"));

    let result = connect_through(&gateway).await;

    let rows = provider.received.rows().await;
    assert!(
        rows.is_empty(),
        "a keyed fallback entry was tried around the Gateway: {rows:?}"
    );
    let failure = result.expect_err("the keyed fallback entry is refused");
    assert_refusal_text(&failure.message);
}

#[tokio::test]
async fn credentials_in_a_fallback_address_are_refused() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let provider = stand_in().await;
    let with_userinfo = provider.origin.replace("http://", "http://user:secret@");
    let with_query = format!("{}?api_key=secret", provider.origin);
    for address in [with_userinfo, with_query] {
        let (_environment, gateway) = gateway_connection_fails(&address, None);

        let result = connect_through(&gateway).await;

        let rows = provider.received.rows().await;
        assert!(
            rows.is_empty(),
            "the credential in {address} went around the Gateway: {rows:?}"
        );
        let failure = result.expect_err("an address with a credential is refused");
        assert_refusal_text(&failure.message);
    }
}

#[tokio::test]
async fn a_keyless_fallback_entry_still_receives_the_turn() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let engine = stand_in().await;
    let (_environment, gateway) = gateway_connection_fails(&engine.origin, None);

    let response = connect_through(&gateway)
        .await
        .expect("the keyless fallback entry is tried");

    assert!(response.status().is_success());
    let rows = engine.received.rows().await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["uri"], "/v1/chat/completions");
    assert!(rows[0]["authorization"].is_null(), "{rows:?}");
    assert!(rows[0]["body"]["messages"].to_string().contains(TURN_TEXT));
}

#[tokio::test]
async fn the_gateway_hop_is_not_refused_and_carries_the_gateway_token() {
    let _lock = crate::sidecar::gateway::lock_gateway_env();
    let gateway = stand_in().await;
    let _environment = Environment::set(&[
        ("RYU_GATEWAY_URL", Some(gateway.origin.as_str())),
        ("RYU_FALLBACK_LLM_BASE_URL", Some(gateway.origin.as_str())),
        ("RYU_FALLBACK_LLM_API_KEY", None),
    ]);

    let response = connect_through(&gateway.origin)
        .await
        .expect("the Gateway hop goes out");

    assert!(response.status().is_success());
    let rows = gateway.received.rows().await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["uri"], "/v1/chat/completions");
    assert_eq!(rows[0]["authorization"], "Bearer gateway-token");
}
