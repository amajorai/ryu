use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};

use agent_client_protocol::schema::{
    AvailableCommandInput, ContentBlock, ImageContent, InitializeRequest, NewSessionRequest,
    NewSessionResponse,
    PromptRequest, PromptResponse, ProtocolVersion, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome, SessionId,
    SessionNotification, SessionUpdate, SetSessionConfigOptionRequest, SetSessionModeRequest,
    SetSessionModelRequest, ToolCall, ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolKind,
};
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{Agent, Client, ConnectionTo, SessionMessage};
use agent_client_protocol_tokio::AcpAgent;
use std::collections::BTreeMap;
use tokio::sync::mpsc;

use crate::sidecar::adapters::{
    AgentAdapter, AgentConfig, AgentInfo, ChatChunk, ChatRequest, ImagePart, MemoryEntry, ToolInfo,
};
use crate::sidecar::gateway::{check_exec_scan, ExecScanOutcome};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::BoxFuture;

/// A single event emitted by a running ACP session.
///
/// The ACP agent runs the full tool loop internally (the LLM requests a tool,
/// the agent executes it, feeds the result back, and continues to a final
/// answer). Our job as the client is to *surface* that loop: forward the
/// assistant text, the tool calls the agent makes, and their results, so the UI
/// can render the whole turn — not just the final text.
#[derive(Debug, Clone)]
pub enum AcpEvent {
    /// A chunk of the assistant's streamed text response.
    Text(String),
    /// A chunk of the agent's internal reasoning (extended thinking) stream.
    Thought(String),
    /// The agent's current execution plan: a full snapshot of its entries
    /// (`[{ content, priority, status }, …]`). Each update replaces the last.
    Plan(serde_json::Value),
    /// A new tool call the agent has initiated.
    ToolCall {
        id: String,
        /// Human-readable title (ACP exposes no stable machine tool name).
        title: String,
        /// ACP tool category (read/edit/execute/…), serialized snake_case.
        kind: String,
        /// Raw input parameters the agent sent to the tool, if any.
        input: Option<serde_json::Value>,
    },
    /// An update on an in-flight or finished tool call (status and/or result).
    ToolResult {
        id: String,
        /// "pending" | "in_progress" | "completed" | "failed".
        status: String,
        /// Raw output and/or rendered content produced by the tool.
        output: Option<serde_json::Value>,
    },
    /// The agent switched the active session mode itself (e.g. Claude Code
    /// leaving "plan" after presenting a plan). Carries the new mode id so the
    /// desktop's mode picker stays in sync. Agent-initiated, not user-driven.
    ModeChanged(String),
    /// The agent advertised (or updated) the slash commands it can execute
    /// (ACP `available_commands_update`). Carries a normalized
    /// `[{ name, description, hint }, …]` array; each update REPLACES the
    /// client's cached list. Drives the desktop's `/` command popover.
    AvailableCommands(serde_json::Value),
    /// The agent is asking the user to approve a tool call because the active
    /// permission mode requires it. The client renders the `options` as
    /// allow/reject buttons and echoes the chosen `option_id` back via
    /// `POST /api/chat/permission` keyed by `request_id`; the awaiting handler
    /// then resolves. Cancels (rejects) on timeout.
    PermissionRequest {
        request_id: String,
        /// Serialized ACP `ToolCallUpdate` describing the action needing consent.
        tool_call: serde_json::Value,
        /// Serialized `Vec<PermissionOption>` ({ optionId, name, kind }).
        options: serde_json::Value,
    },
    /// A fatal error from the session; the stream ends after this.
    Error(String),
}

/// User-chosen ACP session controls applied to a single turn, all read from the
/// agent's own `session/new` advertisement (Ryu hardcodes none). Because Core
/// runs one ACP session per turn, these are re-applied each turn (sticky on the
/// client). Empty fields mean "leave the agent's default".
#[derive(Debug, Clone, Default)]
pub struct AcpTurnConfig {
    /// `SessionModeId` to switch into (e.g. `plan`, `bypassPermissions`).
    pub session_mode: Option<String>,
    /// `(config_id, value_id)` pairs for select config options (e.g. a
    /// reasoning-effort / `thought_level` selector).
    pub config_options: Vec<(String, String)>,
    /// `ModelId` to select (unstable ACP capability; ignored if unsupported).
    pub model_id: Option<String>,
    /// When `true` (desktop streaming), a tool-permission request is surfaced to
    /// the user as a `PermissionRequest` event and the handler awaits their
    /// choice (cancel on timeout). When `false` (headless/bots/CLI/legacy), the
    /// handler auto-approves the first offered option — preserving the prior
    /// non-interactive behaviour so tool use keeps working without a UI.
    pub interactive: bool,
}

/// Serialize an ACP `ToolKind` to its snake_case wire form (read, execute, …).
fn tool_kind_str(kind: &ToolKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".to_owned())
}

/// Serialize an ACP `ToolCallStatus` to its snake_case wire form.
fn tool_status_str(status: &ToolCallStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "pending".to_owned())
}

/// Collapse a tool call's `content` blocks (text/diff/terminal) into a JSON
/// value the UI can render as output. Plain text blocks are concatenated;
/// anything richer passes through as structured JSON.
fn tool_content_to_output(content: &[ToolCallContent]) -> Option<serde_json::Value> {
    if content.is_empty() {
        return None;
    }
    let mut text = String::new();
    let mut structured: Vec<serde_json::Value> = Vec::new();
    for block in content {
        match block {
            ToolCallContent::Content(c) => {
                if let ContentBlock::Text(t) = &c.content {
                    text.push_str(&t.text);
                } else if let Ok(v) = serde_json::to_value(&c.content) {
                    structured.push(v);
                }
            }
            other => {
                if let Ok(v) = serde_json::to_value(other) {
                    structured.push(v);
                }
            }
        }
    }
    if structured.is_empty() {
        (!text.is_empty()).then(|| serde_json::Value::String(text))
    } else {
        if !text.is_empty() {
            structured.push(serde_json::Value::String(text));
        }
        Some(serde_json::Value::Array(structured))
    }
}

/// If a tool's content carries an ACP `Diff` block — the protocol-standard,
/// agent-agnostic way an agent reports a file edit (the same signal Zed renders
/// its diffs from) — surface it in the exact shape the desktop's Edit/Write diff
/// card reads: `{ old_content, content, path }`. ACP edits arrive *here* (in the
/// content block), not in the agent-specific `raw_input`, so without this the
/// diff card renders empty for ACP agents. Returns `None` when no diff is present
/// (non-edit tools are unaffected).
fn extract_diff_output(content: &[ToolCallContent]) -> Option<serde_json::Value> {
    content.iter().find_map(|block| match block {
        ToolCallContent::Diff(diff) => Some(serde_json::json!({
            "old_content": diff.old_text.clone().unwrap_or_default(),
            "content": diff.new_text.clone(),
            "path": diff.path.display().to_string(),
        })),
        _ => None,
    })
}

/// Tools observed across ACP sessions, keyed by agent id.
///
/// ACP agents don't advertise a static tool catalog — their tools are internal,
/// surfaced only via `ToolCall` notifications during a turn. To make
/// `list_tools` return *real* tools (AC3) rather than an empty or fabricated
/// list, we record each distinct tool the agent uses, keyed by its title.
fn observed_tools() -> &'static Mutex<BTreeMap<String, BTreeMap<String, ToolInfo>>> {
    static TOOLS: OnceLock<Mutex<BTreeMap<String, BTreeMap<String, ToolInfo>>>> = OnceLock::new();
    TOOLS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Record a tool the given agent invoked so a later `list_tools` call can
/// report it. Keyed by tool title; the ACP `kind` is kept as the description.
pub fn record_observed_tool(agent_id: &str, title: &str, kind: &str) {
    if title.is_empty() {
        return;
    }
    if let Ok(mut map) = observed_tools().lock() {
        let agent_tools = map.entry(agent_id.to_owned()).or_default();
        agent_tools
            .entry(title.to_owned())
            .or_insert_with(|| ToolInfo {
                name: title.to_owned(),
                description: (!kind.is_empty() && kind != "other").then(|| kind.to_owned()),
                schema: None,
            });
    }
}

/// Return the tools observed for `agent_id` so far this process run.
pub fn observed_tools_for(agent_id: &str) -> Vec<ToolInfo> {
    observed_tools()
        .lock()
        .ok()
        .and_then(|map| map.get(agent_id).map(|t| t.values().cloned().collect()))
        .unwrap_or_default()
}

// ── Interactive permission back-channel ──────────────────────────────────────
//
// When an ACP agent in a permission-requiring mode asks to run a tool, the
// adapter must surface allow/reject options to the user and wait for a choice —
// the stream is otherwise one-way (Core → desktop). We bridge the gap with a
// process-global registry of pending requests: the permission handler registers
// a oneshot, emits a `PermissionRequest` event, and awaits; the
// `POST /api/chat/permission` route calls `resolve_permission` to deliver the
// user's chosen option id (or `None` to cancel/reject).

type PermissionWaiters =
    Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>>;

fn pending_permissions() -> &'static PermissionWaiters {
    static WAITERS: OnceLock<PermissionWaiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Mint a unique permission request id (process-local, collision-free).
fn next_permission_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    format!("perm-{}", SEQ.fetch_add(1, Ordering::Relaxed))
}

/// Register a waiter for `request_id` and return the receiver the permission
/// handler awaits. Dropping the returned receiver (or never resolving) leaves
/// the handler to time out and cancel.
fn register_permission(request_id: String) -> tokio::sync::oneshot::Receiver<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut map) = pending_permissions().lock() {
        map.insert(request_id, tx);
    }
    rx
}

/// Ask the connected desktop user to approve a synthetic tool action and wait
/// for their response. Used by Core-owned tools that run inside the ACP MCP
/// bridge; ACP-native permission requests use the same waiter map directly.
pub async fn request_user_permission(
    tx: &mpsc::UnboundedSender<AcpEvent>,
    tool_call: serde_json::Value,
    options: serde_json::Value,
) -> Option<String> {
    let request_id = next_permission_id();
    let rx = register_permission(request_id.clone());
    let _ = tx.send(AcpEvent::PermissionRequest {
        request_id: request_id.clone(),
        tool_call,
        options,
    });
    let chosen = tokio::time::timeout(std::time::Duration::from_secs(600), rx)
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    if chosen.is_none() {
        let _ = resolve_permission(&request_id, None);
    }
    chosen
}

/// Deliver the user's decision to the awaiting permission handler.
/// `option_id = None` cancels (reject). Returns `true` if a waiter was found.
pub fn resolve_permission(request_id: &str, option_id: Option<String>) -> bool {
    let sender = pending_permissions()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(request_id));
    match sender {
        Some(tx) => tx.send(option_id).is_ok(),
        None => false,
    }
}

// ── ACP session-config discovery (modes / models / config options) ───────────
//
// `ActiveSession` only surfaces `modes()`; the raw `NewSessionResponse` also
// carries `models` (feature-gated) and `config_options` (e.g. a reasoning-effort
// selector). To populate the desktop's per-agent pickers *before* the first
// turn, `probe_acp_config` opens a throwaway session (no prompt) over the
// low-level connection, reads the full response, and drops it. Results are
// cached per spawn command (an agent's advertised set is static per binary).

type ConfigCache = Mutex<std::collections::HashMap<String, serde_json::Value>>;

fn config_cache() -> &'static ConfigCache {
    static CACHE: OnceLock<ConfigCache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// Probe an ACP agent for its advertised session config — `{ modes, models,
