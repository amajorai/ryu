//! Conversation store tests: search backfill.

use super::*;

#[tokio::test]
async fn search_messages_none_without_index() {
    // No index wired (open_in_memory) → search returns None, never errors.
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "hello world", None, None, None)
        .await
        .unwrap();
    let res = store.search_messages("hello", 5, None).await.unwrap();
    assert!(res.is_none());
}

#[tokio::test]
async fn usage_metadata_pages_never_decrypt_bodies_or_return_conversation_parts() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("usage-fixture", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    let id = store
        .append_message_as(
            "usage-fixture",
            "assistant",
            "private body",
            Some("acp:codex"),
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    store.update_message_parts(&id, &serde_json::json!([
        {"type":"text","text":"private text part"},
        {"type":"data-ryu-stats","data":{"done":true,"promptTokens":10,"completionTokens":3,"used":100,"sessionCostAmount":50,"credential":"private credential","historyEventId":"ryu-turn:fixture"}}
    ]).to_string()).await.unwrap();
    store.content_reads.store(0, Ordering::Relaxed);
    let page = store.usage_metadata_page(0, 1).await.unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!(page[0].5.len(), 1);
    assert_eq!(page[0].5[0]["promptTokens"], 10);
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 0);
    let encoded = serde_json::to_string(&page).unwrap();
    assert!(!encoded.contains("private"));
    assert!(!encoded.contains("sessionCostAmount"));
    assert!(!encoded.contains("\"used\""));
    assert!(store
        .usage_metadata_page(page[0].0, 1)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn search_backfill_warm_reads_only_new_imports_and_retries_after_reset() {
    let semantic = crate::search_host::in_memory_message_index().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_index(semantic)
        .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap());
    store
        .ensure_conversation("search-perf", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    // Raw inserts exercise the same trigger used by import/sync/fork, with
    // equal historical timestamps rather than an append-time watermark.
    {
        let conn = store.conn.lock().await;
        for number in 0..300 {
            conn.execute(
                "INSERT INTO messages(id, conversation_id, role, content, created_at)
                     VALUES (?1, 'search-perf', 'user', 'searchable history', 1)",
                [format!("history-{number}")],
            )
            .unwrap();
        }
    }
    store.set_chat_memory_enabled(true).await.unwrap();
    for lexical in [false, true] {
        let lock = if lexical {
            &store.fts_backfill
        } else {
            &store.semantic_backfill
        };
        let mut initialized = lock.lock().await;
        store.content_reads.store(0, Ordering::Relaxed);
        store
            .reconcile_search_index(lexical, &mut initialized)
            .await
            .unwrap();
        assert_eq!(store.content_reads.load(Ordering::Relaxed), 300);
        store.content_reads.store(0, Ordering::Relaxed);
        store
            .reconcile_search_index(lexical, &mut initialized)
            .await
            .unwrap();
        assert_eq!(
            store.content_reads.load(Ordering::Relaxed),
            0,
            "warm search reads no bodies"
        );
        if !lexical {
            {
                let conn = store.conn.lock().await;
                conn.execute(
                    "INSERT INTO message_search_pending(kind, message_id) VALUES (0, 'history-0')",
                    [],
                )
                .unwrap();
            }
            store
                .reconcile_search_index(false, &mut initialized)
                .await
                .unwrap();
            assert_eq!(
                store.content_reads.load(Ordering::Relaxed),
                0,
                "successful append indexing is not repeated"
            );
            {
                let conn = store.conn.lock().await;
                conn.execute(
                    "UPDATE messages SET content = 'updated history' WHERE id = 'history-0'",
                    [],
                )
                .unwrap();
            }
            store
                .reconcile_search_index(false, &mut initialized)
                .await
                .unwrap();
            assert_eq!(
                store.content_reads.load(Ordering::Relaxed),
                1,
                "an edit still refreshes an existing embedding"
            );
        }
    }
    store
        .set_message_embedder(store.message_index.as_ref().unwrap().embedder())
        .await
        .unwrap();
    assert!(
        !*store.semantic_backfill.lock().await,
        "provider swaps invalidate reconciliation"
    );
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO messages(id, conversation_id, role, content, created_at)
                 VALUES ('late-import', 'search-perf', 'user', 'imported history', 0)",
            [],
        )
        .unwrap();
    }
    store.content_reads.store(0, Ordering::Relaxed);
    let hits = store
        .fts_search_messages("imported", 5, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id, "late-import");
    assert_eq!(
        store.content_reads.load(Ordering::Relaxed),
        2,
        "one backfill and one hit snippet"
    );
    store.clear_message_embeddings().await.unwrap();
    store.content_reads.store(0, Ordering::Relaxed);
    let mut initialized = store.semantic_backfill.lock().await;
    store
        .reconcile_search_index(false, &mut initialized)
        .await
        .unwrap();
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 301);
}

