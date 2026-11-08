//! Store integrity under races: a revision approval supersedes its target in
//! the same transaction (row-count checked), rollback is transactional and
//! refuses when it would leave two active versions of one fact, and `update`
//! never overwrites a row that was superseded or edited after it was read.

use rusqlite::params;

use super::*;

async fn record_target(store: &MemoryStore) -> String {
    store
        .record(LOCAL_USER, "agent-a", "User prefers tea")
        .await
        .unwrap()
        .unwrap()
}

async fn propose_revision(store: &MemoryStore, target: &str, content: &str) -> String {
    store
        .create_proposal(NewMemoryProposal {
            owner_user_id: LOCAL_USER.to_owned(),
            agent_id: "agent-a".to_owned(),
            target_memory_id: Some(target.to_owned()),
            operation: MemoryProposalOperation::Revise,
            draft: MemoryProposalDraft {
                content: content.to_owned(),
                scope: MemoryScope::User,
                scope_id: None,
                category: MemoryCategory::UserFact,
                importance: DEFAULT_IMPORTANCE,
                when_to_use: None,
                tags: Vec::new(),
                author_agent_id: Some("agent-a".to_owned()),
                metadata: MemoryMetadata::default(),
                sources: Vec::new(),
            },
            rationale: "integrity test".to_owned(),
        })
        .await
        .unwrap()
}

/// Approve a revision and return the id of the memory row it created.
async fn apply_revision(store: &MemoryStore, target: &str, content: &str) -> (String, String) {
    let proposal_id = propose_revision(store, target, content).await;
    let applied = store
        .review_proposal(&proposal_id, true, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(applied.status, MemoryProposalStatus::Applied);
    (proposal_id, applied.applied_memory_id.unwrap())
}

async fn active_ids(store: &MemoryStore) -> Vec<String> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT id FROM memory_entries WHERE lifecycle = 'active' ORDER BY id")
        .unwrap();
    stmt.query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<String>>>()
        .unwrap()
}

async fn row_count(store: &MemoryStore) -> i64 {
    let conn = store.conn.lock().await;
    conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |row| row.get(0))
        .unwrap()
}

async fn lifecycle(store: &MemoryStore, id: &str) -> MemoryLifecycle {
    store.get(id).await.unwrap().unwrap().lifecycle
}

async fn status(store: &MemoryStore, proposal_id: &str) -> MemoryProposalStatus {
    store
        .get_proposal(proposal_id)
        .await
        .unwrap()
        .unwrap()
        .status
}

#[tokio::test]
async fn two_revisions_of_one_target_apply_once_and_leave_one_active_row() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let first = propose_revision(&store, &target, "User prefers green tea").await;
    let second = propose_revision(&store, &target, "User prefers black tea").await;

    let applied = store
        .review_proposal(&first, true, None)
        .await
        .unwrap()
        .unwrap();
    let revision = applied.applied_memory_id.unwrap();
    let err = store
        .review_proposal(&second, true, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no longer active"), "{err}");

    assert_eq!(active_ids(&store).await, vec![revision]);
    // The failed approval inserted nothing and stays reviewable.
    assert_eq!(row_count(&store).await, 2);
    assert_eq!(status(&store, &second).await, MemoryProposalStatus::Pending);
}

#[tokio::test]
async fn approval_inserts_nothing_when_the_target_left_active_inside_the_race_window() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let proposal_id = propose_revision(&store, &target, "User prefers green tea").await;
    // Another writer archives the target after the proposal was created; the
    // in-transaction supersede must match no row and abort the approval.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_entries SET lifecycle = 'archived' WHERE id = ?1",
            params![target],
        )
        .unwrap();
    }

    let err = store
        .review_proposal(&proposal_id, true, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no longer active"), "{err}");
    assert_eq!(row_count(&store).await, 1);
    assert!(active_ids(&store).await.is_empty());
    assert_eq!(lifecycle(&store, &target).await, MemoryLifecycle::Archived);
    assert_eq!(
        status(&store, &proposal_id).await,
        MemoryProposalStatus::Pending
    );
}

#[tokio::test]
async fn rolling_back_a_revision_that_was_itself_revised_is_refused() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (proposal_a, revision_a) = apply_revision(&store, &target, "User prefers green tea").await;
    let (proposal_b, revision_b) = apply_revision(&store, &revision_a, "User prefers sencha").await;

    let err = store
        .rollback_proposal(&proposal_a, None)
        .await
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("roll back the later proposal first"),
        "{err}"
    );
    // Nothing moved: B is still the only active version and A stays applied.
    assert_eq!(active_ids(&store).await, vec![revision_b.clone()]);
    assert_eq!(
        lifecycle(&store, &target).await,
        MemoryLifecycle::Superseded
    );
    assert_eq!(
        lifecycle(&store, &revision_a).await,
        MemoryLifecycle::Superseded
    );
    assert_eq!(
        status(&store, &proposal_a).await,
        MemoryProposalStatus::Applied
    );

    // Unwinding in order works and ends with only the original active.
    store.rollback_proposal(&proposal_b, None).await.unwrap();
    assert_eq!(active_ids(&store).await, vec![revision_a.clone()]);
    store.rollback_proposal(&proposal_a, None).await.unwrap();
    assert_eq!(active_ids(&store).await, vec![target]);
    assert_eq!(
        status(&store, &proposal_a).await,
        MemoryProposalStatus::RolledBack
    );
    assert_eq!(
        lifecycle(&store, &revision_b).await,
        MemoryLifecycle::Retracted
    );
}

