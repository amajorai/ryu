//! Telegram channel adapter.
//!
//! Registers a bot via its token and uses the Telegram Bot API `getUpdates`
//! long-polling endpoint to receive messages — no public webhook URL required.
//!
//! Inbound text is routed to the Core session seam (`POST <core_url>/api/channels/run`)
//! when `agent_id` is configured in [`TelegramChannelConfig`], making the bot a
//! first-class Session client: conversation history is persisted in Core, and model
//! calls still flow Core → Gateway so the moat (firewall, DLP, budgets, audit)
//! governs every outbound call. When `agent_id` is absent the adapter falls back to
//! the legacy `handle_message` → gateway pipeline path.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use tracing::{debug, info, warn};

use crate::{
    handle_message, status::StatusReporter, Channel, ChannelHost, GroupReplyMode, InboundMessage,
    TelegramChannelConfig,
};

/// Seconds the Telegram server holds an open `getUpdates` request waiting for
/// new messages (server-side long poll). Keeps request volume low.
const LONG_POLL_SECS: u64 = 25;

/// Cooldown before retrying after a transport error, so a flaky network or a
/// transient Telegram outage doesn't become a tight failure loop.
const ERROR_BACKOFF: Duration = Duration::from_secs(3);

pub struct TelegramChannel {
    model: String,
    system_prompt: Option<String>,
    http: reqwest::Client,
    api_base: String,
    /// When set, inbound messages are routed through Core's `/api/channels/run`
    /// endpoint using this agent id so conversation history is persisted in the
    /// Core session store. `None` falls back to the legacy gateway-pipeline path.
    agent_id: Option<String>,
    /// When set, inbound messages route to this Core team instead of a single
    /// agent; the team's lead orchestrates its members. Takes precedence over
    /// `agent_id`. Like `agent_id`, this uses Core's `/api/channels/run` seam.
    team_id: Option<String>,
    /// Base URL of the Core sidecar, used when `agent_id` or `team_id` is set.
    core_url: String,
    /// When the bot replies inside a group chat. Private chats always reply;
    /// this gates the group case (mentions-only vs every message).
    group_reply_mode: GroupReplyMode,
    /// Reports this bot's live connection status to the control plane. `None`
    /// for env-configured bots (no store id), which then show as `unknown`.
    status: Option<StatusReporter>,
}

impl TelegramChannel {
    pub fn new(cfg: TelegramChannelConfig, http: reqwest::Client) -> anyhow::Result<Self> {
        Self::new_with_status(cfg, http, None)
    }

    /// Like [`Self::new`] but attaches a liveness reporter so the bot heartbeats
    /// its connection status back to the control plane.
    pub fn new_with_status(
        cfg: TelegramChannelConfig,
        http: reqwest::Client,
        status: Option<StatusReporter>,
    ) -> anyhow::Result<Self> {
        if cfg.token.trim().is_empty() {
            anyhow::bail!("telegram channel token is empty");
        }
        let api_base = format!("https://api.telegram.org/bot{}", cfg.token);
        Ok(Self {
            model: cfg.model,
            system_prompt: cfg.system_prompt,
            http,
            api_base,
            agent_id: cfg.agent_id,
            team_id: cfg.team_id,
            core_url: cfg.core_url,
            group_reply_mode: cfg.group_reply_mode,
            status,
        })
    }

