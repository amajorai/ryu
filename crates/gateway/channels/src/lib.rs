//! Channel layer: external messaging surfaces (Telegram, Slack, WhatsApp,
//! Discord) that register once at the gateway. Inbound messages become gateway
//! pipeline requests; outbound responses route back to the originating chat.
//!
//! The abstraction is deliberately minimal so that new channels (U33/U34) only
//! need to implement the [`Channel`] trait. Every channel shares the same
//! inbound path: [`handle_message`] builds a request body, runs it through the
//! gateway pipeline (via the [`ChannelHost`] seam), and hands the reply text
//! back to the channel for delivery.
//!
//! Inbound is gated by a chat allowlist (`RYU_CHANNEL_ALLOWED_USERS[_<PLATFORM>]`)
//! and is CLOSED by default: with no allowlist configured every sender is
//! refused unless the operator explicitly opts into open mode with
//! `RYU_CHANNEL_ALLOW_ALL=1` — anyone who can message the bot would otherwise
//! get completions billed to the operator.

pub mod discord;
pub mod slack;
pub mod status;
pub mod telegram;
pub mod whatsapp;

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::{info, warn};

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

/// Telegram bot adapter configuration.
#[derive(Debug, Clone)]
pub struct TelegramChannelConfig {
    pub token: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub group_reply_mode: GroupReplyMode,
    pub core_url: String,
}

/// Slack bot adapter configuration (Socket Mode).
#[derive(Debug, Clone)]
pub struct SlackChannelConfig {
    pub app_token: String,
    pub bot_token: String,
    pub model: String,
    pub system_prompt: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub group_reply_mode: GroupReplyMode,
    pub core_url: String,
}

/// Discord bot adapter configuration.
#[derive(Debug, Clone)]
pub struct DiscordChannelConfig {
    pub token: String,
    pub channel_ids: Vec<String>,
    pub model: String,
    pub system_prompt: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub group_reply_mode: GroupReplyMode,
    pub core_url: String,
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
    pub model: String,
    pub system_prompt: Option<String>,
    pub agent_id: Option<String>,
    pub team_id: Option<String>,
    pub group_reply_mode: GroupReplyMode,
    pub core_url: String,
}

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
    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()>;
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

/// Per-platform / global allowed-chat list for inbound channel traffic.
///
/// Env: `RYU_CHANNEL_ALLOWED_USERS` (global, all platforms) and
/// `RYU_CHANNEL_ALLOWED_USERS_<PLATFORM>` (e.g. `_TELEGRAM`). Comma-separated
/// chat ids. When BOTH are unset for a platform the channel is CLOSED — every
/// inbound chat is refused unless the operator explicitly opts into open mode
/// with [`ENV_CHANNEL_ALLOW_ALL`]. NOTE: `InboundMessage` carries only
/// `chat_id`, so this gates on the originating chat/conversation, not an
/// individual sender user id.
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

/// Env var opting a deployment into accepting ALL inbound chats when no
/// allowlist is configured. A bot token grants LLM completions billed to the
/// operator, so no-allowlist is CLOSED by default; this is the explicit escape
/// hatch (`1`/`true`/`yes`/`on`, case-insensitive).
const ENV_CHANNEL_ALLOW_ALL: &str = "RYU_CHANNEL_ALLOW_ALL";

