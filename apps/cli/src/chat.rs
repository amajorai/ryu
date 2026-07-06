use futures_util::StreamExt;
use serde::Serialize;
use tokio::sync::mpsc;

// ── Types ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum Role {
    User,
    Assistant,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
}

#[derive(Debug, Default)]
pub struct ChatState {
    pub messages: Vec<ChatMessage>,
    pub input: String,
    /// Line index from the top (used when user scrolls manually).
    pub scroll: usize,
    /// When true, always jump to bottom on new content.
    pub auto_scroll: bool,
    pub streaming: bool,
    pub error: Option<String>,
    /// Set for one tick when an assistant turn finishes streaming, so the event
    /// loop can fire post-turn hooks (goal judge, double-check) exactly once.
    pub turn_just_completed: bool,
}

impl ChatState {
    pub fn new() -> Self {
        Self {
            auto_scroll: true,
            ..Default::default()
        }
    }
}

// ── Events sent from the streaming task back to the UI ────────────────────────

pub enum ChatEvent {
    Chunk(String),
    Done,
    Error(String),
}

/// Result of a `/btw` side question. Non-streaming: a single answer or an error.
pub enum BtwEvent {
    Answer(String),
    Error(String),
}

// ── Per-turn routing options ─────────────────────────────────────────────────

/// Everything the chat composer can attach to a single turn beyond the message
/// text. Mirrors the subset of Core's `ChatStreamRequest` the CLI drives:
/// agent/team routing, a stable conversation id (so `/goal`, `/double-check`,
/// and sessions work against a persisted conversation), and an optional ACP
/// model override (`/model <id>`).
#[derive(Default, Clone)]
pub struct ChatOptions {
    /// Agent to route to. `None` lets Core pick its default agent.
    pub agent_id: Option<String>,
    /// Stable per-chat id. Sent on every turn so Core persists the conversation
    /// under it; goal/double-check/session endpoints key off the same id.
    pub conversation_id: Option<String>,
    /// ACP session model override for this turn (`acp_model`). Ignored by Core
    /// when the bound agent doesn't advertise model selection.
    pub acp_model: Option<String>,
    /// Route the turn to an agent team instead of a single agent (`@team`).
    pub team_id: Option<String>,
}

// ── Wire format sent to the server ───────────────────────────────────────────

#[derive(Serialize)]
struct ChatRequest {
    messages: Vec<ApiMessage>,
    /// Agent to route to. Present only when chatting through Core
    /// (`/api/chat/stream`).
    #[serde(rename = "agent_id", skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    acp_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    team_id: Option<String>,
}

#[derive(Serialize)]
struct ApiMessage {
    role: &'static str,
    content: Vec<ApiContent>,
}

#[derive(Serialize)]
struct ApiContent {
    #[serde(rename = "type")]
    kind: &'static str,
    text: String,
}

// ── Streaming task ────────────────────────────────────────────────────────────

