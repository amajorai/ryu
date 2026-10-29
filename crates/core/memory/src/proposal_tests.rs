//! Reviewed memory-revision proposals (dream review): approve, reject,
//! idempotent re-review, approval-time guards, rollback, and owner-scoped
//! listing. A child module of the crate root so it can tamper with a stored
//! proposal payload to reach the approval-time re-validation.

use super::*;

fn draft(content: &str) -> MemoryProposalDraft {
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
    }
}

fn proposal(
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

async fn record_target(store: &MemoryStore) -> String {
    store
        .record(LOCAL_USER, "agent-a", "User prefers tea")
        .await
        .unwrap()
        .unwrap()
}

async fn propose_revision(store: &MemoryStore, target: &str) -> String {
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
async fn tamper_draft(store: &MemoryStore, id: &str, draft: MemoryProposalDraft) {
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
async fn rejecting_marks_rejected_with_reviewer_and_creates_no_memory() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .create_proposal(proposal(
            LOCAL_USER,
            None,
            MemoryProposalOperation::Create,
            "User likes jazz",
        ))
        .await
        .unwrap();

    let reviewed = store
        .review_proposal(&id, false, Some("reviewer-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reviewed.status, MemoryProposalStatus::Rejected);
    assert_eq!(reviewed.reviewed_by.as_deref(), Some("reviewer-1"));
    assert!(reviewed.reviewed_at.is_some());
    assert!(reviewed.applied_memory_id.is_none());
    assert_eq!(store.count().await.unwrap(), 0);

    // A later approval of the already-rejected row is a no-op.
    let again = store
        .review_proposal(&id, true, Some("reviewer-2"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.status, MemoryProposalStatus::Rejected);
    assert_eq!(again.reviewed_by.as_deref(), Some("reviewer-1"));
    assert_eq!(store.count().await.unwrap(), 0);
}

#[tokio::test]
async fn reviewing_an_unknown_proposal_returns_none() {
    let store = MemoryStore::open_in_memory().unwrap();
    assert!(store
        .review_proposal("missing", true, None)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .rollback_proposal("missing", None)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn approving_a_revision_supersedes_the_target_and_is_idempotent() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let id = propose_revision(&store, &target).await;

    let applied = store
        .review_proposal(&id, true, Some("reviewer-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(applied.status, MemoryProposalStatus::Applied);
    assert_eq!(applied.reviewed_by.as_deref(), Some("reviewer-1"));
    let new_id = applied
        .applied_memory_id
        .clone()
        .expect("applied memory id");
    assert_ne!(new_id, target);

    let revision = store.get(&new_id).await.unwrap().unwrap();
    assert_eq!(revision.content, "User prefers green tea");
    assert_eq!(revision.lifecycle, MemoryLifecycle::Active);
    assert_eq!(revision.supersedes_id.as_deref(), Some(target.as_str()));
    assert_eq!(revision.owner_user_id.as_deref(), Some(LOCAL_USER));
    assert_eq!(revision.tags, vec!["dream".to_owned()]);
    let old = store.get(&target).await.unwrap().unwrap();
    assert_eq!(old.lifecycle, MemoryLifecycle::Superseded);

    // Only the revision is recalled now.
    let recalled = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].id, new_id);

    // A second review neither inserts another row nor changes the outcome.
    let again = store
        .review_proposal(&id, true, Some("reviewer-2"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.status, MemoryProposalStatus::Applied);
    assert_eq!(again.applied_memory_id.as_deref(), Some(new_id.as_str()));
    assert_eq!(again.reviewed_by.as_deref(), Some("reviewer-1"));
    let rejected_late = store
        .review_proposal(&id, false, Some("reviewer-3"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rejected_late.status, MemoryProposalStatus::Applied);
    assert_eq!(store.count().await.unwrap(), 2);
}

#[tokio::test]
async fn approving_a_create_inserts_an_active_entry_without_supersedes() {
    let store = MemoryStore::open_in_memory().unwrap();
    let mut new = proposal(LOCAL_USER, None, MemoryProposalOperation::Create, " Ship ");
    new.draft.scope = MemoryScope::Project;
    new.draft.scope_id = Some("/r".to_owned());
    new.draft.category = MemoryCategory::ProjectContext;
    new.draft.importance = 9;
    new.draft.when_to_use = Some(" ci ".to_owned());
    let id = store.create_proposal(new).await.unwrap();
    let applied = store
        .review_proposal(&id, true, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(applied.status, MemoryProposalStatus::Applied);
    let entry = store
        .get(applied.applied_memory_id.as_deref().unwrap())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(entry.content, "Ship");
    assert_eq!(entry.scope_id.as_deref(), Some("/r"));
    assert_eq!(entry.scope, MemoryScope::Project);
    assert_eq!(entry.category, MemoryCategory::ProjectContext);
    assert_eq!(entry.importance, 5);
    assert_eq!(entry.when_to_use.as_deref(), Some("ci"));
    assert_eq!(entry.lifecycle, MemoryLifecycle::Active);
    assert!(entry.supersedes_id.is_none());
}

#[tokio::test]
async fn approval_fails_when_the_target_is_deleted() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let id = propose_revision(&store, &target).await;
    assert!(store.delete(&target).await.unwrap());

    let err = store.review_proposal(&id, true, None).await.unwrap_err();
    assert!(err.to_string().contains("no longer exists"), "{err}");
    let still = store.get_proposal(&id).await.unwrap().unwrap();
    assert_eq!(still.status, MemoryProposalStatus::Pending);
    assert_eq!(store.count().await.unwrap(), 0);
}

#[tokio::test]
async fn approval_fails_when_the_target_is_no_longer_active() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let first = propose_revision(&store, &target).await;
    let second = propose_revision(&store, &target).await;
    store.review_proposal(&first, true, None).await.unwrap();

    let err = store
        .review_proposal(&second, true, None)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no longer active"), "{err}");
    let still = store.get_proposal(&second).await.unwrap().unwrap();
    assert_eq!(still.status, MemoryProposalStatus::Pending);
    assert!(still.applied_memory_id.is_none());
    // Only the original and the first revision exist.
    assert_eq!(store.count().await.unwrap(), 2);
}

#[tokio::test]
async fn approval_rejects_a_scoped_draft_without_scope_id() {
    for scope in [MemoryScope::Agent, MemoryScope::Project, MemoryScope::Org] {
        let store = MemoryStore::open_in_memory().unwrap();
        let id = store
            .create_proposal(proposal(
                LOCAL_USER,
                None,
                MemoryProposalOperation::Create,
                "Deploys go through staging first",
            ))
            .await
            .unwrap();
        let mut bad = draft("Deploys go through staging first");
        bad.scope = scope;
        bad.scope_id = Some("   ".to_owned());
        tamper_draft(&store, &id, bad).await;

        let err = store.review_proposal(&id, true, None).await.unwrap_err();
        assert!(
            err.to_string().contains("requires a scope id"),
            "{scope:?}: {err}"
        );
        assert_eq!(store.count().await.unwrap(), 0, "{scope:?}");
        let still = store.get_proposal(&id).await.unwrap().unwrap();
        assert_eq!(still.status, MemoryProposalStatus::Pending, "{scope:?}");
    }
}

#[tokio::test]
async fn approval_rejects_sensitive_content_outside_user_scope() {
    let store = MemoryStore::open_in_memory().unwrap();
    // Creation already refuses sensitive non-user drafts.
    let mut create_bad = proposal(
        LOCAL_USER,
        None,
        MemoryProposalOperation::Create,
        "User takes medication for a disease",
    );
    create_bad.draft.scope = MemoryScope::Project;
    create_bad.draft.scope_id = Some("/repo".to_owned());
    assert!(store.create_proposal(create_bad).await.is_err());

    let id = store
        .create_proposal(proposal(
            LOCAL_USER,
            None,
            MemoryProposalOperation::Create,
            "Neutral fact",
        ))
        .await
        .unwrap();
    let mut bad = draft("User takes medication for a disease");
    bad.scope = MemoryScope::Project;
    bad.scope_id = Some("/repo".to_owned());
    tamper_draft(&store, &id, bad).await;

    let err = store.review_proposal(&id, true, None).await.unwrap_err();
    assert!(err.to_string().contains("sensitive memory"), "{err}");
    assert_eq!(store.count().await.unwrap(), 0);

    // The same sensitive content at user scope is approvable.
    tamper_draft(&store, &id, draft("User takes medication for a disease")).await;
    let applied = store
        .review_proposal(&id, true, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(applied.status, MemoryProposalStatus::Applied);
    assert_eq!(store.count().await.unwrap(), 1);
}

#[tokio::test]
async fn rollback_retracts_the_revision_and_reactivates_the_target() {
    let store = MemoryStore::open_in_memory().unwrap();
    let target = record_target(&store).await;
    let id = propose_revision(&store, &target).await;

    // Rolling back a pending proposal is a no-op.
    let pending = store
        .rollback_proposal(&id, Some("reviewer-1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pending.status, MemoryProposalStatus::Pending);

    let applied = store
        .review_proposal(&id, true, None)
        .await
        .unwrap()
        .unwrap();
    let new_id = applied.applied_memory_id.unwrap();

    let rolled = store
        .rollback_proposal(&id, Some("reviewer-2"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rolled.status, MemoryProposalStatus::RolledBack);
    assert_eq!(rolled.reviewed_by.as_deref(), Some("reviewer-2"));
    // The audit trail keeps the applied revision id.
    assert_eq!(rolled.applied_memory_id.as_deref(), Some(new_id.as_str()));

    let revision = store.get(&new_id).await.unwrap().unwrap();
    assert_eq!(revision.lifecycle, MemoryLifecycle::Retracted);
    let original = store.get(&target).await.unwrap().unwrap();
    assert_eq!(original.lifecycle, MemoryLifecycle::Active);
    let recalled = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
    assert_eq!(recalled.len(), 1);
    assert_eq!(recalled[0].id, target);

    // A second rollback and a late re-review leave it rolled back.
    let again = store.rollback_proposal(&id, None).await.unwrap().unwrap();
    assert_eq!(again.status, MemoryProposalStatus::RolledBack);
    let review = store
        .review_proposal(&id, true, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(review.status, MemoryProposalStatus::RolledBack);
    assert_eq!(store.count().await.unwrap(), 2);
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
