//! Gateway-side channel wiring: the [`ChannelHost`] implementation (the
//! `pipeline::run` call + [`RequestContext`] construction) plus channel
//! registration — control-plane store fetch, env fallback, and spawn.
//!
//! The transport adapters (Telegram/Slack/Discord/WhatsApp/BlueBubbles) and the
//! shared inbound path live in the [`ryu_gw_channels`] crate. This module is the
//! "wiring stays" half of that extraction: it holds everything that touches
//! [`SharedState`], the pipeline, or the gateway config shell, and hands the
//! crate a narrow [`ChannelHost`] seam plus fully-built adapters.
//!
//! One thing is deliberately built HERE rather than per adapter: the
//! [`PairingStore`]. Approving a sender is a per-node act, so every channel on
//! the node must observe the same approvals the moment they land — one store is
//! constructed at startup and cloned into each adapter.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize};
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use ryu_gw_channels::{
    bluebubbles::BlueBubblesChannel,
    discord::DiscordChannel,
    is_token_rejected,
    media::VoiceReplyMode as ChannelVoiceReplyMode,
    openwa::OpenWaChannel,
    pairing::{AccessPolicy, PairingSeal, PairingStore, PAIRING_STORE},
    policy_from_env, run_channel,
    slack::SlackChannel,
    spawn_channel,
    status::StatusReporter,
    telegram::TelegramChannel,
    whatsapp::WhatsAppChannel,
    BotProfile, ChannelHost, CommonChannelConfig,
};

use crate::{
    config::{
        BlueBubblesChannelConfig, CommonChannelFileConfig, DiscordChannelConfig,
        SlackChannelConfig, TelegramChannelConfig, VoiceReplyMode, WhatsAppChannelConfig,
    },
    pipeline::{self, RequestContext},
    state::SharedState,
};

/// Default model used for store-sourced bot configs that don't specify one.
const DEFAULT_BOT_MODEL: &str = "gpt-4o";

/// Override for the pairing store's location. Mirrors the escape hatch the
/// marketplace signing key has, for deployments that keep gateway state on a
/// mounted volume.
const ENV_PAIRING_PATH: &str = "RYU_CHANNEL_PAIRING_PATH";

// ─── Gateway config → crate transport-config mapping ────────────────────────
//
// The config-FILE shapes live in `config.rs` (serde + profile-aware `core_url`
// defaults, kernel §5). The transport adapters take the crate's plain config
// mirrors; these move the fields across at the spawn boundary. Everything that
// is not a transport secret now lives in one `common` struct on both sides, so
// each mapper is its secrets plus one `to_common` call.

/// Map the config-file voice mode onto the crate's domain enum. Two enums exist
/// because the config shape is serde-aware and the crate's is not; the variants
/// are 1:1 so this stays exhaustive by construction.
fn to_voice_reply(mode: VoiceReplyMode) -> ChannelVoiceReplyMode {
    match mode {
        VoiceReplyMode::Never => ChannelVoiceReplyMode::Never,
        VoiceReplyMode::Mirror => ChannelVoiceReplyMode::Mirror,
        VoiceReplyMode::Always => ChannelVoiceReplyMode::Always,
    }
}

/// Resolve a channel's [`AccessPolicy`] from the config file, layered over the
/// legacy env allowlist.
///
/// The env vars (`RYU_CHANNEL_ALLOWED_USERS[_<PLATFORM>]`, `RYU_CHANNEL_ALLOW_ALL`)
/// are the baseline, so a deployment that configures nothing new keeps exactly
/// the gate it has today. An explicitly configured policy or allowlist then
/// overrides that baseline — but an env allowlist survives an explicit policy
/// change, which is what lets a bot switch to pairing without locking out the
/// senders the operator had already admitted.
fn to_access_policy(platform: &str, c: &CommonChannelFileConfig) -> AccessPolicy {
    let mut policy = policy_from_env(platform);
    if let Some(dm) = c.dm_policy {
        policy.dm = dm;
    }
    if let Some(group) = c.group_policy {
        policy.group = group;
    }
    if !c.dm_allowlist.is_empty() {
        policy.dm_allowlist = c.dm_allowlist.clone();
    }
    if !c.group_allowlist.is_empty() {
        policy.group_allowlist = c.group_allowlist.clone();
    }
    if !c.group_user_allowlist.is_empty() {
        policy.group_sender_allowlist = c.group_user_allowlist.clone();
    }
    policy
}

/// Map the shared config-file knobs onto the crate's [`CommonChannelConfig`].
///
/// `send_read_receipts` is the one field this does NOT resolve: the kernel keeps
/// it in the common struct (that is where `handle_turn` reads it), but only two
/// platforms can act on it, so only those two configs expose the key. They set it
/// on the returned struct; everyone else keeps the kernel's default, where
/// `mark_read` is a no-op anyway.
fn to_common(platform: &str, c: CommonChannelFileConfig) -> CommonChannelConfig {
    let access = to_access_policy(platform, &c);
    CommonChannelConfig {
        model: c.model,
        system_prompt: c.system_prompt,
        agent_id: c.agent_id,
        team_id: c.team_id,
        channel_id: c.channel_id,
        group_reply_mode: c.group_reply_mode,
        core_url: c.core_url,
        reaction_learning: c.reaction_learning,
        access,
        voice_reply: to_voice_reply(c.voice_reply),
        typing_indicator: c.typing_indicator,
        publish_commands: c.publish_commands,
        rich_text: c.rich_text,
        streaming: c.streaming,
        lifecycle_reactions: c.lifecycle_reactions,
        proactive_opening: c.proactive_opening,
        proactive_target: c.proactive_target,
        profile: BotProfile {
            name: c.profile_name,
            short_bio: c.profile_short_bio,
            description: c.profile_description,
        },
        // Spelled out rather than filled in with `..Default::default()`: every
        // field is listed exactly once here, so a knob added to the kernel breaks
        // this mapper instead of silently defaulting and never being wired.
        send_read_receipts: true,
    }
}

fn to_channel_telegram(c: TelegramChannelConfig) -> ryu_gw_channels::TelegramChannelConfig {
    ryu_gw_channels::TelegramChannelConfig {
        token: c.token,
        common: to_common("telegram", c.common),
        options: ryu_gw_channels::TelegramChannelOptions {
            webhook_url: c.options.webhook_url,
            webhook_secret: c.options.webhook_secret,
            webhook_bind: c.options.webhook_bind,
            webhook_path: c.options.webhook_path,
            base_url: c.options.base_url,
            base_file_url: c.options.base_file_url,
            local_mode: c.options.local_mode,
            mention_patterns: c.options.mention_patterns,
            ignored_threads: c.options.ignored_threads,
            exclusive_bot_mentions: c.options.exclusive_bot_mentions,
            guest_mode: c.options.guest_mode,
            command_menu_max: c.options.command_menu_max,
        },
    }
}

fn to_channel_slack(c: SlackChannelConfig) -> ryu_gw_channels::SlackChannelConfig {
    ryu_gw_channels::SlackChannelConfig {
        app_token: c.app_token,
        bot_token: c.bot_token,
        common: to_common("slack", c.common),
        options: ryu_gw_channels::SlackChannelOptions {
            reply_in_thread: c.options.reply_in_thread,
            reply_broadcast: c.options.reply_broadcast,
            strict_mention: c.options.strict_mention,
            thread_require_mention: c.options.thread_require_mention,
            free_response_channels: c.options.free_response_channels,
            require_mention_channels: c.options.require_mention_channels,
            allowed_channels: c.options.allowed_channels,
            ignored_channels: c.options.ignored_channels,
            allow_bots: c.options.allow_bots,
            reply_prefix: c.options.reply_prefix,
            mention_patterns: c.options.mention_patterns,
            rich_blocks: c.options.rich_blocks,
            feedback_buttons: c.options.feedback_buttons,
        },
    }
}

