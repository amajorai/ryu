//! Conversation store tests: reactions and receipts.

use super::*;

#[tokio::test]
async fn agent_ui_state_round_trips_updates_caps_and_deletes_with_the_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-ui", "user", "make me a checklist", None, None, None)
        .await
        .unwrap();
    assert!(store
        .list_agent_ui_states("conv-ui")
        .await
        .unwrap()
        .is_empty());

    let first = serde_json::json!({ "todo": [{ "label": "Pack", "done": true }] });
    assert!(store
        .set_agent_ui_state("conv-ui", "call-1", &first.to_string())
        .await
        .unwrap());
    // Updating the same widget replaces its state rather than adding a row.
    let second = serde_json::json!({ "todo": [{ "label": "Pack", "done": false }] });
    assert!(store
        .set_agent_ui_state("conv-ui", "call-1", &second.to_string())
        .await
        .unwrap());
    let saved = store.list_agent_ui_states("conv-ui").await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].tool_call_id, "call-1");
    assert_eq!(saved[0].state, second);
    // Other conversations never see it.
    assert!(store
        .list_agent_ui_states("conv-other")
        .await
        .unwrap()
        .is_empty());

    // The per-conversation cap refuses NEW widgets but still accepts updates.
    for index in 1..MAX_AGENT_UI_STATES {
        assert!(store
            .set_agent_ui_state("conv-ui", &format!("fill-{index}"), "{}")
            .await
            .unwrap());
    }
    assert!(!store
        .set_agent_ui_state("conv-ui", "one-too-many", "{}")
        .await
        .unwrap());
    assert!(store
        .set_agent_ui_state("conv-ui", "call-1", &first.to_string())
        .await
        .unwrap());

    assert!(store.delete_conversation("conv-ui").await.unwrap());
    assert!(store
        .list_agent_ui_states("conv-ui")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn message_reactions_aggregate_per_emoji_and_resolve_the_viewer() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-x", "user", "ship it?", None, None, None)
        .await
        .unwrap();
    let asst = store
        .append_message("conv-x", "assistant", "shipped", None, None, None)
        .await
        .unwrap();

    // Nothing yet.
    assert!(store
        .list_reactions("conv-x", "alice")
        .await
        .unwrap()
        .is_empty());

    assert!(store
        .add_reaction("conv-x", &asst, "alice", "🎉")
        .await
        .unwrap());
    let seen = store.list_reactions("conv-x", "alice").await.unwrap();
    assert_eq!(
        seen,
        vec![MessageReaction {
            message_id: asst.clone(),
            emoji: "🎉".to_owned(),
            count: 1,
            reacted_by_me: true,
        }]
    );
    // Bob sees the same bucket, but it is not his.
    assert!(!store.list_reactions("conv-x", "bob").await.unwrap()[0].reacted_by_me);

    // A second user on the same emoji aggregates into one bucket; both see
    // themselves in it.
    assert!(store
        .add_reaction("conv-x", &asst, "bob", "🎉")
        .await
        .unwrap());
    for viewer in ["alice", "bob"] {
        let seen = store.list_reactions("conv-x", viewer).await.unwrap();
        assert_eq!(seen.len(), 1, "one bucket for one emoji");
        assert_eq!(seen[0].count, 2);
        assert!(seen[0].reacted_by_me, "{viewer} reacted");
    }

    // Double-tapping is idempotent — no PK error, no double count.
    assert!(store
        .add_reaction("conv-x", &asst, "alice", "🎉")
        .await
        .unwrap());
    assert_eq!(
        store.list_reactions("conv-x", "alice").await.unwrap()[0].count,
        2
    );

    // A different emoji is a separate bucket.
    assert!(store
        .add_reaction("conv-x", &asst, "alice", "👀")
        .await
        .unwrap());
    assert_eq!(
        store.list_reactions("conv-x", "alice").await.unwrap().len(),
        2
    );

    // Removing drops only this user's row from the bucket.
    assert!(store
        .remove_reaction("conv-x", &asst, "alice", "🎉")
        .await
        .unwrap());
    let seen = store.list_reactions("conv-x", "alice").await.unwrap();
    let party = seen.iter().find(|r| r.emoji == "🎉").expect("bucket kept");
    assert_eq!(party.count, 1);
    assert!(!party.reacted_by_me);
    // Removing again is a harmless no-op, not an error.
    assert!(store
        .remove_reaction("conv-x", &asst, "alice", "🎉")
        .await
        .unwrap());
}

