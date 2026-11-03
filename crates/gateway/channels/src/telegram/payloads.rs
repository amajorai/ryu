//! Pure message helpers: thread tags, the Bot API payload builders, guest-mode
//! turns and the attachment list of an inbound message.

use super::*;

mod guest_locale;
#[cfg(test)]
mod tests;

/// The thread tag for a message, if it arrived inside one.
///
/// A direct-messages topic and a forum topic are DIFFERENT API parameters, so
/// the tag records which one it is: `d<id>` for `direct_messages_topic_id`,
/// `t<id>` for `message_thread_id`. The DM topic wins when both are present
/// because it is the more specific of the two.
pub(super) fn thread_of(message: &Message) -> Option<String> {
    if let Some(topic) = message.direct_messages_topic.as_ref() {
        return Some(format!("{DM_TOPIC_TAG}{}", topic.topic_id));
    }
    message
        .message_thread_id
        .map(|id| format!("{TOPIC_TAG}{id}"))
}

pub(super) fn callback_button_label(message: &Message, callback_data: &str) -> Option<String> {
    message
        .reply_markup
        .as_ref()?
        .get("inline_keyboard")?
        .as_array()?
        .iter()
        .filter_map(Value::as_array)
        .flatten()
        .find(|button| button.get("callback_data").and_then(Value::as_str) == Some(callback_data))
        .and_then(|button| button.get("text"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Decode a thread tag into `(message_thread_id, direct_messages_topic_id)`.
/// An unrecognised or malformed tag yields neither, so a key written by an older
/// build degrades to "reply in the room" instead of failing the send.
pub(super) fn thread_params(thread: Option<&str>) -> (Option<i64>, Option<i64>) {
    let Some(thread) = thread else {
        return (None, None);
    };
    if let Some(id) = thread.strip_prefix(TOPIC_TAG) {
        return (id.parse().ok(), None);
    }
    if let Some(id) = thread.strip_prefix(DM_TOPIC_TAG) {
        return (None, id.parse().ok());
    }
    (None, None)
}

/// Add whichever topic parameter the thread tag encodes.
pub(super) fn insert_thread(obj: &mut Map<String, Value>, thread: Option<&str>) {
    let (topic, dm_topic) = thread_params(thread);
    if let Some(topic) = topic {
        obj.insert("message_thread_id".to_string(), json!(topic));
    }
    if let Some(dm_topic) = dm_topic {
        obj.insert("direct_messages_topic_id".to_string(), json!(dm_topic));
    }
}

/// `sendMessage` payload.
pub(super) fn message_payload(chat: i64, thread: Option<&str>, text: &str) -> Value {
    let mut obj = Map::new();
    obj.insert("chat_id".to_string(), json!(chat));
    obj.insert("text".to_string(), json!(text));
    insert_thread(&mut obj, thread);
    Value::Object(obj)
}

/// `sendMessage` payload with validated Telegram-native buttons.
pub(super) fn interactive_payload(
    chat: i64,
    thread: Option<&str>,
    text: &str,
    markup: &InteractiveMarkup,
) -> anyhow::Result<Value> {
    markup.validate().map_err(anyhow::Error::msg)?;
    if text.trim().is_empty() || text.chars().count() > 4096 {
        anyhow::bail!("an interactive Telegram message must contain 1..=4096 characters");
    }

    let rows = markup
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|button| match (&markup.layout, &button.action) {
                    (InteractiveLayout::ReplyKeyboard, InteractiveAction::Reply) => {
                        Ok(json!({ "text": button.label }))
                    }
                    (
                        InteractiveLayout::Inline,
                        InteractiveAction::Callback { action_id, payload },
                    ) => {
                        let callback_data =
                            encode_callback_data(&ryu_channel_contracts::ChannelActionEvent {
                                action_id: action_id.clone(),
                                label: button.label.clone(),
                                payload: payload.clone(),
                            })
                            .map_err(anyhow::Error::msg)?;
                        Ok(json!({ "text": button.label, "callback_data": callback_data }))
                    }
                    (InteractiveLayout::Inline, InteractiveAction::OpenUrl { url }) => {
                        Ok(json!({ "text": button.label, "url": url }))
                    }
                    _ => anyhow::bail!("button action does not match interactive layout"),
                })
                .collect::<anyhow::Result<Vec<_>>>()
        })
        .collect::<anyhow::Result<Vec<_>>>()?;

    let mut payload = message_payload(chat, thread, text);
    let object = payload
        .as_object_mut()
        .expect("message_payload always returns a JSON object");
    let reply_markup = match markup.layout {
        InteractiveLayout::ReplyKeyboard => json!({
            "keyboard": rows,
            "resize_keyboard": true,
            "one_time_keyboard": true,
        }),
        InteractiveLayout::Inline => json!({ "inline_keyboard": rows }),
    };
    object.insert("reply_markup".to_owned(), reply_markup);
    Ok(payload)
}

