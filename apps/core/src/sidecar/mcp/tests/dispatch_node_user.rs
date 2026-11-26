//! The node-user rule at the dispatch core: who may call a tool that acts as
//! the node's own user on a shared node.
//!
//! Every call goes through the entry an approved or internal call takes, which
//! ends in the dispatch core with no approval gate in front. No tool can reach
//! a backend: a call the rule lets through ends at the allowlist stop of the
//! app-tool arm (`fixtures::ALLOWLIST_STOP`). The node kind, the people the
//! by-user-id lookup finds and the senders are bound per task, so no test
//! changes what a concurrently running test reads.

use super::fixtures::{
    admin, conversations_owned, dispatch, member, person, personal_node, registry_with_class_tools,
    seed_tool_policy_for, shared_node, ALLOWLIST_STOP, BROWSER_TOOL, CAPTURES_TOOL,
    CREDENTIAL_TOOL, PLAIN_TOOL,
};
use super::*;
use crate::sidecar::control_plane::with_test_node_binding;

const MEMBER: &str = "ce36-member";
const ADMIN: &str = "ce36-admin";
const SECOND_ADMIN: &str = "ce36-admin-two";
const OWNER: &str = "ce36-owner";

const MEMBER_CHAT: &str = "ce36-member-chat";
const ADMIN_CHAT: &str = "ce36-admin-chat";
const OWNER_CHAT: &str = "ce36-owner-chat";

/// One tool of each class, with the words its refusal carries.
const CLASS_TOOLS: [(&str, &str); 3] = [
    (CREDENTIAL_TOOL, "uses a credential stored on this node"),
    (BROWSER_TOOL, "controls the desktop or the browser"),
    (CAPTURES_TOOL, "reads what was captured"),
];

async fn registry() -> McpRegistry {
    seed_tool_policy_for(&[MEMBER, ADMIN, SECOND_ADMIN, OWNER]);
    let conversations = conversations_owned(&[
        (MEMBER_CHAT, MEMBER),
        (ADMIN_CHAT, ADMIN),
        (OWNER_CHAT, OWNER),
    ])
    .await;
    registry_with_class_tools(Some(conversations)).await
}

async fn on_shared_node<F: std::future::Future>(future: F) -> F::Output {
    with_test_node_binding(false, Some(shared_node()), future).await
}

/// One call of a turn `sender` sent in `conversation`.
async fn turn(
    registry: &McpRegistry,
    tool: &str,
    conversation: &str,
    sender: &VerifiedCaller,
) -> String {
    authenticated_scope::with_turn_sender(sender, dispatch(registry, tool, Some(conversation)))
        .await
}

fn served(
    senders: Vec<VerifiedCaller>,
    without_sender: bool,
) -> authenticated_scope::InstanceSenders {
    authenticated_scope::InstanceSenders {
        senders,
        served_without_sender: without_sender,
    }
}

#[track_caller]
fn assert_refused(answer: &str, reason: &str) {
    assert!(
        answer.contains(NODE_USER_TOOL_REFUSAL),
        "the rule refuses: {answer}"
    );
    assert!(answer.contains(reason), "the reason is named: {answer}");
    assert!(
        answer.contains(NODE_USER_TOOL_PERMISSION),
        "the permission is named: {answer}"
    );
    assert!(!answer.contains(ALLOWLIST_STOP), "{answer}");
}

#[track_caller]
fn assert_reached_the_tool(answer: &str) {
    assert!(
        answer.contains(ALLOWLIST_STOP),
        "the call passes the rule and ends at the stop behind it: {answer}"
    );
    assert!(!answer.contains(NODE_USER_TOOL_REFUSAL), "{answer}");
}

async fn member_turn_is_refused(tool: &str, class_words: &str) {
    let registry = registry().await;
    on_shared_node(async {
        let answer = turn(&registry, tool, MEMBER_CHAT, &member(MEMBER)).await;
        assert_refused(&answer, "does not hold that permission");
        assert!(answer.contains(class_words), "the class is named: {answer}");
        assert!(answer.contains(tool), "the tool is named: {answer}");
    })
    .await;
}

#[tokio::test]
async fn member_turn_is_refused_a_credential_backed_tool_on_a_shared_node() {
    let (tool, words) = CLASS_TOOLS[0];
    member_turn_is_refused(tool, words).await;
}

#[tokio::test]
async fn member_turn_is_refused_a_browser_session_tool_on_a_shared_node() {
    let (tool, words) = CLASS_TOOLS[1];
    member_turn_is_refused(tool, words).await;
}

#[tokio::test]
async fn member_turn_is_refused_a_capture_reading_tool_on_a_shared_node() {
    let (tool, words) = CLASS_TOOLS[2];
    member_turn_is_refused(tool, words).await;
}

