use super::store::PushTarget;
use super::tokens_by_locale;

fn device(token: &str, locale: Option<&str>) -> PushTarget {
    PushTarget {
        token: token.to_owned(),
        owner: None,
        locale: locale.map(str::to_owned),
    }
}

#[test]
fn devices_group_by_their_registered_locale_else_the_node_locale() {
    let devices = [
        device("a", Some("ja-JP")),
        device("b", None),
        device("c", Some("ja")),
        device("d", Some("pt-br")),
        device("e", Some("")),
        device("f", Some("tlh")),
    ];
    assert_eq!(
        tokens_by_locale(&devices, "de"),
        vec![
            ("de", vec!["b".to_owned(), "e".to_owned()]),
            ("en", vec!["f".to_owned()]),
            ("ja", vec!["a".to_owned(), "c".to_owned()]),
            ("pt-BR", vec!["d".to_owned()]),
        ]
    );
}

#[tokio::test]
async fn a_core_authored_localized_notification_persists_without_a_source_app() {
    use crate::i18n::{messages, AlertText, Join, Message};
    let directory = tempfile::tempdir().unwrap();
    let store = super::NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let text = AlertText::new(
        Message::new(messages::LICENSE_DISABLED_TITLE_MESSAGE).text("item", "acme.paid"),
        Vec::new(),
        Join::Sentences,
    );
    let id = super::deliver_localized_user_notification(
        &store,
        "user-1",
        &text,
        "warning",
        None,
        |title, body| (title, body),
    )
    .await
    .unwrap();
    let row = store.get_notification(&id).await.unwrap().expect("row");
    assert_eq!(row.user_id.as_deref(), Some("user-1"));
    assert!(row.title.contains("acme.paid"), "{}", row.title);
    assert_eq!(row.source_app_id, None);
    assert_eq!(row.level, "warning");
}

#[test]
fn push_delivery_reuses_one_shared_http_client() {
    assert!(std::ptr::eq(super::push_client(), super::push_client()));
}

#[tokio::test]
async fn a_user_without_push_devices_gets_the_inbox_row_and_no_rendered_push() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let directory = tempfile::tempdir().unwrap();
    let store = super::NotifyStore::open(directory.path().join("notify.db")).unwrap();
    let id = super::deliver_user_notification(
        &store, "user-2", "Hello", "World", "info", None, None, false, None,
    )
    .await
    .unwrap();
    let row = store.get_notification(&id).await.unwrap().expect("row");
    assert_eq!(row.user_id.as_deref(), Some("user-2"));
    assert_eq!(row.title, "Hello");

    let renders = AtomicUsize::new(0);
    let render = |_: &str| {
        renders.fetch_add(1, Ordering::SeqCst);
        ("t".to_owned(), "b".to_owned())
    };
    super::push_to_user(&store, "user-2", false, &render, serde_json::json!({})).await;
    super::push_to_user(&store, "user-2", true, &render, serde_json::json!({})).await;
    assert_eq!(renders.load(Ordering::SeqCst), 0);
}