#[tokio::test]
async fn rolling_back_a_hard_deleted_revision_keeps_the_original_superseded() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (proposal_id, revision) = apply_revision(&store, &target, "User prefers green tea").await;
    assert!(store.delete(&revision).await.unwrap());

    let err = store
        .rollback_proposal(&proposal_id, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no longer exists"), "{err}");
    assert_eq!(
        lifecycle(&store, &target).await,
        MemoryLifecycle::Superseded
    );
    assert!(active_ids(&store).await.is_empty());
    assert_eq!(
        status(&store, &proposal_id).await,
        MemoryProposalStatus::Applied
    );
}

#[tokio::test]
async fn rollback_with_a_missing_target_is_refused_and_keeps_the_revision_active() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (proposal_id, revision) = apply_revision(&store, &target, "User prefers green tea").await;
    assert!(store.delete(&target).await.unwrap());

    let err = store
        .rollback_proposal(&proposal_id, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("target memory"), "{err}");
    // The retraction was rolled back with the transaction: the fact survives.
    assert_eq!(active_ids(&store).await, vec![revision]);
    assert_eq!(
        status(&store, &proposal_id).await,
        MemoryProposalStatus::Applied
    );
}

#[tokio::test]
async fn repeated_rollback_is_idempotent() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let (proposal_id, _) = apply_revision(&store, &target, "User prefers green tea").await;

    let first = store
        .rollback_proposal(&proposal_id, None)
        .await
        .unwrap()
        .unwrap();
    let second = store
        .rollback_proposal(&proposal_id, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.status, MemoryProposalStatus::RolledBack);
    assert_eq!(second.status, MemoryProposalStatus::RolledBack);
    assert_eq!(active_ids(&store).await, vec![target]);
}

#[tokio::test]
async fn an_update_racing_a_supersede_leaves_the_superseded_row_untouched() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    // The update read the row before the revision was approved.
    let snapshot = store.get(&target).await.unwrap().unwrap();
    let (_, revision) = apply_revision(&store, &target, "User prefers green tea").await;

    let patch = MemoryPatch {
        content: Some("User prefers coffee".to_owned()),
        importance: Some(5),
        ..Default::default()
    };
    assert!(store.update_from(snapshot, patch).await.unwrap().is_none());

    let original = store.get(&target).await.unwrap().unwrap();
    assert_eq!(original.content, "User prefers tea");
    assert_eq!(original.lifecycle, MemoryLifecycle::Superseded);
    assert_eq!(original.importance, DEFAULT_IMPORTANCE);
    assert_eq!(active_ids(&store).await, vec![revision]);
}

#[tokio::test]
async fn a_stale_update_does_not_overwrite_a_newer_edit() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let snapshot = store.get(&target).await.unwrap().unwrap();

    let first = MemoryPatch {
        content: Some("User prefers oolong".to_owned()),
        ..Default::default()
    };
    let edited = store.update(&target, first).await.unwrap().unwrap();
    // The version strictly increases even within one millisecond.
    assert!(edited.updated_at > snapshot.updated_at);

    let stale = MemoryPatch {
        content: Some("User prefers coffee".to_owned()),
        ..Default::default()
    };
    assert!(store.update_from(snapshot, stale).await.unwrap().is_none());
    let current = store.get(&target).await.unwrap().unwrap();
    assert_eq!(current.content, "User prefers oolong");

    // A fresh read can still be updated, back to back.
    for content in ["User prefers rooibos", "User prefers mate"] {
        let patch = MemoryPatch {
            content: Some(content.to_owned()),
            ..Default::default()
        };
        let updated = store.update(&target, patch).await.unwrap().unwrap();
        assert_eq!(updated.content, content);
    }
}

#[tokio::test]
async fn update_accepts_a_legacy_row_without_an_updated_at() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_entries SET updated_at = 0 WHERE id = ?1",
            params![target],
        )
        .unwrap();
    }

    let patch = MemoryPatch {
        content: Some("User prefers green tea".to_owned()),
        ..Default::default()
    };
    let updated = store.update(&target, patch).await.unwrap().unwrap();
    assert_eq!(updated.content, "User prefers green tea");
    assert!(updated.updated_at > updated.created_at);
}