fn to_channel_discord(c: DiscordChannelConfig) -> ryu_gw_channels::DiscordChannelConfig {
    let mut common = to_common("discord", c.common);
    if common.proactive_target.is_none() {
        common.proactive_target = c.home_channel.clone();
    }
    ryu_gw_channels::DiscordChannelConfig {
        token: c.token,
        channel_ids: c.channel_ids,
        thread_replies: c.thread_replies,
        common,
        options: ryu_gw_channels::DiscordChannelOptions {
            history_backfill: c.history_backfill,
            free_response_channels: c.free_response_channels,
            allowed_channels: c.allowed_channels,
            allowed_roles: c.allowed_roles,
            thread_require_mention: c.thread_require_mention,
            mention_patterns: c.mention_patterns,
            ignored_channels: c.ignored_channels,
            no_thread_channels: c.no_thread_channels,
            allow_bots: c.allow_bots,
            home_channel: c.home_channel,
        },
    }
}

fn to_channel_whatsapp(c: WhatsAppChannelConfig) -> ryu_gw_channels::WhatsAppChannelConfig {
    let mut common = to_common("whatsapp", c.common);
    common.send_read_receipts = c.send_read_receipts;
    ryu_gw_channels::WhatsAppChannelConfig {
        access_token: c.access_token,
        phone_number_id: c.phone_number_id,
        verify_token: c.verify_token,
        app_secret: c.app_secret,
        webhook_bind: c.webhook_bind,
        webhook_path: c.webhook_path,
        graph_version: c.graph_version,
        common,
    }
}

fn to_channel_openwa(
    c: ryu_gw_channels::OpenWaChannelConfig,
) -> ryu_gw_channels::OpenWaChannelConfig {
    c
}

fn to_channel_bluebubbles(
    c: BlueBubblesChannelConfig,
) -> ryu_gw_channels::BlueBubblesChannelConfig {
    let mut common = to_common("bluebubbles", c.common);
    if common.proactive_target.is_none() {
        common.proactive_target = c.home_channel.clone();
    }
    // Read receipts on iMessage are a Private-API-only verb, so asking for them
    // without the helper installed would just emit failing calls every turn.
    common.send_read_receipts = c.private_api && c.send_read_receipts;
    ryu_gw_channels::BlueBubblesChannelConfig {
        server_url: c.server_url,
        password: c.password,
        webhook_bind: c.webhook_bind,
        webhook_path: c.webhook_path,
        private_api: c.private_api,
        mention_patterns: c.mention_patterns,
        home_channel: c.home_channel,
        common,
    }
}

// ─── The node's pairing store ───────────────────────────────────────────────

/// Where the pairing store lives: the [`ENV_PAIRING_PATH`] override, else
/// `<RYU_DIR>/state/channel-pairing.json` under Core, else the standalone
/// `<data_local>/ryu{profile suffix}/channel-pairing.json`.
///
/// The profile suffix matters here in a way it does not for, say, the audit db:
/// a dev gateway must not inherit (or write into) the release node's approvals,
/// or "approve this sender" in one profile silently admits them in the other.
/// `None` when the platform has no data dir, which the caller degrades to an
/// in-memory store.
fn pairing_store_path() -> Option<PathBuf> {
    if let Ok(raw) = std::env::var(ENV_PAIRING_PATH) {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    crate::profile::data_file(crate::profile::DataSlot::State, "channel-pairing.json")
}

/// The pairing file's at-rest protection: the Gateway component key's content
/// cipher for [`PAIRING_STORE`], whatever path the file lives at. Without a key
/// the store runs in memory only (it never writes plaintext).
fn pairing_seal() -> PairingSeal {
    match ryu_crypto::component_cipher_for_process(ryu_crypto::components::GATEWAY) {
        Ok(component) => PairingSeal::Sealed(component.content_cipher(PAIRING_STORE)),
        Err(error) => PairingSeal::Unavailable(error.to_string()),
    }
}

/// Load the node's shared pairing store, falling back to an ephemeral one when
/// there is nowhere to persist it. Ephemeral is safe but forgetful: senders
/// re-pair after a restart, so it is logged rather than passed over silently.
async fn load_pairing_store() -> PairingStore {
    match pairing_store_path() {
        Some(path) => PairingStore::load(path, pairing_seal()).await,
        None => {
            warn!(
                "no data directory available for the channel pairing store; \
                 approvals will not survive a gateway restart"
            );
            PairingStore::ephemeral()
        }
    }
}

// ─── The ChannelHost seam ───────────────────────────────────────────────────

/// The gateway's [`ChannelHost`]: runs a channel-originated request through the
/// pipeline with a channel-scoped [`RequestContext`].
struct GatewayChannelHost {
    state: SharedState,
}

#[async_trait]
impl ChannelHost for GatewayChannelHost {
    async fn run_pipeline(&self, channel_name: &str, body: Value) -> anyhow::Result<Value> {
        let ctx = channel_context(channel_name);
        let output = pipeline::run(self.state.clone(), ctx, body)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(output.response)
    }
}

/// Build an internal request context for channel-originated traffic.
///
/// Channel messages do not carry an HTTP API key, so we synthesise a context
/// scoped to the channel. The api_key namespaces audit/rate-limit buckets per
/// channel without requiring `auth.require_auth`.
fn channel_context(channel_name: &str) -> RequestContext {
    RequestContext {
        org_limits: None,
        identity: None,
        standing: None,
        enforcement: None,
        host_conversation: None,
        authorized_operation: crate::config::ApiKeyOperation::Inference,
        provider_snapshot: None,
        request_id: Uuid::new_v4().to_string(),
        api_key: format!("channel:{channel_name}"),
        owner_binding: ryu_gw_credentials::fingerprint(&format!("channel:{channel_name}")),
        is_master_key: false,
        org_id: None,
        team_id: None,
        project_id: None,
        user_name: Some(format!("{channel_name}-bot")),
        user_id: None,
        agent_id: None,
        agent_provider_access: None,
        key_config: None,
        skill_ids: None,
        // Channel messages don't carry per-agent tool grants.
        tool_actions: None,
        tools_header_present: false,
        capability_hints: None,
        // Channel messages don't carry per-agent slot selections; modality
        // routing falls back to the static modality_map for bot traffic.
        slot_provider: None,
        slot_model: None,
        own_supply_route: None,
        violation_attempt: Default::default(),
        // Channel messages don't have a session/conversation id.
        session_id: None,
        // Channel messages aren't tagged with a control-plane product surface.
        feature: None,
        purpose: None,
        // Channel messages are not companion-sourced.
        companion_source: false,
        // Channel messages do not opt into the unified tool loop.
        tool_search_requested: false,
        untrusted_caller: false,
        // Bot traffic is interactive (a user is waiting on the other end).
        priority: crate::concurrency::Priority::Interactive,
        // Channel messages don't select a named tool-policy profile.
        tool_profile: None,
        // No HTTP headers on channel traffic, so the node's `[prompt_cache]`
        // policy applies unmodified.
        prompt_cache_mode: None,
        prompt_cache_ttl: None,
        node_routing: None,
        // Bots use the managed tool loops, not SDK raw passthrough.
        raw_tools: false,
        // Channel/bot traffic is not a dynamically-resolved managed tenant.
        managed_inference: false,
        openrouter_routing_enabled: false,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        credit_accounting_unavailable: false,
        budget_resolved_at: None,
        resolved_policy: None,
    }
}

// ---------------------------------------------------------------------------
// Control-plane store: response types for GET /channels/gateway/enabled
// ---------------------------------------------------------------------------

/// One enabled bot config returned by the control-plane store endpoint.
///
/// The endpoint (`packages/api/src/routers/channels.ts`) serializes camelCase
/// keys (`channelType`, `agentId`, `systemPrompt`), so map them to our snake_case
/// fields — without this the store response fails to parse and the gateway
/// silently falls back to env-only channel config.
/// Every field past `system_prompt` carries `#[serde(default)]` for one reason:
/// an older control plane does not send it. Without the defaults the whole
/// response fails to parse and the gateway silently drops back to env-only
/// channels — the exact failure the `rename_all` regression caused before.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBotConfig {
    /// The channel config's control-plane id, used to report liveness back.
    id: String,
    channel_type: String,
    name: String,
    secrets: HashMap<String, String>,
    #[serde(default)]
    platform_options: Value,
    agent_id: Option<String>,
    #[serde(default)]
    team_id: Option<String>,
    model: Option<String>,
    system_prompt: Option<String>,
    /// When the bot replies in a group chat (mentions-only vs all). Absent on
    /// older control planes → serde default (mentions).
    #[serde(default)]
    group_reply_mode: ryu_gw_channels::GroupReplyMode,

    /// Who may DM the bot, and how a stranger enrols. `None` (older control
    /// plane) leaves the legacy env allowlist in charge — see [`to_access_policy`].
    #[serde(default)]
    dm_policy: Option<crate::config::DmPolicy>,
    /// Whether the bot answers in groups at all.
    #[serde(default)]
    group_policy: Option<crate::config::GroupPolicy>,
    #[serde(default)]
    dm_allowlist: Vec<String>,
    #[serde(default)]
    group_allowlist: Vec<String>,
    #[serde(default)]
    group_user_allowlist: Vec<String>,
    #[serde(default = "default_true")]
    typing_indicator: bool,
    #[serde(default = "default_true")]
    publish_commands: bool,
    #[serde(default = "default_true")]
    rich_text: bool,
    #[serde(default)]
    streaming: bool,
    #[serde(default = "default_true")]
    lifecycle_reactions: bool,
    /// Optional provider-reaction learning settings. Older control planes omit
    /// this and keep the bridge disabled via the domain default.
    #[serde(default)]
    reaction_learning: ryu_gw_channels::ReactionLearningConfig,
    #[serde(default)]
    voice_reply: VoiceReplyMode,
    /// Send the first Ryu welcome after the channel is ready. Older control
    /// planes omit this, so store-sourced bots remain quiet until configured.
    #[serde(default)]
    proactive_opening: bool,
    #[serde(default)]
    proactive_target: Option<String>,
    /// Discord only: answer inside a thread opened on the triggering message.
    #[serde(default)]
    thread_replies: bool,
    /// WhatsApp / BlueBubbles: mark inbound messages read (blue ticks).
    #[serde(default = "default_true")]
    send_read_receipts: bool,
    #[serde(default)]
    profile_name: Option<String>,
    #[serde(default)]
    profile_short_bio: Option<String>,
    #[serde(default)]
    profile_description: Option<String>,
}

