//! Channel layer: external messaging surfaces (Telegram, Slack, WhatsApp,
//! Discord, BlueBubbles/iMessage) that register once at the gateway. Inbound
//! messages become Core session turns; outbound responses route back to the
//! originating chat.
//!
//! # Shape
//!
//! An adapter owns exactly two things: its **transport** (long-poll loop, webhook
//! receiver, socket) and its **platform verbs** (how to send text, show a typing
//! indicator, attach a file). Everything between those two — the access gate, the
//! media round trip, the Core call, the reply delivery — is shared and lives in
//! [`handle_turn`]. Adding a channel therefore means implementing [`Channel`] and
//! nothing else; it does not mean re-deriving how pairing works or how a voice
//! note is transcribed.
//!
//! That split is the reason for [`ChannelRuntime`]: the per-bot state every
//! adapter needs (Core route, access policy, pairing store, voice mode, published
//! command menu) lives in one struct the adapter embeds and exposes via
//! [`Channel::runtime`], instead of being copy-pasted field-by-field into five
//! adapters as it previously was.
//!
//! # Capabilities
//!
//! Platforms differ enormously in what they can express — Telegram has forum
//! topics, rich-text documents and streaming drafts; WhatsApp has none of those.
//! Rather than lowest-common-denominator everything, each adapter declares a
//! [`ChannelCaps`] and the shared path uses the best available verb, falling back
//! to plain text. Every capability method on [`Channel`] has a default
//! implementation, so an adapter only overrides what its platform actually does.
//!
//! # Access
//!
//! Inbound is closed to strangers by default. The gate is [`pairing`]: an unknown
//! DM sender is answered with a one-time code that an operator must approve, and
//! groups are allowlisted. The legacy flat env allowlist
//! (`RYU_CHANNEL_ALLOWED_USERS[_<PLATFORM>]`, `RYU_CHANNEL_ALLOW_ALL`) still
//! configures that policy — see [`policy_from_env`].

pub mod bluebubbles;
pub mod commands;
pub mod discord;
pub mod media;
pub mod openwa;
pub mod pairing;
pub mod slack;
pub mod status;
pub mod telegram;
pub mod voice_call;
pub mod whatsapp;
pub mod whatsapp_format;

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{OwnedSemaphorePermit, RwLock, Semaphore};
use tracing::{debug, info, warn};

use crate::commands::ChannelCommand;
use crate::media::{Attachment, VoiceDelivery, VoiceReplyMode};
use crate::pairing::{AccessPolicy, Decision, DeliveryClaim, DmPolicy, GroupPolicy, PairingStore};
use crate::status::StatusReporter;
pub use ryu_channel_contracts::{
    ChannelActionEvent, InteractiveAction, InteractiveButton, InteractiveLayout, InteractiveMarkup,
};

// ─── Channel-layer configuration (transport-adapter shapes) ─────────────────
//
// These plain structs hold exactly the fields each adapter needs at spawn. The
// config-FILE shapes (serde-derived, profile-aware `core_url` defaults) live in
// `apps/gateway/src/config.rs` — the gateway config shell (kernel §5) — which
// maps them into these at the spawn boundary. `GroupReplyMode` is the shared
// channel-domain type; gateway `config.rs` re-exports it so `config::GroupReplyMode`
// stays a valid path.

/// When a bot replies inside a GROUP/multi-user chat. Direct messages are always
/// answered regardless; this only gates the noisy group case. Mirrors the
/// control-plane `GROUP_REPLY_MODES` (`packages/db/src/models/channel.model.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupReplyMode {
    /// Reply only when the bot is @mentioned, replied to, or addressed by a
    /// command. The safe default — a group bot otherwise answers every message.
    #[default]
    Mentions,
    /// Reply to every message in the group.
    All,
}

/// Maps a platform reaction to the shared Learning thumbs vocabulary.
///
/// This is deliberately part of the channel domain rather than a Telegram
/// option: adapters receive different event shapes, but every one can feed the
/// same `up` / `down` / clear contract into Core. Learning is disabled by
/// default because channel reactions can be authored by more than one person.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct ReactionLearningConfig {
    /// Opt in to turning reactions on bot replies into Learning feedback.
    #[serde(default)]
    pub enabled: bool,
    /// Reactions treated as a positive label. The wire/config spelling follows
    /// the linked Hermes issue; the plural alias is accepted for readability.
    #[serde(
        default = "default_positive_reaction_emojis",
        rename = "positive_emoji",
        alias = "positive_emojis",
        alias = "positiveEmoji"
    )]
    pub positive_emojis: Vec<String>,
    /// Reactions treated as a negative label.
    #[serde(
        default = "default_negative_reaction_emojis",
        rename = "negative_emoji",
        alias = "negative_emojis",
        alias = "negativeEmoji"
    )]
    pub negative_emojis: Vec<String>,
    /// Allow group-room reactions. Off by default because the Core feedback
    /// sink is node-wide rather than a per-sender preference profile.
    #[serde(default, alias = "group_reactions", alias = "allowGroup")]
    pub allow_group: bool,
}

fn default_positive_reaction_emojis() -> Vec<String> {
    vec!["👍".to_string()]
}

fn default_negative_reaction_emojis() -> Vec<String> {
    vec!["👎".to_string()]
}

impl Default for ReactionLearningConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            positive_emojis: default_positive_reaction_emojis(),
            negative_emojis: default_negative_reaction_emojis(),
            allow_group: false,
        }
    }
}

impl ReactionLearningConfig {
    /// Classify one provider-normalized emoji. `None` means clear any existing
    /// label (reaction removal or an emoji outside both configured sets).
    pub fn classify(&self, emoji: &str) -> Option<&'static str> {
        if self
            .positive_emojis
            .iter()
            .any(|candidate| candidate == emoji)
        {
            Some("up")
        } else if self
            .negative_emojis
            .iter()
            .any(|candidate| candidate == emoji)
        {
            Some("down")
        } else {
            None
        }
    }
}

/// Behaviour shared by every channel config, independent of transport.
///
/// Grouped into one struct so adding a knob (a new access policy, a voice mode)
/// is a single edit rather than the same field appended to five config structs
/// and five `to_channel_*` mappers.
#[derive(Debug, Clone)]
pub struct CommonChannelConfig {
    pub model: String,
    pub system_prompt: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    /// Control-plane channel config id. Store-backed bots use it to namespace
    /// platform chat ids so two bot records never share a Core transcript.
    pub channel_id: Option<String>,
    pub group_reply_mode: GroupReplyMode,
    pub core_url: String,
    /// DM/group access rules. Defaults to pairing for DMs and allowlist for
    /// groups; [`policy_from_env`] derives it from the legacy env vars.
    pub access: AccessPolicy,
    /// When to answer with synthesized speech.
    pub voice_reply: VoiceReplyMode,
    /// Show a platform typing indicator while the agent is working.
    pub typing_indicator: bool,
    /// Mark inbound messages read (blue ticks) when the bot picks them up.
    ///
    /// Lives here, not on the two configs whose platforms implement it, because
    /// [`handle_turn`] is what calls [`Channel::mark_read`] — a per-channel field
    /// would be invisible at the only place that reads it, and the setting would
    /// silently ride on `typing_indicator` instead.
    pub send_read_receipts: bool,
    /// Publish the Ryu command menu to the platform where one exists.
    pub publish_commands: bool,
    /// Render replies as platform rich text where supported, instead of plain.
    pub rich_text: bool,
    /// Stream partial output where the platform supports drafts.
    pub streaming: bool,
    /// Show 👀 while a turn is running (taken back once it finishes) and ❌ when
    /// it fails. Platforms that cannot react simply ignore the capability. The
    /// agent's own reaction is mirrored regardless; see [`finish_reactions`].
    pub lifecycle_reactions: bool,
    /// Send Ryu's first plain-language welcome without waiting for a user message.
    /// This is intentionally opt-in: a target is required and the shared access
    /// policy must already admit it before anything leaves the gateway.
    pub proactive_opening: bool,
    /// Direct-chat id to receive the first welcome. This is never inferred from
    /// a token or broadcast to a channel-wide audience.
    pub proactive_target: Option<String>,
    /// Bot profile the adapter pushes at startup (name / short bio / description).
    pub profile: BotProfile,
    /// Optional provider-reaction → Learning feedback bridge.
    pub reaction_learning: ReactionLearningConfig,
}

impl Default for CommonChannelConfig {
    fn default() -> Self {
        Self {
            model: String::new(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            channel_id: None,
            group_reply_mode: GroupReplyMode::default(),
            core_url: "http://127.0.0.1:7980".to_string(),
            access: AccessPolicy::default(),
            voice_reply: VoiceReplyMode::default(),
            typing_indicator: true,
            send_read_receipts: true,
            publish_commands: true,
            rich_text: true,
            streaming: false,
            lifecycle_reactions: true,
            proactive_opening: false,
            proactive_target: None,
            profile: BotProfile::default(),
            reaction_learning: ReactionLearningConfig::default(),
        }
    }
}

/// Operator-customisable bot profile. Empty fields are left untouched on the
/// platform rather than cleared — an operator who sets only a bio should not
/// silently wipe the bot's name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BotProfile {
    /// Display name (Telegram `setMyName`, Discord `PATCH /users/@me`).
    pub name: Option<String>,
    /// Short bio shown on the profile page (Telegram `setMyShortDescription`,
    /// max 120 chars).
    pub short_bio: Option<String>,
    /// Longer description shown in an empty chat (Telegram `setMyDescription`,
    /// max 512 chars).
    pub description: Option<String>,
}

impl BotProfile {
    /// Nothing to push.
    pub fn is_empty(&self) -> bool {
        self.name.is_none() && self.short_bio.is_none() && self.description.is_none()
    }

    /// Clip each field to the platform's documented ceiling so a too-long bio is
    /// truncated rather than rejected wholesale at publish time.
    pub fn clipped(&self) -> Self {
        fn clip(v: &Option<String>, max: usize) -> Option<String> {
            v.as_deref().map(|s| s.chars().take(max).collect())
        }
        Self {
            name: clip(&self.name, 64),
            short_bio: clip(&self.short_bio, 120),
            description: clip(&self.description, 512),
        }
    }
}

/// Telegram bot adapter configuration.
#[derive(Debug, Clone)]
pub struct TelegramChannelConfig {
    pub token: String,
    pub common: CommonChannelConfig,
    pub options: TelegramChannelOptions,
}

