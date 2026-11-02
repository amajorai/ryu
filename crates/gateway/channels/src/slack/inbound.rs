//! The inbound side of the Socket Mode loop: delivery spawning, reconnect backoff,
//! thread keys, envelope and event parsing, and the group-reply gate.

use super::*;

impl SlackChannel {
    /// Handle one message on its own task so a slow agent call does not stall
    /// the socket read loop: claim the delivery (dedupe across reconnects),
    /// transcribe voice notes, then run the turn.
    pub(super) fn spawn_delivery(
        self: &Arc<Self>,
        host: &Arc<dyn ChannelHost>,
        inbound: InboundMessage,
        provider_id: String,
    ) {
        let channel = Arc::clone(self);
        let host = Arc::clone(host);
        tokio::spawn(async move {
            let (delivery_id, claim) = match claim_inbound_delivery(&*channel, &provider_id).await {
                Ok(result) => result,
                Err(error) => {
                    warn!(
                        channel = "slack",
                        %error,
                        "slack delivery could not be durably claimed; processing once without dedupe"
                    );
                    let delivery_id = scoped_delivery_id(&*channel, &provider_id);
                    let mut inbound = inbound;
                    channel.ingest_attachments(&mut inbound).await;
                    let _ =
                        handle_turn_with_delivery(channel, host, inbound, Some(&delivery_id)).await;
                    return;
                }
            };
            if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
                debug!(
                    channel = "slack",
                    delivery_id = %delivery_id,
                    ?claim,
                    "duplicate slack delivery suppressed"
                );
                return;
            }
            let mut inbound = inbound;
            // Voice notes become text before the gate sees them.
            channel.ingest_attachments(&mut inbound).await;
            let work_channel = Arc::clone(&channel);
            let work_host = Arc::clone(&host);
            let work_delivery_id = delivery_id.clone();
            run_claimed_delivery(channel, delivery_id, move || {
                let channel = Arc::clone(&work_channel);
                let host = Arc::clone(&work_host);
                let message = inbound.clone();
                let delivery_id = work_delivery_id.clone();
                async move {
                    handle_turn_with_delivery(channel, host, message, Some(&delivery_id)).await
                }
            })
            .await;
        });
    }
}

// ─── Reconnect backoff ─────────────────────────────────────────────────────────

/// Exponential backoff with jitter for reconnect attempt `n` (1-based), capped at
/// [`RECONNECT_MAX_BACKOFF`]. Jitter (0-25% on top) keeps a fleet of bots from
/// re-opening in lockstep after a Slack outage clears.
pub(super) fn reconnect_delay(attempt: u32) -> Duration {
    let delay = backoff_for(attempt);
    let spread = delay.as_millis() as u64 / 4;
    if spread == 0 {
        return delay;
    }
    // Cheap, dependency-free jitter source: the sub-nanos of the wall clock.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::from(d.subsec_nanos()));
    delay + Duration::from_millis(nanos % spread)
}

/// The deterministic (un-jittered) part of [`reconnect_delay`]: base * 2^(n-1),
/// capped. `attempt` 0 is treated as the first attempt.
pub(super) fn backoff_for(attempt: u32) -> Duration {
    let shift = attempt.saturating_sub(1).min(16);
    let millis = (RECONNECT_BASE_BACKOFF.as_millis() as u64).saturating_mul(1u64 << shift);
    Duration::from_millis(millis.min(RECONNECT_MAX_BACKOFF.as_millis() as u64))
}

// ─── Thread keys ───────────────────────────────────────────────────────────────
//
// Both directions of the packing convention described in the module docs. They
// are the only place a Slack `ts` is turned into a conversation key, so the read
// loop and `open_thread` cannot disagree about which thread a turn belongs to.

/// Pack a triggering message's `ts` together with the thread it arrived in.
///
/// The parent anchor is only carried when it differs from `ts` — a top-level
/// message is its own anchor, and packing it twice would be noise.
pub(super) fn pack_message_id(ts: &str, thread_ts: Option<&str>) -> String {
    pack_thread(ts, thread_ts.filter(|parent| *parent != ts))
}

