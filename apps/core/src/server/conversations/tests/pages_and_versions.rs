//! Conversation store tests: pages and versions.

use super::*;

#[tokio::test]
async fn messages_carry_author_name() {
    // Group/channel support: a connector-supplied sender display name is
    // persisted on the user message and read back, while agent/1:1 messages
    // carry no author_name. (`author_user_id` stays None — author_name is the
    // unverified display label, distinct from a verified identity.)
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "conv-grp",
            "user",
            "Alice: hi team",
            None,
            None,
            Some("Alice"),
        )
        .await
        .unwrap();
    store
        .append_message(
            "conv-grp",
            "assistant",
            "hello",
            Some("agent-x"),
            None,
            None,
        )
        .await
        .unwrap();

    let msgs = store.get_messages("conv-grp").await.unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!(msgs[0].author_name.as_deref(), Some("Alice"));
    assert_eq!(
        msgs[0].author_user_id, None,
        "display name is not a verified id"
    );
    assert_eq!(
        msgs[1].author_name, None,
        "agent message has no author_name"
    );
}

#[tokio::test]
async fn get_conversation_detail_includes_participants() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("conv-detail", "user", "hi", Some("agent-x"), None, None)
        .await
        .unwrap();
    store
        .add_participant("conv-detail", "agent-x", Tenancy::Unattributed)
        .await
        .unwrap();
    store
        .add_participant("conv-detail", "agent-y", Tenancy::Unattributed)
        .await
        .unwrap();

    let detail = store
        .get_conversation_detail("conv-detail")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.id, "conv-detail");
    assert_eq!(detail.participants.len(), 2);
    assert!(detail.participants.contains(&"agent-x".to_owned()));
    assert!(detail.participants.contains(&"agent-y".to_owned()));
    assert_eq!(detail.messages.len(), 1);
}

