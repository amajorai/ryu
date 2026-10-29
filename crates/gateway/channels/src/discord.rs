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
    claim_inbound_delivery, deliver_inbound, handle_turn_with_delivery, pack_thread,
    run_claimed_delivery, scoped_delivery_id, unpack_thread, BotProfile, Channel, ChannelCaps,
    ChannelHost, ChannelRuntime, DiscordChannelConfig, DiscordChannelOptions, GroupReplyMode,
    InboundMessage,
};

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
const THREAD_NAME_FALLBACK: &str = "Ryu reply";

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

impl DiscordChannel {
    /// Register Core's command registry as Discord application commands. The
    /// Gateway delivers the resulting `INTERACTION_CREATE` events to the same
    /// connection as messages, so the menu is real rather than decorative.
    async fn publish_commands(
        &self,
        cmds: &[crate::commands::ChannelCommand],
    ) -> anyhow::Result<()> {
        let Some(application_id) = self.application_id.get() else {
            anyhow::bail!("discord application id is not known yet")
        };
        if cmds.is_empty() {
            return Ok(());
        }
        let commands: Vec<Value> = cmds
            .iter()
            .take(100)
            .map(|command| {
                json!({
                    "name": command.name,
                    "description": command.description,
                    "type": 1,
                })
            })
            .collect();
        self.http()
            .put(format!("{API_BASE}/applications/{application_id}/commands"))
            .header("Authorization", self.auth_header())
            .json(&commands)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn gateway_url(&self) -> anyhow::Result<String> {
        let body: GatewayUrlResponse = self
            .http()
            .get(format!("{API_BASE}/gateway/bot"))
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        body.url
            .filter(|url| !url.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("discord Gateway response contained no url"))
    }

    /// Look up whether `channel_id` is a thread and, if so, its parent channel.
    ///
    /// `None` means the lookup failed and the answer is unknown (do not cache
    /// it); `Some(None)` means an ordinary channel; `Some(Some(parent))` a thread.
    async fn parent_channel_id(&self, channel_id: &str) -> Option<Option<String>> {
        let response = self
            .http()
            .get(format!("{API_BASE}/channels/{channel_id}"))
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        let channel = response.json::<DiscordChannelRef>().await.ok()?;
        Some(thread_parent(&channel))
    }

    async fn dispatch_gateway_message(
        self: &Arc<Self>,
        host: Arc<dyn ChannelHost>,
        value: Value,
        me_id: &str,
        thread_parents: &mut ThreadParents,
        last_seen: &mut HashMap<String, String>,
    ) {
        let Ok(message) = serde_json::from_value::<DiscordMessage>(value) else {
            return;
        };
        if message.channel_id.is_empty() || message.id.is_empty() {
            return;
        }
        last_seen.insert(message.channel_id.clone(), message.id.clone());
        if message.author.id == me_id {
            return;
        }
        if message.author.bot.unwrap_or(false) && !self.options.allow_bots {
            return;
        }
        // Checked before the parent lookup so an ignored channel costs no REST.
        if self
            .options
            .ignored_channels
            .iter()
            .any(|id| id == &message.channel_id)
        {
            return;
        }
        let is_group = message.guild_id.is_some();
        let parent = if is_group {
            if let Some(parent) = thread_parents.get(&message.channel_id) {
                parent.clone()
            } else if self.channel_ids.iter().any(|id| id == &message.channel_id) {
                None
            } else {
                // A failed lookup scopes this message to the channel itself and
                // is not cached, so the next message asks again.
                match self.parent_channel_id(&message.channel_id).await {
                    Some(parent) => {
                        remember_thread_parent(thread_parents, &message.channel_id, parent.clone());
                        parent
                    }
                    None => None,
                }
            }
        } else {
            None
        };
        let scope_channel = parent.as_deref().unwrap_or(&message.channel_id);
        if !self.channel_ids.is_empty()
            && is_group
            && !self.channel_ids.iter().any(|id| id == scope_channel)
        {
            return;
        }
        if self
            .options
            .ignored_channels
            .iter()
            .any(|id| id == scope_channel)
        {
            return;
        }
        if is_group
            && !self.options.allowed_channels.is_empty()
            && !self
                .options
                .allowed_channels
                .iter()
                .any(|id| id == scope_channel || id == &message.channel_id)
        {
            return;
        }
        let in_thread = parent.is_some();
        let Some(routed_text) = decide_reply_with_options(
            &message,
            me_id,
            self.runtime.cfg.group_reply_mode,
            in_thread,
            &self.options,
        ) else {
            return;
        };
        let chat_id = inbound_chat_id(&message.channel_id, parent.as_deref());
        let inbound = InboundMessage {
            chat_id,
            access_chat_id: parent.or_else(|| is_group.then(|| message.channel_id.clone())),
            text: routed_text,
            author_name: Some(message.author.username.clone())
                .filter(|name| !name.trim().is_empty()),
            sender_id: Some(message.author.id.clone()).filter(|id| !id.is_empty()),
            message_id: Some(message.id.clone()),
            is_group,
            attachments: parse_attachments(&message),
            channel_action: None,
        };
        let provider_id = format!("message:{}", message.id);
        let channel = Arc::clone(self);
        tokio::spawn(async move {
            let (delivery_id, claim) = match claim_inbound_delivery(&*channel, &provider_id).await {
                Ok(result) => result,
                Err(error) => {
                    warn!(
                        channel = "discord",
                        %error,
                        "discord delivery could not be durably claimed; processing once without dedupe"
                    );
                    let delivery_id = scoped_delivery_id(&*channel, &provider_id);
                    let mut inbound = inbound;
                    let downloaded = channel.download_speech(&inbound).await;
                    if !downloaded.is_empty() {
                        channel.runtime.ingest_media(&mut inbound, downloaded).await;
                    }
                    let _ =
                        handle_turn_with_delivery(channel, host, inbound, Some(&delivery_id)).await;
                    return;
                }
            };
            if !matches!(claim, crate::pairing::DeliveryClaim::Claimed) {
                debug!(
                    channel = "discord",
                    delivery_id = %delivery_id,
                    ?claim,
                    "duplicate discord delivery suppressed"
                );
                return;
            }
            let mut inbound = inbound;
            let downloaded = channel.download_speech(&inbound).await;
            if !downloaded.is_empty() {
                channel.runtime.ingest_media(&mut inbound, downloaded).await;
            }
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

    async fn backfill(
        self: &Arc<Self>,
        host: &Arc<dyn ChannelHost>,
        me_id: &str,
        last_seen: &mut HashMap<String, String>,
        thread_parents: &mut ThreadParents,
    ) {
        for channel_id in &self.channel_ids {
            let Some(after) = last_seen.get(channel_id) else {
                continue;
            };
            match self.fetch_messages(channel_id, Some(after)).await {
                Ok(mut messages) => {
                    messages.reverse();
                    for message in messages {
                        let Ok(value) = serde_json::to_value(message) else {
                            continue;
                        };
                        self.dispatch_gateway_message(
                            Arc::clone(host),
                            value,
                            me_id,
                            thread_parents,
                            last_seen,
                        )
                        .await;
                    }
                }
                Err(err) => warn!(%err, channel_id, "discord history backfill failed"),
            }
        }
    }

    async fn handle_interaction(
        self: &Arc<Self>,
        value: Value,
        host: Arc<dyn ChannelHost>,
        _me_id: &str,
    ) {
        if value["type"].as_u64() != Some(2) {
            return;
        }
        let Some(interaction_id) = value["id"].as_str().map(str::to_string) else {
            return;
        };
        let Some(token) = value["token"].as_str() else {
            return;
        };
        let Some(name) = value["data"]["name"].as_str() else {
            return;
        };
        let mut text = format!("/{name}");
        if let Some(options) = value["data"]["options"].as_array() {
            for option in options {
                if let Some(option_value) = option["value"].as_str() {
                    text.push(' ');
                    text.push_str(option_value);
                }
            }
        }
        let callback = format!("{API_BASE}/interactions/{interaction_id}/{token}/callback");
        if self
            .http()
            .post(callback)
            .json(&json!({ "type": 5 }))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await
            .is_err()
        {
            return;
        }
        let channel_id = value["channel_id"].as_str().unwrap_or_default().to_string();
        if channel_id.is_empty() {
            return;
        }
        let sender_id = value["member"]["user"]["id"]
            .as_str()
            .or_else(|| value["user"]["id"].as_str())
            .map(str::to_string);
        let author_name = value["member"]["user"]["username"]
            .as_str()
            .or_else(|| value["user"]["username"].as_str())
            .map(str::to_string);
        let is_group = value["guild_id"].as_str().is_some();
        if is_group
            && !self.options.allowed_roles.is_empty()
            && !value["member"]["roles"].as_array().is_some_and(|roles| {
                roles.iter().any(|role| {
                    role.as_str().is_some_and(|role| {
                        self.options
                            .allowed_roles
                            .iter()
                            .any(|allowed| allowed == role)
                    })
                })
            })
        {
            return;
        }
        let scope_channel = if is_group {
            self.parent_channel_id(&channel_id)
                .await
                .flatten()
                .unwrap_or_else(|| channel_id.clone())
        } else {
            channel_id.clone()
        };
        if self
            .options
            .ignored_channels
            .iter()
            .any(|id| id == &channel_id || id == &scope_channel)
        {
            return;
        }
        if is_group
            && (!self.channel_ids.is_empty()
                && !self
                    .channel_ids
                    .iter()
                    .any(|id| id == &channel_id || id == &scope_channel)
                || !self.options.allowed_channels.is_empty()
                    && !self
                        .options
                        .allowed_channels
                        .iter()
                        .any(|id| id == &channel_id || id == &scope_channel))
        {
            return;
        }
        let inbound = InboundMessage {
            chat_id: channel_id.clone(),
            access_chat_id: is_group.then_some(scope_channel),
            text,
            author_name,
            sender_id,
            message_id: None,
            is_group,
            attachments: Vec::new(),
            channel_action: None,
        };
        let channel = Arc::clone(self);
        let provider_id = format!("interaction:{interaction_id}");
        let turn_delivery_id = scoped_delivery_id(&*channel, &provider_id);
        deliver_inbound(channel, provider_id, move || {
            let channel = Arc::clone(self);
            let host = Arc::clone(&host);
            let inbound = inbound.clone();
            let delivery_id = turn_delivery_id.clone();
            async move {
                handle_turn_with_delivery(channel, host, inbound, Some(&delivery_id)).await
            }
        })
        .await;
    }
}

#[async_trait]
impl Channel for DiscordChannel {
    fn name(&self) -> &'static str {
        "discord"
    }

    fn runtime(&self) -> &ChannelRuntime {
        &self.runtime
    }

    /// Discord speaks typing indicators, threads, arbitrary file attachments and
    /// reactions.
    ///
    /// `rich_text` is deliberately FALSE: Discord message content already renders
    /// the markdown our replies are written in, so plain `content` *is* the rich
    /// surface. Claiming otherwise would send replies through [`Channel::send_rich`]
    /// for no behavioural difference. Streaming drafts are false because Discord
    /// has no draft surface; command menus are registered through interactions.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps {
            typing: true,
            rich_text: false,
            streaming: false,
            threads: true,
            command_menu: true,
            voice: true,
            attachments: true,
            reactions: true,
            reply_keyboards: false,
            inline_buttons: false,
        }
    }

    /// Discord's typing indicator lasts 10 seconds, so re-assert it a little under
    /// that rather than on the kernel's tighter Telegram-shaped default.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(8)
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let target = target_channel(chat_id).to_string();
        for chunk in split_message(text, MAX_MESSAGE_CHARS) {
            self.post_content(&target, &chunk).await?;
        }
        Ok(())
    }

