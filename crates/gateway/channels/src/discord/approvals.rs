//! Approve and Deny buttons for a waiting tool approval, on Discord.
//!
//! The prompt is one message with an action row of two buttons. Each
//! button's `custom_id` is [`shared::encode_press`]. Agent, tool and summary
//! text is escaped and sent with no mention allowed, so nothing an agent
//! wrote is read as markdown, a link or a ping.
//!
//! A press arrives as an `INTERACTION_CREATE` event (a message component
//! interaction) on the Gateway session this bot identified with its bot
//! token. That session is the delivery proof: interactions on the Gateway
//! carry no signature (the Ed25519 signature belongs to the HTTP interactions
//! endpoint, which this adapter does not serve). The presser is the
//! interaction's `member.user.id` (or `user.id` in a direct message), which
//! Discord sets. Nothing in the `custom_id` names a person, a channel or an
//! approval.
//!
//! Discord wants an answer within three seconds, so the press is first
//! acknowledged as a deferred update. A press that settles the approval then
//! edits the prompt to its final state and removes the buttons. A press that
//! changes nothing sends an ephemeral follow-up only the presser sees.

use super::*;
use crate::approvals::{self as shared, ApprovalPress, ApprovalPrompt, FinalState, PressOutcome};

/// Interaction type of a message component press.
const MESSAGE_COMPONENT: u64 = 3;
/// Component type of a button.
const BUTTON: u64 = 2;
/// Callback type that acknowledges a press and keeps the message for a later edit.
const DEFERRED_UPDATE_MESSAGE: u64 = 6;
/// Message flag that shows a message only to the person who triggered it.
const EPHEMERAL: u64 = 64;
/// Longest prompt text kept when the final state is written under it, so the
/// edited message stays inside Discord's 2000 character limit.
const SHOWN_MAX_CHARS: usize = 1700;

/// One approval button press, read from a component interaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct DiscordPress {
    pub(super) token: String,
    pub(super) approve: bool,
    pub(super) interaction_id: String,
    /// The interaction's own token, which answers this one press only.
    pub(super) interaction_token: String,
    pub(super) application_id: String,
    /// The Discord user who pressed, as Discord reported it.
    pub(super) user: String,
    /// The channel (or thread) the prompt message is in.
    pub(super) channel_id: String,
    pub(super) is_group: bool,
    /// The prompt's content as Discord returned it (already escaped).
    pub(super) shown: String,
    pub(super) locale: Option<String>,
}

/// Whether `value` is a message component interaction. Those never start a turn.
pub(super) fn is_component(value: &Value) -> bool {
    value["type"].as_u64() == Some(MESSAGE_COMPONENT)
}

