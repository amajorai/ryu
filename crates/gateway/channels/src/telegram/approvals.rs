//! Approve and Deny buttons for a waiting tool approval, on Telegram.
//!
//! The prompt is one `sendMessage` in HTML parse mode with an inline keyboard
//! whose callback data is [`approvals::encode_press`]. Agent, tool and summary
//! text is escaped and link previews are off, so nothing an agent wrote is
//! read as markup or fetched.
//!
//! A press arrives as a `callback_query` on a delivery Telegram proved: the
//! long poll made with the bot token, or a webhook request that carried the
//! secret token ([`webhook_secret_matches`], checked before the update is
//! queued). The presser is `callback_query.from.id`, which Telegram sets.
//! Nothing in the callback data names a person, a chat or an approval.
//!
//! A press that settles the approval rewrites the prompt to its final state
//! and removes the keyboard. A press that changes nothing answers only the
//! presser, through the callback acknowledgement.

use super::*;
use crate::approvals::{self, ApprovalPress, ApprovalPrompt, FinalState, Notice, PressOutcome};

/// Longest text Telegram shows in a callback acknowledgement.
const ACK_MAX_CHARS: usize = 200;

/// `sendMessage` payload for one prompt, or `None` for a token Core would
/// never issue.
pub(super) fn prompt_payload(
    chat: i64,
    thread: Option<&str>,
    prompt: &ApprovalPrompt,
    locale: &str,
) -> Option<Value> {
    let approve = approvals::encode_press(&prompt.token, true)?;
    let deny = approvals::encode_press(&prompt.token, false)?;
    let (approve_label, deny_label) = approvals::button_labels(locale);
    let text = approvals::escape_telegram_html(&approvals::prompt_text(locale, prompt));
    let mut payload = message_payload(chat, thread, &text);
    let object = payload.as_object_mut()?;
    object.insert("parse_mode".to_owned(), json!("HTML"));
    object.insert(
        "link_preview_options".to_owned(),
        json!({ "is_disabled": true }),
    );
    object.insert(
        "reply_markup".to_owned(),
        json!({ "inline_keyboard": [[
            { "text": approve_label, "callback_data": approve },
            { "text": deny_label, "callback_data": deny },
        ]] }),
    );
    Some(payload)
}

/// `editMessageText` payload that writes the final state under the prompt
/// and removes its buttons. `shown` is the prompt as Telegram returned it.
pub(super) fn final_payload(
    chat: i64,
    message_id: i64,
    shown: &str,
    locale: &str,
    state: FinalState,
) -> Value {
    let body = approvals::escape_telegram_html(shown.trim());
    let verdict = approvals::escape_telegram_html(&approvals::final_text(locale, state));
    let text = if body.is_empty() {
        format!("<b>{verdict}</b>")
    } else {
        format!("{body}\n\n<b>{verdict}</b>")
    };
    json!({
        "chat_id": chat,
        "message_id": message_id,
        "text": text,
        "parse_mode": "HTML",
        "link_preview_options": { "is_disabled": true },
        "reply_markup": { "inline_keyboard": [] },
    })
}

/// `answerCallbackQuery` payload. A refusal is an alert only the presser sees.
pub(super) fn ack_payload(callback_id: &str, text: &str, alert: bool) -> Value {
    json!({
        "callback_query_id": callback_id,
        "text": approvals::clip(text, ACK_MAX_CHARS),
        "show_alert": alert,
    })
}

impl TelegramChannel {
    /// Post one approval prompt. `Ok(false)` for a guest query, which has no
    /// chat to put buttons in.
    pub(super) async fn post_approval_prompt(
        &self,
        chat_id: &str,
        prompt: &ApprovalPrompt,
        locale: &str,
    ) -> anyhow::Result<bool> {
        if guest_query_of(chat_id).is_some() {
            return Ok(false);
        }
        let (chat, thread) = target(chat_id)?;
        let Some(payload) = prompt_payload(chat, thread, prompt, locale) else {
            return Ok(false);
        };
        self.call("sendMessage", payload).await?;
        Ok(true)
    }

    /// Decide one approval button press and show the result. The presser is
    /// taken from the callback Telegram delivered, never from its data.
    pub(super) async fn handle_approval_press(
        &self,
        callback: CallbackQuery,
        token: String,
        approve: bool,
    ) {
        let locale = self
            .runtime
            .reply_locale(callback.from.language_code.as_deref())
            .await;
        let outcome = match callback.message.as_ref() {
            Some(message) => {
                let thread = thread_of(message);
                let press = ApprovalPress {
                    token,
                    approve,
                    chat_id: pack_thread(&message.chat.id.to_string(), thread.as_deref()),
                    sender_id: callback.from.id.to_string(),
                    locale: callback.from.language_code.clone(),
                };
                approvals::decide_press(self, &press).await
            }
            // Without its message a press cannot be tied to a conversation.
            None => PressOutcome::Notice(Notice::Unavailable),
        };
        let (text, alert) = match outcome {
            PressOutcome::Final(state) => {
                if let Some(message) = callback.message.as_ref() {
                    let payload = final_payload(
                        message.chat.id,
                        message.message_id,
                        message.text.as_deref().unwrap_or_default(),
                        locale,
                        state,
                    );
                    if let Err(error) = self.call("editMessageText", payload).await {
                        warn!(%error, "telegram approval prompt could not be updated");
                    }
                }
                (approvals::final_text(locale, state), false)
            }
            PressOutcome::Notice(notice) => (approvals::notice_text(locale, notice), true),
        };
        if let Err(error) = self
            .call(
                "answerCallbackQuery",
                ack_payload(&callback.id, &text, alert),
            )
            .await
        {
            debug!(%error, "telegram approval press acknowledgement failed");
        }
    }
}

#[cfg(test)]
#[path = "approvals_tests.rs"]
mod tests;