    /// Fetch the bot's own identity (`getMe`) so group-mention detection knows
    /// the bot's `@username` and user id. Called once at the start of the run
    /// loop; on failure the loop proceeds with an empty identity (private chats
    /// still work, group mention detection is disabled).
    async fn get_me(&self) -> anyhow::Result<BotIdentity> {
        let url = format!("{}/getMe", self.api_base);
        let resp = self.http.get(&url).send().await?.error_for_status()?;
        let body: GetMeResponse = resp.json().await?;
        if !body.ok {
            anyhow::bail!("telegram getMe returned ok=false");
        }
        Ok(BotIdentity {
            id: body.result.id,
            username: body.result.username,
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
    /// the Telegram `chat_id` so multi-turn exchanges share conversation history.
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

    /// Fetch the next batch of updates starting at `offset` (long poll).
    async fn get_updates(&self, offset: i64) -> anyhow::Result<Vec<Update>> {
        let url = format!("{}/getUpdates", self.api_base);
        let resp = self
            .http
            .get(&url)
            .query(&[
                ("offset", offset.to_string()),
                ("timeout", LONG_POLL_SECS.to_string()),
            ])
            // Allow the client a little longer than the server-side long poll.
            .timeout(Duration::from_secs(LONG_POLL_SECS + 10))
            .send()
            .await?
            .error_for_status()?;

        let body: GetUpdatesResponse = resp.json().await?;
        if !body.ok {
            anyhow::bail!("telegram getUpdates returned ok=false");
        }
        Ok(body.result)
    }
}

#[async_trait]
impl Channel for TelegramChannel {
    fn name(&self) -> &'static str {
        "telegram"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn system_prompt(&self) -> Option<&str> {
        self.system_prompt.as_deref()
    }

    async fn send_message(&self, chat_id: &str, text: &str) -> anyhow::Result<()> {
        let url = format!("{}/sendMessage", self.api_base);
        let chat_id_num: i64 = chat_id
            .parse()
            .map_err(|_| anyhow::anyhow!("invalid telegram chat id: {chat_id}"))?;
        self.http
            .post(&url)
            .json(&json!({
                "chat_id": chat_id_num,
                "text": text,
            }))
            .send()
            .await?
            .error_for_status()?;
        Ok(())
    }

    async fn run(self: Arc<Self>, host: Arc<dyn ChannelHost>) -> anyhow::Result<()> {
        debug!("telegram channel long-poll loop started");
        // Announce that the bot is registered and connecting before the first
        // (up to 25s) long poll returns, so the sidebar dot lights up promptly.
        if let Some(reporter) = &self.status {
            reporter.connecting().await;
        }
        // Resolve the bot's own identity once so group-mention detection can
        // recognise `@username` and replies to the bot. A failure here is
        // non-fatal: private chats reply regardless, and group Mentions mode
        // simply falls back to command-only until the next restart.
        let me = match self.get_me().await {
            Ok(identity) => identity,
            Err(err) => {
                warn!(
                    error = %err,
                    "telegram getMe failed; group mention detection disabled (private chats unaffected)"
                );
                BotIdentity::default()
            }
        };
        // Telegram acknowledges processed updates by advancing the offset to
        // (last update_id + 1); anything below the offset is never re-delivered.
        let mut offset: i64 = 0;

        loop {
            match self.get_updates(offset).await {
                Ok(updates) => {
                    // A successful poll means the bot is live — heartbeat online.
                    if let Some(reporter) = &self.status {
                        reporter.online().await;
                    }
                    for update in updates {
                        offset = offset.max(update.update_id + 1);

                        let Some(message) = update.message else {
                            continue;
                        };
                        let Some(raw_text) = message.text.clone() else {
                            continue;
                        };

                        // Auto-detect group vs private and decide whether to
                        // reply. Returns the (mention-stripped, speaker-prefixed)
                        // text to route, or None to ignore this message.
                        let Some(routed_text) =
                            decide_reply(&message, &raw_text, &me, self.group_reply_mode)
                        else {
                            continue;
                        };

                        let chat_id = message.chat.id.to_string();
                        let inbound = InboundMessage {
                            chat_id: chat_id.clone(),
                            text: routed_text,
                        };

                        // Handle each message on its own task so a slow agent
                        // call does not stall polling for other chats.
                        let channel = Arc::clone(&self);
                        let host = Arc::clone(&host);
                        tokio::spawn(async move {
                            if channel.routes_via_core() {
                                // M11 / #226: route through Core session seam so
                                // conversation history is persisted and model calls
                                // flow Core → Gateway (moat stays on path). The
                                // target is a single agent or a team (Core picks).
                                info!(
                                    chat_id = %inbound.chat_id,
                                    agent_id = ?channel.agent_id,
                                    team_id = ?channel.team_id,
                                    "telegram: routing via Core session seam"
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
                                            "telegram: Core session run failed"
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
                                        "telegram: failed to deliver reply"
                                    );
                                }
                            } else {
                                // Legacy path: handle_message → gateway pipeline.
                                // Deprecated for telegram; use agent_id to opt in
                                // to the Core session seam.
                                handle_message(channel.as_ref(), host, inbound).await;
                            }
                        });
                    }
                }
                Err(err) => {
                    warn!(error = %err, "telegram getUpdates failed, backing off");
                    if let Some(reporter) = &self.status {
                        reporter.error(&err.to_string()).await;
                    }
                    tokio::time::sleep(ERROR_BACKOFF).await;
                }
            }
        }
    }
}

/// The bot's own identity, resolved once via `getMe`. Used to recognise when a
/// group message addresses the bot (`@username` mention or a reply to the bot).
#[derive(Debug, Clone, Default)]
struct BotIdentity {
    id: i64,
    username: Option<String>,
}

/// Decide whether — and in what form — to route an inbound Telegram message to
/// Core. Direct/private chats always reply with the raw text. Group chats are
/// gated by `mode`: in `Mentions` the bot only answers when @mentioned, replied
/// to, or addressed by a `/command`; in `All` it answers every message. For
/// group replies the bot's `@mention` is stripped and the speaker's name is
/// prefixed so Core can tell who is talking in a multi-person chat.
///
/// Returns the text to route, or `None` to ignore the message.
fn decide_reply(
    message: &Message,
    raw_text: &str,
    me: &BotIdentity,
    mode: GroupReplyMode,
) -> Option<String> {
    let chat_type = message.chat.chat_type.as_str();
    let is_group = chat_type == "group" || chat_type == "supergroup";
    if !is_group {
        // Private chat (or channel post): always answer with the raw text.
        return Some(raw_text.to_string());
    }

    let mention = me.username.as_ref().map(|u| format!("@{u}"));
    let mentions_bot = mention
        .as_ref()
        .is_some_and(|m| raw_text.to_lowercase().contains(&m.to_lowercase()));
    let replies_to_bot = message
        .reply_to_message
        .as_deref()
        .and_then(|reply| reply.from.as_ref())
        .is_some_and(|from| from.id == me.id && me.id != 0);
    let is_command = raw_text.trim_start().starts_with('/');

    if mode == GroupReplyMode::Mentions && !(mentions_bot || replies_to_bot || is_command) {
        return None;
    }

    // Strip the bot's @mention so the agent sees a clean prompt.
    let stripped = match &mention {
        Some(m) => raw_text.split(m.as_str()).collect::<Vec<_>>().join(""),
        None => raw_text.to_string(),
    };
    let stripped = stripped.trim();
    if stripped.is_empty() {
        return None;
    }

    // Prefix the speaker so Core can attribute turns in a multi-person chat.
    match message.from.as_ref() {
        Some(from) if !from.first_name.is_empty() => {
            Some(format!("{}: {stripped}", from.first_name))
        }
        _ => Some(stripped.to_string()),
    }
}

// ─── Telegram Bot API response types (only the fields we use) ──────────────────

#[derive(Debug, Deserialize)]
struct GetUpdatesResponse {
    ok: bool,
    #[serde(default)]
    result: Vec<Update>,
}

#[derive(Debug, Deserialize)]
struct GetMeResponse {
    ok: bool,
    result: BotUser,
}

#[derive(Debug, Deserialize)]
struct BotUser {
    id: i64,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Update {
    update_id: i64,
    #[serde(default)]
    message: Option<Message>,
}

#[derive(Debug, Deserialize)]
struct Message {
    chat: Chat,
    #[serde(default)]
    text: Option<String>,
    /// Sender of the message. Used for the speaker prefix in group chats.
    #[serde(default)]
    from: Option<TgUser>,
    /// The message this one replies to, if any. Boxed because it is the same
    /// `Message` type (self-referential) and would otherwise be infinitely sized.
    #[serde(default)]
    reply_to_message: Option<Box<Message>>,
}

#[derive(Debug, Deserialize)]
struct Chat {
    id: i64,
    /// `private`, `group`, `supergroup`, or `channel`. Absent → treated as
    /// non-group (private) so the bot still replies.
    #[serde(rename = "type", default)]
    chat_type: String,
}

#[derive(Debug, Deserialize)]
struct TgUser {
    id: i64,
    #[serde(default)]
    first_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_cfg(token: &str) -> TelegramChannelConfig {
        TelegramChannelConfig {
            token: token.to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: None,
            team_id: None,
            group_reply_mode: GroupReplyMode::default(),
            core_url: "http://127.0.0.1:7980".to_string(),
        }
    }

    fn group_message(text: &str, first_name: &str) -> Message {
        Message {
            chat: Chat {
                id: 42,
                chat_type: "supergroup".to_string(),
            },
            text: Some(text.to_string()),
            from: Some(TgUser {
                id: 7,
                first_name: first_name.to_string(),
            }),
            reply_to_message: None,
        }
    }

    fn me() -> BotIdentity {
        BotIdentity {
            id: 999,
            username: Some("ryubot".to_string()),
        }
    }

    #[test]
    fn private_chat_always_replies_with_raw_text() {
        let message = Message {
            chat: Chat {
                id: 1,
                chat_type: "private".to_string(),
            },
            text: Some("hello".to_string()),
            from: None,
            reply_to_message: None,
        };
        let routed = decide_reply(&message, "hello", &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("hello"));
    }

    #[test]
    fn group_mentions_mode_ignores_unaddressed_message() {
        let message = group_message("just chatting", "Ada");
        assert!(decide_reply(&message, "just chatting", &me(), GroupReplyMode::Mentions).is_none());
    }

    #[test]
    fn group_mentions_mode_replies_when_mentioned_and_strips_mention() {
        let raw = "@ryubot what is 2+2";
        let message = group_message(raw, "Ada");
        let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
        // Mention stripped, speaker prefixed.
        assert_eq!(routed.as_deref(), Some("Ada: what is 2+2"));
    }

    #[test]
    fn group_mentions_mode_replies_to_command() {
        let raw = "/help";
        let message = group_message(raw, "Ada");
        let routed = decide_reply(&message, raw, &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("Ada: /help"));
    }

    #[test]
    fn group_mentions_mode_replies_to_a_reply_to_the_bot() {
        let mut message = group_message("thanks", "Ada");
        message.reply_to_message = Some(Box::new(Message {
            chat: Chat {
                id: 42,
                chat_type: "supergroup".to_string(),
            },
            text: Some("earlier bot reply".to_string()),
            from: Some(TgUser {
                id: 999,
                first_name: "Ryu".to_string(),
            }),
            reply_to_message: None,
        }));
        let routed = decide_reply(&message, "thanks", &me(), GroupReplyMode::Mentions);
        assert_eq!(routed.as_deref(), Some("Ada: thanks"));
    }

    #[test]
    fn group_all_mode_replies_to_every_message() {
        let message = group_message("just chatting", "Ada");
        let routed = decide_reply(&message, "just chatting", &me(), GroupReplyMode::All);
        assert_eq!(routed.as_deref(), Some("Ada: just chatting"));
    }

    #[test]
    fn empty_identity_disables_mention_detection_but_allows_commands() {
        let empty = BotIdentity::default();
        let message = group_message("@ryubot hi", "Ada");
        // Without an identity the @mention can't be recognised → ignored.
        assert!(decide_reply(&message, "@ryubot hi", &empty, GroupReplyMode::Mentions).is_none());
        // Commands still work (identity-independent).
        let cmd = group_message("/start", "Ada");
        assert!(decide_reply(&cmd, "/start", &empty, GroupReplyMode::Mentions).is_some());
    }

    #[test]
    fn new_rejects_empty_token() {
        let mut cfg = make_cfg("   ");
        cfg.token = "   ".to_string();
        let result = TelegramChannel::new(cfg, reqwest::Client::new());
        assert!(result.is_err());
    }

    #[test]
    fn new_builds_api_base_from_token() {
        let cfg = TelegramChannelConfig {
            token: "123:ABC".to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: Some("hi".to_string()),
            agent_id: None,
            team_id: None,
            group_reply_mode: GroupReplyMode::default(),
            core_url: "http://127.0.0.1:7980".to_string(),
        };
        let channel = TelegramChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.api_base, "https://api.telegram.org/bot123:ABC");
        assert_eq!(channel.name(), "telegram");
        assert_eq!(channel.model(), "gpt-4o");
        assert_eq!(channel.system_prompt(), Some("hi"));
    }

    #[test]
    fn new_stores_agent_id_and_core_url() {
        let cfg = TelegramChannelConfig {
            token: "tok:1".to_string(),
            model: "gpt-4o".to_string(),
            system_prompt: None,
            agent_id: Some("acp:pi".to_string()),
            team_id: None,
            group_reply_mode: GroupReplyMode::default(),
            core_url: "http://127.0.0.1:7980".to_string(),
        };
        let channel = TelegramChannel::new(cfg, reqwest::Client::new()).unwrap();
        assert_eq!(channel.agent_id.as_deref(), Some("acp:pi"));
        assert_eq!(channel.core_url, "http://127.0.0.1:7980");
    }

    #[test]
    fn parses_getupdates_response() {
        let raw = json!({
            "ok": true,
            "result": [
                {
                    "update_id": 42,
                    "message": {
                        "chat": { "id": 99 },
                        "text": "hello bot"
                    }
                }
            ]
        });
        let parsed: GetUpdatesResponse = serde_json::from_value(raw).unwrap();
        assert!(parsed.ok);
        assert_eq!(parsed.result.len(), 1);
        let update = &parsed.result[0];
        assert_eq!(update.update_id, 42);
        let message = update.message.as_ref().unwrap();
        assert_eq!(message.chat.id, 99);
        assert_eq!(message.text.as_deref(), Some("hello bot"));
    }
}