/// Spawnable async task: streams chat completion from the server and sends
/// [`ChatEvent`]s back through `tx`.
pub async fn stream_chat(
    messages: Vec<ChatMessage>,
    tx: mpsc::UnboundedSender<ChatEvent>,
    chat_url: String,
    opts: ChatOptions,
) {
    let api_messages: Vec<ApiMessage> = messages
        .iter()
        .map(|m| ApiMessage {
            role: match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            },
            content: vec![ApiContent {
                kind: "text",
                text: m.content.clone(),
            }],
        })
        .collect();

    let body = ChatRequest {
        messages: api_messages,
        agent_id: opts.agent_id,
        conversation_id: opts.conversation_id,
        acp_model: opts.acp_model,
        team_id: opts.team_id,
    };

    let client = reqwest::Client::new();
    let response = match client.post(&chat_url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(ChatEvent::Error(e.to_string()));
            return;
        }
    };

    if !response.status().is_success() {
        let status = response.status();
        let _ = tx.send(ChatEvent::Error(format!("HTTP {status}")));
        return;
    }

    let mut stream = response.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = tx.send(ChatEvent::Error(e.to_string()));
                return;
            }
        };

        buffer.push_str(&String::from_utf8_lossy(&bytes));

        // Process all complete `\n`-terminated lines in the buffer.
        let mut start = 0;
        while let Some(rel) = buffer[start..].find('\n') {
            let end = start + rel;
            let line = buffer[start..end].trim_end_matches('\r').to_owned();
            start = end + 1;

            // AI SDK v6 UI Message Stream SSE format: each `data:` frame is a
            // JSON object with a `type` discriminator.
            //   {"type":"text-delta","delta":"…"}            → text chunk
            //   {"type":"tool-input-available","toolName":…}  → a tool call
            //   {"type":"tool-output-available","output":…}   → a tool result
            //   {"type":"error","errorText":"…"}             → error
            //   {"type":"finish"} / data: [DONE]              → end of stream
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };

            if data.is_empty() {
                continue;
            }

            if data == "[DONE]" {
                let _ = tx.send(ChatEvent::Done);
                return;
            }

            let Ok(chunk) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };

            match chunk.get("type").and_then(|t| t.as_str()) {
                Some("text-delta") => {
                    if let Some(delta) = chunk.get("delta").and_then(|d| d.as_str()) {
                        let _ = tx.send(ChatEvent::Chunk(delta.to_owned()));
                    }
                }
                Some("tool-input-available") => {
                    // The CLI has no rich tool UI; surface the call as a readable
                    // line so the user sees the agent's tool loop, not just text.
                    let name = chunk
                        .get("toolName")
                        .and_then(|n| n.as_str())
                        .unwrap_or("tool");
                    let _ = tx.send(ChatEvent::Chunk(format!("\n[tool: {name}]\n")));
                }
                Some("tool-output-available") => {
                    if let Some(status) = chunk
                        .get("output")
                        .and_then(|o| o.get("status"))
                        .and_then(|s| s.as_str())
                    {
                        let _ = tx.send(ChatEvent::Chunk(format!("[tool {status}]\n")));
                    }
                }
                Some("error") => {
                    let msg = chunk
                        .get("errorText")
                        .and_then(|m| m.as_str())
                        .unwrap_or("stream error");
                    let _ = tx.send(ChatEvent::Error(msg.to_owned()));
                    return;
                }
                Some("finish") => {
                    let _ = tx.send(ChatEvent::Done);
                    return;
                }
                // start, text-start, text-end, tool-input-start, etc. — ignored.
                _ => {}
            }
        }
        buffer.drain(..start);
    }

    let _ = tx.send(ChatEvent::Done);
}

// ── Side question (`/btw`) task ───────────────────────────────────────────────

/// Wire format for a `/btw` side question sent to Core's `POST /api/btw`. The CLI
/// holds the transcript itself, so it passes `messages` (Core falls back to a
/// stored conversation only when this is absent).
#[derive(Serialize)]
struct BtwRequest {
    question: String,
    messages: Vec<BtwWireMessage>,
}

#[derive(Serialize)]
struct BtwWireMessage {
    role: &'static str,
    content: String,
}

/// Spawnable async task: ask an ephemeral side question about the current
/// conversation and send the single answer back through `tx`. The side model
/// sees the conversation context but has no tools, and nothing is persisted —
/// this is Claude-Code-style `/btw`, a quick aside that never enters history.
pub async fn ask_btw(
    messages: Vec<ChatMessage>,
    question: String,
    btw_url: String,
    tx: mpsc::UnboundedSender<BtwEvent>,
) {
    let wire: Vec<BtwWireMessage> = messages
        .iter()
        .map(|m| BtwWireMessage {
            role: match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            },
            content: m.content.clone(),
        })
        .collect();
    let body = BtwRequest {
        question,
        messages: wire,
    };

    let client = reqwest::Client::new();
    let response = match client.post(&btw_url).json(&body).send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = tx.send(BtwEvent::Error(e.to_string()));
            return;
        }
    };
    if !response.status().is_success() {
        let _ = tx.send(BtwEvent::Error(format!("HTTP {}", response.status())));
        return;
    }
    let value: serde_json::Value = match response.json().await {
        Ok(v) => v,
        Err(e) => {
            let _ = tx.send(BtwEvent::Error(e.to_string()));
            return;
        }
    };
    let answer = value
        .get("answer")
        .and_then(|a| a.as_str())
        .unwrap_or_default()
        .to_string();
    let _ = tx.send(BtwEvent::Answer(answer));
}

