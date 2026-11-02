//! Channel-layer configuration: the plain structs each adapter needs at spawn.

use super::*;

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

pub(super) fn default_positive_reaction_emojis() -> Vec<String> {
    vec!["👍".to_string()]
}

pub(super) fn default_negative_reaction_emojis() -> Vec<String> {
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
