use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use agent_client_protocol::schema::{
    AuthMethodId, AuthenticateRequest, AvailableCommandInput, CancelNotification,
    ClientCapabilities, CloseSessionRequest, ContentBlock, CreateTerminalRequest,
    CreateTerminalResponse, EmbeddedResourceResource, ImageContent, InitializeRequest,
    InitializeResponse, KillTerminalRequest, KillTerminalResponse, ListSessionsRequest,
    ListSessionsResponse, LoadSessionRequest, LogoutRequest, NewSessionRequest, NewSessionResponse,
    PromptRequest, PromptResponse, ProtocolVersion, ReadTextFileRequest, ReadTextFileResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, RequestPermissionOutcome,
    RequestPermissionRequest, RequestPermissionResponse, SelectedPermissionOutcome,
    SessionConfigOption, SessionConfigOptionCategory, SessionConfigOptionValue,
    SessionConfigSelectOption, SessionId, SessionNotification, SessionUpdate,
    SetSessionConfigOptionRequest, SetSessionConfigOptionResponse, SetSessionModeRequest,
    SetSessionModelRequest, TerminalId, TerminalOutputRequest, TerminalOutputResponse, ToolCall,
    ToolCallContent, ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolKind,
    WaitForTerminalExitRequest, WaitForTerminalExitResponse, WriteTextFileRequest,
    WriteTextFileResponse,
};
use agent_client_protocol::schema::{ResumeSessionRequest, ResumeSessionResponse};
use agent_client_protocol::util::MatchDispatch;
use agent_client_protocol::{Agent, Client, ConnectionTo, SessionMessage};
use agent_client_protocol_tokio::AcpAgent;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tokio::sync::mpsc;

use crate::sidecar::adapters::acp_probe_cache as probe_cache;
use crate::sidecar::adapters::{
    AgentAdapter, AgentConfig, AgentInfo, ChatChunk, ChatRequest, ImagePart, MemoryEntry, ToolInfo,
};
use crate::sidecar::gateway::{check_exec_scan, ExecScanOutcome};
use crate::sidecar::mcp::McpRegistry;
use crate::sidecar::BoxFuture;
use crate::win_process::NoWindow;

/// ACP's elicitation request was added after the 0.11 schema dependency this
/// crate currently uses. Keep the wire-level request local until the dependency
/// can be upgraded; unlike a `ToolCall` notification, this is a real
/// request/response exchange and the response is what resumes the agent's tool
/// loop.
#[derive(Debug, Clone, Serialize, Deserialize, agent_client_protocol::JsonRpcRequest)]
#[request(method = "elicitation/create", response = ElicitationCreateResponse)]
pub struct ElicitationCreateRequest {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub mode: serde_json::Value,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, agent_client_protocol::JsonRpcResponse)]
pub struct ElicitationCreateResponse {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
}

impl ElicitationCreateResponse {
    fn cancelled() -> Self {
        Self {
            action: "cancel".to_owned(),
            content: None,
        }
    }
}

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
    /// The agent's own startup banner — the text it declared in `session/new`'s
    /// `_meta.piAcp.startupInfo` and then re-emitted as an `agent_message_chunk`
    /// once the session was live (pi-acp's `sendStartupInfoIfPending`).
    ///
    /// It is agent chrome (a skills/commands listing, an available-update
    /// notice), not a reply to anything — the user has not spoken yet. Routed
    /// here so it does NOT join the assistant reply buffer and does NOT get
    /// persisted as an assistant message row; mod.rs surfaces it as a data part
    /// instead. Same treatment as [`AcpEvent::UserText`], for the same reason.
    Banner(String),
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
        /// The call's arguments, when this update carries them.
        ///
        /// LOAD-BEARING, not a convenience: an ACP agent is free to open a tool
        /// call before its arguments exist and fill them in afterwards, and
        /// pi-acp does exactly that — the first `tool_call` frame carries
        /// `rawInput: {}` (or a partial-JSON blob) while the model is still
        /// streaming the call, and the real arguments arrive on a later
        /// `tool_call_update`. The desktop's rich renderers read `part.input`
        /// (`TodoTool` → `input.todos`, `PlanTool` → `input.plan`, `SubagentTool`
        /// → `input.description`), so dropping this field pins those cards to the
        /// empty opening frame: a plan card renders as a blank region, a to-do
        /// list shimmers forever, and a subagent card loses its subtitle — with
        /// no error anywhere. mod.rs re-emits the opening frame when this
        /// changes.
        input: Option<serde_json::Value>,
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
    /// The agent re-published its session config options, as the serialized
    /// `Vec<SessionConfigOption>`. Each update REPLACES the client's cached list,
    /// exactly like [`AcpEvent::AvailableCommands`].
    ///
    /// Two producers, one channel:
    ///
    /// - the response to `session/set_config_option`, which by protocol returns
    ///   the FULL refreshed list rather than an acknowledgement. That is the only
    ///   way an option existing solely for *another* option's value can ever
    ///   appear mid-session — `session/new` could not have mentioned it. The
    ///   probe path has always consumed this; the TURN path used to throw it
    ///   away, so applying a pick silently stopped the pickers from learning
    ///   what it unlocked.
    /// - `SessionUpdate::ConfigOptionUpdate`, the agent volunteering the same
    ///   list unprompted.
    ConfigOptions(serde_json::Value),
    /// ACP session metadata changed (title and/or last-activity timestamp).
    /// The desktop can use this to keep the tab title and transcript chrome in
    /// sync with agents that rename their sessions.
    SessionInfo(serde_json::Value),
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
    /// A structured ACP elicitation request. The client answers this through
    /// `/api/chat/question`; the request handler owns the ACP responder and
    /// therefore resumes the agent directly when the waiter resolves.
    QuestionRequest {
        tool_call_id: String,
        input: serde_json::Value,
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
    /// A tool result declared the nested sub-steps it performed internally
    /// (`details.ryuSteps`, see [`pi_subagent_steps`]). ACP carries no
    /// parent/child relation on tool calls and an agent-side extension has no way
    /// to emit a sibling tool-call frame, so Core minting `<parent_id>:<n>` child
    /// parts from this marker is the ONLY route to the desktop's nested-subagent
    /// rows and to `tool-TaskOutput`.
    ///
    /// Emitted on EVERY update carrying the marker, not only the terminal one:
    /// the producer streams steps as the child performs them, so the array grows
    /// across updates. mod.rs makes the fan-out idempotent by child part id.
    ToolSteps {
        /// The parent tool call's id — the model's own `tool_use` id, passed
        /// through verbatim by the ACP agent.
        parent_id: String,
        /// `[{ name, input, output?, status }, …]`, one entry per nested step.
        steps: Vec<serde_json::Value>,
        /// The parent's own answer text, present only once the parent tool call
        /// has COMPLETED. mod.rs emits it as a `<parent_id>:out` `TaskOutput`
        /// part — the child's final answer, as the Cowork transcript reads it.
        final_answer: Option<String>,
    },
    /// A tool result asked the CLIENT to update session config values it holds
    /// (`details.ryuConfig`, see [`pi_config_updates`]). Carries the requested
    /// `{ config_id: value_id }` pairs verbatim.
    ///
    /// The reverse of the usual direction: the client normally pushes its config
    /// picks down to the agent per turn, and a client that PERSISTS a pick keeps
    /// re-sending it, so an agent-side action that invalidates the pick has no way
    /// to say so. This is that way. Agent-neutral by construction — keyed on the
    /// generic `details.*` marker, never on a tool name or an agent id — so any
    /// producer that stamps it gets the write-back.
    ///
    /// Advisory, not authoritative: the client owns its own state and is free to
    /// ignore a key it does not hold. Core neither validates the ids nor mirrors
    /// them into any session state of its own.
    ConfigUpdate(std::collections::BTreeMap<String, String>),
    /// The agent refused the turn because it needs the user to authenticate
    /// (JSON-RPC -32000, `ErrorCode::AuthRequired`) — in practice an OAuth /
    /// subscription token that expired mid-session.
    ///
    /// Deliberately NOT an [`AcpEvent::Error`]: that arm tears the turn down with
    /// a message about configuring a model, which is advice the user cannot act
    /// on and which hides the real cause. This one names the agent so the client
    /// can offer that agent's own advertised `authMethods` and let the user
    /// re-run the turn once they are back in.
    AuthNeeded { agent_id: String, message: String },
    /// A fatal error from the session; the stream ends after this.
    Error(AcpFailure),
}

/// Stable failed-turn information carried from the ACP boundary to Core's
/// stream and persistence layers. Keeping the code, title, and recovery copy
/// together prevents the live error frame and reloaded transcript from
/// disagreeing about what failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcpFailure {
    pub code: String,
    pub title: String,
    pub message: String,
}

fn has_payment_required_marker(detail: &str) -> bool {
    let lower = detail.to_ascii_lowercase();
    lower.contains("provider_payment_required")
        || lower.contains("insufficient_credits")
        || lower.contains("payment required")
        || lower.contains("http 402")
        || lower.contains("error 402")
        || lower.contains("no credits")
        || lower.contains("insufficient credit")
        || lower.contains("credit balance exhausted")
}

/// Turn an opaque pi-acp JSON-RPC failure into the recovery the selected
/// provider actually needs. ACP does not expose the upstream HTTP status as a
/// typed field, so the managed Pi's Core-owned active provider supplies the
/// missing context while stable Gateway markers confirm this is a 402.
fn classify_prompt_failure(active_provider: Option<&str>, detail: &str) -> AcpFailure {
    let payment_required = has_payment_required_marker(detail);
    if active_provider == Some(crate::pi_config::MANAGED_OPENROUTER_ID) && payment_required {
        return AcpFailure {
            code: "insufficient_credits".to_owned(),
            title: "Ryu credits exhausted".to_owned(),
            message: "Your organization's Ryu credits are exhausted. Open Settings > Credits to top up, or choose a BYOK or local model, then retry."
                .to_owned(),
        };
    }
    if active_provider == Some("openrouter") && payment_required {
        return AcpFailure {
            code: "provider_payment_required".to_owned(),
            title: "OpenRouter credits exhausted".to_owned(),
            message: "The OpenRouter API key on this node has no prepaid credits left. Add credits to your OpenRouter account or choose another provider, then retry."
                .to_owned(),
        };
    }
    AcpFailure {
        code: "agent_error".to_owned(),
        title: "Request failed".to_owned(),
        message: format!(
            "The agent could not complete the turn because its model provider is unavailable or misconfigured. Check Settings > Engines, then retry. (details: {detail})"
        ),
    }
}

/// A snapshot of ACP's `unstable_session_usage` counters.
///
/// Every field of the protocol's `Usage` is documented as SESSION-CUMULATIVE
/// ("Sum of all token types across session", "Total input tokens across all
/// turns"), but it is delivered on the per-turn `PromptResponse`. Reporting it
/// verbatim as the turn's usage — which Core did — makes turn 5 claim turns 1-5's
/// tokens and inflates every derived number (tok/s, cost, TPOT) with it. So the
/// session loop keeps the previous snapshot and emits the DELTA as this turn's
/// usage, keeping the cumulative figure under a separate `session*` key.
///
/// Fields are `Option` because all but the first three are optional in the
/// schema and `unstable_session_usage` support is sparse and per-agent — an
/// absent counter must stay absent all the way to the UI, never become a zero.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AcpUsageSnapshot {
    pub cached_read_tokens: Option<u64>,
    pub cached_write_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub thought_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
}

/// One counter's turn delta.
///
/// `None` in ⇒ `None` out: an agent that never reports a counter must not get a
/// fabricated zero. A DECREASE means the cumulative counter was re-based under
/// us (agent restart, context compaction, a fresh session behind the same chat),
/// so the current value IS the new baseline and the whole of it belongs to this
/// turn — clamping to zero would silently drop a real turn's tokens.
pub(crate) fn acp_usage_delta(current: Option<u64>, previous: Option<u64>) -> Option<u64> {
    let cur = current?;
    match previous {
        Some(prev) if cur >= prev => Some(cur - prev),
        _ => Some(cur),
    }
}

impl AcpUsageSnapshot {
    /// Read a serialized ACP `Usage` (camelCase, see the schema crate).
    pub(crate) fn from_value(v: &serde_json::Value) -> Self {
        let get = |k: &str| v.get(k).and_then(serde_json::Value::as_u64);
        Self {
            cached_read_tokens: get("cachedReadTokens"),
            cached_write_tokens: get("cachedWriteTokens"),
            input_tokens: get("inputTokens"),
            output_tokens: get("outputTokens"),
            thought_tokens: get("thoughtTokens"),
            total_tokens: get("totalTokens"),
        }
    }

    /// This turn's usage = cumulative now − cumulative at the end of last turn.
    pub(crate) fn delta_from(&self, previous: &Self) -> Self {
        Self {
            cached_read_tokens: acp_usage_delta(
                self.cached_read_tokens,
                previous.cached_read_tokens,
            ),
            cached_write_tokens: acp_usage_delta(
                self.cached_write_tokens,
                previous.cached_write_tokens,
            ),
            input_tokens: acp_usage_delta(self.input_tokens, previous.input_tokens),
            output_tokens: acp_usage_delta(self.output_tokens, previous.output_tokens),
            thought_tokens: acp_usage_delta(self.thought_tokens, previous.thought_tokens),
            total_tokens: acp_usage_delta(self.total_tokens, previous.total_tokens),
        }
    }
}

/// Fully-resolved payload for [`AcpEvent::ToolWidget`], mapped 1:1 onto the
/// `data-tool-widget-available` stream part (spec §1.1). The MCP bridge mints the
/// `instance_id`, resolves the widget HTML, and strips `ryu/widget` from the
/// forwarded `_meta`; the adapter only serializes.
#[derive(Debug, Clone)]
pub struct ToolWidgetEvent {
    /// The tool-call row this widget attaches to (best-effort correlation).
    pub tool_call_id: String,
    /// Fully-qualified tool id (`<server>.<tool>`).
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
    /// Agent-requested reasoning effort. Unlike a client-selected config option,
    /// this remains available when Simple mode intentionally strips all model
    /// controls from the request. ACP does not have one stable effort id, so the
    /// turn path tries the conventional ids until the agent accepts one.
    pub agent_effort: Option<String>,
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
    /// `sessionCapabilities.list` — agent implements `session/list`.
    session_list: bool,
    /// `sessionCapabilities.resume` — agent implements `session/resume`.
    session_resume: bool,
    /// `sessionCapabilities.close` — agent implements `session/close`.
    ///
    /// Load-bearing rather than informational: [`close_acp_session`] used to fire
    /// `session/close` at every agent and surface the rejection as a 502. Real
    /// agents disagree here — captured `initialize` responses show pi-acp,
    /// qwen-code and factory-droid advertising NO `close` — so the button that
    /// drives it has to be able to hide itself.
    session_close: bool,
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
        // Presence IS the signal: each sub-struct is empty apart from its own
        // `_meta`, so the protocol says "supported" by sending the key at all.
        //
        // Only these three are read because only these three COMPILE under
        // Core's feature set (`unstable_session_resume`, `unstable_session_close`, and
        // `unstable_session_additional_directories` are on; `unstable_session_fork` is
        // off). Agents also send a
        // `delete` key, which the pinned schema has no field for at all — it is
        // dropped by serde and must not be confused with `close`.
        session_list: caps.session_capabilities.list.is_some(),
        session_resume: caps.session_capabilities.resume.is_some(),
        session_close: caps.session_capabilities.close.is_some(),
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
        "sessionCapabilities": {
            "list": caps.session_list,
            "resume": caps.session_resume,
            "close": caps.session_close,
        },
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
///
/// The command is pre-scanned through the gateway command-approval scanner
/// first: `terminal/create` has no `request_permission` step, so without this
/// scan it would be an ungoverned second exec path beside the scanned
/// permission seam. There is no prompt seam here, so `ApprovalRequired` rejects
/// (fail closed) in interactive and headless mode alike.
async fn terminal_create(
    registry: &TerminalRegistry,
    req: &CreateTerminalRequest,
    session_roots: &[std::path::PathBuf],
    scan_agent: &str,
) -> anyhow::Result<String> {
    use std::process::Stdio;

    let line = if req.args.is_empty() {
        req.command.clone()
    } else {
        format!("{} {}", req.command, req.args.join(" "))
    };
    match check_exec_scan("acp", &line, None, Some(scan_agent)).await {
        ExecScanOutcome::Allow => {}
        ExecScanOutcome::Deny(reason) => {
            return Err(anyhow::anyhow!(
                "terminal command denied by gateway policy: {reason}"
            ))
        }
        ExecScanOutcome::ApprovalRequired(reason) => {
            return Err(anyhow::anyhow!(
            "terminal command requires approval and terminal/create has no prompt seam: {reason}"
        ))
        }
    }

    let terminal_cwd = req
        .cwd
        .as_deref()
        .map(|path| {
            scoped_path(session_roots, path)
                .ok_or_else(|| anyhow::anyhow!("terminal cwd is outside the session workspaces"))
        })
        .transpose()?
        .unwrap_or_else(|| session_roots[0].clone());
    let mut cmd = tokio::process::Command::new(&req.command);
    cmd.args(&req.args);
    for env in &req.env {
        cmd.env(&env.name, &env.value);
    }
    cmd.current_dir(terminal_cwd);
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
// rather than touching disk directly, so the client is the single mediation point
// — and the confinement point: requests are scoped to the session's workspace
// root. ACP agents are first-party binaries running as the user (SECURITY.md),
// so this is accident prevention (a prompt-injected turn must not read
// `~/.ssh/id_ed25519` or write `~/.zshrc` through the client seam), not process
// containment. Read honours ACP's 1-based `line` + `limit` window.

/// True when `path` stays inside `root` after LEXICAL normalization (`.`/`..`
/// resolved without touching the filesystem, so a not-yet-created target still
/// checks). A relative path is joined to `root` first. Symlink-following escapes
/// are out of scope here — this is the accident-prevention layer; the gateway
/// exec-scan's path deny rules govern the exec plane separately.
fn path_within_root(root: &std::path::Path, path: &std::path::Path) -> bool {
    use std::path::Component;
    fn normalize(p: &std::path::Path) -> std::path::PathBuf {
        let mut out = std::path::PathBuf::new();
        for c in p.components() {
            match c {
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other),
            }
        }
        out
    }
    let abs = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    normalize(&abs).starts_with(normalize(root))
}

/// Serve `fs/read_text_file`, applying the optional 1-based `line` offset and
/// `limit`. Confined to the session workspace root: an out-of-root path returns
/// `""` (the ACP response carries only `content`; degrading to empty matches how
/// a missing file behaves, and never feeds out-of-workspace secrets to the
/// model). Returns `""` on any read error likewise.
fn scoped_path(roots: &[std::path::PathBuf], path: &std::path::Path) -> Option<std::path::PathBuf> {
    roots.iter().find_map(|root| {
        if path_within_root(root, path) {
            Some(if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            })
        } else {
            None
        }
    })
}

