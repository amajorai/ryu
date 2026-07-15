use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::{
    AuthMethodId, AuthenticateRequest, AvailableCommandInput, CancelNotification,
    ClientCapabilities, CloseSessionRequest, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, EmbeddedResourceResource, FileSystemCapabilities, ImageContent,
    InitializeRequest, InitializeResponse, KillTerminalRequest, KillTerminalResponse,
    ListSessionsRequest, ListSessionsResponse, LoadSessionRequest, LogoutRequest,
    NewSessionRequest, NewSessionResponse, PromptRequest, PromptResponse, ProtocolVersion,
    ReadTextFileRequest, ReadTextFileResponse, ReleaseTerminalRequest, ReleaseTerminalResponse,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionModeRequest, SetSessionModelRequest, TerminalId,
    TerminalOutputRequest, TerminalOutputResponse, ToolCall, ToolCallContent, ToolCallLocation,
    ToolCallStatus, ToolCallUpdate, ToolKind, WaitForTerminalExitRequest,
    WaitForTerminalExitResponse, WriteTextFileRequest, WriteTextFileResponse,
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
use crate::win_process::NoWindow;

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
    /// A chunk of a USER message the agent is (re)playing back — ACP
    /// `user_message_chunk`. Emitted chiefly when replaying a resumed session's
    /// history (`session/load`), where the agent streams the prior user turns
    /// before the assistant ones. Surfaced (not dropped) so a loaded conversation
    /// can show its user turns; on a live turn it's the user's own echoed input.
    UserText(String),
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
        /// The file locations this call touches (ACP `ToolCall.locations`):
        /// `[{ path, line? }, …]`. Surfaced so the client can show which files /
        /// lines a tool acted on (previously the field was never read).
        locations: Vec<serde_json::Value>,
    },
    /// An update on an in-flight or finished tool call (status and/or result).
    ToolResult {
        id: String,
        /// "pending" | "in_progress" | "completed" | "failed".
        status: String,
        /// Raw output and/or rendered content produced by the tool.
        output: Option<serde_json::Value>,
    },
    /// A non-text block in the assistant's message (ACP `Content`): an inline
    /// image or audio clip the agent emitted. Carries the base64 `data` + its
    /// `mime` so mod.rs can forward it as an AI-SDK `file` part (previously these
    /// blocks were silently dropped — only text was surfaced).
    Media { mime: String, data: String },
    /// The agent switched the active session mode itself (e.g. Claude Code
    /// leaving "plan" after presenting a plan). Carries the new mode id so the
    /// desktop's mode picker stays in sync. Agent-initiated, not user-driven.
    ModeChanged(String),
    /// A user-chosen session control could not be applied to the agent (e.g. it
    /// implements neither `session/set_model` nor a `model` config option).
    /// Non-fatal — the turn proceeds on the agent's defaults — but surfaced so
    /// clients can react (e.g. reset a model picker that shows a model the agent
    /// never applied) instead of silently misleading the user (QA finding B2).
    ConfigWarning {
        /// The control that failed ("model", "mode", …).
        field: String,
        /// The value the user requested.
        requested: String,
        /// The agent's error, human-readable.
        message: String,
    },
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
    /// Token / context-window usage for the turn (ACP `unstable_session_usage`).
    /// Carries whatever the agent reported as a loosely-typed object — a live
    /// `SessionUpdate::UsageUpdate` snapshot (`{ used, total }`), the final
    /// `PromptResponse.usage` totals (`{ promptTokens, completionTokens,
    /// totalTokens }`), and a `done` flag on the last frame of the turn. The
    /// desktop reconciles repeated frames (same `acp-usage` id) into one live
    /// meter; Core enriches each with wall-clock `durationMs` + `tokensPerSecond`
    /// on the mod.rs side. Emitted at least once per turn (a final `done:true`
    /// frame) even when the agent reports no usage, so the duration/speed UI works.
    Usage(serde_json::Value),
    /// A tool call resolved to a widget (`outputTemplate`): the desktop should
    /// render an inline Ryu App widget. Emitted from the MCP bridge (the single
    /// choke point for both planes, D1) in addition to the normal tool-output
    /// part for the same tool. Boxed to keep the enum small.
    ToolWidget(Box<ToolWidgetEvent>),
    /// A fatal error from the session; the stream ends after this.
    Error(String),
}

/// Fully-resolved payload for [`AcpEvent::ToolWidget`], mapped 1:1 onto the
/// `data-tool-widget-available` stream part (spec §1.1). The MCP bridge mints the
/// `instance_id`, resolves the widget HTML, and strips `ryu/widget` from the
/// forwarded `_meta`; the adapter only serializes.
#[derive(Debug, Clone)]
pub struct ToolWidgetEvent {
    /// The tool-call row this widget attaches to (best-effort correlation).
    pub tool_call_id: String,
    /// Fully-qualified tool id (`<server>__<tool>`).
    pub tool_name: String,
    /// Minted `WidgetInstanceStore` id (round-trip identity).
    pub instance_id: String,
    /// Origin MCP server (same-server provenance gate).
    pub server_id: String,
    /// `ui://widget/<slug>.html`.
    pub template_uri: String,
    /// Widget HTML (embedded live, R9).
    pub widget_html: String,
    /// Widget MIME dialect.
    pub widget_mime: String,
    /// Tool arguments (`toolInput`).
    pub tool_input: serde_json::Value,
    /// `structuredContent` (`toolOutput`).
    pub tool_output: serde_json::Value,
    /// `_meta` minus `ryu/widget` (`toolResponseMetadata`).
    pub tool_response_metadata: serde_json::Value,
    /// Whether the widget may `callTool` (gates the local capability).
    pub widget_accessible: bool,
    /// Gateway-validated grant subset.
    pub approved_grants: Vec<String>,
    /// "invoking…" label.
    pub invoking: Option<String>,
    /// "invoked" label.
    pub invoked: Option<String>,
    /// Rehydrated widget state (persistence), if any.
    pub initial_widget_state: Option<serde_json::Value>,
    /// `"inline" | "fullscreen" | "pip"`.
    pub display_mode: String,
    /// The widget's declared remote-asset hosts (`resource_domains`), parsed from
    /// the widget resource's `_meta`. Threaded to the SSE `csp.resource_domains`
    /// so the client widens `img-src`/`font-src`/`media-src` to the Core asset
    /// proxy and rewrites these hosts' URLs through it (governed egress). Empty ⇒
    /// the CSP stays fully locked (`data:` only).
    pub resource_domains: Vec<String>,
}

/// User-chosen ACP session controls applied to a single turn, all read from the
/// agent's own `session/new` advertisement (Ryu hardcodes none). The ACP session
/// is reused across a chat's turns, but these controls are re-applied every turn
/// (sticky on the client). Empty fields mean "leave the agent's default".
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

/// The ACP client capabilities Ryu advertises in `initialize`. Ryu is a full
/// client host: it serves the agent's `fs/*` (read/write text file) and
/// `terminal/*` requests (handlers live in the session dispatch chain below), so
/// ACP agents like Claude Code / Codex that mediate file edits and command
/// execution *through the client* work against Ryu instead of silently having
/// those requests dropped (the pre-2026-07 default sent `ClientCapabilities`
/// with everything `false`).
fn ryu_client_capabilities() -> ClientCapabilities {
    // These schema structs are `#[non_exhaustive]`, so build from Default and set
    // fields rather than a struct literal.
    let mut caps = ClientCapabilities::default();
    caps.fs.read_text_file = true;
    caps.fs.write_text_file = true;
    caps.terminal = true;
    caps
}

/// `initialize` request carrying Ryu's full client capabilities (fs + terminal).
fn ryu_initialize_request() -> InitializeRequest {
    let mut init = InitializeRequest::new(ProtocolVersion::V1);
    init.client_capabilities = ryu_client_capabilities();
    init
}

/// The agent's own capabilities, read from its `initialize` response
/// (`agentCapabilities`). Ryu previously ignored these entirely — sending images
/// unconditionally and never attempting `session/load`. Now they gate content
/// (only send image/audio blocks the agent advertised support for) and features
/// (`session/load` warm-resume, MCP transport selection).
#[derive(Debug, Clone, Copy, Default)]
struct AcpCaps {
    /// Agent can resume a prior session via `session/load` (`loadSession`).
    load_session: bool,
    /// `promptCapabilities.image` — agent accepts `ContentBlock::Image` prompts.
    prompt_image: bool,
    /// `promptCapabilities.audio` — agent accepts `ContentBlock::Audio` prompts.
    prompt_audio: bool,
    /// `promptCapabilities.embeddedContext` — agent accepts embedded resources.
    prompt_embedded_context: bool,
    /// `mcpCapabilities.http` — agent can connect to HTTP MCP servers.
    mcp_http: bool,
    /// `mcpCapabilities.sse` — agent can connect to SSE MCP servers.
    mcp_sse: bool,
}

/// Extract the agent's advertised capabilities from its `initialize` response.
fn read_agent_caps(init: &InitializeResponse) -> AcpCaps {
    let caps = &init.agent_capabilities;
    AcpCaps {
        load_session: caps.load_session,
        prompt_image: caps.prompt_capabilities.image,
        prompt_audio: caps.prompt_capabilities.audio,
        prompt_embedded_context: caps.prompt_capabilities.embedded_context,
        mcp_http: caps.mcp_capabilities.http,
        mcp_sse: caps.mcp_capabilities.sse,
    }
}

/// Serialize the agent's capabilities for the desktop (surfaced by the config
/// probe as `agentCapabilities`), so clients can reflect what the agent supports
/// (e.g. show a "Resume" affordance only when `loadSession` is true).
fn agent_caps_json(caps: &AcpCaps) -> serde_json::Value {
    serde_json::json!({
        "loadSession": caps.load_session,
        "promptCapabilities": {
            "image": caps.prompt_image,
            "audio": caps.prompt_audio,
            "embeddedContext": caps.prompt_embedded_context,
        },
        "mcpCapabilities": { "http": caps.mcp_http, "sse": caps.mcp_sse },
    })
}

// ── Client-hosted terminals (ACP `terminal/*`) ──────────────────────────────────
//
// ACP agents that don't run their own shell ask the *client* to spawn commands
// and stream their output back (`terminal/create|output|wait_for_exit|kill|
// release`). Ryu hosts these: each `terminal/create` spawns a real child process
// whose merged stdout+stderr is buffered (byte-capped, truncated from the front),
// and a per-terminal task owns the child so `kill` can race `wait` without a lock
// deadlock. The registry is per ACP instance (one chat), cleaned up on `release`.

/// One live client-hosted terminal.
struct TerminalEntry {
    /// Merged stdout+stderr captured so far.
    output: Arc<Mutex<String>>,
    /// Set once the output buffer hit `output_byte_limit` and was truncated.
    truncated: Arc<std::sync::atomic::AtomicBool>,
    /// The process exit status once it has exited: `(exit_code, signal)`.
    exit: Arc<tokio::sync::Mutex<Option<(Option<u32>, Option<String>)>>>,
    /// Notified when `exit` transitions to `Some` (wakes `wait_for_exit`).
    exit_notify: Arc<tokio::sync::Notify>,
    /// Send `()` to request the child be killed (drives the owner task's select).
    kill_tx: tokio::sync::mpsc::Sender<()>,
}

/// Per-ACP-instance terminal registry, keyed by the `terminal_id` string.
type TerminalRegistry = Arc<tokio::sync::Mutex<BTreeMap<String, TerminalEntry>>>;

/// Append `chunk` to a byte-capped buffer, truncating from the FRONT (oldest
/// output) on overflow to stay within `limit` at a char boundary (per the ACP
/// spec). Sets `truncated` when it trims.
fn append_capped(
    buf: &Arc<Mutex<String>>,
    truncated: &Arc<std::sync::atomic::AtomicBool>,
    chunk: &str,
    limit: Option<u64>,
) {
    let Ok(mut out) = buf.lock() else { return };
    out.push_str(chunk);
    if let Some(limit) = limit {
        let limit = limit as usize;
        if out.len() > limit {
            // Trim from the front to a char boundary.
            let mut cut = out.len() - limit;
            while cut < out.len() && !out.is_char_boundary(cut) {
                cut += 1;
            }
            *out = out.split_off(cut);
            truncated.store(true, std::sync::atomic::Ordering::Relaxed);
        }
    }
}

