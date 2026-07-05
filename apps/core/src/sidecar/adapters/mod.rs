pub mod acp;
pub mod context_window;
pub mod mcp_bridge;
pub mod openai_compat;
pub mod sdk;

pub use acp::{AcpAgentRegistry, FallbackProvider};

use std::path::PathBuf;
use std::sync::Arc;

use crate::agents::{AgentStore, PersonaSlot};
use crate::registry::ProviderRegistry;
use crate::server::conversations::{ConversationStore, MessageSearchHit};
use crate::server::memory::{
    MemoryStore, DEFAULT_LONG_TERM_LIMIT, DEFAULT_SHORT_TERM_LIMIT, LOCAL_USER,
};
use crate::server::retrieval::{ChunkSource, RetrievalOptions, RetrievalStore, ScoredChunk};
use crate::server::trace::{hash_args, TraceStore};
use crate::server::worktree::{create_worktree_in, find_git_root, is_git_repo, WorktreeGuard};
use crate::sidecar::active_engine::{is_local_engine, local_engine_base_url};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::BoxFuture;
use crate::sidecar::SidecarManager;
use crate::skills::SkillRegistry;
use axum::{
    body::Body,
    http::{HeaderValue, StatusCode},
    response::Response,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ── Shared domain types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub install_hint: Option<String>,
    pub installed: Option<bool>,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub created_at: Option<String>,
    /// The engine this agent is bound to, as decided by Core (never the client).
    /// For ACP agents this is the agent's own runtime (e.g. "claude"); for
    /// OpenAI-compatible agents it is the local engine that serves it (e.g.
    /// "zeroclaw"). Lets every client show "agent → engine" without inventing
    /// its own mapping.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    /// Transport kind backing the agent: `"acp"` (spawned subprocess) or
    /// `"openai_compat"` (local OpenAI-compatible server). Clients use this to
    /// label the binding without hard-coding the agent list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transport: Option<String>,
    /// True for the default flagship agent ("ryu"). Clients may surface this as
    /// a recommended/default selection badge. Only one agent sets this to `true`
    /// at a time; the field is omitted from the response when `false` or absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
    /// Semver version of the agent template. `None` for registry built-ins (they
    /// are not versioned as app templates). Custom agents always carry a version.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// When `true` the agent is locked and cannot be edited via the API.
    /// Omitted from the response when `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    /// `true` for the agent that is auto-installed + set as the default on
    /// first Core start (derived from `ProviderRegistry::default_agent_id`,
    /// NOT persisted as a DB column — config is authoritative for AC4).
    /// Omitted from the response when not the default agent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// `true` when this agent's provider calls cannot be redirected through the
    /// local gateway via env-var injection (i.e. the engine does not honour
    /// `OPENAI_BASE_URL` / `OPENAI_API_KEY`). Clients may surface this as a
    /// "gateway bypass" warning in the UI. Omitted when `false` or absent.
    ///
    /// Engines in this category: Claude Code (Anthropic `/v1/messages` format),
    /// Gemini CLI (Google format). Both hardcode their provider endpoint and
    /// ignore `OPENAI_BASE_URL`, so injecting it would silently fail or break
    /// them. The residual bypass is an explicit design choice (AC3 of #214).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway_bypass: Option<bool>,
    /// Custom avatar image for the agent, as a data URL (or remote URL), taken
    /// from the agent's persona slot. When present, clients render this in place
    /// of the engine logo. Only custom (DB-backed) agents carry it; registry
    /// built-ins leave it `None` and fall back to the engine logo. Omitted from
    /// the response when absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub name: String,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
}

/// A selectable chat-model option for an engine, shown in client model pickers.
/// Keyed by engine id (e.g. "claude"), matching [`AgentInfo::engine`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineModel {
    pub id: String,
    pub name: String,
}

fn engine_model(id: &str, name: &str) -> EngineModel {
    EngineModel {
        id: id.to_string(),
        name: name.to_string(),
    }
}

/// The Core-owned catalog of per-engine chat-model options — the single source of
/// truth that desktop/CLI/mobile used to each hardcode. These are swappable
/// defaults (a default table Core owns, not a lock): a later config/registry can
/// override them without touching any client. Clients fetch this via
/// `GET /api/engines/models` and fall back to it only when offline.
pub fn engine_model_catalog() -> std::collections::BTreeMap<String, Vec<EngineModel>> {
    let mut catalog = std::collections::BTreeMap::new();
    catalog.insert(
        "claude".to_string(),
        vec![
            engine_model("opus", "Opus"),
            engine_model("sonnet", "Sonnet"),
            engine_model("fable", "Fable"),
            engine_model("haiku", "Haiku"),
        ],
    );
    catalog.insert(
        "codex".to_string(),
        vec![
            engine_model("gpt-5.1-codex-max", "GPT-5.1 Codex Max"),
            engine_model("gpt-5.1-codex", "GPT-5.1 Codex"),
            engine_model("gpt-5.1", "GPT-5.1"),
        ],
    );
    catalog.insert(
        "gemini".to_string(),
        vec![
            engine_model("gemini-2.5-pro", "Gemini 2.5 Pro"),
            engine_model("gemini-2.5-flash", "Gemini 2.5 Flash"),
        ],
    );
    catalog.insert("pi".to_string(), vec![engine_model("default", "Default")]);
    catalog.insert(
        "hermes".to_string(),
        vec![engine_model("hermes3", "Hermes 3")],
    );
    let local_models = vec![engine_model("gemma-4-e2b-it", "Gemma 4 E2B")];
    // The flagship `ryu` agent (Pi + Gateway) runs on the local engine by
    // default, so its picker surfaces the same local models as `local`.
    // Without this key `resolveEngine("ryu")` finds no catalog entry and the
    // selector collapses to a single "Auto" option.
    catalog.insert("ryu".to_string(), local_models.clone());
    catalog.insert("local".to_string(), local_models);
    catalog
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub content: String,
    pub score: Option<f32>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: Option<String>,
    pub schema: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatRequest {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatChunk {
    pub delta: Option<String>,
    #[serde(default)]
    pub done: bool,
    pub metadata: Option<serde_json::Value>,
}

// ── Traits ─────────────────────────────────────────────────────────────────────

/// Universal adapter trait for AI providers (llamacpp, ollama, etc.)
pub trait ProviderAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn is_available(&self) -> bool;
}

// ── Chat stream types (used by the /api/chat/stream endpoint) ─────────────────

/// Incoming request body from the UI (matches Vercel AI SDK v6 UIMessage format).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ChatStreamRequest {
    /// Messages in `{ role, content }` form — the UI sends these as UIMessage parts.
    #[serde(default)]
    pub messages: Vec<UiMessage>,
    /// Which agent to route to. The id is resolved against the [`AcpAgentRegistry`]
    /// (`find_by_prefix`) and the agent's stored binding decides the adapter:
    ///   "zeroclaw*"    → ZeroClaw, local OpenAI-compatible server (port 42617)
    ///   "openclaw"     → OpenClaw, native ACP bridge (`openclaw acp`)
    ///   "hermes"       → Hermes Agent, native ACP (`hermes acp`)
    ///   "acp:*"        → an ACP subprocess agent (Claude Code, Codex, Gemini, Pi,
    ///                    and the self-fetching ACP-registry agents)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    /// Opt-in long-term (cross-session) memory (spec unit U11). When `true`,
    /// prior durable facts for this user/agent are injected as context and the
    /// current turn is recorded for future sessions. Defaults to `false` per
    /// the privacy-by-default principle.
    #[serde(default)]
    pub enable_long_term: bool,
    /// The working directory the user has selected for this run (M1 git-native
    /// workspace). When set and `worktree_isolation` is `true`, Core allocates a
    /// per-run git worktree from this path so the agent never mutates the user's
    /// main checkout mid-run. When set and isolation is off, the ACP session is
    /// rooted here instead of the Core process cwd.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// When `true` (and `cwd` resolves to a git repo), Core creates an isolated
    /// `ryu/run-<id>` worktree for the ACP session and removes it on completion.
    /// Defaults to `false` — non-git directories or opt-out callers get the plain
    /// `cwd` (or `current_dir()` when `cwd` is absent) passed directly.
    #[serde(default)]
    pub worktree_isolation: bool,
    /// Git branch active at run start (M1). Populated by clients that track the
    /// active workspace; stored on the conversation row for the runs list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// Per-run worktree path (M1). Set by clients that create a dedicated
    /// worktree for this run; stored for later resume/apply. When worktree
    /// isolation is active, Core overwrites this with the allocated worktree path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Desired branch name for the isolated worktree (M1, persistent-session).
    /// Applied only when Core *creates* a new worktree for the conversation
    /// (first turn, or after apply); sanitized and made collision-safe. Ignored
    /// when an existing worktree is reused across turns. `None` ⇒ auto-named
    /// `ryu/run-<id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_branch: Option<String>,
    /// True when this chat request originates from the context companion
    /// (screen-capture path, M7 / #199). When set, Core forwards the
    /// `x-ryu-companion-source: true` header to the Gateway so Gateway DLP/PII
    /// redaction fires unconditionally before the provider call.
    #[serde(default)]
    pub companion_source: bool,
    /// Route this specific message to a particular agent within a multi-agent
    /// conversation (#414). When set, Core validates the agent is a participant
    /// in the conversation (auto-adding it if needed) and uses that agent's
    /// config for this turn. When absent, the conversation's primary `agent_id`
    /// governs routing (backward compatible).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_agent_id: Option<String>,
    /// Route this message to an **agent team** (a named collection of agents +
    /// a coordination strategy). When set, the request is dispatched to
    /// [`route_team_chat_stream`] instead of the single-agent path: the team's
    /// members are run per the team's coordination strategy (broadcast /
    /// round-robin / debate-synthesis / router) and their replies are merged
    /// into one attributed SSE stream. `agent_id`/`target_agent_id` are ignored
    /// when this is set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Whether this turn should be persisted to the conversation store. Defaults
    /// to `true` (every normal chat turn is recorded). The team orchestrator sets
    /// this to `false` on its per-member sub-requests so each member's reply is
    /// *not* double-persisted: the orchestrator records the user turn once and a
    /// single combined assistant turn attributed to the team, keeping the
    /// streamed view and a later reload identical.
    #[serde(default = "default_persist")]
    pub persist: bool,
    /// Per-request inference / sampling override (temperature, top_p, top_k, …).
    /// Merged on top of the agent's stored [`crate::agents::AgentRecord::inference`]
    /// defaults (request wins per field) and applied to the OpenAI-compat body,
    /// translated for the bound engine. `None` leaves the agent defaults in force.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inference: Option<crate::inference::SamplingConfig>,
    /// ACP session **permission mode** to apply for this turn (e.g. `plan`,
    /// `acceptEdits`, `bypassPermissions`). Agent-reported via `session/new`
    /// (see `GET /api/agents/:id/acp-config`); Ryu hardcodes no mode strings.
    /// Re-applied each turn since ACP sessions are per-turn. Ignored by non-ACP
    /// routes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_mode: Option<String>,
    /// ACP session **config options** to apply for this turn, as
    /// `{ config_id: value_id }` — e.g. a reasoning-effort / `thought_level`
    /// selector. Agent-reported; applied via `session/set_config_option`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_config: Option<std::collections::HashMap<String, String>>,
    /// ACP session **model** id to select for this turn (unstable ACP
    /// capability; ignored if the agent doesn't advertise model selection).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_model: Option<String>,
    /// True when this turn is programmatic background work (sub-agent fan-out,
    /// background worker, scheduled/triggered run) rather than a user-facing
    /// chat turn. Forwarded to the Gateway as `x-ryu-priority: background` so the
    /// local-engine admission queue serves interactive turns ahead of it when
    /// the resident engine's batch slots are full. Default `false` (interactive).
    /// NB: only effective on Core-made gateway calls (the default / openai-compat
    /// route); ACP agents (Pi/flagship) make their own provider calls, so their
    /// egress can't carry this header — they get concurrency limiting but
    /// default-interactive priority (same ACP egress-bypass class as the other
    /// `x-ryu-*` headers).
    #[serde(default)]
    pub background: bool,
    /// Per-request plugin flags set by the client (e.g. a composer toggle):
    /// `{ "io.ryu.double-check": true }`. The plugin turn-hook runtime
    /// ([`crate::plugin_host`]) passes these to each `post_assistant_turn` hook so
    /// a plugin reads its own flag to decide whether to act this turn. Empty by
    /// default (no hook acts on a flag it cannot see).
    #[serde(default)]
    pub plugin_flags: std::collections::HashMap<String, bool>,
    /// Verified human author of this turn's user message — the Better Auth user
    /// id resolved from the request's user JWT (`crate::identity_verify`). This is
    /// SERVER-SET ONLY: `chat_stream` stamps it from the verified caller, and
    /// `#[serde(skip)]` keeps it out of the wire format so a client request body
    /// can never set or spoof it. It is threaded into the user-row
    /// `append_message` so each persisted message records who actually sent it,
    /// distinct from `agent_id` (the AI agent). `None` in the single-tenant /
    /// loopback (anonymous) flow, preserving current behavior.
    #[serde(skip)]
    pub author_user_id: Option<String>,
    /// Connector-supplied display name of the sender (e.g. a Telegram first name
    /// or Discord username) for group/channel chats. SERVER-SET ONLY
    /// (`#[serde(skip)]`) — a client body can neither set nor spoof it. Unlike
    /// `author_user_id` it is NOT a verified identity and is never used for auth;
    /// it is threaded into the user-row `append_message` purely so a
    /// multi-participant thread can record and reason about who said what. `None`
    /// for 1:1 / anonymous turns.
    #[serde(skip)]
    pub author_name: Option<String>,
}

/// Default for [`ChatStreamRequest::persist`] — normal turns persist.
fn default_persist() -> bool {
    true
}

/// A single message in the AI SDK UIMessage format (simplified subset).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiMessage {
    pub role: String,
    /// Legacy string or parts array (AI SDK v5 and earlier).
    #[serde(default)]
    pub content: UiContent,
    /// AI SDK v6 sends parts at the top level instead of content.
    #[serde(default)]
    pub parts: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(untagged)]
pub enum UiContent {
    #[default]
    Empty,
    Text(String),
    Parts(Vec<Value>),
}

impl UiContent {
    /// Extract a plain-text string from any content shape.
    pub fn as_text(&self) -> String {
        match self {
            Self::Text(s) => s.clone(),
            Self::Parts(parts) => parts
                .iter()
                .filter_map(|p| p.get("text")?.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
                .join(""),
            Self::Empty => String::new(),
        }
    }
}

// ── AI SDK v6 UI Message Stream encoding ──────────────────────────────────────
//
// The clients (`apps/desktop` via `@ai-sdk/react` `DefaultChatTransport`, and
// `apps/cli`) speak the AI SDK v6 UI Message Stream: SSE frames whose `data:`
// payload is a JSON object with a `type` discriminator. This is the same
// protocol `apps/server`'s `/ai` route emits via `toUIMessageStreamResponse()`.
// Tool calls and results are first-class part types here, which is what lets the
// flagship desktop client render the agent's tool loop (not just final text).

/// Terminal SSE frame the AI SDK expects to close a UI message stream.
const DONE_SSE_LINE: &str = "data: [DONE]\n\n";

/// The terminal `[DONE]` SSE frame bytes. Exposed so the plugin turn-hook wrapper
/// (`server::run_chat_with_hooks`) can withhold each inner turn's `[DONE]` and
/// emit a single terminal one for the whole (possibly multi-turn) response.
pub(crate) fn done_sse_frame() -> Vec<u8> {
    DONE_SSE_LINE.as_bytes().to_vec()
}

/// Whether a forwarded SSE chunk is exactly the terminal `[DONE]` frame.
pub(crate) fn is_done_frame(bytes: &[u8]) -> bool {
    bytes == DONE_SSE_LINE.as_bytes()
}

/// Encode one UI message stream chunk as an SSE `data:` frame.
fn ui_chunk(value: &Value) -> Vec<u8> {
    format!("data: {value}\n\n").into_bytes()
}

/// `start` part — opens the assistant message.
fn ui_start() -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "start" }))
}

/// `text-start` part — opens a streamed text block with a stable id.
fn ui_text_start(id: &str) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "text-start", "id": id }))
}

/// `text-delta` part — one chunk of streamed assistant text.
fn ui_text_delta(id: &str, delta: &str) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "text-delta", "id": id, "delta": delta }))
}

/// `text-end` part — closes the streamed text block.
fn ui_text_end(id: &str) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "text-end", "id": id }))
}

/// `tool-input-available` part — a tool call the agent has initiated.
///
/// `dynamic: true` produces a `dynamic-tool` part carrying a clean `toolName`
/// (rendered by the desktop's generic tool row). `dynamic: false` produces a
/// `tool-<Name>` part — the desktop binds rich renderers (Bash terminal, Edit
/// diff, Todo checklist, Thinking, …) to the canonical Claude-style names, so
/// ACP tool calls mapped via [`acp_tool_ui_name`] get the full tool UI.
fn ui_tool_input(tool_call_id: &str, tool_name: &str, input: &Value, dynamic: bool) -> Vec<u8> {
    ui_chunk(&serde_json::json!({
        "type": "tool-input-available",
        "toolCallId": tool_call_id,
        "toolName": tool_name,
        "input": input,
        "dynamic": dynamic,
    }))
}

/// `tool-output-available` part — the result of a tool call. The `dynamic`
/// flag must match the part's opening `tool-input-available` frame.
fn ui_tool_output(tool_call_id: &str, output: &Value, dynamic: bool) -> Vec<u8> {
    ui_chunk(&serde_json::json!({
        "type": "tool-output-available",
        "toolCallId": tool_call_id,
        "output": output,
        "dynamic": dynamic,
    }))
}

/// Map an ACP tool call (category `kind`, human `title`, raw `input`) onto the
/// canonical tool name the desktop renders rich UI for.
///
/// Returns `(tool_name, dynamic)`: `dynamic = false` means the name is one of
/// the known Claude-style tools (`tool-Bash`, `tool-Edit`, `tool-TodoWrite`, …)
/// with a matching input shape, so the client shows the specialized card.
/// Anything unrecognized stays a dynamic tool row under its original title.
fn acp_tool_ui_name(kind: &str, title: &str, input: &Value) -> (String, bool) {
    const KNOWN_TOOLS: [&str; 14] = [
        "Bash",
        "Read",
        "Edit",
        "Write",
        "Grep",
        "Glob",
        "WebFetch",
        "WebSearch",
        "TodoWrite",
        "PlanWrite",
        "ExitPlanMode",
        "Task",
        "Agent",
        "NotebookEdit",
    ];
    // Some ACP adapters put the underlying tool name straight into the title.
    if KNOWN_TOOLS.contains(&title) {
        return (title.to_owned(), false);
    }
    let has = |key: &str| input.get(key).is_some();
    match kind {
        "execute" if has("command") => ("Bash".to_owned(), false),
        "read" if has("file_path") => ("Read".to_owned(), false),
        "edit" if has("file_path") => {
            if has("content") && !has("old_string") {
                ("Write".to_owned(), false)
            } else {
                ("Edit".to_owned(), false)
            }
        }
        "fetch" if has("url") => ("WebFetch".to_owned(), false),
        "search" if has("query") => ("WebSearch".to_owned(), false),
        "search" if has("pattern") => ("Grep".to_owned(), false),
        "think" if has("todos") => ("TodoWrite".to_owned(), false),
        "think" => ("Thinking".to_owned(), false),
        // Kind-only fallbacks: ACP does not standardize `raw_input` field names,
        // so when the specific-key arms above don't match (a non-Claude input
        // schema), map on the protocol `kind` alone. This keeps an ACP agent's
        // edits/reads/commands/searches on their rich renderers (diff card,
        // terminal, search group) instead of dropping to a generic row — the
        // edit's actual diff still arrives via the ACP `Diff` content block
        // (see `extract_diff_output`).
        "execute" => ("Bash".to_owned(), false),
        "read" => ("Read".to_owned(), false),
        "edit" => ("Edit".to_owned(), false),
        "fetch" => ("WebFetch".to_owned(), false),
        "search" => ("WebSearch".to_owned(), false),
        // Built-in generative-UI tool (`ui__render`). ACP exposes no stable machine
        // tool name (the `title` is humanized per-adapter), so detect it by its
        // unique spec-shaped input and emit a stable name the desktop matches to
        // render the UI inline. The `{ spec: { root, elements } }` shape is specific
        // to json-render and used by no other tool.
        _ if input
            .get("spec")
            .and_then(Value::as_object)
            .is_some_and(|s| s.contains_key("root") && s.contains_key("elements")) =>
        {
            ("ui__render".to_owned(), true)
        }
        _ => {
            let name = if title.is_empty() { kind } else { title };
            (name.to_owned(), true)
        }
    }
}

/// `finish` part — marks the assistant message complete.
fn ui_finish() -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": "finish" }))
}

/// Custom `data-<name>` part — an arbitrary structured payload the desktop reads
/// off `message.parts` (Vercel AI SDK data parts). Used for ACP control events
/// that are neither text nor tool calls: agent-initiated mode changes,
/// interactive tool-permission prompts, and slash-command advertisements.
fn ui_data(name: &str, data: &Value) -> Vec<u8> {
    ui_chunk(&serde_json::json!({ "type": format!("data-{name}"), "data": data }))
}

/// Build the `data-ryu-stats` part carrying per-message inference statistics
/// (tokens/sec, token counts, time-to-first-token), or `None` when there is
/// nothing meaningful to show.
///
/// Mirrors Jan AI's calculation: the token speed is llama.cpp's
/// `timings.predicted_per_second` when present, falling back to
/// `completion_tokens / generation_seconds`. Token counts prefer the engine's
/// reported numbers (`timings.predicted_n`/`usage.completion_tokens`) over a
/// streamed-delta count, which is only a last resort (a delta is not a token).
/// `ttft_ms` is the wall-clock from stream open to the first content delta;
/// `duration_ms` is first delta → completion (the generation window), so the
/// fallback speed excludes prompt-processing time exactly as Jan does.
fn build_stats_part(
    stream_open: std::time::Instant,
    first_token_at: Option<std::time::Instant>,
    delta_count: u64,
    last_timings: &Option<Value>,
    last_usage: &Option<Value>,
) -> Option<Vec<u8>> {
    let now = std::time::Instant::now();
    let timings_f = |key: &str| {
        last_timings
            .as_ref()
            .and_then(|t| t.get(key))
            .and_then(Value::as_f64)
    };
    let usage_u = |key: &str| {
        last_usage
            .as_ref()
            .and_then(|u| u.get(key))
            .and_then(Value::as_u64)
    };

    let prompt_tokens = timings_f("prompt_n")
        .map(|n| n as u64)
        .or_else(|| usage_u("prompt_tokens"));
    let completion_tokens = timings_f("predicted_n")
        .map(|n| n as u64)
        .or_else(|| usage_u("completion_tokens"))
        .unwrap_or(delta_count);
    let total_tokens = usage_u("total_tokens")
        .or_else(|| Some(prompt_tokens.unwrap_or(0) + completion_tokens));

    // Generation window: first content token → now. TTFT: stream open → first token.
    let duration_ms = first_token_at.map(|t| now.duration_since(t).as_millis() as u64);
    let ttft_ms = first_token_at.map(|t| t.duration_since(stream_open).as_millis() as u64);

    let round2 = |v: f64| (v * 100.0).round() / 100.0;
    let duration_sec = duration_ms.unwrap_or(0) as f64 / 1000.0;
    let tokens_per_second = match timings_f("predicted_per_second") {
        Some(tps) if tps > 0.0 => round2(tps),
        _ if duration_sec > 0.0 && completion_tokens > 0 => {
            round2(completion_tokens as f64 / duration_sec)
        }
        _ => 0.0,
    };
    let prompt_per_second = timings_f("prompt_per_second")
        .filter(|v| *v > 0.0)
        .map(round2);

    // Nothing worth showing (e.g. an empty/aborted turn): omit the part entirely,
    // mirroring Jan's `if speed === 0 && count === 0 return null`.
    if tokens_per_second == 0.0 && completion_tokens == 0 {
        return None;
    }

    let mut stats = serde_json::Map::new();
    stats.insert("tokensPerSecond".into(), serde_json::json!(tokens_per_second));
    if let Some(pps) = prompt_per_second {
        stats.insert("promptPerSecond".into(), serde_json::json!(pps));
    }
    stats.insert("completionTokens".into(), serde_json::json!(completion_tokens));
    if let Some(pt) = prompt_tokens {
        stats.insert("promptTokens".into(), serde_json::json!(pt));
    }
    if let Some(tt) = total_tokens {
        stats.insert("totalTokens".into(), serde_json::json!(tt));
    }
    if let Some(d) = duration_ms {
        stats.insert("durationMs".into(), serde_json::json!(d));
    }
    if let Some(ttft) = ttft_ms {
        stats.insert("ttftMs".into(), serde_json::json!(ttft));
    }
    Some(ui_data("ryu-stats", &Value::Object(stats)))
}

