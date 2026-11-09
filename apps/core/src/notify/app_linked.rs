//! App-raised notifications that carry a tap `link`.
//!
//! An app's `notify.deliver` call or `events.emit` hint may name where tapping
//! the notification leads: a deep link into that app
//! (`ryu://apps/<plugin id>/...`, validated by the caller with
//! [`ryu_app_events::NotifyHint::link_is_valid_for`]). The link rides every
//! channel the plain delivery uses: the inbox row's toast and the mobile push
//! `data.link`, exactly as [`super::deliver_linked_notification`] sends a
//! Core-raised one.

use super::{deliver_routed, push_to_user, DeliveryRoute, NotificationRow, NotifyStore};

/// [`super::deliver_app_notification`] with an optional tap `link`.
pub async fn deliver_app_notification_linked(
    store: &NotifyStore,
    source_app_id: &str,
    user_id: &str,
    title: &str,
    body: &str,
    level: &str,
    link: Option<&str>,
) -> Result<String, String> {
    let route = DeliveryRoute {
        source_app_id: Some(source_app_id),
        link,
        ..DeliveryRoute::default()
    };
    deliver_routed(store, user_id, title, body, level, route).await
}

/// [`super::deliver_localized_app_notification`] with an optional tap `link`.
pub async fn deliver_localized_app_notification_linked(
    store: &NotifyStore,
    source_app_id: &str,
    user_id: &str,
    text: &crate::i18n::AlertText,
    level: &str,
    link: Option<&str>,
    clip: fn(String, String) -> (String, String),
) -> Result<String, String> {
    deliver_localized_routed(store, user_id, text, level, Some(source_app_id), link, clip).await
}

/// Localized delivery: the inbox row and toast in the node's `ui-language`,
/// each push in the locale its device registered with. `link`, when set, is
/// carried on the toast and in the push `data`.
pub(super) async fn deliver_localized_routed(
    store: &NotifyStore,
    user_id: &str,
    text: &crate::i18n::AlertText,
    level: &str,
    source_app_id: Option<&str>,
    link: Option<&str>,
    clip: fn(String, String) -> (String, String),
) -> Result<String, String> {
    let node_locale = crate::i18n::locale::node_locale().await;
    let (title, body) = {
        let (title, body) = text.render(node_locale);
        clip(title, body)
    };
    let id = format!("ntf_{}", uuid::Uuid::new_v4().simple());
    let route = DeliveryRoute {
        source_app_id,
        link,
        ..DeliveryRoute::default()
    };
    persist_and_toast_routed(store, &id, user_id, &title, &body, level, &route).await?;
    let mut data = serde_json::json!({
        "notification_id": id,
        "workflow_run_id": serde_json::Value::Null,
        "ack_required": false,
    });
    if let Some(link) = link {
        data["link"] = serde_json::Value::String(link.to_owned());
    }
    // Each push is clipped like the inbox row: a translation may run longer.
    let render = |locale: &str| {
        let (title, body) = text.render(locale);
        clip(title, body)
    };
    push_to_user(store, user_id, true, &render, data).await;
    Ok(id)
}

/// The inbox row and the user-scoped toast of one notification.
pub(super) async fn persist_and_toast_routed(
    store: &NotifyStore,
    id: &str,
    user_id: &str,
    title: &str,
    body: &str,
    level: &str,
    route: &DeliveryRoute<'_>,
) -> Result<(), String> {
    let row = NotificationRow {
        id: id.to_owned(),
        user_id: Some(user_id.to_owned()),
        title: title.to_owned(),
        body: (!body.is_empty()).then(|| body.to_owned()),
        level: level.to_owned(),
        workflow_run_id: route.workflow_run_id.map(str::to_owned),
        node_id: route.node_id.map(str::to_owned),
        ack_required: route.ack_required,
        acked: false,
        read_at: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_app_id: route.source_app_id.map(str::to_owned),
        archived_at: None,
    };
    store
        .insert_notification(&row)
        .await
        .map_err(|e| format!("failed to persist notification: {e}"))?;
    crate::events::publish(crate::events::DesktopNotification {
        title: row.title,
        body: row.body,
        level: row.level,
        target_user_id: row.user_id,
        notification_id: Some(row.id),
        source_app_id: row.source_app_id,
        link: route.link.map(str::to_owned),
    });
    Ok(())
}

#[cfg(test)]
#[path = "app_linked_tests.rs"]
mod tests;
