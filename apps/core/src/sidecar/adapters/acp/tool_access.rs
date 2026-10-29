use super::*;

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
/// [`super::acp_mcp_over_acp`] (the wire ACP 0.11's
/// `SessionBuilder::with_mcp_server` spoke), which pushes a `McpServer::Http`
/// entry (an `acp:<uuid>` pseudo-URL served back over the ACP connection), and
/// `agent-client-protocol-schema` documents `McpCapabilities::http` as, verbatim,
/// "Agent supports `McpServer::Http`".
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
/// Watch item: codex-acp returned an `acp: false` member inside `mcpCapabilities`.
/// `agent-client-protocol` 3.x defines it (behind `unstable_mcp_over_acp`) as
/// support for a new `type: "acp"` server with request-scoped `mcp/message`, a
/// different wire from the `_mcp/*` one Ryu speaks. Core does not enable that
/// feature or declare such servers; if Ryu ever moves to that binding, gate it on
/// `mcpCapabilities.acp` (an agent that does not advertise it cannot use the entry,
/// and a strict one may reject `session/new` over it) and re-verify this comment.
pub(super) fn acp_bridge_supported(spawn_cmd: &str) -> bool {
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
    pub(super) fn as_str(self) -> &'static str {
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
pub(super) fn ryu_tool_access(spawn_cmd: &str) -> RyuToolAccess {
    if acp_bridge_supported(spawn_cmd) {
        return RyuToolAccess::Bridge;
    }
    if spawn_cmd.contains("PI_CODING_AGENT_DIR") {
        return RyuToolAccess::PiExtension;
    }
    RyuToolAccess::None
}

/// Whether this turn runs Ryu's managed Pi with the `ryu-mcp` extension: the
/// flagship itself, a built-in that borrows its engine under its own agent id
/// (Jay Jr. or Patrol, see [`crate::agents::runs_on_ryu_engine`]), or a limited
/// custom agent on the "Ryu" engine, whose spawn reads the credential-free
/// limited Pi config (see [`crate::agents::runs_limited_on_managed_pi`]). The
/// tool broker then scopes the extension to that agent's allowlist.
pub(crate) fn is_managed_pi_extension(spawn_cmd: &str, agent_id: &str) -> bool {
    ryu_tool_access(spawn_cmd) == RyuToolAccess::PiExtension
        && (agent_id == "ryu"
            || crate::agents::runs_on_ryu_engine(agent_id)
            || limited_managed_pi_spawn(
                spawn_cmd,
                &crate::pi_config::limited_agent_dir(Some(agent_id)),
            ))
}

/// Whether `spawn_cmd` is a Pi spawn that reads the limited-agent Pi config
/// `limited_dir` as its only config. Only
/// [`crate::pi_config::agent_config_dir_str`] writes that dir, with no user
/// provider credential and only the Gateway pin, so a spawn naming it can reach
/// models only through Gateway.
pub(super) fn limited_managed_pi_spawn(spawn_cmd: &str, limited_dir: &std::path::Path) -> bool {
    let Ok(agent) = AcpSpawn::from_str(spawn_cmd) else {
        return false;
    };
    let agent_client_protocol::schema::v1::McpServer::Stdio(stdio) = agent.into_server() else {
        return false;
    };
    let mut config_dirs = stdio
        .env
        .iter()
        .filter(|variable| variable.name == "PI_CODING_AGENT_DIR");
    config_dirs
        .next()
        .is_some_and(|variable| PathBuf::from(&variable.value) == limited_dir)
        && config_dirs.next().is_none()
}

pub(crate) fn is_direct_managed_pi_account_spawn(spawn_cmd: &str) -> bool {
    direct_managed_pi_account_spawn(
        spawn_cmd,
        crate::pi_config::is_gateway_routing(),
        &crate::pi_config::config_dir(),
        &managed_pi_binary(),
    )
}

pub(super) fn direct_managed_pi_account_spawn(
    spawn_cmd: &str,
    gateway_routing: bool,
    config_directory: &std::path::Path,
    managed_binary: &std::path::Path,
) -> bool {
    if gateway_routing {
        return false;
    }
    let Ok(agent) = AcpSpawn::from_str(spawn_cmd) else {
        return false;
    };
    let agent_client_protocol::schema::v1::McpServer::Stdio(stdio) = agent.into_server() else {
        return false;
    };
    stdio.env.iter().any(|variable| {
        variable.name == "PI_CODING_AGENT_DIR" && PathBuf::from(&variable.value) == config_directory
    }) && stdio.env.iter().any(|variable| {
        variable.name == "PI_ACP_PI_COMMAND" && PathBuf::from(&variable.value) == managed_binary
    }) && !stdio
        .env
        .iter()
        .any(|variable| variable.name == "OPENAI_BASE_URL")
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
pub(super) fn acp_tool_bridge_enabled(spawn_cmd: &str, agent_id: &str) -> bool {
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
///
/// Every turn handed to the instance gets an answer. When the instance ends
/// with an error, the turns still queued on it are failed with a classified
/// [`AcpFailure`]: dropping them would close their streams with no event, which
/// the chat consumer finishes as an empty, successful reply.
pub async fn run_acp_instance(
    spawn_cmd: String,
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    environment: Vec<(String, String)>,
    session_grant: Option<crate::server::acp_tool_broker::AcpToolSessionGrant>,
    // Held for the whole instance: dropping it revokes the credential.
    inference_grant: Option<crate::server::acp_inference_proxy::AcpInferenceGrant>,
    turns_rx: mpsc::UnboundedReceiver<AcpTurn>,
    activity: Option<Arc<AcpInstanceActivity>>,
    // What the OS sandbox hides because of the agent's account access. Part
    // of the pool key, so a policy change starts a fresh process.
    account_confinement: crate::agent_access::AccountConfinement,
) -> anyhow::Result<()> {
    let mut turns_rx = turns_rx;
    let mut session_live = false;
    let mut first_turn: UnservedFirstTurn = None;
    let result = serve_acp_instance(
        spawn_cmd,
        cwd,
        additional_directories,
        environment,
        session_grant,
        inference_grant,
        &mut turns_rx,
        &mut session_live,
        &mut first_turn,
        activity,
        account_confinement,
    )
    .await;
    if let Err(error) = &result {
        let (failure, auth_message) = if session_live {
            // The turn in flight was already told the connection dropped; the
            // ones behind it never reached the agent.
            let failure = AcpFailure {
                code: "acp_transport_error".to_owned(),
                title: "Agent connection lost".to_owned(),
                message: format!(
                    "The agent connection ended before this message was sent: {error:#}"
                ),
            };
            (failure, None)
        } else {
            instance_start_failure(error)
        };
        if let Some((events, agent_id)) = first_turn.take() {
            if let Some(message) = auth_message.clone() {
                let _ = events.send(AcpEvent::AuthNeeded { agent_id, message });
            }
            let _ = events.send(AcpEvent::Error(failure.clone()));
        }
        fail_queued_turns(&mut turns_rx, &failure, auth_message.as_deref());
    }
    result
}
