//! Conversation store tests: resume and sync.

use super::*;

#[tokio::test]
async fn every_delete_path_clears_title_model_and_handoff_history() {
    let store = ConversationStore::open_in_memory().unwrap();
    for (conversation, owner) in [
        ("deleted", "alice"),
        ("alice-chat", "alice"),
        ("bob-chat", "bob"),
    ] {
        store
            .append_message(conversation, "user", "hi", None, None, None)
            .await
            .unwrap();
        store
            .claim_tenancy(conversation, owner, Some("org1"))
            .await
            .unwrap();
        seed_conversation_history_rows(&store, conversation).await;
        // Five seeded rows plus the title the first message derived.
        assert_eq!(
            conversation_history_row_count(&store, conversation).await,
            6
        );
    }

    assert!(store.delete_conversation("deleted").await.unwrap());
    assert_eq!(conversation_history_row_count(&store, "deleted").await, 0);
    // A recreated id starts without the deleted chat's history.
    store
        .append_message("deleted", "user", "new owner", None, None, None)
        .await
        .unwrap();
    assert!(store
        .list_context_handoffs("deleted")
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_model_changes("deleted")
        .await
        .unwrap()
        .is_empty());
    assert!(store
        .list_title_history("deleted")
        .await
        .unwrap()
        .iter()
        .all(|entry| entry.title != "old title"));

    store.clear_conversations_owned_by("bob").await.unwrap();
    assert_eq!(conversation_history_row_count(&store, "bob-chat").await, 0);
    assert_eq!(
        conversation_history_row_count(&store, "alice-chat").await,
        6
    );

    store.clear_all_conversations().await.unwrap();
    assert_eq!(
        conversation_history_row_count(&store, "alice-chat").await,
        0
    );
}

#[tokio::test]
async fn resumed_messages_join_the_active_thread_of_a_branched_conversation() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-resumed";
    let u1 = store
        .append_message(conv, "user", "u1", None, None, None)
        .await
        .unwrap();
    let a1 = store
        .append_message(conv, "assistant", "a1", None, None, None)
        .await
        .unwrap();
    // Engage the version tree (leaf = a1), as an edit or regenerate would.
    store
        .select_version(conv, &a1)
        .await
        .unwrap()
        .expect("leaf");

    let later = now_millis() + 1_000;
    for (offset, (id, role, text)) in [
        ("b-u2", "user", "u2 on the other node"),
        ("b-a2", "assistant", "a2 on the other node"),
        ("rnp-context-1", "user", "[Imported context: notes]"),
    ]
    .into_iter()
    .enumerate()
    {
        assert!(store
            .append_sync_message_with_id(conv, id, role, text, None, later + offset as i64)
            .await
            .unwrap());
    }
    let transcript = owned_ids(&[u1.as_str(), a1.as_str(), "b-u2", "b-a2"]);
    let context = owned_ids(&["rnp-context-1"]);
    let inserted = owned_id_set(&["b-u2", "b-a2", "rnp-context-1"]);
    store
        .link_resumed_messages(conv, &transcript, &context, &inserted)
        .await
        .unwrap();

    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(
        contents(&active),
        [
            "u1",
            "a1",
            "u2 on the other node",
            "a2 on the other node",
            "[Imported context: notes]"
        ]
    );
    // The next local turn continues beneath the resumed work.
    store
        .append_message(conv, "user", "u3", None, None, None)
        .await
        .unwrap();
    let recent = store.get_recent_messages(conv, 2).await.unwrap();
    assert_eq!(contents(&recent), ["[Imported context: notes]", "u3"]);
}

