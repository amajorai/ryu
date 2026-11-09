//! Deleting facts: the row is gone, links to it are repaired in the same
//! transaction, proposals that pointed at it are rejected or scrubbed, and the
//! full wipe leaves no proposal or setting behind.

use rusqlite::params;

use super::*;
use crate::delete::{APPLIED_DELETED_RATIONALE, SYSTEM_REVIEWER, TARGET_DELETED_RATIONALE};
use crate::proposal_tests::{proposal, propose_revision, record_target};

async fn apply_revision(store: &MemoryStore, target: &str) -> (String, String) {
    let id = propose_revision(store, target).await;
    let applied = store
        .review_proposal(&id, true, Some("reviewer-1"))
        .await
        .unwrap()
        .unwrap();
    (id, applied.applied_memory_id.unwrap())
}

fn cited_proposal(target: &str, operation: MemoryProposalOperation) -> NewMemoryProposal {
    let mut cited = proposal(LOCAL_USER, Some(target), operation, "User prefers oolong");
    cited.draft.when_to_use = Some("when ordering tea".to_owned());
    cited.draft.sources = vec![MemoryProposalSource {
        message_id: "m1".to_owned(),
        conversation_id: Some("c1".to_owned()),
        excerpt: "I only drink oolong now".to_owned(),
    }];
    cited.rationale = "User said they only drink oolong".to_owned();
    cited
}

async fn raw_ciphertexts(store: &MemoryStore) -> Vec<Vec<u8>> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT ciphertext FROM memory_proposals")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

#[tokio::test]
async fn deleting_a_superseded_row_unlinks_the_revision_that_replaced_it() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (_, revision) = apply_revision(&store, &target).await;
    assert_eq!(
        store.get(&revision).await.unwrap().unwrap().supersedes_id,
        Some(target.clone())
    );

    assert!(store.delete(&target).await.unwrap());

    assert!(store.get(&target).await.unwrap().is_none());
    let survivor = store.get(&revision).await.unwrap().unwrap();
    assert!(survivor.supersedes_id.is_none());
    assert_eq!(survivor.content, "User prefers green tea");
    assert_eq!(survivor.lifecycle, MemoryLifecycle::Active);
}

#[tokio::test]
async fn deleting_a_target_rejects_its_pending_proposals_and_scrubs_them() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let other = store
        .record(LOCAL_USER, "agent-a", "User lives in Lisbon")
        .await
        .unwrap()
        .unwrap();
    let revise = store
        .create_proposal(cited_proposal(&target, MemoryProposalOperation::Revise))
        .await
        .unwrap();
    let archive = store
        .create_proposal(cited_proposal(&target, MemoryProposalOperation::Archive))
        .await
        .unwrap();
    let unrelated = propose_revision(&store, &other).await;
    let create = store
        .create_proposal(proposal(
            LOCAL_USER,
            None,
            MemoryProposalOperation::Create,
            "User likes jazz",
        ))
        .await
        .unwrap();

    assert!(store.delete(&target).await.unwrap());

    for id in [&revise, &archive] {
        let rejected = store.get_proposal(id).await.unwrap().unwrap();
        assert_eq!(rejected.status, MemoryProposalStatus::Rejected);
        assert_eq!(rejected.reviewed_by.as_deref(), Some(SYSTEM_REVIEWER));
        assert!(rejected.rejected_by_system());
        assert!(rejected.reviewed_at.is_some());
        assert_eq!(rejected.rationale, TARGET_DELETED_RATIONALE);
        assert_eq!(rejected.draft.content, "");
        assert!(rejected.draft.when_to_use.is_none());
        assert_eq!(rejected.draft.sources.len(), 1);
        assert_eq!(rejected.draft.sources[0].message_id, "m1");
        assert_eq!(rejected.draft.sources[0].excerpt, "");
        assert_eq!(rejected.target_memory_id.as_deref(), Some(target.as_str()));
    }
    for id in [&unrelated, &create] {
        let untouched = store.get_proposal(id).await.unwrap().unwrap();
        assert_eq!(untouched.status, MemoryProposalStatus::Pending);
        assert!(!untouched.rejected_by_system());
        assert!(!untouched.draft.content.is_empty());
    }
    // A reviewer's own rejection is not the store's.
    let declined = store
        .review_proposal(&unrelated, false, Some("reviewer-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(declined.status, MemoryProposalStatus::Rejected);
    assert!(!declined.rejected_by_system());
    // Neither the deleted fact nor the new rationale is stored in plaintext.
    for ciphertext in raw_ciphertexts(&store).await {
        assert!(!contains(&ciphertext, "oolong"));
        assert!(!contains(&ciphertext, "was deleted"));
    }

    // Approving the auto-rejected proposal is a no-op that writes nothing.
    let again = store
        .review_proposal(&revise, true, Some("reviewer-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.status, MemoryProposalStatus::Rejected);
    assert_eq!(again.reviewed_by.as_deref(), Some(SYSTEM_REVIEWER));
    assert_eq!(store.count().await.unwrap(), 1);
}

#[tokio::test]
async fn approving_a_proposal_whose_target_was_deleted_writes_nothing() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let id = propose_revision(&store, &target).await;
    assert!(store.delete(&target).await.unwrap());

    // The delete already rejected the proposal, so approval is a no-op.
    let reviewed = store
        .review_proposal(&id, true, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reviewed.status, MemoryProposalStatus::Rejected);
    assert!(reviewed.applied_memory_id.is_none());
    assert_eq!(store.count().await.unwrap(), 0);
}

#[tokio::test]
async fn deleting_an_applied_revision_scrubs_the_proposal_that_wrote_it() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (proposal_id, revision) = apply_revision(&store, &target).await;

    assert!(store.delete(&revision).await.unwrap());

    let scrubbed = store.get_proposal(&proposal_id).await.unwrap().unwrap();
    assert_eq!(scrubbed.status, MemoryProposalStatus::Applied);
    assert_eq!(scrubbed.reviewed_by.as_deref(), Some("reviewer-1"));
    assert_eq!(scrubbed.draft.content, "");
    assert_eq!(scrubbed.rationale, APPLIED_DELETED_RATIONALE);
    assert_eq!(
        scrubbed.applied_memory_id.as_deref(),
        Some(revision.as_str())
    );
}

#[tokio::test]
async fn deleting_the_original_keeps_the_surviving_revision_proposal_intact() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (proposal_id, _) = apply_revision(&store, &target).await;

    assert!(store.delete(&target).await.unwrap());

    // The draft is the surviving row's content, not the deleted fact.
    let kept = store.get_proposal(&proposal_id).await.unwrap().unwrap();
    assert_eq!(kept.status, MemoryProposalStatus::Applied);
    assert_eq!(kept.draft.content, "User prefers green tea");
    assert_eq!(kept.rationale, "consolidated during dream");
}

