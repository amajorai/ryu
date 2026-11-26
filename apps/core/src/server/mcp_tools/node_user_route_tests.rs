//! The node-user rule and the credential tool rule on the direct tool-call route
//! (`POST /api/mcp/tools/call`), and the write gate of the setting that names
//! the allowed credential tools.
//!
//! The route body is driven as the handler drives it (`call_mcp_tool_inner`).
//! No tool can reach a backend: the agent's allowlist does not name the test
//! tools, so a call the rules let through ends at the allowlist stop of the
//! app-tool arm. The route always runs a tool for an agent, and the agent's
//! effect check, which runs after the rules, stops the command tool first: its
//! effect is unknown. The node kind and the people are bound per task.

use crate::agents::{AgentLifecycleStatus, AgentSafetyProfile, CreateAgent, UpdateAgent};
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::server::conversations::Tenancy;
use crate::server::*;
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::mcp::node_user_fixtures::{
    admin, allowlist_without_the_tool, member, person, personal_node, registry_with_class_tools,
    seed_tool_policy_for, shared_node, ALLOWLIST_STOP, BROWSER_TOOL, CAPTURES_TOOL,
    CREDENTIAL_TOOL, ORG, PLAIN_TOOL, RETURNS_CREDENTIAL_TOOL,
};
use crate::sidecar::mcp::{
    with_test_credential_tools_allowed, with_test_people, CREDENTIAL_TOOLS_ALLOWED_PREF_KEY,
    CREDENTIAL_TOOL_REFUSAL, NODE_USER_TOOL_REFUSAL,
};

const MEMBER: &str = "ce36-route-member";
const ADMIN: &str = "ce36-route-admin";
const OWNER: &str = "ce36-route-owner";

const MEMBER_CHAT: &str = "ce36-route-member-chat";
const ADMIN_CHAT: &str = "ce36-route-admin-chat";
const OWNER_CHAT: &str = "ce36-route-owner-chat";

const CLASS_TOOLS: [&str; 3] = [CREDENTIAL_TOOL, BROWSER_TOOL, CAPTURES_TOOL];

/// A server state whose registry holds the test tools, with one active agent
/// whose allowlist names none of them. The folder lives as long as the state.
struct Route {
    state: ServerState,
    agent_id: String,
    _directory: tempfile::TempDir,
}

async fn route() -> Route {
    let directory = tempfile::tempdir().expect("a folder for the state");
    let mut state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let agent = state
        .agent_store
        .create(CreateAgent {
            name: "CE-36 route".to_owned(),
            tools: allowlist_without_the_tool(),
            ..Default::default()
        })
        .await
        .expect("create the agent");
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
        state
            .agent_store
            .update(&agent.id, update)
            .await
            .expect("activate the agent");
    }
    for (conversation, owner) in [
        (MEMBER_CHAT, MEMBER),
        (ADMIN_CHAT, ADMIN),
        (OWNER_CHAT, OWNER),
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
            .expect("store the conversation");
    }
    state.mcp = std::sync::Arc::new(
        registry_with_class_tools(Some(state.conversations.clone()))
            .await
            .with_agent_store(state.agent_store.clone()),
    );
    seed_tool_policy_for(&[MEMBER, ADMIN, OWNER]);
    Route {
        state,
        agent_id: agent.id,
        _directory: directory,
    }
}

/// `POST /api/mcp/tools/call` as `caller`. Returns the answer as text.
async fn call(
    route: &Route,
    caller: Option<&VerifiedCaller>,
    tool: &str,
    conversation: Option<&str>,
) -> String {
    let mut body: CallToolBody = serde_json::from_value(json!({
        "tool": tool,
        "arguments": {},
        "agent_id": route.agent_id,
        "host_conversation_id": conversation,
    }))
    .expect("the tool-call body decodes");
    // The allowlist of the call, fixed here as well as on the agent, so no
    // test tool can run whatever the agent record resolves to.
    body.mcp_allowlist = Some(allowlist_without_the_tool());
    body.mcp_policy_snapshot = true;
    let response = call_mcp_tool_inner(route.state.clone(), caller.cloned(), None, body).await;
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("read the answer");
    String::from_utf8_lossy(&bytes).into_owned()
}

