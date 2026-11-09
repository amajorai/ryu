//! Window bounds and branch handling for [`ConversationStore::message_window`].

use super::*;

/// A flat conversation of `count` alternating turns `m0..m{count-1}`; returns
/// the message ids in order.
async fn seed(store: &ConversationStore, conv: &str, count: usize) -> Vec<String> {
    store
        .ensure_conversation(conv, None, Some("Release planning"), Tenancy::Unattributed)
        .await
        .unwrap();
    let mut ids = Vec::with_capacity(count);
    for n in 0..count {
        let role = if n % 2 == 0 { "user" } else { "assistant" };
        let id = store
            .append_message_at(
                conv,
                role,
                &format!("m{n}"),
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(1_000 + n as i64),
            )
            .await
            .unwrap();
        ids.push(id);
    }
    ids
}

fn contents(window: &MessageWindow) -> Vec<&str> {
    window.messages.iter().map(|m| m.content.as_str()).collect()
}

#[tokio::test]
async fn resolves_the_conversation_of_a_message_and_nothing_for_unknown_ids() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-a", 2).await;
    assert_eq!(
        store.message_conversation_id(&ids[1]).await.unwrap(),
        Some("conv-a".to_owned())
    );
    assert_eq!(store.message_conversation_id("nope").await.unwrap(), None);
}

#[tokio::test]
async fn window_in_the_middle_returns_both_sides_and_flags_more() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-mid", 9).await;
    let window = store
        .message_window("conv-mid", &ids[4], 2, 2)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&window), vec!["m2", "m3", "m4", "m5", "m6"]);
    assert_eq!(window.target_index, 2);
    assert_eq!(window.messages[window.target_index].id, ids[4]);
    assert!(window.has_earlier);
    assert!(window.has_later);
    assert_eq!(window.conversation_id, "conv-mid");
    assert_eq!(
        window.conversation_title.as_deref(),
        Some("Release planning")
    );
}

#[tokio::test]
async fn window_is_clamped_at_both_ends_of_the_transcript() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-ends", 4).await;

    let first = store
        .message_window("conv-ends", &ids[0], 3, 1)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&first), vec!["m0", "m1"]);
    assert_eq!(first.target_index, 0);
    assert!(!first.has_earlier);
    assert!(first.has_later);

    let last = store
        .message_window("conv-ends", &ids[3], 1, 5)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&last), vec!["m2", "m3"]);
    assert_eq!(last.target_index, 1);
    assert!(last.has_earlier);
    assert!(!last.has_later);

    let only = store
        .message_window("conv-ends", &ids[2], 0, 0)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&only), vec!["m2"]);
    assert!(only.has_earlier);
    assert!(only.has_later);
}

#[tokio::test]
async fn a_message_from_another_conversation_or_unknown_id_has_no_window() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-one", 2).await;
    seed(&store, "conv-two", 2).await;
    assert!(store
        .message_window("conv-two", &ids[0], 2, 2)
        .await
        .unwrap()
        .is_none());
    assert!(store
        .message_window("conv-one", "missing", 2, 2)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn an_edited_away_version_reads_its_own_ancestry_and_nothing_after() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-branch", 4).await;
    // Editing m2 moves the selected thread to the edit; the original m2 and the
    // reply under it stay stored as an unselected version.
    store
        .edit_user_message("conv-branch", &ids[2], "m2-edited")
        .await
        .unwrap()
        .expect("edit");

    let original = store
        .message_window("conv-branch", &ids[2], 1, 3)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&original), vec!["m1", "m2"]);
    assert_eq!(original.target_index, 1);
    assert!(original.has_earlier);
    assert!(!original.has_later);
}