#[tokio::test]
async fn message_reactions_allow_a_peer_agent_authored_message() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "conv-agents-reactions",
            "user",
            "review this",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    let alpha_message = store
        .append_message(
            "conv-agents-reactions",
            "assistant",
            "alpha's review",
            Some("agent-alpha"),
            None,
            None,
        )
        .await
        .unwrap();
    let beta_message = store
        .append_message(
            "conv-agents-reactions",
            "assistant",
            "beta's follow-up",
            Some("agent-beta"),
            None,
            None,
        )
        .await
        .unwrap();

    // The reaction writer is a different agent from both message authors.
    // The persisted-message gate checks conversation membership, not role or
    // agent ownership, so peer-agent replies remain reactable.
    assert!(store
        .add_reaction(
            "conv-agents-reactions",
            &alpha_message,
            "agent:agent-reviewer",
            "✅",
        )
        .await
        .unwrap());
    assert!(store
        .add_reaction(
            "conv-agents-reactions",
            &beta_message,
            "agent:agent-reviewer",
            "👀",
        )
        .await
        .unwrap());

    let reactions = store
        .list_reactions("conv-agents-reactions", "agent:agent-reviewer")
        .await
        .unwrap();
    assert_eq!(reactions.len(), 2);
    assert!(reactions.iter().any(|reaction| {
        reaction.message_id == alpha_message && reaction.emoji == "✅" && reaction.reacted_by_me
    }));
    assert!(reactions.iter().any(|reaction| {
        reaction.message_id == beta_message && reaction.emoji == "👀" && reaction.reacted_by_me
    }));
}

#[tokio::test]
async fn agent_reactions_on_latest_user_message_ignore_people_and_older_turns() {
    let store = ConversationStore::open_in_memory().unwrap();
    assert_eq!(
        store.latest_user_message_id("conv-ack").await.unwrap(),
        None
    );
    assert!(store
        .agent_reactions_on_latest_user_message("conv-ack")
        .await
        .unwrap()
        .is_empty());
    let first = store
        .append_message("conv-ack", "user", "first", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-ack", "assistant", "ok", Some("agent-a"), None, None)
        .await
        .unwrap();
    let latest = store
        .append_message("conv-ack", "user", "yea find useful ones", None, None, None)
        .await
        .unwrap();
    store
        .append_message(
            "conv-ack",
            "assistant",
            "on it",
            Some("agent-a"),
            None,
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        store.latest_user_message_id("conv-ack").await.unwrap(),
        Some(latest.clone())
    );

    for (message, actor, emoji) in [
        (&first, "agent:agent-a", "🎉"),
        (&latest, "human-user", "❤️"),
        (&latest, "agent:agent-a", "👍"),
        (&latest, "agent:agent-b", "👍"),
        (&latest, "agent:agent-b", "🙏"),
    ] {
        assert!(store
            .add_reaction("conv-ack", message, actor, emoji)
            .await
            .unwrap());
    }
    assert_eq!(
        store
            .agent_reactions_on_latest_user_message("conv-ack")
            .await
            .unwrap(),
        vec!["👍".to_owned(), "🙏".to_owned()]
    );
}

#[tokio::test]
async fn message_reactions_are_gated_on_a_persisted_message_of_this_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    let msg = store
        .append_message("conv-g", "assistant", "hi", None, None, None)
        .await
        .unwrap();

    // A client-generated id for a still-streaming reply has no row yet: false
    // (→ 404 at the route). This IS the persistence gate — there is no
    // `allow_latest_fallback` retarget for reactions.
    assert!(!store
        .add_reaction("conv-g", "client-generated-id", "alice", "🎉")
        .await
        .unwrap());
    // …and no orphan row was written.
    assert!(store
        .list_reactions("conv-g", "alice")
        .await
        .unwrap()
        .is_empty());

    // A real id under the WRONG conversation is equally refused.
    assert!(!store
        .add_reaction("conv-other", &msg, "alice", "🎉")
        .await
        .unwrap());
    assert!(!store
        .remove_reaction("conv-other", &msg, "alice", "🎉")
        .await
        .unwrap());
}