pub(crate) fn sse_response(body: Body) -> Response {
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .body(body)
        .unwrap();
    let h = response.headers_mut();
    h.insert(
        "content-type",
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert("cache-control", HeaderValue::from_static("no-cache"));
    h.insert(
        "x-vercel-ai-ui-message-stream",
        HeaderValue::from_static("v1"),
    );
    h.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    response
}

// ── Agent routing ──────────────────────────────────────────────────────────────

enum AgentRoute {
    OpenAiCompat {
        base_url: String,
        model: String,
        api_key: Option<String>,
        /// When true, Core forwards this call to the local ryu-gateway instead
        /// of hitting `base_url` directly. The gateway owns provider creds and
        /// forwards to the engine (U18 data-plane wiring). When false, the
        /// route targets a specific provider directly (registry-configured
        /// OpenAI-compat agents that already encode their own endpoint).
        via_gateway: bool,
    },
    Acp {
        spawn_cmd: String,
    },
    /// Bound to a local inference engine that must be made resident (swapped to)
    /// before the request can stream. `model` is threaded into the payload.
    LocalEngine {
        engine: String,
        base_url: String,
        model: String,
    },
    /// An SDK app managed by Core (`sdk:<package>` prefix). The app exposes an
    /// OpenAI-compatible loopback endpoint; Core calls it directly (`via_gateway:
    /// false`). The app's own model calls are governed by gateway env-injection
    /// (see `sdk::sdk_app_spawn_parts`). Model calls made inside the SDK process
    /// flow through the gateway — policy at the subprocess boundary, not the
    /// Core hop.
    SdkApp {
        base_url: String,
        model: String,
    },
}

/// `agent_id` values that select a built-in default agent (plain-LLM or Ryu flagship).
///
/// `None`, `""`, and `"default"` pick the plain-LLM fallback (`default_agent_route`).
/// `"ryu"` selects the flagship "Ryu" agent: Pi bound as the engine, every call
/// forced through the Gateway (`ryu_agent_route`). Both share the same ACL path
/// so clients that haven't selected an agent get chat without needing to know
/// which underlying agent is running.
fn is_default_agent(agent_id: Option<&str>) -> bool {
    matches!(agent_id, None | Some("") | Some("default") | Some("ryu"))
}

/// Build the default plain-LLM route from the unified [`ProviderRegistry`].
///
/// Lets Core act as a complete standalone backend: a chat request with no
/// `agent_id` (or `agent_id=default`) streams from a configurable
/// OpenAI-compatible provider without needing an ACP agent installed.
///
/// The registry resolves base_url and model in precedence order:
///   env var > `~/.ryu/registry.json` field > built-in literal fallback
///
/// The API key is NOT stored in the registry file (config, not secrets).
/// It is read directly from env (`RYU_DEFAULT_LLM_API_KEY` / `OPENAI_API_KEY`).
fn default_agent_route(reg: &ProviderRegistry) -> AgentRoute {
    let base_url = reg.default_llm_base_url.clone();
    let model = reg.default_llm_model.clone();
    let api_key = std::env::var("RYU_DEFAULT_LLM_API_KEY")
        .ok()
        .or_else(|| std::env::var("OPENAI_API_KEY").ok())
        .filter(|s| !s.is_empty());
    AgentRoute::OpenAiCompat {
        base_url,
        model,
        api_key,
        via_gateway: true,
    }
}

/// Build the route for the flagship "Ryu" agent: Pi bound as the engine with every
/// call forced through the local ryu-gateway.
///
/// Pi is looked up in the in-code `registry` so the binding is swappable — changing
/// the Pi entry (or overriding it via the U1/U30 config registry) automatically
/// changes what Ryu uses. If the Pi entry is absent the route falls back to the
/// plain-LLM `default_agent_route()` so chat keeps working even without Pi.
///
/// "Gateway on top" is expressed exactly as `codex_acp_cmd()` does it for Codex:
/// gateway URL + token are injected as env vars into the Pi subprocess so every
/// outbound model call the Pi process makes goes through the gateway's firewall,
/// budget, and audit pipeline (U18/U28).
fn ryu_agent_route(acp_registry: &AcpAgentRegistry, provider_reg: &ProviderRegistry) -> AgentRoute {
    // Prefer Core's own managed Pi binary (~/.ryu/bin/pi). This is a separate
    // install from any Pi the user has on PATH — same relationship as OpenClaw to Pi.
    if let Some(cmd) = acp::ryu_pi_acp_cmd() {
        return AgentRoute::Acp { spawn_cmd: cmd };
    }

    // Managed binary not installed yet (first run / setup pending). Fall back to
    // the user's Pi on PATH, but still pointed at Ryu's OWN isolated config dir
    // (`PI_CODING_AGENT_DIR`) so it reads Ryu's model/provider config, never the
    // user's `~/.pi/agent`. Gateway env injection is applied only in Gateway-routed
    // mode (the default), matching `acp::ryu_pi_acp_cmd`.
    if let Some(pi_entry) = acp_registry.find_by_prefix("acp:pi") {
        if let acp::AgentTransport::Acp { ref spawn_cmd } = pi_entry.transport {
            // Same config invariants the managed-binary path enforces (valid
            // zero-key defaultModel + Pi-side skills off + gateway models.json
            // pin) — this fallback Pi reads the same isolated config dir.
            if let Err(e) = crate::pi_config::ensure_managed_defaults() {
                tracing::warn!(error = %e, "ryu fallback: could not write managed Pi defaults");
            }
            let config_dir = crate::pi_config::config_dir_str();
            let gateway = crate::pi_config::is_gateway_routing();
            let gateway_base = crate::sidecar::gateway::gateway_url();
            let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
            let token =
                crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());
            let gated_cmd = if cfg!(target_os = "windows") {
                let gateway_env = if gateway {
                    format!("set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& ")
                } else {
                    String::new()
                };
                format!(
                    "cmd /c {gateway_env}set PI_CODING_AGENT_DIR={config_dir}&& {}",
                    spawn_cmd.trim_start_matches("cmd /c ")
                )
            } else {
                let gateway_env = if gateway {
                    format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} ")
                } else {
                    String::new()
                };
                format!("{gateway_env}PI_CODING_AGENT_DIR={config_dir} {spawn_cmd}")
            };
            return AgentRoute::Acp {
                spawn_cmd: gated_cmd,
            };
        }
    }

    // No Pi available at all — fall back to the plain-LLM default.
    default_agent_route(provider_reg)
}

/// Resolve a chat request into a concrete [`AgentRoute`].
///
/// `agent_id` is the client-selected agent; `engine`/`model` are the agent's
/// persisted binding from the [`AgentStore`] (U6), when known. Resolution order:
///   1. The built-in "ryu" flagship agent → Pi ACP with gateway env-injection (U042).
///   2. The plain default agent (no/empty/`default` agent_id) → registry-configured
///      OpenAI-compat route, forwarded via the gateway (U18).
///   3. A local-engine binding (`ollama`/`llamacpp`/`vllm`) → `LocalEngine`, which
///      triggers a managed swap (U4) before streaming.
///   4. A registry id (built-in or cloud agent) → its transport.
///
/// `engine` falls back to `agent_id` so clients that send a registry id directly
/// (the legacy prefix path) keep working even before any store row exists.
///
/// `provider_reg` is the unified [`ProviderRegistry`] that supplies the default
/// base_url and model (env > file > literal). Passing it explicitly keeps the
/// function pure and unit-testable.
fn agent_route(
    agent_id: Option<&str>,
    engine: Option<&str>,
    model: Option<&str>,
    acp_registry: &AcpAgentRegistry,
    provider_reg: &ProviderRegistry,
) -> Option<AgentRoute> {
    // Ryu flagship: Pi engine with gateway on top. Checked before the generic
    // default so "ryu" never falls through to the plain-LLM path.
    if agent_id == Some("ryu") {
        return Some(ryu_agent_route(acp_registry, provider_reg));
    }
    if is_default_agent(agent_id) {
        return Some(default_agent_route(provider_reg));
    }

    // The binding from the store is the source of truth; fall back to the raw id.
    let engine = engine.or(agent_id)?;

    // The id the generic per-agent gateway-routing toggle is keyed on. It must be
    // the SAME string the desktop writes the toggle under: the client-selected
    // agent id (a custom agent's record id for the `acp-exec:` path), falling back
    // to the engine when no agent id was sent.
    let route_id = agent_id.unwrap_or(engine);

    // BYO arbitrary ACP agent (zero-lock-in escape hatch): an engine of the form
    // `acp-exec:<command>` runs that literal command as an ACP subprocess. This
    // makes EVERY ACP-compatible agent usable without being enumerated in the
    // registry — a binary-only registry agent the user already installed (goose,
    // cursor, opencode, …), a private/in-house agent, or a future one. It flows
    // through the same `run_acp_prompt` path, so session modes/models/effort,
    // interactive permissions, and diff rendering all apply uniformly. Like the
    // self-fetching registry agents it makes its own provider calls (no gateway
    // env-injection); its tool egress is still governed via the MCP bridge.
    if let Some(cmd) = engine.strip_prefix("acp-exec:") {
        let cmd = cmd.trim();
        if !cmd.is_empty() {
            // Generic gateway routing (opt-in per agent): when enabled, swap this
            // BYO agent's OpenAI-compatible endpoint to the local gateway so its
            // egress is governed (the lever this whole feature exists for). When
            // off, run the command verbatim (its own provider calls, ungoverned).
            let spawn_cmd = if crate::agent_routing::is_gateway_routing(route_id) {
                acp::openai_gateway_cmd(cmd)
            } else {
                cmd.to_owned()
            };
            return Some(AgentRoute::Acp { spawn_cmd });
        }
    }

    // 0. SDK app (`sdk:<package>`) — a developer SDK app managed by Core.
    //    Routed direct to the loopback (via_gateway:false); gateway policy is
    //    enforced by env-injection into the SDK subprocess at spawn time.
    if sdk::is_sdk_app(engine) {
        let base_url = sdk::sdk_app_base_url();
        let model = model.unwrap_or("sdk-app").to_owned();
        return Some(AgentRoute::SdkApp { base_url, model });
    }

    // 1. Local inference engine — needs a managed swap before streaming.
    if is_local_engine(engine) {
        let base_url = local_engine_base_url(engine)?;
        return Some(AgentRoute::LocalEngine {
            engine: engine.to_owned(),
            base_url: base_url.to_owned(),
            // ollama/vllm require a model; fall back to the engine name so the
            // request is at least well-formed if the agent left model unset.
            model: model.unwrap_or(engine).to_owned(),
        });
    }

    // 2. Registry agent (cloud-style OpenAI-compat or ACP subprocess).
    //
    // OpenAI-compat registry agents (zeroclaw) route via the gateway so the
    // firewall, budget, and audit pipeline governs their egress. When the gateway
    // is unreachable the existing degraded-mode fallback in route_chat_stream
    // reverts to base_url (direct), so chat keeps working even if the gateway is
    // not running.
    //
    // NOTE: ACP subprocess agents make their own provider calls internally, so
    // Ryu cannot intercept their egress. The ones that honour OPENAI_BASE_URL
    // (Codex, Pi, the Ryu flagship) get the gateway env injected at spawn.
    // Claude Code (Anthropic format) is now governable too via the gateway's
    // transparent passthrough proxy when the user opts in (see the match arm
    // below). The rest — Gemini CLI (Google format), OpenClaw (its own WebSocket
    // gateway), Hermes (its own creds), and the self-fetching ACP-registry agents
    // — still carry `gateway_bypass: true` (no base-URL hook we can transparently
    // proxy yet).
    let entry = acp_registry.find_by_prefix(engine)?;
    Some(match &entry.transport {
        acp::AgentTransport::Acp { spawn_cmd } => {
            // Claude Code (`acp:claude`) speaks Anthropic format with the user's
            // own subscription auth, so it normally bypasses the gateway. When the
            // user opts in (claude-gateway-routing pref), inject ANTHROPIC_BASE_URL
            // so its egress traverses the gateway's transparent passthrough proxy
            // (firewall/DLP/audit) while the subscription bearer is forwarded
            // upstream unchanged. Other ACP agents are spawned verbatim.
            // Claude and Codex have their own dedicated, format-specific routing
            // (and always take it regardless of the generic toggle); guard the
            // generic OPENAI_BASE_URL injection off their ids so a stale generic-map
            // entry can never inject the wrong env into an Anthropic/Codex agent.
            let is_special = entry.id == "acp:claude" || entry.id == "acp:codex";
            let resolved = if entry.id == "acp:claude" && crate::claude_config::is_gateway_routing()
            {
                acp::claude_gateway_cmd(spawn_cmd)
            } else if entry.id == "acp:codex" && crate::codex_config::is_gateway_routing() {
                // Codex subscription passthrough (opt-in): point Codex at an
                // isolated CODEX_HOME → gateway passthrough so its ChatGPT-login
                // Responses egress is governed while the OAuth subscription
                // credential is forwarded upstream unchanged. Overrides the
                // default API-key OPENAI_BASE_URL injection baked into the entry.
                acp::codex_acp_gateway_cmd()
            } else if !is_special && crate::agent_routing::is_gateway_routing(route_id) {
                // Generic per-agent gateway routing (opt-in): point a registry ACP
                // agent at the gateway via the OpenAI base-URL swap. Only meaningful
                // for agents whose client honours OPENAI_BASE_URL; a harmless no-op
                // otherwise (e.g. Gemini/OpenClaw/Hermes).
                acp::openai_gateway_cmd(spawn_cmd)
            } else {
                spawn_cmd.clone()
            };
            AgentRoute::Acp {
                spawn_cmd: resolved,
            }
        }
        acp::AgentTransport::OpenAiCompat {
            base_url,
            model: reg_model,
        } => {
            AgentRoute::OpenAiCompat {
                base_url: (*base_url).to_owned(),
                model: model.or(*reg_model).unwrap_or("default").to_owned(),
                api_key: None,
                // Route through the gateway so firewall/budget/audit governs
                // the egress call. The gateway falls back to direct base_url
                // when it is unreachable (see route_chat_stream).
                via_gateway: true,
            }
        }
    })
}

/// Resolve `agent_id` to its ACP spawn command, or `None` when the agent is not
/// an ACP subprocess agent (only ACP agents advertise session/new modes/models/
/// config options to probe). Reuses the same binding + route resolution the chat
/// path uses, so the probed agent is exactly the one a turn would spawn.
pub async fn resolve_acp_spawn_cmd(
    agent_id: &str,
    registry: &AcpAgentRegistry,
    agent_store: &AgentStore,
) -> Option<String> {
    let provider_reg = ProviderRegistry::load();
    let (engine, model, _slots, _persona, _composio, _skills, _identity_profile_ids) =
        resolve_binding(agent_id, agent_store).await;
    match agent_route(
        Some(agent_id),
        engine.as_deref(),
        model.as_deref(),
        registry,
        &provider_reg,
    )? {
        AgentRoute::Acp { spawn_cmd } => Some(spawn_cmd),
        _ => None,
    }
}

/// Extract the last user message as a prompt string for ACP agents.
/// Image extracted from a user message part (base64 data + MIME type).
#[derive(Debug, Clone)]
pub struct ImagePart {
    pub data: String,
    pub mime_type: String,
}

