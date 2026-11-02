use axum::http::StatusCode;
use ryu_webauthn_relay::{
    b64url_encode, CeremonyKind, CredentialResponse, PendingRelayRequest, RelayCredential,
    RelayDecision, RelayOutcome, RelayRequest,
};
use serde_json::json;

use super::api::{answer_status, Caller};
use super::*;

const ORIGIN: &str = "https://login.example.com";
const CHALLENGE: &str = "c2lnbi1pbi1jaGFsbGVuZ2UtMTIzNA";
const ALICE: &str = "user:alice";
const BOB: &str = "user:bob";

fn request(kind: CeremonyKind) -> RelayRequest {
    let client_data = json!({
        "type": kind.client_data_type(),
        "challenge": CHALLENGE,
        "origin": ORIGIN,
        "crossOrigin": false,
    });
    let options = match kind {
        CeremonyKind::Get => json!({ "challenge": CHALLENGE, "rpId": "example.com" }),
        CeremonyKind::Create => json!({
            "challenge": CHALLENGE,
            "rp": { "id": "example.com", "name": "Example" },
            "user": { "id": "dXNlcg", "name": "alice", "displayName": "Alice" },
            "pubKeyCredParams": [{ "type": "public-key", "alg": -7 }],
        }),
    };
    RelayRequest {
        kind,
        agent_id: Some("agent-1".to_owned()),
        page_url: "https://login.example.com/sign-in".to_owned(),
        origin: ORIGIN.to_owned(),
        rp_id: "example.com".to_owned(),
        client_data_json: b64url_encode(client_data.to_string().as_bytes()),
        options,
        timeout_ms: Some(20_000),
    }
}

fn assertion() -> RelayCredential {
    RelayCredential {
        id: "Y3JlZA".to_owned(),
        response: CredentialResponse::Assertion {
            authenticator_data: "YXV0aA".to_owned(),
            signature: "c2ln".to_owned(),
            user_handle: None,
        },
    }
}

fn attestation() -> RelayCredential {
    RelayCredential {
        id: "Y3JlZA".to_owned(),
        response: CredentialResponse::Attestation {
            attestation_object: "b2Jq".to_owned(),
            transports: vec!["usb".to_owned()],
        },
    }
}

fn is(owner: &'static str) -> impl Fn(&str) -> bool {
    move |candidate: &str| candidate == owner
}