#[tokio::test]
async fn member_direct_call_is_refused_each_class_on_a_shared_node() {
    let registry = registry().await;
    on_shared_node(async {
        for (tool, _) in CLASS_TOOLS {
            let answer =
                with_verified_tool_caller(&member(MEMBER), dispatch(&registry, tool, None)).await;
            assert_refused(&answer, "does not hold that permission");
        }
    })
    .await;
}

#[tokio::test]
async fn a_call_that_names_no_person_is_refused_each_class_on_a_shared_node() {
    // What a workflow, a monitor or a recipe replay sends: no conversation and
    // no caller.
    let registry = registry().await;
    on_shared_node(async {
        for (tool, _) in CLASS_TOOLS {
            let answer = dispatch(&registry, tool, None).await;
            assert_refused(&answer, "this call names no person");
        }
    })
    .await;
}

#[tokio::test]
async fn a_shared_conversation_needs_both_its_owner_and_the_sender_to_hold_the_permission() {
    let registry = registry().await;
    on_shared_node(with_test_people(
        vec![member(MEMBER), admin(ADMIN)],
        async {
            for (tool, _) in CLASS_TOOLS {
                // A member writes into an admin's conversation.
                let answer = turn(&registry, tool, ADMIN_CHAT, &member(MEMBER)).await;
                assert_refused(&answer, "does not hold that permission");
                // An admin writes into a member's conversation.
                let answer = turn(&registry, tool, MEMBER_CHAT, &admin(ADMIN)).await;
                assert_refused(&answer, "does not hold that permission");
            }
        },
    ))
    .await;
}

#[tokio::test]
async fn an_owner_whose_permissions_cannot_be_read_is_refused() {
    // The owner is known by user id only and nothing answers for them here.
    let registry = registry().await;
    on_shared_node(with_test_people(Vec::new(), async {
        let answer = turn(&registry, CREDENTIAL_TOOL, MEMBER_CHAT, &admin(ADMIN)).await;
        assert_refused(&answer, "could not be read");
    }))
    .await;
}

#[tokio::test]
async fn a_call_in_a_conversation_with_no_bound_sender_is_refused_whoever_owns_it() {
    // Team turns, worker threads and routines into a chat run with the owner
    // named and no sender: the owner is not proof of who sent the turn.
    let registry = registry().await;
    on_shared_node(with_test_people(
        vec![member(MEMBER), admin(ADMIN)],
        async {
            for (tool, _) in CLASS_TOOLS {
                for conversation in [ADMIN_CHAT, MEMBER_CHAT] {
                    let answer = dispatch(&registry, tool, Some(conversation)).await;
                    assert_refused(&answer, "the person who sent this turn is not known");
                }
            }
        },
    ))
    .await;
}

#[tokio::test]
async fn an_approved_call_is_judged_again_at_dispatch() {
    // The replay of an approved call enters here with the stored conversation
    // and nobody bound. An approval does not lift the rule.
    let registry = registry().await;
    on_shared_node(async {
        let answer = dispatch(&registry, CREDENTIAL_TOOL, Some(MEMBER_CHAT)).await;
        assert_refused(&answer, "the person who sent this turn is not known");
    })
    .await;
}

#[tokio::test]
async fn a_member_turn_then_an_admin_turn_on_one_instance_is_refused() {
    // The bridge outlives a turn. A call an engine makes for the member's
    // earlier turn would otherwise borrow the admin who sent the next one.
    let registry = registry().await;
    on_shared_node(async {
        for (tool, _) in CLASS_TOOLS {
            let answer = authenticated_scope::with_instance_senders(
                served(vec![member(MEMBER), admin(ADMIN)], false),
                turn(&registry, tool, ADMIN_CHAT, &admin(ADMIN)),
            )
            .await;
            assert_refused(&answer, "does not hold that permission");
        }
    })
    .await;
}

#[tokio::test]
async fn an_instance_that_served_a_turn_with_no_sender_is_refused() {
    let registry = registry().await;
    on_shared_node(async {
        let answer = authenticated_scope::with_instance_senders(
            served(vec![admin(ADMIN)], true),
            turn(&registry, CREDENTIAL_TOOL, ADMIN_CHAT, &admin(ADMIN)),
        )
        .await;
        assert_refused(&answer, "also served a turn whose sender is not known");
    })
    .await;
}

#[tokio::test]
async fn every_class_is_refused_to_everybody_on_a_managed_node_that_is_not_registered() {
    let registry = registry().await;
    with_test_node_binding(true, None, async {
        for (tool, _) in CLASS_TOOLS {
            let answer =
                with_verified_tool_caller(&admin(ADMIN), dispatch(&registry, tool, None)).await;
            assert_refused(&answer, "not registered with its organization yet");
        }
    })
    .await;
}

