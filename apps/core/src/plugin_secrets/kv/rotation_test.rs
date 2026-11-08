use rusqlite::params;

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;

const DAY: i64 = 24 * 3600 * 1000;

async fn set_created(store: &PluginSecretStore, version: u32, created_at: i64) {
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE vault_keyring SET created_at = ?1 WHERE version = ?2",
            params![created_at, version],
        )
        .unwrap();
}

async fn row_versions(store: &PluginSecretStore) -> Vec<u32> {
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT key_version FROM plugin_secrets ORDER BY key_version")
        .unwrap();
    let rows = stmt.query_map([], |row| row.get(0)).unwrap();
    rows.collect::<rusqlite::Result<Vec<u32>>>().unwrap()
}

#[tokio::test]
async fn rewrap_prunes_retired_keys_once_nothing_uses_them() {
    let store = PluginSecretStore::in_memory().unwrap();
    store.set("plug", "token", "s3cret").await.unwrap();
    {
        let conn = store.conn.lock().await;
        store.keyring.rotate(&conn).unwrap();
    }
    // v2 superseded v1 long ago, so v1 is outside its grace window.
    set_created(&store, 2, 0).await;
    {
        let conn = store.conn.lock().await;
        store.keyring.rotate(&conn).unwrap();
    }
    let rows = store.rewrap_all(&AuditActor::system()).await.unwrap();
    assert_eq!(rows, 1);
    assert_eq!(row_versions(&store).await, vec![3]);
    // v1 is gone; v2 was superseded just now and stays for the grace window.
    assert_eq!(store.keyring.status().key_versions, vec![2, 3]);
    assert_eq!(
        store.get("plug", "token").await.unwrap().as_deref(),
        Some("s3cret")
    );
}

#[tokio::test]
async fn pruning_keeps_a_retired_key_a_row_still_uses() {
    let store = PluginSecretStore::in_memory().unwrap();
    store.set("plug", "token", "s3cret").await.unwrap();
    {
        let conn = store.conn.lock().await;
        store.keyring.rotate(&conn).unwrap();
    }
    set_created(&store, 2, 0).await;
    // No rewrap: the row still uses v1.
    assert!(store
        .prune_keyring(&AuditActor::system())
        .await
        .unwrap()
        .is_empty());
    assert_eq!(store.keyring.status().key_versions, vec![1, 2]);
    assert_eq!(
        store.get("plug", "token").await.unwrap().as_deref(),
        Some("s3cret")
    );
}

#[tokio::test]
async fn scheduled_maintenance_rotates_a_due_key_and_rewraps() {
    let store = PluginSecretStore::in_memory().unwrap();
    store.set("plug", "token", "s3cret").await.unwrap();

    let idle = store.keyring_maintain(DAY).await.unwrap();
    assert_eq!(idle.rotated, None, "a fresh key is not due");

    set_created(&store, 1, 0).await;
    assert_eq!(store.keyring_maintain(0).await.unwrap().rotated, None);
    let report = store.keyring_maintain(DAY).await.unwrap();
    assert_eq!(report.rotated, Some(2));
    assert_eq!(report.rewrapped, 1);
    assert_eq!(row_versions(&store).await, vec![2]);
    assert_eq!(store.keyring.active_version(), 2);

    // Past the grace window, the next pass deletes v1.
    set_created(&store, 2, crate::vault::now_millis() - DAY / 2).await;
    let next = store.keyring_maintain(DAY).await.unwrap();
    assert_eq!(next.rotated, None);
    assert_eq!(next.pruned, vec![1]);
    assert_eq!(
        store.get("plug", "token").await.unwrap().as_deref(),
        Some("s3cret")
    );
}
