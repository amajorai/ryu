//! Pure helpers around the Discord wire: conversation keys, message splitting,
//! thread names, payload builders, the group reply gate and the REST/Gateway
//! response shapes.

use super::*;

// ─── Pure helpers ───────────────────────────────────────────────────────────

/// The parent channel of `channel` when it is a thread, `None` otherwise.
///
/// A text channel's `parent_id` is its category, which must never become a
/// conversation scope: that would treat every categorized channel as a thread
/// (answering without a mention) and key its history to the category.
pub(super) fn thread_parent(channel: &DiscordChannelRef) -> Option<String> {
    let is_thread = channel
        .kind
        .is_some_and(|kind| THREAD_CHANNEL_TYPES.contains(&kind));
    channel
        .parent_id
        .clone()
        .filter(|parent| is_thread && !parent.is_empty())
}

/// Store a definitive parent lookup, clearing the per-connection cache first
/// when it is full so it stays bounded.
pub(super) fn remember_thread_parent(
    cache: &mut ThreadParents,
    channel_id: &str,
    parent: Option<String>,
) {
    if cache.len() >= THREAD_PARENT_CACHE_MAX && !cache.contains_key(channel_id) {
        cache.clear();
    }
    cache.insert(channel_id.to_owned(), parent);
}

/// Build the Core conversation key for a Discord inbound message.
///
/// Discord exposes a thread as its own channel id, while the shared packed key
/// is always `parent_channel:thread_channel`. Keeping the parent first means
/// outbound routing resolves the actual thread instead of posting back to the
/// parent channel.
pub(super) fn inbound_chat_id(channel_id: &str, parent_channel_id: Option<&str>) -> String {
    match parent_channel_id {
        Some(parent_channel_id) => pack_thread(parent_channel_id, Some(channel_id)),
        None => pack_thread(channel_id, None),
    }
}

/// The channel a conversation key addresses: the thread when the key carries one,
/// otherwise the room itself.
///
/// A Discord thread *is* a channel — messages, typing and reactions inside it all
/// post to the thread id — so every outbound verb resolves the key through here.
/// Snowflakes contain no colon, so [`unpack_thread`]'s split is unambiguous.
pub(super) fn target_channel(packed: &str) -> &str {
    let (channel_id, thread_id) = unpack_thread(packed);
    thread_id.unwrap_or(channel_id)
}

/// Split a reply into chunks Discord will accept.
///
/// Discord rejects a message over [`MAX_MESSAGE_CHARS`] outright rather than
/// truncating, and an agent answer routinely runs longer. Splitting happens on line
/// boundaries so lists and short code blocks stay intact; a single line longer than
/// the ceiling is hard-split because nothing else can be done with it. A fenced
/// block that itself spans the boundary is still severed (the first chunk ends
/// unclosed) — tracking fence state across chunks is more machinery than the
/// rendering glitch is worth.
pub(super) fn split_message(text: &str, max: usize) -> Vec<String> {
    let mut chunks: Vec<String> = Vec::new();
    let mut buf = String::new();
    let mut buf_len = 0usize;

    for line in text.split_inclusive('\n') {
        let line_len = line.chars().count();
        if line_len > max {
            if buf_len > 0 {
                chunks.push(std::mem::take(&mut buf));
                buf_len = 0;
            }
            for ch in line.chars() {
                if buf_len == max {
                    chunks.push(std::mem::take(&mut buf));
                    buf_len = 0;
                }
                buf.push(ch);
                buf_len += 1;
            }
            continue;
        }
        if buf_len + line_len > max {
            chunks.push(std::mem::take(&mut buf));
            buf_len = 0;
        }
        buf.push_str(line);
        buf_len += line_len;
    }
    if buf_len > 0 {
        chunks.push(buf);
    }
    // A blank chunk would be rejected by Discord ("content: must not be empty"),
    // so drop anything that is only whitespace.
    chunks.retain(|chunk| !chunk.trim().is_empty());
    chunks
}

