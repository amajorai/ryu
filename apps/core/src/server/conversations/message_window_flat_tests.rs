//! Bounded forward/backward paging around an anchor in a never-branched
//! conversation: page bounds, ordering ties, edges, and that a long transcript
//! is never read beyond the window.

use std::sync::atomic::Ordering;

use super::*;

/// Insert `count` flat messages `m0..` with sealed content directly, so long
/// conversations seed quickly. `created_at` is `stamp(n)`. Returns ids in order.
async fn seed_rows(
    store: &ConversationStore,
    conv: &str,
    count: usize,
    stamp: impl Fn(usize) -> i64,
) -> Vec<String> {
    store
        .ensure_conversation(conv, None, Some("Long thread"), Tenancy::Unattributed)
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let mut ids = Vec::with_capacity(count);
    for n in 0..count {
        let id = format!("{conv}-{n}");
        let role = if n % 2 == 0 { "user" } else { "assistant" };
        conn.execute(
            "INSERT INTO messages(id, conversation_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                id,
                conv,
                role,
                store.cipher.seal(&format!("m{n}")).unwrap(),
                stamp(n)
            ],
        )
        .unwrap();
        ids.push(id);
    }
    ids
}

fn contents(messages: &[StoredMessage]) -> Vec<&str> {
    messages.iter().map(|m| m.content.as_str()).collect()
}

#[tokio::test]
async fn pages_read_at_most_their_limit_in_each_direction() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed_rows(&store, "pages", 50, |n| 1_000 + n as i64).await;
    let conn = store.conn.lock().await;
    let anchor = ConversationStore::message_position_locked(&conn, "pages", &ids[20])
        .unwrap()
        .expect("position");

    let forward =
        ConversationStore::flat_page_locked(&conn, "pages", anchor, PageDirection::FromAnchor, 4)
            .unwrap();
    let forward_ids: Vec<&str> = forward.iter().map(|(m, _, _)| m.id.as_str()).collect();
    assert_eq!(
        forward_ids,
        ["pages-20", "pages-21", "pages-22", "pages-23"]
    );

    let backward =
        ConversationStore::flat_page_locked(&conn, "pages", anchor, PageDirection::Older, 3)
            .unwrap();
    let backward_ids: Vec<&str> = backward.iter().map(|(m, _, _)| m.id.as_str()).collect();
    assert_eq!(backward_ids, ["pages-19", "pages-18", "pages-17"]);

    assert_eq!(
        ConversationStore::message_position_locked(&conn, "other", &ids[20]).unwrap(),
        None,
        "a message is only located inside its own conversation"
    );
}

#[tokio::test]
async fn equal_timestamps_page_in_insertion_order() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed_rows(&store, "ties", 9, |_| 5_000).await;
    let slice = store
        .flat_message_window("ties", &ids[4], 2, 2)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&slice.messages), ["m2", "m3", "m4", "m5", "m6"]);
    assert_eq!(slice.target_index, 2);
    assert!(slice.has_earlier && slice.has_later);
}

#[tokio::test]
async fn windows_at_the_edges_report_no_more_on_the_open_side() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed_rows(&store, "edges", 5, |n| 1_000 + n as i64).await;

    let first = store
        .flat_message_window("edges", &ids[0], 3, 2)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&first.messages), ["m0", "m1", "m2"]);
    assert_eq!(first.target_index, 0);
    assert!(!first.has_earlier);
    assert!(first.has_later);

    let last = store
        .flat_message_window("edges", &ids[4], 2, 3)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&last.messages), ["m2", "m3", "m4"]);
    assert_eq!(last.target_index, 2);
    assert!(last.has_earlier);
    assert!(!last.has_later);

    // Exactly reaching each end is not "more".
    let exact = store
        .flat_message_window("edges", &ids[2], 2, 2)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&exact.messages), ["m0", "m1", "m2", "m3", "m4"]);
    assert!(!exact.has_earlier && !exact.has_later);

    let lone = seed_rows(&store, "lone", 1, |_| 1).await;
    let only = store
        .flat_message_window("lone", &lone[0], 0, 0)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(contents(&only.messages), ["m0"]);
    assert!(!only.has_earlier && !only.has_later);

    assert!(store
        .flat_message_window("edges", &lone[0], 2, 2)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn every_window_matches_slicing_the_whole_transcript() {
    let store = ConversationStore::open_in_memory().unwrap();
    // Mixed ordering: timestamps repeat in pairs, so rowid breaks ties.
    let ids = seed_rows(&store, "oracle", 8, |n| 1_000 + (n / 2) as i64).await;
    let thread = store.get_active_messages("oracle").await.unwrap();
    for (index, id) in ids.iter().enumerate() {
        for (before, after) in [(0, 0), (1, 2), (3, 0), (10, 10)] {
            let slice = store
                .flat_message_window("oracle", id, before, after)
                .await
                .unwrap()
                .expect("window");
            let start = index.saturating_sub(before);
            let end = (index + after + 1).min(thread.len());
            let expected: Vec<&str> = thread[start..end].iter().map(|m| m.id.as_str()).collect();
            let got: Vec<&str> = slice.messages.iter().map(|m| m.id.as_str()).collect();
            assert_eq!(got, expected, "anchor {index}, {before}/{after}");
            assert_eq!(slice.target_index, index - start);
            assert_eq!(slice.has_earlier, start > 0);
            assert_eq!(slice.has_later, end < thread.len());
        }
    }
}

#[tokio::test]
async fn a_long_conversation_reads_only_the_window() {
    let store = ConversationStore::open_in_memory().unwrap();
    let ids = seed_rows(&store, "long", 2_000, |n| 1_000 + n as i64).await;
    // A row far from the anchor that cannot be decoded: reading the whole
    // transcript fails on it, the window never touches it.
    store
        .conn
        .lock()
        .await
        .execute(
            "UPDATE messages SET interrupted = 'not a number' WHERE id = ?1",
            params![ids[10]],
        )
        .unwrap();
    assert!(store.get_active_messages("long").await.is_err());

    store.content_reads.store(0, Ordering::Relaxed);
    let window = store
        .message_window("long", &ids[1_500], 4, 6)
        .await
        .unwrap()
        .expect("window");
    assert_eq!(store.content_reads.load(Ordering::Relaxed), 11);
    assert_eq!(window.messages.len(), 11);
    assert_eq!(window.messages[0].content, "m1496");
    assert_eq!(window.messages[window.target_index].id, ids[1_500]);
    assert_eq!(window.messages[10].content, "m1506");
    assert!(window.has_earlier && window.has_later);
    assert_eq!(window.conversation_title.as_deref(), Some("Long thread"));
}