/// configOptions }`, each `null` when unsupported. Fully agent-reported; Ryu
/// hardcodes nothing. Cached per `spawn_cmd`.
pub async fn probe_acp_config(
    spawn_cmd: String,
    cwd: PathBuf,
) -> anyhow::Result<serde_json::Value> {
    if let Some(v) = config_cache()
        .lock()
        .ok()
        .and_then(|m| m.get(&spawn_cmd).cloned())
    {
        return Ok(v);
    }
    let agent =
        AcpAgent::from_str(&spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let probe_cmd = spawn_cmd.clone();
    let value = Client
        .builder()
        .connect_with(agent, move |cx: ConnectionTo<Agent>| {
            let cwd = cwd.clone();
            async move {
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;
                let resp: NewSessionResponse = cx
                    .send_request(NewSessionRequest::new(cwd))
                    .block_task()
                    .await?;
                Ok(serde_json::json!({
                    "modes": resp.modes,
                    "models": resp.models,
                    "configOptions": resp.config_options,
                }))
            }
        })
        .await
        .map_err(|e| anyhow::anyhow!("ACP probe: {e}"))?;
    if let Ok(mut m) = config_cache().lock() {
        m.insert(probe_cmd, value.clone());
    }
    Ok(value)
}

/// Apply a turn's chosen session controls (mode / config options / model) to a
/// live ACP session over its connection. Each is best-effort: a failure
/// (unsupported capability or unknown id) is logged and skipped so the turn
/// still proceeds with the agent's defaults.
async fn apply_turn_config(
    connection: ConnectionTo<Agent>,
    session_id: SessionId,
    turn: &AcpTurnConfig,
) {
    if let Some(mode) = turn.session_mode.as_ref().filter(|m| !m.is_empty()) {
        match connection
            .send_request_to(
                Agent,
                SetSessionModeRequest::new(session_id.clone(), mode.clone()),
            )
            .block_task()
            .await
        {
            Ok(_) => tracing::info!("ACP applied session mode '{mode}'"),
            Err(e) => tracing::warn!("ACP set_mode '{mode}' failed: {e}"),
        }
    }
    for (config_id, value) in &turn.config_options {
        if config_id.is_empty() {
            continue;
        }
        if let Err(e) = connection
            .send_request_to(
                Agent,
                SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    config_id.clone(),
                    value.clone(),
                ),
            )
            .block_task()
            .await
        {
            tracing::warn!("ACP set_config_option '{config_id}'='{value}' failed: {e}");
        }
    }
    if let Some(model) = turn.model_id.as_ref().filter(|m| !m.is_empty()) {
        if let Err(e) = connection
            .send_request_to(
                Agent,
                SetSessionModelRequest::new(session_id.clone(), model.clone()),
            )
            .block_task()
            .await
        {
            tracing::warn!("ACP set_model '{model}' failed: {e}");
        }
    }
}

/// Spawn an ACP subprocess and return a receiver that yields structured events
/// (text, tool calls, tool results) as they arrive. The channel closes when the
/// session completes or errors.
///
/// `cwd` is the working directory the ACP session runs in. Pass the worktree
/// path when worktree isolation is active; otherwise pass the user's folder or
/// `std::env::current_dir()` as a fallback.
///
/// `mcp` and `allowlist` wire Ryu's registered tools (Ghost, Shadow, config
/// servers) into the ACP session so the agent can call them during its tool
/// loop. `mcp = None` or an empty allowlist offers no Ryu tools (legacy/test
/// path and the explicit "no tools" case, respectively). Every bridged call is
/// gated by the allowlist inside `McpRegistry::call_tool` (AC3 governance).
pub fn spawn_acp_task(
    spawn_cmd: String,
    prompt: String,
    images: Vec<ImagePart>,
    cwd: PathBuf,
    mcp: Option<Arc<McpRegistry>>,
    allowlist: Option<Vec<String>>,
    // Per-agent Composio action slugs + the effective agent id, threaded into the
    // MCP bridge so Composio reaches the ACP plane and PTC execution is scoped (#477).
    composio_actions: Vec<String>,
    agent_id: String,
    // Per-agent bound Identity Vault profiles (epic #517), threaded into the MCP
    // bridge for the tool-call-time vault consult. Empty = no consult.
    identity_profile_ids: Vec<String>,
    // User-chosen ACP session controls (permission mode / reasoning effort /
    // model) applied to this turn's session. All agent-reported; see
    // [`AcpTurnConfig`].
    turn: AcpTurnConfig,
    // Stable chat-session key for Core-owned interactive MCP permissions.
    permission_scope_id: Option<String>,
) -> mpsc::UnboundedReceiver<AcpEvent> {
    let (tx, rx) = mpsc::unbounded_channel();
    let err_tx = tx.clone();
    tokio::spawn(async move {
        if let Err(e) = run_acp_prompt(
            spawn_cmd,
            prompt,
            images,
            cwd,
            mcp,
            allowlist,
            composio_actions,
            agent_id,
            identity_profile_ids,
            turn,
            permission_scope_id,
            tx,
        )
        .await
        {
            tracing::error!("ACP streaming error: {e}");
            let _ = err_tx.send(AcpEvent::Error(format!("Agent error: {e}")));
        }
    });
    rx
}

pub struct AcpAdapter {
    pub agent_name: &'static str,
    pub spawn_cmd: &'static str,
}

impl AgentAdapter for AcpAdapter {
    fn name(&self) -> &'static str {
        self.agent_name
    }

    fn is_available(&self) -> bool {
        true
    }

    fn send_message(
        &self,
        _agent_id: &str,
        req: ChatRequest,
    ) -> BoxFuture<anyhow::Result<Vec<ChatChunk>>> {
        let spawn_cmd = self.spawn_cmd.to_owned();
        // Key recorded tools the same way `list_tools` reads them back.
        let agent_id = format!("acp:{}", self.agent_name);
        let prompt = req.message;
        Box::pin(async move {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            // Legacy send_message path: no McpRegistry context available here,
            // so no Ryu tools are offered. The primary tool-loop path is
            // route_acp_stream in adapters/mod.rs which passes the full registry.
            let mut rx = spawn_acp_task(
                spawn_cmd,
                prompt,
                vec![],
                cwd,
                None,
                None,
                vec![],
                agent_id.clone(),
                vec![],
                AcpTurnConfig::default(),
                None,
            );
            let mut chunks = Vec::new();
            while let Some(event) = rx.recv().await {
                match event {
                    AcpEvent::Text(text) if !text.is_empty() => {
                        chunks.push(ChatChunk {
                            delta: Some(text),
                            done: false,
                            metadata: None,
                        });
                    }
                    AcpEvent::ToolCall {
                        id,
                        title,
                        kind,
                        input,
                    } => {
                        record_observed_tool(&agent_id, &title, &kind);
                        chunks.push(ChatChunk {
                            delta: None,
                            done: false,
                            metadata: Some(serde_json::json!({
                                "toolCall": { "id": id, "title": title, "kind": kind, "input": input }
                            })),
                        });
                    }
                    AcpEvent::ToolResult { id, status, output } => {
                        chunks.push(ChatChunk {
                            delta: None,
                            done: false,
                            metadata: Some(serde_json::json!({
                                "toolResult": { "id": id, "status": status, "output": output }
                            })),
                        });
                    }
                    AcpEvent::Error(msg) => {
                        chunks.push(ChatChunk {
                            delta: Some(msg),
                            done: false,
                            metadata: Some(serde_json::json!({ "error": true })),
                        });
                    }
                    // Reasoning, plan snapshots, mode changes, permission
                    // prompts and command advertisements are surfaced only on the
                    // streaming path (route_acp_stream); this legacy collect path
                    // returns final text + tool metadata and runs non-interactively.
                    AcpEvent::Text(_)
                    | AcpEvent::Thought(_)
                    | AcpEvent::Plan(_)
                    | AcpEvent::ModeChanged(_)
                    | AcpEvent::AvailableCommands(_)
                    | AcpEvent::PermissionRequest { .. } => {}
                }
            }
            chunks.push(ChatChunk {
                delta: None,
                done: true,
                metadata: None,
            });
            Ok(chunks)
        })
    }

    fn list_agents(&self) -> BoxFuture<anyhow::Result<Vec<AgentInfo>>> {
        let name = self.agent_name.to_owned();
        Box::pin(async move {
            Ok(vec![AgentInfo {
                id: format!("acp:{name}"),
                engine: Some(name.clone()),
                name,
                description: None,
                install_hint: None,
                installed: None,
                model: None,
                system_prompt: None,
                created_at: None,
                transport: Some("acp".into()),
                recommended: None,
                version: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
            }])
        })
    }

    fn create_agent(&self, config: AgentConfig) -> BoxFuture<anyhow::Result<AgentInfo>> {
        Box::pin(async move {
            Ok(AgentInfo {
                id: config.name.clone(),
                name: config.name,
                description: None,
                install_hint: None,
                installed: None,
                model: config.model,
                system_prompt: config.system_prompt,
                created_at: None,
                engine: None,
                transport: None,
                recommended: None,
                version: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
            })
        })
    }

    fn get_memory(
        &self,
        _agent_id: &str,
        _query: String,
    ) -> BoxFuture<anyhow::Result<Vec<MemoryEntry>>> {
        Box::pin(async move { Ok(vec![]) })
    }

    fn list_tools(&self, agent_id: &str) -> BoxFuture<anyhow::Result<Vec<ToolInfo>>> {
        // ACP agents expose no static tool catalog (tools are internal, surfaced
        // only via ToolCall notifications). Report the tools this agent has
        // actually used this session — real tools, never a fabricated list.
        // Also report the Ryu registry tools this agent is allowed to use (AC4):
        // these are offered to the agent via the in-process MCP bridge during the
        // next turn, so exposing them here keeps list_tools consistent with what
        // the agent will actually see.
        let key = if agent_id.is_empty() {
            format!("acp:{}", self.agent_name)
        } else {
            agent_id.to_owned()
        };
        Box::pin(async move { Ok(observed_tools_for(&key)) })
    }
}

