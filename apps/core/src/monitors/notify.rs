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
}

/// Fan an alert out to every configured target plus all registered mobile push
/// tokens. Best-effort: errors are logged, never propagated.
pub async fn notify_all(
    http: &reqwest::Client,
    store: &MonitorStore,
    targets: &[NotifyTarget],
    alert: &Alert,
) {
    for target in targets {
        match target {
            NotifyTarget::Webhook { url } => send_webhook(http, url, alert).await,
            NotifyTarget::Telegram { bot_token, chat_id } => {
                send_telegram(http, bot_token, chat_id, alert).await;
            }
            NotifyTarget::ExpoPush { token } => send_expo(http, &[token.clone()], alert).await,
        }
    }

    // Globally-registered mobile devices always receive triggered alerts.
    match store.push_tokens().await {
        Ok(tokens) if !tokens.is_empty() => send_expo(http, &tokens, alert).await,
        Ok(_) => {}
        Err(e) => tracing::warn!("monitors: failed to read push tokens: {e}"),
    }
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
