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

fn users_of(served: &InstanceSenders) -> Vec<String> {
    served
        .senders
        .iter()
        .map(|caller| caller.user_id.clone())
        .collect()
}

#[test]
fn an_instance_remembers_every_sender_it_served() {
    let instance = channel();
    let memory = remember_instance("ts-conv-e", &instance, "ryu");
    let served = remembered_senders_for("ts-conv-e", &instance, "ryu").expect("a record");
    assert!(users_of(&served).is_empty());
    assert!(!served.served_without_sender);

    memory.remember_turn(Some(&sender("alice")));
    memory.remember_turn(Some(&sender("bob")));
    // A second turn of the same person is not a second person.
    memory.remember_turn(Some(&sender("alice")));
    let served = remembered_senders_for("ts-conv-e", &instance, "ryu").expect("a record");
    assert_eq!(
        users_of(&served),
        vec!["bob".to_owned(), "alice".to_owned()]
    );
    assert!(!served.served_without_sender);
}

#[test]
fn an_instance_remembers_that_it_served_a_turn_with_no_sender() {
    let instance = channel();
    let memory = remember_instance("ts-conv-f", &instance, "ryu");
    memory.remember_turn(Some(&sender("alice")));
    memory.remember_turn(None);
    // A later turn with a sender does not clear it.
    memory.remember_turn(Some(&sender("bob")));
    let served = remembered_senders_for("ts-conv-f", &instance, "ryu").expect("a record");
    assert!(served.served_without_sender);
    assert_eq!(users_of(&served).len(), 2);
}

#[test]
fn only_the_remembering_instance_and_agent_see_the_record() {
    let instance = channel();
    let other_instance = channel();
    let memory = remember_instance("ts-conv-g", &instance, "ryu");
    memory.remember_turn(Some(&sender("alice")));

    assert!(remembered_senders_for("ts-conv-g", &instance, "ryu").is_some());
    assert!(remembered_senders_for("ts-conv-g", &other_instance, "ryu").is_none());
    assert!(remembered_senders_for("ts-conv-g", &instance, "other-agent").is_none());
    assert!(remembered_senders_for("ts-conv-h", &instance, "ryu").is_none());
}

#[test]
fn the_memory_guard_clears_only_its_own_record_when_the_instance_ends() {
    let first = channel();
    let second = channel();
    let ended = remember_instance("ts-conv-i", &first, "ryu");
    let live = remember_instance("ts-conv-i", &second, "ryu");
    ended.remember_turn(Some(&sender("alice")));
    live.remember_turn(Some(&sender("bob")));

    drop(ended);
    assert!(remembered_senders_for("ts-conv-i", &first, "ryu").is_none());
    let served = remembered_senders_for("ts-conv-i", &second, "ryu").expect("a record");
    assert_eq!(users_of(&served), vec!["bob".to_owned()]);
    drop(live);
    assert!(remembered_senders_for("ts-conv-i", &second, "ryu").is_none());
}

#[test]
fn the_turn_guard_does_not_clear_what_the_instance_remembers() {
    let instance = channel();
    let memory = remember_instance("ts-conv-j", &instance, "ryu");
    let turn = register_turn_sender("ts-conv-j", sender("alice"), &instance, "ryu");
    memory.remember_turn(Some(&sender("alice")));
    drop(turn);

    // The live sender is gone with the turn; the record of it is not.
    assert!(turn_sender_for("ts-conv-j", &instance, "ryu").is_none());
    let served = remembered_senders_for("ts-conv-j", &instance, "ryu").expect("a record");
    assert_eq!(users_of(&served), vec!["alice".to_owned()]);
}
