//! Conversation store tests: forks.

use super::*;

#[tokio::test]
async fn clear_owned_removes_only_the_owners_widget_state_reactions_and_runs() {
    let store = ConversationStore::open_in_memory().unwrap();
    for (conversation, owner) in [("alice-chat", "alice"), ("bob-chat", "bob")] {
        let message_id = store
            .append_message(conversation, "user", "hi", None, None, None)
            .await
            .unwrap();
        store
            .claim_tenancy(conversation, owner, Some("org1"))
            .await
            .unwrap();
        assert!(store
            .set_agent_ui_state(conversation, "call-1", r#"{"state":{"done":true}}"#)
            .await
            .unwrap());
        assert!(store
            .add_reaction(conversation, &message_id, owner, "👍")
            .await
            .unwrap());
    }
    let owned = |user: &str| Tenancy::Owned {
        user_id: user.to_owned(),
        org_id: Some("org1".to_owned()),
    };
    let mut run_ids = Vec::new();
    for owner in ["alice", "bob"] {
        let session = store
            .create_session("agent-a", RunnableKind::Agent, None, None, owned(owner))
            .await
            .unwrap();
        let request = StartRunRequest {
            input: serde_json::json!({ "prompt": "inspect" }),
            idempotency_key: None,
            execution_profile: None,
            resume_run_id: None,
            multitask_strategy: None,
        };
        let started = store
            .start_harness_run(&session.id, &request)
            .await
            .unwrap();
        run_ids.push((owner, started.run.id));
    }

    let cleared = store.clear_conversations_owned_by("bob").await.unwrap();
    assert_eq!(
        cleared.removed, 2,
        "Bob's chat and his session's conversation"
    );
    // The residue names exactly the conversations removed, so their
    // transcripts and checkpoint pins are released and Alice's are not.
    assert_eq!(cleared.residue.len(), 2);
    assert!(cleared
        .residue
        .iter()
        .any(|residue| residue.conversation_id == "bob-chat"));
    assert!(cleared
        .residue
        .iter()
        .all(|residue| residue.conversation_id != "alice-chat"));

    assert!(store
        .list_agent_ui_states("bob-chat")
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_reactions("bob-chat", "bob")
        .await
        .unwrap()
        .is_empty());
    // Alice's rows are untouched.
    assert_eq!(
        store
            .list_agent_ui_states("alice-chat")
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store
            .list_reactions("alice-chat", "alice")
            .await
            .unwrap()
            .len(),
        1
    );
    for (owner, run_id) in run_ids {
        let kept = store.get_harness_run(&run_id).await.unwrap().is_some();
        assert_eq!(kept, owner == "alice", "harness run of {owner}");
    }
}

#[tokio::test]
async fn full_fork_carries_widget_state_but_a_mid_history_fork_does_not() {
    let store = ConversationStore::open_in_memory().unwrap();
    let cut = store
        .append_message("src", "user", "make a checklist", None, None, None)
        .await
        .unwrap();
    store
        .append_message("src", "assistant", "here it is", None, None, None)
        .await
        .unwrap();
    let saved = serde_json::json!({ "state": { "done": [true] }, "submitted": true });
    assert!(store
        .set_agent_ui_state("src", "call-1", &saved.to_string())
        .await
        .unwrap());

    let full = store
        .fork_conversation("src", None, Tenancy::Unattributed)
        .await
        .unwrap()
        .expect("full fork");
    let copied = store.list_agent_ui_states(&full.id).await.unwrap();
    assert_eq!(copied.len(), 1);
    assert_eq!(copied[0].tool_call_id, "call-1");
    assert_eq!(copied[0].state, saved);

    // The fork owns its copy: editing it leaves the source alone.
    assert!(store
        .set_agent_ui_state(&full.id, "call-1", r#"{"state":{"done":[false]}}"#)
        .await
        .unwrap());
    assert_eq!(
        store.list_agent_ui_states("src").await.unwrap()[0].state,
        saved
    );

    // A cut before the last message would import a later snapshot, so the
    // branch starts its widgets from their specs instead.
    let partial = store
        .fork_conversation("src", Some(&cut), Tenancy::Unattributed)
        .await
        .unwrap()
        .expect("partial fork");
    assert!(store
        .list_agent_ui_states(&partial.id)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn fork_copies_history_up_to_message_into_new_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("src", "user", "q1", None, None, None)
        .await
        .unwrap();
    let cut = store
        .append_message("src", "assistant", "a1", Some("default"), None, None)
        .await
        .unwrap();
    store
        .append_message("src", "user", "q2", None, None, None)
        .await
        .unwrap();

    let forked = store
        .fork_conversation("src", Some(&cut), Tenancy::Unattributed)
        .await
        .unwrap()
        .expect("fork should succeed");
    assert_ne!(forked.id, "src");
    assert_eq!(forked.message_count, 2);
    assert_eq!(forked.title.as_deref(), Some("q1 (branch)"));

    // The fork has exactly the first two messages, with fresh ids.
    let copied = store.get_messages(&forked.id).await.unwrap();
    assert_eq!(copied.len(), 2);
    assert_eq!(copied[0].content, "q1");
    assert_eq!(copied[1].content, "a1");
    assert_ne!(copied[1].id, cut, "copied messages get fresh ids");

    // The source is untouched; continuing the fork never touches it.
    assert_eq!(store.get_messages("src").await.unwrap().len(), 3);
    store
        .append_message(&forked.id, "user", "branch-only", None, None, None)
        .await
        .unwrap();
    assert_eq!(store.get_messages("src").await.unwrap().len(), 3);
    assert_eq!(store.get_messages(&forked.id).await.unwrap().len(), 3);
}

#[tokio::test]
async fn fork_missing_source_or_message_returns_none() {
    let store = ConversationStore::open_in_memory().unwrap();
    assert!(store
        .fork_conversation("nope", None, Tenancy::Unattributed)
        .await
        .unwrap()
        .is_none());
    store
        .append_message("src2", "user", "hi", None, None, None)
        .await
        .unwrap();
    assert!(store
        .fork_conversation("src2", Some("not-a-real-id"), Tenancy::Unattributed)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn get_recent_returns_tail_in_order() {
    let store = ConversationStore::open_in_memory().unwrap();
    for n in 0..5 {
        store
            .append_message("conv-r", "user", &format!("msg {n}"), None, None, None)
            .await
            .unwrap();
    }
    let recent = store.get_recent_messages("conv-r", 2).await.unwrap();
    assert_eq!(recent.len(), 2);
    // Newest two, in chronological order.
    assert_eq!(recent[0].content, "msg 3");
    assert_eq!(recent[1].content, "msg 4");
}

pub(super) fn contents(messages: &[StoredMessage]) -> Vec<&str> {
    messages.iter().map(|m| m.content.as_str()).collect()
}

#[tokio::test]
async fn get_recent_follows_the_active_thread_after_rewind_and_edit() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-branched";
    for (role, text) in [("user", "u1"), ("assistant", "a1")] {
        store
            .append_message(conv, role, text, None, None, None)
            .await
            .unwrap();
    }
    let u2 = store
        .append_message(conv, "user", "u2", None, None, None)
        .await
        .unwrap();
    store
        .append_message(conv, "assistant", "a2", None, None, None)
        .await
        .unwrap();

    // Rewinding to before u2 must keep the rewound pair out of the replay.
    store
        .rewind_to_message(conv, &u2)
        .await
        .unwrap()
        .expect("rewound");
    let u3 = store
        .append_message(conv, "user", "u3", None, None, None)
        .await
        .unwrap();
    let recent = store.get_recent_messages(conv, 10).await.unwrap();
    assert_eq!(contents(&recent), ["u1", "a1", "u3"]);
    let recent = store.get_recent_messages(conv, 2).await.unwrap();
    assert_eq!(contents(&recent), ["a1", "u3"], "limit keeps the newest");

    // Editing u3 drops the original question and its answer.
    store
        .append_message(conv, "assistant", "a3", None, None, None)
        .await
        .unwrap();
    store
        .edit_user_message(conv, &u3, "u3 edited")
        .await
        .unwrap()
        .expect("edited");
    store
        .append_message(conv, "assistant", "a3 edited", None, None, None)
        .await
        .unwrap();
    let recent = store.get_recent_messages(conv, 10).await.unwrap();
    assert_eq!(contents(&recent), ["u1", "a1", "u3 edited", "a3 edited"]);
}

#[tokio::test]
async fn fork_of_a_branched_conversation_copies_only_the_cut_points_thread() {
    let store = ConversationStore::open_in_memory().unwrap();
    for (role, text) in [("user", "u1"), ("assistant", "a1")] {
        store
            .append_message("src", role, text, None, None, None)
            .await
            .unwrap();
    }
    let u2 = store
        .append_message("src", "user", "u2", None, None, None)
        .await
        .unwrap();
    let a2 = store
        .append_message("src", "assistant", "a2", None, None, None)
        .await
        .unwrap();
    store
        .edit_user_message("src", &u2, "u2 edited")
        .await
        .unwrap()
        .expect("edited");
    let a2_edited = store
        .append_message("src", "assistant", "a2 edited", None, None, None)
        .await
        .unwrap();
    store
        .prepare_regenerate("src", &a2_edited)
        .await
        .unwrap()
        .expect("regenerate");
    let newest = store
        .append_message("src", "assistant", "a2 regenerated", None, None, None)
        .await
        .unwrap();
    assert!(store
        .set_agent_ui_state("src", "call-1", r#"{"state":{"done":true}}"#)
        .await
        .unwrap());

    let thread = ["u1", "a1", "u2 edited", "a2 regenerated"];
    for cut in [None, Some(newest.as_str())] {
        let forked = store
            .fork_conversation("src", cut, Tenancy::Unattributed)
            .await
            .unwrap()
            .expect("fork");
        assert_eq!(forked.message_count, 4);
        let copied = store.get_active_messages(&forked.id).await.unwrap();
        assert_eq!(contents(&copied), thread);
        assert_eq!(
            store.list_agent_ui_states(&forked.id).await.unwrap().len(),
            1,
            "a fork of the whole active thread keeps its widget state"
        );
    }

    // A cut on an inactive version copies that version's own ancestry.
    let forked = store
        .fork_conversation("src", Some(&a2), Tenancy::Unattributed)
        .await
        .unwrap()
        .expect("fork of an inactive version");
    let copied = store.get_active_messages(&forked.id).await.unwrap();
    assert_eq!(contents(&copied), ["u1", "a1", "u2", "a2"]);
    assert!(store
        .list_agent_ui_states(&forked.id)
        .await
        .unwrap()
        .is_empty());
}

pub(super) async fn seed_conversation_history_rows(
    store: &ConversationStore,
    conversation_id: &str,
) {
    let conn = store.conn.lock().await;
    conn.execute(
        "INSERT INTO conversation_title_history (id, conversation_id, title, source, created_at)
             VALUES (?1, ?2, 'old title', 'auto', 1)",
        params![format!("title-{conversation_id}"), conversation_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversation_model_changes (id, conversation_id, selection_kind, created_at)
             VALUES (?1, ?2, 'initial', 1)",
        params![format!("change-{conversation_id}"), conversation_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO conversation_context_handoffs
                (id, conversation_id, model_change_id, outcome, reason, summarized_count,
                 boundary_at, summary, created_at)
             VALUES (?1, ?2, ?3, 'applied', 'switch', 1, 1, 'digest of the chat', 1)",
        params![
            format!("handoff-{conversation_id}"),
            conversation_id,
            format!("change-{conversation_id}")
        ],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO agent_controls (conversation_id, requested_by, requested_at)
             VALUES (?1, 'someone', 1)",
        params![conversation_id],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO run_auto_resume (conversation_id, user_message_id, attempts, updated_at)
             VALUES (?1, 'turn', 1, 1)",
        params![conversation_id],
    )
    .unwrap();
}

pub(super) async fn conversation_history_row_count(
    store: &ConversationStore,
    conversation_id: &str,
) -> i64 {
    let conn = store.conn.lock().await;
    CONVERSATION_SCOPED_HISTORY_TABLES
        .iter()
        .map(|table| {
            conn.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE conversation_id = ?1"),
                params![conversation_id],
                |row| row.get::<_, i64>(0),
            )
            .unwrap()
        })
        .sum()
}
