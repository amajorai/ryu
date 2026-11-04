//! Conversation store tests: harness runs.

use super::*;

#[tokio::test]
async fn harness_rollback_keeps_turns_of_a_run_that_completed_in_between() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = double_text_session(&store).await;
    let conversation = session.conversation_id.clone();
    let active = store
        .start_harness_run(&session.id, &double_text_request("draft", None))
        .await
        .unwrap();
    let active_started = store
        .get_harness_run(&active.run.id)
        .await
        .unwrap()
        .unwrap()
        .started_at
        .map(|started_at| rfc3339_to_millis(&started_at))
        .expect("the first run starts immediately");
    store
        .append_message_at(
            &conversation,
            "user",
            "draft",
            None,
            None,
            None,
            Tenancy::Unattributed,
            Some(active_started),
        )
        .await
        .unwrap();
    // Double text: an interrupt and then a rollback both displace the run.
    let interrupt = store
        .start_harness_run(
            &session.id,
            &double_text_request("interrupt", Some(MultitaskStrategy::Interrupt)),
        )
        .await
        .unwrap();
    let rollback = store
        .start_harness_run(
            &session.id,
            &double_text_request("replace", Some(MultitaskStrategy::Rollback)),
        )
        .await
        .unwrap();
    assert_eq!(
        interrupt.displaced_run_id.as_deref(),
        Some(active.run.id.as_str())
    );
    assert_eq!(
        rollback.displaced_run_id.as_deref(),
        Some(active.run.id.as_str())
    );
    store
        .finish_harness_run(&active.run.id, HarnessRunStatus::Canceled, None, None)
        .await
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    let promoted = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .expect("the interrupt is promoted first");
    assert_eq!(promoted.run.id, interrupt.run.id);
    assert_eq!(promoted.removed_messages, 0);
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    for (role, text) in [("user", "interrupt"), ("assistant", "interrupt answer")] {
        store
            .append_message_at(
                &conversation,
                role,
                text,
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(now_millis()),
            )
            .await
            .unwrap();
    }
    store
        .finish_harness_run(&interrupt.run.id, HarnessRunStatus::Completed, None, None)
        .await
        .unwrap();
    let promoted = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .expect("the rollback follows");
    assert_eq!(promoted.run.id, rollback.run.id);
    assert_eq!(promoted.removed_messages, 1);
    let remaining: Vec<_> = store
        .get_messages(&conversation)
        .await
        .unwrap()
        .into_iter()
        .map(|message| message.content)
        .collect();
    assert_eq!(remaining, ["interrupt", "interrupt answer"]);
}

#[tokio::test]
async fn harness_interrupt_keeps_the_partial_transcript_and_preempt_without_active_starts() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = double_text_session(&store).await;
    let conversation = session.conversation_id.clone();
    // With nothing active, interrupt starts immediately and displaces nothing.
    let first = store
        .start_harness_run(
            &session.id,
            &double_text_request("first", Some(MultitaskStrategy::Interrupt)),
        )
        .await
        .unwrap();
    assert_eq!(first.run.status, HarnessRunStatus::Running);
    assert!(first.displaced_run_id.is_none());
    store
        .append_message_at(
            &conversation,
            "assistant",
            "partial",
            None,
            None,
            None,
            Tenancy::Unattributed,
            Some(now_millis() + 60_000),
        )
        .await
        .unwrap();
    let interrupt = store
        .start_harness_run(
            &session.id,
            &double_text_request("second", Some(MultitaskStrategy::Interrupt)),
        )
        .await
        .unwrap();
    assert_eq!(
        interrupt.displaced_run_id.as_deref(),
        Some(first.run.id.as_str())
    );
    store
        .finish_harness_run(&first.run.id, HarnessRunStatus::Canceled, None, None)
        .await
        .unwrap();
    let promoted = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(promoted.run.id, interrupt.run.id);
    assert_eq!(promoted.removed_messages, 0);
    assert_eq!(store.get_messages(&conversation).await.unwrap().len(), 1);
}

