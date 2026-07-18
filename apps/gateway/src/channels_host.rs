//! Gateway-side channel wiring: the [`ChannelHost`] implementation (the
//! `pipeline::run` call + [`RequestContext`] construction) plus channel
//! registration — control-plane store fetch, env fallback, and spawn.
//!
//! The transport adapters (Telegram/Slack/Discord/WhatsApp) and the shared
//! inbound path live in the [`ryu_gw_channels`] crate. This module is the
//! "wiring stays" half of that extraction: it holds everything that touches
//! [`SharedState`], the pipeline, or the gateway config shell, and hands the
//! crate a narrow [`ChannelHost`] seam plus fully-built adapters.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::Value;
use tracing::{info, warn};
use uuid::Uuid;

use ryu_gw_channels::{
    discord::DiscordChannel, slack::SlackChannel, spawn_channel, status::StatusReporter,
    telegram::TelegramChannel, whatsapp::WhatsAppChannel, ChannelHost,
};

use crate::{
    config::{
        DiscordChannelConfig, SlackChannelConfig, TelegramChannelConfig, WhatsAppChannelConfig,
    },
    pipeline::{self, RequestContext},
    state::SharedState,
};

/// Default model used for store-sourced bot configs that don't specify one.
const DEFAULT_BOT_MODEL: &str = "gpt-4o";

// ─── Gateway config → crate transport-config mapping ────────────────────────
//
// The config-FILE shapes live in `config.rs` (serde + profile-aware `core_url`
// defaults, kernel §5). The transport adapters take the crate's plain config
// mirrors; these move the fields across at the spawn boundary. `group_reply_mode`
// is the shared `GroupReplyMode` (re-exported by `config.rs`), so it moves as-is.

fn to_channel_telegram(c: TelegramChannelConfig) -> ryu_gw_channels::TelegramChannelConfig {
    ryu_gw_channels::TelegramChannelConfig {
        token: c.token,
        model: c.model,
        system_prompt: c.system_prompt,
        agent_id: c.agent_id,
        team_id: c.team_id,
        group_reply_mode: c.group_reply_mode,
        core_url: c.core_url,
    }
}

fn to_channel_slack(c: SlackChannelConfig) -> ryu_gw_channels::SlackChannelConfig {
    ryu_gw_channels::SlackChannelConfig {
        app_token: c.app_token,
        bot_token: c.bot_token,
        model: c.model,
        system_prompt: c.system_prompt,
        agent_id: c.agent_id,
        team_id: c.team_id,
        group_reply_mode: c.group_reply_mode,
        core_url: c.core_url,
    }
}

fn to_channel_discord(c: DiscordChannelConfig) -> ryu_gw_channels::DiscordChannelConfig {
    ryu_gw_channels::DiscordChannelConfig {
        token: c.token,
        channel_ids: c.channel_ids,
        model: c.model,
        system_prompt: c.system_prompt,
        agent_id: c.agent_id,
        team_id: c.team_id,
        group_reply_mode: c.group_reply_mode,
        core_url: c.core_url,
    }
}

fn to_channel_whatsapp(c: WhatsAppChannelConfig) -> ryu_gw_channels::WhatsAppChannelConfig {
    ryu_gw_channels::WhatsAppChannelConfig {
        access_token: c.access_token,
        phone_number_id: c.phone_number_id,
        verify_token: c.verify_token,
        app_secret: c.app_secret,
        webhook_bind: c.webhook_bind,
        webhook_path: c.webhook_path,
        graph_version: c.graph_version,
        model: c.model,
        system_prompt: c.system_prompt,
        agent_id: c.agent_id,
        team_id: c.team_id,
        group_reply_mode: c.group_reply_mode,
        core_url: c.core_url,
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
        request_id: Uuid::new_v4().to_string(),
        api_key: format!("channel:{channel_name}"),
        is_master_key: false,
        org_id: None,
        team_id: None,
        project_id: None,
        user_name: Some(format!("{channel_name}-bot")),
        user_id: None,
        agent_id: None,
        key_config: None,
        skill_ids: None,
        // Channel messages don't carry per-agent tool grants.
        tool_actions: None,
        tools_header_present: false,
        // Channel messages don't carry per-agent slot selections; modality
        // routing falls back to the static modality_map for bot traffic.
        slot_provider: None,
        slot_model: None,
        // Channel messages don't have a session/conversation id.
        session_id: None,
        // Channel messages aren't tagged with a control-plane product surface.
        feature: None,
        // Channel messages are not companion-sourced.
        companion_source: false,
        // Channel messages do not opt into the unified tool loop.
        tool_search_requested: false,
        // Bot traffic is interactive (a user is waiting on the other end).
        priority: crate::concurrency::Priority::Interactive,
        // Channel messages don't select a named tool-policy profile.
        tool_profile: None,
        // Bots use the managed tool loops, not SDK raw passthrough.
        raw_tools: false,
        // Channel/bot traffic is not a dynamically-resolved managed tenant.
        managed_inference: false,
        remaining_budget_micro_usd: None,
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
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredBotConfig {
    /// The channel config's control-plane id, used to report liveness back.
    id: String,
    channel_type: String,
    name: String,
    secrets: HashMap<String, String>,
    agent_id: Option<String>,
    #[serde(default)]
    team_id: Option<String>,
    model: Option<String>,
    system_prompt: Option<String>,
    /// When the bot replies in a group chat (mentions-only vs all). Absent on
    /// older control planes → serde default (mentions).
    #[serde(default)]
    group_reply_mode: ryu_gw_channels::GroupReplyMode,
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
    let core_url = "http://127.0.0.1:7980".to_string();
    Some(TelegramChannelConfig {
        token,
        model: bot
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_BOT_MODEL.to_string()),
        system_prompt: bot.system_prompt.clone(),
        agent_id: bot.agent_id.clone(),
        team_id: bot.team_id.clone(),
        group_reply_mode: bot.group_reply_mode,
        core_url,
    })
}

/// Build a [`SlackChannelConfig`] from a store bot config.
fn slack_cfg_from_store(bot: &StoredBotConfig) -> Option<SlackChannelConfig> {
    let app_token = bot.secrets.get("app_token")?.to_string();
    let bot_token = bot.secrets.get("bot_token")?.to_string();
    let core_url = "http://127.0.0.1:7980".to_string();
    Some(SlackChannelConfig {
        app_token,
        bot_token,
        model: bot
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_BOT_MODEL.to_string()),
        system_prompt: bot.system_prompt.clone(),
        agent_id: bot.agent_id.clone(),
        team_id: bot.team_id.clone(),
        group_reply_mode: bot.group_reply_mode,
        core_url,
    })
}

