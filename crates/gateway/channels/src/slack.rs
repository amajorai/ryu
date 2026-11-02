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
    claim_inbound_delivery, handle_turn_with_delivery, i18n,
    media::{self, Attachment, AttachmentKind, VoiceDelivery},
    pack_thread,
    pairing::PairingStore,
    run_claimed_delivery, scoped_delivery_id,
    status::{StatusReporter, HEARTBEAT_INTERVAL},
    unpack_thread, Channel, ChannelCaps, ChannelHost, ChannelRuntime, GroupReplyMode,
    InboundMessage, SlackChannelConfig, SlackChannelOptions,
};

mod api;
mod channel;
mod inbound;
mod mrkdwn;
mod wire;

use inbound::*;
pub use mrkdwn::*;
use wire::*;

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
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod reaction_name_tests;