/// Telegram transport and group-behaviour options.
#[derive(Debug, Clone)]
pub struct TelegramChannelOptions {
    /// Public webhook URL. When set, polling is replaced by webhook delivery.
    pub webhook_url: Option<String>,
    /// Secret token Telegram sends in `X-Telegram-Bot-Api-Secret-Token`.
    pub webhook_secret: Option<String>,
    /// Local listener for webhook delivery.
    pub webhook_bind: String,
    /// Literal webhook route.
    pub webhook_path: String,
    /// Custom Bot API endpoint (for a local Bot API server or a proxy).
    pub base_url: Option<String>,
    /// Custom file endpoint paired with `base_url`.
    pub base_file_url: Option<String>,
    /// Read `getFile.file_path` from the local filesystem.
    pub local_mode: bool,
    /// Additional case-insensitive address strings for group messages.
    pub mention_patterns: Vec<String>,
    /// Topic ids that must never be answered.
    pub ignored_threads: Vec<String>,
    /// Require the bot's own mention even when a generic pattern matches.
    pub exclusive_bot_mentions: bool,
    /// Accept Telegram guest-query updates.
    pub guest_mode: bool,
    /// Maximum commands sent to Telegram's native menu.
    pub command_menu_max: usize,
}

impl Default for TelegramChannelOptions {
    fn default() -> Self {
        Self {
            webhook_url: None,
            webhook_secret: None,
            webhook_bind: "0.0.0.0:8443".to_string(),
            webhook_path: "/webhooks/telegram".to_string(),
            base_url: None,
            base_file_url: None,
            local_mode: false,
            mention_patterns: Vec::new(),
            ignored_threads: Vec::new(),
            exclusive_bot_mentions: false,
            guest_mode: true,
            command_menu_max: 60,
        }
    }
}

/// Slack bot adapter configuration (Socket Mode).
#[derive(Debug, Clone)]
pub struct SlackChannelConfig {
    pub app_token: String,
    pub bot_token: String,
    pub common: CommonChannelConfig,
    pub options: SlackChannelOptions,
}

/// Slack Socket Mode reply and mention policy.
#[derive(Debug, Clone)]
pub struct SlackChannelOptions {
    pub reply_in_thread: bool,
    pub reply_broadcast: bool,
    pub strict_mention: bool,
    pub thread_require_mention: bool,
    pub free_response_channels: Vec<String>,
    pub require_mention_channels: Vec<String>,
    pub allowed_channels: Vec<String>,
    pub ignored_channels: Vec<String>,
    pub allow_bots: bool,
    pub reply_prefix: Option<String>,
    pub mention_patterns: Vec<String>,
    pub rich_blocks: bool,
    pub feedback_buttons: bool,
}

impl Default for SlackChannelOptions {
    fn default() -> Self {
        Self {
            reply_in_thread: true,
            reply_broadcast: false,
            strict_mention: false,
            thread_require_mention: false,
            free_response_channels: Vec::new(),
            require_mention_channels: Vec::new(),
            allowed_channels: Vec::new(),
            ignored_channels: Vec::new(),
            allow_bots: false,
            reply_prefix: None,
            mention_patterns: Vec::new(),
            rich_blocks: false,
            feedback_buttons: false,
        }
    }
}

/// Discord bot adapter configuration.
#[derive(Debug, Clone)]
pub struct DiscordChannelConfig {
    pub token: String,
    pub channel_ids: Vec<String>,
    /// Open a thread per triggering message and answer inside it, keeping a busy
    /// channel readable. Mirrors OpenClaw's `threadBindings`.
    pub thread_replies: bool,
    pub common: CommonChannelConfig,
    pub options: DiscordChannelOptions,
}

/// Discord Gateway and channel policy options.
#[derive(Debug, Clone, Default)]
pub struct DiscordChannelOptions {
    /// Replay messages received while the gateway was disconnected.
    pub history_backfill: bool,
    pub free_response_channels: Vec<String>,
    pub allowed_channels: Vec<String>,
    /// Discord role ids allowed to trigger the bot in guild channels.
    pub allowed_roles: Vec<String>,
    pub thread_require_mention: bool,
    pub mention_patterns: Vec<String>,
    pub ignored_channels: Vec<String>,
    pub no_thread_channels: Vec<String>,
    pub allow_bots: bool,
    pub home_channel: Option<String>,
}

/// WhatsApp Business (Meta Cloud API) adapter configuration.
#[derive(Debug, Clone)]
pub struct WhatsAppChannelConfig {
    pub access_token: String,
    pub phone_number_id: String,
    pub verify_token: String,
    pub app_secret: String,
    pub webhook_bind: String,
    pub webhook_path: String,
    pub graph_version: String,
    pub common: CommonChannelConfig,
}

/// WhatsApp Personal adapter configuration backed by an OpenWA session.
///
/// OpenWA is an unofficial, self-hosted WhatsApp Web bridge. The API key and
/// webhook secret are credentials; the remaining fields identify the OpenWA
/// instance/session and the per-channel listener endpoint.
#[derive(Debug, Clone)]
pub struct OpenWaChannelConfig {
    pub base_url: String,
    pub api_key: String,
    pub session_id: String,
    pub webhook_url: String,
    pub webhook_secret: String,
    pub webhook_bind: String,
    pub webhook_path: String,
    pub self_chat_only: bool,
    pub common: CommonChannelConfig,
}

/// BlueBubbles (iMessage bridge running on a Mac) adapter configuration.
#[derive(Debug, Clone)]
pub struct BlueBubblesChannelConfig {
    /// Base URL of the BlueBubbles Server, e.g. `http://192.168.1.10:1234`.
    pub server_url: String,
    /// The server password, sent as the `password` query parameter.
    pub password: String,
    /// Local bind for the webhook receiver BlueBubbles POSTs into.
    pub webhook_bind: String,
    /// Path BlueBubbles is configured to POST to.
    pub webhook_path: String,
    /// Use the Private API helper for typing indicators, read receipts and
    /// tapbacks. Requires the operator to have installed it on the Mac.
    pub private_api: bool,
    /// Additional group-addressing patterns. BlueBubbles does not expose native
    /// mentions, so these are the safe, explicit equivalent.
    pub mention_patterns: Vec<String>,
    /// Optional home chat used by operator-triggered outbound sends.
    pub home_channel: Option<String>,
    pub common: CommonChannelConfig,
}

/// What a channel adapter can do beyond sending plain text.
///
/// Declared per adapter and consulted by [`handle_turn`], so a platform gets its
/// best available verb without the shared path branching on channel names.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChannelCaps {
    /// A typing / "is composing" indicator can be shown.
    pub typing: bool,
    /// Replies can carry platform rich text (headings, lists, tables).
    pub rich_text: bool,
    /// Partial output can be streamed before the reply is final.
    pub streaming: bool,
    /// Conversations can be threaded (forum topics, Discord threads, Slack
    /// thread_ts).
    pub threads: bool,
    /// The platform has a native command menu that can be registered.
    pub command_menu: bool,
    /// Audio can be sent back as a voice note or audio attachment.
    pub voice: bool,
    /// Arbitrary files can be attached to a reply.
    pub attachments: bool,
    /// Emoji reactions can be placed on a message.
    pub reactions: bool,
    /// The platform can display normal-message quick replies.
    pub reply_keyboards: bool,
    /// The platform can display attached callback or URL buttons.
    pub inline_buttons: bool,
}

/// An inbound message received from a channel, normalised across providers.
#[derive(Debug, Clone, Default)]
pub struct InboundMessage {
    /// Opaque identifier of the conversation to reply to, and the Core
    /// `conversation_id`. Threaded platforms pack the thread into it — see
    /// [`pack_thread`] — so each thread keeps its own history.
    pub chat_id: String,
    /// Stable room id used for group authorization when `chat_id` contains a
    /// provider-specific thread/conversation key. Reply verbs continue to use
    /// `chat_id`.
    pub access_chat_id: Option<String>,
    /// The user's message text (a transcript, for a voice note).
    pub text: String,
    /// Display name of the speaker, for multi-party chats. Connector-supplied and
    /// UNVERIFIED: recorded on the turn so the agent can attribute who spoke,
    /// never used for authorization.
    pub author_name: Option<String>,
    /// Stable per-user id on the platform, used by the pairing gate. Falls back to
    /// the chat id on platforms where a DM chat *is* the user.
    pub sender_id: Option<String>,
    /// Platform message id, needed to react, mark read, or open a thread.
    pub message_id: Option<String>,
    /// True when the message came from a group / multi-user conversation.
    pub is_group: bool,
    /// Media the user attached.
    pub attachments: Vec<Attachment>,
    /// A typed button action; quick replies remain ordinary text messages.
    pub channel_action: Option<ChannelActionEvent>,
}

impl InboundMessage {
    /// A plain text message with no media — the common case, and what the older
    /// two-field struct literal used to express.
    pub fn text(chat_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            chat_id: chat_id.into(),
            text: text.into(),
            ..Default::default()
        }
    }

    /// The pairing identity for this sender: the platform user id when known,
    /// otherwise the chat id.
    pub fn identity(&self) -> &str {
        self.sender_id.as_deref().unwrap_or(&self.chat_id)
    }

    /// Return the room id the shared access gate should evaluate.
    pub fn access_chat(&self) -> &str {
        self.access_chat_id.as_deref().unwrap_or(&self.chat_id)
    }

    /// Did the user speak rather than type?
    pub fn is_voice(&self) -> bool {
        self.attachments
            .iter()
            .any(|a| a.resolved_kind().is_speech())
    }
}

/// Per-bot state shared by the transport-agnostic path.
///
/// One of these is embedded in each adapter and exposed via [`Channel::runtime`].
/// It owns the Core route, the access policy, and the cached command menu, so
/// those live in exactly one place rather than being duplicated per adapter.
pub struct ChannelRuntime {
    pub http: reqwest::Client,
    pub cfg: CommonChannelConfig,
    /// Pairing state for this node, shared across every channel on it.
    pub pairing: PairingStore,
    /// Reports this bot's live connection status to the control plane. `None`
    /// for env-configured bots (no store id), which then show as `unknown`.
    pub status: Option<StatusReporter>,
    /// The command menu last fetched from Core.
    commands: RwLock<Vec<ChannelCommand>>,
    /// Bound concurrent channel turns so a public webhook cannot create an
    /// unbounded number of model/media tasks while the provider is retrying.
    delivery_slots: Arc<Semaphore>,
}

