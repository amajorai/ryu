//! Telegram channel adapter — the reference implementation of [`Channel`].
//!
//! Registers a bot via its token and uses the Bot API `getUpdates` long-polling
//! endpoint to receive messages — no public webhook URL required, which is what
//! makes a bot on a laptop work at all.
//!
//! Telegram is the richest surface Ryu speaks to, so this adapter overrides most
//! of the optional [`Channel`] verbs: forum topics, rich-text replies, ephemeral
//! streaming drafts, a native command menu, a bot profile, voice round trips,
//! reactions and guest queries. Everything *between* the transport and those
//! verbs — the access gate, media ingest, the Core call, reply delivery — lives
//! in [`handle_turn`] and is deliberately not re-derived here.
//!
//! # Two ids, one conversation key
//!
//! A Telegram reply may need up to three ids: the chat, and — inside a forum
//! supergroup or a direct-messages chat — the topic within it. Core takes one
//! opaque `conversation_id`, so the topic is packed into the chat id with
//! [`pack_thread`] and a one-character tag (`t` = `message_thread_id`,
//! `d` = `direct_messages_topic_id`). Every `send_*` therefore receives a PACKED
//! key and unpacks it before touching the API. The payoff is that each topic
//! keeps its own Core history instead of all of them sharing the room's.
//!
//! # Guest queries
//!
//! `Update.guest_message` arrives from someone who is not in a chat with the bot.
//! The reply goes out through `answerGuestQuery`, not `sendMessage`, and the
//! docs warn the guest chat id "may not coincide with other existing bot chats
//! sharing the same identifier" — so the conversation is keyed on the guest query
//! id (prefixed [`GUEST_KEY_PREFIX`]) and the chat id is never reused. The guest
//! key is checked first in every verb that would otherwise parse a numeric chat.
//!
//! # `ok: false` is not an HTTP error
//!
//! The Bot API answers a rejected call with **HTTP 200** and `{"ok":false}`. A
//! send whose failure must be detected (so the rich-text path can fall back to
//! plain text) therefore has to parse the envelope, which is what [`ApiEnvelope`]
//! and `TelegramChannel::call` exist for. Checking only the status code would
//! turn "the server does not know `sendRichMessage`" into a silently dropped
//! reply.

use std::sync::{Arc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Router,
};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tracing::{debug, info, warn};

use crate::commands::{self, ChannelCommand};
use crate::media::{self, Attachment, AttachmentKind, VoiceDelivery};
use crate::pairing::PairingStore;
use crate::status::StatusReporter;
use crate::{
    claim_inbound_delivery, handle_turn_with_delivery, is_token_rejected, pack_thread,
    run_claimed_delivery, scoped_delivery_id, unpack_thread, BotProfile, Channel, ChannelCaps,
    ChannelHost, ChannelRuntime, ChannelTurnOutcome, GroupReplyMode, InboundMessage,
    InteractiveAction, InteractiveLayout, InteractiveMarkup, TelegramChannelConfig, TokenRejected,
};
use ryu_channel_contracts::{decode_callback_data, encode_callback_data};

/// Seconds the Telegram server holds an open `getUpdates` request waiting for
/// new messages (server-side long poll). Keeps request volume low.
const LONG_POLL_SECS: u64 = 25;

/// Cooldown before retrying after a transport error, so a flaky network or a
/// transient Telegram outage doesn't become a tight failure loop.
const ERROR_BACKOFF: Duration = Duration::from_secs(3);

/// How often the typing indicator is re-asserted. `sendChatAction` expires after
/// **5 seconds**, so anything slower leaves visible gaps mid-answer.
const TYPING_INTERVAL: Duration = Duration::from_secs(4);

/// Longest Telegram flood-control wait (`parameters.retry_after`) that one Bot
/// API call sits out before its single in-place retry. A longer wait fails the
/// call instead of holding a turn slot for minutes; the delivery ledger and the
/// provider stay the outer retry.
const MAX_INLINE_RETRY_AFTER: Duration = Duration::from_secs(30);

/// Marks a conversation key that belongs to a guest query rather than a chat.
/// `#` (not `:`) so [`unpack_thread`] never mistakes the query id for a topic.
const GUEST_KEY_PREFIX: &str = "guest#";

/// Tag for a `message_thread_id` (forum topic) inside a packed conversation key.
const TOPIC_TAG: char = 't';

/// Tag for a `direct_messages_topic_id` inside a packed conversation key.
const DM_TOPIC_TAG: char = 'd';

pub struct TelegramChannel {
    /// `https://api.telegram.org/bot<TOKEN>` — carries the token, never logged.
    api_base: String,
    /// `https://api.telegram.org/file/bot<TOKEN>` — the download root that
    /// `getFile`'s `file_path` is resolved against.
    file_base: String,
    options: crate::TelegramChannelOptions,
    /// Core route, access policy, pairing store, command cache.
    runtime: ChannelRuntime,
}