/// serde's `default` needs a function for a non-`false` boolean default. These
/// three knobs are on unless the operator turned them off, and an older control
/// plane that omits them must land on "on", not "off".
fn default_true() -> bool {
    true
}

impl StoredBotConfig {
    fn platform_options<T>(&self) -> T
    where
        T: DeserializeOwned + Default,
    {
        serde_json::from_value(self.platform_options.clone()).unwrap_or_default()
    }

    /// The shared knobs, in the config-FILE shape so store-sourced and
    /// env-sourced bots go through exactly one mapping path ([`to_common`]).
    fn common(&self) -> CommonChannelFileConfig {
        CommonChannelFileConfig {
            model: self
                .model
                .clone()
                .unwrap_or_else(|| DEFAULT_BOT_MODEL.to_string()),
            system_prompt: self.system_prompt.clone(),
            agent_id: self.agent_id.clone(),
            team_id: self.team_id.clone(),
            channel_id: Some(self.id.clone()),
            group_reply_mode: self.group_reply_mode,
            // Profile-aware, so a dev-profile gateway's store bots call the dev
            // Core rather than the release one.
            core_url: crate::config::default_core_url(),
            dm_policy: self.dm_policy,
            group_policy: self.group_policy,
            dm_allowlist: self.dm_allowlist.clone(),
            group_allowlist: self.group_allowlist.clone(),
            group_user_allowlist: self.group_user_allowlist.clone(),
            typing_indicator: self.typing_indicator,
            publish_commands: self.publish_commands,
            rich_text: self.rich_text,
            streaming: self.streaming,
            lifecycle_reactions: self.lifecycle_reactions,
            reaction_learning: self.reaction_learning.clone(),
            voice_reply: self.voice_reply,
            proactive_opening: self.proactive_opening,
            proactive_target: self.proactive_target.clone(),
            profile_name: self.profile_name.clone(),
            profile_short_bio: self.profile_short_bio.clone(),
            profile_description: self.profile_description.clone(),
        }
    }
}

/// Top-level response from `GET /api/channels/gateway/enabled`.
#[derive(Debug, Deserialize)]
struct StoredChannelsResponse {
    channels: Vec<StoredBotConfig>,
}

/// Fetch enabled bot configs from the control-plane store.
///
/// Returns an empty vec when the control plane is disabled, when no gateway
/// key is configured, or when the request fails — caller must treat this as
/// "no store configs available, fall back to env".
async fn fetch_store_configs(state: &SharedState) -> Vec<StoredBotConfig> {
    let cfg = &state.config.control_plane;
    let Some(key) = cfg.gateway_key.as_deref() else {
        return Vec::new();
    };

    let url = format!(
        "{}/channels/gateway/enabled",
        cfg.base_url.trim_end_matches('/')
    );

    match state
        .http
        .get(&url)
        .header("x-gateway-key", key)
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            match resp.json::<StoredChannelsResponse>().await {
                Ok(parsed) => {
                    info!(
                        count = parsed.channels.len(),
                        "loaded enabled bot configs from control-plane store"
                    );
                    parsed.channels
                }
                Err(err) => {
                    warn!(%err, "failed to parse control-plane channel configs; falling back to env");
                    Vec::new()
                }
            }
        }
        Ok(resp) => {
            warn!(
                status = %resp.status(),
                "control-plane channel store returned non-2xx; falling back to env"
            );
            Vec::new()
        }
        Err(err) => {
            warn!(%err, "control-plane channel store unreachable; falling back to env");
            Vec::new()
        }
    }
}

/// Build a [`TelegramChannelConfig`] from a store bot config.
fn telegram_cfg_from_store(bot: &StoredBotConfig) -> Option<TelegramChannelConfig> {
    let token = bot.secrets.get("bot_token")?.to_string();
    let mut options: crate::config::TelegramChannelOptionsFileConfig = bot.platform_options();
    options.webhook_secret = bot.secrets.get("webhook_secret").cloned();
    Some(TelegramChannelConfig {
        token,
        common: bot.common(),
        options,
    })
}

/// Build a [`SlackChannelConfig`] from a store bot config.
fn slack_cfg_from_store(bot: &StoredBotConfig) -> Option<SlackChannelConfig> {
    let app_token = bot.secrets.get("app_token")?.to_string();
    let bot_token = bot.secrets.get("bot_token")?.to_string();
    Some(SlackChannelConfig {
        app_token,
        bot_token,
        common: bot.common(),
        options: bot.platform_options(),
    })
}