    async fn send_typing(&self, chat_id: &str) -> anyhow::Result<()> {
        let target = target_channel(chat_id);
        let url = format!("{API_BASE}/channels/{target}/typing");
        self.http()
            .post(&url)
            .header("Authorization", self.auth_header())
            // Discord requires a body on this POST; an empty JSON object is the
            // documented shape.
            .json(&json!({}))
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Upload the synthesized WAV as a file attachment.
    ///
    /// Discord's true voice-message flag needs an OGG/Opus body plus a waveform,
    /// which Core's TTS does not produce — so [`media::wav_delivery`] reports
    /// [`VoiceDelivery::AudioFile`] and this sends a playable attachment instead of
    /// faking a voice bubble.
    async fn send_voice(
        &self,
        chat_id: &str,
        wav: Vec<u8>,
        delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        if delivery == VoiceDelivery::Unsupported {
            anyhow::bail!("discord was asked to deliver audio it cannot carry");
        }
        let target = target_channel(chat_id);
        let url = format!("{API_BASE}/channels/{target}/messages");
        let part = reqwest::multipart::Part::bytes(wav)
            .file_name(VOICE_FILENAME)
            .mime_str("audio/wav")?;
        let form = reqwest::multipart::Form::new()
            .text("payload_json", voice_payload(VOICE_FILENAME).to_string())
            .part("files[0]", part);
        self.http()
            .post(&url)
            .header("Authorization", self.auth_header())
            .multipart(form)
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn react(&self, chat_id: &str, message_id: &str, emoji: &str) -> anyhow::Result<()> {
        let target = target_channel(chat_id);
        let encoded = encode_emoji(emoji);
        let url =
            format!("{API_BASE}/channels/{target}/messages/{message_id}/reactions/{encoded}/@me");
        self.http()
            .put(&url)
            // Discord requires a length on this bodyless PUT; reqwest emits
            // `content-length: 0` for an empty body, so nothing else is needed.
            .body(Vec::new())
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Take back this bot's own reaction (`DELETE …/reactions/{emoji}/@me`).
    async fn remove_reaction(
        &self,
        chat_id: &str,
        message_id: &str,
        emoji: &str,
    ) -> anyhow::Result<()> {
        let target = target_channel(chat_id);
        let encoded = encode_emoji(emoji);
        let url =
            format!("{API_BASE}/channels/{target}/messages/{message_id}/reactions/{encoded}/@me");
        self.http()
            .delete(&url)
            .header("Authorization", self.auth_header())
            .timeout(REQUEST_TIMEOUT)
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    /// Push the operator's bot profile. Discord splits it across two objects: the
    /// bot USER carries the name, the APPLICATION carries the description shown on
    /// the app's profile. There is no equivalent of a short bio, so that field is
    /// left unpublished rather than crammed into the description.
    async fn publish_profile(&self, profile: &BotProfile) -> anyhow::Result<()> {
        if let Some(name) = profile.name.as_deref().filter(|n| !n.trim().is_empty()) {
            self.http()
                .patch(format!("{API_BASE}/users/@me"))
                .header("Authorization", self.auth_header())
                .json(&json!({ "username": name }))
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await?
                .error_for_status()?;
        }
        if let Some(description) = profile
            .description
            .as_deref()
            .filter(|d| !d.trim().is_empty())
        {
            self.http()
                .patch(format!("{API_BASE}/applications/@me"))
                .header("Authorization", self.auth_header())
                .json(&json!({ "description": description }))
                .timeout(REQUEST_TIMEOUT)
                .send()
                .await?
                .error_for_status()?;
        }
        Ok(())
    }

    /// Answer inside a thread hung off the triggering message, keeping a busy
    /// channel readable and giving each exchange its own Core history (the packed
    /// key is the conversation id).
    ///
    /// Returns a conversation key, not a `Result`: a thread that could not be
    /// created must degrade to the parent channel, because losing the reply is far
    /// worse than losing the thread.
    async fn open_thread(&self, chat_id: &str, message: &InboundMessage) -> String {
        if !self.thread_replies {
            return chat_id.to_string();
        }
        let (channel_id, existing) = unpack_thread(chat_id);
        if self
            .options
            .no_thread_channels
            .iter()
            .any(|id| id == channel_id)
        {
            return chat_id.to_string();
        }
        if existing.is_some() {
            // Already inside a thread — nest no further.
            return chat_id.to_string();
        }
        let Some(message_id) = message.message_id.as_deref() else {
            return chat_id.to_string();
        };
        let name = thread_name(&message.text);
        match self.create_thread(channel_id, message_id, &name).await {
            Ok(thread_id) => pack_thread(channel_id, Some(&thread_id)),
            Err(err) => {
                warn!(
                    channel_id = %channel_id,
                    %err,
                    "discord thread creation failed; answering in the parent channel"
                );
                chat_id.to_string()
            }
        }
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("discord channel Gateway loop started");
        if let Some(reporter) = &self.runtime.status {
            reporter.connecting().await;
        }
        let profile = self.runtime.cfg.profile.clipped();
        if !profile.is_empty() {
            if let Err(err) = self.publish_profile(&profile).await {
                warn!(%err, "discord profile publish failed");
            }
        }
        let me_id = match self.get_me_id().await {
            Ok(id) => id,
            Err(err) => {
                warn!(error = %err, "discord get_me failed; mention detection disabled");
                String::new()
            }
        };
        let _ = self.application_id.set(me_id.clone());
        if self.runtime.cfg.publish_commands {
            let commands = self.runtime.refresh_commands().await;
            if let Err(err) = self.publish_commands(&commands).await {
                warn!(%err, "discord application commands not published");
            }
        }

        let mut reconnect_attempt = 0u32;
        let mut last_seen: HashMap<String, String> = HashMap::new();
        loop {
            let gateway = match self.gateway_url().await {
                Ok(url) => url,
                Err(err) => {
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    warn!(%err, "discord Gateway URL lookup failed");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
                    continue;
                }
            };
            let url = format!("{gateway}?v=10&encoding=json");
            let (mut ws, _) = match tokio_tungstenite::connect_async(&url).await {
                Ok(pair) => pair,
                Err(err) => {
                    reconnect_attempt = reconnect_attempt.saturating_add(1);
                    warn!(%err, "discord Gateway connection failed");
                    if let Some(reporter) = &self.runtime.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
                    continue;
                }
            };
            // Do NOT reset the backoff on a bare socket open: Discord closes a
            // session right after IDENTIFY for a revoked token (4004) or
            // disallowed intents (4014). Resetting here re-IDENTIFIED every 3 s,
            // burning the 1000-per-day identify budget (Discord then resets the
            // bot token). The counter resets only on READY/RESUMED below.
            reconnect_attempt = reconnect_attempt.saturating_add(1);

            let hello = match ws.next().await {
                Some(Ok(WsMessage::Text(text))) => serde_json::from_str::<GatewayEnvelope>(&text)
                    .ok()
                    .filter(|envelope| envelope.op == 10),
                _ => None,
            };
            let Some(hello) = hello else {
                warn!("discord Gateway did not send HELLO");
                tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
                continue;
            };
            let heartbeat_ms = hello
                .d
                .as_ref()
                .and_then(|value| value["heartbeat_interval"].as_u64())
                .unwrap_or(41_250);
            ws.send(WsMessage::Text(
                json!({
                    "op": 2,
                    "d": {
                        "token": self.token,
                        "intents": DISCORD_GATEWAY_INTENTS,
                            "properties": {
                                "os": "ryu",
                                "browser": "ryu",
                                "device": "ryu",
                            },
                            "presence": {
                                "since": 0,
                                "activities": [{"name": "Ryu", "type": 0}],
                                "status": "online",
                                "afk": false
                            }
                    }
                })
                .to_string(),
            ))
            .await?;

            let mut heartbeat = tokio::time::interval(Duration::from_millis(heartbeat_ms));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut thread_parents = ThreadParents::new();
            loop {
                tokio::select! {
                    _ = heartbeat.tick() => {
                        if ws.send(WsMessage::Text(json!({"op": 1, "d": Value::Null}).to_string())).await.is_err() {
                            break;
                        }
                    }
                    frame = ws.next() => {
                        let Some(frame) = frame else { break; };
                        let payload = match frame {
                            Ok(WsMessage::Text(text)) => text,
                            Ok(WsMessage::Ping(data)) => { let _ = ws.send(WsMessage::Pong(data)).await; continue; }
                            Ok(WsMessage::Close(_)) => break,
                            Ok(_) => continue,
                            Err(err) => { warn!(%err, "discord Gateway frame failed"); break; }
                        };
                        let Ok(envelope) = serde_json::from_str::<GatewayEnvelope>(&payload) else { continue; };
                        if envelope.op == 7 || envelope.op == 9 {
                            break;
                        }
                        if envelope.op == 0 {
                            match envelope.event_name.as_deref() {
                                Some("READY") | Some("RESUMED") => {
                                    reconnect_attempt = 0;
                                    if let Some(reporter) = &self.runtime.status { reporter.online().await; }
                                    if self.options.history_backfill {
                                        self.backfill(&host, &me_id, &mut last_seen, &mut thread_parents).await;
                                    }
                                }
                                Some("MESSAGE_CREATE") => {
                                    if let Some(data) = envelope.d {
                                        self.dispatch_gateway_message(Arc::clone(&host), data, &me_id, &mut thread_parents, &mut last_seen).await;
                                    }
                                }
                                Some("INTERACTION_CREATE") => {
                                    if let Some(data) = envelope.d {
                                        // Off the select loop: the interaction runs a whole
                                        // turn, which can take minutes, and awaiting it here
                                        // would starve the heartbeat branch.
                                        let channel = Arc::clone(&self);
                                        let host = Arc::clone(&host);
                                        let me_id = me_id.clone();
                                        tokio::spawn(async move {
                                            channel.handle_interaction(data, host, &me_id).await;
                                        });
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            if let Some(reporter) = &self.runtime.status {
                reporter.connecting().await;
            }
            tokio::time::sleep(reconnect_delay(reconnect_attempt)).await;
        }
    }
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

/// The parent channel of `channel` when it is a thread, `None` otherwise.
///
/// A text channel's `parent_id` is its category, which must never become a
/// conversation scope: that would treat every categorized channel as a thread
/// (answering without a mention) and key its history to the category.
fn thread_parent(channel: &DiscordChannelRef) -> Option<String> {
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
fn remember_thread_parent(cache: &mut ThreadParents, channel_id: &str, parent: Option<String>) {
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
fn inbound_chat_id(channel_id: &str, parent_channel_id: Option<&str>) -> String {
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
fn target_channel(packed: &str) -> &str {
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
fn split_message(text: &str, max: usize) -> Vec<String> {
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
/// [`THREAD_NAME_FALLBACK`] because Discord rejects an empty name — an image sent
/// with no caption must still get a thread.
fn thread_name(text: &str) -> String {
    let cleaned: String = text.chars().filter(|ch| !ch.is_control()).collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let clipped: String = collapsed.chars().take(THREAD_NAME_CHARS).collect();
    let trimmed = clipped.trim();
    if trimmed.is_empty() {
        THREAD_NAME_FALLBACK.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Percent-encode an emoji for the reactions path segment.
///
/// Hand-rolled rather than pulling an encoder in for one call site. `:` is left
/// intact on purpose: a custom emoji is addressed as `name:id`, and encoding the
/// separator turns a valid custom reaction into a 400.
fn encode_emoji(emoji: &str) -> String {
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
fn allowed_mentions() -> Value {
    json!({ "parse": ["users"] })
}

/// The JSON body for one text message create.
fn message_payload(content: &str) -> Value {
    json!({
        "content": content,
        "allowed_mentions": allowed_mentions(),
    })
}

/// The `payload_json` half of a file upload. Discord maps a `files[N]` part to an
/// entry in `attachments` by its `id`, so the two must agree or the upload is
/// accepted with no attachment on it.
fn voice_payload(filename: &str) -> Value {
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
fn parse_attachments(message: &DiscordMessage) -> Vec<Attachment> {
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
fn decide_reply(message: &DiscordMessage, me_id: &str, mode: GroupReplyMode) -> Option<String> {
    decide_reply_with_options(
        message,
        me_id,
        mode,
        false,
        &DiscordChannelOptions::default(),
    )
}

fn decide_reply_with_options(
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
struct DiscordMessage {
    id: String,
    #[serde(default)]
    channel_id: String,
    #[serde(default)]
    guild_id: Option<String>,
    #[serde(default)]
    content: String,
    author: DiscordUser,
    /// Users explicitly mentioned in the message — the authoritative source for
    /// detecting whether the bot was addressed.
    #[serde(default)]
    mentions: Vec<DiscordUser>,
    /// Guild member roles used by the optional role allowlist.
    #[serde(default)]
    member: Option<DiscordMember>,
    #[serde(default)]
    attachments: Vec<DiscordAttachment>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DiscordMember {
    #[serde(default)]
    roles: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DiscordUser {
    #[serde(default)]
    id: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    bot: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DiscordAttachment {
    #[serde(default)]
    url: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    content_type: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    /// Present only on a true voice message; its presence is how a push-to-talk
    /// recording is told apart from an uploaded audio file.
    #[serde(default)]
    duration_secs: Option<f64>,
}

/// A channel or created thread, of which only the id, type and parent are needed.
#[derive(Debug, Deserialize)]
struct DiscordChannelRef {
    #[serde(default)]
    id: String,
    #[serde(default)]
    parent_id: Option<String>,
    /// Discord's channel type; see [`THREAD_CHANNEL_TYPES`].
    #[serde(default, rename = "type")]
    kind: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct GatewayUrlResponse {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GatewayEnvelope {
    op: u8,
    #[serde(default)]
    d: Option<Value>,
    #[serde(rename = "t", default)]
    event_name: Option<String>,
}

fn reconnect_delay(attempt: u32) -> Duration {
    let power = attempt.min(5);
    Duration::from_secs(ERROR_BACKOFF.as_secs().saturating_mul(1u64 << power))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pairing::Decision;
    use crate::CommonChannelConfig;

    fn make_cfg(token: &str, channel_ids: Vec<String>) -> DiscordChannelConfig {
        DiscordChannelConfig {
            token: token.to_string(),
            channel_ids,
            thread_replies: false,
            options: DiscordChannelOptions::default(),
            common: CommonChannelConfig {
                model: "gpt-4o".to_string(),
                ..Default::default()
            },
        }
    }

    fn build(cfg: DiscordChannelConfig) -> anyhow::Result<DiscordChannel> {
        DiscordChannel::new(cfg, reqwest::Client::new(), PairingStore::ephemeral())
    }

    fn msg(content: &str, mentions: Vec<&str>) -> DiscordMessage {
        DiscordMessage {
            id: "1".to_string(),
            channel_id: "chan".to_string(),
            guild_id: Some("guild".to_string()),
            content: content.to_string(),
            author: DiscordUser {
                id: "user-1".to_string(),
                username: "Ada".to_string(),
                bot: Some(false),
            },
            mentions: mentions
                .into_iter()
                .map(|id| DiscordUser {
                    id: id.to_string(),
                    username: String::new(),
                    bot: None,
                })
                .collect(),
            member: None,
            attachments: Vec::new(),
        }
    }

    const BOT_ID: &str = "999";

    #[test]
    fn ignores_bot_authored_messages() {
        let mut message = msg("hi", vec![]);
        message.author.bot = Some(true);
        assert!(decide_reply(&message, BOT_ID, GroupReplyMode::All).is_none());
    }

    #[test]
    fn mentions_mode_ignores_unaddressed_message() {
        let message = msg("just chatting", vec![]);
        assert!(decide_reply(&message, BOT_ID, GroupReplyMode::Mentions).is_none());
    }

    #[test]
    fn mentions_mode_replies_when_mentioned_and_strips_mention() {
        let message = msg("<@999> what is 2+2", vec![BOT_ID]);
        let routed = decide_reply(&message, BOT_ID, GroupReplyMode::Mentions);
        // The speaker is no longer prefixed into the text — it travels as
        // `author_name` on the inbound message instead.
        assert_eq!(routed.as_deref(), Some("what is 2+2"));
    }

    #[test]
    fn mentions_mode_detects_nickname_mention_form() {
        // `<@!id>` is the nickname mention form; both must be recognised/stripped.
        let message = msg("<@!999> hello", vec![]);
        let routed = decide_reply(&message, BOT_ID, GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("hello"));
    }

    #[test]
    fn all_mode_replies_to_every_message() {
        let message = msg("just chatting", vec![]);
        let routed = decide_reply(&message, BOT_ID, GroupReplyMode::All);
        assert_eq!(routed.as_deref(), Some("just chatting"));
    }

    #[test]
    fn role_allowlist_filters_guild_messages() {
        let mut message = msg("role gated", vec![]);
        message.member = Some(DiscordMember {
            roles: vec!["role-allowed".to_string()],
        });
        let options = DiscordChannelOptions {
            allowed_roles: vec!["role-allowed".to_string()],
            ..Default::default()
        };
        assert_eq!(
            decide_reply_with_options(&message, BOT_ID, GroupReplyMode::All, false, &options)
                .as_deref(),
            Some("role gated")
        );
        message.member = Some(DiscordMember {
            roles: vec!["role-other".to_string()],
        });
        assert!(
            decide_reply_with_options(&message, BOT_ID, GroupReplyMode::All, false, &options)
                .is_none()
        );
    }

    #[test]
    fn empty_bot_id_disables_mention_detection() {
        let message = msg("<@999> hi", vec!["999"]);
        assert!(decide_reply(&message, "", GroupReplyMode::Mentions).is_none());
        // All mode still routes (mention detection irrelevant).
        assert_eq!(
            decide_reply(&message, "", GroupReplyMode::All).as_deref(),
            Some("<@999> hi")
        );
    }

    #[test]
    fn media_only_message_is_routed_with_empty_text() {
        // A voice note has no content; dropping it here would make transcription
        // unreachable, so it must survive with empty text.
        let mut message = msg("", vec![]);
        message.attachments.push(DiscordAttachment {
            url: "https://cdn.discordapp.com/a/voice.ogg".to_string(),
            filename: "voice-message.ogg".to_string(),
            content_type: Some("audio/ogg".to_string()),
            size: Some(1024),
            duration_secs: Some(3.5),
        });
        assert_eq!(
            decide_reply(&message, BOT_ID, GroupReplyMode::All).as_deref(),
            Some("")
        );
        // With neither text nor media there is nothing to route.
        let empty = msg("   ", vec![]);
        assert!(decide_reply(&empty, BOT_ID, GroupReplyMode::All).is_none());
    }

    #[test]
    fn new_rejects_empty_token() {
        assert!(build(make_cfg("  ", vec!["123".to_string()])).is_err());
    }

    #[test]
    fn new_rejects_missing_channels() {
        assert!(build(make_cfg("abc", vec![])).is_ok());
    }

    #[test]
    fn builds_auth_header_and_metadata() {
        let mut cfg = make_cfg("secret", vec!["123".to_string()]);
        cfg.common.system_prompt = Some("be nice".to_string());
        let channel = build(cfg).unwrap();
        assert_eq!(channel.auth_header(), "Bot secret");
        assert_eq!(channel.name(), "discord");
        assert_eq!(channel.model(), "gpt-4o");
        assert_eq!(channel.system_prompt(), Some("be nice"));
    }

    #[test]
    fn new_stores_agent_id_and_core_url() {
        let mut cfg = make_cfg("tok:1", vec!["chan1".to_string()]);
        cfg.common.agent_id = Some("acp:pi".to_string());
        let channel = build(cfg).unwrap();
        assert_eq!(channel.runtime.cfg.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(channel.runtime.cfg.core_url, "http://127.0.0.1:7980");
        assert!(channel.runtime.routes_via_core());
    }

    /// Configuring a channel to poll IS the operator consent the group allowlist
    /// asks for. Without this the default policy (allowlist, empty) would deny
    /// every message in the very channels the bot was told to watch.
    #[test]
    fn watched_channels_are_admitted_by_the_group_gate() {
        let channel = build(make_cfg("t", vec!["chan1".to_string()])).unwrap();
        let access = &channel.runtime.cfg.access;
        assert_eq!(access.decide_group("chan1"), Decision::Allow);
        // An unwatched channel is still refused.
        assert_eq!(access.decide_group("chan2"), Decision::Deny);
    }

    #[test]
    fn caps_declare_only_what_the_poll_transport_can_do() {
        let channel = build(make_cfg("t", vec!["c".to_string()])).unwrap();
        let caps = channel.caps();
        assert!(caps.typing && caps.threads && caps.voice && caps.attachments && caps.reactions);
        // Discord content already renders our markdown; there is no separate rich
        // surface to claim.
        assert!(!caps.rich_text);
        // Slash commands need an interactions endpoint or a Gateway socket.
        assert!(caps.command_menu);
        assert!(!caps.streaming);
        // The indicator lasts 10s, so it must be re-asserted under that.
        assert!(channel.typing_interval() < Duration::from_secs(10));
    }

    /// A thread IS a channel, so every outbound verb must address the thread when
    /// the conversation key carries one — using the parent would silently defeat
    /// threaded replies.
    #[test]
    fn conversation_key_resolves_to_the_thread() {
        let packed = pack_thread("111", Some("222"));
        assert_eq!(packed, "111:222");
        assert_eq!(target_channel(&packed), "222");
        // An unthreaded key addresses the channel itself.
        assert_eq!(target_channel("111"), "111");
    }

    #[test]
    fn existing_thread_inbound_key_keeps_parent_before_thread() {
        let packed = inbound_chat_id("thread-222", Some("channel-111"));
        assert_eq!(packed, "channel-111:thread-222");
        assert_eq!(target_channel(&packed), "thread-222");
        assert_eq!(inbound_chat_id("channel-111", None), "channel-111");
    }

    #[test]
    fn thread_names_are_sanitised_and_clipped() {
        assert_eq!(thread_name("  hello   world\n"), "hello world");
        // Control characters never reach Discord.
        assert_eq!(thread_name("a\u{7}b"), "ab");
        // Long prompts are clipped to a readable single line.
        let long = thread_name(&"x".repeat(200));
        assert_eq!(long.chars().count(), THREAD_NAME_CHARS);
        const {
            assert!(THREAD_NAME_CHARS <= 100, "Discord caps thread names at 100");
        }
        // An uncaptioned image must still yield a nameable thread.
        assert_eq!(thread_name("   "), THREAD_NAME_FALLBACK);
        assert_eq!(thread_name(""), THREAD_NAME_FALLBACK);
    }

    #[test]
    fn emoji_encoding_keeps_the_custom_emoji_separator() {
        // A multi-byte unicode emoji is fully percent-encoded.
        assert_eq!(encode_emoji("👍"), "%F0%9F%91%8D");
        // A custom emoji is `name:id`; encoding the colon would 400.
        assert_eq!(encode_emoji("ryu:12345"), "ryu:12345");
        assert_eq!(encode_emoji("a b"), "a%20b");
    }

    #[test]
    fn long_replies_split_on_line_boundaries() {
        let text = format!("{}\n{}", "a".repeat(1500), "b".repeat(900));
        let chunks = split_message(&text, MAX_MESSAGE_CHARS);
        assert_eq!(
            chunks.len(),
            2,
            "the two lines must not be merged over 2000"
        );
        assert!(chunks
            .iter()
            .all(|c| c.chars().count() <= MAX_MESSAGE_CHARS));
        assert!(chunks[0].starts_with('a') && chunks[1].starts_with('b'));

        // A single overlong line has no boundary to split on, so it is hard-split.
        let one_line = "z".repeat(4100);
        let hard = split_message(&one_line, MAX_MESSAGE_CHARS);
        assert_eq!(hard.len(), 3);
        assert_eq!(hard.iter().map(|c| c.chars().count()).sum::<usize>(), 4100);

        // Short text is one chunk; blank text produces no request at all.
        assert_eq!(
            split_message("hi", MAX_MESSAGE_CHARS),
            vec!["hi".to_string()]
        );
        assert!(split_message("   \n\n", MAX_MESSAGE_CHARS).is_empty());
    }

    #[test]
    fn voice_payload_maps_the_file_part_to_an_attachment() {
        let payload = voice_payload(VOICE_FILENAME);
        assert_eq!(payload["attachments"][0]["id"], 0);
        assert_eq!(payload["attachments"][0]["filename"], VOICE_FILENAME);
    }

    /// Reply text is model output a member (or injected content) can steer, so no
    /// message create may let Discord parse `@everyone`, `@here` or role mentions
    /// out of it with the bot's permissions. User mentions stay pingable.
    #[test]
    fn message_creates_never_parse_everyone_here_or_role_mentions() {
        let content = "@everyone @here <@&123> verify at https://evil.example <@456>";
        let text = message_payload(content);
        assert_eq!(text["content"], content);
        for payload in [text, voice_payload(VOICE_FILENAME)] {
            let parse = payload["allowed_mentions"]["parse"]
                .as_array()
                .expect("every message create must carry allowed_mentions.parse");
            assert_eq!(parse, &vec![json!("users")]);
            assert!(payload["allowed_mentions"].get("roles").is_none());
        }
    }

    #[test]
    fn parses_messages_response() {
        let raw = json!([
            {
                "id": "555",
                "content": "hello bot",
                "author": { "bot": false }
            },
            {
                "id": "556",
                "content": "i am a bot",
                "author": { "bot": true }
            }
        ]);
        let parsed: Vec<DiscordMessage> = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "555");
        assert_eq!(parsed[0].content, "hello bot");
        assert_eq!(parsed[0].author.bot, Some(false));
        assert_eq!(parsed[1].author.bot, Some(true));
        assert!(parsed[0].attachments.is_empty());
    }

    #[test]
    fn parses_attachments_into_kernel_shape() {
        let raw = json!({
            "id": "1",
            "content": "",
            "author": { "id": "u1", "username": "Ada", "bot": false },
            "attachments": [
                {
                    "url": "https://cdn.discordapp.com/a/voice-message.ogg",
                    "filename": "voice-message.ogg",
                    "content_type": "audio/ogg",
                    "size": 4096,
                    "duration_secs": 2.25
                },
                {
                    "url": "https://cdn.discordapp.com/a/cat.png",
                    "filename": "cat.png",
                    "content_type": "image/png",
                    "size": 9001
                }
            ]
        });
        let message: DiscordMessage = serde_json::from_value(raw).unwrap();
        let parsed = parse_attachments(&message);
        assert_eq!(parsed.len(), 2);

        // `duration_secs` marks a true voice message, which is what gets transcribed.
        assert_eq!(parsed[0].resolved_kind(), AttachmentKind::Voice);
        assert!(parsed[0].resolved_kind().is_speech());
        assert_eq!(parsed[0].safe_filename(), "voice-message.ogg");
        assert_eq!(parsed[0].size, Some(4096));
        assert!(
            parsed[0].file_id.is_none(),
            "discord serves a direct CDN url"
        );

        // Everything else is classified from its MIME type and never transcribed.
        assert_eq!(parsed[1].resolved_kind(), AttachmentKind::Image);
        assert!(!parsed[1].resolved_kind().is_speech());
    }

    fn channel_ref(raw: Value) -> DiscordChannelRef {
        serde_json::from_value(raw).unwrap()
    }

    #[test]
    fn a_category_parent_is_not_a_thread_parent() {
        let text_channel = channel_ref(json!({ "id": "c1", "type": 0, "parent_id": "category-1" }));
        assert_eq!(thread_parent(&text_channel), None);
        let untyped = channel_ref(json!({ "id": "c1", "parent_id": "category-1" }));
        assert_eq!(thread_parent(&untyped), None);
    }

    #[test]
    fn thread_types_resolve_to_their_parent_channel() {
        for kind in [10, 11, 12] {
            let thread = channel_ref(json!({ "id": "t1", "type": kind, "parent_id": "c1" }));
            assert_eq!(thread_parent(&thread).as_deref(), Some("c1"), "type {kind}");
        }
        let orphan = channel_ref(json!({ "id": "t1", "type": 11 }));
        assert_eq!(thread_parent(&orphan), None);
    }

    #[test]
    fn ordinary_channels_are_cached_so_they_are_looked_up_once() {
        let mut cache = ThreadParents::new();
        remember_thread_parent(&mut cache, "c1", None);
        remember_thread_parent(&mut cache, "t1", Some("c1".to_owned()));
        // `Some(None)` is a cached "not a thread", distinct from "never asked".
        assert_eq!(cache.get("c1"), Some(&None));
        assert_eq!(cache.get("t1"), Some(&Some("c1".to_owned())));
        assert_eq!(cache.get("c2"), None);

        for index in 0..THREAD_PARENT_CACHE_MAX {
            remember_thread_parent(&mut cache, &format!("x{index}"), None);
        }
        assert!(cache.len() <= THREAD_PARENT_CACHE_MAX);
        // Updating a known channel never evicts the rest.
        let before = cache.len();
        let known = cache.keys().next().cloned().unwrap();
        remember_thread_parent(&mut cache, &known, None);
        assert_eq!(cache.len(), before);
    }
}
