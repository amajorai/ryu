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

mod channel;
mod payloads;
mod updates;
mod webhook;
mod wire;

use payloads::*;
use webhook::*;
use wire::*;

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
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod reaction_tests;
