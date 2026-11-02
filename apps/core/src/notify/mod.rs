//! Kernel notification-delivery: the shared store + fan-out orchestration.
//!
//! Notifications are an adjudicated **kernel** concern (not a swappable
//! capability): the delivery store + `deliver_user_notification` + the tiered
//! `notify_all` fan-out stay compiled into Core and keep serving
//! `notifications_api`, `policy_alerts`, `workflow`, and `approvals` even after
//! the monitor ENGINE moves out-of-process.
//!
//! What lives here vs in [`ryu_notify`]: the dep-light wire types (`NotifyTarget`,
//! `AlertDeliveryTargets`) and the pure HTTP send primitives live in the shared
//! `ryu_notify` crate (Core and the out-of-process monitors engine both need
//! them). The Core-coupled orchestration — the SQLite store, desktop event-bus
//! mirror ([`crate::events`]), plugin-hook dispatch ([`crate::plugin_host`]), and
//! the BYO SMTP send ([`ryu_email_send`]) — lives here, because nothing outside
//! Core touches it.
//!
//! The out-of-process monitor engine delivers its alerts back here by POSTing them
//! to Core's `POST /api/host/capability/notify.fanout` kernel capability, handled in
//! [`crate::server::app_notify`], which calls [`notify_all`] (and records the activity
//! item).

pub mod delivery_view;
pub mod run_push;
pub mod store;
mod streaming_privacy;
#[cfg(test)]
mod tests;

use std::sync::OnceLock;

pub use ryu_notify::NotifyTarget;

/// Inbox source used for private suggestions produced by Connect agent triggers.
pub const ISLAND_CONNECT_SUGGESTION_SOURCE: &str = "@ryu/island";
pub const CONNECT_SUGGESTION_PRIVACY_TITLE: &str = "Private connected-app activity";
pub const CONNECT_SUGGESTION_PRIVACY_BODY: &str = "A connected-app event was hidden during Streaming. Review it in the source app when you’re ready.";
pub use store::{NotificationRow, NotifyStore};
pub use streaming_privacy::{localize_privacy_placeholder, privacy_placeholder};

/// Process-global notification store, set once at startup from `main.rs`. The
/// state-free scheduler, workflow executor, and policy-alert deliverer all reach
/// it off `ServerState`, so it is published here once and cloned on read.
static STORE: OnceLock<NotifyStore> = OnceLock::new();

/// Publish the global notify store. Idempotent: a second call is ignored.
pub fn set_global_store(store: NotifyStore) {
    let _ = STORE.set(store);
}

/// The global notify store, if it has been published.
pub fn global_store() -> Option<NotifyStore> {
    STORE.get().cloned()
}

/// A fanned-out alert, decoupled from any producer's concrete type. Monitor
/// alerts and policy alerts both build one of these; `notify_all` fans it out.
pub struct FanoutAlert {
    /// Notification title (webhook/telegram/push heading).
    pub title: String,
    /// Notification body.
    pub message: String,
    /// Extra structured payload for the mobile push `data` field (e.g. the
    /// producing monitor id + alert kind).
    pub data: serde_json::Value,
    /// The full JSON carrier fed to `notification` plugin hooks (observation).
    pub hook_event: serde_json::Value,
}