fn read_text_file_scoped_in_roots(
    req: &ReadTextFileRequest,
    roots: &[std::path::PathBuf],
) -> String {
    let Some(path) = scoped_path(roots, &req.path) else {
        tracing::warn!(
            path = %req.path.display(),
            "fs/read_text_file refused: path is outside the session workspaces"
        );
        return String::new();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
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

/// Serve `fs/write_text_file`, creating parent directories as needed. Confined
/// to the session workspace root — an out-of-root path is refused (no directory
/// is created, nothing is written).
fn write_text_file_scoped_in_roots(
    req: &WriteTextFileRequest,
    roots: &[std::path::PathBuf],
) -> anyhow::Result<()> {
    let Some(path) = scoped_path(roots, &req.path) else {
        return Err(anyhow::anyhow!(
            "refusing write outside the session workspaces: {}",
            req.path.display()
        ));
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(&path, &req.content).with_context_msg(|| format!("write {}", path.display()))
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
    std::collections::HashMap<
        String,
        (tokio::sync::oneshot::Sender<Option<String>>, Option<String>),
    >,
>;

/// `conversation_id/tool_call_id → (answer waiter, host conversation id)`.
///
/// Question tools are surfaced as ACP tool calls, but their answer is a
/// client-side interaction. Keep the waiter separate from permission waiters:
/// an answer is structured data, not an option id, and must never be accepted
/// by the permission endpoint by accident.
type QuestionWaiters = Mutex<
    std::collections::HashMap<String, (tokio::sync::oneshot::Sender<serde_json::Value>, String)>,
>;

fn pending_permissions() -> &'static PermissionWaiters {
    static WAITERS: OnceLock<PermissionWaiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn pending_questions() -> &'static QuestionWaiters {
    static WAITERS: OnceLock<QuestionWaiters> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn question_key(conversation_id: &str, tool_call_id: &str) -> String {
    format!("{conversation_id}\u{1f}{tool_call_id}")
}

fn elicitation_tool_call_id(request: &ElicitationCreateRequest) -> String {
    request
        .mode
        .get("scope")
        .and_then(|scope| scope.get("toolCallId"))
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("elicitation-{}", next_permission_id()))
}

fn elicitation_question_input(
    request: &ElicitationCreateRequest,
    tool_call_id: &str,
) -> serde_json::Value {
    serde_json::json!({
        "toolCallId": tool_call_id,
        "questions": [{
            "id": "q-0",
            "title": request.message,
            "kind": "text",
            "options": [],
        }],
        "schema": request.mode,
    })
}

/// Register the answer channel for a Question tool call. The ACP tool-call id
/// is stable for the life of the session and is also sent on the wire as
/// `toolCallId`, so reconnecting clients can answer the exact pending call.
pub fn register_question(
    conversation_id: String,
    tool_call_id: String,
) -> tokio::sync::oneshot::Receiver<serde_json::Value> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    if !conversation_id.is_empty() && !tool_call_id.is_empty() {
        if let Ok(mut map) = pending_questions().lock() {
            map.insert(
                question_key(&conversation_id, &tool_call_id),
                (tx, conversation_id),
            );
        }
    }
    rx
}

/// Return the conversation owning a pending Question, without consuming it.
pub fn peek_question_scope(conversation_id: &str, tool_call_id: &str) -> Option<String> {
    pending_questions().lock().ok().and_then(|map| {
        map.get(&question_key(conversation_id, tool_call_id))
            .map(|(_, scope)| scope.clone())
    })
}

/// Deliver a structured answer to a pending Question tool call.
pub fn resolve_question(
    conversation_id: &str,
    tool_call_id: &str,
    answers: serde_json::Value,
) -> bool {
    let sender = pending_questions()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(&question_key(conversation_id, tool_call_id)));
    match sender {
        Some((tx, _scope)) => tx.send(answers).is_ok(),
        None => false,
    }
}

/// Drop a pending Question when its ACP stream ends or the client disconnects.
pub fn cancel_question(conversation_id: &str, tool_call_id: &str) {
    if let Ok(mut map) = pending_questions().lock() {
        map.remove(&question_key(conversation_id, tool_call_id));
    }
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
        map.insert(request_id, (tx, conversation_id.filter(|s| !s.is_empty())));
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
// low-level connection, reads the full response, and drops it.
//
// That spawn is expensive (up to the 30s ceiling below), and every agent picker
// in the product depends on it, so the result is cached per spawn command by
// [`probe_cache`] — persisted across restarts, TTL'd, single-flighted, and
// refreshed in the background. Read that module's header before changing the
// caching behaviour here; in particular, FAILURES are cached deliberately.

/// Ceiling on a single ACP config probe (`initialize` + `session/new`). Long
/// enough for a cold `npx` spawn of a large agent binary plus a first backend
/// round-trip, short enough that a wedged `session/new` (e.g. Codex against an
/// unreachable provider) fails fast and stays retryable rather than hanging the
/// desktop's picker request forever.
const ACP_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

// ── Core-synthesized session config options ──────────────────────────────────
//
// Everything above this line is agent-reported: Ryu asks, the agent answers, and
// the desktop renders whatever came back. This one option is the exception, and
// it is deliberately narrow.
//
// Plan mode on the flagship is entered by an in-band token in the prompt text
// (`crate::pi_config::plan_mode_sentinel`) — the only per-turn channel pi-acp
// leaves open. A typed token is a poor affordance, so Core advertises the toggle
// as if the agent had reported it. The desktop already renders every advertised
// config option generically (`use-composer-acp-sections.ts`), so the pill costs
// ZERO client change; the turn path turns the chosen value back into the token.
//
// Two consequences of "synthesized, not reported" follow, and both are handled
// below rather than left to a reader: the agent has never heard of this id, so it
// must never be sent to `session/set_config_option` (`apply_turn_config` filters
// it), and Core has no per-session plan state to report as `currentValue`.

/// The id of the Core-synthesized plan-mode option. Dotted and `ryu`-prefixed so
/// it cannot collide with an agent-reported id: ACP ids are opaque strings and an
/// agent is free to invent `plan`, but `ryu.` is ours by construction.
///
/// Shared with [`super::route_acp_stream`], which reads the turn's chosen value
/// back out of the request. One const, so the producer and the consumer of this
/// id cannot drift.
pub const PLAN_MODE_CONFIG_ID: &str = "ryu.plan";

/// The option value that means "plan mode on for this turn".
pub const PLAN_MODE_ON: &str = "on";

/// The option value that means "plan mode off", and the advertised default.
const PLAN_MODE_OFF: &str = "off";

/// Is `config_id` one Core made up rather than one the agent advertised?
///
/// Sending a synthesized id to `session/set_config_option` is not merely useless,
/// it is an error the agent rejects: pi-acp accepts exactly `model` and
/// `thought_level` and throws `Unknown configId` on anything else. The rejection
/// is logged and skipped, so the visible symptom would be a warn line per turn
/// forever — noise that trains people to ignore the log. Filter instead.
fn is_core_synthesized_config_id(config_id: &str) -> bool {
    config_id == PLAN_MODE_CONFIG_ID
}

/// The synthesized plan-mode selector, as an agent would have advertised it.
///
/// `category: "mode"` is the honest classification (it selects how the turn
/// behaves, not which model runs it) and is what gives the desktop its icon and
/// placement. One caveat worth knowing before changing it: the composer hides the
/// agent's own `modes` picker as soon as ANY config option carries
/// `category: "mode"`. That costs nothing today only because the flagship's modes
/// picker is *already* hidden for an unrelated reason — pi-acp advertises its
/// thinking levels twice, once as `modes` and once as the `thought_level` config
/// option over the identical value set, which trips the composer's
/// duplicate-detection. If pi-acp ever stops duplicating them, this category
/// becomes load-bearing and must be revisited.
///
/// `name` must also stay clear of "thought"/"reason"/"think"/"effort": the
/// composer treats any option whose category, id or name contains one of those as
/// a reasoning control and hides it outright when the agent reports no reasoning
/// capability. "Plan mode" is safe; "Planning effort" would silently vanish.
///
/// `currentValue` is always `off`, even while plan mode is on. Core has no
/// per-session plan state to read — the flag lives inside the Pi process, and this
/// probe is cached per spawn command and shared by every conversation. The
/// desktop overlays the user's own pick (`acpOptionValues[opt.id] ?? currentValue`)
/// so the pill still shows what they chose; `off` is only the cold-start default.
fn plan_mode_config_option() -> SessionConfigOption {
    SessionConfigOption::select(
        PLAN_MODE_CONFIG_ID,
        "Plan mode",
        PLAN_MODE_OFF,
        vec![
            SessionConfigSelectOption::new(PLAN_MODE_OFF, "Off")
                .description("Act on the request directly.".to_owned()),
            SessionConfigSelectOption::new(PLAN_MODE_ON, "On").description(
                "Investigate and propose a plan first; file edits are withheld until you approve it."
                    .to_owned(),
            ),
        ],
    )
    .category(SessionConfigOptionCategory::Mode)
    .description("Research and write a plan before changing anything.".to_owned())
}

/// Append the synthesized plan-mode option to what an agent advertised — for the
/// flagship only.
///
/// Gated on [`RyuToolAccess::PiExtension`] rather than on an agent id: that is the
/// SAME spawn-command predicate `run_acp_instance` uses to recognise the managed
/// Pi, and it is true exactly when `ryu-plan.ts` has been shipped into the config
/// dir the process will read. Offering the pill to an agent that cannot honour the
/// sentinel would be a control that does nothing — and the user's `/plan` would
/// reach that agent's model as literal text.
///
/// `None` (the agent advertised no config options at all) becomes a one-element
/// list rather than staying `None`, so the pill does not depend on the agent
/// happening to advertise something else first.
fn with_plan_mode_option(
    spawn_cmd: &str,
    advertised: Option<Vec<SessionConfigOption>>,
) -> Option<Vec<SessionConfigOption>> {
    if ryu_tool_access(spawn_cmd) != RyuToolAccess::PiExtension {
        return advertised;
    }
    let mut options = advertised.unwrap_or_default();
    // Appended, never inserted: the agent's own options keep the order it chose,
    // and the model selector in particular stays first where pi-acp put it.
    options.push(plan_mode_config_option());
    Some(options)
}

/// Probe an ACP agent for its advertised session config — `{ modes, models,
/// configOptions }`, each `null` when unsupported. Fully agent-reported apart
/// from the one Core-synthesized option documented above; Ryu hardcodes nothing
/// else. Cached per `spawn_cmd`.
pub async fn probe_acp_config(
    spawn_cmd: String,
    cwd: PathBuf,
) -> anyhow::Result<serde_json::Value> {
    probe_acp_config_with(spawn_cmd, cwd, SessionSelections::new()).await
}

/// Config-option values to apply to the probe session before reading what the
/// agent advertises — `{ config_id → value_id }`, sorted so the same selections
/// always produce the same cache key.
pub type SessionSelections = std::collections::BTreeMap<String, String>;

/// Probe an ACP agent with `selections` already applied to the throwaway session.
///
/// The advertised option SET is not always a constant of the binary: an agent may
/// only offer an option while some OTHER option holds a particular value. ACP
/// exposes that directly — `session/set_config_option` answers with the whole
/// refreshed `configOptions` list rather than an ack — and this is the client
/// half of that contract: apply what the user has picked, then report what the
/// agent says it offers *given those picks*.
///
/// Verified against opencode 1.18.5, which advertises `{ id: "effort",
/// category: "thought_level" }` only while the session's model has effort levels:
/// `session/new` on its default model returns `[model, mode]`, and the same
/// session answers `[model, effort, mode]` once a model with effort levels is
/// applied. Nothing here names that agent — any agent whose options depend on
/// another option's value gets the same treatment.
///
/// Cached per (`spawn_cmd`, `selections`), so switching model re-probes once and
/// is then instant, and the two answers cannot overwrite each other.
pub async fn probe_acp_config_with(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
) -> anyhow::Result<serde_json::Value> {
    let key = probe_cache::cache_key(&spawn_cmd, &selections);
    // Cached answer (success OR failure) — see [`probe_cache`] for why failures
    // count and why a stale entry is served rather than awaited. The only probe
    // a user can block on is the first one for an agent never opened before.
    if let Some(hit) = probe_cache::lookup(&key) {
        if hit.stale {
            refresh_acp_config_in_background(spawn_cmd.clone(), cwd, selections);
        }
        return hit.outcome.map_err(|e| anyhow::anyhow!(e));
    }

    // Single-flight: opening a window mounts several pickers for the same agent
    // at once, and without this each one spawns its own subprocess. The waiter
    // re-reads the cache, because the holder ahead of it has just written the
    // answer it was about to spend up to 30s computing.
    let lock = probe_cache::probe_lock(&key);
    let _guard = lock.lock().await;
    if let Some(hit) = probe_cache::lookup(&key) {
        return hit.outcome.map_err(|e| anyhow::anyhow!(e));
    }

    let result = probe_acp_config_uncached(spawn_cmd.clone(), cwd, selections).await;
    store_probe_result(&key, &result);
    result
}

/// Record a probe outcome, flattening `anyhow`'s error into the message the
/// cache stores (and the desktop eventually shows).
fn store_probe_result(key: &str, result: &anyhow::Result<serde_json::Value>) {
    match result {
        Ok(value) => probe_cache::store(key, Ok(value)),
        Err(err) => probe_cache::store(key, Err(&err.to_string())),
    }
}

/// Re-probe `spawn_cmd` behind the user and refresh its cache entry.
///
/// Detached on purpose: this is the "revalidate" half of stale-while-revalidate,
/// so the read that noticed the staleness has already returned. Deduped through
/// [`probe_cache::begin_refresh`] so a burst of stale reads (several pickers
/// mounting at once) schedules one re-probe, not one each.
fn refresh_acp_config_in_background(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
) {
    // Keyed by the same (spawn command, selections) pair the entry is: refreshing
    // one model's answer must not dedupe out the refresh of another's.
    let key = probe_cache::cache_key(&spawn_cmd, &selections);
    let Some(slot) = probe_cache::begin_refresh(&key) else {
        return;
    };
    tokio::spawn(async move {
        let lock = probe_cache::probe_lock(&key);
        let _guard = lock.lock().await;
        let result = probe_acp_config_uncached(spawn_cmd, cwd, selections).await;
        store_probe_result(&key, &result);
        drop(slot);
    });
}

/// The probe itself: spawn the agent, `initialize` + `session/new`, read what it
/// advertises, drop the session. Always hits the subprocess — every caller goes
/// through [`probe_acp_config`], which is what owns the caching.
fn acp_agent_from_spawn(spawn_cmd: &str) -> anyhow::Result<AcpAgent> {
    let agent =
        AcpAgent::from_str(spawn_cmd).map_err(|e| anyhow::anyhow!("ACP spawn parse: {e}"))?;
    let server = match agent.into_server() {
        agent_client_protocol::schema::McpServer::Stdio(stdio) => {
            agent_client_protocol::schema::McpServer::Stdio(
                crate::agent_sandbox::confine_codex_stdio(stdio).map_err(|error| {
                    anyhow::anyhow!("preparing the managed Codex OS deletion boundary: {error}")
                })?,
            )
        }
        other => other,
    };
    Ok(AcpAgent::new(server))
}

async fn probe_acp_config_uncached(
    spawn_cmd: String,
    cwd: PathBuf,
    selections: SessionSelections,
) -> anyhow::Result<serde_json::Value> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    // Which road Ryu's tools take to this agent, resolved from the spawn command
    // BEFORE the subprocess answers anything. Reported alongside the agent's own
    // capabilities because clients must NOT derive it from `mcpCapabilities`: the
    // managed Pi advertises `http:false` yet has full tool access through the
    // `ryu-mcp` extension, so a UI reading the raw capability would tell the
    // flagship's user their tools are unavailable when they are not. Core owns
    // this derivation for exactly that reason — see [`RyuToolAccess`].
    let tool_access = ryu_tool_access(&spawn_cmd);
    // Carried into the connect closure so the synthesized plan-mode option is
    // appended INSIDE it — i.e. before the result is written to `config_cache`.
    // Appending after the cache read instead would work on the first call and
    // silently stop on every later one, which is the worst shape this bug has.
    let plan_cmd = spawn_cmd.clone();
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
                let plan_cmd = plan_cmd.clone();
                let selections = selections.clone();
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
                    // Apply the caller's picks and let the agent re-answer. ACP's
                    // `session/set_config_option` returns the FULL refreshed option
                    // list, which is the only channel by which an option that
                    // exists only for some other option's value can ever appear —
                    // `session/new` cannot have mentioned it. Best-effort per
                    // option: an agent that rejects an id (or implements no config
                    // options at all) leaves the `session/new` answer standing.
                    let mut config_options = resp.config_options;
                    for (config_id, value) in model_first(&selections) {
                        let applied: Result<SetSessionConfigOptionResponse, _> = cx
                            .send_request(SetSessionConfigOptionRequest::new(
                                resp.session_id.clone(),
                                config_id.clone(),
                                config_option_value(value),
                            ))
                            .block_task()
                            .await;
                        match applied {
                            Ok(refreshed) => config_options = Some(refreshed.config_options),
                            Err(e) => tracing::debug!(
                                "ACP probe could not apply '{config_id}'='{value}': {e}"
                            ),
                        }
                    }
                    Ok(serde_json::json!({
                        "modes": resp.modes,
                        "models": resp.models,
                        "configOptions": with_plan_mode_option(&plan_cmd, config_options),
                        "authMethods": init.auth_methods,
                        "agentCapabilities": agent_caps_json(&caps),
                        "ryuToolAccess": tool_access.as_str(),
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
    Ok(value)
}

/// Authenticate to an ACP agent with one of the methods it advertised in its
/// `initialize` response (`auth_methods`, surfaced by [`probe_acp_config`] as
/// `authMethods`). This drives the ACP Authentication flow — e.g. a subscription
/// / OAuth "login" — so agents that gate `session/new` behind auth become usable.
/// The agent subprocess owns the actual login UX (opening a browser, etc.).
///
/// **This waits for the `authenticate` RESPONSE, not for the login.** The
/// distinction is not academic: `connect_with` runs the connection only until
/// the closure below returns (agent-client-protocol 0.11.1,
/// `src/jsonrpc.rs`), and the tokio transport wraps the spawned agent in a
/// `ChildGuard` whose `Drop` calls `start_kill` (agent-client-protocol-tokio
/// 0.11.1, `src/acp_agent.rs:233-237`). So returning here SIGKILLs the agent.
/// For an agent that answers `authenticate` once its browser flow is *finished*
/// that is correct; for the common CLI shape that answers once the browser is
/// *opened*, it kills the callback server mid-flow and the credential is never
/// written. `acp_authenticate` (`server/mod.rs`) exists to keep that honest —
/// it checks Pi's stored credential rather than trusting this returning `Ok`,
/// and reports `verified: false` when there is nothing to check against.
///
/// Invalidates the probe cache for this spawn command on success so the next
/// `acp-config` read reflects the now-authenticated state.
pub async fn authenticate_acp(spawn_cmd: String, method_id: String) -> anyhow::Result<()> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
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
    // The agent's config may now differ (auth unlocked session/new); drop the
    // cache. This is also what un-sticks a CACHED FAILURE: the probe of a
    // signed-out agent fails, and logging in is the fix — so it must not wait out
    // the failure TTL.
    probe_cache::invalidate(&cache_key);
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
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
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
    probe_cache::invalidate(&cache_key);
    Ok(())
}

/// Resume an ACP agent's own prior session — prefer `session/resume` when the
/// agent advertises that capability, otherwise use `session/load`. `resume`
/// reconnects without replaying the native history; `load` asks the agent to
/// replay its retained history. If neither capability is advertised this
/// returns `{ supported: false }` rather than pretending native persistence is
/// available. On success the response includes the mode plus the resumed
/// session's advertised state (`{ modes, models, configOptions }`).
///
/// `session_id` is the agent-native session id (e.g. a Claude Code / Codex
/// session id, as persisted on import); `cwd` is the workspace the session ran in.
pub async fn load_acp_session(
    spawn_cmd: String,
    session_id: String,
    cwd: PathBuf,
) -> anyhow::Result<serde_json::Value> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    // The resumed session's advertised config feeds the same composer pickers the
    // cold probe does, so it gets the same synthesized plan-mode option. Omitting
    // it here would make the pill disappear on exactly the sessions a user resumed.
    let plan_cmd = spawn_cmd.clone();
    let value = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let session_id = session_id.clone();
                let cwd = cwd.clone();
                let plan_cmd = plan_cmd.clone();
                async move {
                    let init: InitializeResponse = cx
                        .send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    let caps = read_agent_caps(&init);
                    if caps.session_resume {
                        let resp: ResumeSessionResponse = cx
                            .send_request(ResumeSessionRequest::new(
                                SessionId::new(session_id.as_str()),
                                cwd.clone(),
                            ))
                            .block_task()
                            .await?;
                        return Ok(serde_json::json!({
                            "supported": true,
                            "mode": "resume",
                            "sessionId": session_id,
                            "modes": resp.modes,
                            "models": resp.models,
                            "configOptions": with_plan_mode_option(&plan_cmd, resp.config_options),
                        }));
                    }
                    // Only attempt load when the agent advertises the capability;
                    // calling it on an agent that lacks it would just error.
                    if !caps.load_session {
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
                        "mode": "load",
                        "sessionId": session_id,
                        "modes": resp.modes,
                        "models": resp.models,
                        "configOptions": with_plan_mode_option(&plan_cmd, resp.config_options),
                    }))
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session resume/load timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session resume/load: {e}"))?;
    Ok(value)
}

/// List the sessions an ACP agent is tracking (ACP `session/list`). Best-effort:
/// an agent that doesn't implement it (the flagship pi spawns fresh per
/// `session/new`) returns `{ sessions: [], unsupported: true }` rather than an
/// error. Returns `{ sessions: [...], nextCursor? }` on success.
pub async fn list_acp_sessions(spawn_cmd: String) -> anyhow::Result<serde_json::Value> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
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
pub async fn close_acp_session(spawn_cmd: String, session_id: String) -> anyhow::Result<bool> {
    let agent = acp_agent_from_spawn(&spawn_cmd)?;
    let closed = tokio::time::timeout(
        ACP_PROBE_TIMEOUT,
        Client
            .builder()
            .connect_with(agent, move |cx: ConnectionTo<Agent>| {
                let session_id = session_id.clone();
                async move {
                    // The `initialize` answer was previously thrown away, which is
                    // why this fired `session/close` at agents that never
                    // advertised it (captured responses show pi-acp, qwen-code and
                    // factory-droid without it) and surfaced the rejection as a
                    // 502. Read the capability instead and report "unsupported"
                    // honestly — a delete that cannot work should not look like a
                    // node that is broken.
                    let init: InitializeResponse = cx
                        .send_request(ryu_initialize_request())
                        .block_task()
                        .await?;
                    if !read_agent_caps(&init).session_close {
                        return Ok(false);
                    }
                    cx.send_request(CloseSessionRequest::new(SessionId::new(
                        session_id.as_str(),
                    )))
                    .block_task()
                    .await?;
                    Ok(true)
                }
            }),
    )
    .await
    .map_err(|_| anyhow::anyhow!("ACP session/close timed out"))?
    .map_err(|e| anyhow::anyhow!("ACP session/close: {e}"))?;
    Ok(closed)
}

/// The startup banner the agent declared in its `session/new` response `_meta`,
/// if any.
///
/// pi-acp computes its prelude (a "## Skills" listing of every skill root it can
/// see — including the hard-coded `~/.agents/skills` — and/or an available-update
/// notice), returns it verbatim under `_meta.piAcp.startupInfo`, and then emits
/// that *same string, whole, as a single* `agent_message_chunk` once the session
/// is live (`sendStartupInfoIfPending`). Capturing it here is what lets
/// [`take_startup_banner`] recognise that chunk **by identity**: the agent told
/// us in-band exactly what it was about to say. That is deliberately not a
/// content heuristic — matching something like `## Skills` would silently
/// swallow a genuine model reply that happened to discuss skills.
///
/// Agents that declare nothing return `None` and the whole path is inert for
/// them, so no other agent's first chunk can ever be reclassified.
fn declared_startup_banner(
    meta: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<String> {
    let text = meta?.get("piAcp")?.get("startupInfo")?.as_str()?;
    (!text.is_empty()).then(|| text.to_owned())
}

/// Whether `text` is this session's still-unconsumed startup banner — consuming
/// it when so, so it can match at most once.
///
/// The consume is the load-bearing part. The ACP instance is **pooled per
/// conversation** and reused for every turn of the chat, so a naive "first agent
/// chunk of the instance" rule would swallow real assistant text on turn 2+.
/// Matching the exact declared string, once, cannot: the banner is emitted
/// before the user has said anything, and after it is taken the slot is empty
/// for the rest of the session.
fn take_startup_banner(pending: &Mutex<Option<String>>, text: &str) -> bool {
    let Ok(mut slot) = pending.lock() else {
        return false;
    };
    if slot.as_deref() != Some(text) {
        return false;
    }
    *slot = None;
    true
}

/// The conventional ACP session-config-option id for model selection. Agents
/// that predate the (unstable) `session/set_model` capability — pi-acp among
/// them — expose the model as a `select` config option under this id instead.
const MODEL_CONFIG_OPTION_ID: &str = "model";

/// Conventional ACP ids used by agents for reasoning effort. The protocol does
/// not standardize this option yet, so agent-level control may need to probe the
/// known ids when the client deliberately omitted its config map.
const EFFORT_CONFIG_OPTION_IDS: &[&str] = &["effort", "thought_level", "reasoning_effort"];

fn is_effort_config_id(config_id: &str) -> bool {
    EFFORT_CONFIG_OPTION_IDS.contains(&config_id)
}

/// Order config-option writes so the model is applied FIRST, keeping every other
/// option in the order it was given.
///
/// Config options are not independent: an agent may validate one against the
/// value of another, and the model is the one every other option is plausibly
/// scoped to. opencode 1.18.5 is the proof — its `effort` values are the current
/// model's effort levels, so writing effort BEFORE the model is rejected
/// (`Invalid params: effort not found: high`) and the later model write resets
/// effort to that model's default. The user's pick is silently lost.
///
/// This is not a nicety: the values arrive as a `HashMap` from the request body,
/// so without an explicit order the pair that goes first is whatever Rust's
/// randomized hashing yields *this process* — the failure is intermittent, which
/// is strictly worse than always broken. Nothing here names an agent; it encodes
/// "the model scopes the rest", which is true of the ACP shape in general.
///
/// Core-synthesized ids never reach an agent (see
/// [`is_core_synthesized_config_id`]) and are dropped here, so both callers get
/// the same filtering.
fn model_first<'a, I>(pairs: I) -> Vec<(&'a String, &'a String)>
where
    I: IntoIterator<Item = (&'a String, &'a String)>,
{
    let mut ordered: Vec<(&String, &String)> = pairs
        .into_iter()
        .filter(|(id, _)| !id.is_empty() && !is_core_synthesized_config_id(id))
        .collect();
    // Stable sort ⇒ everything that is not the model keeps its relative order.
    ordered.sort_by_key(|(id, _)| u8::from(id.as_str() != MODEL_CONFIG_OPTION_ID));
    ordered
}

/// JSON-RPC code for ACP's `ErrorCode::AuthRequired`. Compared numerically
/// because the error arrives from the wire, where only the integer is carried.
const ACP_AUTH_REQUIRED_CODE: i32 = -32000;

/// Turn a client-supplied config value string into the ACP wire value.
///
/// Every layer above this holds config picks as `String` — the desktop persists
/// `{ optionId: value }` to localStorage and posts it on the turn body — but the
/// protocol distinguishes a select's value id from a boolean toggle
/// (`SessionConfigKind::Boolean`, the `unstable_boolean_config` capability).
/// Sending a boolean option the string `"true"` as a VALUE ID is simply wrong:
/// the agent looks for an option whose id is `"true"`, finds none, and rejects
/// the write.
///
/// Exactly `"true"`/`"false"` map to the boolean form; everything else is a
/// value id. The ambiguity that leaves — a SELECT option whose value id is
/// literally the string `"true"` would be sent as a boolean — is accepted
/// knowingly: the alternative is threading the option's declared type through
/// the turn body from a client that has only ever stored strings, and no
/// observed agent names a select value `"true"`. If one ever does, the fix is a
/// typed value on `AcpTurnConfig`, not a heuristic here.
fn config_option_value(raw: &str) -> SessionConfigOptionValue {
    match raw {
        "true" => SessionConfigOptionValue::boolean(true),
        "false" => SessionConfigOptionValue::boolean(false),
        other => SessionConfigOptionValue::value_id(other.to_owned()),
    }
}

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
    // Model first, then the rest in their given order — an option can be scoped
    // to the model (see [`model_first`]), so the reverse order loses the pick.
    // `model_first` also drops the Core-synthesized ids, which never go on the
    // wire: the agent never advertised them and rejects them. `ryu.plan` is
    // applied by prepending the sentinel to the prompt instead
    // (`super::route_acp_stream`), which is the whole reason it exists. Filtered
    // rather than removed from `turn.config_options`, because the model fallback
    // below still has to see the full list to decide whether `model` was already
    // sent explicitly.
    for (config_id, value) in model_first(turn.config_options.iter().map(|(a, b)| (a, b))) {
        let applied: Result<SetSessionConfigOptionResponse, _> = connection
            .send_request_to(
                Agent,
                SetSessionConfigOptionRequest::new(
                    session_id.clone(),
                    config_id.clone(),
                    config_option_value(value),
                ),
            )
            .block_task()
            .await;
        match applied {
            // The response is the FULL refreshed option list, not an ack — the
            // same contract the probe path consumes. Forwarding it is the only
            // way an option that exists only for another option's VALUE reaches
            // the client mid-session (codex reveals its reasoning `effort` list
            // once a model that has one is picked). Discarding it left the
            // pickers showing the set `session/new` happened to answer with.
            Ok(refreshed) => {
                if let Ok(json) = serde_json::to_value(&refreshed.config_options) {
                    let _ = events.send(AcpEvent::ConfigOptions(json));
                }
            }
            Err(e) => {
                tracing::warn!("ACP set_config_option '{config_id}'='{value}' failed: {e}");
            }
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
        if let Err(e) = set_model_result {
            // Already sent as an explicit config option above? Then the fallback
            // would just repeat it — log and stop.
            let already_via_config = turn
                .config_options
                .iter()
                .any(|(id, _)| id == MODEL_CONFIG_OPTION_ID);
            if already_via_config {
                tracing::warn!("ACP set_model '{model}' failed: {e}");
            } else {
                tracing::info!(
                    "ACP set_model '{model}' failed ({e}); retrying as config option '{MODEL_CONFIG_OPTION_ID}'"
                );
                match connection
                    .send_request_to(
                        Agent,
                        SetSessionConfigOptionRequest::new(
                            session_id.clone(),
                            MODEL_CONFIG_OPTION_ID.to_owned(),
                            config_option_value(&model),
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
    }
    if let Some(effort) = turn
        .agent_effort
        .as_deref()
        .map(str::trim)
        .filter(|effort| !effort.is_empty())
    {
        let has_explicit_effort_option = turn
            .config_options
            .iter()
            .any(|(id, _)| is_effort_config_id(id));
        if !has_explicit_effort_option {
            let mut applied = false;
            for config_id in EFFORT_CONFIG_OPTION_IDS {
                let result: Result<SetSessionConfigOptionResponse, _> = connection
                    .send_request_to(
                        Agent,
                        SetSessionConfigOptionRequest::new(
                            session_id.clone(),
                            (*config_id).to_owned(),
                            config_option_value(effort),
                        ),
                    )
                    .block_task()
                    .await;
                match result {
                    Ok(refreshed) => {
                        tracing::info!(
                            "ACP applied agent-requested effort '{effort}' via config option '{config_id}'"
                        );
                        if let Ok(json) = serde_json::to_value(&refreshed.config_options) {
                            let _ = events.send(AcpEvent::ConfigOptions(json));
                        }
                        applied = true;
                        break;
                    }
                    Err(error) => {
                        tracing::debug!(
                            "ACP agent-requested effort option '{config_id}'='{effort}' was rejected: {error}"
                        );
                    }
                }
            }
            if !applied {
                let _ = events.send(AcpEvent::ConfigWarning {
                    field: "effort".to_owned(),
                    requested: effort.to_owned(),
                    message: "agent did not advertise a supported reasoning-effort option"
                        .to_owned(),
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
    // When true, do not reuse the pooled ACP session: this turn must receive the
    // complete rewritten prompt so prior hidden context injections are absent.
    // `permission_scope_id` is still carried on the turn for ACL/cancel scope.
    fresh_session: bool,
    images: Vec<ImagePart>,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    environment: Vec<(String, String)>,
    mcp: Option<Arc<McpRegistry>>,
    allowlist: Option<Vec<String>>,
    // Per-agent Composio action slugs + the effective agent id, threaded into the
    // MCP bridge so Composio reaches the ACP plane and PTC execution is scoped (#477).
    composio_actions: Vec<String>,
    agent_id: String,
    // Per-agent bound Identity Vault profiles (epic #517), threaded into the MCP
    // bridge for the tool-call-time vault consult. Empty = no consult.
    identity_profile_ids: Vec<String>,
    // Optional server-validated Composio connections and conversation scope
    // used by the onboarding profile builder.
    composio_connection_scope:
        Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    conversation_scope: Option<Vec<String>>,
    // User-chosen ACP session controls (permission mode / reasoning effort /
    // model) applied to this turn's session. All agent-reported; see
    // [`AcpTurnConfig`].
    turn: AcpTurnConfig,
    // Stable chat-session key for Core-owned interactive MCP permissions.
    permission_scope_id: Option<String>,
) -> mpsc::UnboundedReceiver<AcpEvent> {
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    crate::acp_runtime::refresh_from_local_file();
    // Resolved concrete agent id for this turn (== the effective/bridge agent id).
    // Folded into the pool key below so the session is keyed by (conversation,
    // agent, spawn_cmd, cwd): switching agents mid-conversation — including the
    // Plane B agent-auto case (spec §2.3) — starts a FRESH session for the newly
    // chosen agent while the previous agent's instance is kept warm in the pool.
    // Keying on the agent id (not just spawn_cmd) is what separates two agent
    // records that happen to share a binary/spawn command but differ in config.
    let agent_key = agent_id.clone();
    // A pooled ACP session retains the first turn's MCP server and bridge
    // credentials. Include every security-sensitive input in the pool key so a
    // later request with a narrower allowlist, different Composio actions, or a
    // different Identity Vault binding cannot inherit the first turn's tools.
    let security_key = acp_security_key(
        &mcp,
        &allowlist,
        &composio_actions,
        &agent_id,
        &identity_profile_ids,
        &composio_connection_scope,
        &conversation_scope,
        &permission_scope_id,
    );
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
        composio_connection_scope,
        conversation_scope,
        permission_scope_id: permission_scope_id.clone(),
        events: events_tx,
    };

    // One live subprocess/connection per CHAT, keyed by the conversation id (Ryu's
    // interactive-permission scope) — chats never share an instance. A message with
    // no conversation id runs an ephemeral, un-pooled instance that dies after the
    // turn. `is_closed()` detects an instance that hit its idle TTL or crashed, so
    // the chat's next message transparently respawns it (auto-restore).
    let conversation = permission_scope_id.unwrap_or_default();
    let environment_key = environment
        .iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("\u{2}");
    let workspace_key = additional_directories
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join("\u{2}");
    if !should_reuse_acp_session(&conversation, fresh_session) {
        // A fresh context turn must not leave the old pooled sender eligible for
        // a later request: drop it before spawning the unpooled instance. The
        // in-flight task retains its own permission scope and drains naturally.
        if fresh_session && !conversation.is_empty() {
            let key = acp_pool_key(
                &conversation,
                &agent_key,
                &spawn_cmd,
                &cwd,
                &workspace_key,
                &environment_key,
                &security_key,
            );
            if let Ok(mut pool) = acp_pool().lock() {
                pool.remove(&key);
            }
        }
        let (turns_tx, turns_rx) = mpsc::unbounded_channel();
        let _ = turns_tx.send(acp_turn); // drop tx → instance ends after this turn
        tokio::spawn(async move {
            crate::acp_runtime::refresh_from_gateway(&reqwest::Client::new()).await;
            let _permit = crate::acp_runtime::acquire().await;
            if let Err(e) = run_acp_instance(
                spawn_cmd,
                cwd,
                additional_directories,
                environment,
                turns_rx,
            )
            .await
            {
                tracing::error!("ACP instance error: {e}");
            }
        });
        return events_rx;
    }

    let key = acp_pool_key(
        &conversation,
        &agent_key,
        &spawn_cmd,
        &cwd,
        &workspace_key,
        &environment_key,
        &security_key,
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
    let additional_directories_task = additional_directories.clone();
    tokio::spawn(async move {
        crate::acp_runtime::refresh_from_gateway(&reqwest::Client::new()).await;
        let _permit = crate::acp_runtime::acquire().await;
        if let Err(e) = run_acp_instance(
            spawn_cmd_task,
            cwd_task,
            additional_directories_task,
            environment,
            turns_rx,
        )
        .await
        {
            tracing::error!("ACP instance error: {e}");
        }
    });
    pool.insert(key, turns_tx);
    events_rx
}

/// A fresh context request is deliberately unpooled even when it has a normal
/// conversation id. The id remains on [`AcpTurn`] so permissions/cancellation
/// stay scoped to the same chat while the model receives no prior ACP session.
fn should_reuse_acp_session(conversation: &str, fresh_session: bool) -> bool {
    !conversation.is_empty() && !fresh_session
}

/// Stable, explicit fingerprint for the security context captured by a pooled
/// ACP session. `None` and `Some([])` remain distinct because the former means
/// "use the default allowlist" while the latter means "offer no tools".
fn acp_security_key(
    mcp: &Option<Arc<McpRegistry>>,
    allowlist: &Option<Vec<String>>,
    composio_actions: &[String],
    agent_id: &str,
    identity_profile_ids: &[String],
    composio_connection_scope: &Option<
        Vec<crate::sidecar::adapters::ComposioConnectionBinding>,
    >,
    conversation_scope: &Option<Vec<String>>,
    permission_scope_id: &Option<String>,
) -> String {
    let mut allowlist = allowlist.clone();
    if let Some(values) = allowlist.as_mut() {
        values.sort();
    }
    let mut composio_actions = composio_actions.to_vec();
    composio_actions.sort();
    let mut identity_profile_ids = identity_profile_ids.to_vec();
    identity_profile_ids.sort();
    let mut composio_connection_scope = composio_connection_scope.clone();
    if let Some(values) = composio_connection_scope.as_mut() {
        values.sort_by(|left, right| left.toolkit.cmp(&right.toolkit).then(left.id.cmp(&right.id)));
    }
    let mut conversation_scope = conversation_scope.clone();
    if let Some(values) = conversation_scope.as_mut() {
        values.sort();
    }
    serde_json::json!({
        "mcp": mcp.as_ref().map(|registry| format!("{:p}", Arc::as_ptr(registry))),
        "allowlist": allowlist,
        "composioActions": composio_actions,
        "agentId": agent_id,
        "identityProfileIds": identity_profile_ids,
        "composioConnectionScope": composio_connection_scope,
        "conversationScope": conversation_scope,
        "permissionScopeId": permission_scope_id,
    })
    .to_string()
}

fn acp_pool_key(
    conversation: &str,
    agent_key: &str,
    spawn_cmd: &str,
    cwd: &PathBuf,
    workspace_key: &str,
    environment_key: &str,
    security_key: &str,
) -> String {
    format!(
		"{conversation}\u{1}{agent_key}\u{1}{spawn_cmd}\u{1}{}\u{1}{workspace_key}\u{1}{environment_key}\u{1}{security_key}",
		cwd.display(),
	)
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
                false,
                vec![],
                cwd,
                vec![],
                vec![],
                None,
                None,
                vec![],
                agent_id.clone(),
                vec![],
                None,
                None,
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
                    // `input` is deliberately not surfaced on this legacy
                    // chunk shape: it exists so the streaming UI can correct a
                    // tool part's arguments in place, and this path has no
                    // parts to correct — it flattens the turn into text chunks.
                    AcpEvent::ToolResult {
                        id, status, output, ..
                    } => {
                        chunks.push(ChatChunk {
                            delta: None,
                            done: false,
                            metadata: Some(serde_json::json!({
                                "toolResult": { "id": id, "status": status, "output": output }
                            })),
                        });
                    }
                    AcpEvent::Error(failure) => {
                        chunks.push(ChatChunk {
                            delta: Some(failure.message),
                            done: false,
                            metadata: Some(serde_json::json!({
                                "error": true,
                                "errorCode": failure.code,
                                "errorTitle": failure.title,
                            })),
                        });
                    }
                    // Reasoning, plan snapshots, mode changes, config write-backs,
                    // permission prompts, command advertisements and usage stats are
                    // surfaced only on the streaming path (route_acp_stream); this
                    // legacy collect path returns final text + tool metadata and runs
                    // non-interactively.
                    AcpEvent::Text(_)
                    | AcpEvent::UserText(_)
                    | AcpEvent::Banner(_)
                    | AcpEvent::Thought(_)
                    | AcpEvent::Plan(_)
                    | AcpEvent::Media { .. }
                    | AcpEvent::ModeChanged(_)
                    | AcpEvent::ConfigWarning { .. }
                    | AcpEvent::AvailableCommands(_)
                    | AcpEvent::Usage(_)
                    | AcpEvent::ToolWidget(_)
                    | AcpEvent::ToolSteps { .. }
                    | AcpEvent::ConfigUpdate(_)
                    | AcpEvent::ConfigOptions(_)
                    | AcpEvent::SessionInfo(_)
                    | AcpEvent::AuthNeeded { .. }
                    | AcpEvent::PermissionRequest { .. }
                    | AcpEvent::QuestionRequest { .. } => {}
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
                title: None,
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
                avatar_glyph: None,
                lifecycle_status: None,
                safety_profile: None,
            }])
        })
    }

    fn create_agent(&self, config: AgentConfig) -> BoxFuture<anyhow::Result<AgentInfo>> {
        Box::pin(async move {
            Ok(AgentInfo {
                id: config.name.clone(),
                name: config.name,
                title: None,
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
                avatar_glyph: None,
                lifecycle_status: None,
                safety_profile: None,
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
    composio_connection_scope:
        Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    conversation_scope: Option<Vec<String>>,
    permission_scope_id: Option<String>,
    events: mpsc::UnboundedSender<AcpEvent>,
}

/// Whether this ACP transport can be handed an MCP server at all.
///
/// pi-acp advertises NO MCP-server support in its `initialize` response, so a
/// server passed to its `session/new` is simply not honored — skip it for pi (the
/// flagship `ryu` engine and bare `acp:pi`). Every other ACP agent supports it.
///
/// A transport fact, deliberately kept separate from the user's preference: no
/// preference value may make Core try to inject into an agent that cannot accept
/// one, which is exactly the mistake defaulting the bridge ON invites.
///
/// ## Verified, not inherited (2026-07-31, pi-acp 0.0.33)
///
/// The claim above was carried as an unsourced comment for long enough that it
/// had to be re-checked against the published artifact rather than trusted. It
/// still holds, and here is what was actually read:
///
/// * `pi-acp@0.0.33`'s `initialize` returns
///   `agentCapabilities.mcpCapabilities = { http: false, sse: false }`, and its
///   `session/new` assigns `params.mcpServers` onto a `PiAcpSession` field that
///   **nothing else in the bundle reads** (the whole `dist/index.js` contains 8
///   occurrences of the substring `mcp`, all of them that one plumbing path).
///   So the servers are accepted, stored, and dropped — silently, with no error
///   the client could react to.
/// * By contrast `@zed-industries/claude-code-acp@0.16.2` advertises
///   `{ http: true, sse: true }` and forwards `params.mcpServers` into the
///   Claude Agent SDK's own `mcpServers` option, and
///   `@zed-industries/codex-acp@0.16.0` (probed live) returns
///   `{ http: true, sse: false, acp: false }`. Both honor the bridge.
///
/// ## Why this is a spawn-string match and NOT `mcpCapabilities.http`
///
/// The temptation is real: Ryu's bridge is injected by
/// `agent-client-protocol`'s `SessionBuilder::with_mcp_server`, which pushes a
/// `McpServer::Http` entry (an `acp:<uuid>` pseudo-URL served back over the ACP
/// connection), and `agent-client-protocol-schema` 0.12.0 documents
/// `McpCapabilities::http` as, verbatim, "Agent supports `McpServer::Http`".
/// Semantically it is *exactly* the right question, and the three probes above
/// all agree with the string match.
///
/// It is still the wrong gate, for a reason that is about the wire format rather
/// than the semantics: every field of `McpCapabilities` is `#[serde(default)]
/// bool`, so **an agent that omits `agentCapabilities` (or omits
/// `mcpCapabilities` within it) is indistinguishable from one that answered
/// `false`**. Gating on it would silently drop the bridge for every agent that
/// under-advertises — Gemini's experimental ACP mode, OpenClaw, any
/// `acp-exec:` BYO agent, any older build — converting "your tools work" into
/// "your tools quietly vanished", which is the same class of failure this whole
/// round exists to remove. The string match only ever *withholds* the bridge from
/// the one transport we have positively verified cannot use it.
///
/// The capability is still read: [`run_acp_instance`] logs a WARN when it injects
/// the bridge into an agent that advertised no HTTP MCP support, so a
/// silently-inert bridge leaves a trace instead of looking like a tool the model
/// merely chose not to call.
///
/// Watch item: codex-acp returned an `acp: false` member inside `mcpCapabilities`
/// that does **not** exist in `agent-client-protocol-schema` 0.12.0. That reads
/// like a future ACP revision promoting `acp:`-over-HTTP to a first-class
/// transport with its own capability bit. If that lands, re-verify this whole
/// comment — it is the one change that would make the analysis above obsolete.
fn acp_bridge_supported(spawn_cmd: &str) -> bool {
    !spawn_cmd.contains("pi-acp")
}

/// How — if at all — Ryu's registered tools can reach a given ACP agent.
///
/// Ryu has **two** unrelated mechanisms for this, and until now nothing named
/// them together, so the bridge code read as "pi has no tools" when the truth is
/// "pi has tools by another road entirely":
///
/// * [`RyuToolAccess::Bridge`] — the in-process MCP server injected into
///   `session/new` ([`super::mcp_bridge::build_ryu_mcp_server`]). Every ACP agent
///   except pi-acp.
/// * [`RyuToolAccess::PiExtension`] — the `ryu-mcp.ts` **Pi extension**
///   (`crate::pi_config::ensure_pi_mcp_extension`), which registers
///   `ryu_call_tool` / `ryu_list_tools` inside Pi and POSTs to Core's
///   `/api/mcp/tools/call`. Reaches the same allowlist-gated registry as the
///   bridge, over HTTP instead of in-process. Only the **managed** Pi has it:
///   the extension is written into Ryu's isolated config dir and only a Pi
///   spawned with `PI_CODING_AGENT_DIR` pointed there will load it.
/// * [`RyuToolAccess::None`] — a pi-acp spawn that is *not* the managed Pi, i.e.
///   bare `acp:pi` (the user's own `~/.pi`) and any custom agent bound to the
///   `acp:pi` engine. No bridge (unsupported transport) and no extension (Ryu
///   never writes into the user's own Pi config dir — see
///   `pi_config::ensure_pi_mcp_extension` for why that restraint is deliberate
///   rather than an oversight). Such an agent cannot call a single Ryu tool.
///
/// Derived from the spawn command alone: pure, unit-testable, and — unlike the
/// agent's `initialize` response — knowable *before* the subprocess is started,
/// which is what lets [`probe_acp_config`] report it for the picker.
///
/// This answers "which road exists", never "is it switched on". Whether a
/// `Bridge` agent actually receives the bridge additionally depends on the
/// `agent-tool-bridge` preference ([`acp_tool_bridge_enabled`]); whether a
/// `PiExtension` agent's calls succeed depends on the `RYU_MCP_*` env the spawn
/// command carries. Keeping the two apart is the point: a user who turns the
/// bridge off has made a choice, whereas `None` is a structural fact they were
/// never told about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RyuToolAccess {
    /// In-process MCP server injected into `session/new`.
    Bridge,
    /// The managed Pi's `ryu-mcp` extension calling Core's HTTP tool API.
    PiExtension,
    /// Neither mechanism applies — this agent cannot reach Ryu's tools.
    None,
}

impl RyuToolAccess {
    /// Stable wire string for clients (`probe_acp_config`'s `ryuToolAccess`).
    /// Kebab-case, matching the rest of the probe payload's JSON conventions.
    fn as_str(self) -> &'static str {
        match self {
            Self::Bridge => "bridge",
            Self::PiExtension => "pi-extension",
            Self::None => "none",
        }
    }
}

/// Classify a spawn command into the tool-access road it can use.
///
/// The managed-Pi test is the same pair of substrings `run_acp_instance` uses to
/// recognise the flagship (`pi-acp` + `PI_CODING_AGENT_DIR`, present on both
/// platforms — POSIX inline `VAR=…`, Windows `set VAR=…`; see
/// [`ryu_pi_acp_cmd`]). `is_managed_pi` is derived from this function rather than
/// re-spelled, so the two predicates cannot drift into disagreeing about which
/// process is the flagship.
fn ryu_tool_access(spawn_cmd: &str) -> RyuToolAccess {
    if acp_bridge_supported(spawn_cmd) {
        return RyuToolAccess::Bridge;
    }
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        return RyuToolAccess::PiExtension;
    }
    RyuToolAccess::None
}

/// The full decision for whether an ACP session gets Ryu's MCP tool bridge:
/// the transport must support it AND the user must not have opted this agent out.
///
/// Both halves live in one named function so a call site cannot take the
/// preference and forget the transport guard. The transport term is FIRST and
/// short-circuits, so pi-acp is answered without ever consulting the preference
/// map — the `is_tool_bridge_enabled` default is ON, and an agent that cannot
/// accept a bridge must not be given one just because nobody configured it.
///
/// Note the two gates read different things about "this agent": the transport
/// half looks at the spawn command, the preference half at the client-selected
/// agent id (`AcpTurn::agent_id`, the same id the pool keys sessions on). An
/// empty agent id — a turn that named no agent — hits the ON default, matching the
/// pre-split behaviour for such turns as far as the user can tell (they had no
/// agent record to toggle either way).
fn acp_tool_bridge_enabled(spawn_cmd: &str, agent_id: &str) -> bool {
    acp_bridge_supported(spawn_cmd) && crate::agent_routing::is_tool_bridge_enabled(agent_id)
}

/// Run one chat's ACP instance: spawn the subprocess ONCE, `initialize` ONCE,
/// build the Ryu MCP bridge ONCE and the ACP session ONCE, then serve every queued
/// turn on that same session until the chat goes idle (the Gateway ACP idle timeout) or the pool
/// drops the queue. Because the live session retains the conversation, the FIRST
/// turn sends the full prompt (with history) and every subsequent turn sends only
/// its delta message — re-sending the full prompt would double-count the transcript.
/// The subprocess spawn, `initialize`, user-MCP load, and session build are all
/// amortized across a chat's turns.
pub async fn run_acp_instance(
    spawn_cmd: String,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    environment: Vec<(String, String)>,
    turns_rx: mpsc::UnboundedReceiver<AcpTurn>,
) -> anyhow::Result<()> {
    // The spawn command is consumed below (`AcpAgent::from_str` then the move into
    // the session closure), but the bridge decision also needs it — and it must be
    // taken with BOTH halves in one place (`acp_tool_bridge_enabled`) so the
    // transport guard cannot be forgotten at this call site. One small clone per
    // pooled instance, i.e. once per chat, buys that.
    let bridge_spawn_cmd = spawn_cmd.clone();
    // Claude Code (via `claude-code-acp`) otherwise loads the session cwd's project
    // `.mcp.json` + local settings on every `session/new`, spawning that folder's
    // MCP servers before the first token (measured: 62s -> 8s once constrained) and
    // on the ungoverned path. Restrict the Claude Agent SDK to user-level settings
    // via claude-code-acp's `_meta.claudeCode.options` passthrough (applied at
    // `build_session_from`, per turn below).
    let is_claude_code =
        spawn_cmd.contains("claude-code-acp") || spawn_cmd.contains("claude-agent-acp");
    // Which road (if any) Ryu's tools can take to this agent. Recorded once per
    // pooled instance — i.e. once per chat's subprocess — because until now the
    // `None` case was completely silent: an agent that structurally cannot reach a
    // single configured tool looked, from every log and every surface, exactly like
    // an agent that simply chose not to call one.
    let tool_access = ryu_tool_access(&spawn_cmd);
    match tool_access {
        RyuToolAccess::None => tracing::warn!(
            access = tool_access.as_str(),
            "ACP agent has NO access to Ryu tools: this is a pi-acp transport (which does not \
             honor session/new mcpServers) spawned WITHOUT Ryu's managed Pi config dir, so it \
             gets neither the MCP bridge nor the ryu-mcp Pi extension. Use the flagship `ryu` \
             agent for Ryu tools on Pi."
        ),
        _ => tracing::debug!(access = tool_access.as_str(), "ACP tool access"),
    }
    // The flagship managed `ryu` agent: pi-acp pointed at Ryu's ISOLATED config dir
    // (`PI_CODING_AGENT_DIR` → `~/.ryu/pi-agent`). Only this Pi reads the managed
    // `auth.json`, so it is the only agent whose subscription OAuth logins we
    // proactively refresh before a turn — never bare `acp:pi` (the user's own
    // `~/.pi`) or any other engine. Both platforms carry the `PI_CODING_AGENT_DIR`
    // substring (POSIX inline `VAR=…`, Windows `set VAR=…`), see `ryu_pi_acp_cmd`.
    //
    // Derived from `ryu_tool_access` rather than re-spelling the two substrings:
    // `PiExtension` IS "this is the managed Pi", and one predicate that two call
    // sites read cannot drift the way two copies of it can.
    let is_managed_pi = tool_access == RyuToolAccess::PiExtension;

    if is_managed_pi {
        // Resolve every enabled plugin's `contributes.lsp_servers` and drop the
        // arbitrated table into the managed Pi config dir, where the Ryu-LSP
        // extension picks it up. It MUST happen here and not in `ryu_pi_acp_cmd`:
        // that function is sync and state-free by design, and the enabled-plugin
        // set only exists behind the published `ServerState`.
        //
        // Cadence: once per pooled instance, i.e. once per Pi process, which is
        // exactly when Pi reads its extensions. A live Pi cannot be told about a
        // new language server, so enabling an LSP-contributing plugin mid-chat
        // lands on the NEXT spawn for that chat — matching Claude Code, where
        // servers are likewise read at startup. Do not move this into the per-turn
        // loop below to "fix" that; there is nothing to send that would make a
        // running Pi re-read, so it would be pure disk churn.
        crate::lsp::ensure_lsp_servers_materialized().await;

        // Same cadence, same argument, one directory over: project every enabled
        // plugin's `contributes.pi_extensions` onto the managed Pi's `extensions/`
        // folder, adding what is enabled and DELETING what is not. The removal half
        // is why it is a reconcile and not an enable hook — Pi auto-discovers that
        // folder, so an uninstalled plugin's file would otherwise keep loading
        // forever.
        crate::pi_config::app_extensions::ensure_pi_extensions_materialized().await;
    }

    let parsed_agent = acp_agent_from_spawn(&spawn_cmd)?;
    let server = match parsed_agent.into_server() {
        agent_client_protocol::schema::McpServer::Stdio(mut stdio) => {
            for (name, value) in environment {
                stdio
                    .env
                    .push(agent_client_protocol::schema::EnvVariable::new(name, value));
            }
            agent_client_protocol::schema::McpServer::Stdio(stdio)
        }
        other => other,
    };
    let agent = AcpAgent::new(server)
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
                let first_turn = match tokio::time::timeout(
                    crate::acp_runtime::settings().idle_timeout,
                    turns_rx.recv(),
                )
                .await
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

                // Build the Ryu MCP bridge ONCE for this chat. When enabled, the
                // session gets Ryu's universal governed bridge (Ghost/Shadow/Composio/
                // registry tools reached through the allowlist-gated `call_tool` path
                // — AC3 governance); when not, the agent runs with its own MCP only
                // (`ryu_server = None`). Loading user-level MCP happens here ONCE —
                // the whole point of building the session a single time (see below).
                //
                // This gate is `agent-tool-bridge` (default ON), NOT the egress
                // `agent-gateway-routing` toggle it used to share. See
                // `acp_tool_bridge_enabled` and the `agent_routing` module docs.
                //
                // The agent's OWN advertised capability is not the gate (see
                // `acp_bridge_supported` for why `mcpCapabilities.http` cannot be
                // trusted to distinguish "no" from "did not say"), but a mismatch is
                // worth a line in the log: the bridge Ryu injects is an
                // `McpServer::Http` entry, so an agent that advertised no HTTP MCP
                // support will most likely ignore it, and the model will then look
                // like it declined to use tools it was never actually offered.
                if acp_tool_bridge_enabled(&bridge_spawn_cmd, &first_turn.agent_id)
                    && !agent_caps.mcp_http
                {
                    tracing::warn!(
                        agent = %first_turn.agent_id,
                        "ACP agent advertised no HTTP MCP support (mcpCapabilities.http=false) \
                         but is being given Ryu's MCP bridge; if it ignores session/new \
                         mcpServers the agent will silently have no Ryu tools"
                    );
                }
                let ryu_server = if acp_tool_bridge_enabled(
                    &bridge_spawn_cmd,
                    &first_turn.agent_id,
                ) {
                    match &first_turn.mcp {
                        Some(registry) => {
                            super::mcp_bridge::build_ryu_mcp_server(
                                Arc::clone(registry),
                                first_turn.allowlist.clone(),
                                first_turn.composio_actions.clone(),
                                first_turn.agent_id.clone(),
                                first_turn.identity_profile_ids.clone(),
                                first_turn.composio_connection_scope.clone(),
                                first_turn.conversation_scope.clone(),
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
                // survives idle gaps even when the bridge is absent.
                let _instance_tx_keepalive = instance_tx;

                let session_cwd = cwd.clone();
                let mut session_roots = vec![session_cwd.clone()];
                session_roots.extend(additional_directories.clone());
                tracing::info!(
                    cwd = %session_cwd.display(),
                    additional_roots = session_roots.len().saturating_sub(1),
                    "ACP build_session"
                );

                // Per-instance client-hosted terminal registry (serves the agent's
                // `terminal/*` requests) + the default cwd for spawned commands.
                let terminals: TerminalRegistry =
                    Arc::new(tokio::sync::Mutex::new(BTreeMap::new()));
                // Build the ACP session ONCE for the whole chat, injecting Ryu's
                // registered tools via the SDK's `with_mcp_server` mechanism. The
                // bridge registers an in-process MCP server so the agent's own MCP
                // client connects back to it, calling Ryu tools through the registry's
                // allowlist-gated `call_tool` path. Building the session (and thus
                // loading user MCP) ONCE — then reusing it across every turn — is the
                // win: the live session already holds the conversation, so subsequent
                // turns send only the delta message (no history re-send).
                //
                // `ryu_server` is `None` for pi-acp and for agents the user has
                // explicitly opted out of the bridge, so those sessions are created
                // without it.
                let mut new_session = NewSessionRequest::new(session_cwd)
                    .additional_directories(additional_directories.clone());
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

                // `session/new` is the first authoritative native-session id. Persist
                // it immediately for conversation-bound ACP resume/load; later
                // `session_info_update` notifications enrich the same binding with
                // agent-provided title/activity metadata on the Gateway path.
                if let (Some(conversation_id), Some(store)) = (
                    first_turn.permission_scope_id.as_deref(),
                    crate::server::agent_sync::global_store(),
                ) {
                    let agent_id = first_turn.agent_id.as_str();
                    let engine = agent_id.strip_prefix("acp:").unwrap_or(agent_id);
                    let native_session_id = session.session_id().to_string();
                    if let Err(error) = store
                        .record_acp_binding_async(
                            conversation_id,
                            agent_id,
                            engine,
                            &native_session_id,
                            Some(&cwd),
                            &agent_caps_json(&agent_caps),
                        )
                        .await
                    {
                        tracing::debug!(
                            "agent sync: initial ACP binding ledger update skipped: {error:#}"
                        );
                    }
                }

                // The banner this session announced it was about to emit (pi-acp's
                // startup skills/commands listing and/or update notice). Held for
                // the life of the session and taken by the FIRST agent chunk that
                // matches it exactly, which routes that chunk to `AcpEvent::Banner`
                // instead of the assistant reply. `None` for every agent that
                // declares no such banner. See `declared_startup_banner`.
                let startup_banner: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(
                    declared_startup_banner(session.meta().as_ref()),
                ));

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
                // Baseline for the session-cumulative → per-turn subtraction (see
                // `AcpUsageSnapshot`). Session-scoped on purpose: `turn_usage` below
                // is rebuilt per turn and cannot hold it.
                let mut prev_usage = AcpUsageSnapshot::default();
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
                        None => match tokio::time::timeout(
                            crate::acp_runtime::settings().idle_timeout,
                            turns_rx.recv(),
                        )
                        .await
                        {
                            Ok(Some(t)) => t,
                            _ => {
                                tracing::info!(
                                    idle_timeout_minutes = crate::acp_runtime::settings()
                                        .idle_timeout_minutes,
                                    "ACP session idle timeout reached; subprocess will be reaped"
                                );
                                break;
                            }
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
                    // Captures a fatal `session/prompt` failure (the request itself
                    // erroring — e.g. no model configured / provider unreachable, which
                    // surfaces as a transport error or timeout). Without this the error
                    // was dropped inside `on_receiving_result` and the turn closed with
                    // a normal `finish`, passing off any pre-failure agent banner as a
                    // successful reply. Read after the update loop to emit a real error
                    // frame instead.
                    // `(code, message)`, not just the message: an expired OAuth token
                    // arrives as JSON-RPC -32000 (`ErrorCode::AuthRequired`) and has to be
                    // told apart from an unreachable provider, because the two need
                    // opposite things from the user.
                    let turn_error: Arc<Mutex<Option<(i32, String)>>> =
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
                    let error_capture = Arc::clone(&turn_error);
                    session
                        .connection()
                        .send_request_to(
                            Agent,
                            PromptRequest::new(session.session_id().clone(), blocks),
                        )
                        .on_receiving_result(move |result| async move {
                            match result {
                                Ok(resp) => {
                                    let resp: PromptResponse = resp;
                                    tracing::debug!(
                                        stop_reason = ?resp.stop_reason,
                                        "ACP prompt completed"
                                    );
                                    // Capture the turn's final token totals (ACP
                                    // unstable usage). `None` when the agent reports
                                    // no usage.
                                    if let Some(usage) = resp.usage.as_ref() {
                                        if let Ok(v) = serde_json::to_value(usage) {
                                            if let Ok(mut g) = usage_capture.lock() {
                                                *g = Some(v);
                                            }
                                        }
                                    }
                                }
                                // The prompt request itself failed. Historically this
                                // error was swallowed (`result?` dropped it and the
                                // turn ended clean). Capture it so the update loop can
                                // surface a real error frame instead of a silent close.
                                Err(e) => {
                                    tracing::error!(error = %e, "ACP prompt result: Err");
                                    if let Ok(mut g) = error_capture.lock() {
                                        *g = Some((i32::from(e.code), e.to_string()));
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
                            let tx_question = tx.clone();
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
                            let term_roots = session_roots.clone();
                            // Workspace roots for the confined fs handlers + the
                            // terminal exec-scan's agent attribution.
                            let fs_roots_read = session_roots.clone();
                            let fs_roots_write = session_roots.clone();
                            let term_scan_agent = scan_agent.clone();
                            let question_conversation = perm_conversation.clone();
                            // The notification callback is `move`; capture only the
                            // immutable ACP id so the live session remains available
                            // to the outer read loop.
                            let session_identifier = session.session_id().clone();
                            // Per-message handle on the session's undelivered startup
                            // banner (the notification closure below is `move`).
                            let banner_slot = Arc::clone(&startup_banner);
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
                                                    // The agent's own startup banner
                                                    // is chrome, not a reply — it is
                                                    // emitted before the user has
                                                    // said anything. Route it off the
                                                    // assistant path so it is neither
                                                    // buffered into `reply` nor
                                                    // persisted as an assistant row.
                                                    let event = if take_startup_banner(
                                                        &banner_slot,
                                                        &t.text,
                                                    ) {
                                                        AcpEvent::Banner(t.text)
                                                    } else {
                                                        AcpEvent::Text(t.text)
                                                    };
                                                    let _ = tx_chunk.send(event);
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
                                            // Nested sub-step path: a tool result
                                            // that declares `details.ryuSteps` gets
                                            // those steps fanned out by mod.rs into
                                            // synthetic `<id>:<n>` child tool parts.
                                            // A SIBLING of the widget block above,
                                            // not nested in it — this has nothing to
                                            // do with the widget MCP registry, and
                                            // it keys on the same kind of generic
                                            // `details.*` marker (no agent id).
                                            if let Some(steps) = pi_subagent_steps(
                                                update.fields.raw_output.as_ref(),
                                            ) {
                                                // The final answer rides only the
                                                // TERMINAL update: emitting it while
                                                // the child is still working would
                                                // publish a truncated answer that
                                                // the id-keyed dedupe then pins.
                                                let final_answer = matches!(
                                                    update.fields.status.as_ref(),
                                                    Some(ToolCallStatus::Completed)
                                                )
                                                .then(|| {
                                                    pi_subagent_answer(
                                                        update.fields.raw_output.as_ref(),
                                                    )
                                                })
                                                .flatten();
                                                let _ = tx_chunk.send(AcpEvent::ToolSteps {
                                                    parent_id: update.tool_call_id.to_string(),
                                                    steps: steps.clone(),
                                                    final_answer,
                                                });
                                            }
                                            // Session-config write-back: a tool result
                                            // that declares `details.ryuConfig` asks the
                                            // CLIENT to update the config values it holds
                                            // and re-sends every turn. ALSO A SIBLING of
                                            // the two blocks above — in particular NOT
                                            // nested in the widget block, which is gated
                                            // on an MCP registry this has nothing to do
                                            // with. Generic `details.*` marker, no agent
                                            // id and no tool name (AGENTS.md).
                                            if let Some(updates) = pi_config_updates(
                                                update.fields.status.as_ref(),
                                                update.fields.raw_output.as_ref(),
                                            ) {
                                                let _ =
                                                    tx_chunk.send(AcpEvent::ConfigUpdate(updates));
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
                                            //
                                            // `cost` is documented as the SESSION's
                                            // cumulative spend, so it ships under a
                                            // `session`-prefixed key and is labelled
                                            // as such in the UI — presenting it as
                                            // this turn's cost would bill turn 1 five
                                            // times over by turn 5.
                                            let mut frame = serde_json::json!({
                                                "used": u.used,
                                                "total": u.size,
                                                "done": false,
                                            });
                                            if let (Some(cost), Some(obj)) =
                                                (u.cost.as_ref(), frame.as_object_mut())
                                            {
                                                obj.insert(
                                                    "sessionCostAmount".to_owned(),
                                                    serde_json::json!(cost.amount),
                                                );
                                                obj.insert(
                                                    "sessionCostCurrency".to_owned(),
                                                    serde_json::json!(cost.currency),
                                                );
                                            }
                                            let _ = tx_chunk.send(AcpEvent::Usage(frame));
                                        }
                                        SessionUpdate::ConfigOptionUpdate(u) => {
                                            // The agent re-published its config
                                            // options unprompted. No agent is
                                            // known to send this today, so this
                                            // arm is insurance: without it the
                                            // frame fell into the catch-all
                                            // below and the desktop's pickers
                                            // would quietly disagree with the
                                            // agent's real state.
                                            if let Ok(json) =
                                                serde_json::to_value(&u.config_options)
                                            {
                                                let _ = tx_chunk
                                                .send(AcpEvent::ConfigOptions(json));
                                            }
                                        }
                                        SessionUpdate::SessionInfoUpdate(u) => {
                                            // Session metadata is a real ACP update, not
                                            // agent text. Preserve the partial-update shape
                                            // (including explicit nulls) for the desktop.
                                            if let Ok(mut json) = serde_json::to_value(&u) {
                                                if let Some(object) = json.as_object_mut() {
                                                    // The protocol update does not carry the
                                                    // session id, but the binding ledger needs
                                                    // the id returned by session/new. Enrich the
                                                    // event at the transport boundary rather
                                                    // than fabricating a native history file.
                                                    object.insert(
                                                        "sessionId".to_owned(),
                                                        serde_json::json!(session_identifier),
                                                    );
                                                    object.insert(
                                                        "capabilities".to_owned(),
                                                        agent_caps_json(&agent_caps),
                                                    );
                                                }
                                                let _ = tx_chunk.send(AcpEvent::SessionInfo(json));
                                            }
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
                                // ── structured user input ─────────────────────
                                // Unlike a ToolCall notification, elicitation is
                                // an ACP request. Keep the responder open while
                                // the HTTP question route resolves the shared
                                // waiter; responding here is what lets the
                                // agent's in-flight tool call continue.
                                .if_request(async move |req: ElicitationCreateRequest, responder| {
                                    let question_id = elicitation_tool_call_id(&req);
                                    let input = elicitation_question_input(&req, &question_id);
                                    let rx = register_question(
                                        question_conversation.clone(),
                                        question_id.clone(),
                                    );
                                    let _ = tx_question.send(AcpEvent::QuestionRequest {
                                        tool_call_id: question_id.clone(),
                                        input,
                                    });
                                    let result = tokio::time::timeout(
                                        std::time::Duration::from_secs(600),
                                        rx,
                                    )
                                    .await
                                    .ok()
                                    .and_then(Result::ok);
                                    let response = match result {
                                        Some(answers) => ElicitationCreateResponse {
                                            action: "accept".to_owned(),
                                            content: Some(serde_json::json!({
                                                "answers": answers,
                                            })),
                                        },
                                        None => {
                                            cancel_question(&question_conversation, &question_id);
                                            ElicitationCreateResponse::cancelled()
                                        }
                                    };
                                    responder.respond(response)?;
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
                                            // Headless: auto-approve the first offered
                                            // option so tool use works without a UI —
                                            // GOVERNED by the scan above, which is armed
                                            // by default (`exec_approval_enabled`) and
                                            // fail-closed: a Deny or ApprovalRequired
                                            // verdict already rejected before this arm.
                                            // Only an operator's explicit
                                            // `RYU_EXEC_APPROVAL_MODE=off` restores the
                                            // old ungoverned auto-approve.
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
                                    let text =
                                        read_text_file_scoped_in_roots(&req, &fs_roots_read);
                                    responder.respond(ReadTextFileResponse::new(text))?;
                                    Ok(())
                                })
                                .await
                                // ── fs/write_text_file ─────────────────────────
                                .if_request(async move |req: WriteTextFileRequest, responder| {
                                    // A refused (out-of-workspace) or failed write is
                                    // logged; the ACP response shape carries no error
                                    // channel, so the agent sees the write as a no-op.
                                    if let Err(e) =
                                        write_text_file_scoped_in_roots(&req, &fs_roots_write)
                                    {
                                        tracing::warn!("fs/write_text_file: {e}");
                                    }
                                    responder.respond(WriteTextFileResponse::new())?;
                                    Ok(())
                                })
                                .await
                                // ── terminal/create ────────────────────────────
                                .if_request(async move |req: CreateTerminalRequest, responder| {
                                    match terminal_create(
                                        &terms_read,
                                        &req,
                                        &term_roots,
                                        &term_scan_agent,
                                    )
                                    .await
                                    {
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

                    // Surface a swallowed provider failure. When the `session/prompt`
                    // request errored (no model configured / provider unreachable —
                    // seen as a transport error or ~timeout), the turn produced no real
                    // completion. Emit a real error frame instead of the normal
                    // usage-done/`finish` so the client gets an actionable failure
                    // rather than a silent close that passes off a pre-failure agent
                    // banner as a successful reply. `AcpEvent::Error` (mod.rs) tears the
                    // turn down (error/finish/[DONE] frames + `set_run_status("failed")`),
                    // so we skip the usage-done frame and loop back for the next turn.
                    if let Some((code, detail)) =
                        turn_error.lock().ok().and_then(|g| g.clone())
                    {
                        tracing::warn!(code, detail = %detail, "ACP turn failed; surfacing error frame");
                        // An expired OAuth token is NOT a missing model. Telling the
                        // user to "configure a model" when their subscription login
                        // lapsed sends them to a settings page that cannot fix it,
                        // which is what this branch exists to stop. `AuthNeeded`
                        // carries the agent id so the client can offer the agent's own
                        // advertised login methods and re-run the turn afterwards.
                        if code == ACP_AUTH_REQUIRED_CODE {
                            let _ = tx.send(AcpEvent::AuthNeeded {
                                // Instance-scoped: the ACP session is pinned to one
                                // agent, so this is the agent whose login lapsed.
                                agent_id: widget_agent_id.clone(),
                                message: detail.clone(),
                            });
                            // The data part above carries the RECOVERY (the toast and
                            // its login button); it does not end the stream. The turn
                            // still has to be torn down, because it genuinely failed —
                            // only `AcpEvent::Error` emits error/finish/[DONE] and
                            // moves the run off "running". Without this the composer
                            // would sit in streaming state with a Stop button and no
                            // way to send: a hang, which is precisely the confusion
                            // this branch exists to remove.
                            let _ = tx.send(AcpEvent::Error(AcpFailure {
                                code: "auth_required".to_owned(),
                                title: "Agent login expired".to_owned(),
                                message: "Your agent login expired. Log in again, then re-send your message."
                                    .to_owned(),
                            }));
                            if let Ok(mut g) = sink.lock() {
                                *g = None;
                            }
                            continue;
                        }
                        let active_provider = if is_managed_pi {
                            Some(crate::pi_config::current().provider)
                        } else {
                            None
                        };
                        let failure =
                            classify_prompt_failure(active_provider.as_deref(), &detail);
                        let _ = tx.send(AcpEvent::Error(failure));
                        if let Ok(mut g) = sink.lock() {
                            *g = None;
                        }
                        continue;
                    }

                    // Final usage frame for the turn (`done: true`). Carries the
                    // turn's token totals when the agent reported them
                    // (`PromptResponse.usage`, camelCase: input/output/total/
                    // thought/cachedRead/cachedWrite); the frame is emitted even when
                    // it did not, so the desktop's duration/speed UI (computed from
                    // mod.rs's own timer) still works. Note: claude-code-acp does not
                    // currently emit ACP usage, so in practice this frame carries only
                    // `done: true` and Core-side timing.
                    //
                    // Every counter the protocol defines is SESSION-CUMULATIVE, so the
                    // per-turn keys carry `current − previous` and the raw cumulative
                    // figure ships separately as `sessionTotalTokens`. `used` stays
                    // cumulative BY DESIGN: it is context-window occupancy (what the
                    // context ring and the workspace context panel read), not this
                    // turn's spend.
                    let mut usage_payload = serde_json::Map::new();
                    usage_payload.insert("done".to_owned(), serde_json::Value::Bool(true));
                    if let Some(u) = turn_usage.lock().ok().and_then(|g| g.clone()) {
                        let cumulative = AcpUsageSnapshot::from_value(&u);
                        let turn_delta = cumulative.delta_from(&prev_usage);
                        prev_usage = cumulative;
                        let mut put = |key: &str, value: Option<u64>| {
                            if let Some(v) = value {
                                usage_payload.insert(key.to_owned(), v.into());
                            }
                        };
                        put("promptTokens", turn_delta.input_tokens);
                        put("completionTokens", turn_delta.output_tokens);
                        put("totalTokens", turn_delta.total_tokens);
                        put("thoughtTokens", turn_delta.thought_tokens);
                        put("cachedReadTokens", turn_delta.cached_read_tokens);
                        put("cachedWriteTokens", turn_delta.cached_write_tokens);
                        put("sessionTotalTokens", cumulative.total_tokens);
                        for key in [
                            "context_window",
                            "contextWindow",
                            "current_usage",
                            "currentUsage",
                            "cost",
                            "costAmount",
                            "costCurrency",
                            "currency",
                        ] {
                            if let Some(value) = u.get(key) {
                                usage_payload.insert(key.to_owned(), value.clone());
                            }
                        }
                        // Context occupancy fallback for agents that send no live
                        // `UsageUpdate`: the cumulative total is the best proxy the
                        // turn-end response offers.
                        if let Some(v) = cumulative.total_tokens {
                            usage_payload.insert("used".to_owned(), v.into());
                        } else if let (Some(p), Some(c)) =
                            (cumulative.input_tokens, cumulative.output_tokens)
                        {
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
        [
            "content",
            "new_string",
            "newString",
            "edits",
            "new_source",
            "newSource",
        ]
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

fn patch_deletes_file_in_value(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(object) => {
            for key in ["patch", "diff"] {
                if object
                    .get(key)
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(ryu_deletion_guard::patch_deletes_file)
                {
                    return true;
                }
            }
            object.values().any(patch_deletes_file_in_value)
        }
        serde_json::Value::Array(items) => items.iter().any(patch_deletes_file_in_value),
        _ => false,
    }
}

/// Run an ACP tool call through the gateway command-approval scanner. Scans the
/// shell command for exec tools, else a synthesized `"write <path>"` for
/// file-mutating tools, so native file tools are governed too (not just shell
/// exec). An explicit `apply_patch` deletion marker is checked locally before
/// extraction because it may not carry a path/content shape the generic write
/// synthesizer recognizes. `Allow` means no scannable mutation was recovered;
/// the permanent-deletion guard remains active even when pattern approval is off.
async fn acp_exec_scan_verdict(tool_call: &serde_json::Value, agent: &str) -> ExecScanOutcome {
    if patch_deletes_file_in_value(tool_call)
        || extract_exec_command(tool_call)
            .as_deref()
            .is_some_and(ryu_deletion_guard::patch_deletes_file)
    {
        return ExecScanOutcome::Deny(
            "permanent file deletion through apply_patch is blocked by Ryu; use the host Trash or Recycle Bin command instead".to_owned(),
        );
    }
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
        // Carried, never interpreted here: an update that fills in arguments the
        // opening `tool_call` frame did not have yet is the ONLY way the desktop
        // ever learns them (see `AcpEvent::ToolResult::input`). `None` and an
        // empty object are both "nothing new"; mod.rs is what decides that, so
        // this stays a verbatim pass-through.
        input: fields.raw_input.clone(),
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

/// Extract the nested sub-steps a tool result declared it performed internally.
///
/// A tool result may carry `details.ryuSteps = [{ name, input, output?, status },
/// …]`; pi-acp preserves a tool result's `details` verbatim as the ACP
/// `rawOutput`. ACP models tool calls as a flat list with no parent/child
/// relation, so this `details` marker is the only correlation channel that
/// exists — the same seam [`pi_widget_binding`]'s `details.ryuWidget` already
/// uses.
///
/// Keyed on the generic `details.*` marker and **never** on `agent_id`: this
/// module is agent-neutral ACP plumbing, so any producer that stamps the marker
/// gets the fan-out and no agent's name is compiled in here.
///
/// DIVERGES from [`pi_widget_binding`] on exactly one point, deliberately: there
/// is **no** [`ToolCallStatus::Completed`] gate. A widget renders once, from a
/// final result, so a partial `tool_execution_update` must not reach it. Steps
/// are the opposite — the producer appends one entry per nested call and re-emits
/// the growing array on every `tool_call_update`, so gating on `Completed` would
/// collapse a live nested transcript into a single frame at the very end.
/// Idempotency is handled downstream instead, by synthetic child part id.
fn pi_subagent_steps(raw_output: Option<&serde_json::Value>) -> Option<&Vec<serde_json::Value>> {
    raw_output?.get("details")?.get("ryuSteps")?.as_array()
}

/// Extract a client-side session-config write-back from a `ToolCallUpdate`.
///
/// A tool result may carry `details.ryuConfig = { "<configId>": "<valueId>" }`;
/// pi-acp preserves a tool result's `details` verbatim as the ACP `rawOutput`.
/// This is the agent→client direction of the session-config channel: a client that
/// PERSISTS a config pick re-sends it on every later turn, so an agent-side action
/// that invalidates the pick (approving an exit from a mode the pick turns on, say)
/// needs a way to say "stop sending that". Returns the requested pairs, or `None`
/// when the update is not a completed result carrying a well-formed marker.
///
/// Keyed on the generic `details.*` marker — the same seam
/// [`pi_widget_binding`]'s `details.ryuWidget` and [`pi_subagent_steps`]'
/// `details.ryuSteps` already use — and **never** on a tool name or an `agent_id`:
/// this module is agent-neutral ACP plumbing, so no producer's vocabulary is
/// compiled in here. The config ids and values are opaque strings forwarded
/// verbatim; Core does not know which options a client holds and must not
/// second-guess them.
///
/// Gates on [`ToolCallStatus::Completed`], like [`pi_widget_binding`] and unlike
/// [`pi_subagent_steps`]: pi-acp also emits in-progress `tool_call_update` frames
/// carrying a partial `rawOutput`, and a write-back is a one-shot instruction, not
/// a growing snapshot. Acting on a partial frame would flip a user's picker while
/// the tool was still running — and, worse, before the tool could still fail.
///
/// Non-string values are dropped per key rather than failing the whole marker (a
/// config value is a `valueId` by ACP's own typing); a marker that yields no usable
/// pair at all returns `None`, so no empty event is emitted.
fn pi_config_updates(
    status: Option<&ToolCallStatus>,
    raw_output: Option<&serde_json::Value>,
) -> Option<std::collections::BTreeMap<String, String>> {
    if !matches!(status, Some(ToolCallStatus::Completed)) {
        return None;
    }
    let updates: std::collections::BTreeMap<String, String> = raw_output?
        .get("details")?
        .get("ryuConfig")?
        .as_object()?
        .iter()
        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_owned())))
        .collect();
    (!updates.is_empty()).then_some(updates)
}

/// The parent tool result's own answer text, for the synthetic `<parent>:out`
/// `TaskOutput` part minted in mod.rs.
///
/// Read from the tool-result envelope pi-acp forwards as `rawOutput`
/// (`{ content: [{ type: "text", text }, …], details: { … } }`) — deliberately
/// NOT from a second `details.*` marker. A marker the producing extension does
/// not happen to stamp would make the final-answer part silently absent (the
/// "shipped and simply not there at runtime" failure class), whereas `content`
/// is the one field every tool result already has.
///
/// Returns `None` when the envelope carries no text at all, so the caller emits
/// no empty `TaskOutput` row.
fn pi_subagent_answer(raw_output: Option<&serde_json::Value>) -> Option<String> {
    let mut text = String::new();
    for block in raw_output?.get("content")?.as_array()? {
        if let Some(t) = block.get("text").and_then(serde_json::Value::as_str) {
            text.push_str(t);
        }
    }
    (!text.is_empty()).then_some(text)
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

/// Resolve `binary` to its real on-disk path by walking `PATH` and following
/// symlinks.
///
/// `binary_in_path` answers *whether* a CLI is installed; this answers *which
/// install owns it*, which is what decides whether Ryu can upgrade it. A global
/// npm install lands as `<prefix>/bin/x` symlinked into `lib/node_modules/...`,
/// so a resolved path containing a `node_modules` component is npm-managed and
/// `npm install -g <pkg>@latest` upgrades it. Anything else (a vendor's own
/// installer, homebrew, volta/mise, a curl script) is not ours to move.
pub fn resolve_in_path(binary: &str) -> Option<std::path::PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    let ext = if cfg!(target_os = "windows") {
        ".exe"
    } else {
        ""
    };
    for dir in std::env::split_paths(&path_var) {
        for candidate in [dir.join(format!("{binary}{ext}")), dir.join(binary)] {
            if candidate.is_file() {
                return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
            }
        }
    }
    None
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
pub fn ryu_pi_acp_cmd(user_jwt: Option<&str>) -> Option<String> {
    ryu_pi_acp_cmd_for_agent(user_jwt, None, None, None, None)
}

/// Build the managed Pi command with an agent-scoped OpenAI base URL.
///
/// ACP agents own their HTTP client, so the agent id is carried in the
/// Gateway path and bound to `x-ryu-agent-id` at ingress. `None` preserves the
/// legacy unscoped endpoint for callers without an agent identity.
pub fn ryu_pi_acp_cmd_for_agent(
    user_jwt: Option<&str>,
    agent_id: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    host_conversation_id: Option<&str>,
) -> Option<String> {
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
    let gateway_v1 = openai_gateway_v1(agent_id);
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
    let core_token = crate::node_token::active_token()
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
        let mcp_env = pi_mcp_extension_env(
            true,
            user_jwt,
            composio_connection_scope,
            conversation_scope,
            host_conversation_id,
        );
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
        let mcp_env = pi_mcp_extension_env(
            false,
            user_jwt,
            composio_connection_scope,
            conversation_scope,
            host_conversation_id,
        );
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
/// format) are NOT covered here. Claude Code is now governable via the gateway's
/// Anthropic passthrough (`claude_gateway_cmd`), but Gemini CLI reads
/// `GOOGLE_GEMINI_BASE_URL` / `CODE_ASSIST_ENDPOINT` (Google wire format) — never
/// `OPENAI_BASE_URL` — and the gateway registers no Google-format ingress (only
/// Anthropic + OpenAI-Responses passthroughs, `apps/gateway/src/passthrough`), so
/// pointing those at the gateway would 404 and break Gemini rather than govern it.
/// Governing Gemini needs a new gateway Google passthrough — a follow-on unit,
/// out of scope here. See `docs/routing-planes.md` (chat-egress coverage matrix).
#[cfg(target_os = "windows")]
fn codex_acp_cmd() -> String {
    codex_acp_cmd_for_agent(None)
}

#[cfg(target_os = "windows")]
fn codex_acp_cmd_for_agent(agent_id: Option<&str>) -> String {
    let gateway_v1 = openai_gateway_v1(agent_id);
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
    let safety_home = crate::codex_config::safety_home();
    format!(
        "cmd /c set \"CODEX_HOME={}\"&& set OPENAI_BASE_URL={gateway_v1}&& set OPENAI_API_KEY={token}&& npx -y @agentclientprotocol/codex-acp@latest",
        safety_home.to_string_lossy()
    )
}

#[cfg(not(target_os = "windows"))]
fn codex_acp_cmd() -> String {
    codex_acp_cmd_for_agent(None)
}

#[cfg(not(target_os = "windows"))]
fn codex_acp_cmd_for_agent(agent_id: Option<&str>) -> String {
    let gateway_v1 = openai_gateway_v1(agent_id);
    // On a remote data plane (WS1) the shared "ryu-local" literal is rejected by
    // the hosted multi-tenant gateway; log + degrade here (this is the rarely-used
    // Codex API-key path, and the call site is a registry-entry builder that cannot
    // propagate a Result) — the fleet's 401 is the fail-closed backstop.
    let token = crate::sidecar::gateway::gateway_bearer().unwrap_or_else(|e| {
        tracing::error!(error = %e, "codex_acp_cmd: no gateway bearer on remote data plane; hosted gateway will reject");
        "ryu-local".to_owned()
    });
    // POSIX: prefix the command with inline env var assignments. The safety home
    // is materialized by `agent_route` immediately before this command is used;
    // keeping it in the command also prevents an inherited user CODEX_HOME from
    // silently bypassing Ryu's isolated hook/rules layer.
    let safety_home = crate::codex_config::safety_home();
    format!(
        "CODEX_HOME='{}' OPENAI_BASE_URL={gateway_v1} OPENAI_API_KEY={token} npx -y @agentclientprotocol/codex-acp@latest",
        safety_home.to_string_lossy().replace('\'', "'\\''")
    )
}

/// The three env vars the managed Pi's extensions need to reach Core, rendered for
/// the target shell (`windows` ⇒ `set VAR=…&& ` chaining, else POSIX inline).
///
/// **Two consumers now, not one.** `ryu-mcp.ts` calls `/api/mcp/tools/call` with
/// them, and `ryu-plan.ts` calls `/api/exec/scan` — the gateway command gate for
/// the flagship's `bash`, which fails OPEN at that hop. So renaming or dropping
/// one of these vars does not merely cost the agent its tools: it silently
/// removes a safety gate, with the extension logging into a stderr stream pi-acp
/// discards. The `RYU_MCP_` prefix is historical; treat it as the Pi-extension
/// channel, not as MCP's.
///
/// **Extracted because it has two callers and they drifted.** Pi cannot accept the
/// in-process MCP bridge (`pi-acp` advertises `mcpCapabilities {http:false,sse:false}`
/// and drops `session/new`'s `mcpServers`), so this extension is its ONLY road to
/// Ryu's tools. There are two spawn paths to the same agent — [`ryu_pi_acp_cmd`] for
/// the managed binary and the PATH fallback in `super::ryu_agent_route` — and only the
/// first injected these. The fallback's Pi silently used the extension's compiled-in
/// defaults instead: `http://127.0.0.1:7980` (the wrong port under any non-release
/// `RYU_PROFILE`) and an empty bearer. The agent still started and answered; it just
/// never had a tool.
///
/// Keeping the rendering here, rather than the values, is deliberate: a caller that
/// re-derives `core_url` itself is free to derive it differently, which is how the
/// drift happened. Both callers now emit the same bytes or neither does.
pub(crate) fn pi_mcp_extension_env(
    windows: bool,
    user_jwt: Option<&str>,
    composio_connection_scope: Option<&[crate::sidecar::adapters::ComposioConnectionBinding]>,
    conversation_scope: Option<&[String]>,
    host_conversation_id: Option<&str>,
) -> String {
    let core_url = crate::sidecar::gateway::core_self_url();
    let mcp_agent_id = crate::registry::DEFAULT_AGENT_ID;
    let core_token = crate::node_token::active_token()
        .map(|v| v.trim().to_owned())
        .filter(|s| !s.is_empty());
    let mut env = if windows {
        format!("set RYU_MCP_CORE_URL={core_url}&& set RYU_MCP_AGENT_ID={mcp_agent_id}&& ")
    } else {
        format!("RYU_MCP_CORE_URL={core_url} RYU_MCP_AGENT_ID={mcp_agent_id} ")
    };
    if let Some(t) = &core_token {
        if windows {
            env.push_str(&format!("set RYU_MCP_CORE_TOKEN={t}&& "));
        } else {
            env.push_str(&format!("RYU_MCP_CORE_TOKEN={t} "));
        }
    }
    if let Some(jwt) = user_jwt.map(str::trim).filter(|value| !value.is_empty()) {
        if windows {
            env.push_str(&format!("set RYU_MCP_USER_JWT={jwt}&& "));
        } else {
            env.push_str(&format!("RYU_MCP_USER_JWT={jwt} "));
        }
    }
    if let Some(conversation_id) = host_conversation_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if windows {
            env.push_str(&format!(
                "set RYU_MCP_HOST_CONVERSATION_ID={conversation_id}&& "
            ));
        } else {
            env.push_str(&format!(
                "RYU_MCP_HOST_CONVERSATION_ID={conversation_id} "
            ));
        }
    }
    if composio_connection_scope.is_some() || conversation_scope.is_some() {
        use base64::Engine as _;

        let payload = serde_json::json!({
            "profile_composio_connection_scope": composio_connection_scope,
            "profile_conversation_scope": conversation_scope,
        });
        if let Ok(encoded) = serde_json::to_vec(&payload).map(|bytes| {
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
        }) {
            if windows {
                env.push_str(&format!("set RYU_MCP_PROFILE_SCOPE={encoded}&& "));
            } else {
                env.push_str(&format!("RYU_MCP_PROFILE_SCOPE={encoded} "));
            }
        }
    }
    env
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
/// Applied only when [`crate::claude_config::is_gateway_routing`] is on (the default
/// for new/routable ACP agents; explicit direct-egress opt-out);
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
    openai_gateway_cmd_for_agent(spawn_cmd, None)
}

/// Wrap an OpenAI-compatible ACP command with an agent-scoped Gateway URL.
pub fn openai_gateway_cmd_for_agent(
    spawn_cmd: &str,
    agent_id: Option<&str>,
) -> anyhow::Result<String> {
    let gateway_v1 = openai_gateway_v1(agent_id);
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

/// Return the OpenAI-compatible Gateway base URL, optionally scoped to an
/// agent. OpenAI clients append `/chat/completions` to this value. Remote
/// managed gateways also receive Core's bearer-bound proof so the fleet can
/// safely accept the agent identity for a dynamic `rgw_` credential.
pub fn openai_gateway_v1(agent_id: Option<&str>) -> String {
    let gateway_base = crate::sidecar::gateway::gateway_url();
    let agent_suffix = agent_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(|id| {
            let proof_suffix = if crate::sidecar::gateway::remote_data_plane() {
                crate::sidecar::gateway::gateway_agent_proof(id)
                    .ok()
                    .map(|proof| format!("/{proof}"))
                    .unwrap_or_default()
            } else {
                String::new()
            };
            format!("/agents/{}{proof_suffix}", urlencoding::encode(id))
        })
        .unwrap_or_default();
    format!("{}/v1{agent_suffix}", gateway_base.trim_end_matches('/'))
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
/// Applied only when [`crate::codex_config::is_gateway_routing`] is on (the default
/// for new/routable ACP agents; explicit direct-egress opt-out).
pub fn codex_acp_gateway_cmd() -> anyhow::Result<String> {
    // (Re)write the isolated CODEX_HOME (provider config + refreshed auth) and
    // resolve its path. Failure is returned so the route refuses to start Codex
    // instead of falling back to the user's ungoverned CODEX_HOME.
    let home = crate::codex_config::ensure_gateway_home()?;
    #[cfg(target_os = "windows")]
    {
        Ok(format!(
            "cmd /c set \"CODEX_HOME={home}\"&& npx -y @zed-industries/codex-acp"
        ))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(format!(
            "CODEX_HOME='{}' npx -y @zed-industries/codex-acp",
            home.replace('\'', "'\\''")
        ))
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
                // ── ACP agents on agentclientprotocol.com/get-started/agents with no ──
                // CDN registry entry yet — curated so the Store catalog and spawn
                // support them. Each ships its own ACP server over a documented CLI
                // command. All of them make their own provider calls (Ryu cannot inject
                // `OPENAI_BASE_URL`), so every entry carries `gateway_bypass: true`.
                AcpAgentEntry {
                    id: "acp:prime".into(),
                    registry_id: None,
                    name: "Prime Agent".into(),
                    description: "Prime Agent — Prime Intellect's self-improving RLM agent (subagents, quality gates, IPython) over ACP".into(),
                    detect_binary: Some("prime-agent"),
                    install_hint: "Install via `curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh`; ACP runs via `prime-agent --mode acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("prime-agent --mode acp"),
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
                    id: "acp:openhands".into(),
                    registry_id: None,
                    name: "OpenHands".into(),
                    description: "OpenHands — All Hands AI's autonomous coding agent (formerly OpenDevin) over ACP".into(),
                    detect_binary: Some("openhands"),
                    install_hint: "Install the OpenHands CLI (`pip install openhands` or the install script at docs.openhands.dev/openhands/usage/cli/installation), configure an LLM with /settings; ACP runs via `openhands acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("openhands acp"),
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
                    id: "acp:code-assistant".into(),
                    registry_id: None,
                    name: "Code Assistant".into(),
                    description: "Code Assistant — open-source Rust coding agent with a native GUI, terminal and ACP modes".into(),
                    detect_binary: Some("code-assistant"),
                    install_hint: "Grab the prebuilt build from the Code Assistant releases page (github.com/stippi/code-assistant/releases); ACP runs via `code-assistant acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("code-assistant acp"),
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
                    id: "acp:construct".into(),
                    registry_id: None,
                    name: "Construct".into(),
                    description: "Construct — tmux-for-agent-fleets daemon whose ACP server drives construct sessions".into(),
                    detect_binary: Some("construct"),
                    install_hint: "Install via `curl -fsSL https://raw.githubusercontent.com/construct-worlds/construct/main/install.sh | sh`; ACP runs via `construct acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("construct acp"),
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
                    id: "acp:blackbox".into(),
                    registry_id: None,
                    name: "Blackbox CLI".into(),
                    description: "Blackbox AI CLI — natural-language coding agent over ACP".into(),
                    detect_binary: Some("blackbox"),
                    install_hint: "Install via `curl -fsSL https://blackbox.ai/install.sh | bash` (Windows: `iex (irm https://blackbox.ai/install.ps1)`) and run `blackbox configure`; ACP runs via `blackbox --experimental-acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("blackbox --experimental-acp"),
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
                    id: "acp:bub".into(),
                    registry_id: None,
                    name: "Bub".into(),
                    description: "Bub — bubble-gum Rust coding agent exposed over ACP via the bub-acp-server plugin".into(),
                    detect_binary: Some("bub"),
                    install_hint: "Install `bub`, then `bub install bub-acp-server@main`; ACP runs via `bub acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("bub acp"),
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
                    id: "acp:raxol".into(),
                    registry_id: None,
                    name: "Raxol".into(),
                    description: "Raxol — Elixir/OTP runtime whose `raxol acp` serves the axol coding agent over ACP".into(),
                    detect_binary: Some("raxol"),
                    install_hint: "Install the raxol CLI (mix archive / Hex package); ACP runs via `raxol acp`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("raxol acp"),
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
                    id: "acp:localharness".into(),
                    registry_id: None,
                    name: "localharness".into(),
                    description: "localharness — self-sovereign agent SDK/binary that serves each agent over ACP".into(),
                    detect_binary: Some("localharness"),
                    install_hint: "Install via `cargo install localharness`; ACP runs via `localharness acp --as <name>` (an on-chain agent identity must exist)".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("localharness acp"),
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
                    id: "acp:kaagum".into(),
                    registry_id: None,
                    name: "Kaagum".into(),
                    description: "Kaagum — tiny security-focused Guile agent; the `kaagum` binary speaks ACP natively".into(),
                    detect_binary: Some("kaagum"),
                    install_hint: "Install the `kaagum` Guix package, then pass `--api-key-command` and `--model` (e.g. `kaagum --api-key-command='pass openrouter.ai' --model=anthropic/claude-sonnet-4.6`)".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("kaagum"),
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
                    id: "acp:docker-agent".into(),
                    registry_id: None,
                    name: "Docker Agent".into(),
                    description: "Docker Agent (cagent) — Docker's agentic builder/runtime, exposed over ACP".into(),
                    detect_binary: Some("docker-agent"),
                    install_hint: "Install `docker-agent` (`brew install docker-agent` or a GitHub release, symlinked into ~/.docker/cli-plugins); ACP runs via `docker agent serve acp <config>`".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("docker agent serve acp"),
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
                    id: "acp:agentpool".into(),
                    registry_id: None,
                    name: "AgentPool".into(),
                    description: "AgentPool — orchestrator that serves ACP and bridges external ACP agents".into(),
                    detect_binary: None,
                    install_hint: "Self-fetches via uvx (install `uv` from https://docs.astral.sh/uv/); ACP runs via `uvx agentpool@latest serve-acp <config>` (a config file or URL is required)".into(),
                    transport: AgentTransport::Acp {
                        spawn_cmd: npx_cmd("uvx agentpool@latest serve-acp"),
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

    /// Resolve an agent principal for authorization. Prefix matching is useful
    /// for display/legacy routing, but it must never turn `ryu-forged` into the
    /// registered `ryu` record and inherit its posture.
    pub fn find_exact(&self, agent_id: &str) -> Option<&AcpAgentEntry> {
        self.entries.iter().find(|entry| entry.id == agent_id)
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
                    title: None,
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
                    avatar_glyph: None,
                    lifecycle_status: None,
                    safety_profile: None,
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

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn codex_acp_spawns_through_the_os_runner() {
        let agent = acp_agent_from_spawn("npx -y @zed-industries/codex-acp@latest")
            .expect("Codex must have a supported OS runner");
        match agent.server() {
            agent_client_protocol::schema::McpServer::Stdio(stdio) => {
                assert_eq!(
                    stdio.command,
                    std::env::current_exe().expect("current executable")
                );
                assert_eq!(
                    stdio.args.first().map(String::as_str),
                    Some(crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG)
                );
                assert_eq!(stdio.args.get(1).map(String::as_str), Some("--"));
                assert_eq!(stdio.args.get(2).map(String::as_str), Some("npx"));
            }
            _ => panic!("Codex ACP must use stdio transport"),
        }
    }

    #[test]
    fn managed_openrouter_credit_failure_has_managed_recovery_copy() {
        let failure = classify_prompt_failure(
            Some(crate::pi_config::MANAGED_OPENROUTER_ID),
            "HTTP 402: organization credit balance exhausted (insufficient_credits)",
        );
        assert_eq!(failure.code, "insufficient_credits");
        assert_eq!(failure.title, "Ryu credits exhausted");
        assert!(failure.message.contains("Settings > Credits"));
        assert!(failure.message.contains("BYOK or local model"));
    }

    #[test]
    fn openrouter_byok_credit_failure_has_provider_recovery_copy() {
        let failure = classify_prompt_failure(
            Some("openrouter"),
            "OpenRouter API error 402: no credits (provider_payment_required)",
        );
        assert_eq!(failure.code, "provider_payment_required");
        assert_eq!(failure.title, "OpenRouter credits exhausted");
        assert!(failure.message.contains("OpenRouter account"));
        assert!(failure.message.contains("another provider"));
    }

    #[test]
    fn openrouter_transport_failure_is_not_mislabeled_as_credit_exhaustion() {
        let failure = classify_prompt_failure(Some("openrouter"), "connection refused");
        assert_eq!(failure.code, "agent_error");
        assert_eq!(failure.title, "Request failed");
        assert!(!failure.message.to_lowercase().contains("credits exhausted"));
    }

    fn pi_acp_cmd_gated() -> String {
        pi_acp_cmd()
    }

    /// The `session/new` meta shape pi-acp actually returns, so the reader is
    /// pinned to the real wire form and not to a shape someone imagined.
    fn session_meta(startup_info: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert(
            "piAcp".to_owned(),
            serde_json::json!({ "startupInfo": startup_info }),
        );
        m
    }

    #[test]
    fn a_declared_startup_banner_is_read_from_the_session_meta() {
        let banner = "pi v1.2.3\n---\n\n## Skills\n- a\n- b";
        assert_eq!(
            declared_startup_banner(Some(&session_meta(banner.into()))),
            Some(banner.to_owned())
        );
    }

    /// Every way an agent can decline to declare one. All of them must leave the
    /// slot empty, because an empty slot is what makes this whole path inert for
    /// agents other than pi-acp — no other agent's first chunk may ever be
    /// reclassified as chrome.
    #[test]
    fn no_declared_banner_leaves_the_slot_empty() {
        // Quiet startup with no update available: pi sends the key as null.
        assert_eq!(
            declared_startup_banner(Some(&session_meta(serde_json::Value::Null))),
            None
        );
        // Declared but empty is not a banner either.
        assert_eq!(
            declared_startup_banner(Some(&session_meta("".into()))),
            None
        );
        // An agent that namespaces nothing under `piAcp`.
        assert_eq!(declared_startup_banner(Some(&serde_json::Map::new())), None);
        // An agent that returns no `_meta` at all (claude-code-acp, codex, …).
        assert_eq!(declared_startup_banner(None), None);
    }

    /// The banner is matched by IDENTITY against what the agent declared, and it
    /// is consumed on the way through.
    ///
    /// The consume is the guard against the pooled-session trap: one ACP instance
    /// serves every turn of a chat, so anything shaped like "the first agent
    /// chunk is chrome" would eat a real answer on turn 2. Here the same text
    /// arriving again is plain assistant text.
    #[test]
    fn the_startup_banner_is_taken_at_most_once() {
        let banner = "## Skills\n- one";
        let slot = Mutex::new(Some(banner.to_owned()));
        assert!(
            take_startup_banner(&slot, banner),
            "first match is the banner"
        );
        assert!(
            !take_startup_banner(&slot, banner),
            "a later chunk with the same text is a real reply, not chrome"
        );
    }

    /// A real reply must never be swallowed, however much it looks like the
    /// banner — which is exactly why this matches the declared string instead of
    /// sniffing for a `## Skills` heading.
    #[test]
    fn a_reply_that_merely_discusses_skills_is_not_the_banner() {
        let slot = Mutex::new(Some("pi v1.2.3\n---\n\n## Skills\n- a".to_owned()));
        for reply in [
            "## Skills\n- a", // the banner's tail, not the banner
            "Sure — here are your skills:\n\n## Skills\n- a",
            "pi v1.2.3\n---\n\n## Skills\n- a\n", // one trailing newline off
        ] {
            assert!(
                !take_startup_banner(&slot, reply),
                "must stay assistant text: {reply:?}"
            );
        }
        // …and the banner itself still matches afterwards: a near miss must not
        // consume the slot and let the real banner through as a persisted reply.
        assert!(take_startup_banner(
            &slot,
            "pi v1.2.3\n---\n\n## Skills\n- a"
        ));
    }

    /// The headline bug this subtraction exists for: ACP `Usage` is
    /// session-cumulative, so turn 3 was reporting turns 1-3's tokens as its own
    /// (and a tok/s several times the true rate, because the denominator was one
    /// turn's wall clock).
    #[test]
    fn cumulative_session_usage_becomes_a_per_turn_delta() {
        let turn1 = AcpUsageSnapshot::from_value(&serde_json::json!({
            "inputTokens": 1000_u64,
            "outputTokens": 200_u64,
            "totalTokens": 1200_u64,
        }));
        let delta1 = turn1.delta_from(&AcpUsageSnapshot::default());
        assert_eq!(delta1.input_tokens, Some(1000));
        assert_eq!(delta1.output_tokens, Some(200));

        let turn2 = AcpUsageSnapshot::from_value(&serde_json::json!({
            "inputTokens": 2500_u64,
            "outputTokens": 350_u64,
            "totalTokens": 2850_u64,
        }));
        let delta2 = turn2.delta_from(&turn1);
        assert_eq!(delta2.input_tokens, Some(1500), "turn 2's own input only");
        assert_eq!(delta2.output_tokens, Some(150), "turn 2's own output only");
        assert_eq!(delta2.total_tokens, Some(1650));
    }

    /// An absent optional counter must stay absent — never become a zero the UI
    /// would render as a real "0 tokens" reading.
    #[test]
    fn absent_usage_counters_stay_absent_through_the_delta() {
        let snap = AcpUsageSnapshot::from_value(&serde_json::json!({
            "inputTokens": 10_u64,
            "outputTokens": 5_u64,
            "totalTokens": 15_u64,
        }));
        let delta = snap.delta_from(&AcpUsageSnapshot::default());
        assert_eq!(delta.thought_tokens, None);
        assert_eq!(delta.cached_read_tokens, None);
        assert_eq!(delta.cached_write_tokens, None);
        // An agent reporting nothing at all yields nothing at all.
        let empty = AcpUsageSnapshot::from_value(&serde_json::json!({}));
        assert_eq!(empty.delta_from(&snap), AcpUsageSnapshot::default());
    }

    /// A cumulative counter can go DOWN (agent restart, context compaction, a new
    /// session behind the same chat). Clamping the delta to zero would silently
    /// drop a whole turn's tokens, so the current value re-baselines instead.
    #[test]
    fn a_decreasing_cumulative_counter_rebaselines_instead_of_clamping() {
        let previous = AcpUsageSnapshot::from_value(&serde_json::json!({
            "inputTokens": 9000_u64,
            "outputTokens": 800_u64,
            "totalTokens": 9800_u64,
        }));
        let after_compaction = AcpUsageSnapshot::from_value(&serde_json::json!({
            "inputTokens": 400_u64,
            "outputTokens": 60_u64,
            "totalTokens": 460_u64,
        }));
        let delta = after_compaction.delta_from(&previous);
        assert_eq!(delta.input_tokens, Some(400));
        assert_eq!(delta.output_tokens, Some(60));
        assert_eq!(delta.total_tokens, Some(460));
        // And the plain helper agrees on both directions.
        assert_eq!(acp_usage_delta(Some(7), Some(3)), Some(4));
        assert_eq!(acp_usage_delta(Some(3), Some(7)), Some(3));
        assert_eq!(acp_usage_delta(None, Some(7)), None);
        assert_eq!(acp_usage_delta(Some(7), None), Some(7));
    }

    /// An agent that declared nothing can never have a chunk reclassified.
    #[test]
    fn an_empty_slot_never_matches() {
        let slot: Mutex<Option<String>> = Mutex::new(None);
        assert!(!take_startup_banner(&slot, ""));
        assert!(!take_startup_banner(&slot, "hello"));
    }

    /// A probe that FAILS must still be cached — the whole bug this path exists
    /// to fix.
    ///
    /// Before the cache stored failures, nothing was recorded on the error path,
    /// so every read re-spawned the agent and re-waited the 30s ceiling. Measured
    /// against a live node, three consecutive `GET /api/agents/ryu/acp-config`
    /// calls took 30.7s each and 502'd every time; the desktop retries twice per
    /// mount, so opening a chat could burn 90s before showing an empty picker.
    /// Asserting on the cache entry (rather than on wall-clock) keeps this
    /// deterministic while still driving the real `probe_acp_config` path.
    #[tokio::test]
    async fn a_failed_probe_is_cached_instead_of_respawning_the_agent() {
        // A binary that cannot exist, so the probe fails fast and spawns nothing
        // that outlives the test.
        let spawn_cmd = "ryu-nonexistent-acp-agent-for-tests --stdio".to_owned();
        let cwd = std::env::temp_dir();

        assert!(
            probe_cache::lookup(&spawn_cmd).is_none(),
            "precondition: nothing cached for this command yet"
        );

        let first = probe_acp_config(spawn_cmd.clone(), cwd.clone()).await;
        assert!(first.is_err(), "a missing binary cannot be probed");

        let hit = probe_cache::lookup(&spawn_cmd)
            .expect("the failure must be cached, not silently dropped");
        assert!(hit.outcome.is_err(), "the cached outcome is the failure");
        assert!(!hit.stale, "a just-recorded failure is still fresh");

        // The second read is served from that entry rather than re-spawning.
        assert!(probe_acp_config(spawn_cmd.clone(), cwd).await.is_err());

        // …and an auth transition drops it, so signing in doesn't wait out the TTL.
        probe_cache::invalidate(&spawn_cmd);
        assert!(probe_cache::lookup(&spawn_cmd).is_none());
    }

    // ── MCP tool bridge gate (split from egress routing) ───────────────────
    //
    // These assert on `acp_tool_bridge_enabled` — the SAME function
    // `run_acp_instance` calls — rather than re-deriving the rule, so a change to
    // the composition (or to the default) fails here instead of only in a live
    // session nobody runs in CI.

    /// The headline behaviour change: an ACP agent nobody has configured now gets
    /// the bridge. Before the split this required opting into gateway EGRESS,
    /// which is why an installed agent had no Ryu tools out of the box.
    #[test]
    fn fresh_acp_agent_gets_the_tool_bridge() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::agent_routing::set_bridge_from_json("");
        // Egress explicitly OFF for this agent — the bridge must not care.
        crate::agent_routing::set_from_json(r#"{"acp:goose": false}"#);
        assert!(acp_tool_bridge_enabled("npx -y goose-acp", "acp:goose"));
        assert!(!crate::agent_routing::is_gateway_routing("acp:goose"));
    }

    /// The opt-out must be reachable. A default-ON gate whose `false` never lands
    /// is not a toggle, it is a constant with a misleading name.
    #[test]
    fn explicit_opt_out_withholds_the_bridge() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        crate::agent_routing::set_bridge_from_json(r#"{"acp:goose": false}"#);
        assert!(!acp_tool_bridge_enabled("npx -y goose-acp", "acp:goose"));
        // Scoped to that agent id only.
        assert!(acp_tool_bridge_enabled("npx -y goose-acp", "acp:opencode"));
    }

    /// pi-acp advertises no MCP-server support, so the transport guard must win
    /// over the (now ON) preference default in BOTH orders of configuration —
    /// otherwise defaulting the bridge on would make Core inject into an agent
    /// that cannot accept it. Covers the managed `ryu` engine's command too,
    /// which carries `PI_CODING_AGENT_DIR` but is still pi-acp.
    #[test]
    fn pi_acp_never_gets_the_bridge_despite_the_on_default() {
        let _guard = crate::agent_routing::TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // Unconfigured (the default-ON path) …
        crate::agent_routing::set_bridge_from_json("");
        assert!(!acp_tool_bridge_enabled(&pi_acp_cmd_gated(), "acp:pi"));
        // … and explicitly opted IN, which must not override a transport fact.
        crate::agent_routing::set_bridge_from_json(r#"{"ryu": true, "acp:pi": true}"#);
        assert!(!acp_tool_bridge_enabled(&pi_acp_cmd_gated(), "acp:pi"));
        assert!(!acp_bridge_supported(&pi_acp_cmd_gated()));
        let managed = format!("PI_CODING_AGENT_DIR=/tmp/pi {}", pi_acp_cmd_gated());
        assert!(!acp_tool_bridge_enabled(&managed, "ryu"));
        // A non-pi transport with the same preference IS enabled, proving the
        // rejection above came from the transport guard and not a stuck map.
        assert!(acp_tool_bridge_enabled("npx -y claude-code-acp", "ryu"));
    }

    // ── Tool-access classification (which road, if any) ───────────────────
    //
    // These pin the CLASSIFIER, not any claim about the pi-acp npm package: a
    // Rust unit test cannot observe what `dist/index.js` does with
    // `params.mcpServers`. That claim lives in `acp_bridge_supported`'s doc
    // comment, with the version and date it was verified against.

    /// Every non-pi transport takes the in-process bridge — the road the whole
    /// `mcp_bridge` module exists to serve.
    #[test]
    fn non_pi_transports_are_classified_as_bridge() {
        for cmd in [
            "npx -y claude-code-acp",
            "npx -y @zed-industries/codex-acp",
            "npx -y goose-acp",
            "/usr/local/bin/my-own-agent --acp",
        ] {
            assert_eq!(ryu_tool_access(cmd), RyuToolAccess::Bridge, "{cmd}");
        }
    }

    /// The flagship. Its spawn command is pi-acp (so no bridge) but carries
    /// `PI_CODING_AGENT_DIR`, which is what makes the managed Pi load the
    /// `ryu-mcp` extension — the road that gives the DEFAULT agent its tools.
    /// Asserted on BOTH platform spellings of the env prefix, because the Windows
    /// `set VAR=…&&` form is the one a POSIX-only substring test would miss.
    #[test]
    fn managed_pi_is_classified_as_pi_extension() {
        let posix = format!("PI_CODING_AGENT_DIR=/tmp/pi-agent {}", pi_acp_cmd_gated());
        assert_eq!(ryu_tool_access(&posix), RyuToolAccess::PiExtension);
        let windows = "cmd /c set PI_CODING_AGENT_DIR=C:\\pi&& npx -y pi-acp";
        assert_eq!(ryu_tool_access(windows), RyuToolAccess::PiExtension);
    }

    /// The gap this classification exists to make visible: bare `acp:pi` (the
    /// user's own `~/.pi`) and any custom agent bound to the `acp:pi` engine get
    /// NEITHER road. The bridge is unsupported by the transport and the extension
    /// lives only in Ryu's managed config dir, so such an agent cannot call a
    /// single Ryu tool — a fact nothing surfaced before this.
    #[test]
    fn bare_pi_acp_is_classified_as_no_tool_access() {
        assert_eq!(ryu_tool_access(&pi_acp_cmd_gated()), RyuToolAccess::None);
    }

    /// The wire strings are a client contract (`probe_acp_config`'s
    /// `ryuToolAccess`, which the desktop switches on to word its copy), so a
    /// rename must break here rather than silently fall through a `default:` arm
    /// in TypeScript.
    #[test]
    fn tool_access_wire_strings_are_stable() {
        assert_eq!(RyuToolAccess::Bridge.as_str(), "bridge");
        assert_eq!(RyuToolAccess::PiExtension.as_str(), "pi-extension");
        assert_eq!(RyuToolAccess::None.as_str(), "none");
    }

    /// `is_managed_pi` in `run_acp_instance` is derived from this classifier, and
    /// it gates real behaviour (managed-Pi OAuth refresh, the LSP-server table,
    /// the widget-synthesis path). So `PiExtension` must mean *exactly* what that
    /// call site's original two-substring test meant — no wider, no narrower.
    #[test]
    fn pi_extension_matches_the_managed_pi_predicate() {
        for cmd in [
            format!("PI_CODING_AGENT_DIR=/tmp/pi {}", pi_acp_cmd_gated()),
            pi_acp_cmd_gated(),
            "npx -y claude-code-acp".to_owned(),
            // A non-pi agent that happens to carry the env var must NOT be taken
            // for the managed Pi: the extension is a Pi mechanism, and the bridge
            // is the road this command actually gets.
            "PI_CODING_AGENT_DIR=/tmp/pi npx -y claude-code-acp".to_owned(),
        ] {
            let legacy = cmd.contains("pi-acp") && cmd.contains("PI_CODING_AGENT_DIR");
            assert_eq!(
                ryu_tool_access(&cmd) == RyuToolAccess::PiExtension,
                legacy,
                "{cmd}"
            );
        }
    }

    /// What the bridge actually exposes: exactly the agent's own allowlist, never a
    /// superset. If that ever stops holding, the ON default must be revisited.
    ///
    /// It is **not**, on its own, the justification for defaulting ON — the baseline
    /// assertion below is the reason why. `allowlist_for` resolves only from
    /// `RYU_MCP_ALLOWLIST*`, so on a stock node the allowlist is `None` =
    /// unrestricted, and "exactly the allowlist" is then the full built-in set. The
    /// real argument is parity: the Pi-extension and openai-compat planes pass the
    /// same `allowlist_for(agent_id)` and are already default-on, and every bridged
    /// call still crosses `approvals::gate_tool_call`. See the module doc on
    /// `crate::agent_routing`.
    #[tokio::test]
    async fn bridge_offers_exactly_the_agents_tool_allowlist() {
        let mcp = Arc::new(McpRegistry::empty());
        let unrestricted = mcp.tools_for_agent(None).await;
        assert!(
            !unrestricted.is_empty(),
            "the built-in providers must offer something, or this test is vacuous"
        );

        // Restrict to ONE of the tools the unrestricted agent can see.
        let keep = unrestricted[0].id.clone();
        let restricted = mcp.tools_for_agent(Some(&[keep.clone()])).await;
        let ids: Vec<String> = restricted.iter().map(|t| t.id.clone()).collect();
        assert_eq!(
            ids,
            vec![keep],
            "a restricted agent sees exactly its allowlist through the bridge"
        );

        // An allowlist naming nothing real yields no registry tools at all — the
        // bridge cannot widen an allowlist, only honour it. (The always-on
        // meta/discovery tools are added on top and are not a grant: every call
        // still re-enters `McpRegistry::call_tool`'s allowlist check.)
        let none = mcp
            .tools_for_agent(Some(&["no-such-server".to_owned()]))
            .await;
        assert!(none.is_empty());
    }

    // ── Managed-Pi widget synthesis (Round A) ──────────────────────────────
    //
    // The `ryu-mcp` Pi extension stamps `details.ryuWidget = { tool, arguments,
    // output }` on its tool result; pi-acp preserves it as ACP `rawOutput`. These
    // cover the NEW extraction/gating (`pi_widget_binding`) and the end-to-end
    // synthesis into a `ToolWidgetEvent` via the SHARED `build_widget_event`, using
    // a real in-process app (`checklist.render`) so the binding + HTML resolve.
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
        let raw = ryu_widget_raw_output("checklist.render", serde_json::json!({ "items": [] }));

        // Completed + marker → extracted (tool, args, mcp result).
        let got = pi_widget_binding(Some(&ToolCallStatus::Completed), Some(&raw));
        let (tool, args, result) = got.expect("completed + marker extracts a binding");
        assert_eq!(tool, "checklist.render");
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

    // ── Nested sub-step fan-out (Unit 6) ───────────────────────────────────
    //
    // A tool result stamps `details.ryuSteps = [{ name, input, output?, status }]`
    // and pi-acp preserves it as ACP `rawOutput`. These cover the extraction only;
    // the `<parent>:<n>` minting itself lives in mod.rs.

    fn ryu_steps_raw_output(answer: &str, steps: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "content": [{ "type": "text", "text": answer }],
            "details": { "mode": "single", "ryuSteps": steps }
        })
    }

    #[test]
    fn pi_subagent_steps_extracts_on_every_update_not_only_completed() {
        // The deliberate DIVERGENCE from `pi_widget_binding`: steps stream, so the
        // extractor has no `Completed` gate. A widget renders once from a final
        // result; a nested transcript has to grow live, which is why this asserts
        // the opposite of `pi_widget_binding_extracts_only_on_completed_with_marker`.
        let raw = ryu_steps_raw_output(
            "done",
            serde_json::json!([
                { "name": "read", "input": { "file_path": "/a.rs" }, "status": "completed" },
            ]),
        );
        let steps = pi_subagent_steps(Some(&raw)).expect("marker extracts regardless of status");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0]["name"], serde_json::json!("read"));
        // Status never enters the extractor at all — there is nothing to gate on.
    }

    #[test]
    fn pi_subagent_steps_none_without_marker_or_wrong_shape() {
        // An ordinary tool result (no `details.ryuSteps`) must not fan out.
        let plain = serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] });
        assert!(pi_subagent_steps(Some(&plain)).is_none());
        // The widget marker is a different seam; it must not be mistaken for steps.
        let widget = ryu_widget_raw_output("checklist.render", serde_json::json!({}));
        assert!(pi_subagent_steps(Some(&widget)).is_none());
        // Marker present but not an array → none (never mint a child from a scalar).
        let scalar = serde_json::json!({ "details": { "ryuSteps": "oops" } });
        assert!(pi_subagent_steps(Some(&scalar)).is_none());
        // No raw_output at all → none.
        assert!(pi_subagent_steps(None).is_none());
    }

    // ── Session-config write-back (`details.ryuConfig`) ────────────────────
    //
    // The agent→client direction of the session-config channel: a tool result
    // stamps `details.ryuConfig = { configId: valueId }` and pi-acp preserves it
    // as ACP `rawOutput`. Structural twin of `pi_widget_binding` (Completed-gated,
    // marker-keyed); these cover the extraction only, the `data-ryu-acp-config`
    // part is emitted in mod.rs.

    fn ryu_config_raw_output(config: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "content": [{ "type": "text", "text": "done" }],
            "details": { "exited": true, "ryuConfig": config }
        })
    }

    #[test]
    fn pi_config_updates_extracts_only_on_completed_with_marker() {
        let raw = ryu_config_raw_output(serde_json::json!({ "ryu.plan": "off" }));

        // Completed + marker → the requested pairs, verbatim.
        let got = pi_config_updates(Some(&ToolCallStatus::Completed), Some(&raw))
            .expect("completed + marker extracts a config write-back");
        assert_eq!(got.len(), 1);
        assert_eq!(got.get("ryu.plan").map(String::as_str), Some("off"));

        // In-progress (a partial `tool_execution_update`) must NOT extract — a
        // write-back is a one-shot instruction, and acting on a partial frame
        // would flip the user's picker before the tool could still fail.
        assert!(pi_config_updates(Some(&ToolCallStatus::InProgress), Some(&raw)).is_none());
        // Missing status → none.
        assert!(pi_config_updates(None, Some(&raw)).is_none());
    }

    #[test]
    fn pi_config_updates_none_without_marker_or_wrong_shape() {
        // An ordinary tool result (no `details.ryuConfig`) must not write back.
        let plain = serde_json::json!({ "content": [{ "type": "text", "text": "hi" }] });
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&plain)).is_none());
        // The sibling markers are different seams and must not be mistaken for this
        // one (mirrors `pi_subagent_steps_none_without_marker_or_wrong_shape`).
        let widget = ryu_widget_raw_output("checklist.render", serde_json::json!({}));
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&widget)).is_none());
        let steps = ryu_steps_raw_output("done", serde_json::json!([]));
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&steps)).is_none());
        // Marker present but not an object → none (never mint a pair from a scalar).
        let scalar = ryu_config_raw_output(serde_json::json!("off"));
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&scalar)).is_none());
        // An empty object yields no usable pair → none, so no empty event is emitted.
        let empty = ryu_config_raw_output(serde_json::json!({}));
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&empty)).is_none());
        // No raw_output at all → none.
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), None).is_none());
    }

    #[test]
    fn pi_config_updates_drops_non_string_values_and_keeps_the_rest() {
        // A `valueId` is a string by ACP's own typing. A malformed entry is dropped
        // per key rather than voiding a marker that also carries usable pairs; a
        // marker with NOTHING usable left degrades to `None`.
        let mixed = ryu_config_raw_output(serde_json::json!({
            "ryu.plan": "off",
            "thought_level": 3,
            "nested": { "a": "b" },
        }));
        let got = pi_config_updates(Some(&ToolCallStatus::Completed), Some(&mixed))
            .expect("the one well-formed pair survives");
        assert_eq!(got.len(), 1);
        assert_eq!(got.get("ryu.plan").map(String::as_str), Some("off"));

        let all_bad = ryu_config_raw_output(serde_json::json!({ "thought_level": 3 }));
        assert!(pi_config_updates(Some(&ToolCallStatus::Completed), Some(&all_bad)).is_none());
    }

    #[test]
    fn pi_config_updates_is_value_agnostic_and_not_pi_specific() {
        // The extractor compiles in no vocabulary of its own: an arbitrary agent's
        // arbitrary option/value round-trips untouched. If this ever needs to know
        // an id or a value, the channel has stopped being agent-neutral.
        let raw = ryu_config_raw_output(serde_json::json!({
            "some.other.agent/option": "whatever-value",
        }));
        let got = pi_config_updates(Some(&ToolCallStatus::Completed), Some(&raw))
            .expect("any producer's ids extract");
        assert_eq!(
            got.get("some.other.agent/option").map(String::as_str),
            Some("whatever-value")
        );
    }

    #[test]
    fn pi_subagent_answer_concatenates_text_blocks() {
        // The `<parent>:out` TaskOutput text comes from the result envelope's
        // `content`, NOT from a second `details.*` marker a producer might forget.
        let raw = ryu_steps_raw_output("", serde_json::json!([]));
        assert!(
            pi_subagent_answer(Some(&raw)).is_none(),
            "empty text → no row"
        );

        let multi = serde_json::json!({
            "content": [
                { "type": "text", "text": "part one " },
                { "type": "image", "data": "…" },
                { "type": "text", "text": "part two" },
            ],
            "details": { "ryuSteps": [] }
        });
        assert_eq!(
            pi_subagent_answer(Some(&multi)).as_deref(),
            Some("part one part two"),
        );
        // No `content` key, and no raw output at all → none.
        assert!(pi_subagent_answer(Some(&serde_json::json!({ "details": {} }))).is_none());
        assert!(pi_subagent_answer(None).is_none());
    }

    // ── Model-first config-option ordering ───────────────────────────────────
    //
    // Config options are not independent: opencode 1.18.5 validates its `effort`
    // values against the CURRENT model's effort levels. Captured from the real
    // binary over ACP:
    //
    //   effort→model : set_config_option(effort,"high") ⇒
    //                  "Invalid params: effort not found: high"; the later model
    //                  write then reports effort back as "low" (the pick is lost)
    //   model→effort : both succeed, effort reads back "high"
    //
    // The values arrive as a `HashMap` from the request body, so with no explicit
    // order the failing one is whatever the process's randomized hashing yields.

    #[test]
    fn model_first_applies_the_model_before_every_other_option() {
        let pairs = vec![
            ("effort".to_owned(), "high".to_owned()),
            ("mode".to_owned(), "plan".to_owned()),
            (MODEL_CONFIG_OPTION_ID.to_owned(), "xai/grok-4.6".to_owned()),
        ];
        let ordered: Vec<&str> = model_first(pairs.iter().map(|(a, b)| (a, b)))
            .into_iter()
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(ordered, vec![MODEL_CONFIG_OPTION_ID, "effort", "mode"]);
    }

    #[test]
    fn model_first_is_stable_for_everything_else() {
        // Only the model moves; the rest keep the order they were given, so an
        // agent that cares about its own option order still sees it.
        let pairs = vec![
            ("b".to_owned(), "1".to_owned()),
            ("a".to_owned(), "2".to_owned()),
            ("c".to_owned(), "3".to_owned()),
        ];
        let ordered: Vec<&str> = model_first(pairs.iter().map(|(a, b)| (a, b)))
            .into_iter()
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(ordered, vec!["b", "a", "c"]);
    }

    #[test]
    fn model_first_drops_core_synthesized_and_empty_ids() {
        // `ryu.plan` is applied as a prompt sentinel, never sent to the agent —
        // both the probe and the turn path get that filtering from one place.
        let pairs = vec![
            (PLAN_MODE_CONFIG_ID.to_owned(), PLAN_MODE_ON.to_owned()),
            (String::new(), "ignored".to_owned()),
            ("effort".to_owned(), "high".to_owned()),
        ];
        let ordered: Vec<&str> = model_first(pairs.iter().map(|(a, b)| (a, b)))
            .into_iter()
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(ordered, vec!["effort"]);
    }

    /// End-to-end against a REAL agent, through Core's own probe path.
    ///
    /// Opt-in (`--ignored`) and env-gated because it spawns a third-party binary
    /// and reads that installation's authenticated model list — neither belongs
    /// in the default suite. Run it as:
    ///
    /// ```text
    /// RYU_TEST_ACP_CMD="$HOME/.opencode/bin/opencode acp" \
    /// RYU_TEST_ACP_REASONING_MODEL="xai/grok-4.6" \
    ///   cargo test -p ryu-core --bin ryu-core probe_with_a_model_selection -- --ignored --nocapture
    /// ```
    ///
    /// What it pins is the entire point of `probe_acp_config_with`: the plain
    /// probe reports the agent's default option set, and the SAME binary reports
    /// a reasoning option once the model that has one is applied first.
    #[tokio::test]
    #[ignore = "spawns a real third-party agent binary; set RYU_TEST_ACP_CMD to run"]
    async fn probe_with_a_model_selection_reveals_that_models_options() {
        let Ok(spawn_cmd) = std::env::var("RYU_TEST_ACP_CMD") else {
            eprintln!("RYU_TEST_ACP_CMD unset — nothing to probe");
            return;
        };
        let model = std::env::var("RYU_TEST_ACP_REASONING_MODEL")
            .expect("RYU_TEST_ACP_REASONING_MODEL must name a model with reasoning levels");
        let cwd = std::env::current_dir().expect("cwd");

        let reasoning_ids = |v: &serde_json::Value| -> Vec<String> {
            v.get("configOptions")
                .and_then(|o| o.as_array())
                .map(|opts| {
                    opts.iter()
                        .filter(|o| {
                            let hay = ["category", "id", "name"]
                                .iter()
                                .filter_map(|k| o.get(*k).and_then(|v| v.as_str()))
                                .collect::<Vec<_>>()
                                .join(" ")
                                .to_lowercase();
                            ["thought", "reason", "think", "effort"]
                                .iter()
                                .any(|m| hay.contains(m))
                        })
                        .filter_map(|o| o.get("id").and_then(|v| v.as_str()))
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };

        let plain = probe_acp_config_with(spawn_cmd.clone(), cwd.clone(), SessionSelections::new())
            .await
            .expect("plain probe");
        let mut selections = SessionSelections::new();
        selections.insert(MODEL_CONFIG_OPTION_ID.to_owned(), model.clone());
        let selected = probe_acp_config_with(spawn_cmd, cwd, selections)
            .await
            .expect("probe with a model selection");

        eprintln!("plain reasoning options:    {:?}", reasoning_ids(&plain));
        eprintln!("selected reasoning options: {:?}", reasoning_ids(&selected));
        assert!(
            !reasoning_ids(&selected).is_empty(),
            "applying '{model}' must reveal the reasoning option the composer renders"
        );
    }

    // ── Core-synthesized plan-mode config option (Unit 7) ────────────────────
    //
    // The ONE option Ryu invents rather than reports. These pin the two halves
    // that make it safe: it is offered only to the agent that can honour it, and
    // it never goes back to that agent over the wire.

    /// A flagship spawn command, in the POSIX spelling `ryu_pi_acp_cmd` emits.
    fn flagship_spawn_cmd() -> String {
        format!("PI_CODING_AGENT_DIR=/tmp/pi-agent {}", pi_acp_cmd_gated())
    }

    #[test]
    fn plan_mode_config_option_is_appended_only_for_the_flagship() {
        // The flagship gets the pill appended AFTER whatever it advertised, so
        // pi-acp's own model selector keeps the leading slot it chose.
        let advertised = vec![SessionConfigOption::select(
            "model",
            "Model",
            "gpt-5",
            vec![SessionConfigSelectOption::new("gpt-5", "GPT-5")],
        )];
        let out = with_plan_mode_option(&flagship_spawn_cmd(), Some(advertised))
            .expect("flagship gets options");
        assert_eq!(out.len(), 2, "appended, not replaced");
        assert_eq!(&*out[0].id.0, "model", "agent's order is preserved");
        assert_eq!(&*out[1].id.0, PLAN_MODE_CONFIG_ID);

        // An agent that advertised nothing still gets the pill — otherwise the
        // affordance would depend on the agent happening to report something else.
        let bare = with_plan_mode_option(&flagship_spawn_cmd(), None).expect("None becomes a list");
        assert_eq!(bare.len(), 1);
        assert_eq!(&*bare[0].id.0, PLAN_MODE_CONFIG_ID);

        // Every OTHER agent is untouched, in both directions. A pill on an agent
        // with no `ryu-plan.ts` would be a control that does nothing worse than
        // nothing: the sentinel would reach that model as literal text.
        for cmd in [
            "npx -y claude-code-acp",
            "npx -y @zed-industries/codex-acp",
            // Bare pi-acp: pi, but NOT the managed config dir, so no extension.
            &pi_acp_cmd_gated(),
        ] {
            assert!(
                with_plan_mode_option(cmd, None).is_none(),
                "{cmd}: no synthesized option"
            );
            let one = with_plan_mode_option(
                cmd,
                Some(vec![SessionConfigOption::select(
                    "model",
                    "Model",
                    "a",
                    vec![SessionConfigSelectOption::new("a", "A")],
                )]),
            )
            .expect("advertised list survives");
            assert_eq!(one.len(), 1, "{cmd}: agent's own options are not extended");
        }
    }

    #[test]
    fn plan_mode_config_option_renders_in_the_composer() {
        // Three properties the desktop's generic renderer depends on. None is
        // cosmetic: each one, if broken, makes the pill silently absent rather
        // than visibly wrong.
        let opt = plan_mode_config_option();
        let json = serde_json::to_value(&opt).expect("serializes");

        // 0. The field names the desktop's `AcpConfigOption` interface requires.
        //    Asserted explicitly because a serde rename would leave every other
        //    assertion below passing while the renderer saw an option with no id.
        assert_eq!(json["id"], serde_json::json!(PLAN_MODE_CONFIG_ID));
        assert!(json["name"].is_string(), "camelCase field names: {json}");

        // 1. It is a `select` with both values, in off→on order.
        assert_eq!(json["type"], serde_json::json!("select"));
        let values: Vec<&str> = json["options"]
            .as_array()
            .expect("options array")
            .iter()
            .map(|o| o["value"].as_str().expect("value"))
            .collect();
        assert_eq!(values, vec![PLAN_MODE_OFF, PLAN_MODE_ON]);

        // 2. `currentValue` is the OFF default. Core holds no per-session plan
        //    state and this probe is cached per spawn command, so there is
        //    nothing else it could honestly be; the desktop overlays the user's
        //    own pick on top.
        assert_eq!(json["currentValue"], serde_json::json!(PLAN_MODE_OFF));

        // 3. Neither the category, the id nor the name may contain a word the
        //    composer reads as "this is a reasoning control" — such options are
        //    hidden outright for an agent that reports no reasoning capability.
        let haystack = format!(
            "{} {} {}",
            json["category"].as_str().unwrap_or_default(),
            json["id"].as_str().unwrap_or_default(),
            json["name"].as_str().unwrap_or_default()
        )
        .to_lowercase();
        for needle in ["thought", "reason", "think", "effort"] {
            assert!(
                !haystack.contains(needle),
                "'{needle}' in \"{haystack}\" would hide the pill when reasoning is off"
            );
        }
        assert_eq!(json["category"], serde_json::json!("mode"));
    }

    #[test]
    fn acp_auth_required_code_matches_the_protocol() {
        // The whole re-login branch hangs off this number. ACP's
        // `ErrorCode::AuthRequired` is JSON-RPC -32000; if it ever moved, an
        // expired token would silently fall back to the "no model configured"
        // message again — advice that cannot fix it.
        assert_eq!(
            ACP_AUTH_REQUIRED_CODE,
            i32::from(agent_client_protocol::ErrorCode::AuthRequired)
        );
    }

    #[test]
    fn config_option_value_maps_booleans_and_leaves_ids_alone() {
        // `unstable_boolean_config` splits the wire value into a select's value
        // id and a real boolean. Every layer above Core stores config picks as
        // STRINGS, so sending a toggle the string "true" as a value id makes the
        // agent hunt for an option whose id is "true" and reject the write.
        assert_eq!(
            config_option_value("true").as_bool(),
            Some(true),
            "\"true\" must cross the wire as a boolean, not a value id"
        );
        assert_eq!(config_option_value("false").as_bool(), Some(false));

        // Everything else stays a value id, including strings that merely look
        // boolean-ish — only the two exact spellings convert.
        for id in ["high", "off", "True", "FALSE", "yes", "1", ""] {
            assert!(
                config_option_value(id).as_bool().is_none(),
                "{id} must stay a value id"
            );
            assert_eq!(
                config_option_value(id).as_value_id().map(|v| v.to_string()),
                Some(id.to_owned())
            );
        }
    }

    #[test]
    fn plan_mode_id_is_filtered_from_set_config_option() {
        // pi-acp accepts `model` and `thought_level` and throws on anything else,
        // so sending the synthesized id would produce a rejected request and a
        // warn line on every single turn.
        assert!(is_core_synthesized_config_id(PLAN_MODE_CONFIG_ID));
        for agent_reported in ["model", "thought_level", "mode", "ryu", "ryu.plan.extra"] {
            assert!(
                !is_core_synthesized_config_id(agent_reported),
                "{agent_reported} is agent-reported and must still be sent"
            );
        }
    }

    #[test]
    fn plan_mode_id_coexists_with_the_model_config_option() {
        // Covers the DATA `apply_turn_config` reads, not its send loop (that needs
        // a live `ConnectionTo<Agent>`). It skips the synthesized id inside the loop rather
        // than removing it from `turn.config_options`, because the model fallback
        // below scans that same list to decide whether `model` was already sent
        // explicitly. This pins that the scan still sees `model` when a plan pick
        // rides alongside it — a `.retain()` "cleanup" would break it silently.
        let turn = AcpTurnConfig {
            session_mode: None,
            config_options: vec![
                (PLAN_MODE_CONFIG_ID.to_owned(), PLAN_MODE_ON.to_owned()),
                (MODEL_CONFIG_OPTION_ID.to_owned(), "gpt-5".to_owned()),
            ],
            model_id: Some("gpt-5".to_owned()),
            agent_effort: None,
            interactive: true,
        };
        assert!(
            turn.config_options
                .iter()
                .any(|(id, _)| id == MODEL_CONFIG_OPTION_ID),
            "the model fallback's `already_via_config` scan must still hit"
        );
        assert_eq!(
            turn.config_options
                .iter()
                .filter(|(id, _)| !is_core_synthesized_config_id(id))
                .count(),
            1,
            "exactly one option reaches the wire"
        );
    }

    #[tokio::test]
    async fn pi_widget_synthesis_builds_tool_widget_event() {
        // End-to-end (minus the live Pi subprocess): the exact two-step the ACP
        // `ToolCallUpdate` handler runs — extract the binding, then feed it to the
        // SHARED `build_widget_event`. `checklist.render` used to be an in-process
        // app whose binding + HTML resolved without a live MCP server; the eight
        // inline-chat widget-apps were retired in 1af518d8, so the fixture is now
        // seeded directly. It stands in for the producer that IS still live — an
        // external MCP server declaring `ryu/outputTemplate` in its tool `_meta` —
        // which is what this synthesis path serves in production.
        let mcp = McpRegistry::empty();
        mcp.seed_widget_tool_for_test("checklist", "render", "ui://widget/checklist.html");
        let raw = ryu_widget_raw_output(
            "checklist.render",
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
        assert_eq!(event.tool_name, "checklist.render");
        assert_eq!(event.template_uri, "ui://widget/checklist.html");
        // `structuredContent` → `toolOutput`, delivered RAW to the widget.
        assert_eq!(event.tool_output["title"], serde_json::json!("Groceries"));
        assert!(!event.widget_html.is_empty(), "widget HTML resolves");
    }

    #[tokio::test]
    async fn pi_widget_synthesis_skips_error_results() {
        // An `isError` MCP result NEVER emits a widget (spec §1.1) — even when the
        // Pi extension stamped the marker. Seed the binding: without it
        // `build_widget_event` would bail one step EARLIER (no widget at all) and
        // the assertion would pass without ever reaching the `isError` guard.
        let mcp = McpRegistry::empty();
        mcp.seed_widget_tool_for_test("checklist", "render", "ui://widget/checklist.html");
        let raw = serde_json::json!({
            "details": { "ryuWidget": {
                "tool": "checklist.render",
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
        assert!(
            event.is_none(),
            "isError result must not synthesize a widget"
        );
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
        assert_eq!(
            read_text_file_scoped_in_roots(&full, std::slice::from_ref(&dir)),
            "l1\nl2\nl3\nl4\nl5"
        );

        // 1-based line offset + limit window.
        let windowed = req(serde_json::json!({ "path": path, "line": 2, "limit": 2 }));
        assert_eq!(
            read_text_file_scoped_in_roots(&windowed, std::slice::from_ref(&dir)),
            "l2\nl3"
        );

        // Missing file → empty, never panics.
        let missing = req(serde_json::json!({ "path": dir.join("nope.txt") }));
        assert_eq!(
            read_text_file_scoped_in_roots(&missing, std::slice::from_ref(&dir)),
            ""
        );

        // Out-of-root read → empty (workspace confinement), even when the file
        // exists.
        let outside = req(serde_json::json!({ "path": path }));
        let sibling_root = dir.join("sub");
        assert_eq!(
            read_text_file_scoped_in_roots(&outside, std::slice::from_ref(&sibling_root)),
            ""
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fs_handlers_allow_every_session_workspace_root() {
        let base = std::env::temp_dir().join(format!("ryu-acp-multi-root-{}", std::process::id()));
        let primary = base.join("web");
        let secondary = base.join("api");
        let outside = base.join("outside");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::create_dir_all(&secondary).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let secondary_file = secondary.join("src/lib.rs");
        std::fs::create_dir_all(secondary_file.parent().unwrap()).unwrap();
        std::fs::write(&secondary_file, "secondary").unwrap();

        let roots = vec![primary.clone(), secondary.clone()];
        let read_request: ReadTextFileRequest =
            serde_json::from_value(serde_json::json!({ "sessionId": "s", "path": secondary_file }))
                .expect("valid secondary-root read request");
        assert_eq!(
            read_text_file_scoped_in_roots(&read_request, &roots),
            "secondary"
        );

        let write_target = secondary.join("generated.txt");
        let write_request: WriteTextFileRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s",
            "path": write_target,
            "content": "written"
        }))
        .expect("valid secondary-root write request");
        write_text_file_scoped_in_roots(&write_request, &roots).expect("secondary-root write");
        assert_eq!(std::fs::read_to_string(&write_target).unwrap(), "written");

        let outside_request: ReadTextFileRequest = serde_json::from_value(
            serde_json::json!({ "sessionId": "s", "path": outside.join("secret.txt") }),
        )
        .expect("valid outside-root read request");
        assert_eq!(read_text_file_scoped_in_roots(&outside_request, &roots), "");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn fs_confinement_rejects_escapes_lexically() {
        let root = std::path::Path::new("/ws/project");
        // In-root, `.`/`..` that stay inside, and relative paths all pass.
        assert!(path_within_root(
            root,
            std::path::Path::new("/ws/project/a.txt")
        ));
        assert!(path_within_root(
            root,
            std::path::Path::new("/ws/project/sub/../a.txt")
        ));
        assert!(path_within_root(root, std::path::Path::new("rel/b.txt")));
        // Escapes — absolute elsewhere, `..` climbing out, sibling-prefix trick.
        assert!(!path_within_root(root, std::path::Path::new("/etc/passwd")));
        assert!(!path_within_root(
            root,
            std::path::Path::new("/ws/project/../other/c.txt")
        ));
        assert!(!path_within_root(
            root,
            std::path::Path::new("/ws/project2/d.txt")
        ));
    }

    #[test]
    fn write_text_file_scoped_refuses_out_of_root() {
        let dir = std::env::temp_dir().join(format!("ryu-acp-fsw-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let target = dir.join("escape.txt");
        let req: WriteTextFileRequest = serde_json::from_value(serde_json::json!({
            "sessionId": "s",
            "path": target,
            "content": "nope",
        }))
        .expect("valid WriteTextFileRequest");
        // Root is a SIBLING dir, so the write must be refused and nothing created.
        let inner_root = dir.join("inner");
        let err =
            write_text_file_scoped_in_roots(&req, std::slice::from_ref(&inner_root)).unwrap_err();
        assert!(err.to_string().contains("outside the session workspaces"));
        assert!(!target.exists());
        // Same request against the real root succeeds.
        write_text_file_scoped_in_roots(&req, std::slice::from_ref(&dir)).expect("in-root write");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "nope");
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
    fn agent_scoped_gateway_url_encodes_the_agent_segment() {
        let _env_guard = crate::sidecar::gateway::lock_gateway_env();
        let base = crate::sidecar::gateway::gateway_url();
        let expected = format!("{}/v1/agents/agent%2Fone", base.trim_end_matches('/'));
        assert_eq!(openai_gateway_v1(Some("agent/one")), expected);
        assert_eq!(
            openai_gateway_v1(None),
            format!("{}/v1", base.trim_end_matches('/'))
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

    #[tokio::test]
    async fn acp_patch_deletion_is_denied_before_gateway_scan() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let tool_call = serde_json::json!({
            "kind": "edit",
            "rawInput": { "command": "*** Delete File: src/old.ts\n" }
        });
        let outcome = acp_exec_scan_verdict(&tool_call, "acp:codex").await;
        assert!(
            matches!(&outcome, ExecScanOutcome::Deny(reason) if reason.contains("apply_patch")),
            "ACP file deletion must be denied before any gateway fallback: {outcome:?}"
        );

        let nested_patch = serde_json::json!({
            "kind": "edit",
            "rawInput": { "patch": "*** Delete File: src/nested-old.ts\n" }
        });
        let nested_outcome = acp_exec_scan_verdict(&nested_patch, "acp:codex").await;
        assert!(
            matches!(&nested_outcome, ExecScanOutcome::Deny(reason) if reason.contains("apply_patch")),
            "nested apply_patch deletion must be denied before any gateway fallback: {nested_outcome:?}"
        );
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

    // ── ACP wire-shape mappers (kind/status/exit) ───────────────────────────

    use agent_client_protocol::schema::{Diff, ToolCallUpdateFields};

    #[test]
    fn tool_kind_str_serializes_snake_case_variants() {
        assert_eq!(tool_kind_str(&ToolKind::Read), "read");
        assert_eq!(tool_kind_str(&ToolKind::Edit), "edit");
        assert_eq!(tool_kind_str(&ToolKind::Execute), "execute");
        assert_eq!(tool_kind_str(&ToolKind::SwitchMode), "switch_mode");
        // The `#[default] #[serde(other)]` variant maps to "other".
        assert_eq!(tool_kind_str(&ToolKind::Other), "other");
        assert_eq!(tool_kind_str(&ToolKind::default()), "other");
    }

    #[test]
    fn tool_status_str_serializes_snake_case_variants() {
        assert_eq!(tool_status_str(&ToolCallStatus::Pending), "pending");
        assert_eq!(tool_status_str(&ToolCallStatus::InProgress), "in_progress");
        assert_eq!(tool_status_str(&ToolCallStatus::Completed), "completed");
        assert_eq!(tool_status_str(&ToolCallStatus::Failed), "failed");
    }

    #[test]
    fn exit_status_value_carries_code_and_signal() {
        let clean = exit_status_value(Some(0), None);
        assert_eq!(clean["exitCode"], serde_json::json!(0));
        assert_eq!(clean["signal"], serde_json::Value::Null);

        let killed = exit_status_value(None, Some("SIGKILL".to_owned()));
        assert_eq!(killed["exitCode"], serde_json::Value::Null);
        assert_eq!(killed["signal"], serde_json::json!("SIGKILL"));
    }

    // ── Tool content → output collapsing ────────────────────────────────────

    fn text_content(text: &str) -> ToolCallContent {
        ToolCallContent::from(text.to_owned())
    }

    #[test]
    fn tool_content_to_output_empty_is_none() {
        assert!(tool_content_to_output(&[]).is_none());
    }

    #[test]
    fn tool_content_to_output_text_only_is_a_string() {
        let out = tool_content_to_output(&[text_content("hello "), text_content("world")])
            .expect("text content collapses to a string");
        assert_eq!(out, serde_json::Value::String("hello world".to_owned()));
    }

    #[test]
    fn tool_content_to_output_diff_becomes_structured_array() {
        // A non-text block (a Diff) forces the structured-array branch.
        let diff = ToolCallContent::Diff(Diff::new("/tmp/f.rs", "new").old_text("old"));
        let out = tool_content_to_output(&[diff]).expect("structured content");
        let arr = out.as_array().expect("diff yields a JSON array");
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["type"], serde_json::json!("diff"));
    }

    #[test]
    fn tool_content_to_output_mixed_appends_text_after_structured() {
        // Text + a structured block: the text is appended as the LAST array entry.
        let diff = ToolCallContent::Diff(Diff::new("/tmp/f.rs", "new"));
        let out = tool_content_to_output(&[text_content("note"), diff])
            .expect("mixed content is structured");
        let arr = out.as_array().expect("array");
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["type"], serde_json::json!("diff"));
        assert_eq!(arr[1], serde_json::Value::String("note".to_owned()));
    }

    // ── Diff extraction (desktop edit card) ─────────────────────────────────

    #[test]
    fn extract_diff_output_maps_old_new_path() {
        let content = vec![ToolCallContent::Diff(
            Diff::new("/repo/src/lib.rs", "after").old_text("before"),
        )];
        let out = extract_diff_output(&content).expect("diff present");
        assert_eq!(out["old_content"], serde_json::json!("before"));
        assert_eq!(out["content"], serde_json::json!("after"));
        assert_eq!(out["path"], serde_json::json!("/repo/src/lib.rs"));
    }

    #[test]
    fn extract_diff_output_new_file_has_empty_old_content() {
        // A brand-new file has no `old_text`; the card must still render (empty old).
        let content = vec![ToolCallContent::Diff(Diff::new("/repo/new.rs", "created"))];
        let out = extract_diff_output(&content).expect("diff present");
        assert_eq!(out["old_content"], serde_json::json!(""));
        assert_eq!(out["content"], serde_json::json!("created"));
    }

    #[test]
    fn extract_diff_output_none_for_non_edit_tools() {
        assert!(extract_diff_output(&[text_content("just text")]).is_none());
        assert!(extract_diff_output(&[]).is_none());
    }

    // ── Location JSON ───────────────────────────────────────────────────────

    #[test]
    fn locations_json_includes_line_only_when_present() {
        let with_line: ToolCallLocation =
            serde_json::from_value(serde_json::json!({ "path": "/a/b.rs", "line": 12 })).unwrap();
        let without: ToolCallLocation =
            serde_json::from_value(serde_json::json!({ "path": "/a/c.rs" })).unwrap();
        let out = locations_json(&[with_line, without]);
        assert_eq!(out[0]["path"], serde_json::json!("/a/b.rs"));
        assert_eq!(out[0]["line"], serde_json::json!(12));
        assert_eq!(out[1]["path"], serde_json::json!("/a/c.rs"));
        assert!(out[1].get("line").is_none(), "absent line is omitted");
    }

    // ── Tool call/update → AcpEvent ─────────────────────────────────────────

    #[test]
    fn tool_call_event_carries_kind_locations_and_input() {
        let loc: ToolCallLocation =
            serde_json::from_value(serde_json::json!({ "path": "/x.rs", "line": 3 })).unwrap();
        let call = ToolCall::new("call-1", "Edit x.rs")
            .kind(ToolKind::Edit)
            .locations(vec![loc])
            .raw_input(serde_json::json!({ "path": "/x.rs" }));
        match tool_call_event(&call) {
            AcpEvent::ToolCall {
                id,
                title,
                kind,
                input,
                locations,
            } => {
                assert_eq!(id, "call-1");
                assert_eq!(title, "Edit x.rs");
                assert_eq!(kind, "edit");
                assert_eq!(input, Some(serde_json::json!({ "path": "/x.rs" })));
                assert_eq!(locations.len(), 1);
                assert_eq!(locations[0]["line"], serde_json::json!(3));
            }
            other => panic!("expected ToolCall event, got {other:?}"),
        }
    }

    #[test]
    fn tool_update_event_none_when_nothing_actionable() {
        // A bare title tweak carries no status and no output → nothing to surface.
        let update = ToolCallUpdate::new("c1", ToolCallUpdateFields::new().title("renamed"));
        assert!(tool_update_event(&update).is_none());
    }

    #[test]
    fn tool_update_event_prefers_diff_over_raw_output() {
        // Both a Diff content block AND a raw_output are present; the diff wins so
        // the desktop's edit card renders old↔new (not the opaque raw output).
        let fields = ToolCallUpdateFields::new()
            .status(ToolCallStatus::Completed)
            .content(vec![ToolCallContent::Diff(
                Diff::new("/f.rs", "new").old_text("old"),
            )])
            .raw_output(serde_json::json!({ "ignored": true }));
        let update = ToolCallUpdate::new("c2", fields);
        match tool_update_event(&update).expect("actionable update") {
            AcpEvent::ToolResult {
                id, status, output, ..
            } => {
                assert_eq!(id, "c2");
                assert_eq!(status, "completed");
                let out = output.expect("diff output");
                assert_eq!(out["old_content"], serde_json::json!("old"));
                assert_eq!(out["content"], serde_json::json!("new"));
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn tool_update_event_falls_back_to_raw_output_then_content() {
        // No diff: raw_output is used verbatim.
        let raw = ToolCallUpdate::new(
            "c3",
            ToolCallUpdateFields::new().raw_output(serde_json::json!({ "rows": 2 })),
        );
        match tool_update_event(&raw).expect("update") {
            AcpEvent::ToolResult { status, output, .. } => {
                // No status supplied → defaults to "in_progress".
                assert_eq!(status, "in_progress");
                assert_eq!(output, Some(serde_json::json!({ "rows": 2 })));
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }

        // No diff, no raw_output: collapse the plain text content instead.
        let text = ToolCallUpdate::new(
            "c4",
            ToolCallUpdateFields::new().content(vec![text_content("plain result")]),
        );
        match tool_update_event(&text).expect("update") {
            AcpEvent::ToolResult { output, .. } => {
                assert_eq!(output, Some(serde_json::json!("plain result")));
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    #[test]
    fn tool_update_event_carries_late_arriving_raw_input() {
        // The shape that motivates the field: pi-acp opens a tool call while the
        // model is still streaming its arguments (`rawInput: {}`) and fills them
        // in on a later update. Dropping this leaves every rich renderer that
        // reads `part.input` — the plan card, the to-do checklist, the subagent
        // card — pinned to the empty opening frame with no error anywhere.
        let update = ToolCallUpdate::new(
            "c5",
            ToolCallUpdateFields::new()
                .status(ToolCallStatus::InProgress)
                .raw_input(serde_json::json!({ "plan": { "title": "Add a health endpoint" } })),
        );
        match tool_update_event(&update).expect("actionable update") {
            AcpEvent::ToolResult { input, .. } => {
                assert_eq!(
                    input,
                    Some(serde_json::json!({ "plan": { "title": "Add a health endpoint" } }))
                );
            }
            other => panic!("expected ToolResult, got {other:?}"),
        }

        // An update with no arguments carries `None` rather than an empty object,
        // so mod.rs can tell "unchanged" from "cleared" without guessing.
        let bare = ToolCallUpdate::new(
            "c6",
            ToolCallUpdateFields::new().status(ToolCallStatus::Completed),
        );
        match tool_update_event(&bare).expect("actionable update") {
            AcpEvent::ToolResult { input, .. } => assert_eq!(input, None),
            other => panic!("expected ToolResult, got {other:?}"),
        }
    }

    // ── Agent capability round-trip ─────────────────────────────────────────

    #[test]
    fn read_agent_caps_and_json_reflect_initialize_response() {
        let init: InitializeResponse = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "audio": false, "embeddedContext": true },
                "mcpCapabilities": { "http": true, "sse": false },
            }
        }))
        .expect("valid InitializeResponse");
        let caps = read_agent_caps(&init);
        assert!(caps.load_session);
        assert!(caps.prompt_image);
        assert!(!caps.prompt_audio);
        assert!(caps.prompt_embedded_context);
        assert!(caps.mcp_http);
        assert!(!caps.mcp_sse);

        let json = agent_caps_json(&caps);
        assert_eq!(json["loadSession"], serde_json::json!(true));
        assert_eq!(json["promptCapabilities"]["image"], serde_json::json!(true));
        assert_eq!(
            json["promptCapabilities"]["audio"],
            serde_json::json!(false)
        );
        assert_eq!(json["mcpCapabilities"]["http"], serde_json::json!(true));
        assert_eq!(json["mcpCapabilities"]["sse"], serde_json::json!(false));
    }

    #[test]
    fn session_capabilities_are_read_from_a_real_claude_initialize() {
        // Verbatim from a captured claude-acp 0.66.0 `initialize` response. The
        // agent advertises MORE than the pinned schema models — `fork`,
        // `additionalDirectories` (features off in Core) and `delete` (no field
        // at all) — so this also pins that the unknown keys are dropped without
        // breaking the parse.
        let init: InitializeResponse = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "loadSession": true,
                "sessionCapabilities": {
                    "additionalDirectories": {},
                    "close": {},
                    "delete": {},
                    "fork": {},
                    "list": {},
                    "resume": {},
                },
            }
        }))
        .expect("valid InitializeResponse");
        let caps = read_agent_caps(&init);
        assert!(caps.session_list);
        assert!(caps.session_resume);
        assert!(caps.session_close);

        let json = agent_caps_json(&caps);
        assert_eq!(
            json["sessionCapabilities"]["close"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn an_agent_without_close_is_reported_as_unable_to_delete() {
        // Verbatim from captured pi-acp 0.0.33: it advertises `delete` and
        // `list`, and NO `close`. `delete` is not a field in the pinned schema,
        // so it must NOT be mistaken for close support — that confusion is what
        // made the desktop show a Delete button whose request the agent rejects.
        let init: InitializeResponse = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "agentCapabilities": {
                "sessionCapabilities": { "delete": {}, "list": {} },
            }
        }))
        .expect("valid InitializeResponse");
        let caps = read_agent_caps(&init);
        assert!(caps.session_list);
        assert!(
            !caps.session_close,
            "`delete` is not `close`; treating it as one is the original bug"
        );
        assert!(!caps.session_resume);

        let json = agent_caps_json(&caps);
        assert_eq!(
            json["sessionCapabilities"]["close"],
            serde_json::json!(false)
        );
    }

    #[test]
    fn session_capabilities_absent_entirely_reads_as_unsupported() {
        // An agent that sends no `sessionCapabilities` at all (older builds) must
        // read as false rather than panicking or defaulting to true.
        let init: InitializeResponse = serde_json::from_value(serde_json::json!({
            "protocolVersion": 1,
            "agentCapabilities": { "loadSession": false }
        }))
        .expect("valid InitializeResponse");
        let caps = read_agent_caps(&init);
        assert!(!(caps.session_list || caps.session_resume || caps.session_close));
    }

    #[test]
    fn read_agent_caps_defaults_to_all_false() {
        // A minimal initialize response (no agentCapabilities) advertises nothing.
        let init: InitializeResponse =
            serde_json::from_value(serde_json::json!({ "protocolVersion": 1 })).unwrap();
        let caps = read_agent_caps(&init);
        assert!(!caps.load_session);
        assert!(!caps.prompt_image);
        assert!(!caps.mcp_http);
    }

    // ── CLI version parsing ─────────────────────────────────────────────────

    #[test]
    fn parse_cli_version_extracts_semver_forms() {
        assert_eq!(parse_cli_version("v1.2.3"), Some("1.2.3".to_owned()));
        assert_eq!(
            parse_cli_version("mytool 0.10.4"),
            Some("0.10.4".to_owned())
        );
        assert_eq!(
            parse_cli_version("codex-acp version 2.0.0-beta.1"),
            Some("2.0.0-beta.1".to_owned())
        );
        assert_eq!(
            parse_cli_version("build 1.0.0+abc123"),
            Some("1.0.0+abc123".to_owned())
        );
    }

    #[test]
    fn parse_cli_version_none_without_semver() {
        assert_eq!(parse_cli_version(""), None);
        assert_eq!(parse_cli_version("no version here"), None);
        // A two-part "1.2" is not a full semver and must not match.
        assert_eq!(parse_cli_version("version 1.2"), None);
    }

    // ── Observed-tool registry (per-agent, process-global) ──────────────────

    #[test]
    fn record_observed_tool_dedups_by_title_and_maps_kind() {
        // Use a process-unique agent id so the global registry cannot collide with
        // any other test running in the same process.
        let agent = format!("obs-test-{}-{}", std::process::id(), line!());
        assert!(observed_tools_for(&agent).is_empty());

        record_observed_tool(&agent, "Search files", "search");
        record_observed_tool(&agent, "Run command", "other"); // "other" → no description
        record_observed_tool(&agent, "Search files", "search"); // dup title → no growth
        record_observed_tool(&agent, "", "read"); // empty title → ignored

        let mut tools = observed_tools_for(&agent);
        tools.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(tools.len(), 2, "empty title ignored, dup title collapsed");
        let search = tools.iter().find(|t| t.name == "Search files").unwrap();
        assert_eq!(search.description.as_deref(), Some("search"));
        let run = tools.iter().find(|t| t.name == "Run command").unwrap();
        assert!(
            run.description.is_none(),
            "the 'other' kind is not surfaced as a description"
        );
    }

    // ── Permission back-channel ─────────────────────────────────────────────

    #[test]
    fn resolve_permission_is_false_for_unknown_request() {
        // No waiter was ever registered for this id → nothing to resolve.
        let unknown = format!("perm-unknown-{}", std::process::id());
        assert!(!resolve_permission(&unknown, Some("allow".to_owned())));
        assert!(peek_permission_scope(&unknown).is_none());
    }

    #[tokio::test]
    async fn question_waiter_round_trips_structured_answers_by_stable_tool_id() {
        let conversation_id = format!("question-conv-{}", line!());
        let tool_call_id = format!("question-tool-{}", line!());
        let rx = register_question(conversation_id.clone(), tool_call_id.clone());
        assert_eq!(
            peek_question_scope(&conversation_id, &tool_call_id).as_deref(),
            Some(conversation_id.as_str())
        );

        let answers = serde_json::json!([{
            "question_id": "q-0",
            "kind": "single",
            "selected_ids": ["option-a"]
        }]);
        assert!(resolve_question(
            &conversation_id,
            &tool_call_id,
            answers.clone()
        ));
        assert_eq!(
            rx.await.expect("question answer sender remains alive"),
            answers
        );
        assert!(peek_question_scope(&conversation_id, &tool_call_id).is_none());
        assert!(!resolve_question(
            &conversation_id,
            &tool_call_id,
            serde_json::json!([])
        ));
    }

    // ── Gateway command wrapping ────────────────────────────────────────────

    #[test]
    fn claude_gateway_cmd_injects_only_base_url_not_api_key() {
        // Subscription-preservation: inject ANTHROPIC_BASE_URL but NEVER an API key
        // (an API key would flip Claude Code off the user's Pro/Max OAuth billing).
        let cmd = claude_gateway_cmd("npx -y @zed-industries/claude-code-acp");
        assert!(cmd.contains("ANTHROPIC_BASE_URL="));
        assert!(cmd.contains("/passthrough/anthropic"));
        assert!(
            !cmd.contains("ANTHROPIC_API_KEY") && !cmd.contains("ANTHROPIC_AUTH_TOKEN"),
            "must not inject an API key or auth token: {cmd}"
        );
        assert!(cmd.contains("claude-code-acp"), "base command is preserved");
    }

    #[test]
    fn fresh_session_disables_pool_reuse_but_keeps_conversation_scope() {
        assert!(should_reuse_acp_session("conv-1", false));
        assert!(!should_reuse_acp_session("conv-1", true));
        assert!(!should_reuse_acp_session("", false));
        assert!(!should_reuse_acp_session("", true));
    }

    #[test]
    fn acp_pool_key_separates_security_contexts() {
        let no_tools = acp_security_key(
            &None,
            &None,
            &[],
            "agent",
            &[],
            &None,
            &None,
            &Some("conv".into()),
        );
        let explicit_no_tools = acp_security_key(
            &None,
            &Some(Vec::new()),
            &[],
            "agent",
            &[],
            &None,
            &None,
            &Some("conv".into()),
        );
        let different_action = acp_security_key(
            &None,
            &Some(vec!["tool:read".into()]),
            &["composio:write".into()],
            "agent",
            &["vault-profile".into()],
            &None,
            &None,
            &Some("conv".into()),
        );
        assert_ne!(no_tools, explicit_no_tools);
        assert_ne!(explicit_no_tools, different_action);
    }
}