/// Run an ACP agent subprocess, send prompt, and forward structured events
/// (text, tool calls, tool results) to `tx`. The agent itself runs the tool
/// loop — request, execute, result, continue — across multiple session updates;
/// the `read_update` loop below stays open across all of them until the agent
/// reports a `StopReason`, so a single turn can call a tool and continue to a
/// final answer. `tx` is closed (dropped) when the session completes or errors.
///
/// `cwd` is the working folder for the session; the ACP session is rooted there.
///
/// `mcp` and `allowlist` bridge Ryu's registered tools into the session via the
/// `with_mcp_server` injection mechanism. When `mcp` is `None` or no tools are
/// available after allowlist filtering, the session runs without Ryu tools (the
/// agent only sees its own built-ins). Every bridged call routes through
/// `McpRegistry::call_tool` which enforces the allowlist (no direct-egress path).
pub async fn run_acp_prompt(
    spawn_cmd: String,
    prompt: String,
    images: Vec<ImagePart>,
    cwd: PathBuf,
    mcp: Option<Arc<McpRegistry>>,
    allowlist: Option<Vec<String>>,
    // Per-agent Composio action slugs + effective agent id, threaded into the
    // MCP bridge (#477 ACP parity).
    composio_actions: Vec<String>,
    agent_id: String,
    // Per-agent bound Identity Vault profiles (epic #517), threaded into the MCP
    // bridge so the tool-call-time vault consult runs. Empty = no consult.
    identity_profile_ids: Vec<String>,
    // User-chosen permission mode / reasoning effort / model + interactivity for
    // this turn's session (all agent-reported via session/new).
    turn: AcpTurnConfig,
    // Stable chat-session key for Core-owned interactive MCP permissions.
    permission_scope_id: Option<String>,
    tx: mpsc::UnboundedSender<AcpEvent>,
) -> anyhow::Result<()> {
    // Pre-build the in-process MCP server before entering the async connection
    // closure so that the `Arc<McpRegistry>` doesn't have to be `Send + 'static`
    // inside the closure (the bridge holds its own Arc).
    //
    // INCOMPATIBLE AGENTS: the bridge is injected via the ACP SDK's
    // `with_mcp_server` — an in-process MCP server the agent connects back to over
    // the ACP connection. pi-acp advertises NO MCP-server support in its
    // `initialize` response (`agentCapabilities.mcpCapabilities { http: false,
    // sse: false }`), so injecting a server into its `session/new` is not honored.
    // Skip the bridge for pi-acp (the flagship `ryu` engine + `acp:pi`): basic chat
    // works and pi keeps its own built-in tools, but Ryu-registry tool injection
    // is unavailable for it until pi-acp gains a compatible MCP transport
    // (re-enabling is a one-line flip + a live turn to verify). NOTE: this skip is
    // independent of the earlier `session/new` crash — that was the backslash-
    // stripping bug in `ryu_pi_acp_cmd`, now fixed; it happened with `mcpServers: []`
    // too, so the bridge was never its cause.
    // Effective agent id, cloned before the bridge consumes `agent_id` below, so
    // the ACP permission seam can label its command-approval scans.
    let scan_agent = agent_id.clone();
    let bridge_supported = !spawn_cmd.contains("pi-acp");
    let ryu_mcp_server = match (&mcp, bridge_supported) {
        (Some(registry), true) => {
            super::mcp_bridge::build_ryu_mcp_server(
                Arc::clone(registry),
                allowlist,
                composio_actions,
                agent_id,
                identity_profile_ids,
                Some(tx.clone()),
                permission_scope_id,
            )
            .await
        }
        _ => None,
    };

    let agent = AcpAgent::from_str(&spawn_cmd)
        .map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?
        // Surface the ACP subprocess's own output. Without this the agent's
        // stderr is piped-and-dropped, so a crash inside pi-acp / the engine only
        // reaches us as an opaque "stream was destroyed". Stderr is logged at WARN
        // (real errors); the JSON-RPC line traffic stays at TRACE to avoid noise.
        .with_debug(|line, direction| match direction {
            agent_client_protocol_tokio::LineDirection::Stderr => {
                tracing::warn!(target: "acp_subprocess", "{line}");
            }
            _ => {
                tracing::trace!(target: "acp_subprocess", ?direction, "{line}");
            }
        });

    Client
        .builder()
        .connect_with(agent, move |cx: ConnectionTo<Agent>| {
            let tx = tx.clone();
            let prompt = prompt.clone();
            let images = images.clone();
            let session_cwd = cwd.clone();
            let ryu_server = ryu_mcp_server;
            let turn = turn.clone();
            async move {
                cx.send_request(InitializeRequest::new(ProtocolVersion::V1))
                    .block_task()
                    .await?;

                tracing::info!(cwd = %session_cwd.display(), "ACP build_session");

                // Inject Ryu's registered tools into the session via the ACP
                // SDK's `with_mcp_server` mechanism. The bridge registers an
                // in-process MCP server so the agent's own MCP client connects
                // back to it during the turn, calling Ryu tools through the
                // registry's allowlist-gated `call_tool` path (AC3 governance).
                //
                // `ryu_server` is `None` for agents that don't support the
                // in-process MCP transport (see the bridge-build site above), so
                // those sessions are created without it.
                let session_builder = cx.build_session(session_cwd).block_task();
                let mut session = if let Some(server) = ryu_server {
                    tracing::info!("ACP: injecting Ryu MCP bridge into session");
                    session_builder
                        .with_mcp_server(server)
                        .map_err(|e| anyhow::anyhow!("ACP with_mcp_server: {e}"))?
                        .start_session()
                        .await?
                } else {
                    session_builder.start_session().await?
                };

                // Apply the user's chosen session controls before prompting.
                // Sessions are per-turn, so these are re-applied every turn
                // (sticky on the client). Each is agent-reported via session/new;
                // failures are logged and ignored (optimistic — an agent may not
                // support a given capability or id).
                apply_turn_config(session.connection(), session.session_id().clone(), &turn).await;

                // Send the user's turn. A text-only turn uses the SDK's
                // `send_prompt` helper, which injects the turn's `StopReason` into
                // the update stream the loop below reads. A multimodal turn (text +
                // images) needs a `Vec<ContentBlock>`, which `send_prompt` cannot
                // express, so we send the `PromptRequest` through the connection's
                // public low-level API and signal end-of-turn over a oneshot. This
                // is byte-for-byte what `send_prompt` does internally (see
                // agent-client-protocol's `ActiveSession::send_prompt`), so no fork
                // of the crate is required.
                let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel();
                let _stop_keepalive = if images.is_empty() {
                    session.send_prompt(&prompt)?;
                    // Hold the sender so `stop_rx` stays pending forever; the text
                    // turn terminates via the `StopReason` message instead.
                    Some(stop_tx)
                } else {
                    let mut blocks: Vec<ContentBlock> = vec![prompt.clone().into()];
                    for img in &images {
                        blocks.push(ContentBlock::Image(ImageContent::new(
                            img.data.clone(),
                            img.mime_type.clone(),
                        )));
                    }
                    session
                        .connection()
                        .send_request_to(
                            Agent,
                            PromptRequest::new(session.session_id().clone(), blocks),
                        )
                        .on_receiving_result(move |result| async move {
                            let PromptResponse { stop_reason, .. } = result?;
                            // The loop may have already exited; ignore a closed rx.
                            let _ = stop_tx.send(stop_reason);
                            Ok(())
                        })?;
                    None
                };

                loop {
                    // `biased` + the `stop_rx` branch coming second guarantees every
                    // buffered update is drained before end-of-turn breaks the loop:
                    // `read_update` is polled first and only yields to `stop_rx` when
                    // its queue is empty. The prompt response (which fires `stop_rx`)
                    // arrives after all session notifications, so the queue is fully
                    // populated by the time `stop_rx` can win.
                    let message = tokio::select! {
                        biased;
                        update = session.read_update() => update?,
                        // `Err` means the prompt callback errored and dropped the
                        // sender; either way the turn is over.
                        _ = &mut stop_rx => break,
                    };
                    match message {
                        SessionMessage::SessionMessage(message) => {
                            let tx_chunk = tx.clone();
                            let tx_perm = tx.clone();
                            let interactive = turn.interactive;
                            let scan_agent = scan_agent.clone();
                            MatchDispatch::new(message)
                                .if_notification(async move |notification: SessionNotification| {
                                    match notification.update {
                                        SessionUpdate::AgentMessageChunk(chunk) => {
                                            if let ContentBlock::Text(t) = chunk.content {
                                                let _ = tx_chunk.send(AcpEvent::Text(t.text));
                                            }
                                        }
                                        SessionUpdate::AgentThoughtChunk(chunk) => {
                                            if let ContentBlock::Text(t) = chunk.content {
                                                let _ = tx_chunk.send(AcpEvent::Thought(t.text));
                                            }
                                        }
                                        SessionUpdate::Plan(plan) => {
                                            if let Ok(entries) = serde_json::to_value(&plan.entries)
                                            {
                                                let _ = tx_chunk.send(AcpEvent::Plan(entries));
                                            }
                                        }
                                        SessionUpdate::ToolCall(call) => {
                                            let _ = tx_chunk.send(tool_call_event(&call));
                                        }
                                        SessionUpdate::ToolCallUpdate(update) => {
                                            if let Some(ev) = tool_update_event(&update) {
                                                let _ = tx_chunk.send(ev);
                                            }
                                        }
                                        SessionUpdate::CurrentModeUpdate(m) => {
                                            // Agent switched mode itself; keep the
                                            // desktop's mode picker in sync.
                                            let _ = tx_chunk.send(AcpEvent::ModeChanged(
                                                m.current_mode_id.to_string(),
                                            ));
                                        }
                                        SessionUpdate::AvailableCommandsUpdate(u) => {
                                            // The agent published its slash commands.
                                            // Normalize to { name, description, hint }
                                            // and forward; the desktop replaces its
                                            // cached list and renders the `/` popover.
                                            let commands: Vec<serde_json::Value> = u
                                                .available_commands
                                                .into_iter()
                                                .map(|c| {
                                                    let hint = match c.input {
                                                        Some(
                                                            AvailableCommandInput::Unstructured(
                                                                i,
                                                            ),
                                                        ) => Some(i.hint),
                                                        _ => None,
                                                    };
                                                    serde_json::json!({
                                                        "name": c.name,
                                                        "description": c.description,
                                                        "hint": hint,
                                                    })
                                                })
                                                .collect();
                                            let _ = tx_chunk.send(AcpEvent::AvailableCommands(
                                                serde_json::Value::Array(commands),
                                            ));
                                        }
                                        _ => {}
                                    }
                                    Ok(())
                                })
                                .await
                                .if_request(
                                    async move |req: RequestPermissionRequest, responder| {
                                        // Security seam: pre-scan LLM-emitted shell/exec
                                        // commands through the gateway command-approval
                                        // scanner before granting. A Deny short-circuits
                                        // to reject regardless of mode (headless would
                                        // otherwise auto-approve the first option). In
                                        // headless mode ApprovalRequired also rejects (no
                                        // human to consult) - fail closed. This is
                                        // accident prevention, not containment; ACP agents
                                        // are first-party binaries, so we gate their
                                        // commands rather than scrub their env. See
                                        // SECURITY.md.
                                        let tool_call_json =
                                            serde_json::to_value(&req.tool_call)
                                                .unwrap_or(serde_json::Value::Null);
                                        let scan_reject = match acp_exec_scan_verdict(
                                            &tool_call_json,
                                            &scan_agent,
                                        )
                                        .await
                                        {
                                            ExecScanOutcome::Deny(_) => true,
                                            ExecScanOutcome::ApprovalRequired(_) => {
                                                !interactive
                                            }
                                            ExecScanOutcome::Allow => false,
                                        };
                                        let outcome = if scan_reject {
                                            RequestPermissionOutcome::Cancelled
                                        } else if interactive {
                                            // Surface the request to the user and await
                                            // their decision; cancel (reject) on timeout.
                                            let request_id = next_permission_id();
                                            let rx = register_permission(request_id.clone());
                                            let _ = tx_perm.send(AcpEvent::PermissionRequest {
                                                request_id: request_id.clone(),
                                                tool_call: serde_json::to_value(&req.tool_call)
                                                    .unwrap_or(serde_json::Value::Null),
                                                options: serde_json::to_value(&req.options)
                                                    .unwrap_or(serde_json::Value::Null),
                                            });
                                            let chosen = tokio::time::timeout(
                                                std::time::Duration::from_secs(600),
                                                rx,
                                            )
                                            .await
                                            .ok()
                                            .and_then(Result::ok)
                                            .flatten();
                                            if chosen.is_none() {
                                                // Timed out: drop the dangling waiter.
                                                let _ = resolve_permission(&request_id, None);
                                            }
                                            match chosen {
                                                Some(option_id) => {
                                                    RequestPermissionOutcome::Selected(
                                                        SelectedPermissionOutcome::new(option_id),
                                                    )
                                                }
                                                None => RequestPermissionOutcome::Cancelled,
                                            }
                                        } else {
                                            // Headless: preserve the prior auto-approve
                                            // behaviour so tool use works without a UI.
                                            req.options.first().map_or(
                                                RequestPermissionOutcome::Cancelled,
                                                |opt| {
                                                    RequestPermissionOutcome::Selected(
                                                        SelectedPermissionOutcome::new(
                                                            opt.option_id.clone(),
                                                        ),
                                                    )
                                                },
                                            )
                                        };
                                        responder
                                            .respond(RequestPermissionResponse::new(outcome))?;
                                        Ok(())
                                    },
                                )
                                .await
                                .otherwise_ignore()?;
                        }
                        SessionMessage::StopReason(_) => break,
                        _ => {}
                    }
                }

                Ok(())
            }
        })
        .await
        .map_err(|e| anyhow::anyhow!("ACP connection: {e}"))
}