/// The response metadata a Core-routed channel turn needs in addition to text.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ChannelRunResult {
    pub reply: String,
    pub assistant_message_id: Option<String>,
    pub assistant_message_ids: Vec<String>,
    pub interactive_markup: Option<InteractiveMarkup>,
    /// Emojis the agent reacted to the user's message with (`agents.react`),
    /// oldest first. Mirrored onto the provider message that started the turn.
    pub agent_reactions: Vec<String>,
}

/// Lifecycle reaction placed while a turn is running.
pub const WORKING_REACTION: &str = "👀";

/// Lifecycle reaction placed when a turn fails.
pub const FAILED_REACTION: &str = "❌";

/// Whether a finishing reaction step adds or takes back an emoji.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReactionOp {
    Add,
    Remove,
}

/// The reaction steps that close a turn on the provider message that started it.
///
/// Mirrors how people (and other chat assistants) react: the working 👀 is taken
/// back once the answer is there, the agent's own `agents.react` choice is what
/// stays, and only a failure is marked. A successful turn the agent chose not to
/// react to ends with no reaction at all — the reply is the acknowledgement, and
/// a ✅ on every message would drown out the reactions that carry meaning.
///
/// The agent's reactions are mirrored regardless of `lifecycle_reactions`: they
/// are part of the agent's answer, not the transport's progress signal.
pub fn finish_reactions<'a>(
    lifecycle_reactions: bool,
    run_succeeded: bool,
    agent_reactions: &'a [String],
) -> Vec<(ReactionOp, &'a str)> {
    let mut steps = Vec::new();
    let agent_placed_working = agent_reactions
        .iter()
        .any(|emoji| emoji == WORKING_REACTION);
    if lifecycle_reactions && !agent_placed_working {
        steps.push((ReactionOp::Remove, WORKING_REACTION));
    }
    if run_succeeded {
        steps.extend(
            agent_reactions
                .iter()
                .map(|emoji| (ReactionOp::Add, emoji.as_str())),
        );
    } else if lifecycle_reactions {
        steps.push((ReactionOp::Add, FAILED_REACTION));
    }
    steps
}

/// Outcome of one normalized inbound turn.
///
/// `Completed` includes an intentional access-policy drop and a pairing prompt:
/// neither should be re-run when the provider retries the same callback. Only a
/// transport failure that prevented the final response from being delivered is
/// retryable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelTurnOutcome {
    Completed,
    Failed,
}

/// Maximum number of local attempts after a provider delivery is durably
/// claimed. The provider remains the outer retry mechanism after this budget is
/// exhausted, while the durable ledger keeps concurrent callbacks from
/// multiplying work.
const DELIVERY_MAX_ATTEMPTS: u32 = 3;

/// Maximum number of webhook turns allowed to run concurrently for one channel
/// runtime. A full set returns `503` at the provider boundary.
const MAX_ACTIVE_DELIVERIES: usize = 128;

fn delivery_retry_delay(attempt: u32) -> Duration {
    match attempt {
        1 => Duration::from_secs(2),
        _ => Duration::from_secs(5),
    }
}

/// Upper bound for one Core-routed agent turn (`POST /api/channels/run`).
///
/// Overrides the shared HTTP client's 60 s timeout: an agent turn with web
/// search and several model rounds routinely takes longer, and cutting it off
/// makes the user see an error while Core finishes (and bills) a reply nobody
/// fetches. It must stay below Core's 15-minute stale channel-turn reclaim
/// (`claim_channel_turn` in `apps/core/src/server/conversations.rs`) and the
/// 30-minute delivery lease in [`pairing`], so a slow turn never outlives
/// either claim.
const CORE_TURN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

const _: () = assert!(
    CORE_TURN_TIMEOUT.as_secs() > 60 && CORE_TURN_TIMEOUT.as_secs() < 15 * 60,
    "CORE_TURN_TIMEOUT must exceed the shared 60 s client timeout and stay below Core's 15-minute reclaim"
);

/// Chat reply when a Core-routed turn fails. Deliberately generic; the cause is
/// logged with the internal URL that a transport error would otherwise expose.
const CORE_TURN_FAILED_REPLY: &str = "Sorry, something went wrong while running that request.";

impl ChannelRuntime {
    pub fn new(
        http: reqwest::Client,
        cfg: CommonChannelConfig,
        pairing: PairingStore,
        status: Option<StatusReporter>,
    ) -> Self {
        Self {
            http,
            cfg,
            pairing,
            status,
            commands: RwLock::new(Vec::new()),
            delivery_slots: Arc::new(Semaphore::new(MAX_ACTIVE_DELIVERIES)),
        }
    }

    /// Reserve one processing slot for a webhook before acknowledging it. A
    /// failed reservation must be translated into a provider-visible retry.
    pub fn try_reserve_delivery(&self) -> Option<OwnedSemaphorePermit> {
        self.delivery_slots.clone().try_acquire_owned().ok()
    }

    /// True when this bot routes through Core's session seam. Store-backed
    /// channel records use Core even when they target the default agent so the
    /// same transcript is visible in the desktop chat history.
    pub fn routes_via_core(&self) -> bool {
        self.cfg.agent_id.is_some() || self.cfg.team_id.is_some() || self.cfg.channel_id.is_some()
    }

    /// Map the platform's reply target to the stable Core session id for this
    /// bot. The raw target remains the value passed to platform send/typing
    /// verbs; only the Core key is namespaced.
    pub fn core_conversation_id(&self, platform_target: &str) -> String {
        self.cfg
            .channel_id
            .as_deref()
            .map(|channel_id| format!("channel:{channel_id}:{platform_target}"))
            .unwrap_or_else(|| platform_target.to_owned())
    }

