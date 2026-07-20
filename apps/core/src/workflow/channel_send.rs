//! The [`super::NodeKind::ChannelSend`] node: deliver a message OUT to an
//! external chat channel (Telegram / Slack / Discord / generic HTTP webhook).
//!
//! Placement (Core vs Gateway): this decides *what runs* (fire a message on a
//! node) → Core. It reuses the swappable channel send primitives in
//! [`ryu_notify`] so "add another channel" is one match arm, never a new
//! transport — the same "nothing hardcoded, everything swappable" rule the
//! monitor notify targets follow.
//!
//! `recipient` and `text` are already template-resolved by the executor before
//! this runs; the BYO credential (`bot_token` / `webhook_url`) rides inline on
//! the node.

use std::time::Instant;

use super::ChannelPlatform;
use ryu_notify::{send_telegram_text, send_webhook_text};

/// Send one message to the configured channel. Returns a JSON receipt string on
/// success, or an error string that fails the node.
///
/// **Outbound is governed (webhook-unify #4).** Before the message leaves the
/// box it is routed through the Gateway firewall (`POST /v1/firewall/check`,
/// pii + secret) so DLP applies to *egress* — the Core-vs-Gateway rule says
/// "what is allowed to leave" is the Gateway's job, and AGENTS.md mandates every
/// egress be governed. A tripped guardrail fails the node (block-and-refuse; the
/// firewall has no sanitize surface for Core to call). Fail-closed if the gateway
/// is unreachable, matching the workflow `Guardrails` node and the support-bundle
/// egress gate (override with `RYU_ALLOW_GATEWAY_FALLBACK=1`). Every send is also
/// recorded to the Gateway exec-audit store (best-effort).
pub async fn run(
    platform: ChannelPlatform,
    recipient: &str,
    text: &str,
    bot_token: Option<&str>,
    webhook_url: Option<&str>,
) -> Result<String, String> {
    if text.trim().is_empty() {
        return Err("channel_send: message text is empty".to_string());
    }

    let platform_str = match platform {
        ChannelPlatform::Telegram => "telegram",
        ChannelPlatform::Slack => "slack",
        ChannelPlatform::Discord => "discord",
        ChannelPlatform::Webhook => "webhook",
    };

    // Gateway egress DLP gate: refuse the send if the firewall blocks the text.
    // Shared with the agent-callable `channel__send` tool so egress never drifts.
    crate::sidecar::gateway::govern_egress(text).await?;

    let http = reqwest::Client::new();
    let started = Instant::now();

    let send_result = match platform {
        ChannelPlatform::Telegram => {
            let token = bot_token
                .filter(|t| !t.trim().is_empty())
                .ok_or_else(|| "channel_send: telegram requires a bot_token".to_string())?;
            if recipient.trim().is_empty() {
                return Err("channel_send: telegram requires a recipient (chat_id)".to_string());
            }
            send_telegram_text(&http, token, recipient, text).await
        }
        ChannelPlatform::Slack | ChannelPlatform::Discord | ChannelPlatform::Webhook => {
            let url = webhook_url
                .filter(|u| !u.trim().is_empty())
                .ok_or_else(|| "channel_send: this channel requires a webhook_url".to_string())?;
            send_webhook_text(&http, url, text).await
        }
    };

    // Audit the egress attempt (best-effort; never fails the send). We record the
    // platform + recipient, never the message body, so the audit row carries no
    // content. The firewall gate above already governed the body.
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let (exit_code, err) = match &send_result {
        Ok(()) => (0, None),
        Err(e) => (1, Some(e.clone())),
    };
    crate::sidecar::gateway::report_exec_audit(
        &format!("channel-send:{platform_str}"),
        &format!("send -> {recipient}"),
        elapsed_ms,
        exit_code,
        None,
        err,
    )
    .await;

    send_result?;

    Ok(serde_json::json!({
        "sent": true,
        "platform": platform_str,
        "recipient": recipient,
    })
    .to_string())
}