#[tokio::test]
async fn the_recorder_is_refused_on_a_shared_node_unless_its_caller_manages_the_node() {
    let client = reqwest::Client::new();
    on_shared_node(async {
        let nobody = enforce_node_user_recorder_access(&client, None)
            .await
            .expect_err("a callback that names no person is refused");
        assert_refused(&nobody, "this call names no person");
        assert!(nobody.contains("recording taps the input"), "{nobody}");

        let by_member = enforce_node_user_recorder_access(&client, Some(&member(MEMBER)))
            .await
            .expect_err("a member is refused");
        assert_refused(&by_member, "does not hold that permission");

        enforce_node_user_recorder_access(&client, Some(&admin(ADMIN)))
            .await
            .expect("a person who manages the node records");
    })
    .await;
    with_test_node_binding(true, None, async {
        let unregistered = enforce_node_user_recorder_access(&client, Some(&admin(ADMIN)))
            .await
            .expect_err("nobody records on a managed node that is not registered");
        assert_refused(&unregistered, "not registered with its organization yet");
    })
    .await;
}

// Guards: these hold with the rule and without it.

#[tokio::test]
async fn owner_on_a_personal_node_is_not_stopped_by_the_rule_for_any_class() {
    let registry = registry().await;
    with_test_node_binding(false, Some(personal_node(OWNER)), async {
        for (tool, _) in CLASS_TOOLS {
            // A turn with no bound sender, a call with no person and a turn of
            // the owner all run as they do today.
            assert_reached_the_tool(&dispatch(&registry, tool, Some(OWNER_CHAT)).await);
            assert_reached_the_tool(&dispatch(&registry, tool, None).await);
            let owner = person(OWNER, crate::identity_verify::OrgRole::Owner);
            assert_reached_the_tool(&turn(&registry, tool, OWNER_CHAT, &owner).await);
        }
    })
    .await;
}

#[tokio::test]
async fn an_unbound_node_is_not_stopped_by_the_rule() {
    let registry = registry().await;
    with_test_node_binding(false, None, async {
        for (tool, _) in CLASS_TOOLS {
            assert_reached_the_tool(&dispatch(&registry, tool, None).await);
            assert_reached_the_tool(&dispatch(&registry, tool, Some(OWNER_CHAT)).await);
        }
    })
    .await;
}

#[tokio::test]
async fn admin_turn_on_a_shared_node_is_not_stopped_by_the_rule() {
    let registry = registry().await;
    on_shared_node(async {
        for (tool, _) in CLASS_TOOLS {
            // The admin's own conversation, the admin bound as the sender.
            assert_reached_the_tool(&turn(&registry, tool, ADMIN_CHAT, &admin(ADMIN)).await);
            // A direct call of the admin with no conversation.
            let direct =
                with_verified_tool_caller(&admin(ADMIN), dispatch(&registry, tool, None)).await;
            assert_reached_the_tool(&direct);
        }
    })
    .await;
}

#[tokio::test]
async fn an_admin_turn_in_another_admins_conversation_is_not_stopped_by_the_rule() {
    // The owner is found by user id and holds the permission as well.
    let registry = registry().await;
    on_shared_node(with_test_people(vec![admin(ADMIN)], async {
        for (tool, _) in CLASS_TOOLS {
            let answer = turn(&registry, tool, ADMIN_CHAT, &admin(SECOND_ADMIN)).await;
            assert_reached_the_tool(&answer);
        }
    }))
    .await;
}

#[tokio::test]
async fn an_admin_only_instance_is_not_stopped_by_the_rule() {
    let registry = registry().await;
    on_shared_node(async {
        for (tool, _) in CLASS_TOOLS {
            let answer = authenticated_scope::with_instance_senders(
                served(vec![admin(ADMIN)], false),
                turn(&registry, tool, ADMIN_CHAT, &admin(ADMIN)),
            )
            .await;
            assert_reached_the_tool(&answer);
        }
    })
    .await;
}

#[tokio::test]
async fn a_tool_outside_the_three_classes_runs_for_a_member_on_a_shared_node() {
    let registry = registry().await;
    on_shared_node(async {
        assert_reached_the_tool(&turn(&registry, PLAIN_TOOL, MEMBER_CHAT, &member(MEMBER)).await);
        // With nobody named and with no bound sender as well.
        assert_reached_the_tool(&dispatch(&registry, PLAIN_TOOL, None).await);
        assert_reached_the_tool(&dispatch(&registry, PLAIN_TOOL, Some(MEMBER_CHAT)).await);
    })
    .await;
}

#[tokio::test]
async fn the_recorder_is_not_stopped_off_a_shared_node() {
    let client = reqwest::Client::new();
    with_test_node_binding(false, Some(personal_node(OWNER)), async {
        enforce_node_user_recorder_access(&client, None)
            .await
            .expect("a personal node records as today");
    })
    .await;
    with_test_node_binding(false, None, async {
        enforce_node_user_recorder_access(&client, None)
            .await
            .expect("an unbound node records as today");
    })
    .await;
}