    /// Route one turn through Core's session seam and return the reply plus the
    /// durable assistant message id that can later receive a reaction.
    ///
    /// `POST <core_url>/api/channels/run` with `conversation_id` keyed to the
    /// chat (or packed chat+thread), so multi-turn exchanges share history. Model
    /// calls still flow Core → Gateway, keeping the governance layer (firewall,
    /// DLP, budgets, audit) on path for every bot-initiated call.
    ///
    /// # Errors
    /// Returns `Err` on HTTP transport failure or a non-2xx from Core.
    pub async fn run_via_core(
        &self,
        conversation_id: &str,
        text: &str,
        author_name: Option<&str>,
        idempotency_key: Option<&str>,
        channel_action: Option<&ChannelActionEvent>,
    ) -> anyhow::Result<ChannelRunResult> {
        let payload = json!({
            "conversation_id": conversation_id,
            "channel_id": self.cfg.channel_id,
            "agent_id": self.cfg.agent_id,
            "team_id": self.cfg.team_id,
            "text": text,
            "author_name": author_name,
            "idempotencyKey": idempotency_key,
            "channelAction": channel_action,
        });
        let resp = self
            .core_run_request(&payload)
            .send()
            .await?
            .error_for_status()?;
        let body: Value = resp.json().await?;
        if let Some(warning) = body["fallbackWarning"].as_str() {
            warn!(
                channel_id = ?self.cfg.channel_id,
                warning,
                "channel session agent binding was resolved to the default agent"
            );
        }
        let assistant_message_id = body["assistantMessageId"].as_str().map(str::to_owned);
        let assistant_message_ids = body["assistantMessageIds"]
            .as_array()
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .filter(|ids| !ids.is_empty())
            .unwrap_or_else(|| assistant_message_id.clone().into_iter().collect());
        // Older Cores omit the field; that only means there is nothing to mirror.
        let agent_reactions = body["agentReactions"]
            .as_array()
            .map(|emojis| {
                emojis
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|emoji| !emoji.is_empty())
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Ok(ChannelRunResult {
            reply: body["reply"].as_str().unwrap_or("").to_owned(),
            assistant_message_id,
            assistant_message_ids,
            agent_reactions,
            interactive_markup: body
                .get("interactiveMarkup")
                .filter(|value| !value.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()?,
        })
    }

    /// The `POST /api/channels/run` request for one turn, with the per-turn
    /// [`CORE_TURN_TIMEOUT`] in place of the shared client's shorter default.
    fn core_run_request(&self, payload: &Value) -> reqwest::RequestBuilder {
        let url = format!(
            "{}/api/channels/run",
            self.cfg.core_url.trim_end_matches('/')
        );
        self.http.post(url).timeout(CORE_TURN_TIMEOUT).json(payload)
    }

    /// Bind provider message ids to the Core assistant row that produced them.
    /// Providers may split one reply into several messages, so all returned ids
    /// receive the same Learning target.
    pub async fn bind_sent_messages(
        &self,
        platform: &str,
        platform_target: &str,
        provider_message_ids: &[String],
        assistant_message_ids: &[String],
    ) {
        if !self.cfg.reaction_learning.enabled
            || provider_message_ids.is_empty()
            || assistant_message_ids.is_empty()
        {
            return;
        }
        self.pairing
            .bind_reply_messages(
                platform,
                &self.core_conversation_id(platform_target),
                provider_message_ids,
                assistant_message_ids,
            )
            .await;
    }

    /// Record one adapter-normalized reaction against a previously confirmed
    /// bot reply. Returns `false` when Learning is disabled or the provider id
    /// is not linked to a Core assistant row (for example after a restart).
    pub async fn record_reaction_feedback(
        &self,
        platform: &str,
        platform_target: &str,
        provider_message_id: &str,
        emoji: &str,
    ) -> anyhow::Result<bool> {
        if !self.cfg.reaction_learning.enabled || !self.routes_via_core() {
            return Ok(false);
        }
        let conversation_id = self.core_conversation_id(platform_target);
        let core_message_ids = self
            .pairing
            .reply_message(platform, &conversation_id, provider_message_id)
            .await;
        let Some(core_message_ids) = core_message_ids else {
            return Ok(false);
        };
        for core_message_id in core_message_ids {
            let url = format!(
                "{}/api/conversations/{}/messages/{}/feedback",
                self.cfg.core_url.trim_end_matches('/'),
                encode_path_segment(&conversation_id),
                encode_path_segment(&core_message_id)
            );
            self.http
                .post(url)
                .json(&json!({
                    "rating": self.cfg.reaction_learning.classify(emoji),
                    "allow_latest_fallback": false,
                }))
                .send()
                .await?
                .error_for_status()?;
        }
        Ok(true)
    }

    /// Refresh the cached command menu from Core. Returns the new list.
    pub async fn refresh_commands(&self) -> Vec<ChannelCommand> {
        let fetched = commands::fetch(&self.http, &self.cfg.core_url).await;
        *self.commands.write().await = fetched.clone();
        fetched
    }

    /// The cached command menu.
    pub async fn commands(&self) -> Vec<ChannelCommand> {
        self.commands.read().await.clone()
    }

    /// Transcribe every speech attachment and fold the transcripts into the turn
    /// text. `downloaded` pairs an index into `message.attachments` with its
    /// bytes; the adapter does the download because only it knows the platform's
    /// auth and resolve step.
    ///
    /// Is this sender ALREADY admitted — without minting anything?
    ///
    /// The read-only twin of the gate in [`handle_turn`]. It exists because the
    /// authoritative gate necessarily runs *inside* `handle_turn`, while the
    /// expensive part of an inbound turn — downloading a voice note and paying for
    /// a transcription — happens in the adapter *before* it. Without this check an
    /// unpaired stranger on an unauthenticated ingress could spend the operator's
    /// STT budget simply by sending audio, which is exactly what the gate is for.
    ///
    /// Deliberately non-mutating, unlike [`AccessPolicy::decide_dm`]: that one
    /// *mints* a pairing code and writes the store, so calling it speculatively on
    /// every inbound would let forged senders drive disk writes. An unknown sender
    /// answers `false` here and is challenged once, later, by the real gate.
    ///
    /// Policy is not duplicated — this reads the same [`AccessPolicy`] and the same
    /// [`PairingStore`] the gate does; it just declines to create state.
    pub async fn already_admitted(&self, platform: &str, message: &InboundMessage) -> bool {
        if message.is_group {
            return matches!(
                self.cfg
                    .access
                    .decide_group_for_sender(message.access_chat(), message.sender_id.as_deref(),),
                Decision::Allow
            );
        }
        let identity = message.identity();
        if self.cfg.access.dm_allowlist.iter().any(|id| id == identity) {
            return true;
        }
        match self.cfg.access.dm {
            DmPolicy::Open => true,
            DmPolicy::Allowlist | DmPolicy::Disabled => false,
            DmPolicy::Pairing => matches!(
                self.pairing.get(platform, identity).await,
                Some(pairing::PairState::Paired { .. })
            ),
        }
    }

    /// A transcription failure degrades to a placeholder rather than dropping the
    /// turn — the user gets an answer that acknowledges the voice note instead of
    /// silence. Annotation of NON-speech media is not done here; [`handle_turn`]
    /// applies it once, for every adapter.
    pub async fn ingest_media(
        &self,
        message: &mut InboundMessage,
        downloaded: Vec<(usize, Vec<u8>)>,
    ) {
        for (index, bytes) in downloaded {
            let Some(attachment) = message.attachments.get(index) else {
                continue;
            };
            if !attachment.resolved_kind().is_speech() {
                continue;
            }
            let filename = attachment.safe_filename();
            match media::transcribe(&self.http, &self.cfg.core_url, bytes, &filename).await {
                Ok(transcript) if !transcript.trim().is_empty() => {
                    if message.text.trim().is_empty() {
                        message.text = transcript;
                    } else {
                        message.text = format!("{}\n\n{transcript}", message.text);
                    }
                }
                Ok(_) => {
                    warn!("channel voice note transcribed to nothing");
                    if message.text.trim().is_empty() {
                        message.text = "[voice message — nothing could be transcribed]".to_string();
                    }
                }
                Err(err) => {
                    warn!(%err, "channel voice transcription failed");
                    if message.text.trim().is_empty() {
                        message.text = "[voice message — transcription unavailable]".to_string();
                    }
                }
            }
        }
    }
}

/// A registered channel: a messaging surface the gateway can receive from and
/// reply to. Implementors own their transport and their platform verbs.
///
/// Every method past [`Channel::send_message`] has a default, so an adapter for a
/// text-only platform implements exactly what the old trait required.
#[async_trait]
pub trait Channel: Send + Sync {
    /// Stable identifier for this channel, e.g. `"telegram"`.
    fn name(&self) -> &'static str;

    /// Shared per-bot state (Core route, access policy, command cache).
    fn runtime(&self) -> &ChannelRuntime;

    /// Stable non-secret identity for this channel instance in the node delivery
    /// ledger. Store-backed records use their control-plane id, so two Telegram
    /// bots or two WhatsApp numbers cannot collide on the same provider event
    /// number. Env-configured deployments have at most one instance per
    /// platform and fall back to the platform name.
    fn delivery_scope(&self) -> String {
        self.runtime()
            .cfg
            .channel_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| self.name().to_string())
    }

    /// Deliver an outbound reply back to the originating chat.
    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()>;

    /// Deliver the assistant reply and optionally return provider message ids.
    /// The default keeps older/text-only adapters unchanged; adapters that
    /// receive reaction events override it so the shared runtime can bind the
    /// reaction to the exact Core assistant row.
    async fn send_reply(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
    ) -> anyhow::Result<Vec<String>> {
        if rich_text && self.caps().rich_text {
            self.send_rich(chat_id, text).await?;
        } else {
            self.send_message(chat_id, text).await?;
        }
        Ok(Vec::new())
    }

    /// Send a reply with channel-neutral buttons when the platform supports
    /// their layout. Text-only adapters use the same reply text as a fallback.
    async fn send_reply_with_markup(
        &self,
        chat_id: &str,
        text: &str,
        rich_text: bool,
        _markup: Option<&InteractiveMarkup>,
    ) -> anyhow::Result<Vec<String>> {
        self.send_reply(chat_id, text, rich_text).await
    }

    /// Run the channel's inbound loop until the process exits. Each inbound
    /// message should be passed to [`handle_turn`].
    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()>;

    /// What this platform can express beyond plain text.
    fn caps(&self) -> ChannelCaps {
        ChannelCaps::default()
    }

    /// Model the inbound messages should be routed to.
    fn model(&self) -> &str {
        &self.runtime().cfg.model
    }

    /// Optional system prompt prepended to every conversation.
    fn system_prompt(&self) -> Option<&str> {
        self.runtime().cfg.system_prompt.as_deref()
    }

    /// Show a typing indicator. Best-effort: platforms expire it after a few
    /// seconds, so [`keep_typing`] re-asserts it on [`Channel::typing_interval`].
    ///
    /// `chat_id` is the PACKED conversation key, exactly like every other send —
    /// after [`Channel::open_thread`] it may be `"<chat>:<thread>"`. Unpack it
    /// with [`unpack_thread`] before calling the platform, or a threaded turn
    /// spends the whole agent call posting to a chat id that does not exist.
    async fn send_typing(&self, _chat_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// How often the typing indicator must be re-asserted to stay visible.
    /// Telegram expires after 5s and Discord after 10s, so the default is set
    /// under the tighter of the two.
    fn typing_interval(&self) -> Duration {
        Duration::from_secs(4)
    }

    /// Send a reply rendered as platform rich text. Defaults to plain text, which
    /// is exactly right for a platform without a rich-text surface.
    async fn send_rich(&self, chat_id: &str, markdown: &str) -> anyhow::Result<()> {
        self.send_message(chat_id, markdown).await
    }

    /// Push a partial, ephemeral draft while the reply is still being generated.
    /// `draft_id` is stable across one turn so the platform animates the diff.
    async fn send_draft(
        &self,
        _chat_id: &str,
        _draft_id: i64,
        _partial: &str,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// Send synthesized speech. `wav` is Core's TTS output; `delivery` states what
    /// the platform will accept (see [`media::wav_delivery`]).
    async fn send_voice(
        &self,
        _chat_id: &str,
        _wav: Vec<u8>,
        _delivery: VoiceDelivery,
    ) -> anyhow::Result<()> {
        anyhow::bail!("{} cannot send audio", self.name())
    }

    /// Place an emoji reaction on a message. Used to acknowledge receipt without
    /// adding a message to the conversation.
    async fn react(&self, _chat_id: &str, _message_id: &str, _emoji: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Take back a reaction this bot placed with [`Channel::react`]. Clears the
    /// working 👀 once a turn finishes so it never lingers beside the answer.
    async fn remove_reaction(
        &self,
        _chat_id: &str,
        _message_id: &str,
        _emoji: &str,
    ) -> anyhow::Result<()> {
        Ok(())
    }

    /// Mark the conversation read on the platform (blue ticks).
    async fn mark_read(&self, _chat_id: &str, _message_id: &str) -> anyhow::Result<()> {
        Ok(())
    }

    /// Register the command menu with the platform.
    async fn publish_commands(&self, _cmds: &[ChannelCommand]) -> anyhow::Result<()> {
        Ok(())
    }

    /// Push the operator-configured bot profile (name / bio / description).
    async fn publish_profile(&self, _profile: &BotProfile) -> anyhow::Result<()> {
        Ok(())
    }

    /// Open a thread for this turn and return the conversation key to answer in.
    /// Defaults to answering in the originating chat.
    async fn open_thread(&self, chat_id: &str, _message: &InboundMessage) -> String {
        chat_id.to_string()
    }
}

/// Build the node-local delivery id from a provider's stable event/message id.
/// The provider id itself is never used as an unscoped global key because one
/// node can host multiple channel records of the same platform.
pub fn scoped_delivery_id<C: Channel + ?Sized>(channel: &C, provider_id: &str) -> String {
    format!("{}:{}", channel.delivery_scope(), provider_id.trim())
}

/// Claim one inbound provider delivery before accepting it for asynchronous
/// processing. Webhook handlers call this while the HTTP request is still open;
/// a persistence error therefore becomes a provider-visible retry rather than a
/// `200` for work that was never durably accepted.
pub async fn claim_inbound_delivery<C: Channel + ?Sized>(
    channel: &C,
    provider_id: &str,
) -> anyhow::Result<(String, DeliveryClaim)> {
    let delivery_id = scoped_delivery_id(channel, provider_id);
    let claim = channel
        .runtime()
        .pairing
        .claim_delivery(channel.name(), &delivery_id)
        .await?;
    Ok((delivery_id, claim))
}

/// Process a delivery that has already been claimed. The closure is invoked
/// serially for up to [`DELIVERY_MAX_ATTEMPTS`] attempts; it must construct a
/// fresh future (and usually a cloned `InboundMessage`) on each invocation.
///
/// A completed record is written only after the shared turn reports that its
/// terminal action was delivered. A failed record remains reclaimable by a later
/// provider callback, while an in-flight record suppresses concurrent retries.
pub async fn run_claimed_delivery<C, F, Fut>(channel: Arc<C>, delivery_id: String, mut work: F)
where
    C: Channel + 'static,
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = ChannelTurnOutcome> + Send,
{
    let platform = channel.name();
    let ledger = channel.runtime().pairing.clone();
    for attempt in 1..=DELIVERY_MAX_ATTEMPTS {
        if work().await == ChannelTurnOutcome::Completed {
            if let Err(error) = ledger.complete_delivery(platform, &delivery_id).await {
                warn!(
                    channel = platform,
                    %error,
                    "channel delivery completed but its durable completion could not be persisted"
                );
            }
            return;
        }

        if attempt == DELIVERY_MAX_ATTEMPTS {
            if let Err(error) = ledger.fail_delivery(platform, &delivery_id).await {
                warn!(
                    channel = platform,
                    %error,
                    "channel delivery failed and its failure state could not be persisted"
                );
            }
            warn!(
                channel = platform,
                delivery_id = %delivery_id,
                attempts = DELIVERY_MAX_ATTEMPTS,
                "channel delivery exhausted local retries; waiting for provider redelivery"
            );
            if let Some(reporter) = &channel.runtime().status {
                reporter
                    .error("inbound delivery failed after local retries")
                    .await;
            }
            return;
        }

        warn!(
            channel = platform,
            delivery_id = %delivery_id,
            attempt,
            "channel delivery failed; retrying"
        );
        if let Err(error) = ledger.touch_delivery(platform, &delivery_id).await {
            warn!(
                channel = platform,
                %error,
                "channel delivery retry lease could not be persisted"
            );
        }
        tokio::time::sleep(delivery_retry_delay(attempt)).await;
    }
}

/// Process a claimed webhook while holding a bounded concurrency slot acquired
/// before the HTTP acknowledgement. Dropping the permit after the terminal
/// state lets the next provider callback enter without widening the public
/// queue.
pub async fn run_claimed_delivery_with_permit<C, F, Fut>(
    channel: Arc<C>,
    delivery_id: String,
    permit: OwnedSemaphorePermit,
    work: F,
) where
    C: Channel + 'static,
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = ChannelTurnOutcome> + Send,
{
    run_claimed_delivery(channel, delivery_id, work).await;
    drop(permit);
}

/// Try to reserve a webhook processing slot without exposing the semaphore
/// itself to provider adapters.
pub fn try_reserve_delivery<C: Channel + ?Sized>(channel: &C) -> Option<OwnedSemaphorePermit> {
    channel.runtime().try_reserve_delivery()
}

/// Claim and process one delivery for transports that do not need to return an
/// HTTP acknowledgement themselves (polling, sockets, or a queued webhook
/// worker).
pub async fn deliver_inbound<C, F, Fut>(channel: Arc<C>, provider_id: String, mut work: F)
where
    C: Channel + 'static,
    F: FnMut() -> Fut + Send,
    Fut: Future<Output = ChannelTurnOutcome> + Send,
{
    let (delivery_id, claim) = match claim_inbound_delivery(channel.as_ref(), &provider_id).await {
        Ok(result) => result,
        Err(error) => {
            warn!(
                channel = channel.name(),
                %error,
                "channel delivery could not be durably claimed; processing once without dedupe"
            );
            let _ = work().await;
            return;
        }
    };
    match claim {
        DeliveryClaim::Claimed => run_claimed_delivery(channel, delivery_id, work).await,
        DeliveryClaim::InFlight | DeliveryClaim::Completed => {
            debug!(channel = channel.name(), delivery_id = %delivery_id, ?claim, "duplicate channel delivery suppressed");
        }
    }
}

/// The gateway seam a channel needs: run one channel-originated request body
/// through the gateway pipeline and return the raw completion response.
///
/// This is the whole coupling between the channel-layer engine and the gateway.
/// The host (implemented in `apps/gateway/src/channels_host.rs`) owns
/// `RequestContext` construction — api-key namespacing, priority — and the
/// `pipeline::run` call. Keeping it behind this trait is what lets the
/// transport adapters live in their own crate without dragging in `SharedState`,
/// the pipeline, or `RequestContext` ("engine moves, wiring stays").
#[async_trait]
pub trait ChannelHost: Send + Sync {
    /// Run `body` (an OpenAI-style chat request built by [`build_request_body`])
    /// through the gateway pipeline, tagging audit/rate-limit buckets by
    /// `channel_name`. Returns the raw completion response.
    async fn run_pipeline(&self, channel_name: &str, body: Value) -> anyhow::Result<Value>;
}

/// Build the OpenAI-style request body for an inbound channel message.
///
/// Pure and synchronous so it can be unit-tested without a running gateway.
pub fn build_request_body(model: &str, system_prompt: Option<&str>, text: &str) -> Value {
    let mut messages = Vec::with_capacity(2);
    if let Some(system) = system_prompt {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": text }));

    json!({
        "model": model,
        "messages": messages,
        "stream": false,
    })
}

/// Extract the assistant reply text from a gateway pipeline response.
pub fn extract_reply(response: &Value) -> Option<String> {
    response["choices"]
        .as_array()
        .and_then(|choices| choices.first())
        .and_then(|choice| choice["message"]["content"].as_str())
        .map(|s| s.to_string())
}

// ─── Thread packing ─────────────────────────────────────────────────────────
//
// Threaded platforms need two ids to answer (the room and the thread within it)
// but Core takes ONE opaque `conversation_id`. Slack solved this by packing
// `"<channel>:<thread_ts>"`; the same trick generalises, so Telegram topics and
// Discord threads reuse it rather than inventing a third convention. Packing is
// also what gives each thread its own conversation history, which is the point.

/// Pack a room id and an optional thread id into one conversation key.
pub fn pack_thread(chat_id: &str, thread_id: Option<&str>) -> String {
    match thread_id.filter(|t| !t.is_empty()) {
        Some(thread) => format!("{chat_id}:{thread}"),
        None => chat_id.to_string(),
    }
}

/// Split a packed conversation key back into `(chat_id, thread_id)`.
///
/// Splits on the LAST separator so a chat id that itself contains a colon
/// survives the round trip.
pub fn unpack_thread(packed: &str) -> (&str, Option<&str>) {
    match packed.rsplit_once(':') {
        Some((chat, thread)) if !thread.is_empty() && !chat.is_empty() => (chat, Some(thread)),
        _ => (packed, None),
    }
}

/// Percent-encode one Core path segment without adding another dependency to
/// the channel crate. Conversation keys contain `:` and provider ids may carry
/// other reserved bytes, so interpolation without this guard would address a
/// different route than the one Core authorized.
fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(*byte as char)
            }
            other => encoded.push_str(&format!("%{other:02X}")),
        }
    }
    encoded
}

// ─── Access policy from the legacy env vars ─────────────────────────────────

/// Env var opting a deployment into accepting ALL inbound chats when no
/// allowlist is configured. A bot token grants LLM completions billed to the
/// operator, so this is the explicit escape hatch (`1`/`true`/`yes`/`on`,
/// case-insensitive).
const ENV_CHANNEL_ALLOW_ALL: &str = "RYU_CHANNEL_ALLOW_ALL";

/// Per-platform / global allowed-chat list for inbound channel traffic.
///
/// Env: `RYU_CHANNEL_ALLOWED_USERS` (global, all platforms) and
/// `RYU_CHANNEL_ALLOWED_USERS_<PLATFORM>` (e.g. `_TELEGRAM`). Comma-separated
/// chat ids; the per-platform key overrides the global one.
fn channel_allowlist(platform: &str) -> Option<Vec<String>> {
    let per_platform_key = format!(
        "RYU_CHANNEL_ALLOWED_USERS_{}",
        platform.to_ascii_uppercase()
    );
    let raw = std::env::var(&per_platform_key)
        .ok()
        .or_else(|| std::env::var("RYU_CHANNEL_ALLOWED_USERS").ok())?;
    let list: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}

/// Pure: does this env value opt into open mode? Only an explicit enable token
/// counts — absent or anything else stays closed. Unit-testable without env.
fn channel_allow_all_from(val: Option<&str>) -> bool {
    matches!(
        val.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Runtime wrapper: read [`ENV_CHANNEL_ALLOW_ALL`] and classify.
fn channel_allow_all() -> bool {
    channel_allow_all_from(std::env::var(ENV_CHANNEL_ALLOW_ALL).ok().as_deref())
}

/// Pure core of [`policy_from_env`], so the mapping is testable without env.
///
/// The three legacy states map onto the richer policy as follows:
///
/// | env                     | DMs        | groups     |
/// |-------------------------|------------|------------|
/// | allowlist set           | allowlist  | allowlist  |
/// | none + `ALLOW_ALL=1`    | open       | open       |
/// | none                    | **pairing**| allowlist (empty ⇒ closed) |
///
/// The last row is the one behaviour change: a bot with no configuration used to
/// refuse every message with only a log line to explain it. It now answers a
/// stranger with a pairing code they can get approved. Groups stay closed —
/// nobody is admitted without a human acting, which is the property that
/// mattered.
pub fn policy_from(allowlist: Option<Vec<String>>, allow_all: bool) -> AccessPolicy {
    match (allowlist, allow_all) {
        (Some(list), _) => AccessPolicy {
            dm: DmPolicy::Allowlist,
            group: GroupPolicy::Allowlist,
            dm_allowlist: list.clone(),
            group_allowlist: list,
            group_sender_allowlist: Vec::new(),
        },
        (None, true) => AccessPolicy {
            dm: DmPolicy::Open,
            group: GroupPolicy::Open,
            ..Default::default()
        },
        (None, false) => AccessPolicy {
            dm: DmPolicy::Pairing,
            group: GroupPolicy::Allowlist,
            ..Default::default()
        },
    }
}

/// Derive a channel's [`AccessPolicy`] from the legacy env vars.
pub fn policy_from_env(platform: &str) -> AccessPolicy {
    policy_from(channel_allowlist(platform), channel_allow_all())
}

// ─── Typing indicator keepalive ─────────────────────────────────────────────

/// A live typing indicator. Dropping it stops the indicator.
///
/// Platforms expire a typing status after a few seconds so a bot that shows it
/// once appears to stop working immediately. This re-asserts it on a ticker and
/// aborts on drop, which makes the correct usage — hold it across the agent call
/// — the same as the easy usage.
pub struct TypingGuard {
    handle: tokio::task::JoinHandle<()>,
}

impl Drop for TypingGuard {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

/// Show a typing indicator in `chat_id` until the returned guard is dropped.
pub fn keep_typing<C: Channel + 'static>(channel: Arc<C>, chat_id: String) -> TypingGuard {
    let interval = channel.typing_interval();
    let handle = tokio::spawn(async move {
        loop {
            if let Err(err) = channel.send_typing(&chat_id).await {
                // A platform that refuses the indicator (missing scope, closed
                // chat) must not spin: log once and stop trying for this turn.
                warn!(
                    channel = channel.name(),
                    %err,
                    "typing indicator failed; not retrying for this turn"
                );
                return;
            }
            tokio::time::sleep(interval).await;
        }
    });
    TypingGuard { handle }
}

const PROACTIVE_OPENING_RETRY: Duration = Duration::from_secs(5);

/// Ask Core for the first Ryu welcome and deliver it through the same platform
/// verb used for every other outbound message.
///
/// The loop is deliberately owned by the shared channel layer rather than by
/// Telegram, WhatsApp, or a desktop-only path. A local model may still be
/// starting when the gateway comes up; Core answers `202`/`503` until it can
/// produce the message, so the gateway keeps trying without creating duplicate
/// assistant messages. Core's idempotency key is stable across adapter restarts.
async fn run_proactive_opening<C: Channel + 'static>(channel: Arc<C>) {
    let runtime = channel.runtime();
    if !runtime.cfg.proactive_opening {
        return;
    }
    let Some(target) = runtime
        .cfg
        .proactive_target
        .clone()
        .filter(|target| !target.trim().is_empty())
    else {
        warn!(
            channel = channel.name(),
            "proactive opening enabled without a target"
        );
        return;
    };

    // Never use an outbound opening to enrol a new sender. The target must be
    // open, allowlisted, or already paired exactly like an inbound DM.
    let admission = InboundMessage {
        chat_id: target.clone(),
        sender_id: Some(target.clone()),
        ..Default::default()
    };
    if !runtime.already_admitted(channel.name(), &admission).await {
        warn!(
            channel = channel.name(),
            "proactive opening target is not admitted; no message sent"
        );
        return;
    }

    let url = format!(
        "{}/api/proactive/opening",
        runtime.cfg.core_url.trim_end_matches('/')
    );
    let agent_id = runtime
        .cfg
        .agent_id
        .clone()
        .unwrap_or_else(|| "ryu".to_string());
    let idempotency_key = format!("ryu-opening:v1:{}:{}", channel.name(), target);

    loop {
        let result = runtime
            .http
            .post(&url)
            .json(&json!({
                "conversation_id": target.clone(),
                "agent_id": agent_id.clone(),
                "idempotency_key": idempotency_key.clone(),
            }))
            .send()
            .await;

        let response = match result {
            Ok(response) => response,
            Err(err) => {
                warn!(channel = channel.name(), %err, "proactive opening could not reach Core; retrying");
                tokio::time::sleep(PROACTIVE_OPENING_RETRY).await;
                continue;
            }
        };

        let status = response.status();
        let body = response.json::<Value>().await.unwrap_or_default();
        if status == reqwest::StatusCode::ACCEPTED
            || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        {
            info!(channel = channel.name(), %status, "proactive opening is waiting for the model");
            tokio::time::sleep(PROACTIVE_OPENING_RETRY).await;
            continue;
        }
        if !status.is_success() {
            warn!(channel = channel.name(), %status, "proactive opening was refused; no message sent");
            return;
        }
        if body["status"].as_str() != Some("completed") {
            info!(
                channel = channel.name(),
                "proactive opening was already delivered; no duplicate sent"
            );
            return;
        }

        let Some(reply) = body["reply"]
            .as_str()
            .filter(|reply| !reply.trim().is_empty())
        else {
            warn!(
                channel = channel.name(),
                "proactive opening completed without a reply"
            );
            return;
        };
        if let Err(err) = channel.send_message(&target, reply).await {
            warn!(channel = channel.name(), %err, "proactive opening was generated but could not be delivered");
        } else {
            info!(channel = channel.name(), "proactive opening delivered");
        }
        return;
    }
}

// ─── The shared inbound path ────────────────────────────────────────────────

/// Handle one inbound message end to end: gate it, ingest its media, run it, and
/// deliver the reply with the best verbs the platform has.
///
/// This is what makes channel registration reusable — every adapter funnels
/// through here, so only the transport and the platform verbs differ per channel.
pub async fn handle_turn<C: Channel + 'static>(
    channel: Arc<C>,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
) -> ChannelTurnOutcome {
    handle_turn_with_delivery(channel, host, message, None).await
}

/// Handle one inbound message with its provider delivery identity. The identity
/// is forwarded to Core for session-backed turns, where Core can replay a
/// completed result if the outbound provider call timed out after the model turn
/// already persisted. Callers without a provider event id use [`handle_turn`].
pub async fn handle_turn_with_delivery<C: Channel + 'static>(
    channel: Arc<C>,
    host: Arc<dyn ChannelHost>,
    mut message: InboundMessage,
    delivery_id: Option<&str>,
) -> ChannelTurnOutcome {
    let runtime = channel.runtime();
    let platform = channel.name();

    // 1. Access gate. Groups are static; DMs may issue a pairing challenge, which
    //    is the one "denied" case that still sends a reply.
    let decision = if message.is_group {
        runtime
            .cfg
            .access
            .decide_group_for_sender(message.access_chat(), message.sender_id.as_deref())
    } else {
        runtime
            .cfg
            .access
            .decide_dm(&runtime.pairing, platform, message.identity())
            .await
    };
    match decision {
        Decision::Allow => {}
        Decision::Deny => {
            warn!(
                channel = platform,
                is_group = message.is_group,
                "channel inbound refused by access policy"
            );
            return ChannelTurnOutcome::Completed;
        }
        Decision::Challenge(code) | Decision::Pending(code) => {
            info!(
                channel = platform,
                "channel inbound held for pairing approval"
            );
            if let Err(err) = channel
                .send_message(&message.chat_id, &pairing::pairing_prompt(&code))
                .await
            {
                warn!(channel = platform, %err, "failed to deliver pairing prompt");
                return ChannelTurnOutcome::Failed;
            }
            return ChannelTurnOutcome::Completed;
        }
    }

    // 2. Acknowledge receipt on platforms that support it, before the slow part.
    //    Gated on its OWN setting: an operator who turned typing off has not
    //    asked to stop marking messages read, and vice versa.
    if runtime.cfg.send_read_receipts {
        if let Some(message_id) = message.message_id.clone() {
            let _ = channel.mark_read(&message.chat_id, &message_id).await;
        }
    }

    // A reaction is an acknowledgement, not a second conversation turn. Keep it
    // best-effort so a missing reactions scope never blocks the actual answer.
    if runtime.cfg.lifecycle_reactions && channel.caps().reactions {
        if let Some(message_id) = message.message_id.as_deref() {
            let _ = channel
                .react(&message.chat_id, message_id, WORKING_REACTION)
                .await;
        }
    }

    // 3. Fold attachments into the turn text (voice → transcript, others → note).
    if !message.attachments.is_empty() {
        message.text = media::annotate(&message.text, &message.attachments);
    }
    if message.text.trim().is_empty() {
        warn!(
            channel = platform,
            "channel inbound had no usable text after media ingest; dropping"
        );
        return ChannelTurnOutcome::Completed;
    }

    // 4. Thread the reply where the platform supports it, and key the Core
    //    conversation to the thread so each one keeps its own history.
    let platform_target = if channel.caps().threads {
        channel.open_thread(&message.chat_id, &message).await
    } else {
        message.chat_id.clone()
    };
    let conversation_id = runtime.core_conversation_id(&platform_target);

    // 5. Typing indicator for the duration of the agent call. The guard aborts on
    //    drop, so every early return below stops it too.
    let _typing = if runtime.cfg.typing_indicator && channel.caps().typing {
        Some(keep_typing(Arc::clone(&channel), platform_target.clone()))
    } else {
        None
    };

    info!(
        channel = platform,
        voice = message.is_voice(),
        "channel inbound message received"
    );

    // 6. Run the turn: Core's session seam when an agent/team is bound (history
    //    persists, governance stays on path), else the legacy gateway pipeline.
    let mut run_succeeded = true;
    let mut assistant_message_ids = Vec::new();
    let mut interactive_markup = None;
    let mut agent_reactions = Vec::new();
    let reply = if runtime.routes_via_core() {
        match runtime
            .run_via_core(
                &conversation_id,
                &message.text,
                message.author_name.as_deref(),
                delivery_id,
                message.channel_action.as_ref(),
            )
            .await
        {
            Ok(result) if !result.reply.is_empty() => {
                assistant_message_ids = result.assistant_message_ids;
                interactive_markup = result.interactive_markup;
                agent_reactions = result.agent_reactions;
                result.reply
            }
            Ok(result) => {
                assistant_message_ids = result.assistant_message_ids;
                interactive_markup = result.interactive_markup;
                agent_reactions = result.agent_reactions;
                "(no response)".to_string()
            }
            Err(err) => {
                run_succeeded = false;
                // The full error stays in the log: reqwest's `Display` carries
                // the internal Core URL, which chat users must not see.
                warn!(channel = platform, %err, "channel Core session run failed");
                CORE_TURN_FAILED_REPLY.to_owned()
            }
        }
    } else {
        let body = build_request_body(channel.model(), channel.system_prompt(), &message.text);
        match host.run_pipeline(platform, body).await {
            Ok(response) => extract_reply(&response).unwrap_or_else(|| "(no response)".to_string()),
            Err(err) => {
                run_succeeded = false;
                warn!(channel = platform, %err, "channel pipeline run failed");
                format!("Sorry, something went wrong: {err}")
            }
        }
    };

    // 7. Deliver. Rich text when the platform and the operator both want it.
    let sent = channel
        .send_reply_with_markup(
            &platform_target,
            &reply,
            runtime.cfg.rich_text,
            interactive_markup.as_ref(),
        )
        .await;
    let provider_message_ids = match sent {
        Ok(ids) => ids,
        Err(err) => {
            warn!(
                channel = platform,
                %err,
                "failed to deliver channel reply"
            );
            return ChannelTurnOutcome::Failed;
        }
    };
    if !assistant_message_ids.is_empty() {
        runtime
            .bind_sent_messages(
                platform,
                &platform_target,
                &provider_message_ids,
                &assistant_message_ids,
            )
            .await;
    }

    if channel.caps().reactions {
        if let Some(message_id) = message.message_id.as_deref() {
            for (op, emoji) in finish_reactions(
                runtime.cfg.lifecycle_reactions,
                run_succeeded,
                &agent_reactions,
            ) {
                let _ = match op {
                    ReactionOp::Add => channel.react(&message.chat_id, message_id, emoji).await,
                    ReactionOp::Remove => {
                        channel
                            .remove_reaction(&message.chat_id, message_id, emoji)
                            .await
                    }
                };
            }
        }
    }

    // 8. Optional spoken reply, alongside (never instead of) the text — a voice
    //    note the user cannot skim is worse than one they can.
    if runtime.cfg.voice_reply.should_speak(message.is_voice()) && channel.caps().voice {
        let delivery = media::wav_delivery(platform);
        if delivery == VoiceDelivery::Unsupported {
            warn!(
                channel = platform,
                "voice reply requested but the platform cannot carry Core's WAV output"
            );
        } else {
            match media::speak(&runtime.http, &runtime.cfg.core_url, &reply).await {
                Ok(wav) => {
                    if let Err(err) = channel.send_voice(&platform_target, wav, delivery).await {
                        warn!(channel = platform, %err, "failed to deliver spoken reply");
                    }
                }
                Err(err) => warn!(channel = platform, %err, "speech synthesis failed"),
            }
        }
    }
    ChannelTurnOutcome::Completed
}

