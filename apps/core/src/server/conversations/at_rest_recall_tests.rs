//! At-rest sealing and recall tests for the conversation database.

use super::*;

async fn raw_text(store: &ConversationStore, sql: &str, id: &str) -> Option<String> {
    let conn = store.conn.lock().await;
    conn.query_row(sql, [id], |row| row.get(0)).unwrap()
}

#[tokio::test]
async fn harness_run_errors_are_sealed_legacy_rows_read_and_bad_rows_skipped() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = store
        .create_session(
            "agent-seal",
            RunnableKind::Agent,
            Some("agent-seal"),
            Some("Seal test"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let request = StartRunRequest {
        input: serde_json::json!({ "prompt": "inspect" }),
        idempotency_key: Some("seal-1".to_owned()),
        execution_profile: None,
        resume_run_id: None,
        multitask_strategy: None,
    };
    let run = store
        .start_harness_run(&session.id, &request)
        .await
        .unwrap()
        .run;
    store
        .finish_harness_run(
            &run.id,
            HarnessRunStatus::Failed,
            Some("upstream echoed: confidential prompt fragment"),
            None,
        )
        .await
        .unwrap();
    let stored = raw_text(
        &store,
        "SELECT error FROM harness_runs WHERE id = ?1",
        &run.id,
    )
    .await
    .unwrap();
    assert!(stored.starts_with("enc:v1:"));
    assert!(!stored.contains("confidential"));
    let read = store.get_harness_run(&run.id).await.unwrap().unwrap();
    assert_eq!(
        read.error.as_deref(),
        Some("upstream echoed: confidential prompt fragment")
    );

    // A legacy plaintext error still reads, and the open-time pass seals it
    // once (a second pass changes nothing).
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE harness_runs SET error = 'legacy plaintext error' WHERE id = ?1",
            [&run.id],
        )
        .unwrap();
    }
    assert_eq!(
        store
            .get_harness_run(&run.id)
            .await
            .unwrap()
            .unwrap()
            .error
            .as_deref(),
        Some("legacy plaintext error")
    );
    {
        let conn = store.conn.lock().await;
        ConversationStore::seal_legacy_run_text(&conn, &store.cipher).unwrap();
    }
    let first = raw_text(
        &store,
        "SELECT error FROM harness_runs WHERE id = ?1",
        &run.id,
    )
    .await
    .unwrap();
    assert!(first.starts_with("enc:v1:"));
    {
        let conn = store.conn.lock().await;
        ConversationStore::seal_legacy_run_text(&conn, &store.cipher).unwrap();
    }
    assert_eq!(
        raw_text(
            &store,
            "SELECT error FROM harness_runs WHERE id = ?1",
            &run.id
        )
        .await
        .unwrap(),
        first
    );

    // A sealed value that does not open: the list skips and counts the row,
    // get-by-id reports an error instead of an empty value.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE harness_runs SET error = 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' WHERE id = ?1",
            [&run.id],
        )
        .unwrap();
    }
    assert!(store
        .list_harness_runs(&session.id)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(store.harness_unreadable.load(Ordering::Relaxed), 1);
    assert!(store.get_harness_run(&run.id).await.is_err());
}

/// Whether `marker` appears anywhere in the database file or its WAL.
fn db_files_contain(path: &std::path::Path, marker: &str) -> bool {
    let wal = std::path::PathBuf::from(format!("{}-wal", path.display()));
    [path.to_path_buf(), wal].iter().any(|file| {
        std::fs::read(file).is_ok_and(|bytes| {
            bytes
                .windows(marker.len())
                .any(|window| window == marker.as_bytes())
        })
    })
}