/// Best-effort extraction of a shell command from a serialized ACP tool call.
///
/// Exec-capable agents surface the command under a handful of shapes: a
/// `command`/`cmd`/`script`/`shellCommand` string (or an argv array) either at
/// the top level or nested under `rawInput`/`raw_input`/`input`. Returns `None`
/// when nothing command-like is present, so non-exec tool calls are not scanned.
/// The scanner is a heuristic accident-prevention layer, not containment, so a
/// command it cannot see is out of scope by design.
fn extract_exec_command(tool_call: &serde_json::Value) -> Option<String> {
    fn command_in(obj: &serde_json::Value) -> Option<String> {
        for key in ["command", "cmd", "script", "shellCommand"] {
            if let Some(s) = obj.get(key).and_then(serde_json::Value::as_str) {
                if !s.trim().is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
        // Some agents pass argv as an array of strings.
        if let Some(arr) = obj.get("command").and_then(serde_json::Value::as_array) {
            let joined = arr
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>()
                .join(" ");
            if !joined.trim().is_empty() {
                return Some(joined);
            }
        }
        None
    }

    if let Some(c) = command_in(tool_call) {
        return Some(c);
    }
    for key in ["rawInput", "raw_input", "input"] {
        if let Some(c) = tool_call.get(key).and_then(command_in) {
            return Some(c);
        }
    }
    None
}

/// Run an ACP tool call's command (if any) through the gateway command-approval
/// scanner. `Allow` when no command is recoverable; `check_exec_scan` itself
/// short-circuits to `Allow` when `RYU_EXEC_APPROVAL_MODE` is unset or `off`.
async fn acp_exec_scan_verdict(tool_call: &serde_json::Value, agent: &str) -> ExecScanOutcome {
    match extract_exec_command(tool_call) {
        Some(command) => check_exec_scan("acp", &command, None, Some(agent)).await,
        None => ExecScanOutcome::Allow,
    }
}

/// Build a `ToolCall` event from an ACP `ToolCall` notification.
fn tool_call_event(call: &ToolCall) -> AcpEvent {
    AcpEvent::ToolCall {
        id: call.tool_call_id.to_string(),
        title: call.title.clone(),
        kind: tool_kind_str(&call.kind),
        input: call.raw_input.clone(),
    }
}

/// Build a `ToolResult` event from an ACP `ToolCallUpdate` notification.
///
/// Updates only carry the fields that changed, so we surface whatever status
/// and/or output is present. Prefer the tool's raw output, falling back to its
/// rendered content blocks. Returns `None` when an update carries nothing the
/// client can act on (no status, no output) — e.g. a bare title tweak.
fn tool_update_event(update: &ToolCallUpdate) -> Option<AcpEvent> {
    let fields = &update.fields;
    let status = fields.status.as_ref().map(tool_status_str);
    // Prefer an ACP `Diff` content block (the standard file-edit signal) so the
    // desktop's diff card renders old↔new; fall back to raw_output, then to the
    // collapsed text/structured content for non-edit tools.
    let output = fields
        .content
        .as_ref()
        .and_then(|content| extract_diff_output(content))
        .or_else(|| fields.raw_output.clone())
        .or_else(|| {
            fields
                .content
                .as_ref()
                .and_then(|content| tool_content_to_output(content))
        });
    if status.is_none() && output.is_none() {
        return None;
    }
    Some(AcpEvent::ToolResult {
        id: update.tool_call_id.to_string(),
        status: status.unwrap_or_else(|| "in_progress".to_owned()),
        output,
    })
}

/// A single fallback provider entry in the default-agent recovery chain.
/// Returned by [`AcpAgentRegistry::fallback_chain_for_default`].
#[derive(Debug, Clone)]
pub struct FallbackProvider {
    pub base_url: String,
    pub model: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone)]
pub enum AgentTransport {
    Acp {
        spawn_cmd: String,
    },
    OpenAiCompat {
        base_url: &'static str,
        model: Option<&'static str>,
    },
}

#[derive(Debug, Clone)]
pub struct AcpAgentEntry {
    pub id: String,
    pub name: String,
    pub description: &'static str,
    /// Binary name to probe in PATH; `None` for always-available agents.
    pub detect_binary: Option<&'static str>,
    /// User-facing install instructions shown when binary not found.
    pub install_hint: &'static str,
    pub transport: AgentTransport,
    /// True for the single recommended/flagship agent (currently "ryu").
    /// Propagated into [`AgentInfo::recommended`] so clients can badge it
    /// without hard-coding the agent id.
    pub recommended: bool,
    /// True when this engine does NOT honour `OPENAI_BASE_URL` / `OPENAI_API_KEY`
    /// for provider redirect. Engines that hardcode their endpoint (Anthropic
    /// format, Google format) carry `gateway_bypass: true`; OpenAI-compat engines
    /// (Codex, Pi, OpenClaw, ZeroClaw) carry `false`. Propagated into
    /// [`AgentInfo::gateway_bypass`] so clients can surface a bypass warning.
    pub gateway_bypass: bool,
    /// Set for binary-only registry agents distributed as per-platform GitHub
    /// release archives (goose, …). When present, the agents-catalog install
    /// handler fetches + extracts the binary into `~/.ryu/bin` BEFORE flipping
    /// the installed flag (so the user gets DownloadCenter progress), and the
    /// entry's `spawn_cmd` already points at that absolute binary path. `None`
    /// for self-fetching (npx/uvx) and always-available agents.
    pub archive_spec: Option<crate::sidecar::agents::archive_agent::ArchiveAgentSpec>,
}

/// Returns `true` if `binary` resolves to an executable file anywhere in `PATH`.
pub fn binary_in_path(binary: &str) -> bool {
    let path_var = match std::env::var("PATH") {
        Ok(v) => v,
        Err(_) => return false,
    };
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(format!("{binary}{ext}"));
        if candidate.is_file() {
            return true;
        }
        // Also try without extension on Windows in case shim has no ext
        if cfg!(target_os = "windows") && dir.join(binary).is_file() {
            return true;
        }
    }
    false
}

/// On Windows, `npx` is a `.cmd` batch file that `Command::new` can't spawn directly.
/// Wrapping with `cmd /c` ensures the shell resolves it correctly.
#[cfg(target_os = "windows")]
fn npx_cmd(cmd: &str) -> String {
    format!("cmd /c {cmd}")
}

#[cfg(not(target_os = "windows"))]
fn npx_cmd(cmd: &str) -> String {
    cmd.to_owned()
}

#[cfg(target_os = "windows")]
fn pi_acp_cmd() -> String {
    // pi-acp defaults to pi.cmd on Windows, but bun installs pi.exe.
    "cmd /c set PI_ACP_PI_COMMAND=pi.exe&& npx -y pi-acp".to_owned()
}

#[cfg(not(target_os = "windows"))]
fn pi_acp_cmd() -> String {
    "npx -y pi-acp".to_owned()
}

/// Directory holding Ryu's OWN managed Pi install — a private package-manager
/// prefix (`~/.ryu/pi`), completely separate from any Pi the user has on their
/// PATH. The two-Pi split is deliberate: the `acp:pi` agent runs the *user's*
/// own Pi (default PATH lookup, `pi_acp_cmd`), while the flagship `ryu` agent
/// runs *this* customized Pi as its engine base.
pub fn managed_pi_dir() -> PathBuf {
    crate::sidecar::download_manager::ryu_dir().join("pi")
}

/// Path to the managed Pi shim produced by installing
/// `@earendil-works/pi-coding-agent` into [`managed_pi_dir`]. Package managers
/// place bin shims under `node_modules/.bin/`, and these shims are NOT
/// relocatable (a bun/npm shim resolves its package + deps relative to that
/// tree). So `PI_ACP_PI_COMMAND` must point at the shim in place here, never at
/// a copy dropped into `bin/`.
///
/// **Windows uses the `.cmd` shim, not `.exe`** (deliberate). pi-acp spawns
/// `PI_ACP_PI_COMMAND` with `child_process.spawn`, and only uses a shell for
/// commands ending in `.cmd`/`.bat`; a bare `.exe` is spawned with `shell:false`,
/// which fails to launch the bun trampoline shim in Core's process context
/// (ENOENT — observed; Core's own `std::process::Command` spawns the same `.exe`
/// fine, so it is specific to pi-acp's Node spawn path). Pointing at the `.cmd`
/// forces pi-acp's `shell:true` path (the one it documents as the Windows
/// default), which launches reliably. [`ensure_ryu_managed_pi`] guarantees a
/// `.cmd` shim exists next to the bun `.exe`.
pub fn managed_pi_binary() -> PathBuf {
    managed_pi_dir()
        .join("node_modules")
        .join(".bin")
        .join(if cfg!(target_os = "windows") {
            "pi.cmd"
        } else {
            "pi"
        })
}

/// Build the ACP spawn command for the `ryu` flagship agent using Core's
/// managed Pi engine. Returns `None` when it has not been installed yet
/// (first run before setup completes), allowing `ryu_agent_route()` to fall
/// back gracefully.
///
/// Core installs Pi independently into [`managed_pi_dir`] so the Ryu agent is
/// completely separate from any Pi the user has on their PATH. `PI_ACP_PI_COMMAND`
/// tells pi-acp which binary to invoke; `PI_CODING_AGENT_DIR` points the managed
/// Pi at Ryu's OWN isolated config directory (never the user's `~/.pi/agent`), so
/// the model/provider config Core writes (see [`crate::pi_config`]) is the only
/// config this Pi reads.
///
/// Gateway env vars (`OPENAI_BASE_URL`/`OPENAI_API_KEY`) are injected ONLY when
/// the managed Pi is in Gateway-routed mode (the default), routing every model
/// call through the Ryu gateway firewall, budget, and audit pipeline. When the
/// user has selected a direct provider ([`crate::pi_config::is_gateway_routing`]
/// is false) the injection is skipped so Pi talks straight to that provider — a
/// deliberate, user-chosen egress bypass.
pub fn ryu_pi_acp_cmd() -> Option<String> {
    let bin = managed_pi_binary();
    if !bin.exists() {
        return None;
    }
    let pi_path = bin.to_string_lossy().into_owned();
    let config_dir = crate::pi_config::config_dir_str();
    let gateway = crate::pi_config::is_gateway_routing();
    if gateway {
        // Pin Pi's `openai` provider at the Gateway in models.json before spawn.
        // Pi ignores `OPENAI_BASE_URL`, so the env injection below is not enough on
        // its own; this is what actually routes Pi through the Gateway. Best-effort
        // — a write failure is logged, and Pi still launches (it just won't route).
        if let Err(e) = crate::pi_config::ensure_gateway_models_json() {
            tracing::warn!(error = %e, "ryu_pi_acp_cmd: could not write gateway models.json");
        }
    }
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());

    #[cfg(target_os = "windows")]
    {
        // CRITICAL (Windows): this whole command string is re-parsed by
        // `AcpAgent::from_str` via `shell_words`, which treats `\` as an escape
        // character and STRIPS it. A Windows path like
        // `C:\Users\…\pi.cmd` therefore becomes `C:Users…pi.cmd`, so cmd.exe can't
        // find pi, the engine never starts, and the ACP turn dies with the opaque
        // "Cannot call write after a stream was destroyed" (pi-acp writing to the
        // exited child's stdin). Double every backslash so shell_words collapses it
        // back to a single one and cmd.exe receives the real path. (The gateway URL
        // and token contain no backslashes, so they need no escaping.)
        let config_dir = config_dir.replace('\\', "\\\\");
        let pi_path = pi_path.replace('\\', "\\\\");
        let gateway_env = if gateway {
            format!("set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& ")
        } else {
            String::new()
        };
        Some(format!(
            "cmd /c {gateway_env}set PI_CODING_AGENT_DIR={config_dir}&& set PI_ACP_PI_COMMAND={pi_path}&& npx -y pi-acp"
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let gateway_env = if gateway {
            format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} ")
        } else {
            String::new()
        };
        Some(format!(
            "{gateway_env}PI_CODING_AGENT_DIR={config_dir} PI_ACP_PI_COMMAND={pi_path} npx -y pi-acp"
        ))
    }
}

/// Build the spawn command for an OpenAI-compatible ACP subprocess (Codex) with
/// gateway egress injection. The subprocess reads `OPENAI_BASE_URL` as its
/// provider base URL; pointing it at the local gateway ensures every outbound
/// model call is governed by the firewall, budget, and audit pipeline (U28).
///
/// The gateway URL includes the `/v1` path suffix that OpenAI client libraries
/// expect (they append `/chat/completions` etc. to it). The gateway bearer token
/// (when set) is passed as `OPENAI_API_KEY` so the subprocess presents a valid
/// credential to the gateway's auth layer.
///
/// Resolution is deferred to call time (not a `const`) so it respects the
/// `RYU_GATEWAY_URL` / `RYU_GATEWAY_TOKEN` env vars as overridden at runtime.
///
/// DEFERRED: Claude Code (Anthropic `/v1/messages`) and Gemini CLI (Google
/// format) are NOT covered here. The gateway router speaks only the OpenAI
/// `/v1/chat/completions` format (`api/mod.rs:17`), so governing them requires a
/// translating ingress — this is a follow-on unit, explicitly out of scope here.
#[cfg(target_os = "windows")]
fn codex_acp_cmd() -> String {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());
    // Windows: inject env vars via `cmd /c set VAR=val&& ...` so the AcpAgent
    // subprocess inherits them. This mirrors pi_acp_cmd()'s approach.
    format!(
        "cmd /c set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& npx -y @zed-industries/codex-acp"
    )
}