/// Derive a thread name from the user's message.
///
/// Control characters are dropped and whitespace collapsed before clipping, so a
/// pasted multi-line prompt still yields one readable line. Falls back to
/// a localized "Ryu reply" because Discord rejects an empty name — an image sent
/// with no caption must still get a thread.
pub(super) fn thread_name(text: &str, locale: &str) -> String {
    let cleaned: String = text.chars().filter(|ch| !ch.is_control()).collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let clipped: String = collapsed.chars().take(THREAD_NAME_CHARS).collect();
    let trimmed = clipped.trim();
    if trimmed.is_empty() {
        i18n::render(locale, i18n::messages::DISCORD_THREAD_FALLBACK_MESSAGE, &[])
    } else {
        trimmed.to_string()
    }
}

/// The invoking user's Discord client language on an interaction.
pub(super) fn interaction_locale(value: &Value) -> Option<String> {
    value["locale"]
        .as_str()
        .filter(|locale| !locale.trim().is_empty())
        .map(str::to_owned)
}

/// Percent-encode an emoji for the reactions path segment.
///
/// Hand-rolled rather than pulling an encoder in for one call site. `:` is left
/// intact on purpose: a custom emoji is addressed as `name:id`, and encoding the
/// separator turns a valid custom reaction into a 400.
pub(super) fn encode_emoji(emoji: &str) -> String {
    let mut out = String::with_capacity(emoji.len() * 3);
    for byte in emoji.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b':' => {
                out.push(*byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// The `allowed_mentions` object sent with every message the bot creates.
///
/// Reply text is model output that anyone who can address the bot (or any content
/// injected into its context) can steer. Without this field Discord parses
/// `@everyone`, `@here` and `<@&role>` out of `content` with the BOT's
/// permissions, letting a member trigger mass pings they could not send
/// themselves. Only user mentions are parsed — any member can already ping a user.
pub(super) fn allowed_mentions() -> Value {
    json!({ "parse": ["users"] })
}

/// The JSON body for one text message create.
pub(super) fn message_payload(content: &str) -> Value {
    json!({
        "content": content,
        "allowed_mentions": allowed_mentions(),
    })
}

/// The `payload_json` half of a file upload. Discord maps a `files[N]` part to an
/// entry in `attachments` by its `id`, so the two must agree or the upload is
/// accepted with no attachment on it.
pub(super) fn voice_payload(filename: &str) -> Value {
    json!({
        "content": "",
        "attachments": [{ "id": 0, "filename": filename }],
        "allowed_mentions": allowed_mentions(),
    })
}

/// Normalise Discord's attachment array into the kernel's shape.
///
/// Discord serves media from a pre-signed CDN URL, so `url` is set and `file_id`
/// stays empty (no resolve step). `duration_secs` is present only on a true voice
/// message, which is what distinguishes a push-to-talk recording from an uploaded
/// song; everything else is classified from its MIME type.
pub(super) fn parse_attachments(message: &DiscordMessage) -> Vec<Attachment> {
    message
        .attachments
        .iter()
        .map(|a| Attachment {
            kind: a.duration_secs.map(|_| AttachmentKind::Voice),
            url: Some(a.url.clone()).filter(|u| !u.is_empty()),
            file_id: None,
            mime: a.content_type.clone().filter(|m| !m.is_empty()),
            filename: Some(a.filename.clone()).filter(|f| !f.is_empty()),
            size: a.size,
        })
        .collect()
}

/// Decide whether — and in what form — to route an inbound Discord message.
///
/// Watched channels are always multi-user (guild) channels, so `mode` applies to
/// all of them: `Mentions` only answers when the bot is `<@id>` mentioned; `All`
/// answers every (non-bot) message. The bot's own mention is stripped so the agent
/// sees a clean prompt; the speaker is carried separately in
/// [`InboundMessage::author_name`] rather than prefixed into the text.
///
/// Returns the text to route — possibly EMPTY when the message is media-only, since
/// the transcript or the attachment note becomes the prompt downstream — or `None`
/// to ignore the message (bot author, nothing at all, or unaddressed in Mentions
/// mode).
#[cfg(test)]
pub(super) fn decide_reply(
    message: &DiscordMessage,
    me_id: &str,
    mode: GroupReplyMode,
) -> Option<String> {
    decide_reply_with_options(
        message,
        me_id,
        mode,
        false,
        &DiscordChannelOptions::default(),
    )
}

pub(super) fn decide_reply_with_options(
    message: &DiscordMessage,
    me_id: &str,
    mode: GroupReplyMode,
    in_thread: bool,
    options: &DiscordChannelOptions,
) -> Option<String> {
    // Ignore bot messages (including our own replies) to avoid self-talk.
    if message.author.bot.unwrap_or(false) && !options.allow_bots {
        return None;
    }
    let content = message.content.trim();
    // A voice note or a photo arrives with no content at all; dropping it here
    // would make media ingest unreachable.
    if content.is_empty() && message.attachments.is_empty() {
        return None;
    }

    let is_group = message.guild_id.is_some();
    if is_group
        && !options.allowed_roles.is_empty()
        && !message.member.as_ref().is_some_and(|member| {
            member
                .roles
                .iter()
                .any(|role| options.allowed_roles.iter().any(|allowed| allowed == role))
        })
    {
        return None;
    }

    let mentioned = !me_id.is_empty()
        && (message.mentions.iter().any(|user| user.id == me_id)
            || content.contains(&format!("<@{me_id}>"))
            || content.contains(&format!("<@!{me_id}>")));

    let pattern_match = options.mention_patterns.iter().any(|pattern| {
        let pattern = pattern.trim().to_ascii_lowercase();
        !pattern.is_empty() && content.to_ascii_lowercase().contains(&pattern)
    });
    let addressed = mentioned || pattern_match;
    let thread_is_allowed = in_thread && !options.thread_require_mention;
    if is_group
        && mode == GroupReplyMode::Mentions
        && !addressed
        && !thread_is_allowed
        && !options
            .free_response_channels
            .iter()
            .any(|channel| channel == &message.channel_id)
    {
        return None;
    }

    // Strip the bot's own mention so the agent sees a clean prompt.
    let stripped = if me_id.is_empty() {
        content.to_string()
    } else {
        content
            .replace(&format!("<@{me_id}>"), "")
            .replace(&format!("<@!{me_id}>"), "")
    };
    let stripped = stripped.trim();
    if stripped.is_empty() && message.attachments.is_empty() {
        return None;
    }
    Some(stripped.to_string())
}

// ─── Discord REST API response types (only the fields we use) ──────────────────

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct DiscordMessage {
    pub(super) id: String,
    #[serde(default)]
    pub(super) channel_id: String,
    #[serde(default)]
    pub(super) guild_id: Option<String>,
    #[serde(default)]
    pub(super) content: String,
    pub(super) author: DiscordUser,
    /// Users explicitly mentioned in the message — the authoritative source for
    /// detecting whether the bot was addressed.
    #[serde(default)]
    pub(super) mentions: Vec<DiscordUser>,
    /// Guild member roles used by the optional role allowlist.
    #[serde(default)]
    pub(super) member: Option<DiscordMember>,
    #[serde(default)]
    pub(super) attachments: Vec<DiscordAttachment>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct DiscordMember {
    #[serde(default)]
    pub(super) roles: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct DiscordUser {
    #[serde(default)]
    pub(super) id: String,
    #[serde(default)]
    pub(super) username: String,
    #[serde(default)]
    pub(super) bot: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
pub(super) struct DiscordAttachment {
    #[serde(default)]
    pub(super) url: String,
    #[serde(default)]
    pub(super) filename: String,
    #[serde(default)]
    pub(super) content_type: Option<String>,
    #[serde(default)]
    pub(super) size: Option<u64>,
    /// Present only on a true voice message; its presence is how a push-to-talk
    /// recording is told apart from an uploaded audio file.
    #[serde(default)]
    pub(super) duration_secs: Option<f64>,
}

/// A channel or created thread, of which only the id, type and parent are needed.
#[derive(Debug, Deserialize)]
pub(super) struct DiscordChannelRef {
    #[serde(default)]
    pub(super) id: String,
    #[serde(default)]
    pub(super) parent_id: Option<String>,
    /// Discord's channel type; see [`THREAD_CHANNEL_TYPES`].
    #[serde(default, rename = "type")]
    pub(super) kind: Option<u8>,
}

#[derive(Debug, Deserialize)]
pub(super) struct GatewayUrlResponse {
    #[serde(default)]
    pub(super) url: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct GatewayEnvelope {
    pub(super) op: u8,
    #[serde(default)]
    pub(super) d: Option<Value>,
    #[serde(rename = "t", default)]
    pub(super) event_name: Option<String>,
}

pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let power = attempt.min(5);
    Duration::from_secs(ERROR_BACKOFF.as_secs().saturating_mul(1u64 << power))
}