/// `sendRichMessage` payload. `InputRichMessage` takes EXACTLY ONE of
/// `html` / `markdown` / `blocks`; agent output is markdown already.
pub(super) fn rich_payload(chat: i64, thread: Option<&str>, markdown: &str) -> Value {
    let mut obj = Map::new();
    obj.insert("chat_id".to_string(), json!(chat));
    obj.insert("rich_message".to_string(), json!({ "markdown": markdown }));
    insert_thread(&mut obj, thread);
    Value::Object(obj)
}

/// `sendChatAction` payload.
pub(super) fn action_payload(chat: i64, thread: Option<&str>, action: &str) -> Value {
    let mut obj = Map::new();
    obj.insert("chat_id".to_string(), json!(chat));
    obj.insert("action".to_string(), json!(action));
    insert_thread(&mut obj, thread);
    Value::Object(obj)
}

/// Pick the draft method and build its payload.
///
/// An EMPTY partial is always sent through `sendMessageDraft`: the documented
/// behaviour of an empty `text` is Telegram's own "Thinking…" placeholder, and
/// `sendRichMessageDraft` has no equivalent (its `rich_message` is required and
/// an empty markdown body is not a placeholder, just an empty message).
pub(super) fn draft_payload(
    chat: i64,
    thread: Option<&str>,
    draft_id: i64,
    partial: &str,
    rich: bool,
) -> (&'static str, Value) {
    let mut obj = Map::new();
    obj.insert("chat_id".to_string(), json!(chat));
    obj.insert("draft_id".to_string(), json!(draft_id));
    insert_thread(&mut obj, thread);
    if rich && !partial.is_empty() {
        obj.insert("rich_message".to_string(), json!({ "markdown": partial }));
        ("sendRichMessageDraft", Value::Object(obj))
    } else {
        obj.insert("text".to_string(), json!(partial));
        ("sendMessageDraft", Value::Object(obj))
    }
}

/// `setMyCommands` payload. `BotCommand.command` is already normalised to
/// Telegram's rule by [`commands::normalize`], so no re-checking here.
pub(super) fn commands_payload(cmds: &[ChannelCommand]) -> Value {
    json!({
        "commands": cmds
            .iter()
            .map(|c| json!({ "command": c.name, "description": c.description }))
            .collect::<Vec<_>>(),
    })
}

/// One `setMyCommands` payload per catalog language, each with its Telegram
/// `language_code` (`pt-BR` is `pt`, `zh-CN` is `zh`). Telegram shows a user the
/// menu for their app language and the default one otherwise.
pub(super) fn localized_commands_payloads(cmds: &[ChannelCommand]) -> Vec<(String, Value)> {
    crate::i18n::commands::telegram_menus(cmds)
        .into_iter()
        .map(|(language_code, menu)| {
            let mut payload = commands_payload(&menu);
            payload["language_code"] = json!(language_code);
            (language_code, payload)
        })
        .collect()
}

/// `answerGuestQuery` payload: one `InlineQueryResultArticle` carrying the reply.
///
/// The result `id` is a short constant rather than the query id — it only has to
/// be unique within this answer, and `InlineQueryResult.id` is capped at 64 bytes.
///
/// The title is in the guest's Telegram app language, which [`guest_inbound`]
/// recorded for this query (English when Telegram reported none).
pub(super) fn guest_reply_payload(query_id: &str, text: &str) -> Value {
    let language = guest_locale::take(query_id).unwrap_or_default();
    let title = crate::i18n::render(
        &language,
        crate::i18n::messages::TELEGRAM_GUEST_REPLY_TITLE_MESSAGE,
        &[],
    );
    json!({
        "guest_query_id": query_id,
        "result": {
            "type": "article",
            "id": "reply",
            "title": title,
            "input_message_content": { "message_text": text },
        },
    })
}

