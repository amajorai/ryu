//! Access tracking: `mark_recalled` bumps active rows once per call, ignores
//! inactive rows, blank and repeated ids, and never edits `updated_at`; the
//! database stamps once when it started tracking.

use rusqlite::params;

use super::*;

async fn record(store: &MemoryStore, content: &str) -> String {
    store
        .record(LOCAL_USER, "agent-a", content)
        .await
        .unwrap()
        .unwrap()
}

#[tokio::test]
async fn a_new_memory_has_never_been_recalled() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = record(&store, "User prefers tea").await;
    let entry = store.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.recall_count, 0);
    assert_eq!(entry.last_recalled_at, None);
}

#[tokio::test]
async fn mark_recalled_counts_each_turn_and_keeps_the_latest_time() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = record(&store, "User prefers tea").await;
    let before = store.get(&id).await.unwrap().unwrap();

    let ids = vec![id.clone(), id.clone(), "  ".to_owned()];
    assert_eq!(store.mark_recalled(&ids, 2_000).await.unwrap(), 1);
    // An older timestamp still counts the turn but never moves the time back.
    assert_eq!(store.mark_recalled(&ids, 1_000).await.unwrap(), 1);

    let entry = store.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.recall_count, 2);
    assert_eq!(entry.last_recalled_at, Some(2_000));
    assert_eq!(entry.updated_at, before.updated_at);
}

#[tokio::test]
async fn mark_recalled_skips_inactive_and_unknown_rows() {
    let store = MemoryStore::open_in_memory().unwrap();
    let active = record(&store, "User prefers tea").await;
    let archived = record(&store, "Trip to Lisbon next week").await;
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE memory_entries SET lifecycle = 'archived' WHERE id = ?1",
            params![archived],
        )
        .unwrap();

    let ids = vec![active.clone(), archived.clone(), "missing".to_owned()];
    assert_eq!(store.mark_recalled(&ids, 5).await.unwrap(), 1);
    assert_eq!(store.get(&active).await.unwrap().unwrap().recall_count, 1);
    let untouched = store.get(&archived).await.unwrap().unwrap();
    assert_eq!(untouched.recall_count, 0);
    assert_eq!(untouched.last_recalled_at, None);
}

#[tokio::test]
async fn mark_recalled_with_no_ids_changes_nothing() {
    let store = MemoryStore::open_in_memory().unwrap();
    record(&store, "User prefers tea").await;
    assert_eq!(store.mark_recalled(&[], 5).await.unwrap(), 0);
    assert_eq!(store.mark_recalled(&[String::new()], 5).await.unwrap(), 0);
}

#[tokio::test]
async fn mark_recalled_applies_at_most_the_bounded_number_of_ids() {
    let store = MemoryStore::open_in_memory().unwrap();
    let mut ids = Vec::new();
    for n in 0..MAX_MARK_RECALLED_IDS + 3 {
        ids.push(record(&store, &format!("Fact number {n}")).await);
    }
    assert_eq!(
        store.mark_recalled(&ids, 9).await.unwrap(),
        MAX_MARK_RECALLED_IDS
    );
    let last = store.get(ids.last().unwrap()).await.unwrap().unwrap();
    assert_eq!(last.recall_count, 0);
}

#[tokio::test]
async fn a_legacy_row_with_null_counters_reads_as_never_recalled_and_can_be_bumped() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = record(&store, "User prefers tea").await;
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE memory_entries SET recall_count = NULL, last_recalled_at = NULL
             WHERE id = ?1",
            params![id],
        )
        .unwrap();
    assert_eq!(store.get(&id).await.unwrap().unwrap().recall_count, 0);

    store.mark_recalled(&[id.clone()], 7).await.unwrap();
    let entry = store.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.recall_count, 1);
    assert_eq!(entry.last_recalled_at, Some(7));
}

#[tokio::test]
async fn the_access_tracking_start_is_stamped_once_and_kept() {
    let before = crate::now_millis();
    let store = MemoryStore::open_in_memory().unwrap();
    let started = store.access_tracking_started_at().await.unwrap();
    assert!(started >= before && started <= crate::now_millis());

    // Every later open runs the schema again; the first stamp stands.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_meta SET value = '5' WHERE key = ?1",
            params![crate::access::ACCESS_TRACKING_STARTED_KEY],
        )
        .unwrap();
        MemoryStore::init_schema(&conn).unwrap();
    }
    assert_eq!(store.access_tracking_started_at().await.unwrap(), 5);
}

#[tokio::test]
async fn a_missing_access_tracking_start_reads_as_now() {
    let store = MemoryStore::open_in_memory().unwrap();
    store
        .conn
        .lock()
        .await
        .execute("DELETE FROM memory_meta", [])
        .unwrap();
    let before = crate::now_millis();
    let started = store.access_tracking_started_at().await.unwrap();
    assert!(started >= before);
}
