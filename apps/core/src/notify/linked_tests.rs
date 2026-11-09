use super::*;
use crate::i18n::{messages, Join, Message};
use crate::notify::deliver_user_notification;

fn proposal_text() -> AlertText {
    AlertText::new(
        Message::new(messages::VAULT_BROKER_PROPOSAL_TITLE_MESSAGE),
        vec![Message::new(messages::VAULT_BROKER_SERVICES_ONE_MESSAGE)
            .number("count", 1.0, 0, 0)
            .text("environment", "prod")
            .text("hosts", "api.test")],
        Join::Sentences,
    )
}

#[tokio::test]
async fn a_linked_notification_reaches_the_inbox_and_carries_its_link_to_the_toast() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let text = proposal_text();
    let id = deliver_linked_notification(
        &store,
        "linked-user",
        &text,
        "warning",
        "/vault?tab=broker&proposal=bp_linked",
    )
    .await
    .unwrap();
    // The inbox row and the toast are written in the node's language.
    let (title, body) = text.render(crate::i18n::locale::node_locale().await);
    let row = store.get_notification(&id).await.unwrap().unwrap();
    assert_eq!(row.user_id.as_deref(), Some("linked-user"));
    assert_eq!(row.level, "warning");
    assert_eq!(row.title, title);
    assert_eq!(row.body.as_deref(), Some(body.as_str()));
    let toast = loop {
        let event = events.recv().await.unwrap();
        if event.notification_id.as_deref() == Some(id.as_str()) {
            break event;
        }
    };
    assert_eq!(toast.target_user_id.as_deref(), Some("linked-user"));
    assert_eq!(toast.title, title);
    assert_eq!(toast.body.as_deref(), Some(body.as_str()));
    assert_eq!(
        toast.link.as_deref(),
        Some("/vault?tab=broker&proposal=bp_linked")
    );
}

#[test]
fn a_linked_push_is_rendered_in_each_device_locale() {
    let text = proposal_text();
    let render = push_render(Some(&text), "node title", "node body");
    let (title, body) = render("en");
    assert_eq!(title, "Agent proposal waiting for approval");
    assert_eq!(body, "An agent asks for 1 service in prod: api.test.");
    // An Arabic device gets its own rendering: the Latin host is isolated.
    let (_, arabic) = render("ar");
    assert_ne!(arabic, body);
    assert!(arabic.contains("\u{2068}api.test\u{2069}"), "{arabic:?}");
    // Without localizable text every device gets the written text.
    let plain = push_render(None, "node title", "node body");
    assert_eq!(
        plain("ar"),
        ("node title".to_owned(), "node body".to_owned())
    );
}

#[tokio::test]
async fn an_ordinary_user_notification_carries_no_link() {
    let directory = tempfile::tempdir().unwrap();
    let store = NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let mut events = crate::events::subscribe();
    let id = deliver_user_notification(
        &store,
        "plain-user",
        "Hello",
        "",
        "info",
        None,
        None,
        false,
        None,
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
    assert!(
        json.get("link").is_none(),
        "an unset link is not serialized"
    );
}