/// Spawn a child process for `terminal/create` and register it. Returns the new
/// terminal id, or an error if the process could not be spawned.
async fn terminal_create(
    registry: &TerminalRegistry,
    req: &CreateTerminalRequest,
    session_cwd: &std::path::Path,
) -> anyhow::Result<String> {
    use std::process::Stdio;

    let mut cmd = tokio::process::Command::new(&req.command);
    cmd.args(&req.args);
    for env in &req.env {
        cmd.env(&env.name, &env.value);
    }
    cmd.current_dir(req.cwd.clone().unwrap_or_else(|| session_cwd.to_path_buf()));
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.no_window();

    let mut child = cmd
        .spawn()
        .with_context_msg(|| format!("spawn terminal command '{}'", req.command))?;

    let output = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let exit = Arc::new(tokio::sync::Mutex::new(None));
    let exit_notify = Arc::new(tokio::sync::Notify::new());
    let (kill_tx, mut kill_rx) = tokio::sync::mpsc::channel::<()>(1);
    let limit = req.output_byte_limit;

    // Merge stdout + stderr into the one buffer as they arrive. They are distinct
    // reader types, so pump each with its own task via a small generic helper.
    async fn pump<R: tokio::io::AsyncRead + Unpin + Send + 'static>(
        mut reader: R,
        buf: Arc<Mutex<String>>,
        trunc: Arc<std::sync::atomic::AtomicBool>,
        limit: Option<u64>,
    ) {
        use tokio::io::AsyncReadExt as _;
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&chunk[..n]);
                    append_capped(&buf, &trunc, &text, limit);
                }
            }
        }
    }
    if let Some(out_pipe) = child.stdout.take() {
        tokio::spawn(pump(
            out_pipe,
            Arc::clone(&output),
            Arc::clone(&truncated),
            limit,
        ));
    }
    if let Some(err_pipe) = child.stderr.take() {
        tokio::spawn(pump(
            err_pipe,
            Arc::clone(&output),
            Arc::clone(&truncated),
            limit,
        ));
    }

    // Owner task: race the process's own exit against a kill request so `kill`
    // never deadlocks against a `wait_for_exit` holding a lock.
    let exit_owner = Arc::clone(&exit);
    let notify_owner = Arc::clone(&exit_notify);
    tokio::spawn(async move {
        let status = tokio::select! {
            s = child.wait() => s,
            _ = kill_rx.recv() => {
                let _ = child.start_kill();
                child.wait().await
            }
        };
        let (code, signal) = match status {
            Ok(st) => {
                #[cfg(unix)]
                let signal = {
                    use std::os::unix::process::ExitStatusExt as _;
                    st.signal().map(|s| s.to_string())
                };
                #[cfg(not(unix))]
                let signal = None;
                (st.code().map(|c| c as u32), signal)
            }
            Err(_) => (None, None),
        };
        if let Ok(mut slot) = exit_owner.try_lock() {
            *slot = Some((code, signal));
        } else {
            *exit_owner.lock().await = Some((code, signal));
        }
        notify_owner.notify_waiters();
    });

    // Terminal ids are unique within an instance; a monotonic counter suffices.
    let id = next_terminal_id();
    registry.lock().await.insert(
        id.clone(),
        TerminalEntry {
            output,
            truncated,
            exit,
            exit_notify,
            kill_tx,
        },
    );
    Ok(id)
}

/// Process-global monotonic terminal-id source (`term-<n>`).
fn next_terminal_id() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("term-{n}")
}

// ── Turn cancellation (ACP `session/cancel`) ────────────────────────────────────
//
// The desktop Stop button aborts the SSE, but Core's completion task deliberately
// runs the ACP turn to completion after a client *disconnect* (so the assistant
// message still persists). An *explicit* stop is different: the user wants the
// agent to actually stop. `POST /api/chat/cancel` → [`request_cancel`] sets the
// active turn's flag; the turn loop then sends an ACP `CancelNotification`
// (`session/cancel`) to the agent and ends the turn.

/// A single in-flight turn's cancellation signal, keyed by conversation id.
#[derive(Default)]
struct TurnCancel {
    flag: std::sync::atomic::AtomicBool,
    notify: tokio::sync::Notify,
}

fn cancel_registry() -> &'static Mutex<BTreeMap<String, Arc<TurnCancel>>> {
    static REG: OnceLock<Mutex<BTreeMap<String, Arc<TurnCancel>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// Register the active turn's cancel handle for a conversation (replaces any
/// stale entry from a prior turn on the same conversation).
fn set_cancel(conversation: &str, cancel: Arc<TurnCancel>) {
    if let Ok(mut reg) = cancel_registry().lock() {
        reg.insert(conversation.to_owned(), cancel);
    }
}

/// Remove a conversation's cancel handle (turn ended).
fn clear_cancel(conversation: &str) {
    if let Ok(mut reg) = cancel_registry().lock() {
        reg.remove(conversation);
    }
}

/// Request cancellation of a conversation's in-flight ACP turn. Returns `true`
/// if a live turn was signalled. Called by the chat-cancel HTTP handler.
pub fn request_cancel(conversation: &str) -> bool {
    let handle = cancel_registry()
        .lock()
        .ok()
        .and_then(|reg| reg.get(conversation).cloned());
    if let Some(cancel) = handle {
        cancel.flag.store(true, std::sync::atomic::Ordering::SeqCst);
        cancel.notify.notify_waiters();
        true
    } else {
        false
    }
}

/// Build a `TerminalExitStatus` JSON value from the stored `(code, signal)`.
fn exit_status_value(code: Option<u32>, signal: Option<String>) -> serde_json::Value {
    serde_json::json!({ "exitCode": code, "signal": signal })
}

/// Small extension so terminal spawn errors carry context without pulling the
/// whole `anyhow::Context` trait into scope for a `std::io::Result`.
trait WithContextMsg<T> {
    fn with_context_msg<F: FnOnce() -> String>(self, f: F) -> anyhow::Result<T>;
}
impl<T, E: std::fmt::Display> WithContextMsg<T> for Result<T, E> {
    fn with_context_msg<F: FnOnce() -> String>(self, f: F) -> anyhow::Result<T> {
        self.map_err(|e| anyhow::anyhow!("{}: {e}", f()))
    }
}

// ── Client-hosted file system (ACP `fs/read_text_file`, `fs/write_text_file`) ────
//
// ACP agents (Claude Code / Codex) route file reads and edits through the *client*
// rather than touching disk directly, so the client is the single mediation point.
// Ryu serves these directly against the local filesystem — ACP agents are first-
// party binaries running as the user (SECURITY.md), so this is parity, not a new
// trust boundary. Read honours ACP's 1-based `line` + `limit` window.

/// Serve `fs/read_text_file`, applying the optional 1-based `line` offset and
/// `limit`. Returns `""` on any read error (the ACP response carries only
/// `content`; a missing file degrades to empty rather than failing the turn).
fn read_text_file_scoped(req: &ReadTextFileRequest) -> String {
    let Ok(content) = std::fs::read_to_string(&req.path) else {
        return String::new();
    };
    if req.line.is_none() && req.limit.is_none() {
        return content;
    }
    let lines: Vec<&str> = content.lines().collect();
    let start = req.line.unwrap_or(1).saturating_sub(1) as usize;
    if start >= lines.len() {
        return String::new();
    }
    let end = req
        .limit
        .map(|l| (start + l as usize).min(lines.len()))
        .unwrap_or(lines.len());
    lines[start..end].join("\n")
}

/// Serve `fs/write_text_file`, creating parent directories as needed.
fn write_text_file_scoped(req: &WriteTextFileRequest) -> anyhow::Result<()> {
    if let Some(parent) = req.path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&req.path, &req.content)
        .with_context_msg(|| format!("write {}", req.path.display()))
}

/// Await a client-hosted terminal's exit, returning `(exit_code, signal)`.
/// Wakes promptly on the owner task's notify, with a 250ms poll fallback so a
/// narrowly-missed notification can never hang the agent. Returns `(None, None)`
/// if the terminal id is unknown (already released).
async fn terminal_wait_for_exit(
    registry: &TerminalRegistry,
    id: &str,
) -> (Option<u32>, Option<String>) {
    loop {
        let (exit_arc, notify) = {
            let reg = registry.lock().await;
            let Some(entry) = reg.get(id) else {
                return (None, None);
            };
            (Arc::clone(&entry.exit), Arc::clone(&entry.exit_notify))
        };
        if let Some(status) = exit_arc.lock().await.clone() {
            return status;
        }
        let _ =
            tokio::time::timeout(std::time::Duration::from_millis(250), notify.notified()).await;
    }
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

/// `request_id → (waiter, host conversation id)`.
///
/// The conversation is carried so `POST /api/chat/permission` can GATE the decision
/// on the thread the prompt belongs to. Without it, `perm-<seq>` ids are sequential
/// and trivially guessable, so any holder of the node token could approve or DENY
/// another user's pending tool-permission prompt — a human-in-the-loop integrity
/// bypass. `None` for an ephemeral (no-conversation) instance.
type PermissionWaiters = Mutex<
    std::collections::HashMap<String, (tokio::sync::oneshot::Sender<Option<String>>, Option<String>)>,
>;

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
fn register_permission(
    request_id: String,
    conversation_id: Option<String>,
) -> tokio::sync::oneshot::Receiver<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if let Ok(mut map) = pending_permissions().lock() {
        map.insert(
            request_id,
            (tx, conversation_id.filter(|s| !s.is_empty())),
        );
    }
    rx
}

/// The host conversation a pending permission request belongs to, WITHOUT consuming
/// the waiter — so `POST /api/chat/permission` can run its ACL before delivering the
/// decision.
///
/// `None` = no such pending request (already answered or timed out).
/// `Some(None)` = pending, but raised by an ephemeral instance with no conversation.
pub fn peek_permission_scope(request_id: &str) -> Option<Option<String>> {
    pending_permissions()
        .lock()
        .ok()
        .and_then(|map| map.get(request_id).map(|(_, cid)| cid.clone()))
}

/// Ask the connected desktop user to approve a synthetic tool action and wait
/// for their response. Used by Core-owned tools that run inside the ACP MCP
/// bridge; ACP-native permission requests use the same waiter map directly.
pub async fn request_user_permission(
    tx: &mpsc::UnboundedSender<AcpEvent>,
    tool_call: serde_json::Value,
    options: serde_json::Value,
    conversation_id: Option<String>,
) -> Option<String> {
    let request_id = next_permission_id();
    let rx = register_permission(request_id.clone(), conversation_id);
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
        Some((tx, _conversation_id)) => tx.send(option_id).is_ok(),
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

/// Ceiling on a single ACP config probe (`initialize` + `session/new`). Long
/// enough for a cold `npx` spawn of a large agent binary plus a first backend
/// round-trip, short enough that a wedged `session/new` (e.g. Codex against an
/// unreachable provider) fails fast and stays retryable rather than hanging the
/// desktop's picker request forever.
const ACP_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

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
    // Bound the whole probe. Some agents advertise their session config statically
    // (Claude Code, Pi, the Ryu flagship) and answer `session/new` instantly; others
    // do real backend work inside `session/new` — Codex, notably, reaches its model
    // provider there, so an unreachable/cold/unauthenticated backend makes it hang
    // indefinitely (`initialize` returns, `session/new` never does). Without a
    // ceiling the request — and the desktop's per-agent pickers that depend on it —
    // would hang forever; with it the caller gets a clear, retryable error and falls
    // back to no pickers instead of a wedged spinner. Nothing here is agent-specific.
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let cwd = cwd.clone();
                async move {
                    // Capture the agent's advertised auth methods (ACP
                    // Authentication) so the desktop can offer "Login with …" for
                    // agents that require it (e.g. a subscription/OAuth login).
                    let init: InitializeResponse = cx
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await?;
                    // Consume the agent's advertised capabilities (loadSession,
                    // promptCapabilities, mcpCapabilities) so the desktop can react
                    // (e.g. offer resume only when supported); previously ignored.
                    let caps = read_agent_caps(&init);
                    let resp: NewSessionResponse = cx
                        .send_request(NewSessionRequest::new(cwd))
                        .block_task()
                        .await?;
                    Ok(serde_json::json!({
                        "modes": resp.modes,
                        "models": resp.models,
                        "configOptions": resp.config_options,
                        "authMethods": init.auth_methods,
                        "agentCapabilities": agent_caps_json(&caps),
                    }))
                }
            }),
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "ACP probe timed out after {}s — the agent's session/new never responded (is its model backend reachable/authenticated?)",
            ACP_PROBE_TIMEOUT.as_secs()
        )
    })?
    .map_err(|e| anyhow::anyhow!("ACP probe: {e}"))?;
    if let Ok(mut m) = config_cache().lock() {
        m.insert(probe_cmd, value.clone());
    }
    Ok(value)
}

