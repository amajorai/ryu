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
//! to Core's `POST /api/host/monitors/alert` callback, handled in
//! [`crate::monitors_client`], which calls [`notify_all`] (and records the activity
//! item).

pub mod store;

use std::sync::OnceLock;

pub use ryu_notify::NotifyTarget;
pub use store::{NotificationRow, NotifyStore};

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

    for target in targets {
        match target {
            NotifyTarget::Webhook { url } => {
                ryu_notify::send_webhook_alert(http, url, &alert.title, &alert.message, &alert.hook_event)
                    .await;
            }
            NotifyTarget::Telegram { bot_token, chat_id } => {
                ryu_notify::send_telegram_alert(http, bot_token, chat_id, &alert.title, &alert.message)
                    .await;
            }
            NotifyTarget::ExpoPush { token } => {
                ryu_notify::push_expo_message(
                    http,
                    &[token.clone()],
                    &alert.title,
                    &alert.message,
                    alert.data.clone(),
                )
                .await;
            }
            NotifyTarget::Email { to } => send_email(to, &alert.title, &alert.message).await,
        }
    }

    // Globally-registered mobile devices always receive triggered alerts.
    match store.push_tokens().await {
        Ok(tokens) if !tokens.is_empty() => {
            ryu_notify::push_expo_message(
                http,
                &tokens,
                &alert.title,
                &alert.message,
                alert.data.clone(),
            )
            .await;
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("notify: failed to read push tokens: {e}"),
    }
}

/// Deliver a user-targeted notification across all three surfaces: the app inbox
/// (persisted row), the desktop OS toast (user-scoped SSE event), and the
/// member's mobile devices (Expo push). Returns the inbox row id.
///
/// `ack_required` marks a HITL notification whose acknowledgement resumes a
/// suspended workflow run (`workflow_run_id` + `node_id` identify the gate).
/// Every channel is best-effort: a push failure never blocks the inbox write.
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
    });

    // 3. Mobile push to the member's registered devices.
    let http = reqwest::Client::new();
    match store.push_tokens_for_user(user_id).await {
        Ok(tokens) => {
            ryu_notify::push_expo_message(
                &http,
                &tokens,
                title,
                body,
                serde_json::json!({
                    "notification_id": id,
                    "workflow_run_id": workflow_run_id,
                    "ack_required": ack_required,
                }),
            )
            .await;
        }
        Err(e) => tracing::warn!("notify: failed to read push tokens for {user_id}: {e}"),
    }
    Ok(id)
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
