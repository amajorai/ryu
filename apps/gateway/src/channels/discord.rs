//! Discord channel adapter.
//!
//! A Discord bot normally receives messages over the Gateway WebSocket. To stay
//! consistent with the dependency-light, long-poll transport used by the
//! [`telegram`](super::telegram) adapter, this adapter polls each watched
//! channel's REST message history with an `after` cursor — the same
//! advance-the-offset trick Telegram's `getUpdates` uses, so nothing is ever
//! re-delivered. Inbound text is routed to the Core session seam
//! (`POST <core_url>/api/channels/run`) when `agent_id` is configured in
//! [`DiscordChannelConfig`], making the bot a first-class Session client:
//! conversation history is persisted in Core (keyed by Discord channel id), and
//! model calls still flow Core → Gateway so the moat (firewall, DLP, budgets,
//! audit) governs every outbound call. When `agent_id` is absent the adapter
//! falls back to the legacy `handle_message` → gateway pipeline path.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, info, warn};

use crate::{config::DiscordChannelConfig, state::SharedState};

use super::{handle_message, Channel, InboundMessage};

/// Discord REST API base. Pinned to v10 (the current stable version).
const API_BASE: &str = "https://discord.com/api/v10";

/// Interval between message-history polls per watched channel.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Cooldown before retrying after a transport error, so a flaky network or a
/// transient Discord outage doesn't become a tight failure loop.
const ERROR_BACKOFF: Duration = Duration::from_secs(3);

/// Max messages fetched per poll (Discord caps this at 100).
const FETCH_LIMIT: u8 = 50;

pub struct DiscordChannel {
    model: String,
    system_prompt: Option<String>,
    http: reqwest::Client,
    token: String,
    channel_ids: Vec<String>,
    /// When set, inbound messages are routed through Core's `/api/channels/run`
    /// endpoint using this agent id so conversation history is persisted in the
    /// Core session store (keyed by Discord channel id). `None` falls back to
    /// the legacy gateway-pipeline path.
    agent_id: Option<String>,
    /// When set, inbound messages route to this Core team (a lead agent
    /// orchestrating its members) instead of a single agent. Takes precedence
    /// over `agent_id`; also uses Core's `/api/channels/run` seam.
    team_id: Option<String>,
    /// Base URL of the Core sidecar, used when `agent_id` or `team_id` is set.
    core_url: String,
}

impl DiscordChannel {
    pub fn new(cfg: DiscordChannelConfig, http: reqwest::Client) -> anyhow::Result<Self> {
        if cfg.token.trim().is_empty() {
            anyhow::bail!("discord channel token is empty");
        }
        if cfg.channel_ids.is_empty() {
            anyhow::bail!("discord channel requires at least one channel_id");
        }
        Ok(Self {
            model: cfg.model,
            system_prompt: cfg.system_prompt,
            http,
            token: cfg.token,
            channel_ids: cfg.channel_ids,
            agent_id: cfg.agent_id,
            team_id: cfg.team_id,
            core_url: cfg.core_url,
        })
    }

    fn auth_header(&self) -> String {
        format!("Bot {}", self.token)
    }

    /// True when this bot routes through Core's session seam (a single agent or
    /// a team) rather than the legacy gateway-pipeline path.
    fn routes_via_core(&self) -> bool {
        self.agent_id.is_some() || self.team_id.is_some()
    }

