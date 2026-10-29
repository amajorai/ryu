//! Slack channel adapter (Socket Mode).
//!
//! Registers a Slack app via its app-level token and opens a Socket Mode
//! WebSocket through `apps.connections.open` — no public webhook URL required,
//! mirroring the Telegram adapter's long-poll design.
//!
//! The adapter owns exactly two things (see [`crate`]): the **transport** — this
//! socket, its ack envelopes and its reconnect budget — and Slack's **verbs**:
//! `chat.postMessage`, `reactions.add`, the external-upload flow, and the
//! assistant thread status that stands in for a typing indicator. Everything
//! between them (the access gate, media ingest, the Core call, reply delivery)
//! is [`handle_turn`]'s job, so this file no longer re-derives any of it.
//!
//! # Threads
//!
//! Slack is a threaded platform, and a busy channel is only readable if the bot
//! answers *in* the thread of the message that triggered it. Two ids are needed
//! for that (the channel and the `thread_ts`) but [`InboundMessage::chat_id`]
//! carries one. The kernel's [`pack_thread`] / [`unpack_thread`] convention is
//! what resolves it, and this adapter uses it twice:
//!
//! - `chat_id` stays the **bare channel id**. It is what the group allowlist is
//!   configured with, so packing a thread into it would silently stop matching.
//! - `message_id` carries the triggering `ts` and — only when the message was
//!   already inside a thread — its parent anchor, packed the same way. A Slack
//!   timestamp is `<seconds>.<micros>`, digits and a dot, so the `:` separator is
//!   unambiguous and a bare ts round-trips to `(ts, None)`.
//!
//! That keeps the adapter stateless: [`Channel::open_thread`] needs the parent
//! anchor and [`Channel::react`] needs the triggering ts, and both read the value
//! they need out of the same field rather than out of a side map that would leak
//! an entry every time the access gate refused a message.
//!
//! # mrkdwn
//!
//! Slack does not render CommonMark. Its "mrkdwn" flavour uses `*bold*`,
//! `_italic_`, `~strike~` and `<url|label>`, and has no headings and no tables —
//! so a reply posted raw shows literal asterisks where the agent meant emphasis.
//! [`to_mrkdwn`] does that translation for [`Channel::send_rich`]; it is a small
//! single-pass converter rather than a Markdown parser, because the alternative
//! (a full parser dependency) buys nothing for a surface with this few marks.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

use crate::{
    claim_inbound_delivery, handle_turn_with_delivery,
    media::{self, Attachment, AttachmentKind, VoiceDelivery},
    pack_thread,
    pairing::PairingStore,
    run_claimed_delivery, scoped_delivery_id,
    status::{StatusReporter, HEARTBEAT_INTERVAL},
    unpack_thread, Channel, ChannelCaps, ChannelHost, ChannelRuntime, GroupReplyMode,
    InboundMessage, SlackChannelConfig, SlackChannelOptions,
};

/// Slack Web API base. Socket Mode is opened from here; replies post here too.
const SLACK_API_BASE: &str = "https://slack.com/api";

/// First cooldown before re-opening the Socket Mode connection after it drops or
/// an open attempt fails, so a transient Slack outage doesn't become a tight loop.
const RECONNECT_BASE_BACKOFF: Duration = Duration::from_secs(3);
/// Ceiling for the exponential backoff between reconnect attempts.
const RECONNECT_MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How many consecutive failed opens/connects we tolerate before giving up.
///
/// Without a cap a permanent failure — an app token missing `connections:write`,
/// Socket Mode switched off, a revoked token — hammered `apps.connections.open`
/// forever at a fixed 3s and the operator saw nothing but log spam. Exhausting
/// the budget now reports a terminal error through the status reporter (so the
/// bot's dot in the UI shows the real reason) and returns `Err` from `run`.
const MAX_RECONNECT_ATTEMPTS: u32 = 10;

/// Text shown in the assistant thread status while the agent is working. Slack
/// renders it italicised under the conversation header, in the same place a
/// human's "is typing…" would appear.
const THINKING_STATUS: &str = "is thinking…";

/// Message `subtype`s that still represent a person addressing the bot.
///
/// The gate used to be "any subtype at all ⇒ ignore", which was right for joins
/// and edits but silently discarded every file upload: Slack tags a message
/// carrying an attachment `file_share`. Listing what is allowed (rather than
/// what is denied) keeps the original conservatism — an unrecognised system
/// subtype is still ignored — while letting media through.
const ALLOWED_SUBTYPES: &[&str] = &[
    "bot_message",
    "file_share",
    "me_message",
    "thread_broadcast",
];

/// How long a thread stays "active" (answerable without a re-@mention) after
/// the bot last replied in it. Each reply refreshes it, so a live conversation
/// never expires; an idle one costs at most a fresh mention to resume.
const ACTIVE_THREAD_IDLE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Ceiling on the active-thread memory. Without it a long-running gateway in a
/// busy workspace kept a slot for every thread the bot ever joined. Evicting
/// the least recently used thread costs only a re-@mention there.
const MAX_ACTIVE_THREADS: usize = 4096;

pub struct SlackChannel {
    /// Core route, access policy, pairing store, command cache — everything the
    /// shared path needs, owned once instead of copied field-by-field.
    runtime: ChannelRuntime,
    app_token: String,
    bot_token: String,
    /// This bot's own Slack user id, learned once at startup via `auth.test`.
    /// It is what a channel mention (`<@U…>`) is matched against. Empty when
    /// `auth.test` failed — the mention gate then fails OPEN (see [`decide_reply`]).
    bot_user_id: OnceLock<String>,
    /// Threads the bot is already answering in, so a follow-up in the same thread
    /// does not need to re-@mention it. Keyed by the packed conversation key,
    /// valued by the last reply time; idle-TTL-pruned and hard-capped (see
    /// [`remember_active_thread`]).
    active_threads: Mutex<HashMap<String, Instant>>,
    options: SlackChannelOptions,
}

