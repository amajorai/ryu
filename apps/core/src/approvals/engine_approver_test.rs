//! The approver of a held tool call as the sender of its run.
//!
//! An approved call is replayed with the stored conversation and nobody bound.
//! The engine binds the person who approved it as the sender of that run, so a
//! tool that acts as the node's own user asks the conversation's owner and the
//! approver. Most cases call `execute_approved`, the function the spawned run
//! calls: the node kind and the people are bound per task here, and a spawned
//! task does not see them. No tool can reach a backend: the stored allowlist
//! does not name the tool, so a run the rule lets through ends at the allowlist
//! stop of the app-tool arm.

use super::*;
use crate::identity_verify::VerifiedCaller;
use crate::sidecar::control_plane::with_test_node_binding;
use crate::sidecar::mcp::node_user_fixtures::{
    admin, allowlist_without_the_tool, conversations_owned, member, person, personal_node,
    registry_with_class_tools, seed_tool_policy_for, shared_node, ALLOWLIST_STOP, BROWSER_TOOL,
    CAPTURES_TOOL, CREDENTIAL_TOOL, PLAIN_TOOL,
};
use crate::sidecar::mcp::{with_test_people, NODE_USER_TOOL_REFUSAL};
use serde_json::json;

const MEMBER: &str = "ce36-approval-member";
const ADMIN: &str = "ce36-approval-admin";
const SECOND_ADMIN: &str = "ce36-approval-admin-two";
/// A person who appears in one test only, as the approver of a decision.
const APPROVER_ONLY: &str = "ce36-decider";

const MEMBER_CHAT: &str = "ce36-approval-member-chat";
const ADMIN_CHAT: &str = "ce36-approval-admin-chat";

const CLASS_TOOLS: [&str; 3] = [CREDENTIAL_TOOL, BROWSER_TOOL, CAPTURES_TOOL];

async fn engine() -> ApprovalEngine {
    seed_tool_policy_for(&[MEMBER, ADMIN, SECOND_ADMIN]);
    let conversations = conversations_owned(&[(MEMBER_CHAT, MEMBER), (ADMIN_CHAT, ADMIN)]).await;
    let registry = registry_with_class_tools(Some(conversations)).await;
    ApprovalEngine::new(
        ApprovalStore::open_in_memory().expect("open the approval store"),
        reqwest::Client::new(),
    )
    .with_registry(std::sync::Arc::new(registry))
}

/// The stored form of a held call of `tool` in `conversation`.
fn held_call(tool: &str, conversation: &str) -> PendingAction {
    PendingAction::ToolCall {
        tool_id: tool.to_owned(),
        arguments: json!({}),
        agent_id: None,
        allowlist: Some(allowlist_without_the_tool()),
        user_id: None,
        profile_ids: Vec::new(),
        session_id: None,
        host_conversation_id: Some(conversation.to_owned()),
        composio_connection_scope: None,
        conversation_scope: None,
        configure_approved: false,
    }
}

/// The run of an approved call, as the spawned task of `decide` makes it.
async fn approved_run(
    engine: &ApprovalEngine,
    tool: &str,
    conversation: &str,
    approver: Option<&VerifiedCaller>,
) -> String {
    match engine
        .execute_approved(&held_call(tool, conversation), approver)
        .await
    {
        Ok(result) => format!("THE CALL RAN: {result:?}"),
        Err(error) => format!("{error:#}"),
    }
}

async fn on_shared_node<F: std::future::Future>(future: F) -> F::Output {
    with_test_node_binding(false, Some(shared_node()), future).await
}

#[track_caller]
fn assert_refused(answer: &str, reason: &str) {
    assert!(
        answer.contains(NODE_USER_TOOL_REFUSAL),
        "the rule refuses: {answer}"
    );
    assert!(answer.contains(reason), "the reason is named: {answer}");
    assert!(!answer.contains(ALLOWLIST_STOP), "{answer}");
}

#[track_caller]
fn assert_reached_the_tool(answer: &str) {
    assert!(
        answer.contains(ALLOWLIST_STOP),
        "the run passes the rule and ends at the stop behind it: {answer}"
    );
    assert!(!answer.contains(NODE_USER_TOOL_REFUSAL), "{answer}");
}

#[tokio::test]
async fn an_admin_who_approves_a_class_call_in_their_own_conversation_runs_it() {
    let engine = engine().await;
    on_shared_node(async {
        for tool in CLASS_TOOLS {
            let answer = approved_run(&engine, tool, ADMIN_CHAT, Some(&admin(ADMIN))).await;
            assert_reached_the_tool(&answer);
        }
    })
    .await;
}

