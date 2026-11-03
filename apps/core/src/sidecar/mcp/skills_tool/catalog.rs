//! The `skills.*` tool catalog: the author opt-in, the server description,
//! and each tool's input schema.

use super::*;

/// Whether skill self-authoring is enabled on this node. Default `false`; enabled
/// when `RYU_SKILLS_AUTHOR` is a truthy value (`1` / `true` / `yes` / `on`).
pub(super) fn author_enabled() -> bool {
    std::env::var(AUTHOR_FLAG_ENV)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// The `skills` row's description for `GET /api/mcp/servers`.
///
/// Lives here rather than as an inline literal in `McpRegistry::list_servers` (where
/// every other built-in server's text does) for one reason: it has to agree with
/// [`author_enabled`], and the previous inline literal did not — it advertised
/// `skills.author` unconditionally while [`tools`] only offers it when the opt-in is
/// set, so on a stock node the listing named a tool that was not there. Keeping the
/// string next to the gate is what makes the two impossible to drift apart.
pub(crate) fn server_description() -> String {
    let mut text = "Built-in skills: discover and load Agent Skills on demand \
                    (skills.search / skills.load) instead of injecting every skill body \
                    up front — progressive disclosure for low-context models."
        .to_owned();
    if author_enabled() {
        text.push_str(
            " skills.author writes a structured, reusable SKILL.md — creating a new slug, \
             or refining one the calling agent is allowed to load.",
        );
    }
    text
}

pub(super) fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What you want to accomplish. Matched against skill names and descriptions."
            },
            "limit": {
                "type": "integer",
                "description": "Max results to return (default 10)."
            }
        },
        "required": ["query"]
    })
}

pub(super) fn load_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "The skill id to load (as shown in the available-skills list or returned by skills.search)."
            }
        },
        "required": ["id"]
    })
}

pub(super) fn author_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Human-readable skill name, e.g. \"Resolve merge conflicts\"."
            },
            "slug": {
                "type": "string",
                "description": "Optional stable id / directory name. Sanitized to a single safe path segment (alphanumerics, '-', '_', '.'). Derived from the name when omitted. Reuse the same slug to refine that skill — allowed only for skills in your available-skills list; use a slug no installed skill already uses otherwise."
            },
            "description": {
                "type": "string",
                "description": "One-line summary shown in the always-on skill index (L1). Keep it short and task-focused."
            },
            "purpose": {
                "type": "string",
                "description": "When and why to use this skill — the situation it applies to."
            },
            "procedure": {
                "type": "string",
                "description": "The step-by-step method to follow. This is the core of the skill."
            },
            "failure_modes": {
                "type": "string",
                "description": "Known pitfalls, edge cases, and what to avoid."
            },
            "verification": {
                "type": "string",
                "description": "How to confirm the task actually succeeded."
            },
            "allowed_tools": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Optional list of tool names this skill declares it needs."
            }
        },
        "required": ["name", "purpose", "procedure", "failure_modes", "verification"]
    })
}

/// The skills tools exposed through the registry.
///
/// `search` and `load` are always present; `author` is added only when the
/// self-authoring opt-in ([`author_enabled`]) is set, so the default surface is
/// unchanged.
pub fn tools() -> Vec<RegistryTool> {
    let mut tools = vec![
        RegistryTool {
            id: SEARCH_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "search".to_owned(),
            description: Some(
                "Search available Agent Skills by task. Returns a ranked list of \
                 { id, name, description }. Call skills.load with an id to read a \
                 skill's full instructions before acting on it."
                    .to_owned(),
            ),
            input_schema: Some(search_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: LOAD_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "load".to_owned(),
            description: Some(
                "Load an Agent Skill's full instructions by id. Returns \
                 { ok, id, name, instructions }. Read the instructions and follow \
                 them for the rest of this turn. Call this when a skill listed as \
                 available is relevant to the user's request."
                    .to_owned(),
            ),
            input_schema: Some(load_schema()),
            ..Default::default()
        },
    ];
    if author_enabled() {
        tools.push(RegistryTool {
            id: AUTHOR_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "author".to_owned(),
            description: Some(
                "Write a new, reusable Agent Skill as a structured SKILL.md \
                 (Purpose / Procedure / Failure modes / Verification) into the \
                 shared skills directory. Call this after solving a complex task to \
                 capture the method for reuse. An UNUSED slug is always created; \
                 re-authoring a slug that any installed skill already uses refines \
                 (replaces) it, which is allowed only for skills in your \
                 available-skills list — if it is refused, author under a different \
                 slug instead of retrying. A created skill is activated (so \
                 skills.search / skills.load see it immediately) unless it fell \
                 outside your available skills, in which case it is saved for the \
                 user to activate. Returns { ok, id, path, refined, active }."
                    .to_owned(),
            ),
            input_schema: Some(author_schema()),
            ..Default::default()
        });
    }
    tools
}