#[tokio::test]
async fn deleting_an_already_missing_row_repairs_legacy_dangling_links() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (_, revision) = apply_revision(&store, &target).await;
    let pending = propose_revision(&store, &revision).await;
    {
        // A row removed before deletes repaired links.
        let conn = store.conn.lock().await;
        conn.execute(
            "DELETE FROM memory_entries WHERE id = ?1",
            params![&revision],
        )
        .unwrap();
        conn.execute(
            "UPDATE memory_entries SET supersedes_id = ?1 WHERE id = ?2",
            params![&revision, &target],
        )
        .unwrap();
    }

    assert!(!store.delete(&revision).await.unwrap());

    assert!(store
        .get(&target)
        .await
        .unwrap()
        .unwrap()
        .supersedes_id
        .is_none());
    let rejected = store.get_proposal(&pending).await.unwrap().unwrap();
    assert_eq!(rejected.status, MemoryProposalStatus::Rejected);
}

#[tokio::test]
async fn an_undecryptable_proposal_does_not_block_the_delete() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let pending = propose_revision(&store, &target).await;
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_proposals SET ciphertext = ?1 WHERE id = ?2",
            params![b"not a ciphertext".to_vec(), &pending],
        )
        .unwrap();
    }

    assert!(store.delete(&target).await.unwrap());

    let rejected = store.get_proposal(&pending).await.unwrap().unwrap();
    assert_eq!(rejected.status, MemoryProposalStatus::Rejected);
    assert_eq!(rejected.draft.content, "");
    assert_eq!(rejected.rationale, TARGET_DELETED_RATIONALE);
}

#[tokio::test]
async fn clear_all_removes_proposals_of_every_status_and_owner_and_settings() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    apply_revision(&store, &target).await;
    let rejected = store
        .create_proposal(proposal(
            LOCAL_USER,
            None,
            MemoryProposalOperation::Create,
            "User likes jazz",
        ))
        .await
        .unwrap();
    store.review_proposal(&rejected, false, None).await.unwrap();
    store
        .create_proposal(proposal(
            "bob",
            None,
            MemoryProposalOperation::Create,
            "Bob likes chess",
        ))
        .await
        .unwrap();
    store
        .set_include_sensitive_topics(LOCAL_USER, true)
        .await
        .unwrap();

    assert_eq!(store.clear_all().await.unwrap(), 2);

    let conn = store.conn.lock().await;
    for table in ["memory_entries", "memory_proposals", "memory_settings"] {
        let rows: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(rows, 0, "{table}");
    }
}
