//! Slack channel adapter (Socket Mode).
//!
//! Registers a Slack app via its app-level token and opens a Socket Mode
//! WebSocket through `apps.connections.open` — no public webhook URL required,
//! mirroring the Telegram adapter's long-poll design.
//!
//! Inbound message events are routed through the Core session seam
//! (`POST <core_url>/api/channels/run`) when `agent_id` is configured in
//! [`SlackChannelConfig`], making the bot a first-class Session client:
//! conversation history is persisted in Core (stable per Slack channel+thread),
//! and model calls still flow Core → Gateway so the moat (firewall, DLP,
//! budgets, audit) governs every outbound call. When `agent_id` is absent the
//! adapter falls back to the legacy `handle_message` → gateway pipeline path.
//!
//! The [`Channel`] trait carries a single opaque `chat_id`, so we pack the Slack
//! channel id and the thread timestamp into it as `"<channel>:<thread_ts>"`. This
//! keeps the shared inbound path in [`super`] unchanged while still letting
//! replies land in the right channel and thread.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{debug, info, warn};

use crate::{config::SlackChannelConfig, state::SharedState};

use super::{
    handle_message,
    status::{StatusReporter, HEARTBEAT_INTERVAL},
    Channel, InboundMessage,
};

/// Slack Web API base. Socket Mode is opened from here; replies post here too.
const SLACK_API_BASE: &str = "https://slack.com/api";

/// Cooldown before re-opening the Socket Mode connection after it drops or an
/// open attempt fails, so a transient Slack outage doesn't become a tight loop.
const RECONNECT_BACKOFF: Duration = Duration::from_secs(3);

pub struct SlackChannel {
    model: String,
    system_prompt: Option<String>,
    http: reqwest::Client,
    app_token: String,
    bot_token: String,
    /// When set, inbound messages are routed through Core's `/api/channels/run`
    /// endpoint using this agent id so conversation history is persisted in the
    /// Core session store. `None` falls back to the legacy gateway-pipeline path.
    agent_id: Option<String>,
    /// When set, inbound messages route to this Core team (a lead agent
    /// orchestrating its members) instead of a single agent. Takes precedence
    /// over `agent_id`; also uses Core's `/api/channels/run` seam.
    team_id: Option<String>,
    /// Base URL of the Core sidecar, used when `agent_id` or `team_id` is set.
    core_url: String,
    /// Reports this bot's live connection status to the control plane. `None`
    /// for env-configured bots (no store id), which then show as `unknown`.
    status: Option<StatusReporter>,
}

impl SlackChannel {
    pub fn new(cfg: SlackChannelConfig, http: reqwest::Client) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats
    /// its connection status back to the control plane.
    pub fn new_with_status(
        cfg: SlackChannelConfig,
        http: reqwest::Client,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        if cfg.app_token.trim().is_empty() {
            anyhow::bail!("slack channel app_token is empty");
        }
        if cfg.bot_token.trim().is_empty() {
            anyhow::bail!("slack channel bot_token is empty");
        }
        Ok(Self {
            model: cfg.model,
            system_prompt: cfg.system_prompt,
            http,
            app_token: cfg.app_token,
            bot_token: cfg.bot_token,
            agent_id: cfg.agent_id,
            team_id: cfg.team_id,
            core_url: cfg.core_url,
            status,
        })
    }

    /// True when this bot routes through Core's session seam (a single agent or
    /// a team) rather than the legacy gateway-pipeline path.
    fn routes_via_core(&self) -> bool {
        self.agent_id.is_some() || self.team_id.is_some()
    }