/// Build a [`DiscordChannelConfig`] from a store bot config.
fn discord_cfg_from_store(bot: &StoredBotConfig) -> Option<DiscordChannelConfig> {
    let token = bot.secrets.get("bot_token")?.to_string();
    let channel_ids = bot
        .secrets
        .get("channel_ids")
        .map(|s| s.split(',').map(str::trim).map(str::to_string).collect())
        .unwrap_or_default();
    let core_url = "http://127.0.0.1:7980".to_string();
    Some(DiscordChannelConfig {
        token,
        channel_ids,
        model: bot
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_BOT_MODEL.to_string()),
        system_prompt: bot.system_prompt.clone(),
        agent_id: bot.agent_id.clone(),
        team_id: bot.team_id.clone(),
        group_reply_mode: bot.group_reply_mode,
        core_url,
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
        webhook_bind: "0.0.0.0:8443".to_string(),
        webhook_path: "/webhooks/whatsapp".to_string(),
        graph_version: "v21.0".to_string(),
        model: bot
            .model
            .clone()
            .unwrap_or_else(|| DEFAULT_BOT_MODEL.to_string()),
        system_prompt: bot.system_prompt.clone(),
        agent_id: bot.agent_id.clone(),
        team_id: bot.team_id.clone(),
        group_reply_mode: bot.group_reply_mode,
        core_url: "http://127.0.0.1:7980".to_string(),
    })
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

    for bot in &store_configs {
        // A store-sourced bot has a control-plane id, so it can report its live
        // connection status back for the sidebar dot. Built once per bot and
        // cloned into whichever channel adapter handles it.
        let reporter = store_reporter(&state, &bot.id);
        match bot.channel_type.as_str() {
            "telegram" => {
                if let Some(cfg) = telegram_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering telegram bot from store");
                    spawn_channel(
                        &host,
                        TelegramChannel::new_with_status(
                            to_channel_telegram(cfg),
                            state.http.clone(),
                            reporter,
                        ),
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
                            reporter,
                        ),
                    );
                    store_whatsapp = true;
                } else {
                    warn!(name = %bot.name, "whatsapp store config missing required secrets; skipping");
                }
            }
            other => {
                warn!(channel_type = %other, name = %bot.name, "unknown channel type in store; skipping");
            }
        }
    }

    // Env fallback: only register the env-config'd channel when the store
    // did not already supply at least one config of that type.
    if !store_telegram {
        if let Some(cfg) = state.config.channels.telegram.clone() {
            spawn_channel(
                &host,
                TelegramChannel::new(to_channel_telegram(cfg), state.http.clone()),
            );
        }
    }
    if !store_slack {
        if let Some(cfg) = state.config.channels.slack.clone() {
            spawn_channel(
                &host,
                SlackChannel::new(to_channel_slack(cfg), state.http.clone()),
            );
        }
    }
    if !store_discord {
        if let Some(cfg) = state.config.channels.discord.clone() {
            spawn_channel(
                &host,
                DiscordChannel::new(to_channel_discord(cfg), state.http.clone()),
            );
        }
    }
    if !store_whatsapp {
        if let Some(cfg) = state.config.channels.whatsapp.clone() {
            spawn_channel(
                &host,
                WhatsAppChannel::new(to_channel_whatsapp(cfg), state.http.clone()),
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
}