impl TelegramChannel {
    /// `setMessageReaction` with an explicit reaction list (empty clears).
    async fn set_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        reaction: Value,
    ) -> anyhow::Result<()> {
        let (chat, _) = target(chat_id)?;
        let message_id: i64 = message_id
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid telegram message id: {message_id}"))?;
        self.call(
            "setMessageReaction",
            json!({ "chat_id": chat, "message_id": message_id, "reaction": reaction }),
        )
        .await?;
        Ok(())
    }
    /// Build an adapter with no liveness reporting (env-configured bots).
    ///
    /// `pairing` is a REQUIRED parameter on BOTH constructors rather than an
    /// option with a default: the store is per-node shared state, so every
    /// adapter on a node must be handed the *same* one. Defaulting it here would
    /// let the wiring layer give each channel a private store, and approvals
    /// would then neither persist nor be visible to the other channels — a bug
    /// that is easy to write and hard to see. Making it explicit makes it
    /// unrepresentable; a caller that genuinely wants process-lifetime pairings
    /// (tests) says so by passing [`PairingStore::ephemeral`].
    pub fn new(
        cfg: TelegramChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
    ) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, pairing, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats
    /// its connection status back to the control plane.
    pub fn new_with_status(
        cfg: TelegramChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        if cfg.token.trim().is_empty() {
            anyhow::bail!("telegram channel token is empty");
        }
        let options = cfg.options;
        if options.webhook_url.is_some()
            && options
                .webhook_secret
                .as_deref()
                .is_none_or(|secret| secret.trim().is_empty())
        {
            anyhow::bail!("telegram webhook mode requires a non-empty webhook_secret");
        }
        let api_base_url = api_base(options.base_url.as_deref(), &cfg.token, false);
        let file_base = api_base(options.base_file_url.as_deref(), &cfg.token, true);
        Ok(Self {
            api_base: api_base_url,
            file_base,
            options,
            runtime: ChannelRuntime::new(http, cfg.common, pairing, status),
        })
    }

    /// POST one Bot API method and return its `result`, treating `ok: false` as
    /// an error even though it arrives with HTTP 200.
    ///
    /// A flood-control answer (HTTP 429 / `error_code: 429`) whose
    /// `retry_after` is at most [`MAX_INLINE_RETRY_AFTER`] is waited out and the
    /// same call retried once (see [`retry_delay`]). Failing instead would make
    /// the delivery ledger re-run the whole turn sooner than Telegram allows,
    /// resending every chunk that already went out.
    ///
    /// # Errors
    /// Returns `Err` on transport failure, a non-2xx, or an `ok: false` envelope
    /// (carrying Telegram's `description`, which is the only useful diagnostic).
    async fn call(&self, method: &str, body: Value) -> anyhow::Result<Value> {
        let url = format!("{}/{method}", self.api_base);
        let mut waited_for_flood_control = false;
        loop {
            let resp = self
                .runtime
                .http
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(reqwest::Error::without_url)?;
            let status = resp.status();
            // A 429 carries the envelope with `retry_after`; every other non-2xx
            // keeps failing on its status as before.
            let resp = if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                resp
            } else {
                resp.error_for_status()
                    .map_err(reqwest::Error::without_url)?
            };
            let envelope: ApiEnvelope = match resp.json().await {
                Ok(envelope) => envelope,
                // A 429 that is not a Bot API envelope (a proxy page) still
                // reports its status, as `error_for_status` did before.
                Err(_) if status == reqwest::StatusCode::TOO_MANY_REQUESTS => {
                    anyhow::bail!("telegram {method} rate limited (HTTP 429) with no retry_after")
                }
                Err(error) => return Err(error.without_url().into()),
            };
            if envelope.ok {
                return Ok(envelope.result.unwrap_or(Value::Null));
            }
            if !waited_for_flood_control {
                if let Some(delay) = retry_delay(status, &envelope) {
                    warn!(
                        method,
                        retry_after_secs = delay.as_secs(),
                        "telegram flood control; waiting before one retry"
                    );
                    waited_for_flood_control = true;
                    tokio::time::sleep(delay).await;
                    continue;
                }
            }
            anyhow::bail!(
                "telegram {method} rejected: {}",
                envelope
                    .description
                    .unwrap_or_else(|| "ok=false with no description".to_string())
            );
        }
    }

    async fn send_text_with_ids(&self, chat_id: &str, text: &str) -> anyhow::Result<Vec<String>> {
        if let Some(query_id) = guest_query_of(chat_id) {
            self.call("answerGuestQuery", guest_reply_payload(query_id, text))
                .await?;
            return Ok(Vec::new());
        }
        let (chat, thread) = target(chat_id)?;
        self.send_plain_chunks(chat, thread, &split_message(text, 4096))
            .await
    }

    /// Send already-split chunks as plain `sendMessage` calls, in order, and
    /// return the message ids Telegram assigned.
    async fn send_plain_chunks(
        &self,
        chat: i64,
        thread: Option<&str>,
        chunks: &[String],
    ) -> anyhow::Result<Vec<String>> {
        let mut ids = Vec::new();
        for chunk in chunks {
            let result = self
                .call("sendMessage", message_payload(chat, thread, chunk))
                .await?;
            if let Some(message_id) = result.get("message_id").and_then(Value::as_i64) {
                ids.push(message_id.to_string());
            }
        }
        Ok(ids)
    }

    async fn send_rich_with_ids(
        &self,
        chat_id: &str,
        markdown: &str,
    ) -> anyhow::Result<Vec<String>> {
        if guest_query_of(chat_id).is_some() {
            return self.send_text_with_ids(chat_id, markdown).await;
        }
        let (chat, thread) = target(chat_id)?;
        let chunks = split_message(markdown, 4096);
        let mut ids = Vec::new();
        for (index, chunk) in chunks.iter().enumerate() {
            match self
                .call("sendRichMessage", rich_payload(chat, thread, chunk))
                .await
            {
                Ok(result) => {
                    if let Some(message_id) = result.get("message_id").and_then(Value::as_i64) {
                        ids.push(message_id.to_string());
                    }
                }
                Err(error) => {
                    warn!(
                        %error,
                        chunk = index,
                        "telegram sendRichMessage failed; sending the rest as plain text"
                    );
                    // Chunks before `index` were already delivered; resending
                    // the whole reply would show them to the user twice.
                    let rest = self
                        .send_plain_chunks(chat, thread, &chunks[index..])
                        .await?;
                    ids.extend(rest);
                    return Ok(ids);
                }
            }
        }
        Ok(ids)
    }

    /// Fetch the bot's own identity (`getMe`).
    ///
    /// Beyond the id and `@username` that group-mention detection needs, this is
    /// where the two bot-level feature flags surface: `has_topics_enabled` (forum
    /// topic mode in private chats) and `supports_guest_queries`. Both are logged
    /// at startup because a silently-unsupported feature is otherwise diagnosed
    /// only by "the bot ignores me".
    async fn get_me(&self) -> anyhow::Result<BotIdentity> {
        let result = self.call("getMe", json!({})).await?;
        let me: BotUser = serde_json::from_value(result)?;
        Ok(BotIdentity {
            id: me.id,
            username: me.username,
            has_topics_enabled: me.has_topics_enabled,
            supports_guest_queries: me.supports_guest_queries,
        })
    }

    /// Fetch the next batch of updates starting at `offset` (long poll).
    ///
    /// # Errors
    /// A rejected credential comes back as [`TokenRejected`] rather than a plain
    /// transport error, because the run loop must stop instead of back off (see
    /// [`is_unauthorized`]). Every other failure is an ordinary `Err`.
    ///
    /// Transport errors are stripped of their URL first: reqwest's `Display`
    /// unconditionally appends the request URL, and this one is
    /// `.../bot<TOKEN>/getUpdates` — so the string that the error arm logs and
    /// ships to the control plane would otherwise carry the bot token.
    async fn get_updates(&self, offset: i64) -> anyhow::Result<Vec<Update>> {
        let url = format!("{}/getUpdates", self.api_base);
        let resp = self
            .runtime
            .http
            .get(&url)
            .query(&[
                ("offset", offset.to_string()),
                ("timeout", LONG_POLL_SECS.to_string()),
                (
                    "allowed_updates",
                    "[\"message\",\"guest_message\",\"message_reaction\",\"callback_query\"]"
                        .to_owned(),
                ),
            ])
            // Allow the client a little longer than the server-side long poll.
            .timeout(Duration::from_secs(LONG_POLL_SECS + 10))
            .send()
            .await
            .map_err(reqwest::Error::without_url)?;

        // Read the status BEFORE `error_for_status`, which collapses a 401 into
        // an opaque error and never lets the body be parsed.
        let status = resp.status();
        if is_unauthorized(Some(status), None) {
            return Err(TokenRejected.into());
        }
        let resp = resp
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;

        let body: GetUpdatesResponse = resp.json().await.map_err(reqwest::Error::without_url)?;
        if !body.ok {
            // The Bot API also rejects a dead token with HTTP 200 +
            // `{"ok":false,"error_code":401}`, so the envelope gets the same rule.
            if is_unauthorized(None, body.error_code) {
                return Err(TokenRejected.into());
            }
            anyhow::bail!("telegram getUpdates returned ok=false");
        }
        Ok(body.result)
    }

    /// Resolve and download every SPEECH attachment, returning
    /// `(index, bytes)` pairs for [`ChannelRuntime::ingest_media`].
    ///
    /// Only speech is fetched: `ingest_media` skips anything else, and
    /// [`handle_turn`] annotates images and documents from their metadata alone,
    /// so downloading a 20 MB video would buy nothing. Failures are logged and the
    /// attachment is skipped — one unreadable file must not lose the turn.
    async fn download_speech(&self, attachments: &[Attachment]) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        for (index, attachment) in attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            // Refuse an oversized file on the declared size, before spending the
            // bandwidth; `media::download` re-checks what actually arrives.
            if let Some(size) = attachment.size {
                if size as usize > media::MAX_ATTACHMENT_BYTES {
                    warn!(
                        size,
                        "telegram attachment exceeds the size cap; skipping download"
                    );
                    continue;
                }
            }
            let Some(file_id) = attachment.file_id.as_deref() else {
                continue;
            };
            let path = match self.call("getFile", json!({ "file_id": file_id })).await {
                Ok(result) => result["file_path"].as_str().map(str::to_string),
                Err(err) => {
                    warn!(%err, "telegram getFile failed; attachment skipped");
                    continue;
                }
            };
            let Some(path) = path else {
                warn!("telegram getFile returned no file_path; attachment skipped");
                continue;
            };
            if self.options.local_mode {
                match tokio::fs::read(&path).await {
                    Ok(bytes) if bytes.len() <= media::MAX_ATTACHMENT_BYTES => {
                        out.push((index, bytes));
                    }
                    Ok(_) => warn!("telegram local attachment exceeds the size cap"),
                    Err(err) => warn!(%err, "telegram local attachment read failed"),
                }
            } else {
                let url = format!("{}/{path}", self.file_base);
                match media::download(&self.runtime.http, &url, &[]).await {
                    Ok(bytes) => out.push((index, bytes)),
                    Err(err) => warn!(%err, "telegram attachment download failed"),
                }
            }
        }
        out
    }

    /// Show a "Thinking…" draft, ingest media, then run the shared path — all on
    /// a dedicated task so a slow agent call never stalls polling for other chats.
    ///
    /// The draft goes FIRST, before the download and transcription of a voice
    /// note, because that is the slowest stretch of the turn (media I/O allows
    /// itself two minutes) and the one with no other feedback: the typing
    /// keepalive does not start until [`handle_turn`] reaches its agent call.
    ///
    /// Both the draft and the media round trip therefore run BEFORE the access
    /// gate, which lives inside `handle_turn` along with the Core call and the
    /// send. Two consequences worth stating rather than discovering: an unpaired
    /// stranger sees "Thinking…" a beat ahead of the pairing prompt, and their
    /// voice note costs one Core STT call before being refused. Avoiding either
    /// would mean re-implementing the gate out here, which is exactly what this
    /// kernel exists to prevent.
    fn spawn_turn(
        self: &Arc<Self>,
        host: Arc<dyn ChannelHost>,
        message: InboundMessage,
        draft: Option<i64>,
        provider_id: String,
        claimed_delivery_id: Option<String>,
    ) {
        let channel = Arc::clone(self);
        tokio::spawn(async move {
            let (delivery_id, claim) = if let Some(delivery_id) = claimed_delivery_id {
                (delivery_id, crate::pairing::DeliveryClaim::Claimed)
            } else {
                match claim_inbound_delivery(&*channel, &provider_id).await {
                    Ok(result) => result,
                    Err(error) => {
                        warn!(
                            channel = "telegram",
                            %error,
                            "telegram delivery could not be durably claimed; processing once without dedupe"
                        );
                        (
                            scoped_delivery_id(&*channel, &provider_id),
                            crate::pairing::DeliveryClaim::Claimed,
                        )
                    }
                }
            };
            if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
                debug!(
                    channel = "telegram",
                    delivery_id = %delivery_id,
                    ?claim,
                    "duplicate telegram delivery suppressed"
                );
                return;
            }

            let mut message = message;
            // A stranger should see the pairing prompt, not a "Thinking…" draft and
            // a transcription bill. Both of those run ahead of `handle_turn`'s
            // authoritative gate, so consult its read-only twin first.
            let admitted = channel
                .runtime
                .already_admitted(channel.name(), &message)
                .await;
            if admitted {
                if let Some(draft_id) = draft {
                    if let Err(err) = channel.send_draft(&message.chat_id, draft_id, "").await {
                        debug!(%err, "telegram draft placeholder not shown");
                    }
                }
                if !message.attachments.is_empty() {
                    let downloaded = channel.download_speech(&message.attachments).await;
                    channel.runtime.ingest_media(&mut message, downloaded).await;
                }
            }
            let work_channel = Arc::clone(&channel);
            let work_host = Arc::clone(&host);
            let work_delivery_id = delivery_id.clone();
            run_claimed_delivery(channel, delivery_id, move || {
                let channel = Arc::clone(&work_channel);
                let host = Arc::clone(&work_host);
                let message = message.clone();
                let delivery_id = work_delivery_id.clone();
                async move {
                    handle_turn_with_delivery(channel, host, message, Some(&delivery_id)).await
                }
            })
            .await;
        });
    }

    /// Normalize and dispatch one update. Keeping this separate means webhook
    /// delivery and long polling share exactly the same mention, topic, guest,
    /// media and access behavior.
    fn dispatch_update(
        self: &Arc<Self>,
        host: Arc<dyn ChannelHost>,
        update: Update,
        me: &BotIdentity,
        claimed_delivery_id: Option<String>,
    ) {
        let provider_id = format!("update:{}", update.update_id);
        if let Some(guest) = update.guest_message {
            if self.options.guest_mode {
                if let Some(inbound) = guest_inbound(&guest) {
                    self.spawn_turn(host, inbound, None, provider_id, claimed_delivery_id);
                } else {
                    warn!("telegram guest_message had no guest_query_id; dropped");
                    complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                }
            } else {
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            }
            return;
        }

        if let Some(reaction) = update.message_reaction {
            if self.runtime.cfg.reaction_learning.enabled {
                spawn_reaction_delivery(
                    Arc::clone(self),
                    reaction,
                    me.id,
                    provider_id,
                    claimed_delivery_id,
                );
            } else {
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            }
            return;
        }

        if let Some(callback) = update.callback_query {
            let callback_id = callback.id.clone();
            let channel = Arc::clone(self);
            tokio::spawn(async move {
                if let Err(error) = channel
                    .call(
                        "answerCallbackQuery",
                        json!({ "callback_query_id": callback_id }),
                    )
                    .await
                {
                    debug!(%error, "telegram callback acknowledgement failed");
                }
            });

            let Some(data) = callback.data.as_deref() else {
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                return;
            };
            let action = match decode_callback_data(data) {
                Ok(action) => action,
                Err(error) => {
                    debug!(%error, "telegram callback data was not issued by Ryu");
                    complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                    return;
                }
            };
            let Some(message) = callback.message else {
                // Inline-mode messages have no chat id, so this channel session
                // cannot safely route them to the originating conversation.
                complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
                return;
            };
            let mut action = action;
            if let Some(label) = callback_button_label(&message, data) {
                action.label = label;
            }
            let thread = thread_of(&message);
            let inbound = InboundMessage {
                chat_id: pack_thread(&message.chat.id.to_string(), thread.as_deref()),
                access_chat_id: is_group_chat(&message.chat.chat_type)
                    .then(|| message.chat.id.to_string()),
                text: format!("Selected: {}", action.label),
                author_name: (!callback.from.first_name.is_empty())
                    .then_some(callback.from.first_name),
                sender_id: Some(callback.from.id.to_string()),
                message_id: (message.message_id != 0).then(|| message.message_id.to_string()),
                is_group: is_group_chat(&message.chat.chat_type),
                channel_action: Some(action),
                ..Default::default()
            };
            self.spawn_turn(host, inbound, None, provider_id, claimed_delivery_id);
            return;
        }

        let Some(message) = update.message else {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        };
        let raw_text = message
            .text
            .clone()
            .or_else(|| message.caption.clone())
            .unwrap_or_default();
        let attachments = attachments_from(&message);
        if raw_text.trim().is_empty() && attachments.is_empty() {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        }
        let Some(routed_text) = decide_reply_with_options(
            &message,
            &raw_text,
            me,
            self.runtime.cfg.group_reply_mode,
            &self.options,
        ) else {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        };
        let thread = thread_of(&message);
        if self.options.ignored_threads.iter().any(|ignored| {
            let ignored = ignored.trim();
            thread.as_deref() == Some(ignored)
                || thread
                    .as_deref()
                    .and_then(|value| value.get(1..))
                    .is_some_and(|value| value == ignored)
        }) {
            complete_claimed_delivery(Arc::clone(self), claimed_delivery_id);
            return;
        }
        let chat_id = pack_thread(&message.chat.id.to_string(), thread.as_deref());
        let is_private = message.chat.chat_type == "private";
        let draft = (self.runtime.cfg.streaming && is_private && message.message_id != 0)
            .then_some(message.message_id);
        let inbound = InboundMessage {
            chat_id,
            access_chat_id: is_group_chat(&message.chat.chat_type)
                .then(|| message.chat.id.to_string()),
            text: routed_text,
            author_name: message
                .from
                .as_ref()
                .map(|from| from.first_name.clone())
                .filter(|name| !name.is_empty()),
            sender_id: message.from.as_ref().map(|from| from.id.to_string()),
            message_id: (message.message_id != 0).then(|| message.message_id.to_string()),
            is_group: is_group_chat(&message.chat.chat_type),
            attachments,
            channel_action: None,
        };
        self.spawn_turn(host, inbound, draft, provider_id, claimed_delivery_id);
    }

    async fn run_webhook(
        self: Arc<Self>,
        host: Arc<dyn ChannelHost>,
        me: BotIdentity,
    ) -> anyhow::Result<()> {
        let public_url = self
            .options
            .webhook_url
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("telegram webhook URL is missing"))?;
        let secret = self
            .options
            .webhook_secret
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("telegram webhook secret is missing"))?;
        self.call(
            "setWebhook",
            json!({
                "url": public_url,
                "secret_token": secret,
                "allowed_updates": ["message", "guest_message", "message_reaction", "callback_query"],
                "drop_pending_updates": false,
            }),
        )
        .await?;

        let bind = self.options.webhook_bind.clone();
        let path = normalize_webhook_path(&self.options.webhook_path);
        let listener = TcpListener::bind(&bind).await?;
        let (tx, mut rx) = mpsc::channel::<PendingUpdate>(128);
        let app = Router::new()
            .route(&path, post(telegram_webhook))
            .with_state(TelegramWebhookState {
                tx,
                secret: secret.to_string(),
                channel: Arc::downgrade(&self),
            });
        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                warn!(%err, "telegram webhook listener stopped");
            }
        });
        info!(bind = %bind, path = %path, "telegram webhook listener started");
        if let Some(reporter) = &self.runtime.status {
            reporter.online().await;
        }

        while let Some(pending) = rx.recv().await {
            self.dispatch_update(
                Arc::clone(&host),
                pending.update,
                &me,
                Some(pending.delivery_id),
            );
            if let Some(reporter) = &self.runtime.status {
                reporter.online().await;
            }
        }
        anyhow::bail!("telegram webhook receiver closed")
    }
}