#[tokio::test]
async fn harness_queue_survives_boot_reconciliation() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = double_text_session(&store).await;
    let active = store
        .start_harness_run(&session.id, &double_text_request("active", None))
        .await
        .unwrap();
    let queued = store
        .start_harness_run(
            &session.id,
            &double_text_request("later", Some(MultitaskStrategy::Enqueue)),
        )
        .await
        .unwrap();
    // Boot reconciliation closes the live run; the queued run stays pending
    // and is promoted next.
    {
        let mut conn = store.conn.lock().await;
        ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap();
    }
    let interrupted = store
        .get_harness_run(&active.run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(interrupted.status, HarnessRunStatus::Interrupted);
    let still_queued = store
        .get_harness_run(&queued.run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_queued.status, HarnessRunStatus::Pending);
    assert_eq!(
        store
            .list_sessions_with_queued_harness_runs()
            .await
            .unwrap()
            .len(),
        1
    );
    let promoted = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(promoted.run.id, queued.run.id);
    assert_eq!(promoted.input, serde_json::json!({ "prompt": "later" }));
    assert!(store
        .list_sessions_with_queued_harness_runs()
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn harness_run_is_idempotent_replayable_and_terminal() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = store
        .create_session(
            "agent-harness",
            RunnableKind::Agent,
            Some("agent-harness"),
            Some("Harness test"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let profile = ExecutionProfile::worktree(
        Some("/tmp/ryu-harness-project".to_owned()),
        Some("harness-test".to_owned()),
    );
    assert!(store
        .set_session_execution_profile(&session.id, &profile, None)
        .await
        .unwrap());

    let request = StartRunRequest {
        input: serde_json::json!({ "prompt": "inspect" }),
        idempotency_key: Some("turn-1".to_owned()),
        execution_profile: None,
        resume_run_id: None,
        multitask_strategy: None,
    };
    let first = store
        .start_harness_run(&session.id, &request)
        .await
        .unwrap();
    assert!(first.created);
    assert_eq!(first.run.attempt, 1);
    assert_eq!(first.run.status, HarnessRunStatus::Running);
    assert_eq!(first.run.event_cursor, 2);
    assert_eq!(first.run.execution_profile, profile);

    let replay = store
        .start_harness_run(&session.id, &request)
        .await
        .unwrap();
    assert!(!replay.created);
    assert_eq!(replay.run.id, first.run.id);
    assert_eq!(replay.run.event_cursor, 2);

    let different_request = StartRunRequest {
        input: serde_json::json!({ "prompt": "different" }),
        idempotency_key: Some("turn-1".to_owned()),
        execution_profile: None,
        resume_run_id: None,
        multitask_strategy: None,
    };
    assert!(store
        .start_harness_run(&session.id, &different_request)
        .await
        .is_err());

    let delta = store
        .append_harness_event(
            &first.run.id,
            RunEvent::TextDelta {
                delta: "done".to_owned(),
            },
        )
        .await
        .unwrap();
    assert_eq!(delta.seq, 3);
    let events = store
        .list_harness_events(&first.run.id, 0, 20)
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[2].event,
        RunEvent::TextDelta {
            delta: "done".into()
        }
    );

    let finished = store
        .finish_harness_run(
            &first.run.id,
            HarnessRunStatus::Completed,
            None,
            Some(&serde_json::json!({ "text": "done" })),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(finished.status, HarnessRunStatus::Completed);
    assert_eq!(finished.event_cursor, 4);
    assert_eq!(finished.output, Some(serde_json::json!({ "text": "done" })));

    // A late duplicate terminal callback is a no-op and cannot overwrite
    // the successful result.
    let duplicate = store
        .finish_harness_run(
            &first.run.id,
            HarnessRunStatus::Failed,
            Some("late failure"),
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(duplicate.status, HarnessRunStatus::Completed);
    assert_eq!(
        duplicate.output,
        Some(serde_json::json!({ "text": "done" }))
    );
}

#[test]
fn folder_paths_normalize_to_one_spelling() {
    // The reported bug: an imported thread's cwd and a native run's folder
    // differ only in punctuation and became two sidebar project folders.
    assert_eq!(
        normalize_folder_path("/Users/j/Code/ryu/"),
        normalize_folder_path("/Users/j/Code/ryu")
    );
    assert_eq!(
        normalize_folder_path("/Users/j//Code/ryu"),
        "/Users/j/Code/ryu"
    );
    assert_eq!(
        normalize_folder_path("  /Users/j/Code/ryu  "),
        "/Users/j/Code/ryu"
    );
    // Roots survive: stripping these would leave a string that names nothing.
    assert_eq!(normalize_folder_path("/"), "/");
    assert_eq!(normalize_folder_path("C:\\"), "C:\\");
    // Case is preserved — the leaf is the project's display name.
    assert_eq!(normalize_folder_path("/Users/J/Code"), "/Users/J/Code");
    // Windows separators survive as backslashes.
    assert_eq!(
        normalize_folder_path("C:\\Users\\j\\Code\\ryu\\"),
        "C:\\Users\\j\\Code\\ryu"
    );
}

#[tokio::test]
async fn run_metadata_round_trips_and_migration_is_idempotent() {
    // Build a store via the normal path (exercises init_schema including the
    // ALTER TABLE migration).
    let store = ConversationStore::open_in_memory().unwrap();

    // Verify that calling init_schema a second time on the same connection
    // (the migration no-op path) does not error and leaves existing data intact.
    {
        let conn = store.conn.lock().await;
        ConversationStore::init_schema(&conn).expect("second init_schema must be a no-op");
    }

    // Create a conversation and set run metadata.
    store
        .append_message("conv-run", "user", "hello", Some("agent-1"), None, None)
        .await
        .unwrap();

    store
        .set_run_metadata("conv-run", Some("/home/user/project"), Some("main"), None)
        .await
        .unwrap();
    store.set_run_status("conv-run", "running").await.unwrap();

    // list_conversations must return the new fields.
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list.len(), 1);
    let summary = &list[0];
    assert_eq!(summary.folder_path.as_deref(), Some("/home/user/project"));
    assert_eq!(summary.branch.as_deref(), Some("main"));
    assert!(summary.worktree_path.is_none());
    assert_eq!(summary.run_status.as_deref(), Some("running"));

    // Update status to completed.
    store.set_run_status("conv-run", "completed").await.unwrap();
    let list2 = store.list_conversations().await.unwrap();
    assert_eq!(list2[0].run_status.as_deref(), Some("completed"));
}

#[tokio::test]
async fn run_metadata_null_fields_preserved_when_unset() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-null", "user", "hi", None, None, None)
        .await
        .unwrap();

    // No metadata set — all new fields must be None.
    let list = store.list_conversations().await.unwrap();
    assert_eq!(list[0].folder_path, None);
    assert_eq!(list[0].branch, None);
    assert_eq!(list[0].worktree_path, None);
    assert_eq!(list[0].run_status, None);
}

#[tokio::test]
async fn terminal_run_retry_claim_is_atomic_and_bounded() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "conv-retry",
            "user",
            "continue this",
            Some("agent-1"),
            None,
            None,
        )
        .await
        .unwrap();
    store.set_run_status("conv-retry", "failed").await.unwrap();

    assert!(store
        .claim_terminal_run_for_retry("conv-retry")
        .await
        .unwrap());
    assert!(!store
        .claim_terminal_run_for_retry("conv-retry")
        .await
        .unwrap());
    assert_eq!(
        store
            .get_run_summary("conv-retry")
            .await
            .unwrap()
            .and_then(|summary| summary.run_status),
        Some("running".to_owned())
    );
}

