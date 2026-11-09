//! Which bridge gets a live turn's sender: only the in-process bridge of the
//! instance and agent that registered the turn, in that turn's conversation.
//! What the sender then changes is covered by
//! `search_conversations_visibility_tests`.

use super::*;
use crate::identity_verify::{OrgRole, VerifiedCaller};
use crate::sidecar::adapters::acp::turn_sender::register_turn_sender;

fn member(user: &str) -> Arc<VerifiedCaller> {
    Arc::new(VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org-bridge-turn-sender".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

fn bridge(
    permission_tx: Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
    conversation: &str,
    agent_id: &str,
) -> RyuMcpHandler {
    RyuMcpHandler {
        mcp: Arc::new(McpRegistry::empty()),
        allowlist: None,
        composio_actions: Vec::new(),
        agent_id: agent_id.to_owned(),
        identity_profile_ids: Vec::new(),
        composio_connection_scope: None,
        conversation_scope: None,
        caps: crate::sidecar::mcp::AgentCapabilities::default(),
        permission_tx,
        permission_scope_id: Some(conversation.to_owned()),
    }
}

fn sender_of(handler: &RyuMcpHandler) -> Option<String> {
    handler
        .live_turn_sender()
        .map(|sender| sender.user_id.clone())
}

#[test]
fn only_the_registering_instance_and_agent_get_the_sender() {
    let chat = format!("bob-{}", uuid::Uuid::new_v4().simple());
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let live = bridge(Some(tx.clone()), &chat, "ryu");
    assert_eq!(sender_of(&live), None);

    let turn = register_turn_sender(&chat, member("bob"), &tx, "ryu");
    assert_eq!(sender_of(&live).as_deref(), Some("bob"));

    // Another instance on the same conversation, the same channel under
    // another agent, another conversation, or the network transport (no
    // channel) never gets it.
    let (other_tx, _other_rx) = tokio::sync::mpsc::unbounded_channel();
    assert_eq!(sender_of(&bridge(Some(other_tx), &chat, "ryu")), None);
    assert_eq!(
        sender_of(&bridge(Some(tx.clone()), &chat, "team-member")),
        None
    );
    assert_eq!(
        sender_of(&bridge(Some(tx.clone()), "other-chat", "ryu")),
        None
    );
    assert_eq!(sender_of(&bridge(None, &chat, "ryu")), None);

    drop(turn);
    assert_eq!(sender_of(&live), None);
}

#[test]
fn a_later_turn_replaces_the_sender_and_an_earlier_guard_does_not_clear_it() {
    let chat = format!("bob-{}", uuid::Uuid::new_v4().simple());
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let live = bridge(Some(tx.clone()), &chat, "ryu");

    let first = register_turn_sender(&chat, member("bob"), &tx, "ryu");
    let second = register_turn_sender(&chat, member("carol"), &tx, "ryu");
    assert_eq!(sender_of(&live).as_deref(), Some("carol"));
    drop(first);
    assert_eq!(sender_of(&live).as_deref(), Some("carol"));
    drop(second);
    assert_eq!(sender_of(&live), None);
}
