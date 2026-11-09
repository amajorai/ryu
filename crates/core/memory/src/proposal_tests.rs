//! Reviewed memory-revision proposals (dream review): owner-scoped listing,
//! plus the shared fixtures `proposal_review_tests` uses for approve, reject,
//! idempotent re-review, approval-time guards and rollback.

use rusqlite::params;

use super::*;
use crate::proposals::MemoryProposalPayload;

pub(super) fn draft(content: &str) -> MemoryProposalDraft {
    MemoryProposalDraft {
        content: content.to_owned(),
        scope: MemoryScope::User,
        scope_id: None,
        category: MemoryCategory::UserFact,
        importance: DEFAULT_IMPORTANCE,
        when_to_use: None,
        tags: vec!["dream".to_owned()],
        author_agent_id: Some("agent-a".to_owned()),
        metadata: MemoryMetadata::default(),
        sources: Vec::new(),
    }
}

pub(super) fn proposal(
    owner: &str,
    target: Option<&str>,
    operation: MemoryProposalOperation,
    content: &str,
) -> NewMemoryProposal {
    NewMemoryProposal {
        owner_user_id: owner.to_owned(),
        agent_id: "agent-a".to_owned(),
        target_memory_id: target.map(str::to_owned),
        operation,
        draft: draft(content),
        rationale: "consolidated during dream".to_owned(),
    }
}

pub(super) async fn record_target(store: &MemoryStore) -> String {
    store
        .record(LOCAL_USER, "agent-a", "User prefers tea")
        .await
        .unwrap()
        .unwrap()
}

pub(super) async fn propose_revision(store: &MemoryStore, target: &str) -> String {
    store
        .create_proposal(proposal(
            LOCAL_USER,
            Some(target),
            MemoryProposalOperation::Revise,
            "User prefers green tea",
        ))
        .await
        .unwrap()
}

/// Overwrite a stored proposal's encrypted draft, bypassing the create-time
/// guards, so the approval-time re-validation is what must reject it.
pub(super) async fn tamper_draft(store: &MemoryStore, id: &str, draft: MemoryProposalDraft) {
    let payload = serde_json::to_vec(&MemoryProposalPayload {
        draft,
        rationale: "tampered".to_owned(),
    })
    .unwrap();
    let (nonce, ciphertext) = store.encrypt(&payload).unwrap();
    let conn = store.conn.lock().await;
    conn.execute(
        "UPDATE memory_proposals SET nonce = ?1, ciphertext = ?2 WHERE id = ?3",
        params![nonce, ciphertext, id],
    )
    .unwrap();
}

#[tokio::test]
async fn list_proposals_is_owner_scoped_status_filtered_and_capped() {
    let store = MemoryStore::open_in_memory().unwrap();
    let mut alice_ids = Vec::new();
    for n in 0..3 {
        alice_ids.push(
            store
                .create_proposal(proposal(
                    "alice",
                    None,
                    MemoryProposalOperation::Create,
                    &format!("alice fact {n}"),
                ))
                .await
                .unwrap(),
        );
    }
    let bob = store
        .create_proposal(proposal(
            "bob",
            None,
            MemoryProposalOperation::Create,
            "bob fact",
        ))
        .await
        .unwrap();
    store
        .review_proposal(&alice_ids[0], false, Some("alice"))
        .await
        .unwrap();

    let all_alice = store
        .list_proposals("alice", &MemoryProposalFilter::default())
        .await
        .unwrap();
    assert_eq!(all_alice.len(), 3);
    assert!(all_alice.iter().all(|p| p.owner_user_id == "alice"));
    assert!(all_alice.iter().all(|p| p.id != bob));

    let pending = store
        .list_proposals(
            "alice",
            &MemoryProposalFilter {
                status: Some(MemoryProposalStatus::Pending),
                limit: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(pending.len(), 2);
    assert!(pending
        .iter()
        .all(|p| p.status == MemoryProposalStatus::Pending));
    assert!(pending.iter().all(|p| p.id != alice_ids[0]));

    let rejected = store
        .list_proposals(
            "alice",
            &MemoryProposalFilter {
                status: Some(MemoryProposalStatus::Rejected),
                limit: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(rejected.len(), 1);
    assert_eq!(rejected[0].id, alice_ids[0]);
    assert_eq!(rejected[0].draft.content, "alice fact 0");

    let bob_list = store
        .list_proposals("bob", &MemoryProposalFilter::default())
        .await
        .unwrap();
    assert_eq!(bob_list.len(), 1);
    assert_eq!(bob_list[0].id, bob);
    assert!(store
        .list_proposals("mallory", &MemoryProposalFilter::default())
        .await
        .unwrap()
        .is_empty());

    let limited = store
        .list_proposals(
            "alice",
            &MemoryProposalFilter {
                status: None,
                limit: Some(2),
            },
        )
        .await
        .unwrap();
    assert_eq!(limited.len(), 2);
}

#[tokio::test]
async fn list_proposals_caps_the_limit_at_500() {
    let store = MemoryStore::open_in_memory().unwrap();
    for n in 0..501 {
        store
            .create_proposal(proposal(
                "alice",
                None,
                MemoryProposalOperation::Create,
                &format!("bulk fact {n}"),
            ))
            .await
            .unwrap();
    }
    let capped = store
        .list_proposals(
            "alice",
            &MemoryProposalFilter {
                status: None,
                limit: Some(10_000),
            },
        )
        .await
        .unwrap();
    assert_eq!(capped.len(), 500);
    let defaulted = store
        .list_proposals("alice", &MemoryProposalFilter::default())
        .await
        .unwrap();
    assert_eq!(defaulted.len(), 100);
}