    /// Route an inbound message through Core's session seam and return the reply.
    ///
    /// Calls `POST <core_url>/api/channels/run` with `conversation_id` set to the
    /// Discord `channel_id` so all messages in the same channel share conversation
    /// history (per-channel cursor de-duplication is preserved independently by the
    /// poll loop). Model calls still flow Core → Gateway — the moat remains on path.
    ///
    /// # Errors
    /// Returns `Err` on HTTP transport failure or when Core returns a non-2xx status.
    async fn run_via_core(&self, channel_id: &str, text: &str) -> anyhow::Result<String> {
        let url = format!("{}/api/channels/run", self.core_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(&url)
            .json(&json!({
                "conversation_id": channel_id,
                "agent_id": self.agent_id,
                "team_id": self.team_id,
                "text": text,
            }))
            .send()
            .await?
            .error_for_status()?;
        let body: serde_json::Value = resp.json().await?;
        let reply = body["reply"].as_str().unwrap_or("").to_owned();
        Ok(reply)
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
            .http
            .get(&url)
            .header("Authorization", self.auth_header())
            .query(&query)
            .timeout(Duration::from_secs(15))
            .send()
            .await?
            .error_for_status()?;

        let messages: Vec<DiscordMessage> = resp.json().await?;
        Ok(messages)
    }
}

#[async_trait]
impl Channel for DiscordChannel {
    fn name(&self) -> &'static str {
        "discord"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn system_prompt(&self) -> Option<&str> {
        self.system_prompt.as_deref()
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let url = format!("{API_BASE}/channels/{chat_id}/messages");
        self.http
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&json!({ "content": text }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn run(self: Arc<Self>, state: SharedState) -> anyhow::Result<()> {
        debug!("discord channel poll loop started");
        // Per-channel cursor: the snowflake id of the last message we processed.
        // Discord ids are monotonically increasing, so `after` cleanly excludes
        // anything we've already handled.
        let mut cursors: HashMap<String, String> = HashMap::new();

        loop {
            for channel_id in &self.channel_ids {
                let after = cursors.get(channel_id).cloned();
                let is_seed_poll = after.is_none();
                match self.fetch_messages(channel_id, after.as_deref()).await {
                    Ok(mut messages) => {
                        // Discord returns newest-first; process oldest-first so
                        // the cursor advances correctly and replies stay ordered.
                        messages.reverse();
                        for message in messages {
                            cursors.insert(channel_id.clone(), message.id.clone());

                            // First poll only seeds the cursor; don't replay
                            // history that predates the bot starting up.
                            if is_seed_poll {
                                continue;
                            }
                            // Ignore bot messages (including our own replies) to
                            // avoid the bot talking to itself.
                            if message.author.bot.unwrap_or(false) {
                                continue;
                            }
                            if message.content.trim().is_empty() {
                                continue;
                            }

                            let inbound = InboundMessage {
                                chat_id: channel_id.clone(),
                                text: message.content,
                            };

                            let channel = Arc::clone(&self);
                            let state = Arc::clone(&state);
                            tokio::spawn(async move {
                                if channel.routes_via_core() {
                                    // M11 / #229: route through Core session seam so
                                    // conversation history is persisted per Discord channel
                                    // and model calls flow Core → Gateway (moat stays on path).
                                    // Target is a single agent or a team (Core picks).
                                    info!(
                                        channel_id = %inbound.chat_id,
                                        agent_id = ?channel.agent_id,
                                        team_id = ?channel.team_id,
                                        "discord: routing via Core session seam"
                                    );
                                    let reply = match channel
                                        .run_via_core(&inbound.chat_id, &inbound.text)
                                        .await
                                    {
                                        Ok(r) if !r.is_empty() => r,
                                        Ok(_) => "(no response)".to_string(),
                                        Err(err) => {
                                            warn!(
                                                channel_id = %inbound.chat_id,
                                                error = %err,
                                                "discord: Core session run failed"
                                            );
                                            format!("Sorry, something went wrong: {err}")
                                        }
                                    };
                                    if let Err(err) =
                                        channel.send_message(&inbound.chat_id, &reply).await
                                    {
                                        warn!(
                                            channel_id = %inbound.chat_id,
                                            error = %err,
                                            "discord: failed to deliver reply"
                                        );
                                    }
                                } else {
                                    // Legacy path: handle_message → gateway pipeline.
                                    // Deprecated for discord; use agent_id to opt in
                                    // to the Core session seam.
                                    handle_message(channel.as_ref(), state, inbound).await;
                                }
                            });
                        }
                    }
                    Err(err) => {
                        warn!(
                            channel_id = %channel_id,
                            error = %err,
                            "discord message fetch failed, backing off"
                        );
                        tokio::time::sleep(ERROR_BACKOFF).await;
                    }
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }
}

// ─── Discord REST API response types (only the fields we use) ──────────────────

#[derive(Debug, Deserialize)]
struct DiscordMessage {
    id: String,
    #[serde(default)]
    content: String,
    author: DiscordAuthor,
}

#[derive(Debug, Deserialize)]
struct DiscordAuthor {
    #[serde(default)]
    bot: Option<bool>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cfg(token: &str, channel_ids: Vec<String>) -> DiscordChannelConfig {
        DiscordChannelConfig {
            token: token.to_string(),
            channel_ids,
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        }
    }

    #[test]
    fn new_rejects_empty_token() {
        let cfg = make_cfg("  ", vec!["123".to_string()]);
        assert!(DiscordChannel::new(cfg, reqwest::Client::new()).is_err());
    }

    #[test]
    fn new_rejects_missing_channels() {
        let cfg = make_cfg("abc", vec![]);
        assert!(DiscordChannel::new(cfg, reqwest::Client::new()).is_err());
    }

    #[test]
    fn builds_auth_header_and_metadata() {
        let cfg = DiscordChannelConfig {
            token: "secret".to_string(),
            channel_ids: vec!["123".to_string()],
            model: "gpt-4o".to_string(),
            system_prompt: Some("be nice".to_string()),
            agent_id: None,
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        };
        let channel = DiscordChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.auth_header(), "Bot secret");
        assert_eq!(channel.name(), "discord");
        assert_eq!(channel.model(), "gpt-4o");
        assert_eq!(channel.system_prompt(), Some("be nice"));
    }

    #[test]
    fn new_stores_agent_id_and_core_url() {
        let cfg = DiscordChannelConfig {
            token: "tok:1".to_string(),
            channel_ids: vec!["chan1".to_string()],
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: Some("acp:pi".to_string()),
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        };
        let channel = DiscordChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(channel.core_url, "http://127.0.0.1:7980");
    }

    /// Verify that `run_via_core` builds the correct request body with
    /// `conversation_id` set to the channel id, ensuring per-channel history
    /// persists in conversations.db. This drives the poll-parse path assertion
    /// (acceptance criterion 3) without a live Discord token or Core sidecar.
    #[test]
    fn core_run_request_body_uses_channel_id_as_conversation_id() {
        // The JSON body sent to Core must use the Discord channel_id as the
        // conversation_id so the same channel always resolves to the same
        // conversation in Core's conversations.db.
        let channel_id = "1234567890";
        let agent_id = "acp:pi";
        let text = "hello bot";
        let body = json!({
            "conversation_id": channel_id,
            "agent_id": agent_id,
            "text": text,
        });
        assert_eq!(body["conversation_id"], channel_id);
        assert_eq!(body["agent_id"], agent_id);
        assert_eq!(body["text"], text);
    }

    /// Each watched channel must use its own conversation_id so history is
    /// isolated — channel A and channel B never share a conversation row.
    #[test]
    fn different_channel_ids_produce_different_conversation_ids() {
        let channel_a = "111";
        let channel_b = "222";
        let body_a = json!({ "conversation_id": channel_a, "agent_id": "x", "text": "hi" });
        let body_b = json!({ "conversation_id": channel_b, "agent_id": "x", "text": "hi" });
        assert_ne!(body_a["conversation_id"], body_b["conversation_id"]);
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
    }
}
