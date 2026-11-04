//! Conversation store tests: sessions and queue.

use super::*;

#[tokio::test]
async fn resumed_rows_sharing_nothing_with_the_target_append_beneath_the_leaf() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-resume-disjoint";
    branched_resume_target(&store, conv).await;
    // A `Recent { max_messages }` export that starts past the target's history.
    insert_synced(
        &store,
        conv,
        &[
            ("b-u5", "user", "remote u5"),
            ("b-a5", "assistant", "remote a5"),
        ],
    )
    .await;
    let transcript = owned_ids(&["b-u5", "b-a5"]);
    store
        .link_resumed_messages(conv, &transcript, &[], &owned_id_set(&["b-u5", "b-a5"]))
        .await
        .unwrap();

    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(
        contents(&active),
        ["u1", "a1", "u2", "a2", "remote u5", "remote a5"]
    );
}

#[test]
fn title_truncates_long_first_line() {
    let long = "a".repeat(100);
    let title = derive_title(&long).expect("a non-empty message derives a title");
    assert!(title.chars().count() <= 61); // 60 chars + ellipsis
    assert!(title.ends_with('…'));
    // A text-less turn derives nothing rather than pinning a placeholder the
    // upsert's COALESCE would then keep forever.
    assert_eq!(derive_title("   \n  "), None);
    assert_eq!(derive_title(""), None);
}