/// Read an approval press out of an interaction. `None` for every other
/// interaction, and for a press that lacks who pressed or where.
pub(super) fn parse_press(value: &Value) -> Option<DiscordPress> {
    if !is_component(value) || value["data"]["component_type"].as_u64() != Some(BUTTON) {
        return None;
    }
    let (token, approve) = shared::decode_press(value["data"]["custom_id"].as_str()?)?;
    let text_of = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let user = text_of(&value["member"]["user"]["id"]).or_else(|| text_of(&value["user"]["id"]))?;
    Some(DiscordPress {
        token,
        approve,
        interaction_id: text_of(&value["id"])?,
        interaction_token: text_of(&value["token"])?,
        application_id: text_of(&value["application_id"])?,
        user,
        channel_id: text_of(&value["channel_id"])?,
        is_group: value["guild_id"].as_str().is_some(),
        shown: value["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
        locale: interaction_locale(value),
    })
}

/// The packed conversation key of the turn that posted the prompt, from the
/// parent lookup of the channel the prompt is in ([`inbound_chat_id`]). `None`
/// when the lookup failed: the conversation is then unknown, never guessed.
pub(super) fn press_chat_id(
    press: &DiscordPress,
    parent: Option<Option<String>>,
) -> Option<String> {
    if !press.is_group {
        return Some(inbound_chat_id(&press.channel_id, None));
    }
    let parent = parent?;
    Some(inbound_chat_id(&press.channel_id, parent.as_deref()))
}

/// Mentions are never parsed in an approval message.
fn no_mentions() -> Value {
    json!({ "parse": [] })
}

fn button(label: &str, custom_id: &str, style: u64) -> Value {
    json!({ "type": BUTTON, "style": style, "label": label, "custom_id": custom_id })
}

/// Message create payload for one prompt, or `None` for a token Core would
/// never issue.
pub(super) fn prompt_payload(prompt: &ApprovalPrompt, locale: &str) -> Option<Value> {
    let approve = shared::encode_press(&prompt.token, true)?;
    let deny = shared::encode_press(&prompt.token, false)?;
    let (approve_label, deny_label) = shared::button_labels(locale);
    Some(json!({
        "content": shared::escape_discord(&shared::prompt_text(locale, prompt)),
        "allowed_mentions": no_mentions(),
        "components": [{
            "type": 1,
            "components": [
                // 3 is the green style, 4 the red one.
                button(&shared::clip(&approve_label, 80), &approve, 3),
                button(&shared::clip(&deny_label, 80), &deny, 4),
            ],
        }],
    }))
}

/// Message edit payload that writes the final state under the prompt and
/// removes its buttons. `shown` is the bot's own prompt as Discord returned
/// it, so it is already escaped and is kept as it is.
pub(super) fn final_payload(shown: &str, locale: &str, state: FinalState) -> Value {
    let body = shared::clip(shown.trim(), SHOWN_MAX_CHARS);
    let verdict = shared::escape_discord(&shared::final_text(locale, state));
    let content = if body.is_empty() {
        format!("**{verdict}**")
    } else {
        format!("{body}\n\n**{verdict}**")
    };
    json!({
        "content": content,
        "allowed_mentions": no_mentions(),
        "components": [],
    })
}

/// Follow-up payload for a notice only the presser sees.
pub(super) fn notice_payload(text: &str) -> Value {
    json!({
        "content": shared::escape_discord(text),
        "flags": EPHEMERAL,
        "allowed_mentions": no_mentions(),
    })
}

/// How `outcome` is shown: the HTTP method, the path under the interaction
/// webhook, and the body. A settled approval edits the prompt; anything else
/// is a follow-up for the presser alone.
pub(super) fn outcome_call(
    press: &DiscordPress,
    locale: &str,
    outcome: PressOutcome,
) -> (reqwest::Method, &'static str, Value) {
    match outcome {
        PressOutcome::Final(state) => (
            reqwest::Method::PATCH,
            "/messages/@original",
            final_payload(&press.shown, locale, state),
        ),
        PressOutcome::Notice(notice) => (
            reqwest::Method::POST,
            "",
            notice_payload(&shared::notice_text(locale, notice)),
        ),
    }
}

impl DiscordChannel {
    /// Post one approval prompt. `Ok(false)` for a token Core would never issue.
    pub(super) async fn post_approval_prompt(
        &self,
        chat_id: &str,
        prompt: &ApprovalPrompt,
        locale: &str,
    ) -> anyhow::Result<bool> {
        let Some(payload) = prompt_payload(prompt, locale) else {
            return Ok(false);
        };
        let target = target_channel(chat_id);
        self.http()
            .post(format!("{API_BASE}/channels/{target}/messages"))
            .header("Authorization", self.auth_header())
            .json(&payload)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(true)
    }

    /// Decide one press for the conversation `chat_id`. The presser is the
    /// user Discord named in the interaction.
    pub(super) async fn decide_approval_press(
        &self,
        press: &DiscordPress,
        chat_id: Option<String>,
    ) -> PressOutcome {
        // Without its conversation a press cannot be checked against its token.
        let Some(chat_id) = chat_id else {
            return PressOutcome::Notice(shared::Notice::Unavailable);
        };
        let shared_press = ApprovalPress {
            token: press.token.clone(),
            approve: press.approve,
            chat_id,
            sender_id: press.user.clone(),
            locale: press.locale.clone(),
        };
        shared::decide_press(self, &shared_press).await
    }

    /// One call on the interaction's own webhook. The URL holds the
    /// interaction token, so it is kept out of every error.
    async fn interaction_call(
        &self,
        method: reqwest::Method,
        url: String,
        body: &Value,
    ) -> anyhow::Result<()> {
        self.http()
            .request(method, url)
            .json(body)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;
        Ok(())
    }

    /// Decide one approval button press and show the result.
    pub(super) async fn handle_approval_press(&self, press: DiscordPress) {
        let callback = format!(
            "{API_BASE}/interactions/{}/{}/callback",
            press.interaction_id, press.interaction_token
        );
        let ack = json!({ "type": DEFERRED_UPDATE_MESSAGE });
        if let Err(error) = self
            .interaction_call(reqwest::Method::POST, callback, &ack)
            .await
        {
            // An unacknowledged press cannot be answered, so nothing is decided.
            warn!(%error, "discord approval press could not be acknowledged");
            return;
        }
        let parent = if press.is_group {
            self.parent_channel_id(&press.channel_id).await
        } else {
            Some(None)
        };
        let outcome = self
            .decide_approval_press(&press, press_chat_id(&press, parent))
            .await;
        let locale = self.runtime.reply_locale(press.locale.as_deref()).await;
        let (method, path, body) = outcome_call(&press, locale, outcome);
        let url = format!(
            "{API_BASE}/webhooks/{}/{}{path}",
            press.application_id, press.interaction_token
        );
        if let Err(error) = self.interaction_call(method, url, &body).await {
            warn!(%error, "discord approval press result could not be shown");
        }
    }
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
