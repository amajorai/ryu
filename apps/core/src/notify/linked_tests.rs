use super::*;

#[tokio::test]
async fn a_linked_notification_reaches_the_inbox_and_carries_its_link_to_the_toast() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let id = deliver_linked_notification(
        &store,
        "linked-user",
        "Agent proposal waiting for approval",
        "An agent asks for 1 service (api.test) in prod.",
        "warning",
        "/vault?tab=broker&proposal=bp_linked",
    )
    .await
    .unwrap();
    let row = store.get_notification(&id).await.unwrap().unwrap();
    assert_eq!(row.user_id.as_deref(), Some("linked-user"));
    assert_eq!(row.level, "warning");
    let toast = loop {
        let event = events.recv().await.unwrap();
        if event.notification_id.as_deref() == Some(id.as_str()) {
            break event;
        }
    };
    assert_eq!(toast.target_user_id.as_deref(), Some("linked-user"));
    assert_eq!(
        toast.link.as_deref(),
        Some("/vault?tab=broker&proposal=bp_linked")
    );
}

#[tokio::test]
async fn an_ordinary_user_notification_carries_no_link() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let id = deliver_user_notification(
        &store, "plain-user", "Hello", "", "info", None, None, false, None,
    )
    .await
    .unwrap();
    let toast = loop {
        let event = events.recv().await.unwrap();
        if event.notification_id.as_deref() == Some(id.as_str()) {
            break event;
        }
    };
    assert_eq!(toast.link, None);
    let json = serde_json::to_value(&toast).unwrap();
    assert!(json.get("link").is_none(), "an unset link is not serialized");
}