/// Build the inbound turn for a guest message.
///
/// The CONVERSATION is keyed on the guest query id, not the chat id: the docs
/// warn a guest chat id "may not coincide with other existing bot chats sharing
/// the same identifier", so reusing it could splice a stranger's turn into an
/// unrelated conversation's history. A guest query id is per-query, so each guest
/// exchange is its own single-turn conversation — which is what a guest query is.
///
/// The PAIRING IDENTITY is the sender's user id instead, and the distinction is
/// load-bearing: identity is what the access gate remembers. Keyed on the query
/// id, every guest message would present as a new stranger, mint a new pairing
/// code, and be approved into an identity that can never recur — guest mode
/// would be a pairing-prompt generator. With `from.id` an approval sticks. When
/// the sender is unknown, `identity()` falls back to the conversation key, which
/// is the closed-by-default behaviour anyway.
pub(super) fn guest_inbound(message: &Message) -> Option<InboundMessage> {
    let query_id = message.guest_query_id.as_deref()?;
    let key = format!("{GUEST_KEY_PREFIX}{query_id}");
    if let Some(language) = sender_locale(message) {
        guest_locale::remember(query_id, &language);
    }
    let text = message
        .text
        .clone()
        .or_else(|| message.caption.clone())
        .unwrap_or_default();
    Some(InboundMessage {
        chat_id: key,
        access_chat_id: None,
        text,
        author_name: message
            .from
            .as_ref()
            .map(|from| from.first_name.clone())
            .filter(|name| !name.is_empty()),
        sender_id: message.from.as_ref().map(|from| from.id.to_string()),
        // No message id: a guest message cannot be reacted to or replied to in
        // place; the answer goes back through `answerGuestQuery`.
        message_id: None,
        is_group: false,
        attachments: attachments_from(message),
        channel_action: None,
        locale: sender_locale(message),
    })
}

/// The sender's Telegram app language, for the bridge's own replies.
pub(super) fn sender_locale(message: &Message) -> Option<String> {
    message
        .from
        .as_ref()
        .and_then(|from| from.language_code.clone())
}

/// Did the user attach anything? Cheaper than building the [`Attachment`] list
/// when only the yes/no answer is needed, and used by the group gate to tell a
/// media-only message apart from an empty one.
pub(super) fn has_media(message: &Message) -> bool {
    message.voice.is_some()
        || message.audio.is_some()
        || !message.photo.is_empty()
        || message.video.is_some()
        || message.document.is_some()
}

/// Normalise a Telegram message's media into [`Attachment`]s.
///
/// Only the `file_id` is carried; resolving it to a URL is a second API call
/// (`getFile`) that [`TelegramChannel::download_speech`] makes on demand. For a
/// photo the LARGEST size is taken — Telegram returns the ladder smallest-first.
pub(super) fn attachments_from(message: &Message) -> Vec<Attachment> {
    let mut out = Vec::new();
    let mut push = |file: &TgFile, kind: AttachmentKind| {
        out.push(Attachment {
            kind: Some(kind),
            url: None,
            file_id: Some(file.file_id.clone()),
            mime: file.mime_type.clone(),
            filename: file.file_name.clone(),
            size: file.file_size,
        });
    };
    if let Some(voice) = message.voice.as_ref() {
        push(voice, AttachmentKind::Voice);
    }
    if let Some(audio) = message.audio.as_ref() {
        push(audio, AttachmentKind::Audio);
    }
    if let Some(photo) = message.photo.last() {
        push(photo, AttachmentKind::Image);
    }
    if let Some(video) = message.video.as_ref() {
        push(video, AttachmentKind::Video);
    }
    if let Some(document) = message.document.as_ref() {
        // A document carries its own MIME, so let `resolved_kind` classify it —
        // "document" on Telegram covers an uncompressed image just as often as
        // it covers a PDF.
        out.push(Attachment {
            kind: None,
            url: None,
            file_id: Some(document.file_id.clone()),
            mime: document.mime_type.clone(),
            filename: document.file_name.clone(),
            size: document.file_size,
        });
    }
    out
}
