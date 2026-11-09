//! Tests of keyword search: ranking, conversation scope and query parsing.

use super::tests::index;

/// THE required round-trip: index three messages with distinct terms in
/// distinct conversations, search a query term, and assert the right past
/// session row surfaces first. Network-free (no embedder).
#[tokio::test]
async fn fts_round_trip_surfaces_matching_session() {
    let index = index();
    let docs = [
        ("m1", "c1", "assistant", "rust borrow checker lifetimes"),
        ("m2", "c1", "user", "favourite pizza toppings pepperoni"),
        ("m3", "c2", "user", "singapore travel itinerary"),
    ];
    for (id, conv, role, text) in docs {
        index
            .index_message(id, conv, role, text, 0)
            .await
            .expect("index");
    }

    let hits = index.search("Pizza!", 5, None).await.expect("search");
    assert!(!hits.is_empty(), "expected at least one hit");
    assert_eq!(hits[0].message_id, "m2", "pizza query must surface m2");
    assert_eq!(hits[0].conversation_id, "c1");
    // Messages that share more query terms rank higher.
    let hits = index
        .search("pizza pepperoni singapore", 5, None)
        .await
        .expect("search");
    assert_eq!(hits[0].message_id, "m2");
    assert_eq!(hits.len(), 2);
}

/// Conversation-scoped search returns only hits from the requested conversation.
#[tokio::test]
async fn search_scopes_to_conversation_ids() {
    let index = index();
    for (id, conv) in [("m1", "c1"), ("m2", "c2")] {
        index
            .index_message(id, conv, "user", "alpha beta gamma", 0)
            .await
            .expect("index");
    }
    let hits = index
        .search("alpha beta", 5, Some(&["c2".to_owned()]))
        .await
        .expect("search");
    assert!(!hits.is_empty());
    assert!(
        hits.iter().all(|h| h.conversation_id == "c2"),
        "all hits must be scoped to c2"
    );
}

/// Queries are tokenized like bodies: FTS5 meta-characters never reach
/// MATCH, and stopword-only or prefix queries find nothing (whole words only).
#[tokio::test]
async fn queries_are_whole_word_and_meta_char_safe() {
    let index = index();
    index
        .index_message("m1", "c1", "user", "the foo and the bar baz", 0)
        .await
        .expect("index");
    let hits = index
        .search("foo:bar* \"baz AND", 5, None)
        .await
        .expect("search must not error on meta-chars");
    assert_eq!(hits[0].message_id, "m1");
    assert!(index.search("the and", 5, None).await.unwrap().is_empty());
    assert!(index.search("ba", 5, None).await.unwrap().is_empty());
    assert!(index.search("   ", 5, None).await.unwrap().is_empty());
    assert!(index.search("!!! @@@", 5, None).await.unwrap().is_empty());
}

/// Regression: matches in other conversations (other users on a shared node)
/// no longer crowd the scoped caller's hits out of a capped result. The scope
/// is applied before the limit, so every in-scope match surfaces even when
/// hundreds of stronger foreign matches outrank it.
#[tokio::test]
async fn foreign_matches_do_not_starve_scoped_results() {
    let index = index();
    // Short foreign documents rank above the caller's longer ones.
    for n in 0..300 {
        index
            .index_message(
                &format!("f{n}"),
                &format!("other{}", n % 7),
                "user",
                "needle",
                0,
            )
            .await
            .expect("index foreign");
    }
    for n in 0..3 {
        index
            .index_message(
                &format!("mine{n}"),
                "mine",
                "user",
                "needle haystack barn tractor pitchfork",
                0,
            )
            .await
            .expect("index mine");
    }
    let unscoped = index.search("needle", 64, None).await.expect("search");
    assert!(
        unscoped.iter().all(|hit| hit.conversation_id != "mine"),
        "the foreign matches outrank the caller's"
    );

    let scope = ["mine".to_owned()];
    let hits = index
        .search("needle", 5, Some(&scope))
        .await
        .expect("search");
    let mut ids: Vec<&str> = hits.iter().map(|hit| hit.message_id.as_str()).collect();
    ids.sort_unstable();
    assert_eq!(ids, ["mine0", "mine1", "mine2"]);
    assert!(hits.iter().all(|hit| hit.conversation_id == "mine"));

    // The limit still caps the scoped result.
    assert_eq!(
        index.search("needle", 2, Some(&scope)).await.unwrap().len(),
        2
    );
}

/// Scoping only filters: the scoped hits are the unscoped ranking restricted
/// to the scope, in the same order and with the same scores.
#[tokio::test]
async fn scoped_ranking_matches_the_unscoped_ranking() {
    let index = index();
    let docs = [
        ("m1", "c1", "kiwi"),
        ("m2", "c2", "kiwi mango"),
        ("m3", "c1", "kiwi mango papaya"),
        ("m4", "c3", "kiwi"),
        ("m5", "c2", "kiwi papaya guava lychee"),
        ("m6", "c1", "mango"),
    ];
    for (id, conversation, text) in docs {
        index
            .index_message(id, conversation, "user", text, 0)
            .await
            .unwrap();
    }
    let all = index.search("kiwi mango", 10, None).await.unwrap();
    let scope = ["c1".to_owned(), "c2".to_owned()];
    let scoped = index.search("kiwi mango", 10, Some(&scope)).await.unwrap();
    let expected: Vec<(String, f32)> = all
        .iter()
        .filter(|hit| scope.contains(&hit.conversation_id))
        .map(|hit| (hit.message_id.clone(), hit.score))
        .collect();
    let actual: Vec<(String, f32)> = scoped
        .iter()
        .map(|hit| (hit.message_id.clone(), hit.score))
        .collect();
    assert_eq!(actual, expected);
    assert_eq!(actual.len(), 5);
    // An empty scope searches everything, like no scope.
    assert_eq!(
        index
            .search("kiwi mango", 10, Some(&[]))
            .await
            .unwrap()
            .len(),
        all.len()
    );
}

/// A scope larger than SQLite's bound-variable limit (32766) still works: the
/// ids travel as one JSON value, so no statement exceeds the limit.
#[tokio::test]
async fn very_large_scopes_stay_within_sqlite_variable_limits() {
    let index = index();
    index
        .index_message("m1", "target", "user", "zeppelin", 0)
        .await
        .unwrap();
    index
        .index_message("m2", "outside", "user", "zeppelin", 0)
        .await
        .unwrap();
    let mut scope: Vec<String> = (0..40_000).map(|n| format!("conv-{n}")).collect();
    scope.push("target".to_owned());
    let hits = index.search("zeppelin", 5, Some(&scope)).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id, "m1");
    // Ids with JSON-special characters round-trip exactly.
    index
        .index_message("m3", "we\"ird\\id", "user", "zeppelin", 0)
        .await
        .unwrap();
    let odd = ["we\"ird\\id".to_owned()];
    let hits = index.search("zeppelin", 5, Some(&odd)).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id, "m3");
}