/// Authenticate to an ACP agent with one of the methods it advertised in its
/// `initialize` response (`auth_methods`, surfaced by [`probe_acp_config`] as
/// `authMethods`). This drives the ACP Authentication flow — e.g. a subscription
/// / OAuth "login" — so agents that gate `session/new` behind auth become usable.
/// The agent subprocess owns the actual login UX (opening a browser, etc.); this
/// just issues the `authenticate` request and waits for it to complete.
///
/// Invalidates the probe cache for this spawn command on success so the next
/// `acp-config` read reflects the now-authenticated state.
pub async fn authenticate_acp(spawn_cmd: String, method_id: String) -> anyhow::Result<()> {
    let agent =
        AcpAgent::from_str(&spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let cache_key = spawn_cmd.clone();
    tokio::time::timeout(
        std::time::Duration::from_secs(300),
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let method_id = method_id.clone();
                async move {
                    cx.send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    cx.send_request(AuthenticateRequest::new(AuthMethodId::new(
                        method_id.as_str(),
                    )))
                    .block_task()
                    .await?;
                    Ok(())
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP authenticate timed out after 300s"))?
    .map_err(|e| anyhow::anyhow!("ACP authenticate: {e}"))?;
    // The agent's config may now differ (auth unlocked session/new); drop the cache.
    if let Ok(mut m) = config_cache().lock() {
        m.remove(&cache_key);
    }
    Ok(())
}

/// End an ACP agent's authenticated session (ACP `logout`). The inverse of
/// [`authenticate_acp`]: agents that support the `logout` capability
/// (`agentCapabilities.auth.logout`) drop their stored credentials, so the next
/// `session/new` requires re-authentication. Best-effort with a short ceiling;
/// invalidates the probe cache so the desktop re-reads the now-unauthenticated
/// auth state. A no-op error surfaces to the caller for agents that don't
/// implement it.
pub async fn logout_acp(spawn_cmd: String) -> anyhow::Result<()> {
    let agent =
        AcpAgent::from_str(&spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let cache_key = spawn_cmd.clone();
    tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                cx.send_request(ryu_initialize_request())
                    .block_task()
                    .await?;
                cx.send_request(LogoutRequest::new()).block_task().await?;
                Ok(())
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP logout timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP logout: {e}"))?;
    // Auth state changed; drop the cached probe so the next read reflects it.
    if let Ok(mut m) = config_cache().lock() {
        m.remove(&cache_key);
    }
    Ok(())
}

/// Resume an ACP agent's own prior session (ACP `session/load`) — warm-reconnect
/// to a session the agent still retains so its context is restored without
/// replaying the transcript as a fresh prompt. Gated on the agent advertising the
/// `loadSession` capability (returned as `{ supported: false }` otherwise, not an
/// error). On success returns the resumed session's advertised state
/// (`{ modes, models, configOptions }`) so the desktop can reflect it.
///
/// `session_id` is the agent-native session id (e.g. a Claude Code / Codex
/// session id, as persisted on import); `cwd` is the workspace the session ran in.
pub async fn load_acp_session(
    spawn_cmd: String,
    session_id: String,
    cwd: PathBuf,
) -> anyhow::Result<serde_json::Value> {
    let agent =
        AcpAgent::from_str(&spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let session_id = session_id.clone();
                let cwd = cwd.clone();
                async move {
                    let init: InitializeResponse = cx
                        .send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    // Only attempt load when the agent advertises the capability;
                    // calling it on an agent that lacks it would just error.
                    if !read_agent_caps(&init).load_session {
                        return Ok(serde_json::json!({ "supported": false }));
                    }
                    let resp = cx
                        .send_request(LoadSessionRequest::new(
                            SessionId::new(session_id.as_str()),
                            cwd,
                        ))
                        .block_task()
                        .await?;
                    let resp: agent_client_protocol::schema::LoadSessionResponse = resp;
                    Ok(serde_json::json!({
                        "supported": true,
                        "sessionId": session_id,
                        "modes": resp.modes,
                        "models": resp.models,
                        "configOptions": resp.config_options,
                    }))
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session/load timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session/load: {e}"))?;
    Ok(value)
}

/// List the sessions an ACP agent is tracking (ACP `session/list`). Best-effort:
/// an agent that doesn't implement it (the flagship pi spawns fresh per
/// `session/new`) returns `{ sessions: [], unsupported: true }` rather than an
/// error. Returns `{ sessions: [...], nextCursor? }` on success.
pub async fn list_acp_sessions(spawn_cmd: String) -> anyhow::Result<serde_json::Value> {
    let agent =
        AcpAgent::from_str(&spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                cx.send_request(ryu_initialize_request())
                    .block_task()
                    .await?;
                match cx
                    .send_request(ListSessionsRequest::new())
                    .block_task()
                    .await
                {
                    Ok(resp) => {
                        let resp: ListSessionsResponse = resp;
                        Ok(serde_json::json!({
                            "sessions": resp.sessions,
                            "nextCursor": resp.next_cursor,
                        }))
                    }
                    // Method-not-found / unsupported → empty, not an error.
                    Err(_) => Ok(serde_json::json!({ "sessions": [], "unsupported": true })),
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session/list timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session/list: {e}"))?;
    Ok(value)
}

/// Delete/close an ACP agent session (ACP `session/close`). Best-effort — an
/// agent that doesn't implement it returns an error the caller can surface.
pub async fn close_acp_session(spawn_cmd: String, session_id: String) -> anyhow::Result<()> {
    let agent =
        AcpAgent::from_str(&spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let session_id = session_id.clone();
                async move {
                    cx.send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    cx.send_request(CloseSessionRequest::new(SessionId::new(
                        session_id.as_str(),
                    )))
                    .block_task()
                    .await?;
                    Ok(())
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session/close timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session/close: {e}"))?;
    Ok(())
}

/// The conventional ACP session-config-option id for model selection. Agents
/// that predate the (unstable) `session/set_model` capability — pi-acp among
/// them — expose the model as a `select` config option under this id instead.
const MODEL_CONFIG_OPTION_ID: &str = "model";

/// Apply a turn's chosen session controls (mode / config options / model) to a
/// live ACP session over its connection. Each is best-effort: a failure
/// (unsupported capability or unknown id) is logged and skipped so the turn
/// still proceeds with the agent's defaults.
///
/// The model pick has a two-step application: `session/set_model` first, then —
/// when that is rejected (pi-acp returns JSON-RPC -32601 "Method not found"; QA
/// finding B2) — the `model` session config option, which pi-acp DOES implement.
/// If both fail, a non-fatal [`AcpEvent::ConfigWarning`] is emitted on `events`
/// so the client can stop displaying a model the agent never applied.
async fn apply_turn_config(
    connection: ConnectionTo<Agent>,
    session_id: SessionId,
    turn: &AcpTurnConfig,
    events: &mpsc::UnboundedSender<AcpEvent>,
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
        let set_model_result = connection
            .send_request_to(
                Agent,
                SetSessionModelRequest::new(session_id.clone(), model.clone()),
            )
            .block_task()
            .await;
        let Err(e) = set_model_result else {
            return;
        };
        // Already sent as an explicit config option above? Then the fallback
        // would just repeat it — log and stop.
        let already_via_config = turn
            .config_options
            .iter()
            .any(|(id, _)| id == MODEL_CONFIG_OPTION_ID);
        if already_via_config {
            tracing::warn!("ACP set_model '{model}' failed: {e}");
            return;
        }
        tracing::info!(
            "ACP set_model '{model}' failed ({e}); retrying as config option '{MODEL_CONFIG_OPTION_ID}'"
        );
        match connection
            .send_request_to(
                Agent,
                SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    MODEL_CONFIG_OPTION_ID.to_owned(),
                    model.clone(),
                ),
            )
            .block_task()
            .await
        {
            Ok(_) => tracing::info!("ACP applied model '{model}' via config option"),
            Err(e2) => {
                tracing::warn!(
                    "ACP set_model '{model}' failed: {e}; config-option fallback failed: {e2}"
                );
                let _ = events.send(AcpEvent::ConfigWarning {
                    field: MODEL_CONFIG_OPTION_ID.to_owned(),
                    requested: model.clone(),
                    message: format!("agent did not accept the model selection: {e2}"),
                });
            }
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
    // Raw new user message (no history). Sent instead of `prompt` on every turn
    // after a live ACP session's first, so history is not double-counted.
    delta_prompt: String,
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
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    // Resolved concrete agent id for this turn (== the effective/bridge agent id).
    // Folded into the pool key below so the session is keyed by (conversation,
    // agent, spawn_cmd, cwd): switching agents mid-conversation — including the
    // Plane B agent-auto case (spec §2.3) — starts a FRESH session for the newly
    // chosen agent while the previous agent's instance is kept warm in the pool.
    // Keying on the agent id (not just spawn_cmd) is what separates two agent
    // records that happen to share a binary/spawn command but differ in config.
    let agent_key = agent_id.clone();
    let acp_turn = AcpTurn {
        prompt,
        delta_prompt,
        images,
        turn,
        mcp,
        allowlist,
        composio_actions,
        agent_id,
        identity_profile_ids,
        permission_scope_id: permission_scope_id.clone(),
        events: events_tx,
    };

    // One live subprocess/connection per CHAT, keyed by the conversation id (Ryu's
    // interactive-permission scope) — chats never share an instance. A message with
    // no conversation id runs an ephemeral, un-pooled instance that dies after the
    // turn. `is_closed()` detects an instance that hit its idle TTL or crashed, so
    // the chat's next message transparently respawns it (auto-restore).
    let conversation = permission_scope_id.unwrap_or_default();
    if conversation.is_empty() {
        let (turns_tx, turns_rx) = mpsc::unbounded_channel();
        let _ = turns_tx.send(acp_turn); // drop tx → instance ends after this turn
        tokio::spawn(async move {
            if let Err(e) = run_acp_instance(spawn_cmd, cwd, turns_rx).await {
                tracing::error!("ACP instance error: {e}");
            }
        });
        return events_rx;
    }

    let key = format!(
        "{conversation}\u{1}{agent_key}\u{1}{spawn_cmd}\u{1}{}",
        cwd.display()
    );
    let mut pool = acp_pool().lock().expect("acp pool mutex poisoned");
    // Drop dead instances (idle-TTL expired or crashed) so the map can't grow.
    pool.retain(|_, turns| !turns.is_closed());

    let mut pending = Some(acp_turn);
    if let Some(turns) = pool.get(&key) {
        match turns.send(pending.take().expect("turn present")) {
            Ok(()) => return events_rx,        // reused this chat's live instance
            Err(err) => pending = Some(err.0), // raced with teardown; respawn below
        }
    }

    // No live instance for this (conversation, agent) key: spawn one and enqueue
    // the turn. On a mid-conversation harness switch (Plane B agent-auto picking a
    // different agent than last turn) this is the newly-chosen agent's first turn.
    //
    // TODO(cross-harness transcript replay, spec §2.3): a freshly-spawned agent's
    // FIRST turn is already seeded with recent context — `build_acp_prompt` folds
    // the caller's `short_term` (a window of recent conversation turns) into the
    // prompt preamble, so the new harness is not blind to the conversation. What is
    // NOT yet replayed is the WHOLE conversation history (a full transcript
    // summary/prefix) into the new ACP session, and in-subprocess ephemeral state
    // (open files the previous agent was editing) is intentionally not carried over
    // — history is replayed, live subprocess state is not.
    let (turns_tx, turns_rx) = mpsc::unbounded_channel();
    let _ = turns_tx.send(pending.expect("turn present"));
    let spawn_cmd_task = spawn_cmd.clone();
    let cwd_task = cwd.clone();
    tokio::spawn(async move {
        if let Err(e) = run_acp_instance(spawn_cmd_task, cwd_task, turns_rx).await {
            tracing::error!("ACP instance error: {e}");
        }
    });
    pool.insert(key, turns_tx);
    events_rx
}

/// Per-chat pool of live ACP instances: conversation id -> that chat's turn queue.
/// See [`spawn_acp_task`] for the reuse / auto-restore / idle-TTL lifecycle.
#[allow(clippy::type_complexity)]
fn acp_pool() -> &'static Mutex<std::collections::HashMap<String, mpsc::UnboundedSender<AcpTurn>>> {
    static POOL: OnceLock<
        Mutex<std::collections::HashMap<String, mpsc::UnboundedSender<AcpTurn>>>,
    > = OnceLock::new();
    POOL.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
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
                prompt.clone(),
                // Legacy one-shot path: an ephemeral, un-pooled instance whose
                // only turn is the first, so `delta_prompt` is never consulted.
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
                        locations,
                    } => {
                        record_observed_tool(&agent_id, &title, &kind);
                        chunks.push(ChatChunk {
                            delta: None,
                            done: false,
                            metadata: Some(serde_json::json!({
                                "toolCall": { "id": id, "title": title, "kind": kind, "input": input, "locations": locations }
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
                    // Reasoning, plan snapshots, mode changes, permission prompts,
                    // command advertisements and usage stats are surfaced only on the
                    // streaming path (route_acp_stream); this legacy collect path
                    // returns final text + tool metadata and runs non-interactively.
                    AcpEvent::Text(_)
                    | AcpEvent::UserText(_)
                    | AcpEvent::Thought(_)
                    | AcpEvent::Plan(_)
                    | AcpEvent::Media { .. }
                    | AcpEvent::ModeChanged(_)
                    | AcpEvent::ConfigWarning { .. }
                    | AcpEvent::AvailableCommands(_)
                    | AcpEvent::Usage(_)
                    | AcpEvent::ToolWidget(_)
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
                latest_version: None,
                version_status: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
                avatar_url: None,
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
                latest_version: None,
                version_status: None,
                locked: None,
                enabled: None,
                gateway_bypass: None,
                avatar_url: None,
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
/// One queued turn for a pooled per-chat ACP instance. Every per-turn input
/// travels in here so one long-lived subprocess/connection can serve all of a
/// chat's turns.
struct AcpTurn {
    /// The full prompt for this turn: long-term system preamble + short-term
    /// history + the new user message. Sent verbatim ONLY on a session's FIRST
    /// turn (the live ACP session holds no history yet).
    prompt: String,
    /// The raw new user message alone (no history). Sent on every SUBSEQUENT
    /// turn — the live session already retains the transcript, so re-sending the
    /// full `prompt` would double-count history. See `run_acp_instance`.
    delta_prompt: String,
    images: Vec<ImagePart>,
    turn: AcpTurnConfig,
    mcp: Option<Arc<McpRegistry>>,
    allowlist: Option<Vec<String>>,
    composio_actions: Vec<String>,
    agent_id: String,
    identity_profile_ids: Vec<String>,
    permission_scope_id: Option<String>,
    events: mpsc::UnboundedSender<AcpEvent>,
}

/// Idle TTL for a pooled per-chat ACP instance: after this long with no new turn,
/// the subprocess is torn down; the chat's next message lazily respawns it.
const ACP_IDLE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// Run one chat's ACP instance: spawn the subprocess ONCE, `initialize` ONCE,
/// build the Ryu MCP bridge ONCE and the ACP session ONCE, then serve every queued
/// turn on that same session until the chat goes idle (`ACP_IDLE_TTL`) or the pool
/// drops the queue. Because the live session retains the conversation, the FIRST
/// turn sends the full prompt (with history) and every subsequent turn sends only
/// its delta message — re-sending the full prompt would double-count the transcript.
/// The subprocess spawn, `initialize`, user-MCP load, and session build are all
/// amortized across a chat's turns.
pub async fn run_acp_instance(
    spawn_cmd: String,
    cwd: PathBuf,
    turns_rx: mpsc::UnboundedReceiver<AcpTurn>,
) -> anyhow::Result<()> {
    // pi-acp advertises NO MCP-server support in its `initialize` response, so
    // injecting Ryu's bridge into its `session/new` is not honored — skip it for
    // pi (the flagship `ryu` engine + `acp:pi`). Every other ACP agent gets it.
    let bridge_supported = !spawn_cmd.contains("pi-acp");
    // Claude Code (via `claude-code-acp`) otherwise loads the session cwd's project
    // `.mcp.json` + local settings on every `session/new`, spawning that folder's
    // MCP servers before the first token (measured: 62s -> 8s once constrained) and
    // on the ungoverned path. Restrict the Claude Agent SDK to user-level settings
    // via claude-code-acp's `_meta.claudeCode.options` passthrough (applied at
    // `build_session_from`, per turn below).
    let is_claude_code =
        spawn_cmd.contains("claude-code-acp") || spawn_cmd.contains("claude-agent-acp");
    // The flagship managed `ryu` agent: pi-acp pointed at Ryu's ISOLATED config dir
    // (`PI_CODING_AGENT_DIR` → `~/.ryu/pi-agent`). Only this Pi reads the managed
    // `auth.json`, so it is the only agent whose subscription OAuth logins we
    // proactively refresh before a turn — never bare `acp:pi` (the user's own
    // `~/.pi`) or any other engine. Both platforms carry the `PI_CODING_AGENT_DIR`
    // substring (POSIX inline `VAR=…`, Windows `set VAR=…`), see `ryu_pi_acp_cmd`.
    let is_managed_pi = spawn_cmd.contains("pi-acp") && spawn_cmd.contains("PI_CODING_AGENT_DIR");

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
            async move {
                let mut turns_rx = turns_rx;
                // Advertise Ryu's full client capabilities (fs + terminal) so the
                // agent routes file reads/writes and command execution through the
                // handlers in the dispatch chain below. Capture the agent's OWN
                // capabilities from the response (previously discarded) so we can
                // gate prompt content (image/audio) and features (session/load) on
                // what it actually advertised.
                let init_resp: InitializeResponse =
                    cx.send_request(ryu_initialize_request()).block_task().await?;
                let agent_caps = read_agent_caps(&init_resp);

                // Peek the FIRST turn (it carries the params the bridge + session
                // are built from). If none arrives within the idle TTL, this chat
                // never sent anything — tear the instance down.
                let first_turn = match tokio::time::timeout(ACP_IDLE_TTL, turns_rx.recv()).await
                {
                    Ok(Some(t)) => t,
                    _ => return Ok(()),
                };

                // The ACP permission seam labels its command-approval scans with the
                // agent id; stable for the whole chat, so take it from the first turn.
                let scan_agent = first_turn.agent_id.clone();
                // Conversation id (Ryu's cancel/permission scope), stable for the
                // instance. Empty for an ephemeral (no-conversation) instance, which
                // the desktop can't target for cancellation anyway.
                let instance_conversation =
                    first_turn.permission_scope_id.clone().unwrap_or_default();

                // Widget synthesis inputs for the managed-Pi widget path. Pi has no
                // MCP bridge, so a widget-bearing tool it calls through the `ryu-mcp`
                // extension carries its MCP `_meta`/`structuredContent` in the tool
                // result's `details.ryuWidget`, which pi-acp preserves as ACP
                // `rawOutput`. We rebuild the widget event from that below — REUSING
                // the shared `build_widget_event`, keyed to the real tool-call id —
                // so it flows to `ui_tool_widget` exactly like the bridge path. Held
                // at instance scope (stable for the chat) so each per-message closure
                // can clone them. `None` mcp (legacy/test) → no synthesis.
                let widget_mcp = first_turn.mcp.clone();
                let widget_agent_id = first_turn.agent_id.clone();

                // Persistent per-instance permission channel + a swappable sink. The
                // Ryu MCP bridge is built ONCE (below) with `instance_tx` as its
                // `permission_tx`, but each turn streams to a DIFFERENT consumer. A
                // relay task forwards every bridge-emitted event to whatever sink is
                // currently set; at each turn's start we point the sink at that turn's
                // events sender, so interactive tool-permission prompts raised by a
                // Ryu tool reach the live turn.
                let (instance_tx, mut instance_rx) = mpsc::unbounded_channel::<AcpEvent>();
                let sink: Arc<Mutex<Option<mpsc::UnboundedSender<AcpEvent>>>> =
                    Arc::new(Mutex::new(None));
                let relay_sink = Arc::clone(&sink);
                tokio::spawn(async move {
                    while let Some(ev) = instance_rx.recv().await {
                        let target = relay_sink.lock().ok().and_then(|g| g.clone());
                        if let Some(s) = target {
                            let _ = s.send(ev);
                        }
                    }
                });

                // Build the Ryu MCP bridge ONCE for this chat, gated on the agent's
                // gateway-routing toggle: gateway-OFF runs the agent VANILLA / un-
                // governed (its own MCP only, `ryu_server = None`); gateway-ON injects
                // Ryu's universal governed bridge (Ghost/Shadow/Composio/registry tools
                // through the allowlist-gated `call_tool` path — AC3 governance). The
                // `bridge_supported` guard still skips pi-acp, which advertises no
                // MCP-server support. Loading user-level MCP happens here ONCE — the
                // whole point of building the session a single time (see below).
                let gateway_on = crate::agent_routing::is_gateway_routing(&first_turn.agent_id);
                let ryu_server = if bridge_supported && gateway_on {
                    match &first_turn.mcp {
                        Some(registry) => {
                            super::mcp_bridge::build_ryu_mcp_server(
                                Arc::clone(registry),
                                first_turn.allowlist.clone(),
                                first_turn.composio_actions.clone(),
                                first_turn.agent_id.clone(),
                                first_turn.identity_profile_ids.clone(),
                                Some(instance_tx.clone()),
                                first_turn.permission_scope_id.clone(),
                            )
                            .await
                        }
                        None => None,
                    }
                } else {
                    None
                };
                // Keep `instance_tx` alive for the whole instance so the relay task
                // survives idle gaps even when the bridge is absent (gateway-off).
                let _instance_tx_keepalive = instance_tx;

                let session_cwd = cwd.clone();
                tracing::info!(cwd = %session_cwd.display(), "ACP build_session");

                // Per-instance client-hosted terminal registry (serves the agent's
                // `terminal/*` requests) + the default cwd for spawned commands.
                let terminals: TerminalRegistry =
                    Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
                let terminal_cwd = cwd.clone();

                // Build the ACP session ONCE for the whole chat, injecting Ryu's
                // registered tools via the SDK's `with_mcp_server` mechanism. The
                // bridge registers an in-process MCP server so the agent's own MCP
                // client connects back to it, calling Ryu tools through the registry's
                // allowlist-gated `call_tool` path. Building the session (and thus
                // loading user MCP) ONCE — then reusing it across every turn — is the
                // win: the live session already holds the conversation, so subsequent
                // turns send only the delta message (no history re-send).
                //
                // `ryu_server` is `None` for pi-acp / gateway-off agents, so those
                // sessions are created without it.
                let mut new_session = NewSessionRequest::new(session_cwd);
                if is_claude_code {
                    // See `is_claude_code` above: constrain the Claude Agent SDK's
                    // settingSources to "user" so it does not enumerate the folder's
                    // project/local MCP servers on session start. This now runs ONCE
                    // per chat (not per turn) — the whole win of the session reuse.
                    let mut meta = serde_json::Map::new();
                    meta.insert(
                        "claudeCode".to_owned(),
                        serde_json::json!({ "options": { "settingSources": ["user"] } }),
                    );
                    new_session.meta = Some(meta);
                }
                let session_builder = cx.build_session_from(new_session).block_task();
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

                // Serve every turn for this chat on the ONE session. The first turn
                // is already in hand (peeked above); subsequent turns block on the
                // queue until the idle TTL or the pool dropping the queue tears the
                // instance down (the chat's next message respawns it — see
                // `spawn_acp_task`).
                let mut pending_first = Some(first_turn);
                // A session's FIRST turn sends the full `prompt` (history via
                // short_term); every SUBSEQUENT turn sends ONLY `delta_prompt` (the
                // raw new user message) because the live session already holds the
                // transcript — re-sending the full prompt would DOUBLE-COUNT it.
                let mut is_first_turn = true;
                loop {
                    let AcpTurn {
                        prompt,
                        delta_prompt,
                        images,
                        turn,
                        events: tx,
                        // `mcp`/`allowlist`/`composio_actions`/`agent_id`/
                        // `identity_profile_ids`/`permission_scope_id` are consumed
                        // once from the first turn to build the fixed bridge above;
                        // per-turn copies are ignored (the session is immutable).
                        ..
                    } = match pending_first.take() {
                        Some(t) => t,
                        None => match tokio::time::timeout(ACP_IDLE_TTL, turns_rx.recv()).await {
                            Ok(Some(t)) => t,
                            _ => break,
                        },
                    };

                    // Point the bridge's permission sink at THIS turn's stream so a
                    // Ryu-tool permission prompt reaches the live turn's consumer.
                    if let Ok(mut g) = sink.lock() {
                        *g = Some(tx.clone());
                    }

                    // Proactively refresh the managed Pi's subscription OAuth
                    // logins (Claude Pro/Max, ChatGPT) before the turn, so a
                    // long-running / long-idle chat doesn't die when an access token
                    // expired since the last turn. Scoped to the managed Pi's own
                    // isolated auth.json (never the user's CLI creds) and strictly
                    // best-effort — failures are logged inside and never block the
                    // turn. Cheap when nothing is near expiry (a plain file read).
                    if is_managed_pi {
                        crate::pi_config::refresh_pi_oauth_logins().await;
                    }

                    // Apply the user's chosen session controls before prompting.
                    // Re-applied each turn (sticky on the client); each is agent-
                    // reported via session/new, failures logged and ignored.
                    apply_turn_config(
                        session.connection(),
                        session.session_id().clone(),
                        &turn,
                        &tx,
                    )
                    .await;

                    // First turn: full prompt (carries history). Later turns: delta
                    // only — the live session retains everything before it.
                    let turn_text = if is_first_turn { prompt } else { delta_prompt };
                    is_first_turn = false;

                    // Send the turn over the connection's low-level `PromptRequest`
                    // path (both text-only and multimodal) so we can read the turn's
                    // final `PromptResponse.usage` — the SDK's `send_prompt` helper
                    // discards it. End-of-turn is signalled over a oneshot. This is
                    // byte-for-byte what `send_prompt` does internally.
                    let turn_usage: Arc<Mutex<Option<serde_json::Value>>> =
                        Arc::new(Mutex::new(None));
                    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
                    let mut blocks: Vec<ContentBlock> = vec![turn_text.into()];
                    // Only attach image blocks when the agent advertised
                    // `promptCapabilities.image`; sending them to an agent that
                    // doesn't accept them can error or be silently dropped, so gate
                    // on the negotiated capability (was previously unconditional).
                    if !images.is_empty() {
                        if agent_caps.prompt_image {
                            for img in &images {
                                blocks.push(ContentBlock::Image(ImageContent::new(
                                    img.data.clone(),
                                    img.mime_type.clone(),
                                )));
                            }
                        } else {
                            tracing::info!(
                                "ACP agent does not advertise promptCapabilities.image; \
                                 dropping {} image attachment(s) from the prompt",
                                images.len()
                            );
                        }
                    }
                    let usage_capture = Arc::clone(&turn_usage);
                    session
                        .connection()
                        .send_request_to(
                            Agent,
                            PromptRequest::new(session.session_id().clone(), blocks),
                        )
                        .on_receiving_result(move |result| async move {
                            let resp: PromptResponse = result?;
                            // Capture the turn's final token totals (ACP unstable
                            // usage). `None` when the agent reports no usage.
                            if let Some(usage) = resp.usage.as_ref() {
                                if let Ok(v) = serde_json::to_value(usage) {
                                    if let Ok(mut g) = usage_capture.lock() {
                                        *g = Some(v);
                                    }
                                }
                            }
                            // The loop may have already exited; ignore a closed rx.
                            let _ = stop_tx.send(());
                            Ok(())
                        })?;

                    // Register this turn's cancel handle so an explicit user Stop
                    // (`POST /api/chat/cancel` → `request_cancel`) can end it.
                    let cancel = Arc::new(TurnCancel::default());
                    if !instance_conversation.is_empty() {
                        set_cancel(&instance_conversation, Arc::clone(&cancel));
                    }
                    // True once we've told the agent to cancel, so end-of-turn
                    // handling can note the turn was user-interrupted.
                    let mut cancelled = false;

                loop {
                    // Explicit cancellation requested between updates: tell the agent
                    // to stop (ACP `session/cancel`) and end the turn.
                    if cancel.flag.load(std::sync::atomic::Ordering::SeqCst) {
                        let _ = session.connection().send_notification_to(
                            Agent,
                            CancelNotification::new(session.session_id().clone()),
                        );
                        cancelled = true;
                        break;
                    }
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
                        // Woken by an explicit cancel; loop back to the flag check
                        // above (which sends `session/cancel` and breaks).
                        _ = cancel.notify.notified() => continue,
                    };
                    match message {
                        SessionMessage::SessionMessage(message) => {
                            let tx_chunk = tx.clone();
                            let tx_perm = tx.clone();
                            // Per-message copies for the managed-Pi widget synthesis
                            // in the `ToolCallUpdate` arm (the closure is `move`).
                            let widget_mcp = widget_mcp.clone();
                            let widget_agent_id = widget_agent_id.clone();
                            let widget_conversation = instance_conversation.clone();
                            let interactive = turn.interactive;
                            let scan_agent = scan_agent.clone();
                            // Per-message copy of the instance's conversation id: the
                            // permission handler below is a `move` closure, so it needs
                            // its own owned copy to scope the prompt it registers.
                            let perm_conversation = instance_conversation.clone();
                            // Per-message handles for the fs/terminal request handlers.
                            let terms_read = Arc::clone(&terminals);
                            let terms_out = Arc::clone(&terminals);
                            let terms_wait = Arc::clone(&terminals);
                            let terms_kill = Arc::clone(&terminals);
                            let terms_release = Arc::clone(&terminals);
                            let term_cwd = terminal_cwd.clone();
                            MatchDispatch::new(message)
                                .if_notification(async move |notification: SessionNotification| {
                                    match notification.update {
                                        SessionUpdate::AgentMessageChunk(chunk) => {
                                            // Surface every content block, not just
                                            // text: inline images/audio become `Media`
                                            // (→ AI-SDK `file` part); resource links
                                            // and embedded text resources become text.
                                            match chunk.content {
                                                ContentBlock::Text(t) => {
                                                    let _ = tx_chunk.send(AcpEvent::Text(t.text));
                                                }
                                                ContentBlock::Image(img) => {
                                                    let _ = tx_chunk.send(AcpEvent::Media {
                                                        mime: img.mime_type,
                                                        data: img.data,
                                                    });
                                                }
                                                ContentBlock::Audio(a) => {
                                                    let _ = tx_chunk.send(AcpEvent::Media {
                                                        mime: a.mime_type,
                                                        data: a.data,
                                                    });
                                                }
                                                ContentBlock::ResourceLink(r) => {
                                                    let label = r
                                                        .title
                                                        .filter(|s| !s.is_empty())
                                                        .unwrap_or(r.name);
                                                    let _ = tx_chunk.send(AcpEvent::Text(format!(
                                                        "\n[{label}]({})\n",
                                                        r.uri
                                                    )));
                                                }
                                                ContentBlock::Resource(res) => {
                                                    // Embedded resource: surface text
                                                    // inline, and binary blobs as Media
                                                    // (→ AI-SDK `file` part) instead of
                                                    // dropping them as before.
                                                    match &res.resource {
                                                        EmbeddedResourceResource::TextResourceContents(t)
                                                            if !t.text.is_empty() =>
                                                        {
                                                            let _ = tx_chunk
                                                                .send(AcpEvent::Text(t.text.clone()));
                                                        }
                                                        EmbeddedResourceResource::BlobResourceContents(b)
                                                            if !b.blob.is_empty() =>
                                                        {
                                                            let mime = b
                                                                .mime_type
                                                                .clone()
                                                                .unwrap_or_else(|| {
                                                                    "application/octet-stream"
                                                                        .to_owned()
                                                                });
                                                            let _ = tx_chunk.send(AcpEvent::Media {
                                                                mime,
                                                                data: b.blob.clone(),
                                                            });
                                                        }
                                                        _ => {}
                                                    }
                                                }
                                                // `ContentBlock` is #[non_exhaustive].
                                                _ => {}
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
                                            // Managed-Pi widget path: a COMPLETED update
                                            // whose `rawOutput.details.ryuWidget` binding
                                            // was stamped by the `ryu-mcp` extension yields
                                            // a widget. `pi_widget_binding` gates on
                                            // COMPLETED + marker presence (so a partial
                                            // `tool_execution_update` cannot emit a premature
                                            // widget) and extracts the raw MCP result. REUSE
                                            // the shared `build_widget_event` — no second
                                            // synthesizer; it reads `_meta`/`structuredContent`
                                            // from that result and never re-dispatches.
                                            if let Some(reg) = widget_mcp.as_deref() {
                                                if let Some((tool, args, result)) = pi_widget_binding(
                                                    update.fields.status.as_ref(),
                                                    update.fields.raw_output.as_ref(),
                                                ) {
                                                    let conversation = (!widget_conversation
                                                        .is_empty())
                                                    .then(|| widget_conversation.clone());
                                                    if let Some(event) =
                                                        super::mcp_bridge::build_widget_event(
                                                            reg,
                                                            &tool,
                                                            &args,
                                                            &result,
                                                            Some(update.tool_call_id.to_string()),
                                                            conversation,
                                                            widget_agent_id.clone(),
                                                        )
                                                        .await
                                                    {
                                                        let _ = tx_chunk.send(AcpEvent::ToolWidget(
                                                            Box::new(event),
                                                        ));
                                                    }
                                                }
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
                                        SessionUpdate::UsageUpdate(u) => {
                                            // Live context-window meter (ACP unstable
                                            // usage): tokens-in-context / window size.
                                            // A non-final frame; mod.rs reconciles it
                                            // in place and adds wall-clock timing.
                                            let _ = tx_chunk.send(AcpEvent::Usage(
                                                serde_json::json!({
                                                    "used": u.used,
                                                    "total": u.size,
                                                    "done": false,
                                                }),
                                            ));
                                        }
                                        SessionUpdate::UserMessageChunk(chunk) => {
                                            // The agent replayed a user message chunk
                                            // (mainly during a session/load history
                                            // replay). Forward text so it isn't
                                            // silently dropped; mod.rs surfaces it as a
                                            // user-echo data part.
                                            if let ContentBlock::Text(t) = chunk.content {
                                                let _ = tx_chunk
                                                    .send(AcpEvent::UserText(t.text));
                                            }
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
                                            // Scope the prompt to this instance's
                                            // conversation so its decision can be
                                            // ACL-gated (see `peek_permission_scope`).
                                            let rx = register_permission(
                                                request_id.clone(),
                                                Some(perm_conversation.clone()),
                                            );
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
                                // ── fs/read_text_file ──────────────────────────
                                .if_request(async move |req: ReadTextFileRequest, responder| {
                                    let text = read_text_file_scoped(&req);
                                    responder.respond(ReadTextFileResponse::new(text))?;
                                    Ok(())
                                })
                                .await
                                // ── fs/write_text_file ─────────────────────────
                                .if_request(async move |req: WriteTextFileRequest, responder| {
                                    let _ = write_text_file_scoped(&req);
                                    responder.respond(WriteTextFileResponse::new())?;
                                    Ok(())
                                })
                                .await
                                // ── terminal/create ────────────────────────────
                                .if_request(async move |req: CreateTerminalRequest, responder| {
                                    match terminal_create(&terms_read, &req, &term_cwd).await {
                                        Ok(id) => {
                                            responder.respond(CreateTerminalResponse::new(
                                                TerminalId::new(id.as_str()),
                                            ))?;
                                        }
                                        Err(e) => {
                                            tracing::warn!("terminal/create failed: {e}");
                                            // Report a terminal id so the agent doesn't hang;
                                            // its output/exit lookups return empty/none.
                                            responder.respond(CreateTerminalResponse::new(
                                                TerminalId::new("term-error"),
                                            ))?;
                                        }
                                    }
                                    Ok(())
                                })
                                .await
                                // ── terminal/output ────────────────────────────
                                .if_request(async move |req: TerminalOutputRequest, responder| {
                                    let id = req.terminal_id.0.to_string();
                                    let (out, truncated, exit) = {
                                        let reg = terms_out.lock().await;
                                        match reg.get(&id) {
                                            Some(entry) => {
                                                let out = entry
                                                    .output
                                                    .lock()
                                                    .map(|g| g.clone())
                                                    .unwrap_or_default();
                                                let trunc = entry.truncated.load(
                                                    std::sync::atomic::Ordering::Relaxed,
                                                );
                                                let exit = entry.exit.lock().await.clone();
                                                (out, trunc, exit)
                                            }
                                            None => (String::new(), false, None),
                                        }
                                    };
                                    let mut resp = TerminalOutputResponse::new(out, truncated);
                                    if let Some((code, signal)) = exit {
                                        resp.exit_status = serde_json::from_value(
                                            exit_status_value(code, signal),
                                        )
                                        .ok();
                                    }
                                    responder.respond(resp)?;
                                    Ok(())
                                })
                                .await
                                // ── terminal/wait_for_exit ─────────────────────
                                .if_request(
                                    async move |req: WaitForTerminalExitRequest, responder| {
                                        let id = req.terminal_id.0.to_string();
                                        let status =
                                            terminal_wait_for_exit(&terms_wait, &id).await;
                                        let resp: WaitForTerminalExitResponse =
                                            serde_json::from_value(serde_json::json!({
                                                "exitCode": status.0,
                                                "signal": status.1,
                                            }))
                                            .unwrap_or_else(|_| {
                                                serde_json::from_value(serde_json::json!({
                                                    "exitCode": serde_json::Value::Null,
                                                    "signal": serde_json::Value::Null,
                                                }))
                                                .expect("exit status")
                                            });
                                        responder.respond(resp)?;
                                        Ok(())
                                    },
                                )
                                .await
                                // ── terminal/kill ──────────────────────────────
                                .if_request(async move |req: KillTerminalRequest, responder| {
                                    let id = req.terminal_id.0.to_string();
                                    if let Some(entry) = terms_kill.lock().await.get(&id) {
                                        let _ = entry.kill_tx.send(()).await;
                                    }
                                    responder.respond(KillTerminalResponse::new())?;
                                    Ok(())
                                })
                                .await
                                // ── terminal/release ───────────────────────────
                                .if_request(async move |req: ReleaseTerminalRequest, responder| {
                                    let id = req.terminal_id.0.to_string();
                                    if let Some(entry) = terms_release.lock().await.remove(&id) {
                                        // Best-effort kill on release so no child leaks.
                                        let _ = entry.kill_tx.send(()).await;
                                    }
                                    responder.respond(ReleaseTerminalResponse::new())?;
                                    Ok(())
                                })
                                .await
                                .otherwise_ignore()?;
                        }
                        SessionMessage::StopReason(_) => break,
                        _ => {}
                    }
                }

                    // Turn over: drop this turn's cancel handle so a later
                    // `request_cancel` for the same conversation can't hit a stale
                    // turn. `cancelled` is set when the user explicitly interrupted.
                    if !instance_conversation.is_empty() {
                        clear_cancel(&instance_conversation);
                    }
                    let _ = cancelled;

                    // Final usage frame for the turn (`done: true`). Carries the
                    // turn's token totals when the agent reported them
                    // (`PromptResponse.usage`, camelCase: input/output/total); the
                    // frame is emitted even when it did not, so the desktop's
                    // duration/speed UI (computed from mod.rs's own timer) still
                    // works. Note: claude-code-acp does not currently emit ACP
                    // usage, so in practice this frame carries only `done: true`
                    // and Core-side timing.
                    let mut usage_payload = serde_json::Map::new();
                    usage_payload.insert("done".to_owned(), serde_json::Value::Bool(true));
                    if let Some(u) = turn_usage.lock().ok().and_then(|g| g.clone()) {
                        if let Some(v) = u.get("inputTokens").and_then(serde_json::Value::as_u64)
                        {
                            usage_payload.insert("promptTokens".to_owned(), v.into());
                        }
                        if let Some(v) =
                            u.get("outputTokens").and_then(serde_json::Value::as_u64)
                        {
                            usage_payload.insert("completionTokens".to_owned(), v.into());
                        }
                        if let Some(v) = u.get("totalTokens").and_then(serde_json::Value::as_u64)
                        {
                            usage_payload.insert("totalTokens".to_owned(), v.into());
                            usage_payload.insert("used".to_owned(), v.into());
                        } else if let (Some(p), Some(c)) = (
                            u.get("inputTokens").and_then(serde_json::Value::as_u64),
                            u.get("outputTokens").and_then(serde_json::Value::as_u64),
                        ) {
                            usage_payload.insert("used".to_owned(), (p + c).into());
                        }
                    }
                    let _ = tx.send(AcpEvent::Usage(serde_json::Value::Object(usage_payload)));

                    // Turn done: clear the permission sink (drop the held clone) and
                    // let `tx` drop, closing the caller's event stream; loop back for
                    // this chat's next turn on the same reused session.
                    if let Ok(mut g) = sink.lock() {
                        *g = None;
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

/// Extract a scannable representation of a FILE-MUTATING tool call
/// (Write/Edit/MultiEdit/NotebookEdit and the like) so path-based gateway deny
/// rules apply to native file tools that carry no shell command. Native coding
/// agents (Claude Code, Codex, …) edit files through dedicated tools whose input
/// is `{ file_path, content }` / `{ file_path, new_string }` — there is no
/// `command` field, so [`extract_exec_command`] misses them and the write slips
/// the gate. We synthesize a `"write <path>"` string so a policy that denies
/// writes under, e.g., `.ssh` / `.env` / `/etc` still fires. Read-only tools
/// (Read/Grep with a path but no content/edit payload) are deliberately NOT swept
/// in. Returns `None` when nothing write-like is present.
fn extract_file_write(tool_call: &serde_json::Value) -> Option<String> {
    fn path_in(obj: &serde_json::Value) -> Option<String> {
        for key in [
            "file_path",
            "filePath",
            "path",
            "abs_path",
            "absPath",
            "notebook_path",
            "notebookPath",
        ] {
            if let Some(s) = obj.get(key).and_then(serde_json::Value::as_str) {
                if !s.trim().is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
        None
    }
    // A write is a path PLUS a mutating payload; without the payload it may be a
    // read (Read/Grep take a path too), which must not be treated as a write.
    fn is_write(obj: &serde_json::Value) -> bool {
        ["content", "new_string", "newString", "edits", "new_source", "newSource"]
            .iter()
            .any(|k| obj.get(k).is_some())
    }
    fn write_path(obj: &serde_json::Value) -> Option<String> {
        if is_write(obj) {
            path_in(obj)
        } else {
            None
        }
    }

    if let Some(p) = write_path(tool_call) {
        return Some(format!("write {p}"));
    }
    for key in ["rawInput", "raw_input", "input"] {
        if let Some(p) = tool_call.get(key).and_then(write_path) {
            return Some(format!("write {p}"));
        }
    }
    None
}

/// Run an ACP tool call through the gateway command-approval scanner. Scans the
/// shell command for exec tools, else a synthesized `"write <path>"` for
/// file-mutating tools, so native file tools are governed too (not just shell
/// exec). `Allow` when nothing scannable is recoverable; `check_exec_scan` itself
/// short-circuits to `Allow` when `RYU_EXEC_APPROVAL_MODE` is unset or `off`.
async fn acp_exec_scan_verdict(tool_call: &serde_json::Value, agent: &str) -> ExecScanOutcome {
    match extract_exec_command(tool_call).or_else(|| extract_file_write(tool_call)) {
        Some(scannable) => check_exec_scan("acp", &scannable, None, Some(agent)).await,
        None => ExecScanOutcome::Allow,
    }
}

/// Serialize ACP `ToolCallLocation`s to `[{ path, line? }, …]` for the client.
fn locations_json(locations: &[ToolCallLocation]) -> Vec<serde_json::Value> {
    locations
        .iter()
        .map(|loc| {
            let mut obj = serde_json::json!({ "path": loc.path.display().to_string() });
            if let Some(line) = loc.line {
                obj["line"] = serde_json::json!(line);
            }
            obj
        })
        .collect()
}

/// Build a `ToolCall` event from an ACP `ToolCall` notification.
fn tool_call_event(call: &ToolCall) -> AcpEvent {
    AcpEvent::ToolCall {
        id: call.tool_call_id.to_string(),
        title: call.title.clone(),
        kind: tool_kind_str(&call.kind),
        input: call.raw_input.clone(),
        locations: locations_json(&call.locations),
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

/// Extract a managed-Pi widget binding from a `ToolCallUpdate`'s raw output.
///
/// The `ryu-mcp` Pi extension stamps `details.ryuWidget = { tool, arguments,
/// output }` on its tool result; pi-acp preserves that verbatim as the ACP
/// `rawOutput`. This returns `(tool_id, arguments, mcp_result)` — the exact inputs
/// the shared [`super::mcp_bridge::build_widget_event`] needs — or `None` when the
/// update is not a completed Pi widget result.
///
/// Gating on [`ToolCallStatus::Completed`] is load-bearing: pi-acp also emits an
/// in-progress `tool_call_update` (`tool_execution_update`) carrying a partial
/// `rawOutput`, and a widget must render only from the final result.
fn pi_widget_binding(
    status: Option<&ToolCallStatus>,
    raw_output: Option<&serde_json::Value>,
) -> Option<(String, serde_json::Value, serde_json::Value)> {
    if !matches!(status, Some(ToolCallStatus::Completed)) {
        return None;
    }
    let binding = raw_output?.get("details")?.get("ryuWidget")?;
    let tool = binding.get("tool").and_then(serde_json::Value::as_str)?;
    let result = binding.get("output")?.clone();
    let args = binding
        .get("arguments")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    Some((tool.to_owned(), args, result))
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
    /// Official ACP registry id (e.g. `claude-acp`), when this agent comes from the CDN catalog.
    pub registry_id: Option<String>,
    pub name: String,
    pub description: String,
    /// Binary name to probe in PATH; `None` for always-available agents.
    pub detect_binary: Option<&'static str>,
    /// User-facing install instructions shown when binary not found.
    pub install_hint: String,
    pub transport: AgentTransport,
    /// True for the single recommended/flagship agent (currently "ryu").
    pub recommended: bool,
    pub gateway_bypass: bool,
    /// GitHub-release archive spec (legacy goose path via `archive_agent`).
    pub archive_spec: Option<crate::sidecar::agents::archive_agent::ArchiveAgentSpec>,
    /// Registry `binary` distribution — full archive extracted under `~/.ryu/agents/<id>`.
    pub direct_archive: Option<crate::sidecar::agents::acp_registry::DirectArchiveDist>,
    /// Latest bridge version from the official ACP registry CDN.
    pub bridge_version: Option<String>,
    /// Brand icon URL (ACP registry CDN or curated local default).
    pub icon_url: Option<String>,
    pub version_probe: Option<AgentVersionProbe>,
}

#[derive(Debug, Clone)]
pub struct AgentVersionProbe {
    /// Underlying agent CLI binary (`claude`, `codex`, …).
    pub binary: Option<&'static str>,
    /// npm package for the underlying agent CLI.
    pub npm_package: Option<String>,
    /// npm package for the ACP bridge/wrapper (unpinned name).
    pub bridge_npm_package: Option<String>,
}

pub fn parse_cli_version(output: &str) -> Option<String> {
    static VERSION_RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = VERSION_RE.get_or_init(|| {
        regex::Regex::new(r"\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b")
            .expect("valid CLI version regex")
    });
    re.captures(output)
        .and_then(|captures| captures.get(1))
        .map(|m| m.as_str().to_owned())
}

pub async fn probe_cli_version(binary: &str) -> Option<String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args(["/c", binary, "--version"]).no_window();
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = tokio::process::Command::new(binary);
        cmd.arg("--version").no_window();
        cmd
    };

    let output = tokio::time::timeout(
        Duration::from_secs(4),
        cmd.stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok)?;

    let mut combined = String::new();
    combined.push_str(&String::from_utf8_lossy(&output.stdout));
    combined.push('\n');
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    parse_cli_version(&combined)
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

/// The npm package that IS the managed Pi engine (the flagship `ryu` agent's
/// runtime). Update checks compare the installed copy under [`managed_pi_dir`]
/// against this package's `latest` on the npm registry.
pub const PI_ENGINE_NPM: &str = "@earendil-works/pi-coding-agent";

/// Read the installed version of the managed Pi engine from its `package.json`
/// under [`managed_pi_dir`]. `None` when it isn't installed yet.
pub fn read_managed_pi_version() -> Option<String> {
    let pkg_json = managed_pi_dir()
        .join("node_modules")
        .join("@earendil-works")
        .join("pi-coding-agent")
        .join("package.json");
    let raw = std::fs::read_to_string(pkg_json).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value
        .get("version")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
}

/// Update the managed Pi engine to the latest published version by re-running the
/// package install with an explicit `@latest` tag (mirrors
/// `onboarding::ensure_ryu_managed_pi`, but forces an upgrade instead of the
/// existence-only skip). Best-effort; returns an error if the package manager
/// exits non-zero.
pub async fn update_managed_pi() -> anyhow::Result<()> {
    let pi_dir = managed_pi_dir();
    std::fs::create_dir_all(&pi_dir).ok();
    let spec = format!("{PI_ENGINE_NPM}@latest");

    #[cfg(target_os = "windows")]
    let (prog, args): (&str, Vec<&str>) = ("cmd", vec!["/c", "bun", "add", spec.as_str()]);
    #[cfg(not(target_os = "windows"))]
    let (prog, args): (&str, Vec<&str>) = ("bun", vec!["add", spec.as_str()]);

    let status = tokio::process::Command::new(prog)
        .args(&args)
        .current_dir(&pi_dir)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .no_window()
        .status()
        .await
        .map_err(|e| anyhow::anyhow!("spawn bun add: {e}"))?;
    if !status.success() {
        anyhow::bail!("bun add {spec} exited with {status}");
    }

    // Re-assert the Windows `.cmd` shim (see `managed_pi_binary`).
    #[cfg(target_os = "windows")]
    {
        let bin_dir = pi_dir.join("node_modules").join(".bin");
        if bin_dir.join("pi.exe").exists() {
            let _ = std::fs::write(bin_dir.join("pi.cmd"), "@\"%~dp0pi.exe\" %*\r\n");
        }
    }
    Ok(())
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
    // Enforce the managed-Pi config invariants before spawn: Pi-side skill
    // auto-injection off (Core injects the governed skill block itself; QA B1),
    // a valid zero-key defaultModel in Gateway mode (Pi with no model parrots
    // its skill manifest instead of answering; QA B1), and the models.json pin
    // that routes Pi's `openai` provider through the Gateway (Pi ignores
    // `OPENAI_BASE_URL`, so the env injection below is not enough on its own).
    // Best-effort — a write failure is logged, and Pi still launches (it just
    // won't route / keeps its previous defaults).
    if let Err(e) = crate::pi_config::ensure_managed_defaults() {
        tracing::warn!(error = %e, "ryu_pi_acp_cmd: could not write managed Pi defaults");
    }
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    // Fail closed on a remote data plane (WS1): a hosted multi-tenant gateway must
    // reject the shared "ryu-local" literal, so refuse to route Pi rather than
    // present it. Only needed when gateway routing is on — otherwise the token is
    // unused (Pi talks straight to its own provider) and no bearer is resolved.
    let token = if gateway {
        match crate::sidecar::gateway::gateway_bearer() {
            Ok(t) => t,
            Err(e) => {
                tracing::error!(error = %e, "ryu_pi_acp_cmd: no gateway bearer, refusing to route Pi through the gateway");
                return None;
            }
        }
    } else {
        String::new()
    };

    // Ryu-MCP extension wiring (widget path for the DEFAULT agent). The managed Pi
    // has NO in-process MCP bridge (pi-acp advertises no MCP-server support), so it
    // reaches Core's tools — including widget-bearing ones — via the `ryu-mcp`
    // extension (shipped by `pi_config::ensure_pi_mcp_extension`), which POSTs to
    // Core's HTTP tool API. These env vars tell that extension where Core is, which
    // agent id to attribute the call to (for the per-agent allowlist + widget
    // identity), and — on an exposed node — the bearer to present. `RYU_TOKEN` is
    // omitted on loopback dev (Core then requires no token). Mirrors how the gateway
    // sidecar learns `CORE_URL`/`CORE_TOKEN`.
    let core_url = crate::sidecar::gateway::core_self_url();
    let mcp_agent_id = crate::registry::DEFAULT_AGENT_ID;
    let core_token = std::env::var("RYU_TOKEN")
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|s| !s.is_empty());

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
        let mut mcp_env = format!(
            "set RYU_MCP_CORE_URL={core_url}&& set RYU_MCP_AGENT_ID={mcp_agent_id}&& "
        );
        if let Some(t) = &core_token {
            mcp_env.push_str(&format!("set RYU_MCP_CORE_TOKEN={t}&& "));
        }
        Some(format!(
            "cmd /c {gateway_env}{mcp_env}set PI_CODING_AGENT_DIR={config_dir}&& set PI_ACP_PI_COMMAND={pi_path}&& npx -y pi-acp"
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let gateway_env = if gateway {
            format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} ")
        } else {
            String::new()
        };
        let mut mcp_env =
            format!("RYU_MCP_CORE_URL={core_url} RYU_MCP_AGENT_ID={mcp_agent_id} ");
        if let Some(t) = &core_token {
            mcp_env.push_str(&format!("RYU_MCP_CORE_TOKEN={t} "));
        }
        Some(format!(
            "{gateway_env}{mcp_env}PI_CODING_AGENT_DIR={config_dir} PI_ACP_PI_COMMAND={pi_path} npx -y pi-acp"
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
    // On a remote data plane (WS1) the shared "ryu-local" literal is rejected by
    // the hosted multi-tenant gateway; log + degrade here (this is the rarely-used
    // Codex API-key path, and the call site is a registry-entry builder that cannot
    // propagate a Result) — the fleet's 401 is the fail-closed backstop.
    let token = crate::sidecar::gateway::gateway_bearer().unwrap_or_else(|e| {
        tracing::error!(error = %e, "codex_acp_cmd: no gateway bearer on remote data plane; hosted gateway will reject");
        "ryu-local".to_owned()
    });
    // Windows: inject env vars via `cmd /c set VAR=val&& ...` so the AcpAgent
    // subprocess inherits them. This mirrors pi_acp_cmd()'s approach.
    format!(
        "cmd /c set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& npx -y @agentclientprotocol/codex-acp@latest"
    )
}

#[cfg(not(target_os = "windows"))]
fn codex_acp_cmd() -> String {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    // On a remote data plane (WS1) the shared "ryu-local" literal is rejected by
    // the hosted multi-tenant gateway; log + degrade here (this is the rarely-used
    // Codex API-key path, and the call site is a registry-entry builder that cannot
    // propagate a Result) — the fleet's 401 is the fail-closed backstop.
    let token = crate::sidecar::gateway::gateway_bearer().unwrap_or_else(|e| {
        tracing::error!(error = %e, "codex_acp_cmd: no gateway bearer on remote data plane; hosted gateway will reject");
        "ryu-local".to_owned()
    });
    // POSIX: prefix the command with inline env var assignments.
    format!("OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} npx -y @agentclientprotocol/codex-acp@latest")
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
pub fn openai_gateway_cmd(spawn_cmd: &str) -> anyhow::Result<String> {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let gateway_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));
    // Fail closed on a remote data plane (WS1): refuse to point a BYO/registry ACP
    // agent at a hosted multi-tenant gateway with the shared "ryu-local" bearer.
    // On the normal local path this still yields the local gateway's dev bearer.
    let token = crate::sidecar::gateway::gateway_bearer()?;
    #[cfg(target_os = "windows")]
    {
        Ok(format!(
            "cmd /c set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& {}",
            spawn_cmd.trim_start_matches("cmd /c ")
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(format!(
            "OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} {spawn_cmd}"
        ))
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
fn registry_meta(registry_id: &str) -> Option<crate::sidecar::agents::acp_registry::RegistryAgent> {
    crate::sidecar::agents::acp_registry::find_registry_agent(registry_id)
}

fn registry_name(registry_id: &str, fallback: &str) -> String {
    registry_meta(registry_id)
        .map(|a| a.name)
        .unwrap_or_else(|| fallback.to_owned())
}

fn registry_description(registry_id: &str, fallback: &str) -> String {
    registry_meta(registry_id)
        .map(|a| a.description)
        .unwrap_or_else(|| fallback.to_owned())
}

fn registry_bridge_version(registry_id: &str) -> Option<String> {
    registry_meta(registry_id).map(|a| a.version)
}

fn registry_icon_url(registry_id: &str) -> Option<String> {
    registry_meta(registry_id).map(|a| crate::sidecar::agents::acp_registry::icon_url_for_agent(&a))
}

fn version_probe_for_registry(registry_id: &str) -> Option<AgentVersionProbe> {
    let bridge = registry_meta(registry_id).and_then(|a| {
        crate::sidecar::agents::acp_registry::spawn_plan_for(&a).and_then(|p| p.bridge_npm_package)
    });
    let (binary, npm) = crate::sidecar::agents::acp_registry::underlying_cli_probe(registry_id)
        .map(|(b, n)| (Some(b), Some(n.to_owned())))
        .unwrap_or((None, None));
    if binary.is_none() && npm.is_none() && bridge.is_none() {
        return None;
    }
    Some(AgentVersionProbe {
        binary,
        npm_package: npm,
        bridge_npm_package: bridge,
    })
}

/// Convert a registry row into a catalog entry. Every registry agent is listed
/// so the catalog mirrors the upstream ACP registry — including agents Core
/// cannot auto-run on this platform (e.g. a binary-only distribution with no
/// build for the host OS/arch). Those get an empty ACP spawn command plus a hint
/// telling the user to add a custom `acp-exec:` command; the catalog derives an
/// `available` flag from the empty spawn command so the UI disables one-click
/// install without hiding the agent.
fn entry_from_registry(
    agent: &crate::sidecar::agents::acp_registry::RegistryAgent,
) -> AcpAgentEntry {
    use crate::sidecar::agents::acp_registry::{self, registry_gateway_bypass};
    let plan = acp_registry::spawn_plan_for(agent);
    let id = acp_registry::canonical_agent_id(&agent.id);
    let install_hint = match &plan {
        Some(p) if p.direct_archive.is_some() => {
            "Downloads the agent from the official ACP registry on install".to_owned()
        }
        Some(_) if agent.distribution.uvx.is_some() => {
            "Self-fetches via uvx on first run (install `uv` from https://docs.astral.sh/uv/)"
                .to_owned()
        }
        Some(_) => "Self-fetches via npx on first run".to_owned(),
        None => format!(
            "No prebuilt package for this platform. Add a custom ACP command \
             (acp-exec:) in the agent's settings to run {}.",
            agent.name
        ),
    };
    let (spawn_cmd, direct_archive) = match plan {
        Some(p) => (p.spawn_cmd, p.direct_archive),
        None => (String::new(), None),
    };
    AcpAgentEntry {
        id,
        registry_id: Some(agent.id.clone()),
        name: agent.name.clone(),
        description: agent.description.clone(),
        detect_binary: acp_registry::underlying_cli_probe(&agent.id).map(|(b, _)| b),
        install_hint,
        transport: AgentTransport::Acp { spawn_cmd },
        recommended: false,
        gateway_bypass: registry_gateway_bypass(&agent.id),
        archive_spec: None,
        direct_archive,
        bridge_version: Some(agent.version.clone()),
        icon_url: Some(crate::sidecar::agents::acp_registry::icon_url_for_agent(
            agent,
        )),
        version_probe: version_probe_for_registry(&agent.id),
    }
}

/// All installable agents from the official ACP registry CDN, minus the
/// first-class curated entries (Claude, Codex, Gemini, Pi) which have bespoke
/// gateway routing.
fn registry_driven_entries() -> Vec<AcpAgentEntry> {
    use crate::sidecar::agents::acp_registry::{load_registry_agents, CURATED_OVERRIDE_IDS};
    let skip: std::collections::HashSet<&str> = CURATED_OVERRIDE_IDS.iter().copied().collect();
    load_registry_agents()
        .iter()
        .filter(|a| !skip.contains(a.id.as_str()))
        .map(entry_from_registry)
        .collect()
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
                    registry_id: None,
                    name: "Ryu".into(),
                    description: "The default Ryu agent — Core-managed Pi engine with the Gateway on top. Installed separately from your own Pi.".into(),
                    detect_binary: None,
                    install_hint: "Ryu installs its own Pi engine automatically on first run".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: pi_acp_cmd(),
                    },
                    recommended: true,
                    gateway_bypass: false,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: registry_bridge_version("pi-acp"),
                    icon_url: None,
                    version_probe: None,
                },
                AcpAgentEntry {
                    id: "acp:claude".into(),
                    registry_id: Some("claude-acp".into()),
                    name: registry_name("claude-acp", "Claude Agent"),
                    description: registry_description(
                        "claude-acp",
                        "ACP wrapper for Anthropic's Claude",
                    ),
                    detect_binary: Some("claude"),
                    install_hint: "npm install -g @anthropic-ai/claude-code".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: registry_meta("claude-acp")
                            .and_then(|a| {
                                crate::sidecar::agents::acp_registry::spawn_plan_for(&a)
                                    .map(|p| p.spawn_cmd)
                            })
                            .unwrap_or_else(|| {
                                npx_cmd("npx -y @agentclientprotocol/claude-agent-acp@latest")
                            }),
                    },
                    recommended: false,
                    gateway_bypass: true,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: registry_bridge_version("claude-acp"),
                    icon_url: registry_icon_url("claude-acp"),
                    version_probe: version_probe_for_registry("claude-acp"),
                },
                AcpAgentEntry {
                    id: "acp:codex".into(),
                    registry_id: Some("codex-acp".into()),
                    name: registry_name("codex-acp", "Codex"),
                    description: registry_description("codex-acp", "OpenAI Codex agent (ACP)"),
                    detect_binary: Some("codex"),
                    install_hint: "Set OPENAI_API_KEY (or sign in to Codex); the codex-acp adapter is fetched via npx".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: codex_acp_cmd(),
                    },
                    recommended: false,
                    gateway_bypass: false,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: registry_bridge_version("codex-acp"),
                    icon_url: registry_icon_url("codex-acp"),
                    version_probe: version_probe_for_registry("codex-acp"),
                },
                AcpAgentEntry {
                    id: "acp:gemini".into(),
                    registry_id: Some("gemini".into()),
                    name: registry_name("gemini", "Gemini CLI"),
                    description: registry_description("gemini", "Google Gemini CLI (ACP)"),
                    detect_binary: Some("gemini"),
                    install_hint: "npm install -g @google/gemini-cli".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: registry_meta("gemini")
                            .and_then(|a| {
                                crate::sidecar::agents::acp_registry::spawn_plan_for(&a)
                                    .map(|p| p.spawn_cmd)
                            })
                            .unwrap_or_else(|| {
                                npx_cmd("npx -y -- @google/gemini-cli@latest --experimental-acp")
                            }),
                    },
                    recommended: false,
                    gateway_bypass: true,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: registry_bridge_version("gemini"),
                    icon_url: registry_icon_url("gemini"),
                    version_probe: version_probe_for_registry("gemini"),
                },
                AcpAgentEntry {
                    id: "acp:pi".into(),
                    registry_id: Some("pi-acp".into()),
                    name: registry_name("pi-acp", "pi ACP"),
                    description: registry_description(
                        "pi-acp",
                        "Pi — your own installed Pi agent, runs with your config and API key",
                    ),
                    detect_binary: Some("pi"),
                    install_hint: "npm install -g pi-acp".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: pi_acp_cmd(),
                    },
                    recommended: false,
                    gateway_bypass: false,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: registry_bridge_version("pi-acp"),
                    icon_url: registry_icon_url("pi-acp"),
                    version_probe: version_probe_for_registry("pi-acp"),
                },
                AcpAgentEntry {
                    id: "openclaw".into(),
                    registry_id: None,
                    name: "OpenClaw".into(),
                    description: "OpenClaw — self-hosted AI assistant, run over its native ACP bridge".into(),
                    detect_binary: Some("openclaw"),
                    install_hint: "Requires a reachable OpenClaw Gateway (run `openclaw gateway` locally, or point your OpenClaw config at a remote one); `openclaw acp` then bridges to it".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: openclaw_acp_cmd(),
                    },
                    recommended: false,
                    gateway_bypass: true,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: None,
                    icon_url: None,
                    version_probe: None,
                },
                AcpAgentEntry {
                    id: "zeroclaw".into(),
                    registry_id: None,
                    name: "ZeroClaw".into(),
                    description: "Fast native autonomous agent by Ryu".into(),
                    detect_binary: None,
                    install_hint: String::new(),
                    transport: AgentTransport::OpenAiCompat {
                        base_url: "http://127.0.0.1:42617",
                        model: None,
                    },
                    recommended: false,
                    gateway_bypass: false,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: None,
                    icon_url: None,
                    version_probe: None,
                },
                AcpAgentEntry {
                    id: "hermes".into(),
                    registry_id: None,
                    name: "Hermes Agent".into(),
                    description: "NousResearch Hermes — open-source agent with native tool use (ACP)".into(),
                    detect_binary: Some("hermes"),
                    install_hint: "Install Hermes Agent (`pip install 'hermes-agent[acp]'` or the install script) and set a provider with `hermes model`; ACP runs via `hermes acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: hermes_acp_cmd(),
                    },
                    recommended: false,
                    gateway_bypass: true,
                    archive_spec: None,
                    direct_archive: None,
                    bridge_version: None,
                    icon_url: None,
                    version_probe: None,
                },
            ];
            entries.extend(registry_driven_entries());
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
            // Default points at the local llamacpp chat engine, whose port is
            // profile-aware (release 8080, dev 9080, …).
            .unwrap_or_else(|| format!("http://127.0.0.1:{}", crate::profile::port(8080)));
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
                    description: Some(e.description.clone()),
                    install_hint: if e.install_hint.is_empty() {
                        None
                    } else {
                        Some(e.install_hint.clone())
                    },
                    recommended: e.recommended.then_some(true),
                    installed,
                    model,
                    system_prompt: None,
                    created_at: None,
                    engine,
                    transport: Some(transport.to_owned()),
                    version: None,
                    latest_version: None,
                    version_status: None,
                    locked: None,
                    enabled,
                    gateway_bypass,
                    avatar_url: None,
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

    // ── Managed-Pi widget synthesis (Round A) ──────────────────────────────
    //
    // The `ryu-mcp` Pi extension stamps `details.ryuWidget = { tool, arguments,
    // output }` on its tool result; pi-acp preserves it as ACP `rawOutput`. These
    // cover the NEW extraction/gating (`pi_widget_binding`) and the end-to-end
    // synthesis into a `ToolWidgetEvent` via the SHARED `build_widget_event`, using
    // a real in-process app (`checklist__render`) so the binding + HTML resolve.
    use crate::sidecar::mcp::McpRegistry;

    fn ryu_widget_raw_output(tool: &str, structured: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "content": [{ "type": "text", "text": "done" }],
            "details": {
                "ryuWidget": {
                    "tool": tool,
                    "arguments": { "title": "Groceries" },
                    "output": { "structuredContent": structured, "content": [] },
                }
            }
        })
    }

    #[test]
    fn pi_widget_binding_extracts_only_on_completed_with_marker() {
        let raw = ryu_widget_raw_output("checklist__render", serde_json::json!({ "items": [] }));

        // Completed + marker → extracted (tool, args, mcp result).
        let got = pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw));
        let (tool, args, result) = got.expect("completed + marker extracts a binding");
        assert_eq!(tool, "checklist__render");
        assert_eq!(args["title"], serde_json::json!("Groceries"));
        assert_eq!(result["structuredContent"]["items"], serde_json::json!([]));

        // In-progress (a partial `tool_execution_update`) must NOT extract — else a
        // premature widget would render before the tool finished.
        assert!(pi_widget_binding(Some(&ToolCallStatus::InProgress), Some(&raw)).is_none());
        // Missing status → none.
        assert!(pi_widget_binding(None, Some(&raw)).is_none());
    }

    #[test]
    fn pi_widget_binding_none_without_marker_or_fields() {
        // Completed but no `details.ryuWidget` (an ordinary Pi tool result).
        let plain = serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] });
        assert!(pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&plain)).is_none());
        // Marker present but missing the required `tool` / `output` fields → none.
        let partial = serde_json::json!({ "details": { "ryuWidget": { "arguments": {} } } });
        assert!(pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&partial)).is_none());
        // No raw_output at all → none.
        assert!(pi_widget_binding(Some(&ToolCallStatus::Completed), None).is_none());
    }

    #[tokio::test]
    async fn pi_widget_synthesis_builds_tool_widget_event() {
        // End-to-end (minus the live Pi subprocess): the exact two-step the ACP
        // `ToolCallUpdate` handler runs — extract the binding, then feed it to the
        // SHARED `build_widget_event`. `checklist__render` is an in-process app, so
        // its widget binding + HTML resolve without any live MCP server.
        let mcp = McpRegistry::empty();
        let raw = ryu_widget_raw_output(
            "checklist__render",
            serde_json::json!({ "title": "Groceries", "items": [{ "text": "milk" }] }),
        );

        let (tool, args, result) =
            pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw)).expect("binding");
        let event = crate::sidecar::adapters::mcp_bridge::build_widget_event(
            &mcp,
            &tool,
            &args,
            &result,
            Some("acp_call_42".to_owned()),
            Some("conv-widget-test".to_owned()),
            "ryu".to_owned(),
        )
        .await
        .expect("checklist render synthesizes a widget event");

        // The widget correlates to the REAL ACP tool-call id (not the synthetic one).
        assert_eq!(event.tool_call_id, "acp_call_42");
        assert_eq!(event.tool_name, "checklist__render");
        assert_eq!(event.template_uri, "ui://widget/checklist.html");
        // `structuredContent` → `toolOutput`, delivered RAW to the widget.
        assert_eq!(event.tool_output["title"], serde_json::json!("Groceries"));
        assert!(!event.widget_html.is_empty(), "widget HTML resolves");
    }

    #[tokio::test]
    async fn pi_widget_synthesis_skips_error_results() {
        // An `isError` MCP result NEVER emits a widget (spec §1.1) — even when the
        // Pi extension stamped the marker.
        let mcp = McpRegistry::empty();
        let raw = serde_json::json!({
            "details": { "ryuWidget": {
                "tool": "checklist__render",
                "arguments": {},
                "output": { "isError": true, "content": [{ "type": "text", "text": "boom" }] },
            }}
        });
        let (tool, args, result) =
            pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw)).expect("binding");
        let event = crate::sidecar::adapters::mcp_bridge::build_widget_event(
            &mcp,
            &tool,
            &args,
            &result,
            Some("acp_call_err".to_owned()),
            Some("conv-err".to_owned()),
            "ryu".to_owned(),
        )
        .await;
        assert!(event.is_none(), "isError result must not synthesize a widget");
    }

    #[test]
    fn append_capped_truncates_from_front_at_char_boundary() {
        let buf = Arc::new(Mutex::new(String::new()));
        let trunc = Arc::new(std::sync::atomic::AtomicBool::new(false));
        append_capped(&buf, &trunc, "hello", Some(10));
        assert!(!trunc.load(std::sync::atomic::Ordering::Relaxed));
        // Overflow: keep only the last 10 bytes, oldest trimmed.
        append_capped(&buf, &trunc, "world12345", Some(10));
        let out = buf.lock().unwrap().clone();
        assert_eq!(out.len(), 10);
        // "helloworld12345" (15) truncated to its last 10 bytes.
        assert_eq!(out, "world12345");
        assert!(trunc.load(std::sync::atomic::Ordering::Relaxed));
    }

    #[test]
    fn read_text_file_scoped_applies_line_and_limit() {
        let dir = std::env::temp_dir().join(format!("ryu-acp-fs-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("f.txt");
        std::fs::write(&path, "l1\nl2\nl3\nl4\nl5").unwrap();

        // These schema structs are `#[non_exhaustive]`, so build them from JSON.
        let req = |extra: serde_json::Value| -> ReadTextFileRequest {
            let mut obj = serde_json::json!({ "sessionId": "s" });
            obj.as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            serde_json::from_value(obj).expect("valid ReadTextFileRequest")
        };

        // Full read.
        let full = req(serde_json::json!({ "path": path }));
        assert_eq!(read_text_file_scoped(&full), "l1\nl2\nl3\nl4\nl5");

        // 1-based line offset + limit window.
        let windowed = req(serde_json::json!({ "path": path, "line": 2, "limit": 2 }));
        assert_eq!(read_text_file_scoped(&windowed), "l2\nl3");

        // Missing file → empty, never panics.
        let missing = req(serde_json::json!({ "path": dir.join("nope.txt") }));
        assert_eq!(read_text_file_scoped(&missing), "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_cancel_is_false_without_a_live_turn() {
        // No registered turn for this conversation → nothing to cancel.
        assert!(!request_cancel("no-such-conversation-xyz"));
    }

    #[test]
    fn request_cancel_signals_a_registered_turn() {
        let conv = "conv-cancel-test";
        let cancel = Arc::new(TurnCancel::default());
        set_cancel(conv, Arc::clone(&cancel));
        assert!(request_cancel(conv));
        assert!(cancel.flag.load(std::sync::atomic::Ordering::SeqCst));
        clear_cancel(conv);
        assert!(!request_cancel(conv));
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
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
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
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
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
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
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
        assert_eq!(extract_exec_command(&tc).as_deref(), Some("rm -rf /tmp/x"));
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

    #[test]
    fn extract_file_write_finds_write_shapes_not_reads() {
        // Write tool: file_path + content → synthesized "write <path>".
        let tc = serde_json::json!({ "file_path": "/home/u/.ssh/authorized_keys", "content": "x" });
        assert_eq!(
            extract_file_write(&tc).as_deref(),
            Some("write /home/u/.ssh/authorized_keys")
        );
        // Edit tool nested under rawInput: file_path + new_string.
        let tc = serde_json::json!({
            "kind": "edit",
            "rawInput": { "file_path": "/etc/hosts", "old_string": "a", "new_string": "b" }
        });
        assert_eq!(extract_file_write(&tc).as_deref(), Some("write /etc/hosts"));
        // A read (path but NO mutating payload) is NOT treated as a write.
        let tc = serde_json::json!({ "kind": "read", "path": "/etc/hosts" });
        assert!(extract_file_write(&tc).is_none());
        // A shell exec (has a command, no file payload) is out of scope here.
        let tc = serde_json::json!({ "command": "ls" });
        assert!(extract_file_write(&tc).is_none());
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
    fn pi_spawn_cmd_is_bare_by_default() {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        // acp:pi runs the user's own Pi. Gateway routing is explicit through the
        // generic OpenAI-compatible wrapper or through the managed `ryu` agent.
        let cmd = pi_acp_cmd_gated();

        assert!(
            cmd.contains("pi-acp"),
            "pi spawn cmd should contain pi-acp, got: {cmd}"
        );
        assert!(
            !cmd.contains("OPENAI_BASE_URL") && !cmd.contains("OPENAI_API_KEY"),
            "bare pi spawn cmd should not inject gateway env, got: {cmd}"
        );
    }

    #[test]
    fn openai_gateway_cmd_wraps_pi_when_requested() {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        let cmd = openai_gateway_cmd(&pi_acp_cmd_gated()).expect("local bearer");
        let gateway_base = crate::sidecar::gateway::gateway_url();
        let expected_v1 = format!("{}/v1", gateway_base.trim_end_matches('/'));

        assert!(
            cmd.contains(&expected_v1),
            "gateway-wrapped pi spawn cmd should contain gateway /v1 URL, got: {cmd}"
        );
        assert!(
            cmd.contains("OPENAI_API_KEY") && cmd.contains("pi-acp"),
            "gateway-wrapped pi spawn cmd should include auth env and original command, got: {cmd}"
        );
    }

    #[test]
    fn openai_gateway_cmd_gateway_url_is_swappable_for_pi() {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        // The injection must honour RYU_GATEWAY_URL — no hardcoded endpoint.
        let prev_gw = std::env::var("RYU_GATEWAY_URL").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://custom-gw.local:7777");

        let cmd = openai_gateway_cmd(&pi_acp_cmd_gated()).expect("local bearer");

        match prev_gw {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }

        assert!(
            cmd.contains("http://custom-gw.local:7777/v1"),
            "gateway-wrapped pi spawn cmd should use RYU_GATEWAY_URL when set, got: {cmd}"
        );
    }

    #[test]
    fn should_inject_gateway_defaults_to_true() {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
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
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
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
            "acp:cursor",
            "acp:opencode",
            "acp:devin",
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
        assert!(spawn("acp:cline").contains("npx -y cline@latest"));
        assert!(spawn("acp:fast-agent").contains("uvx fast-agent-acp"));
        assert!(spawn("acp:minion").contains("uvx minion-code"));
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