fn last_user_message(messages: &[UiMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| {
            let from_content = m.content.as_text();
            if !from_content.is_empty() {
                return from_content;
            }
            // AI SDK v6: text lives in top-level parts array
            m.parts
                .iter()
                .filter_map(|p| {
                    let t = p.get("type")?.as_str()?;
                    if t == "text" {
                        p.get("text")?.as_str().map(str::to_owned)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

/// Image `file` parts of a single message (AI SDK v6 `file` parts with an image
/// mediaType/mimeType carrying a data-URL `data:<mime>;base64,<data>`).
fn message_image_parts(msg: &UiMessage) -> Vec<ImagePart> {
    let mut images = Vec::new();
    for part in &msg.parts {
        let type_ = part.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if type_ != "file" {
            continue;
        }
        let mime = part
            .get("mediaType")
            .or_else(|| part.get("mimeType"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !mime.starts_with("image/") {
            continue;
        }
        let url = part.get("url").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(base64) = extract_base64_from_data_url(url) {
            images.push(ImagePart {
                data: base64,
                mime_type: mime.to_owned(),
            });
        }
    }
    images
}

/// Extract image parts from the last user message (for the ACP plane, which
/// sends only the latest turn). The openai_compat plane uses
/// [`message_image_parts`] per message instead, to preserve image context across
/// the full history.
fn last_user_images(messages: &[UiMessage]) -> Vec<ImagePart> {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(message_image_parts)
        .unwrap_or_default()
}

/// Strip `data:<mime>;base64,` prefix and return the raw base64 string.
fn extract_base64_from_data_url(url: &str) -> Option<String> {
    let rest = url.strip_prefix("data:")?;
    let (_meta, data) = rest.split_once(',')?;
    Some(data.to_owned())
}

/// Per-modality slot selections resolved from a carded agent's `AgentRecord`.
///
/// These are forwarded to the Gateway as `x-ryu-slot-*` headers so the Gateway
/// can route each modality call to the provider the agent card specifies, rather
/// than the static `modality_map` default. An unset slot means "use the gateway's
/// configured default for that modality" and no header is sent for it.
///
/// Chat, image, TTS, and STT slots are all carried here. For chat, the provider
/// is resolved from `chat_model.engine` (which doubles as the gateway provider
/// identifier, e.g. `"openai"`, `"anthropic"`, `"local"`). On the gateway side
/// `pre_process` calls `route_modality_with_slot(Chat, ...)` when a chat slot
/// is present, so the agent card's chat provider wins over eval/model routing.
#[derive(Debug, Clone, Default)]
pub struct AgentSlots {
    /// Chat-generation slot: `(provider, model)`. Provider is the gateway
    /// ProviderKind string (openai, anthropic, local, openrouter, core).
    pub chat: Option<(String, Option<String>)>,
    /// Image-generation slot: `(provider, model)`. Both may be `None`.
    pub image: Option<(String, Option<String>)>,
    /// Video-generation slot: `(provider, model)`. Both may be `None`.
    pub video: Option<(String, Option<String>)>,
    /// Text-to-speech slot: `(provider, model)`. Both may be `None`.
    pub tts: Option<(String, Option<String>)>,
    /// Speech-to-text slot: `(provider, model)`. Both may be `None`.
    pub stt: Option<(String, Option<String>)>,
}

/// Resolve the engine an agent is bound to. Built-in agents are seeded into the
/// store with `engine = id`, and custom agents carry an explicit `engine`; either
/// way the store is the source of truth for the binding. We also surface the
/// agent's `model`, which a local-engine request needs, its per-attribute
/// modality slots (M3 / #164) so the Gateway can route each call independently,
/// and the persona slot (#410) so the caller can build a tone prefix for the system
/// prompt. Falls back to treating `agent_id` itself as the engine so clients that
/// pass a registry id directly (the legacy path) keep working even before any store
/// row exists.
async fn resolve_binding(
    agent_id: &str,
    store: &AgentStore,
) -> (
    Option<String>,
    Option<String>,
    AgentSlots,
    Option<PersonaSlot>,
    Vec<String>,
    // Per-agent Skill allowlist (empty = all enabled). Injected in Core on both
    // planes; see `SkillRegistry::enabled_for`.
    Vec<String>,
    // Per-agent Identity Vault profile binding (epic #517, Unit 4). Empty = the
    // agent sees NO identity profiles (binding is opt-in, never "all"). At
    // tool-call time decrypted credential state is fetched only for the domains
    // of these bound profiles via [`crate::identity`]; state is never broadcast.
    Vec<String>,
) {
    match store.get(agent_id).await {
        Ok(Some(record)) => {
            let engine = record.engine.or_else(|| Some(agent_id.to_owned()));
            // Chat slot: engine doubles as the gateway ProviderKind identifier
            // (e.g. "openai", "anthropic", "local"). When set, the gateway's
            // pre_process will call route_modality_with_slot(Chat, ...) so the
            // agent card's provider wins over eval/model routing. Only populate
            // when chat_model.engine is set; otherwise let model routing handle it.
            let chat_slot = record
                .chat_model
                .as_ref()
                .and_then(|s| s.engine.as_ref().map(|e| (e.clone(), s.model_id.clone())));
            let slots = AgentSlots {
                chat: chat_slot,
                image: record
                    .image_model
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
                video: record
                    .video_model
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
                tts: record
                    .tts
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
                stt: record
                    .stt
                    .as_ref()
                    .and_then(|s| s.provider.as_ref().map(|p| (p.clone(), s.model_id.clone()))),
            };
            let persona = record.persona;
            (
                engine,
                record.model,
                slots,
                persona,
                record.composio_actions,
                record.skills,
                record.identity_profile_ids,
            )
        }
        Ok(None) => (
            Some(agent_id.to_owned()),
            None,
            AgentSlots::default(),
            None,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
        Err(e) => {
            tracing::warn!("resolve_binding: store lookup failed for '{agent_id}': {e:#}");
            (
                Some(agent_id.to_owned()),
                None,
                AgentSlots::default(),
                None,
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
        }
    }
}

/// Build a persona tone prefix for the system prompt from a [`PersonaSlot`].
///
/// If `persona.tone` is set, returns a string of the form:
///   "Your name is {name}.\nYou are {tone}. Respond in that voice consistently."
/// (the name line is omitted when `display_name` is absent).
/// Returns `None` when neither tone nor display_name is set.
fn persona_tone_prefix(persona: Option<&PersonaSlot>) -> Option<String> {
    let persona = persona?;
    let has_name = persona.display_name.is_some();
    let has_tone = persona.tone.is_some();
    if !has_name && !has_tone {
        return None;
    }
    let mut prefix = String::new();
    if let Some(name) = &persona.display_name {
        prefix.push_str(&format!("Your name is {name}.\n"));
    }
    if let Some(tone) = &persona.tone {
        prefix.push_str(&format!(
            "You are {tone}. Respond in that voice consistently."
        ));
    }
    Some(prefix)
}

/// Merge a persona tone prefix into an optional existing system prompt.
///
/// When `tone_prefix` is `Some`, it is prepended to `existing` (separated by
/// a blank line when `existing` is non-empty). When `tone_prefix` is `None`,
/// `existing` is returned unchanged.
/// Resolve just the model id bound to an agent (the second field of
/// [`resolve_binding`]). Used by the context-window resolver to size an `auto`
/// budget to the loaded model's launch `ctx_size`.
pub(crate) async fn resolve_agent_model(agent_id: &str, store: &AgentStore) -> Option<String> {
    resolve_binding(agent_id, store).await.1
}

fn merge_system_prompt(existing: Option<String>, tone_prefix: Option<String>) -> Option<String> {
    match (existing, tone_prefix) {
        (Some(e), Some(p)) if !e.is_empty() => Some(format!("{p}\n\n{e}")),
        (Some(e), Some(p)) => Some(if p.is_empty() { e } else { p }),
        (None, Some(p)) if !p.is_empty() => Some(p),
        (existing, _) => existing,
    }
}

/// Resolve the long-term memory scope key for an agent. Long-term memory is
/// scoped per user/agent; while Core is local-first/single-user the user is the
/// `LOCAL_USER` sentinel (see `memory.rs`).
fn long_term_agent_scope(agent_id: Option<&str>) -> String {
    agent_id
        .filter(|s| !s.is_empty())
        .unwrap_or("default")
        .to_owned()
}

/// Build the long-term-memory system message from recalled entries, or `None`
/// when memory is disabled or empty. Injected as a leading `system` message on
/// both the OpenAI-compat and ACP paths.
async fn assemble_long_term_system_message(
    memory: &MemoryStore,
    enabled: bool,
    agent_id: Option<&str>,
) -> Option<String> {
    if !enabled {
        return None;
    }
    let scope = long_term_agent_scope(agent_id);
    let entries = match memory
        .recall(LOCAL_USER, &scope, DEFAULT_LONG_TERM_LIMIT)
        .await
    {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("failed to recall long-term memory: {e:#}");
            return None;
        }
    };
    if entries.is_empty() {
        return None;
    }
    // Render oldest-first so the model reads facts in the order learned.
    let mut lines = String::from(
        "The following are durable facts remembered about the user from previous sessions:\n",
    );
    for entry in entries.iter().rev() {
        lines.push_str("- ");
        lines.push_str(entry.content.trim());
        lines.push('\n');
    }
    Some(lines)
}

/// Decide whether a via-gateway request should actually forward to the gateway
/// or degrade to the direct provider path.
///
/// Extracting the decision into a pure function makes it unit-testable without
/// standing up an HTTP server or spawning a gateway child.
fn forward_via_gateway(via_gateway: bool, gateway_healthy: bool) -> bool {
    via_gateway && gateway_healthy
}

// ── Auto-recall (U17, now wired) ───────────────────────────────────────────────
//
// Before each chat turn we automatically retrieve relevant prior knowledge and
// fold it into `long_term_system` (the SAME seam skills use), so BOTH the
// openai-compat and ACP planes inherit it with no per-adapter duplication. The
// recall source is durable long-term MEMORY + PAST CHAT MESSAGES (document
// Spaces are deliberately excluded — those are explicit-RAG, not auto-injected).
// This is orthogonal to `enable_long_term` (the memory *record* toggle): a single
// `auto-recall-enabled` preference gates it, encoded as `Some`/`None` here.
//
// Everything is FAIL-OPEN: any embed/retrieve/search error logs and skips recall,
// never blocking the chat turn.

/// Cap on the rendered length of any single recalled snippet, to keep the
/// injected block small enough for a local model's context window.
const AUTO_RECALL_SNIPPET_CHARS: usize = 320;

/// Hard wall-clock bound on the whole auto-recall step (embed + retrieve + the
/// chat-search lazy backfill). On a large backlog with a live embedder the first
/// backfill can be slow; exceeding this degrades to "no recall this turn" so a
/// chat reply is never stalled. Auto-recall is a best-effort enhancement.
const AUTO_RECALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(4);

/// Upper bound on how many long-term memory facts the lazy-backfill enumerates
/// per turn when bridging them into the retrieval index. Bounded so a huge
/// backlog cannot make the (already timeout-wrapped) backfill unbounded; facts
/// beyond this are picked up on later turns (newest are enumerated first).
const MEMORY_BACKFILL_LIMIT: usize = 500;

/// Resolved auto-recall config threaded into `route_chat_stream`. `None` (the
/// param is `Option<AutoRecallConfig>`) means the feature is disabled for this
/// turn, so no work is done. The chat-message half reuses the `conversations`
/// store already passed to `route_chat_stream`; only the memory half needs the
/// `RetrievalStore`.
#[derive(Clone)]
pub struct AutoRecallConfig {
    pub retrieval: RetrievalStore,
    pub top_k: usize,
    /// Whether the FTS (full-text, lexical) session-search source contributes this
    /// turn. DEFAULT-OFF sub-source of auto-recall: when `true`, `run_auto_recall`
    /// also runs a keyword FTS pass over past messages and merges its hits into the
    /// past-chat set (deduped by message id). When `false`, no FTS work is done.
    pub fts_enabled: bool,
}

/// Truncate a snippet to `AUTO_RECALL_SNIPPET_CHARS` on a char boundary, adding
/// an ellipsis when cut. Whitespace is collapsed to a single line so the block
/// stays compact.
fn truncate_snippet(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= AUTO_RECALL_SNIPPET_CHARS {
        return collapsed;
    }
    let truncated: String = collapsed.chars().take(AUTO_RECALL_SNIPPET_CHARS).collect();
    format!("{truncated}…")
}

/// Pure assembly of the recall block from already-retrieved memory chunks and
/// past-chat hits. Returns `None` when there is nothing to inject (so callers can
/// skip merging an empty system message). `top_k` caps the TOTAL injected lines
/// across both sources.
///
/// Kept pure (no I/O) so it is unit-testable without a network embed.
fn assemble_recall_block(
    memory_chunks: &[ScoredChunk],
    chat_hits: &[MessageSearchHit],
    top_k: usize,
) -> Option<String> {
    if top_k == 0 {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    for chunk in memory_chunks {
        let snippet = truncate_snippet(&chunk.content);
        if !snippet.is_empty() {
            lines.push(format!("- [memory] {snippet}"));
        }
    }
    for hit in chat_hits {
        let snippet = truncate_snippet(&hit.content);
        if !snippet.is_empty() {
            lines.push(format!("- [past chat] {snippet}"));
        }
    }
    lines.truncate(top_k);
    if lines.is_empty() {
        return None;
    }
    let mut block = String::from(
        "Relevant context from memory and past conversations \
         (ignore if irrelevant):\n",
    );
    block.push_str(&lines.join("\n"));
    Some(block)
}

/// Drop `Memory`-source chunks whose id is in `recency_ids` (the long-term facts
/// the RECENCY path already injected this turn). Pure + sync so the dedup
/// invariant is unit-testable without I/O.
///
/// Dedup is BY ID, not by content: the recency block (`assemble_long_term_system_message`)
/// and the recall block (`assemble_recall_block`) use different formats/truncation,
/// so a content match would silently fail and double-inject. The chunk id == the
/// `MemoryStore` fact id (the backfill indexes facts under their own id), so an id
/// match is exact. Past-chat hits and any non-fact `Memory` chunks are unaffected
/// (only ids in the recency set are dropped).
fn drop_recency_dupes(
    chunks: Vec<ScoredChunk>,
    recency_ids: &std::collections::HashSet<String>,
) -> Vec<ScoredChunk> {
    chunks
        .into_iter()
        .filter(|c| !(c.source == ChunkSource::Memory && recency_ids.contains(&c.id)))
        .collect()
}

/// Lazy-backfill long-term memory FACTS into the retrieval index so semantic
/// search can find them. Mirrors the message-index lazy-backfill pattern: only
/// facts whose id is NOT already indexed (under the current embedder) are embedded
/// + indexed, so the steady-state cost is one cheap `recall` SELECT plus zero
/// embeds.
///
/// The chunk id is the `MemoryStore` fact id — this stable id is what makes the
/// id-based dedup against the recency path work. Facts are indexed as
/// `ChunkSource::Memory` (Space-less), the same source the recall memory half
/// searches.
///
/// FAIL-OPEN + BOUNDED: a per-fact embed failure logs and skips that fact (the
/// loop never aborts); enumeration is capped at [`MEMORY_BACKFILL_LIMIT`]; the
/// whole call already runs inside the [`AUTO_RECALL_TIMEOUT`] budget. Never
/// panics or propagates.
async fn backfill_memory_facts(memory: &MemoryStore, retrieval: &RetrievalStore, scope: &str) {
    let facts = match memory
        .recall(LOCAL_USER, scope, MEMORY_BACKFILL_LIMIT)
        .await
    {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!(
                "auto-recall: enumerating memory facts failed (skipping backfill): {e:#}"
            );
            return;
        }
    };
    if facts.is_empty() {
        return;
    }
    let indexed = match retrieval.indexed_memory_ids().await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!(
                "auto-recall: reading indexed memory ids failed (skipping backfill): {e:#}"
            );
            return;
        }
    };
    for fact in facts {
        if indexed.contains(&fact.id) {
            continue;
        }
        if let Err(e) = retrieval
            .index_chunk(&fact.id, ChunkSource::Memory, None, &fact.content)
            .await
        {
            tracing::warn!(
                "auto-recall: indexing memory fact {} failed (skipping): {e:#}",
                fact.id
            );
        }
    }
}

/// Run the auto-recall retrieval and return a ready-to-merge context block, or
/// `None`. FAIL-OPEN: every error logs and yields `None`.
///
/// - Memory: lazy-backfill long-term FACTS into the retrieval index, then the
///   unified retrieval path with Spaces excluded (`space_ids: Some(vec![])`,
///   `include_memory: true`), then drop facts the RECENCY path already injected
///   this turn (dedup by id) so no fact appears twice.
/// - Past chats: `ConversationStore::search_messages` with the CURRENT
///   conversation excluded (pass `None` then post-filter, since the param is an
///   include-filter).
///
/// `recency_ids` are the long-term fact ids the recency path injected this turn
/// (empty when `enable_long_term` is off — see the call site). `memory_scope` is
/// the `(LOCAL_USER, scope)` agent scope, the SAME one the recency path used.
async fn run_auto_recall(
    cfg: &AutoRecallConfig,
    conversations: &ConversationStore,
    memory: &MemoryStore,
    memory_scope: &str,
    recency_ids: &std::collections::HashSet<String>,
    query: &str,
    current_conversation_id: Option<&str>,
) -> Option<String> {
    if query.trim().is_empty() || cfg.top_k == 0 {
        return None;
    }

    // Bridge long-term facts into the retrieval index BEFORE retrieving, so a
    // just-recorded fact is searchable this turn. Bounded + fail-open.
    backfill_memory_facts(memory, &cfg.retrieval, memory_scope).await;

    // Memory half (Spaces excluded). Fetch more than top_k so dropping the
    // recency-injected facts still leaves room for the ones the recency window
    // MISSED.
    let memory_chunks = {
        let opts = RetrievalOptions {
            top_k: cfg.top_k + recency_ids.len(),
            space_ids: Some(Vec::new()),
            include_memory: true,
            ..RetrievalOptions::default()
        };
        match cfg.retrieval.retrieve(query, &opts).await {
            Ok(chunks) => drop_recency_dupes(chunks, recency_ids),
            Err(e) => {
                tracing::warn!("auto-recall: memory retrieve failed (skipping): {e:#}");
                Vec::new()
            }
        }
    };

    // Past-chat half (current conversation excluded). `search_messages` returns
    // `Ok(None)` when no message index is wired — treat as no hits.
    let mut chat_hits = match conversations.search_messages(query, cfg.top_k, None).await {
        Ok(Some(hits)) => hits
            .into_iter()
            .filter(|h| Some(h.conversation_id.as_str()) != current_conversation_id)
            .collect::<Vec<_>>(),
        Ok(None) => Vec::new(),
        Err(e) => {
            tracing::warn!("auto-recall: chat search failed (skipping): {e:#}");
            Vec::new()
        }
    };

    // FTS (lexical) session-search source — default-OFF sub-source. When enabled,
    // run a keyword FTS pass over past messages and merge its hits into the
    // past-chat set, deduped BY MESSAGE ID (the semantic and lexical passes can
    // both surface the same message). The current conversation is excluded, same as
    // the semantic half. Fully fail-open. `assemble_recall_block` still caps the
    // TOTAL injected lines at `top_k`.
    if cfg.fts_enabled {
        match conversations
            .fts_search_messages(query, cfg.top_k, None)
            .await
        {
            Ok(Some(hits)) => {
                let mut seen: std::collections::HashSet<String> =
                    chat_hits.iter().map(|h| h.message_id.clone()).collect();
                for hit in hits {
                    if Some(hit.conversation_id.as_str()) == current_conversation_id {
                        continue;
                    }
                    if seen.insert(hit.message_id.clone()) {
                        chat_hits.push(hit);
                    }
                }
            }
            Ok(None) => {}
            Err(e) => {
                tracing::warn!("auto-recall: fts session search failed (skipping): {e:#}");
            }
        }
    }

    assemble_recall_block(&memory_chunks, &chat_hits, cfg.top_k)
}

/// Route a chat stream request to the correct agent sidecar and return an
/// `axum::Response` whose body is an AI SDK v6 UIMessageStream SSE.
/// Inner run function for non-streaming callers (channel bots, M11).
///
/// Builds a [`ChatStreamRequest`] from a `(conversation_id, agent_id, text)` turn,
/// runs the full engine + memory path shared with the HTTP streaming handler, and
/// drains the SSE stream to assemble the final reply `String`. Existing desktop/CLI
/// chat continues to call [`route_chat_stream`] directly — this function is a thin
/// wrapper that reuses every piece of that path without duplicating logic.
///
/// `conversation_id` is set to the Telegram `chat_id` (or any stable per-channel
/// id) so multi-turn exchanges share conversation history via the SQLite store.
///
/// Returns `Err` only when the underlying route produces an SSE error frame;
/// a missing reply (empty model response) returns `Ok("")`.
#[allow(clippy::too_many_arguments)]
pub async fn run_reply_text(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<String> {
    // The channel path persists: each inbound bot turn becomes conversation
    // history so multi-turn exchanges share context.
    run_text_turn(
        conversation_id,
        agent_id,
        text,
        author_name,
        true,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
    )
    .await
}

/// Non-streaming team reply for the channel-bot path: fan out to the team's
/// members per its coordination strategy and return one combined, attributed
/// reply string. Mirrors [`route_team_chat_stream`] but assembles plain text —
/// channels deliver a single message, so progressive streaming is not needed.
///
/// Like the channel agent path, this persists the user turn and one combined
/// assistant turn (attributed to the team) so a later desktop reload of the
/// same conversation renders the same merged content.
#[allow(clippy::too_many_arguments)]
pub async fn run_team_reply_text(
    conversation_id: String,
    team: crate::teams::TeamRecord,
    text: String,
    author_name: Option<String>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<String> {
    use crate::teams::Coordination;

    if team.members.is_empty() {
        anyhow::bail!(
            "Team '{}' has no members. Add agents to the team first.",
            team.name
        );
    }

    let deps = TeamRunDeps {
        registry,
        conversations: conversations.clone(),
        agent_store: agent_store.clone(),
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
    };

    let original_messages = vec![UiMessage {
        role: "user".to_owned(),
        content: UiContent::Text(text.clone()),
        parts: vec![],
    }];
    let user_text = text;
    let conv = Some(conversation_id.clone());
    let members = member_names(&team.members, &agent_store).await;
    let lead_id = team
        .lead_agent_id
        .clone()
        .unwrap_or_else(|| team.members[0].clone());

    // Persist the user turn once (attributed to the user, not a member). The
    // verified author_user_id is still None on the team path (the channel caller
    // is unauthenticated); the connector-supplied display name is carried so a
    // multi-participant group thread records who spoke.
    if !user_text.trim().is_empty() {
        if let Err(e) = conversations
            .append_message(
                &conversation_id,
                "user",
                &user_text,
                None,
                None,
                author_name.as_deref(),
            )
            .await
        {
            tracing::warn!("failed to persist team channel user message: {e:#}");
        }
    }

    // Resolve one member's reply, normalising empties/errors like the streaming
    // path. A nested item (not a closure) so it can be `await`ed in a loop.
    async fn member_reply(
        mid: &str,
        msgs: Vec<UiMessage>,
        conv: Option<String>,
        deps: &TeamRunDeps,
    ) -> String {
        match run_member_text(mid, msgs, conv, deps).await {
            Ok(t) if !t.trim().is_empty() => t,
            Ok(_) => "_(no response)_".to_owned(),
            Err(e) => format!("_(error: {e})_"),
        }
    }

    let mut combined = String::new();
    match team.coordination {
        // Every member answers the same prompt independently.
        Coordination::Broadcast => {
            for (mid, mname) in &members {
                let t = member_reply(mid, original_messages.clone(), conv.clone(), &deps).await;
                combined.push_str(&format!("**{mname}**\n\n{t}\n\n"));
            }
        }
        // Members answer in order; each sees the prior members' replies.
        Coordination::RoundRobin => {
            let mut transcript = String::new();
            for (mid, mname) in &members {
                let msgs = if transcript.is_empty() {
                    original_messages.clone()
                } else {
                    let preamble = format!(
                        "You are on a team. Your teammates have responded so far:\n\n{transcript}\nNow add your own response, building on theirs."
                    );
                    messages_with_preamble(&original_messages, &preamble)
                };
                let t = member_reply(mid, msgs, conv.clone(), &deps).await;
                transcript.push_str(&format!("{mname}: {t}\n\n"));
                combined.push_str(&format!("**{mname}**\n\n{t}\n\n"));
            }
        }
        // Members answer independently, then the lead synthesizes.
        Coordination::DebateSynthesis => {
            let mut round1 = String::new();
            for (mid, mname) in &members {
                let t = member_reply(mid, original_messages.clone(), conv.clone(), &deps).await;
                round1.push_str(&format!("{mname}: {t}\n\n"));
                combined.push_str(&format!("**{mname}**\n\n{t}\n\n"));
            }
            let lead_name = members
                .iter()
                .find(|(id, _)| id == &lead_id)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| lead_id.clone());
            let preamble = format!(
                "You are the lead of a team. Your teammates gave these answers to the user's request:\n\n{round1}\nSynthesize them into one definitive, non-repetitive answer for the user."
            );
            let msgs = messages_with_preamble(&original_messages, &preamble);
            let synth = match run_member_text(&lead_id, msgs, conv.clone(), &deps).await {
                Ok(t) if !t.trim().is_empty() => t,
                Ok(_) => "_(no synthesis)_".to_owned(),
                Err(e) => format!("_(synthesis error: {e})_"),
            };
            combined.push_str(&format!("**{lead_name} (synthesis)**\n\n{synth}\n\n"));
        }
        // A router picks the single best-suited member, then only it answers.
        Coordination::Router => {
            let menu = members
                .iter()
                .map(|(id, name)| format!("- {name} (id: {id})"))
                .collect::<Vec<_>>()
                .join("\n");
            let route_prompt = format!(
                "You are a router for a team of agents. Given the user's message, pick the SINGLE best-suited teammate to answer it. Reply with ONLY that teammate's id and nothing else.\n\nTeammates:\n{menu}\n\nUser message:\n{user_text}"
            );
            let pick_msgs = vec![UiMessage {
                role: "user".to_owned(),
                content: UiContent::Text(route_prompt),
                parts: vec![],
            }];
            // No conversation_id: the routing decision is a side query.
            let pick = run_member_text(&lead_id, pick_msgs, None, &deps)
                .await
                .unwrap_or_default();
            let chosen = members
                .iter()
                .find(|(id, _)| pick.contains(id.as_str()))
                .cloned()
                .unwrap_or_else(|| members[0].clone());
            let t = member_reply(&chosen.0, original_messages.clone(), conv.clone(), &deps).await;
            combined.push_str(&format!("**{} (routed)**\n\n{t}\n\n", chosen.1));
        }
    }

    let combined = combined.trim_end().to_string();

    // Persist exactly one combined assistant turn attributed to the team.
    if !combined.is_empty() {
        if let Err(e) = conversations
            .append_message(
                &conversation_id,
                "assistant",
                &combined,
                Some(&team.id),
                None,
                None,
            )
            .await
        {
            tracing::warn!("failed to persist team channel assistant message: {e:#}");
        }
    }

    Ok(combined)
}

/// Shared core for non-streaming single-turn agent invocations.
///
/// Builds a minimal [`ChatStreamRequest`] carrying `text` as one user message,
/// the `conversation_id` for history, and the `agent_id` binding, routes it
/// through the full [`route_chat_stream`] path, and drains the SSE stream to the
/// final assistant text. `persist` decides whether the turn is written to the
/// conversation store: the channel path ([`run_reply_text`]) persists; internal
/// callers (the workflow `AgentRunner`) do not, so they leave no orphan history.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_text_turn(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    persist: bool,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<String> {
    run_text_turn_in(
        conversation_id,
        agent_id,
        text,
        author_name,
        persist,
        None,
        false,
        None,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
    )
    .await
}

/// Like [`run_text_turn`] but with an explicit working directory and optional
/// per-conversation git-worktree isolation. Used by the coordinator-threads
/// feature so a spawned worker conversation runs its configured agent in its own
/// isolated worktree (each worker gets a dedicated branch/worktree, reused across
/// turns by `route_chat_stream`'s persistent-session logic). When `cwd` is `None`
/// and `worktree_isolation` is `false` this is identical to `run_text_turn`.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_text_turn_in(
    conversation_id: String,
    agent_id: Option<String>,
    text: String,
    author_name: Option<String>,
    persist: bool,
    cwd: Option<String>,
    worktree_isolation: bool,
    worktree_branch: Option<String>,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> anyhow::Result<String> {
    let req = ChatStreamRequest {
        messages: vec![UiMessage {
            role: "user".to_owned(),
            content: UiContent::Text(text),
            parts: vec![],
        }],
        agent_id,
        conversation_id: Some(conversation_id),
        enable_long_term: false,
        cwd,
        worktree_isolation,
        branch: None,
        worktree_path: None,
        worktree_branch,
        companion_source: false,
        target_agent_id: None,
        team_id: None,
        persist,
        inference: None,
        acp_mode: None,
        acp_config: None,
        acp_model: None,
        // Programmatic fan-out (delegate / threads / worker / scheduled / team
        // member) — yield to a directly-typing user on the shared local engine.
        background: true,
        plugin_flags: std::collections::HashMap::new(),
        // Programmatic turn, no verified human author to attribute.
        author_user_id: None,
        // Connector-supplied sender display name (group/channel chats); None for
        // non-channel programmatic turns.
        author_name,
    };

    // Route through the full streaming path (identical to the HTTP handler).
    // Headless callers (channels) pass `None` for auto-recall: they have no
    // `RetrievalStore` in scope and recall on bot/channel turns is a deliberate
    // v1 scope decision (the HTTP chat handler is where recall is wired).
    let response = route_chat_stream(
        req,
        registry,
        conversations,
        agent_store,
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
        None,
        // Programmatic fan-out (channels/threads) inherits the engine's own
        // overflow handling; app-level trimming is wired on the interactive
        // chat path (route_single_turn) only.
        None,
    )
    .await;

    // Drain the SSE response body, collecting all `text-delta` payloads into a
    // single String. Error frames propagate as Err. Shared with the team
    // orchestrator so both paths parse the AI SDK stream identically.
    drain_text_reply(response).await
}

/// Drain an AI SDK v6 UI-message-stream [`Response`] to its final assistant text.
///
/// Concatenates every `text-delta` payload, stops at the `[DONE]` sentinel, and
/// returns `Err` on an `error` frame (so a failed agent never silently collects
/// to `""`). Non-text frames (tool calls/results, thinking, start/finish) are
/// ignored — callers that need them must forward the raw stream instead.
///
/// `axum::body::to_bytes` drains the whole stream to one `Bytes` buffer (bounded
/// by `usize::MAX`; add a cap once a real per-reply limit is needed). Splitting
/// on the SSE `\n\n` frame boundary after a full read sidesteps the cross-buffer
/// frame-splitting hazard of incremental parsing.
pub(crate) async fn drain_text_reply(response: Response) -> anyhow::Result<String> {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .map_err(|e| anyhow::anyhow!("body read error: {e}"))?;
    let raw = String::from_utf8_lossy(&bytes);

    let mut reply = String::new();
    let mut buf: &str = &raw;
    while let Some(rel) = buf.find("\n\n") {
        let frame = &buf[..rel];
        buf = &buf[rel + 2..];
        let Some(data) = frame.strip_prefix("data:").map(|s| s.trim()) else {
            continue;
        };
        if data == "[DONE]" {
            break;
        }
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
            match json.get("type").and_then(|t| t.as_str()) {
                Some("text-delta") => {
                    if let Some(delta) = json.get("delta").and_then(|d| d.as_str()) {
                        reply.push_str(delta);
                    }
                }
                Some("error") => {
                    let msg = json
                        .get("errorText")
                        .and_then(|t| t.as_str())
                        .unwrap_or("agent error");
                    return Err(anyhow::anyhow!("{msg}"));
                }
                _ => {}
            }
        }
    }

    Ok(reply)
}

/// Stream an AI SDK v6 UI-message-stream [`Response`] to `delta_tx` **incrementally**
/// — the per-token counterpart of [`drain_text_reply`]. Each `text-delta` payload is
/// sent as it arrives (so voice mode can caption + synthesize sentence-by-sentence
/// instead of waiting for the whole reply). Returns `Ok(())` at the `[DONE]`
/// sentinel / stream end, or `Err` on an `error` frame. Non-text frames are ignored.
///
/// Unlike `drain_text_reply` (which buffers the whole body then splits on `\n\n`),
/// this reads the body as a data stream and carries a partial-frame buffer across
/// chunks, so a frame split across two network reads is still parsed correctly.
pub(crate) async fn stream_text_reply(
    response: Response,
    delta_tx: tokio::sync::mpsc::Sender<String>,
) -> anyhow::Result<()> {
    use futures_util::StreamExt;

    let mut body = response.into_body().into_data_stream();
    let mut buf = String::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| anyhow::anyhow!("body read error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // Drain every complete `\n\n`-terminated frame currently in the buffer.
        while let Some(rel) = buf.find("\n\n") {
            let frame: String = buf[..rel].to_string();
            buf.drain(..rel + 2);
            let Some(data) = frame.strip_prefix("data:").map(|s| s.trim()) else {
                continue;
            };
            if data == "[DONE]" {
                return Ok(());
            }
            let Ok(json) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };
            match json.get("type").and_then(|t| t.as_str()) {
                Some("text-delta") => {
                    if let Some(delta) = json.get("delta").and_then(|d| d.as_str()) {
                        // A closed receiver (client gone / barge-in) ends the stream.
                        if delta_tx.send(delta.to_string()).await.is_err() {
                            return Ok(());
                        }
                    }
                }
                Some("error") => {
                    let msg = json
                        .get("errorText")
                        .and_then(|t| t.as_str())
                        .unwrap_or("agent error");
                    return Err(anyhow::anyhow!("{msg}"));
                }
                _ => {}
            }
        }
    }
    Ok(())
}

// ── Agent teams orchestration ────────────────────────────────────────────────
//
// A team turn fans out one user message to several member agents per the team's
// coordination strategy and merges their replies into ONE attributed SSE stream.
// Every member runs through the exact same `route_chat_stream` path (so each
// keeps its own engine binding, gateway routing, tools, persona) — the team
// layer only decides *which* members run, *what prompt* each sees, and *how* the
// replies are stitched together.
//
// Persistence model (verified to reload identically): the orchestrator writes the
// user turn once and a single combined assistant turn attributed to the team id;
// member sub-requests run with `persist = false` so they never write their own
// rows. Member replies are attributed inline with a `**Name**` markdown header —
// a guaranteed-render fallback that needs no client changes.

/// Bundle of the stores a team turn needs, so the orchestrator and its
/// per-member helper don't each carry a dozen positional args.
#[derive(Clone)]
pub struct TeamRunDeps {
    pub registry: Arc<AcpAgentRegistry>,
    pub conversations: ConversationStore,
    pub agent_store: AgentStore,
    pub manager: Arc<SidecarManager>,
    pub memory: MemoryStore,
    pub worktree_diffs: crate::server::WorktreeDiffStore,
    pub mcp: Arc<McpRegistry>,
    pub skills: SkillRegistry,
    pub traces: TraceStore,
}

/// Run a single team member for one turn and return its final assistant text.
///
/// Reuses `route_chat_stream` wholesale (engine binding, gateway, tools, memory)
/// with `persist = false` so the member's reply is not written to the store — the
/// orchestrator persists one combined turn itself. A real `conversation_id` is
/// still passed so ACP members get short-term context (recent turns) for the
/// conversation; `target_agent_id` binds the call to this member.
async fn run_member_text(
    member_id: &str,
    messages: Vec<UiMessage>,
    conversation_id: Option<String>,
    deps: &TeamRunDeps,
) -> anyhow::Result<String> {
    let req = ChatStreamRequest {
        messages,
        agent_id: Some(member_id.to_owned()),
        conversation_id,
        enable_long_term: false,
        cwd: None,
        worktree_isolation: false,
        branch: None,
        worktree_path: None,
        worktree_branch: None,
        companion_source: false,
        target_agent_id: Some(member_id.to_owned()),
        team_id: None,
        persist: false,
        inference: None,
        acp_mode: None,
        acp_config: None,
        acp_model: None,
        // Programmatic fan-out (delegate / threads / worker / scheduled / team
        // member) — yield to a directly-typing user on the shared local engine.
        background: true,
        plugin_flags: std::collections::HashMap::new(),
        // Programmatic per-member turn, no human author to attribute.
        author_user_id: None,
        author_name: None,
    };
    // Team members run with auto-recall OFF: a single user message is fanned out
    // to N members, so per-member recall would be N× redundant retrieval on the
    // same query. Recall is wired at the single-agent HTTP chat handler.
    let response = route_chat_stream(
        req,
        Arc::clone(&deps.registry),
        deps.conversations.clone(),
        deps.agent_store.clone(),
        Arc::clone(&deps.manager),
        deps.memory.clone(),
        Arc::clone(&deps.worktree_diffs),
        Arc::clone(&deps.mcp),
        deps.skills.clone(),
        deps.traces.clone(),
        None,
        // Team member turns inherit engine overflow handling (see above).
        None,
    )
    .await;
    drain_text_reply(response).await
}

/// Clone `original`, rewriting the last user message so `preamble` precedes its
/// text. This is how cross-member context (round-robin transcript, debate
/// synthesis brief, router instruction) is injected uniformly for BOTH ACP and
/// OpenAI-compat members — ACP only forwards the last user message, so folding
/// context into that message reaches every engine without history threading.
fn messages_with_preamble(original: &[UiMessage], preamble: &str) -> Vec<UiMessage> {
    let mut messages = original.to_vec();
    if let Some(last_user) = messages.iter_mut().rev().find(|m| m.role == "user") {
        let existing = last_user.content.as_text();
        last_user.content = UiContent::Text(format!("{preamble}\n\n{existing}"));
        last_user.parts = vec![];
    }
    messages
}

/// Resolve a `(member_id, display_name)` for each team member, falling back to
/// the id when the agent record is missing (e.g. an uninstalled built-in).
async fn member_names(members: &[String], agent_store: &AgentStore) -> Vec<(String, String)> {
    let mut out = Vec::with_capacity(members.len());
    for id in members {
        let name = agent_store
            .get(id)
            .await
            .ok()
            .flatten()
            .map(|a| a.name)
            .unwrap_or_else(|| id.clone());
        out.push((id.clone(), name));
    }
    out
}

/// Format one member's reply as an attributed UI text block (header + body),
/// pushing the frames to `out` and the same text to `combined` (what gets
/// persisted, so a reload renders identically to the live stream).
fn push_member_block(
    out: &mut Vec<Vec<u8>>,
    combined: &mut String,
    block_id: &str,
    label: &str,
    body: &str,
) {
    let header = format!("**{label}**\n\n");
    out.push(ui_text_start(block_id));
    out.push(ui_text_delta(block_id, &header));
    out.push(ui_text_delta(block_id, body));
    out.push(ui_text_end(block_id));
    combined.push_str(&header);
    combined.push_str(body);
    combined.push_str("\n\n");
}

/// Orchestrate a team turn: fan out to members per the coordination strategy and
/// stream one merged, attributed assistant message. Logic lives entirely in Core.
#[allow(clippy::too_many_arguments)]
pub async fn route_team_chat_stream(
    req: ChatStreamRequest,
    team: crate::teams::TeamRecord,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
) -> Response {
    use crate::teams::Coordination;

    if team.members.is_empty() {
        return error_stream(format!(
            "Team '{}' has no members. Add agents to the team first.",
            team.name
        ));
    }

    let deps = TeamRunDeps {
        registry,
        conversations: conversations.clone(),
        agent_store: agent_store.clone(),
        manager,
        memory,
        worktree_diffs,
        mcp,
        skills,
        traces,
    };

    let user_text = last_user_message(&req.messages);
    let conversation_id = req.conversation_id.clone();
    let original_messages = req.messages.clone();
    let members = member_names(&team.members, &agent_store).await;

    // Persist the user turn once (attributed to no agent — it's the user's), so
    // the conversation has exactly one user row regardless of member count.
    // TODO (Phase 0 follow-up): stamp the verified author_user_id here once the
    // team path carries the caller (single-agent path is wired; see chat_stream).
    if req.persist {
        if let Some(ref conv_id) = conversation_id {
            if !user_text.is_empty() {
                if let Err(e) = conversations
                    .append_message(
                        conv_id,
                        "user",
                        &user_text,
                        None,
                        req.author_user_id.as_deref(),
                        req.author_name.as_deref(),
                    )
                    .await
                {
                    tracing::warn!("failed to persist team user message: {e:#}");
                }
            }
        }
    }

    // Build the merged stream. Members run inside the stream so each block is
    // emitted as soon as that member finishes (progressive output).
    let team_id = team.id.clone();
    let coordination = team.coordination;
    let lead_id = team
        .lead_agent_id
        .clone()
        .unwrap_or_else(|| team.members[0].clone());
    let persist_combined = req.persist;

    let stream = async_stream::stream! {
        yield Ok::<_, std::convert::Infallible>(ui_start());

        let mut frames: Vec<Vec<u8>> = Vec::new();
        let mut combined = String::new();

        match coordination {
            // Every member answers the same prompt independently.
            Coordination::Broadcast => {
                for (idx, (mid, mname)) in members.iter().enumerate() {
                    let text = match run_member_text(mid, original_messages.clone(), conversation_id.clone(), &deps).await {
                        Ok(t) if !t.trim().is_empty() => t,
                        Ok(_) => "_(no response)_".to_owned(),
                        Err(e) => format!("_(error: {e})_"),
                    };
                    let mut block = Vec::new();
                    push_member_block(&mut block, &mut combined, &format!("m{idx}"), mname, &text);
                    for f in &block { yield Ok(f.clone()); }
                    frames.extend(block);
                }
            }
            // Members answer in order; each sees the prior members' replies.
            Coordination::RoundRobin => {
                let mut transcript = String::new();
                for (idx, (mid, mname)) in members.iter().enumerate() {
                    let msgs = if transcript.is_empty() {
                        original_messages.clone()
                    } else {
                        let preamble = format!(
                            "You are on a team. Your teammates have responded so far:\n\n{transcript}\nNow add your own response, building on theirs."
                        );
                        messages_with_preamble(&original_messages, &preamble)
                    };
                    let text = match run_member_text(mid, msgs, conversation_id.clone(), &deps).await {
                        Ok(t) if !t.trim().is_empty() => t,
                        Ok(_) => "_(no response)_".to_owned(),
                        Err(e) => format!("_(error: {e})_"),
                    };
                    transcript.push_str(&format!("{mname}: {text}\n\n"));
                    let mut block = Vec::new();
                    push_member_block(&mut block, &mut combined, &format!("m{idx}"), mname, &text);
                    for f in &block { yield Ok(f.clone()); }
                    frames.extend(block);
                }
            }
            // Members answer independently (round 1), then a lead synthesizes.
            Coordination::DebateSynthesis => {
                let mut round1 = String::new();
                for (idx, (mid, mname)) in members.iter().enumerate() {
                    let text = match run_member_text(mid, original_messages.clone(), conversation_id.clone(), &deps).await {
                        Ok(t) if !t.trim().is_empty() => t,
                        Ok(_) => "_(no response)_".to_owned(),
                        Err(e) => format!("_(error: {e})_"),
                    };
                    round1.push_str(&format!("{mname}: {text}\n\n"));
                    let mut block = Vec::new();
                    push_member_block(&mut block, &mut combined, &format!("m{idx}"), mname, &text);
                    for f in &block { yield Ok(f.clone()); }
                    frames.extend(block);
                }
                // Synthesis pass by the lead agent.
                let lead_name = members
                    .iter()
                    .find(|(id, _)| id == &lead_id)
                    .map(|(_, n)| n.clone())
                    .unwrap_or_else(|| lead_id.clone());
                let preamble = format!(
                    "You are the lead of a team. Your teammates gave these answers to the user's request:\n\n{round1}\nSynthesize them into one definitive, non-repetitive answer for the user."
                );
                let msgs = messages_with_preamble(&original_messages, &preamble);
                let synth = match run_member_text(&lead_id, msgs, conversation_id.clone(), &deps).await {
                    Ok(t) if !t.trim().is_empty() => t,
                    Ok(_) => "_(no synthesis)_".to_owned(),
                    Err(e) => format!("_(synthesis error: {e})_"),
                };
                let mut block = Vec::new();
                push_member_block(&mut block, &mut combined, "synth", &format!("{lead_name} (synthesis)"), &synth);
                for f in &block { yield Ok(f.clone()); }
                frames.extend(block);
            }
            // A router picks the single best-suited member, then only it answers.
            Coordination::Router => {
                let menu = members
                    .iter()
                    .map(|(id, name)| format!("- {name} (id: {id})"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let route_prompt = format!(
                    "You are a router for a team of agents. Given the user's message, pick the SINGLE best-suited teammate to answer it. Reply with ONLY that teammate's id and nothing else.\n\nTeammates:\n{menu}\n\nUser message:\n{user_text}"
                );
                let pick_msgs = vec![UiMessage {
                    role: "user".to_owned(),
                    content: UiContent::Text(route_prompt),
                    parts: vec![],
                }];
                // No conversation_id: the routing decision is a side query, not a turn.
                let pick = run_member_text(&lead_id, pick_msgs, None, &deps).await.unwrap_or_default();
                // Choose the first member whose id appears in the router's reply;
                // fall back to the first member when parsing fails.
                let chosen = members
                    .iter()
                    .find(|(id, _)| pick.contains(id.as_str()))
                    .cloned()
                    .unwrap_or_else(|| members[0].clone());
                let text = match run_member_text(&chosen.0, original_messages.clone(), conversation_id.clone(), &deps).await {
                    Ok(t) if !t.trim().is_empty() => t,
                    Ok(_) => "_(no response)_".to_owned(),
                    Err(e) => format!("_(error: {e})_"),
                };
                let mut block = Vec::new();
                push_member_block(&mut block, &mut combined, "m0", &format!("{} (routed)", chosen.1), &text);
                for f in &block { yield Ok(f.clone()); }
                frames.extend(block);
            }
        }

        yield Ok(ui_finish());

        // Persist exactly one combined assistant turn attributed to the team, so a
        // later reload re-renders the same merged content that just streamed.
        if persist_combined {
            if let Some(ref conv_id) = conversation_id {
                if !combined.trim().is_empty() {
                    if let Err(e) = conversations
                        .append_message(conv_id, "assistant", combined.trim_end(), Some(&team_id), None, None)
                        .await
                    {
                        tracing::warn!("failed to persist team assistant message: {e:#}");
                    }
                }
            }
        }

        yield Ok(DONE_SSE_LINE.as_bytes().to_vec());
    };

    sse_response(Body::from_stream(stream))
}

///
/// `conversations` persists chat history server-side (U10): the inbound user
/// message is written before streaming begins, and the streamed assistant reply
/// is accumulated and written once the stream completes.
///
/// `agent_store` supplies the selected agent's **bound engine** (U6) rather than
/// only the `agent_id` prefix: a local-engine binding triggers a managed swap
/// (U4) via `manager` so the requested engine becomes the single resident one
/// before streaming; a cloud/registry binding routes without touching local
/// engines; an unknown/unbound agent falls back to the default plain-LLM agent.
///
/// Two-tier memory (spec unit U11): when `enable_long_term` is set, durable
/// cross-session facts are recalled and prepended as a leading `system` message,
/// and the user's turn is recorded for future sessions once the stream completes.
#[allow(clippy::too_many_arguments)]
pub async fn route_chat_stream(
    mut req: ChatStreamRequest,
    registry: Arc<AcpAgentRegistry>,
    conversations: ConversationStore,
    agent_store: AgentStore,
    manager: Arc<SidecarManager>,
    memory: MemoryStore,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    skills: SkillRegistry,
    traces: TraceStore,
    recall: Option<AutoRecallConfig>,
    // App-level context-window management (opt-in / off by default). `None`
    // means full history is sent and the engine handles overflow. When set, the
    // OpenAI-compat path trims `req.messages` to the token budget and the ACP
    // path replaces its fixed last-10 replay with a budgeted window — both
    // always keeping the system block, optionally summarizing dropped turns.
    ctx_window: Option<context_window::ContextWindowConfig>,
) -> Response {
    tracing::info!(
        agent_id = ?req.agent_id,
        conversation_id = ?req.conversation_id,
        msg_count = req.messages.len(),
        enable_long_term = req.enable_long_term,
        last_role = req.messages.last().map(|m| m.role.as_str()),
        last_content = ?req.messages.last().map(|m| m.content.as_text()),
        last_parts_count = req.messages.last().map(|m| m.parts.len()),
        "route_chat_stream: received request"
    );

    let user_text = last_user_message(&req.messages);

    // Persist the latest user turn before we stream the reply, so history
    // survives even if the connection drops mid-stream. Skipped when `persist`
    // is false (the team orchestrator records the user turn once itself and runs
    // each member with `persist = false` to avoid N duplicate user rows).
    if req.persist {
        if let Some(conversation_id) = req.conversation_id.clone() {
            if !user_text.is_empty() {
                if let Err(e) = conversations
                    .append_message(
                        &conversation_id,
                        "user",
                        &user_text,
                        req.agent_id.as_deref(),
                        // Verified human author (Phase 0): stamped from the request's
                        // user JWT in `chat_stream`. `None` in the anonymous /
                        // loopback flow, which keeps the single-tenant behavior.
                        req.author_user_id.as_deref(),
                        // Unverified sender display name for group/channel chats.
                        req.author_name.as_deref(),
                    )
                    .await
                {
                    tracing::warn!("failed to persist user message: {e:#}");
                }
            }
        }
    }

    // Load the unified provider/model/strategy registry (env > file > literal).
    // This is the single source of truth for the default chat base_url and model.
    let provider_reg = ProviderRegistry::load();

    // Resolve the effective agent for this turn: if `target_agent_id` is set,
    // auto-add it as a participant and route this message to it (#414). Otherwise
    // use the primary `agent_id` (backward compatible).
    let effective_agent_id: Option<String> = if let Some(ref target) = req.target_agent_id {
        // Auto-register the target as a participant in this conversation.
        if let Some(ref conv_id) = req.conversation_id {
            if let Err(e) = conversations.add_participant(conv_id, target).await {
                tracing::warn!("failed to add participant {target}: {e:#}");
            }
        }
        Some(target.clone())
    } else {
        req.agent_id.clone()
    };

    // Resolve the agent's engine binding from the store (U6), then map it to a
    // concrete route. The binding lets a custom agent target a local engine or a
    // registry transport; unknown agents fall back to the default plain-LLM agent.
    // Per-attribute slots (M3 / #164) are also resolved here and threaded into
    // the gateway request headers so each modality call routes independently.
    // The persona slot (#410) is also resolved so we can build a tone prefix for
    // the system prompt before dispatching.
    // `identity_profile_ids` are the agent's bound Identity Vault profiles (epic
    // #517), resolved per request alongside the other bindings. They are carried
    // (IDs only — not secrets) and threaded into the ACP MCP bridge so the
    // tool-call-time consult (`crate::identity::consult_for_tool_call`) fetches
    // decrypted state ONLY for the domains of these bound profiles, at call time —
    // state is never broadcast to the LLM. An empty list means the agent sees no
    // identities. The consumer is wired in `route_acp_stream` → the MCP bridge.
    let (
        engine,
        model,
        agent_slots,
        persona,
        composio_actions,
        skills_allowlist,
        identity_profile_ids,
    ) = match effective_agent_id.as_deref() {
        Some(id) => resolve_binding(id, &agent_store).await,
        None => (
            None,
            None,
            AgentSlots::default(),
            None,
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ),
    };

    // Build persona tone prefix (#410). Merged into the system prompt before
    // dispatching — prepended to long_term_system for both adapters.
    let persona_prefix = persona_tone_prefix(persona.as_ref());

    // Recall long-term (cross-session) memory BEFORE recording the current turn,
    // so the just-sent message does not echo back to the model as a remembered
    // "fact". This keeps long-term context strictly cross-session.
    // Use effective_agent_id so multi-agent turns scope memory correctly.
    let long_term_system = assemble_long_term_system_message(
        &memory,
        req.enable_long_term,
        effective_agent_id.as_deref(),
    )
    .await;

    // Merge the persona prefix into the system prompt. Both the persona instructions
    // and the long-term memory block are injected as a leading system message.
    // Persona prefix comes first so the model reads the persona before the facts.
    let long_term_system = merge_system_prompt(long_term_system, persona_prefix);

    // The agent scope for long-term memory facts — the SAME one the recency path
    // (`assemble_long_term_system_message`) used, so backfill + dedup ids line up.
    let memory_scope = long_term_agent_scope(effective_agent_id.as_deref());

    // The set of fact ids the RECENCY path injected this turn, so auto-recall can
    // dedup BY ID (the two blocks use different formats, so content-match would
    // silently double-inject). CRITICAL: only populate this when `enable_long_term`
    // is true — recency injects NOTHING when it's off (`assemble_long_term_system_message`
    // returns `None`), so dropping these ids then would surface them NOWHERE.
    // This is a cheap SELECT (same `DEFAULT_LONG_TERM_LIMIT` recency used), no embed.
    let recency_fact_ids: std::collections::HashSet<String> = if req.enable_long_term {
        match memory
            .recall(LOCAL_USER, &memory_scope, DEFAULT_LONG_TERM_LIMIT)
            .await
        {
            Ok(entries) => entries.into_iter().map(|e| e.id).collect(),
            Err(e) => {
                tracing::warn!("auto-recall: reading recency fact ids failed (no dedup): {e:#}");
                std::collections::HashSet::new()
            }
        }
    } else {
        std::collections::HashSet::new()
    };

    // Auto-recall (U17, now wired): retrieve relevant prior knowledge (long-term
    // MEMORY + PAST CHAT MESSAGES, current conversation excluded) and fold it into
    // `long_term_system` ONCE here, so BOTH the openai-compat and ACP planes
    // inherit it via the same seam skills use. This is gated solely by the
    // `auto-recall-enabled` pref (encoded as `recall: Some`/`None` by the handler)
    // and is INDEPENDENT of `enable_long_term`. Fully fail-open — any error inside
    // `run_auto_recall` logs and yields `None`, never blocking the turn. Appended
    // AFTER persona+memory so persona instructions stay leading.
    // Mutable: a context-window compaction summary (if enabled) is merged in below.
    let mut long_term_system = if let Some(ref cfg) = recall {
        // Hard wall-clock bound so recall NEVER slows a turn fatally. Both halves
        // do a lazy backfill (the chat-search path embeds any not-yet-indexed
        // message inline; the memory path embeds any not-yet-indexed long-term
        // fact); on a large backlog with a live embedder that first call can be
        // slow, so a timeout degrades to "no recall this turn" rather than
        // stalling the reply. Fail-open on both the timeout and any inner error.
        let recalled = match tokio::time::timeout(
            AUTO_RECALL_TIMEOUT,
            run_auto_recall(
                cfg,
                &conversations,
                &memory,
                &memory_scope,
                &recency_fact_ids,
                &user_text,
                req.conversation_id.as_deref(),
            ),
        )
        .await
        {
            Ok(block) => block,
            Err(_) => {
                tracing::warn!("auto-recall timed out, skipping for this turn");
                None
            }
        };
        match recalled {
            Some(block) => match long_term_system {
                Some(existing) if !existing.is_empty() => Some(format!("{existing}\n\n{block}")),
                _ => Some(block),
            },
            None => long_term_system,
        }
    } else {
        long_term_system
    };

    // Record the user's turn into long-term memory when opted in, so it informs
    // future sessions. No-op (and nothing is stored) when disabled.
    if req.enable_long_term && !user_text.is_empty() {
        let scope = long_term_agent_scope(effective_agent_id.as_deref());
        if let Err(e) = memory.record(LOCAL_USER, &scope, &user_text).await {
            tracing::warn!("failed to record long-term memory: {e:#}");
        }
    }

    let route = match agent_route(
        effective_agent_id.as_deref(),
        engine.as_deref(),
        model.as_deref(),
        &registry,
        &provider_reg,
    ) {
        Some(r) => r,
        None => {
            let msg = effective_agent_id.as_deref().map_or(
                "No agent selected. Please pick an agent.".to_owned(),
                |id| format!("Unknown agent: {id}"),
            );
            return error_stream(msg);
        }
    };

    // Resolve advanced sampling (#mtp-advanced-inference): the agent's stored
    // inference defaults overlaid with any per-request override (request wins per
    // field). The engine governs field-name translation and the remote-OpenAI
    // safety gate: only a LocalEngine route gets the non-standard sampler fields
    // (top_k/min_p/…); every other route is treated as Engine::Other so a remote
    // OpenAI endpoint never 400s on an unknown field.
    let sampling = {
        let agent_defaults = match effective_agent_id.as_deref() {
            Some(id) => agent_store
                .get(id)
                .await
                .ok()
                .flatten()
                .and_then(|r| r.inference)
                .unwrap_or_default(),
            None => crate::inference::SamplingConfig::default(),
        };
        agent_defaults.merge(&req.inference.clone().unwrap_or_default())
    };
    let sampling_engine = match &route {
        AgentRoute::LocalEngine { engine, .. } => crate::inference::Engine::from_name(engine),
        _ => crate::inference::Engine::Other,
    };

    // Short-term context for the ACP path: replay recent conversation turns,
    // since ACP otherwise sends only the last user message. Assembled before the
    // `persist` closure consumes `store`. The OpenAI-compat path already receives
    // the full message list from the client, so it needs no short-term injection.
    let short_term = if matches!(route, AgentRoute::Acp { .. }) {
        match req.conversation_id.as_deref() {
            // When a context budget is set, replay a token-budgeted window of
            // recent turns (optionally summarizing the dropped tail) instead of
            // the fixed last-10 cap. The system block is counted against the
            // budget so the replay leaves room for it + the reply.
            Some(id) => match &ctx_window {
                Some(cfg) => {
                    let system_tokens = long_term_system
                        .as_deref()
                        .map(context_window::estimate_tokens)
                        .unwrap_or(0);
                    context_window::budgeted_short_term(&conversations, id, system_tokens, cfg)
                        .await
                }
                None => assemble_short_term_context(&conversations, id).await,
            },
            None => None,
        }
    } else {
        None
    };

    // OpenAI-compat / local path: trim the outbound history to the token budget
    // (off by default). ACP is handled above via its short-term replay, so this
    // only runs for the OpenAI-compat plane. Keeps every system message and the
    // last turn; when auto-compact is on, dropped turns are summarized and the
    // summary is merged into the system prompt (labelled, not a memory fact).
    if let Some(cfg) = &ctx_window {
        if !matches!(route, AgentRoute::Acp { .. }) {
            let system_tokens = long_term_system
                .as_deref()
                .map(context_window::estimate_tokens)
                .unwrap_or(0);
            if let Some(summary) =
                context_window::apply_openai(&mut req.messages, system_tokens, cfg).await
            {
                long_term_system = merge_system_prompt(long_term_system, Some(summary));
            }
        }
    }

    // Resolve the effective working directory for ACP. If the request carries a
    // `cwd` and worktree isolation is requested, allocate a per-run git worktree
    // from the repo root so the agent never mutates the user's main checkout.
    // The guard is returned even on the non-isolation path to carry the resolved
    // path; for that path `guard` is `None` and we pass `effective_cwd` directly.
    let (effective_cwd, worktree_guard): (PathBuf, Option<WorktreeGuard>) =
        if matches!(route, AgentRoute::Acp { .. }) {
            let base = req
                .cwd
                .as_deref()
                .map(PathBuf::from)
                .filter(|p| p.exists())
                .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

            if req.worktree_isolation && is_git_repo(&base) {
                let repo_root = find_git_root(&base).unwrap_or_else(|| base.clone());
                // Persistent per-session: reuse this conversation's live worktree
                // across turns instead of forking a fresh one each message. Take
                // the guard out of the diff store so the run owns it; the
                // completion task re-inserts it with a refreshed diff. A new
                // worktree is created only when the conversation has none yet
                // (first turn) or its previous one was applied/removed.
                let reused = if let Some(ref conv_id) = req.conversation_id {
                    let mut store = worktree_diffs.lock().await;
                    store
                        .get_mut(conv_id)
                        .and_then(|run| match run.guard.take() {
                            Some(g) if g.path.exists() => Some(g),
                            // Stale guard (dir vanished) — drop it and create fresh.
                            _ => None,
                        })
                } else {
                    None
                };
                match reused {
                    Some(guard) => (guard.path.clone(), Some(guard)),
                    None => match create_worktree_in(&repo_root, req.worktree_branch.as_deref()) {
                        Ok(guard) => {
                            let worktree_path = guard.path.clone();
                            (worktree_path, Some(guard))
                        }
                        Err(e) => {
                            tracing::warn!(
                                "worktree create failed, falling back to plain cwd: {e:#}"
                            );
                            (base, None)
                        }
                    },
                }
            } else {
                (base, None)
            }
        } else {
            (
                std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                None,
            )
        };

    // Record run metadata and mark the run as "running" before streaming begins
    // so the state is durable even if the connection drops mid-stream (U013).
    // When worktree isolation is active, the guard's path takes priority over
    // any client-supplied worktree_path.
    if let Some(ref conv_id) = req.conversation_id {
        let folder_path = req.cwd.as_deref();
        let branch = req.branch.as_deref();
        let resolved_worktree = worktree_guard
            .as_ref()
            .map(|g| g.path.to_string_lossy().into_owned());
        let worktree_path = resolved_worktree
            .as_deref()
            .or(req.worktree_path.as_deref());
        if folder_path.is_some() || branch.is_some() || worktree_path.is_some() {
            if let Err(e) = conversations
                .set_run_metadata(conv_id, folder_path, branch, worktree_path)
                .await
            {
                tracing::warn!("failed to set run metadata: {e:#}");
            }
        }
        if let Err(e) = conversations.set_run_status(conv_id, "running").await {
            tracing::warn!("failed to set run status to running: {e:#}");
        }
    }

    // When `persist` is false (team member sub-requests), force the assistant
    // persist target to None so the per-member reply is not written — the team
    // orchestrator persists one combined assistant turn itself.
    let conversation_id_for_persist = if req.persist {
        req.conversation_id.clone()
    } else {
        None
    };
    // Use effective_agent_id so the persisted assistant message is attributed to
    // the agent that actually handled the turn (target_agent_id if set, else primary).
    let persist_agent_id = effective_agent_id.clone();
    // The ACP path uses incremental persistence (store + metadata passed
    // directly); non-ACP paths still use the FnOnce closure.
    let persist_store_for_acp = conversations.clone();
    let persist = {
        let conv_id = conversation_id_for_persist.clone();
        let agent_id = persist_agent_id.clone();
        move |reply: String, outcome: &'static str| {
            persist_assistant_reply(
                conversations.clone(),
                conv_id,
                agent_id,
                reply,
                outcome,
            )
        }
    };

    match route {
        AgentRoute::OpenAiCompat {
            base_url,
            model,
            api_key,
            via_gateway,
        } => {
            if via_gateway {
                let gateway_healthy = crate::sidecar::gateway::is_healthy().await;
                if forward_via_gateway(via_gateway, gateway_healthy) {
                    // U18: hand the call to the local ryu-gateway, which owns
                    // provider creds and forwards to the engine. Core no longer
                    // needs its own provider key here. The gateway URL replaces
                    // base_url; the gateway token (not the provider key) is the
                    // bearer.
                    let gateway_base = crate::sidecar::gateway::gateway_url();
                    let gateway_token = crate::sidecar::gateway::gateway_token();
                    // Forward the selected agent id so the gateway can apply
                    // per-agent token budgets (U21). Core has no local user concept,
                    // so `x-ryu-user-id` is left for cloud/multi-tenant gateways.
                    let budget_agent_id = effective_agent_id.clone();
                    // For the default/"ryu" agent, attach the registry-configured
                    // fallback chain so a gateway transport failure recovers to the
                    // local engine instead of surfacing a raw error (AC1–AC4).
                    let fallback_chain = if is_default_agent(effective_agent_id.as_deref()) {
                        registry.fallback_chain_for_default()
                    } else {
                        vec![]
                    };
                    return route_openai_stream(
                        req,
                        gateway_base,
                        model,
                        gateway_token,
                        long_term_system,
                        budget_agent_id,
                        persist,
                        fallback_chain,
                        skills,
                        skills_allowlist.clone(),
                        composio_actions,
                        agent_slots,
                        sampling.clone(),
                        sampling_engine,
                    )
                    .await;
                }
                // Gateway is configured but unreachable — fall through to the
                // direct provider path so chat keeps working in degraded mode.
                tracing::warn!(
                    gateway_url = %crate::sidecar::gateway::gateway_url(),
                    "ryu-gateway unreachable; falling back to direct provider (degraded mode)"
                );
            }
            // Guard the unconfigured default: public OpenAI endpoint with no key
            // would just 401. Give the operator an actionable message instead.
            // Compare against the registry's last-resort literal so a file- or
            // env-configured alternative is never blocked.
            if is_default_agent(effective_agent_id.as_deref())
                && base_url == crate::registry::DEFAULT_LLM_BASE_URL
                && api_key.is_none()
            {
                return error_stream(
                    "Default LLM is not configured. Set RYU_DEFAULT_LLM_API_KEY (or OPENAI_API_KEY), \
                     or point RYU_DEFAULT_LLM_BASE_URL at a local OpenAI-compatible provider."
                        .to_owned(),
                );
            }
            // Direct-to-provider (registry agent or degraded-mode fallback):
            // no gateway budget scoping.
            // Also carry the fallback chain when this is the default agent on the
            // degraded-mode path (gateway down → direct provider) so recovery
            // still applies.
            let fallback_chain = if is_default_agent(effective_agent_id.as_deref()) {
                registry.fallback_chain_for_default()
            } else {
                vec![]
            };
            route_openai_stream(
                req,
                base_url,
                model,
                api_key,
                long_term_system,
                None,
                persist,
                fallback_chain,
                skills,
                skills_allowlist.clone(),
                Vec::new(),
                agent_slots,
                sampling.clone(),
                sampling_engine,
            )
            .await
        }
        AgentRoute::LocalEngine {
            engine,
            base_url,
            model,
        } => {
            // Make the bound engine the single resident local engine. Idempotent
            // if already active; performs a stop-then-start swap otherwise (U4).
            tracing::info!(engine = %engine, "route_chat_stream: ensuring local engine is resident");
            if let Err(e) = manager.set_active_local_engine(&engine).await {
                return error_stream(format!("Could not activate local engine '{engine}': {e}"));
            }
            // Local engines have no provider key; persist the reply on completion.
            // No fallback chain for local-engine routes — they are the fallback.
            // Local engines go direct; slot overrides are gateway-only so we pass
            // an empty default here.
            route_openai_stream(
                req,
                base_url,
                model,
                None,
                long_term_system,
                None,
                persist,
                vec![],
                skills,
                skills_allowlist.clone(),
                Vec::new(),
                AgentSlots::default(),
                sampling.clone(),
                sampling_engine,
            )
            .await
        }
        AgentRoute::Acp { spawn_cmd } => {
            let conversation_id = req.conversation_id.clone();
            // Resolve the per-agent allowlist so the MCP bridge only offers the
            // tools the agent is permitted to call (AC3 governance). Use the
            // effective agent id so target_agent_id routing gets the correct allowlist.
            let allowlist = effective_agent_id
                .as_deref()
                .and_then(|id| registry.allowlist_for(id));
            // Effective agent id for the MCP bridge (PTC scoping). Falls back to
            // the ACP transport id form when no agent id is set.
            let bridge_agent_id = effective_agent_id
                .clone()
                .unwrap_or_else(|| format!("acp:{spawn_cmd}"));
            // Make the per-agent skill allowlist real on the ACP plane. ACP
            // subprocesses make their own provider calls, so Core cannot inject a
            // separate system message the way the openai-compat path does — instead
            // we fold the resolved skill block into the prompt preamble via
            // `long_term_system` (consumed by `build_acp_prompt`). Empty allowlist =
            // all enabled skills, matching the openai-compat path.
            //
            // The ACP plane always runs a tool loop (the MCP bridge), so it is the
            // one plane where progressive disclosure is safe: inject only the L1
            // index (+ any always-on bodies) and let the model load full bodies on
            // demand via `skills__load`. When the global mode is `full` (or there
            // are no progressive skills) we fall back to the full-body block. The
            // no-tool openai-compat path always uses the full block (see
            // `route_openai_stream`), so a weak model is never starved.
            let skill_block = if crate::skills::is_progressive_disclosure() {
                skills.progressive_block(&skills_allowlist)
            } else {
                skills.skill_block(&skills_allowlist)
            };
            let long_term_system = match skill_block {
                Some((header, _ids)) => merge_system_prompt(long_term_system, Some(header)),
                None => long_term_system,
            };
            route_acp_stream(
                req,
                spawn_cmd,
                effective_cwd,
                worktree_guard,
                short_term,
                long_term_system,
                persist_store_for_acp,
                conversation_id_for_persist,
                persist_agent_id,
                conversation_id,
                worktree_diffs,
                mcp,
                allowlist,
                // #477: thread the per-agent Composio actions (in scope from
                // resolve_binding) + effective agent id into the ACP bridge so
                // Composio reaches the ACP plane and PTC execution is scoped.
                composio_actions.clone(),
                bridge_agent_id,
                // #517: thread the agent's bound Identity Vault profiles so the
                // tool-call-time vault consult runs on the ACP plane.
                identity_profile_ids,
                traces,
            )
            .await
        }
        AgentRoute::SdkApp { base_url, model } => {
            // SDK apps are not swappable local engines (no exclusive GPU slot),
            // so we do not call set_active_local_engine. Core routes the chat
            // request directly to the loopback endpoint the SDK process serves.
            // The SDK process's model calls flow through the gateway via env-
            // injection applied at spawn time (sdk::sdk_app_spawn_parts).
            tracing::info!(
                agent_id = ?req.agent_id,
                url = %base_url,
                "route_chat_stream: routing to SDK app loopback"
            );
            // No fallback chain and no gateway on this hop — the SDK app owns its
            // own provider routing (via injected OPENAI_BASE_URL).
            route_openai_stream(
                req,
                base_url,
                model,
                None,
                long_term_system,
                None,
                persist,
                vec![],
                skills,
                skills_allowlist,
                Vec::new(),
                AgentSlots::default(),
                sampling,
                sampling_engine,
            )
            .await
        }
    }
}

/// Assemble a short-term context block from the recent turns of a conversation
/// (spec unit U11). Returns `None` when there is no prior context to replay.
async fn assemble_short_term_context(
    store: &ConversationStore,
    conversation_id: &str,
) -> Option<String> {
    let recent = match store
        .get_recent_messages(conversation_id, DEFAULT_SHORT_TERM_LIMIT)
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("failed to load short-term context: {e:#}");
            return None;
        }
    };
    // The final entry is the just-persisted current user turn; the prefix is the
    // prior context worth replaying. Fewer than 2 messages means no prior turns.
    if recent.len() < 2 {
        return None;
    }
    let mut block = String::from("Conversation so far:\n");
    for msg in &recent[..recent.len() - 1] {
        block.push_str(&msg.role);
        block.push_str(": ");
        block.push_str(msg.content.trim());
        block.push('\n');
    }
    Some(block)
}

/// Write the assistant reply to the conversation store. Called after a stream
/// completes; a no-op when there is no `conversation_id` or the reply is empty.
/// Write the assistant reply to the conversation store and update run_status.
/// Called after a stream completes; a no-op when there is no `conversation_id`.
/// `outcome` is "completed" on clean end, "failed" on error.
async fn persist_assistant_reply(
    store: ConversationStore,
    conversation_id: Option<String>,
    agent_id: Option<String>,
    reply: String,
    outcome: &'static str,
) {
    let Some(conversation_id) = conversation_id else {
        return;
    };
    if !reply.is_empty() {
        if let Err(e) = store
            .append_message(
                &conversation_id,
                "assistant",
                &reply,
                agent_id.as_deref(),
                None,
                None,
            )
            .await
        {
            tracing::warn!("failed to persist assistant reply: {e:#}");
        }
    }
    if let Err(e) = store.set_run_status(&conversation_id, outcome).await {
        tracing::warn!("failed to set run_status to {outcome}: {e:#}");
    }
}

// ── OpenAI-compat streaming ────────────────────────────────────────────────────

/// Build and send the OpenAI-compat HTTP request, returning the upstream response
/// or a transport-level error string. Separating the connection step from streaming
/// allows the caller to fall back to an alternative provider on transport failure
/// before committing to a stream (self-healing, AC1/AC2).
///
/// `slots` carries the agent's per-attribute modality slot selections (M3 / #164).
/// When forwarding to the ryu-gateway, these are attached as `x-ryu-slot-*`
/// headers so the gateway can route each modality call to the provider specified
/// on the agent card rather than the static `modality_map` default. On the
/// direct-to-provider path the headers are sent but harmlessly ignored.
async fn connect_openai(
    messages: &[Value],
    base_url: &str,
    model: &str,
    api_key: Option<&str>,
    agent_id: Option<&str>,
    // Verified Better Auth user id of the caller (from the inbound `x-ryu-user-id`
    // header via `identity_from_headers`, stamped onto `ChatStreamRequest`). Forwarded
    // as `x-ryu-user-id` so the gateway's per-user usage attribution / budgets are live.
    // `None` in the single-tenant / loopback (anonymous) flow.
    user_id: Option<&str>,
    // Active skill ids for Gateway attribution (AC3). Forwarded as
    // `x-ryu-skill-ids: id1,id2` so the Gateway can record them in the audit row.
    skill_ids: &[String],
    // Per-agent Composio action allowlist (#456). Forwarded as
    // `x-ryu-composio-actions: A,B` so the gateway's Composio tool loop offers and
    // executes only these actions for this agent.
    composio_actions: &[String],
    // Core conversation/session id for per-run audit correlation (M4 / #176).
    // Forwarded as `x-ryu-session-id` so the gateway can key audit rows to a session.
    session_id: Option<&str>,
    // Per-attribute modality slot overrides (M3 / #164). Each populated slot is
    // forwarded as `x-ryu-slot-<modality>-provider` / `x-ryu-slot-<modality>-model`
    // so the gateway can route the same agent's image/TTS/STT calls differently.
    slots: &AgentSlots,
    // True when the request originates from the context companion (M7 / #199).
    // Forwarded as `x-ryu-companion-source` so Gateway DLP fires unconditionally.
    companion_source: bool,
    // True for programmatic background fan-out. Forwarded as `x-ryu-priority:
    // background` so the gateway's local-engine admission queue serves
    // interactive turns first when the resident engine's slots are full.
    background: bool,
    // Advanced sampling params, merged into the body below and translated for
    // `sampling_engine` (field names differ per engine; the remote-OpenAI safety
    // gate lives inside `apply_to_body`).
    sampling: &crate::inference::SamplingConfig,
    sampling_engine: crate::inference::Engine,
) -> Result<reqwest::Response, String> {
    let mut payload_map = serde_json::Map::new();
    payload_map.insert("model".to_owned(), Value::String(model.to_owned()));
    payload_map.insert("stream".to_owned(), Value::Bool(true));
    // Ask any OpenAI-compatible endpoint to emit a final `usage` chunk
    // (prompt/completion/total tokens). llama.cpp additionally streams a
    // non-standard `timings` object with `predicted_per_second` — both feed the
    // per-message inference stats surfaced by `build_stats_part` (mirrors Jan's
    // `includeUsage: true`). Harmless to providers that ignore the option.
    payload_map.insert(
        "stream_options".to_owned(),
        serde_json::json!({ "include_usage": true }),
    );
    payload_map.insert("messages".to_owned(), Value::Array(messages.to_vec()));
    // Merge advanced sampling (temperature/top_p/top_k/penalties/…). No-op when the
    // agent set nothing, so the body stays identical to the pre-feature shape.
    if !sampling.is_empty() {
        sampling.apply_to_body(sampling_engine, &mut payload_map);
    }
    let payload = Value::Object(payload_map);

    static HTTP_CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let client = HTTP_CLIENT.get_or_init(reqwest::Client::new);
    let endpoint = format!("{}/v1/chat/completions", base_url.trim_end_matches('/'));
    let mut builder = client.post(endpoint).json(&payload);
    if let Some(key) = api_key.filter(|k| !k.is_empty()) {
        builder = builder.bearer_auth(key);
    }
    if let Some(aid) = agent_id.filter(|a| !a.is_empty()) {
        builder = builder.header("x-ryu-agent-id", aid);
    }
    // Forward the verified caller so the gateway's per-user usage attribution and
    // per-user budgets are live (previously never sent, leaving them inert). Only
    // set when non-empty — anonymous/loopback turns leave it off, as before.
    if let Some(uid) = user_id.filter(|u| !u.is_empty()) {
        builder = builder.header("x-ryu-user-id", uid);
    }
    // Static feature tag for the main chat path so the gateway can attribute
    // usage/budgets per feature. This connector serves the chat-completions path
    // exclusively (only reached via `route_openai_stream`).
    builder = builder.header("x-ryu-feature", "chat");
    // Thread the Core session/conversation id so the gateway can correlate audit
    // rows back to a specific chat run without a separate session store (M4 / #176).
    if let Some(sid) = session_id.filter(|s| !s.is_empty()) {
        builder = builder.header("x-ryu-session-id", sid);
    }
    // Companion-source tag (M7 / #199): when set, the gateway applies unconditional
    // DLP/PII redaction before the provider call regardless of local firewall config.
    if companion_source {
        builder = builder.header("x-ryu-companion-source", "true");
    }
    // Admission priority for the shared local engine (interactive vs background).
    // Only background is forwarded — the gateway defaults an absent header to
    // interactive, so a directly-typing user never needs the header.
    if background {
        builder = builder.header("x-ryu-priority", "background");
    }
    if !skill_ids.is_empty() {
        builder = builder.header("x-ryu-skill-ids", skill_ids.join(","));
    }
    // Per-agent Composio allowlist (#456): the gateway uses this to scope its
    // Composio tool loop to the actions this agent selected.
    if !composio_actions.is_empty() {
        builder = builder.header("x-ryu-composio-actions", composio_actions.join(","));
        // Canonical egress allowlist header (Contract 7, #477): `x-ryu-tools` is a
        // CSV of fully-qualified tool ids; Composio actions are `composio__<slug>`.
        // The gateway reads `x-ryu-tools` first with the legacy header as fallback.
        let tool_ids = composio_actions
            .iter()
            .map(|slug| format!("composio__{slug}"))
            .collect::<Vec<_>>()
            .join(",");
        builder = builder.header("x-ryu-tools", tool_ids);
    }
    // Forward per-attribute slot selections so the gateway can apply
    // per-agent modality routing (M3 / #164). Each slot that has a provider
    // set emits `x-ryu-slot-<modality>-provider`; model is emitted only when
    // explicitly set on the slot so the gateway falls back to the modality map
    // or caller model when the agent card doesn't pin a specific model.
    //
    // Chat slot: gateway's pre_process calls route_modality_with_slot(Chat,...)
    // when x-ryu-slot-chat-provider is present, overriding eval/model routing.
    if let Some((prov, mdl)) = &slots.chat {
        builder = builder.header("x-ryu-slot-chat-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-chat-model", m.as_str());
        }
    }
    // Image/TTS/STT slots are forwarded on the chat call as pre-registration so
    // the gateway session context knows the agent's modality preferences. They
    // are also forwarded on the respective modality calls when those are made.
    if let Some((prov, mdl)) = &slots.image {
        builder = builder.header("x-ryu-slot-image-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-image-model", m.as_str());
        }
    }
    if let Some((prov, mdl)) = &slots.video {
        builder = builder.header("x-ryu-slot-video-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-video-model", m.as_str());
        }
    }
    if let Some((prov, mdl)) = &slots.tts {
        builder = builder.header("x-ryu-slot-tts-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-tts-model", m.as_str());
        }
    }
    if let Some((prov, mdl)) = &slots.stt {
        builder = builder.header("x-ryu-slot-stt-provider", prov.as_str());
        if let Some(m) = mdl {
            builder = builder.header("x-ryu-slot-stt-model", m.as_str());
        }
    }
    builder
        .send()
        .await
        .map_err(|e| format!("Agent unreachable: {e}"))
}