impl SlackChannel {
    /// `reactions.add` / `reactions.remove` on the triggering message. Slack
    /// names reactions by shortcode, so a Unicode emoji (Core's form) is
    /// translated first; one with no known shortcode is skipped.
    async fn reaction_call(&self, method: &str, chat_id: &str, message_id: &str, emoji: &str) {
        let Some(name) = slack_reaction_name(emoji) else {
            debug!(
                emoji,
                "no Slack shortcode is known for this emoji; skipping"
            );
            return;
        };
        let (channel, _) = unpack_thread(chat_id);
        // The packed message id carries the thread anchor too; a reaction belongs
        // on the message that triggered the turn, which is the first component.
        let (timestamp, _) = unpack_thread(message_id);
        let result: anyhow::Result<ApiAck> = async {
            let ack = self
                .http()
                .post(format!("{SLACK_API_BASE}/{method}"))
                .bearer_auth(&self.bot_token)
                .json(&json!({ "channel": channel, "timestamp": timestamp, "name": name }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            Ok(ack)
        }
        .await;
        match result {
            Ok(ack) if ack.ok => {}
            Ok(ack) => warn!(
                error = %ack.error.unwrap_or_default(),
                method, "slack reaction call returned ok=false"
            ),
            Err(err) => warn!(%err, method, "slack reaction call failed"),
        }
    }
    /// Build a Slack adapter. `pairing` is the node-wide store, shared with every
    /// other channel so an approval granted once holds everywhere.
    pub fn new(
        cfg: SlackChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
    ) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, pairing, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats
    /// its connection status back to the control plane.
    pub fn new_with_status(
        cfg: SlackChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        if cfg.app_token.trim().is_empty() {
            anyhow::bail!("slack channel app_token is empty");
        }
        if cfg.bot_token.trim().is_empty() {
            anyhow::bail!("slack channel bot_token is empty");
        }
        let mut common = cfg.common;
        for channel_id in &cfg.options.allowed_channels {
            if !common
                .access
                .group_allowlist
                .iter()
                .any(|id| id == channel_id)
            {
                common.access.group_allowlist.push(channel_id.clone());
            }
        }
        Ok(Self {
            runtime: ChannelRuntime::new(http, common, pairing, status),
            app_token: cfg.app_token,
            bot_token: cfg.bot_token,
            bot_user_id: OnceLock::new(),
            active_threads: Mutex::new(HashMap::new()),
            options: cfg.options,
        })
    }

    /// Shorthand for the shared HTTP client.
    fn http(&self) -> &reqwest::Client {
        &self.runtime.http
    }

    /// Learn this bot's own Slack user id (`auth.test`). Needed to tell "someone
    /// mentioned *me*" from "someone mentioned anyone".
    async fn auth_test(&self) -> anyhow::Result<String> {
        let url = format!("{SLACK_API_BASE}/auth.test");
        let resp = self
            .http()
            .post(&url)
            .bearer_auth(&self.bot_token)
            .send()
            .await?
            .error_for_status()?;
        let body: AuthTestResponse = resp.json().await?;
        if !body.ok {
            anyhow::bail!(
                "slack auth.test returned ok=false: {}",
                body.error.unwrap_or_default()
            );
        }
        body.user_id
            .ok_or_else(|| anyhow::anyhow!("slack auth.test returned no user_id"))
    }

    /// The bot's own user id, or `""` when `auth.test` never succeeded.
    fn bot_user_id(&self) -> &str {
        self.bot_user_id.get().map_or("", String::as_str)
    }

    /// Open a Socket Mode connection and return the single-use WebSocket URL.
    async fn open_connection(&self) -> anyhow::Result<String> {
        let url = format!("{SLACK_API_BASE}/apps.connections.open");
        let resp = self
            .http()
            .post(&url)
            .bearer_auth(&self.app_token)
            .send()
            .await?
            .error_for_status()?;

        let body: ConnectionsOpenResponse = resp.json().await?;
        if !body.ok {
            anyhow::bail!(
                "slack apps.connections.open returned ok=false: {}",
                body.error.unwrap_or_default()
            );
        }
        body.url
            .ok_or_else(|| anyhow::anyhow!("slack apps.connections.open returned no url"))
    }

    /// Post one message, threaded when `chat_id` carries a `thread_ts`.
    ///
    /// `mrkdwn` is Slack's default for `text`, so both the plain and the rich
    /// path land here; only what they put in `text` differs.
    async fn post_text(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let (channel, thread_ts) = unpack_thread(chat_id);
        let url = format!("{SLACK_API_BASE}/chat.postMessage");

        let text = match self.options.reply_prefix.as_deref() {
            Some(prefix) if !prefix.is_empty() => format!("{prefix}{text}"),
            _ => text.to_string(),
        };
        let mut payload = json!({
            "channel": channel,
            "text": text,
        });
        if (self.options.rich_blocks || self.options.feedback_buttons)
            && text.chars().count() <= 3000
        {
            let mut blocks = vec![json!({
                "type": "section",
                "text": { "type": "mrkdwn", "text": text },
            })];
            if self.options.feedback_buttons {
                blocks.push(json!({
                    "type": "actions",
                    "elements": [
                        {
                            "type": "button",
                            "text": { "type": "plain_text", "text": "Helpful" },
                            "action_id": "ryu_feedback_helpful",
                            "value": "helpful",
                        },
                        {
                            "type": "button",
                            "text": { "type": "plain_text", "text": "Needs work" },
                            "action_id": "ryu_feedback_needs_work",
                            "value": "needs_work",
                        },
                    ],
                }));
            }
            payload["blocks"] = Value::Array(blocks);
        }
        // Reply in-thread so multi-turn conversations stay grouped.
        if self.options.reply_in_thread {
            if let Some(ts) = thread_ts {
                payload["thread_ts"] = json!(ts);
                payload["reply_broadcast"] = json!(self.options.reply_broadcast);
            }
        }

        let body: ApiAck = self
            .http()
            .post(&url)
            .bearer_auth(&self.bot_token)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.into_result("chat.postMessage")
    }

    /// Upload a file to a channel (and thread) with Slack's modern external
    /// upload flow: reserve a URL, PUT the bytes at it, then complete the upload
    /// so the file is shared into the conversation.
    ///
    /// The legacy `files.upload` fallback is deliberately not implemented — it is
    /// retired, and every failure mode here (missing `files:write`, a workspace
    /// that refuses the upload) is reported to the caller, which already has a
    /// text reply in the conversation to fall back on.
    ///
    /// # Errors
    /// Returns `Err` on transport failure or an `ok:false` from any of the three
    /// steps, carrying Slack's own error string so the operator can act on it.
    async fn upload_file(
        &self,
        channel: &str,
        thread_ts: Option<&str>,
        filename: &str,
        bytes: Vec<u8>,
    ) -> anyhow::Result<()> {
        // 1. Reserve an upload URL. This method takes FORM parameters, not a JSON
        //    body (a JSON body is rejected with `invalid_arguments`), and `length`
        //    must be the exact byte count.
        let length = bytes.len().to_string();
        let reserved: UploadUrlResponse = self
            .http()
            .post(format!("{SLACK_API_BASE}/files.getUploadURLExternal"))
            .bearer_auth(&self.bot_token)
            .form(&[("filename", filename), ("length", length.as_str())])
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        if !reserved.ok {
            anyhow::bail!(
                "slack files.getUploadURLExternal returned ok=false: {}",
                reserved.error.unwrap_or_default()
            );
        }
        let (upload_url, file_id) = match (reserved.upload_url, reserved.file_id) {
            (Some(url), Some(id)) => (url, id),
            _ => anyhow::bail!("slack files.getUploadURLExternal returned no upload url"),
        };

        // 2. POST the bytes to the reserved URL. This one is a plain multipart
        //    upload and answers with text, not JSON.
        let part = reqwest::multipart::Part::bytes(bytes).file_name(filename.to_string());
        let form = reqwest::multipart::Form::new().part("file", part);
        self.http()
            .post(&upload_url)
            .multipart(form)
            .send()
            .await?
            .error_for_status()?;

        // 3. Share it into the conversation. `channel_id` is singular here — the
        //    legacy `channels` list belongs to the retired `files.upload`.
        let mut payload = json!({
            "files": [{ "id": file_id, "title": filename }],
            "channel_id": channel,
        });
        if let Some(ts) = thread_ts {
            payload["thread_ts"] = json!(ts);
        }
        let body: ApiAck = self
            .http()
            .post(format!("{SLACK_API_BASE}/files.completeUploadExternal"))
            .bearer_auth(&self.bot_token)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.into_result("files.completeUploadExternal")
    }

    /// Fetch the bytes of every attachment that needs transcribing and fold the
    /// transcripts into the turn text.
    ///
    /// Slack file URLs are private: they answer only to the bot token presented
    /// as a bearer header (an unauthenticated GET quietly returns a login page,
    /// not a 401), which is why the download lives here and not in the kernel.
    /// Non-speech media is not downloaded at all — [`handle_turn`] annotates it
    /// from the filename, and pulling a 20 MB video the agent cannot read would
    /// buy nothing.
    async fn ingest_attachments(&self, message: &mut InboundMessage) {
        if message.attachments.is_empty() {
            return;
        }
        // Downloading and transcribing is the expensive part of a turn, and it runs
        // ahead of the access gate inside `handle_turn` — so an unadmitted sender
        // could otherwise spend the operator's STT budget just by attaching audio.
        // `already_admitted` is that gate's read-only twin; the kernel still
        // answers an unknown sender with a pairing prompt.
        if !self.runtime.already_admitted(self.name(), message).await {
            return;
        }
        let auth = format!("Bearer {}", self.bot_token);
        let mut downloaded = Vec::new();
        for (index, attachment) in message.attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let Some(url) = attachment.url.as_deref() else {
                continue;
            };
            // Refuse an oversized file on its declared size, before spending the
            // bandwidth; `media::download` re-checks what actually arrives.
            if attachment
                .size
                .is_some_and(|size| size as usize > media::MAX_ATTACHMENT_BYTES)
            {
                warn!(
                    size = attachment.size,
                    "slack: skipping an attachment over the size cap"
                );
                continue;
            }
            match media::download(self.http(), url, &[("Authorization", auth.as_str())]).await {
                Ok(bytes) => downloaded.push((index, bytes)),
                Err(err) => warn!(%err, "slack: attachment download failed"),
            }
        }
        self.runtime.ingest_media(message, downloaded).await;
    }

    /// Terminal state: the reconnect budget is spent. Report a real, actionable
    /// error to the control plane (the bot's status dot) and stop, instead of
    /// hammering Slack forever on a failure that will never clear by itself.
    async fn give_up(&self, attempts: u32, err: &anyhow::Error) -> anyhow::Result<()> {
        let message = format!(
            "slack: giving up after {attempts} failed connection attempts ({err}). Check that \
             the app token starts with xapp-, carries the connections:write scope, and that \
             Socket Mode is enabled for the app."
        );
        warn!("{message}");
        if let Some(reporter) = &self.runtime.status {
            reporter.error(&message).await;
        }
        Err(anyhow::anyhow!(message))
    }

    /// Clear the assistant status after the final reply. Slack's status API is
    /// best-effort for ordinary bot tokens, just like `send_typing`.
    async fn clear_typing(&self, chat_id: &str) {
        let (channel, Some(thread_ts)) = unpack_thread(chat_id) else {
            return;
        };
        let result = self
            .http()
            .post(format!("{SLACK_API_BASE}/assistant.threads.setStatus"))
            .bearer_auth(&self.bot_token)
            .json(&json!({
                "channel_id": channel,
                "thread_ts": thread_ts,
                "status": "",
            }))
            .send()
            .await;
        if let Err(err) = result {
            debug!(%err, "slack assistant status clear failed");
        }
    }

    /// Acknowledge feedback buttons rendered in rich replies. Socket Mode
    /// delivers interactive payloads on the same WebSocket as messages; the
    /// envelope is acknowledged by the caller, while the reaction gives the
    /// person a visible confirmation without starting another agent turn.
    async fn handle_interactive(&self, raw: &str) -> bool {
        let value: Value = match serde_json::from_str(raw) {
            Ok(value) => value,
            Err(_) => return false,
        };
        if value["type"].as_str() != Some("interactive") {
            return false;
        }

        let payload = &value["payload"];
        if payload["type"].as_str() != Some("block_actions") {
            return true;
        }
        let action_id = payload["actions"]
            .as_array()
            .and_then(|actions| actions.first())
            .and_then(|action| action["action_id"].as_str());
        let emoji = match action_id {
            Some("ryu_feedback_helpful") => "white_check_mark",
            Some("ryu_feedback_needs_work") => "x",
            _ => return true,
        };
        if !self.options.feedback_buttons {
            return true;
        }
        let channel = payload["container"]["channel_id"]
            .as_str()
            .or_else(|| payload["channel"]["id"].as_str());
        let message_ts = payload["container"]["message_ts"]
            .as_str()
            .or_else(|| payload["message"]["ts"].as_str());
        if let (Some(channel), Some(message_ts)) = (channel, message_ts) {
            let _ = self.react(channel, message_ts, emoji).await;
        }
        true
    }
}

#[async_trait]
impl Channel for SlackChannel {
    fn name(&self) -> &'static str {
        "slack"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// What Slack actually does.
    ///
    /// `command_menu` is FALSE on purpose: a Slack slash command only exists if
    /// it is declared in the app's manifest and re-installed by the operator —
    /// there is no runtime "register these commands" API the way Telegram has
    /// `setMyCommands`. Publishing a menu from here is impossible, so claiming
    /// the capability would only produce a call that always fails.
    ///
    /// `streaming` is FALSE because Slack has no draft/partial surface; a stream
    /// would have to be faked by editing a posted message, which reads worse than
    /// one complete answer.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            // Best-effort: a real typing indicator needs the (retired) RTM API, so
            // this is the assistant thread status — see `send_typing`.
            typing: true,
            rich_text: true,
            streaming: false,
            threads: true,
            command_menu: false,
            voice: true,
            attachments: true,
            reactions: true,
            reply_keyboards: false,
            inline_buttons: false,
        }
    }

    /// The assistant status is sticky rather than expiring after a few seconds
    /// like Telegram's, so it only needs re-asserting rarely — often enough to
    /// recover from a dropped call, not often enough to be a poll loop.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(20)
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        for chunk in split_slack_text(text, 4000) {
            self.post_text(chat_id, &chunk).await?;
        }
        self.clear_typing(chat_id).await;
        Ok(())
    }

    /// Post the reply as mrkdwn. Without the conversion Slack renders the agent's
    /// CommonMark literally: `**bold**` shows its asterisks and `[a](b)` shows its
    /// brackets.
    async fn send_rich(&self, chat_id: &str, markdown: &str) -> anyhow::Result<()> {
        self.send_message(chat_id, &to_mrkdwn(markdown)).await
    }

    /// Show that the agent is working.
    ///
    /// A bot **cannot** send a real typing indicator over the Web API — that was
    /// an RTM feature and RTM is retired. The supported modern equivalent is
    /// `assistant.threads.setStatus`, which needs the assistant scopes; for a
    /// plain bot it simply fails, and that is fine.
    ///
    /// Returning `Err` on that failure is deliberate: [`crate::keep_typing`]
    /// treats one error as "this platform will not show an indicator this turn"
    /// and stops re-asserting, so a bot without the assistant scopes makes
    /// exactly one wasted call per turn instead of one every interval. The error
    /// never reaches the message loop.
    ///
    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        // Slack scopes the status to a thread; with no thread there is nothing to
        // set, which is not a failure.
        let (channel, thread_ts) = unpack_thread(chat_id);
        let Some(thread_ts) = thread_ts else {
            return Ok(());
        };
        let body: ApiAck = self
            .http()
            .post(format!("{SLACK_API_BASE}/assistant.threads.setStatus"))
            .bearer_auth(&self.bot_token)
            .json(&json!({
                "channel_id": channel,
                "thread_ts": thread_ts,
                "status": THINKING_STATUS,
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.into_result("assistant.threads.setStatus")
    }

    /// Send synthesized speech as a file. Slack has no voice-note bubble, so
    /// [`media::wav_delivery`] classifies it as an audio file; anything else
    /// means the caller and this adapter disagree and is refused loudly.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        if delivery == VoiceDelivery::Unsupported {
            anyhow::bail!("slack cannot deliver this audio");
        }
        let (channel, thread_ts) = unpack_thread(chat_id);
        self.upload_file(channel, thread_ts, "reply.wav", wav).await
    }

    /// Place an emoji reaction on the triggering message.
    ///
    /// Best-effort by contract: a duplicate reaction, a missing `reactions:write`
    /// scope or a deleted message are all logged and swallowed, because a failed
    /// acknowledgement must never affect the turn that follows it.
    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        self.reaction_call("reactions.add", chat_id, message_id, emoji)
            .await;
        Ok(())
    }

    /// Take back a reaction this bot placed. Same best-effort contract as
    /// [`Channel::react`]: `no_reaction` is logged, never surfaced.
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()> {
        self.reaction_call("reactions.remove", chat_id, message_id, emoji)
            .await;
        Ok(())
    }

    /// No-op. Slack's `conversations.mark` moves a *user's* read cursor and needs
    /// a user token with `conversations.write`; a bot has no unread state of its
    /// own to clear, so there is nothing honest to call here.
    async fn mark_read(&self, _chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Answer inside the triggering message's thread: its own thread when it
    /// already had one, otherwise a new thread rooted at the message — which is
    /// what keeps a busy channel readable. No API call is needed; on Slack a
    /// thread comes into existence when the first reply carries `thread_ts`.
    async fn open_thread(&self, chat_id: &str, message: &InboundMessage) -> String {
        if !self.options.reply_in_thread {
            return chat_id.to_string();
        }
        conversation_key(chat_id, message.message_id.as_deref())
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("slack channel socket-mode loop started");
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }

        // Learn our own user id up front: the mention gate matches against it.
        // FAIL-OPEN — a bot that can't resolve its id (missing `users:read`-free
        // `auth.test` access, a revoked token) still connects and answers every
        // channel message, exactly as it did before this gate existed. Turning a
        // scope gap into a silent, dead bot would be the worse failure.
        match self.auth_test().await {
            Ok(id) => {
                info!(bot_user_id = %id, "slack: bot identity resolved");
                let _ = self.bot_user_id.set(id);
            }
            Err(err) => {
                warn!(
                    error = %err,
                    "slack auth.test failed; the mention gate will fail open (the bot \
                     answers every channel message it can see)"
                );
            }
        }

        // Consecutive failed opens/connects. Reset the moment a socket comes up.
        let mut attempts: u32 = 0;

        loop {
            let ws_url = match self.open_connection().await {
                Ok(url) => url,
                Err(err) => {
                    attempts += 1;
                    if attempts >= MAX_RECONNECT_ATTEMPTS {
                        return self.give_up(attempts, &err).await;
                    }
                    let delay = reconnect_delay(attempts);
                    warn!(
                        error = %err,
                        attempt = attempts,
                        max_attempts = MAX_RECONNECT_ATTEMPTS,
                        backoff_ms = delay.as_millis() as u64,
                        "slack apps.connections.open failed, backing off"
                    );
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(delay).await;
                    continue;
                }
            };

            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((mut ws, _)) => {
                    debug!("slack socket-mode websocket connected");
                    // A live socket clears the failure budget: the next outage
                    // starts its backoff from scratch.
                    attempts = 0;
                    // The socket is open — the bot is live. Re-asserted below on
                    // each idle timeout so a quiet channel stays fresh.
                    if let Some(reporter) = &self.runtime.status {
                        reporter.online().await;
                    }
                    // Read frames, but wake every HEARTBEAT_INTERVAL even when idle
                    // to re-report `online` (the connection is still healthy).
                    loop {
                        let next = tokio::time::timeout(HEARTBEAT_INTERVAL, ws.next()).await;
                        let frame = match next {
                            Ok(Some(frame)) => frame,
                            Ok(None) => break,
                            Err(_) => {
                                if let Some(reporter) = &self.runtime.status {
                                    reporter.online().await;
                                }
                                continue;
                            }
                        };
                        let payload = match frame {
                            Ok(WsMessage::Text(text)) => text,
                            Ok(WsMessage::Ping(data)) => {
                                let _ = ws.send(WsMessage::Pong(data)).await;
                                continue;
                            }
                            Ok(WsMessage::Close(_)) => break,
                            Ok(_) => continue,
                            Err(err) => {
                                warn!(error = %err, "slack websocket read error");
                                break;
                            }
                        };

                        // Slack requires an ack envelope echoing the envelope_id
                        // for every events_api / interactive payload it sends.
                        let envelope_id = parse_envelope_id(&payload);
                        if let Some(envelope_id) = envelope_id.as_deref() {
                            let ack = json!({ "envelope_id": envelope_id }).to_string();
                            let _ = ws.send(WsMessage::Text(ack)).await;
                        }

                        if self.handle_interactive(&payload).await {
                            continue;
                        }

                        let Some(parsed) =
                            parse_inbound(&payload).or_else(|| parse_slash_command(&payload))
                        else {
                            continue;
                        };

                        if self
                            .options
                            .ignored_channels
                            .iter()
                            .any(|channel| channel == &parsed.channel)
                        {
                            debug!(channel = %parsed.channel, "slack: channel is ignored");
                            continue;
                        }
                        if !parsed.is_dm
                            && !self.options.allowed_channels.is_empty()
                            && !self
                                .options
                                .allowed_channels
                                .iter()
                                .any(|channel| channel == &parsed.channel)
                        {
                            debug!(channel = %parsed.channel, "slack: channel is not allowed");
                            continue;
                        }

                        // Second loop guard, on the bot's own USER id rather than
                        // on `bot_id`. It matters now that the adapter uploads
                        // files: a file the bot shares comes back as an inbound
                        // `file_share`, and one that slipped through would be
                        // downloaded and transcribed before any gate saw it —
                        // the bot answering its own voice note, forever.
                        if is_self_authored(parsed.sender_id.as_deref(), self.bot_user_id()) {
                            debug!("slack: ignoring the bot's own message");
                            continue;
                        }

                        // The conversation key the reply will land in. Computed
                        // here as well as in `open_thread` (same function, so the
                        // two cannot drift) because the active-thread memory is
                        // keyed by it.
                        let conversation =
                            conversation_key(&parsed.channel, parsed.message_id.as_deref());

                        // Honour the admin's group-reply choice. A channel message
                        // that doesn't address the bot is dropped here, before any
                        // model call is made.
                        let in_active_thread = self.active_threads.lock().is_ok_and(|threads| {
                            thread_is_active(&threads, &conversation, Instant::now())
                        });
                        let Some(text) = decide_reply_with_options(
                            &parsed,
                            self.runtime.cfg.group_reply_mode,
                            self.bot_user_id(),
                            in_active_thread,
                            &self.options,
                        ) else {
                            debug!(
                                channel = %parsed.channel,
                                "slack: message not addressed to the bot, ignoring"
                            );
                            continue;
                        };
                        // The bot now owns this thread: follow-ups in it continue
                        // without a re-@mention (matches the hosted connector).
                        if !parsed.is_dm && self.options.reply_in_thread {
                            if let Ok(mut threads) = self.active_threads.lock() {
                                remember_active_thread(&mut threads, conversation, Instant::now());
                            }
                        }

                        let inbound = InboundMessage {
                            // The BARE channel id: the group allowlist is written
                            // in channel ids, and `open_thread` adds the thread.
                            chat_id: parsed.channel,
                            access_chat_id: None,
                            text,
                            // Slack events carry a user id, not a display name;
                            // resolving it needs `users:read` and a call per
                            // message, so the id is left to the pairing gate and
                            // no name is claimed.
                            author_name: None,
                            sender_id: parsed.sender_id,
                            message_id: parsed.message_id,
                            is_group: !parsed.is_dm,
                            attachments: parsed.attachments,
                            channel_action: None,
                        };
                        let provider_id = inbound.message_id.clone().map_or_else(
                            || {
                                envelope_id
                                    .clone()
                                    .unwrap_or_else(|| "frame:unknown".to_string())
                            },
                            |message_id| format!("message:{message_id}"),
                        );

                        // Handle each message on its own task so a slow agent
                        // call does not stall the socket read loop.
                        let channel = Arc::clone(&self);
                        let host = Arc::clone(&host);
                        tokio::spawn(async move {
                            let (delivery_id, claim) = match claim_inbound_delivery(
                                &*channel,
                                &provider_id,
                            )
                            .await
                            {
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
                                    let _ = handle_turn_with_delivery(
                                        channel,
                                        host,
                                        inbound,
                                        Some(&delivery_id),
                                    )
                                    .await;
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
                                    handle_turn_with_delivery(
                                        channel,
                                        host,
                                        message,
                                        Some(&delivery_id),
                                    )
                                    .await
                                }
                            })
                            .await;
                        });
                    }
                    debug!("slack socket-mode websocket closed, reconnecting");
                }
                Err(err) => {
                    attempts += 1;
                    if attempts >= MAX_RECONNECT_ATTEMPTS {
                        return self.give_up(attempts, &err.into()).await;
                    }
                    warn!(
                        error = %err,
                        attempt = attempts,
                        max_attempts = MAX_RECONNECT_ATTEMPTS,
                        "slack websocket connect failed, backing off"
                    );
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                }
            }

            tokio::time::sleep(reconnect_delay(attempts)).await;
        }
    }
}