/// The `thread_ts` to reply under, read back out of a packed message id: the
/// parent anchor when the message already sat in a thread, else the message's
/// own ts (replying under which starts the thread).
pub(super) fn thread_anchor(message_id: &str) -> &str {
    let (ts, parent) = unpack_thread(message_id);
    parent.unwrap_or(ts)
}

/// The Core `conversation_id` for a turn — the channel plus the thread the reply
/// belongs in — so every thread keeps its own history.
///
/// Idempotent on an already-packed `chat_id`: an existing thread wins over the
/// message's anchor, so re-running it never re-roots a conversation.
pub(super) fn conversation_key(chat_id: &str, message_id: Option<&str>) -> String {
    let (channel, existing) = unpack_thread(chat_id);
    let anchor = existing.or_else(|| message_id.map(thread_anchor));
    pack_thread(channel, anchor)
}

/// Whether the bot replied in `key` within the idle TTL.
pub(super) fn thread_is_active(
    threads: &HashMap<String, Instant>,
    key: &str,
    now: Instant,
) -> bool {
    threads
        .get(key)
        .is_some_and(|seen| now.saturating_duration_since(*seen) < ACTIVE_THREAD_IDLE_TTL)
}

/// Mark `key` active as of `now`: drop idle threads, then evict the least
/// recently used one when the map is still full, so the memory stays bounded.
pub(super) fn remember_active_thread(
    threads: &mut HashMap<String, Instant>,
    key: String,
    now: Instant,
) {
    threads.retain(|_, seen| now.saturating_duration_since(*seen) < ACTIVE_THREAD_IDLE_TTL);
    if threads.len() >= MAX_ACTIVE_THREADS && !threads.contains_key(&key) {
        let oldest = threads
            .iter()
            .min_by_key(|(_, seen)| **seen)
            .map(|(thread, _)| thread.clone());
        if let Some(oldest) = oldest {
            threads.remove(&oldest);
        }
    }
    threads.insert(key, now);
}

// ─── Envelope / event parsing ──────────────────────────────────────────────────

/// Extract the Socket Mode `envelope_id` that must be acked.
pub(super) fn parse_envelope_id(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value["envelope_id"].as_str().map(|s| s.to_string())
}

/// A user-authored Slack message, before the group-reply gate runs on it.
#[derive(Debug, Clone)]
pub(super) struct SlackInbound {
    /// The bare Slack channel id (`C…`, `D…`, `G…`).
    pub(super) channel: String,
    /// The message text exactly as Slack sent it — mentions NOT stripped, because
    /// the mention gate has to see them.
    pub(super) text: String,
    /// True for a 1:1 DM (`channel_type == "im"`), which always gets a reply.
    pub(super) is_dm: bool,
    /// The author's Slack user id, which is what pairing is keyed on. `None` on
    /// the rare event that omits it; the gate then falls back to the channel.
    pub(super) sender_id: Option<String>,
    /// The triggering `ts`, packed with its parent thread anchor when there is
    /// one. Slash-command frames have no message timestamp and therefore keep
    /// this empty so they do not manufacture an invalid Slack `thread_ts`.
    pub(super) message_id: Option<String>,
    /// Files shared with the message.
    pub(super) attachments: Vec<Attachment>,
    /// Slash-command frames are already addressed, even when they target a
    /// channel whose ordinary messages are mention-gated.
    pub(super) force_reply: bool,
    pub(super) is_bot: bool,
}

impl SlackInbound {
    /// A message with media is a real prompt even with no text at all.
    pub(super) fn has_media(&self) -> bool {
        !self.attachments.is_empty()
    }
}