// NOTE: the legacy `handle_message(&C, host, InboundMessage)` entry point is
// deliberately GONE rather than kept as a deprecated shim. It could not honestly
// be made backwards compatible: the shared path now runs the pairing gate, media
// ingest and thread packing, so a "compatible" shim would have quietly changed
// the behaviour of every caller that kept using it — including gating inbound
// that used to flow. Deleting it turns that into a compile error at each call
// site, which is where the decision belongs. Every adapter calls `handle_turn`.

/// The platform rejected the adapter's own credential — its token is no longer
/// valid, and no amount of retrying with it will help.
///
/// This exists as a distinct type rather than a string an operator greps for
/// because it is the one transport failure a *supervisor* must act on instead of
/// back off on: a Telegram token can be replaced out from under a running
/// adapter (the owner rotates it in Telegram, or `replaceManagedBotToken` mints a
/// new one), and the only recovery is a fresh token plus a new adapter — the
/// token is baked into the API base at construction, so it cannot be mutated in
/// place. Treated as a generic transport error it becomes an unauthorized poll
/// every few seconds, forever, with the bot silently deaf.
///
/// Deliberately carries no payload: the failing URL contains the token, so the
/// message must never be built from the transport error's own `Display`.
#[derive(Debug, Clone, Copy)]
pub struct TokenRejected;