#[tokio::test]
async fn branched_windows_match_slicing_the_selected_thread() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed(&store, "conv-fork", 5).await;
    let edited = store
        .edit_user_message("conv-fork", &ids[2], "m2-edited")
        .await
        .unwrap()
        .expect("edit");
    for n in 0..4 {
        store
            .append_message_at(
                "conv-fork",
                if n % 2 == 0 { "assistant" } else { "user" },
                &format!("after-{n}"),
                None,
                None,
                None,
                Tenancy::Unattributed,
                Some(5_000 + n),
            )
            .await
            .unwrap();
    }
    let thread = store.get_active_messages("conv-fork").await.unwrap();
    let thread_ids: Vec<&str> = thread.iter().map(|m| m.id.as_str()).collect();
    assert!(thread_ids.contains(&edited.as_str()));
    assert!(!thread_ids.contains(&ids[2].as_str()));
    for (index, anchor) in thread.iter().enumerate() {
        for (before, after) in [(0, 0), (1, 2), (2, 1), (10, 10)] {
            let window = store
                .message_window("conv-fork", &anchor.id, before, after)
                .await
                .unwrap()
                .expect("window");
            let start = index.saturating_sub(before);
            let end = (index + after + 1).min(thread.len());
            let expected = &thread[start..end];
            let got: Vec<(&str, usize, usize)> = window
                .messages
                .iter()
                .map(|m| (m.id.as_str(), m.sibling_index, m.sibling_count))
                .collect();
            let want: Vec<(&str, usize, usize)> = expected
                .iter()
                .map(|m| (m.id.as_str(), m.sibling_index, m.sibling_count))
                .collect();
            assert_eq!(got, want, "anchor {index}, {before}/{after}");
            assert_eq!(window.target_index, index - start);
            assert_eq!(window.has_earlier, start > 0);
            assert_eq!(window.has_later, end < thread.len());
        }
    }
}

#[tokio::test]
async fn a_long_branched_conversation_reads_only_the_window() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_conversation("branch-long", None, None, Tenancy::Unattributed)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        for number in 0..1_000 {
            let parent = (number > 0).then(|| format!("active-{}", number - 1));
            for prefix in ["active", "alternate"] {
                conn.execute(
                    "INSERT INTO messages(id, conversation_id, role, content, created_at, parent_message_id)
                     VALUES (?1, 'branch-long', 'user', ?2, 1, ?3)",
                    params![
                        format!("{prefix}-{number}"),
                        store.cipher.seal(&format!("{prefix} body {number}")).unwrap(),
                        parent
                    ],
                )
                .unwrap();
            }
        }
        conn.execute(
            "UPDATE conversations SET active_leaf_message_id = 'active-999'
             WHERE id = 'branch-long'",
            [],
        )
        .unwrap();
    }
    store
        .content_reads
        .store(0, std::sync::atomic::Ordering::Relaxed);
    let window = store
        .message_window("branch-long", "active-500", 3, 3)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(
        store
            .content_reads
            .load(std::sync::atomic::Ordering::Relaxed),
        7
    );
    let ids: Vec<&str> = window.messages.iter().map(|m| m.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "active-497",
            "active-498",
            "active-499",
            "active-500",
            "active-501",
            "active-502",
            "active-503"
        ]
    );
    assert_eq!(window.messages[3].content, "active body 500");
    assert_eq!(window.target_index, 3);
    assert!(window.has_earlier && window.has_later);
    assert!(window.messages.iter().all(|m| m.sibling_count == 2));

    let leaf = store
        .message_window("branch-long", "active-999", 1, 5)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&leaf), vec!["active body 998", "active body 999"]);
    assert!(leaf.has_earlier && !leaf.has_later);

    let root = store
        .message_window("branch-long", "active-0", 5, 1)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&root), vec!["active body 0", "active body 1"]);
    assert!(!root.has_earlier && root.has_later);

    // An alternate version reads its own ancestry and nothing after it.
    let alternate = store
        .message_window("branch-long", "alternate-500", 1, 3)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(
        contents(&alternate),
        vec!["active body 499", "alternate body 500"]
    );
    assert!(alternate.has_earlier && !alternate.has_later);
}
