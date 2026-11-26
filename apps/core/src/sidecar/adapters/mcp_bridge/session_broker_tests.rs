//! In-process broker tools: offered only under the run's own broker session,
//! gated by the agent's allowlist, and filed as that session.

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::broker::{proposals, sessions};

pub(super) fn vault() -> &'static PluginSecretStore {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    crate::plugin_secrets::global().unwrap()
}

pub(super) fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

/// A broker session like the one an ACP run's lease mints: `(token, id)`.
pub(super) async fn mint() -> (String, String) {
    let conn = vault().conn.lock().await;
    let (token, session) = sessions::mint(
        &conn,
        sessions::MintRequest {
            environment: "default".into(),
            services: vec![unique("svc-")],
            label: String::new(),
            ttl_secs: None,
            minted_by: unique("runtime:claude-code:"),
            not_after: None,
            minted_token: None,
            minter_scope: None,
        },
    )
    .unwrap();
    (token, session.id)
}

async fn bridge(allowlist: Option<Vec<String>>, token: Option<&str>) -> Option<BrokeredHandler> {
    bridge_for(Arc::new(McpRegistry::empty()), "ryu", allowlist, token).await
}

/// The handler a run's bridge serves: wrapped only when the run is brokered.
async fn bridge_for(
    mcp: Arc<McpRegistry>,
    agent_id: &str,
    allowlist: Option<Vec<String>>,
    token: Option<&str>,
) -> Option<BrokeredHandler> {
    let server = build_ryu_mcp_server(
        mcp,
        allowlist,
        Vec::new(),
        agent_id.to_owned(),
        Vec::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap()
    .with_broker_session(token);
    let credentials = server.broker_credentials.clone()?;
    Some(BrokeredHandler::new(server.new_handler(), credentials))
}

async fn broker_tool_names(handler: &BrokeredHandler) -> Vec<String> {
    handler
        .tool_list()
        .await
        .iter()
        .map(|tool| tool.name.to_string())
        .filter(|name| name.starts_with("ryu_broker_"))
        .collect()
}

pub(super) fn text(result: &CallToolResult) -> String {
    serde_json::to_value(result).unwrap()["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned()
}

pub(super) fn failed(result: &CallToolResult) -> bool {
    result.is_error == Some(true)
}

#[tokio::test]
async fn a_run_without_a_broker_session_is_offered_none() {
    vault();
    // No lease: the bridge serves Ryu's own handler, which has no broker tools.
    assert!(bridge(None, None).await.is_none());
    let server = build_ryu_mcp_server(
        Arc::new(McpRegistry::empty()),
        None,
        Vec::new(),
        "ryu".to_owned(),
        Vec::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .unwrap();
    let names: Vec<String> = server
        .new_handler()
        .build_tool_list()
        .await
        .iter()
        .map(|tool| tool.name.to_string())
        .collect();
    assert!(
        names.iter().all(|name| !name.starts_with("ryu_broker_")),
        "{names:?}"
    );
    assert!(names.iter().any(|name| name == "tool_search"));
}

#[tokio::test]
async fn only_an_rvb_session_token_becomes_a_credential() {
    vault();
    for token in ["", "rvt_vault_token", "Bearer rvb_x", "node-bearer"] {
        assert!(bridge(None, Some(token)).await.is_none(), "{token}");
    }
    let credentials = session_credentials("rvb_abc").unwrap();
    let value = credentials.get(hosted_mcp::BROKER_SESSION_HEADER).unwrap();
    assert!(value.is_sensitive());
    let route = hosted_mcp::agent_headers(&credentials).unwrap();
    assert!(route
        .get(axum::http::header::AUTHORIZATION)
        .unwrap()
        .is_sensitive());
}

#[tokio::test]
async fn the_run_files_and_polls_proposals_as_its_own_session() {
    let (token, session_id) = mint().await;
    let handler = bridge(None, Some(&token)).await.unwrap();
    assert_eq!(
        broker_tool_names(&handler).await,
        [
            hosted_mcp::DISCOVER,
            hosted_mcp::PROPOSE,
            hosted_mcp::PROPOSAL
        ]
    );

    let discovered = handler
        .broker_call(hosted_mcp::DISCOVER, Value::Null, None)
        .await
        .unwrap();
    assert!(!failed(&discovered), "{}", text(&discovered));
    assert!(!text(&discovered).contains(&token));

    let reference = format!("secret:{}", unique("INPROC_"));
    let filed = handler
        .broker_call(
            hosted_mcp::PROPOSE,
            json!({ "message": "need the Linear token", "credentials": [{ "ref": reference }] }),
            None,
        )
        .await
        .unwrap();
    assert!(!failed(&filed), "{}", text(&filed));
    let filed: Value = serde_json::from_str(&text(&filed)).unwrap();
    let id = filed["proposal"]["id"].as_str().unwrap().to_owned();

    let stored = {
        let conn = vault().conn.lock().await;
        proposals::get(&conn, &id).unwrap().unwrap()
    };
    assert_eq!(stored.requested_by, format!("broker_session:{session_id}"));

    let polled = handler
        .broker_call(hosted_mcp::PROPOSAL, json!({ "id": id }), None)
        .await
        .unwrap();
    assert!(!failed(&polled), "{}", text(&polled));

    // Another run's session cannot read this run's proposal.
    let (other, _) = mint().await;
    let stranger = bridge(None, Some(&other)).await.unwrap();
    let refused = stranger
        .broker_call(hosted_mcp::PROPOSAL, json!({ "id": id }), None)
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(text(&refused).contains("HTTP 404"), "{}", text(&refused));
}

#[tokio::test]
async fn a_revoked_session_is_refused() {
    let (token, session_id) = mint().await;
    let handler = bridge(None, Some(&token)).await.unwrap();
    {
        let conn = vault().conn.lock().await;
        assert!(sessions::revoke(&conn, &session_id).unwrap());
    }
    let result = handler
        .broker_call(hosted_mcp::DISCOVER, json!({}), None)
        .await
        .unwrap();
    assert!(failed(&result));
    assert!(text(&result).contains("HTTP 401"), "{}", text(&result));
    assert!(!text(&result).contains(&token));
}

#[tokio::test]
async fn an_explicit_allowlist_must_name_each_broker_tool() {
    let (token, _) = mint().await;
    let handler = bridge(Some(vec![hosted_mcp::DISCOVER.to_owned()]), Some(&token))
        .await
        .unwrap();
    assert_eq!(broker_tool_names(&handler).await, [hosted_mcp::DISCOVER]);
    let refused = handler
        .broker_call(hosted_mcp::PROPOSE, json!({ "message": "x" }), None)
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(text(&refused).contains("not allowed"), "{}", text(&refused));

    let none = bridge(Some(Vec::new()), Some(&token)).await.unwrap();
    assert!(broker_tool_names(&none).await.is_empty());
}

#[tokio::test]
async fn a_wildcard_allowlist_admits_all_three() {
    let (token, _) = mint().await;
    let handler = bridge(Some(vec!["*".to_owned()]), Some(&token))
        .await
        .unwrap();
    assert_eq!(broker_tool_names(&handler).await.len(), 3);
}

#[tokio::test]
async fn after_a_device_read_a_proposal_is_refused_and_files_nothing() {
    use crate::approvals::policy::ApprovalMode;
    use crate::device_tools::{declaration::ClientDeviceDecl, identity::DevicePrincipal};
    let (token, session_id) = mint().await;
    let handler = bridge(None, Some(&token)).await.unwrap();
    let decl: ClientDeviceDecl = serde_json::from_value(json!({
        "device_id": unique("dev-"), "app": "ryu-bot", "platform": "ios", "label": "Phone",
        "foreground": true, "catalog_version": 1, "tools": [],
    }))
    .unwrap();
    let offer = crate::device_tools::offer::DeviceOffer::new(
        unique("conv-"),
        DevicePrincipal::User(unique("user-")),
        decl,
        ApprovalMode::Smart,
    );
    crate::device_tools::taint::mark_device_read(&offer, "device.location.current");

    let refused = handler
        .broker_call(
            hosted_mcp::PROPOSE,
            json!({ "message": "my location is 37.33,-122.03" }),
            Some(&offer),
        )
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(
        text(&refused).contains("device.location.current"),
        "{}",
        text(&refused)
    );
    let filed = {
        let conn = vault().conn.lock().await;
        proposals::list(&conn, None).unwrap()
    };
    let subject = format!("broker_session:{session_id}");
    assert!(filed
        .iter()
        .all(|proposal| proposal.requested_by != subject));

    // Discovery reads nothing out of the turn, so it still runs.
    let discovered = handler
        .broker_call(hosted_mcp::DISCOVER, json!({}), Some(&offer))
        .await
        .unwrap();
    assert!(!failed(&discovered), "{}", text(&discovered));
}

#[tokio::test]
async fn the_agents_safety_profile_limits_the_tools() {
    use crate::agents::{AgentLifecycleStatus, AgentSafetyProfile, CreateAgent, UpdateAgent};
    let (token, _) = mint().await;
    let agents = crate::agents::AgentStore::open_in_memory(
        &crate::sidecar::adapters::AcpAgentRegistry::new(),
    )
    .unwrap();
    let mut ids = Vec::new();
    for profile in [
        AgentSafetyProfile::VerifiedPlanOnly,
        AgentSafetyProfile::ReadOnly,
    ] {
        let record = agents
            .create(CreateAgent {
                name: unique("Broker "),
                ..CreateAgent::default()
            })
            .await
            .unwrap();
        agents
            .update(
                &record.id,
                UpdateAgent {
                    lifecycle_status: Some(AgentLifecycleStatus::Active),
                    safety_profile: Some(profile),
                    ..UpdateAgent::default()
                },
            )
            .await
            .unwrap()
            .unwrap();
        ids.push(record.id);
    }
    let mcp = Arc::new(McpRegistry::empty().with_agent_store(agents));

    let plan_only = bridge_for(Arc::clone(&mcp), &ids[0], None, Some(&token))
        .await
        .unwrap();
    assert!(broker_tool_names(&plan_only).await.is_empty());
    let refused = plan_only
        .broker_call(hosted_mcp::DISCOVER, json!({}), None)
        .await
        .unwrap();
    assert!(text(&refused).contains("not allowed"), "{}", text(&refused));

    let read_only = bridge_for(Arc::clone(&mcp), &ids[1], None, Some(&token))
        .await
        .unwrap();
    assert_eq!(
        broker_tool_names(&read_only).await,
        [hosted_mcp::DISCOVER, hosted_mcp::PROPOSAL]
    );
    let refused = read_only
        .broker_call(hosted_mcp::PROPOSE, json!({ "message": "x" }), None)
        .await
        .unwrap();
    assert!(text(&refused).contains("not allowed"), "{}", text(&refused));

    // An agent id the store does not know is offered nothing.
    let unknown = bridge_for(mcp, "no-such-agent", None, Some(&token))
        .await
        .unwrap();
    assert!(broker_tool_names(&unknown).await.is_empty());
}

async fn bridge_in(conversation: &str, token: &str) -> BrokeredHandler {
    let server = build_ryu_mcp_server(
        Arc::new(McpRegistry::empty()),
        None,
        Vec::new(),
        "ryu".to_owned(),
        Vec::new(),
        None,
        None,
        None,
        Some(conversation.to_owned()),
    )
    .await
    .unwrap()
    .with_broker_session(Some(token));
    let credentials = server.broker_credentials.clone().unwrap();
    BrokeredHandler::new(server.new_handler(), credentials)
}

#[tokio::test]
async fn each_run_has_its_own_rate_quota_bucket() {
    let (token, _) = mint().await;
    let (other, _) = mint().await;
    let handler = bridge(None, Some(&token)).await.unwrap();
    let stranger = bridge(None, Some(&other)).await.unwrap();
    let filed = handler
        .broker_call(
            hosted_mcp::PROPOSE,
            json!({ "message": "need a token", "credentials": [{ "ref": "secret:INPROC_QUOTA" }] }),
            None,
        )
        .await
        .unwrap();
    let filed: Value = serde_json::from_str(&text(&filed)).unwrap();
    let id = filed["proposal"]["id"].as_str().unwrap().to_owned();
    vault()
        .quota_put(
            &unique("inproc-poll-"),
            crate::vault::quotas::QuotaRule::RateLimit {
                path: format!("/api/vault/agent/broker/proposals/{id}"),
                rate: 1,
                interval_secs: 60,
                block_interval_secs: None,
            },
            &crate::vault::audit::AuditActor::system(),
        )
        .await
        .unwrap();
    async fn poll(handler: &BrokeredHandler, id: &str) -> CallToolResult {
        handler
            .broker_call(hosted_mcp::PROPOSAL, json!({ "id": id }), None)
            .await
            .unwrap()
    }
    assert!(!failed(&poll(&handler, &id).await));
    let limited = poll(&handler, &id).await;
    assert!(text(&limited).contains("HTTP 429"), "{}", text(&limited));
    assert!(!text(&limited).contains(&token));
    // Another run is not in this run's bucket: it reaches the route (which
    // refuses another session's proposal) instead of the quota.
    let other_run = poll(&stranger, &id).await;
    assert!(
        text(&other_run).contains("HTTP 404"),
        "{}",
        text(&other_run)
    );
}

#[tokio::test]
async fn describe_answers_for_offered_broker_tools_only() {
    let (token, _) = mint().await;
    let handler = bridge(None, Some(&token)).await.unwrap();
    let described = handler
        .describe(&json!({ "id": hosted_mcp::PROPOSE }))
        .await
        .expect("an offered broker tool is described");
    assert!(described.contains("credentials"), "{described}");
    assert!(handler
        .describe(&json!({ "id": "tool_search" }))
        .await
        .is_none());
    let narrow = bridge(Some(vec![hosted_mcp::DISCOVER.to_owned()]), Some(&token))
        .await
        .unwrap();
    assert!(narrow
        .describe(&json!({ "id": hosted_mcp::PROPOSE }))
        .await
        .is_none());
}

#[tokio::test]
async fn a_device_read_in_another_instance_of_the_conversation_blocks_a_proposal() {
    use crate::approvals::policy::ApprovalMode;
    use crate::device_tools::{declaration::ClientDeviceDecl, identity::DevicePrincipal};
    let (token, _) = mint().await;
    let conversation = unique("conv-");
    let handler = bridge_in(&conversation, &token).await;
    assert!(handler.device_offer().is_none());

    let decl: ClientDeviceDecl = serde_json::from_value(json!({
        "device_id": unique("dev-"), "app": "ryu-bot", "platform": "ios", "label": "Phone",
        "foreground": true, "catalog_version": 1, "tools": [],
    }))
    .unwrap();
    let offer = Arc::new(crate::device_tools::offer::DeviceOffer::new(
        conversation.clone(),
        DevicePrincipal::User(unique("user-")),
        decl,
        ApprovalMode::Smart,
    ));
    // Another instance (a delegated run on its own channel) serves the turn.
    let (other_instance, _events) = tokio::sync::mpsc::unbounded_channel();
    let _turn = crate::device_tools::turn_context::register_turn_context(
        Arc::clone(&offer),
        &other_instance,
        "delegate",
    );
    crate::device_tools::taint::mark_device_read(&offer, "device.contacts.search");

    let seen = handler
        .device_offer()
        .expect("the conversation's live turn");
    let refused = handler
        .broker_call(hosted_mcp::PROPOSE, json!({ "message": "x" }), Some(&seen))
        .await
        .unwrap();
    assert!(failed(&refused));
    assert!(
        text(&refused).contains("device.contacts.search"),
        "{}",
        text(&refused)
    );
}
