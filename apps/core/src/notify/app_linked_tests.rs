use super::*;

async fn toast_for(
    events: &mut tokio::sync::broadcast::Receiver<crate::events::DesktopNotification>,
    id: &str,
) -> crate::events::DesktopNotification {
    loop {
        let event = events.recv().await.unwrap();
        if event.notification_id.as_deref() == Some(id) {
            return event;
        }
    }
}

#[tokio::test]
async fn a_linked_app_notification_keeps_its_source_and_carries_the_link() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let id = deliver_app_notification_linked(
        &store,
        "@example/app",
        "member-1",
        "Your item is ready",
        "",
        "success",
        Some("ryu://apps/@example/app/items/i1"),
    )
    .await
    .unwrap();
    let row = store.get_notification(&id).await.unwrap().expect("row");
    assert_eq!(row.source_app_id.as_deref(), Some("@example/app"));
    assert_eq!(row.user_id.as_deref(), Some("member-1"));
    assert_eq!(row.level, "success");
    let toast = toast_for(&mut events, &id).await;
    assert_eq!(
        toast.link.as_deref(),
        Some("ryu://apps/@example/app/items/i1")
    );
    assert_eq!(toast.target_user_id.as_deref(), Some("member-1"));
}

#[tokio::test]
async fn an_app_notification_without_a_link_has_none() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let id = crate::notify::deliver_app_notification(
        &store,
        "@example/app",
        "member-2",
        "Hello",
        "",
        "info",
    )
    .await
    .unwrap();
    assert_eq!(toast_for(&mut events, &id).await.link, None);
}

#[tokio::test]
async fn a_localized_linked_app_notification_carries_the_link_to_the_toast() {
    use crate::i18n::{messages, AlertText, Join, Message};
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let text = AlertText::new(
        Message::new(messages::LICENSE_DISABLED_TITLE_MESSAGE).text("item", "x"),
        Vec::new(),
        Join::Sentences,
    );
    let id = deliver_localized_app_notification_linked(
        &store,
        "@example/app",
        "member-3",
        &text,
        "info",
        Some("ryu://apps/@example/app"),
        |title, body| (title, body),
    )
    .await
    .unwrap();
    let row = store.get_notification(&id).await.unwrap().expect("row");
    assert_eq!(row.source_app_id.as_deref(), Some("@example/app"));
    let toast = toast_for(&mut events, &id).await;
    assert_eq!(toast.link.as_deref(), Some("ryu://apps/@example/app"));
}