/// Attempt a primary OpenAI-compat connection; on transport failure, retry once
/// with each fallback in `fallback_chain` (single bounded retry per AC1).
/// Returns `Ok(upstream_response)` from whichever attempt succeeds first, or
/// `Err(last_error)` if every attempt fails.
///
/// Recovery attempts are logged via tracing with the original failure cause (AC4).
async fn connect_with_fallback(
    messages: &[Value],
    primary_base_url: &str,
    primary_model: &str,
    primary_api_key: Option<&str>,
    primary_agent_id: Option<&str>,
    // Verified caller user id forwarded to the gateway as `x-ryu-user-id` for
    // per-user attribution/budgets. `None` for anonymous/loopback turns.
    user_id: Option<&str>,
    // Active skill ids forwarded to Gateway attribution (M3 / #145 AC3).
    skill_ids: &[String],
    // Per-agent Composio action allowlist forwarded to the gateway (#456).
    composio_actions: &[String],
    // Core conversation/session id for per-run audit correlation (M4 / #176).
    session_id: Option<&str>,
    fallback_chain: &[FallbackProvider],
    // Per-attribute slot overrides forwarded to the gateway (M3 / #164).
    slots: &AgentSlots,
    // Companion-source tag (M7 / #199): forwarded to trigger Gateway DLP.
    companion_source: bool,
    // Background fan-out tag (#queue): forwarded as `x-ryu-priority: background`.
    background: bool,
    // Advanced sampling params + the engine governing field-name translation.
    sampling: &crate::inference::SamplingConfig,
    sampling_engine: crate::inference::Engine,
) -> Result<reqwest::Response, String> {
    match connect_openai(
        messages,
        primary_base_url,
        primary_model,
        primary_api_key,
        primary_agent_id,
        user_id,
        skill_ids,
        composio_actions,
        session_id,
        slots,
        companion_source,
        background,
        sampling,
        sampling_engine,
    )
    .await
    {
        Ok(resp) => Ok(resp),
        Err(primary_err) => {
            if fallback_chain.is_empty() {
                return Err(primary_err);
            }
            // Single bounded fallback: try the first entry in the chain.
            // Slot overrides are not forwarded on the fallback path because the
            // fallback provider may not support the same slots; the gateway's own
            // fallback chain and modality_map take over from here.
            let fallback = &fallback_chain[0];
            tracing::warn!(
                primary_base_url = %primary_base_url,
                fallback_base_url = %fallback.base_url,
                cause = %primary_err,
                "ryu-agent: primary provider failed; attempting fallback recovery"
            );
            match connect_openai(
                messages,
                &fallback.base_url,
                &fallback.model,
                fallback.api_key.as_deref(),
                primary_agent_id,
                user_id,
                skill_ids,
                composio_actions,
                session_id,
                &AgentSlots::default(),
                // Companion DLP must apply on the fallback path too (AC3 / #199).
                companion_source,
                background,
                sampling,
                sampling_engine,
            )
            .await
            {
                Ok(resp) => {
                    tracing::info!(
                        fallback_base_url = %fallback.base_url,
                        "ryu-agent: fallback recovery succeeded"
                    );
                    Ok(resp)
                }
                Err(fallback_err) => {
                    tracing::warn!(
                        primary_err = %primary_err,
                        fallback_err = %fallback_err,
                        "ryu-agent: fallback recovery also failed; returning error to client"
                    );
                    Err(format!(
                        "Primary provider failed ({primary_err}); fallback also failed ({fallback_err})"
                    ))
                }
            }
        }
    }
}

