use std::sync::Arc;

use super::*;
use crate::identity_verify::OrgRole;
use crate::server::{host_conversation_proof, host_conversation_proof_is_valid};

fn owner(user: &str) -> Arc<VerifiedCaller> {
    Arc::new(VerifiedCaller {
        user_id: user.to_owned(),
        email: None,
        email_verified: false,
        org_id: Some("org".to_owned()),
        role: OrgRole::Member,
        teams: Vec::new(),
    })
}

fn user_of(found: Option<Arc<VerifiedCaller>>) -> Option<String> {
    found.map(|caller| caller.user_id.clone())
}

#[test]
fn a_turn_bound_proof_is_still_a_valid_host_conversation_proof() {
    let turn = register_gateway_turn_sender("gts-conv-a", owner("alice"));
    let proof = turn.host_conversation_proof();
    let (base, token) = proof.split_once('.').expect("turn token suffix");
    assert_eq!(base, host_conversation_proof("gts-conv-a"));
    assert!(token.len() >= 22, "128-bit token: {token}");
    assert!(host_conversation_proof_is_valid("gts-conv-a", &proof));
    assert!(host_conversation_proof_is_valid(
        "gts-conv-a",
        &host_conversation_proof("gts-conv-a")
    ));
    assert!(!host_conversation_proof_is_valid("gts-conv-b", &proof));

    // A tampered base fails even with a live token.
    let flipped = if base.ends_with('A') { 'B' } else { 'A' };
    let tampered = format!("{}{flipped}.{token}", &base[..base.len() - 1]);
    assert!(!host_conversation_proof_is_valid("gts-conv-a", &tampered));
    assert!(gateway_turn_sender("gts-conv-a", &tampered).is_none());
}

#[test]
fn the_token_resolves_only_for_its_own_conversation() {
    let turn = register_gateway_turn_sender("gts-conv-c", owner("alice"));
    let proof = turn.host_conversation_proof();
    assert_eq!(
        user_of(gateway_turn_sender("gts-conv-c", &proof)),
        Some("alice".to_owned())
    );

    // Another conversation's valid base with this turn's token.
    let token = proof.split_once('.').map(|(_, token)| token).unwrap();
    let moved = format!("{}.{token}", host_conversation_proof("gts-conv-d"));
    assert!(host_conversation_proof_is_valid("gts-conv-d", &moved));
    assert!(gateway_turn_sender("gts-conv-d", &moved).is_none());

    // The bare proof and an unknown token name no sender.
    assert!(gateway_turn_sender("gts-conv-c", &host_conversation_proof("gts-conv-c")).is_none());
    let unknown = format!("{}.not-a-live-token", host_conversation_proof("gts-conv-c"));
    assert!(gateway_turn_sender("gts-conv-c", &unknown).is_none());
}

#[test]
fn an_ended_turn_names_no_sender() {
    let turn = register_gateway_turn_sender("gts-conv-e", owner("alice"));
    let proof = turn.host_conversation_proof();
    drop(turn);
    assert!(host_conversation_proof_is_valid("gts-conv-e", &proof));
    assert!(gateway_turn_sender("gts-conv-e", &proof).is_none());
}