pub(super) fn owned_ids(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

pub(super) fn owned_id_set(ids: &[&str]) -> std::collections::HashSet<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

/// A branched conversation u1,a1,u2,a2 with leaf a2, plus its message ids.
pub(super) async fn branched_resume_target(store: &ConversationStore, conv: &str) -> Vec<String> {
    let mut ids = Vec::new();
    for (role, text) in [
        ("user", "u1"),
        ("assistant", "a1"),
        ("user", "u2"),
        ("assistant", "a2"),
    ] {
        ids.push(
            store
                .append_message(conv, role, text, None, None, None)
                .await
                .unwrap(),
        );
    }
    store
        .select_version(conv, &ids[3])
        .await
        .unwrap()
        .expect("leaf");
    ids
}

pub(super) async fn insert_synced(
    store: &ConversationStore,
    conv: &str,
    rows: &[(&str, &str, &str)],
) {
    let later = now_millis() + 1_000;
    for (offset, (id, role, text)) in rows.iter().enumerate() {
        assert!(store
            .append_sync_message_with_id(conv, id, role, text, None, later + offset as i64)
            .await
            .unwrap());
    }
}

pub(super) fn sync_link(id: &str, parent: SyncParent) -> SyncLink {
    SyncLink {
        id: id.to_owned(),
        parent,
    }
}

#[tokio::test]
async fn checkpoint_import_chains_onto_the_branched_thread_it_continues() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-sync-link-checkpoint";
    let ids = branched_resume_target(&store, conv).await;
    insert_synced(
        &store,
        conv,
        &[("g-u3", "user", "u3"), ("g-a3", "assistant", "a3")],
    )
    .await;
    // A linear checkpoint: the first row's position is unknown, each later
    // row replies to its predecessor.
    let mut links = vec![sync_link(&ids[0], SyncParent::Unknown)];
    for pair in ids.windows(2) {
        links.push(sync_link(&pair[1], SyncParent::Message(pair[0].clone())));
    }
    links.push(sync_link("g-u3", SyncParent::Message(ids[3].clone())));
    links.push(sync_link("g-a3", SyncParent::Message("g-u3".to_owned())));
    store
        .link_synced_messages(conv, &links, &owned_id_set(&["g-u3", "g-a3"]))
        .await
        .unwrap();

    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(contents(&active), ["u1", "a1", "u2", "a2", "u3", "a3"]);
    // Rows that already existed are never re-parented.
    assert_eq!(active[0].parent_message_id, None);
}

/// Walk every stored row's parent chain; panics if one loops.
pub(super) async fn assert_acyclic(store: &ConversationStore, conv: &str) {
    let stored = store.get_messages(conv).await.unwrap();
    let parents: std::collections::HashMap<&str, Option<&str>> = stored
        .iter()
        .map(|m| (m.id.as_str(), m.parent_message_id.as_deref()))
        .collect();
    for start in parents.keys() {
        let mut current = Some(*start);
        let mut steps = 0;
        while let Some(id) = current {
            steps += 1;
            assert!(steps <= parents.len(), "parent loop through {start}");
            current = parents.get(id).copied().flatten();
        }
    }
}

#[tokio::test]
async fn synced_parents_that_would_close_a_loop_continue_the_thread() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-sync-link-cycle";
    let ids = branched_resume_target(&store, conv).await;
    insert_synced(
        &store,
        conv,
        &[
            ("s-x", "user", "x"),
            ("s-y", "assistant", "y"),
            ("s-z", "user", "z"),
        ],
    )
    .await;
    // A relayed payload naming rows as each other's (and their own) parent.
    let links = [
        sync_link("s-x", SyncParent::Message("s-y".to_owned())),
        sync_link("s-y", SyncParent::Message("s-x".to_owned())),
        sync_link("s-z", SyncParent::Message("s-z".to_owned())),
    ];
    store
        .link_synced_messages(conv, &links, &owned_id_set(&["s-x", "s-y", "s-z"]))
        .await
        .unwrap();

    assert_acyclic(&store, conv).await;
    let stored = store.get_messages(conv).await.unwrap();
    let parent_of = |id: &str| {
        stored
            .iter()
            .find(|m| m.id == id)
            .and_then(|m| m.parent_message_id.clone())
    };
    assert_eq!(parent_of("s-x").as_deref(), Some("s-y"));
    assert_eq!(parent_of("s-y").as_deref(), Some(ids[3].as_str()));
    assert_eq!(parent_of("s-z").as_deref(), Some("s-y"));
    // Selecting any of them descends to a leaf instead of spinning.
    assert!(store.select_version(conv, "s-x").await.unwrap().is_some());
    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(contents(&active), ["u1", "a1", "u2", "a2", "y", "x"]);
}

#[tokio::test]
async fn linearize_never_turns_a_stale_first_row_parent_into_a_ring() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-linearize-ring";
    let mut ids = Vec::new();
    for (role, text) in [("user", "u1"), ("assistant", "a1"), ("user", "u2")] {
        ids.push(
            store
                .append_message(conv, role, text, None, None, None)
                .await
                .unwrap(),
        );
    }
    // A flat row may hold a parent naming a later row (relayed or legacy).
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE messages SET parent_message_id = ?1 WHERE id = ?2",
            params![ids[2], ids[0]],
        )
        .unwrap();

    let leaf = store.select_version(conv, &ids[0]).await.unwrap();
    assert_eq!(leaf.as_deref(), Some(ids[2].as_str()));
    assert_acyclic(&store, conv).await;
    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(contents(&active), ["u1", "a1", "u2"]);
}