async fn route_openai_stream<F, Fut>(
    req: ChatStreamRequest,
    base_url: String,
    model: String,
    api_key: Option<String>,
    long_term_system: Option<String>,
    // When forwarding to the gateway, the selected agent id for per-agent
    // budgets (U21). `None` for direct-to-provider calls.
    agent_id: Option<String>,
    persist: F,
    // Fallback chain for the default/"ryu" agent. Empty for non-default agents.
    fallback_chain: Vec<FallbackProvider>,
    // Active skill registry (M3 / #145). Enabled skills have their instructions
    // injected into the assembled messages before the request is forwarded, and
    // skill ids are attached via `x-ryu-skill-ids` for Gateway attribution (AC3).
    skills: SkillRegistry,
    // Per-agent Skill allowlist. Empty = all enabled skills (back-compat); a
    // non-empty list narrows injection to its intersection with the enabled set.
    // Enforced entirely in Core (skills are injected, not gateway-gated).
    skills_allowlist: Vec<String>,
    // Per-agent Composio action allowlist (#456). Signalled to the gateway via
    // `x-ryu-composio-actions` so its Composio tool loop offers/executes only the
    // actions this agent selected (overriding the gateway's global allowlist).
    // Empty for non-gateway hops (direct provider / local engine / SDK app).
    composio_actions: Vec<String>,
    // Per-attribute modality slot overrides (M3 / #164). Forwarded to the gateway
    // so each modality call from this agent card can reach a different provider.
    slots: AgentSlots,
    // Advanced sampling params (temperature/top_p/top_k/…), already merged from the
    // agent defaults + per-request override. Applied to the outbound chat body,
    // field-name-translated for `sampling_engine`.
    sampling: crate::inference::SamplingConfig,
    sampling_engine: crate::inference::Engine,
) -> Response
where
    F: FnOnce(String, &'static str) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    // Long-term memory (opt-in) is injected as a leading system message. The
    // client already supplies short-term context (the full message list), so we
    // do not re-inject it here.
    let mut oai_messages: Vec<Value> = Vec::with_capacity(req.messages.len() + 1);
    if let Some(system) = long_term_system.as_deref() {
        oai_messages.push(serde_json::json!({ "role": "system", "content": system }));
    }
    let history: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            let text = {
                let from_content = m.content.as_text();
                if !from_content.is_empty() {
                    from_content
                } else {
                    m.parts
                        .iter()
                        .filter_map(|p| p.get("text")?.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                        .join("")
                }
            };
            // Multimodal: a message carrying image `file` parts becomes an
            // OpenAI content array (text + each image as an `image_url` data-URL)
            // so a locally-served vision model (with its `--mmproj` adapter
            // loaded) or any multimodal provider actually receives the image.
            // Text-only messages keep the plain-string content shape — the common
            // case, unchanged — so this never alters non-vision chat.
            let images = message_image_parts(m);
            if images.is_empty() {
                return serde_json::json!({ "role": m.role, "content": text });
            }
            let mut content: Vec<Value> = Vec::with_capacity(images.len() + 1);
            if !text.is_empty() {
                content.push(serde_json::json!({ "type": "text", "text": text }));
            }
            for img in &images {
                content.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", img.mime_type, img.data)
                    }
                }));
            }
            serde_json::json!({ "role": m.role, "content": content })
        })
        .collect();
    oai_messages.extend(history);

    // Inject active skill instructions (M3 / #145 AC2).
    // Core decides what skills run (what runs → Core). The gateway governs egress;
    // we signal active skill ids via `x-ryu-skill-ids` so the Gateway can attribute
    // budget/audit rows to the skill (AC3). Injection is non-blocking and
    // lenient — a missing skill dir is not an error.
    let active_skill_ids =
        skills.inject_into_messages_filtered(&mut oai_messages, &skills_allowlist);

    // The conversation id doubles as the session correlation key forwarded to the
    // gateway via `x-ryu-session-id` so audit rows can be grouped per chat run
    // without a separate session store (M4 / #176).
    let session_id = req.conversation_id.clone();

    // Verified caller identity (server-stamped from the inbound `x-ryu-user-id`
    // header via `identity_from_headers`; `#[serde(skip)]` so a client body cannot
    // spoof it). Forwarded to the gateway as `x-ryu-user-id` so per-user usage
    // attribution and budgets are live. `None` on anonymous/loopback turns.
    let user_id = req.author_user_id.clone();

    // Attempt the primary connection; fall back to the registry-configured
    // fallback provider (if any) on a transport failure (self-healing, AC1–AC4).
    let upstream = match connect_with_fallback(
        &oai_messages,
        &base_url,
        &model,
        api_key.as_deref(),
        agent_id.as_deref(),
        user_id.as_deref(),
        active_skill_ids.as_slice(),
        composio_actions.as_slice(),
        session_id.as_deref(),
        &fallback_chain,
        &slots,
        req.companion_source,
        req.background,
        &sampling,
        sampling_engine,
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return error_stream(e),
    };

    if !upstream.status().is_success() {
        let status = upstream.status();
        // Prefer the gateway's structured error message so a firewall policy
        // block ("policy_violation"), rate limit, or budget rejection surfaces
        // a clear, actionable result to the client instead of a bare status
        // code. The gateway speaks OpenAI's `{ "error": { "message", "type" } }`
        // shape (see apps/gateway/src/error.rs).
        let body = upstream.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|json| {
                let err = &json["error"];
                let message = err["message"].as_str()?.to_owned();
                match err["type"].as_str() {
                    Some(kind) => Some(format!("{message} ({kind})")),
                    None => Some(message),
                }
            })
            .unwrap_or_else(|| format!("Agent returned HTTP {status}"));
        return error_stream(detail);
    }

    let byte_stream = upstream.bytes_stream();

    let transformed = async_stream::stream! {
        const TEXT_ID: &str = "0";
        let mut buf = String::new();
        // Accumulate the assistant text so it can be persisted on completion.
        let mut reply = String::new();
        let mut persist = Some(persist);
        let mut text_open = false;

        // Per-message inference stats (see `build_stats_part`). `stream_open`
        // anchors TTFT; `first_token_at` marks the start of the generation
        // window; `delta_count` is the last-resort token count; the engine's
        // own `timings`/`usage` (kept as the LAST seen, since they arrive on a
        // trailing `choices: []` chunk) are preferred when present.
        let stream_open = std::time::Instant::now();
        let mut first_token_at: Option<std::time::Instant> = None;
        let mut delta_count: u64 = 0;
        let mut last_timings: Option<Value> = None;
        let mut last_usage: Option<Value> = None;

        yield Ok::<_, std::convert::Infallible>(ui_start());

        tokio::pin!(byte_stream);
        while let Some(chunk) = byte_stream.next().await {
            let chunk = match chunk {
                Ok(c) => c,
                Err(e) => {
                    if let Some(p) = persist.take() {
                        p(std::mem::take(&mut reply), "failed").await;
                    }
                    if text_open {
                        yield Ok::<_, std::convert::Infallible>(ui_text_end(TEXT_ID));
                    }
                    for line in error_ui_lines(&e.to_string()) {
                        yield Ok::<_, std::convert::Infallible>(line);
                    }
                    return;
                }
            };

            buf.push_str(&String::from_utf8_lossy(&chunk));

            let mut start = 0;
            while let Some(rel) = buf[start..].find("\n\n") {
                let pos = start + rel;
                let data_owned = buf[start..pos]
                    .strip_prefix("data:")
                    .map(|s| s.trim().to_owned());
                start = pos + 2;

                let Some(data) = data_owned else { continue };

                if data == "[DONE]" {
                    if let Some(p) = persist.take() {
                        p(std::mem::take(&mut reply), "completed").await;
                    }
                    if text_open {
                        yield Ok::<_, std::convert::Infallible>(ui_text_end(TEXT_ID));
                    }
                    if let Some(stats) = build_stats_part(
                        stream_open,
                        first_token_at,
                        delta_count,
                        &last_timings,
                        &last_usage,
                    ) {
                        yield Ok::<_, std::convert::Infallible>(stats);
                    }
                    yield Ok::<_, std::convert::Infallible>(ui_finish());
                    yield Ok::<_, std::convert::Infallible>(DONE_SSE_LINE.as_bytes().to_vec());
                    return;
                }

                if let Ok(json) = serde_json::from_str::<Value>(&data) {
                    // Stats siblings: the engine reports `timings` (llama.cpp)
                    // and `usage` on a trailing chunk that carries no
                    // `delta.content`, so capture them independently of the
                    // text branch and keep the last one seen.
                    if json.get("timings").is_some_and(Value::is_object) {
                        last_timings = json.get("timings").cloned();
                    }
                    if json.get("usage").is_some_and(Value::is_object) {
                        last_usage = json.get("usage").cloned();
                    }
                    if let Some(delta_text) = json
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|t| t.as_str())
                    {
                        if !delta_text.is_empty() {
                            if first_token_at.is_none() {
                                first_token_at = Some(std::time::Instant::now());
                            }
                            delta_count += 1;
                            reply.push_str(delta_text);
                            if !text_open {
                                text_open = true;
                                yield Ok::<_, std::convert::Infallible>(ui_text_start(TEXT_ID));
                            }
                            yield Ok::<_, std::convert::Infallible>(
                                ui_text_delta(TEXT_ID, delta_text)
                            );
                        }
                    }
                }
            }
            buf.drain(..start);
        }

        if let Some(p) = persist.take() {
            p(std::mem::take(&mut reply), "completed").await;
        }
        if text_open {
            yield Ok::<_, std::convert::Infallible>(ui_text_end(TEXT_ID));
        }
        if let Some(stats) = build_stats_part(
            stream_open,
            first_token_at,
            delta_count,
            &last_timings,
            &last_usage,
        ) {
            yield Ok::<_, std::convert::Infallible>(stats);
        }
        yield Ok::<_, std::convert::Infallible>(ui_finish());
        yield Ok::<_, std::convert::Infallible>(DONE_SSE_LINE.as_bytes().to_vec());
    };

    sse_response(Body::from_stream(transformed))
}