/// Fan an alert out to every configured target plus all registered mobile push
/// tokens. Best-effort: errors are logged, never propagated.
///
/// Wires in the three Core couplings directly (no host trait, because the store
/// is Core-only): the `notification` plugin-hook dispatch, the BYO SMTP email
/// send ([`ryu_email_send`], a logged skip when no transport is configured), and
/// the whole-node Expo push broadcast.
///
/// When the alert carries localizable text (`hook_event.i18n`, see
/// [`crate::i18n::AlertText`]), each channel gets it rendered: registered devices in
/// the locale they registered with, everything else in the node's
/// `ui-language`. Otherwise the producer's own `title`/`message` go out as-is.
pub async fn notify_all(
    http: &reqwest::Client,
    store: &NotifyStore,
    targets: &[NotifyTarget],
    alert: &FanoutAlert,
) {
    // Notification hooks (Claude parity): observe every fanned-out alert, detached
    // and best-effort. The global dispatcher's DB-free fast path skips instantly
    // when no `notification` plugin is loaded.
    fire_notification_hooks(alert.hook_event.clone());

    let text = alert
        .hook_event
        .get("i18n")
        .and_then(crate::i18n::AlertText::from_wire);
    let node_locale = match text {
        Some(_) => crate::i18n::locale::node_locale().await,
        None => "en",
    };
    let render = |locale: &str| match &text {
        Some(text) => text.render(locale),
        None => (alert.title.clone(), alert.message.clone()),
    };
    let (title, message) = render(node_locale);

    for target in targets {
        match target {
            NotifyTarget::Webhook { url } => {
                ryu_notify::send_webhook_alert(http, url, &title, &message, &alert.hook_event)
                    .await;
            }
            NotifyTarget::Telegram { bot_token, chat_id } => {
                ryu_notify::send_telegram_alert(http, bot_token, chat_id, &title, &message).await;
            }
            NotifyTarget::ExpoPush { token } => {
                ryu_notify::push_expo_message(
                    http,
                    &[token.clone()],
                    &title,
                    &message,
                    alert.data.clone(),
                )
                .await;
            }
            NotifyTarget::Email { to } => send_email(to, &title, &message).await,
        }
    }

    // Globally-registered mobile devices always receive triggered alerts, each
    // in its own language when the alert is localizable.
    match store.push_targets().await {
        Ok(devices) if !devices.is_empty() => {
            let groups = match text {
                Some(_) => tokens_by_locale(&devices, node_locale),
                None => vec![(node_locale, devices.into_iter().map(|d| d.token).collect())],
            };
            for (locale, tokens) in groups {
                let (title, message) = render(locale);
                ryu_notify::push_expo_message(http, &tokens, &title, &message, alert.data.clone())
                    .await;
            }
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("notify: failed to read push tokens: {e}"),
    }
}

/// Group devices by the locale to render for them: the one each registered,
/// else `fallback` (the node's). Sorted by locale, so delivery is stable.
pub fn tokens_by_locale(
    devices: &[store::PushTarget],
    fallback: &'static str,
) -> Vec<(&'static str, Vec<String>)> {
    let mut groups: std::collections::BTreeMap<&'static str, Vec<String>> =
        std::collections::BTreeMap::new();
    for device in devices {
        let locale = crate::i18n::locale::stored(device.locale.as_deref()).unwrap_or(fallback);
        groups.entry(locale).or_default().push(device.token.clone());
    }
    groups.into_iter().collect()
}

/// Deliver a user-targeted notification across all three surfaces: the app inbox
/// (persisted row), the desktop OS toast (user-scoped SSE event), and the
/// member's mobile devices (Expo push). Returns the inbox row id.
///
/// `ack_required` marks a HITL notification whose acknowledgement resumes a
/// suspended workflow run (`workflow_run_id` + `node_id` identify the gate).
/// `source_app_id` records which app raised it (for icon/name resolution in the
/// desktop); a Core-internal producer passes `None` (or its own id, when it wants
/// to surface under a named app). Every channel is best-effort: a push failure
/// never blocks the inbox write.
#[allow(clippy::too_many_arguments)]
pub async fn deliver_user_notification(
    store: &NotifyStore,
    user_id: &str,
    title: &str,
    body: &str,
    level: &str,
    workflow_run_id: Option<&str>,
    node_id: Option<&str>,
    ack_required: bool,
    source_app_id: Option<&str>,
) -> Result<String, String> {
    let id = format!("ntf_{}", uuid::Uuid::new_v4().simple());
    let row = NotificationRow {
        id: id.clone(),
        user_id: Some(user_id.to_owned()),
        title: title.to_owned(),
        body: (!body.is_empty()).then(|| body.to_owned()),
        level: level.to_owned(),
        workflow_run_id: workflow_run_id.map(|s| s.to_owned()),
        node_id: node_id.map(|s| s.to_owned()),
        ack_required,
        acked: false,
        read_at: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_app_id: source_app_id.map(|s| s.to_owned()),
        archived_at: None,
    };
    // 1. App inbox (persisted — the one channel that must succeed).
    store
        .insert_notification(&row)
        .await
        .map_err(|e| format!("failed to persist notification: {e}"))?;

    // 2. Desktop OS toast, scoped to the target member.
    crate::events::publish(crate::events::DesktopNotification {
        title: title.to_owned(),
        body: (!body.is_empty()).then(|| body.to_owned()),
        level: level.to_owned(),
        target_user_id: Some(user_id.to_owned()),
        notification_id: Some(id.clone()),
        source_app_id: source_app_id.map(|s| s.to_owned()),
    });

    // 3. Mobile push to the member's registered devices.
    let data = serde_json::json!({
        "notification_id": id,
        "workflow_run_id": workflow_run_id,
        "ack_required": ack_required,
    });
    push_to_user(
        store,
        user_id,
        false,
        &|_| (title.to_owned(), body.to_owned()),
        data,
    )
    .await;
    Ok(id)
}

/// Push to `user_id`'s registered devices. When `localized`, the devices are
/// grouped by the locale each registered with (else the node's) and `render`
/// writes the text once per group; otherwise it is called once for every device.
async fn push_to_user(
    store: &NotifyStore,
    user_id: &str,
    localized: bool,
    render: &(dyn Fn(&str) -> (String, String) + Sync),
    data: serde_json::Value,
) {
    let devices = match store.push_targets_for_user(user_id).await {
        Ok(devices) => devices,
        Err(e) => {
            tracing::warn!("notify: failed to read push tokens for {user_id}: {e}");
            return;
        }
    };
    let http = reqwest::Client::new();
    let groups = if localized && !devices.is_empty() {
        tokens_by_locale(&devices, crate::i18n::locale::node_locale().await)
    } else {
        vec![("en", devices.into_iter().map(|d| d.token).collect())]
    };
    for (locale, tokens) in groups {
        let (title, body) = render(locale);
        ryu_notify::push_expo_message(&http, &tokens, &title, &body, data.clone()).await;
    }
}

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
    });
    Ok(notification_id.to_owned())
}

