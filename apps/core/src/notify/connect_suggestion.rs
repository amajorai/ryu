//! Island suggestions raised by Connect agent triggers: persisted to the inbox
//! and toasted, but never sent to mobile push.

use super::{
    localize_privacy_placeholder, streaming_privacy, NotificationRow, NotifyStore,
    ISLAND_CONNECT_SUGGESTION_SOURCE,
};

/// Persist an Island suggestion without sending it to mobile push. The stable id
/// makes Connect retries idempotent; the notification stream and inbox list let
/// Island recover suggestions after it was offline.
pub async fn deliver_connect_suggestion(
    store: &NotifyStore,
    notification_id: &str,
    user_id: &str,
    title: &str,
    body: &str,
) -> Result<String, String> {
    if let Some(existing) = store
        .get_notification(notification_id)
        .await
        .map_err(|error| format!("failed to check existing suggestion: {error}"))?
    {
        if existing.user_id.as_deref() != Some(user_id)
            || existing.source_app_id.as_deref() != Some(ISLAND_CONNECT_SUGGESTION_SOURCE)
        {
            return Err("Connect suggestion id is already used by another notification".to_owned());
        }
        return Ok(notification_id.to_owned());
    }

    let row = NotificationRow {
        id: notification_id.to_owned(),
        user_id: Some(user_id.to_owned()),
        title: title.to_owned(),
        body: Some(body.to_owned()),
        level: "info".to_owned(),
        workflow_run_id: None,
        node_id: None,
        ack_required: false,
        acked: false,
        read_at: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_app_id: Some(ISLAND_CONNECT_SUGGESTION_SOURCE.to_owned()),
        archived_at: None,
    };
    store
        .insert_notification(&row)
        .await
        .map_err(|error| format!("failed to persist Island suggestion: {error}"))?;

    // The row keeps the English placeholder; the toast shows the node's language.
    let (mut title, mut body) = (row.title, row.body);
    if streaming_privacy::is_privacy_placeholder(&title, body.as_deref()) {
        let locale = crate::i18n::locale::node_locale().await;
        localize_privacy_placeholder(&mut title, &mut body, locale);
    }
    crate::events::publish(crate::events::DesktopNotification {
        title,
        body,
        level: row.level,
        target_user_id: row.user_id,
        notification_id: Some(row.id.clone()),
        source_app_id: row.source_app_id,
        link: None,
    });
    Ok(notification_id.to_owned())
}

#[cfg(test)]
#[path = "connect_suggestion_tests.rs"]
mod connect_suggestion_tests;