#[tokio::test]
async fn saving_a_temporary_snapshot_is_atomic_and_preserves_parts() {
    let store = ConversationStore::open_in_memory().unwrap();
    let messages = vec![
        TemporaryConversationMessage {
            metadata: None,
            role: "user".to_owned(),
            content: "Plan a private launch review".to_owned(),
            agent_id: None,
            author_user_id: None,
            parts: Some(
                serde_json::json!([{ "type": "text", "text": "Plan a private launch review" }]),
            ),
            created_at: 10,
        },
        TemporaryConversationMessage {
            metadata: None,
            role: "assistant".to_owned(),
            content: "Here is a concise review plan.".to_owned(),
            agent_id: Some("agent-x".to_owned()),
            author_user_id: None,
            parts: Some(serde_json::json!([
                { "type": "text", "text": "Here is a concise review plan." },
                { "type": "data-note", "data": { "kind": "temporary" } }
            ])),
            created_at: 11,
        },
    ];

    let summary = store
        .save_temporary_conversation(
            "temporary-1",
            Some("agent-x"),
            Some("/tmp/project"),
            &messages,
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    assert_eq!(summary.id, "temporary-1");
    assert_eq!(
        summary.title.as_deref(),
        Some("Plan a private launch review")
    );
    assert_eq!(summary.message_count, 2);
    assert_eq!(summary.folder_path.as_deref(), Some("/tmp/project"));

    let detail = store
        .get_conversation_detail("temporary-1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.messages.len(), 2);
    assert_eq!(detail.messages[0].content, messages[0].content);
    assert_eq!(detail.messages[1].parts, messages[1].parts);
    assert!(store
        .save_temporary_conversation(
            "temporary-1",
            Some("agent-x"),
            None,
            &messages,
            Tenancy::Unattributed,
        )
        .await
        .is_err());
}

#[tokio::test]
async fn conversation_message_pages_walk_backwards_from_latest() {
    let store = ConversationStore::open_in_memory().unwrap();
    for index in 0..5 {
        store
            .append_message(
                "conv-page",
                if index % 2 == 0 { "user" } else { "assistant" },
                &format!("message-{index}"),
                Some("agent-x"),
                None,
                None,
            )
            .await
            .unwrap();
    }

    let latest = store
        .get_conversation_message_page("conv-page", None, 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        latest
            .messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>(),
        ["message-3", "message-4"]
    );
    assert!(latest.has_older_messages);
    let cursor = latest.older_messages_cursor.clone().unwrap();

    let middle = store
        .get_conversation_message_page("conv-page", Some(&cursor), 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        middle
            .messages
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>(),
        ["message-1", "message-2"]
    );
    assert!(middle.has_older_messages);

    let oldest_cursor = middle.older_messages_cursor.clone().unwrap();
    let oldest = store
        .get_conversation_message_page("conv-page", Some(&oldest_cursor), 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(oldest.messages.len(), 1);
    assert_eq!(oldest.messages[0].content, "message-0");
    assert!(!oldest.has_older_messages);
    assert_eq!(oldest.older_messages_cursor, None);
}

// ── Version tree (edit + regenerate + select) ──────────────────────────

/// Seed a 2-turn flat conversation: user "q1" → assistant "a1". Returns the
/// two message ids.
pub(super) async fn seed_flat(store: &ConversationStore, conv: &str) -> (String, String) {
    let u = store
        .append_message(conv, "user", "q1", Some("agent-x"), None, None)
        .await
        .unwrap();
    let a = store
        .append_message(conv, "assistant", "a1", Some("agent-x"), None, None)
        .await
        .unwrap();
    (u, a)
}

#[tokio::test]
async fn branched_pages_read_only_returned_payloads_and_preserve_cursor_order() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("branch-perf", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        for number in 0..1000 {
            let parent = (number > 0).then(|| format!("active-{}", number - 1));
            for prefix in ["active", "alternate"] {
                conn.execute(
                    "INSERT INTO messages(id, conversation_id, role, content, created_at, parent_message_id)
                         VALUES (?1, 'branch-perf', 'user', 'history body', 1, ?2)",
                    params![format!("{prefix}-{number}"), parent],
                ).unwrap();
            }
        }
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = 'active-999'
                WHERE id = 'branch-perf'",
            [],
        )
        .unwrap();
    }
    store.content_reads.store(0, Ordering::Relaxed);
    let page = store
        .get_conversation_message_page("branch-perf", None, 20)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 20);
    assert_eq!(page.messages.first().unwrap().id, "active-980");
    assert_eq!(page.messages.last().unwrap().id, "active-999");
    assert!(page.has_older_messages);
    assert!(page
        .messages
        .iter()
        .all(|message| message.sibling_count == 2 && message.sibling_index == 0));
    store.content_reads.store(0, Ordering::Relaxed);
    let older = store
        .get_conversation_message_page("branch-perf", page.older_messages_cursor.as_deref(), 20)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(older.messages.first().unwrap().id, "active-960");
    assert_eq!(older.messages.last().unwrap().id, "active-979");
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 20);
    let invalid = store
        .get_conversation_message_page("branch-perf", Some("alternate-500"), 20)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(invalid.messages.first().unwrap().id, "active-980");
    let oldest = store
        .get_conversation_message_page("branch-perf", Some("active-10"), 20)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(oldest.messages.len(), 10);
    assert!(!oldest.has_older_messages);
    assert_eq!(
        oldest.messages[0].sibling_ids,
        vec!["active-0", "alternate-0"]
    );
    store.content_reads.store(0, Ordering::Relaxed);
    assert_eq!(
        store
            .get_active_messages("branch-perf")
            .await
            .unwrap()
            .len(),
        1000
    );
    assert_eq!(
        store.content_reads.load(Ordering::Relaxed),
        1000,
        "inactive branches are never opened"
    );
}

#[tokio::test]
async fn flat_conversation_stays_flat_until_edited() {
    let store = ConversationStore::open_in_memory().unwrap();
    seed_flat(&store, "conv-flat").await;
    // No branching yet: active messages == flat messages, no siblings, no
    // parent links (byte-identical to pre-tree behavior).
    let active = store.get_active_messages("conv-flat").await.unwrap();
    assert_eq!(active.len(), 2);
    assert!(active.iter().all(|m| m.parent_message_id.is_none()));
    assert!(active.iter().all(|m| m.sibling_count == 1));
}