// ─── Reconnect backoff ─────────────────────────────────────────────────────────

/// Exponential backoff with jitter for reconnect attempt `n` (1-based), capped at
/// [`RECONNECT_MAX_BACKOFF`]. Jitter (0-25% on top) keeps a fleet of bots from
/// re-opening in lockstep after a Slack outage clears.
fn reconnect_delay(attempt: u32) -> Duration {
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
fn backoff_for(attempt: u32) -> Duration {
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
fn pack_message_id(ts: &str, thread_ts: Option<&str>) -> String {
    pack_thread(ts, thread_ts.filter(|parent| *parent != ts))
}

/// The `thread_ts` to reply under, read back out of a packed message id: the
/// parent anchor when the message already sat in a thread, else the message's
/// own ts (replying under which starts the thread).
fn thread_anchor(message_id: &str) -> &str {
    let (ts, parent) = unpack_thread(message_id);
    parent.unwrap_or(ts)
}

/// The Core `conversation_id` for a turn — the channel plus the thread the reply
/// belongs in — so every thread keeps its own history.
///
/// Idempotent on an already-packed `chat_id`: an existing thread wins over the
/// message's anchor, so re-running it never re-roots a conversation.
fn conversation_key(chat_id: &str, message_id: Option<&str>) -> String {
    let (channel, existing) = unpack_thread(chat_id);
    let anchor = existing.or_else(|| message_id.map(thread_anchor));
    pack_thread(channel, anchor)
}

/// Whether the bot replied in `key` within the idle TTL.
fn thread_is_active(threads: &HashMap<String, Instant>, key: &str, now: Instant) -> bool {
    threads
        .get(key)
        .is_some_and(|seen| now.saturating_duration_since(*seen) < ACTIVE_THREAD_IDLE_TTL)
}

/// Mark `key` active as of `now`: drop idle threads, then evict the least
/// recently used one when the map is still full, so the memory stays bounded.
fn remember_active_thread(threads: &mut HashMap<String, Instant>, key: String, now: Instant) {
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
fn parse_envelope_id(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value["envelope_id"].as_str().map(|s| s.to_string())
}

/// A user-authored Slack message, before the group-reply gate runs on it.
#[derive(Debug, Clone)]
struct SlackInbound {
    /// The bare Slack channel id (`C…`, `D…`, `G…`).
    channel: String,
    /// The message text exactly as Slack sent it — mentions NOT stripped, because
    /// the mention gate has to see them.
    text: String,
    /// True for a 1:1 DM (`channel_type == "im"`), which always gets a reply.
    is_dm: bool,
    /// The author's Slack user id, which is what pairing is keyed on. `None` on
    /// the rare event that omits it; the gate then falls back to the channel.
    sender_id: Option<String>,
    /// The triggering `ts`, packed with its parent thread anchor when there is
    /// one. Slash-command frames have no message timestamp and therefore keep
    /// this empty so they do not manufacture an invalid Slack `thread_ts`.
    message_id: Option<String>,
    /// Files shared with the message.
    attachments: Vec<Attachment>,
    /// Slash-command frames are already addressed, even when they target a
    /// channel whose ordinary messages are mention-gated.
    force_reply: bool,
    is_bot: bool,
}

impl SlackInbound {
    /// A message with media is a real prompt even with no text at all.
    fn has_media(&self) -> bool {
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
fn parse_inbound(raw: &str) -> Option<SlackInbound> {
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

fn parse_slash_command(raw: &str) -> Option<SlackInbound> {
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
fn parse_files(event: &Value) -> Vec<Attachment> {
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
fn is_self_authored(sender_id: Option<&str>, bot_user_id: &str) -> bool {
    !bot_user_id.is_empty() && sender_id == Some(bot_user_id)
}

/// `<@U123>` / `<@U123|name>` — the raw form a Slack mention takes in `text`.
/// True when `text` @mentions `bot_user_id`.
///
/// An empty `bot_user_id` is never a match: without the guard the check would
/// degrade to "mentions anyone".
fn mentions_bot(text: &str, bot_user_id: &str) -> bool {
    if bot_user_id.is_empty() {
        return false;
    }
    text.contains(&format!("<@{bot_user_id}"))
}

/// Strip every `<@U…>` / `<@U…|name>` mention so the agent sees a clean prompt.
fn strip_mentions(text: &str) -> String {
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
fn decide_reply(
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

fn decide_reply_with_options(
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

// ─── CommonMark → Slack mrkdwn ─────────────────────────────────────────────────

/// Split a Slack message without breaking UTF-8 or exceeding the Web API cap.
fn split_slack_text(input: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![input.to_string()];
    }
    let chars: Vec<char> = input.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    while chars.len() - start > max_chars {
        let mut end = start + max_chars;
        for index in (start + 1..=end).rev() {
            if chars[index - 1] == '\n' {
                end = index;
                break;
            }
        }
        parts.push(chars[start..end].iter().collect());
        start = end;
        while chars.get(start) == Some(&'\n') {
            start += 1;
        }
    }
    parts.push(chars[start..].iter().collect());
    parts
}

/// How deeply emphasis may nest before the converter stops interpreting it.
/// Pathological input ("`*`" a thousand times) should degrade to literal text,
/// not to unbounded work.
const MAX_EMPHASIS_NESTING: usize = 8;

/// Convert CommonMark to Slack's mrkdwn.
///
/// The mapping, and what it deliberately cannot do:
///
/// | CommonMark        | mrkdwn        | note                                  |
/// |-------------------|---------------|---------------------------------------|
/// | `**b**` / `__b__` | `*b*`         | Slack's bold is a SINGLE asterisk      |
/// | `*i*`             | `_i_`         | …which is why italics have to move     |
/// | `~~s~~`           | `~s~`         |                                        |
/// | `[t](u)`          | `<u\|t>`      |                                        |
/// | `# H`             | `*H*`         | no headings exist; emphasis stands in  |
/// | `- x`             | `• x`         | indentation preserved                  |
/// | table rows        | verbatim      | no table syntax exists; pipes stay     |
///
/// Fenced blocks and inline code spans pass through untouched (their content is
/// not markup), and `&`, `<`, `>` are escaped everywhere else because Slack
/// otherwise reads them as its own control syntax — the escaping happens as text
/// is emitted, so the `<url|label>` links this function *generates* survive it.
pub fn to_mrkdwn(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_fence = false;

    for (index, line) in markdown.lines().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let trimmed = line.trim_start();

        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            // Drop the info string: Slack has no syntax highlighting and would
            // render "rust" as the block's first line.
            out.push_str("```");
            continue;
        }
        if in_fence {
            out.push_str(&escape(line));
            continue;
        }

        // A heading has no mrkdwn equivalent, so it becomes bold. Emphasis INSIDE
        // it is dropped rather than nested — Slack does not render `*a *b* c*`.
        // CommonMark requires whitespace after the `#` run, and so do we: without
        // that rule a message about `#general` would come out emboldened.
        if let Some(heading) = heading_body(trimmed) {
            let text = heading.trim();
            if !text.is_empty() {
                out.push('*');
                out.push_str(&convert_inline(text).replace('*', ""));
                out.push('*');
                continue;
            }
        }

        // Bullets: keep the indentation (Slack nests on it) and use a real
        // bullet, which is what `-`/`*` would have rendered as.
        let indent = &line[..line.len() - trimmed.len()];
        if let Some(item) = bullet_body(trimmed) {
            out.push_str(indent);
            out.push_str("• ");
            out.push_str(&convert_inline(item));
            continue;
        }

        // Block quotes use the same `>` in mrkdwn, so the marker is passed
        // through literally instead of being escaped into `&gt;`.
        if let Some(quoted) = trimmed.strip_prefix('>') {
            out.push_str(indent);
            out.push('>');
            out.push_str(&convert_inline(quoted));
            continue;
        }

        out.push_str(&convert_inline(line));
    }

    // `lines()` drops a trailing newline; keep it so a reply's spacing survives.
    if markdown.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// The text of an ATX heading (`## Results`), or `None` when the line is not
/// one. The whitespace after the `#` run is required, which is what keeps a
/// channel reference (`#general`) from being read as a heading.
fn heading_body(trimmed: &str) -> Option<&str> {
    let rest = trimmed.trim_start_matches('#');
    if rest.len() == trimmed.len() {
        return None;
    }
    rest.starts_with([' ', '\t']).then(|| rest.trim_start())
}

/// The text of a `-`/`*`/`+` bullet, or `None` when the line is not one. The
/// space is required, so "3 * 4" and "**bold**" are not mistaken for bullets.
fn bullet_body(trimmed: &str) -> Option<&str> {
    let mut chars = trimmed.chars();
    match (chars.next(), chars.next()) {
        (Some('-' | '*' | '+'), Some(' ')) => Some(trimmed[2..].trim_start()),
        _ => None,
    }
}

/// Escape the three characters Slack reads as control syntax in message text.
fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Convert one line's inline markup.
///
/// A SINGLE left-to-right pass, which is the whole point: converting `**b**` to
/// `*b*` and then converting single asterisks to `_` in a second pass would undo
/// the first one. Openers record where their closer sits, so the scan emits the
/// right replacement when it arrives there without ever re-reading its own output.
fn convert_inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    // (index of the closing marker, what to emit for it, marker length).
    let mut closers: Vec<(usize, &str, usize)> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        if let Some(&(index, replacement, len)) = closers.last() {
            if i == index {
                out.push_str(replacement);
                i += len;
                closers.pop();
                continue;
            }
        }

        let ch = chars[i];
        match ch {
            // Code spans are not markup: copy through (escaped) to the closer.
            '`' => match find_marker(&chars, i + 1, "`") {
                Some(end) => {
                    out.push('`');
                    out.push_str(&escape(&slice(&chars, i + 1, end)));
                    out.push('`');
                    i = end + 1;
                }
                None => {
                    out.push('`');
                    i += 1;
                }
            },
            '[' => match parse_link(&chars, i) {
                Some((label, url, next)) => {
                    // Escaping happens on the pieces, BEFORE the link syntax is
                    // written, so this generated `<…|…>` is not escaped away.
                    out.push('<');
                    out.push_str(&escape(&url));
                    if !label.is_empty() {
                        out.push('|');
                        out.push_str(&escape(&label));
                    }
                    out.push('>');
                    i = next;
                }
                None => {
                    out.push('[');
                    i += 1;
                }
            },
            '*' | '_' | '~' => match open_emphasis(&chars, i, closers.len()) {
                Some((replacement, len, close_at)) => {
                    out.push_str(replacement);
                    closers.push((close_at, replacement, len));
                    i += len;
                }
                None => {
                    out.push(ch);
                    i += 1;
                }
            },
            '&' => {
                out.push_str("&amp;");
                i += 1;
            }
            '<' => {
                out.push_str("&lt;");
                i += 1;
            }
            '>' => {
                out.push_str("&gt;");
                i += 1;
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// Classify an emphasis marker at `start`, returning what to emit for it, how
/// many characters it spans, and where its closer sits — or `None` when it has
/// no closer (a lone `*` in prose is text, not markup).
fn open_emphasis(
    chars: &[char],
    start: usize,
    depth: usize,
) -> Option<(&'static str, usize, usize)> {
    if depth >= MAX_EMPHASIS_NESTING {
        return None;
    }
    let doubled = chars.get(start + 1) == Some(&chars[start]);
    let (marker, len, replacement) = match (chars[start], doubled) {
        // Bold in CommonMark is doubled; in mrkdwn it is a single asterisk.
        ('*', true) => ("**", 2, "*"),
        ('_', true) => ("__", 2, "*"),
        ('~', true) => ("~~", 2, "~"),
        // A single asterisk is CommonMark's italic, which mrkdwn spells `_`.
        ('*', false) => ("*", 1, "_"),
        // A single underscore already means italic to Slack; leave it alone.
        ('_', false) => ("_", 1, "_"),
        // A single tilde already means strikethrough to Slack.
        ('~', false) => ("~", 1, "~"),
        _ => return None,
    };
    // Emphasis cannot open on whitespace ("2 * 3" is arithmetic) and must close.
    if matches!(chars.get(start + len), None | Some(' ') | Some('\t')) {
        return None;
    }
    let close_at = find_marker(chars, start + len, marker)?;
    Some((replacement, len, close_at))
}

/// Index of the next occurrence of `marker` at or after `from`.
fn find_marker(chars: &[char], from: usize, marker: &str) -> Option<usize> {
    let needle: Vec<char> = marker.chars().collect();
    (from..chars.len().saturating_sub(needle.len() - 1))
        .find(|&i| chars[i..i + needle.len()] == needle[..])
}

/// Parse `[label](url)` starting at `start`, returning `(label, url, index after
/// the link)`. An image (`![alt](url)`) parses the same way — Slack unfurls the
/// URL, which is the closest thing it has to an inline image.
fn parse_link(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    let label_end = (start + 1..chars.len()).find(|&i| chars[i] == ']')?;
    if chars.get(label_end + 1) != Some(&'(') {
        return None;
    }
    let url_end = (label_end + 2..chars.len()).find(|&i| chars[i] == ')')?;
    let url = slice(chars, label_end + 2, url_end);
    if url.trim().is_empty() {
        return None;
    }
    Some((slice(chars, start + 1, label_end), url, url_end + 1))
}

/// `chars[a..b]` as a `String`.
fn slice(chars: &[char], a: usize, b: usize) -> String {
    chars[a..b].iter().collect()
}

// ─── Slack Web API response types (only the fields we use) ─────────────────────

/// The `{ok, error}` envelope every Slack Web API method answers with.
#[derive(Debug, Deserialize)]
struct ApiAck {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

impl ApiAck {
    /// Turn `ok:false` into an error naming the method, which is what an operator
    /// needs to see (`missing_scope`, `channel_not_found`, …).
    fn into_result(self, method: &str) -> anyhow::Result<()> {
        if self.ok {
            return Ok(());
        }
        anyhow::bail!(
            "slack {method} returned ok=false: {}",
            self.error.unwrap_or_default()
        )
    }
}

#[derive(Debug, Deserialize)]
struct ConnectionsOpenResponse {
    ok: bool,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AuthTestResponse {
    ok: bool,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UploadUrlResponse {
    ok: bool,
    #[serde(default)]
    upload_url: Option<String>,
    #[serde(default)]
    file_id: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

/// The Slack reaction name for `emoji`. A `:shortcode:` (or bare shortcode)
/// passes through; a Unicode emoji is translated for the common reactions,
/// since Slack's `reactions.*` methods accept names only.
fn slack_reaction_name(emoji: &str) -> Option<String> {
    let trimmed = emoji.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed
        .trim_matches(':')
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+'))
    {
        return Some(trimmed.trim_matches(':').to_owned());
    }
    let bare: String = trimmed.chars().filter(|c| *c != '\u{fe0f}').collect();
    let name = match bare.as_str() {
        "👀" => "eyes",
        "✅" => "white_check_mark",
        "❌" => "x",
        "👍" => "+1",
        "👎" => "-1",
        "👌" => "ok_hand",
        "🙏" => "pray",
        "❤" => "heart",
        "🔥" => "fire",
        "🎉" => "tada",
        "😂" => "joy",
        "🤣" => "rolling_on_the_floor_laughing",
        "😁" => "grin",
        "😄" => "smile",
        "😮" => "open_mouth",
        "😱" => "scream",
        "😢" => "cry",
        "😭" => "sob",
        "🤔" => "thinking_face",
        "👏" => "clap",
        "🙌" => "raised_hands",
        "💯" => "100",
        "🚀" => "rocket",
        "💪" => "muscle",
        "🤝" => "handshake",
        "🫡" => "saluting_face",
        "✍" => "writing_hand",
        "🥳" => "partying_face",
        "😅" => "sweat_smile",
        "😎" => "sunglasses",
        "🤯" => "exploding_head",
        "👋" => "wave",
        "⚡" => "zap",
        "🏆" => "trophy",
        _ => return None,
    };
    Some(name.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CommonChannelConfig, GroupReplyMode};

    fn make_cfg(app_token: &str, bot_token: &str) -> SlackChannelConfig {
        SlackChannelConfig {
            app_token: app_token.to_string(),
            bot_token: bot_token.to_string(),
            common: CommonChannelConfig {
                model: "gpt-4o".to_string(),
                ..Default::default()
            },
            options: SlackChannelOptions::default(),
        }
    }

    fn build(cfg: SlackChannelConfig) -> anyhow::Result<SlackChannel> {
        SlackChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
    }

    #[test]
    fn new_rejects_empty_app_token() {
        assert!(build(make_cfg("   ", "xoxb-1")).is_err());
    }

    #[test]
    fn new_rejects_empty_bot_token() {
        assert!(build(make_cfg("xapp-1", "")).is_err());
    }

    #[test]
    fn new_accepts_valid_tokens() {
        let mut cfg = make_cfg("xapp-1", "xoxb-1");
        cfg.common.system_prompt = Some("be terse".to_string());
        let channel = build(cfg).unwrap();
        assert_eq!(channel.name(), "slack");
        assert_eq!(channel.model(), "gpt-4o");
        assert_eq!(channel.system_prompt(), Some("be terse"));
    }

    #[test]
    fn new_stores_agent_id_and_core_url() {
        let mut cfg = make_cfg("xapp-1", "xoxb-1");
        cfg.common.agent_id = Some("acp:pi".to_string());
        cfg.common.core_url = "http://127.0.0.1:7980".to_string();
        let channel = build(cfg).unwrap();
        assert_eq!(channel.runtime().cfg.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(channel.runtime().cfg.core_url, "http://127.0.0.1:7980");
        // An agent id is what routes the bot through Core's session seam.
        assert!(channel.runtime().routes_via_core());
    }

    /// Slack declares the platform's real surface: threads, files, reactions and
    /// mrkdwn, but NOT a command menu (only the app manifest can register a slash
    /// command) and not streaming.
    #[test]
    fn caps_declare_what_slack_can_do() {
        let channel = build(make_cfg("xapp-1", "xoxb-1")).unwrap();
        let caps = channel.caps();
        assert!(caps.threads && caps.rich_text && caps.attachments && caps.reactions);
        assert!(caps.voice && caps.typing);
        assert!(!caps.command_menu, "slash commands are manifest-only");
        assert!(!caps.streaming, "slack has no draft surface");
    }

    // ─── Thread keys (previously `make_chat_id` / `split_chat_id`, now the
    // kernel's one shared convention) ──────────────────────────────────────────

    #[test]
    fn chat_id_round_trips_channel_and_thread() {
        let packed = pack_thread("C123", Some("169.45"));
        assert_eq!(packed, "C123:169.45");
        assert_eq!(unpack_thread(&packed), ("C123", Some("169.45")));
    }

    #[test]
    fn split_chat_id_without_thread() {
        assert_eq!(unpack_thread("C123"), ("C123", None));
    }

    /// A top-level message anchors its own thread; a message already in a thread
    /// answers in the PARENT's, never in a thread of a thread.
    #[test]
    fn thread_anchor_prefers_the_parent() {
        let top_level = pack_message_id("111.222", None);
        assert_eq!(top_level, "111.222");
        assert_eq!(thread_anchor(&top_level), "111.222");

        let in_thread = pack_message_id("333.444", Some("111.222"));
        assert_eq!(thread_anchor(&in_thread), "111.222");

        // Slack repeats `thread_ts` on the parent message itself; the anchor is
        // then the ts, packed only once.
        let parent = pack_message_id("111.222", Some("111.222"));
        assert_eq!(parent, "111.222");
        assert_eq!(thread_anchor(&parent), "111.222");
    }

    #[test]
    fn active_threads_expire_and_stay_bounded() {
        let t0 = Instant::now();
        let mut threads = HashMap::new();
        remember_active_thread(&mut threads, "C1:1.0".to_owned(), t0);
        assert!(thread_is_active(&threads, "C1:1.0", t0));
        assert!(thread_is_active(
            &threads,
            "C1:1.0",
            t0 + ACTIVE_THREAD_IDLE_TTL - Duration::from_secs(1)
        ));
        assert!(!thread_is_active(
            &threads,
            "C1:1.0",
            t0 + ACTIVE_THREAD_IDLE_TTL
        ));
        assert!(!thread_is_active(&threads, "C1:2.0", t0));

        // A reply refreshes the thread, so a live conversation never expires.
        remember_active_thread(
            &mut threads,
            "C1:1.0".to_owned(),
            t0 + Duration::from_secs(3600),
        );
        assert!(thread_is_active(
            &threads,
            "C1:1.0",
            t0 + ACTIVE_THREAD_IDLE_TTL
        ));

        // Remembering anything after the TTL drops the idle threads.
        remember_active_thread(
            &mut threads,
            "C1:3.0".to_owned(),
            t0 + ACTIVE_THREAD_IDLE_TTL * 2,
        );
        assert_eq!(threads.len(), 1);
        assert!(threads.contains_key("C1:3.0"));

        // The map never grows past the cap; the least recently used goes first.
        let mut threads = HashMap::new();
        for index in 0..=MAX_ACTIVE_THREADS {
            let seconds = u64::try_from(index).expect("index fits u64");
            remember_active_thread(
                &mut threads,
                format!("C1:{index}"),
                t0 + Duration::from_secs(seconds),
            );
        }
        assert_eq!(threads.len(), MAX_ACTIVE_THREADS);
        assert!(!threads.contains_key("C1:0"));
        assert!(threads.contains_key(&format!("C1:{MAX_ACTIVE_THREADS}")));

        // Refreshing an existing thread at the cap evicts nothing.
        let refreshed = t0 + Duration::from_secs(10_000);
        remember_active_thread(&mut threads, "C1:1".to_owned(), refreshed);
        assert_eq!(threads.len(), MAX_ACTIVE_THREADS);
        assert_eq!(threads.get("C1:1"), Some(&refreshed));
        // ...and the refreshed thread survives the next eviction.
        remember_active_thread(&mut threads, "C1:new".to_owned(), refreshed);
        assert!(threads.contains_key("C1:1"));
        assert!(!threads.contains_key("C1:2"));
    }

    #[test]
    fn conversation_key_packs_channel_and_thread() {
        assert_eq!(
            conversation_key("C999", Some(&pack_message_id("111.222", None))),
            "C999:111.222"
        );
        assert_eq!(
            conversation_key("C999", Some(&pack_message_id("333.444", Some("111.222")))),
            "C999:111.222"
        );
        // Idempotent: an already-packed key is not re-rooted.
        assert_eq!(
            conversation_key("C999:111.222", Some("999.999")),
            "C999:111.222"
        );
        // With nothing to anchor on, the channel itself is the conversation.
        assert_eq!(conversation_key("C999", None), "C999");
    }

    #[test]
    fn parse_envelope_id_reads_field() {
        let raw = json!({ "envelope_id": "abc-123", "type": "events_api" }).to_string();
        assert_eq!(parse_envelope_id(&raw).as_deref(), Some("abc-123"));
    }

    #[test]
    fn parse_inbound_extracts_message() {
        let raw = json!({
            "type": "events_api",
            "envelope_id": "e1",
            "payload": {
                "event": {
                "type": "message",
                    "channel": "C999",
                    "user": "U1",
                    "text": "hello bot",
                    "ts": "111.222"
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).unwrap();
        assert_eq!(inbound.text, "hello bot");
        // The chat id is the BARE channel — the group allowlist is keyed on it —
        // and the thread only appears in the conversation key.
        assert_eq!(inbound.channel, "C999");
        assert_eq!(inbound.sender_id.as_deref(), Some("U1"));
        assert_eq!(
            conversation_key(&inbound.channel, inbound.message_id.as_deref()),
            "C999:111.222"
        );
    }

    #[test]
    fn parse_inbound_prefers_existing_thread() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "subtype": "bot_message",
                    "channel": "C999",
                    "text": "in a thread",
                    "ts": "333.444",
                    "thread_ts": "111.222"
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).unwrap();
        assert_eq!(
            conversation_key(&inbound.channel, inbound.message_id.as_deref()),
            "C999:111.222"
        );
    }

    #[test]
    fn parse_inbound_ignores_bot_messages() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "bot_id": "B1",
                    "text": "i am a bot",
                    "ts": "1.2"
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).expect("bot messages remain available for allow_bots");
        assert!(inbound.is_bot);
        assert!(decide_reply_with_options(
            &inbound,
            GroupReplyMode::All,
            "U999",
            false,
            &SlackChannelOptions::default(),
        )
        .is_none());
    }

    #[test]
    fn parse_inbound_ignores_subtype_messages() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "subtype": "channel_join",
                    "channel": "C999",
                    "text": "joined",
                    "ts": "1.2"
                }
            }
        })
        .to_string();
        assert!(parse_inbound(&raw).is_none());
    }

    #[test]
    fn parse_inbound_ignores_non_events_frames() {
        let hello = json!({ "type": "hello" }).to_string();
        assert!(parse_inbound(&hello).is_none());
    }

    #[test]
    fn slash_commands_are_addressed_without_a_message_thread_anchor() {
        let raw = json!({
            "type": "slash_commands",
            "payload": {
                "command": "/hermes",
                "text": "status",
                "channel_id": "C999",
                "channel_name": "general",
                "user_id": "U1",
                "trigger_id": "123.456.789"
            }
        })
        .to_string();
        let inbound = parse_slash_command(&raw).unwrap();
        assert!(inbound.force_reply);
        assert_eq!(inbound.message_id, None);
        assert_eq!(
            conversation_key(&inbound.channel, inbound.message_id.as_deref()),
            "C999"
        );
        assert_eq!(
            decide_reply(&inbound, GroupReplyMode::Mentions, "UBOT", false).as_deref(),
            Some("/hermes status")
        );
    }

    /// Verify that the conversation key derived from `parse_inbound` is stable per
    /// channel/thread — the same raw frame always yields the same conversation_id
    /// so multi-turn context is preserved across messages in the same thread.
    #[test]
    fn parse_inbound_chat_id_stable_per_thread() {
        let frame = json!({
            "type": "events_api",
            "envelope_id": "e1",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "user": "U1",
                    "text": "turn two",
                    "ts": "555.666",
                    "thread_ts": "111.222"
                }
            }
        })
        .to_string();
        let key = |raw: &str| {
            let parsed = parse_inbound(raw).unwrap();
            conversation_key(&parsed.channel, parsed.message_id.as_deref())
        };
        // conversation_id must be deterministic for the same channel+thread…
        assert_eq!(key(&frame), key(&frame));
        // …and encode both the channel and the thread timestamp so Core can key
        // separate conversations per thread.
        assert_eq!(key(&frame), "C999:111.222");
    }

    /// Verify that two messages in different threads produce different
    /// conversation keys so their Core conversations are kept separate.
    #[test]
    fn parse_inbound_different_threads_get_different_chat_ids() {
        let frame = |ts: &str, thread: &str| {
            json!({
                "type": "events_api",
                "payload": {
                    "event": {
                        "type": "message",
                        "channel": "C999",
                        "text": "hello",
                        "ts": ts,
                        "thread_ts": thread
                    }
                }
            })
            .to_string()
        };
        let key = |raw: String| {
            let parsed = parse_inbound(&raw).unwrap();
            conversation_key(&parsed.channel, parsed.message_id.as_deref())
        };
        assert_ne!(key(frame("1.1", "1.0")), key(frame("2.1", "2.0")));
    }

    // ─── Media (a file upload arrives as subtype `file_share`, which the old
    // "any subtype ⇒ ignore" rule dropped on the floor) ─────────────────────────

    #[test]
    fn parse_inbound_accepts_a_caption_less_file_share() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "subtype": "file_share",
                    "channel": "C999",
                    "user": "U1",
                    "text": "",
                    "ts": "1.2",
                    "files": [{
                        "id": "F1",
                        "name": "diagram.png",
                        "mimetype": "image/png",
                        "size": 4096,
                        "url_private": "https://files.slack.com/private",
                        "url_private_download": "https://files.slack.com/download"
                    }]
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).unwrap();
        assert!(inbound.text.is_empty());
        let file = &inbound.attachments[0];
        // The download URL is preferred: it serves bytes, not the viewer page.
        assert_eq!(
            file.url.as_deref(),
            Some("https://files.slack.com/download")
        );
        assert_eq!(file.filename.as_deref(), Some("diagram.png"));
        assert_eq!(file.size, Some(4096));
        assert_eq!(file.resolved_kind(), AttachmentKind::Image);
    }

    #[test]
    fn parse_inbound_marks_a_voice_memo_as_speech() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "subtype": "file_share",
                    "channel": "D1",
                    "channel_type": "im",
                    "user": "U1",
                    "ts": "1.2",
                    "files": [{
                        "id": "F2",
                        "name": "audio_message.webm",
                        "mimetype": "audio/webm",
                        "subtype": "slack_audio",
                        "url_private": "https://files.slack.com/private"
                    }]
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).unwrap();
        assert_eq!(
            inbound.attachments[0].resolved_kind(),
            AttachmentKind::Voice
        );
        // A media-only DM still routes: the transcript becomes the prompt.
        assert_eq!(
            decide_reply(&inbound, GroupReplyMode::Mentions, "UBOT", false).as_deref(),
            Some("")
        );
    }

    #[test]
    fn parse_inbound_drops_an_empty_message_with_no_media() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": { "type": "message", "channel": "C999", "text": "   ", "ts": "1.2" }
            }
        })
        .to_string();
        assert!(parse_inbound(&raw).is_none());
    }

    // ─── Group-reply gate (group_reply_mode was previously dropped on the floor:
    // the adapter answered EVERY channel message regardless of the admin's
    // choice in the setup form) ────────────────────────────────────────────────

    fn inbound(text: &str, is_dm: bool) -> SlackInbound {
        SlackInbound {
            channel: if is_dm { "D1".into() } else { "C1".into() },
            text: text.to_string(),
            is_dm,
            sender_id: Some("U1".to_string()),
            message_id: Some("1.0".to_string()),
            attachments: Vec::new(),
            force_reply: false,
            is_bot: false,
        }
    }

    fn channel_msg(text: &str) -> SlackInbound {
        inbound(text, false)
    }

    fn dm(text: &str) -> SlackInbound {
        inbound(text, true)
    }

    #[test]
    fn parse_inbound_flags_a_dm_via_channel_type() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel_type": "im",
                    "channel": "D1",
                    "user": "U1",
                    "text": "hi",
                    "ts": "1.1"
                }
            }
        })
        .to_string();
        assert!(parse_inbound(&raw).unwrap().is_dm);
    }

    /// The failure direction matters: an event with NO `channel_type` must be
    /// treated as a group, or a pairing code could be posted in public.
    #[test]
    fn parse_inbound_treats_an_unlabelled_channel_as_a_group() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "user": "U1",
                    "text": "hi",
                    "ts": "1.1"
                }
            }
        })
        .to_string();
        assert!(!parse_inbound(&raw).unwrap().is_dm);
    }

    /// The loop guard the file-upload path made necessary: a file the bot itself
    /// shared arrives back as an inbound `file_share`, and answering it would
    /// transcribe the bot's own voice note and reply to it forever.
    #[test]
    fn a_message_the_bot_wrote_is_never_answered() {
        assert!(is_self_authored(Some("UBOT"), "UBOT"));
        assert!(!is_self_authored(Some("U1"), "UBOT"));
        assert!(!is_self_authored(None, "UBOT"));
        // Fail-open: with no known identity nothing is dropped as "our own",
        // exactly as the mention gate degrades.
        assert!(!is_self_authored(Some("UBOT"), ""));
        assert!(!is_self_authored(None, ""));
    }

    /// THE BITE: in `Mentions` mode an un-addressed channel message is now
    /// dropped. Before this gate existed the adapter routed it to the agent.
    #[test]
    fn mentions_mode_ignores_unaddressed_channel_message() {
        let msg = channel_msg("just chatting with my colleague");
        assert!(decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).is_none());
    }

    #[test]
    fn mentions_mode_answers_when_mentioned_and_strips_the_mention() {
        let msg = channel_msg("<@UBOT> what's   up");
        let routed = decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).unwrap();
        assert_eq!(routed, "what's up");

        // The `<@U…|name>` form Slack also emits.
        let piped = channel_msg("<@UBOT|ryu> hi");
        assert_eq!(
            decide_reply(&piped, GroupReplyMode::Mentions, "UBOT", false).unwrap(),
            "hi"
        );
    }

    /// A mention of SOMEONE ELSE is not a mention of the bot.
    #[test]
    fn mentions_mode_ignores_a_mention_of_another_user() {
        let msg = channel_msg("<@USOMEONE> can you look at this?");
        assert!(decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).is_none());
    }

    /// Once the bot is in a thread, follow-ups continue without a re-mention.
    #[test]
    fn mentions_mode_continues_an_active_thread_without_a_mention() {
        let msg = channel_msg("and what about tuesday?");
        let routed = decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", true).unwrap();
        assert_eq!(routed, "and what about tuesday?");
    }

    #[test]
    fn all_mode_answers_every_channel_message() {
        let msg = channel_msg("just chatting");
        assert_eq!(
            decide_reply(&msg, GroupReplyMode::All, "UBOT", false).unwrap(),
            "just chatting"
        );
    }

    #[test]
    fn dms_always_answer_regardless_of_mode() {
        let msg = dm("hello");
        assert_eq!(
            decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).unwrap(),
            "hello"
        );
    }

    /// Fail-open: `auth.test` failed, so the gate cannot be evaluated. A scope gap
    /// must not silently turn an over-chatty bot into a dead one.
    #[test]
    fn unknown_bot_id_fails_open_in_mentions_mode() {
        let msg = channel_msg("just chatting");
        assert_eq!(
            decide_reply(&msg, GroupReplyMode::Mentions, "", false).unwrap(),
            "just chatting"
        );
        // ...and an empty bot id never matches a bare mention of anyone.
        assert!(!mentions_bot("<@USOMEONE> hey", ""));
    }

    /// A message that is ONLY a mention carries no prompt — nothing to route.
    #[test]
    fn mention_only_message_is_dropped() {
        let msg = channel_msg("<@UBOT>");
        assert!(decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).is_none());
    }

    /// …unless it carries media, which IS the prompt.
    #[test]
    fn mention_with_media_and_no_text_is_routed() {
        let mut msg = channel_msg("<@UBOT>");
        msg.attachments.push(Attachment {
            kind: Some(AttachmentKind::Image),
            filename: Some("chart.png".into()),
            ..Default::default()
        });
        assert_eq!(
            decide_reply(&msg, GroupReplyMode::Mentions, "UBOT", false).as_deref(),
            Some("")
        );
    }

    // ─── Reconnect backoff (was a fixed 3s with no cap, no jitter and no attempt
    // counter: a permanently-failing apps.connections.open hot-looped forever) ──

    #[test]
    fn backoff_grows_exponentially_and_is_capped() {
        assert_eq!(backoff_for(1), RECONNECT_BASE_BACKOFF);
        assert_eq!(backoff_for(2), Duration::from_secs(6));
        assert_eq!(backoff_for(3), Duration::from_secs(12));
        assert_eq!(backoff_for(4), Duration::from_secs(24));
        assert_eq!(backoff_for(5), Duration::from_secs(48));
        // Capped from here on — never unbounded, never a tight loop.
        assert_eq!(backoff_for(6), RECONNECT_MAX_BACKOFF);
        assert_eq!(backoff_for(MAX_RECONNECT_ATTEMPTS), RECONNECT_MAX_BACKOFF);
        assert_eq!(backoff_for(u32::MAX), RECONNECT_MAX_BACKOFF);
    }

    #[test]
    fn backoff_is_never_shorter_than_the_base_and_jitter_stays_bounded() {
        for attempt in 1..=MAX_RECONNECT_ATTEMPTS {
            let base = backoff_for(attempt);
            let delay = reconnect_delay(attempt);
            assert!(delay >= base, "jitter must never shorten the backoff");
            // Jitter adds at most 25% on top, so a fleet never re-opens in lockstep
            // yet the delay stays predictable.
            assert!(delay <= base + base / 4 + Duration::from_millis(1));
            assert!(delay >= RECONNECT_BASE_BACKOFF);
        }
    }

    /// The attempt budget is finite — that is what turns a permanent failure
    /// (an app token without `connections:write`) into a reported error instead
    /// of an infinite retry loop.
    #[test]
    fn reconnect_budget_is_bounded() {
        const {
            assert!(MAX_RECONNECT_ATTEMPTS > 0);
        }
        let total: Duration = (1..MAX_RECONNECT_ATTEMPTS).map(backoff_for).sum();
        // Generous enough to ride out a real outage, finite enough to surface a
        // permanent misconfiguration to the operator.
        assert!(
            total >= Duration::from_secs(60),
            "budget too eager to give up"
        );
        assert!(
            total <= Duration::from_secs(15 * 60),
            "budget never terminates"
        );
    }

    #[test]
    fn strip_mentions_collapses_whitespace_and_keeps_stray_text() {
        assert_eq!(strip_mentions("<@U1> hey   there"), "hey there");
        assert_eq!(strip_mentions("no mentions"), "no mentions");
        // An unterminated mention is left alone rather than eating the message.
        assert_eq!(strip_mentions("<@U1 unterminated"), "<@U1 unterminated");
    }

    // ─── mrkdwn conversion ─────────────────────────────────────────────────────

    /// The conversion that a sequential two-pass implementation gets wrong:
    /// `**bold**` becomes `*bold*`, and the `*bold*` it just produced must NOT
    /// then be re-read as an italic.
    #[test]
    fn mrkdwn_converts_bold_without_re_reading_its_own_output() {
        assert_eq!(to_mrkdwn("**bold**"), "*bold*");
        assert_eq!(to_mrkdwn("__bold__"), "*bold*");
        assert_eq!(to_mrkdwn("*italic*"), "_italic_");
        assert_eq!(to_mrkdwn("**bold** and *italic*"), "*bold* and _italic_");
        // Already-mrkdwn emphasis survives untouched.
        assert_eq!(to_mrkdwn("_italic_"), "_italic_");
        assert_eq!(to_mrkdwn("~~gone~~"), "~gone~");
    }

    /// A lone asterisk is arithmetic or a footnote, not markup.
    #[test]
    fn mrkdwn_leaves_unmatched_emphasis_alone() {
        assert_eq!(to_mrkdwn("2 * 3 = 6"), "2 * 3 = 6");
        assert_eq!(to_mrkdwn("a *dangling marker"), "a *dangling marker");
    }

    #[test]
    fn mrkdwn_rewrites_links_and_escapes_around_them() {
        assert_eq!(
            to_mrkdwn("see [the docs](https://example.com/a?b=1&c=2)"),
            "see <https://example.com/a?b=1&amp;c=2|the docs>"
        );
        // A bare `<` in prose is escaped, or Slack reads it as its own syntax.
        assert_eq!(to_mrkdwn("a < b && c > d"), "a &lt; b &amp;&amp; c &gt; d");
    }

    #[test]
    fn mrkdwn_passes_code_through_untouched() {
        assert_eq!(to_mrkdwn("call `a ** b` now"), "call `a ** b` now");
        let fenced = "before\n```rust\nlet x = **y;\n```\nafter";
        // The info string goes (Slack has no highlighting) and the body is verbatim.
        assert_eq!(to_mrkdwn(fenced), "before\n```\nlet x = **y;\n```\nafter");
    }

    /// A `#` without whitespace after it is a channel reference, not a heading.
    #[test]
    fn mrkdwn_leaves_a_channel_reference_alone() {
        assert_eq!(to_mrkdwn("ask in #general"), "ask in #general");
        assert_eq!(to_mrkdwn("#general is quiet"), "#general is quiet");
    }

    #[test]
    fn mrkdwn_maps_block_constructs_slack_lacks() {
        assert_eq!(to_mrkdwn("## Results"), "*Results*");
        // Emphasis inside a heading is dropped, not nested — Slack cannot render
        // nested asterisks.
        assert_eq!(to_mrkdwn("# A **bold** title"), "*A bold title*");
        assert_eq!(to_mrkdwn("- one\n  - two"), "• one\n  • two");
        assert_eq!(to_mrkdwn("* starred item"), "• starred item");
        assert_eq!(to_mrkdwn("> quoted **thing**"), "> quoted *thing*");
        // Tables have no equivalent at all, so the rows are left as written.
        assert_eq!(to_mrkdwn("| a | b |"), "| a | b |");
    }

    #[test]
    fn mrkdwn_preserves_line_structure() {
        assert_eq!(to_mrkdwn("one\n\ntwo\n"), "one\n\ntwo\n");
        assert_eq!(to_mrkdwn(""), "");
    }

    /// A wall of markers must not recurse, hang, or grow the output. The scan is
    /// linear and the nesting ceiling bounds the closer stack, so asterisk soup
    /// simply collapses to the mrkdwn spelling of the same (meaningless) emphasis.
    #[test]
    fn mrkdwn_survives_pathological_emphasis() {
        let noisy = "*".repeat(200);
        assert!(to_mrkdwn(&noisy).chars().count() <= noisy.chars().count());
        // Whatever the markers do, the words between them must survive.
        let mixed = format!("{m}a{m}b{m}c{m}", m = "*_~");
        assert!(["a", "b", "c"]
            .iter()
            .all(|word| to_mrkdwn(&mixed).contains(word)));
    }
}

#[cfg(test)]
mod reaction_name_tests {
    use super::slack_reaction_name;

    #[test]
    fn unicode_reactions_become_slack_shortcodes() {
        // Slack's `reactions.add` takes names only; sending "👀" as a name was
        // refused with `invalid_name`, so the working marker never appeared.
        assert_eq!(slack_reaction_name("👀").as_deref(), Some("eyes"));
        assert_eq!(slack_reaction_name("👍").as_deref(), Some("+1"));
        assert_eq!(slack_reaction_name("❤️").as_deref(), Some("heart"));
        assert_eq!(slack_reaction_name("❌").as_deref(), Some("x"));
    }

    #[test]
    fn shortcodes_pass_through_and_unknown_emoji_are_skipped() {
        assert_eq!(
            slack_reaction_name(":white_check_mark:").as_deref(),
            Some("white_check_mark")
        );
        assert_eq!(slack_reaction_name("+1").as_deref(), Some("+1"));
        assert_eq!(slack_reaction_name("🦀"), None);
        assert_eq!(slack_reaction_name("  "), None);
    }
}
