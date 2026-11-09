use super::*;

/// Resolve the effective MCP tool allowlist for a chat turn. An environment
/// override remains the highest-priority operator control; otherwise the
/// persisted agent card supplies the per-agent setting. A missing record keeps
/// the historical unrestricted behavior for registry-only callers.
pub(crate) async fn resolve_agent_tool_allowlist(
    agent_id: Option<&str>,
    registry: &AcpAgentRegistry,
    store: &AgentStore,
) -> Option<Vec<String>> {
    let Some(id) = agent_id else {
        return None;
    };
    if let Some(allowlist) = registry.allowlist_for(id) {
        return Some(allowlist);
    }
    match store.get(id).await {
        Ok(Some(record)) => record.mcp_tool_allowlist(),
        Ok(None) => None,
        Err(error) => {
            // `None` means unrestricted to the registry. A failed store read
            // must therefore fail closed rather than turning a transient DB
            // error into access to every tool.
            tracing::warn!(agent = id, error = %error, "agent allowlist lookup failed");
            Some(Vec::new())
        }
    }
}

/// The tool allowlist a chat turn offers on `route`, narrowed in order by the
/// public-agent policy, the unverified-caller list, the read-only flag (the
/// OpenAI-compatible plane only; the route gate refuses it elsewhere) and the
/// withheld working-memory tool. `None` is unrestricted. Routes that offer no
/// Core tools (A2A, local engines, SDK apps, a direct provider) resolve nothing
/// and get `None`; nothing on them reads it.
pub(crate) async fn turn_tool_allowlist(
    req: &ChatStreamRequest,
    route: &AgentRoute,
    agent_id: Option<&str>,
    registry: &AcpAgentRegistry,
    store: &AgentStore,
    mcp: &McpRegistry,
    working_memory_tool_withheld: bool,
) -> Option<Vec<String>> {
    let apply_read_only = match route {
        AgentRoute::Acp { .. } => false,
        AgentRoute::OpenAiCompat {
            via_gateway: true, ..
        } => true,
        _ => return None,
    };
    let allowlist = resolve_agent_tool_allowlist(agent_id, registry, store).await;
    let allowlist = match req.public_agent_policy.as_ref() {
        Some(policy) => Some(restrict_public_agent_tool_allowlist(mcp, allowlist, policy).await),
        None => allowlist,
    };
    let allowlist = caller_scoped_tool_allowlist(req.untrusted_caller, mcp, allowlist);
    let allowlist = if apply_read_only && req.read_only_tools {
        Some(restrict_read_only_tool_allowlist(mcp, allowlist).await)
    } else {
        allowlist
    };
    if working_memory_tool_withheld {
        Some(withhold_working_memory_tool_allowlist(mcp, allowlist).await)
    } else {
        allowlist
    }
}

pub(crate) fn restrict_public_agent_skills(
    current: &mut Vec<String>,
    policy: &PublicAgentRunPolicy,
) {
    let allowed = policy.identifiers("skill");
    let explicitly_empty = current
        .iter()
        .any(|skill| skill == crate::agents::NO_AGENT_CAPABILITIES);
    if explicitly_empty {
        current.clear();
    } else if current.is_empty() {
        *current = allowed.into_iter().collect();
    } else {
        current.retain(|skill| allowed.contains(skill));
    }
    if current.is_empty() {
        current.push(crate::agents::NO_AGENT_CAPABILITIES.to_owned());
    }
}

pub(crate) async fn restrict_public_agent_tool_allowlist(
    mcp: &McpRegistry,
    current: Option<Vec<String>>,
    policy: &PublicAgentRunPolicy,
) -> Vec<String> {
    let visible = mcp.tools_for_agent(current.as_deref()).await;
    filter_public_agent_tools(visible, policy)
}

pub(crate) fn filter_public_agent_tools(
    tools: impl IntoIterator<Item = crate::sidecar::mcp::RegistryTool>,
    policy: &PublicAgentRunPolicy,
) -> Vec<String> {
    let allowed = policy.identifiers("tool");
    tools
        .into_iter()
        .filter(|tool| {
            allowed.contains(&tool.id)
                && tool
                    .annotations
                    .as_ref()
                    .and_then(|annotations| annotations.get("readOnlyHint"))
                    .and_then(Value::as_bool)
                    == Some(true)
        })
        .map(|tool| tool.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// Narrow an agent's tool allowlist to the tools annotated `readOnlyHint: true`.
/// The result is always `Some`-shaped by the caller, so an empty vector means
/// "no tools" (never "all tools").
pub(crate) async fn restrict_read_only_tool_allowlist(
    mcp: &McpRegistry,
    current: Option<Vec<String>>,
) -> Vec<String> {
    let visible = mcp.tools_for_agent(current.as_deref()).await;
    filter_read_only_tools(visible)
}

/// Narrow a tool allowlist so `working_memory.update_working_memory` is neither
/// offered nor dispatchable on a turn whose working-memory block was withheld.
/// The result is an explicit list (an empty vector means "no tools"), because the
/// allowlist grammar has no negation and `None` would keep the tool reachable.
pub(crate) async fn withhold_working_memory_tool_allowlist(
    mcp: &McpRegistry,
    current: Option<Vec<String>>,
) -> Vec<String> {
    let visible = mcp.tools_for_agent(current.as_deref()).await;
    filter_out_working_memory_tool(visible)
}

pub(crate) fn filter_out_working_memory_tool(
    tools: impl IntoIterator<Item = crate::sidecar::mcp::RegistryTool>,
) -> Vec<String> {
    let withheld = format!(
        "{}.{}",
        crate::sidecar::mcp::working_memory_tool::SERVER_NAME,
        crate::server::memory_working::UPDATE_TOOL_NAME
    );
    tools
        .into_iter()
        .filter(|tool| tool.id != withheld)
        .map(|tool| tool.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn filter_read_only_tools(
    tools: impl IntoIterator<Item = crate::sidecar::mcp::RegistryTool>,
) -> Vec<String> {
    tools
        .into_iter()
        .filter(|tool| {
            tool.annotations
                .as_ref()
                .and_then(|annotations| annotations.get("readOnlyHint"))
                .and_then(Value::as_bool)
                == Some(true)
        })
        .map(|tool| tool.id)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

pub(crate) fn intersect_public_agent_tool_ids(
    tool_ids: impl IntoIterator<Item = String>,
    policy: &PublicAgentRunPolicy,
) -> Vec<String> {
    let allowed = policy.identifiers("tool");
    tool_ids
        .into_iter()
        .filter(|tool_id| allowed.contains(tool_id))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}
