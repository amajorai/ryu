//! Exercises the actual native SSE loop against an explicit fake Gateway.
//! The separate cloud runtime integration tests exercise the Gateway-to-workspace half.
use super::*;
use axum::{extract::State, routing::post, Json, Router};
use serde_json::json;
use std::future::IntoFuture;
use tokio::sync::Mutex;

#[derive(Clone, Default)]
struct Probe(Arc<Mutex<Vec<Value>>>);

#[test]
fn cloud_tools_for_agent_is_closed_and_honors_the_agent_allowlist() {
    let registry = McpRegistry::empty();
    assert_eq!(registry.cloud_tools_for_agent(None).len(), 4);
    assert!(registry.cloud_tools_for_agent(Some(&[])).is_empty());
    let read_only = registry.cloud_tools_for_agent(Some(&["cloud.read_file".into()]));
    assert_eq!(read_only.len(), 1);
    assert_eq!(read_only[0].id, "cloud.read_file");
    assert!(registry
        .cloud_tools_for_agent(Some(&["host.exec".into()]))
        .is_empty());
    assert_eq!(
        registry
            .cloud_tools_for_agent(Some(&["cloud".into()]))
            .len(),
        4
    );
}

async fn model(
    State(probe): State<Probe>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let mut records = probe.0.lock().await;
    let turn = records
        .iter()
        .filter(|row| row.get("messages").is_some())
        .count();
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    records.push(json!({
        "model_request_headers": {
            "authorization": header("authorization"),
            "agent_id": header("x-ryu-agent-id"),
            "agent_proof": header("x-ryu-agent-proof"),
        }
    }));
    records.push(body);
    let delta = if turn == 0 {
        json!({"tool_calls":[
            {"index":0,"id":"call-cloud","type":"function","function":{"name":"cloud_exec","arguments":"{\"command\":\"pwd\"}"}},
            {"index":1,"id":"call-host","type":"function","function":{"name":"host_exec","arguments":"{\"command\":\"pwd\"}"}}
        ]})
    } else {
        json!({"content":"Cloud workspace verified."})
    };
    let chunk = json!({"choices":[{"delta":delta}]});
    Response::builder()
        .header("content-type", "text/event-stream")
        .body(Body::from(format!("data: {chunk}\n\ndata: [DONE]\n\n")))
        .unwrap()
}

async fn tool(State(probe): State<Probe>, Json(body): Json<Value>) -> Json<Value> {
    probe.0.lock().await.push(body);
    Json(json!({"ok":true,"result":{"stdout":"/tmp/ryu-workspace/project","exit_code":0}}))
}