#[tokio::test]
async fn synced_rows_with_no_known_parent_continue_the_thread_in_any_order() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-sync-link-unknown";
    let ids = branched_resume_target(&store, conv).await;
    insert_synced(
        &store,
        conv,
        &[
            ("s-a3", "assistant", "a3"),
            ("s-u3", "user", "u3"),
            ("s-root", "user", "edited first turn"),
            ("s-orphan", "user", "orphan"),
        ],
    )
    .await;
    let links = [
        // A parent the receiver does not hold falls back to appending.
        sync_link("s-orphan", SyncParent::Message("missing".to_owned())),
        // A child listed before its parent still ends up selected.
        sync_link("s-a3", SyncParent::Message("s-u3".to_owned())),
        // Later rows with no position chain beneath the earlier ones.
        sync_link("s-u3", SyncParent::Unknown),
        // A genuine root stays an alternate first turn.
        sync_link("s-root", SyncParent::Root),
    ];
    store
        .link_synced_messages(
            conv,
            &links,
            &owned_id_set(&["s-a3", "s-u3", "s-root", "s-orphan"]),
        )
        .await
        .unwrap();

    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(
        contents(&active),
        ["u1", "a1", "u2", "a2", "orphan", "u3", "a3"]
    );
    assert_eq!(
        active[0].sibling_count, 2,
        "the root is a first-turn version"
    );
    let stored = store.get_messages(conv).await.unwrap();
    let parent_of = |id: &str| {
        stored
            .iter()
            .find(|m| m.id == id)
            .and_then(|m| m.parent_message_id.clone())
    };
    assert_eq!(parent_of("s-orphan").as_deref(), Some(ids[3].as_str()));
    assert_eq!(parent_of("s-u3").as_deref(), Some("s-orphan"));
    assert_eq!(parent_of("s-a3").as_deref(), Some("s-u3"));
    assert_eq!(parent_of("s-root"), None);
}

#[tokio::test]
async fn resumed_context_keeps_the_targets_newer_local_turns_selected() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-resume-context-only";
    let ids = branched_resume_target(&store, conv).await;
    // The target kept chatting after the export's checkpoint (a2).
    store
        .append_message(conv, "user", "u3", None, None, None)
        .await
        .unwrap();
    store
        .append_message(conv, "assistant", "a3", None, None, None)
        .await
        .unwrap();
    insert_synced(
        &store,
        conv,
        &[("rnp-context-x", "user", "[Imported context: notes]")],
    )
    .await;
    let context = owned_ids(&["rnp-context-x"]);
    store
        .link_resumed_messages(conv, &ids, &context, &owned_id_set(&["rnp-context-x"]))
        .await
        .unwrap();

    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(
        contents(&active),
        [
            "u1",
            "a1",
            "u2",
            "a2",
            "u3",
            "a3",
            "[Imported context: notes]"
        ]
    );
}

#[tokio::test]
async fn divergent_resumed_turns_become_a_branch_without_moving_the_leaf() {
    let store = ConversationStore::open_in_memory().unwrap();
    let conv = "conv-resume-divergent";
    let ids = branched_resume_target(&store, conv).await;
    store
        .append_message(conv, "user", "local u3", None, None, None)
        .await
        .unwrap();
    store
        .append_message(conv, "assistant", "local a3", None, None, None)
        .await
        .unwrap();
    insert_synced(
        &store,
        conv,
        &[
            ("b-u3", "user", "remote u3"),
            ("b-a3", "assistant", "remote a3"),
            ("rnp-context-y", "user", "[Imported context: remote notes]"),
        ],
    )
    .await;
    let mut transcript = ids;
    transcript.extend(owned_ids(&["b-u3", "b-a3"]));
    let context = owned_ids(&["rnp-context-y"]);
    store
        .link_resumed_messages(
            conv,
            &transcript,
            &context,
            &owned_id_set(&["b-u3", "b-a3", "rnp-context-y"]),
        )
        .await
        .unwrap();

    // The target's own newer turns stay on the active thread.
    let active = store.get_active_messages(conv).await.unwrap();
    assert_eq!(
        contents(&active),
        ["u1", "a1", "u2", "a2", "local u3", "local a3"]
    );
    // The remote turns are a sibling branch under the shared row, with their
    // context, and selecting it shows the resumed work.
    store
        .select_version(conv, "rnp-context-y")
        .await
        .unwrap()
        .expect("leaf");
    let branch = store.get_active_messages(conv).await.unwrap();
    assert_eq!(
        contents(&branch),
        [
            "u1",
            "a1",
            "u2",
            "a2",
            "remote u3",
            "remote a3",
            "[Imported context: remote notes]"
        ]
    );
}