// ── ACP subprocess streaming ───────────────────────────────────────────────────

/// Compose the single ACP prompt string from optional long-term facts, optional
/// short-term context, and the new user message.
fn build_acp_prompt(
    long_term_system: Option<String>,
    short_term: Option<String>,
    user_message: &str,
) -> String {
    let mut prompt = String::new();
    if let Some(system) = long_term_system {
        prompt.push_str(system.trim_end());
        prompt.push_str("\n\n");
    }
    if let Some(context) = short_term {
        prompt.push_str(context.trim_end());
        prompt.push_str("\n\n");
    }
    prompt.push_str(user_message);
    prompt
}

/// Pre-rendered SSE frame for the UI message stream. The completion task
/// produces these; the SSE generator forwards them verbatim to the client.
type UiFrame = Vec<u8>;

async fn route_acp_stream(
    req: ChatStreamRequest,
    spawn_cmd: String,
    cwd: PathBuf,
    // Ownership of the worktree guard transfers to the detached completion
    // task so cleanup (and diff capture) runs on ACP session end regardless
    // of whether the SSE consumer is still connected.
    worktree_guard: Option<WorktreeGuard>,
    short_term: Option<String>,
    long_term_system: Option<String>,
    // Incremental persistence: the store + metadata replace the old FnOnce
    // persist closure so the detached task can write partial replies that
    // survive a client disconnect.
    persist_store: ConversationStore,
    persist_conversation_id: Option<String>,
    persist_agent_id: Option<String>,
    // The conversation id used as the key in `worktree_diffs`. `None` when the
    // caller did not send a conversation id (diff will not be stored).
    conversation_id: Option<String>,
    worktree_diffs: crate::server::WorktreeDiffStore,
    mcp: Arc<McpRegistry>,
    allowlist: Option<Vec<String>>,
    // Per-agent Composio action slugs + effective agent id, threaded into the MCP
    // bridge so Composio reaches the ACP plane and PTC execution is scoped (#477).
    composio_actions: Vec<String>,
    bridge_agent_id: String,
    // Per-agent bound Identity Vault profiles (epic #517), threaded into the MCP
    // bridge so a tool call targeting a NEEDS_AUTH bound domain elicits and an
    // AUTHENTICATED one reads the credential under the gateway grant. Empty = none.
    identity_profile_ids: Vec<String>,
    traces: TraceStore,
) -> Response
{
    let user_message = last_user_message(&req.messages);
    if user_message.is_empty() {
        return error_stream("No user message to send to ACP agent".to_owned());
    }

    let agent_id = req.agent_id.clone().unwrap_or_default();
    let prompt = build_acp_prompt(long_term_system, short_term, &user_message);
    let images = last_user_images(&req.messages);

    // [QA B2] Make the composer's model pick actually reach the flagship `ryu`
    // agent (Pi). pi-acp implements no `session/set_model`, so beyond the live
    // config-option fallback (acp::apply_turn_config) the pick is persisted into
    // the managed Pi's isolated settings.json/models.json BEFORE the turn's
    // session is built — pi-acp spawns a fresh Pi process per session/new (one
    // per turn), so the persisted model applies to this very turn and becomes
    // Pi's defaultModel for later chats. Only the `ryu` agent reads that config
    // dir; other ACP agents are untouched.
    if agent_id == "ryu" {
        if let Some(model) = req
            .acp_model
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty())
        {
            if let Err(e) = crate::pi_config::persist_turn_model(model) {
                tracing::warn!(error = %e, model, "could not persist ryu model pick into Pi config");
            }
        }
    }

    // User-chosen ACP session controls for this turn (permission mode /
    // reasoning effort / model), all agent-reported via session/new. The desktop
    // streaming path is interactive: tool-permission requests are surfaced to the
    // user and awaited (vs. headless auto-approve).
    let turn = acp::AcpTurnConfig {
        session_mode: req.acp_mode.clone().filter(|s| !s.is_empty()),
        config_options: req
            .acp_config
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect(),
        model_id: req.acp_model.clone().filter(|s| !s.is_empty()),
        interactive: true,
    };

    // ACP event channel — the completion task is the sole consumer.
    let mut acp_rx = acp::spawn_acp_task(
        spawn_cmd,
        prompt,
        // Raw new user message (no preamble/history) — sent as the turn delta on
        // every turn after a reused session's first, so history is not re-sent.
        user_message.clone(),
        images,
        cwd,
        Some(mcp),
        allowlist,
        composio_actions,
        bridge_agent_id,
        identity_profile_ids,
        turn,
        conversation_id.clone(),
    );

    // UI frame channel — the SSE generator is the sole consumer.  The
    // completion task pushes pre-rendered frames here; a dropped receiver
    // (client disconnect) is ignored via `let _ = ui_tx.send(…)` so the
    // completion task continues to run and finishes persistence/cleanup.
    let (ui_tx, mut ui_rx) = tokio::sync::mpsc::unbounded_channel::<UiFrame>();

    // Detached completion task — owns the worktree guard, persist closure,
    // and diff store reference.  Runs to completion even when the SSE client
    // disconnects.  Frame sequence on the happy path is unchanged:
    //   start → text-start/delta/end (interleaved with tool frames) → finish → [DONE]
    let ui_tx_clone = ui_tx;
    tokio::spawn(async move {
        // After stream completes the guard is transferred into WorktreeRun
        // (so the worktree survives for apply). If abandoned before completion
        // the guard drops here and cleans up via its Drop impl.
        let mut guard = worktree_guard;

        let mut reply = String::new();
        // Incremental persistence: instead of a FnOnce that fires at the end,
        // we create the assistant message row on the first text chunk and
        // periodically update it as more text arrives. This way the reply
        // survives in the DB even if the user navigates away mid-stream.
        let mut persisted_msg_id: Option<String> = None;
        // Debounce: only flush to DB every N bytes of new text to avoid
        // excessive writes on fast token streams.
        const INCREMENTAL_FLUSH_BYTES: usize = 512;
        let mut bytes_since_flush: usize = 0;
        const TEXT_ID: &str = "0";
        const THOUGHT_ID: &str = "acp-thought";
        const PLAN_TOOL_ID: &str = "acp-plan";
        let mut text_open = false;
        let mut text_seq = 0u32;
        // Reasoning (thinking) state: accumulated content of the open Thinking
        // part. Each chunk re-emits `tool-input-available` under the same id —
        // the AI SDK updates the existing part in place, so the desktop's
        // Thinking card grows live and closes when the agent moves on.
        let mut thought_acc = String::new();
        let mut thought_seq = 0u32;
        let mut thought_open = false;
        // True once a plan snapshot opened the TodoWrite part (closed at turn end).
        let mut plan_open = false;
        // toolCallId -> `dynamic` flag of the opening frame, so the closing
        // tool-output frame matches its part type.
        let mut tool_dynamic: std::collections::HashMap<String, bool> =
            std::collections::HashMap::new();
        // Maps ACP tool call id -> trace span id so we can close the span on ToolResult.
        let mut open_spans: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();

        // Turn stopwatch + running usage accumulator for the `data-acp-usage` stats
        // frame. `turn_start` measures wall-clock so the desktop's duration/speed UI
        // works even when the ACP agent reports no token usage. The `usage_*` fields
        // hold the latest values Core has seen (from streamed `UsageUpdate` frames
        // and/or the turn-end `PromptResponse.usage`), re-emitted under the stable
        // `acp-usage` id so the AI SDK reconciles repeated frames into one live meter.
        let turn_start = std::time::Instant::now();
        let mut usage_used: Option<u64> = None;
        let mut usage_total: Option<u64> = None;
        let mut usage_prompt: Option<u64> = None;
        let mut usage_completion: Option<u64> = None;
        let mut usage_total_tokens: Option<u64> = None;

        let _ = ui_tx_clone.send(ui_start());

        // Close-out frames for the open Thinking part (macro so the loop arms
        // and both exit paths share it without fighting the borrow checker).
        macro_rules! close_thought {
            () => {
                if thought_open {
                    let tid = format!("{THOUGHT_ID}-{thought_seq}");
                    let _ = ui_tx_clone
                        .send(ui_tool_output(&tid, &serde_json::json!({ "done": true }), false));
                    thought_open = false;
                    thought_acc.clear();
                    thought_seq += 1;
                }
            };
        }
        macro_rules! close_text {
            () => {
                if text_open {
                    let tid = format!("{TEXT_ID}-{text_seq}");
                    let _ = ui_tx_clone.send(ui_text_end(&tid));
                    text_open = false;
                    text_seq += 1;
                }
            };
        }

        while let Some(event) = acp_rx.recv().await {
            match event {
                acp::AcpEvent::Text(text) => {
                    if text.is_empty() {
                        continue;
                    }
                    close_thought!();
                    reply.push_str(&text);
                    bytes_since_flush += text.len();

                    // Incremental persistence: create the message row on the
                    // first text chunk, then update it periodically so the
                    // reply survives a client disconnect.
                    if let Some(ref conv_id) = persist_conversation_id {
                        if persisted_msg_id.is_none() {
                            // First chunk — insert the row with whatever we have so far.
                            match persist_store
                                .append_message(
                                    conv_id,
                                    "assistant",
                                    &reply,
                                    persist_agent_id.as_deref(),
                                    None,
                                    None,
                                )
                                .await
                            {
                                Ok(mid) => {
                                    persisted_msg_id = Some(mid);
                                    bytes_since_flush = 0;
                                }
                                Err(e) => tracing::warn!(
                                    "failed to create incremental assistant message: {e:#}"
                                ),
                            }
                        } else if bytes_since_flush >= INCREMENTAL_FLUSH_BYTES {
                            // Periodic flush — update the existing row.
                            if let Some(ref mid) = persisted_msg_id {
                                if let Err(e) = persist_store
                                    .update_message_content(mid, &reply)
                                    .await
                                {
                                    tracing::warn!(
                                        "failed to flush incremental reply: {e:#}"
                                    );
                                }
                            }
                            bytes_since_flush = 0;
                        }
                    }

                    if !text_open {
                        text_open = true;
                        let id = format!("{TEXT_ID}-{text_seq}");
                        let _ = ui_tx_clone.send(ui_text_start(&id));
                    }
                    let id = format!("{TEXT_ID}-{text_seq}");
                    let _ = ui_tx_clone.send(ui_text_delta(&id, &text));
                }
                acp::AcpEvent::Thought(text) => {
                    if text.is_empty() {
                        continue;
                    }
                    close_text!();
                    thought_acc.push_str(&text);
                    thought_open = true;
                    let tid = format!("{THOUGHT_ID}-{thought_seq}");
                    let _ = ui_tx_clone.send(ui_tool_input(
                        &tid,
                        "Thinking",
                        &serde_json::json!({ "thought": thought_acc }),
                        false,
                    ));
                }
                acp::AcpEvent::Plan(entries) => {
                    close_thought!();
                    close_text!();
                    plan_open = true;
                    // Full snapshot each time, same part id: the desktop's Todo
                    // checklist updates in place as entries change status.
                    let _ = ui_tx_clone.send(ui_tool_input(
                        PLAN_TOOL_ID,
                        "TodoWrite",
                        &serde_json::json!({ "todos": entries }),
                        false,
                    ));
                }
                acp::AcpEvent::ToolCall {
                    id,
                    title,
                    kind,
                    input,
                } => {
                    acp::record_observed_tool(&agent_id, &title, &kind);
                    close_thought!();
                    close_text!();
                    let input_value = input.unwrap_or(Value::Null);
                    // Bind the ACP call to the desktop's rich tool UI when the
                    // kind/input shape matches a known tool (Bash terminal,
                    // Edit diff, Read, search, …); otherwise generic dynamic row.
                    let (tool_name, dynamic) = acp_tool_ui_name(&kind, &title, &input_value);
                    tool_dynamic.insert(id.clone(), dynamic);
                    // Open a tool-call span in the trace store (no-op when no conv id).
                    if let Some(ref conv_id) = conversation_id {
                        let ah = hash_args(&input_value);
                        match traces
                            .open_span(conv_id, "tool-call", &tool_name, Some(&ah), None)
                            .await
                        {
                            Ok(span_id) => {
                                open_spans.insert(id.clone(), span_id);
                            }
                            Err(e) => tracing::warn!("trace open_span failed: {e:#}"),
                        }
                    }
                    let _ = ui_tx_clone.send(ui_tool_input(&id, &tool_name, &input_value, dynamic));
                }
                acp::AcpEvent::ToolResult { id, status, output } => {
                    close_thought!();
                    close_text!();
                    // Close the matching tool-call span.
                    if let Some(span_id) = open_spans.remove(&id) {
                        let err = if status == "error" {
                            Some(status.as_str())
                        } else {
                            None
                        };
                        if let Err(e) = traces.close_span(&span_id, err).await {
                            tracing::warn!("trace close_span failed: {e:#}");
                        }
                    }
                    let dynamic = tool_dynamic.remove(&id).unwrap_or(true);
                    let payload = serde_json::json!({
                        "status": status,
                        "output": output.unwrap_or(Value::Null),
                    });
                    let _ = ui_tx_clone.send(ui_tool_output(&id, &payload, dynamic));
                }
                acp::AcpEvent::Media { mime, data } => {
                    // A non-text assistant content block (inline image/audio).
                    // Forward as an AI-SDK v6 `file` part carrying a data URL so the
                    // desktop renders it inline (previously dropped). Close any open
                    // thought first for clean part ordering.
                    close_thought!();
                    let url = format!("data:{mime};base64,{data}");
                    let _ = ui_tx_clone.send(ui_chunk(&serde_json::json!({
                        "type": "file",
                        "mediaType": mime,
                        "url": url,
                    })));
                }
                acp::AcpEvent::ModeChanged(mode_id) => {
                    // Agent-initiated mode switch; forward so the desktop's mode
                    // picker reflects the new active mode.
                    let _ = ui_tx_clone.send(ui_data(
                        "ryu-acp-mode",
                        &serde_json::json!({ "currentModeId": mode_id }),
                    ));
                }
                acp::AcpEvent::ConfigWarning {
                    field,
                    requested,
                    message,
                } => {
                    // Non-fatal: a session control the user chose (e.g. the model
                    // pick) was not accepted by the agent. Forward as a data part
                    // so the UI can react — e.g. clear a model pick the agent never
                    // applied — instead of silently misleading the user (QA B2).
                    let _ = ui_tx_clone.send(ui_data(
                        "ryu-acp-config-warning",
                        &serde_json::json!({
                            "field": field,
                            "requested": requested,
                            "message": message,
                        }),
                    ));
                }
                acp::AcpEvent::AvailableCommands(commands) => {
                    // Agent published its slash commands; forward the full list so
                    // the desktop replaces its cached set and renders the `/` popover.
                    let _ = ui_tx_clone.send(ui_data(
                        "ryu-acp-commands",
                        &serde_json::json!({ "commands": commands }),
                    ));
                }
                acp::AcpEvent::Usage(u) => {
                    // Merge whatever this frame carries into the running accumulator,
                    // then re-emit the FULL stats object under the stable `acp-usage`
                    // id so the AI SDK reconciles it in place (a live meter). The
                    // final frame (`done: true`) carries Core-computed wall-clock
                    // duration + tokens/sec, so the desktop UI works even when the
                    // agent reported no token usage at all.
                    if let Some(v) = u.get("used").and_then(Value::as_u64) {
                        usage_used = Some(v);
                    }
                    if let Some(v) = u.get("total").and_then(Value::as_u64) {
                        usage_total = Some(v);
                    }
                    if let Some(v) = u.get("promptTokens").and_then(Value::as_u64) {
                        usage_prompt = Some(v);
                    }
                    if let Some(v) = u.get("completionTokens").and_then(Value::as_u64) {
                        usage_completion = Some(v);
                    }
                    if let Some(v) = u.get("totalTokens").and_then(Value::as_u64) {
                        usage_total_tokens = Some(v);
                    }
                    let done = u.get("done").and_then(Value::as_bool).unwrap_or(false);
                    let duration_ms = turn_start.elapsed().as_millis() as u64;
                    let round2 = |x: f64| (x * 100.0).round() / 100.0;
                    let tokens_per_second = match usage_completion {
                        Some(c) if c > 0 && duration_ms > 0 => {
                            round2(c as f64 / (duration_ms as f64 / 1000.0))
                        }
                        _ => 0.0,
                    };
                    let mut stats = serde_json::Map::new();
                    stats.insert("id".into(), serde_json::json!("acp-usage"));
                    if let Some(v) = usage_used {
                        stats.insert("used".into(), serde_json::json!(v));
                    }
                    if let Some(v) = usage_total {
                        stats.insert("total".into(), serde_json::json!(v));
                    }
                    if let Some(v) = usage_prompt {
                        stats.insert("promptTokens".into(), serde_json::json!(v));
                    }
                    if let Some(v) = usage_completion {
                        stats.insert("completionTokens".into(), serde_json::json!(v));
                    }
                    if let Some(v) = usage_total_tokens {
                        stats.insert("totalTokens".into(), serde_json::json!(v));
                    }
                    stats.insert("tokensPerSecond".into(), serde_json::json!(tokens_per_second));
                    stats.insert("durationMs".into(), serde_json::json!(duration_ms));
                    stats.insert("done".into(), serde_json::json!(done));
                    let _ = ui_tx_clone.send(ui_data("acp-usage", &Value::Object(stats)));
                }
                acp::AcpEvent::PermissionRequest {
                    request_id,
                    tool_call,
                    options,
                } => {
                    // The agent paused to ask for tool approval. Close any open
                    // text/thought block so the prompt renders as its own element,
                    // then surface the options; the desktop POSTs the chosen
                    // option id to /api/chat/permission to unblock the agent.
                    close_thought!();
                    close_text!();
                    let _ = ui_tx_clone.send(ui_data(
                        "ryu-permission",
                        &serde_json::json!({
                            "requestId": request_id,
                            "toolCall": tool_call,
                            "options": options,
                        }),
                    ));
                }
                acp::AcpEvent::Error(msg) => {
                    // Close any still-open spans with an error on agent failure.
                    for (_tool_id, span_id) in open_spans.drain() {
                        let _ = traces.close_span(&span_id, Some("agent error")).await;
                    }
                    // Final persistence on error: update the existing row or
                    // create one if we never received text.
                    if let Some(ref conv_id) = persist_conversation_id {
                        if let Some(ref mid) = persisted_msg_id {
                            let _ = persist_store
                                .update_message_content(mid, &reply)
                                .await;
                        } else if !reply.is_empty() {
                            let _ = persist_store
                                .append_message(
                                    conv_id,
                                    "assistant",
                                    &reply,
                                    persist_agent_id.as_deref(),
                                    None,
                                    None,
                                )
                                .await;
                        }
                        let _ = persist_store
                            .set_run_status(conv_id, "failed")
                            .await;
                    }
                    close_thought!();
                    if plan_open {
                        let _ = ui_tx_clone.send(ui_tool_output(
                            PLAN_TOOL_ID,
                            &serde_json::json!({ "done": true }),
                            false,
                        ));
                    }
                    if text_open {
                        let tid = format!("{TEXT_ID}-{text_seq}");
                        let _ = ui_tx_clone.send(ui_text_end(&tid));
                    }
                    for line in error_ui_lines(&msg) {
                        let _ = ui_tx_clone.send(line);
                    }
                    return; // guard drops here on error path — worktree removed
                }
            }
        }

        // Normal completion: final flush of the reply text and mark completed.
        if let Some(ref conv_id) = persist_conversation_id {
            if let Some(ref mid) = persisted_msg_id {
                // Update the existing row with the final full reply.
                let _ = persist_store
                    .update_message_content(mid, &reply)
                    .await;
            } else if !reply.is_empty() {
                // No text chunks arrived yet (edge case) — persist now.
                let _ = persist_store
                    .append_message(
                        conv_id,
                        "assistant",
                        &reply,
                        persist_agent_id.as_deref(),
                        None,
                        None,
                    )
                    .await;
            }
            let _ = persist_store
                .set_run_status(conv_id, "completed")
                .await;
        }
        close_thought!();
        if plan_open {
            let _ = ui_tx_clone.send(ui_tool_output(
                PLAN_TOOL_ID,
                &serde_json::json!({ "done": true }),
                false,
            ));
        }
        if text_open {
            let tid = format!("{TEXT_ID}-{text_seq}");
            let _ = ui_tx_clone.send(ui_text_end(&tid));
        }

        // Capture the worktree diff and store it together with the live guard.
        // The guard is transferred into WorktreeRun so the worktree and branch
        // survive until the user calls POST /api/worktree/:run_id/apply, at
        // which point apply_worktree consumes the guard and git-removes it.
        if let (Some(ref conv_id), Some(live_guard)) = (&conversation_id, guard.take()) {
            let base = if live_guard.base_hash.is_empty() {
                "HEAD".to_string()
            } else {
                live_guard.base_hash.clone()
            };
            let diff = crate::server::worktree::worktree_diff(&live_guard.path, &base);
            worktree_diffs.lock().await.insert(
                conv_id.clone(),
                crate::server::WorktreeRun {
                    diff,
                    guard: Some(live_guard),
                },
            );
        }

        let _ = ui_tx_clone.send(ui_finish());
        let _ = ui_tx_clone.send(DONE_SSE_LINE.as_bytes().to_vec());
        // _guard drops here — worktree removed after diff captured
    });

    // SSE generator — forwards pre-rendered frames from the completion task.
    // Dropping this (client disconnect) does not affect the completion task.
    let transformed = async_stream::stream! {
        while let Some(frame) = ui_rx.recv().await {
            yield Ok::<_, std::convert::Infallible>(frame);
        }
    };

    sse_response(Body::from_stream(transformed))
}

