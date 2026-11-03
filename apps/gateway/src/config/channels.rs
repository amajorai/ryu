//! Shared channel options plus the Telegram and Slack channel configs.

use super::*;

// `GroupReplyMode`, `DmPolicy` and `GroupPolicy` are shared channel-domain types
// owned by the `ryu-gw-channels` crate. Re-exported here so `config::<T>` stays a
// valid path and the channel config structs below keep using them as field types.
// (They all derive serde with lowercase variants, so a config file spells them
// exactly as the crate documents them.)
pub use ryu_gw_channels::pairing::{DmPolicy, GroupPolicy};
pub use ryu_gw_channels::GroupReplyMode;

/// When the bot answers with synthesized speech as well as text.
///
/// A config-FILE mirror of `ryu_gw_channels::media::VoiceReplyMode`, which is a
/// plain domain enum with no serde derives — the same split as every other
/// channel type here (config shapes are serde-aware, the crate's are not).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceReplyMode {
    /// Never synthesize. The default — TTS costs time and most chats want text.
    #[default]
    Never,
    /// Speak only when the user's own message was a voice note.
    Mirror,
    /// Speak every reply.
    Always,
}

/// The behaviour every channel config shares, independent of transport.
///
/// `#[serde(flatten)]`-ed into each per-channel table, so the keys sit exactly
/// where they always did (`[channels.telegram] model = "..."`) and an existing
/// `gateway.toml` parses byte-identically — while a new knob is added once, here,
/// instead of five times across five near-identical structs. Mirrors
/// [`ryu_gw_channels::CommonChannelConfig`], which `channels_host.rs` maps this
/// into at the spawn boundary.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommonChannelFileConfig {
    /// Model to route inbound messages to. Defaults to `gpt-4o`.
    /// Ignored when `agent_id`/`team_id` is set (the Core binding takes precedence).
    #[serde(default = "default_channel_model")]
    pub model: String,
    /// Optional system prompt prepended to every inbound conversation.
    #[serde(default)]
    pub system_prompt: Option<String>,
    /// Core agent id to route inbound messages to (M11).
    ///
    /// When set, inbound messages are routed through Core's
    /// `POST /api/channels/run` endpoint using this agent binding instead of
    /// going directly through the gateway pipeline. The agent binding is swappable
    /// via config; omit to keep the legacy gateway-pipeline path.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// Core team id to route inbound messages to. When set, the bot targets a
    /// team (a lead agent orchestrating its members) instead of a single agent
    /// and takes precedence over `agent_id`. Also routed through
    /// `/api/channels/run`.
    #[serde(default)]
    pub team_id: Option<String>,
    /// Store-backed channel config id used to namespace platform chats in Core.
    /// Environment-only channel configs leave this unset and keep legacy ids.
    #[serde(skip)]
    pub channel_id: Option<String>,
    /// When the bot replies inside a group chat (DMs always reply). Mirrors the
    /// control-plane `groupReplyMode`; defaults to mentions-only.
    #[serde(default)]
    pub group_reply_mode: GroupReplyMode,
    /// Base URL of the Core sidecar. Defaults to the profile-aware Core bind
    /// address (`http://127.0.0.1:7980` on release). Used when `agent_id` or
    /// `team_id` is set, and for the voice/command round trips.
    #[serde(default = "default_core_url")]
    pub core_url: String,
    /// Optional reaction-to-Learning bridge. Disabled by default; when enabled,
    /// `positive_emoji` / `negative_emoji` choose the provider reactions that
    /// become thumbs-up/down labels. The exact reaction is still bound to a
    /// confirmed bot reply before Core receives it.
    #[serde(default)]
    pub reaction_learning: ryu_gw_channels::ReactionLearningConfig,

    // ── Access ──────────────────────────────────────────────────────────────
    //
    // `None` means "not configured here", which is NOT the same as the policy
    // default: it hands the decision to the legacy env allowlist
    // (`RYU_CHANNEL_ALLOWED_USERS[_<PLATFORM>]`, `RYU_CHANNEL_ALLOW_ALL`) that
    // deployments already depend on. Setting either key here overrides that env
    // for this channel; leaving it unset keeps today's behaviour exactly.
    /// How a DM from an unknown sender is treated: `pairing` (default — issue a
    /// one-time code an operator approves), `allowlist`, `open`, or `disabled`.
    #[serde(default)]
    pub dm_policy: Option<DmPolicy>,
    /// How a group/multi-user chat is treated: `allowlist` (default), `open`, or
    /// `disabled`. There is no pairing flow for groups — a room is admitted by
    /// the operator or not at all.
    #[serde(default)]
    pub group_policy: Option<GroupPolicy>,
    /// Sender ids admitted without pairing. Non-empty replaces whatever the
    /// legacy env allowlist supplied.
    #[serde(default)]
    pub dm_allowlist: Vec<String>,
    /// Group/chat ids admitted under `group_policy = "allowlist"`. Non-empty
    /// replaces whatever the legacy env allowlist supplied.
    #[serde(default)]
    pub group_allowlist: Vec<String>,
    /// Sender ids admitted inside groups. This is useful for Telegram, Slack and
    /// BlueBubbles where a platform can expose a stable author id even when the
    /// room itself is discovered dynamically.
    #[serde(default)]
    pub group_user_allowlist: Vec<String>,

    // ── Presentation ────────────────────────────────────────────────────────
    /// Show a platform typing indicator (and mark inbound read) while the agent
    /// is working. On by default: a silent bot looks broken.
    #[serde(default = "default_true")]
    pub typing_indicator: bool,
    /// Publish the Ryu command menu to the platform where one exists, so `/proof`
    /// autocompletes in Telegram the way it does in the desktop composer.
    #[serde(default = "default_true")]
    pub publish_commands: bool,
    /// Render replies as platform rich text where supported, instead of plain.
    #[serde(default = "default_true")]
    pub rich_text: bool,
    /// Stream partial output where the platform supports editable drafts. Off by
    /// default — it multiplies outbound API calls and every platform rate-limits
    /// edits.
    #[serde(default)]
    pub streaming: bool,
    /// Show 👀 while a turn runs and ❌ when it fails, where the platform supports
    /// reactions. The agent's own `agents.react` reaction is mirrored either way.
    #[serde(default = "default_true")]
    pub lifecycle_reactions: bool,
    /// When to answer with synthesized speech alongside the text reply.
    #[serde(default)]
    pub voice_reply: VoiceReplyMode,
    /// Send Ryu's first welcome without waiting for a user message. Requires an
    /// explicitly admitted `proactive_target`; it never broadcasts.
    #[serde(default)]
    pub proactive_opening: bool,
    /// Direct-chat id where the first welcome should appear.
    #[serde(default)]
    pub proactive_target: Option<String>,

    // ── Bot profile ─────────────────────────────────────────────────────────
    //
    // Kept as three flat keys rather than a `[profile]` sub-table: the whole
    // struct is flattened into the channel table, and a nested table inside a
    // flattened struct is exactly the shape TOML cannot serialise after values.
    /// Display name pushed to the platform at startup. Unset leaves the
    /// platform's current name alone rather than clearing it.
    #[serde(default)]
    pub profile_name: Option<String>,
    /// Short bio shown on the bot's profile page (clipped to 120 chars).
    #[serde(default)]
    pub profile_short_bio: Option<String>,
    /// Longer description shown in an empty chat (clipped to 512 chars).
    #[serde(default)]
    pub profile_description: Option<String>,
}

