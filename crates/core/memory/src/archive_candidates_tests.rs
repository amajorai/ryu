//! Archive candidates: unused events are filtered and bounded in SQL, oldest
//! first, so none hides behind newer rows; and an archive the owner declined
//! stays blocked however many proposals came after it.

use rusqlite::params;

use super::*;
use crate::proposal_tests::proposal;

const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
const NOW: i64 = 1_000 * DAY_MS;
const IDLE_BEFORE: i64 = NOW - 90 * DAY_MS;
const OLD: i64 = IDLE_BEFORE - 10 * DAY_MS;

/// A store whose recall tracking started long before every fixture.
async fn store() -> MemoryStore {
    let store = MemoryStore::open_in_memory().unwrap();
    set_tracking_start(&store, 0).await;
    store
}

async fn set_tracking_start(store: &MemoryStore, at: i64) {
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE memory_meta SET value = ?1 WHERE key = 'access_tracking_started_at'",
            params![at.to_string()],
        )
        .unwrap();
}

/// Record a memory owned by `user` with `category`, saved at `created_at`.
async fn saved(
    store: &MemoryStore,
    user: &str,
    category: MemoryCategory,
    content: &str,
    created_at: i64,
) -> String {
    let mut memory = NewMemory::user_fact(content);
    memory.category = category;
    let id = store
        .record_full(user, "agent-a", memory)
        .await
        .unwrap()
        .unwrap();
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE memory_entries SET created_at = ?1 WHERE id = ?2",
            params![created_at, id],
        )
        .unwrap();
    id
}

async fn event(store: &MemoryStore, content: &str, created_at: i64) -> String {
    saved(
        store,
        LOCAL_USER,
        MemoryCategory::Event,
        content,
        created_at,
    )
    .await
}

fn query(limit: usize) -> UnusedEventQuery<'static> {
    UnusedEventQuery {
        idle_before: IDLE_BEFORE,
        owner_user_id: None,
        archive_owner: LOCAL_USER,
        limit,
    }
}

async fn unused(store: &MemoryStore, query: &UnusedEventQuery<'_>) -> Vec<String> {
    store
        .unused_event_memories(query, MemoryVisibility::unrestricted(), true)
        .await
        .unwrap()
        .into_iter()
        .map(|entry| entry.id)
        .collect()
}

/// Create an archive proposal for `target` and move it to `status`.
async fn archive_proposal(
    store: &MemoryStore,
    owner: &str,
    target: &str,
    operation: MemoryProposalOperation,
    status: MemoryProposalStatus,
) {
    let id = store
        .create_proposal(proposal(owner, Some(target), operation, "draft"))
        .await
        .unwrap();
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE memory_proposals SET status = ?1 WHERE id = ?2",
            params![status.as_str(), id],
        )
        .unwrap();
}

#[tokio::test]
async fn unused_events_are_old_never_recalled_active_events_oldest_first() {
    let store = store().await;
    event(&store, "recent", IDLE_BEFORE + DAY_MS).await;
    saved(
        &store,
        LOCAL_USER,
        MemoryCategory::Preference,
        "preference",
        OLD,
    )
    .await;
    let recalled = event(&store, "recalled", OLD).await;
    store.mark_recalled(&[recalled], NOW).await.unwrap();
    let archived = event(&store, "archived", OLD).await;
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE memory_entries SET lifecycle = 'archived' WHERE id = ?1",
            params![archived],
        )
        .unwrap();
    let mut stale = Vec::new();
    for n in 0..7 {
        stale.push(event(&store, &format!("stale {n}"), OLD - n * DAY_MS).await);
    }

    let found = unused(&store, &query(5)).await;
    // Oldest first: the last fixtures were saved earliest.
    let expected: Vec<String> = stale.iter().rev().take(5).cloned().collect();
    assert_eq!(found, expected);
}

#[tokio::test]
async fn an_event_saved_before_tracking_needs_the_full_window_after_it() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = event(&store, "Flew to Lisbon", DAY_MS).await;

    // Tracking started after the cutoff: the zero count proves nothing yet.
    set_tracking_start(&store, IDLE_BEFORE + DAY_MS).await;
    assert!(unused(&store, &query(5)).await.is_empty());
    set_tracking_start(&store, IDLE_BEFORE).await;
    assert!(unused(&store, &query(5)).await.is_empty());

    set_tracking_start(&store, IDLE_BEFORE - DAY_MS).await;
    assert_eq!(unused(&store, &query(5)).await, [id]);
}