#[tokio::test]
async fn read_receipts_are_per_user_idempotent_and_message_scoped() {
    let store = ConversationStore::open_in_memory().unwrap();
    let first = store
        .append_message("conv-read", "user", "first", None, Some("alice"), None)
        .await
        .unwrap();
    let second = store
        .append_message("conv-read", "user", "second", None, Some("alice"), None)
        .await
        .unwrap();

    let first_mark = store
        .mark_messages_read(
            "conv-read",
            &[first.clone(), second.clone(), "not-in-this-chat".to_owned()],
            "bob",
            Some("bob@example.test"),
        )
        .await
        .unwrap();
    assert_eq!(first_mark.len(), 2);
    assert!(first_mark.iter().all(|receipt| {
        receipt.user_id == "bob"
            && receipt.read_at.contains('T')
            && receipt.user_name.as_deref() == Some("bob@example.test")
    }));

    // Retrying the same batch produces no second event/row.
    assert!(store
        .mark_messages_read("conv-read", &[first.clone(), second.clone()], "bob", None,)
        .await
        .unwrap()
        .is_empty());

    // A second person gets an independent receipt, while a different
    // conversation cannot attach to these message ids.
    assert_eq!(
        store
            .mark_messages_read("conv-read", std::slice::from_ref(&first), "carol", None,)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(store
        .mark_messages_read("conv-other", std::slice::from_ref(&first), "dave", None,)
        .await
        .unwrap()
        .is_empty());

    let listed = store.list_read_receipts("conv-read").await.unwrap();
    assert_eq!(listed.len(), 3);
    assert!(listed
        .iter()
        .any(|receipt| { receipt.message_id == first && receipt.user_id == "carol" }));

    assert!(store.delete_conversation("conv-read").await.unwrap());
    assert!(store
        .list_read_receipts("conv-read")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn read_receipts_publish_a_named_live_event_once() {
    let registry = ryu_realtime::RoomRegistry::new();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_realtime(registry.clone());
    let message_id = store
        .append_message(
            "conv-realtime-read",
            "user",
            "live message",
            None,
            Some("alice"),
            None,
        )
        .await
        .unwrap();
    let mut receiver = registry.get_or_create("conv-realtime-read").subscribe();

    let receipts = store
        .mark_messages_read(
            "conv-realtime-read",
            std::slice::from_ref(&message_id),
            "bob",
            Some("bob@example.test"),
        )
        .await
        .unwrap();
    assert_eq!(receipts.len(), 1);
    let frame = receiver.recv().await.unwrap();
    let event = ryu_realtime::Event::decode(&frame).expect("named read event");
    assert_eq!(event.name, "conversation.readReceipt");
    assert_eq!(event.payload["type"], "readReceipt");
    assert_eq!(event.payload["conversationId"], "conv-realtime-read");
    assert_eq!(event.payload["messageId"], message_id);
    assert_eq!(event.payload["userId"], "bob");
    assert_eq!(event.payload["userName"], "bob@example.test");

    // Idempotent retries do not produce another room event.
    assert!(store
        .mark_messages_read(
            "conv-realtime-read",
            std::slice::from_ref(&message_id),
            "bob",
            None,
        )
        .await
        .unwrap()
        .is_empty());
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(20), receiver.recv())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn deleting_a_conversation_removes_its_reactions() {
    // FK enforcement is off, so this only holds because `delete_conversation`
    // drops the rows by hand.
    let store = ConversationStore::open_in_memory().unwrap();
    let msg = store
        .append_message("conv-d", "assistant", "bye", None, None, None)
        .await
        .unwrap();
    assert!(store
        .add_reaction("conv-d", &msg, "alice", "👋")
        .await
        .unwrap());

    assert!(store.delete_conversation("conv-d").await.unwrap());

    // Query the table directly: `list_reactions` would also pass on an empty
    // result, but this proves no row survived under the old conversation id.
    let conn = store.conn.lock().await;
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_reactions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 0, "reactions must not outlive their conversation");
}