/// Pure: does this env value opt into open mode? Only an explicit enable token
/// counts — absent or anything else stays closed. Unit-testable without env.
fn channel_allow_all_from(val: Option<&str>) -> bool {
    matches!(
        val.map(str::trim)
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Runtime wrapper: read [`ENV_CHANNEL_ALLOW_ALL`] and classify.
fn channel_allow_all() -> bool {
    channel_allow_all_from(std::env::var(ENV_CHANNEL_ALLOW_ALL).ok().as_deref())
}

/// Pure decision core for [`channel_chat_allowed`]: with an allowlist the chat
/// must be listed; with none the channel is closed unless `allow_all` opted in.
fn chat_allowed_with(allowlist: Option<&[String]>, allow_all: bool, chat_id: &str) -> bool {
    match allowlist {
        Some(list) => list.iter().any(|allowed| allowed == chat_id),
        None => allow_all,
    }
}

/// Whether a chat is permitted for this platform. Closed when no allowlist is
/// configured, unless [`ENV_CHANNEL_ALLOW_ALL`] explicitly opts into open mode.
fn channel_chat_allowed(platform: &str, chat_id: &str) -> bool {
    chat_allowed_with(
        channel_allowlist(platform).as_deref(),
        channel_allow_all(),
        chat_id,
    )
}

/// Shared inbound path for every channel: turn a message into a gateway request,
/// run the pipeline, and deliver the reply back through the channel.
///
/// This is what makes channel registration reusable: Telegram, Slack, etc. all
/// funnel through here, so only the transport differs per channel.
pub async fn handle_message<C: Channel + ?Sized>(
    channel: &C,
    host: Arc<dyn ChannelHost>,
    message: InboundMessage,
) {
    // Channel allowlist gate: reject inbound from a chat not on the platform's
    // (or global) allowlist. Unset ⇒ CLOSED unless RYU_CHANNEL_ALLOW_ALL opts in.
    if !channel_chat_allowed(channel.name(), &message.chat_id) {
        if channel_allowlist(channel.name()).is_none() {
            warn!(
                channel = channel.name(),
                chat_id = %message.chat_id,
                "channel inbound refused: no allowlist configured — set RYU_CHANNEL_ALLOWED_USERS[_{}] to admit specific chats, or RYU_CHANNEL_ALLOW_ALL=1 to accept all",
                channel.name().to_uppercase()
            );
        } else {
            warn!(
                channel = channel.name(),
                chat_id = %message.chat_id,
                "channel inbound rejected: chat not in allowlist"
            );
        }
        return;
    }

    let body = build_request_body(channel.model(), channel.system_prompt(), &message.text);

    info!(
        channel = channel.name(),
        chat_id = %message.chat_id,
        "channel inbound message received"
    );

    let reply = match host.run_pipeline(channel.name(), body).await {
        Ok(response) => extract_reply(&response).unwrap_or_else(|| "(no response)".to_string()),
        Err(err) => {
            warn!(
                channel = channel.name(),
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

/// Spawn one channel's inbound loop on a dedicated task. A channel that fails to
/// construct or whose loop errors is logged and skipped so it never takes down
/// the gateway or any sibling channel.
pub fn spawn_channel<C: Channel + 'static>(
    host: &Arc<dyn ChannelHost>,
    channel: anyhow::Result<C>,
) {
    match channel {
        Ok(channel) => {
            let channel = Arc::new(channel);
            let name = channel.name();
            if channel_allowlist(name).is_none() {
                if channel_allow_all() {
                    warn!(
                        channel = name,
                        "channel registered with NO allowlist and RYU_CHANNEL_ALLOW_ALL set — all chats accepted"
                    );
                } else {
                    warn!(
                        channel = name,
                        "channel registered with NO allowlist (RYU_CHANNEL_ALLOWED_USERS[_{}] unset) — ALL inbound will be refused; set an allowlist or RYU_CHANNEL_ALLOW_ALL=1",
                        name.to_uppercase()
                    );
                }
            }
            info!(channel = name, "registering channel");
            let host = Arc::clone(host);
            tokio::spawn(async move {
                if let Err(err) = channel.clone().run(host).await {
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

    /// No allowlist and no opt-in ⇒ CLOSED. Pure helpers, no env mutation.
    #[test]
    fn no_allowlist_is_default_closed() {
        assert!(!chat_allowed_with(None, false, "123"));
        // Absent env or a non-enable token never opts in.
        assert!(!channel_allow_all_from(None));
        for v in ["0", "false", "off", "no", ""] {
            assert!(
                !channel_allow_all_from(Some(v)),
                "{v:?} must not open the channel"
            );
        }
    }

    /// Explicit `RYU_CHANNEL_ALLOW_ALL` opt-in reopens a no-allowlist channel.
    #[test]
    fn allow_all_opt_in_opens_channel() {
        assert!(chat_allowed_with(None, true, "123"));
        for v in ["1", "true", "yes", "on", " 1 ", "TRUE"] {
            assert!(
                channel_allow_all_from(Some(v)),
                "{v:?} should opt into open mode"
            );
        }
        // The opt-in never widens a CONFIGURED allowlist.
        let list = vec!["123".to_string()];
        assert!(chat_allowed_with(Some(list.as_slice()), true, "123"));
        assert!(!chat_allowed_with(Some(list.as_slice()), true, "999"));
    }

    /// Channel allowlist behavior. Run as ONE sequential test because it mutates
    /// process-global env (`RYU_CHANNEL_ALLOWED_USERS[_*]`, `RYU_CHANNEL_ALLOW_ALL`);
    /// parallel sub-tests would race. Each phase sets/removes only what it needs
    /// and cleans up.
    #[test]
    fn channel_allowlist_gating() {
        // Clean slate.
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM");
        std::env::remove_var("RYU_CHANNEL_ALLOWED_USERS_SLACK");
        std::env::remove_var("RYU_CHANNEL_ALLOW_ALL");

        // 1. Fully unset ⇒ CLOSED (default), until the explicit opt-in.
        assert!(channel_allowlist("telegram").is_none());
        assert!(!channel_chat_allowed("telegram", "123"));
        std::env::set_var("RYU_CHANNEL_ALLOW_ALL", "1");
        assert!(channel_chat_allowed("telegram", "123"));
        std::env::remove_var("RYU_CHANNEL_ALLOW_ALL");

        // 2. Per-platform set ⇒ listed id allowed, others rejected.
        std::env::set_var("RYU_CHANNEL_ALLOWED_USERS_TELEGRAM", "123, 456");
        assert!(channel_chat_allowed("telegram", "123"));
        assert!(channel_chat_allowed("telegram", "456"));
        assert!(!channel_chat_allowed("telegram", "999"));
        // A different platform with no list of its own stays closed.
        assert!(!channel_chat_allowed("slack", "999"));

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
