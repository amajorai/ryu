//! The bot identity and group-reply gate, the Telegram Bot API response shapes
//! (only the fields the adapter reads) and the reaction-emoji mapping.

use super::*;

/// The bot's own identity, resolved once via `getMe`. Used to recognise when a
/// group message addresses the bot (`@username` mention or a reply to the bot),
/// and to log the two bot-level feature flags at startup.
#[derive(Debug, Clone, Default)]
pub(super) struct BotIdentity {
    pub(super) id: i64,
    pub(super) username: Option<String>,
    /// Bot-level flag: forum topic mode is enabled in the bot's private chats.
    /// NOT per-chat, despite how it reads.
    pub(super) has_topics_enabled: bool,
    /// Bot-level flag: `Update.guest_message` can arrive for this bot.
    pub(super) supports_guest_queries: bool,
}

/// Decide whether — and in what form — to route an inbound Telegram message to
/// Core. Direct/private chats always reply with the raw text. Group chats are
/// gated by `mode`: in `Mentions` the bot only answers when @mentioned, replied
/// to, or addressed by a `/command`; in `All` it answers every message. For
/// group replies the bot's `@mention` is stripped and the speaker's name is
/// prefixed so Core can tell who is talking in a multi-person chat.
///
/// The speaker prefix is kept even though [`InboundMessage::author_name`] now
/// carries the same fact: the author field is only read on the Core session path,
/// while the legacy gateway-pipeline path flattens the turn to a single user
/// message and would otherwise lose attribution entirely.
///
/// Returns the text to route, or `None` to ignore the message.
#[cfg(test)]
pub(super) fn decide_reply(
    message: &Message,
    raw_text: &str,
    me: &BotIdentity,
    mode: GroupReplyMode,
) -> Option<String> {
    decide_reply_with_options(
        message,
        raw_text,
        me,
        mode,
        &crate::TelegramChannelOptions::default(),
    )
}

pub(super) fn decide_reply_with_options(
    message: &Message,
    raw_text: &str,
    me: &BotIdentity,
    mode: GroupReplyMode,
    options: &crate::TelegramChannelOptions,
) -> Option<String> {
    if !is_group_chat(&message.chat.chat_type) {
        // Private chat (or channel post): always answer with the raw text. Empty
        // text is legitimate here — a voice note's transcript arrives later, in
        // `ingest_media`, before the shared path checks for usable text.
        return Some(raw_text.to_string());
    }

    let mention = me.username.as_ref().map(|u| format!("@{u}"));
    let mentions_bot = mention
        .as_ref()
        .is_some_and(|m| raw_text.to_lowercase().contains(&m.to_lowercase()));
    let replies_to_bot = message
        .reply_to_message
        .as_deref()
        .and_then(|reply| reply.from.as_ref())
        .is_some_and(|from| from.id == me.id && me.id != 0);
    // `commands::parse_command` rather than a bare `starts_with('/')` so
    // `/help@ryubot` — what a Telegram client actually sends in a group — and a
    // lone `/` are classified the same way everywhere in the codebase.
    let is_command = commands::parse_command(raw_text).is_some();

    let pattern_match = options.mention_patterns.iter().any(|pattern| {
        let pattern = pattern.trim().to_ascii_lowercase();
        !pattern.is_empty() && raw_text.to_ascii_lowercase().contains(&pattern)
    });
    let addressed = if options.exclusive_bot_mentions {
        mentions_bot || replies_to_bot || is_command
    } else {
        mentions_bot || replies_to_bot || is_command || pattern_match
    };
    if mode == GroupReplyMode::Mentions && !addressed {
        return None;
    }

    // Strip the bot's @mention so the agent sees a clean prompt.
    let stripped = match &mention {
        Some(m) => raw_text.split(m.as_str()).collect::<Vec<_>>().join(""),
        None => raw_text.to_string(),
    };
    let stripped = stripped.trim();
    if stripped.is_empty() {
        // Empty after stripping is not necessarily empty of content: a bare
        // "@ryubot" over a photo, or any media-only message in an `All`-mode
        // group, is a real turn. Route it with no text and let `handle_turn`'s
        // annotation make the attachment the prompt; `author_name` still carries
        // the speaker. With nothing attached there is genuinely nothing to say.
        return has_media(message).then(String::new);
    }

    // Prefix the speaker so Core can attribute turns in a multi-person chat.
    match message.from.as_ref() {
        Some(from) if !from.first_name.is_empty() => {
            Some(format!("{}: {stripped}", from.first_name))
        }
        _ => Some(stripped.to_string()),
    }
}

// ─── Telegram Bot API response types (only the fields we use) ──────────────────
//
// Every field is `#[serde(default)]`: Telegram omits absent fields entirely, so a
// missing `voice` or `message_thread_id` must parse as "not present", never as a
// deserialization error that drops the whole update batch.