#[async_trait]
impl Channel for TelegramChannel {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// Telegram does all of it. `streaming` declares that the platform has a
    /// draft surface — see [`Channel::send_draft`] for what Ryu can currently
    /// put in it.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            rich_text: true,
            streaming: true,
            threads: true,
            command_menu: true,
            voice: true,
            attachments: true,
            reactions: true,
            reply_keyboards: true,
            inline_buttons: true,
        }
    }

    fn typing_interval(&self) -> Duration {
        TYPING_INTERVAL
    }

    /// Plain-text reply. A guest key is answered through `answerGuestQuery`
    /// instead — that is a different outbound path, not a different chat.
    ///
    /// Telegram caps `sendMessage` at 4096 characters. Split on line boundaries
    /// first, then hard-split a single oversized line so a long agent answer is
    /// delivered instead of being rejected as one oversized request.
    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        self.send_text_with_ids(chat_id, text).await?;
        Ok(())
    }

    async fn send_reply(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
    ) -> anyhow::Result<Vec<String>> {
        if rich_text && self.caps().rich_text {
            self.send_rich_with_ids(chat_id, text).await
        } else {
            self.send_text_with_ids(chat_id, text).await
        }
    }

    async fn send_reply_with_markup(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
        markup: Option<&InteractiveMarkup>,
    ) -> anyhow::Result<Vec<String>> {
        let Some(markup) = markup else {
            return self.send_reply(chat_id, text, rich_text).await;
        };
        if guest_query_of(chat_id).is_some() {
            return self.send_reply(chat_id, text, rich_text).await;
        }
        let (chat, thread) = target(chat_id)?;
        let chunks = split_message(text, 4096);
        let Some((last, preceding)) = chunks.split_last() else {
            anyhow::bail!("interactive Telegram replies cannot be empty");
        };
        let mut ids = self.send_plain_chunks(chat, thread, preceding).await?;
        let payload = interactive_payload(chat, thread, last, markup)?;
        let result = self.call("sendMessage", payload).await?;
        if let Some(message_id) = result.get("message_id").and_then(Value::as_i64) {
            ids.push(message_id.to_string());
        }
        Ok(ids)
    }

    /// Rich-text reply: `sendRichMessage` with `rich_message = { markdown }`.
    ///
    /// Agent replies are already markdown, so this is the cheap correct mapping.
    /// Any rejection — an older Bot API server that has no such method, a chat
    /// that refuses rich messages — falls back to plain text for the chunk that
    /// failed and every chunk after it: the reply matters more than its
    /// formatting, and chunks already delivered are never resent.
    async fn send_rich(&self, chat_id: &str, markdown: &str) -> anyhow::Result<()> {
        self.send_rich_with_ids(chat_id, markdown).await?;
        Ok(())
    }

    /// Push an ephemeral draft into a PRIVATE chat.
    ///
    /// Telegram's drafts are a 30-second preview that must still be finalized
    /// with a real send, and they are rejected outright in groups.
    ///
    /// **What this is not:** token streaming. Core's `/api/channels/run` is a
    /// single non-streaming request, so there is no partial output to animate.
    /// What the caller gets is the documented empty-text draft — Telegram renders
    /// it as "Thinking…" — held while the agent works, and then replaced by the
    /// real reply from [`handle_turn`]. The `partial` argument is honoured for
    /// the day the Core seam grows a streaming variant; until then it is empty.
    async fn send_draft(&self, chat_id: &str, draft_id: i64, partial: &str) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        let (chat, thread) = target(chat_id)?;
        // Defensive: the caller gates on `chat.type == "private"`. A negative id
        // is a group or channel, where the API rejects drafts.
        if chat < 0 {
            return Ok(());
        }
        let (method, payload) = draft_payload(
            chat,
            thread,
            draft_id,
            partial,
            self.runtime.cfg.rich_text && self.caps().rich_text,
        );
        self.call(method, payload).await?;
        Ok(())
    }

    /// `sendChatAction` — the status lasts at most 5 seconds and is cleared the
    /// moment the bot's message lands, so [`crate::keep_typing`] re-asserts it on
    /// [`Self::typing_interval`]. Channel chats do not support it; the resulting
    /// `ok: false` stops the keepalive for that turn rather than looping.
    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        let (chat, thread) = target(chat_id)?;
        self.call("sendChatAction", action_payload(chat, thread, "typing"))
            .await?;
        Ok(())
    }

    /// Send Core's synthesized WAV.
    ///
    /// `sendVoice` accepts only OGG/OPUS, MP3 or M4A, so a WAV must go out as an
    /// audio attachment — which is why [`media::wav_delivery`] returns
    /// [`VoiceDelivery::AudioFile`] for this platform. The `VoiceNote` arm is
    /// kept for the day an encoder makes a real voice bubble possible.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        let (method, field) = match delivery {
            VoiceDelivery::AudioFile => ("sendAudio", "audio"),
            VoiceDelivery::VoiceNote => ("sendVoice", "voice"),
            VoiceDelivery::Unsupported => anyhow::bail!("telegram cannot carry this audio"),
        };
        if guest_query_of(chat_id).is_some() {
            anyhow::bail!("telegram guest replies cannot carry audio");
        }
        let (chat, thread) = target(chat_id)?;
        let (topic, dm_topic) = thread_params(thread);

        let part = reqwest::multipart::Part::bytes(wav)
            .file_name("reply.wav")
            .mime_str("audio/wav")?;
        let mut form = reqwest::multipart::Form::new()
            .text("chat_id", chat.to_string())
            .part(field.to_string(), part);
        if let Some(topic) = topic {
            form = form.text("message_thread_id", topic.to_string());
        }
        if let Some(dm_topic) = dm_topic {
            form = form.text("direct_messages_topic_id", dm_topic.to_string());
        }

        let url = format!("{}/{method}", self.api_base);
        let resp = self
            .runtime
            .http
            .post(&url)
            .multipart(form)
            .send()
            .await
            .map_err(reqwest::Error::without_url)?
            .error_for_status()
            .map_err(reqwest::Error::without_url)?;
        let envelope: ApiEnvelope = resp.json().await.map_err(reqwest::Error::without_url)?;
        if !envelope.ok {
            anyhow::bail!(
                "telegram {method} rejected: {}",
                envelope
                    .description
                    .unwrap_or_else(|| "ok=false with no description".to_string())
            );
        }
        Ok(())
    }

    /// Place an emoji reaction (`setMessageReaction`).
    ///
    /// Bots may only use Telegram's fixed reaction set, and a bot holds one
    /// reaction per message, so a new reaction replaces the previous one. An
    /// emoji outside the set is mapped to its closest allowed form, or skipped.
    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        let Some(emoji) = telegram_reaction(emoji) else {
            debug!(
                channel = "telegram",
                emoji, "no Telegram bot reaction matches this emoji; skipping"
            );
            return Ok(());
        };
        self.set_reaction(
            chat_id,
            message_id,
            json!([{ "type": "emoji", "emoji": emoji }]),
        )
        .await
    }

    /// Clear this bot's reaction. Telegram keeps one bot reaction per message,
    /// so clearing is setting an empty list rather than naming the emoji.
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        _emoji: &str,
    ) -> anyhow::Result<()> {
        if guest_query_of(chat_id).is_some() {
            return Ok(());
        }
        self.set_reaction(chat_id, message_id, json!([])).await
    }

    /// No-op: the Bot API has no way for a bot to mark a chat read. Stated
    /// explicitly rather than inherited so the omission reads as deliberate.
    async fn mark_read(&self, _chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Register the command menu with `setMyCommands`. An EMPTY list leaves the
    /// published menu untouched rather than clearing it with `deleteMyCommands`.
    ///
    /// The instinct is the other way round — a stale menu advertises commands that
    /// no longer exist — but an empty list here is ambiguous: [`commands::fetch`]
    /// returns an empty vec both when Core genuinely publishes nothing AND when it
    /// could not be reached, answered non-2xx, or returned a body that did not
    /// parse. The gateway refreshes the menu once at connect, which is exactly when
    /// it is most likely to win the startup race against Core, so clearing on that
    /// ambiguity would silently wipe the operator's menu on a restart. The two
    /// failures are not symmetric: a stale entry degrades to the agent answering
    /// the command as ordinary text (Core intercepts what it still knows), whereas
    /// a deleted menu is invisible until the operator notices it is gone.
    async fn publish_commands(&self, cmds: &[ChannelCommand]) -> anyhow::Result<()> {
        if cmds.is_empty() {
            debug!("telegram command registry empty; leaving the published menu as it is");
            return Ok(());
        }
        let max = self.options.command_menu_max.clamp(1, 100);
        self.call(
            "setMyCommands",
            commands_payload(&cmds[..cmds.len().min(max)]),
        )
        .await?;
        Ok(())
    }

    /// Push the operator's bot profile. Each field is a separate API call and an
    /// unset field is skipped, so setting only a bio never wipes the name.
    /// Best-effort per field: one rejected call must not drop the other two.
    async fn publish_profile(&self, profile: &BotProfile) -> anyhow::Result<()> {
        let profile = profile.clipped();
        let calls = [
            ("setMyName", "name", profile.name),
            (
                "setMyShortDescription",
                "short_description",
                profile.short_bio,
            ),
            ("setMyDescription", "description", profile.description),
        ];
        let mut failed = Vec::new();
        for (method, field, value) in calls {
            let Some(value) = value else {
                continue;
            };
            if let Err(err) = self.call(method, json!({ field: value })).await {
                warn!(%err, method, "telegram profile field not published");
                failed.push(method);
            }
        }
        // Every field is attempted before reporting, so one rejection does not
        // cost the other two — but the caller is still told, rather than being
        // handed an Ok that means "check the logs".
        if !failed.is_empty() {
            anyhow::bail!("telegram profile fields rejected: {}", failed.join(", "));
        }
        Ok(())
    }

    /// The topic is already packed into the conversation key by the run loop —
    /// Telegram topics are created by users, not by bots, so there is nothing to
    /// open here.
    async fn open_thread(&self, chat_id: &str, _message: &InboundMessage) -> String {
        chat_id.to_string()
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("telegram channel long-poll loop started");
        // Announce that the bot is registered and connecting before the first
        // (up to 25s) long poll returns, so the sidebar dot lights up promptly.
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }
        // Resolve the bot's own identity once so group-mention detection can
        // recognise `@username` and replies to the bot. A failure here is
        // non-fatal: private chats reply regardless, and group Mentions mode
        // simply falls back to command-only until the next restart.
        let me = match self.get_me().await {
            Ok(identity) => {
                info!(
                    username = identity.username.as_deref().unwrap_or("?"),
                    supports_guest_queries = identity.supports_guest_queries,
                    has_topics_enabled = identity.has_topics_enabled,
                    "telegram bot identity resolved"
                );
                identity
            }
            Err(err) => {
                warn!(
                    error = %err,
                    "telegram getMe failed; group mention detection disabled (private chats unaffected)"
                );
                BotIdentity::default()
            }
        };

        // Publish the menu and profile once per connect. Both are best-effort:
        // a bot with no menu still works, because a typed command reaches Core
        // whether or not the platform advertises it.
        if self.runtime.cfg.publish_commands {
            let cmds = self.runtime.refresh_commands().await;
            if let Err(err) = self.publish_commands(&cmds).await {
                warn!(error = %err, "telegram command menu not published");
            }
        }
        if !self.runtime.cfg.profile.is_empty() {
            let profile = self.runtime.cfg.profile.clone();
            if let Err(err) = self.publish_profile(&profile).await {
                warn!(error = %err, "telegram bot profile not published");
            }
        }

        if self.options.webhook_url.is_some() {
            return self.run_webhook(Arc::clone(&host), me).await;
        }

        // Telegram acknowledges processed updates by advancing the offset to
        // (last update_id + 1); anything below the offset is never re-delivered.
        let mut offset: i64 = 0;

        loop {
            match self.get_updates(offset).await {
                Ok(updates) => {
                    // A successful poll means the bot is live — heartbeat online.
                    if let Some(reporter) = &self.runtime.status {
                        reporter.online().await;
                    }
                    for update in updates {
                        offset = offset.max(update.update_id + 1);
                        self.dispatch_update(Arc::clone(&host), update, &me, None);
                    }
                }
                // A rejected token is terminal for THIS adapter: the token is
                // baked into `api_base`, so recovery means a new adapter built
                // from a new token. Return so the host's supervisor can refresh
                // and respawn — backing off here would poll 401 forever while
                // the bot sits deaf.
                Err(err) if is_token_rejected(&err) => {
                    warn!("telegram token rejected (401); stopping this adapter so the host can refresh it");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error("bot token rejected by Telegram (401)").await;
                    }
                    return Err(err);
                }
                Err(err) => {
                    warn!(error = %err, "telegram getUpdates failed, backing off");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(ERROR_BACKOFF).await;
                }
            }
        }
    }
}

