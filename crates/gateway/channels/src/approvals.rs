//! Approve and Deny buttons for a tool approval an agent is waiting on.
//!
//! When a Core-routed turn ends with a gated tool call parked in the Approvals
//! inbox, Core may hand the turn back with one [`ApprovalPrompt`] per waiting
//! approval (only for a channel connection whose chat approval setting is on).
//! The shared turn path posts each one with [`Channel::send_approval_prompt`].
//!
//! The button's callback data is [`encode_press`]: a fixed prefix, one letter
//! for the choice, and Core's opaque token. It holds no approval id, no tool
//! name and no arguments, and it decides nothing by itself:
//!
//! 1. The adapter takes the presser's account id from the platform's own
//!    payload, on a delivery the platform proved (the bot-token long poll, the
//!    webhook secret token, the app-token or bot-token socket). Nothing in the
//!    callback data names a person.
//! 2. [`decide_press`] refuses a presser the DM access gate has not admitted
//!    (paired, allowlisted, never blocked) without asking Core.
//! 3. Core checks the token against this connection and conversation, the
//!    connection's setting, the chat account's link to a Ryu user, and that
//!    user's permission to decide, then decides once.
//!
//! A refusal is a [`PressOutcome::Notice`] shown only to the presser. Anything
//! that settles the approval is a [`PressOutcome::Final`], which the adapter
//! writes over the prompt message, removing its buttons.

use serde::Deserialize;
use serde_json::json;
use tracing::warn;

use crate::i18n::{self, messages};
use crate::pairing::PairState;
use crate::{Channel, ChannelRuntime, InboundMessage};

/// Prefix of approval callback data. Not JSON, so it can never be read as a
/// plugin button's [`crate::ChannelActionEvent`].
pub const PRESS_PREFIX: &str = "ryuapr";

/// Upper bound for one Core decision call. A press is answered in seconds or
/// reported as unavailable; it never holds a platform acknowledgement open.
const DECIDE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Longest prompt text, before escaping. Escaping can double it, which still
/// fits one Telegram, Slack or Discord message.
pub const PROMPT_MAX_CHARS: usize = 600;

/// One waiting approval, as Core describes it for a chat message.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalPrompt {
    /// Core's opaque token for the buttons.
    pub token: String,
    #[serde(default)]
    pub agent_name: Option<String>,
    pub tool_name: String,
    #[serde(default)]
    pub summary: String,
}

/// A button press an adapter received and attributed to a platform account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPress {
    pub token: String,
    pub approve: bool,
    /// Packed conversation key of the chat the prompt message is in.
    pub chat_id: String,
    /// The presser's platform account id, from the platform's payload.
    pub sender_id: String,
    /// The presser's language, when the platform reports one.
    pub locale: Option<String>,
}

/// How the approval ended, for the text written over the prompt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalState {
    Approved,
    Denied,
    Expired,
    Cancelled,
    /// The buttons are stale (Core restarted, or the approval was pruned).
    Gone,
}

/// A private answer to the presser. The prompt message stays as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notice {
    NotAllowed,
    Unavailable,
}

/// What an adapter does after a press.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressOutcome {
    /// Replace the prompt with the final state and remove the buttons.
    Final(FinalState),
    /// Tell only the presser; change nothing else.
    Notice(Notice),
}

fn valid_token(token: &str) -> bool {
    (16..=48).contains(&token.len()) && token.bytes().all(|byte| byte.is_ascii_alphanumeric())
}

/// The callback data for one button, or `None` for a token Core would never
/// issue. Always under Telegram's 64-byte limit.
pub fn encode_press(token: &str, approve: bool) -> Option<String> {
    valid_token(token)
        .then(|| format!("{PRESS_PREFIX}:{}:{token}", if approve { 'a' } else { 'd' }))
}

/// Read approval callback data back into `(token, approve)`. `None` for
/// anything that is not exactly what [`encode_press`] writes.
pub fn decode_press(data: &str) -> Option<(String, bool)> {
    let mut parts = data.split(':');
    if parts.next() != Some(PRESS_PREFIX) {
        return None;
    }
    let approve = match parts.next()? {
        "a" => true,
        "d" => false,
        _ => return None,
    };
    let token = parts.next()?;
    if parts.next().is_some() || !valid_token(token) {
        return None;
    }
    Some((token.to_owned(), approve))
}

/// The plain text of a prompt: who wants to run what, then Core's summary.
/// Agent, tool and summary text are untrusted; escape the result for the
/// platform's markup before sending it.
pub fn prompt_text(locale: &str, prompt: &ApprovalPrompt) -> String {
    let tool = prompt.tool_name.trim();
    let sentence = match prompt
        .agent_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(agent) => i18n::render(
            locale,
            messages::APPROVAL_REQUEST_MESSAGE,
            &[("agent", agent), ("tool", tool)],
        ),
        None => i18n::render(
            locale,
            messages::APPROVAL_REQUEST_UNNAMED_MESSAGE,
            &[("tool", tool)],
        ),
    };
    let summary = prompt.summary.trim();
    let text = if summary.is_empty() {
        sentence
    } else {
        format!("{sentence}\n{summary}")
    };
    clip(&text, PROMPT_MAX_CHARS)
}

/// Cut `text` to at most `max` characters, marking a cut with an ellipsis.
pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// The Approve and Deny button labels.
pub fn button_labels(locale: &str) -> (String, String) {
    (
        i18n::render(locale, messages::APPROVAL_APPROVE_BUTTON_MESSAGE, &[]),
        i18n::render(locale, messages::APPROVAL_DENY_BUTTON_MESSAGE, &[]),
    )
}

