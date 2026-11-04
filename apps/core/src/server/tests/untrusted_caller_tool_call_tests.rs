use crate::server::*;

async fn call(
    state: &ServerState,
    agent_id: &str,
    tool: &str,
    arguments: serde_json::Value,
    untrusted_caller: bool,
) -> (StatusCode, serde_json::Value) {
    let body: CallToolBody = serde_json::from_value(json!({
        "tool": tool,
        "arguments": arguments,
        "agent_id": agent_id,
        "untrusted_caller": untrusted_caller,
    }))
    .expect("the Gateway's tool-call body decodes");
    let response = call_mcp_tool_inner(state.clone(), None, None, body).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

#[tokio::test]
async fn forwarded_untrusted_calls_keep_only_the_caller_profile() {
    use crate::agents::{AgentLifecycleStatus, AgentSafetyProfile, CreateAgent, UpdateAgent};

    let directory = tempfile::tempdir().unwrap();
    let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
    // An active phone agent allowed every tool, so only the caller profile
    // can be what refuses a call below.
    let agent = state
        .agent_store
        .create(CreateAgent {
            name: "Phone line".to_owned(),
            tools: vec!["*".to_owned()],
            ..Default::default()
        })
        .await
        .unwrap();
    for update in [
        UpdateAgent {
            lifecycle_status: Some(AgentLifecycleStatus::Trial),
            safety_profile: Some(AgentSafetyProfile::Autonomous),
            ..Default::default()
        },
        UpdateAgent {
            lifecycle_status: Some(AgentLifecycleStatus::Active),
            ..Default::default()
        },
    ] {
        state.agent_store.update(&agent.id, update).await.unwrap();
    }
    state.mcp = std::sync::Arc::new(
        crate::sidecar::mcp::McpRegistry::empty().with_agent_store(state.agent_store.clone()),
    );
    let agent_id = agent.id;

    let (_, denied) = call(
        &state,
        &agent_id,
        "spaces.list_documents",
        json!({ "space_id": "owner-space" }),
        true,
    )
    .await;
    assert!(
        denied.to_string().contains("not in this agent's allowlist"),
        "a denied tool is refused for an unverified caller: {denied}"
    );

    // The profile lets the safe tool through. The agent-effect gate is a
    // separate, earlier rule that refuses tools with no declared effect
    // for configured agents, so only the allowlist refusal is ruled out.
    let (_, allowed) = call(
        &state,
        &agent_id,
        "notify.desktop",
        json!({ "title": "Message from a caller" }),
        true,
    )
    .await;
    assert!(
        !allowed
            .to_string()
            .contains("not in this agent's allowlist"),
        "the caller profile keeps the safe tool: {allowed}"
    );

    let (_, owner) = call(
        &state,
        &agent_id,
        "spaces.list_documents",
        json!({ "space_id": "owner-space" }),
        false,
    )
    .await;
    assert!(
        !owner.to_string().contains("allowlist"),
        "an owner call is not narrowed by the caller profile: {owner}"
    );
}
