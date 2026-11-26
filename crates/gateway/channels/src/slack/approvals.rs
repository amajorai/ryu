//! Approve and Deny buttons for a waiting tool approval, on Slack.
//!
//! The prompt is one `chat.postMessage` with a plain-text section and an
//! actions block. Each button's `value` is [`shared::encode_press`]. Agent,
//! tool and summary text is escaped and sent as `plain_text`, so nothing an
//! agent wrote is read as a link, a mention or formatting.
//!
//! A press arrives as an `interactive` envelope with a `block_actions`
//! payload on the Socket Mode connection this bot opened with its app token.
//! That connection is the delivery proof: Socket Mode has no per-request
//! signature (the signing secret belongs to the HTTP endpoints, which this
//! adapter does not serve). The presser is `payload.user.id`, which Slack
//! sets. Nothing in the button value names a person, a channel or an approval.
//!
//! A press that settles the approval rewrites the prompt to its final state
//! with `chat.update`, which removes the buttons. A press that changes
//! nothing answers only the presser, with `chat.postEphemeral`.

use super::*;
use crate::approvals::{self as shared, ApprovalPress, ApprovalPrompt, FinalState, PressOutcome};

/// `action_id` of the Approve button.
pub(super) const APPROVE_ACTION_ID: &str = "ryu_approval_approve";
/// `action_id` of the Deny button.
pub(super) const DENY_ACTION_ID: &str = "ryu_approval_deny";

/// Longest text of one Slack section block.
const SECTION_MAX_CHARS: usize = 3000;

/// One approval button press, read from a `block_actions` payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SlackPress {
    pub(super) token: String,
    pub(super) approve: bool,
    /// The Slack user who pressed, as Slack reported it.
    pub(super) user: String,
    pub(super) channel: String,
    /// `ts` of the prompt message the button is on.
    pub(super) message_ts: String,
    /// The thread the prompt message is in, when it is in one.
    pub(super) thread_ts: Option<String>,
    /// The prompt's fallback text as Slack returned it.
    pub(super) shown: String,
}

/// Read an approval press out of a Socket Mode frame. `None` for every other
/// frame, and for a press that lacks who pressed or where.
pub(super) fn parse_press(raw: &str) -> Option<SlackPress> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if value["type"].as_str() != Some("interactive") {
        return None;
    }
    let payload = &value["payload"];
    if payload["type"].as_str() != Some("block_actions") {
        return None;
    }
    let action = payload["actions"].as_array()?.first()?;
    let (token, approve) = shared::decode_press(action["value"].as_str()?)?;
    // The button and its value must agree; anything else was not built here.
    let expected = if approve {
        APPROVE_ACTION_ID
    } else {
        DENY_ACTION_ID
    };
    if action["action_id"].as_str() != Some(expected) {
        return None;
    }
    let text_of = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let user = text_of(&payload["user"]["id"])?;
    let channel = text_of(&payload["container"]["channel_id"])
        .or_else(|| text_of(&payload["channel"]["id"]))?;
    let message_ts = text_of(&payload["container"]["message_ts"])
        .or_else(|| text_of(&payload["message"]["ts"]))?;
    let thread_ts = text_of(&payload["container"]["thread_ts"])
        .or_else(|| text_of(&payload["message"]["thread_ts"]));
    Some(SlackPress {
        token,
        approve,
        user,
        channel,
        message_ts,
        thread_ts,
        shown: payload["message"]["text"]
            .as_str()
            .unwrap_or_default()
            .to_owned(),
    })
}

/// The packed conversation key of the turn that posted the prompt: the
/// channel plus the thread when replies are threaded, the same key
/// [`conversation_key`] gave the turn.
pub(super) fn press_chat_id(press: &SlackPress, reply_in_thread: bool) -> String {
    if reply_in_thread {
        pack_thread(&press.channel, press.thread_ts.as_deref())
    } else {
        press.channel.clone()
    }
}

fn plain_section(text: &str) -> Value {
    json!({
        "type": "section",
        "text": { "type": "plain_text", "text": text, "emoji": false },
    })
}

fn button(label: &str, action_id: &str, value: &str, style: &str) -> Value {
    json!({
        "type": "button",
        "style": style,
        "text": { "type": "plain_text", "text": label, "emoji": false },
        "action_id": action_id,
        "value": value,
    })
}