/// `PUT /api/preferences/credential-tools-allowed` as `caller`.
async fn put_allowed(route: &Route, caller: Option<VerifiedCaller>, value: &str) -> StatusCode {
    crate::server::set_preference(
        axum::extract::State(route.state.clone()),
        axum::extract::Path(CREDENTIAL_TOOLS_ALLOWED_PREF_KEY.to_owned()),
        axum::Extension(caller),
        axum::Json(crate::server::SetPreferenceBody {
            value: value.to_owned(),
        }),
    )
    .await
    .status()
}

#[track_caller]
fn assert_refused_by_the_node_user_rule(answer: &str) {
    assert!(
        answer.contains(NODE_USER_TOOL_REFUSAL),
        "the node-user rule refuses: {answer}"
    );
    assert!(!answer.contains(ALLOWLIST_STOP), "{answer}");
}

#[track_caller]
fn assert_reached_the_tool(answer: &str) {
    assert!(
        answer.contains(ALLOWLIST_STOP),
        "the call passes the rules and ends at the stop behind them: {answer}"
    );
    assert!(!answer.contains(NODE_USER_TOOL_REFUSAL), "{answer}");
    assert!(!answer.contains(CREDENTIAL_TOOL_REFUSAL), "{answer}");
}

/// The first stop behind the rules for a class tool on the route. The command
/// tool has no method, no hints and no effect word in its name, so the agent's
/// effect check refuses it before the allowlist stop; both checks run after the
/// node-user rule and the credential tool rule.
fn stop_behind_the_rules(tool: &str) -> String {
    if tool == CREDENTIAL_TOOL {
        format!("cannot run tool '{tool}' because its effect is unknown")
    } else {
        ALLOWLIST_STOP.to_owned()
    }
}

#[track_caller]
fn assert_class_tool_passed_the_rules(tool: &str, answer: &str) {
    let stop = stop_behind_the_rules(tool);
    assert!(
        answer.contains(&stop),
        "the call passes the rules and ends at the stop behind them ({stop}): {answer}"
    );
    assert!(!answer.contains(NODE_USER_TOOL_REFUSAL), "{answer}");
    assert!(!answer.contains(CREDENTIAL_TOOL_REFUSAL), "{answer}");
}

#[tokio::test]
async fn member_direct_tool_call_is_refused_each_class_on_a_shared_node() {
    let route = route().await;
    let member = member(MEMBER);
    with_test_node_binding(false, Some(shared_node()), async {
        for tool in CLASS_TOOLS {
            // With no conversation the member is the verified caller.
            let answer = call(&route, Some(&member), tool, None).await;
            assert_refused_by_the_node_user_rule(&answer);
            assert!(answer.contains("does not hold that permission"), "{answer}");
            // In a conversation the member owns, the member is its sender.
            let answer = call(&route, Some(&member), tool, Some(MEMBER_CHAT)).await;
            assert_refused_by_the_node_user_rule(&answer);
            assert!(answer.contains("does not hold that permission"), "{answer}");
        }
    })
    .await;
}

#[tokio::test]
async fn a_tool_that_returns_a_credential_is_refused_on_the_route_until_allowed() {
    let route = route().await;
    let owner = person(OWNER, OrgRole::Owner);
    with_test_node_binding(false, Some(personal_node(OWNER)), async {
        let refused = with_test_credential_tools_allowed(
            Vec::new(),
            call(&route, Some(&owner), RETURNS_CREDENTIAL_TOOL, None),
        )
        .await;
        assert!(refused.contains(CREDENTIAL_TOOL_REFUSAL), "{refused}");
        assert!(
            refused.contains(CREDENTIAL_TOOLS_ALLOWED_PREF_KEY),
            "the setting is named: {refused}"
        );
        assert!(!refused.contains(ALLOWLIST_STOP), "{refused}");

        let allowed = with_test_credential_tools_allowed(
            vec![RETURNS_CREDENTIAL_TOOL.to_owned()],
            call(&route, Some(&owner), RETURNS_CREDENTIAL_TOOL, None),
        )
        .await;
        assert_reached_the_tool(&allowed);
    })
    .await;
}