/// Build a [`DiscordChannelConfig`] from a store bot config.
fn discord_cfg_from_store(bot: &StoredBotConfig) -> Option<DiscordChannelConfig> {
    let token = bot.secrets.get("bot_token")?.to_string();
    let channel_ids = bot
        .secrets
        .get("channel_ids")
        .map(|s| {
            s.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let options: Value = bot.platform_options();
    let option_bool = |key: &str, fallback| {
        options
            .get(key)
            .and_then(Value::as_bool)
            .unwrap_or(fallback)
    };
    let option_list = |key: &str| {
        options
            .get(key)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let home_channel = options
        .get("home_channel")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(DiscordChannelConfig {
        token,
        channel_ids,
        thread_replies: bot.thread_replies,
        history_backfill: option_bool("history_backfill", false),
        free_response_channels: option_list("free_response_channels"),
        allowed_channels: option_list("allowed_channels"),
        allowed_roles: option_list("allowed_roles"),
        thread_require_mention: option_bool("thread_require_mention", false),
        mention_patterns: option_list("mention_patterns"),
        ignored_channels: option_list("ignored_channels"),
        no_thread_channels: option_list("no_thread_channels"),
        allow_bots: option_bool("allow_bots", false),
        home_channel,
        common: bot.common(),
    })
}

/// Build a [`WhatsAppChannelConfig`] from a store bot config.
fn whatsapp_cfg_from_store(bot: &StoredBotConfig) -> Option<WhatsAppChannelConfig> {
    let access_token = bot.secrets.get("access_token")?.to_string();
    let verify_token = bot.secrets.get("verify_token")?.to_string();
    let phone_number_id = bot
        .secrets
        .get("phone_number_id")
        .cloned()
        .unwrap_or_default();
    let app_secret = bot.secrets.get("app_secret").cloned().unwrap_or_default();
    Some(WhatsAppChannelConfig {
        access_token,
        phone_number_id,
        verify_token,
        app_secret,
        // These are optional per-channel overrides. The defaults preserve the
        // legacy single-Cloud-bot configuration, while separate bind/path values
        // let multiple channel records coexist on one gateway.
        webhook_bind: secret_or(bot, "webhook_bind", crate::config::default_whatsapp_bind()),
        webhook_path: secret_or(bot, "webhook_path", crate::config::default_whatsapp_path()),
        graph_version: secret_or(
            bot,
            "graph_version",
            crate::config::default_whatsapp_graph_version(),
        ),
        send_read_receipts: bot.send_read_receipts,
        common: bot.common(),
    })
}

/// Build a WhatsApp Personal/OpenWA transport config from one channel record.
fn openwa_cfg_from_store(bot: &StoredBotConfig) -> Option<ryu_gw_channels::OpenWaChannelConfig> {
    let base_url = bot.secrets.get("openwa_url")?.to_string();
    let api_key = bot.secrets.get("openwa_api_key")?.to_string();
    let session_id = bot.secrets.get("openwa_session_id")?.to_string();
    let webhook_url = bot.secrets.get("webhook_url")?.to_string();
    let webhook_secret = bot.secrets.get("webhook_secret")?.to_string();
    Some(ryu_gw_channels::OpenWaChannelConfig {
        base_url,
        api_key,
        session_id,
        webhook_url,
        webhook_secret,
        webhook_bind: secret_or(
            bot,
            "webhook_bind",
            crate::config::default_whatsapp_personal_bind(),
        ),
        webhook_path: secret_or(
            bot,
            "webhook_path",
            crate::config::default_whatsapp_personal_path(),
        ),
        self_chat_only: secret_bool(bot, "self_chat_only"),
        common: to_common("openwa", bot.common()),
    })
}

fn secret_or(bot: &StoredBotConfig, key: &str, fallback: String) -> String {
    bot.secrets
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(fallback)
}

fn secret_bool(bot: &StoredBotConfig, key: &str) -> bool {
    bot.secrets
        .get(key)
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Build a [`BlueBubblesChannelConfig`] from a store bot config.
///
/// `server_url` + `password` are the bridge's own credentials (the Mac running
/// BlueBubbles Server); without both there is nothing to connect to.
fn bluebubbles_cfg_from_store(bot: &StoredBotConfig) -> Option<BlueBubblesChannelConfig> {
    let server_url = bot.secrets.get("server_url")?.to_string();
    let password = bot.secrets.get("password")?.to_string();
    let options: Value = bot.platform_options();
    let option_string = |key: &str, fallback: String| {
        options
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(fallback)
    };
    let option_list = |key: &str| {
        options
            .get(key)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let private_api = options
        .get("private_api")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| bluebubbles_private_api(bot));
    Some(BlueBubblesChannelConfig {
        server_url,
        password,
        webhook_bind: option_string("webhook_bind", crate::config::default_bluebubbles_bind()),
        webhook_path: option_string("webhook_path", crate::config::default_bluebubbles_path()),
        // The Private API helper is an extra install on the operator's Mac, so it
        // rides in `secrets` (the same opaque map Discord's `channel_ids` uses for
        // non-secret per-bot plumbing) and stays OFF unless it was declared —
        // turning it on blind would just emit failing calls. Read receipts are one
        // of the verbs it provides, hence the `&&`.
        private_api,
        send_read_receipts: private_api && bot.send_read_receipts,
        mention_patterns: option_list("mention_patterns"),
        home_channel: options
            .get("home_channel")
            .and_then(Value::as_str)
            .map(str::to_string),
        common: bot.common(),
    })
}

/// Did the store's BlueBubbles bot declare the Private API helper as installed?
fn bluebubbles_private_api(bot: &StoredBotConfig) -> bool {
    bot.secrets
        .get("private_api")
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Build a liveness reporter for a store-sourced bot from the control-plane
/// config. `None` when the control plane is not configured.
fn store_reporter(state: &SharedState, bot_id: &str) -> Option<StatusReporter> {
    StatusReporter::new(
        state.http.clone(),
        &state.config.control_plane.base_url,
        state.config.control_plane.gateway_key.clone(),
        Some(bot_id.to_string()),
    )
}

// ─── Managed-bot token rotation ──────────────────────────────────────────────
//
// A Telegram bot that Ryu created for the user (Bot API 9.6 "managed bots") can
// have its token replaced at any moment: the owner rotates it inside Telegram, or
// the manager calls `replaceManagedBotToken`. The old token dies immediately and
// the running adapter's `getUpdates` starts answering 401 — the bot goes deaf with
// nothing in the UI to explain why.
//
// Recovery cannot be a mutation. The token is baked into the adapter's API base
// at construction (`crates/gateway/channels/src/telegram.rs`), so a new token
// means a NEW adapter. Hence a supervisor *around* the adapter: it awaits the
// loop, and when it ends in `TokenRejected` it re-reads the token from the
// manager and builds a replacement. Every other exit is left alone — those are
// already logged by `run_channel`, and restart-looping them would just hide them.
//
// A hand-pasted @BotFather token has no pairing secret and therefore nothing to
// refresh. That is a legitimate configuration, not an error, so the supervisor
// says so once in a line an operator can act on and stops.

/// Base URL of the managed-bot manager (Ryu's hosted `cloud-bot`). Deliberately
/// the same variable name the node uses, so one deployment override moves both
/// ends of the pairing — note this breaks the gateway's local habit of bare
/// `CONTROL_PLANE_*` names, which is the lesser evil.
const ENV_MANAGED_BOT_URL: &str = "RYU_MANAGED_BOT_URL";

/// The hosted manager, used when nothing overrides it.
const DEFAULT_MANAGED_BOT_URL: &str = "https://bot.ryuhq.com";

/// Secrets key holding the pairing's `claim_secret` — the bearer that authorizes
/// re-reading this bot's token. Its presence is what distinguishes a Ryu-created
/// bot from a hand-pasted one, so it doubles as the "can this be refreshed?" flag.
const SECRET_MANAGED_BOT_SECRET: &str = "managed_bot_secret";

/// Secrets key holding the pairing's public `nonce`, which names the record.
const SECRET_MANAGED_BOT_NONCE: &str = "managed_bot_nonce";

/// Hard ceiling on refresh attempts before the supervisor gives up.
///
/// A revoked bot (the owner ran `/deletebot`) and a rotate storm both present as
/// an endless 401, so an unbounded retry is a hot loop against both Telegram and
/// the manager. Five attempts at the backoff below spans ~2.5 minutes: long
/// enough to ride out a rotation, short enough that the give-up line shows up
/// while the operator is still looking.
const MAX_TOKEN_REFRESHES: u32 = 5;

/// Delay before the first refresh, doubling per attempt up to
/// [`REFRESH_BACKOFF_MAX`]. Non-zero on purpose — a rotation the user just
/// triggered may still be in flight on the manager side.
const REFRESH_BACKOFF_BASE: Duration = Duration::from_secs(5);

/// Cap on the per-attempt delay, so the bounded budget still spans minutes
/// rather than hours.
const REFRESH_BACKOFF_MAX: Duration = Duration::from_secs(60);

/// Timeout for one refresh call. Short: the supervisor is holding a dead bot open
/// while it waits.
const REFRESH_TIMEOUT: Duration = Duration::from_secs(15);

/// An adapter that stayed up this long was working, so its next 401 is a NEW
/// rotation rather than the same one failing again — and the attempt budget
/// resets. Without this, a bot rotated five times over its life would refuse to
/// recover from the sixth.
const HEALTHY_RUN: Duration = Duration::from_secs(600);

/// The credentials that let the gateway re-read one managed bot's token.
#[derive(Debug, Clone)]
struct ManagedBotCreds {
    /// Public pairing id — names the record on the manager.
    nonce: String,
    /// The pairing's `claim_secret`. Never logged: it is the bearer that yields a
    /// live bot token.
    secret: String,
}

/// Pull the managed-bot pairing credentials out of a bot's secrets map.
///
/// `None` means "hand-pasted token": there is nothing to refresh. Blank values
/// count as absent — the control plane drops blank secrets on write, but an empty
/// string that did land would otherwise produce an unauthenticated refresh whose
/// 401 is indistinguishable from a wrong secret.
fn managed_bot_creds(secrets: &HashMap<String, String>) -> Option<ManagedBotCreds> {
    let nonce = secrets.get(SECRET_MANAGED_BOT_NONCE)?.trim();
    let secret = secrets.get(SECRET_MANAGED_BOT_SECRET)?.trim();
    if nonce.is_empty() || secret.is_empty() {
        return None;
    }
    Some(ManagedBotCreds {
        nonce: nonce.to_string(),
        secret: secret.to_string(),
    })
}

/// Base URL of the managed-bot manager, env-overridable, trailing slash trimmed.
fn managed_bot_base_url() -> String {
    std::env::var(ENV_MANAGED_BOT_URL)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .unwrap_or_else(|| DEFAULT_MANAGED_BOT_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Delay before refresh attempt `attempt` (1-based): exponential, capped.
///
/// Pure so the "cannot become a hot loop" property is a test rather than a
/// reading of the loop — the whole budget's worth of delay is bounded and
/// monotonic by construction.
fn refresh_backoff(attempt: u32) -> Duration {
    // Clamp the shift before it is applied: `1u32 << 32` is UB-adjacent (a debug
    // panic), and every attempt past a handful is capped anyway.
    let shift = attempt.saturating_sub(1).min(16);
    REFRESH_BACKOFF_BASE
        .saturating_mul(1u32 << shift)
        .min(REFRESH_BACKOFF_MAX)
}

/// The manager's answer to `POST /managed-bot/refresh`.
#[derive(Debug, Deserialize)]
struct ManagedBotRefreshResponse {
    /// `"ready"` or `"pending"`.
    status: String,
    /// Present only when `status == "ready"`. Optional and never unwrapped, so a
    /// manager that answers `pending` cannot take the gateway down with it.
    #[serde(default)]
    token: Option<String>,
}

/// Why a refresh did not produce a usable token.
///
/// Distinguished from a plain `Option` because half of the failures must NOT be
/// retried: a deleted pairing record and a rejected `claim_secret` will answer
/// the same way forever, and spending the attempt budget on them only delays the
/// log line that tells the operator what to fix.
enum RefreshOutcome {
    /// A live token for this bot.
    Token(String),
    /// Retrying may work — the manager was unreachable, returned 5xx, or is still
    /// `pending`.
    Retry,
    /// It never will. Carries the operator-facing reason.
    Terminal(&'static str),
}

/// Ask the manager for this bot's CURRENT token.
///
/// `refresh`, never `rotate`: when the owner rotated the token inside Telegram,
/// the current token *is* the new one, and `replaceManagedBotToken` would throw
/// away the token the user just minted.
///
/// Nothing here logs the token, the secret or the nonce — a bot token is a full
/// credential, and the log sink is not a secret store.
async fn refresh_managed_bot_token(
    state: &SharedState,
    creds: &ManagedBotCreds,
    name: &str,
) -> RefreshOutcome {
    let url = format!("{}/managed-bot/refresh", managed_bot_base_url());
    let sent = state
        .http
        .post(&url)
        .bearer_auth(&creds.secret)
        .json(&serde_json::json!({ "nonce": creds.nonce }))
        .timeout(REFRESH_TIMEOUT)
        .send()
        .await;

    let resp = match sent {
        Ok(resp) => resp,
        Err(err) => {
            // `without_url` for symmetry with the adapter: the bearer is not in
            // the URL, but neither is anything useful, and this keeps the habit.
            warn!(channel = %name, err = %err.without_url(), "managed-bot token refresh unreachable");
            return RefreshOutcome::Retry;
        }
    };

    let status = resp.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return RefreshOutcome::Terminal(
            "the managed-bot pairing no longer exists on the manager (deleted or expired)",
        );
    }
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return RefreshOutcome::Terminal("the manager rejected this bot's stored pairing secret");
    }
    if !status.is_success() {
        warn!(channel = %name, %status, "managed-bot token refresh returned non-2xx");
        return RefreshOutcome::Retry;
    }

    match resp.json::<ManagedBotRefreshResponse>().await {
        Ok(body) if body.status == "ready" => match body.token {
            Some(token) if !token.trim().is_empty() => RefreshOutcome::Token(token),
            // A ready record with no token is a manager bug, not a wait state —
            // polling it forever would never resolve.
            _ => RefreshOutcome::Terminal("the manager reported a ready bot with no token"),
        },
        Ok(body) => {
            info!(channel = %name, status = %body.status, "managed-bot token not ready yet");
            RefreshOutcome::Retry
        }
        Err(err) => {
            warn!(channel = %name, %err, "could not parse the managed-bot refresh response");
            RefreshOutcome::Retry
        }
    }
}

/// Run one Telegram adapter, and when its token is rejected, refresh the token
/// and run a replacement adapter built from it.
///
/// Returns when the bot is done: a clean exit, a non-auth failure, a bot with no
/// pairing to refresh, or an exhausted attempt budget. It never returns to a
/// caller that would restart it, so "done" here means "offline until the gateway
/// restarts" — which is the honest state, and is reported as such.
async fn supervise_telegram(
    host: Arc<dyn ChannelHost>,
    state: SharedState,
    pairing: PairingStore,
    mut cfg: ryu_gw_channels::TelegramChannelConfig,
    reporter: Option<StatusReporter>,
    managed: Option<ManagedBotCreds>,
    name: String,
) {
    let mut attempts: u32 = 0;
    loop {
        let started = Instant::now();
        let result = run_channel(
            &host,
            TelegramChannel::new_with_status(
                cfg.clone(),
                state.http.clone(),
                pairing.clone(),
                reporter.clone(),
            ),
        )
        .await;

        // `run` only returns on failure today; an `Ok` is an adapter that was
        // told to stop, and there is nothing to respawn.
        let Err(err) = result else {
            return;
        };
        // Anything but a rejected token is already logged by `run_channel` and is
        // not a rotation. Leave the bot down rather than turn every transport
        // failure into a restart loop.
        if !is_token_rejected(&err) {
            return;
        }

        let Some(creds) = managed.as_ref() else {
            warn!(
                channel = %name,
                "telegram rejected this bot's token (401) and the bot has no Ryu-managed pairing, so the gateway cannot fetch a new one — create a fresh token with @BotFather and save it on the channel; not retrying"
            );
            if let Some(reporter) = &reporter {
                reporter
                    .error("bot token rejected by Telegram (401) — save a new token")
                    .await;
            }
            return;
        };

        // A long healthy run means this is a fresh rotation, not the same one
        // failing again, so it earns a fresh budget.
        if started.elapsed() >= HEALTHY_RUN {
            attempts = 0;
        }

        let mut fresh_token = None;
        while attempts < MAX_TOKEN_REFRESHES {
            attempts += 1;
            tokio::time::sleep(refresh_backoff(attempts)).await;
            match refresh_managed_bot_token(&state, creds, &name).await {
                RefreshOutcome::Token(token) => {
                    fresh_token = Some(token);
                    break;
                }
                RefreshOutcome::Retry => continue,
                RefreshOutcome::Terminal(reason) => {
                    warn!(channel = %name, reason, "managed-bot token refresh cannot succeed; leaving this bot offline");
                    if let Some(reporter) = &reporter {
                        reporter.error(reason).await;
                    }
                    return;
                }
            }
        }

        let Some(token) = fresh_token else {
            warn!(
                channel = %name,
                attempts = MAX_TOKEN_REFRESHES,
                "gave up refreshing this managed bot's token; it stays offline until the gateway restarts"
            );
            if let Some(reporter) = &reporter {
                reporter
                    .error("managed-bot token refresh exhausted — bot offline")
                    .await;
            }
            return;
        };

        info!(channel = %name, "managed-bot token refreshed; respawning the telegram adapter");
        cfg.token = token;
    }
}

/// Register a Telegram bot under the rotation supervisor instead of a bare
/// [`spawn_channel`].
///
/// Both Telegram spawn sites go through this — the env-configured bot too, whose
/// hand-pasted token takes the `managed: None` path and so gets the actionable
/// "save a new token" line rather than a bare `channel loop exited with error`.
/// The other four transports stay on `spawn_channel`: none of them has a token
/// Ryu can re-mint, so there is nothing for a supervisor to do.
fn spawn_telegram_supervised(
    host: &Arc<dyn ChannelHost>,
    state: &SharedState,
    pairing: &PairingStore,
    cfg: TelegramChannelConfig,
    reporter: Option<StatusReporter>,
    managed: Option<ManagedBotCreds>,
    name: String,
) {
    tokio::spawn(supervise_telegram(
        Arc::clone(host),
        Arc::clone(state),
        pairing.clone(),
        to_channel_telegram(cfg),
        reporter,
        managed,
        name,
    ));
}

/// Spawn every channel configured in [`GatewayConfig`](crate::config::GatewayConfig)
/// **or** stored as an enabled bot config in the control-plane store.
///
/// Called once at startup. For each channel type, the store takes precedence
/// when configs are found there; the static `config.channels` env path is
/// used as a fallback when the store is unavailable or returns no records for
/// that type. A channel that fails to start is logged and skipped.
pub async fn spawn_registered(state: SharedState) {
    // One host shared by every channel: it owns the pipeline call + context.
    let host: Arc<dyn ChannelHost> = Arc::new(GatewayChannelHost {
        state: Arc::clone(&state),
    });

    // One pairing store for the whole node, cloned into every adapter: an
    // approval must take effect on every channel at once, and the file it is
    // backed by has a single writer.
    let pairing = load_pairing_store().await;
    // Hand the same store to the admin approval route
    // (`POST /v1/channels/pairing/approve`): pending codes are never logged, so
    // that route is how an operator admits a sender.
    let _ = state.channel_pairing.set(pairing.clone());

    // Attempt to load enabled configs from the control-plane store. An
    // empty result means the store is disabled or unreachable — fall back
    // to env for all channel types.
    let store_configs = fetch_store_configs(&state).await;

    // Track which channel types were satisfied by the store so we know
    // whether to fall back to env config.
    let mut store_telegram = false;
    let mut store_slack = false;
    let mut store_discord = false;
    let mut store_whatsapp = false;
    let mut store_bluebubbles = false;

    for bot in &store_configs {
        // A store-sourced bot has a control-plane id, so it can report its live
        // connection status back for the sidebar dot. Built once per bot and
        // cloned into whichever channel adapter handles it.
        let reporter = store_reporter(&state, &bot.id);
        match bot.channel_type.as_str() {
            "telegram" => {
                if let Some(cfg) = telegram_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering telegram bot from store");
                    // Under the supervisor, not `spawn_channel`: a Ryu-created bot's
                    // token can be replaced while this adapter is running.
                    spawn_telegram_supervised(
                        &host,
                        &state,
                        &pairing,
                        cfg,
                        reporter,
                        managed_bot_creds(&bot.secrets),
                        bot.name.clone(),
                    );
                    store_telegram = true;
                } else {
                    warn!(name = %bot.name, "telegram store config missing required secrets; skipping");
                }
            }
            "slack" => {
                if let Some(cfg) = slack_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering slack bot from store");
                    spawn_channel(
                        &host,
                        SlackChannel::new_with_status(
                            to_channel_slack(cfg),
                            state.http.clone(),
                            pairing.clone(),
                            reporter,
                        ),
                    );
                    store_slack = true;
                } else {
                    warn!(name = %bot.name, "slack store config missing required secrets; skipping");
                }
            }
            "discord" => {
                if let Some(cfg) = discord_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering discord bot from store");
                    spawn_channel(
                        &host,
                        DiscordChannel::new_with_status(
                            to_channel_discord(cfg),
                            state.http.clone(),
                            pairing.clone(),
                            reporter,
                        ),
                    );
                    store_discord = true;
                } else {
                    warn!(name = %bot.name, "discord store config missing required secrets; skipping");
                }
            }
            "whatsapp" => {
                if let Some(cfg) = whatsapp_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering whatsapp bot from store");
                    spawn_channel(
                        &host,
                        WhatsAppChannel::new_with_status(
                            to_channel_whatsapp(cfg),
                            state.http.clone(),
                            pairing.clone(),
                            reporter,
                        ),
                    );
                    store_whatsapp = true;
                } else {
                    warn!(name = %bot.name, "whatsapp store config missing required secrets; skipping");
                }
            }
            "whatsapp_personal" => {
                if let Some(cfg) = openwa_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering whatsapp personal bot from store");
                    spawn_channel(
                        &host,
                        OpenWaChannel::new_with_status(
                            to_channel_openwa(cfg),
                            state.http.clone(),
                            pairing.clone(),
                            reporter,
                        ),
                    );
                } else {
                    warn!(name = %bot.name, "whatsapp personal store config missing required secrets; skipping");
                }
            }
            "bluebubbles" => {
                if let Some(cfg) = bluebubbles_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering bluebubbles bot from store");
                    spawn_channel(
                        &host,
                        BlueBubblesChannel::new_with_status(
                            to_channel_bluebubbles(cfg),
                            state.http.clone(),
                            pairing.clone(),
                            reporter,
                        ),
                    );
                    store_bluebubbles = true;
                } else {
                    warn!(name = %bot.name, "bluebubbles store config missing required secrets; skipping");
                }
            }
            other => {
                warn!(channel_type = %other, name = %bot.name, "unknown channel type in store; skipping");
            }
        }
    }

    // Env fallback: only register the env-config'd channel when the store
    // did not already supply at least one config of that type.
    //
    // These go through the same `new_with_status` constructor as the store path
    // with a `None` reporter (an env bot has no control-plane id to report
    // against), so the node's pairing store reaches every adapter either way.
    if !store_telegram {
        if let Some(cfg) = state.config.channels.telegram.clone() {
            // An env bot's token is by definition hand-pasted, so it takes the
            // supervisor's `managed: None` path — the point is not rotation but
            // the actionable 401 line, which the bare spawn cannot produce.
            spawn_telegram_supervised(
                &host,
                &state,
                &pairing,
                cfg,
                None,
                None,
                "telegram (env)".to_string(),
            );
        }
    }
    if !store_slack {
        if let Some(cfg) = state.config.channels.slack.clone() {
            spawn_channel(
                &host,
                SlackChannel::new_with_status(
                    to_channel_slack(cfg),
                    state.http.clone(),
                    pairing.clone(),
                    None,
                ),
            );
        }
    }
    if !store_discord {
        if let Some(cfg) = state.config.channels.discord.clone() {
            spawn_channel(
                &host,
                DiscordChannel::new_with_status(
                    to_channel_discord(cfg),
                    state.http.clone(),
                    pairing.clone(),
                    None,
                ),
            );
        }
    }
    if !store_whatsapp {
        if let Some(cfg) = state.config.channels.whatsapp.clone() {
            spawn_channel(
                &host,
                WhatsAppChannel::new_with_status(
                    to_channel_whatsapp(cfg),
                    state.http.clone(),
                    pairing.clone(),
                    None,
                ),
            );
        }
    }
    if !store_bluebubbles {
        if let Some(cfg) = state.config.channels.bluebubbles.clone() {
            spawn_channel(
                &host,
                BlueBubblesChannel::new_with_status(
                    to_channel_bluebubbles(cfg),
                    state.http.clone(),
                    pairing.clone(),
                    None,
                ),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stored_bot_config_parses_camelcase_response() {
        // The control-plane endpoint returns camelCase keys; the struct must map
        // them (regression guard for the missing `rename_all`, which silently
        // dropped every store config and fell back to env-only channels).
        let raw = json!({
            "channels": [
                {
                    "id": "chan-123",
                    "channelType": "telegram",
                    "name": "Support Bot",
                    "secrets": { "bot_token": "tok:1" },
                    "agentId": "acp:pi",
                    "teamId": null,
                    "model": null,
                    "systemPrompt": "be nice"
                }
            ]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.channels.len(), 1);
        let bot = &parsed.channels[0];
        assert_eq!(bot.id, "chan-123");
        assert_eq!(bot.channel_type, "telegram");
        assert_eq!(bot.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(bot.system_prompt.as_deref(), Some("be nice"));
        assert!(bot.team_id.is_none());
    }

    #[test]
    fn channel_context_namespaces_api_key() {
        let ctx = channel_context("telegram");
        assert_eq!(ctx.api_key, "channel:telegram");
        assert_eq!(ctx.user_name.as_deref(), Some("telegram-bot"));
        assert!(!ctx.is_master_key);
    }

    /// A control plane that predates the behaviour knobs sends none of them. The
    /// bot must still parse AND land on the documented defaults — a missing field
    /// silently reading as `false` would turn typing indicators, the command menu
    /// and rich text off across every existing deployment.
    #[test]
    fn stored_bot_config_defaults_the_new_behaviour_fields() {
        let raw = json!({
            "channels": [
                {
                    "id": "chan-1",
                    "channelType": "telegram",
                    "name": "Old Bot",
                    "secrets": { "bot_token": "tok:1" },
                    "agentId": null,
                    "model": null,
                    "systemPrompt": null
                }
            ]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(raw).unwrap();
        let bot = &parsed.channels[0];
        assert!(bot.typing_indicator);
        assert!(bot.publish_commands);
        assert!(bot.rich_text);
        assert!(!bot.streaming);
        assert!(!bot.thread_replies);
        assert!(bot.lifecycle_reactions);
        assert!(!bot.proactive_opening);
        assert!(bot.proactive_target.is_none());
        assert!(bot.send_read_receipts);
        assert_eq!(bot.voice_reply, VoiceReplyMode::Never);
        // No policy at all ⇒ the legacy env allowlist stays in charge.
        assert!(bot.dm_policy.is_none());
        assert!(bot.group_policy.is_none());
    }

    /// A current control plane sends every knob camelCased; each one must reach
    /// the crate config through `common()` + `to_common()`.
    #[test]
    fn stored_bot_config_maps_every_behaviour_field() {
        let raw = json!({
            "channels": [
                {
                    "id": "chan-2",
                    "channelType": "discord",
                    "name": "Loud Bot",
                    "secrets": { "bot_token": "tok:2", "channel_ids": "c1, c2" },
                    "agentId": "acp:pi",
                    "model": "claude-sonnet",
                    "systemPrompt": "be nice",
                    "dmPolicy": "open",
                    "groupPolicy": "disabled",
                    "dmAllowlist": ["u1"],
                    "groupAllowlist": ["g1"],
                    "groupUserAllowlist": ["u2"],
                    "typingIndicator": false,
                    "publishCommands": false,
                    "richText": false,
                    "streaming": true,
                    "lifecycleReactions": false,
                    "proactiveOpening": true,
                    "proactiveTarget": "c-home",
                    "voiceReply": "mirror",
                    "threadReplies": true,
                    "sendReadReceipts": false,
                    "profileName": "Ryu",
                    "profileShortBio": "short",
                    "profileDescription": "long",
                    "platformOptions": {
                        "history_backfill": true,
                        "allowed_channels": ["c3"],
                        "allowed_roles": ["role-1"],
                        "mention_patterns": ["hey ryu"]
                    }
                }
            ]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(raw).unwrap();
        let bot = &parsed.channels[0];

        let cfg = discord_cfg_from_store(bot).expect("secrets are complete");
        assert_eq!(cfg.channel_ids, vec!["c1".to_string(), "c2".to_string()]);
        assert!(cfg.thread_replies);
        assert!(cfg.history_backfill);
        assert_eq!(cfg.allowed_channels, vec!["c3".to_string()]);
        assert_eq!(cfg.allowed_roles, vec!["role-1".to_string()]);
        assert_eq!(cfg.mention_patterns, vec!["hey ryu".to_string()]);

        let mapped = to_channel_discord(cfg);
        assert_eq!(mapped.common.model, "claude-sonnet");
        assert_eq!(mapped.common.agent_id.as_deref(), Some("acp:pi"));
        assert!(!mapped.common.typing_indicator);
        assert!(!mapped.common.publish_commands);
        assert!(!mapped.common.rich_text);
        assert!(mapped.common.streaming);
        assert!(!mapped.common.lifecycle_reactions);
        assert!(mapped.common.proactive_opening);
        assert_eq!(mapped.common.proactive_target.as_deref(), Some("c-home"));
        assert_eq!(mapped.common.voice_reply, ChannelVoiceReplyMode::Mirror);
        assert_eq!(mapped.common.access.dm, crate::config::DmPolicy::Open);
        assert_eq!(
            mapped.common.access.group,
            crate::config::GroupPolicy::Disabled
        );
        assert_eq!(mapped.common.access.dm_allowlist, vec!["u1".to_string()]);
        assert_eq!(mapped.common.access.group_allowlist, vec!["g1".to_string()]);
        assert_eq!(
            mapped.common.access.group_sender_allowlist,
            vec!["u2".to_string()]
        );
        assert_eq!(mapped.common.profile.name.as_deref(), Some("Ryu"));
        assert_eq!(mapped.common.profile.short_bio.as_deref(), Some("short"));
        assert_eq!(mapped.common.profile.description.as_deref(), Some("long"));
    }

    /// An unconfigured channel inherits the legacy env gate untouched: that is
    /// what keeps a deployment relying on `RYU_CHANNEL_ALLOWED_USERS` working.
    #[test]
    fn access_policy_falls_back_to_the_legacy_env_gate() {
        let file = CommonChannelFileConfig::default();
        let from_env = policy_from_env("telegram");
        let resolved = to_access_policy("telegram", &file);
        assert_eq!(resolved.dm, from_env.dm);
        assert_eq!(resolved.group, from_env.group);
        assert_eq!(resolved.dm_allowlist, from_env.dm_allowlist);

        // An explicit policy overrides it, and an explicit list replaces it.
        let configured = CommonChannelFileConfig {
            dm_policy: Some(crate::config::DmPolicy::Disabled),
            dm_allowlist: vec!["only-me".to_string()],
            ..CommonChannelFileConfig::default()
        };
        let resolved = to_access_policy("telegram", &configured);
        assert_eq!(resolved.dm, crate::config::DmPolicy::Disabled);
        assert_eq!(resolved.dm_allowlist, vec!["only-me".to_string()]);
    }

    /// BlueBubbles' Private-API-only verbs stay off unless the bot declared the
    /// helper, whatever the generic read-receipt flag says.
    #[test]
    fn bluebubbles_read_receipts_require_the_private_api() {
        let mut secrets = HashMap::new();
        secrets.insert("server_url".to_string(), "http://mac:1234".to_string());
        secrets.insert("password".to_string(), "pw".to_string());
        let raw = json!({
            "channels": [{
                "id": "bb-1",
                "channelType": "bluebubbles",
                "name": "iMessage",
                "secrets": secrets,
                "agentId": null,
                "model": null,
                "systemPrompt": null,
                "sendReadReceipts": true
            }]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(raw).unwrap();
        let cfg = bluebubbles_cfg_from_store(&parsed.channels[0]).expect("secrets are complete");
        assert!(!cfg.private_api, "helper not declared ⇒ stays off");
        assert!(!cfg.send_read_receipts, "and so do the verbs that need it");

        // Declaring the helper turns both on.
        let with_helper = json!({
            "channels": [{
                "id": "bb-2",
                "channelType": "bluebubbles",
                "name": "iMessage",
                "secrets": {
                    "server_url": "http://mac:1234",
                    "password": "pw",
                    "private_api": "true"
                },
                "agentId": null,
                "model": null,
                "systemPrompt": null,
                "sendReadReceipts": true
            }]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(with_helper).unwrap();
        let cfg = bluebubbles_cfg_from_store(&parsed.channels[0]).unwrap();
        assert!(cfg.private_api);
        assert!(cfg.send_read_receipts);
    }

    /// The store never carries the bridge's URL/password in a shape we can
    /// half-use: both or nothing.
    #[test]
    fn bluebubbles_store_config_needs_both_secrets() {
        let raw = json!({
            "channels": [{
                "id": "bb-3",
                "channelType": "bluebubbles",
                "name": "iMessage",
                "secrets": { "server_url": "http://mac:1234" },
                "agentId": null,
                "model": null,
                "systemPrompt": null
            }]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(raw).unwrap();
        assert!(bluebubbles_cfg_from_store(&parsed.channels[0]).is_none());
    }

    /// The pairing store must land under the profile's own data dir, so a dev
    /// gateway never reads or writes the release node's approvals.
    #[test]
    fn pairing_store_path_is_profile_scoped() {
        std::env::remove_var(ENV_PAIRING_PATH);
        if let Some(path) = pairing_store_path() {
            assert!(path.ends_with("channel-pairing.json"));
            let parent = path
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_string_lossy();
            // Under Core (`RYU_DIR` set) it lives in the data dir's `state/`;
            // standalone, in the profile-suffixed OS data dir.
            let expected = if std::env::var_os("RYU_DIR").is_some_and(|dir| !dir.is_empty()) {
                "state".to_owned()
            } else {
                format!("ryu{}", crate::profile::suffix())
            };
            assert_eq!(parent, expected);
        }

        // The override wins outright, for state on a mounted volume.
        std::env::set_var(ENV_PAIRING_PATH, "/tmp/ryu-pairing-test.json");
        assert_eq!(
            pairing_store_path(),
            Some(PathBuf::from("/tmp/ryu-pairing-test.json"))
        );
        std::env::remove_var(ENV_PAIRING_PATH);
    }

    // ─── Managed-bot token rotation ─────────────────────────────────────────
    //
    // The supervisor itself needs a live Telegram and a live manager, so what is
    // tested is every decision it makes: whether a bot CAN be refreshed, how long
    // it waits between tries, and how the manager's answer is classified. A wrong
    // answer to any of those is either a bot that never comes back or a hot loop
    // against Telegram, and a typecheck catches neither.

    #[test]
    fn managed_bot_creds_require_both_keys() {
        let mut secrets = HashMap::new();
        secrets.insert("bot_token".to_string(), "123:ABC".to_string());
        // A hand-pasted token: nothing to refresh, and that is not an error.
        assert!(managed_bot_creds(&secrets).is_none());

        secrets.insert(SECRET_MANAGED_BOT_NONCE.to_string(), "n0nce".to_string());
        assert!(
            managed_bot_creds(&secrets).is_none(),
            "a nonce without the claim secret cannot authorize a refresh"
        );

        secrets.insert(SECRET_MANAGED_BOT_SECRET.to_string(), "s3cret".to_string());
        let creds = managed_bot_creds(&secrets).expect("both keys present");
        assert_eq!(creds.nonce, "n0nce");
        assert_eq!(creds.secret, "s3cret");
    }

    #[test]
    fn managed_bot_creds_treat_blanks_as_absent() {
        // An empty secret would otherwise send an unauthenticated refresh, whose
        // 401 is indistinguishable from a genuinely wrong secret.
        let mut secrets = HashMap::new();
        secrets.insert(SECRET_MANAGED_BOT_NONCE.to_string(), "n0nce".to_string());
        secrets.insert(SECRET_MANAGED_BOT_SECRET.to_string(), "   ".to_string());
        assert!(managed_bot_creds(&secrets).is_none());
    }

    /// The "cannot become a hot loop" guarantee, as an assertion rather than a
    /// reading of the loop: every delay is non-trivial, the sequence never
    /// shrinks, it is capped, and the whole budget still costs the operator only
    /// minutes of downtime.
    #[test]
    fn refresh_backoff_is_monotonic_capped_and_bounded() {
        let mut previous = Duration::ZERO;
        let mut total = Duration::ZERO;
        for attempt in 1..=MAX_TOKEN_REFRESHES {
            let delay = refresh_backoff(attempt);
            assert!(
                delay >= REFRESH_BACKOFF_BASE,
                "attempt {attempt} never busy-waits"
            );
            assert!(delay >= previous, "attempt {attempt} must not go backwards");
            assert!(
                delay <= REFRESH_BACKOFF_MAX,
                "attempt {attempt} respects the cap"
            );
            previous = delay;
            total += delay;
        }
        assert_eq!(refresh_backoff(1), REFRESH_BACKOFF_BASE);
        // A wildly out-of-range attempt must saturate, not overflow the shift.
        assert_eq!(refresh_backoff(u32::MAX), REFRESH_BACKOFF_MAX);
        assert!(
            total >= Duration::from_secs(30) && total <= Duration::from_secs(600),
            "the whole budget spans minutes, not milliseconds or hours: {total:?}"
        );
    }

    #[test]
    fn refresh_response_parses_ready_and_pending() {
        let ready: ManagedBotRefreshResponse =
            serde_json::from_value(json!({ "status": "ready", "token": "123:ABC" })).unwrap();
        assert_eq!(ready.status, "ready");
        assert_eq!(ready.token.as_deref(), Some("123:ABC"));

        // `pending` carries no token — the field must be optional, never unwrapped.
        let pending: ManagedBotRefreshResponse =
            serde_json::from_value(json!({ "status": "pending" })).unwrap();
        assert_eq!(pending.status, "pending");
        assert!(pending.token.is_none());
    }

    #[test]
    fn managed_bot_base_url_defaults_and_trims() {
        std::env::remove_var(ENV_MANAGED_BOT_URL);
        assert_eq!(managed_bot_base_url(), DEFAULT_MANAGED_BOT_URL);

        // A trailing slash would produce `//managed-bot/refresh`.
        std::env::set_var(ENV_MANAGED_BOT_URL, "http://localhost:4000/");
        assert_eq!(managed_bot_base_url(), "http://localhost:4000");

        // A blank override is an operator mistake, not a request for an empty base.
        std::env::set_var(ENV_MANAGED_BOT_URL, "  ");
        assert_eq!(managed_bot_base_url(), DEFAULT_MANAGED_BOT_URL);
        std::env::remove_var(ENV_MANAGED_BOT_URL);
    }

    /// A managed bot's pairing keys ride in the same opaque `secrets` map as the
    /// token, so they must survive the store parse and reach the supervisor.
    #[test]
    fn stored_bot_config_carries_the_managed_bot_pairing() {
        let raw = json!({
            "channels": [{
                "id": "chan-mb",
                "channelType": "telegram",
                "name": "My Helper",
                "secrets": {
                    "bot_token": "123:ABC",
                    "managed_bot_nonce": "n0nce",
                    "managed_bot_secret": "s3cret"
                },
                "agentId": null,
                "model": null,
                "systemPrompt": null
            }]
        });
        let parsed: StoredChannelsResponse = serde_json::from_value(raw).unwrap();
        let bot = &parsed.channels[0];
        // The token still resolves — the extra keys are not mistaken for it.
        let cfg = telegram_cfg_from_store(bot).expect("bot_token present");
        assert_eq!(cfg.token, "123:ABC");
        assert!(managed_bot_creds(&bot.secrets).is_some());
    }
}