/// Deliver a plain app-raised notification (no workflow gate) into the user's
/// inbox + toast + push. `source_app_id` is the AUTHENTICATED calling app's id —
/// it is always derived from the sidecar identity, never taken from the request
/// body, so a notification can only ever be attributed to the app that minted
/// the token that sent it.
pub async fn deliver_app_notification(
    store: &NotifyStore,
    source_app_id: &str,
    user_id: &str,
    title: &str,
    body: &str,
    level: &str,
) -> Result<String, String> {
    deliver_user_notification(
        store,
        user_id,
        title,
        body,
        level,
        None,
        None,
        false,
        Some(source_app_id),
    )
    .await
}

/// [`deliver_app_notification`] for localizable text (the `i18n` payload of
/// `notify.deliver`): the inbox row and desktop toast are written in the node's
/// `ui-language`, and each of the member's devices gets the push in the locale
/// it registered with. `clip` bounds the rendered title and body the way the
/// caller bounds plain text.
pub async fn deliver_localized_app_notification(
    store: &NotifyStore,
    source_app_id: &str,
    user_id: &str,
    text: &crate::i18n::AlertText,
    level: &str,
    clip: fn(String, String) -> (String, String),
) -> Result<String, String> {
    deliver_localized_user_notification(store, user_id, text, level, Some(source_app_id), clip)
        .await
}

/// [`deliver_user_notification`] for a Core-authored notification that
/// carries message keys and arguments rather than rendered text: the inbox row
/// and desktop toast are written in the node's `ui-language`, and each of the
/// member's devices gets the push rendered in the locale it registered with
/// (falling back to the node's). `clip` bounds every rendering.
pub async fn deliver_localized_user_notification(
    store: &NotifyStore,
    user_id: &str,
    text: &crate::i18n::AlertText,
    level: &str,
    source_app_id: Option<&str>,
    clip: fn(String, String) -> (String, String),
) -> Result<String, String> {
    let node_locale = crate::i18n::locale::node_locale().await;
    let (title, body) = {
        let (title, body) = text.render(node_locale);
        clip(title, body)
    };
    let id = format!("ntf_{}", uuid::Uuid::new_v4().simple());
    persist_and_toast(store, &id, user_id, &title, &body, level, source_app_id).await?;
    let data = serde_json::json!({
        "notification_id": id,
        "workflow_run_id": serde_json::Value::Null,
        "ack_required": false,
    });
    // Each push is clipped like the inbox row: a translation may run longer.
    let render = |locale: &str| {
        let (title, body) = text.render(locale);
        clip(title, body)
    };
    push_to_user(store, user_id, true, &render, data).await;
    Ok(id)
}

/// Steps 1 and 2 of a plain app notification: the inbox row and the toast.
/// Also the whole of a copy whose push already went out another way (the
/// `notify.fanout` inbox copy, after `notify_all` pushed to every device).
pub(crate) async fn persist_and_toast(
    store: &NotifyStore,
    id: &str,
    user_id: &str,
    title: &str,
    body: &str,
    level: &str,
    source_app_id: Option<&str>,
) -> Result<(), String> {
    let row = NotificationRow {
        id: id.to_owned(),
        user_id: Some(user_id.to_owned()),
        title: title.to_owned(),
        body: (!body.is_empty()).then(|| body.to_owned()),
        level: level.to_owned(),
        workflow_run_id: None,
        node_id: None,
        ack_required: false,
        acked: false,
        read_at: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        source_app_id: source_app_id.map(str::to_owned),
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
    });
    Ok(())
}

/// Send a single-recipient alert email over the shared BYO SMTP transport.
/// Best-effort: with no transport configured, or on a send failure, this logs and
/// drops it — it never propagates and never blocks other targets.
async fn send_email(to: &str, subject: &str, body: &str) {
    let Some(cfg) = ryu_email_send::resolve_transport() else {
        tracing::warn!("notify: email to {to} skipped — no SMTP transport configured");
        return;
    };
    if let Err(e) = ryu_email_send::send_email_alert(&cfg, to, subject, body).await {
        tracing::warn!("notify: email to {to} failed: {e}");
    }
}

/// Fire `notification` plugin hooks DETACHED with the alert payload in
/// `ctx.event`. Observation-only.
fn fire_notification_hooks(alert_json: serde_json::Value) {
    tokio::spawn(async move {
        let ctx = crate::plugin_host::HookContext {
            event: Some(alert_json),
            ..Default::default()
        };
        let _ = crate::plugin_host::dispatch_global(crate::plugin_host::ON_NOTIFICATION, ctx).await;
    });
}