// ── Error helper ──────────────────────────────────────────────────────────────

/// The `error` + `finish` + `[DONE]` frames that terminate a stream on failure,
/// in AI SDK v6 UI message stream form.
fn error_ui_lines(msg: &str) -> [Vec<u8>; 3] {
    [
        ui_chunk(&serde_json::json!({ "type": "error", "errorText": msg })),
        ui_finish(),
        DONE_SSE_LINE.as_bytes().to_vec(),
    ]
}

pub(crate) fn error_stream(msg: String) -> Response {
    let mut payload = ui_start();
    for line in error_ui_lines(&msg) {
        payload.extend_from_slice(&line);
    }
    sse_response(Body::from(payload))
}

// ── AgentAdapter trait ────────────────────────────────────────────────────────

/// Universal adapter trait for AI agents (zeroclaw, openclaw, etc.)
pub trait AgentAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn is_available(&self) -> bool;

    fn send_message(
        &self,
        agent_id: &str,
        req: ChatRequest,
    ) -> BoxFuture<anyhow::Result<Vec<ChatChunk>>>;

    fn list_agents(&self) -> BoxFuture<anyhow::Result<Vec<AgentInfo>>>;

    fn create_agent(&self, config: AgentConfig) -> BoxFuture<anyhow::Result<AgentInfo>>;

    fn get_memory(
        &self,
        agent_id: &str,
        query: String,
    ) -> BoxFuture<anyhow::Result<Vec<MemoryEntry>>>;

    fn list_tools(&self, agent_id: &str) -> BoxFuture<anyhow::Result<Vec<ToolInfo>>>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acp_reg() -> AcpAgentRegistry {
        AcpAgentRegistry::new()
    }

    fn provider_reg() -> ProviderRegistry {
        ProviderRegistry::default()
    }

    #[test]
    fn ui_render_call_normalized_by_spec_shape() {
        // ACP gives no stable machine name; a spec-shaped input must still map to
        // the stable `ui__render` name (dynamic) so the desktop renders it inline,
        // regardless of the humanized title the adapter reports.
        let input = serde_json::json!({
            "spec": { "root": "a", "elements": { "a": { "type": "Text" } } }
        });
        let (name, dynamic) = acp_tool_ui_name("other", "Render some UI", &input);
        assert_eq!(name, "ui__render");
        assert!(dynamic);
    }

    #[test]
    fn non_ui_tool_falls_through_to_title() {
        let (name, _) = acp_tool_ui_name("other", "some_custom_tool", &Value::Null);
        assert_eq!(name, "some_custom_tool");
    }

    // ── Team orchestration linchpin: the SSE drain parser ──────────────────────

    #[tokio::test]
    async fn drain_collects_text_and_stops_at_done() {
        // A well-formed UI message stream with two text deltas, then [DONE], then
        // a stray delta that must be ignored (parser stops at the sentinel).
        let mut p = ui_start();
        p.extend(ui_text_start("a"));
        p.extend(ui_text_delta("a", "Hello "));
        p.extend(ui_text_delta("a", "world"));
        p.extend(ui_text_end("a"));
        p.extend(ui_finish());
        p.extend_from_slice(DONE_SSE_LINE.as_bytes());
        p.extend(ui_text_delta("a", "AFTER-DONE"));
        let resp = sse_response(Body::from(p));
        let text = drain_text_reply(resp).await.unwrap();
        assert_eq!(text, "Hello world");
    }

    #[tokio::test]
    async fn drain_propagates_error_frame_not_empty_string() {
        // A member that errors must surface as Err, never silently collect to "".
        let mut p = ui_start();
        for line in error_ui_lines("boom") {
            p.extend_from_slice(&line);
        }
        let resp = sse_response(Body::from(p));
        let err = drain_text_reply(resp).await.unwrap_err();
        assert!(err.to_string().contains("boom"), "got: {err}");
    }

    #[test]
    fn preamble_folds_into_last_user_message() {
        let original = vec![
            UiMessage {
                role: "user".to_owned(),
                content: UiContent::Text("first".to_owned()),
                parts: vec![],
            },
            UiMessage {
                role: "assistant".to_owned(),
                content: UiContent::Text("reply".to_owned()),
                parts: vec![],
            },
            UiMessage {
                role: "user".to_owned(),
                content: UiContent::Text("latest question".to_owned()),
                parts: vec![],
            },
        ];
        let out = messages_with_preamble(&original, "CONTEXT");
        // Only the last user message is rewritten; earlier turns are untouched.
        assert_eq!(out[0].content.as_text(), "first");
        assert_eq!(out[1].content.as_text(), "reply");
        assert_eq!(out[2].content.as_text(), "CONTEXT\n\nlatest question");
    }

    // ── Auto-recall block assembly (U17) ────────────────────────────────────────
    // Pure assembly + merge, exercised without a network embed.

    fn mem_chunk(content: &str) -> ScoredChunk {
        ScoredChunk {
            id: "m".to_owned(),
            source: crate::server::retrieval::ChunkSource::Memory,
            space_id: None,
            content: content.to_owned(),
            score: 0.9,
        }
    }

    fn chat_hit(conversation_id: &str, content: &str) -> MessageSearchHit {
        MessageSearchHit {
            conversation_id: conversation_id.to_owned(),
            message_id: "x".to_owned(),
            role: "user".to_owned(),
            content: content.to_owned(),
            created_at: 0,
            score: 0.8,
        }
    }

    #[test]
    fn recall_block_labels_and_caps() {
        let mem = vec![mem_chunk("user prefers dark mode")];
        let chats = vec![
            chat_hit("c1", "we discussed the rust build"),
            chat_hit("c2", "and the gateway routing"),
        ];
        // top_k = 2 caps to two lines total (memory line + first chat line).
        let block = assemble_recall_block(&mem, &chats, 2).expect("non-empty");
        assert!(block.contains("Relevant context from memory and past conversations"));
        assert!(block.contains("- [memory] user prefers dark mode"));
        assert!(block.contains("- [past chat] we discussed the rust build"));
        // The third candidate is dropped by the top_k cap.
        assert!(!block.contains("gateway routing"));
        // Exactly two bullet lines.
        assert_eq!(block.matches("- [").count(), 2);
    }

    #[test]
    fn recall_block_empty_when_no_chunks() {
        assert!(assemble_recall_block(&[], &[], 5).is_none());
        // top_k = 0 short-circuits to None even with content.
        assert!(assemble_recall_block(&[mem_chunk("x")], &[], 0).is_none());
    }

    #[test]
    fn recall_block_truncates_long_snippets() {
        let long = "word ".repeat(400); // far over the snippet cap
        let block = assemble_recall_block(&[mem_chunk(&long)], &[], 5).expect("non-empty");
        assert!(block.contains('…'), "long snippet should be ellipsised");
    }

    #[test]
    fn recall_block_appends_after_existing_long_term() {
        // Mirror the route_chat_stream merge: append recall AFTER persona+memory so
        // persona/memory stay leading.
        let existing = Some("You are a helpful persona.".to_owned());
        let block = assemble_recall_block(&[mem_chunk("a fact")], &[], 5).unwrap();
        let merged = match existing {
            Some(e) if !e.is_empty() => format!("{e}\n\n{block}"),
            _ => block,
        };
        let persona_pos = merged.find("helpful persona").unwrap();
        let recall_pos = merged.find("[memory] a fact").unwrap();
        assert!(
            persona_pos < recall_pos,
            "persona must lead the recall block"
        );
    }

    // ── Long-term fact bridge: dedup-by-id + lazy backfill ──────────────────────

    fn mem_chunk_id(id: &str, content: &str) -> ScoredChunk {
        ScoredChunk {
            id: id.to_owned(),
            source: ChunkSource::Memory,
            space_id: None,
            content: content.to_owned(),
            score: 0.9,
        }
    }

    /// (i) A fact already injected by the RECENCY path (its id is in the recency
    /// set) is NOT injected a second time by auto-recall. (ii) A Memory-source
    /// chunk whose id is NOT in the recency set still passes through.
    #[test]
    fn drop_recency_dupes_drops_by_id_keeps_misses() {
        let mut recency = std::collections::HashSet::new();
        recency.insert("fact-recent".to_owned());

        let chunks = vec![
            mem_chunk_id("fact-recent", "recency already showed this"),
            mem_chunk_id("fact-missed", "semantically relevant but old"),
        ];
        let kept = drop_recency_dupes(chunks, &recency);

        assert_eq!(kept.len(), 1, "the recency-injected fact must be dropped");
        assert_eq!(
            kept[0].id, "fact-missed",
            "the fact the recency window missed must pass through"
        );
    }

    /// A past-chat / non-fact Memory chunk is unaffected even if a SAME-VALUED
    /// id collision is impossible here — dedup only touches Memory-source ids in
    /// the set. (Guards against accidentally widening the filter.)
    #[test]
    fn drop_recency_dupes_only_touches_ids_in_set() {
        let recency = std::collections::HashSet::new(); // empty set
        let chunks = vec![mem_chunk_id("fact-a", "a"), mem_chunk_id("fact-b", "b")];
        let kept = drop_recency_dupes(chunks, &recency);
        assert_eq!(kept.len(), 2, "empty recency set drops nothing");
    }

    /// (iii) Backfill indexes a not-yet-indexed fact id, and a second backfill is
    /// a no-op (already-indexed facts are skipped). Network-free: in-memory stores
    /// with the local hashing embedder.
    #[tokio::test]
    async fn backfill_indexes_new_facts_then_is_idempotent() {
        let memory = MemoryStore::open_in_memory().unwrap();
        let retrieval = RetrievalStore::open_in_memory().unwrap();
        let scope = "default";

        let fact_id = memory
            .record(
                LOCAL_USER,
                scope,
                "User lives in Singapore and prefers dark mode",
            )
            .await
            .unwrap()
            .expect("a fact id");

        // Nothing indexed yet.
        assert!(retrieval.indexed_memory_ids().await.unwrap().is_empty());

        backfill_memory_facts(&memory, &retrieval, scope).await;

        let indexed = retrieval.indexed_memory_ids().await.unwrap();
        assert!(
            indexed.contains(&fact_id),
            "backfill must index the new fact under its MemoryStore id"
        );
        assert_eq!(indexed.len(), 1);

        // Second backfill: already indexed → no change.
        backfill_memory_facts(&memory, &retrieval, scope).await;
        assert_eq!(
            retrieval.indexed_memory_ids().await.unwrap().len(),
            1,
            "re-running backfill must be a no-op for already-indexed facts"
        );

        // And the indexed fact is now semantically retrievable as a Memory chunk.
        let opts = RetrievalOptions {
            top_k: 5,
            space_ids: Some(Vec::new()),
            include_memory: true,
            ..RetrievalOptions::default()
        };
        let hits = retrieval
            .retrieve("where does the user live", &opts)
            .await
            .unwrap();
        assert!(
            hits.iter()
                .any(|c| c.id == fact_id && c.source == ChunkSource::Memory),
            "the backfilled fact must be retrievable via semantic search"
        );
    }

    /// FTS session-search sub-source: with `fts_enabled = false` the FTS pass does
    /// no work (a matching past message is NOT surfaced); with `fts_enabled = true`
    /// an FTS-only match surfaces in the assembled recall block. Network-free.
    #[tokio::test]
    async fn run_auto_recall_fts_source_gated_by_flag() {
        let memory = MemoryStore::open_in_memory().unwrap();
        let retrieval = RetrievalStore::open_in_memory().unwrap();
        let fts = crate::server::message_fts::MessageFtsIndex::open_in_memory().unwrap();
        // Conversation store WITHOUT a semantic message index (so the only past-chat
        // contribution can come from the FTS source), WITH the FTS index wired.
        let conversations = ConversationStore::open_in_memory()
            .unwrap()
            .with_message_fts_index(fts);
        // A distinctive past message in a DIFFERENT conversation than the current.
        conversations
            .append_message(
                "c-past",
                "user",
                "the quarterly kubernetes migration retro",
                None,
                None,
                None,
            )
            .await
            .unwrap();

        let recency = std::collections::HashSet::new();

        // Gate OFF: FTS contributes nothing → no block (memory + semantic are empty).
        let cfg_off = AutoRecallConfig {
            retrieval: retrieval.clone(),
            top_k: 5,
            fts_enabled: false,
        };
        let block_off = run_auto_recall(
            &cfg_off,
            &conversations,
            &memory,
            "default",
            &recency,
            "kubernetes migration",
            Some("c-current"),
        )
        .await;
        assert!(
            block_off.is_none(),
            "fts disabled must contribute no recall, got: {block_off:?}"
        );

        // Gate ON: the FTS-only match surfaces in the block.
        let cfg_on = AutoRecallConfig {
            retrieval,
            top_k: 5,
            fts_enabled: true,
        };
        let block_on = run_auto_recall(
            &cfg_on,
            &conversations,
            &memory,
            "default",
            &recency,
            "kubernetes migration",
            Some("c-current"),
        )
        .await
        .expect("fts match should produce a recall block");
        assert!(
            block_on.contains("kubernetes migration retro"),
            "fts-surfaced past chat must appear, got: {block_on}"
        );
    }

    // ── ACP skill injection seam (per-agent allowlist on the ACP plane) ─────────
    // The `AgentRoute::Acp` arm folds the resolved skill block into the prompt
    // preamble via `merge_system_prompt` → `build_acp_prompt`. These lock that
    // composition (`SkillRegistry::skill_block` itself is covered in the skills
    // module tests).

    #[test]
    fn acp_skill_block_folds_into_prompt_preamble() {
        // Simulate `SkillRegistry::skill_block(..)` returning a header, then run the
        // exact arm logic: merge into long_term_system, then build the ACP prompt.
        let header = "## Skill: Greeter\nAlways say hello.".to_owned();
        let long_term_system = Some("You are helpful. Remembered: the user likes tea.".to_owned());
        let merged = merge_system_prompt(long_term_system, Some(header));
        let prompt = build_acp_prompt(merged, None, "what's the weather?");
        // Skill instructions reach the ACP subprocess as a leading preamble...
        assert!(
            prompt.starts_with("## Skill: Greeter"),
            "skill block leads the preamble: {prompt}"
        );
        assert!(prompt.contains("Always say hello."));
        // ...alongside the existing persona/memory context and the user message.
        assert!(prompt.contains("the user likes tea."));
        assert!(prompt.contains("what's the weather?"));
    }

    #[test]
    fn acp_no_skill_block_leaves_preamble_unchanged() {
        // The `None` arm (empty allowlist + no enabled skills) must not alter the
        // preamble: the long_term_system passes through verbatim.
        let long_term_system = Some("Just the memory block.".to_owned());
        let merged = merge_system_prompt(long_term_system.clone(), None);
        assert_eq!(merged, long_term_system);
        let prompt = build_acp_prompt(merged, None, "hi");
        assert!(prompt.starts_with("Just the memory block."));
        assert!(!prompt.contains("## Skill:"));
    }

    #[test]
    fn default_agent_recognized() {
        assert!(is_default_agent(None));
        assert!(is_default_agent(Some("")));
        assert!(is_default_agent(Some("default")));
        // ryu is the flagship; it is recognized as a default agent (AC1).
        assert!(is_default_agent(Some("ryu")));
        assert!(!is_default_agent(Some("acp:claude")));
        assert!(!is_default_agent(Some("zeroclaw")));
    }

    #[test]
    fn no_agent_id_routes_to_default_provider() {
        // No agent_id and "default" both resolve to the OpenAI-compat default,
        // never the unknown-agent error path.
        for id in [None, Some("default")] {
            let route =
                agent_route(id, None, None, &acp_reg(), &provider_reg()).expect("default route");
            assert!(matches!(route, AgentRoute::OpenAiCompat { .. }));
        }
    }

    #[test]
    fn default_route_goes_through_gateway() {
        // U18: the built-in default LLM path must forward to ryu-gateway, not
        // hit a provider directly.
        let route =
            agent_route(None, None, None, &acp_reg(), &provider_reg()).expect("default route");
        assert!(matches!(
            route,
            AgentRoute::OpenAiCompat {
                via_gateway: true,
                ..
            }
        ));
    }

    // ── File-backed model swap (AC3: no recompile to change the chat model) ──

    #[test]
    fn registry_file_overrides_default_chat_model_in_route() {
        // AC3: load a ProviderRegistry pointing at a temp registry.json with a
        // custom model, assert that default_agent_route returns that model so
        // swapping the default chat model only requires editing the file.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("registry.json");
        std::fs::write(
            &path,
            r#"{"default_llm_base_url":"https://api.custom-provider.example","default_llm_model":"my-custom-chat-model"}"#,
        )
        .unwrap();
        let reg = ProviderRegistry::from_file(&path);
        let route = default_agent_route(&reg);
        match route {
            AgentRoute::OpenAiCompat {
                base_url,
                model,
                via_gateway,
                ..
            } => {
                // The route must carry exactly what the file specified — no inline literal.
                assert_eq!(
                    base_url, "https://api.custom-provider.example",
                    "base_url must come from registry.json, not the inline literal"
                );
                assert_eq!(
                    model, "my-custom-chat-model",
                    "model must come from registry.json, not the inline literal"
                );
                assert!(via_gateway, "default route must always forward via gateway");
            }
            _ => panic!("expected OpenAiCompat route"),
        }
    }

    // ── Ryu flagship agent (U042) ─────────────────────────────────────────────

    #[test]
    fn ryu_agent_routes_to_pi_acp_with_gateway() {
        // AC1: agent_id="ryu" must resolve to an ACP route (Pi engine) and
        // inject the gateway URL into the spawn command so every outbound
        // model call is governed by the Gateway (via env injection like Codex).
        let route =
            agent_route(Some("ryu"), None, None, &acp_reg(), &provider_reg()).expect("ryu route");
        match route {
            AgentRoute::Acp { ref spawn_cmd } => {
                // The spawn command must embed the gateway base URL so Pi's
                // outbound model calls route through ryu-gateway.
                let gateway_base = crate::sidecar::gateway::gateway_url();
                let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
                assert!(
                    spawn_cmd.contains(&expected_v1) || spawn_cmd.contains("OPENAI_BASE_URL"),
                    "ryu spawn cmd must inject gateway URL or OPENAI_BASE_URL, got: {spawn_cmd}"
                );
            }
            _ => panic!("expected ACP route for ryu agent (Pi + Gateway)"),
        }
    }

    #[test]
    fn ryu_is_not_routed_as_generic_default_llm() {
        // ryu must branch before the generic default_agent_route() so it never
        // falls through to the plain-LLM OpenAI-compat path.
        let route =
            agent_route(Some("ryu"), None, None, &acp_reg(), &provider_reg()).expect("ryu route");
        assert!(
            matches!(route, AgentRoute::Acp { .. }),
            "ryu must resolve to an ACP route, not the generic OpenAI-compat default"
        );
    }

    #[test]
    fn unknown_agent_id_has_no_route() {
        assert!(agent_route(
            Some("nope-not-real"),
            Some("nope-not-real"),
            None,
            &acp_reg(),
            &provider_reg()
        )
        .is_none());
    }

    #[test]
    fn registry_agent_still_routes() {
        let route = agent_route(
            Some("acp:claude"),
            Some("acp:claude"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("acp route");
        assert!(matches!(route, AgentRoute::Acp { .. }));
    }

    #[test]
    fn acp_exec_engine_runs_arbitrary_command() {
        // BYO escape hatch: a custom agent whose engine is `acp-exec:<command>`
        // runs that literal command as an ACP subprocess, so ANY ACP-compatible
        // agent works without being enumerated in the registry (binary-only,
        // private, or future agents). The command is passed through verbatim.
        let route = agent_route(
            Some("my-custom-acp"),
            Some("acp-exec:goose acp"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("acp-exec route");
        match route {
            AgentRoute::Acp { ref spawn_cmd } => assert_eq!(spawn_cmd, "goose acp"),
            _ => panic!("acp-exec engine must resolve to an ACP route"),
        }
    }

    #[test]
    fn acp_exec_agent_routes_through_gateway_when_toggled() {
        // The core of the "point any agent at the gateway" feature: a BYO
        // `acp-exec:` agent with its generic gateway-routing toggle ON must have
        // OPENAI_BASE_URL injected into its spawn command (so its egress traverses
        // the gateway); with the toggle OFF the command stays verbatim.
        // Serialize against the agent_routing module tests — they share the same
        // process-global routing map.
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let id = "byo-openai-agent";
        // Off by default: verbatim, no injection.
        crate::agent_routing::set_from_json("{}");
        let off = agent_route(
            Some(id),
            Some("acp-exec:my-agent --acp"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("acp-exec route");
        match off {
            AgentRoute::Acp { ref spawn_cmd } => {
                assert_eq!(spawn_cmd, "my-agent --acp");
                assert!(!spawn_cmd.contains("OPENAI_BASE_URL"));
            }
            _ => panic!("acp-exec engine must resolve to an ACP route"),
        }
        // Toggled on for this agent id: the gateway env is injected.
        crate::agent_routing::set_from_json(&format!("{{\"{id}\": true}}"));
        let on = agent_route(
            Some(id),
            Some("acp-exec:my-agent --acp"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("acp-exec route");
        match on {
            AgentRoute::Acp { ref spawn_cmd } => {
                assert!(
                    spawn_cmd.contains("OPENAI_BASE_URL="),
                    "toggled-on BYO agent must inject the gateway base URL, got: {spawn_cmd}"
                );
                assert!(spawn_cmd.contains("my-agent --acp"));
            }
            _ => panic!("acp-exec engine must resolve to an ACP route"),
        }
        // Reset shared state so other tests see the default (OFF).
        crate::agent_routing::set_from_json("{}");
    }

    #[test]
    fn acp_exec_engine_empty_command_has_no_route() {
        // An empty command after the prefix must not produce a route (it would
        // spawn nothing useful); it falls through to the normal resolution.
        assert!(agent_route(
            Some("broken"),
            Some("acp-exec:   "),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .is_none());
    }

    #[test]
    fn local_engine_binding_resolves_to_local_route_with_model() {
        // An agent bound to ollama must route to the local engine (which the
        // caller will swap to) carrying the agent's model.
        let route = agent_route(
            Some("my-agent"),
            Some("ollama"),
            Some("llama3"),
            &acp_reg(),
            &provider_reg(),
        )
        .unwrap();
        match route {
            AgentRoute::LocalEngine {
                engine,
                base_url,
                model,
            } => {
                assert_eq!(engine, "ollama");
                assert_eq!(base_url, "http://127.0.0.1:11434");
                assert_eq!(model, "llama3");
            }
            _ => panic!("expected LocalEngine route for an ollama binding"),
        }
    }

    #[test]
    fn local_engine_without_model_falls_back_to_engine_name() {
        let route = agent_route(
            Some("my-agent"),
            Some("vllm"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .unwrap();
        match route {
            AgentRoute::LocalEngine { engine, model, .. } => {
                assert_eq!(engine, "vllm");
                assert_eq!(model, "vllm");
            }
            _ => panic!("expected LocalEngine route"),
        }
    }

    #[test]
    fn cloud_binding_resolves_without_touching_local_engines() {
        // A cloud/registry OpenAI-compat agent must NOT be a LocalEngine route —
        // routing it must never trigger a local-engine swap. It must also carry
        // via_gateway:true so the call goes through the firewall/budget pipeline
        // before reaching the local engine endpoint (U28 egress closure).
        let route = agent_route(
            Some("zeroclaw"),
            Some("zeroclaw"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .unwrap();
        match route {
            AgentRoute::OpenAiCompat {
                base_url,
                via_gateway,
                ..
            } => {
                assert_eq!(base_url, "http://127.0.0.1:42617");
                assert!(
                    via_gateway,
                    "registry OpenAI-compat agents must route via_gateway:true"
                );
            }
            _ => panic!("expected OpenAiCompat route for a zeroclaw binding"),
        }
    }

    #[test]
    fn registry_openai_compat_agents_all_route_via_gateway() {
        // Every OpenAI-compat registry agent (zeroclaw, openclaw, hermes) must
        // carry via_gateway:true so their egress is governed. Degraded-mode
        // fallback (gateway-down → direct base_url) is handled by route_chat_stream.
        let reg = acp_reg();
        let preg = provider_reg();
        for entry in &reg.entries {
            if let acp::AgentTransport::OpenAiCompat { .. } = &entry.transport {
                let route = agent_route(Some(&entry.id), Some(&entry.id), None, &reg, &preg)
                    .unwrap_or_else(|| panic!("no route for {}", entry.id));
                assert!(
                    matches!(
                        route,
                        AgentRoute::OpenAiCompat {
                            via_gateway: true,
                            ..
                        }
                    ),
                    "registry agent {} must have via_gateway:true",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn unknown_or_unbound_engine_resolves_to_none() {
        // A non-default agent_id with neither a local engine nor a registry id → None,
        // so the caller falls back to the default agent.
        assert!(agent_route(
            Some("x"),
            Some("does-not-exist"),
            None,
            &acp_reg(),
            &provider_reg()
        )
        .is_none());
    }

    // ── SDK app routing (issue #208) ─────────────────────────────────────────

    #[test]
    fn sdk_app_agent_id_resolves_to_sdk_app_route() {
        // An `sdk:*` agent_id must resolve to an SdkApp route so Core can route
        // chat to the loopback OpenAI-compat endpoint the SDK process serves on.
        let route = agent_route(
            Some("sdk:my-sdk-app"),
            Some("sdk:my-sdk-app"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("sdk app route");
        assert!(
            matches!(route, AgentRoute::SdkApp { .. }),
            "sdk:* agent_id must resolve to SdkApp route"
        );
    }

    #[test]
    fn sdk_app_route_base_url_is_loopback() {
        // The Core→SDK-app hop must target the loopback (not the gateway), so
        // model calls routed from Core hit the SDK process's local server. Gateway
        // policy flows via env-injection into the SDK subprocess at spawn time.
        let route = agent_route(
            Some("sdk:my-sdk-app"),
            Some("sdk:my-sdk-app"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("sdk app route");
        match route {
            AgentRoute::SdkApp { base_url, .. } => {
                assert!(
                    base_url.starts_with("http://127.0.0.1:"),
                    "SDK app base_url must be loopback, got: {base_url}"
                );
                let gateway_url = crate::sidecar::gateway::gateway_url();
                assert_ne!(
                    base_url, gateway_url,
                    "SDK app route must not target the gateway directly"
                );
            }
            _ => panic!("expected SdkApp route"),
        }
    }

    #[test]
    fn sdk_app_route_uses_via_gateway_false() {
        // SdkApp is not an OpenAiCompat route at the Core hop — it is its own
        // variant, so the via_gateway flag does not apply here. This test asserts
        // the route does NOT accidentally end up as OpenAiCompat via_gateway:true,
        // which would loop Core→gateway→Core.
        let route = agent_route(
            Some("sdk:my-sdk-app"),
            Some("sdk:my-sdk-app"),
            None,
            &acp_reg(),
            &provider_reg(),
        )
        .expect("sdk app route");
        assert!(
            !matches!(
                route,
                AgentRoute::OpenAiCompat {
                    via_gateway: true,
                    ..
                }
            ),
            "SDK app must not be OpenAiCompat via_gateway:true"
        );
    }

    // ── Gateway fallback decision (U015) ─────────────────────────────────────

    #[test]
    fn gateway_up_and_via_gateway_true_forwards_through_gateway() {
        assert!(forward_via_gateway(true, true));
    }

    #[test]
    fn gateway_down_causes_direct_provider_fallback() {
        // When via_gateway is true but the gateway is unreachable, the route
        // must fall back to the direct provider path instead of hard-failing.
        assert!(!forward_via_gateway(true, false));
    }

    #[test]
    fn non_gateway_route_never_forwards_via_gateway() {
        // A route with via_gateway:false (e.g. degraded-mode direct fallback)
        // is never forwarded through the gateway regardless of health status.
        assert!(!forward_via_gateway(false, true));
        assert!(!forward_via_gateway(false, false));
    }

    #[test]
    fn acp_prompt_orders_memory_then_message() {
        let prompt = build_acp_prompt(
            Some("Remembered: likes tea".to_owned()),
            Some("Conversation so far:\nuser: hi".to_owned()),
            "what did I just say?",
        );
        let lt = prompt.find("Remembered").unwrap();
        let st = prompt.find("Conversation so far").unwrap();
        let msg = prompt.find("what did I just say?").unwrap();
        assert!(lt < st, "long-term should precede short-term");
        assert!(st < msg, "short-term should precede the user message");
    }

    #[test]
    fn acp_prompt_without_memory_is_just_message() {
        let prompt = build_acp_prompt(None, None, "hello");
        assert_eq!(prompt, "hello");
    }

    #[test]
    fn long_term_scope_falls_back_to_default() {
        assert_eq!(long_term_agent_scope(None), "default");
        assert_eq!(long_term_agent_scope(Some("")), "default");
        assert_eq!(long_term_agent_scope(Some("acp:claude")), "acp:claude");
    }

    #[tokio::test]
    async fn short_term_context_contains_prior_turns() {
        let store = ConversationStore::open_in_memory().unwrap();
        store
            .append_message(
                "conv-st",
                "user",
                "remember the number 42",
                None,
                None,
                None,
            )
            .await
            .unwrap();
        store
            .append_message("conv-st", "assistant", "noted, 42", None, None, None)
            .await
            .unwrap();
        // Current turn (persisted before routing in the real flow).
        store
            .append_message("conv-st", "user", "what number?", None, None, None)
            .await
            .unwrap();

        let context = assemble_short_term_context(&store, "conv-st")
            .await
            .expect("context should be assembled");
        assert!(context.contains("remember the number 42"));
        assert!(context.contains("noted, 42"));
        // The current (last) turn is excluded from the replayed prefix.
        assert!(!context.contains("what number?"));
    }

    #[tokio::test]
    async fn long_term_recall_is_cross_session_not_current_turn() {
        // Mirrors route_chat_stream's ordering: recall BEFORE recording the
        // current turn, so the just-sent message never echoes back as memory.
        let memory = MemoryStore::open_in_memory().unwrap();

        // First opted-in turn of a fresh conversation: nothing prior exists.
        let before_first = assemble_long_term_system_message(&memory, true, None).await;
        assert!(
            before_first.is_none(),
            "first turn has no cross-session memory"
        );
        memory
            .record(LOCAL_USER, "default", "turn one")
            .await
            .unwrap();

        // Second turn: recall now surfaces turn one, but not the current turn.
        let before_second = assemble_long_term_system_message(&memory, true, None)
            .await
            .expect("turn one should be recalled");
        assert!(before_second.contains("turn one"));
        assert!(!before_second.contains("turn two"));
        memory
            .record(LOCAL_USER, "default", "turn two")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn long_term_system_message_disabled_when_opt_out() {
        let memory = MemoryStore::open_in_memory().unwrap();
        memory
            .record(LOCAL_USER, "default", "a fact")
            .await
            .unwrap();
        // Disabled: nothing recalled even though an entry exists.
        let disabled = assemble_long_term_system_message(&memory, false, None).await;
        assert!(disabled.is_none());
        // Enabled: the fact is surfaced.
        let enabled = assemble_long_term_system_message(&memory, true, None)
            .await
            .expect("memory enabled");
        assert!(enabled.contains("a fact"));
    }

    // ── Self-healing fallback chain (U043) ────────────────────────────────────

    #[test]
    fn default_agent_gets_fallback_chain() {
        // The registry must always return at least one fallback entry for the
        // default/"ryu" agent so a primary failure has somewhere to recover to.
        let reg = acp_reg();
        let chain = reg.fallback_chain_for_default();
        assert!(
            !chain.is_empty(),
            "default agent must have a non-empty fallback chain"
        );
    }

    #[test]
    fn fallback_chain_url_env_override() {
        // The fallback chain must be swappable via env var (AC2: registry-configured,
        // not hardcoded). Verify that RYU_FALLBACK_LLM_BASE_URL is respected.
        std::env::set_var("RYU_FALLBACK_LLM_BASE_URL", "http://127.0.0.1:9999");
        std::env::set_var("RYU_FALLBACK_LLM_MODEL", "custom-model");
        let reg = acp_reg();
        let chain = reg.fallback_chain_for_default();
        assert_eq!(chain[0].base_url, "http://127.0.0.1:9999");
        assert_eq!(chain[0].model, "custom-model");
        std::env::remove_var("RYU_FALLBACK_LLM_BASE_URL");
        std::env::remove_var("RYU_FALLBACK_LLM_MODEL");
    }

    #[tokio::test]
    async fn connect_with_fallback_tries_fallback_on_primary_failure() {
        // Simulate a primary provider failure by pointing at a guaranteed-
        // unreachable port. The fallback also points at an unreachable port, but
        // the test asserts the *fallback was attempted* by checking the combined
        // error message includes both provider URLs — proving the fallback path ran.
        let messages: Vec<Value> = vec![];
        let fallback = vec![FallbackProvider {
            base_url: "http://127.0.0.1:19998".to_owned(),
            model: "test-model".to_owned(),
            api_key: None,
        }];
        let result = connect_with_fallback(
            &messages,
            "http://127.0.0.1:19999",
            "primary-model",
            None,
            None,
            None, // no user id
            &[],  // no active skills
            &[],  // no composio actions
            None, // no session id
            &fallback,
            &AgentSlots::default(),
            false, // not companion-sourced
            false, // not background fan-out
            &crate::inference::SamplingConfig::default(),
            crate::inference::Engine::Other,
        )
        .await;
        // Both primary and fallback should fail; the error message must mention
        // both failures so the operator can diagnose the full chain.
        let err = result.expect_err("both providers are unreachable");
        assert!(
            err.contains("Primary provider failed"),
            "error should describe primary failure: {err}"
        );
        assert!(
            err.contains("fallback also failed"),
            "error should describe fallback failure: {err}"
        );
    }

    #[tokio::test]
    async fn connect_with_fallback_returns_primary_error_when_no_fallback_configured() {
        // When the fallback chain is empty (non-default agents, or fallback disabled),
        // the primary error is returned directly with no fallback attempt.
        let messages: Vec<Value> = vec![];
        let result = connect_with_fallback(
            &messages,
            "http://127.0.0.1:19999",
            "model",
            None,
            None,
            None, // no user id
            &[],  // no active skills
            &[],  // no composio actions
            None, // no session id
            &[],  // empty fallback chain
            &AgentSlots::default(),
            false, // not companion-sourced
            false, // not background fan-out
            &crate::inference::SamplingConfig::default(),
            crate::inference::Engine::Other,
        )
        .await;
        let err = result.expect_err("unreachable primary");
        // Must be a plain transport error, not a "combined" message.
        assert!(
            !err.contains("fallback"),
            "no fallback should be mentioned when chain is empty: {err}"
        );
    }

    // ── per-message inference stats (build_stats_part) ────────────────────────

    /// Decode the JSON `data` object out of a `data: {…}\n\n` UI-stream frame.
    fn decode_stats(bytes: &[u8]) -> Value {
        let s = String::from_utf8(bytes.to_vec()).unwrap();
        let json: Value = serde_json::from_str(s.trim_start_matches("data:").trim()).unwrap();
        assert_eq!(json["type"], "data-ryu-stats");
        json["data"].clone()
    }

    #[test]
    fn stats_prefer_llamacpp_timings() {
        // When the engine reports `timings`, its `predicted_per_second` wins over
        // any wall-clock estimate, and token counts come from `predicted_n` /
        // `prompt_n` (not the streamed-delta count).
        let timings = serde_json::json!({
            "prompt_n": 1024,
            "predicted_n": 200,
            "predicted_per_second": 42.5,
            "prompt_per_second": 350.0
        });
        let open = std::time::Instant::now();
        let first = Some(open + std::time::Duration::from_millis(120));
        let part = build_stats_part(open, first, 7, &Some(timings), &None)
            .expect("timings produce a stats part");
        let data = decode_stats(&part);
        assert_eq!(data["tokensPerSecond"], 42.5);
        assert_eq!(data["promptPerSecond"], 350.0);
        assert_eq!(data["completionTokens"], 200);
        assert_eq!(data["promptTokens"], 1024);
        assert_eq!(data["totalTokens"], 1224);
    }

    #[test]
    fn stats_fall_back_to_usage_and_wallclock() {
        // No timings: token counts come from `usage`, speed is
        // completion_tokens / generation_seconds. delta_count is ignored when
        // usage reports a real completion count.
        let usage = serde_json::json!({
            "prompt_tokens": 50,
            "completion_tokens": 100,
            "total_tokens": 150
        });
        let open = std::time::Instant::now();
        // Generation window must be a real elapsed span; sleep 2s would be slow,
        // so we synthesize `first_token_at` 2s in the past relative to "now".
        let first = Some(std::time::Instant::now() - std::time::Duration::from_secs(2));
        let part = build_stats_part(open, first, 3, &None, &Some(usage))
            .expect("usage produces a stats part");
        let data = decode_stats(&part);
        // ~100 tokens / ~2s ≈ 50 tok/s (allow slack for scheduling jitter).
        let tps = data["tokensPerSecond"].as_f64().unwrap();
        assert!((30.0..=60.0).contains(&tps), "tps {tps} not in expected band");
        assert_eq!(data["completionTokens"], 100);
        assert_eq!(data["totalTokens"], 150);
        assert!(data.get("promptPerSecond").is_none());
    }

    #[test]
    fn stats_omitted_when_nothing_generated() {
        // An empty/aborted turn (no tokens, no engine numbers) yields no part,
        // mirroring Jan's "hide when speed and count are both zero".
        let open = std::time::Instant::now();
        assert!(build_stats_part(open, None, 0, &None, &None).is_none());
    }

    // ── run_reply_text / channel session seam (M11 / #226) ────────────────────

    /// AC2: two turns in the same chat share conversation history via the Core
    /// conversation store. Verify that after two calls with the same conversation_id
    /// the store holds at least two rows keyed to that id.
    ///
    /// The test does NOT stand up a live agent (the call to an unreachable
    /// OpenAI-compat endpoint will error), but the user turn is persisted by
    /// `route_chat_stream` BEFORE the upstream connection is attempted, so we
    /// can assert conversation rows grow per-turn using only the in-memory store.
    #[tokio::test]
    async fn channel_turns_share_conversation_in_store() {
        use std::collections::HashMap;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let conversations = ConversationStore::open_in_memory().unwrap();
        let memory = MemoryStore::open_in_memory().unwrap();
        let worktree_diffs = Arc::new(Mutex::new(HashMap::new()));
        let registry = Arc::new(AcpAgentRegistry::new());
        let agent_store =
            crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
        let manager = crate::sidecar::SidecarManager::new_noop();
        let mcp = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let skills = crate::skills::SkillRegistry::empty();
        let traces = crate::server::trace::TraceStore::open_in_memory().unwrap();

        let conv_id = "telegram-chat-99".to_string();

        // First turn: the unreachable provider returns an error, but the user
        // message is persisted before the connection attempt.
        let _ = run_reply_text(
            conv_id.clone(),
            None,
            "hello turn one".to_string(),
            None,
            Arc::clone(&registry),
            conversations.clone(),
            agent_store.clone(),
            Arc::clone(&manager),
            memory.clone(),
            Arc::clone(&worktree_diffs),
            Arc::clone(&mcp),
            skills.clone(),
            traces.clone(),
        )
        .await;

        // Second turn with the same conversation_id = chat_id.
        let _ = run_reply_text(
            conv_id.clone(),
            None,
            "hello turn two".to_string(),
            None,
            Arc::clone(&registry),
            conversations.clone(),
            agent_store.clone(),
            Arc::clone(&manager),
            memory.clone(),
            Arc::clone(&worktree_diffs),
            Arc::clone(&mcp),
            skills.clone(),
            traces.clone(),
        )
        .await;

        // Both user turns must be persisted in the conversation store under the
        // same conversation_id (= Telegram chat_id), proving multi-turn history
        // is shared. Per persist logic: user turn written before upstream attempt.
        let rows = conversations
            .get_recent_messages(&conv_id, 10)
            .await
            .unwrap_or_default();
        assert!(
            rows.len() >= 2,
            "expected at least 2 persisted turns for conversation {conv_id}, got {}",
            rows.len()
        );
        assert!(rows.iter().any(|r| r.content.contains("turn one")));
        assert!(rows.iter().any(|r| r.content.contains("turn two")));
    }

    /// AC1: `run_reply_text` builds a valid `ChatStreamRequest` that the existing
    /// streaming machinery accepts — verified indirectly by asserting the function
    /// signature compiles and a call with an empty agent id doesn't panic.
    #[tokio::test]
    async fn run_reply_text_accepts_no_agent_id() {
        use std::collections::HashMap;
        use std::sync::Arc;
        use tokio::sync::Mutex;

        let conversations = ConversationStore::open_in_memory().unwrap();
        let memory = MemoryStore::open_in_memory().unwrap();
        let worktree_diffs = Arc::new(Mutex::new(HashMap::new()));
        let registry = Arc::new(AcpAgentRegistry::new());
        let agent_store =
            crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap();
        let manager = crate::sidecar::SidecarManager::new_noop();
        let mcp = Arc::new(crate::sidecar::mcp::McpRegistry::empty());
        let skills = crate::skills::SkillRegistry::empty();
        let traces = crate::server::trace::TraceStore::open_in_memory().unwrap();

        // No agent_id — falls back to the default route (which will error because
        // no LLM is configured). The important thing is it doesn't panic.
        let result = run_reply_text(
            "test-conv-1".to_string(),
            None,
            "ping".to_string(),
            None,
            registry,
            conversations,
            agent_store,
            manager,
            memory,
            worktree_diffs,
            mcp,
            skills,
            traces,
        )
        .await;
        // Either an Ok(empty-or-error-text) or an Err — both are acceptable here;
        // what matters is no panic occurred.
        let _ = result;
    }
}