/// The one test that writes the setting. It reads the list the process holds,
/// not a per-task one, and leaves it empty.
#[tokio::test]
async fn only_a_node_manager_or_the_operator_writes_the_allowed_credential_tools() {
    let route = route().await;
    let owner = person(OWNER, OrgRole::Owner);
    let names_the_tool = format!("[\"{RETURNS_CREDENTIAL_TOOL}\"]");
    with_test_node_binding(false, Some(shared_node()), async {
        // A person needs the permission to manage nodes.
        for caller in [member(MEMBER), person("ce36-route-viewer", OrgRole::Viewer)] {
            assert_eq!(
                put_allowed(&route, Some(caller), &names_the_tool).await,
                StatusCode::FORBIDDEN
            );
        }
        assert_eq!(
            put_allowed(&route, Some(admin(ADMIN)), "[]").await,
            StatusCode::OK
        );
    })
    .await;
    with_test_node_binding(false, Some(personal_node(OWNER)), async {
        // Nothing a refused write named is allowed.
        let answer = call(&route, Some(&owner), RETURNS_CREDENTIAL_TOOL, None).await;
        assert!(answer.contains(CREDENTIAL_TOOL_REFUSAL), "{answer}");
        // The node credential with no person is the machine's operator. Its
        // write applies from the next call, with no restart.
        assert_eq!(
            put_allowed(&route, None, &names_the_tool).await,
            StatusCode::OK
        );
        let answer = call(&route, Some(&owner), RETURNS_CREDENTIAL_TOOL, None).await;
        assert_reached_the_tool(&answer);
        // A value that is not a list of ids allows nothing.
        assert_eq!(put_allowed(&route, None, "*").await, StatusCode::OK);
        let answer = call(&route, Some(&owner), RETURNS_CREDENTIAL_TOOL, None).await;
        assert!(answer.contains(CREDENTIAL_TOOL_REFUSAL), "{answer}");
        assert_eq!(put_allowed(&route, None, "[]").await, StatusCode::OK);
    })
    .await;
}

// Guards: these hold with the rules and without them.

#[tokio::test]
async fn direct_tool_calls_of_an_owner_and_of_an_admin_are_as_today() {
    let route = route().await;
    let owner = person(OWNER, OrgRole::Owner);
    let admin = admin(ADMIN);
    // The owner on a personal node, with and without a conversation.
    with_test_node_binding(false, Some(personal_node(OWNER)), async {
        for tool in CLASS_TOOLS {
            let answer = call(&route, Some(&owner), tool, None).await;
            assert_class_tool_passed_the_rules(tool, &answer);
            let answer = call(&route, Some(&owner), tool, Some(OWNER_CHAT)).await;
            assert_class_tool_passed_the_rules(tool, &answer);
        }
    })
    .await;
    // An admin on a shared node: as the verified caller, and as the sender in
    // a conversation the admin owns.
    with_test_node_binding(
        false,
        Some(shared_node()),
        with_test_people(vec![admin.clone()], async {
            for tool in CLASS_TOOLS {
                let answer = call(&route, Some(&admin), tool, None).await;
                assert_class_tool_passed_the_rules(tool, &answer);
                let answer = call(&route, Some(&admin), tool, Some(ADMIN_CHAT)).await;
                assert_class_tool_passed_the_rules(tool, &answer);
            }
        }),
    )
    .await;
    // A member on a shared node keeps a tool that is in no class.
    with_test_node_binding(false, Some(shared_node()), async {
        let member = member(MEMBER);
        assert_reached_the_tool(&call(&route, Some(&member), PLAIN_TOOL, None).await);
        assert_reached_the_tool(&call(&route, Some(&member), PLAIN_TOOL, Some(MEMBER_CHAT)).await);
    })
    .await;
}