/// Wait (yielding to the relay future) until `owner` has a request waiting.
async fn next_pending(store: &RelayStore, owner: &'static str) -> PendingRelayRequest {
    loop {
        if let Some(first) = store.pending_for(is(owner), now_ms()).into_iter().next() {
            return first;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn disabled_setting_refuses_without_storing() {
    let store = RelayStore::default();
    let outcome = relay(&store, ALICE, request(CeremonyKind::Get), false).await;
    assert_eq!(outcome, RelayOutcome::Disabled);
    assert!(store.pending_for(|_| true, now_ms()).is_empty());
}

#[tokio::test]
async fn invalid_request_is_refused_before_it_is_shown() {
    let store = RelayStore::default();
    let mut bad = request(CeremonyKind::Get);
    bad.rp_id = "evil.com".to_owned();
    bad.options = json!({ "challenge": CHALLENGE, "rpId": "evil.com" });
    let outcome = relay(&store, ALICE, bad, true).await;
    assert!(
        matches!(outcome, RelayOutcome::Invalid { .. }),
        "{outcome:?}"
    );
    assert!(store.pending_for(|_| true, now_ms()).is_empty());
}

#[tokio::test]
async fn a_waiting_request_is_woken_by_its_answer() {
    let store = RelayStore::default();
    let answer = async {
        let pending = next_pending(&store, ALICE).await;
        assert_eq!(pending.kind, CeremonyKind::Get);
        assert_eq!(pending.origin, ORIGIN);
        assert_eq!(pending.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(pending.expires_at_ms - pending.created_at_ms, 20_000);
        let decision = RelayDecision::Approve {
            credential: assertion(),
        };
        store
            .answer(&pending.id, is(ALICE), decision, now_ms())
            .expect("the owner answers");
        pending.id
    };
    let (outcome, id) = tokio::join!(
        relay(&store, ALICE, request(CeremonyKind::Get), true),
        answer
    );
    assert_eq!(
        outcome,
        RelayOutcome::Ok {
            credential: assertion()
        }
    );
    // The finished request is gone: a late answer is unknown.
    assert_eq!(
        store.answer(
            &id,
            is(ALICE),
            RelayDecision::Deny { reason: None },
            now_ms()
        ),
        Err(AnswerError::NotFound)
    );
}

#[tokio::test]
async fn a_denial_reaches_the_page_with_its_reason() {
    let store = RelayStore::default();
    let answer = async {
        let pending = next_pending(&store, ALICE).await;
        let decision = RelayDecision::Deny {
            reason: Some("not me".to_owned()),
        };
        store.answer(&pending.id, is(ALICE), decision, now_ms())
    };
    let (outcome, answered) = tokio::join!(
        relay(&store, ALICE, request(CeremonyKind::Create), true),
        answer
    );
    assert_eq!(answered, Ok(()));
    assert_eq!(
        outcome,
        RelayOutcome::Denied {
            reason: Some("not me".to_owned())
        }
    );
}

#[tokio::test(start_paused = true)]
async fn an_unanswered_request_times_out_and_is_removed() {
    let store = RelayStore::default();
    let outcome = relay(&store, ALICE, request(CeremonyKind::Get), true).await;
    assert_eq!(outcome, RelayOutcome::Timeout);
    assert!(store.pending_for(|_| true, now_ms()).is_empty());
}

#[tokio::test]
async fn only_the_owner_sees_and_answers_a_request() {
    let store = RelayStore::default();
    let answer = async {
        let pending = next_pending(&store, ALICE).await;
        assert!(store.pending_for(is(BOB), now_ms()).is_empty());
        let deny = RelayDecision::Deny { reason: None };
        assert_eq!(
            store.answer(&pending.id, is(BOB), deny.clone(), now_ms()),
            Err(AnswerError::NotFound)
        );
        store.answer(&pending.id, is(ALICE), deny, now_ms())
    };
    let (outcome, answered) = tokio::join!(
        relay(&store, ALICE, request(CeremonyKind::Get), true),
        answer
    );
    assert_eq!(answered, Ok(()));
    assert_eq!(outcome, RelayOutcome::Denied { reason: None });
}

#[tokio::test]
async fn a_request_is_answered_once() {
    let store = RelayStore::default();
    let answer = async {
        let pending = next_pending(&store, ALICE).await;
        let first = RelayDecision::Approve {
            credential: assertion(),
        };
        store
            .answer(&pending.id, is(ALICE), first, now_ms())
            .expect("first answer");
        // Answered requests leave the desktop's list straight away.
        assert!(store.pending_for(is(ALICE), now_ms()).is_empty());
        store.answer(
            &pending.id,
            is(ALICE),
            RelayDecision::Deny { reason: None },
            now_ms(),
        )
    };
    let (outcome, second) = tokio::join!(
        relay(&store, ALICE, request(CeremonyKind::Get), true),
        answer
    );
    assert_eq!(second, Err(AnswerError::AlreadyAnswered));
    assert!(matches!(outcome, RelayOutcome::Ok { .. }));
}

#[tokio::test]
async fn a_credential_for_the_other_ceremony_is_refused() {
    let store = RelayStore::default();
    let answer = async {
        let pending = next_pending(&store, ALICE).await;
        let wrong = RelayDecision::Approve {
            credential: assertion(),
        };
        assert_eq!(
            store.answer(&pending.id, is(ALICE), wrong, now_ms()),
            Err(AnswerError::KindMismatch)
        );
        // The request is still waiting for a proper answer.
        let right = RelayDecision::Approve {
            credential: attestation(),
        };
        store.answer(&pending.id, is(ALICE), right, now_ms())
    };
    let (outcome, answered) = tokio::join!(
        relay(&store, ALICE, request(CeremonyKind::Create), true),
        answer
    );
    assert_eq!(answered, Ok(()));
    assert_eq!(
        outcome,
        RelayOutcome::Ok {
            credential: attestation()
        }
    );
}

#[test]
fn an_owner_cannot_queue_more_than_the_cap() {
    let store = RelayStore::default();
    let now = now_ms();
    let tickets: Vec<_> = (0..MAX_PENDING_PER_OWNER)
        .map(|_| {
            store
                .open(ALICE, request(CeremonyKind::Get), 20_000, now)
                .expect("under the cap")
        })
        .collect();
    assert_eq!(
        store
            .open(ALICE, request(CeremonyKind::Get), 20_000, now)
            .err(),
        Some(OpenError::Full)
    );
    assert!(store
        .open(BOB, request(CeremonyKind::Get), 20_000, now)
        .is_ok());
    drop(tickets);
    assert!(store
        .open(ALICE, request(CeremonyKind::Get), 20_000, now)
        .is_ok());
}

#[test]
fn expired_requests_are_hidden_and_unanswerable() {
    let store = RelayStore::default();
    let now = now_ms();
    let ticket = store
        .open(ALICE, request(CeremonyKind::Get), 10_000, now)
        .expect("opened");
    assert_eq!(store.pending_for(is(ALICE), now).len(), 1);
    let later = now + 10_000;
    assert!(store.pending_for(is(ALICE), later).is_empty());
    assert_eq!(
        store.answer(
            &ticket.id,
            is(ALICE),
            RelayDecision::Deny { reason: None },
            later
        ),
        Err(AnswerError::NotFound)
    );
}

#[test]
fn the_setting_must_be_exactly_true() {
    assert!(security_key_enabled_in(
        &json!({ "computer_use": { "security_key": true } })
    ));
    for config in [
        json!({}),
        json!({ "computer_use": {} }),
        json!({ "computer_use": { "security_key": false } }),
        json!({ "computer_use": { "security_key": "true" } }),
        json!({ "computer_use": { "locked_use": true } }),
    ] {
        assert!(!security_key_enabled_in(&config), "{config}");
    }
}

#[test]
fn requests_are_held_for_the_personal_owner_or_the_node_token() {
    use crate::sidecar::control_plane::{NodeScope, RegisteredNode, RegisteredOrg};
    let node = |scope, owner: Option<&str>| RegisteredNode {
        org: RegisteredOrg {
            id: "org-1".to_owned(),
            name: "Org".to_owned(),
            slug: None,
        },
        node_id: "node-1".to_owned(),
        scope,
        team_id: None,
        owner_user_id: owner.map(str::to_owned),
    };
    assert_eq!(owner_key_for(None), NODE_OWNER);
    assert_eq!(
        owner_key_for(Some(&node(NodeScope::Personal, Some("alice")))),
        ALICE
    );
    assert_eq!(
        owner_key_for(Some(&node(NodeScope::Personal, None))),
        NODE_OWNER
    );
    assert_eq!(
        owner_key_for(Some(&node(NodeScope::Team, Some("alice")))),
        NODE_OWNER
    );
}

#[test]
fn a_caller_owns_its_own_requests_and_the_node_owner_the_nodes() {
    let alice = Caller {
        owner: Some(ALICE.to_owned()),
        node_owner: false,
    };
    assert!(alice.owns(ALICE, NODE_OWNER));
    assert!(!alice.owns(BOB, NODE_OWNER));
    assert!(!alice.owns(NODE_OWNER, NODE_OWNER));

    // The node token, or the registered owner signed in with it, answers the
    // requests held for the node's owner key, whatever its own key reads.
    let token = Caller {
        owner: Some(NODE_OWNER.to_owned()),
        node_owner: true,
    };
    assert!(token.owns(ALICE, ALICE));
    assert!(token.owns(NODE_OWNER, NODE_OWNER));
    assert!(!token.owns(BOB, ALICE));

    let paired = Caller {
        owner: None,
        node_owner: false,
    };
    assert!(!paired.owns(NODE_OWNER, NODE_OWNER));
}

#[test]
fn answer_errors_map_to_their_statuses() {
    assert_eq!(
        answer_status(Ok(())),
        (StatusCode::OK, json!({ "ok": true }))
    );
    assert_eq!(
        answer_status(Err(AnswerError::NotFound)).0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        answer_status(Err(AnswerError::AlreadyAnswered)).0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        answer_status(Err(AnswerError::KindMismatch)).0,
        StatusCode::BAD_REQUEST
    );
}

#[test]
fn outcomes_and_decisions_keep_the_wire_shape() {
    let outcome = RelayOutcome::Ok {
        credential: assertion(),
    };
    let wire = serde_json::to_value(&outcome).expect("serializes");
    assert_eq!(wire["status"], "ok");
    assert_eq!(wire["credential"]["response"]["kind"], "assertion");
    let decision: RelayDecision =
        serde_json::from_value(json!({ "decision": "deny" })).expect("deny parses");
    assert_eq!(decision, RelayDecision::Deny { reason: None });
}