#[cfg(not(target_os = "windows"))]
fn codex_acp_cmd() -> String {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());
    // POSIX: prefix the command with inline env var assignments.
    format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} npx -y @zed-industries/codex-acp")
}

/// The gateway URL Claude Code is pointed at via `ANTHROPIC_BASE_URL`. Claude Code
/// appends `/v1/messages` (etc.), which the gateway's transparent passthrough
/// proxy (`/passthrough/anthropic/*`) forwards upstream to Anthropic with the
/// caller's own subscription auth unchanged.
fn anthropic_passthrough_url() -> String {
    let base = crate::sidecar::gateway::gateway_url();
    format!("{}/passthrough/anthropic", base.trim_end_matches('/'))
}

/// Wrap Claude Code's base spawn command with `ANTHROPIC_BASE_URL` injection so its
/// internal HTTP client routes through the Ryu gateway's transparent passthrough
/// proxy (subscription-preserving egress governance).
///
/// **Subscription-preservation rule:** inject ONLY `ANTHROPIC_BASE_URL`. We must
/// NOT set `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` — either takes precedence
/// over the user's Pro/Max subscription OAuth and would flip Claude Code onto
/// API-key billing. The gateway forwards the caller's own bearer upstream.
///
/// Applied only when [`crate::claude_config::is_gateway_routing`] is on (opt-in);
/// see [`crate::claude_config`].
pub fn claude_gateway_cmd(spawn_cmd: &str) -> String {
    let base_url = anthropic_passthrough_url();
    #[cfg(target_os = "windows")]
    {
        // The base claude spawn command is `cmd /c npx -y …`; re-emit it with a
        // `set ANTHROPIC_BASE_URL=…&&` prefix inside the same `cmd /c` (mirrors
        // ryu_pi_acp_cmd's Windows form).
        format!(
            "cmd /c set ANTHROPIC_BASE_URL={base_url}&& {}",
            spawn_cmd.trim_start_matches("cmd /c ")
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("ANTHROPIC_BASE_URL={base_url} {spawn_cmd}")
    }
}

/// Wrap an arbitrary ACP spawn command with `OPENAI_BASE_URL` + `OPENAI_API_KEY`
/// injection pointing at the local gateway's `/v1`, so the agent's HTTP client
/// sends its model calls through the Ryu gateway (firewall/budget/audit) instead
/// of straight to a provider. This is the GENERIC "point any agent at the gateway
/// via the OpenAI base-URL swap" lever, gated per-agent by
/// [`crate::agent_routing::is_gateway_routing`].
///
/// Unlike Pi/Claude/Codex (which each have their own dedicated, format-specific
/// routing), this is applied to the verbatim ACP branches: a BYO `acp-exec:`
/// agent and the non-special-cased registry ACP agents. It only does anything for
/// agents whose client actually honours `OPENAI_BASE_URL` (an OpenAI-compatible
/// agent — e.g. a custom `acp-exec:` one); it is a harmless no-op for agents that
/// speak another wire format or use their own gateway. Unlike the subscription-
/// preserving Claude/Codex passthroughs, this DOES inject `OPENAI_API_KEY` (the
/// gateway token) because the target is an API-key OpenAI-compatible client, not a
/// subscription login.
///
/// Mirrors [`claude_gateway_cmd`]'s shell handling: on Windows it re-emits the
/// command inside a single `cmd /c set VAR=val&& …` (stripping a leading `cmd /c`
/// so it isn't doubled); on POSIX it prefixes inline `VAR=val` assignments.
pub fn openai_gateway_cmd(spawn_cmd: &str) -> String {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    let token = crate::sidecar::gateway::gateway_token().unwrap_or_else(|| "ryu-local".to_owned());
    #[cfg(target_os = "windows")]
    {
        format!(
            "cmd /c set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& {}",
            spawn_cmd.trim_start_matches("cmd /c ")
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} {spawn_cmd}")
    }
}

/// Build Codex's ACP spawn command for **subscription-preserving** gateway
/// routing. Unlike `codex_acp_cmd()` (which injects `OPENAI_BASE_URL` +
/// `OPENAI_API_KEY` to govern the *API-key* path), this points Codex at an
/// isolated `CODEX_HOME` whose `config.toml` routes the **subscription**
/// (ChatGPT-login) Responses traffic through the gateway passthrough proxy while
/// the user's own OAuth bearer + `ChatGPT-Account-ID` reach upstream unchanged.
///
/// **Subscription-preservation rule:** inject ONLY `CODEX_HOME`. We must NOT set
/// `OPENAI_API_KEY` / `OPENAI_BASE_URL` here — either would flip Codex onto
/// API-key billing. The isolated home reuses the user's real `auth.json` (the
/// OAuth subscription credential), copied in by
/// [`crate::codex_config::ensure_gateway_home`].
///
/// Applied only when [`crate::codex_config::is_gateway_routing`] is on (opt-in).
pub fn codex_acp_gateway_cmd() -> String {
    // (Re)write the isolated CODEX_HOME (provider config + refreshed auth) and
    // resolve its path. On any IO failure fall back to the user's default home so
    // Codex still starts (ungoverned) rather than failing the turn.
    let home = crate::codex_config::ensure_gateway_home().unwrap_or_else(|_| {
        crate::codex_config::codex_home()
            .to_string_lossy()
            .into_owned()
    });
    #[cfg(target_os = "windows")]
    {
        format!("cmd /c set CODEX_HOME={home}&& npx -y @zed-industries/codex-acp")
    }
    #[cfg(not(target_os = "windows"))]
    {
        format!("CODEX_HOME={home} npx -y @zed-industries/codex-acp")
    }
}

/// Build the ACP spawn command for OpenClaw.
///
/// OpenClaw's ACP mode (`openclaw acp`) is a **Gateway-backed stdio bridge**: it
/// speaks ACP on stdin/stdout to us and forwards every prompt to the user's
/// OpenClaw Gateway over WebSocket (`wss://…:18789`), reading the gateway URL and
/// token from OpenClaw's own config (`gateway.remote.*`) when no `--url`/`--token`
/// flags are given. It is therefore **not** a self-contained subprocess the way
/// Claude Code / Codex / Pi are — it needs a reachable OpenClaw Gateway (local via
/// `openclaw gateway`, or remote). That is OpenClaw's own architecture, not Ryu's,
/// so we spawn the canonical bridge command and leave the gateway endpoint to the
/// user's OpenClaw config (see the entry's `install_hint`).
///
/// Core installs OpenClaw under `~/.ryu/bin` via npm (see
/// [`crate::sidecar::agents::openclaw::installer`]); we prefer that managed binary
/// and fall back to `openclaw` on the user's PATH. Because `openclaw` talks to its
/// own gateway (and never honours `OPENAI_BASE_URL`), the entry carries
/// `gateway_bypass: true` — Ryu's gateway does not see its egress.
fn openclaw_acp_cmd() -> String {
    let managed = crate::sidecar::agents::openclaw::installer::binary_path();
    let base = if managed.exists() {
        managed.to_string_lossy().into_owned()
    } else {
        "openclaw".to_owned()
    };
    npx_cmd(&format!("{base} acp"))
}

/// Build the ACP spawn command for the NousResearch Hermes agent.
///
/// Hermes runs ACP **natively** via `hermes acp` (NousResearch docs): the adapter
/// reads provider credentials and config from the standard Hermes paths
/// (`~/.hermes/.env`, `~/.hermes/config.yaml`) and runs the agent loop in-process,
/// so it is fully self-contained once Hermes is installed (unlike OpenClaw). When
/// the `hermes` CLI is not on PATH we fall back to the registry-published `uvx`
/// invocation, which self-fetches the package (requires `uv`/`uvx` on PATH).
///
/// Hermes uses its own provider credentials and does not honour `OPENAI_BASE_URL`,
/// so the entry carries `gateway_bypass: true`.
fn hermes_acp_cmd() -> String {
    if binary_in_path("hermes") {
        // `npx_cmd` is just the Windows `cmd /c` shell wrapper here (Hermes may be
        // a `.cmd`/`.bat` shim on Windows); it is a no-op on POSIX.
        npx_cmd("hermes acp")
    } else {
        // shell_words (used by AcpAgent::from_str) keeps the quoted extra spec as a
        // single arg, so the `[acp]` extra survives intact.
        npx_cmd("uvx --from \"hermes-agent[acp]\" hermes-acp")
    }
}

/// Build an `Acp` registry entry for a self-fetching ACP agent from the official
/// ACP registry (`https://cdn.agentclientprotocol.com/registry/v1/latest`).
///
/// `dist` is the launch command *minus* the leading runner-fetch boilerplate:
///   - `Npx(rest)`  → `npx -y <rest>` (e.g. `cline --acp`, `@kilocode/cli acp`),
///     wrapped in `cmd /c` on Windows since `npx` is a `.cmd` shim there.
///   - `Uvx(rest)`  → `uvx <rest>` (e.g. `fast-agent-acp -x`); `uvx` is a real
///     executable so it needs no shell wrapper.
///
/// Both runners self-fetch on first use, so these agents work cross-platform with
/// no Ryu-side download infrastructure. Every such agent makes its own provider
/// calls internally (Ryu cannot inject `OPENAI_BASE_URL`), so all carry
/// `gateway_bypass: true` — honest about the egress not traversing Ryu's gateway.
fn registry_acp_entry(
    id: &str,
    name: &str,
    description: &'static str,
    detect_binary: Option<&'static str>,
    install_hint: &'static str,
    dist: AcpDist,
) -> AcpAgentEntry {
    let mut archive_spec = None;
    let spawn_cmd = match dist {
        AcpDist::Npx(rest) => npx_cmd(&format!("npx -y {rest}")),
        // `uvx` is a real binary (shipped with `uv`); no `cmd /c` wrapper needed.
        AcpDist::Uvx(rest) => format!("uvx {rest}"),
        // Binary-only registry agent: install handler downloads + extracts the
        // archive into `~/.ryu/bin`, so the spawn command is the absolute binary
        // path plus the agent's ACP args (e.g. `<bin> acp`).
        AcpDist::Archive { spec, acp_args } => {
            let bin = spec.binary_path();
            let bin = bin.display();
            let spawn_cmd = if acp_args.is_empty() {
                format!("{bin}")
            } else {
                format!("{bin} {acp_args}")
            };
            archive_spec = Some(spec);
            spawn_cmd
        }
    };
    AcpAgentEntry {
        id: id.to_owned(),
        name: name.to_owned(),
        description,
        detect_binary,
        install_hint,
        transport: AgentTransport::Acp { spawn_cmd },
        recommended: false,
        gateway_bypass: true,
        archive_spec,
    }
}

/// Distribution form for a self-fetching ACP registry agent (see
/// [`registry_acp_entry`]).
enum AcpDist {
    /// `npx -y <rest>` — npm-published adapters that self-fetch.
    Npx(&'static str),
    /// `uvx <rest>` — PyPI-published adapters run via `uv`'s `uvx`.
    Uvx(&'static str),
    /// A binary-only agent distributed as per-platform GitHub release archives.
    /// Ryu installs the binary into `~/.ryu/bin` (via the agents-catalog install
    /// handler) and spawns it with `acp_args` (e.g. `acp`).
    Archive {
        spec: crate::sidecar::agents::archive_agent::ArchiveAgentSpec,
        acp_args: &'static str,
    },
}

/// The self-fetching (npx/uvx) agents from the official ACP registry, minus the
/// ones already curated as first-class entries above (Claude Code, Codex, Gemini
/// CLI, Pi — those have bespoke gateway-injection handling). Pure ACP subprocess
/// agents; each self-fetches via `npx`/`uvx` on first run.
///
/// The **binary-only** registry agents (amp, cortex-code, corust, crow-cli,
/// cursor, devin, goose, junie, kimi, mistral-vibe, opencode, poolside, stakpak,
/// vtcode) are distributed as per-platform GitHub release archives, not npx/uvx.
/// The archive-download machinery now exists
/// ([`crate::sidecar::agents::archive_agent`]), so each can be added here as an
/// [`AcpDist::Archive`] entry once its real GitHub repo, asset-name template,
/// platform-tag convention, binary name, and ACP invocation flag are confirmed
/// from that project's releases page. **goose** (`block/goose`,
/// `goose-{platform}.{ext}`, `goose acp`) is wired below as the proven anchor;
/// the remaining 13 stay deferred (not fabricated) until their asset patterns are
/// verified — adding one is a single `Archive` row.
fn registry_acp_entries() -> Vec<AcpAgentEntry> {
    use crate::sidecar::agents::archive_agent::ArchiveAgentSpec;
    use AcpDist::{Archive, Npx, Uvx};
    vec![
        // ── Binary-only archive agents ──────────────────────────────────────
        // goose: the proven anchor. block/goose ships `goose-<triple>.tar.gz`
        // (`.zip` on Windows) on every GitHub release; the CLI speaks ACP via
        // `goose acp` (verified from goose's ACP-clients docs).
        registry_acp_entry(
            "acp:goose",
            "goose",
            "Block's goose — extensible on-machine coding agent (ACP)",
            None,
            "Installs the goose binary from GitHub releases on first install",
            Archive {
                spec: ArchiveAgentSpec {
                    id: "goose",
                    repo: "block/goose",
                    asset_template: "goose-{platform}.{ext}",
                    binary_name: "goose",
                    pinned_tag: None,
                    label: "goose",
                },
                acp_args: "acp",
            },
        ),
        registry_acp_entry(
            "acp:cline",
            "Cline",
            "Cline — autonomous coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("cline --acp"),
        ),
        registry_acp_entry(
            "acp:auggie",
            "Auggie CLI",
            "Augment Code's CLI coding agent (ACP)",
            None,
            "Self-fetches via npx; sign in to Augment Code for provider access",
            Npx("@augmentcode/auggie --acp"),
        ),
        registry_acp_entry(
            "acp:qwen",
            "Qwen Code",
            "Alibaba Qwen Code agent (ACP)",
            None,
            "Self-fetches via npx; set your Qwen/DashScope credentials",
            Npx("@qwen-code/qwen-code --acp --experimental-skills"),
        ),
        registry_acp_entry(
            "acp:copilot",
            "GitHub Copilot",
            "GitHub Copilot CLI coding agent (ACP, public preview)",
            None,
            "Self-fetches via npx; sign in with `gh auth login` / Copilot access",
            Npx("@github/copilot --acp"),
        ),
        registry_acp_entry(
            "acp:kilo",
            "Kilo",
            "Kilo Code agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("@kilocode/cli acp"),
        ),
        registry_acp_entry(
            "acp:codebuddy",
            "Codebuddy Code",
            "Tencent Codebuddy Code agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("@tencent-ai/codebuddy-code --acp"),
        ),
        registry_acp_entry(
            "acp:nova",
            "Nova",
            "Compass AI Nova coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("@compass-ai/nova acp"),
        ),
        registry_acp_entry(
            "acp:qoder",
            "Qoder CLI",
            "Qoder coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("@qoder-ai/qodercli --acp"),
        ),
        registry_acp_entry(
            "acp:grok",
            "Grok Build",
            "xAI Grok coding agent (ACP)",
            None,
            "Self-fetches via npx; set your xAI API key",
            Npx("@xai-official/grok agent stdio"),
        ),
        registry_acp_entry(
            "acp:droid",
            "Factory Droid",
            "Factory Droid agent (ACP)",
            None,
            "Self-fetches via npx; sign in to Factory",
            Npx("droid exec --output-format acp-daemon"),
        ),
        registry_acp_entry(
            "acp:dirac",
            "Dirac",
            "Dirac CLI coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("dirac-cli --acp"),
        ),
        registry_acp_entry(
            "acp:dimcode",
            "DimCode",
            "DimCode coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("dimcode acp"),
        ),
        registry_acp_entry(
            "acp:autohand",
            "Autohand Code",
            "Autohand coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("@autohandai/autohand-acp"),
        ),
        registry_acp_entry(
            "acp:deepagents",
            "DeepAgents",
            "DeepAgents ACP agent",
            None,
            "Self-fetches via npx on first run",
            Npx("deepagents-acp"),
        ),
        registry_acp_entry(
            "acp:glm",
            "GLM Agent",
            "Zhipu GLM coding agent (ACP)",
            None,
            "Self-fetches via npx; set your Zhipu GLM API key",
            Npx("glm-acp-agent"),
        ),
        registry_acp_entry(
            "acp:sigit",
            "siGit Code",
            "siGit coding agent (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("@smbcloud/sigit"),
        ),
        registry_acp_entry(
            "acp:agoragentic",
            "Agoragentic",
            "Agoragentic — agent marketplace with 174+ capabilities (ACP)",
            None,
            "Self-fetches via npx on first run",
            Npx("agoragentic-mcp --acp"),
        ),
        registry_acp_entry(
            "acp:fast-agent",
            "fast-agent",
            "fast-agent — Python ACP agent server",
            Some("uvx"),
            "Run via uvx (install `uv`: https://docs.astral.sh/uv/)",
            Uvx("fast-agent-acp -x"),
        ),
        registry_acp_entry(
            "acp:minion",
            "Minion Code",
            "Minion Code agent (ACP)",
            Some("uvx"),
            "Run via uvx (install `uv`: https://docs.astral.sh/uv/)",
            Uvx("minion-code acp"),
        ),
    ]
}

pub struct AcpAgentRegistry {
    pub entries: Vec<AcpAgentEntry>,
}

impl AcpAgentRegistry {
    pub fn new() -> Self {
        {
            let mut entries = vec![
                // ── "Ryu" flagship: Pi engine + Gateway on top ──────────────────
                // The default car-around-the-engine demo agent. Pi is the engine
                // binding (swappable via the pi entry below); the gateway layer is
                // injected at routing time in `ryu_agent_route()` (adapters/mod.rs).
                // Seeded first so it appears at the top of the agent list.
                AcpAgentEntry {
                    id: "ryu".into(),
                    name: "Ryu".into(),
                    description: "The default Ryu agent — Core-managed Pi engine with the Gateway on top. Installed separately from your own Pi.",
                    // Ryu manages its own Pi binary in ~/.ryu/bin/; it does not
                    // depend on the user having Pi installed. detect_binary is None
                    // so the availability check in ryu_agent_route() governs instead.
                    detect_binary: None,
                    install_hint: "Ryu installs its own Pi engine automatically on first run",
                    transport: AgentTransport::Acp {
                        // Fallback spawn_cmd used only when the managed binary is
                        // not yet installed (ryu_agent_route() calls ryu_pi_acp_cmd()
                        // first and falls back to user's pi + gateway if not ready).
                        spawn_cmd: pi_acp_cmd(),
                    },
                    recommended: true,
                    gateway_bypass: false,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "acp:claude".into(),
                    name: "Claude Code".into(),
                    description: "Anthropic's agentic AI — coding, analysis, and reasoning",
                    detect_binary: Some("claude"),
                    install_hint: "npm install -g @anthropic-ai/claude-code",
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("npx -y @zed-industries/claude-code-acp@latest"),
                    },
                    recommended: false,
                    // Claude Code uses Anthropic /v1/messages and ignores
                    // OPENAI_BASE_URL; gateway injection would 404. This is a
                    // residual bypass pending a translating ingress in the gateway.
                    gateway_bypass: true,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "acp:codex".into(),
                    name: "Codex".into(),
                    description: "OpenAI's coding agent — natural language to code",
                    detect_binary: Some("codex"),
                    install_hint: "Set OPENAI_API_KEY (or sign in to Codex); the codex-acp adapter is fetched via npx",
                    transport: AgentTransport::Acp {
                        // Codex has no native ACP mode — bridge through Zed's
                        // codex-acp adapter. OPENAI_BASE_URL is injected to route
                        // every Codex provider call through ryu-gateway so the
                        // firewall, budget, and audit pipeline govern egress (U28).
                        spawn_cmd: codex_acp_cmd(),
                    },
                    recommended: false,
                    // API-key mode honours OPENAI_BASE_URL (injected by
                    // codex_acp_cmd() above), so that path is governed. The
                    // ChatGPT-login (subscription) path ignores OPENAI_BASE_URL
                    // and bypasses the gateway UNLESS the user opts into the
                    // `codex-gateway-routing` toggle, which routes it through the
                    // subscription passthrough (codex_acp_gateway_cmd + the
                    // gateway /passthrough/openai-responses route, see
                    // crate::codex_config).
                    gateway_bypass: false,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "acp:gemini".into(),
                    name: "Gemini CLI".into(),
                    description: "Google Gemini — multimodal agent with large context window",
                    detect_binary: Some("gemini"),
                    install_hint: "npm install -g @google/gemini-cli",
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("npx -y -- @google/gemini-cli@latest --experimental-acp"),
                    },
                    recommended: false,
                    // Gemini CLI uses Google's endpoint format and ignores
                    // OPENAI_BASE_URL; gateway injection is not possible without a
                    // translating ingress. Residual bypass until that is built.
                    gateway_bypass: true,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "acp:pi".into(),
                    name: "Pi".into(),
                    description: "Pi — your own installed Pi agent, runs with your config and API key",
                    detect_binary: Some("pi"),
                    install_hint: "npm install -g pi-acp",
                    transport: AgentTransport::Acp {
                        // Bare Pi: no gateway injection. The user's own Pi binary
                        // on PATH is used as-is with their config, API key, and
                        // model settings. The Ryu flagship agent (above) is the
                        // separately managed Pi build with gateway on top.
                        spawn_cmd: pi_acp_cmd(),
                    },
                    recommended: false,
                    gateway_bypass: false,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "openclaw".into(),
                    name: "OpenClaw".into(),
                    description: "OpenClaw — self-hosted AI assistant, run over its native ACP bridge",
                    // OpenClaw ships a CLI (managed under ~/.ryu/bin or on PATH).
                    detect_binary: Some("openclaw"),
                    install_hint: "Requires a reachable OpenClaw Gateway (run `openclaw gateway` locally, or point your OpenClaw config at a remote one); `openclaw acp` then bridges to it",
                    transport: AgentTransport::Acp {
                        // `openclaw acp` is a Gateway-backed stdio bridge — see
                        // openclaw_acp_cmd(). It is NOT self-contained; it needs the
                        // user's OpenClaw Gateway running/configured.
                        spawn_cmd: openclaw_acp_cmd(),
                    },
                    recommended: false,
                    // OpenClaw talks to its own gateway and never honours
                    // OPENAI_BASE_URL, so its egress does not traverse Ryu's gateway.
                    gateway_bypass: true,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "zeroclaw".into(),
                    name: "ZeroClaw".into(),
                    description: "Fast native autonomous agent by Ryu",
                    detect_binary: None,
                    install_hint: "",
                    transport: AgentTransport::OpenAiCompat {
                        base_url: "http://127.0.0.1:42617",
                        model: None,
                    },
                    recommended: false,
                    gateway_bypass: false,
                    archive_spec: None,
                },
                AcpAgentEntry {
                    id: "hermes".into(),
                    name: "Hermes Agent".into(),
                    description: "NousResearch Hermes — open-source agent with native tool use (ACP)",
                    detect_binary: Some("hermes"),
                    install_hint: "Install Hermes Agent (`pip install 'hermes-agent[acp]'` or the install script) and set a provider with `hermes model`; ACP runs via `hermes acp`",
                    transport: AgentTransport::Acp {
                        // `hermes acp` runs the agent loop in-process from ~/.hermes
                        // config; falls back to a self-fetching uvx invocation when
                        // the hermes CLI is not on PATH (see hermes_acp_cmd()).
                        spawn_cmd: hermes_acp_cmd(),
                    },
                    recommended: false,
                    // Hermes uses its own provider credentials (~/.hermes), not
                    // OPENAI_BASE_URL, so its egress does not traverse Ryu's gateway.
                    gateway_bypass: true,
                    archive_spec: None,
                },
            ];
            entries.extend(registry_acp_entries());
            Self { entries }
        }
    }

    /// Real tools available for `agent_id`: the tools the agent has actually
    /// invoked this process run. ACP agents publish no static tool catalog, so
    /// an agent reports an empty list until it uses a tool — see
    /// [`observed_tools`]. Returns an empty list for unknown agents.
    pub fn tools_for(&self, agent_id: &str) -> Vec<ToolInfo> {
        observed_tools_for(agent_id)
    }

    /// The MCP tool allowlist for an agent, if one is configured.
    ///
    /// `None` means "no restriction — every registered MCP tool is allowed";
    /// `Some(list)` restricts the agent to those tools (matched by fully-
    /// qualified id, bare tool name, or server name — see `McpRegistry`).
    ///
    /// Resolution order (first match wins):
    ///   1. `RYU_MCP_ALLOWLIST_<AGENT>` — per-agent, where `<AGENT>` is the
    ///      agent id upper-cased with non-alphanumerics turned into `_`
    ///      (e.g. `acp:claude` → `RYU_MCP_ALLOWLIST_ACP_CLAUDE`).
    ///   2. `RYU_MCP_ALLOWLIST` — a global default applied to every agent.
    /// In both cases the value is a comma-separated list; an empty value means
    /// an explicit empty allowlist (no MCP tools).
    pub fn allowlist_for(&self, agent_id: &str) -> Option<Vec<String>> {
        let key_suffix: String = agent_id
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() {
                    c.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect();
        let per_agent = std::env::var(format!("RYU_MCP_ALLOWLIST_{key_suffix}")).ok();
        let raw = per_agent.or_else(|| std::env::var("RYU_MCP_ALLOWLIST").ok())?;
        Some(
            raw.split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
        )
    }

    /// Find a registry entry whose `id` is a prefix of (or equal to) `agent_id`.
    pub fn find_by_prefix(&self, agent_id: &str) -> Option<&AcpAgentEntry> {
        self.entries
            .iter()
            .find(|e| agent_id == e.id || agent_id.starts_with(&e.id))
    }

    /// Return the fallback provider chain for the default/"ryu" agent. Called by
    /// `route_chat_stream` when the primary route fails with a transport/provider
    /// error so the stream can recover instead of surfacing a raw error.
    ///
    /// The chain is registry-configured — swappable at runtime via env vars:
    ///   `RYU_FALLBACK_LLM_BASE_URL` — fallback provider base URL
    ///                                  (default: local llamacpp at :8080)
    ///   `RYU_FALLBACK_LLM_MODEL`    — fallback model id
    ///                                  (default: `gemma2`)
    ///   `RYU_FALLBACK_LLM_API_KEY`  — bearer key for the fallback (optional)
    ///
    /// Returns a list with one entry — a single bounded retry, never an infinite
    /// loop. An empty list means no fallback is configured (caller must error out).
    pub fn fallback_chain_for_default(&self) -> Vec<FallbackProvider> {
        let base_url = std::env::var("RYU_FALLBACK_LLM_BASE_URL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "http://127.0.0.1:8080".to_owned());
        let model = std::env::var("RYU_FALLBACK_LLM_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "gemma2".to_owned());
        let api_key = std::env::var("RYU_FALLBACK_LLM_API_KEY")
            .ok()
            .filter(|s| !s.is_empty());
        vec![FallbackProvider {
            base_url,
            model,
            api_key,
        }]
    }

    /// List all registry agents as [`AgentInfo`] records.
    ///
    /// `default_agent_id` is the registry-configured id that should be
    /// marked as `enabled: true` in the response (AC2 of U041). Pass the
    /// value from [`crate::registry::ProviderRegistry::default_agent_id`].
    /// The built-in fallback is `"acp:pi"` (see
    /// [`crate::registry::DEFAULT_AGENT_ID`]).
    pub fn list_infos(&self) -> Vec<AgentInfo> {
        let default_agent_id = crate::registry::ProviderRegistry::load().default_agent_id;
        self.list_infos_with_default(&default_agent_id)
    }

    /// Like [`list_infos`] but accepts the default agent id directly (avoids
    /// reading the registry file for each entry; used by the server handler
    /// which already holds a loaded registry).
    pub fn list_infos_with_default(&self, default_agent_id: &str) -> Vec<AgentInfo> {
        self.entries
            .iter()
            .map(|e| {
                let model = match &e.transport {
                    AgentTransport::OpenAiCompat { model, .. } => model.map(str::to_owned),
                    AgentTransport::Acp { .. } => None,
                };
                // Engine binding is decided here in Core, never by the client.
                // ACP agents are their own runtime (strip the "acp:" id prefix);
                // OpenAI-compatible agents are themselves the local engine.
                let (engine, transport) = match &e.transport {
                    AgentTransport::Acp { .. } => (
                        Some(e.id.strip_prefix("acp:").unwrap_or(&e.id).to_owned()),
                        "acp",
                    ),
                    AgentTransport::OpenAiCompat { .. } => (Some(e.id.clone()), "openai_compat"),
                };
                let installed = e.detect_binary.map(binary_in_path);
                // Mark the default agent as `enabled: true` (AC2). Config is
                // authoritative; this is NOT persisted to the agents DB (AC4).
                let enabled = (e.id == default_agent_id).then_some(true);
                // Surface the gateway bypass flag (AC3 of #214) so clients can
                // show a warning for engines that cannot be redirected through the
                // local gateway (Claude Code, Gemini CLI).
                let gateway_bypass = e.gateway_bypass.then_some(true);
                if e.gateway_bypass {
                    tracing::debug!(
                        agent_id = %e.id,
                        "acp: agent does not honour OPENAI_BASE_URL — provider calls \
                         bypass the local gateway (residual egress; set gateway_bypass=true \
                         in metadata). To govern this agent, a translating ingress is needed."
                    );
                }
                AgentInfo {
                    id: e.id.clone(),
                    name: e.name.clone(),
                    description: Some(e.description.to_string()),
                    install_hint: if e.install_hint.is_empty() {
                        None
                    } else {
                        Some(e.install_hint.to_string())
                    },
                    recommended: e.recommended.then_some(true),
                    installed,
                    model,
                    system_prompt: None,
                    created_at: None,
                    engine,
                    transport: Some(transport.to_owned()),
                    version: None,
                    locked: None,
                    enabled,
                    gateway_bypass,
                }
            })
            .collect()
    }
}

impl Default for AcpAgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pi_acp_cmd_gated() -> String {
        pi_acp_cmd()
    }

    #[test]
    fn list_infos_binds_acp_agents_to_their_runtime() {
        let infos = AcpAgentRegistry::new().list_infos();
        let claude = infos
            .iter()
            .find(|a| a.id == "acp:claude")
            .expect("claude agent present");
        assert_eq!(claude.transport.as_deref(), Some("acp"));
        // ACP agents are their own runtime; the "acp:" prefix is stripped.
        assert_eq!(claude.engine.as_deref(), Some("claude"));
    }

    #[test]
    fn list_infos_binds_openai_compat_agents_to_local_engine() {
        let infos = AcpAgentRegistry::new().list_infos();
        let zeroclaw = infos
            .iter()
            .find(|a| a.id == "zeroclaw")
            .expect("zeroclaw agent present");
        assert_eq!(zeroclaw.transport.as_deref(), Some("openai_compat"));
        // OpenAI-compatible agents are themselves the local engine.
        assert_eq!(zeroclaw.engine.as_deref(), Some("zeroclaw"));
    }

    #[test]
    fn every_agent_reports_an_engine_and_transport() {
        for info in AcpAgentRegistry::new().list_infos() {
            assert!(
                info.engine.is_some(),
                "agent {} missing engine binding",
                info.id
            );
            assert!(
                info.transport.is_some(),
                "agent {} missing transport",
                info.id
            );
        }
    }

    // ── Codex gateway egress injection (U28) ─────────────────────────────────

    #[test]
    fn codex_spawn_cmd_injects_gateway_base_url() {
        // codex_acp_cmd() must embed the gateway /v1 URL so that Codex routes
        // every outbound provider call through ryu-gateway, not directly to
        // OpenAI.  The test validates the URL is present regardless of whether
        // RYU_GATEWAY_URL is set (uses the default when absent).
        let cmd = codex_acp_cmd();
        let gateway_base = crate::sidecar::gateway::gateway_url();
        let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
        assert!(
            cmd.contains(&expected_v1),
            "codex spawn cmd should contain the gateway /v1 URL, got: {cmd}"
        );
    }

    #[test]
    fn codex_spawn_cmd_injects_api_key() {
        // The spawn cmd must set an OPENAI_API_KEY that the subprocess can
        // present to the gateway's auth layer (even if auth is disabled, the
        // key slot must be populated so the subprocess doesn't error out on
        // the missing-key guard).
        let cmd = codex_acp_cmd();
        assert!(
            cmd.contains("OPENAI_API_KEY"),
            "codex spawn cmd should set OPENAI_API_KEY for gateway auth, got: {cmd}"
        );
    }

    #[test]
    fn codex_spawn_cmd_gateway_url_is_swappable() {
        // The injection must honour RYU_GATEWAY_URL — no hardcoded endpoint.
        let prev = std::env::var("RYU_GATEWAY_URL").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://test-gw.local:9999");
        let cmd = codex_acp_cmd();
        match prev {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
        assert!(
            cmd.contains("http://test-gw.local:9999/v1"),
            "codex spawn cmd should use RYU_GATEWAY_URL when set, got: {cmd}"
        );
    }

    // ── Ryu flagship agent (U042) ─────────────────────────────────────────────

    #[test]
    fn ryu_agent_is_present_in_registry() {
        let infos = AcpAgentRegistry::new().list_infos();
        let ryu = infos
            .iter()
            .find(|a| a.id == "ryu")
            .expect("ryu agent present");
        assert_eq!(ryu.transport.as_deref(), Some("acp"));
        // Ryu uses Pi as its engine; the id strip yields "ryu" (no "acp:" prefix).
        assert_eq!(ryu.engine.as_deref(), Some("ryu"));
    }

    #[test]
    fn ryu_is_the_only_recommended_agent() {
        let infos = AcpAgentRegistry::new().list_infos();
        let recommended: Vec<&str> = infos
            .iter()
            .filter(|a| a.recommended == Some(true))
            .map(|a| a.id.as_str())
            .collect();
        assert_eq!(
            recommended,
            ["ryu"],
            "exactly one agent should be recommended: ryu"
        );
    }

    #[test]
    fn ryu_pi_binding_is_read_from_registry_entry() {
        // AC4: the Ryu agent's engine binding must come from the Pi entry in the
        // AcpAgentRegistry, not be hardcoded. Finding acp:pi in the registry and
        // the ryu entry both present validates the swappable binding contract.
        let reg = AcpAgentRegistry::new();
        assert!(
            reg.find_by_prefix("acp:pi").is_some(),
            "Pi entry must exist in registry as the Ryu engine binding"
        );
        assert!(
            reg.find_by_prefix("ryu").is_some(),
            "Ryu entry must exist in registry"
        );
    }

    #[test]
    fn extract_exec_command_finds_command_shapes() {
        // Top-level command string.
        let tc = serde_json::json!({ "command": "rm -rf /tmp/x" });
        assert_eq!(
            extract_exec_command(&tc).as_deref(),
            Some("rm -rf /tmp/x")
        );
        // Nested under rawInput as an argv array.
        let tc = serde_json::json!({
            "kind": "execute",
            "rawInput": { "command": ["git", "push", "--force"] }
        });
        assert_eq!(
            extract_exec_command(&tc).as_deref(),
            Some("git push --force")
        );
        // Non-exec tool call (a file read) yields nothing to scan.
        let tc = serde_json::json!({ "kind": "read", "path": "/etc/hosts" });
        assert!(extract_exec_command(&tc).is_none());
        // Empty command string is treated as absent.
        let tc = serde_json::json!({ "command": "   " });
        assert!(extract_exec_command(&tc).is_none());
    }

    // ── Pi as default-installed+enabled agent (U041) ──────────────────────────

    #[test]
    fn default_agent_enabled_flag_set_for_configured_id() {
        // AC2: list_infos_with_default must mark the configured agent as
        // `enabled: Some(true)` and leave all others as `None`.
        let reg = AcpAgentRegistry::new();

        // With default "acp:pi" — the Pi entry is enabled.
        let infos = reg.list_infos_with_default("acp:pi");
        let pi = infos
            .iter()
            .find(|a| a.id == "acp:pi")
            .expect("acp:pi present");
        assert_eq!(
            pi.enabled,
            Some(true),
            "acp:pi should be enabled when it is the default"
        );

        // Every other agent must NOT have enabled set.
        for info in infos.iter().filter(|a| a.id != "acp:pi") {
            assert!(
                info.enabled.is_none(),
                "agent {} should not have enabled set when acp:pi is the default",
                info.id
            );
        }
    }

    #[test]
    fn default_agent_enabled_is_overridable_via_registry() {
        // AC4: changing the default_agent_id changes which agent is `enabled`.
        let reg = AcpAgentRegistry::new();

        // Set a different default (e.g. "acp:claude") — claude should be enabled.
        let infos = reg.list_infos_with_default("acp:claude");
        let claude = infos
            .iter()
            .find(|a| a.id == "acp:claude")
            .expect("acp:claude present");
        assert_eq!(
            claude.enabled,
            Some(true),
            "acp:claude should be enabled when it is the default"
        );

        // acp:pi must not be enabled in this configuration.
        let pi = infos
            .iter()
            .find(|a| a.id == "acp:pi")
            .expect("acp:pi present");
        assert!(
            pi.enabled.is_none(),
            "acp:pi should not be enabled when acp:claude is the default"
        );
    }

    #[test]
    fn only_one_agent_has_enabled_set_at_a_time() {
        // Invariant: at most one agent carries `enabled: Some(true)` in a given
        // list_infos response — the one that matches the default_agent_id.
        let reg = AcpAgentRegistry::new();
        let infos = reg.list_infos_with_default("acp:pi");
        let enabled_count = infos.iter().filter(|a| a.enabled == Some(true)).count();
        assert_eq!(
            enabled_count, 1,
            "exactly one agent should have enabled: true"
        );
    }

    // ── Gateway bypass detection (AC3 of #214) ───────────────────────────────

    #[test]
    fn bypass_agents_carry_gateway_bypass_true_in_metadata() {
        // Claude Code and Gemini CLI cannot be redirected via OPENAI_BASE_URL;
        // they must surface gateway_bypass: Some(true) so clients can warn users.
        let infos = AcpAgentRegistry::new().list_infos();
        let claude = infos
            .iter()
            .find(|a| a.id == "acp:claude")
            .expect("acp:claude present");
        assert_eq!(
            claude.gateway_bypass,
            Some(true),
            "Claude Code should carry gateway_bypass: true — it uses Anthropic format"
        );
        let gemini = infos
            .iter()
            .find(|a| a.id == "acp:gemini")
            .expect("acp:gemini present");
        assert_eq!(
            gemini.gateway_bypass,
            Some(true),
            "Gemini CLI should carry gateway_bypass: true — it uses Google format"
        );
    }

    #[test]
    fn injectable_agents_do_not_carry_gateway_bypass() {
        // Codex, Pi, and the Ryu flagship honour OPENAI_BASE_URL; they must NOT
        // carry gateway_bypass so clients don't mislead users with a false warning.
        let infos = AcpAgentRegistry::new().list_infos();
        for id in &["acp:codex", "acp:pi", "ryu"] {
            let info = infos
                .iter()
                .find(|a| &a.id.as_str() == id)
                .expect("agent present");
            assert!(
                info.gateway_bypass.is_none(),
                "agent {id} should not carry gateway_bypass — it supports OPENAI_BASE_URL injection"
            );
        }
    }

    // ── ACP gateway injection opt-out (AC2 of #214) ──────────────────────────

    #[test]
    fn pi_spawn_cmd_injects_gateway_base_url_by_default() {
        // pi_acp_cmd_gated() must embed the gateway /v1 URL by default so Pi routes
        // its model calls through ryu-gateway (same constraint as Codex).
        // Note: this test is sensitive to RYU_ACP_GATEWAY_INJECT being unset/1.
        let prev = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
        std::env::remove_var("RYU_ACP_GATEWAY_INJECT");

        let cmd = pi_acp_cmd_gated();
        let gateway_base = crate::sidecar::gateway::gateway_url();
        let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));

        match prev {
            Some(v) => std::env::set_var("RYU_ACP_GATEWAY_INJECT", v),
            None => std::env::remove_var("RYU_ACP_GATEWAY_INJECT"),
        }

        assert!(
            cmd.contains(&expected_v1),
            "pi spawn cmd should contain gateway /v1 URL by default, got: {cmd}"
        );
    }

    #[test]
    fn pi_spawn_cmd_opts_out_when_inject_disabled() {
        // Setting RYU_ACP_GATEWAY_INJECT=0 must fall back to the bare Pi command
        // (no gateway URL injected) — BYO-endpoint mode (AC2 of #214).
        let prev = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
        std::env::set_var("RYU_ACP_GATEWAY_INJECT", "0");

        let cmd = pi_acp_cmd_gated();
        let gateway_base = crate::sidecar::gateway::gateway_url();
        let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));

        std::env::set_var("RYU_ACP_GATEWAY_INJECT", prev.unwrap_or_default());

        assert!(
            !cmd.contains(&gateway_v1),
            "pi spawn cmd should NOT contain the gateway URL when inject is disabled, got: {cmd}"
        );
        assert!(
            cmd.contains("pi-acp"),
            "pi spawn cmd should still contain pi-acp when inject is disabled, got: {cmd}"
        );
    }

    #[test]
    fn pi_spawn_cmd_gateway_url_is_swappable() {
        // The injection must honour RYU_GATEWAY_URL — no hardcoded endpoint.
        let prev_inject = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
        let prev_gw = std::env::var("RYU_GATEWAY_URL").ok();
        std::env::remove_var("RYU_ACP_GATEWAY_INJECT");
        std::env::set_var("RYU_GATEWAY_URL", "http://custom-gw.local:7777");

        let cmd = pi_acp_cmd_gated();

        match prev_inject {
            Some(v) => std::env::set_var("RYU_ACP_GATEWAY_INJECT", v),
            None => std::env::remove_var("RYU_ACP_GATEWAY_INJECT"),
        }
        match prev_gw {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }

        assert!(
            cmd.contains("http://custom-gw.local:7777/v1"),
            "pi spawn cmd should use RYU_GATEWAY_URL when set, got: {cmd}"
        );
    }

    #[test]
    fn should_inject_gateway_defaults_to_true() {
        let prev = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
        std::env::remove_var("RYU_ACP_GATEWAY_INJECT");
        let result = crate::sidecar::gateway::should_inject_gateway();
        match prev {
            Some(v) => std::env::set_var("RYU_ACP_GATEWAY_INJECT", v),
            None => std::env::remove_var("RYU_ACP_GATEWAY_INJECT"),
        }
        assert!(
            result,
            "should_inject_gateway() should default to true when env var is unset"
        );
    }

    #[test]
    fn should_inject_gateway_respects_opt_out() {
        for val in &["0", "false", "no"] {
            let prev = std::env::var("RYU_ACP_GATEWAY_INJECT").ok();
            std::env::set_var("RYU_ACP_GATEWAY_INJECT", val);
            let result = crate::sidecar::gateway::should_inject_gateway();
            match prev {
                Some(v) => std::env::set_var("RYU_ACP_GATEWAY_INJECT", v),
                None => std::env::remove_var("RYU_ACP_GATEWAY_INJECT"),
            }
            assert!(
                !result,
                "should_inject_gateway() should return false when RYU_ACP_GATEWAY_INJECT={val}"
            );
        }
    }

    // ── OpenClaw + Hermes as native ACP agents ───────────────────────────────

    #[test]
    fn openclaw_and_hermes_are_acp_agents() {
        // Both speak ACP natively (openclaw acp / hermes acp), so they must bind
        // as ACP — not the stale OpenAI-compat localhost ports they used before.
        let reg = AcpAgentRegistry::new();
        for id in &["openclaw", "hermes"] {
            let entry = reg.find_by_prefix(id).expect("entry present");
            assert!(
                matches!(entry.transport, AgentTransport::Acp { .. }),
                "{id} should use ACP transport"
            );
        }
        let infos = reg.list_infos();
        for id in &["openclaw", "hermes"] {
            let info = infos.iter().find(|a| &a.id == id).expect("info present");
            assert_eq!(info.transport.as_deref(), Some("acp"), "{id} transport");
        }
    }

    #[test]
    fn openclaw_and_hermes_carry_gateway_bypass() {
        // As ACP subprocesses they make their own provider calls (OpenClaw → its
        // own WS gateway, Hermes → ~/.hermes creds); neither traverses Ryu's
        // gateway, so both must surface gateway_bypass: true.
        let infos = AcpAgentRegistry::new().list_infos();
        for id in &["openclaw", "hermes"] {
            let info = infos.iter().find(|a| &a.id == id).expect("info present");
            assert_eq!(
                info.gateway_bypass,
                Some(true),
                "{id} should carry gateway_bypass: true"
            );
        }
    }

    // ── Self-fetching ACP registry agents ────────────────────────────────────

    #[test]
    fn registry_acp_agents_are_present_and_acp() {
        // A representative slice of the npx/uvx ACP-registry agents must be
        // registered as ACP entries so the catalog can offer them.
        let reg = AcpAgentRegistry::new();
        for id in &[
            "acp:cline",
            "acp:auggie",
            "acp:qwen",
            "acp:copilot",
            "acp:grok",
            "acp:fast-agent",
            "acp:minion",
        ] {
            let entry = reg
                .find_by_prefix(id)
                .unwrap_or_else(|| panic!("{id} should be registered"));
            assert!(
                matches!(entry.transport, AgentTransport::Acp { .. }),
                "{id} should use ACP transport"
            );
            assert_eq!(entry.id, *id, "find_by_prefix must return an exact match");
        }
    }

    #[test]
    fn registry_acp_spawn_cmds_invoke_their_runner() {
        // npx agents must spawn via `npx -y`; uvx agents via `uvx`. (On Windows the
        // npx command is wrapped in `cmd /c`; either way the runner token is there.)
        let reg = AcpAgentRegistry::new();
        let spawn = |id: &str| match &reg.find_by_prefix(id).unwrap().transport {
            AgentTransport::Acp { spawn_cmd } => spawn_cmd.clone(),
            AgentTransport::OpenAiCompat { .. } => unreachable!("expected ACP"),
        };
        assert!(spawn("acp:cline").contains("npx -y cline --acp"));
        assert!(spawn("acp:fast-agent").contains("uvx fast-agent-acp -x"));
        assert!(spawn("acp:minion").contains("uvx minion-code acp"));
    }

    #[test]
    fn registry_does_not_duplicate_curated_agents() {
        // The curated entries (Claude Code, Codex, Gemini, Pi) have bespoke
        // gateway handling; the self-fetching registry set must not re-add them
        // under a colliding id, and every entry id must be unique.
        let reg = AcpAgentRegistry::new();
        let mut ids: Vec<&str> = reg.entries.iter().map(|e| e.id.as_str()).collect();
        let count = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(count, ids.len(), "agent ids must be unique");
        // The registry's claude-acp/codex-acp/gemini/pi-acp packages must not have
        // been added as new ids — those live as the curated acp:claude etc.
        for dup in &["acp:claude-agent", "acp:gemini-cli", "acp:pi-acp"] {
            assert!(
                reg.find_by_prefix(dup).map(|e| e.id.as_str()) != Some(dup),
                "{dup} should not be a separate registry entry"
            );
        }
    }

    #[test]
    fn every_acp_spawn_cmd_parses_at_spawn_time() {
        // The spawn command is handed to `AcpAgent::from_str` (shell_words::split)
        // before the subprocess launches. A malformed command — e.g. an unbalanced
        // quote in the uvx/hermes invocations — would only surface at runtime, so
        // assert here that every ACP entry's command parses cleanly. This is the
        // same parse the real spawn path runs.
        for entry in &AcpAgentRegistry::new().entries {
            if let AgentTransport::Acp { spawn_cmd } = &entry.transport {
                AcpAgent::from_str(spawn_cmd).unwrap_or_else(|e| {
                    panic!("spawn cmd for '{}' must parse, got error: {e}", entry.id)
                });
            }
        }
    }
}
