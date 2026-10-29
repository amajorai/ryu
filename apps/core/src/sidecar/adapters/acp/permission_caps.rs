use super::*;

/// What the ACP permission seam does with one `request_permission`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PermissionRoute {
    /// Answer `cancelled` without asking anyone.
    Reject,
    /// Surface the request to the user and wait for their choice.
    AskUser,
    /// Headless only: pick the agent's one-time allow option.
    AllowOnce,
}

/// Decide a permission request from the scan verdict, whether a person can be
/// asked, and the workspace's trust. Headless turns have nobody to consent, so
/// they only auto-approve what a positive scan covers: a shell request Ryu
/// could not read a command from is not "scanned clean", and in an untrusted
/// workspace no shell request is auto-approved at all — the scanner is
/// accident prevention, and a README can ask for a command that matches none
/// of its patterns.
pub(super) fn route_permission(
    scan: &ExecScanOutcome,
    interactive: bool,
    tool_call: &serde_json::Value,
    workspace_trusted: bool,
) -> PermissionRoute {
    match scan {
        ExecScanOutcome::Deny(_) => return PermissionRoute::Reject,
        ExecScanOutcome::ApprovalRequired(_) if !interactive => return PermissionRoute::Reject,
        _ => {}
    }
    if interactive {
        return PermissionRoute::AskUser;
    }
    let executes = tool_call.get("kind").and_then(serde_json::Value::as_str) == Some("execute")
        || extract_exec_command(tool_call).is_some();
    if executes && (!workspace_trusted || extract_exec_command(tool_call).is_none()) {
        return PermissionRoute::Reject;
    }
    PermissionRoute::AllowOnce
}

/// The option a headless turn may choose on the user's behalf: a one-time
/// allow. Never an "always" option, which would persist a rule in the agent's
/// own settings from a run nobody watched.
pub(super) fn headless_allow_once(options: &[PermissionOption]) -> Option<PermissionOptionId> {
    options
        .iter()
        .find(|option| option.kind == PermissionOptionKind::AllowOnce)
        .map(|option| option.option_id.clone())
}

/// Serialize an ACP `ToolKind` to its snake_case wire form (read, execute, …).
pub(super) fn tool_kind_str(kind: &ToolKind) -> String {
    serde_json::to_value(kind)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "other".to_owned())
}

/// Serialize an ACP `ToolCallStatus` to its snake_case wire form.
pub(super) fn tool_status_str(status: &ToolCallStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "pending".to_owned())
}

/// The ACP client capabilities Ryu advertises in `initialize`. File operations
/// are scoped to the session workspaces. Host terminal execution is not
/// advertised until a managed sandbox backend is available; the ACP terminal
/// protocol has no safe way to turn a caller-supplied command into a contained
/// process on this host.
pub(super) fn ryu_client_capabilities() -> ClientCapabilities {
    // These schema structs are `#[non_exhaustive]`, so build from Default and set
    // fields rather than a struct literal.
    let mut caps = ClientCapabilities::default();
    caps.fs.read_text_file = true;
    caps.fs.write_text_file = true;
    // Do not advertise host terminal execution. `terminal/create` is handled
    // defensively below as well because a peer may send it despite the
    // capability projection.
    caps.terminal = false;
    // ACP 3.x agents send `type: "boolean"` config options only to a client that
    // advertises `session.configOptions.boolean`. The 0.11 schema had no such
    // capability and agents sent their toggles unasked, so advertising it keeps
    // the composer's toggles; Core already reads and writes boolean options.
    caps.session = Some(
        agent_client_protocol::schema::v1::ClientSessionCapabilities::new().config_options(
            agent_client_protocol::schema::v1::SessionConfigOptionsCapabilities::new().boolean(
                agent_client_protocol::schema::v1::BooleanConfigOptionCapabilities::default(),
            ),
        ),
    );
    caps
}

