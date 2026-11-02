//! Discord channel adapter.
//!
//! A Discord bot receives messages over the Gateway WebSocket. The adapter keeps
//! that identified session alive, handles Gateway reconnects and heartbeats, and
//! uses REST only for verbs the socket cannot perform. Everything after "a
//! message arrived" is the shared path:
//! [`handle_turn`] gates it, folds in media, runs it through Core's session seam
//! (or the legacy gateway pipeline) and delivers the reply, so this file owns the
//! Gateway transport plus Discord's own verbs. Slash commands and presence travel
//! through the same identified session; REST history backfill is optional and only
//! fills a cursor after a reconnect.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, warn};

use crate::media::{self, Attachment, AttachmentKind, VoiceDelivery};
use crate::pairing::PairingStore;
use crate::status::StatusReporter;
use crate::{
    claim_inbound_delivery, deliver_inbound, handle_turn_with_delivery, i18n, pack_thread,
    run_claimed_delivery, scoped_delivery_id, unpack_thread, BotProfile, Channel, ChannelCaps,
    ChannelHost, ChannelRuntime, DiscordChannelConfig, DiscordChannelOptions, GroupReplyMode,
    InboundMessage,
};

mod channel;
mod events;
mod wire;

use wire::*;

/// Discord REST API base. Pinned to v10 (the current stable version).
const API_BASE: &str = "https://discord.com/api/v10";

/// Cooldown before retrying after a transport error, so a flaky network or a
/// transient Discord outage doesn't become a tight failure loop.
const ERROR_BACKOFF: Duration = Duration::from_secs(3);

/// Max messages fetched per poll (Discord caps this at 100).
const FETCH_LIMIT: u8 = 50;

/// Timeout for one REST call. Generous enough for a slow round trip, short enough
/// that a hung request cannot stall the poll loop for a watched channel.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// GUILDS + GUILD_MESSAGES + GUILD_MESSAGE_REACTIONS + DIRECT_MESSAGES +
/// MESSAGE_CONTENT. Message Content is privileged and must also be enabled in
/// the Discord developer portal.
const DISCORD_GATEWAY_INTENTS: u64 = 1 | 512 | 1024 | 4096 | 32768;

/// Discord's per-message content ceiling. An agent reply routinely exceeds it, and
/// the API rejects the whole message rather than truncating, so replies are split
/// (see [`split_message`]).
const MAX_MESSAGE_CHARS: usize = 2000;

/// Longest thread name we build. Discord allows 100; keeping well under it means a
/// name derived from a user's first sentence stays readable in the sidebar.
const THREAD_NAME_CHARS: usize = 60;

/// Name used when the triggering message yields nothing nameable (an image with no
/// caption). Discord rejects an empty thread name outright.

/// `auto_archive_duration` for created threads, in minutes. Must be one of
/// 60 / 1440 / 4320 / 10080; a day is the sane default for a conversation thread.
const THREAD_AUTO_ARCHIVE_MINUTES: u32 = 1440;

/// Filename used for a synthesized reply. The `.wav` extension is what makes
/// Discord render an inline player instead of a generic download chip.
const VOICE_FILENAME: &str = "reply.wav";

/// Discord channel types that are threads: `ANNOUNCEMENT_THREAD`,
/// `PUBLIC_THREAD`, `PRIVATE_THREAD`. Only these have a `parent_id` that names
/// a conversation's parent channel; on any other channel it is a category.
const THREAD_CHANNEL_TYPES: [u8; 3] = [10, 11, 12];

/// Most channels one Gateway connection remembers thread parents for. The map
/// holds every channel the bot has seen a message in, including ordinary ones,
/// so it is cleared rather than grown without bound on a very long connection.
const THREAD_PARENT_CACHE_MAX: usize = 4096;

/// Per-connection answers from [`DiscordChannel::parent_channel_id`]: the thread
/// parent for a thread, `None` for any other channel. Only definitive answers are
/// stored, so a failed lookup is retried on the channel's next message.
type ThreadParents = HashMap<String, Option<String>>;

pub struct DiscordChannel {
    /// Core route, access policy, pairing store, status reporter — everything the
    /// shared inbound path needs.
    runtime: ChannelRuntime,
    token: String,
    /// Guild channels polled for new messages.
    channel_ids: Vec<String>,
    /// Answer inside a thread opened on the triggering message rather than in the
    /// channel itself. Gated inside [`Channel::open_thread`] rather than in
    /// [`Channel::caps`]: Discord *can* thread regardless, this is the operator's
    /// choice about whether it should.
    thread_replies: bool,
    options: DiscordChannelOptions,
    application_id: OnceLock<String>,
}