#[tokio::test]
async fn another_admin_who_approves_an_admins_class_call_runs_it() {
    // The owner of the conversation is found by user id and holds the
    // permission; the approver holds it as well.
    let engine = engine().await;
    on_shared_node(with_test_people(vec![admin(ADMIN)], async {
        for tool in CLASS_TOOLS {
            let approver = admin(SECOND_ADMIN);
            let answer = approved_run(&engine, tool, ADMIN_CHAT, Some(&approver)).await;
            assert_reached_the_tool(&answer);
        }
    }))
    .await;
}

#[tokio::test]
async fn a_members_held_class_call_stays_refused_when_an_admin_approves_it() {
    let engine = engine().await;
    on_shared_node(with_test_people(vec![member(MEMBER)], async {
        for tool in CLASS_TOOLS {
            let answer = approved_run(&engine, tool, MEMBER_CHAT, Some(&admin(ADMIN))).await;
            assert_refused(&answer, "does not hold that permission");
        }
    }))
    .await;
}

#[tokio::test]
async fn an_approver_who_does_not_manage_the_node_cannot_release_a_class_tool() {
    // A person may hold the permission to decide approvals through a role of
    // their own and still not manage the node.
    let engine = engine().await;
    on_shared_node(with_test_people(vec![admin(ADMIN)], async {
        for tool in CLASS_TOOLS {
            let approver = member(MEMBER);
            let answer = approved_run(&engine, tool, ADMIN_CHAT, Some(&approver)).await;
            assert_refused(&answer, "does not hold that permission");
        }
    }))
    .await;
}

// Guards: these hold with the binding and without it.

#[tokio::test]
async fn an_approved_class_call_with_no_approver_is_refused() {
    let engine = engine().await;
    on_shared_node(async {
        for tool in CLASS_TOOLS {
            for conversation in [ADMIN_CHAT, MEMBER_CHAT] {
                let answer = approved_run(&engine, tool, conversation, None).await;
                assert_refused(&answer, "the person who sent this turn is not known");
            }
        }
    })
    .await;
}

#[tokio::test]
async fn an_approved_call_runs_as_today_where_the_rule_does_not_apply() {
    let engine = engine().await;
    // A tool in no class on a shared node, with and without an approver.
    on_shared_node(async {
        assert_reached_the_tool(&approved_run(&engine, PLAIN_TOOL, MEMBER_CHAT, None).await);
        let approver = admin(ADMIN);
        let answer = approved_run(&engine, PLAIN_TOOL, MEMBER_CHAT, Some(&approver)).await;
        assert_reached_the_tool(&answer);
    })
    .await;
    // Every class on a personal node and on a node bound to nothing.
    for node in [Some(personal_node(ADMIN)), None] {
        with_test_node_binding(false, node, async {
            for tool in CLASS_TOOLS {
                assert_reached_the_tool(&approved_run(&engine, tool, ADMIN_CHAT, None).await);
                let approver = admin(ADMIN);
                let answer = approved_run(&engine, tool, ADMIN_CHAT, Some(&approver)).await;
                assert_reached_the_tool(&answer);
            }
        })
        .await;
    }
}

#[tokio::test]
async fn deciding_with_an_approver_runs_the_approved_action_once() {
    // Through `decide` itself. The run is a spawned task, which does not see a
    // per-task node binding, so this shows only that the action still runs for
    // a decision that names its approver, and that nothing is stored of them.
    let engine = engine().await;
    let request = engine
        .request(ApprovalRequest::for_tool_call(
            PLAIN_TOOL,
            Vec::new(),
            held_call(PLAIN_TOOL, ADMIN_CHAT),
        ))
        .await
        .expect("queue the held call");
    let decided = engine
        .decide(&request.id, true, None, Some(admin(APPROVER_ONLY)))
        .await
        .expect("decide")
        .expect("the request exists");
    assert_eq!(decided.status, ApprovalStatus::Approved);
    let error = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        loop {
            let row = engine
                .store
                .get(&request.id)
                .await
                .expect("read the request")
                .expect("the request exists");
            assert!(row.result.is_none(), "no test tool runs: {:?}", row.result);
            if let Some(error) = row.error {
                break error;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the approved action runs");
    assert!(error.contains(ALLOWLIST_STOP), "{error}");
    let stored = serde_json::to_string(
        &engine
            .store
            .get(&request.id)
            .await
            .expect("read the request")
            .expect("the request exists"),
    )
    .expect("the request serializes");
    assert!(
        !stored.contains(APPROVER_ONLY),
        "the approver is not stored on the request: {stored}"
    );
}