impl std::fmt::Display for TokenRejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("channel credential rejected by the platform (401 unauthorized)")
    }
}

impl std::error::Error for TokenRejected {}

/// Is this error (or anything it wraps) a [`TokenRejected`]?
///
/// Walks the whole chain rather than testing the outermost error so an adapter
/// stays free to add `.context(...)` on the way out without changing how a
/// supervisor classifies the failure.
pub fn is_token_rejected(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<TokenRejected>())
}

/// Spawn one channel's inbound loop on a dedicated task. A channel that fails to
/// construct or whose loop errors is logged and skipped so it never takes down
/// the gateway or any sibling channel.
pub fn spawn_channel<C: Channel + 'static>(
    host: &Arc<dyn ChannelHost>,
    channel: anyhow::Result<C>,
) {
    let host = Arc::clone(host);
    tokio::spawn(async move {
        // The error is already logged inside `run_channel`; a fire-and-forget
        // caller has nothing further to do with it.
        let _ = run_channel(&host, channel).await;
    });
}

/// Register a channel and await its inbound loop on the *current* task,
/// returning why it ended.
///
/// Split out of [`spawn_channel`] so a caller that must observe the outcome —
/// the gateway's token-rotation supervisor, which respawns a Telegram adapter
/// whose token was replaced ([`TokenRejected`]) — runs the same registration
/// path (the DM-policy warning, the `registering channel` line) instead of
/// re-deriving it and drifting from it.
///
/// # Errors
/// Returns the construction error, or whatever the channel's loop exited with.
/// Both are logged here, so the two callers stay symmetrical in the log.
pub async fn run_channel<C: Channel + 'static>(
    host: &Arc<dyn ChannelHost>,
    channel: anyhow::Result<C>,
) -> anyhow::Result<()> {
    let channel = match channel {
        Ok(channel) => Arc::new(channel),
        Err(err) => {
            warn!(error = %err, "failed to register channel");
            return Err(err);
        }
    };
    let name = channel.name();
    let access = &channel.runtime().cfg.access;
    match access.dm {
        DmPolicy::Open => warn!(
            channel = name,
            "channel registered in OPEN mode — every DM is answered and billed to this operator"
        ),
        DmPolicy::Pairing => info!(
            channel = name,
            "channel registered with DM pairing — unknown senders get a code to be approved"
        ),
        DmPolicy::Allowlist | DmPolicy::Disabled => {}
    }
    info!(channel = name, "registering channel");
    let opening = tokio::spawn(run_proactive_opening(Arc::clone(&channel)));
    let result = Arc::clone(&channel).run(Arc::clone(host)).await;
    opening.abort();
    if let Err(err) = &result {
        warn!(channel = name, error = %err, "channel loop exited with error");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDeliveryChannel {
        runtime: ChannelRuntime,
    }

    #[async_trait::async_trait]
    impl Channel for TestDeliveryChannel {
        fn name(&self) -> &'static str {
            "test"
        }

        fn runtime(&self) -> &ChannelRuntime {
            &self.runtime
        }

        async fn send_message(&self, _chat_id: &str, _text: &str) -> anyhow::Result<()> {
            Ok(())
        }

        async fn run(self: Arc<Self>, _host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
            anyhow::bail!("test channel does not run a transport")
        }
    }

    #[test]
    fn build_request_body_includes_user_message() {
        let body = build_request_body("gpt-4o", None, "hello");
        assert_eq!(body["model"], "gpt-4o");
        assert_eq!(body["stream"], false);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["content"], "hello");
    }

    #[test]
    fn build_request_body_prepends_system_prompt() {
        let body = build_request_body("gpt-4o", Some("be terse"), "hi");
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "system");
        assert_eq!(messages[0]["content"], "be terse");
        assert_eq!(messages[1]["role"], "user");
    }

    #[test]
    fn extract_reply_reads_first_choice() {
        let response = json!({
            "choices": [
                { "message": { "role": "assistant", "content": "the answer" } }
            ]
        });
        assert_eq!(extract_reply(&response).as_deref(), Some("the answer"));
    }

    #[test]
    fn extract_reply_none_when_missing() {
        let response = json!({ "choices": [] });
        assert!(extract_reply(&response).is_none());
    }

    #[tokio::test]
    async fn claimed_delivery_retries_and_completes_after_a_transient_failure() {
        let channel = Arc::new(TestDeliveryChannel {
            runtime: ChannelRuntime::new(
                reqwest::Client::new(),
                CommonChannelConfig::default(),
                PairingStore::ephemeral(),
                None,
            ),
        });
        let (delivery_id, claim) = claim_inbound_delivery(&*channel, "message-1")
            .await
            .unwrap();
        assert_eq!(claim, DeliveryClaim::Claimed);

        let attempts = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let work_attempts = Arc::clone(&attempts);
        run_claimed_delivery(channel, delivery_id, move || {
            let attempt = work_attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    ChannelTurnOutcome::Failed
                } else {
                    ChannelTurnOutcome::Completed
                }
            }
        })
        .await;

        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn delivery_backpressure_is_bounded_and_releases_after_completion() {
        let runtime = ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig::default(),
            PairingStore::ephemeral(),
            None,
        );
        let permits = (0..MAX_ACTIVE_DELIVERIES)
            .map(|_| runtime.try_reserve_delivery())
            .collect::<Option<Vec<_>>>()
            .expect("the configured delivery capacity should be available");
        assert!(
            runtime.try_reserve_delivery().is_none(),
            "a full webhook queue must reject before spawning another task"
        );
        drop(permits);
        assert!(runtime.try_reserve_delivery().is_some());
    }

    #[test]
    fn thread_packing_round_trips() {
        let packed = pack_thread("C123", Some("111.222"));
        assert_eq!(packed, "C123:111.222");
        assert_eq!(unpack_thread(&packed), ("C123", Some("111.222")));

        // No thread ⇒ the chat id is unchanged and unpacks to itself.
        let bare = pack_thread("C123", None);
        assert_eq!(bare, "C123");
        assert_eq!(unpack_thread(&bare), ("C123", None));

        // An empty thread id must not produce a trailing separator.
        assert_eq!(pack_thread("C123", Some("")), "C123");
    }

    #[test]
    fn unpack_thread_splits_on_the_last_separator() {
        // A chat id containing a colon still survives the round trip.
        let packed = pack_thread("a:b", Some("t1"));
        assert_eq!(unpack_thread(&packed), ("a:b", Some("t1")));
    }

    #[test]
    fn env_policy_maps_the_three_legacy_states() {
        // An allowlist locks both DMs and groups to it.
        let listed = policy_from(Some(vec!["123".into()]), false);
        assert_eq!(listed.dm, DmPolicy::Allowlist);
        assert_eq!(listed.group, GroupPolicy::Allowlist);
        assert_eq!(listed.dm_allowlist, vec!["123".to_string()]);

        // ALLOW_ALL with no list opens both.
        let open = policy_from(None, true);
        assert_eq!(open.dm, DmPolicy::Open);
        assert_eq!(open.group, GroupPolicy::Open);

        // Nothing configured ⇒ DMs pair, groups stay closed (empty allowlist).
        let bare = policy_from(None, false);
        assert_eq!(bare.dm, DmPolicy::Pairing);
        assert_eq!(bare.group, GroupPolicy::Allowlist);
        assert_eq!(bare.decide_group("anything"), Decision::Deny);
    }

    #[test]
    fn allow_all_only_accepts_explicit_enable_tokens() {
        assert!(!channel_allow_all_from(None));
        for v in ["0", "false", "off", "no", ""] {
            assert!(
                !channel_allow_all_from(Some(v)),
                "{v:?} must not open the channel"
            );
        }
        for v in ["1", "true", "yes", "on", " 1 ", "TRUE"] {
            assert!(
                channel_allow_all_from(Some(v)),
                "{v:?} should opt into open mode"
            );
        }
    }

    #[test]
    fn reaction_learning_defaults_to_safe_opt_in_and_thumb_labels() {
        let config = ReactionLearningConfig::default();

        assert!(!config.enabled);
        assert_eq!(config.positive_emojis, vec!["👍"]);
        assert_eq!(config.negative_emojis, vec!["👎"]);
        assert!(!config.allow_group);
        assert_eq!(config.classify("👍"), Some("up"));
        assert_eq!(config.classify("👎"), Some("down"));
        assert_eq!(config.classify("❤️"), None);
    }

    #[test]
    fn reaction_learning_accepts_configured_emoji_aliases_and_serializes_wire_names() {
        let config: ReactionLearningConfig = serde_json::from_value(json!({
            "enabled": true,
            "positive_emoji": ["❤️", "✅"],
            "negative_emojis": ["💀"],
            "group_reactions": true,
        }))
        .expect("reaction config should accept the issue's singular keys and aliases");

        assert!(config.enabled);
        assert!(config.allow_group);
        assert_eq!(config.classify("✅"), Some("up"));
        assert_eq!(config.classify("💀"), Some("down"));
        assert_eq!(config.classify("🤔"), None);

        let wire = serde_json::to_value(&config).expect("reaction config should serialize");
        assert_eq!(wire["positive_emoji"], json!(["❤️", "✅"]));
        assert_eq!(wire["negative_emoji"], json!(["💀"]));
        assert!(wire.get("positive_emojis").is_none());
    }

    #[test]
    fn core_path_segments_escape_channel_and_provider_separators() {
        assert_eq!(
            encode_path_segment("channel:bot/chat"),
            "channel%3Abot%2Fchat"
        );
        assert_eq!(encode_path_segment("message_42"), "message_42");
    }

    /// Build a runtime with a given access policy, for the admission tests.
    fn runtime_with(access: AccessPolicy) -> ChannelRuntime {
        ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig {
                access,
                ..Default::default()
            },
            PairingStore::ephemeral(),
            None,
        )
    }

    fn dm_from(sender: &str) -> InboundMessage {
        let mut m = InboundMessage::text("chat-1", "hi");
        m.sender_id = Some(sender.to_string());
        m
    }

    /// The read-only gate must never mint a pairing code — that is the whole
    /// reason it exists rather than reusing `decide_dm`.
    #[tokio::test]
    async fn already_admitted_does_not_mint_a_code() {
        let runtime = runtime_with(AccessPolicy {
            dm: DmPolicy::Pairing,
            ..Default::default()
        });
        let message = dm_from("stranger");

        assert!(!runtime.already_admitted("telegram", &message).await);
        assert!(
            runtime.pairing.get("telegram", "stranger").await.is_none(),
            "the read-only check must not create pairing state"
        );

        // Once the operator approves them, the same check admits them.
        runtime.pairing.approve("telegram", "stranger").await;
        assert!(runtime.already_admitted("telegram", &message).await);
    }

    #[tokio::test]
    async fn already_admitted_matches_the_policy_for_each_dm_mode() {
        let open = runtime_with(AccessPolicy {
            dm: DmPolicy::Open,
            ..Default::default()
        });
        assert!(open.already_admitted("t", &dm_from("anyone")).await);

        let off = runtime_with(AccessPolicy {
            dm: DmPolicy::Disabled,
            ..Default::default()
        });
        assert!(!off.already_admitted("t", &dm_from("anyone")).await);

        // A listed sender is admitted whatever the mode, exactly as the real gate.
        let listed = runtime_with(AccessPolicy {
            dm: DmPolicy::Pairing,
            dm_allowlist: vec!["vip".into()],
            ..Default::default()
        });
        assert!(listed.already_admitted("t", &dm_from("vip")).await);
        assert!(!listed.already_admitted("t", &dm_from("other")).await);
    }

    #[tokio::test]
    async fn already_admitted_uses_the_group_rules_for_group_messages() {
        let runtime = runtime_with(AccessPolicy {
            group: GroupPolicy::Allowlist,
            group_allowlist: vec!["room-1".into()],
            // A wide-open DM policy must not leak into the group decision.
            dm: DmPolicy::Open,
            ..Default::default()
        });

        let mut allowed = InboundMessage::text("room-1", "hi");
        allowed.is_group = true;
        assert!(runtime.already_admitted("t", &allowed).await);

        let mut denied = InboundMessage::text("room-2", "hi");
        denied.is_group = true;
        assert!(
            !runtime.already_admitted("t", &denied).await,
            "an unlisted room must not inherit the open DM policy"
        );
    }

    #[tokio::test]
    async fn reaction_feedback_ignores_unbound_provider_messages() {
        let runtime = ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig {
                channel_id: Some("telegram-bot".to_owned()),
                reaction_learning: ReactionLearningConfig {
                    enabled: true,
                    ..Default::default()
                },
                ..Default::default()
            },
            PairingStore::ephemeral(),
            None,
        );

        assert!(!runtime
            .record_reaction_feedback("telegram", "123", "unlinked-provider-message", "👍")
            .await
            .expect("unlinked reactions should be ignored without a Core request"));
    }

    #[tokio::test]
    async fn disabled_reaction_learning_does_not_persist_reply_links() {
        let runtime = ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig {
                channel_id: Some("telegram-bot".to_owned()),
                reaction_learning: ReactionLearningConfig {
                    enabled: false,
                    ..Default::default()
                },
                ..Default::default()
            },
            PairingStore::ephemeral(),
            None,
        );

        runtime
            .bind_sent_messages(
                "telegram",
                "123",
                &["provider-42".to_owned()],
                &["assistant-98".to_owned()],
            )
            .await;

        assert_eq!(
            runtime
                .pairing
                .reply_message("telegram", "channel:telegram-bot:123", "provider-42")
                .await,
            None
        );
    }

    #[test]
    fn inbound_identity_prefers_the_sender_id() {
        let mut m = InboundMessage::text("chat-1", "hi");
        assert_eq!(m.identity(), "chat-1");
        m.sender_id = Some("user-9".into());
        assert_eq!(m.identity(), "user-9");
    }

    #[test]
    fn bot_profile_clips_to_platform_limits() {
        let profile = BotProfile {
            name: Some("n".repeat(100)),
            short_bio: Some("s".repeat(300)),
            description: Some("d".repeat(900)),
        };
        let clipped = profile.clipped();
        assert_eq!(clipped.name.unwrap().chars().count(), 64);
        assert_eq!(clipped.short_bio.unwrap().chars().count(), 120);
        assert_eq!(clipped.description.unwrap().chars().count(), 512);
        assert!(BotProfile::default().is_empty());
    }

    #[test]
    fn core_turn_request_outlives_the_shared_client_timeout() {
        let shared_client = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap();
        let runtime = ChannelRuntime::new(
            shared_client,
            CommonChannelConfig {
                channel_id: Some("bot-a".to_owned()),
                ..Default::default()
            },
            PairingStore::ephemeral(),
            None,
        );
        let request = runtime
            .core_run_request(&json!({ "conversation_id": "chat-1" }))
            .build()
            .unwrap();
        assert_eq!(request.url().path(), "/api/channels/run");
        assert_eq!(
            request.timeout(),
            Some(&CORE_TURN_TIMEOUT),
            "a slow agent turn must not be cut at the shared client's 60 s timeout"
        );
    }

    #[test]
    fn store_backed_channel_sessions_are_namespaced_per_bot() {
        let runtime = ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig {
                channel_id: Some("bot-a".to_owned()),
                ..Default::default()
            },
            PairingStore::ephemeral(),
            None,
        );
        assert_eq!(
            runtime.core_conversation_id("discord:guild-1:channel-1"),
            "channel:bot-a:discord:guild-1:channel-1"
        );
        assert!(runtime.routes_via_core());

        let legacy = ChannelRuntime::new(
            reqwest::Client::new(),
            CommonChannelConfig::default(),
            PairingStore::ephemeral(),
            None,
        );
        assert_eq!(legacy.core_conversation_id("chat-1"), "chat-1");
    }

    /// Channel allowlist env reading. Run as ONE sequential test because it
    /// mutates process-global env; parallel sub-tests would race.
    #[test]
    fn channel_allowlist_reads_env() {
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");

        assert!(channel_allowlist("telegram").is_none());

        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123, 456");
        assert_eq!(
            channel_allowlist("telegram"),
            Some(vec!["123".to_string(), "456".to_string()])
        );
        // A different platform with no list of its own sees nothing.
        assert!(channel_allowlist("slack").is_none());

        // Global applies when per-platform is unset.
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS", "777");
        assert_eq!(channel_allowlist("telegram"), Some(vec!["777".to_string()]));

        // Per-platform OVERRIDES global.
        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123");
        assert_eq!(channel_allowlist("telegram"), Some(vec!["123".to_string()]));

        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
    }
}

