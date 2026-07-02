//! Channel layer: external messaging surfaces (Telegram, Slack, WhatsApp,
//! Discord) that register once at the gateway. Inbound messages become gateway
//! pipeline requests; outbound responses route back to the originating chat.
//!
//! The abstraction is deliberately minimal so that new channels (U33/U34) only
//! need to implement the [`Channel`] trait. Every channel shares the same
//! inbound path: [`handle_message`] builds a request body, runs it through the
//! gateway [`pipeline`](crate::pipeline), and hands the reply text back to the
//! channel for delivery.

pub mod discord;
pub mod slack;
pub mod status;
pub mod telegram;
pub mod whatsapp;

use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use tracing::{info, warn};
use uuid::Uuid;

use crate::{
    config::{
        DiscordChannelConfig, SlackChannelConfig, TelegramChannelConfig, WhatsAppChannelConfig,
    },
    pipeline::{self, RequestContext},
    state::SharedState,
};

/// Default model used for store-sourced bot configs that don't specify one.
const DEFAULT_BOT_MODEL: &str = "gpt-4o";

/// An inbound message received from a channel, normalised across providers.
#[derive(Debug, Clone)]
pub struct InboundMessage {
    /// Opaque identifier of the conversation to reply to (e.g. Telegram chat id).
    pub chat_id: String,
    /// The user's message text.
    pub text: String,
}

/// A registered channel: a messaging surface the gateway can receive from and
/// reply to. Implementors own their transport (long-poll loop, webhook, etc.)
/// and only need to deliver outbound text via [`Channel::send_message`].
#[async_trait]
pub trait Channel: Send + Sync {
    /// Stable identifier for this channel, e.g. `"telegram"`.
    fn name(&self) -> &'static str;

    /// Model the inbound messages should be routed to.
    fn model(&self) -> &str;

    /// Optional system prompt prepended to every conversation.
    fn system_prompt(&self) -> Option<&str> {
        None
    }

    /// Deliver an outbound reply back to the originating chat.
    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()>;

    /// Run the channel's inbound loop until the process exits. Each inbound
    /// message should be passed to [`handle_message`].
    async fn run(self: Arc<Self>, state: SharedState) -> anyhow::Result<()>;
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
    }
}

/// Per-platform / global allowed-chat list for inbound channel traffic.
///
/// Env: `RYU_CHANNEL_ALLOWED_USERS` (global, all platforms) and
/// `RYU_CHANNEL_ALLOWED_USERS_<PLATFORM>` (e.g. `_TELEGRAM`). Comma-separated
/// chat ids. When BOTH are unset for a platform the channel is OPEN (current
/// behavior preserved) — the open warning is emitted once at spawn time, not
/// per-message. NOTE: `InboundMessage` carries only `chat_id`, so this gates on
/// the originating chat/conversation, not an individual sender user id.
fn channel_allowlist(platform: &str) -> Option<Vec<String>> {
    let per_platform_key = format!("RYU_CHANNEL_ALLOWED_USERS_{}", platform.to_ascii_uppercase());
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

/// Whether a chat is permitted for this platform. Open (true) when unset.
fn channel_chat_allowed(platform: &str, chat_id: &str) -> bool {
    match channel_allowlist(platform) {
        Some(list) => list.iter().any(|allowed| allowed == chat_id),
        None => true,
    }
}

/// Shared inbound path for every channel: turn a message into a gateway request,
/// run the pipeline, and deliver the reply back through the channel.
///
/// This is what makes channel registration reusable: Telegram, Slack, etc. all
/// funnel through here, so only the transport differs per channel.
pub async fn handle_message<C: Channel + ?Sized>(
    channel: &C,
    state: SharedState,
    message: InboundMessage,
) {
    // Channel allowlist gate: reject inbound from a chat not on the platform's
    // (or global) allowlist. Unset ⇒ open (warned once at spawn, not here).
    if !channel_chat_allowed(channel.name(), &message.chat_id) {
        warn!(
            channel = channel.name(),
            chat_id = %message.chat_id,
            "channel inbound rejected: chat not in allowlist"
        );
        return;
    }

    let body = build_request_body(channel.model(), channel.system_prompt(), &message.text);
    let ctx = channel_context(channel.name());
    let request_id = ctx.request_id.clone();

    info!(
        channel = channel.name(),
        chat_id = %message.chat_id,
        request_id = %request_id,
        "channel inbound message received"
    );

    let reply = match pipeline::run(state, ctx, body).await {
        Ok(output) => {
            extract_reply(&output.response).unwrap_or_else(|| "(no response)".to_string())
        }
        Err(err) => {
            warn!(
                channel = channel.name(),
                request_id = %request_id,
                error = %err,
                "channel pipeline run failed"
            );
            format!("Sorry, something went wrong: {err}")
        }
    };

    if let Err(err) = channel.send_message(&message.chat_id, &reply).await {
        warn!(
            channel = channel.name(),
            chat_id = %message.chat_id,
            error = %err,
            "failed to deliver channel reply"
        );
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
        core_url: "http://127.0.0.1:7980".to_string(),
    })
}

