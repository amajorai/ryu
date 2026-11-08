//! Opening the store: the bind-time owner backfill.

use rusqlite::params;

use super::*;

/// The bind-time `'local' → owner` backfill (the memory twin of the conversation
/// backfill). Driven directly against the SQL so it needs no org registration:
/// a pre-ACL `'local'` user row is invisible to a real caller until re-stamped.
#[tokio::test]
async fn local_rows_backfill_to_owner() {
    let store = MemoryStore::open_in_memory().unwrap();
    let id = store
        .record(LOCAL_USER, "a", "legacy fact recorded before ACL")
        .await
        .unwrap()
        .unwrap();

    // Before backfill, a bound-node caller "alice" cannot see the 'local' row.
    let before = store
        .list_visible(
            &MemoryFilter::default(),
            MemoryVisibility::for_caller(Some("alice"), true),
        )
        .await
        .unwrap();
    assert!(
        before.is_empty(),
        "pre-backfill 'local' user row is invisible to a real caller (fail closed)"
    );

    // Simulate the backfill's UPDATE ('local' → the local owner) directly.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE memory_entries SET user_id = ?1 WHERE user_id = ?2",
            params!["alice", LOCAL_USER],
        )
        .unwrap();
    }

    let after = store
        .list_visible(
            &MemoryFilter::default(),
            MemoryVisibility::for_caller(Some("alice"), true),
        )
        .await
        .unwrap();
    assert_eq!(
        after.len(),
        1,
        "after backfill the owner reaches their legacy fact"
    );
    assert_eq!(after[0].id, id);
    assert_eq!(after[0].owner_user_id.as_deref(), Some("alice"));
}
