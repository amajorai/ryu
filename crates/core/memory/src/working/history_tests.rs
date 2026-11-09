//! Working-memory history: every write snapshots its version, the history is
//! capped, owner-isolated, encrypted at rest, and deleted with its document.

use super::*;
use crate::MemoryStore;
use ryu_kernel_contracts::ResourceKey;
use serde_json::json;

fn alice() -> ResourceKey {
    ResourceKey::owned(Some("alice"), None)
}

fn bob() -> ResourceKey {
    ResourceKey::owned(Some("bob"), None)
}

async fn write(store: &MemoryStore, key: &ResourceKey, id: &str, content: &str) -> WorkingMemory {
    store
        .put_working_memory(
            key,
            WorkingMemoryScope::Thread,
            id,
            WorkingMemoryWrite {
                content: Some(content.to_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap()
}

async fn history_rows(store: &MemoryStore) -> i64 {
    let conn = store.conn.lock().await;
    conn.query_row("SELECT COUNT(*) FROM memory_working_history", [], |row| {
        row.get(0)
    })
    .unwrap()
}

#[tokio::test]
async fn each_write_is_snapshotted_newest_first() {
    let store = MemoryStore::open_in_memory().unwrap();
    assert!(store
        .working_memory_history(&alice(), WorkingMemoryScope::Thread, "t")
        .await
        .unwrap()
        .is_empty());
    write(&store, &alice(), "t", "first").await;
    let latest = write(&store, &alice(), "t", "second").await;
    let history = store
        .working_memory_history(&alice(), WorkingMemoryScope::Thread, " t ")
        .await
        .unwrap();
    let versions: Vec<(i64, Option<&str>)> = history
        .iter()
        .map(|doc| (doc.version, doc.content.as_deref()))
        .collect();
    assert_eq!(versions, vec![(2, Some("second")), (1, Some("first"))]);
    // The newest snapshot is exactly the stored document.
    assert_eq!(history[0], latest);
}

#[tokio::test]
async fn history_is_capped_per_document() {
    let store = MemoryStore::open_in_memory().unwrap();
    let total = WORKING_MEMORY_HISTORY_LIMIT + 5;
    for n in 1..=total {
        write(&store, &alice(), "t", &format!("v{n}")).await;
    }
    write(&store, &alice(), "other", "kept").await;
    let history = store
        .working_memory_history(&alice(), WorkingMemoryScope::Thread, "t")
        .await
        .unwrap();
    assert_eq!(history.len() as i64, WORKING_MEMORY_HISTORY_LIMIT);
    assert_eq!(history[0].version, total);
    assert_eq!(
        history.last().unwrap().version,
        total - WORKING_MEMORY_HISTORY_LIMIT + 1
    );
    // Pruning one document never touches another's history.
    assert_eq!(history_rows(&store).await, WORKING_MEMORY_HISTORY_LIMIT + 1);
}

#[tokio::test]
async fn refused_writes_leave_no_snapshot() {
    let store = MemoryStore::open_in_memory().unwrap();
    write(&store, &alice(), "t", "v1").await;
    let stale = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                content: Some("lost".into()),
                expected_version: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(stale.downcast_ref::<WorkingMemoryError>().is_some());
    let invalid = store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Thread,
            "t",
            WorkingMemoryWrite {
                data: Some(json!({ "a": 1 })),
                ..Default::default()
            },
        )
        .await
        .unwrap_err();
    assert!(invalid.downcast_ref::<WorkingMemoryError>().is_some());
    assert_eq!(history_rows(&store).await, 1);
}

#[tokio::test]
async fn history_is_owner_isolated_and_deleted_with_the_document() {
    let store = MemoryStore::open_in_memory().unwrap();
    write(&store, &alice(), "t", "alice v1").await;
    write(&store, &alice(), "t", "alice v2").await;
    write(&store, &bob(), "t", "bob v1").await;
    store
        .put_working_memory(
            &alice(),
            WorkingMemoryScope::Resource,
            "t",
            WorkingMemoryWrite {
                content: Some("resource".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let bobs = store
        .working_memory_history(&bob(), WorkingMemoryScope::Thread, "t")
        .await
        .unwrap();
    assert_eq!(bobs.len(), 1);
    assert_eq!(bobs[0].content.as_deref(), Some("bob v1"));

    assert!(store
        .delete_working_memory(&alice(), WorkingMemoryScope::Resource, "t")
        .await
        .unwrap());
    assert!(store
        .working_memory_history(&alice(), WorkingMemoryScope::Resource, "t")
        .await
        .unwrap()
        .is_empty());
    assert_eq!(history_rows(&store).await, 3);

    // Deleting the conversation removes every owner's thread history for it.
    assert_eq!(store.delete_thread_working_memory("t").await.unwrap(), 2);
    assert_eq!(history_rows(&store).await, 0);
    // A recreated document starts a fresh history at version 1.
    let fresh = write(&store, &alice(), "t", "again").await;
    assert_eq!(fresh.version, 1);
    let history = store
        .working_memory_history(&alice(), WorkingMemoryScope::Thread, "t")
        .await
        .unwrap();
    assert_eq!(history, vec![fresh]);
}

#[tokio::test]
async fn snapshots_are_encrypted_at_rest() {
    let store = MemoryStore::open_in_memory().unwrap();
    write(&store, &alice(), "t", "secret plan: launch on friday").await;
    let conn = store.conn.lock().await;
    let raw: Vec<u8> = conn
        .query_row("SELECT ciphertext FROM memory_working_history", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains("secret plan"));
}
