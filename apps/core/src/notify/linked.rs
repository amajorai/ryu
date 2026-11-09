//! Core-raised notifications whose tap opens a desktop route, written from
//! localizable text: the inbox row and toast in the node's `ui-language`, the
//! push in the language each of the member's devices registered with.

use super::{deliver_routed, DeliveryRoute, NotifyStore};
use crate::i18n::AlertText;

/// Deliver a Core-raised notification whose tap opens `link`, a desktop route
/// (see [`crate::events::DesktopNotification::link`]), on every surface: the
/// inbox row, the user-scoped toast, and the mobile push `data`. Returns the
/// inbox row id.
pub async fn deliver_linked_notification(
    store: &NotifyStore,
    user_id: &str,
    text: &AlertText,
    level: &str,
    link: &str,
) -> Result<String, String> {
    let (title, body) = text.render(crate::i18n::locale::node_locale().await);
    let route = DeliveryRoute {
        link: Some(link),
        push_text: Some(text),
        ..DeliveryRoute::default()
    };
    deliver_routed(store, user_id, &title, &body, level, route).await
}

/// What a push says in `locale`: `text` rendered for it when the notification
/// is localizable, else the already-written `title` and `body`.
pub(super) fn push_render<'a>(
    text: Option<&'a AlertText>,
    title: &'a str,
    body: &'a str,
) -> impl Fn(&str) -> (String, String) + Sync + 'a {
    move |locale| match text {
        Some(text) => text.render(locale),
        None => (title.to_owned(), body.to_owned()),
    }
}

#[cfg(test)]
#[path = "linked_tests.rs"]
mod tests;
