//! Tests moved out of `sidecar/mcp/mod.rs`.

use super::*;
use crate::sidecar::mcp::tests::derived_route;
use serde_json::json;

#[tokio::test]
async fn restricted_agent_cannot_delegate_or_write_through_the_self_api() {
    use crate::agents::{
        AgentIdentityMode, AgentLifecycleStatus, AgentSafetyProfile, AgentStore, CreateAgent,
        UpdateAgent,
    };
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
    let allowlisted = store
        .create(CreateAgent {
            name: "Allowlisted".to_owned(),
            tools: vec!["*".to_owned()],
            account_access: Some(vec!["composio:ca_allowed".to_owned()]),
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
    // Make the callers runnable so only the account policy can refuse them.
    for agent in [&individual.id, &allowlisted.id] {
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
    let registry = McpRegistry::empty().with_agent_store(store);
    let call = |agent: String, tool: &'static str, arguments: Value| {
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
                    None,
                    None,
                    None,
                    false,
                )
                .await
        }
    };
    for caller in [&individual.id, &allowlisted.id] {
        // The default agent and an explicit unrestricted one are both wider
        // than the caller: a routine for either, switching the chat to
        // either, or a fan-out to either is refused before anything is
        // saved, switched or started.
        for target in [crate::registry::DEFAULT_AGENT_ID, legacy.id.as_str()] {
            let error = call(
                caller.clone(),
                "routines.create",
                json!({
                    "agent_id": target,
                    "name": "nightly",
                    "prompt": "do it",
                    "schedule": { "kind": "cron", "expr": "0 * * * *" },
                }),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("cannot hand work"), "{error}");
            let error = call(
                caller.clone(),
                crate::agent_control::SET_ACTIVE_TARGET_TOOL_ID,
                json!({ "agent_id": target }),
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains("cannot hand work"), "{error}");
        }
        for tasks in [
            json!([{ "task": "do it" }]),
            json!([{ "task": "do it", "agent_id": legacy.id }]),
        ] {
            // Refused either as a handoff to a wider agent or, for a caller
            // whose model providers are limited, because fan-out runs on all
            // of the user's providers.
            let error = call(caller.clone(), "delegate.fanout", json!({ "tasks": tasks }))
                .await
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("cannot hand work") || error.contains("account access"),
                "{error}"
            );
        }
        let error = call(
            caller.clone(),
            "ryu_api.put_api_agents_id",
            json!({ "id": caller, "body": { "identity_mode": "managed" } }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("account access"), "{error}");
    }

    // Writes follow the reviewed category list: a restricted agent can still
    // edit workspace content but not reach credentials or connections. A
    // passing call fails later at the loopback (no Core is listening), never
    // at the account-access gate.
    const REFUSAL: &str = "account access does not allow";
    let workspace_write = || {
        (
            "ryu_api.post_api_notifications_id_ack",
            json!({ "id": "n-missing" }),
        )
    };
    let credential_writes = [
        (
            "ryu_api.put_api_plugins_id_secrets_key",
            json!({ "id": "@ryu/notion", "key": "token", "body": { "value": "x" } }),
        ),
        (
            "ryu_api.post_api_composio_connections_initiate",
            json!({ "body": { "toolkit": "gmail" } }),
        ),
        (
            "ryu_api.post_api_conversations_id_participants",
            json!({ "id": "c1", "body": { "agent_id": legacy.id } }),
        ),
    ];
    for caller in [&individual.id, &allowlisted.id] {
        let (tool, arguments) = workspace_write();
        if let Err(error) = call(caller.clone(), tool, arguments).await {
            assert!(!error.to_string().contains(REFUSAL), "{tool}: {error}");
        }
        for (tool, arguments) in credential_writes.clone() {
            let error = call(caller.clone(), tool, arguments).await.unwrap_err();
            assert!(error.to_string().contains(REFUSAL), "{tool}: {error}");
        }
    }
    // An unrestricted agent is not held to the category list.
    let (tool, arguments) = workspace_write();
    if let Err(error) = call(legacy.id.clone(), tool, arguments).await {
        assert!(!error.to_string().contains(REFUSAL), "{tool}: {error}");
    }
    // Account connection and credential writes are not in the catalog at
    // all, so even an agent that acts as the user cannot make them: the
    // loopback dispatch knows no such tool.
    for (tool, arguments) in credential_writes.into_iter().take(2) {
        let error = crate::self_api::dispatch(&reqwest::Client::new(), tool, arguments, None)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("unknown core-api tool"),
            "{tool}: {error}"
        );
    }
}

/// A `ryu_ext.`-prefixed id that no live lowering registered must be refused,
/// never forwarded. The registered set is this plane's allowlist-of-record: it is
/// also what pins the URL and the method, so an unmatched id has no destination
/// at all and a fallthrough would mean a caller-invented id choosing one.
#[tokio::test]
async fn derived_tool_dispatch_rejects_unknown_id() {
    let reg = McpRegistry::empty();
    let err = reg
        .call_tool("ryu_ext.ryu_crm.get_records", serde_json::json!({}), None)
        .await
        .expect_err("an unregistered derived id must be rejected");
    assert!(
        err.to_string().contains("unknown derived tool"),
        "got: {err}"
    );
}

/// A registered derived id whose owner is not a live enabled manifest is refused
/// too — fail-closed rather than dispatching with an empty grant set. An empty set
/// is NOT "no grants" here: `ext_api::call_plan` unions the loopback egress grant
/// in, so an empty set would still let the call through with no owner behind it.
#[tokio::test]
async fn derived_tool_dispatch_refuses_when_the_owner_is_not_enabled() {
    let reg = McpRegistry::empty();
    reg.set_ext_api_routes(
        "@ryu/crm",
        vec![derived_route("ryu_ext.ryu_crm.get_records", "@ryu/crm")],
    );
    let err = reg
        .call_tool("ryu_ext.ryu_crm.get_records", serde_json::json!({}), None)
        .await
        .expect_err("no wired app store means no enabled owner");
    assert!(
        err.to_string().contains("no enabled owning plugin"),
        "got: {err}"
    );
}

/// The allowlist is enforced on the fully-qualified id, exactly as the self-API
/// arm does it, so `allow:["ryu_ext"]` authorizes this plane the way
/// `allow:["ryu_api"]` authorizes that one — and an unrelated allowlist denies
/// BEFORE the route is even resolved.
#[tokio::test]
async fn derived_tool_dispatch_enforces_the_allowlist() {
    let reg = McpRegistry::empty();
    reg.set_ext_api_routes(
        "@ryu/crm",
        vec![derived_route("ryu_ext.ryu_crm.get_records", "@ryu/crm")],
    );
    let denied = reg
        .call_tool(
            "ryu_ext.ryu_crm.get_records",
            serde_json::json!({}),
            Some(&["something_else".to_owned()]),
        )
        .await
        .expect_err("absent from the allowlist");
    assert!(
        denied.to_string().contains("not in this agent's allowlist"),
        "got: {denied}"
    );

    // Allowlisting the server segment passes the gate; the call then fails later,
    // at the owner resolution, which is what proves the gate was passed.
    let passed = reg
        .call_tool(
            "ryu_ext.ryu_crm.get_records",
            serde_json::json!({}),
            Some(&[crate::ext_api::SERVER_NAME.to_owned()]),
        )
        .await
        .expect_err("no enabled owner in this test context");
    assert!(
        passed.to_string().contains("no enabled owning plugin"),
        "allowlisting the server must let dispatch reach owner resolution: {passed}"
    );
}
