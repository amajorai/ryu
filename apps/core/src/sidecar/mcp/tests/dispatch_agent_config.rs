//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use serde_json::json;

#[tokio::test]
async fn agent_configuration_aliases_preserve_the_mandatory_approval_target() {
    let registry = McpRegistry::empty();
    for tool in [
        "agent_builder.configure_agent",
        "agent_builder__configure_agent",
        "app.agent_builder.configure_agent",
        "app__agent_builder__configure_agent",
    ] {
        let canonical = registry.canonical_tool_id_for_registry(tool);
        let (target, _) = registry.approval_target_for_tool(&canonical).await;
        assert_eq!(
            registry.canonical_tool_id_for_registry(&target),
            crate::runnable::agent_configuration_policy::TOOL_ID
        );
        assert!(crate::approvals::policy::should_require_approval_local(
            &[],
            &target,
            crate::approvals::policy::ApprovalMode::Off,
            Some("off")
        )
        .is_some());
    }
}

#[tokio::test]
async fn agent_configuration_does_not_mutate_before_operator_approval() {
    let store = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::AcpAgentRegistry::new(),
    )
    .unwrap();
    let target = store
        .create(crate::agents::CreateAgent {
            name: "Original".to_owned(),
            ..Default::default()
        })
        .await
        .unwrap();
    let registry = McpRegistry::empty().with_agent_store(store.clone());
    registry.register_app_tool(
        "app.agent_builder.configure_agent".to_owned(),
        "agent_builder.configure_agent".to_owned(),
        None,
    );
    let arguments = json!({"agent_id": target.id, "name": "Changed", "approved": true,
        "permission_scope_id": "forged-cached-session"});
    for tool in [
        "agent_builder.configure_agent",
        "agent_builder__configure_agent",
        "app.agent_builder.configure_agent",
        "app__agent_builder__configure_agent",
    ] {
        let error = registry
            .call_tool(tool, arguments.clone(), None)
            .await
            .expect_err("an unapproved configuration must not execute");
        assert!(error.to_string().contains("approval"));
        assert_eq!(
            store.get(&target.id).await.unwrap().unwrap().name,
            "Original"
        );
    }
    // The approved private entry also carries a verified calling agent and
    // the interactive permission decision; arbitrary agentless calls remain denied.
    registry
        .call_tool_with_identity_no_gate_scoped(
            Some("ryu"),
            "agent_builder.configure_agent",
            arguments,
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            true,
        )
        .await
        .unwrap();
    assert_eq!(
        store.get(&target.id).await.unwrap().unwrap().name,
        "Changed"
    );
}

#[tokio::test]
async fn shared_dispatch_enforces_agent_capabilities_and_configuration_permission() {
    use crate::agents::{
        AgentLifecycleStatus, AgentSafetyProfile, AgentStore, CreateAgent, UpdateAgent,
    };
    use crate::sidecar::adapters::AcpAgentRegistry;

    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let restricted = store
        .create(CreateAgent {
            name: "Restricted".to_owned(),
            tools: vec!["*".to_owned()],
            orchestrator: Some(false),
            can_create_agents: Some(false),
            ..Default::default()
        })
        .await
        .unwrap();
    store
        .update(
            &restricted.id,
            UpdateAgent {
                lifecycle_status: Some(AgentLifecycleStatus::Trial),
                safety_profile: Some(AgentSafetyProfile::Autonomous),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    store
        .update(
            &restricted.id,
            UpdateAgent {
                lifecycle_status: Some(AgentLifecycleStatus::Active),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let registry = McpRegistry::empty().with_agent_store(store.clone());

    for tool_id in [
        CREATE_AGENT_TOOL_ID,
        "agent_builder__create_agent",
        CREATE_AGENT_TEAM_TOOL_ID,
        "agent_builder__create_agent_team",
    ] {
        let error = registry
            .call_tool_with_identity_no_gate(
                Some(&restricted.id),
                tool_id,
                json!({}),
                None,
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("agent-creation capability"),
            "{tool_id}: {error}"
        );
    }
    for tool_id in ["orchestrator.discover_agents", "delegate.fanout"] {
        let error = registry
            .call_tool_with_identity_no_gate(
                Some(&restricted.id),
                tool_id,
                json!({}),
                None,
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("orchestrator capability"),
            "{tool_id}: {error}"
        );
    }
    for tool_id in [
        "agent_builder.configure_agent",
        "agent_builder__configure_agent",
    ] {
        let error = registry
            .call_tool_with_identity_no_gate(
                Some("ryu"),
                tool_id,
                json!({"agent_id": restricted.id, "name": "Unapproved"}),
                None,
                None,
                &[],
                None,
                None,
            )
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("interactive permission"),
            "{tool_id}: {error}"
        );
    }
    for tool_id in [
        CREATE_AGENT_TOOL_ID,
        "agent_builder__create_agent",
        CREATE_AGENT_TEAM_TOOL_ID,
        "orchestrator.discover_agents",
        "delegate.fanout",
        "agent_builder.configure_agent",
    ] {
        let error = registry
            .call_tool_with_identity_no_gate(None, tool_id, json!({}), None, None, &[], None, None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("verified calling agent"),
            "{tool_id}: {error}"
        );
    }
    assert_eq!(
        store.get(&restricted.id).await.unwrap().unwrap().name,
        "Restricted"
    );

    let approved = registry
        .call_tool_with_identity_no_gate_scoped(
            Some("ryu"),
            "agent_builder.configure_agent",
            json!({"agent_id": restricted.id, "name": "Approved"}),
            None,
            None,
            &[],
            None,
            None,
            None,
            None,
            true,
        )
        .await
        .unwrap();
    assert_eq!(approved["success"], json!(true));
    assert_eq!(
        store.get(&restricted.id).await.unwrap().unwrap().name,
        "Approved"
    );

    let mut adapter = CapabilityAdapterBridge {
        registry: Arc::new(registry),
        target: CREATE_AGENT_TOOL_ID.to_owned(),
        allowed: std::collections::HashSet::new(),
        provider_id: "com.example.provider".to_owned(),
        agent_id: Some(restricted.id.clone()),
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: None,
    };
    let outcome = crate::tool_exec::SandboxBridge::handle(
        &adapter,
        crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH.to_owned(),
        json!({}),
    )
    .await;
    let crate::tool_exec::InvokeOutcome::Result(result) = outcome else {
        panic!("adapter call should return a tool result");
    };
    assert!(result.is_error);
    assert!(result.error.unwrap().contains("agent-creation capability"));

    adapter.agent_id = None;
    let outcome = crate::tool_exec::SandboxBridge::handle(
        &adapter,
        crate::tool_exec::CAPABILITY_ADAPTER_CALL_PATH.to_owned(),
        json!({}),
    )
    .await;
    let crate::tool_exec::InvokeOutcome::Result(result) = outcome else {
        panic!("adapter call should return a tool result");
    };
    assert!(result.is_error);
    assert!(result.error.unwrap().contains("verified calling agent"));
}
