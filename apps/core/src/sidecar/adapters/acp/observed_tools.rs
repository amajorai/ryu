use super::*;

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

/// Distinct tool titles kept per agent. ACP titles are often per-call text
/// ("Read src/foo.rs", "Run `npm test`"), so an uncapped map grew with nearly
/// every tool call for the life of the process; the list only needs to show
/// what an agent tends to use.
pub(super) const MAX_OBSERVED_TOOLS_PER_AGENT: usize = 128;

/// Record a tool the given agent invoked so a later `list_tools` call can
/// report it. Keyed by tool title; the ACP `kind` is kept as the description.
pub fn record_observed_tool(agent_id: &str, title: &str, kind: &str) {
    if title.is_empty() {
        return;
    }
    if let Ok(mut map) = observed_tools().lock() {
        let agent_tools = map.entry(agent_id.to_owned()).or_default();
        if agent_tools.len() >= MAX_OBSERVED_TOOLS_PER_AGENT && !agent_tools.contains_key(title) {
            return;
        }
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