/// `chat.postMessage` payload for one prompt, or `None` for a token Core
/// would never issue.
pub(super) fn prompt_payload(
    chat_id: &str,
    reply_in_thread: bool,
    prompt: &ApprovalPrompt,
    locale: &str,
) -> Option<Value> {
    let approve = shared::encode_press(&prompt.token, true)?;
    let deny = shared::encode_press(&prompt.token, false)?;
    let (approve_label, deny_label) = shared::button_labels(locale);
    let text = shared::escape_slack(&shared::prompt_text(locale, prompt));
    let (channel, thread_ts) = unpack_thread(chat_id);
    let mut payload = json!({
        "channel": channel,
        "text": text,
        "mrkdwn": false,
        "unfurl_links": false,
        "unfurl_media": false,
        "blocks": [
            plain_section(&text),
            {
                "type": "actions",
                "elements": [
                    button(&approve_label, APPROVE_ACTION_ID, &approve, "primary"),
                    button(&deny_label, DENY_ACTION_ID, &deny, "danger"),
                ],
            },
        ],
    });
    if reply_in_thread {
        if let Some(ts) = thread_ts {
            payload["thread_ts"] = json!(ts);
        }
    }
    Some(payload)
}

/// Slack returns message text with its three control characters still
/// escaped. Undo that once, so escaping again never doubles it.
fn unescape_slack(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// `chat.update` payload that writes the final state under the prompt and
/// leaves no actions block, so the buttons are gone.
pub(super) fn final_payload(press: &SlackPress, locale: &str, state: FinalState) -> Value {
    let body = shared::clip(
        &shared::escape_slack(&unescape_slack(press.shown.trim())),
        SECTION_MAX_CHARS,
    );
    let verdict = shared::escape_slack(&shared::final_text(locale, state));
    let mut blocks = Vec::new();
    if !body.is_empty() {
        blocks.push(plain_section(&body));
    }
    blocks.push(plain_section(&verdict));
    let text = if body.is_empty() {
        verdict
    } else {
        format!("{body}\n{verdict}")
    };
    json!({
        "channel": press.channel,
        "ts": press.message_ts,
        "text": text,
        "blocks": blocks,
    })
}

/// `chat.postEphemeral` payload: a notice only the presser sees.
pub(super) fn notice_payload(press: &SlackPress, text: &str) -> Value {
    let mut payload = json!({
        "channel": press.channel,
        "user": press.user,
        "text": shared::escape_slack(text),
    });
    if let Some(thread_ts) = press.thread_ts.as_deref() {
        payload["thread_ts"] = json!(thread_ts);
    }
    payload
}

/// The Web API call that shows `outcome` to the people in the channel (a
/// settled approval) or only to the presser (a press that changed nothing).
pub(super) fn outcome_call(
    press: &SlackPress,
    locale: &str,
    outcome: PressOutcome,
) -> (&'static str, Value) {
    match outcome {
        PressOutcome::Final(state) => ("chat.update", final_payload(press, locale, state)),
        PressOutcome::Notice(notice) => (
            "chat.postEphemeral",
            notice_payload(press, &shared::notice_text(locale, notice)),
        ),
    }
}

impl SlackChannel {
    async fn approval_api(&self, method: &str, payload: &Value) -> anyhow::Result<()> {
        let body: ApiAck = self
            .http()
            .post(format!("{SLACK_API_BASE}/{method}"))
            .bearer_auth(&self.bot_token)
            .json(payload)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?
            .json()
            .await
            .map_err(reqwest::Error::without_url)?;
        body.into_result(method)
    }

    /// Post one approval prompt. `Ok(false)` for a token Core would never issue.
    pub(super) async fn post_approval_prompt(
        &self,
        chat_id: &str,
        prompt: &ApprovalPrompt,
        locale: &str,
    ) -> anyhow::Result<bool> {
        let Some(payload) = prompt_payload(chat_id, self.options.reply_in_thread, prompt, locale)
        else {
            return Ok(false);
        };
        self.approval_api("chat.postMessage", &payload).await?;
        Ok(true)
    }

    /// Decide one press. The presser is the user Slack named in the payload,
    /// and the conversation is the one the prompt message sits in.
    pub(super) async fn decide_approval_press(&self, press: &SlackPress) -> PressOutcome {
        let shared_press = ApprovalPress {
            token: press.token.clone(),
            approve: press.approve,
            chat_id: press_chat_id(press, self.options.reply_in_thread),
            sender_id: press.user.clone(),
            // Slack reports no language for the presser.
            locale: None,
        };
        shared::decide_press(self, &shared_press).await
    }

    /// Decide one approval button press and show the result.
    pub(super) async fn handle_approval_press(&self, press: SlackPress) {
        let outcome = self.decide_approval_press(&press).await;
        let locale = self.runtime.reply_locale(None).await;
        let (method, payload) = outcome_call(&press, locale, outcome);
        if let Err(error) = self.approval_api(method, &payload).await {
            warn!(%error, method, "slack approval press result could not be shown");
        }
    }
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
