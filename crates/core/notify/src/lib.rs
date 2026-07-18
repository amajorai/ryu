//! Shared notification-delivery wire types + send primitives.
//!
//! This crate is the narrow surface that both **Core** (the kernel notification
//! store + fan-out orchestration in `apps/core/src/notify`) and the
//! out-of-process **monitors** engine (`apps-store/monitors/backend`) need in
//! common: the channel-target enum and the dep-light HTTP send functions. It has
//! ZERO dependency on `apps/core`.
//!
//! Placement (Core vs Gateway): a notification decides *what runs* (open a
//! delivery socket) → Core-side. Nothing here is policy. The store,
//! `deliver_user_notification`, dedupe, and the tiered `notify_all` fan-out that
//! wires in the desktop event bus / plugin hooks / BYO SMTP live in Core; only the
//! shared types + primitives live here.
//!
//! The set of targets is an extensible enum — the "nothing hardcoded, everything
//! swappable" rule applied to channels: a webhook covers Slack/Discord/any HTTP
//! endpoint, Telegram is a direct Bot-API send, Expo handles mobile, and Email
//! carries only the recipient (the SMTP transport is a shared node resource
//! resolved once at the Core call site, never stored per-target).
//!
//! Every send is best-effort unless its name ends in `_text`: those return
//! `Ok(())` only on a 2xx so a workflow node can surface a failed delivery.

use serde::{Deserialize, Serialize};
use serde_json::json;

const EXPO_PUSH_URL: &str = "https://exp.host/--/api/v2/push/send";

/// A notification destination (per-monitor or node-level policy-alert channel).
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
    /// node resource resolved once at the Core call site (`ryu_email_send`), not
    /// stored per-target, so the plaintext-secret surface is not multiplied.
    Email { to: String },
}

/// Node-level alert delivery targets (self-host): the fan-out channels
/// (webhook / Telegram / Expo push) + email recipients that policy alerts
/// deliver to. Distinct from per-monitor targets, which are scoped to one
/// watched site. Persisted in the Core notify store (`alert_delivery` table).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AlertDeliveryTargets {
    #[serde(default)]
    pub targets: Vec<NotifyTarget>,
    #[serde(default)]
    pub emails: Vec<String>,
}

// ---- 2xx-gated primitives (workflow ChannelSend surfaces failures) ---------

/// Post a plain-text message to a Slack/Discord/generic incoming webhook. Sends
/// both `text` (Slack) and `content` (Discord) so one URL fits either service.
/// Returns `Ok(())` only on a 2xx response.
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

/// Send a plain-text message via the Telegram Bot API (`sendMessage`). Returns
/// `Ok(())` only on a 2xx so a workflow node can surface a failed send.
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

// ---- best-effort alert sends (fan-out; errors are logged, never propagated) --

/// Best-effort webhook alert send: `{text, content, alert}` so both Slack/Discord
/// framing and the structured payload ride one URL. `alert` is the full JSON
/// carrier (embedded under `"alert"`).
pub async fn send_webhook_alert(
    http: &reqwest::Client,
    url: &str,
    title: &str,
    message: &str,
    alert: &serde_json::Value,
) {
    let body = json!({
        "text": format!("{title}\n{message}"),
        "content": format!("{title}\n{message}"),
        "alert": alert,
    });
    let result = http
        .post(url)
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("notify: webhook to {url} failed: {e}");
    }
}

/// Best-effort Telegram alert send (with a bell emoji prefix).
pub async fn send_telegram_alert(
    http: &reqwest::Client,
    bot_token: &str,
    chat_id: &str,
    title: &str,
    message: &str,
) {
    let api = format!("https://api.telegram.org/bot{bot_token}/sendMessage");
    let text = format!("\u{1f514} {title}\n{message}");
    let result = http
        .post(&api)
        .json(&json!({ "chat_id": chat_id, "text": text }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;
    if let Err(e) = result {
        tracing::warn!("notify: telegram alert failed: {e}");
    }
}

/// Send a plain title/body push to a set of Expo tokens. Best-effort: a failure
/// is logged, never propagated. `data` rides through to the device payload.
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