impl Default for CommonChannelFileConfig {
    fn default() -> Self {
        Self {
            model: default_channel_model(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            channel_id: None,
            group_reply_mode: GroupReplyMode::default(),
            core_url: default_core_url(),
            reaction_learning: ryu_gw_channels::ReactionLearningConfig::default(),
            dm_policy: None,
            group_policy: None,
            dm_allowlist: Vec::new(),
            group_allowlist: Vec::new(),
            group_user_allowlist: Vec::new(),
            typing_indicator: true,
            publish_commands: true,
            rich_text: true,
            streaming: false,
            lifecycle_reactions: true,
            voice_reply: VoiceReplyMode::default(),
            proactive_opening: false,
            proactive_target: None,
            profile_name: None,
            profile_short_bio: None,
            profile_description: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramChannelConfig {
    /// Bot token issued by @BotFather.
    pub token: String,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.telegram]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
    /// Telegram Bot API transport and group-addressing options.
    #[serde(default)]
    pub options: TelegramChannelOptionsFileConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TelegramChannelOptionsFileConfig {
    #[serde(default)]
    pub webhook_url: Option<String>,
    #[serde(default)]
    pub webhook_secret: Option<String>,
    #[serde(default = "default_telegram_webhook_bind")]
    pub webhook_bind: String,
    #[serde(default = "default_telegram_webhook_path")]
    pub webhook_path: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub base_file_url: Option<String>,
    #[serde(default)]
    pub local_mode: bool,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub ignored_threads: Vec<String>,
    #[serde(default)]
    pub exclusive_bot_mentions: bool,
    #[serde(default = "default_true")]
    pub guest_mode: bool,
    #[serde(default = "default_telegram_command_menu_max")]
    pub command_menu_max: usize,
}

impl Default for TelegramChannelOptionsFileConfig {
    fn default() -> Self {
        Self {
            webhook_url: None,
            webhook_secret: None,
            webhook_bind: default_telegram_webhook_bind(),
            webhook_path: default_telegram_webhook_path(),
            base_url: None,
            base_file_url: None,
            local_mode: false,
            mention_patterns: Vec::new(),
            ignored_threads: Vec::new(),
            exclusive_bot_mentions: false,
            guest_mode: true,
            command_menu_max: default_telegram_command_menu_max(),
        }
    }
}

pub(crate) fn default_telegram_webhook_bind() -> String {
    "0.0.0.0:8443".to_string()
}

pub(crate) fn default_telegram_webhook_path() -> String {
    "/webhooks/telegram".to_string()
}

pub(crate) fn default_telegram_command_menu_max() -> usize {
    60
}

pub(crate) fn default_core_url() -> String {
    // The channels callback URL to Core. Profile-aware (release 7980, dev 8980, …)
    // so a standalone dev gateway's channel adapters reach the dev Core, not the
    // release one. `RYU_CORE_URL` (set explicitly) still wins.
    format!("http://127.0.0.1:{}", crate::profile::port(7980))
}

/// Slack channel config. Uses Socket Mode so no public webhook URL is required:
/// the gateway opens an outbound WebSocket via the app-level token and receives
/// events over it, replying with the bot token.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlackChannelConfig {
    /// App-level token (`xapp-...`) with `connections:write`, used to open the
    /// Socket Mode WebSocket via `apps.connections.open`.
    pub app_token: String,
    /// Bot user OAuth token (`xoxb-...`) used to post replies via
    /// `chat.postMessage`.
    pub bot_token: String,
    /// Model, agent binding, access policy and presentation knobs. Flattened, so
    /// these keys sit directly under `[channels.slack]`.
    #[serde(flatten)]
    pub common: CommonChannelFileConfig,
    #[serde(default)]
    pub options: SlackChannelOptionsFileConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SlackChannelOptionsFileConfig {
    #[serde(default = "default_true")]
    pub reply_in_thread: bool,
    #[serde(default)]
    pub reply_broadcast: bool,
    #[serde(default)]
    pub strict_mention: bool,
    #[serde(default)]
    pub thread_require_mention: bool,
    #[serde(default)]
    pub free_response_channels: Vec<String>,
    #[serde(default)]
    pub require_mention_channels: Vec<String>,
    #[serde(default)]
    pub allowed_channels: Vec<String>,
    #[serde(default)]
    pub ignored_channels: Vec<String>,
    #[serde(default)]
    pub allow_bots: bool,
    #[serde(default)]
    pub reply_prefix: Option<String>,
    #[serde(default)]
    pub mention_patterns: Vec<String>,
    #[serde(default)]
    pub rich_blocks: bool,
    #[serde(default)]
    pub feedback_buttons: bool,
}

impl Default for SlackChannelOptionsFileConfig {
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

pub(crate) fn default_channel_model() -> String {
    "gpt-4o".to_string()
}
