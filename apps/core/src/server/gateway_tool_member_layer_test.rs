//! The Gateway's unified chat tool loop executes through `/api/mcp/tools/call`
//! with the node credential and no user JWT. Core relays the turn's host
//! conversation (and its process-local proof) on the Gateway hop only when the
//! turn's author owns that conversation.
//!
//! What this covers, and what it does not: on an org-bound node the anonymous
//! Gateway hop is refused at `agent.run` admission before any org tool policy
//! runs, so no Gateway-reachable call is ever evaluated with only the org/team
//! layers. The member-layer assertions below drive dispatch directly
//! (`call_tool_with_identity_scoped`) to prove the layer is chosen by the
//! conversation owner the relayed proof names; the route assertions prove the
//! hop itself fails closed (missing/forged proof, then anonymous admission).
use super::*;
use crate::agents::{AgentLifecycleStatus, AgentSafetyProfile, CreateAgent, UpdateAgent};
use crate::org_policy::{seed_caller_tool_rules_for_tests, OrgToolRules};
use crate::server::conversations::Tenancy;
use crate::sidecar::control_plane::{
    with_test_node_binding, NodeScope, RegisteredNode, RegisteredOrg,
};

const ORG: &str = "org_abac20";

fn org_node() -> RegisteredNode {
    RegisteredNode {
        org: RegisteredOrg {
            id: ORG.to_owned(),
            name: "Acme".to_owned(),
            slug: None,
        },
        node_id: "node_abac20".to_owned(),
        scope: NodeScope::Org,
        team_id: None,
        owner_user_id: None,
    }
}

async fn gateway_call(
    state: &ServerState,
    agent_id: &str,
    tool: &str,
    host_conversation_id: Option<&str>,
    host_conversation_proof: Option<String>,
) -> (StatusCode, serde_json::Value) {
    let body: CallToolBody = serde_json::from_value(json!({
        "tool": tool,
        "arguments": { "title": "Gateway loop" },
        "agent_id": agent_id,
        "host_conversation_id": host_conversation_id,
        "host_conversation_proof": host_conversation_proof,
    }))
    .expect("the Gateway's tool-call body decodes");
    // A node-token request: no verified user JWT, exactly as the Gateway sends.
    let response = call_mcp_tool_inner(state.clone(), None, None, body).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(json!({})))
}

#[tokio::test]
async fn member_layer_follows_the_host_conversation_owner_and_the_gateway_hop_fails_closed() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = super::isolated_plugin_hook_test_state(directory.path());
    // An active agent allowed every tool, so only the member layer can be what
    // refuses a call below.
    let agent = state
        .agent_store
        .create(CreateAgent {
            name: "Gateway loop".to_owned(),
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
        crate::sidecar::mcp::McpRegistry::empty()
            .with_agent_store(state.agent_store.clone())
            .with_conversations(state.conversations.clone()),
    );
    for (conversation, owner) in [
        ("abac20-alice-chat", "abac20-alice"),
        ("abac20-carol-chat", "abac20-carol"),
    ] {
        state
            .conversations
            .ensure_conversation(
                conversation,
                None,
                None,
                Tenancy::Owned {
                    user_id: owner.to_owned(),
                    org_id: Some(ORG.to_owned()),
                },
            )
            .await
            .unwrap();
    }
    // Alice's own user layer denies the tool; Carol's allows everything.
    seed_caller_tool_rules_for_tests(
        ORG,
        None,
        "abac20-alice",
        OrgToolRules {
            denied_tools: vec!["notify.desktop".to_owned()],
            ..Default::default()
        },
    );
    seed_caller_tool_rules_for_tests(ORG, None, "abac20-carol", OrgToolRules::default());

    with_test_node_binding(false, Some(org_node()), async {
        let denial = "denied by your organization's tool policy";

        // The host conversation Core relays selects whose member layer the
        // dispatch applies: Alice's own deniedTools entry refuses the tool...
        let dispatch = |conversation: Option<&'static str>| {
            let registry = state.mcp.clone();
            let agent_id = agent.id.clone();
            async move {
                registry
                    .call_tool_with_identity_scoped(
                        Some(&agent_id),
                        "notify.desktop",
                        json!({ "title": "Gateway loop" }),
                        None,
                        None,
                        &[],
                        None,
                        conversation,
                        None,
                        None,
                    )
                    .await
                    .map_err(|error| error.to_string())
            }
        };
        let refused = dispatch(Some("abac20-alice-chat")).await;
        assert!(
            refused.as_ref().is_err_and(|error| error.contains(denial)),
            "the owner's member layer refuses the tool: {refused:?}"
        );
        // ...while Carol's layer allows it, so the org policy is not what answers.
        let allowed = dispatch(Some("abac20-carol-chat")).await;
        assert!(
            !allowed.as_ref().is_err_and(|error| error.contains(denial)),
            "a member whose layer allows the tool is not refused by it: {allowed:?}"
        );

        // On the route, a node-token caller cannot select a member's
        // conversation without Core's proof, nor reuse a proof minted for
        // another conversation.
        for proof in [None, Some(host_conversation_proof("abac20-carol-chat"))] {
            let (status, body) = gateway_call(
                &state,
                &agent.id,
                "notify.desktop",
                Some("abac20-alice-chat"),
                proof,
            )
            .await;
            assert_eq!(status, StatusCode::FORBIDDEN);
            assert!(
                body.to_string().contains("trusted forwarder"),
                "refused before any dispatch: {body}"
            );
        }
        // With a valid proof but no verified user, the bound node still
        // refuses to run the agent at all: the anonymous Gateway hop never
        // reaches dispatch as the conversation owner by itself.
        let (status, body) = gateway_call(
            &state,
            &agent.id,
            "notify.desktop",
            Some("abac20-alice-chat"),
            Some(host_conversation_proof("abac20-alice-chat")),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert!(
            body.to_string().contains("insufficient permissions"),
            "refused at agent.run admission, before org tool policy: {body}"
        );
    })
    .await;
}