    /// Route an inbound message through Core's session seam and return the reply.
    ///
    /// Calls `POST <core_url>/api/channels/run` with the `conversation_id` set to
    /// the packed Slack `chat_id` (`"<channel>:<thread_ts>"`) so multi-turn
    /// exchanges in the same channel/thread share conversation history.
    /// Model calls still flow Core → Gateway — the moat remains on path.
    ///
    /// # Errors
    /// Returns `Err` on HTTP transport failure or when Core returns a non-2xx status.
    async fn run_via_core(&self, chat_id: &str, text: &str) -> anyhow::Result<String> {
        let url = format!("{}/api/channels/run", self.core_url.trim_end_matches('/'));
        let resp = self
            .http
            .post(&url)
            .json(&json!({
                "conversation_id": chat_id,
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

    /// Open a Socket Mode connection and return the single-use WebSocket URL.
    async fn open_connection(&self) -> anyhow::Result<String> {
        let url = format!("{SLACK_API_BASE}/apps.connections.open");
        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.app_token)
            .send()
            .await?
            .error_for_status()?;

        let body: ConnectionsOpenResponse = resp.json().await?;
        if !body.ok {
            anyhow::bail!(
                "slack apps.connections.open returned ok=false: {}",
                body.error.unwrap_or_default()
            );
        }
        body.url
            .ok_or_else(|| anyhow::anyhow!("slack apps.connections.open returned no url"))
    }
}

#[async_trait]
impl Channel for SlackChannel {
    fn name(&self) -> &'static str {
        "slack"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn system_prompt(&self) -> Option<&str> {
        self.system_prompt.as_deref()
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let (channel, thread_ts) = split_chat_id(chat_id);
        let url = format!("{SLACK_API_BASE}/chat.postMessage");

        let mut payload = json!({
            "channel": channel,
            "text": text,
        });
        // Reply in-thread so multi-turn conversations stay grouped.
        if let Some(ts) = thread_ts {
            payload["thread_ts"] = json!(ts);
        }

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.bot_token)
            .json(&payload)
            .send()
            .await?
            .error_for_status()?;

        let body: PostMessageResponse = resp.json().await?;
        if !body.ok {
            anyhow::bail!(
                "slack chat.postMessage returned ok=false: {}",
                body.error.unwrap_or_default()
            );
        }
        Ok(())
    }

    async fn run(self: Arc<Self>, state: SharedState) -> anyhow::Result<()> {
        debug!("slack channel socket-mode loop started");
        if let Some(reporter) = &self.status {
            reporter.connecting().await;
        }

        loop {
            let ws_url = match self.open_connection().await {
                Ok(url) => url,
                Err(err) => {
                    warn!(error = %err, "slack apps.connections.open failed, backing off");
                    if let Some(reporter) = &self.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(RECONNECT_BACKOFF).await;
                    continue;
                }
            };

            match tokio_tungstenite::connect_async(&ws_url).await {
                Ok((mut ws, _)) => {
                    debug!("slack socket-mode websocket connected");
                    // The socket is open — the bot is live. Re-asserted below on
                    // each idle timeout so a quiet channel stays fresh.
                    if let Some(reporter) = &self.status {
                        reporter.online().await;
                    }
                    // Read frames, but wake every HEARTBEAT_INTERVAL even when idle
                    // to re-report `online` (the connection is still healthy).
                    loop {
                        let next =
                            tokio::time::timeout(HEARTBEAT_INTERVAL, ws.next()).await;
                        let frame = match next {
                            Ok(Some(frame)) => frame,
                            Ok(None) => break,
                            Err(_) => {
                                if let Some(reporter) = &self.status {
                                    reporter.online().await;
                                }
                                continue;
                            }
                        };
                        let payload = match frame {
                            Ok(WsMessage::Text(text)) => text,
                            Ok(WsMessage::Ping(data)) => {
                                let _ = ws.send(WsMessage::Pong(data)).await;
                                continue;
                            }
                            Ok(WsMessage::Close(_)) => break,
                            Ok(_) => continue,
                            Err(err) => {
                                warn!(error = %err, "slack websocket read error");
                                break;
                            }
                        };

                        // Slack requires an ack envelope echoing the envelope_id
                        // for every events_api / interactive payload it sends.
                        if let Some(envelope_id) = parse_envelope_id(&payload) {
                            let ack = json!({ "envelope_id": envelope_id }).to_string();
                            let _ = ws.send(WsMessage::Text(ack)).await;
                        }

                        let Some(inbound) = parse_inbound(&payload) else {
                            continue;
                        };

                        // Handle each message on its own task so a slow agent
                        // call does not stall the socket read loop.
                        let channel = Arc::clone(&self);
                        let state = Arc::clone(&state);
                        tokio::spawn(async move {
                            if channel.routes_via_core() {
                                // M11 / #227: route through Core session seam so
                                // conversation history is persisted and model calls
                                // flow Core → Gateway (moat stays on path).
                                // conversation_id is the packed chat_id so history
                                // is stable per Slack channel/thread. Target is a
                                // single agent or a team (Core picks).
                                info!(
                                    chat_id = %inbound.chat_id,
                                    agent_id = ?channel.agent_id,
                                    team_id = ?channel.team_id,
                                    "slack: routing via Core session seam"
                                );
                                let reply = match channel
                                    .run_via_core(&inbound.chat_id, &inbound.text)
                                    .await
                                {
                                    Ok(r) if !r.is_empty() => r,
                                    Ok(_) => "(no response)".to_string(),
                                    Err(err) => {
                                        warn!(
                                            chat_id = %inbound.chat_id,
                                            error = %err,
                                            "slack: Core session run failed"
                                        );
                                        format!("Sorry, something went wrong: {err}")
                                    }
                                };
                                if let Err(err) =
                                    channel.send_message(&inbound.chat_id, &reply).await
                                {
                                    warn!(
                                        chat_id = %inbound.chat_id,
                                        error = %err,
                                        "slack: failed to deliver reply"
                                    );
                                }
                            } else {
                                // Legacy path: handle_message → gateway pipeline.
                                // Deprecated for slack; set agent_id to opt in
                                // to the Core session seam.
                                handle_message(channel.as_ref(), state, inbound).await;
                            }
                        });
                    }
                    debug!("slack socket-mode websocket closed, reconnecting");
                }
                Err(err) => {
                    warn!(error = %err, "slack websocket connect failed, backing off");
                    if let Some(reporter) = &self.status {
                        reporter.error(&err.to_string()).await;
                    }
                }
            }

            tokio::time::sleep(RECONNECT_BACKOFF).await;
        }
    }
}

// ─── Chat-id packing ───────────────────────────────────────────────────────────

/// Pack a Slack channel id and thread timestamp into the trait's opaque chat id.
fn make_chat_id(channel: &str, thread_ts: &str) -> String {
    format!("{channel}:{thread_ts}")
}

/// Split a packed chat id back into `(channel, Some(thread_ts))`. If no `:` is
/// present the whole value is treated as the channel with no thread.
fn split_chat_id(chat_id: &str) -> (&str, Option<&str>) {
    match chat_id.split_once(':') {
        Some((channel, thread_ts)) if !thread_ts.is_empty() => (channel, Some(thread_ts)),
        _ => (chat_id, None),
    }
}

// ─── Envelope / event parsing ──────────────────────────────────────────────────

/// Extract the Socket Mode `envelope_id` that must be acked.
fn parse_envelope_id(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value["envelope_id"].as_str().map(|s| s.to_string())
}

/// Parse a Socket Mode frame into an [`InboundMessage`], or `None` if it is not
/// a user-authored message event we should respond to.
///
/// We skip non-`events_api` frames (hello/disconnect), non-`message` events, and
/// any message that carries a `bot_id` or `subtype` (edits, joins, our own
/// replies) to avoid loops and noise.
fn parse_inbound(raw: &str) -> Option<InboundMessage> {
    let value: Value = serde_json::from_str(raw).ok()?;

    if value["type"].as_str() != Some("events_api") {
        return None;
    }

    let event = &value["payload"]["event"];
    if event["type"].as_str() != Some("message") {
        return None;
    }
    // Ignore message subtypes (edits, deletions, channel joins, etc.).
    if event.get("subtype").and_then(Value::as_str).is_some() {
        return None;
    }
    // Ignore anything posted by a bot, including our own replies (loop guard).
    if event.get("bot_id").and_then(Value::as_str).is_some() {
        return None;
    }

    let text = event["text"].as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    let channel = event["channel"].as_str()?;

    // Reply in the message's existing thread if any, otherwise start one rooted
    // at the message timestamp so the conversation stays grouped.
    let thread_ts = event
        .get("thread_ts")
        .and_then(Value::as_str)
        .or_else(|| event["ts"].as_str())
        .unwrap_or_default();

    Some(InboundMessage {
        chat_id: make_chat_id(channel, thread_ts),
        text: text.to_string(),
    })
}

// ─── Slack Web API response types (only the fields we use) ─────────────────────

#[derive(Debug, Deserialize)]
struct ConnectionsOpenResponse {
    ok: bool,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PostMessageResponse {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cfg(app_token: &str, bot_token: &str) -> SlackChannelConfig {
        SlackChannelConfig {
            app_token: app_token.to_string(),
            bot_token: bot_token.to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        }
    }

    #[test]
    fn new_rejects_empty_app_token() {
        let cfg = make_cfg("   ", "xoxb-1");
        assert!(SlackChannel::new(cfg, reqwest::Client::new()).is_err());
    }

    #[test]
    fn new_rejects_empty_bot_token() {
        let cfg = make_cfg("xapp-1", "");
        assert!(SlackChannel::new(cfg, reqwest::Client::new()).is_err());
    }

    #[test]
    fn new_accepts_valid_tokens() {
        let cfg = SlackChannelConfig {
            app_token: "xapp-1".to_string(),
            bot_token: "xoxb-1".to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: Some("be terse".to_string()),
            agent_id: None,
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        };
        let channel = SlackChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.name(), "slack");
        assert_eq!(channel.model(), "gpt-4o");
        assert_eq!(channel.system_prompt(), Some("be terse"));
    }

    #[test]
    fn new_stores_agent_id_and_core_url() {
        let cfg = SlackChannelConfig {
            app_token: "xapp-1".to_string(),
            bot_token: "xoxb-1".to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: Some("acp:pi".to_string()),
            team_id: None,
            core_url: "http://127.0.0.1:7980".to_string(),
        };
        let channel = SlackChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(channel.core_url, "http://127.0.0.1:7980");
    }

    #[test]
    fn chat_id_round_trips_channel_and_thread() {
        let packed = make_chat_id("C123", "169.45");
        assert_eq!(packed, "C123:169.45");
        assert_eq!(split_chat_id(&packed), ("C123", Some("169.45")));
    }

    #[test]
    fn split_chat_id_without_thread() {
        assert_eq!(split_chat_id("C123"), ("C123", None));
    }

    #[test]
    fn parse_envelope_id_reads_field() {
        let raw = json!({ "envelope_id": "abc-123", "type": "events_api" }).to_string();
        assert_eq!(parse_envelope_id(&raw).as_deref(), Some("abc-123"));
    }

    #[test]
    fn parse_inbound_extracts_message() {
        let raw = json!({
            "type": "events_api",
            "envelope_id": "e1",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "user": "U1",
                    "text": "hello bot",
                    "ts": "111.222"
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).unwrap();
        assert_eq!(inbound.text, "hello bot");
        assert_eq!(inbound.chat_id, "C999:111.222");
    }

    #[test]
    fn parse_inbound_prefers_existing_thread() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "text": "in a thread",
                    "ts": "333.444",
                    "thread_ts": "111.222"
                }
            }
        })
        .to_string();
        let inbound = parse_inbound(&raw).unwrap();
        assert_eq!(inbound.chat_id, "C999:111.222");
    }

    #[test]
    fn parse_inbound_ignores_bot_messages() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "bot_id": "B1",
                    "text": "i am a bot",
                    "ts": "1.2"
                }
            }
        })
        .to_string();
        assert!(parse_inbound(&raw).is_none());
    }

    #[test]
    fn parse_inbound_ignores_subtype_messages() {
        let raw = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "subtype": "channel_join",
                    "channel": "C999",
                    "text": "joined",
                    "ts": "1.2"
                }
            }
        })
        .to_string();
        assert!(parse_inbound(&raw).is_none());
    }

    #[test]
    fn parse_inbound_ignores_non_events_frames() {
        let hello = json!({ "type": "hello" }).to_string();
        assert!(parse_inbound(&hello).is_none());
    }

    /// Verify that the chat_id produced by `parse_inbound` is stable per
    /// channel/thread — the same raw frame always yields the same conversation_id
    /// so multi-turn context is preserved across messages in the same thread.
    #[test]
    fn parse_inbound_chat_id_stable_per_thread() {
        let frame = json!({
            "type": "events_api",
            "envelope_id": "e1",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "user": "U1",
                    "text": "turn two",
                    "ts": "555.666",
                    "thread_ts": "111.222"
                }
            }
        })
        .to_string();
        let first = parse_inbound(&frame).unwrap();
        let second = parse_inbound(&frame).unwrap();
        // conversation_id must be deterministic for the same channel+thread.
        assert_eq!(first.chat_id, second.chat_id);
        // conversation_id encodes both the channel and thread timestamp so Core
        // can key separate conversations per thread.
        assert_eq!(first.chat_id, "C999:111.222");
    }

    /// Verify that two messages in different threads produce different chat_ids
    /// so their Core conversations are kept separate.
    #[test]
    fn parse_inbound_different_threads_get_different_chat_ids() {
        let thread_a = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "text": "hello",
                    "ts": "1.1",
                    "thread_ts": "1.0"
                }
            }
        })
        .to_string();
        let thread_b = json!({
            "type": "events_api",
            "payload": {
                "event": {
                    "type": "message",
                    "channel": "C999",
                    "text": "world",
                    "ts": "2.1",
                    "thread_ts": "2.0"
                }
            }
        })
        .to_string();
        let id_a = parse_inbound(&thread_a).unwrap().chat_id;
        let id_b = parse_inbound(&thread_b).unwrap().chat_id;
        assert_ne!(id_a, id_b);
    }
}