// ─── Pure helpers (payload building, id packing, message parsing) ─────────────
//
// Everything below takes primitives and returns values, so the wire shapes are
// unit-testable without a Telegram to talk to. That is the whole reason the
// `send_*` methods are thin.

#[derive(Clone)]
struct TelegramWebhookState {
    tx: mpsc::Sender<PendingUpdate>,
    secret: String,
    channel: Weak<TelegramChannel>,
}

struct PendingUpdate {
    update: Update,
    delivery_id: String,
}

/// Constant-time check of the presented `X-Telegram-Bot-Api-Secret-Token`
/// against the configured webhook secret. Both sides are hashed first so the
/// comparison always runs over two fixed-width digests: how long a rejection
/// takes reveals neither how many leading bytes matched nor the secret's
/// length (the operator chooses it, so unlike a fixed-width token it is not
/// public).
fn webhook_secret_matches(expected: &str, presented: &str) -> bool {
    let expected = Sha256::digest(expected.as_bytes());
    let presented = Sha256::digest(presented.as_bytes());
    let mut diff = 0u8;
    for (x, y) in expected.iter().zip(presented.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn telegram_webhook(
    State(state): State<TelegramWebhookState>,
    headers: HeaderMap,
    body: Bytes,
) -> StatusCode {
    let presented = headers
        .get("x-telegram-bot-api-secret-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !webhook_secret_matches(&state.secret, presented) {
        return StatusCode::UNAUTHORIZED;
    }
    if body.len() > 1024 * 1024 {
        return StatusCode::PAYLOAD_TOO_LARGE;
    }
    let Ok(update) = serde_json::from_slice::<Update>(&body) else {
        return StatusCode::BAD_REQUEST;
    };
    let provider_id = format!("update:{}", update.update_id);
    let Some(channel) = state.channel.upgrade() else {
        return StatusCode::SERVICE_UNAVAILABLE;
    };
    let (delivery_id, claim) = match claim_inbound_delivery(&*channel, &provider_id).await {
        Ok(result) => result,
        Err(error) => {
            warn!(%error, "telegram webhook delivery could not be durably claimed");
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    };
    if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
        debug!(
            delivery_id = %delivery_id,
            ?claim,
            "duplicate telegram webhook delivery suppressed"
        );
        return StatusCode::OK;
    }

    let pending = PendingUpdate {
        update,
        delivery_id: delivery_id.clone(),
    };
    match state.tx.try_send(pending) {
        Ok(()) => StatusCode::OK,
        Err(error) => {
            if let Err(persist_error) = channel
                .runtime
                .pairing
                .fail_delivery("telegram", &delivery_id)
                .await
            {
                warn!(%persist_error, "telegram webhook queue failure could not be persisted");
            }
            warn!(%error, "telegram webhook queue is unavailable; asking Telegram to retry");
            StatusCode::SERVICE_UNAVAILABLE
        }
    }
}

fn complete_claimed_delivery(channel: Arc<TelegramChannel>, delivery_id: Option<String>) {
    let Some(delivery_id) = delivery_id else {
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = channel
            .runtime
            .pairing
            .complete_delivery("telegram", &delivery_id)
            .await
        {
            warn!(%error, "telegram ignored delivery could not be marked complete");
        }
    });
}

fn spawn_reaction_delivery(
    channel: Arc<TelegramChannel>,
    reaction: MessageReactionUpdated,
    bot_id: i64,
    provider_id: String,
    claimed_delivery_id: Option<String>,
) {
    tokio::spawn(async move {
        let (delivery_id, claim) = if let Some(delivery_id) = claimed_delivery_id {
            (delivery_id, crate::pairing::DeliveryClaim::Claimed)
        } else {
            match claim_inbound_delivery(&*channel, &provider_id).await {
                Ok(result) => result,
                Err(error) => {
                    warn!(
                        channel = "telegram",
                        %error,
                        "telegram reaction could not be durably claimed; processing once without dedupe"
                    );
                    (
                        scoped_delivery_id(&*channel, &provider_id),
                        crate::pairing::DeliveryClaim::Claimed,
                    )
                }
            }
        };
        if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
            debug!(
                channel = "telegram",
                delivery_id = %delivery_id,
                ?claim,
                "duplicate telegram reaction suppressed"
            );
            return;
        }

        let work_channel = Arc::clone(&channel);
        run_claimed_delivery(channel, delivery_id, move || {
            let channel = Arc::clone(&work_channel);
            let reaction = reaction.clone();
            async move {
                let Some(user) = reaction.user.as_ref() else {
                    // Anonymous group/channel reactions carry actor_chat rather
                    // than a person. They are intentionally not attributed to
                    // Learning's node-wide feedback sink.
                    return ChannelTurnOutcome::Completed;
                };
                if user.id == bot_id {
                    return ChannelTurnOutcome::Completed;
                }
                let is_group = reaction.chat.chat_type != "private";
                if is_group && !channel.runtime.cfg.reaction_learning.allow_group {
                    return ChannelTurnOutcome::Completed;
                }
                let thread = reaction
                    .message_thread_id
                    .map(|id| format!("{TOPIC_TAG}{id}"));
                let target = pack_thread(&reaction.chat.id.to_string(), thread.as_deref());
                let emoji = reaction
                    .new_reaction
                    .iter()
                    .find_map(|item| item.emoji.as_deref())
                    .unwrap_or_default();
                match channel
                    .runtime
                    .record_reaction_feedback(
                        "telegram",
                        &target,
                        &reaction.message_id.to_string(),
                        emoji,
                    )
                    .await
                {
                    Ok(true) => {
                        info!(
                            message_id = reaction.message_id,
                            "telegram reaction recorded as Learning feedback"
                        );
                        ChannelTurnOutcome::Completed
                    }
                    Ok(false) => {
                        debug!(
                            message_id = reaction.message_id,
                            "telegram reaction was not linked to a Core assistant reply"
                        );
                        ChannelTurnOutcome::Completed
                    }
                    Err(error) => {
                        warn!(
                            message_id = reaction.message_id,
                            %error,
                            "telegram reaction feedback failed"
                        );
                        ChannelTurnOutcome::Failed
                    }
                }
            }
        })
        .await;
    });
}

/// Build a Telegram Bot API base from either the public endpoint or a custom
/// local endpoint. A full `/bot<TOKEN>` URL is also accepted for deployments
/// that already template the token into their endpoint.
fn api_base(custom: Option<&str>, token: &str, file: bool) -> String {
    let default = if file {
        format!("https://api.telegram.org/file/bot{token}")
    } else {
        format!("https://api.telegram.org/bot{token}")
    };
    let Some(custom) = custom.map(str::trim).filter(|value| !value.is_empty()) else {
        return default;
    };
    let custom = custom.trim_end_matches('/');
    if custom.contains("/bot") {
        return custom.to_string();
    }
    let prefix = if file { "/file" } else { "" };
    format!("{custom}{prefix}/bot{token}")
}

