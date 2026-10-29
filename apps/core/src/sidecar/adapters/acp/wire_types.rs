use super::*;

/// ACP's `elicitation/create`, kept as Ryu's own wire type. It predates the ACP
/// 0.11 schema Core used to pin; 3.x now ships a stable `CreateElicitationRequest`,
/// but agents send it only to clients advertising `clientCapabilities.elicitation`,
/// which Core has never advertised, so this loose-`mode` shape is unchanged by
/// the upgrade. Unlike a `ToolCall` notification, this is a real
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

/// `session/set_model` was an unstable 0.x schema method that ACP 3.x removed in
/// favour of the `model` session config option. Agents that still implement it
/// (claude-agent-acp, codex-acp) keep working through this wire-level request.
#[derive(Debug, Clone, Serialize, Deserialize, agent_client_protocol::JsonRpcRequest)]
#[request(method = "session/set_model", response = serde_json::Value)]
pub struct SetSessionModelRequest {
    #[serde(rename = "sessionId")]
    pub session_id: SessionId,
    #[serde(rename = "modelId")]
    pub model_id: String,
}

impl SetSessionModelRequest {
    pub fn new(session_id: SessionId, model_id: String) -> Self {
        Self {
            session_id,
            model_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, agent_client_protocol::JsonRpcResponse)]
pub struct ElicitationCreateResponse {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<serde_json::Value>,
}

impl ElicitationCreateResponse {
    pub(super) fn cancelled() -> Self {
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
    /// Token / context-window usage for the turn (ACP `SessionUpdate::UsageUpdate`
    /// and, behind `unstable_end_turn_token_usage`, `PromptResponse.usage`).
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
