//! Tests for the continuity hand-off marker.

use super::*;

#[tokio::test]
async fn continued_on_is_set_cleared_and_listed_without_moving_updated_at() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .ensure_sync_conversation("c1", None, Some("Thread"), 10, 20, Tenancy::Unattributed)
        .await
        .unwrap();
    let before = store.get_summary("c1").await.unwrap().unwrap();
    assert!(before.continued_on.is_none());

    let record = r#"{"nodeLabel":"Mac","at":30}"#;
    assert!(store.set_continued_on("c1", record).await.unwrap());
    assert!(!store.set_continued_on("missing", record).await.unwrap());
    let marked = store.get_summary("c1").await.unwrap().unwrap();
    assert_eq!(
        marked.continued_on,
        Some(serde_json::json!({"nodeLabel":"Mac","at":30}))
    );
    assert_eq!(marked.updated_at, before.updated_at);
    let listed = store
        .list_summaries_inner("", TenancyFilter::unrestricted(), true, Some("c1"))
        .await
        .unwrap();
    assert_eq!(listed[0].continued_on, marked.continued_on);

    assert!(store.clear_continued_on("c1").await.unwrap());
    assert!(store
        .get_summary("c1")
        .await
        .unwrap()
        .unwrap()
        .continued_on
        .is_none());
}
