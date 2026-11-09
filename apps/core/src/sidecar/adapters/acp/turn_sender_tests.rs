use std::sync::Arc;

use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use super::*;
use crate::identity_verify::OrgRole;

fn sender(user: &str) -> Arc<VerifiedCaller> {
    Arc::new(VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

fn channel() -> UnboundedSender<AcpEvent> {
    unbounded_channel().0
}

fn user_of(found: Option<Arc<VerifiedCaller>>) -> Option<String> {
    found.map(|caller| caller.user_id.clone())
}

#[test]
fn only_the_registering_instance_and_agent_see_the_sender() {
    let instance = channel();
    let other_instance = channel();
    let _guard = register_turn_sender("ts-conv-a", sender("alice"), &instance, "ryu");

    assert_eq!(
        user_of(turn_sender_for("ts-conv-a", &instance, "ryu")),
        Some("alice".to_owned())
    );
    assert!(turn_sender_for("ts-conv-a", &other_instance, "ryu").is_none());
    assert!(turn_sender_for("ts-conv-a", &instance, "other-agent").is_none());
    assert!(turn_sender_for("ts-conv-b", &instance, "ryu").is_none());
}

#[test]
fn the_guard_clears_its_own_turn_at_turn_end() {
    let instance = channel();
    let guard = register_turn_sender("ts-conv-c", sender("alice"), &instance, "ryu");
    drop(guard);
    assert!(turn_sender_for("ts-conv-c", &instance, "ryu").is_none());
}

#[test]
fn a_superseded_guard_does_not_clear_the_newer_turn() {
    let first = channel();
    let second = channel();
    let stale = register_turn_sender("ts-conv-d", sender("alice"), &first, "ryu");
    let _live = register_turn_sender("ts-conv-d", sender("bob"), &second, "ryu");

    // The first instance lost its entry: it fails closed instead of seeing Bob.
    assert!(turn_sender_for("ts-conv-d", &first, "ryu").is_none());
    drop(stale);
    assert_eq!(
        user_of(turn_sender_for("ts-conv-d", &second, "ryu")),
        Some("bob".to_owned())
    );
}
