//! Notification fan-out for monitor alerts.
//!
//! When a monitor's check trips an alert condition, the alert is always recorded
//! and broadcast over SSE (the desktop in-app feed + OS toast subscribe to that).
//! On top of that, each monitor can carry zero or more [`NotifyTarget`]s, and any
//! Expo push tokens registered by mobile devices receive every alert.
//!
//! The set of targets is an extensible enum — the "nothing hardcoded, everything
//! swappable" rule applied to channels: a webhook covers Slack/Discord/any HTTP
//! endpoint, Telegram is a direct Bot-API send, and Expo handles mobile. Adding a
//! Slack/Discord *bot-token* target later is the same shape.
//!
//! Every send is best-effort: a failing target logs a warning and never blocks the
//! check or the other targets.

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::store::MonitorStore;
use super::Alert;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

/// A per-monitor notification destination.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NotifyTarget {
    /// Generic JSON POST. Works with Slack/Discord *incoming webhooks* and any
    /// HTTP endpoint. We send both a Slack/Discord-friendly `text`/`content`
    /// field and the structured alert so one URL fits most services.
    Webhook { url: String },
    /// Direct Telegram Bot API send (`sendMessage`).
    Telegram { bot_token: String, chat_id: String },
    /// A specific Expo push token (in addition to globally-registered devices).
    ExpoPush { token: String },
    /// A single email recipient. Unlike the self-contained Webhook/Telegram
    /// targets, this carries the recipient ONLY: the SMTP transport is a shared
    /// node resource resolved once at the call site (passed as `cfg`), not stored
    /// per-target, so the plaintext-secret surface is not multiplied across rows.
    Email { to: String },
}

/// Fan an alert out to every configured target plus all registered mobile push
/// tokens. Best-effort: errors are logged, never propagated.
///
/// `cfg` is the shared BYO SMTP transport, resolved once by the caller. It is
/// `None` when email is not configured (or no target needs it); an
/// [`NotifyTarget::Email`] target is skipped (with a warning) when `cfg` is
/// `None`, so a missing relay never blocks the other channels.
pub async fn notify_all(
    http: &reqwest::Client,
    store: &MonitorStore,
    targets: &[NotifyTarget],
    alert: &Alert,
    cfg: Option<&crate::email::EmailTransportConfig>,
) {
    // Notification hooks (Claude parity): observe every fanned-out alert, detached
    // and best-effort. Node-level: no chat context, just the alert payload.
    fire_notification_hooks(alert);

    for target in targets {
        match target {
            NotifyTarget::Webhook { url } => send_webhook(http, url, alert).await,
            NotifyTarget::Telegram { bot_token, chat_id } => {
                send_telegram(http, bot_token, chat_id, alert).await;
            }
            NotifyTarget::ExpoPush { token } => send_expo(http, &[token.clone()], alert).await,
            NotifyTarget::Email { to } => send_email(cfg, to, alert).await,
        }
    }

    // Globally-registered mobile devices always receive triggered alerts.
    match store.push_tokens().await {
        Ok(tokens) if !tokens.is_empty() => send_expo(http, &tokens, alert).await,
        Ok(_) => {}
        Err(e) => tracing::warn!("monitors: failed to read push tokens: {e}"),
    }
}

/// Fire `notification` hooks DETACHED with the alert payload in `ctx.event`.
/// Observation-only; the global dispatcher's DB-free fast path skips instantly
/// when no `notification` plugin is loaded.
fn fire_notification_hooks(alert: &Alert) {
    let event = serde_json::to_value(alert).ok();
    tokio::spawn(async move {
        let ctx = crate::plugin_host::HookContext {
            event,
            ..Default::default()
        };
        let _ = crate::plugin_host::dispatch_global(crate::plugin_host::ON_NOTIFICATION, ctx).await;
    });
}

