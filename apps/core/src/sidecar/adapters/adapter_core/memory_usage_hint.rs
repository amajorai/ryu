//! The standing memory-usage guide for the cached system block.
//!
//! An agent that is handed memory tools but never told what memory is for
//! reads it far less often than it should. This layer says, in a few constant
//! sentences, what memory holds and when to consult and correct it. It names
//! only the memory tools the turn actually offers, by their registry ids, and
//! carries nothing per-turn (no time, no query), so the same tool set always
//! yields the same bytes and the provider's prompt-cache prefix holds. It
//! deliberately sets no rules for what to save: that stays the agent's call
//! and the memory write policy's.

use std::borrow::Cow;

use super::*;

/// Registry id of the long-term memory recall verb.
pub(crate) const MEMORY_SEARCH_TOOL_ID: &str = "memory.search";
/// Registry id of the long-term memory write verb.
pub(crate) const MEMORY_STORE_TOOL_ID: &str = "memory.store";
/// Registry id of the past-chat search tool (`search_conversations::tools`).
pub(crate) const PAST_CHATS_TOOL_ID: &str = "search_conversations.search";
/// Registry id of the working-memory update tool (`working_memory_tool::tools`).
pub(crate) const WORKING_MEMORY_TOOL_ID: &str = "working_memory.update_working_memory";

/// How every guide starts. The guide holds no blank line, so in a system block
/// it runs from here to the next blank line or the end.
const MEMORY_HINT_OPENING: &str = "## Memory\nMemory is how you keep continuity across sessions:";

/// The memory tools one turn offers its model.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub(crate) struct OfferedMemoryTools {
    pub(crate) search: bool,
    pub(crate) store: bool,
    pub(crate) past_chats: bool,
    pub(crate) working_memory: bool,
}

impl OfferedMemoryTools {
    /// Pick the memory tools out of the ids a turn offers. Working memory
    /// counts only when the turn also carries its block: the update tool is
    /// listed for every agent but refuses unless the agent enabled it.
    pub(crate) fn from_tool_ids<'a>(
        tool_ids: impl IntoIterator<Item = &'a str>,
        working_memory_active: bool,
    ) -> Self {
        let mut offered = Self::default();
        for id in tool_ids {
            match id {
                MEMORY_SEARCH_TOOL_ID => offered.search = true,
                MEMORY_STORE_TOOL_ID => offered.store = true,
                PAST_CHATS_TOOL_ID => offered.past_chats = true,
                WORKING_MEMORY_TOOL_ID => offered.working_memory = working_memory_active,
                _ => {}
            }
        }
        offered
    }

    fn any(self) -> bool {
        self.search || self.store || self.past_chats || self.working_memory
    }
}

/// The guide for `tools`, or `None` when the turn offers no memory tool.
pub(crate) fn memory_usage_hint(tools: OfferedMemoryTools) -> Option<String> {
    if !tools.any() {
        return None;
    }
    let mut lines = vec![format!(
        "{MEMORY_HINT_OPENING} the user's preferences, decisions and the reasons behind \
         them, lessons from past failures, and rules that have been tested."
    )];
    let mut reads = Vec::new();
    if tools.search {
        reads.push(format!("`{MEMORY_SEARCH_TOOL_ID}` for saved notes"));
    }
    if tools.past_chats {
        reads.push(format!("`{PAST_CHATS_TOOL_ID}` for past chats"));
    }
    if !reads.is_empty() {
        lines.push(format!(
            "Before relying on an assumption about the user, their work or an earlier \
             conversation, check what is relevant: {}.",
            reads.join(" and ")
        ));
    }
    lines.push(
        "A remembered note can be stale or wrong, so verify one that matters before \
         acting on it."
            .to_owned(),
    );
    if tools.store {
        lines.push(format!(
            "When a note turns out to be wrong, correct it with `{MEMORY_STORE_TOOL_ID}`; \
             what else is worth keeping is your call."
        ));
    }
    if tools.working_memory {
        lines.push(format!(
            "Keep this conversation's working notes current with `{WORKING_MEMORY_TOOL_ID}`."
        ));
    }
    Some(lines.join("\n"))
}

