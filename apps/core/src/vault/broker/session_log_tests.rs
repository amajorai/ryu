use super::*;

fn entry(at: i64, path: &str) -> SessionLogEntry {
    SessionLogEntry {
        at,
        method: "POST".into(),
        scheme: "https".into(),
        host: "mcp.example.com".into(),
        port: 443,
        path: path.into(),
        status: 200,
        outcome: "forwarded".into(),
        ..SessionLogEntry::default()
    }
}

#[tokio::test]
async fn entries_are_sealed_at_rest_and_read_newest_first() {
    let store = PluginSecretStore::in_memory().unwrap();
    let mut first = entry(1, "/mcp");
    first.rpc = vec![RpcCall {
        method: "tools/call".into(),
        id: Some("1".into()),
        tool: Some("create_issue".into()),
    }];
    first.on_behalf_of = Some("user:alice".into());
    append(&store, "bvs_a", first.clone()).await.unwrap();
    append(&store, "bvs_a", entry(2, "/mcp/second"))
        .await
        .unwrap();
    append(&store, "bvs_b", entry(3, "/other")).await.unwrap();

    let read_back = read(&store, "bvs_a", 10).await.unwrap();
    assert_eq!(read_back.len(), 2);
    assert_eq!(read_back[0].path, "/mcp/second");
    assert_eq!(read_back[1], first);
    assert_eq!(read(&store, "bvs_a", 1).await.unwrap().len(), 1);
    assert_eq!(read(&store, "bvs_missing", 10).await.unwrap(), Vec::new());

    // The stored bytes are ciphertext: neither the tool name nor the path is
    // readable from the database.
    let conn = store.conn.lock().await;
    let mut stmt = conn
        .prepare("SELECT ciphertext FROM plugin_secrets WHERE plugin_id = ?1")
        .unwrap();
    let blobs: Vec<Vec<u8>> = stmt
        .query_map(["vault-broker-session-log:bvs_a"], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(blobs.len(), 1);
    let text = String::from_utf8_lossy(&blobs[0]);
    assert!(!text.contains("create_issue"));
    assert!(!text.contains("/mcp/second"));
}

#[tokio::test]
async fn chunks_roll_over_and_the_oldest_are_dropped() {
    let store = PluginSecretStore::in_memory().unwrap();
    let total = CHUNK_ENTRIES * (MAX_CHUNKS + 2) + 3;
    for at in 0..total {
        append(&store, "bvs_long", entry(at as i64, "/x"))
            .await
            .unwrap();
    }
    let keys = store
        .list_keys("vault-broker-session-log:bvs_long")
        .await
        .unwrap();
    assert_eq!(keys.len(), MAX_CHUNKS);
    let entries = read(&store, "bvs_long", MAX_READ).await.unwrap();
    assert_eq!(entries[0].at, total as i64 - 1);
    // Whole chunks are dropped, oldest first.
    assert!(entries.len() <= MAX_READ);
    assert!(entries.last().unwrap().at >= (CHUNK_ENTRIES * 2) as i64);
}

#[tokio::test]
async fn old_chunks_are_pruned_and_other_secrets_are_kept() {
    let store = PluginSecretStore::in_memory().unwrap();
    append(&store, "bvs_old", entry(1, "/x")).await.unwrap();
    store.set("other-plugin", "token", "value").await.unwrap();
    let now = crate::vault::now_millis();
    let conn = store.conn.lock().await;
    assert_eq!(prune(&conn, now, 0).unwrap(), 0);
    assert_eq!(prune(&conn, now, 1).unwrap(), 0);
    assert_eq!(prune(&conn, now + 2 * HOUR_MILLIS, 1).unwrap(), 1);
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM plugin_secrets", [], |row| row.get(0))
        .unwrap();
    assert_eq!(left, 1);
}

#[test]
fn entries_copy_the_value_free_row() {
    let row = LogRow {
        at: 5,
        method: "GET".into(),
        scheme: "https".into(),
        host: "api.example.com".into(),
        port: 443,
        path: "/v1".into(),
        service: Some("svc".into()),
        status: 403,
        latency_ms: 3,
        outcome: "forbidden".into(),
        ..LogRow::default()
    };
    let entry = SessionLogEntry::from_row(&row, Vec::new(), Some("user:u1".into()));
    assert_eq!(entry.outcome, "forbidden");
    assert_eq!(entry.service.as_deref(), Some("svc"));
    assert_eq!(entry.on_behalf_of.as_deref(), Some("user:u1"));
}