/// Spawn every channel configured in [`GatewayConfig`](crate::config::GatewayConfig)
/// **or** stored as an enabled bot config in the control-plane store.
///
/// Called once at startup. For each channel type, the store takes precedence
/// when configs are found there; the static `config.channels` env path is
/// used as a fallback when the store is unavailable or returns no records for
/// that type. A channel that fails to start is logged and skipped.
pub async fn spawn_registered(state: SharedState) {
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
        let reporter = status::StatusReporter::new(
            state.http.clone(),
            &state.config.control_plane,
            Some(bot.id.clone()),
        );
        match bot.channel_type.as_str() {
            "telegram" => {
                if let Some(cfg) = telegram_cfg_from_store(bot) {
                    info!(name = %bot.name, "registering telegram bot from store");
                    spawn_channel(
                        &state,
                        telegram::TelegramChannel::new_with_status(
                            cfg,
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
                        &state,
                        slack::SlackChannel::new_with_status(
                            cfg,
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
                        &state,
                        discord::DiscordChannel::new_with_status(
                            cfg,
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
                        &state,
                        whatsapp::WhatsAppChannel::new_with_status(
                            cfg,
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
                &state,
                telegram::TelegramChannel::new(cfg, state.http.clone()),
            );
        }
    }
    if !store_slack {
        if let Some(cfg) = state.config.channels.slack.clone() {
            spawn_channel(&state, slack::SlackChannel::new(cfg, state.http.clone()));
        }
    }
    if !store_discord {
        if let Some(cfg) = state.config.channels.discord.clone() {
            spawn_channel(
                &state,
                discord::DiscordChannel::new(cfg, state.http.clone()),
            );
        }
    }
    if !store_whatsapp {
        if let Some(cfg) = state.config.channels.whatsapp.clone() {
            spawn_channel(
                &state,
                whatsapp::WhatsAppChannel::new(cfg, state.http.clone()),
            );
        }
    }
}

/// Spawn one channel's inbound loop on a dedicated task. A channel that fails to
/// construct or whose loop errors is logged and skipped so it never takes down
/// the gateway or any sibling channel.
fn spawn_channel<C: Channel + 'static>(state: &SharedState, channel: anyhow::Result<C>) {
    match channel {
        Ok(channel) => {
            let channel = Arc::new(channel);
            let name = channel.name();
            if channel_allowlist(name).is_none() {
                warn!(
                    channel = name,
                    "channel registered with NO allowlist (RYU_CHANNEL_ALLOWED_USERS[_{}] unset) — all chats accepted",
                    name.to_uppercase()
                );
            }
            info!(channel = name, "registering channel");
            let state = Arc::clone(state);
            tokio::spawn(async move {
                if let Err(err) = channel.clone().run(state).await {
                    warn!(channel = name, error = %err, "channel loop exited with error");
                }
            });
        }
        Err(err) => {
            warn!(error = %err, "failed to register channel");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    /// Channel allowlist behavior. Run as ONE sequential test because it mutates
    /// process-global env (`RYU_CHANNEL_ALLOWED_USERS[_*]`); parallel sub-tests
    /// would race. Each phase sets/removes only what it needs and cleans up.
    #[test]
    fn channel_allowlist_gating() {
        // Clean slate.
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_SLACK");

        // 1. Fully unset ⇒ open (current behavior preserved).
        assert!(channel_allowlist("telegram").is_none());
        assert!(channel_chat_allowed("telegram", "123"));

        // 2. Per-platform set ⇒ listed id allowed, others rejected.
        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123, 456");
        assert!(channel_chat_allowed("telegram", "123"));
        assert!(channel_chat_allowed("telegram", "456"));
        assert!(!channel_chat_allowed("telegram", "999"));
        // A different platform with no list of its own stays open.
        assert!(channel_chat_allowed("slack", "999"));

        // 3. Global applies when per-platform is unset.
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS", "777");
        assert!(channel_chat_allowed("telegram", "777"));
        assert!(!channel_chat_allowed("telegram", "123"));

        // 4. Per-platform OVERRIDES global (global ignored when per-platform set).
        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123");
        assert!(channel_chat_allowed("telegram", "123"));
        assert!(
            !channel_chat_allowed("telegram", "777"),
            "global should be ignored once per-platform is present"
        );

        // Cleanup.
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
    }
}