#[cfg(test)]
mod finish_reaction_tests {
    use super::{finish_reactions, ReactionOp};

    fn owned(emojis: &[&str]) -> Vec<String> {
        emojis.iter().map(|emoji| (*emoji).to_owned()).collect()
    }

    #[test]
    fn the_agent_reaction_replaces_the_working_marker() {
        let agent = owned(&["👍"]);
        assert_eq!(
            finish_reactions(true, true, &agent),
            vec![(ReactionOp::Remove, "👀"), (ReactionOp::Add, "👍")]
        );
    }

    #[test]
    fn a_turn_the_agent_did_not_react_to_ends_with_no_reaction() {
        assert_eq!(
            finish_reactions(true, true, &[]),
            vec![(ReactionOp::Remove, "👀")]
        );
    }

    #[test]
    fn a_failed_turn_is_marked() {
        assert_eq!(
            finish_reactions(true, false, &[]),
            vec![(ReactionOp::Remove, "👀"), (ReactionOp::Add, "❌")]
        );
    }

    #[test]
    fn agent_reactions_mirror_even_with_lifecycle_reactions_off() {
        let agent = owned(&["🙏", "🎉"]);
        assert_eq!(
            finish_reactions(false, true, &agent),
            vec![(ReactionOp::Add, "🙏"), (ReactionOp::Add, "🎉")]
        );
        assert!(finish_reactions(false, true, &[]).is_empty());
        assert!(finish_reactions(false, false, &[]).is_empty());
    }

    #[test]
    fn an_agent_that_chose_the_working_emoji_keeps_it() {
        let agent = owned(&["👀"]);
        assert_eq!(
            finish_reactions(true, true, &agent),
            vec![(ReactionOp::Add, "👀")]
        );
    }
}