/// Parse a Socket Mode frame into a [`SlackInbound`], or `None` if it is not
/// a user-authored message event we should respond to.
///
/// We skip non-`events_api` frames (hello/disconnect), non-`message` events, any
/// subtype outside [`ALLOWED_SUBTYPES`] (edits, joins, topic changes), and
/// anything carrying a `bot_id` — including our own replies, which is the loop
/// guard.
pub(super) fn parse_inbound(raw: &str) -> Option<SlackInbound> {
    let value: Value = serde_json::from_str(raw).ok()?;

    if value["type"].as_str() != Some("events_api") {
        return None;
    }

    let event = &value["payload"]["event"];
    if event["type"].as_str() != Some("message") {
        return None;
    }
    if let Some(subtype) = event.get("subtype").and_then(Value::as_str) {
        if !ALLOWED_SUBTYPES.contains(&subtype) {
            return None;
        }
    }
    let channel = event["channel"].as_str()?;
    let text = event["text"].as_str().unwrap_or_default().trim();
    let attachments = parse_files(event);
    // A caption-less photo or a voice memo carries no text, so "empty" is only a
    // reason to drop the event when nothing was attached either.
    if text.is_empty() && attachments.is_empty() {
        return None;
    }

    let ts = event["ts"].as_str()?;
    let thread_ts = event.get("thread_ts").and_then(Value::as_str);

    Some(SlackInbound {
        channel: channel.to_string(),
        text: text.to_string(),
        // A missing `channel_type` is treated as a GROUP: the failure direction
        // matters, because mistaking a public channel for a DM would post a
        // pairing code where everyone can read it.
        is_dm: event.get("channel_type").and_then(Value::as_str) == Some("im"),
        sender_id: event
            .get("user")
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty())
            .map(str::to_string),
        message_id: Some(pack_message_id(ts, thread_ts)),
        attachments,
        force_reply: false,
        is_bot: event.get("bot_id").and_then(Value::as_str).is_some(),
    })
}

pub(super) fn parse_slash_command(raw: &str) -> Option<SlackInbound> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if value["type"].as_str() != Some("slash_commands") {
        return None;
    }
    let payload = &value["payload"];
    let command = payload["command"].as_str()?.trim();
    let text = payload["text"].as_str().unwrap_or_default().trim();
    let mut routed = command.to_string();
    if !text.is_empty() {
        routed.push(' ');
        routed.push_str(text);
    }
    let channel = payload["channel_id"].as_str()?.to_string();
    Some(SlackInbound {
        channel,
        text: routed,
        is_dm: payload["channel_name"].as_str() == Some("directmessage"),
        sender_id: payload["user_id"].as_str().map(str::to_string),
        // A slash command is addressed, but Slack's trigger/command ids are
        // not message timestamps and cannot be used as a thread anchor.
        message_id: None,
        attachments: Vec::new(),
        force_reply: true,
        is_bot: false,
    })
}

/// Map the event's `files[]` onto kernel [`Attachment`]s.
///
/// `url_private_download` is preferred over `url_private`: both need the bot
/// token, but the former serves the raw bytes rather than Slack's viewer page.
/// A Slack voice memo is tagged `subtype: "slack_audio"`, which is the one
/// reliable way to tell "the user spoke" from "the user attached a song" — both
/// are transcribed, but only the former reads as a voice message.
pub(super) fn parse_files(event: &Value) -> Vec<Attachment> {
    let Some(files) = event.get("files").and_then(Value::as_array) else {
        return Vec::new();
    };
    files
        .iter()
        .filter_map(|file| {
            let url = file
                .get("url_private_download")
                .and_then(Value::as_str)
                .or_else(|| file.get("url_private").and_then(Value::as_str))?;
            let kind = match file.get("subtype").and_then(Value::as_str) {
                Some("slack_audio") => Some(AttachmentKind::Voice),
                // Everything else is classified from its MIME type by
                // `Attachment::resolved_kind`.
                _ => None,
            };
            Some(Attachment {
                kind,
                url: Some(url.to_string()),
                file_id: file.get("id").and_then(Value::as_str).map(str::to_string),
                mime: file
                    .get("mimetype")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                filename: file.get("name").and_then(Value::as_str).map(str::to_string),
                size: file.get("size").and_then(Value::as_u64),
            })
        })
        .collect()
}

// ─── Group-reply gate ──────────────────────────────────────────────────────────