#[tokio::test]
async fn session_round_trip_with_existing_conversation_store() {
    let store = ConversationStore::open_in_memory().unwrap();

    // Create a session bound to an agent Runnable.
    let session = store
        .create_session(
            "agent-abc",
            RunnableKind::Agent,
            Some("agent-abc"),
            Some("Test session"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap();

    assert_eq!(session.runnable_id, "agent-abc");
    assert_eq!(session.runnable_kind, RunnableKind::Agent);
    assert_eq!(session.status, SessionStatus::Idle);

    // Append a message via the existing ConversationStore path (no duplicate store).
    store
        .append_message(
            &session.conversation_id,
            "user",
            "Hello from session test",
            Some("agent-abc"),
            None,
            None,
        )
        .await
        .unwrap();

    // Reload session and verify state.
    let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
    assert_eq!(reloaded.id, session.id);
    assert_eq!(reloaded.runnable_kind, RunnableKind::Agent);
    assert_eq!(reloaded.status, SessionStatus::Idle);

    // Verify the message is accessible through the existing store.
    let msgs = store.get_messages(&session.conversation_id).await.unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "Hello from session test");

    // Update status and verify round-trip.
    let updated = store
        .update_session_status(&session.id, SessionStatus::Running)
        .await
        .unwrap();
    assert!(updated);

    let after_update = store.get_session(&session.id).await.unwrap().unwrap();
    assert_eq!(after_update.status, SessionStatus::Running);
}

#[tokio::test]
async fn session_runnable_kind_round_trips_for_workflow() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = store
        .create_session(
            "wf-xyz",
            RunnableKind::Workflow,
            None,
            None,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
    assert_eq!(reloaded.runnable_kind, RunnableKind::Workflow);
}

pub(super) fn double_text_request(
    prompt: &str,
    strategy: Option<MultitaskStrategy>,
) -> StartRunRequest {
    StartRunRequest {
        input: serde_json::json!({ "prompt": prompt }),
        idempotency_key: None,
        execution_profile: None,
        resume_run_id: None,
        multitask_strategy: strategy,
    }
}

pub(super) async fn double_text_session(store: &ConversationStore) -> Session {
    store
        .create_session(
            "agent-double-text",
            RunnableKind::Agent,
            Some("agent-double-text"),
            Some("Double text"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn harness_double_text_reject_is_default_and_enqueue_is_fifo() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = double_text_session(&store).await;
    let active = store
        .start_harness_run(&session.id, &double_text_request("first", None))
        .await
        .unwrap();
    assert_eq!(active.run.status, HarnessRunStatus::Running);
    assert!(active.displaced_run_id.is_none());

    let rejected = store
        .start_harness_run(&session.id, &double_text_request("again", None))
        .await
        .unwrap_err()
        .to_string();
    assert!(rejected.contains("active run"), "{rejected}");

    let second = store
        .start_harness_run(
            &session.id,
            &double_text_request("second", Some(MultitaskStrategy::Enqueue)),
        )
        .await
        .unwrap();
    let third = store
        .start_harness_run(
            &session.id,
            &double_text_request("third", Some(MultitaskStrategy::Enqueue)),
        )
        .await
        .unwrap();
    assert_eq!(second.run.status, HarnessRunStatus::Pending);
    assert_eq!(second.run.started_at, None);
    assert_eq!(second.run.event_cursor, 1);
    assert_eq!(
        second.run.multitask_strategy,
        Some(MultitaskStrategy::Enqueue)
    );
    let queued_events = store
        .list_harness_events(&third.run.id, 0, 10)
        .await
        .unwrap();
    assert_eq!(
        queued_events[0].event,
        RunEvent::RunQueued {
            position: 2,
            strategy: MultitaskStrategy::Enqueue,
            active_run_id: Some(active.run.id.clone()),
        }
    );

    // Reject also refuses to jump a non-empty queue.
    assert!(store
        .start_harness_run(&session.id, &double_text_request("x", None))
        .await
        .is_err());
    // The live run still describes the session while others wait.
    let projected = store
        .get_harness_session(&session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(projected.status, HarnessRunStatus::Running);
    assert_eq!(
        store
            .list_sessions_with_queued_harness_runs()
            .await
            .unwrap(),
        vec![QueuedHarnessSession {
            session_id: session.id.clone(),
            attributed: false,
        }]
    );

    // Nothing is promoted while a run is active.
    assert!(store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .is_none());
    store
        .finish_harness_run(&active.run.id, HarnessRunStatus::Completed, None, None)
        .await
        .unwrap();
    let promoted = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .expect("second run is promoted");
    assert_eq!(promoted.run.id, second.run.id);
    assert_eq!(promoted.run.status, HarnessRunStatus::Running);
    assert!(promoted.run.started_at.is_some());
    assert_eq!(promoted.input, serde_json::json!({ "prompt": "second" }));
    assert_eq!(promoted.conversation_id, session.conversation_id);
    let events = store
        .list_harness_events(&second.run.id, 0, 10)
        .await
        .unwrap();
    let kinds: Vec<_> = events
        .iter()
        .map(|event| serde_json::to_value(&event.event).unwrap()["type"].clone())
        .collect();
    assert_eq!(kinds, ["run_queued", "run_started", "input_accepted"]);
    assert_eq!(events.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2, 3]);
    // A second promotion cannot start the third run alongside the second.
    assert!(store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .is_none());

    // Canceling a queued run leaves the live run's session status alone.
    store
        .finish_harness_run(&third.run.id, HarnessRunStatus::Canceled, None, None)
        .await
        .unwrap();
    let projected = store
        .get_harness_session(&session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(projected.status, HarnessRunStatus::Running);
    let reloaded = store.get_session(&session.id).await.unwrap().unwrap();
    assert_eq!(reloaded.status, SessionStatus::Running);
}

#[tokio::test]
async fn harness_preempting_runs_jump_the_queue_and_rollback_removes_turns() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = double_text_session(&store).await;
    let conversation = session.conversation_id.clone();
    store
        .append_message_at(
            &conversation,
            "user",
            "earlier turn",
            None,
            None,
            None,
            Tenancy::Unattributed,
            Some(1_000),
        )
        .await
        .unwrap();
    let active = store
        .start_harness_run(&session.id, &double_text_request("draft", None))
        .await
        .unwrap();
    let later = now_millis() + 60_000;
    for (role, text) in [("user", "draft"), ("assistant", "partial answ")] {
        store
            .append_message_at(
                &conversation,
                role,
                text,
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(later),
            )
            .await
            .unwrap();
    }
    let waiting = store
        .start_harness_run(
            &session.id,
            &double_text_request("queued", Some(MultitaskStrategy::Enqueue)),
        )
        .await
        .unwrap();
    assert!(waiting.displaced_run_id.is_none());
    let rollback = store
        .start_harness_run(
            &session.id,
            &double_text_request("replace", Some(MultitaskStrategy::Rollback)),
        )
        .await
        .unwrap();
    assert_eq!(rollback.run.status, HarnessRunStatus::Pending);
    assert_eq!(
        rollback.displaced_run_id.as_deref(),
        Some(active.run.id.as_str())
    );
    let queued = store
        .list_harness_events(&rollback.run.id, 0, 1)
        .await
        .unwrap();
    assert!(matches!(
        queued[0].event,
        RunEvent::RunQueued {
            position: 1,
            strategy: MultitaskStrategy::Rollback,
            ..
        }
    ));

    store
        .finish_harness_run(
            &active.run.id,
            HarnessRunStatus::Canceled,
            Some("rolled back"),
            None,
        )
        .await
        .unwrap();
    let promoted = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .expect("rollback run is promoted first");
    assert_eq!(promoted.run.id, rollback.run.id);
    assert_eq!(promoted.removed_messages, 2);
    let remaining: Vec<_> = store
        .get_messages(&conversation)
        .await
        .unwrap()
        .into_iter()
        .map(|message| message.content)
        .collect();
    assert_eq!(remaining, ["earlier turn"]);
    let canceled = store
        .get_harness_run(&active.run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(canceled.status, HarnessRunStatus::Canceled);
    assert_eq!(canceled.error.as_deref(), Some("rolled back"));

    // The enqueued run waits for the rollback run, then starts.
    store
        .finish_harness_run(&rollback.run.id, HarnessRunStatus::Completed, None, None)
        .await
        .unwrap();
    let next = store
        .promote_next_harness_run(&session.id)
        .await
        .unwrap()
        .expect("enqueued run follows");
    assert_eq!(next.run.id, waiting.run.id);
    assert_eq!(next.removed_messages, 0);
}
