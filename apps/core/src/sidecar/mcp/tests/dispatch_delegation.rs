//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use serde_json::json;

#[tokio::test]
async fn restricted_agent_cannot_escape_through_routines_handoff_or_builders() {
    use crate::agents::{
        AgentIdentityMode, AgentLifecycleStatus, AgentSafetyProfile, AgentStore, CreateAgent,
        UpdateAgent,
    };
    use crate::server::conversations::{ConversationStore, Tenancy};
    use crate::sidecar::adapters::AcpAgentRegistry;

    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let individual = store
        .create(CreateAgent {
            name: "Own identity".to_owned(),
            tools: vec!["*".to_owned()],
            identity_mode: AgentIdentityMode::Individual,
            ..Default::default()
        })
        .await
        .unwrap();
    let legacy = store
        .create(CreateAgent {
            name: "Legacy".to_owned(),
            tools: vec!["*".to_owned()],
            ..Default::default()
        })
        .await
        .unwrap();
    for agent in [&individual.id, &legacy.id] {
        store
            .update(
                agent,
                UpdateAgent {
                    lifecycle_status: Some(AgentLifecycleStatus::Active),
                    safety_profile: Some(AgentSafetyProfile::Autonomous),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
    }
    let conversations = ConversationStore::open_in_memory().unwrap();
    conversations
        .ensure_conversation("handoff", Some(&individual.id), None, Tenancy::Unattributed)
        .await
        .unwrap();
    let registry = McpRegistry::empty()
        .with_agent_store(store)
        .with_conversations(conversations);
    let call = |agent: String, tool: &'static str, arguments: Value, host: Option<&'static str>| {
        let registry = &registry;
        async move {
            registry
                .call_tool_with_identity_no_gate_scoped(
                    Some(&agent),
                    tool,
                    arguments,
                    None,
                    None,
                    &[],
                    None,
                    host,
                    None,
                    None,
                    false,
                )
                .await
        }
    };
    const HANDOFF_REFUSAL: &str = "cannot hand work";
    const BUILDER_REFUSAL: &str = "cannot create or change";

    // Routines run under their target agent's record: a limited agent may
    // schedule itself, never the default agent or an unrestricted one.
    let jobs = tempfile::tempdir().unwrap();
    crate::scheduler::store::with_test_jobs_directory(jobs.path().to_path_buf(), async {
        let routine = |agent_id: Option<&str>| {
            let mut arguments = json!({
                "name": "Nightly",
                "prompt": "summarise",
                "schedule": { "kind": "every", "interval": "3h" },
                "new_chat": true,
            });
            if let Some(agent_id) = agent_id {
                arguments["agent_id"] = json!(agent_id);
            }
            arguments
        };
        for target in [crate::registry::DEFAULT_AGENT_ID, legacy.id.as_str()] {
            let error = call(
                individual.id.clone(),
                "routines.create",
                routine(Some(target)),
                None,
            )
            .await
            .unwrap_err();
            assert!(
                error.to_string().contains(HANDOFF_REFUSAL),
                "{target}: {error}"
            );
        }
        assert!(crate::scheduler::store::list_jobs().is_empty());
        let created = call(
            individual.id.clone(),
            "routines.create",
            routine(None),
            None,
        )
        .await
        .unwrap();
        assert_eq!(created["ok"], true, "{created}");

        // A routine for a wider agent that already exists (made by the
        // user) can't be changed, run or deleted by the limited agent.
        let wider = call(legacy.id.clone(), "routines.create", routine(None), None)
            .await
            .unwrap();
        let job_id = wider["routine"]["id"].as_str().unwrap().to_owned();
        for (tool, arguments) in [
            (
                "routines.update",
                json!({ "job_id": job_id, "name": "Changed" }),
            ),
            ("routines.run_now", json!({ "job_id": job_id })),
            ("routines.delete", json!({ "job_id": job_id })),
        ] {
            let error = call(individual.id.clone(), tool, arguments, None)
                .await
                .unwrap_err();
            assert!(
                error.to_string().contains(HANDOFF_REFUSAL),
                "{tool}: {error}"
            );
        }
        let listed = call(individual.id.clone(), "routines.list", json!({}), None)
            .await
            .unwrap();
        assert_eq!(listed["routines"].as_array().unwrap().len(), 2);
    })
    .await;

    // A limited agent may not run a thread bound to a wider agent, however
    // the id is spelled, nor create one bound to it; an unknown thread is
    // refused rather than waved through to the dispatcher.
    let conversations = registry.conversations.as_ref().unwrap();
    conversations
        .ensure_conversation("wide-thread", Some(&legacy.id), None, Tenancy::Unattributed)
        .await
        .unwrap();
    for thread_id in ["wide-thread", "  wide-thread  "] {
        let error = call(
            individual.id.clone(),
            "threads.send_message_to_thread",
            json!({ "thread_id": thread_id, "message": "hi" }),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains(HANDOFF_REFUSAL),
            "{thread_id:?}: {error}"
        );
    }
    let error = call(
        individual.id.clone(),
        "threads.send_message_to_thread",
        json!({ "thread_id": "missing-thread", "message": "hi" }),
        None,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("thread not found"), "{error}");
    let error = call(
        individual.id.clone(),
        "threads.create_thread",
        json!({ "agent_id": legacy.id }),
        None,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains(HANDOFF_REFUSAL), "{error}");

    // Handing the conversation to an unrestricted agent is refused; the
    // limited agent may still change its own next turn.
    let error = call(
        individual.id.clone(),
        crate::agent_control::SET_ACTIVE_TARGET_TOOL_ID,
        json!({ "agent_id": legacy.id }),
        Some("handoff"),
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains(HANDOFF_REFUSAL), "{error}");
    if let Err(error) = call(
        individual.id.clone(),
        crate::agent_control::SET_ACTIVE_TARGET_TOOL_ID,
        json!({ "effort": "high" }),
        Some("handoff"),
    )
    .await
    {
        assert!(!error.to_string().contains(HANDOFF_REFUSAL), "{error}");
    }

    // Workflows and dashboards run with the user's accounts: a limited
    // agent can't create or change them. An unrestricted agent passes the
    // gate (its empty arguments then fail validation, writing nothing).
    for tool in [
        "workflow_builder.create_workflow",
        "workflow_builder.configure_workflow",
        "dashboard_builder.create_dashboard",
        "dashboard_builder.configure_dashboard",
    ] {
        let error = call(individual.id.clone(), tool, json!({}), None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains(BUILDER_REFUSAL),
            "{tool}: {error}"
        );
        if let Err(error) = call(legacy.id.clone(), tool, json!({}), None).await {
            assert!(
                !error.to_string().contains(BUILDER_REFUSAL),
                "{tool}: {error}"
            );
        }
    }
    if let Err(error) = call(
        individual.id.clone(),
        "workflow_builder.get_workflow",
        json!({}),
        None,
    )
    .await
    {
        assert!(!error.to_string().contains(BUILDER_REFUSAL), "{error}");
    }
}

#[tokio::test]
async fn a_restricted_agent_cannot_hand_work_to_an_agent_with_more_vault_profiles() {
    use crate::agents::{
        AgentLifecycleStatus, AgentSafetyProfile, AgentStore, CreateAgent, UpdateAgent,
    };
    use crate::sidecar::adapters::AcpAgentRegistry;

    let store = AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
    let limited = |name: &str, profiles: Vec<String>| CreateAgent {
        name: name.to_owned(),
        tools: vec!["*".to_owned()],
        account_access: Some(vec!["composio:ca_allowed".to_owned()]),
        identity_profile_ids: profiles,
        ..Default::default()
    };
    let caller = store.create(limited("Caller", Vec::new())).await.unwrap();
    let same = store.create(limited("Same", Vec::new())).await.unwrap();
    let with_profile = store
        .create(limited("With profile", vec!["profile-1".to_owned()]))
        .await
        .unwrap();
    store
        .update(
            &caller.id,
            UpdateAgent {
                lifecycle_status: Some(AgentLifecycleStatus::Active),
                safety_profile: Some(AgentSafetyProfile::Autonomous),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let registry = McpRegistry::empty().with_agent_store(store);
    let set_target = |target: String| {
        let registry = &registry;
        let caller = caller.id.clone();
        async move {
            registry
                .call_tool_with_identity_no_gate_scoped(
                    Some(&caller),
                    crate::agent_control::SET_ACTIVE_TARGET_TOOL_ID,
                    json!({ "agent_id": target }),
                    None,
                    None,
                    &[],
                    None,
                    None,
                    None,
                    None,
                    false,
                )
                .await
        }
    };
    // Same account allowlist, but the target also signs in with one of the
    // user's Identity Vault profiles the caller was never given.
    let error = set_target(with_profile.id.clone()).await.unwrap_err();
    assert!(error.to_string().contains("cannot hand work"), "{error}");
    // An agent with exactly the caller's reach passes the policy check (the
    // call may still fail later for want of a conversation).
    if let Err(error) = set_target(same.id.clone()).await {
        assert!(!error.to_string().contains("cannot hand work"), "{error}");
    }
}