#[tokio::test]
async fn edit_user_message_creates_sibling_and_switches_active_path() {
    let store = ConversationStore::open_in_memory().unwrap();
    let (u, _a) = seed_flat(&store, "conv-edit").await;

    // Edit the user turn → new sibling, leaf now points at it. The old
    // assistant reply drops off the active path (its parent is the ORIGINAL
    // user turn, not the edit).
    let u2 = store
        .edit_user_message("conv-edit", &u, "q1-edited")
        .await
        .unwrap()
        .expect("edit returns new id");
    assert_ne!(u2, u);

    let active = store.get_active_messages("conv-edit").await.unwrap();
    assert_eq!(active.len(), 1, "only the edited user turn is active");
    assert_eq!(active[0].id, u2);
    assert_eq!(active[0].content, "q1-edited");
    // Two versions at this branch point: original + edit.
    assert_eq!(active[0].sibling_count, 2);
    assert_eq!(active[0].sibling_index, 1, "edit is the newer version");

    // A generated reply now attaches beneath the edit.
    store
        .append_message("conv-edit", "assistant", "a2", Some("agent-x"), None, None)
        .await
        .unwrap();
    let active = store.get_active_messages("conv-edit").await.unwrap();
    assert_eq!(active.len(), 2);
    assert_eq!(active[1].content, "a2");
    assert_eq!(active[1].parent_message_id.as_deref(), Some(u2.as_str()));
}

#[tokio::test]
async fn select_version_restores_the_other_branch() {
    let store = ConversationStore::open_in_memory().unwrap();
    let (u, _a) = seed_flat(&store, "conv-sel").await;
    let u2 = store
        .edit_user_message("conv-sel", &u, "q1-edited")
        .await
        .unwrap()
        .unwrap();
    store
        .append_message("conv-sel", "assistant", "a2", Some("agent-x"), None, None)
        .await
        .unwrap();

    // Switch back to the ORIGINAL user version → its subtree (assistant "a1")
    // returns as the active path.
    let leaf = store
        .select_version("conv-sel", &u)
        .await
        .unwrap()
        .expect("select returns a leaf");
    let active = store.get_active_messages("conv-sel").await.unwrap();
    assert_eq!(active.len(), 2);
    assert_eq!(active[0].id, u);
    assert_eq!(active[0].content, "q1");
    assert_eq!(active[1].content, "a1");
    assert_eq!(active[1].id, leaf);

    // Flip forward to the edit again.
    store.select_version("conv-sel", &u2).await.unwrap();
    let active = store.get_active_messages("conv-sel").await.unwrap();
    assert_eq!(active[0].content, "q1-edited");
    assert_eq!(active[1].content, "a2");
}

#[tokio::test]
async fn regenerate_creates_assistant_sibling_under_same_user_turn() {
    let store = ConversationStore::open_in_memory().unwrap();
    let (u, a) = seed_flat(&store, "conv-regen").await;

    // Regenerate the assistant reply → leaf moves to the user turn above it.
    let parent = store
        .prepare_regenerate("conv-regen", &a)
        .await
        .unwrap()
        .expect("regenerate returns parent");
    assert_eq!(parent, u);

    // The fresh generation appends as a sibling of the old assistant reply.
    store
        .append_message(
            "conv-regen",
            "assistant",
            "a1-v2",
            Some("agent-x"),
            None,
            None,
        )
        .await
        .unwrap();
    let active = store.get_active_messages("conv-regen").await.unwrap();
    assert_eq!(active.len(), 2);
    assert_eq!(active[1].content, "a1-v2");
    assert_eq!(active[1].sibling_count, 2, "two assistant versions");
    assert_eq!(active[1].parent_message_id.as_deref(), Some(u.as_str()));
}

// ── Per-resource ACL: tenancy is actually POPULATED (the fix) ──────────────
//
// Before this, EVERY conversation row was created with `owner_user_id` and
// `org_id` NULL, and `resource_access` (server/mod.rs) read NULL tenancy as
// "the untenanted local row" and returned `Access::Write` unconditionally. The
// gate existed, looked real, and enforced nothing. These tests pin the write
// that makes it bite, and the SQL filter that mirrors it.

#[tokio::test]
async fn claim_tenancy_stamps_the_owner_on_a_brand_new_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .claim_tenancy("c1", "alice", Some("org1"))
        .await
        .unwrap();

    let meta = store.get_access_meta("c1").await.unwrap().expect("row");
    assert_eq!(meta.owner_user_id.as_deref(), Some("alice"));
    assert_eq!(meta.org_id.as_deref(), Some("org1"));
    assert_eq!(meta.visibility, "private");
}