/// Plaintext run errors an older build wrote, then deleted without
/// `secure_delete`, must not survive the open-time reseal in free pages,
/// partly used pages or WAL frames.
#[tokio::test]
async fn legacy_run_errors_are_scrubbed_from_db_and_wal_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("conversations.db");
    let deleted_marker = "DELETED-LEGACY-RUN-ERROR-7f3a";
    let live_marker = "LIVE-LEGACY-RUN-ERROR-9c1e";
    let cipher = {
        let store = ConversationStore::open_hook_test_file(path.clone()).unwrap();
        {
            let conn = store.conn.lock().await;
            conn.pragma_update(None, "secure_delete", "OFF").unwrap();
        }
        let session = store
            .create_session(
                "agent-scrub",
                RunnableKind::Agent,
                Some("agent-scrub"),
                Some("Scrub test"),
                Tenancy::Unattributed,
            )
            .await
            .unwrap();
        let mut runs = Vec::new();
        for key in ["scrub-1", "scrub-2"] {
            let request = StartRunRequest {
                input: serde_json::json!({ "prompt": "inspect" }),
                idempotency_key: Some(key.to_owned()),
                execution_profile: None,
                resume_run_id: None,
                multitask_strategy: None,
            };
            let run = store
                .start_harness_run(&session.id, &request)
                .await
                .unwrap()
                .run;
            store
                .finish_harness_run(&run.id, HarnessRunStatus::Failed, Some("sealed"), None)
                .await
                .unwrap();
            runs.push(run);
        }
        {
            // What an older build left: plaintext errors, one of them on a
            // run it then deleted without secure_delete.
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE harness_runs SET error = ?1 WHERE id = ?2",
                params![deleted_marker, runs[0].id],
            )
            .unwrap();
            conn.execute(
                "UPDATE harness_runs SET error = ?1 WHERE id = ?2",
                params![live_marker, runs[1].id],
            )
            .unwrap();
            conn.execute("DELETE FROM harness_runs WHERE id = ?1", [&runs[0].id])
                .unwrap();
        }
        assert!(db_files_contain(&path, deleted_marker));
        store.cipher.clone()
    };

    // The open-time pass on the store's single connection.
    {
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "secure_delete", "ON").unwrap();
        ConversationStore::init_schema(&conn).unwrap();
        ConversationStore::seal_and_scrub_legacy_run_text(&conn, &path, &cipher).unwrap();
        let record = ryu_crypto::content_sqlite::read_store_record(&conn, RUN_TEXT_STORE)
            .unwrap()
            .unwrap();
        assert_eq!(record.state, ryu_crypto::content_sqlite::states::OK);
        assert!(record.kcv.is_none(), "the scrub record names no key");
        let stored: String = conn
            .query_row("SELECT error FROM harness_runs", [], |row| row.get(0))
            .unwrap();
        assert!(stored.starts_with("enc:v1:"));
        assert_eq!(cipher.open(&stored).unwrap(), live_marker);
    }
    assert!(
        !db_files_contain(&path, deleted_marker),
        "a deleted legacy run error survived the scrub"
    );
    assert!(
        !db_files_contain(&path, live_marker),
        "the resealed legacy run error survived the scrub"
    );

    // Nothing left to seal and no debt: a later open does not rewrite.
    let conn = Connection::open(&path).unwrap();
    conn.pragma_update(None, "secure_delete", "ON").unwrap();
    ConversationStore::seal_and_scrub_legacy_run_text(&conn, &path, &cipher).unwrap();
    assert_eq!(
        ryu_crypto::content_sqlite::read_store_record(&conn, RUN_TEXT_STORE)
            .unwrap()
            .unwrap()
            .state,
        ryu_crypto::content_sqlite::states::OK
    );
}

#[tokio::test]
async fn channel_turn_fallback_warnings_are_sealed() {
    let store = ConversationStore::open_in_memory().unwrap();
    let key = "telegram:bot-a:update-sealed";
    store
        .claim_channel_turn(key, "conversation-1", "hash-1")
        .await
        .unwrap();
    let result = ChannelTurnReplay {
        reply: "reply".to_owned(),
        assistant_message_id: None,
        assistant_message_ids: Vec::new(),
        agent_id: None,
        fallback_warning: Some("primary model unavailable for this request".to_owned()),
        interactive_markup: None,
    };
    store.complete_channel_turn(key, &result).await.unwrap();
    let stored = raw_text(
        &store,
        "SELECT fallback_warning FROM channel_turn_idempotency WHERE idempotency_key = ?1",
        key,
    )
    .await
    .unwrap();
    assert!(stored.starts_with("enc:v1:"));
    assert_eq!(
        store
            .claim_channel_turn(key, "conversation-1", "hash-1")
            .await
            .unwrap(),
        ChannelTurnClaim::Completed(result)
    );
}

