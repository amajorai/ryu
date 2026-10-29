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
