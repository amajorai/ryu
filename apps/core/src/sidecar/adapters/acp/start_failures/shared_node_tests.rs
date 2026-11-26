//! The failed-turn frames of a shared node's refusals (finding CE-35). Each
//! reuses the start-failure card. The one text of the host a member is shown
//! is the sandbox probe's reason; every other sentence is fixed.

use super::*;

#[test]
fn the_shared_node_refusal_reuses_the_start_failure_card_and_names_the_reason() {
    let failure = shared_node_sandbox_failure(Some("no user namespaces"));
    assert_eq!(failure.code, "agent_start_failed");
    assert!(
        failure.message.contains("this node is shared"),
        "{}",
        failure.message
    );
    assert!(
        failure.message.contains("(no user namespaces)"),
        "{}",
        failure.message
    );
    assert!(
        !failure.message.contains("rust the folder"),
        "{}",
        failure.message
    );
}

/// A step after the probe failed (the loopback relay or the wrap). The frame
/// takes no text of that step: the sentence is fixed and sends the reader to
/// the node's log, where the error chain is.
#[test]
fn a_shared_node_refusal_after_the_probe_shows_a_fixed_sentence() {
    let failure = shared_node_sandbox_failure(None);
    assert_eq!(failure.code, "agent_start_failed");
    assert!(
        failure.message.contains(
            "this node is shared, and Ryu could not sandbox the agent on this computer (the \
             cause is in the node's log), so it did not start the agent"
        ),
        "{}",
        failure.message
    );
    assert_eq!(failure.message, shared_node_sandbox_failure(None).message);
    assert!(
        !failure.message.contains("rust the folder"),
        "{}",
        failure.message
    );
}

#[test]
fn the_refusal_of_a_server_that_is_not_stdio_shows_a_fixed_sentence() {
    let failure = shared_node_server_failure();
    assert_eq!(failure.code, "agent_start_failed");
    assert!(
        failure.message.contains(
            "this node is shared, and this agent does not start as a program Ryu can sandbox, \
             so it did not start the agent"
        ),
        "{}",
        failure.message
    );
}