/// The line written under the prompt once the approval is settled.
pub fn final_text(locale: &str, state: FinalState) -> String {
    let template = match state {
        FinalState::Approved => messages::APPROVAL_APPROVED_MESSAGE,
        FinalState::Denied => messages::APPROVAL_DENIED_MESSAGE,
        FinalState::Expired => messages::APPROVAL_EXPIRED_MESSAGE,
        FinalState::Cancelled => messages::APPROVAL_CANCELLED_MESSAGE,
        FinalState::Gone => messages::APPROVAL_GONE_MESSAGE,
    };
    i18n::render(locale, template, &[])
}

/// The private answer to a presser whose press changed nothing.
pub fn notice_text(locale: &str, notice: Notice) -> String {
    let template = match notice {
        Notice::NotAllowed => messages::APPROVAL_NOT_ALLOWED_MESSAGE,
        Notice::Unavailable => messages::APPROVAL_UNAVAILABLE_MESSAGE,
    };
    i18n::render(locale, template, &[])
}

/// Escape untrusted text for Telegram's HTML parse mode.
pub fn escape_telegram_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Escape untrusted text for a Slack `text` field: the three control
/// characters Slack reads as entities, links and mentions.
pub fn escape_slack(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Escape untrusted text for Discord message content: every markdown, link
/// and mention opener gets a backslash, so it is shown as typed. An `@` is
/// followed by a zero-width space so `@everyone` is text, not a ping (the
/// adapter also sends `allowed_mentions` with nothing allowed).
pub fn escape_discord(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        match ch {
            '\\' | '*' | '_' | '~' | '`' | '|' | '>' | '<' | '#' | '[' | ']' | '(' | ')' => {
                out.push('\\');
                out.push(ch);
            }
            '@' => out.push_str("@\u{200b}"),
            other => out.push(other),
        }
    }
    out
}

/// Map Core's answer onto what the adapter does. Unknown values fail closed
/// to "unavailable": the prompt keeps its buttons and nothing is claimed.
pub fn outcome_from(outcome: &str, status: Option<&str>) -> PressOutcome {
    match outcome {
        "decided" | "already_decided" => PressOutcome::Final(match status {
            Some("approved") => FinalState::Approved,
            Some("rejected") => FinalState::Denied,
            Some("expired") => FinalState::Expired,
            Some("cancelled") => FinalState::Cancelled,
            _ => FinalState::Gone,
        }),
        "expired" => PressOutcome::Final(FinalState::Gone),
        "refused" => PressOutcome::Notice(Notice::NotAllowed),
        _ => PressOutcome::Notice(Notice::Unavailable),
    }
}

/// Whether the DM access gate has admitted this platform account: paired or
/// allowlisted (or the bot is open), and never blocked. Read-only.
pub async fn presser_admitted(runtime: &ChannelRuntime, platform: &str, sender_id: &str) -> bool {
    let sender = sender_id.trim();
    if sender.is_empty() {
        return false;
    }
    if matches!(
        runtime.pairing.get(platform, sender).await,
        Some(PairState::Blocked)
    ) {
        return false;
    }
    let as_dm = InboundMessage {
        chat_id: sender.to_owned(),
        sender_id: Some(sender.to_owned()),
        ..Default::default()
    };
    runtime.already_admitted(platform, &as_dm).await
}

impl ChannelRuntime {
    /// Ask Core to decide the approval behind a press. Core does the checks
    /// that matter; this only carries who pressed, where, and what.
    async fn decide_approval_via_core(
        &self,
        connection: &str,
        platform: &str,
        press: &ApprovalPress,
    ) -> anyhow::Result<PressOutcome> {
        let url = format!(
            "{}/api/channels/approvals/decide",
            self.cfg.core_url.trim_end_matches('/')
        );
        let body: serde_json::Value = self
            .http
            .post(url)
            .timeout(DECIDE_TIMEOUT)
            .json(&json!({
                "token": press.token,
                "approve": press.approve,
                "connection": connection,
                "conversationId": self.core_conversation_id(&press.chat_id),
                "platform": platform,
                "senderId": press.sender_id,
            }))
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?
            .json()
            .await
            .map_err(reqwest::Error::without_url)?;
        Ok(outcome_from(
            body["outcome"].as_str().unwrap_or_default(),
            body["status"].as_str(),
        ))
    }
}

/// Decide one press. Never changes an approval for a presser the DM gate has
/// not admitted, and never reports success Core did not confirm.
pub async fn decide_press<C: Channel + ?Sized>(channel: &C, press: &ApprovalPress) -> PressOutcome {
    let runtime = channel.runtime();
    let platform = channel.name();
    if !runtime.routes_via_core() || !presser_admitted(runtime, platform, &press.sender_id).await {
        return PressOutcome::Notice(Notice::NotAllowed);
    }
    match runtime
        .decide_approval_via_core(&channel.delivery_scope(), platform, press)
        .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            warn!(channel = platform, %error, "approval press could not be decided by Core");
            PressOutcome::Notice(Notice::Unavailable)
        }
    }
}

/// Post the prompts a turn returned, one message each. Best-effort: a prompt
/// that cannot be posted leaves its approval in the inbox, where it already is.
pub async fn post_prompts<C: Channel + ?Sized>(
    channel: &C,
    chat_id: &str,
    prompts: &[ApprovalPrompt],
    locale: &str,
) {
    for prompt in prompts {
        if encode_press(&prompt.token, true).is_none() {
            warn!(
                channel = channel.name(),
                "approval prompt had an unusable token; not posted"
            );
            continue;
        }
        if let Err(error) = channel.send_approval_prompt(chat_id, prompt, locale).await {
            warn!(channel = channel.name(), %error, "approval prompt could not be posted");
        }
    }
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