#[tokio::test]
async fn an_old_candidate_is_found_behind_more_than_500_newer_events() {
    let store = store().await;
    let oldest = event(&store, "Conference in Porto", OLD - 1_000 * 60).await;
    let mut newer = Vec::new();
    for n in 0..600_i64 {
        newer.push(event(&store, &format!("Recalled event {n}"), OLD + n).await);
    }
    // The 600 newer events were all used, so none of them is a candidate.
    for chunk in newer.chunks(MAX_MARK_RECALLED_IDS) {
        store.mark_recalled(chunk, NOW).await.unwrap();
    }
    assert_eq!(unused(&store, &query(5)).await, [oldest.clone()]);

    // With 600 newer candidates too, the oldest still comes first.
    for n in 0..600_i64 {
        event(&store, &format!("Unused event {n}"), OLD + n).await;
    }
    let found = unused(&store, &query(5)).await;
    assert_eq!(found.len(), 5);
    assert_eq!(found[0], oldest);
}

#[tokio::test]
async fn declined_archives_stay_blocked_behind_hundreds_of_later_proposals() {
    let store = store().await;
    let mut declined = Vec::new();
    for n in 0..250_i64 {
        let rejected = event(&store, &format!("Rejected {n}"), OLD - 2_000 + n).await;
        archive_proposal(
            &store,
            LOCAL_USER,
            &rejected,
            MemoryProposalOperation::Archive,
            MemoryProposalStatus::Rejected,
        )
        .await;
        let rolled_back = event(&store, &format!("Rolled back {n}"), OLD - 1_000 + n).await;
        archive_proposal(
            &store,
            LOCAL_USER,
            &rolled_back,
            MemoryProposalOperation::Archive,
            MemoryProposalStatus::RolledBack,
        )
        .await;
        declined.push(rejected);
        declined.push(rolled_back);
    }
    // Neither a rejected revision nor another owner's decline blocks an archive.
    let revision_rejected = event(&store, "Revision rejected", OLD).await;
    archive_proposal(
        &store,
        LOCAL_USER,
        &revision_rejected,
        MemoryProposalOperation::Revise,
        MemoryProposalStatus::Rejected,
    )
    .await;
    let declined_elsewhere = event(&store, "Declined by someone else", OLD + 1).await;
    archive_proposal(
        &store,
        "someone-else",
        &declined_elsewhere,
        MemoryProposalOperation::Archive,
        MemoryProposalStatus::Rejected,
    )
    .await;
    // A pending proposal of any kind blocks.
    let pending = event(&store, "Revision pending", OLD + 2).await;
    archive_proposal(
        &store,
        LOCAL_USER,
        &pending,
        MemoryProposalOperation::Revise,
        MemoryProposalStatus::Pending,
    )
    .await;
    let fresh = event(&store, "Never proposed", OLD + 3).await;

    assert_eq!(
        unused(&store, &query(5)).await,
        [
            revision_rejected.clone(),
            declined_elsewhere.clone(),
            fresh.clone()
        ]
    );

    let mut all = declined.clone();
    all.extend([
        revision_rejected.clone(),
        declined_elsewhere.clone(),
        pending.clone(),
        fresh.clone(),
    ]);
    let blocked = store
        .archive_blocked_targets(LOCAL_USER, &all)
        .await
        .unwrap();
    assert_eq!(blocked.len(), declined.len() + 1);
    assert!(declined.iter().all(|id| blocked.contains(id)));
    assert!(blocked.contains(&pending));
    for open in [&revision_rejected, &declined_elsewhere, &fresh] {
        assert!(!blocked.contains(open), "{open}");
    }
    assert!(store
        .archive_blocked_targets("someone-else", &[declined_elsewhere.clone()])
        .await
        .unwrap()
        .contains(&declined_elsewhere));
    assert!(store
        .archive_blocked_targets(LOCAL_USER, &[])
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn owner_visibility_and_sensitive_rows_are_filtered_before_the_limit() {
    let store = store().await;
    let sensitive = event(&store, "Hospital stay for the illness", OLD - 3).await;
    let theirs = saved(&store, "bob", MemoryCategory::Event, "Bob's trip", OLD - 2).await;
    let mine = saved(
        &store,
        "alice",
        MemoryCategory::Event,
        "Alice's trip",
        OLD - 1,
    )
    .await;

    let alice = UnusedEventQuery {
        owner_user_id: Some("alice"),
        archive_owner: "alice",
        ..query(1)
    };
    let bound = MemoryVisibility::for_caller(Some("alice"), true);
    let found = store
        .unused_event_memories(&alice, bound, true)
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, mine);

    // Without consent the sensitive row is skipped and the next one fills in.
    let found = store
        .unused_event_memories(&query(1), MemoryVisibility::unrestricted(), false)
        .await
        .unwrap();
    assert_eq!(found[0].id, theirs);
    assert_eq!(unused(&store, &query(1)).await, [sensitive]);
    assert!(unused(&store, &query(0)).await.is_empty());
}
