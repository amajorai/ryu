//! Conversation store tests: clearing and previews.

use super::*;

#[tokio::test]
async fn bulk_clear_removes_reactions_and_legacy_orphans_stay_hidden() {
    let store = ConversationStore::open_in_memory().unwrap();
    let message_id = store
        .append_message("conv-clear", "assistant", "bye", None, None, None)
        .await
        .unwrap();
    store
        .add_reaction("conv-clear", &message_id, "alice", "👋")
        .await
        .unwrap();

    assert_eq!(store.clear_all_conversations().await.unwrap().removed, 1);
    let conn = store.conn.lock().await;
    let left: i64 = conn
        .query_row("SELECT COUNT(*) FROM message_reactions", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(left, 0);
    conn.execute(
        "INSERT INTO message_reactions
                (message_id, conversation_id, user_id, emoji, created_at)
             VALUES ('old-message', 'conv-clear', 'alice', '👋', 1)",
        [],
    )
    .unwrap();
    drop(conn);

    store
        .append_message("conv-clear", "assistant", "new", None, None, None)
        .await
        .unwrap();
    assert!(store
        .list_reactions("conv-clear", "alice")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn owner_scoped_clear_removes_only_that_owners_reactions() {
    let store = ConversationStore::open_in_memory().unwrap();
    let alice_message = store
        .append_message_as(
            "shared-id",
            "assistant",
            "alice old",
            None,
            Some("alice"),
            None,
            Tenancy::Owned {
                user_id: "alice".to_owned(),
                org_id: Some("org-1".to_owned()),
            },
        )
        .await
        .unwrap();
    let bob_message = store
        .append_message_as(
            "bob-chat",
            "assistant",
            "bob",
            None,
            Some("bob"),
            None,
            Tenancy::Owned {
                user_id: "bob".to_owned(),
                org_id: Some("org-1".to_owned()),
            },
        )
        .await
        .unwrap();
    store
        .add_reaction("shared-id", &alice_message, "alice", "🔒")
        .await
        .unwrap();
    store
        .add_reaction("bob-chat", &bob_message, "bob", "✅")
        .await
        .unwrap();

    assert_eq!(
        store
            .clear_conversations_owned_by("alice")
            .await
            .unwrap()
            .removed,
        1
    );
    assert_eq!(
        store.list_reactions("bob-chat", "bob").await.unwrap().len(),
        1
    );

    store
        .append_message_as(
            "shared-id",
            "assistant",
            "bob new",
            None,
            Some("bob"),
            None,
            Tenancy::Owned {
                user_id: "bob".to_owned(),
                org_id: Some("org-1".to_owned()),
            },
        )
        .await
        .unwrap();
    assert!(store
        .list_reactions("shared-id", "bob")
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn turn_resolution_pairs_second_assistant_reply_to_the_user() {
    // Regenerate / council case: a second consecutive assistant reply must
    // still pair to the preceding user turn (not return None).
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-r", "user", "what is 2+2", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-r", "assistant", "first attempt: 4", None, None, None)
        .await
        .unwrap();
    let second = store
        .append_message(
            "conv-r",
            "assistant",
            "regenerated: it is 4",
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let turn = store
        .get_turn_for_assistant_message("conv-r", &second)
        .await
        .unwrap()
        .expect("second assistant reply resolves to the preceding user turn");
    assert_eq!(turn.0, "what is 2+2");
    assert_eq!(turn.1, "regenerated: it is 4");
}

#[tokio::test]
async fn list_orders_by_recency_and_counts() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-a", "user", "first", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-b", "user", "second", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-a", "assistant", "reply", None, None, None)
        .await
        .unwrap();

    let list = store.list_conversations().await.unwrap();
    assert_eq!(list.len(), 2);
    // conv-a was updated last, so it sorts first.
    assert_eq!(list[0].id, "conv-a");
    assert_eq!(list[0].message_count, 2);
    assert_eq!(list[0].title.as_deref(), Some("first"));
    // The default listing stays preview-free — every other lister (runs, sync
    // replay, the learning pass) rides this path and must not pay for it.
    assert_eq!(list[0].last_message, None);
    assert_eq!(list[0].last_message_at, None);
}

#[tokio::test]
async fn preview_listing_returns_the_newest_message_decrypted_and_flattened() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-a", "user", "first", None, None, None)
        .await
        .unwrap();
    store
        .append_message(
            "conv-a",
            "assistant",
            "line one\n\n   line two",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store
        .append_message("conv-b", "user", "only message", None, None, None)
        .await
        .unwrap();

    let list = store
        .list_conversations_visible_with_preview(None, None, false)
        .await
        .unwrap();
    let a = list
        .iter()
        .find(|c| c.id == "conv-a")
        .expect("conv-a listed");
    // Newest wins, it comes back decrypted, and the newlines are flattened so
    // the two-line sidebar row cannot grow a third line.
    assert_eq!(a.last_message.as_deref(), Some("line one line two"));
    assert_eq!(a.last_message_role.as_deref(), Some("assistant"));
    assert!(a.last_message_at.unwrap_or(0) > 0);

    let b = list
        .iter()
        .find(|c| c.id == "conv-b")
        .expect("conv-b listed");
    assert_eq!(b.last_message.as_deref(), Some("only message"));
    assert_eq!(b.last_message_role.as_deref(), Some("user"));
}

#[tokio::test]
async fn preview_skips_non_conversational_roles() {
    // Sync replay and thread import copy a peer's role verbatim, so a `tool`
    // row can be the newest message. Previewing it would put a raw tool
    // payload where the sidebar promises the last thing that was said.
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-t", "user", "run the build", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-t", "assistant", "building now", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-t", "tool", "{\"exit\":0}", None, None, None)
        .await
        .unwrap();

    let list = store
        .list_conversations_visible_with_preview(None, None, false)
        .await
        .unwrap();
    let conv = list.iter().find(|c| c.id == "conv-t").expect("listed");
    assert_eq!(conv.last_message.as_deref(), Some("building now"));
    assert_eq!(conv.last_message_role.as_deref(), Some("assistant"));
}

#[test]
fn preview_line_caps_a_long_body() {
    let long = "x".repeat(PREVIEW_MAX_CHARS * 3);
    let preview = preview_line(&long);
    // Capped at the limit plus the ellipsis — a 40 KB tool dump never reaches
    // the sidebar.
    assert_eq!(preview.chars().count(), PREVIEW_MAX_CHARS + 1);
    assert!(preview.ends_with('…'));
}

#[tokio::test]
async fn delete_removes_conversation_and_messages() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-x", "user", "to delete", None, None, None)
        .await
        .unwrap();
    assert!(store.delete_conversation("conv-x").await.unwrap());
    assert!(store.get_messages("conv-x").await.unwrap().is_empty());
    assert!(!store.delete_conversation("conv-x").await.unwrap());
}

#[tokio::test]
async fn delete_removes_proactive_opening_tombstones() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-recreated", "user", "hello", None, None, None)
        .await
        .unwrap();
    assert!(store
        .claim_proactive_opening("opening-recreated", "conv-recreated")
        .await
        .unwrap());
    store
        .complete_proactive_opening("opening-recreated")
        .await
        .unwrap();

    assert!(store.delete_conversation("conv-recreated").await.unwrap());
    assert_eq!(
        store
            .proactive_opening_status("opening-recreated")
            .await
            .unwrap(),
        None
    );
    // Recreating the same conversation id starts with a fresh idempotency
    // lifecycle instead of inheriting the deleted row's completed tombstone.
    assert!(store
        .claim_proactive_opening("opening-recreated", "conv-recreated")
        .await
        .unwrap());
}

#[tokio::test]
async fn sealed_content_count_separates_sealed_rows_from_legacy_plaintext() {
    // The Encryption settings tab reports this as MEASURED coverage, so a
    // legacy plaintext row must drag the count down, not be assumed sealed.
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-a", "user", "sealed on write", None, None, None)
        .await
        .unwrap();
    let (sealed, total) = store.count_sealed_content().await.unwrap();
    assert!(total > 0, "the written row must be counted");
    assert_eq!(sealed, total, "everything written now is sealed");
    let before = total;

    // A row from before encryption landed: plaintext, no `enc:v1:` prefix.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('legacy', 'conv-a', 'user', 'written before encryption', 0)",
            [],
        )
        .unwrap();
    }
    let (sealed, total) = store.count_sealed_content().await.unwrap();
    assert_eq!(total, before + 1, "the legacy row is counted in the total");
    assert_eq!(sealed, before, "legacy plaintext must count as open");
}

#[tokio::test]
async fn clear_all_removes_every_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-a", "user", "hi", None, None, None)
        .await
        .unwrap();
    store
        .append_message("conv-b", "user", "yo", None, None, None)
        .await
        .unwrap();
    assert_eq!(store.count_conversations().await.unwrap(), 2);
    // Saved widget state and reactions have no FK, so the wipe must remove
    // them explicitly rather than leave sealed orphans behind.
    store
        .set_agent_ui_state("conv-a", "call-1", r#"{"state":{"typed":"secret"}}"#)
        .await
        .unwrap();
    let message_id = store.get_messages("conv-b").await.unwrap()[0].id.clone();
    assert!(store
        .add_reaction("conv-b", &message_id, "me", "👍")
        .await
        .unwrap());

    let removed = store.clear_all_conversations().await.unwrap().removed;
    assert_eq!(removed, 2);
    assert_eq!(store.count_conversations().await.unwrap(), 0);
    assert!(store.list_conversations().await.unwrap().is_empty());
    let conn = store.conn.lock().await;
    let leftover: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM agent_ui_state)
                      + (SELECT COUNT(*) FROM message_reactions)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        leftover, 0,
        "clearing all chats left widget state or reactions"
    );
}
