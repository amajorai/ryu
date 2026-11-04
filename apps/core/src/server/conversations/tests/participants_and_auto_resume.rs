//! Conversation store tests: participants and auto resume.

use super::*;

// ── Multi-agent participants (#414) ───────────────────────────────────────

#[tokio::test]
async fn participants_add_remove_roundtrip() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "conv-multi",
            "user",
            "hello",
            Some("agent-alpha"),
            None,
            None,
        )
        .await
        .unwrap();

    // Start with no participants.
    let initial = store.get_participants("conv-multi").await.unwrap();
    assert!(initial.is_empty(), "new conversation has no participants");

    // Add two agents.
    let after_add1 = store
        .add_participant("conv-multi", "agent-alpha", Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(after_add1, vec!["agent-alpha"]);

    let after_add2 = store
        .add_participant("conv-multi", "agent-beta", Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(after_add2, vec!["agent-alpha", "agent-beta"]);

    // Idempotent: adding agent-alpha again changes nothing.
    let after_dup = store
        .add_participant("conv-multi", "agent-alpha", Tenancy::Unattributed)
        .await
        .unwrap();
    assert_eq!(after_dup, vec!["agent-alpha", "agent-beta"]);

    // Remove one.
    let after_remove = store
        .remove_participant("conv-multi", "agent-alpha")
        .await
        .unwrap();
    assert_eq!(after_remove, vec!["agent-beta"]);

    // Verify via get_participants.
    let final_list = store.get_participants("conv-multi").await.unwrap();
    assert_eq!(final_list, vec!["agent-beta"]);
}

// ── Crash recovery: turns the node died in the middle of ──────────────────

#[tokio::test]
async fn reconcile_interrupted_runs_marks_the_truncated_trailing_turn() {
    let store = ConversationStore::open_in_memory().unwrap();

    // A conversation the node died mid-turn on: the assistant row holds only
    // what the incremental flush had written, and the run is still "running".
    store
        .append_message("conv-crash", "user", "write me an essay", None, None, None)
        .await
        .unwrap();
    let truncated = store
        .append_message(
            "conv-crash",
            "assistant",
            "Sure — here is the fi",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store.set_run_status("conv-crash", "running").await.unwrap();

    // A conversation that finished cleanly must be left alone.
    store
        .append_message("conv-ok", "user", "hi", None, None, None)
        .await
        .unwrap();
    let finished = store
        .append_message("conv-ok", "assistant", "hello!", None, None, None)
        .await
        .unwrap();
    store.set_run_status("conv-ok", "completed").await.unwrap();

    let (runs, flagged) = {
        let mut conn = store.conn.lock().await;
        ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
    };
    assert_eq!(runs, 1, "only the stuck run is reconciled");
    assert_eq!(flagged, 1, "only its trailing assistant row is flagged");

    let crashed = store.get_messages("conv-crash").await.unwrap();
    assert!(
        !crashed[0].interrupted,
        "the user turn is never marked interrupted"
    );
    assert!(
        crashed[1].interrupted && crashed[1].id == truncated,
        "the trailing assistant row carries the marker"
    );
    // The text that was never written is gone — the marker is what makes the
    // truncation visible, it does not restore it.
    assert_eq!(crashed[1].content, "Sure — here is the fi");

    let ok = store.get_messages("conv-ok").await.unwrap();
    assert!(
        !ok.iter().any(|m| m.interrupted),
        "a completed run's rows are untouched"
    );
    assert_eq!(ok[1].id, finished);

    let summaries = store.list_conversations().await.unwrap();
    let crashed_summary = summaries.iter().find(|c| c.id == "conv-crash").unwrap();
    assert_eq!(crashed_summary.run_status.as_deref(), Some("interrupted"));

    // Idempotent: a second boot flips nothing further (there is no `running`
    // row left) and does not re-flag anything.
    let (runs2, flagged2) = {
        let mut conn = store.conn.lock().await;
        ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
    };
    assert_eq!((runs2, flagged2), (0, 0));
}

#[tokio::test]
async fn boot_capture_lists_only_runs_that_were_live() {
    let store = ConversationStore::open_in_memory().unwrap();
    for (id, status) in [
        ("live-a", "running"),
        ("done", "completed"),
        ("old-crash", "interrupted"),
        ("live-b", "running"),
    ] {
        store
            .append_message(id, "user", "go", None, None, None)
            .await
            .unwrap();
        store.set_run_status(id, status).await.unwrap();
    }
    let captured = {
        let conn = store.conn.lock().await;
        ConversationStore::list_running_conversations(&conn).unwrap()
    };
    assert_eq!(captured, vec!["live-a".to_owned(), "live-b".to_owned()]);
    // The in-memory store never boots, so it has nothing to hand out.
    assert!(store.take_boot_interrupted_runs().is_empty());
}

#[tokio::test]
async fn auto_resume_claim_is_bounded_per_user_turn() {
    let store = ConversationStore::open_in_memory().unwrap();
    let first_turn = store
        .append_message("conv", "user", "build it", None, None, None)
        .await
        .unwrap();
    store.set_run_status("conv", "interrupted").await.unwrap();

    let claim = store
        .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
        .await
        .unwrap();
    assert!(
        matches!(claim, AutoResumeClaim::Claimed { attempt: 1, .. }),
        "{claim:?}"
    );
    let status = store
        .get_run_summary("conv")
        .await
        .unwrap()
        .unwrap()
        .run_status;
    assert_eq!(status.as_deref(), Some("running"));
    // Already running: a racing claim (or a desktop retry) loses.
    assert_eq!(
        store
            .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
            .await
            .unwrap(),
        AutoResumeClaim::NotInterrupted
    );

    // The resumed turn took the node down again: the next boot gets one
    // more try, then the turn is left for the user.
    store.set_run_status("conv", "interrupted").await.unwrap();
    let claim = store
        .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
        .await
        .unwrap();
    assert!(
        matches!(claim, AutoResumeClaim::Claimed { attempt: 2, .. }),
        "{claim:?}"
    );
    store.set_run_status("conv", "interrupted").await.unwrap();
    assert_eq!(
        store
            .claim_interrupted_run_for_auto_resume("conv", &first_turn, 2)
            .await
            .unwrap(),
        AutoResumeClaim::Exhausted
    );
    let status = store
        .get_run_summary("conv")
        .await
        .unwrap()
        .unwrap()
        .run_status;
    assert_eq!(
        status.as_deref(),
        Some("interrupted"),
        "exhausted runs stay put"
    );

    // A new user turn starts a fresh budget.
    let second_turn = store
        .append_message("conv", "user", "try again", None, None, None)
        .await
        .unwrap();
    let claim = store
        .claim_interrupted_run_for_auto_resume("conv", &second_turn, 2)
        .await
        .unwrap();
    assert!(
        matches!(claim, AutoResumeClaim::Claimed { attempt: 1, .. }),
        "{claim:?}"
    );
}

#[tokio::test]
async fn auto_resume_never_claims_a_conversation_owned_by_a_person() {
    let store = ConversationStore::open_in_memory().unwrap();
    for (id, owner, org) in [
        ("alice-chat", Some("alice"), Some("org1")),
        ("org-chat", None, Some("org1")),
    ] {
        let turn = store
            .append_message(id, "user", "build it", None, None, None)
            .await
            .unwrap();
        store
            .conn
            .lock()
            .await
            .execute(
                "UPDATE conversations SET owner_user_id = ?1, org_id = ?2 WHERE id = ?3",
                params![owner, org, id],
            )
            .unwrap();
        store.set_run_status(id, "interrupted").await.unwrap();

        // A detached resume has no verified caller to run as, so it must
        // not pick up a person's turn with node authority.
        assert_eq!(
            store
                .claim_interrupted_run_for_auto_resume(id, &turn, 2)
                .await
                .unwrap(),
            AutoResumeClaim::Attributed
        );
        let status = store.get_run_summary(id).await.unwrap().unwrap().run_status;
        assert_eq!(
            status.as_deref(),
            Some("interrupted"),
            "{id} is left for its author to retry"
        );
        let attempts: i64 = store
            .conn
            .lock()
            .await
            .query_row(
                "SELECT COUNT(*) FROM run_auto_resume WHERE conversation_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempts, 0, "{id} spends no resume budget");
    }
}

#[tokio::test]
async fn unstarted_auto_resume_fails_only_when_no_turn_took_over() {
    let store = ConversationStore::open_in_memory().unwrap();
    let turn = store
        .append_message("conv", "user", "build it", None, None, None)
        .await
        .unwrap();
    store.set_run_status("conv", "interrupted").await.unwrap();
    let AutoResumeClaim::Claimed { claimed_at, .. } = store
        .claim_interrupted_run_for_auto_resume("conv", &turn, 2)
        .await
        .unwrap()
    else {
        panic!("claim should succeed");
    };

    // A turn that started rewrote `running` with a newer timestamp.
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = 'conv'",
            params![claimed_at + 1],
        )
        .unwrap();
    assert!(!store
        .fail_unstarted_auto_resume("conv", claimed_at)
        .await
        .unwrap());

    // Nothing touched the run since the claim: the turn never started.
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = 'conv'",
            params![claimed_at],
        )
        .unwrap();
    assert!(store
        .fail_unstarted_auto_resume("conv", claimed_at)
        .await
        .unwrap());
    let status = store
        .get_run_summary("conv")
        .await
        .unwrap()
        .unwrap()
        .run_status;
    assert_eq!(status.as_deref(), Some("failed"));
}

#[tokio::test]
async fn reconcile_interrupted_harness_run_appends_terminal_event() {
    let store = ConversationStore::open_in_memory().unwrap();
    let session = store
        .create_session(
            "agent-1",
            RunnableKind::Agent,
            Some("agent-1"),
            Some("Harness crash"),
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let started = store
        .start_harness_run(
            &session.id,
            &StartRunRequest {
                input: serde_json::json!({ "prompt": "continue" }),
                idempotency_key: None,
                execution_profile: None,
                resume_run_id: None,
                multitask_strategy: None,
            },
        )
        .await
        .unwrap();
    store
        .set_harness_run_status(&started.run.id, HarnessRunStatus::AwaitingApproval)
        .await
        .unwrap();

    let (runs, flagged) = {
        let mut conn = store.conn.lock().await;
        ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
    };
    assert_eq!((runs, flagged), (1, 0));

    let run = store
        .get_harness_run(&started.run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(run.status, HarnessRunStatus::Interrupted);
    assert_eq!(run.event_cursor, 3);
    let events = store
        .list_harness_events(&started.run.id, 0, 10)
        .await
        .unwrap();
    assert_eq!(events.len(), 3);
    assert!(matches!(
        events.get(1).map(|event| &event.event),
        Some(RunEvent::InputAccepted {
            message_count: 1,
            ..
        })
    ));
    assert!(matches!(
        events.last().map(|event| &event.event),
        Some(RunEvent::RunInterrupted)
    ));

    let session = store
        .get_harness_session(&session.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.status, HarnessRunStatus::Interrupted);

    let (runs_again, flagged_again) = {
        let mut conn = store.conn.lock().await;
        ConversationStore::reconcile_interrupted_runs(&mut conn, &store.cipher).unwrap()
    };
    assert_eq!((runs_again, flagged_again), (0, 0));
    assert_eq!(
        store
            .list_harness_events(&started.run.id, 0, 10)
            .await
            .unwrap()
            .len(),
        3,
        "reconciliation must not append a second terminal event"
    );
}

#[tokio::test]
async fn messages_carry_agent_id() {
    let store = ConversationStore::open_in_memory().unwrap();

    // Two agents in one conversation each produce a message.
    store
        .append_message("conv-agents", "user", "question", None, None, None)
        .await
        .unwrap();
    store
        .append_message(
            "conv-agents",
            "assistant",
            "reply from alpha",
            Some("agent-alpha"),
            None,
            None,
        )
        .await
        .unwrap();
    store
        .append_message(
            "conv-agents",
            "assistant",
            "reply from beta",
            Some("agent-beta"),
            None,
            None,
        )
        .await
        .unwrap();

    let msgs = store.get_messages("conv-agents").await.unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].agent_id, None, "user message has no agent_id");
    assert_eq!(msgs[1].agent_id.as_deref(), Some("agent-alpha"));
    assert_eq!(msgs[2].agent_id.as_deref(), Some("agent-beta"));
}