#[tokio::test]
async fn cloud_native_sse_loop_forwards_only_closed_tools_with_server_context() {
    let _managed_lock = crate::sidecar::gateway::lock_managed_node_env();
    let _gateway_lock = crate::sidecar::gateway::lock_gateway_env();
    let probe = Probe::default();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(
        axum::serve(
            listener,
            Router::new()
                .route("/v1/chat/completions", post(model))
                .route("/v1/exec/tool", post(tool))
                .with_state(probe.clone()),
        )
        .into_future(),
    );
    struct RestoreEnvironment(Vec<(&'static str, Option<std::ffi::OsString>)>);
    impl Drop for RestoreEnvironment {
        fn drop(&mut self) {
            for (name, previous) in &self.0 {
                match previous {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
        }
    }
    let _environment = RestoreEnvironment(
        [
            "RYU_GATEWAY_URL",
            "RYU_GATEWAY_MANAGED",
            "RYU_GATEWAY_TOKEN",
            "RYU_GATEWAY_CORE_PROOF_KEY",
        ]
        .into_iter()
        .map(|name| (name, std::env::var_os(name)))
        .collect(),
    );
    std::env::set_var("RYU_GATEWAY_URL", &origin);
    // This fixture is an explicitly configured external Gateway, not a managed
    // listener whose signed readiness Core has yet to verify.
    std::env::set_var("RYU_GATEWAY_MANAGED", "0");
    std::env::set_var("RYU_GATEWAY_TOKEN", "gwrelay_cloud_fixture_123456789");
    // An external Gateway receives a bearer-bound agent proof signed with this key.
    std::env::set_var(
        "RYU_GATEWAY_CORE_PROOF_KEY",
        "gwproof_cloud_fixture_123456789",
    );
    // The Gateway hop carries the inference credential its caller resolves, as
    // the production `via_gateway` branch passes it to `route_openai_stream`.
    let gateway_token = crate::sidecar::gateway::required_gateway_inference_token()
        .expect("external Gateway inference credential");
    let req = ChatStreamRequest {
        conversation_id: Some("cloud-native-proof".into()),
        cloud_task_context: Some(crate::server::cloud_tasks::CloudTaskContext {
            environment_id: "proof".into(),
            environment_name: "Proof environment".into(),
            revision: 1,
            working_directory: "/tmp/ryu-workspace/project".into(),
            repository_directories: vec![],
            start_instructions: "Follow cloud instructions.".into(),
            executor: "ryu".into(),
            backend: "docker".into(),
        }),
        browser_context_consent: true,
        client_tools: vec![
            json!({"type":"function","function":{"name":"browser_host_exec","parameters":{"type":"object"}}}),
        ],
        messages: vec![UiMessage {
            role: "user".into(),
            content: UiContent::Text("Inspect cloud workspace".into()),
            parts: vec![],
            metadata: None,
        }],
        ..Default::default()
    };
    let response = route_openai_stream(
        req,
        origin,
        "selected-model".into(),
        Some(gateway_token.clone()),
        Some("Follow cloud instructions.".into()),
        vec![],
        None,
        None,
        Some("ryu".into()),
        |_, _, _| async { None },
        None,
        vec![],
        SkillRegistry::empty(),
        vec![],
        None,
        vec![],
        AgentSlots::default(),
        crate::inference::SamplingConfig::default(),
        crate::inference::Engine::Other,
        Arc::new(McpRegistry::empty()),
        TraceStore::open_in_memory().unwrap(),
        true,
        false,
        None,
        None,
        None,
        None,
        None,
        StreamHop::Provider,
        None,
        crate::routing_policy::reactive::TurnWatch::off(),
    )
    .await;
    let result = axum::body::to_bytes(response.into_body(), 2_000_000)
        .await
        .unwrap();
    server.abort();
    let result = String::from_utf8(result.to_vec()).unwrap();
    assert!(result.contains("Cloud workspace verified."), "{result}");
    let records = probe.0.lock().await;
    let requests: Vec<_> = records
        .iter()
        .filter(|row| row.get("messages").is_some())
        .collect();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["model"], "selected-model");
    assert!(requests[0]["messages"]
        .to_string()
        .contains("Follow cloud instructions."));
    let names: Vec<_> = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names.len(), 4);
    assert!(names.iter().all(|name| name.starts_with("cloud_")));
    let calls: Vec<_> = records
        .iter()
        .filter(|row| row.get("tool_id").is_some())
        .collect();
    assert_eq!(calls.len(), 1, "unknown host tool must never reach Gateway");
    assert_eq!(calls[0]["tool_id"], "cloud.exec");
    assert_eq!(calls[0]["host_conversation_id"], "cloud-native-proof");
    assert_eq!(
        calls[0]["host_conversation_proof"],
        crate::server::host_conversation_proof("cloud-native-proof")
    );
    assert!(calls[0]["arguments"].get("workspaceId").is_none());
    assert!(requests[1]["messages"]
        .to_string()
        .contains("closed cloud tools"));
    // Each model hop to the configured Gateway carries the bearer and an agent
    // proof the Gateway's own verifier accepts for that bearer and agent.
    let hops: Vec<_> = records
        .iter()
        .filter_map(|row| row.get("model_request_headers"))
        .collect();
    assert_eq!(hops.len(), 2);
    for hop in hops {
        assert_eq!(hop["authorization"], format!("Bearer {gateway_token}"));
        assert_eq!(hop["agent_id"], "ryu");
        let proof = hop["agent_proof"].as_str().expect("agent proof header");
        assert!(ryu_gw_credentials::verify_agent_route_proof(
            "gwproof_cloud_fixture_123456789",
            &gateway_token,
            "ryu",
            proof,
        ));
        assert!(!ryu_gw_credentials::verify_agent_route_proof(
            "gwproof_cloud_fixture_123456789",
            &gateway_token,
            "another-agent",
            proof,
        ));
    }
}