async fn send_webhook(http: &reqwest::Client, url: &str, alert: &Alert) {
    let body = json!({
        // Slack uses `text`, Discord uses `content`; sending both is harmless.
        "text": format!("{}\n{}", alert.title, alert.message),
        "content": format!("{}\n{}", alert.title, alert.message),
        "alert": alert,
    });
    let result = http
        .post(url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("monitors: webhook notify to {url} failed: {e}");
    }
}

/// Post a plain-text message to a Slack/Discord/generic incoming webhook. Sends
/// both `text` (Slack) and `content` (Discord) so one URL fits either service.
///
/// Unlike [`send_webhook`], this carries no `Alert` framing — it is the raw
/// send primitive behind the [`crate::workflow::NodeKind::ChannelSend`] node.
/// Returns `Ok(())` only on a 2xx response so a workflow node can surface a
/// failed delivery.
pub async fn send_webhook_text(
    http: &reqwest::Client,
    url: &str,
    text: &str,
) -> Result<(), String> {
    let body = json!({ "text": text, "content": text });
    let resp = http
        .post(url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("webhook send failed: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("webhook returned HTTP {status}"))
    }
}

/// Send a plain-text message via the Telegram Bot API (`sendMessage`). The raw
/// send primitive behind the [`crate::workflow::NodeKind::ChannelSend`] node;
/// returns `Ok(())` only on a 2xx so a workflow node can surface a failed send.
pub async fn send_telegram_text(
    http: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let api = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
    let resp = http
        .post(&api)
        .json(&json!({ "chat_id": chat_id, "text": text }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("telegram send failed: {e}"))?;
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("telegram returned HTTP {status}"))
    }
}

/// Send a single-recipient alert email over the shared BYO SMTP transport.
/// Best-effort: with no transport configured, or on a send failure, this logs and
/// drops the result — it never propagates and never blocks other targets.
async fn send_email(
    cfg: Option<&crate::email::EmailTransportConfig>,
    to: &str,
    alert: &Alert,
) {
    let Some(cfg) = cfg else {
        tracing::warn!("monitors: email target {to} skipped (no SMTP transport configured)");
        return;
    };
    if let Err(e) = crate::email::send_email_alert(cfg, to, &alert.title, &alert.message).await {
        tracing::warn!("monitors: email notify to {to} failed: {e}");
    }
}

async fn send_telegram(http: &reqwest::Client, bot_token: &str, chat_id: &str, alert: &Alert) {
    let api = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
    let text = format!("\u{1f514} {}\n{}", alert.title, alert.message);
    let result = http
        .post(&api)
        .json(&json!({ "chat_id": chat_id, "text": text }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("monitors: telegram notify failed: {e}");
    }
}

/// Send a plain title/body push to a set of Expo tokens (not tied to a monitor
/// alert). Used by user-targeted notifications (e.g. a workflow pinging a
/// teammate). Best-effort: a failure is logged, never propagated.
pub async fn push_expo_message(
    http: &reqwest::Client,
    tokens: &[String],
    title: &str,
    body: &str,
    data: serde_json::Value,
) {
    if tokens.is_empty() {
        return;
    }
    let messages: Vec<_> = tokens
        .iter()
        .map(|t| {
            json!({
                "to": t,
                "title": title,
                "body": body,
                "sound": "default",
                "data": data,
            })
        })
        .collect();
    let result = http
        .post(EXPO_PUSH_URL)
        .json(&messages)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("notify: expo push message failed: {e}");
    }
}

async fn send_expo(http: &reqwest::Client, tokens: &[String], alert: &Alert) {
    // Expo accepts an array of messages in one POST.
    let messages: Vec<_> = tokens
        .iter()
        .map(|t| {
            json!({
                "to": t,
                "title": alert.title,
                "body": alert.message,
                "sound": "default",
                "data": { "monitor_id": alert.monitor_id, "kind": alert.kind },
            })
        })
        .collect();
    let result = http
        .post(EXPO_PUSH_URL)
        .json(&messages)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("monitors: expo push notify failed: {e}");
    }
}