impl DiscordChannel {
    /// Build an adapter with no liveness reporting (env-configured bots).
    pub fn new(
        cfg: DiscordChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
    ) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, pairing, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats
    /// its connection status back to the control plane.
    pub fn new_with_status(
        cfg: DiscordChannelConfig,
        http: reqwest::Client,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        if cfg.token.trim().is_empty() {
            anyhow::bail!("discord channel token is empty");
        }
        // Every watched channel is a guild (multi-user) channel, so the shared gate
        // decides it as a GROUP — and the default group policy is an allowlist that
        // starts empty, which would deny every message the operator explicitly
        // asked this bot to watch. Configuring `channel_ids` IS the operator
        // consent `GroupPolicy::Allowlist` is asking for, so fold them in. Harmless
        // under `Open`/`Disabled`, which never read the list.
        let mut common = cfg.common;
        for channel_id in &cfg.channel_ids {
            if !common
                .access
                .group_allowlist
                .iter()
                .any(|id| id == channel_id)
            {
                common.access.group_allowlist.push(channel_id.clone());
            }
        }
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
            token: cfg.token,
            channel_ids: cfg.channel_ids,
            thread_replies: cfg.thread_replies,
            options: cfg.options,
            application_id: OnceLock::new(),
        })
    }

    fn auth_header(&self) -> String {
        format!("Bot {}", self.token)
    }

    fn http(&self) -> &reqwest::Client {
        &self.runtime.http
    }

    /// Fetch the bot's own user id (`GET /users/@me`) so mention detection can
    /// recognise `<@id>` mentions. Called once at the start of the poll loop; on
    /// failure the loop proceeds with an empty id — in `Mentions` mode that means
    /// no message matches (bot stays quiet) until the next restart.
    async fn get_me_id(&self) -> anyhow::Result<String> {
        let url = format!("{API_BASE}/users/@me");
        let resp = self
            .http()
            .get(&url)
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        let me: DiscordUser = resp.json().await?;
        Ok(me.id)
    }

    /// Fetch messages newer than `after` (a Discord snowflake id) for one channel.
    /// When `after` is empty, fetch the most recent batch to establish a cursor.
    async fn fetch_messages(
        &self,
        channel_id: &str,
        after: Option<&str>,
    ) -> anyhow::Result<Vec<DiscordMessage>> {
        let url = format!("{API_BASE}/channels/{channel_id}/messages");
        let mut query: Vec<(&str, String)> = vec![("limit", FETCH_LIMIT.to_string())];
        if let Some(after) = after {
            query.push(("after", after.to_string()));
        }

        let resp = self
            .http()
            .get(&url)
            .header("Authorization", self.auth_header())
            .query(&query)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;

        let messages: Vec<DiscordMessage> = resp.json().await?;
        Ok(messages)
    }

    /// Post one chunk of content to a channel (or thread — a thread IS a channel).
    async fn post_content(&self, target: &str, content: &str) -> anyhow::Result<()> {
        let url = format!("{API_BASE}/channels/{target}/messages");
        self.http()
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&message_payload(content))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Create a thread hanging off `message_id` and return the new thread's id.
    ///
    /// # Errors
    /// Returns `Err` when Discord refuses (missing `CREATE_PUBLIC_THREADS`, the
    /// message already has a thread, the channel type cannot host one) or the
    /// response carries no id.
    async fn create_thread(
        &self,
        channel_id: &str,
        message_id: &str,
        name: &str,
    ) -> anyhow::Result<String> {
        let url = format!("{API_BASE}/channels/{channel_id}/messages/{message_id}/threads");
        let resp = self
            .http()
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&json!({
                "name": name,
                "auto_archive_duration": THREAD_AUTO_ARCHIVE_MINUTES,
            }))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        let created: DiscordChannelRef = resp.json().await?;
        if created.id.is_empty() {
            anyhow::bail!("discord returned a thread with no id");
        }
        Ok(created.id)
    }

    /// Download the speech attachments on an inbound message so the shared path can
    /// transcribe them.
    ///
    /// Only speech is fetched: an image or a PDF is annotated by its filename
    /// (see [`media::annotate`]) and pulling its bytes would spend bandwidth on
    /// something nothing reads. Discord CDN links are pre-signed and public, so —
    /// importantly — the bot token is NOT sent with them. Every failure degrades to
    /// "this attachment contributes nothing", never to a dropped turn.
    async fn download_speech(&self, message: &InboundMessage) -> Vec<(usize, Vec<u8>)> {
        let mut downloaded = Vec::new();
        for (index, attachment) in message.attachments.iter().enumerate() {
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let Some(url) = attachment.url.as_deref() else {
                continue;
            };
            // The declared size lets an oversized attachment be refused before the
            // bandwidth is spent on it.
            if attachment
                .size
                .is_some_and(|size| size as usize > media::MAX_ATTACHMENT_BYTES)
            {
                warn!(
                    size = attachment.size,
                    "discord attachment exceeds the size cap; skipping download"
                );
                continue;
            }
            match media::download(self.http(), url, &[]).await {
                Ok(bytes) => downloaded.push((index, bytes)),
                Err(err) => warn!(%err, "discord attachment download failed"),
            }
        }
        downloaded
    }
}

#[cfg(test)]
mod tests;