/// Did the bot write this itself?
///
/// An empty `bot_user_id` (`auth.test` failed) is never a match — the same
/// fail-open direction as [`mentions_bot`]. Matching on empty would drop every
/// event whose author is unknown, which is the "silent dead bot" outcome the
/// identity lookup is explicitly allowed to fail into.
pub(super) fn is_self_authored(sender_id: Option<&str>, bot_user_id: &str) -> bool {
    !bot_user_id.is_empty() && sender_id == Some(bot_user_id)
}

/// `<@U123>` / `<@U123|name>` — the raw form a Slack mention takes in `text`.
/// True when `text` @mentions `bot_user_id`.
///
/// An empty `bot_user_id` is never a match: without the guard the check would
/// degrade to "mentions anyone".
pub(super) fn mentions_bot(text: &str, bot_user_id: &str) -> bool {
    if bot_user_id.is_empty() {
        return false;
    }
    text.contains(&format!("<@{bot_user_id}"))
}

/// Strip every `<@U…>` / `<@U…|name>` mention so the agent sees a clean prompt.
pub(super) fn strip_mentions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<@") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            rest = &rest[start..];
            break;
        };
        out.push(' ');
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Decide whether to answer `inbound`, and with what text.
///
/// DMs always answer. CHANNEL messages are gated by `mode`: in `Mentions` — the
/// admin's default, and what the setup form has always shown — the bot only
/// answers when it is @mentioned or when the message lands in a thread it is
/// already running. In `All` it answers everything.
///
/// Fails OPEN when `bot_user_id` is empty (`auth.test` failed at startup): the
/// gate cannot be evaluated, so the bot behaves as it did before the gate existed
/// rather than going silent.
///
/// Returns the text to route, or `None` to ignore the message. An EMPTY string is
/// a legitimate answer when media was attached — [`handle_turn`] turns the
/// attachment into the prompt (a transcript, or a bracketed note).
#[cfg(test)]
pub(super) fn decide_reply(
    inbound: &SlackInbound,
    mode: GroupReplyMode,
    bot_user_id: &str,
    in_active_thread: bool,
) -> Option<String> {
    decide_reply_with_options(
        inbound,
        mode,
        bot_user_id,
        in_active_thread,
        &SlackChannelOptions::default(),
    )
}

pub(super) fn decide_reply_with_options(
    inbound: &SlackInbound,
    mode: GroupReplyMode,
    bot_user_id: &str,
    in_active_thread: bool,
    options: &SlackChannelOptions,
) -> Option<String> {
    if inbound.is_bot && !options.allow_bots {
        return None;
    }
    let stripped = strip_mentions(&inbound.text);

    if inbound.is_dm || inbound.force_reply {
        if !stripped.is_empty() {
            return Some(stripped);
        }
        if !inbound.text.is_empty() {
            return Some(inbound.text.clone());
        }
        return inbound.has_media().then(String::new);
    }

    let gate_evaluable = !bot_user_id.is_empty();
    let pattern_match = options.mention_patterns.iter().any(|pattern| {
        let pattern = pattern.trim().to_ascii_lowercase();
        !pattern.is_empty() && inbound.text.to_ascii_lowercase().contains(&pattern)
    });
    let mention_required = !options.require_mention_channels.is_empty()
        && options
            .require_mention_channels
            .iter()
            .any(|channel| channel == &inbound.channel);
    let free_response = options
        .free_response_channels
        .iter()
        .any(|channel| channel == &inbound.channel);
    let addressed = mentions_bot(&inbound.text, bot_user_id) || pattern_match;
    let active_thread = in_active_thread
        && !options.strict_mention
        && !options.thread_require_mention
        && !mention_required;
    let mention_gate = mode == GroupReplyMode::Mentions || mention_required;
    if mention_gate && gate_evaluable && !addressed && !active_thread && !free_response {
        return None;
    }

    if stripped.is_empty() {
        // A bare `@ryu` with a photo attached is a real prompt; a bare `@ryu`
        // with nothing at all is not.
        return inbound.has_media().then(String::new);
    }
    Some(stripped)
}
