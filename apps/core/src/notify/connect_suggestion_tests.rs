use super::*;

#[tokio::test]
async fn a_retried_suggestion_keeps_one_island_row() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let first = deliver_connect_suggestion(&store, "sugg-1", "island-user", "Title", "Body")
        .await
        .unwrap();
    let again = deliver_connect_suggestion(&store, "sugg-1", "island-user", "Other", "Other")
        .await
        .unwrap();
    assert_eq!(first, "sugg-1");
    assert_eq!(again, "sugg-1");
    let row = store.get_notification("sugg-1").await.unwrap().unwrap();
    assert_eq!(row.title, "Title");
    assert_eq!(row.user_id.as_deref(), Some("island-user"));
    assert_eq!(
        row.source_app_id.as_deref(),
        Some(ISLAND_CONNECT_SUGGESTION_SOURCE)
    );
}

#[tokio::test]
async fn a_suggestion_id_owned_by_another_user_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    deliver_connect_suggestion(&store, "sugg-2", "owner", "Title", "Body")
        .await
        .unwrap();
    let error = deliver_connect_suggestion(&store, "sugg-2", "intruder", "Title", "Body")
        .await
        .unwrap_err();
    assert!(error.contains("already used"), "{error}");
}