/// The envelope every Bot API method answers with. `ok: false` arrives with HTTP
/// 200, which is why this is parsed rather than trusting the status code.
#[derive(Debug, Deserialize)]
pub(super) struct ApiEnvelope {
    pub(super) ok: bool,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(default)]
    pub(super) result: Option<Value>,
    /// Telegram's numeric reason when `ok` is false; `429` is flood control.
    #[serde(default)]
    pub(super) error_code: Option<i64>,
    /// Extra detail on a failed call, such as the flood-control wait.
    #[serde(default)]
    pub(super) parameters: Option<ResponseParameters>,
}

/// `ResponseParameters` from a failed Bot API call (only the fields we use).
#[derive(Debug, Default, Deserialize)]
pub(super) struct ResponseParameters {
    /// Seconds to wait before repeating a call that hit flood control.
    #[serde(default)]
    pub(super) retry_after: Option<u64>,
}

#[derive(Debug, Deserialize)]
pub(super) struct GetUpdatesResponse {
    pub(super) ok: bool,
    /// Telegram's numeric reason when `ok` is false. Only `401` is acted on (a
    /// revoked or replaced token), but it is read here rather than at the call
    /// site because an `ok: false` poll arrives with HTTP 200 and is otherwise
    /// indistinguishable from a transient failure.
    #[serde(default)]
    pub(super) error_code: Option<i64>,
    #[serde(default)]
    pub(super) result: Vec<Update>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct BotUser {
    pub(super) id: i64,
    #[serde(default)]
    pub(super) username: Option<String>,
    /// The bot has forum topic mode enabled in private chats.
    #[serde(default)]
    pub(super) has_topics_enabled: bool,
    /// The bot can receive `Update.guest_message`.
    #[serde(default)]
    pub(super) supports_guest_queries: bool,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct Update {
    pub(super) update_id: i64,
    #[serde(default)]
    pub(super) message: Option<Message>,
    /// A message from someone who is not in a chat with the bot. Answered with
    /// `answerGuestQuery`, keyed on `Message.guest_query_id`.
    #[serde(default)]
    pub(super) guest_message: Option<Message>,
    /// Reaction added/removed by a user on a bot message. Enabled explicitly by
    /// the reaction-learning config and only linked after an outbound reply id
    /// has been confirmed.
    #[serde(default)]
    pub(super) message_reaction: Option<MessageReactionUpdated>,
    /// Callback button selected from an inline keyboard.
    #[serde(default)]
    pub(super) callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct CallbackQuery {
    pub(super) id: String,
    pub(super) from: TgUser,
    #[serde(default)]
    pub(super) message: Option<Message>,
    #[serde(default)]
    pub(super) data: Option<String>,
}

#[derive(Debug, Default, Deserialize, Clone)]
pub(super) struct MessageReactionUpdated {
    pub(super) chat: Chat,
    #[serde(default)]
    pub(super) message_id: i64,
    #[serde(default)]
    pub(super) user: Option<TgUser>,
    #[serde(default)]
    pub(super) new_reaction: Vec<TelegramReaction>,
    #[serde(default)]
    pub(super) message_thread_id: Option<i64>,
}

#[derive(Debug, Default, Deserialize, Clone)]
pub(super) struct TelegramReaction {
    #[serde(default)]
    pub(super) emoji: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct Message {
    pub(super) chat: Chat,
    #[serde(default)]
    pub(super) message_id: i64,
    #[serde(default)]
    pub(super) text: Option<String>,
    /// Caption on a media message — the user's words when they attach a photo.
    #[serde(default)]
    pub(super) caption: Option<String>,
    /// Sender of the message. Used for the speaker prefix in group chats.
    #[serde(default)]
    pub(super) from: Option<TgUser>,
    /// The message this one replies to, if any. Boxed because it is the same
    /// `Message` type (self-referential) and would otherwise be infinitely sized.
    #[serde(default)]
    pub(super) reply_to_message: Option<Box<Message>>,
    /// Forum topic (or private-chat topic) this message belongs to.
    #[serde(default)]
    pub(super) message_thread_id: Option<i64>,
    /// The callback's source keyboard lets us recover a button label when it
    /// was omitted from compact callback data to stay within Telegram's limit.
    #[serde(default)]
    pub(super) reply_markup: Option<Value>,
    /// Direct-messages topic, a DIFFERENT parameter from `message_thread_id`.
    #[serde(default)]
    pub(super) direct_messages_topic: Option<DirectMessagesTopic>,
    /// Present only on `Update.guest_message`; the handle for `answerGuestQuery`.
    #[serde(default)]
    pub(super) guest_query_id: Option<String>,
    #[serde(default)]
    pub(super) voice: Option<TgFile>,
    #[serde(default)]
    pub(super) audio: Option<TgFile>,
    /// Size ladder for a photo, smallest first.
    #[serde(default)]
    pub(super) photo: Vec<TgFile>,
    #[serde(default)]
    pub(super) video: Option<TgFile>,
    #[serde(default)]
    pub(super) document: Option<TgFile>,
}

#[derive(Debug, Default, Deserialize, Clone)]
pub(super) struct Chat {
    pub(super) id: i64,
    /// `private`, `group`, `supergroup`, or `channel`. Absent → treated as
    /// non-group (private) so the bot still replies.
    #[serde(rename = "type", default)]
    pub(super) chat_type: String,
}

#[derive(Debug, Default, Deserialize)]
pub(super) struct DirectMessagesTopic {
    #[serde(default)]
    pub(super) topic_id: i64,
}

#[derive(Debug, Default, Deserialize, Clone)]
pub(super) struct TgUser {
    pub(super) id: i64,
    #[serde(default)]
    pub(super) first_name: String,
    /// IETF tag of the user's Telegram app language, when Telegram shares it.
    #[serde(default)]
    pub(super) language_code: Option<String>,
}

/// The shape every Telegram media object shares. `PhotoSize` has no `mime_type`
/// or `file_name`, which the defaults cover.
#[derive(Debug, Default, Deserialize)]
pub(super) struct TgFile {
    pub(super) file_id: String,
    #[serde(default)]
    pub(super) mime_type: Option<String>,
    #[serde(default)]
    pub(super) file_name: Option<String>,
    #[serde(default)]
    pub(super) file_size: Option<u64>,
}

/// Emoji a Telegram bot may react with (`ReactionTypeEmoji`), written without
/// variation selectors. Anything else is refused by `setMessageReaction`.
pub(super) const TELEGRAM_BOT_REACTIONS: &[&str] = &[
    "👍",
    "👎",
    "❤",
    "🔥",
    "🥰",
    "👏",
    "😁",
    "🤔",
    "🤯",
    "😱",
    "🤬",
    "😢",
    "🎉",
    "🤩",
    "🤮",
    "💩",
    "🙏",
    "👌",
    "🕊",
    "🤡",
    "🥱",
    "🥴",
    "😍",
    "🐳",
    "❤\u{200d}🔥",
    "🌚",
    "🌭",
    "💯",
    "🤣",
    "⚡",
    "🍌",
    "🏆",
    "💔",
    "🤨",
    "😐",
    "🍓",
    "🍾",
    "💋",
    "🖕",
    "😈",
    "😴",
    "😭",
    "🤓",
    "👻",
    "👨\u{200d}💻",
    "👀",
    "🎃",
    "🙈",
    "😇",
    "😨",
    "🤝",
    "✍",
    "🤗",
    "🫡",
    "🎅",
    "🎄",
    "☃",
    "💅",
    "🤪",
    "🗿",
    "🆒",
    "💘",
    "🙉",
    "🦄",
    "😘",
    "💊",
    "🙊",
    "😎",
    "👾",
    "🤷\u{200d}♂",
    "🤷",
    "🤷\u{200d}♀",
    "😡",
];

/// The Telegram bot reaction for `emoji`: the emoji itself when Telegram allows
/// it, the nearest allowed one for common emoji it does not, otherwise `None`.
pub(super) fn telegram_reaction(emoji: &str) -> Option<&'static str> {
    let bare: String = emoji.trim().chars().filter(|c| *c != '\u{fe0f}').collect();
    if let Some(allowed) = TELEGRAM_BOT_REACTIONS
        .iter()
        .find(|allowed| **allowed == bare)
    {
        return Some(allowed);
    }
    let nearest = match bare.as_str() {
        "✅" | "☑" | "✔" | "🆗" => "👌",
        "❌" | "✖" | "🚫" => "👎",
        "😂" | "😆" | "😹" => "🤣",
        "😄" | "😃" | "😀" | "😊" | "🙂" | "😸" => "😁",
        "😮" | "😲" | "😯" => "😱",
        "💖" | "💗" | "💕" | "♥" | "🧡" | "💛" | "💚" | "💙" | "💜" | "🫶" => {
            "❤"
        }
        "🥳" | "🎊" => "🎉",
        "🙌" => "👏",
        "🥲" | "😥" | "😞" | "😔" => "😢",
        "🤞" | "🫂" => "🤗",
        "💪" | "🚀" => "🔥",
        "👋" => "🫡",
        _ => return None,
    };
    TELEGRAM_BOT_REACTIONS
        .iter()
        .find(|allowed| **allowed == nearest)
        .copied()
}