// ── Goal judge (`/goal`) task ─────────────────────────────────────────────────

/// One judge verdict for an active goal, mirroring Core's `GoalVerdict`.
pub enum GoalEvent {
    Verdict {
        /// Whether the judge decided the completion condition is met.
        met: bool,
        /// The judge's short reason.
        reason: String,
        /// Halt the loop regardless of `met` (true when met, or on a fail-safe
        /// stop — unreachable judge / unparseable verdict).
        stop: bool,
        /// Turns evaluated so far (post-increment).
        turns: u32,
    },
    Error(String),
}

/// Spawnable task: run one goal-judge evaluation against the conversation
/// transcript Core holds (keyed by `conversation_id`). The judge model is
/// resolved + routed server-side; the client only drives the continuation loop.
pub async fn judge_goal(
    api_url: String,
    conversation_id: String,
    token: Option<String>,
    tx: mpsc::UnboundedSender<GoalEvent>,
) {
    let url = format!("{api_url}/api/conversations/{conversation_id}/goal/judge");
    let client = reqwest::Client::new();
    let mut req = client.post(&url);
    if let Some(t) = &token {
        req = req.bearer_auth(t);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(v) => {
                let met = v.get("met").and_then(|b| b.as_bool()).unwrap_or(false);
                // Fail-safe default is to stop, never loop on a garbage verdict.
                let stop = v.get("stop").and_then(|b| b.as_bool()).unwrap_or(true);
                let reason = v
                    .get("reason")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let turns = v.get("turns").and_then(|n| n.as_u64()).unwrap_or(0) as u32;
                let _ = tx.send(GoalEvent::Verdict {
                    met,
                    reason,
                    stop,
                    turns,
                });
            }
            Err(e) => {
                let _ = tx.send(GoalEvent::Error(e.to_string()));
            }
        },
        Ok(resp) => {
            let _ = tx.send(GoalEvent::Error(format!("HTTP {}", resp.status())));
        }
        Err(e) => {
            let _ = tx.send(GoalEvent::Error(e.to_string()));
        }
    }
}

// ── Double-check task ─────────────────────────────────────────────────────────

/// One double-check review of the latest assistant answer (Core's
/// `DoubleCheckResult`). Stateless — Core persists nothing.
pub enum DoubleCheckEvent {
    Result {
        /// True when the reviewer found no issues (fail-loud: false flags one).
        ok: bool,
        /// The reviewer's short critique.
        critique: String,
        /// The reviewing model id (resolved server-side).
        model: String,
    },
    Error(String),
}

/// Spawnable task: have a separately-configured side model review the latest
/// assistant turn in `conversation_id` and report a verdict + critique.
pub async fn double_check(
    api_url: String,
    conversation_id: String,
    token: Option<String>,
    tx: mpsc::UnboundedSender<DoubleCheckEvent>,
) {
    let url = format!("{api_url}/api/conversations/{conversation_id}/double-check");
    let client = reqwest::Client::new();
    let mut req = client.post(&url);
    if let Some(t) = &token {
        req = req.bearer_auth(t);
    }
    match req.send().await {
        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
            Ok(v) => {
                let ok = v.get("ok").and_then(|b| b.as_bool()).unwrap_or(false);
                let critique = v
                    .get("critique")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let model = v
                    .get("model")
                    .and_then(|s| s.as_str())
                    .unwrap_or("")
                    .to_string();
                let _ = tx.send(DoubleCheckEvent::Result {
                    ok,
                    critique,
                    model,
                });
            }
            Err(e) => {
                let _ = tx.send(DoubleCheckEvent::Error(e.to_string()));
            }
        },
        Ok(resp) => {
            let _ = tx.send(DoubleCheckEvent::Error(format!("HTTP {}", resp.status())));
        }
        Err(e) => {
            let _ = tx.send(DoubleCheckEvent::Error(e.to_string()));
        }
    }
}
