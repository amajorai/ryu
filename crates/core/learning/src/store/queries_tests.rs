use std::collections::HashSet;

use super::tests::{open_tmp, sample};

#[tokio::test]
async fn filters_unscored_and_trainable() {
    let store = open_tmp("filters").await;
    store.record_if_absent(&sample("a", None)).await.unwrap();
    store.record_if_absent(&sample("b", None)).await.unwrap();
    store.set_reward("b", 0.8).await.unwrap();
    store.record_if_absent(&sample("c", None)).await.unwrap();
    store.set_reward("c", 0.3).await.unwrap();

    let unscored = store.list_unscored(10).await.unwrap();
    assert_eq!(unscored.len(), 1);
    assert_eq!(unscored[0].id, "a");

    let trainable = store.list_for_training(0.7, 10).await.unwrap();
    assert_eq!(trainable.len(), 1);
    assert_eq!(trainable[0].id, "b");

    let (total, scored, train_count) = store.counts(0.7).await.unwrap();
    assert_eq!((total, scored, train_count), (3, 2, 1));
}

#[tokio::test]
async fn scoped_queries_hide_other_conversations() {
    let store = open_tmp("scoped").await;
    let mut other = sample("other", Some(0.95));
    other.conversation_id = "conv-2".to_string();
    other.user_text = "private prompt".to_string();
    other.assistant_text = "private reply".to_string();
    store
        .record_if_absent(&sample("visible", Some(0.9)))
        .await
        .unwrap();
    store.record_if_absent(&other).await.unwrap();

    let visible = HashSet::from(["conv-1".to_string()]);
    let rows = store.list_visible(10, &visible).await.unwrap();
    assert_eq!(
        rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
        ["visible"]
    );
    assert_eq!(
        store
            .list_for_training_visible(0.7, 10, &visible)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        store.counts_visible(0.7, &visible).await.unwrap(),
        (1, 1, 1)
    );
}
