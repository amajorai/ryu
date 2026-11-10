//! Server availability probes and per-agent capability filtering.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use super::*;

/// Best-effort check of whether a server's `command` is present on disk.
///
/// An absolute or relative path (e.g. the built-in Ghost binary at
/// `~/.ryu/bin/ghost`) can be checked with a filesystem probe, surfacing a
/// clear "not yet available" state in `GET /api/mcp/servers` before the user
/// installs the sidecar. A bare command resolved via `PATH` (e.g. `npx`,
/// `uvx`) returns `None` — we don't walk `PATH` here; the lazy `tools/list`
/// already degrades gracefully if such a server can't be spawned.
pub(super) fn command_availability(command: &str) -> Option<bool> {
    let path = std::path::Path::new(command);
    let looks_like_path = path.is_absolute() || command.contains(['/', '\\']);
    if looks_like_path {
        Some(path.exists())
    } else {
        None
    }
}

/// Transport-aware wrapper around [`command_availability`].
///
/// A **remote** entry is `Some(true)` whenever it names a URL: there is nothing
/// installed locally to look for, so the only honest local answer is "yes, this
/// is reachable in principle". Whether the endpoint actually answers is a network
/// question the lazy `tools/list` already surfaces as a real error.
///
/// Without this split a remote server would go down `command_availability`'s
/// path with an empty string: not absolute, no separator ⇒ `None`, i.e. "can't
/// tell" — which the UI renders as an indefinite state for a server that is
/// perfectly well defined. `Some(false)` would be worse still ("not yet
/// available", prompting the user to install something that does not exist).
pub(super) fn config_availability(cfg: &McpServerConfig) -> Option<bool> {
    match cfg.transport_kind() {
        McpTransportKind::Http | McpTransportKind::Sse => {
            Some(cfg.url.as_deref().is_some_and(|u| !u.trim().is_empty()))
        }
        McpTransportKind::Stdio => command_availability(cfg.command.as_deref().unwrap_or("")),
    }
}

/// The fully-qualified id of the privileged agent-creation tool — gated by
/// [`AgentCapabilities::can_create_agents`]. Other `agent_builder.*` tools
/// (read/configure existing agents) are not creation and stay available.
pub const CREATE_AGENT_TOOL_ID: &str = "agent_builder.create_agent";

/// The fully-qualified id of the team-creation tool. It mints permanent agents
/// (a whole roster), so it is gated by the same [`AgentCapabilities::can_create_agents`]
/// as [`CREATE_AGENT_TOOL_ID`].
pub const CREATE_AGENT_TEAM_TOOL_ID: &str = "agent_builder.create_agent_team";

/// An agent's orchestration capabilities, resolved from its config record.
#[derive(Debug, Clone, Copy)]
pub struct AgentCapabilities {
    /// May discover peers (`orchestrator.*`) and delegate to them (`delegate.*`).
    pub orchestrator: bool,
    /// May mint new agents (`agent_builder.create_agent`).
    pub can_create_agents: bool,
}

impl Default for AgentCapabilities {
    /// The safe defaults: delegation **on** (historical default-available
    /// behaviour), agent-creation **off** (privileged, opt-in per agent).
    fn default() -> Self {
        Self {
            orchestrator: true,
            can_create_agents: false,
        }
    }
}

/// Remove capability-gated tools from an offered set per an agent's
/// [`AgentCapabilities`]. Withholds the delegation/discovery providers when
/// `orchestrator` is off and the agent-creation tool when `can_create_agents`
/// is off. Tools unrelated to these capabilities pass through untouched.
pub fn filter_capability_tools(
    tools: Vec<RegistryTool>,
    caps: AgentCapabilities,
) -> Vec<RegistryTool> {
    tools
        .into_iter()
        .filter(|tool| {
            if !caps.orchestrator
                && (tool.server == delegate::SERVER_NAME
                    || tool.server == orchestrator::SERVER_NAME)
            {
                return false;
            }
            if !caps.can_create_agents
                && (tool.id == CREATE_AGENT_TOOL_ID || tool.id == CREATE_AGENT_TEAM_TOOL_ID)
            {
                return false;
            }
            true
        })
        .collect()
}

/// Whether `tool` passes an allowlist. A list entry matches if it equals the
/// tool's fully-qualified id, its bare name, or its owning server name.
pub(in crate::sidecar) fn tool_allowed(tool: &RegistryTool, allowlist: &[String]) -> bool {
    if allowlist
        .iter()
        .any(|entry| entry == crate::agents::ALL_MCP_TOOLS)
    {
        return true;
    }
    let canonical_id = canonical_tool_id(&tool.id);
    allowlist.iter().any(|entry| {
        canonical_tool_id(entry) == canonical_id || entry == &tool.name || entry == &tool.server
    })
}