/// [`memory_usage_hint`] under the Safe Mode rule every standing Core layer
/// follows: a baseline turn carries nothing extra.
pub(crate) fn memory_usage_hint_when(safe_mode: bool, tools: OfferedMemoryTools) -> Option<String> {
    if safe_mode {
        return None;
    }
    memory_usage_hint(tools)
}

/// Whether `route` hands this turn's tool allowlist to the model.
///
/// ACP agents always reach Core's tools through the MCP bridge. On the
/// OpenAI-compatible plane only a Gateway hop runs a tool loop, and it does so
/// on every turn only when Core sends an explicit allowlist (`x-ryu-tools`); an
/// unrestricted agent gets tools there only on turns with capability hints,
/// which vary with the message and so cannot steer a cached layer. Every other
/// route offers no Core tools.
pub(crate) fn route_offers_turn_tools(route: &AgentRoute, allowlist: Option<&[String]>) -> bool {
    match route {
        AgentRoute::Acp { .. } => true,
        AgentRoute::OpenAiCompat {
            via_gateway: true, ..
        } => allowlist.is_some(),
        _ => false,
    }
}

/// The guide for this turn: the memory tools `route` offers under `allowlist`.
pub(crate) async fn turn_memory_usage_hint(
    route: &AgentRoute,
    mcp: &McpRegistry,
    allowlist: Option<&[String]>,
    working_memory_active: bool,
) -> Option<String> {
    if crate::safe_mode::is_active() || !route_offers_turn_tools(route, allowlist) {
        return None;
    }
    let visible = mcp.tools_for_agent(allowlist).await;
    let offered = OfferedMemoryTools::from_tool_ids(
        visible.iter().map(|tool| tool.id.as_str()),
        working_memory_active,
    );
    memory_usage_hint_when(false, offered)
}

/// `system` without the memory guide, for a leg that offers no tools.
///
/// The guide is added before dispatch for a route that offers tools, but a
/// Gateway turn can still end up on a leg that offers none: the direct-provider
/// path when the Gateway is down, or the fallback provider after the Gateway
/// hop fails. A guide naming tools the model cannot call invites it to fake the
/// calls, so such a leg drops it. It undoes the blank-line join that put the
/// guide in, so the rest of the block is unchanged; a block without the guide
/// comes back as it was.
pub(crate) fn system_without_memory_usage_hint(system: &str) -> Cow<'_, str> {
    let joined = format!("\n\n{MEMORY_HINT_OPENING}");
    let (start, body) = if system.starts_with(MEMORY_HINT_OPENING) {
        (0, 0)
    } else if let Some(index) = system.find(&joined) {
        (index, index + 2)
    } else {
        return Cow::Borrowed(system);
    };
    let end = system[body..]
        .find("\n\n")
        .map_or(system.len(), |offset| body + offset);
    let rest = if start == 0 {
        system[end..].strip_prefix("\n\n").unwrap_or("")
    } else {
        &system[end..]
    };
    Cow::Owned(format!("{}{rest}", &system[..start]))
}

/// [`system_without_memory_usage_hint`] for an optional system block; a block
/// that held only the guide becomes `None`.
pub(crate) fn long_term_system_without_memory_usage_hint(system: Option<String>) -> Option<String> {
    let system = system?;
    let stripped = match system_without_memory_usage_hint(&system) {
        Cow::Borrowed(_) => return Some(system),
        Cow::Owned(stripped) => stripped,
    };
    (!stripped.is_empty()).then_some(stripped)
}

/// `messages` with the memory guide taken out of every system message; a
/// system message that held only the guide is dropped.
pub(crate) fn messages_without_memory_usage_hint(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|message| {
            let content = match (message["role"].as_str(), message["content"].as_str()) {
                (Some("system"), Some(content)) => content,
                _ => return Some(message.clone()),
            };
            let stripped = system_without_memory_usage_hint(content);
            if stripped.is_empty() {
                return None;
            }
            let mut message = message.clone();
            message["content"] = Value::String(stripped.into_owned());
            Some(message)
        })
        .collect()
}

#[cfg(test)]
#[path = "memory_usage_hint_tests.rs"]
mod tests;