/// `initialize` request carrying Ryu's full client capabilities (fs + terminal).
///
/// Since ACP 3.x the SDK validates the reply itself: an agent must answer with
/// a numeric `protocolVersion` of 1, and a missing, string, or other version now
/// fails `initialize` with a "required protocol version" error instead of being
/// read as version 0. That check sits inside the SDK's connection and cannot be
/// relaxed from here; it only rejects agents that do not speak ACP v1, and the
/// error reaches the user through the usual probe/instance start failure.
pub(super) fn ryu_initialize_request() -> InitializeRequest {
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
pub(super) struct AcpCaps {
    /// Agent can resume a prior session via `session/load` (`loadSession`).
    pub(super) load_session: bool,
    /// `promptCapabilities.image` — agent accepts `ContentBlock::Image` prompts.
    pub(super) prompt_image: bool,
    /// `promptCapabilities.audio` — agent accepts `ContentBlock::Audio` prompts.
    pub(super) prompt_audio: bool,
    /// `promptCapabilities.embeddedContext` — agent accepts embedded resources.
    pub(super) prompt_embedded_context: bool,
    /// `mcpCapabilities.http` — agent can connect to HTTP MCP servers.
    pub(super) mcp_http: bool,
    /// `mcpCapabilities.sse` — agent can connect to SSE MCP servers.
    pub(super) mcp_sse: bool,
    /// `sessionCapabilities.list` — agent implements `session/list`.
    pub(super) session_list: bool,
    /// `sessionCapabilities.resume` — agent implements `session/resume`.
    pub(super) session_resume: bool,
    /// `sessionCapabilities.close` — agent implements `session/close`.
    ///
    /// Load-bearing rather than informational: [`close_acp_session`] used to fire
    /// `session/close` at every agent and surface the rejection as a 502. Real
    /// agents disagree here — captured `initialize` responses show pi-acp,
    /// qwen-code and factory-droid advertising NO `close` — so the button that
    /// drives it has to be able to hide itself.
    pub(super) session_close: bool,
}

/// Extract the agent's advertised capabilities from its `initialize` response.
pub(super) fn read_agent_caps(init: &InitializeResponse) -> AcpCaps {
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
        // Only these three are read because only these three drive Core
        // features. ACP 3.x also defines `additionalDirectories` and `delete`
        // (stable) and `fork` (behind `unstable_session_fork`, off here); a
        // `delete` key must not be confused with `close`.
        session_list: caps.session_capabilities.list.is_some(),
        session_resume: caps.session_capabilities.resume.is_some(),
        session_close: caps.session_capabilities.close.is_some(),
    }
}

/// Serialize the agent's capabilities for the desktop (surfaced by the config
/// probe as `agentCapabilities`), so clients can reflect what the agent supports
/// (e.g. show a "Resume" affordance only when `loadSession` is true).
pub(super) fn agent_caps_json(caps: &AcpCaps) -> serde_json::Value {
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
// Ryu does not host ACP terminals: the capability is not advertised (see
// [`ryu_client_capabilities`]) and `terminal/create` fails closed. The other
// `terminal/*` requests are still answered (empty output, no exit status, ack)
// so a peer that sends them anyway never hangs waiting for a reply.

/// `terminal/create` is disabled: Ryu does not spawn agent-requested commands.
///
/// An ACP terminal is an agent-controlled exec path beside the scanned
/// `request_permission` seam, and Core has no verified managed sandbox backend
/// to contain it. Until one exists the request fails closed with this explicit
/// error (the handler answers with a sentinel id whose output/exit lookups are
/// empty, so the agent does not hang). Agents that need a shell must use their
/// own tool path, which goes through the permission seam.
pub(super) fn terminal_create() -> anyhow::Result<String> {
    anyhow::bail!(
        "ACP terminal/create is disabled until a verified managed sandbox backend is available"
    )
}

// ── Turn cancellation (ACP `session/cancel`) ────────────────────────────────────
//
// The desktop Stop button aborts the SSE, but Core's completion task deliberately
// runs the ACP turn to completion after a client *disconnect* (so the assistant
// message still persists). An *explicit* stop is different: the user wants the
// agent to actually stop. `POST /api/chat/cancel` → [`request_cancel`] sets the
// active turn's flag; the turn loop then sends an ACP `CancelNotification`
// (`session/cancel`) to the agent and ends the turn.