async fn idempotent_harness_session(store: &ConversationStore) -> Session {
    store
        .create_session(
            "agent-harness",
            RunnableKind::Agent,
            Some("agent-harness"),
            Some("Harness idempotency"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap()
}

fn keyed_request(input: serde_json::Value) -> StartRunRequest {
    StartRunRequest {
        input,
        idempotency_key: Some("turn-1".to_owned()),
        execution_profile: None,
        resume_run_id: None,
        multitask_strategy: None,
    }
}

#[tokio::test]
async fn harness_idempotency_matches_a_retry_whose_input_keys_are_reordered() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = idempotent_harness_session(&store).await;
    let original = keyed_request(serde_json::json!({
        "prompt": "inspect",
        "options": { "depth": 2, "mode": "fast" },
    }));
    let first = store
        .start_harness_run(&session.id, &original)
        .await
        .unwrap();
    assert!(first.created);

    // Core keeps object keys in insertion order, so this is a different byte
    // string for the same request.
    let reordered = keyed_request(serde_json::json!({
        "options": { "mode": "fast", "depth": 2 },
        "prompt": "inspect",
    }));
    assert_ne!(
        serde_json::to_string(&reordered.input).unwrap(),
        serde_json::to_string(&original.input).unwrap()
    );
    let retry = store
        .start_harness_run(&session.id, &reordered)
        .await
        .expect("a reordered retry is the same request");
    assert!(!retry.created);
    assert_eq!(retry.run.id, first.run.id);
}

#[tokio::test]
async fn harness_idempotency_accepts_a_stored_legacy_row_and_rejects_a_changed_request() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = idempotent_harness_session(&store).await;
    let first = store
        .start_harness_run(
            &session.id,
            &keyed_request(serde_json::json!({ "a": 1, "b": [true, { "c": "x" }] })),
        )
        .await
        .unwrap();
    // A row an older Core stored in the first caller's own key order.
    {
        let conn = store.conn.lock().await;
        let legacy = store
            .cipher
            .seal(r#"{"b":[true,{"c":"x"}],"a":1}"#)
            .unwrap();
        conn.execute(
            "UPDATE harness_runs SET input_json = ?1 WHERE id = ?2",
            params![legacy, first.run.id],
        )
        .unwrap();
    }

    let retry = store
        .start_harness_run(
            &session.id,
            &keyed_request(serde_json::json!({ "a": 1, "b": [true, { "c": "x" }] })),
        )
        .await
        .expect("the legacy row is the same request");
    assert_eq!(retry.run.id, first.run.id);
    assert!(!retry.created);

    for changed in [
        serde_json::json!({ "a": 2, "b": [true, { "c": "x" }] }),
        serde_json::json!({ "a": 1, "b": [{ "c": "x" }, true] }),
        serde_json::json!({ "a": 1, "b": [true, { "c": "x" }], "d": null }),
    ] {
        let error = store
            .start_harness_run(&session.id, &keyed_request(changed))
            .await
            .expect_err("a changed request under the same key is refused");
        assert!(error
            .to_string()
            .contains("already used with a different request"));
    }

    let mut other_profile = keyed_request(serde_json::json!({ "a": 1, "b": [true, { "c": "x" }] }));
    other_profile.execution_profile = Some(ExecutionProfile::worktree(
        Some("/tmp/ryu-harness-other".to_owned()),
        None,
    ));
    assert!(store
        .start_harness_run(&session.id, &other_profile)
        .await
        .is_err());
}