fn normalize_webhook_path(raw: &str) -> String {
    let trimmed = raw.trim().trim_matches('/');
    if trimmed.is_empty() {
        "/webhooks/telegram".to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// Split Telegram text at line boundaries and hard-split only when a single
/// line itself exceeds the Bot API ceiling.
fn split_message(text: &str, max: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    for line in text.split_inclusive('\n') {
        if line.chars().count() <= max && current.chars().count() + line.chars().count() <= max {
            current.push_str(line);
            continue;
        }
        if !current.trim().is_empty() {
            chunks.push(std::mem::take(&mut current));
        }
        if line.chars().count() > max {
            let mut hard = String::new();
            for ch in line.chars() {
                hard.push(ch);
                if hard.chars().count() == max {
                    chunks.push(std::mem::take(&mut hard));
                }
            }
            current = hard;
        } else {
            current.push_str(line);
        }
    }
    if !current.trim().is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Does this `getUpdates` outcome mean "your token is not valid any more"?
///
/// Telegram says so two ways for the same cause, and both must classify the
/// same: an HTTP `401` on the request, and — because a rejected call arrives with
/// HTTP 200 (see the module header) — `{"ok":false,"error_code":401}` in the
/// envelope. Kept as a pure predicate over the two signals so the rule that
/// decides whether an adapter stops is testable without a Telegram to talk to.
fn is_unauthorized(status: Option<reqwest::StatusCode>, error_code: Option<i64>) -> bool {
    status == Some(reqwest::StatusCode::UNAUTHORIZED) || error_code == Some(401)
}

/// How long to wait before retrying a Bot API call that hit flood control, or
/// `None` when the call must fail now.
///
/// Telegram signals flood control as HTTP 429 and/or `error_code: 429`, with
/// the required wait in `parameters.retry_after` seconds. A wait above
/// [`MAX_INLINE_RETRY_AFTER`], or a 429 without a wait, is not retried in place.
/// Pure over the two signals, like [`is_unauthorized`], so the rule is testable
/// without a Telegram to talk to.
fn retry_delay(status: reqwest::StatusCode, envelope: &ApiEnvelope) -> Option<Duration> {
    let flood_control =
        status == reqwest::StatusCode::TOO_MANY_REQUESTS || envelope.error_code == Some(429);
    if !flood_control {
        return None;
    }
    let delay = Duration::from_secs(envelope.parameters.as_ref()?.retry_after?);
    (delay <= MAX_INLINE_RETRY_AFTER).then_some(delay)
}

/// The guest query id inside a conversation key, if this is a guest turn.
fn guest_query_of(chat_id: &str) -> Option<&str> {
    chat_id.strip_prefix(GUEST_KEY_PREFIX)
}

/// Split a packed conversation key into `(chat_id, thread_tag)`.
///
/// # Errors
/// Returns `Err` when the chat part is not a Telegram integer chat id.
fn target(chat_id: &str) -> anyhow::Result<(i64, Option<&str>)> {
    let (chat, thread) = unpack_thread(chat_id);
    let parsed: i64 = chat
        .parse()
        .map_err(|_| anyhow::anyhow!("invalid telegram chat id: {chat_id}"))?;
    Ok((parsed, thread))
}

/// Is this chat type a multi-user room?
fn is_group_chat(chat_type: &str) -> bool {
    chat_type == "group" || chat_type == "supergroup"
}

/// The thread tag for a message, if it arrived inside one.
///
/// A direct-messages topic and a forum topic are DIFFERENT API parameters, so
/// the tag records which one it is: `d<id>` for `direct_messages_topic_id`,
/// `t<id>` for `message_thread_id`. The DM topic wins when both are present
/// because it is the more specific of the two.
fn thread_of(message: &Message) -> Option<String> {
    if let Some(topic) = message.direct_messages_topic.as_ref() {
        return Some(format!("{DM_TOPIC_TAG}{}", topic.topic_id));
    }
    message
        .message_thread_id
        .map(|id| format!("{TOPIC_TAG}{id}"))
}

fn callback_button_label(message: &Message, callback_data: &str) -> Option<String> {
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
fn thread_params(thread: Option<&str>) -> (Option<i64>, Option<i64>) {
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
fn insert_thread(obj: &mut Map<String, Value>, thread: Option<&str>) {
    let (topic, dm_topic) = thread_params(thread);
    if let Some(topic) = topic {
        obj.insert("message_thread_id".to_string(), json!(topic));
    }
    if let Some(dm_topic) = dm_topic {
        obj.insert("direct_messages_topic_id".to_string(), json!(dm_topic));
    }
}

/// `sendMessage` payload.
fn message_payload(chat: i64, thread: Option<&str>, text: &str) -> Value {
    let mut obj = Map::new();
    obj.insert("chat_id".to_string(), json!(chat));
    obj.insert("text".to_string(), json!(text));
    insert_thread(&mut obj, thread);
    Value::Object(obj)
}

/// `sendMessage` payload with validated Telegram-native buttons.
fn interactive_payload(
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
fn rich_payload(chat: i64, thread: Option<&str>, markdown: &str) -> Value {
    let mut obj = Map::new();
    obj.insert("chat_id".to_string(), json!(chat));
    obj.insert("rich_message".to_string(), json!({ "markdown": markdown }));
    insert_thread(&mut obj, thread);
    Value::Object(obj)
}

/// `sendChatAction` payload.
fn action_payload(chat: i64, thread: Option<&str>, action: &str) -> Value {
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
fn draft_payload(
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
fn commands_payload(cmds: &[ChannelCommand]) -> Value {
    json!({
        "commands": cmds
            .iter()
            .map(|c| json!({ "command": c.name, "description": c.description }))
            .collect::<Vec<_>>(),
    })
}

/// `answerGuestQuery` payload: one `InlineQueryResultArticle` carrying the reply.
///
/// The result `id` is a short constant rather than the query id — it only has to
/// be unique within this answer, and `InlineQueryResult.id` is capped at 64 bytes.
fn guest_reply_payload(query_id: &str, text: &str) -> Value {
    json!({
        "guest_query_id": query_id,
        "result": {
            "type": "article",
            "id": "reply",
            "title": "Reply",
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
fn guest_inbound(message: &Message) -> Option<InboundMessage> {
    let query_id = message.guest_query_id.as_deref()?;
    let key = format!("{GUEST_KEY_PREFIX}{query_id}");
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
    })
}

/// Did the user attach anything? Cheaper than building the [`Attachment`] list
/// when only the yes/no answer is needed, and used by the group gate to tell a
/// media-only message apart from an empty one.
fn has_media(message: &Message) -> bool {
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
fn attachments_from(message: &Message) -> Vec<Attachment> {
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

/// The bot's own identity, resolved once via `getMe`. Used to recognise when a
/// group message addresses the bot (`@username` mention or a reply to the bot),
/// and to log the two bot-level feature flags at startup.
#[derive(Debug, Clone, Default)]
struct BotIdentity {
    id: i64,
    username: Option<String>,
    /// Bot-level flag: forum topic mode is enabled in the bot's private chats.
    /// NOT per-chat, despite how it reads.
    has_topics_enabled: bool,
    /// Bot-level flag: `Update.guest_message` can arrive for this bot.
    supports_guest_queries: bool,
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
fn decide_reply(
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

fn decide_reply_with_options(
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
struct ApiEnvelope {
    ok: bool,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    result: Option<Value>,
    /// Telegram's numeric reason when `ok` is false; `429` is flood control.
    #[serde(default)]
    error_code: Option<i64>,
    /// Extra detail on a failed call, such as the flood-control wait.
    #[serde(default)]
    parameters: Option<ResponseParameters>,
}

/// `ResponseParameters` from a failed Bot API call (only the fields we use).
#[derive(Debug, Default, Deserialize)]
struct ResponseParameters {
    /// Seconds to wait before repeating a call that hit flood control.
    #[serde(default)]
    retry_after: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct GetUpdatesResponse {
    ok: bool,
    /// Telegram's numeric reason when `ok` is false. Only `401` is acted on (a
    /// revoked or replaced token), but it is read here rather than at the call
    /// site because an `ok: false` poll arrives with HTTP 200 and is otherwise
    /// indistinguishable from a transient failure.
    #[serde(default)]
    error_code: Option<i64>,
    #[serde(default)]
    result: Vec<Update>,
}

#[derive(Debug, Default, Deserialize)]
struct BotUser {
    id: i64,
    #[serde(default)]
    username: Option<String>,
    /// The bot has forum topic mode enabled in private chats.
    #[serde(default)]
    has_topics_enabled: bool,
    /// The bot can receive `Update.guest_message`.
    #[serde(default)]
    supports_guest_queries: bool,
}

#[derive(Debug, Default, Deserialize)]
struct Update {
    update_id: i64,
    #[serde(default)]
    message: Option<Message>,
    /// A message from someone who is not in a chat with the bot. Answered with
    /// `answerGuestQuery`, keyed on `Message.guest_query_id`.
    #[serde(default)]
    guest_message: Option<Message>,
    /// Reaction added/removed by a user on a bot message. Enabled explicitly by
    /// the reaction-learning config and only linked after an outbound reply id
    /// has been confirmed.
    #[serde(default)]
    message_reaction: Option<MessageReactionUpdated>,
    /// Callback button selected from an inline keyboard.
    #[serde(default)]
    callback_query: Option<CallbackQuery>,
}

#[derive(Debug, Default, Deserialize)]
struct CallbackQuery {
    id: String,
    from: TgUser,
    #[serde(default)]
    message: Option<Message>,
    #[serde(default)]
    data: Option<String>,
}

#[derive(Debug, Default, Deserialize, Clone)]
struct MessageReactionUpdated {
    chat: Chat,
    #[serde(default)]
    message_id: i64,
    #[serde(default)]
    user: Option<TgUser>,
    #[serde(default)]
    new_reaction: Vec<TelegramReaction>,
    #[serde(default)]
    message_thread_id: Option<i64>,
}

#[derive(Debug, Default, Deserialize, Clone)]
struct TelegramReaction {
    #[serde(default)]
    emoji: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Message {
    chat: Chat,
    #[serde(default)]
    message_id: i64,
    #[serde(default)]
    text: Option<String>,
    /// Caption on a media message — the user's words when they attach a photo.
    #[serde(default)]
    caption: Option<String>,
    /// Sender of the message. Used for the speaker prefix in group chats.
    #[serde(default)]
    from: Option<TgUser>,
    /// The message this one replies to, if any. Boxed because it is the same
    /// `Message` type (self-referential) and would otherwise be infinitely sized.
    #[serde(default)]
    reply_to_message: Option<Box<Message>>,
    /// Forum topic (or private-chat topic) this message belongs to.
    #[serde(default)]
    message_thread_id: Option<i64>,
    /// The callback's source keyboard lets us recover a button label when it
    /// was omitted from compact callback data to stay within Telegram's limit.
    #[serde(default)]
    reply_markup: Option<Value>,
    /// Direct-messages topic, a DIFFERENT parameter from `message_thread_id`.
    #[serde(default)]
    direct_messages_topic: Option<DirectMessagesTopic>,
    /// Present only on `Update.guest_message`; the handle for `answerGuestQuery`.
    #[serde(default)]
    guest_query_id: Option<String>,
    #[serde(default)]
    voice: Option<TgFile>,
    #[serde(default)]
    audio: Option<TgFile>,
    /// Size ladder for a photo, smallest first.
    #[serde(default)]
    photo: Vec<TgFile>,
    #[serde(default)]
    video: Option<TgFile>,
    #[serde(default)]
    document: Option<TgFile>,
}

#[derive(Debug, Default, Deserialize, Clone)]
struct Chat {
    id: i64,
    /// `private`, `group`, `supergroup`, or `channel`. Absent → treated as
    /// non-group (private) so the bot still replies.
    #[serde(rename = "type", default)]
    chat_type: String,
}

#[derive(Debug, Default, Deserialize)]
struct DirectMessagesTopic {
    #[serde(default)]
    topic_id: i64,
}

#[derive(Debug, Default, Deserialize, Clone)]
struct TgUser {
    id: i64,
    #[serde(default)]
    first_name: String,
}

/// The shape every Telegram media object shares. `PhotoSize` has no `mime_type`
/// or `file_name`, which the defaults cover.
#[derive(Debug, Default, Deserialize)]
struct TgFile {
    file_id: String,
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    file_name: Option<String>,
    #[serde(default)]
    file_size: Option<u64>,
}

/// Emoji a Telegram bot may react with (`ReactionTypeEmoji`), written without
/// variation selectors. Anything else is refused by `setMessageReaction`.
const TELEGRAM_BOT_REACTIONS: &[&str] = &[
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
fn telegram_reaction(emoji: &str) -> Option<&'static str> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CommonChannelConfig;
    use ryu_channel_contracts::ChannelActionEvent;

    struct TestHost;

    #[async_trait]
    impl ChannelHost for TestHost {
        async fn run_pipeline(&self, _channel_name: &str, _body: Value) -> anyhow::Result<Value> {
            Ok(Value::Null)
        }
    }

    fn make_cfg(token: &str) -> TelegramChannelConfig {
        TelegramChannelConfig {
            token: token.to_string(),
            common: CommonChannelConfig {
                model: "gpt-4o".to_string(),
                ..Default::default()
            },
            options: crate::TelegramChannelOptions::default(),
        }
    }

    fn group_message(text: &str, first_name: &str) -> Message {
        Message {
            chat: Chat {
                id: 42,
                chat_type: "supergroup".to_string(),
            },
            text: Some(text.to_string()),
            from: Some(TgUser {
                id: 7,
                first_name: first_name.to_string(),
            }),
            ..Default::default()
        }
    }

    fn me() -> BotIdentity {
        BotIdentity {
            id: 999,
            username: Some("ryubot".to_string()),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn webhook_claims_before_ack_and_suppresses_duplicate_updates() {
        let channel = Arc::new(
            TelegramChannel::new(
                make_cfg("token"),
                reqwest::Client::new(),
                PairingStore::ephemeral(),
            )
            .unwrap(),
        );
        let (tx, mut rx) = mpsc::channel(2);
        let state = TelegramWebhookState {
            tx,
            secret: "secret".to_string(),
            channel: Arc::downgrade(&channel),
        };
        let body = Bytes::from_static(br#"{"update_id":42}"#);
        let mut headers = HeaderMap::new();
        headers.insert("x-telegram-bot-api-secret-token", "secret".parse().unwrap());

        assert_eq!(
            telegram_webhook(State(state.clone()), headers.clone(), body.clone()).await,
            StatusCode::OK
        );
        let pending = rx.try_recv().expect("first update should be queued");
        assert_eq!(pending.update.update_id, 42);

        assert_eq!(
            telegram_webhook(State(state), headers, body).await,
            StatusCode::OK
        );
        assert!(
            rx.try_recv().is_err(),
            "the retry must not enqueue a second update"
        );
        assert_eq!(
            channel
                .runtime
                .pairing
                .claim_delivery("telegram", "telegram:update:42")
                .await
                .unwrap(),
            crate::pairing::DeliveryClaim::InFlight
        );
    }

    #[test]
    fn webhook_secret_matches_only_the_exact_secret() {
        assert!(webhook_secret_matches("s3cr3t-Token_9", "s3cr3t-Token_9"));
        for wrong in [
            "",
            "s",
            "s3cr3t-Token_",
            "s3cr3t-Token_9x",
            "s3cr3t-Token_8",
            "S3CR3T-TOKEN_9",
            " s3cr3t-Token_9",
        ] {
            assert!(
                !webhook_secret_matches("s3cr3t-Token_9", wrong),
                "{wrong:?} must not match the configured secret"
            );
        }
    }

    #[tokio::test]
    async fn webhook_rejects_a_wrong_or_missing_secret_token() {
        let channel = Arc::new(
            TelegramChannel::new(
                make_cfg("token"),
                reqwest::Client::new(),
                PairingStore::ephemeral(),
            )
            .unwrap(),
        );
        let (tx, mut rx) = mpsc::channel(2);
        let state = TelegramWebhookState {
            tx,
            secret: "secret".to_string(),
            channel: Arc::downgrade(&channel),
        };
        let body = Bytes::from_static(br#"{"update_id":7}"#);

        assert_eq!(
            telegram_webhook(State(state.clone()), HeaderMap::new(), body.clone()).await,
            StatusCode::UNAUTHORIZED,
            "a request without the header must be refused"
        );
        for wrong in ["secre", "secrets", "secreT"] {
            let mut headers = HeaderMap::new();
            headers.insert("x-telegram-bot-api-secret-token", wrong.parse().unwrap());
            assert_eq!(
                telegram_webhook(State(state.clone()), headers, body.clone()).await,
                StatusCode::UNAUTHORIZED,
                "{wrong:?} must be refused"
            );
        }
        assert!(
            rx.try_recv().is_err(),
            "a refused request must not enqueue an update"
        );
    }

    // ─── decide_reply: the group gate ───────────────────────────────────────

    #[test]
    fn private_chat_always_replies_with_raw_text() {
        let message = Message {
            chat: Chat {
                id: 1,
                chat_type: "private".to_string(),
            },
            text: Some("hello".to_string()),
            ..Default::default()
        };
        let routed = decide_reply(&message, "hello", &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("hello"));
    }

    #[test]
    fn group_mentions_mode_ignores_unaddressed_message() {
        let message = group_message("just chatting", "Ada");
        assert!(decide_reply(&message, "just chatting", &me(), GroupReplyMode::Mentions).is_none());
    }

    #[test]
    fn group_mentions_mode_replies_when_mentioned_and_strips_mention() {
        let raw = "@ryubot what is 2+2";
        let message = group_message(raw, "Ada");
        let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
        // Mention stripped, speaker prefixed.
        assert_eq!(routed.as_deref(), Some("Ada: what is 2+2"));
    }

    #[test]
    fn group_mentions_mode_replies_to_command() {
        let raw = "/help";
        let message = group_message(raw, "Ada");
        let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("Ada: /help"));
    }

    #[test]
    fn group_command_detection_accepts_the_bot_suffixed_form() {
        // What a Telegram client actually sends in a group.
        let raw = "/help@ryubot";
        let message = group_message(raw, "Ada");
        // The mention is stripped as part of the reply text, leaving the command.
        let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("Ada: /help"));

        // A lone slash is not a command and must not open the group gate.
        let bare = group_message("/", "Ada");
        assert!(decide_reply(&bare, "/", &me(), GroupReplyMode::Mentions).is_none());
    }

    #[test]
    fn group_mentions_mode_replies_to_a_reply_to_the_bot() {
        let mut message = group_message("thanks", "Ada");
        message.reply_to_message = Some(Box::new(Message {
            chat: Chat {
                id: 42,
                chat_type: "supergroup".to_string(),
            },
            text: Some("earlier bot reply".to_string()),
            from: Some(TgUser {
                id: 999,
                first_name: "Ryu".to_string(),
            }),
            ..Default::default()
        }));
        let routed = decide_reply(&message, "thanks", &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("Ada: thanks"));
    }

    #[test]
    fn group_all_mode_replies_to_every_message() {
        let message = group_message("just chatting", "Ada");
        let routed = decide_reply(&message, "just chatting", &me(), GroupReplyMode::All);
        assert_eq!(routed.as_deref(), Some("Ada: just chatting"));
    }

    #[test]
    fn a_media_only_group_message_is_still_a_turn() {
        // A caption-less photo in an `All`-mode group: the text is empty but the
        // message is not, and dropping it would ignore what the operator asked
        // for. It routes with no text; the attachment becomes the prompt.
        let mut photo = group_message("", "Ada");
        photo.text = None;
        photo.photo = vec![TgFile {
            file_id: "p1".to_string(),
            ..Default::default()
        }];
        assert_eq!(
            decide_reply(&photo, "", &me(), GroupReplyMode::All).as_deref(),
            Some("")
        );

        // The same photo captioned only with the bot's @mention, in Mentions
        // mode: addressed, empty once stripped, still a real "look at this".
        let mut mentioned = photo;
        mentioned.text = Some("@ryubot".to_string());
        assert_eq!(
            decide_reply(&mentioned, "@ryubot", &me(), GroupReplyMode::Mentions).as_deref(),
            Some("")
        );

        // With nothing attached there is genuinely nothing to route.
        let empty = group_message("@ryubot", "Ada");
        assert!(decide_reply(&empty, "@ryubot", &me(), GroupReplyMode::Mentions).is_none());
    }

    #[test]
    fn empty_identity_disables_mention_detection_but_allows_commands() {
        let empty = BotIdentity::default();
        let message = group_message("@ryubot hi", "Ada");
        // Without an identity the @mention can't be recognised → ignored.
        assert!(decide_reply(&message, "@ryubot hi", &empty, GroupReplyMode::Mentions).is_none());
        // Commands still work (identity-independent).
        let cmd = group_message("/start", "Ada");
        assert!(decide_reply(&cmd, "/start", &empty, GroupReplyMode::Mentions).is_some());
    }

    // ─── Construction ───────────────────────────────────────────────────────

    #[test]
    fn new_rejects_empty_token() {
        let result = TelegramChannel::new(
            make_cfg("   "),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn new_builds_api_and_file_bases_from_token() {
        let mut cfg = make_cfg("123:ABC");
        cfg.common.system_prompt = Some("hi".to_string());
        let channel =
            TelegramChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
        assert_eq!(channel.api_base, "https://api.telegram.org/bot123:ABC");
        assert_eq!(
            channel.file_base,
            "https://api.telegram.org/file/bot123:ABC"
        );
        assert_eq!(channel.name(), "telegram");
        assert_eq!(channel.model(), "gpt-4o");
        assert_eq!(channel.system_prompt(), Some("hi"));
    }

    // ─── 401 classification: a replaced token must stop the adapter ─────────

    #[test]
    fn http_401_is_unauthorized() {
        assert!(is_unauthorized(
            Some(reqwest::StatusCode::UNAUTHORIZED),
            None
        ));
    }

    #[test]
    fn envelope_error_code_401_is_unauthorized() {
        // The Bot API rejects a dead token with HTTP 200 + ok:false, so the
        // envelope must classify the same as the status code.
        assert!(is_unauthorized(Some(reqwest::StatusCode::OK), Some(401)));
    }

    #[test]
    fn other_failures_are_not_unauthorized() {
        // 429 and 5xx are exactly the cases the adapter must keep backing off on
        // rather than tearing itself down for a token refresh.
        assert!(!is_unauthorized(
            Some(reqwest::StatusCode::TOO_MANY_REQUESTS),
            None
        ));
        assert!(!is_unauthorized(
            Some(reqwest::StatusCode::BAD_GATEWAY),
            None
        ));
        assert!(!is_unauthorized(Some(reqwest::StatusCode::OK), Some(400)));
        assert!(!is_unauthorized(None, None));
    }

    #[test]
    fn get_updates_response_reads_the_error_code() {
        let body: GetUpdatesResponse =
            serde_json::from_value(json!({ "ok": false, "error_code": 401 })).unwrap();
        assert!(!body.ok);
        assert!(is_unauthorized(None, body.error_code));
    }

    #[test]
    fn get_updates_response_without_an_error_code_still_parses() {
        // An older/other rejection carries only a description; a missing
        // `error_code` must not fail the whole batch parse.
        let body: GetUpdatesResponse =
            serde_json::from_value(json!({ "ok": true, "result": [] })).unwrap();
        assert!(body.ok);
        assert!(body.error_code.is_none());
    }

    #[test]
    fn token_rejected_survives_a_context_wrap() {
        // The supervisor classifies by walking the chain, so an adapter is free
        // to annotate the error on the way out.
        let err = anyhow::Error::from(TokenRejected).context("telegram getUpdates");
        assert!(is_token_rejected(&err));
    }

    #[test]
    fn a_plain_transport_error_is_not_token_rejected() {
        let err = anyhow::anyhow!("connection reset");
        assert!(!is_token_rejected(&err));
    }

    #[test]
    fn token_rejected_never_names_the_token() {
        // The whole point of the payload-free marker: the failing URL contains
        // the token, and this string is logged and shipped to the control plane.
        let rendered = TokenRejected.to_string();
        assert!(!rendered.contains("api.telegram.org"));
        assert!(rendered.contains("401"));
    }

    #[test]
    fn new_stores_the_core_route() {
        let mut cfg = make_cfg("tok:1");
        cfg.common.agent_id = Some("acp:pi".to_string());
        let channel =
            TelegramChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral()).unwrap();
        assert!(channel.runtime().routes_via_core());
        assert_eq!(channel.runtime().cfg.core_url, "http://127.0.0.1:7980");
    }

    #[test]
    fn caps_declare_the_full_telegram_surface() {
        let channel = TelegramChannel::new(
            make_cfg("t:1"),
            reqwest::Client::new(),
            PairingStore::ephemeral(),
        )
        .unwrap();
        let caps = channel.caps();
        assert!(caps.typing && caps.rich_text && caps.streaming && caps.threads);
        assert!(caps.command_menu && caps.voice && caps.attachments && caps.reactions);
        // Under Telegram's 5s chat-action expiry, or the indicator visibly gaps.
        assert!(channel.typing_interval() < Duration::from_secs(5));
    }

    // ─── Thread packing ─────────────────────────────────────────────────────

    #[test]
    fn thread_is_packed_off_a_message_and_unpacked_for_the_api() {
        let mut message = group_message("hi", "Ada");
        message.message_thread_id = Some(77);

        let tag = thread_of(&message);
        assert_eq!(tag.as_deref(), Some("t77"));
        let key = pack_thread(&message.chat.id.to_string(), tag.as_deref());
        assert_eq!(key, "42:t77");

        let (chat, thread) = target(&key).unwrap();
        assert_eq!(chat, 42);
        assert_eq!(thread_params(thread), (Some(77), None));
    }

    #[test]
    fn direct_messages_topic_maps_to_its_own_parameter() {
        let mut message = group_message("hi", "Ada");
        message.message_thread_id = Some(5);
        message.direct_messages_topic = Some(DirectMessagesTopic { topic_id: 9 });
        // The more specific of the two wins.
        assert_eq!(thread_of(&message).as_deref(), Some("d9"));
        assert_eq!(thread_params(Some("d9")), (None, Some(9)));
    }

    #[test]
    fn a_threadless_chat_round_trips_unchanged() {
        let message = group_message("hi", "Ada");
        assert!(thread_of(&message).is_none());
        let key = pack_thread("-1001", None);
        assert_eq!(key, "-1001");
        let (chat, thread) = target(&key).unwrap();
        assert_eq!(chat, -1001);
        assert!(thread.is_none());
        assert_eq!(thread_params(thread), (None, None));
    }

    #[test]
    fn an_unrecognised_thread_tag_degrades_to_the_room() {
        // A key written by an older or newer build must not fail the send.
        assert_eq!(thread_params(Some("zzz")), (None, None));
        assert_eq!(thread_params(Some("tnot-a-number")), (None, None));
        assert!(target("not-a-chat").is_err());
    }

    // ─── Payload building ───────────────────────────────────────────────────

    #[test]
    fn message_payload_carries_the_topic() {
        let plain = message_payload(42, None, "hi");
        assert_eq!(plain["chat_id"], 42);
        assert_eq!(plain["text"], "hi");
        assert!(plain.get("message_thread_id").is_none());

        let threaded = message_payload(42, Some("t7"), "hi");
        assert_eq!(threaded["message_thread_id"], 7);

        let dm = message_payload(42, Some("d7"), "hi");
        assert_eq!(dm["direct_messages_topic_id"], 7);
        assert!(dm.get("message_thread_id").is_none());
    }

    #[test]
    fn interactive_payloads_render_both_button_layouts() {
        let reply = InteractiveMarkup {
            layout: InteractiveLayout::ReplyKeyboard,
            rows: vec![vec![crate::InteractiveButton {
                label: "Option 1".to_owned(),
                action: InteractiveAction::Reply,
            }]],
        };
        let reply_payload = interactive_payload(42, None, "Choose an option", &reply).unwrap();
        assert_eq!(
            reply_payload["reply_markup"]["keyboard"][0][0]["text"],
            "Option 1"
        );
        assert_eq!(reply_payload["reply_markup"]["resize_keyboard"], true);

        let inline = InteractiveMarkup {
            layout: InteractiveLayout::Inline,
            rows: vec![vec![crate::InteractiveButton {
                label: "Approve".to_owned(),
                action: InteractiveAction::Callback {
                    action_id: "review.approve".to_owned(),
                    payload: json!({ "requestId": "7" }),
                },
            }]],
        };
        let inline_payload =
            interactive_payload(42, Some("t7"), "Review this request", &inline).unwrap();
        assert_eq!(inline_payload["message_thread_id"], 7);
        let callback_data = inline_payload["reply_markup"]["inline_keyboard"][0][0]
            ["callback_data"]
            .as_str()
            .unwrap();
        assert_eq!(
            decode_callback_data(callback_data).unwrap(),
            ChannelActionEvent {
                action_id: "review.approve".to_owned(),
                label: "Approve".to_owned(),
                payload: json!({ "requestId": "7" }),
            }
        );
    }

    #[tokio::test]
    async fn callback_update_routes_typed_action_and_sends_returned_buttons() {
        use crate::pairing::{AccessPolicy, DmPolicy};
        use axum::extract::Path;

        async fn telegram_api(
            Path((_token, method)): Path<(String, String)>,
            State(calls): State<mpsc::UnboundedSender<(String, Value)>>,
            axum::Json(body): axum::Json<Value>,
        ) -> axum::Json<Value> {
            let result = if method == "sendMessage" {
                json!({ "message_id": 89 })
            } else {
                json!(true)
            };
            let _ = calls.send((method, body));
            axum::Json(json!({ "ok": true, "result": result }))
        }

        let (core_tx, mut core_rx) = mpsc::unbounded_channel();
        let core_app = Router::new().route(
            "/api/channels/run",
            axum::routing::post(move |axum::Json(body): axum::Json<Value>| {
                let core_tx = core_tx.clone();
                async move {
                    let _ = core_tx.send(body);
                    axum::Json(json!({
                        "reply": "Choose what to do next.",
                        "assistantMessageId": "assistant-1",
                        "assistantMessageIds": ["assistant-1"],
                        "interactiveMarkup": {
                            "layout": "inline",
                            "rows": [[{
                                "label": "Continue",
                                "action": {
                                    "type": "callback",
                                    "actionId": "workflow.continue",
                                    "payload": { "ticketId": "42" }
                                }
                            }]]
                        }
                    }))
                }
            }),
        );
        let core_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let core_url = format!("http://{}", core_listener.local_addr().unwrap());
        let core_server = tokio::spawn(async move {
            axum::serve(core_listener, core_app).await.unwrap();
        });

        let (telegram_tx, mut telegram_rx) = mpsc::unbounded_channel();
        let telegram_app = Router::new()
            .route("/:token/:method", axum::routing::post(telegram_api))
            .with_state(telegram_tx);
        let telegram_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let telegram_base = format!(
            "http://{}/bot-test",
            telegram_listener.local_addr().unwrap()
        );
        let telegram_server = tokio::spawn(async move {
            axum::serve(telegram_listener, telegram_app).await.unwrap();
        });

        let mut config = make_cfg("test-token");
        config.common.core_url = core_url;
        config.common.channel_id = Some("channel-test".to_owned());
        config.common.access = AccessPolicy {
            dm: DmPolicy::Open,
            ..Default::default()
        };
        config.options.base_url = Some(telegram_base);
        let channel = Arc::new(
            TelegramChannel::new(
                config,
                reqwest::Client::new(),
                crate::pairing::PairingStore::ephemeral(),
            )
            .unwrap(),
        );

        let action = ChannelActionEvent {
            action_id: "workflow.continue".to_owned(),
            label: "Continue".to_owned(),
            payload: json!({ "ticketId": "42" }),
        };
        let callback_data = encode_callback_data(&action).unwrap();
        channel.dispatch_update(
            Arc::new(TestHost),
            Update {
                update_id: 54,
                callback_query: Some(CallbackQuery {
                    id: "callback-54".to_owned(),
                    from: TgUser {
                        id: 7,
                        first_name: "Ada".to_owned(),
                    },
                    message: Some(Message {
                        chat: Chat {
                            id: 42,
                            chat_type: "private".to_owned(),
                        },
                        message_id: 88,
                        reply_markup: Some(json!({
                            "inline_keyboard": [[{
                                "text": "Continue",
                                "callback_data": callback_data.clone()
                            }]]
                        })),
                        ..Default::default()
                    }),
                    data: Some(callback_data),
                }),
                ..Default::default()
            },
            &me(),
            None,
        );

        let core_request = tokio::time::timeout(Duration::from_secs(3), core_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(core_request["text"], "Selected: Continue");
        assert_eq!(
            core_request["channelAction"]["actionId"],
            "workflow.continue"
        );
        assert_eq!(core_request["channelAction"]["payload"]["ticketId"], "42");

        let mut methods = Vec::new();
        let mut sent_markup = None;
        for _ in 0..4 {
            let (method, body) = tokio::time::timeout(Duration::from_secs(3), telegram_rx.recv())
                .await
                .unwrap()
                .unwrap();
            if method == "sendMessage" {
                sent_markup = Some(body["reply_markup"].clone());
            }
            methods.push(method);
            if methods.iter().any(|method| method == "answerCallbackQuery") && sent_markup.is_some()
            {
                break;
            }
        }
        assert!(methods.iter().any(|method| method == "answerCallbackQuery"));
        assert!(
            sent_markup.is_some(),
            "Telegram methods called: {methods:?}"
        );
        assert_eq!(
            sent_markup.unwrap()["inline_keyboard"][0][0]["text"],
            "Continue"
        );

        core_server.abort();
        telegram_server.abort();
    }

    #[test]
    fn rich_payload_sends_markdown_and_nothing_else() {
        let payload = rich_payload(42, Some("t7"), "# Title\n\n- a");
        assert_eq!(payload["chat_id"], 42);
        assert_eq!(payload["message_thread_id"], 7);
        assert_eq!(payload["rich_message"]["markdown"], "# Title\n\n- a");
        // InputRichMessage takes EXACTLY ONE of html/markdown/blocks.
        let rich = payload["rich_message"].as_object().unwrap();
        assert_eq!(rich.len(), 1);
        assert!(!rich.contains_key("html") && !rich.contains_key("blocks"));
    }

    #[test]
    fn draft_payload_uses_the_plain_placeholder_when_empty() {
        // Empty text is the documented "Thinking…" placeholder, and only the
        // plain draft method expresses it.
        let (method, payload) = draft_payload(42, None, 5, "", true);
        assert_eq!(method, "sendMessageDraft");
        assert_eq!(payload["text"], "");
        assert_eq!(payload["draft_id"], 5);

        // A partial with rich text on uses the rich draft method.
        let (method, payload) = draft_payload(42, Some("t7"), 5, "partial", true);
        assert_eq!(method, "sendRichMessageDraft");
        assert_eq!(payload["rich_message"]["markdown"], "partial");
        assert_eq!(payload["message_thread_id"], 7);

        // Rich text off keeps the plain method for a partial too.
        let (method, payload) = draft_payload(42, None, 5, "partial", false);
        assert_eq!(method, "sendMessageDraft");
        assert_eq!(payload["text"], "partial");
    }

    #[test]
    fn commands_payload_is_a_bot_command_array() {
        let cmds = vec![
            ChannelCommand {
                name: "proof".to_string(),
                description: "prove it".to_string(),
                source: "plugin".to_string(),
            },
            ChannelCommand {
                name: "goal".to_string(),
                description: "set a goal".to_string(),
                source: "builtin".to_string(),
            },
        ];
        let payload = commands_payload(&cmds);
        let list = payload["commands"].as_array().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["command"], "proof");
        assert_eq!(list[0]["description"], "prove it");
        // `source` is Ryu-internal and has no place in a BotCommand.
        assert!(list[0].get("source").is_none());
    }

    #[test]
    fn guest_reply_payload_is_an_inline_article() {
        let payload = guest_reply_payload("q-123", "the answer");
        assert_eq!(payload["guest_query_id"], "q-123");
        assert_eq!(payload["result"]["type"], "article");
        assert_eq!(
            payload["result"]["input_message_content"]["message_text"],
            "the answer"
        );
        // InlineQueryResult.id is capped at 64 bytes; a constant cannot bust it.
        assert!(payload["result"]["id"].as_str().unwrap().len() <= 64);
    }

    #[test]
    fn guest_turns_are_keyed_on_the_query_id_not_the_chat() {
        let message: Message = serde_json::from_value(json!({
            "chat": { "id": 99, "type": "private" },
            "message_id": 3,
            "guest_query_id": "gq-7",
            "text": "hello there",
            "from": { "id": 5, "first_name": "Ada" }
        }))
        .unwrap();

        let inbound = guest_inbound(&message).unwrap();
        // The CONVERSATION is the query…
        assert_eq!(inbound.chat_id, "guest#gq-7");
        // …but the pairing IDENTITY is the person, or every guest message would
        // present as a new stranger and mint a pairing code nobody can use.
        assert_eq!(inbound.identity(), "5");
        assert_eq!(inbound.author_name.as_deref(), Some("Ada"));
        assert!(!inbound.is_group);
        // The chat id (99) must never surface — the docs warn it may collide
        // with an unrelated chat.
        assert!(!inbound.chat_id.contains("99"));
        assert_eq!(guest_query_of(&inbound.chat_id), Some("gq-7"));
        assert_eq!(guest_query_of("42:t7"), None);

        // With no sender, `identity()` falls back to the conversation key —
        // closed-by-default, same as any unknown DM.
        let anonymous: Message = serde_json::from_value(json!({
            "chat": { "id": 99 },
            "guest_query_id": "gq-8",
            "text": "hi"
        }))
        .unwrap();
        assert_eq!(guest_inbound(&anonymous).unwrap().identity(), "guest#gq-8");

        // A message with no query id is not a guest turn.
        let plain = Message::default();
        assert!(guest_inbound(&plain).is_none());
    }

    // ─── Inbound media ──────────────────────────────────────────────────────

    #[test]
    fn attachment_parsing_reads_every_media_field() {
        let message: Message = serde_json::from_value(json!({
            "chat": { "id": 1, "type": "private" },
            "message_id": 8,
            "voice": { "file_id": "v1", "mime_type": "audio/ogg", "file_size": 2048 },
            "photo": [
                { "file_id": "small", "file_size": 100 },
                { "file_id": "large", "file_size": 900 }
            ],
            "document": { "file_id": "d1", "mime_type": "application/pdf", "file_name": "spec.pdf" }
        }))
        .unwrap();

        let attachments = attachments_from(&message);
        assert_eq!(attachments.len(), 3);

        let voice = &attachments[0];
        assert_eq!(voice.resolved_kind(), AttachmentKind::Voice);
        assert!(voice.resolved_kind().is_speech());
        assert_eq!(voice.file_id.as_deref(), Some("v1"));
        assert_eq!(voice.size, Some(2048));
        // No filename on a voice note; the MIME gives it a usable extension.
        assert_eq!(voice.safe_filename(), "audio.ogg");

        // The LARGEST photo size is taken — Telegram lists smallest first.
        let photo = &attachments[1];
        assert_eq!(photo.file_id.as_deref(), Some("large"));
        assert_eq!(photo.resolved_kind(), AttachmentKind::Image);
        assert!(!photo.resolved_kind().is_speech());

        // A document is classified by its MIME rather than assumed to be a file.
        let doc = &attachments[2];
        assert_eq!(doc.resolved_kind(), AttachmentKind::Document);
        assert_eq!(doc.filename.as_deref(), Some("spec.pdf"));

        // A text-only message has nothing to download.
        let bare: Message =
            serde_json::from_value(json!({ "chat": { "id": 1 }, "text": "hi" })).unwrap();
        assert!(attachments_from(&bare).is_empty());
    }

    #[test]
    fn an_audio_document_is_still_transcribed() {
        // Telegram delivers an uncompressed voice recording as a document; the
        // MIME fallback is what keeps it on the speech path.
        let message: Message = serde_json::from_value(json!({
            "chat": { "id": 1 },
            "document": { "file_id": "d2", "mime_type": "audio/mpeg", "file_name": "note.mp3" }
        }))
        .unwrap();
        let attachments = attachments_from(&message);
        assert_eq!(attachments[0].resolved_kind(), AttachmentKind::Audio);
        assert!(attachments[0].resolved_kind().is_speech());
    }

    // ─── Wire parsing ───────────────────────────────────────────────────────

    #[test]
    fn parses_getupdates_response() {
        let raw = json!({
            "ok": true,
            "result": [
                {
                    "update_id": 42,
                    "message": {
                        "chat": { "id": 99 },
                        "text": "hello bot"
                    }
                }
            ]
        });
        let parsed: GetUpdatesResponse = serde_json::from_value(raw).unwrap();
        assert!(parsed.ok);
        assert_eq!(parsed.result.len(), 1);
        let update = &parsed.result[0];
        assert_eq!(update.update_id, 42);
        let message = update.message.as_ref().unwrap();
        assert_eq!(message.chat.id, 99);
        assert_eq!(message.text.as_deref(), Some("hello bot"));
        // Absent optional fields must parse as "not present".
        assert!(message.message_thread_id.is_none());
        assert!(message.voice.is_none());
        assert_eq!(message.message_id, 0);
    }

    #[test]
    fn parses_reaction_updates_without_treating_them_as_new_messages() {
        let raw = json!({
            "update_id": 43,
            "message_reaction": {
                "chat": { "id": 99, "type": "private" },
                "message_id": 17,
                "user": { "id": 7, "first_name": "Ada" },
                "new_reaction": [{ "type": "emoji", "emoji": "👍" }],
                "message_thread_id": 4
            }
        });
        let parsed: Update = serde_json::from_value(raw).unwrap();
        assert!(parsed.message.is_none());
        let reaction = parsed.message_reaction.expect("reaction update");
        assert_eq!(reaction.chat.id, 99);
        assert_eq!(reaction.message_id, 17);
        assert_eq!(reaction.user.as_ref().map(|user| user.id), Some(7));
        assert_eq!(reaction.message_thread_id, Some(4));
        assert_eq!(reaction.new_reaction[0].emoji.as_deref(), Some("👍"));
    }

    #[test]
    fn a_rejected_call_is_visible_despite_http_200() {
        // The failure mode the fallback in `send_rich` depends on.
        let envelope: ApiEnvelope = serde_json::from_value(json!({
            "ok": false,
            "description": "Bad Request: method not found"
        }))
        .unwrap();
        assert!(!envelope.ok);
        assert_eq!(
            envelope.description.as_deref(),
            Some("Bad Request: method not found")
        );
    }

    #[test]
    fn getme_exposes_the_bot_level_feature_flags() {
        let me: BotUser = serde_json::from_value(json!({
            "id": 999,
            "username": "ryubot",
            "has_topics_enabled": true,
            "supports_guest_queries": true
        }))
        .unwrap();
        assert!(me.has_topics_enabled && me.supports_guest_queries);

        // An older Bot API server omits both; they must default to false rather
        // than failing the whole getMe.
        let old: BotUser = serde_json::from_value(json!({ "id": 1 })).unwrap();
        assert!(!old.has_topics_enabled && !old.supports_guest_queries);
    }

    fn flood_envelope(retry_after: u64) -> ApiEnvelope {
        serde_json::from_value(json!({
            "ok": false,
            "error_code": 429,
            "description": format!("Too Many Requests: retry after {retry_after}"),
            "parameters": { "retry_after": retry_after }
        }))
        .unwrap()
    }

    #[test]
    fn retry_delay_waits_out_only_short_flood_control() {
        assert_eq!(
            retry_delay(reqwest::StatusCode::TOO_MANY_REQUESTS, &flood_envelope(7)),
            Some(Duration::from_secs(7))
        );
        // The envelope alone is enough: a rejected call may arrive with HTTP 200.
        assert_eq!(
            retry_delay(reqwest::StatusCode::OK, &flood_envelope(7)),
            Some(Duration::from_secs(7))
        );
        // Longer than the inline cap: fail now and leave it to the outer retry.
        assert_eq!(
            retry_delay(reqwest::StatusCode::TOO_MANY_REQUESTS, &flood_envelope(31)),
            None
        );
        let bad_request: ApiEnvelope = serde_json::from_value(json!({
            "ok": false,
            "error_code": 400,
            "description": "Bad Request: chat not found",
            "parameters": { "retry_after": 7 }
        }))
        .unwrap();
        assert_eq!(
            retry_delay(reqwest::StatusCode::BAD_REQUEST, &bad_request),
            None
        );
        let no_wait: ApiEnvelope =
            serde_json::from_value(json!({ "ok": false, "error_code": 429 })).unwrap();
        assert_eq!(
            retry_delay(reqwest::StatusCode::TOO_MANY_REQUESTS, &no_wait),
            None
        );
    }

    type BotApiCalls = Arc<std::sync::Mutex<Vec<(String, Value)>>>;
    type BotApiResponder = Arc<dyn Fn(&str, usize) -> (StatusCode, Value) + Send + Sync>;

    #[derive(Clone)]
    struct MockBotApi {
        calls: BotApiCalls,
        responder: BotApiResponder,
    }

    async fn mock_bot_api_method(
        axum::extract::Path((_token, method)): axum::extract::Path<(String, String)>,
        State(api): State<MockBotApi>,
        axum::Json(body): axum::Json<Value>,
    ) -> (StatusCode, axum::Json<Value>) {
        let earlier_calls = {
            let mut calls = api.calls.lock().unwrap();
            let earlier = calls.iter().filter(|(name, _)| name == &method).count();
            calls.push((method.clone(), body));
            earlier
        };
        let (status, reply) = (api.responder)(&method, earlier_calls);
        (status, axum::Json(reply))
    }

    /// A Bot API stand-in whose `responder` gets the method name and how many
    /// earlier calls that method has seen. Returns the channel and the call log.
    async fn channel_with_mock_bot_api(
        responder: BotApiResponder,
    ) -> (TelegramChannel, BotApiCalls, tokio::task::JoinHandle<()>) {
        let calls = BotApiCalls::default();
        let app = Router::new()
            .route("/:token/:method", post(mock_bot_api_method))
            .with_state(MockBotApi {
                calls: Arc::clone(&calls),
                responder,
            });
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/bot-test", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut config = make_cfg("test-token");
        config.options.base_url = Some(base);
        let channel =
            TelegramChannel::new(config, reqwest::Client::new(), PairingStore::ephemeral())
                .unwrap();
        (channel, calls, server)
    }

    fn sent(message_id: i64) -> (StatusCode, Value) {
        (
            StatusCode::OK,
            json!({ "ok": true, "result": { "message_id": message_id } }),
        )
    }

    fn flood_control() -> (StatusCode, Value) {
        (
            StatusCode::TOO_MANY_REQUESTS,
            json!({
                "ok": false,
                "error_code": 429,
                "description": "Too Many Requests: retry after 0",
                "parameters": { "retry_after": 0 }
            }),
        )
    }

    #[tokio::test]
    async fn flood_control_is_waited_out_and_retried_once() {
        let (channel, calls, server) = channel_with_mock_bot_api(Arc::new(|_, earlier| {
            if earlier == 0 {
                flood_control()
            } else {
                sent(5)
            }
        }))
        .await;
        let ids = channel.send_text_with_ids("42", "hello").await.unwrap();
        assert_eq!(ids, vec!["5".to_owned()]);
        assert_eq!(calls.lock().unwrap().len(), 2);
        server.abort();

        let (channel, calls, server) =
            channel_with_mock_bot_api(Arc::new(|_, _| flood_control())).await;
        let error = channel
            .send_text_with_ids("42", "hello")
            .await
            .expect_err("a second 429 must fail the call");
        assert!(error.to_string().contains("Too Many Requests"));
        assert_eq!(
            calls.lock().unwrap().len(),
            2,
            "flood control is retried in place exactly once"
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_429_without_an_envelope_still_names_the_status_and_is_not_retried() {
        let (channel, calls, server) = channel_with_mock_bot_api(Arc::new(|_, _| {
            (StatusCode::TOO_MANY_REQUESTS, json!("Too Many Requests"))
        }))
        .await;
        let error = channel
            .send_text_with_ids("42", "hello")
            .await
            .expect_err("a 429 must fail the call");
        assert!(error.to_string().contains("HTTP 429"), "{error}");
        assert!(!error.to_string().contains("test-token"), "{error}");
        assert_eq!(calls.lock().unwrap().len(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn rich_fallback_sends_only_the_undelivered_chunks_as_plain_text() {
        let (channel, calls, server) =
            channel_with_mock_bot_api(Arc::new(|method, earlier| match (method, earlier) {
                ("sendRichMessage", 0) => sent(1),
                ("sendRichMessage", _) => (
                    StatusCode::OK,
                    json!({ "ok": false, "description": "Bad Request: can't parse entities" }),
                ),
                (_, earlier) => sent(2 + i64::try_from(earlier).unwrap()),
            }))
            .await;
        let reply = format!(
            "{}\n{}\n{}",
            "a".repeat(3000),
            "b".repeat(3000),
            "c".repeat(3000)
        );
        let ids = channel.send_rich_with_ids("42", &reply).await.unwrap();
        assert_eq!(ids, vec!["1", "2", "3"]);

        let calls = calls.lock().unwrap();
        let methods: Vec<&str> = calls.iter().map(|(method, _)| method.as_str()).collect();
        assert_eq!(
            methods,
            vec![
                "sendRichMessage",
                "sendRichMessage",
                "sendMessage",
                "sendMessage"
            ]
        );
        let plain: Vec<&str> = calls
            .iter()
            .filter(|(method, _)| method == "sendMessage")
            .filter_map(|(_, body)| body["text"].as_str())
            .collect();
        assert!(plain[0].starts_with('b') && plain[1].starts_with('c'));
        assert!(
            !plain.iter().any(|text| text.starts_with('a')),
            "the chunk already delivered as rich text must not be resent"
        );
        drop(calls);
        server.abort();
    }
}

#[cfg(test)]
mod reaction_tests {
    use super::telegram_reaction;

    #[test]
    fn bot_reactions_pass_through_and_drop_variation_selectors() {
        assert_eq!(telegram_reaction("👍"), Some("👍"));
        assert_eq!(telegram_reaction(" 👀 "), Some("👀"));
        assert_eq!(telegram_reaction("❤️"), Some("❤"));
        assert_eq!(telegram_reaction("❤️‍🔥"), Some("❤\u{200d}🔥"));
    }

    #[test]
    fn common_emoji_outside_the_bot_set_map_to_the_nearest_allowed_one() {
        // `setMessageReaction` rejects these outright, which is why the old ✅
        // completion marker never landed and left 👀 on every message.
        assert_eq!(telegram_reaction("✅"), Some("👌"));
        assert_eq!(telegram_reaction("❌"), Some("👎"));
        assert_eq!(telegram_reaction("😂"), Some("🤣"));
        assert_eq!(telegram_reaction("🥳"), Some("🎉"));
    }

    #[test]
    fn unknown_emoji_are_skipped_rather_than_sent() {
        assert_eq!(telegram_reaction("🦀"), None);
        assert_eq!(telegram_reaction(""), None);
    }
}
