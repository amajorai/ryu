//! Access tracking on the chat path: the injected ids are deduped and
//! bounded, a turn bumps exactly the facts it recalled, a temporary turn
//! bumps nothing, and a store failure never surfaces.

use super::*;

fn citation(id: &str) -> MemoryCitation {
    MemoryCitation {
        id: id.to_owned(),
        content: format!("fact {id}"),
    }
}

#[test]
fn recalled_ids_merge_recency_and_citations_without_repeats() {
    let recency = vec!["a".to_owned(), "b".to_owned(), " ".to_owned()];
    let citations = [citation("b"), citation("c"), citation("a")];
    assert_eq!(
        recalled_memory_ids(true, &recency, &citations),
        vec!["a".to_owned(), "b".to_owned(), "c".to_owned()]
    );
    assert!(recalled_memory_ids(true, &[], &[]).is_empty());
}

#[test]
fn recalled_ids_are_bounded() {
    let recency: Vec<String> = (0..crate::server::memory::MAX_MARK_RECALLED_IDS + 10)
        .map(|n| format!("id-{n}"))
        .collect();
    assert_eq!(
        recalled_memory_ids(true, &recency, &[]).len(),
        crate::server::memory::MAX_MARK_RECALLED_IDS
    );
}

#[tokio::test]
async fn a_turn_bumps_only_the_facts_it_recalled() {
    let memory = MemoryStore::open_in_memory().unwrap();
    let mut ids = Vec::new();
    for content in ["prefers metric units", "lives in Lisbon"] {
        ids.push(
            memory
                .record(LOCAL_USER, "default", content)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    let context = assemble_long_term_context_for_user(
        &memory,
        true,
        LOCAL_USER,
        None,
        None,
        &[],
        MemoryVisibility::unrestricted(),
        1,
        crate::memory_policy::RecallBudget::default().char_budget(),
        true,
    )
    .await;
    let recalled = recalled_memory_ids(true, &context.recency_ids, &context.citations);
    assert_eq!(recalled.len(), 1);

    mark_turn_recalled(&memory, &recalled).await;

    for id in &ids {
        let entry = memory.get(id).await.unwrap().unwrap();
        let expected = i64::from(recalled.contains(id));
        assert_eq!(entry.recall_count, expected, "{}", entry.content);
        assert_eq!(entry.last_recalled_at.is_some(), expected == 1);
    }
}

#[tokio::test]
async fn a_temporary_turn_reading_memory_leaves_no_recall_trace() {
    let memory = MemoryStore::open_in_memory().unwrap();
    let id = memory
        .record(LOCAL_USER, "default", "prefers metric units")
        .await
        .unwrap()
        .unwrap();
    // "Use memory in temporary chat" lets the turn read the fact...
    let context = assemble_long_term_context_for_user(
        &memory,
        true,
        LOCAL_USER,
        None,
        None,
        &[],
        MemoryVisibility::unrestricted(),
        1,
        crate::memory_policy::RecallBudget::default().char_budget(),
        true,
    )
    .await;
    assert_eq!(context.recency_ids, vec![id.clone()]);

    // ...but the turn is not persisted, so nothing about it is written.
    let recalled = recalled_memory_ids(false, &context.recency_ids, &context.citations);
    mark_turn_recalled(&memory, &recalled).await;

    let entry = memory.get(&id).await.unwrap().unwrap();
    assert_eq!(entry.recall_count, 0);
    assert_eq!(entry.last_recalled_at, None);
}

#[tokio::test]
async fn marking_unknown_ids_is_silent() {
    let memory = MemoryStore::open_in_memory().unwrap();
    mark_turn_recalled(&memory, &["missing".to_owned()]).await;
    mark_turn_recalled(&memory, &[]).await;
    assert_eq!(memory.count().await.unwrap(), 0);
}