#[tokio::test]
async fn search_same_width_provider_change_reindexes_acknowledged_history() {
    let index = crate::search_host::in_memory_message_index().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_index(index.clone());
    let id = store
        .append_message(
            "provider-change",
            "user",
            "retained history",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .search_messages("retained history", 5, None)
        .await
        .unwrap();
    let embedder = index.embedder();
    let vector = embedder.embed("retained history").await.unwrap();
    // Keep the existing vector width while simulating metadata written by
    // the previous provider. The pending queue was already acknowledged.
    index
        .index_message(&id, "provider-change", "user", &vector, "previous-model", 1)
        .await
        .unwrap();
    assert!(index
        .search("retained history", 5, None)
        .await
        .unwrap()
        .is_empty());
    // Settings/startup use this setter followed by the coordinated reindex.
    store.set_message_embedder(embedder.clone()).await.unwrap();
    assert_eq!(store.reindex_message_embeddings().await.unwrap(), 1);
    assert!(index
        .stale_ids(embedder.model_id(), embedder.dims())
        .await
        .unwrap()
        .is_empty());
    let hits = store
        .search_messages("retained history", 5, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id, id);
    store.content_reads.store(0, Ordering::Relaxed);
    let mut initialized = store.semantic_backfill.lock().await;
    store
        .reconcile_search_index(false, &mut initialized)
        .await
        .unwrap();
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn search_pending_revisions_survive_stale_ack_and_remove_deleted_messages() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("queue", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    conn.execute(
        "INSERT INTO messages(id, conversation_id, role, content, created_at)
            VALUES ('revision', 'queue', 'user', 'before', 1)",
        [],
    )
    .unwrap();
    let revision: i64 = conn.query_row(
        "SELECT revision FROM message_search_pending WHERE kind = 0 AND message_id = 'revision'",
        [], |row| row.get(0),
    ).unwrap();
    conn.execute(
        "UPDATE messages SET content = 'after' WHERE id = 'revision'",
        [],
    )
    .unwrap();
    conn.execute(
        "DELETE FROM message_search_pending WHERE revision = ?1",
        [revision],
    )
    .unwrap();
    let queued: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_search_pending", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(queued, 2, "each index retains its newer pending revision");
    conn.execute("DELETE FROM messages WHERE id = 'revision'", [])
        .unwrap();
    let queued: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_search_pending", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(queued, 0);
}

#[tokio::test]
async fn search_backfill_query_uses_indexed_pending_ids_not_a_message_scan() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conn = store.conn.lock().await;
    let mut statement = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {MESSAGE_SEARCH_BATCH_SQL}"))
        .unwrap();
    let plan = statement
        .query_map(params![0, 0, 1000], |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH p USING INDEX idx_message_search_pending_kind")),
        "{plan:?}"
    );
    assert!(
        plan.iter()
            .any(|step| step.contains("SEARCH m USING INDEX sqlite_autoindex_messages")),
        "{plan:?}"
    );
    assert!(!plan.iter().any(|step| step.contains("SCAN")), "{plan:?}");
}

#[tokio::test]
async fn search_backfill_failed_metadata_read_stays_retryable_and_clones_share_ownership() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("fts.db");
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(ryu_search::MessageFtsIndex::open(path.clone()).unwrap());
    store
        .append_message("failure", "user", "retryable message", None, None, None)
        .await
        .unwrap();
    store.set_chat_memory_enabled(true).await.unwrap();
    Connection::open(&path)
        .unwrap()
        .execute_batch("DROP TABLE fts_messages")
        .unwrap();
    assert!(store.fts_search_messages("missing", 5, None).await.is_err());
    assert!(
        !*store.fts_backfill.lock().await,
        "failed metadata read must not complete reconciliation"
    );
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 0);
    // Reopening recreates the missing metadata table. Existing store clones
    // still share their connection and backfill owner across both requests.
    drop(ryu_search::MessageFtsIndex::open(path).unwrap());
    let clone = store.clone();
    let (first, second) = tokio::join!(
        store.fts_search_messages("missing", 5, None),
        clone.fts_search_messages("missing", 5, None),
    );
    assert!(first.is_ok());
    assert!(second.is_ok());
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 1);
}

#[tokio::test]
async fn search_backfill_reopen_recovers_pending_and_reconciles_existing_ids_once() {
    let temp = tempfile::tempdir().unwrap();
    let database = temp.path().join("conversations.db");
    let index_path = temp.path().join("message-fts.db");
    {
        let mut store = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(ryu_search::MessageFtsIndex::open(index_path.clone()).unwrap());
        let conn = Connection::open(&database).unwrap();
        ConversationStore::init_schema(&conn).unwrap();
        store.conn = Arc::new(Mutex::new(conn));
        store
            .append_message(
                "restart",
                "user",
                "indexed before restart",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store.set_chat_memory_enabled(true).await.unwrap();
        store.fts_search_messages("indexed", 5, None).await.unwrap();
        // Simulate shutdown after persist but before the next backfill.
        store
            .append_message("restart", "user", "pending at shutdown", None, None, None)
            .await
            .unwrap();
    }
    let mut reopened = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(ryu_search::MessageFtsIndex::open(index_path).unwrap());
    let conn = Connection::open(database).unwrap();
    ConversationStore::init_schema(&conn).unwrap();
    reopened.conn = Arc::new(Mutex::new(conn));
    reopened.set_chat_memory_enabled(true).await.unwrap();
    let mut initialized = reopened.fts_backfill.lock().await;
    reopened
        .reconcile_search_index(true, &mut initialized)
        .await
        .unwrap();
    assert_eq!(
        reopened.content_reads.load(Ordering::Relaxed),
        1,
        "only the unacknowledged message is opened after restart"
    );
    reopened.content_reads.store(0, Ordering::Relaxed);
    reopened
        .reconcile_search_index(true, &mut initialized)
        .await
        .unwrap();
    assert_eq!(reopened.content_reads.load(Ordering::Relaxed), 0);
    drop(initialized);
    assert_eq!(
        reopened
            .fts_search_messages("shutdown", 5, None)
            .await
            .unwrap()
            .unwrap()
            .len(),
        1
    );
}