fn indexed_store() -> ConversationStore {
    ConversationStore::open_in_memory()
        .unwrap()
        .with_message_index(crate::search_host::in_memory_message_index().unwrap())
        .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap())
}

#[tokio::test]
async fn deleting_a_conversation_removes_its_index_rows_and_memory_off_clears_both() {
    let store = indexed_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .append_message(
            "conv-del",
            "user",
            "pineapple orchard harvest",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store
        .append_message(
            "conv-keep",
            "user",
            "pineapple smoothie recipe",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let hits = store
        .fts_search_messages("pineapple", 5, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hits.len(), 2);
    store
        .search_messages("pineapple", 5, None)
        .await
        .unwrap()
        .unwrap();
    let fts = store.message_fts.clone().unwrap();
    let semantic = store.message_index.clone().unwrap();
    // Wait for the append-time semantic workers to settle.
    for _ in 0..50 {
        if semantic.indexed_ids().await.unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(semantic.indexed_ids().await.unwrap().len(), 2);

    assert!(store.delete_conversation("conv-del").await.unwrap());
    assert_eq!(fts.indexed_ids().await.unwrap().len(), 1);
    assert_eq!(semantic.indexed_ids().await.unwrap().len(), 1);
    let diagnostics = store.search_index_diagnostics();
    assert!(diagnostics["vector_coverage"]["total"].is_number());

    store.clear_message_embeddings().await.unwrap();
    assert!(fts.indexed_ids().await.unwrap().is_empty());
    assert!(semantic.indexed_ids().await.unwrap().is_empty());
}

/// The danger-zone clears remove the wiped chats from both derived indexes
/// (and the in-memory vector partition), not only from `conversations.db`.
#[tokio::test]
async fn clearing_chats_removes_their_index_rows() {
    let store = indexed_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    for (conversation, owner) in [("conv-alice", "alice"), ("conv-bob", "bob")] {
        store
            .ensure_conversation(
                conversation,
                None,
                None,
                Tenancy::Owned {
                    user_id: owner.to_owned(),
                    org_id: Some("org1".to_owned()),
                },
            )
            .await
            .unwrap();
        store
            .append_message(conversation, "user", "walnut grove notes", None, None, None)
            .await
            .unwrap();
    }
    store
        .fts_search_messages("walnut", 5, None)
        .await
        .unwrap()
        .unwrap();
    let fts = store.message_fts.clone().unwrap();
    let semantic = store.message_index.clone().unwrap();
    for _ in 0..50 {
        if semantic.indexed_ids().await.unwrap().len() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert_eq!(fts.indexed_ids().await.unwrap().len(), 2);
    assert_eq!(semantic.indexed_ids().await.unwrap().len(), 2);

    assert_eq!(
        store
            .clear_conversations_owned_by("bob")
            .await
            .unwrap()
            .removed,
        1
    );
    assert_eq!(fts.indexed_ids().await.unwrap().len(), 1);
    assert_eq!(semantic.indexed_ids().await.unwrap().len(), 1);

    store.clear_all_conversations().await.unwrap();
    assert!(fts.indexed_ids().await.unwrap().is_empty());
    assert!(semantic.indexed_ids().await.unwrap().is_empty());
    assert_eq!(semantic.vector_coverage().total, 0);
}

#[tokio::test]
async fn the_index_backfill_skips_bodies_that_do_not_open() {
    let store = indexed_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .ensure_conversation("conv-bad", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO messages(id, conversation_id, role, content, created_at)
                 VALUES ('bad', 'conv-bad', 'user', 'enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 1)",
            [],
        )
        .unwrap();
    }
    let hits = store
        .fts_search_messages("unable decrypt message", 5, None)
        .await
        .unwrap()
        .unwrap();
    assert!(hits.is_empty(), "placeholder text must never be indexed");
    assert!(store
        .message_fts
        .clone()
        .unwrap()
        .indexed_ids()
        .await
        .unwrap()
        .is_empty());
    assert_eq!(store.index_unreadable.load(Ordering::Relaxed), 1);
}
