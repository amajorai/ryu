//! Built-in **skills** tool server — the progressive-disclosure bridge between
//! Agent Skills and the unified tool gateway.
//!
//! Historically Core injected the *full body* of every enabled skill into the
//! system prompt on every turn (`skills::SkillRegistry::skill_block`), which
//! bloats context and hurts low-context local models the most. The Agent Skills
//! standard instead uses **progressive disclosure**: only a skill's name +
//! description (L1) is always in context, and its full instructions (L2) load on
//! demand when the model decides the skill is relevant.
//!
//! This server is the L2 loader. It exposes two tools through the same registry /
//! `tool_search` plumbing as every other tool, so a model discovers and loads a
//! skill exactly like any other capability:
//!
//! - `skills__search { query }` — find skills by task (id, name, description).
//! - `skills__load { id }` — return a skill's full instruction body. The returned
//!   text *is* the injection: the model reads it as the tool result and follows it
//!   for the rest of the turn (the same mechanism as Claude Code's Skill tool).
//!
//! ## Architecture note (Core-vs-Gateway)
//!
//! Deciding *what skills run* is Core, so this lives here as a reserved server name
//! (`skills`) like `web_fetch`/`threads`. A skill stays **instruction text**, not a
//! function call — this server only borrows the gateway's discovery mechanism; it
//! returns instructions, never executes them. The Gateway still governs egress /
//! budget / audit of the underlying model call.
//!
//! ## v1 scope (honest)
//!
//! - `load`/`search` operate over the **globally enabled** (active) skill set. The
//!   per-agent *skill* allowlist scopes what the model *sees* in the L1 index
//!   (`progressive_block`), but is not re-enforced here, so an agent could load an
//!   enabled-but-not-listed skill by id. Skills are instruction text (no secrets),
//!   so this is a soft scope, not a security boundary.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::skills::SkillRegistry;

/// Reserved registry server name for the built-in skills provider.
pub const SERVER_NAME: &str = "skills";

/// Fully-qualified ids of the two tools this provider exposes.
pub const SEARCH_TOOL_ID: &str = "skills__search";
pub const LOAD_TOOL_ID: &str = "skills__load";

/// Default / max search results.
const SEARCH_DEFAULT_LIMIT: usize = 10;
const SEARCH_MAX_LIMIT: usize = 25;

fn search_schema() -> Value {
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

fn load_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "id": {
                "type": "string",
                "description": "The skill id to load (as shown in the available-skills list or returned by skills__search)."
            }
        },
        "required": ["id"]
    })
}

/// The skills tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: SEARCH_TOOL_ID.to_owned(),
            server: SERVER_NAME.to_owned(),
            name: "search".to_owned(),
            description: Some(
                "Search available Agent Skills by task. Returns a ranked list of \
                 { id, name, description }. Call skills__load with an id to read a \
                 skill's full instructions before acting on it."
                    .to_owned(),
            ),
            input_schema: Some(search_schema()),
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
        },
    ]
}

/// Dispatch a `skills` tool call against the live skill registry.
///
/// `Err` only for a malformed call (unknown tool / missing required arg); an
/// unknown or inactive skill id is a structured `Ok({ok:false,...})` so the
/// agent's turn continues.
pub async fn dispatch(tool: &str, arguments: Value, registry: &SkillRegistry) -> Result<Value> {
    match tool {
        "search" => do_search(arguments, registry),
        "load" => do_load(arguments, registry),
        other => Err(anyhow::anyhow!("unknown skills tool '{other}'")),
    }
}

fn do_search(arguments: Value, registry: &SkillRegistry) -> Result<Value> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument 'query'"))?;
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, SEARCH_MAX_LIMIT))
        .unwrap_or(SEARCH_DEFAULT_LIMIT);

    let needle = query.to_lowercase();
    let mut scored: Vec<(i32, Value)> = registry
        .enabled()
        .iter()
        .filter_map(|s| {
            let score = skill_match_score(s, &needle);
            if score <= 0 {
                return None;
            }
            Some((
                score,
                json!({
                    "id": s.id,
                    "name": s.name,
                    "description": s.description,
                }),
            ))
        })
        .collect();
    // Highest score first; stable on ties.
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<Value> = scored.into_iter().take(limit).map(|(_, v)| v).collect();

    Ok(json!({ "ok": true, "results": results }))
}

/// Cheap relevance score: weight name/id hits over description over body. A
/// blank-ish query (already filtered out) never reaches here.
fn skill_match_score(s: &crate::skills::SkillRecord, needle: &str) -> i32 {
    let mut score = 0;
    if s.name.to_lowercase().contains(needle) {
        score += 5;
    }
    if s.id.to_lowercase().contains(needle) {
        score += 4;
    }
    if let Some(d) = &s.description {
        if d.to_lowercase().contains(needle) {
            score += 3;
        }
    }
    if s.instructions.to_lowercase().contains(needle) {
        score += 1;
    }
    score
}

fn do_load(arguments: Value, registry: &SkillRegistry) -> Result<Value> {
    let id = arguments
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument 'id'"))?;

    match registry.enabled().into_iter().find(|s| s.id == id) {
        Some(s) => Ok(json!({
            "ok": true,
            "id": s.id,
            "name": s.name,
            "instructions": s.instructions,
        })),
        None => Ok(json!({
            "ok": false,
            "id": id,
            "error": format!("no enabled skill with id '{id}'. Use skills__search to find one."),
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::SkillRecord;

    fn registry_with(skills: Vec<SkillRecord>) -> SkillRegistry {
        let reg = SkillRegistry::empty();
        reg.replace_for_test(skills);
        reg
    }

    fn skill(id: &str, name: &str, desc: &str, body: &str, enabled: bool) -> SkillRecord {
        SkillRecord {
            id: id.to_owned(),
            name: name.to_owned(),
            description: Some(desc.to_owned()),
            instructions: body.to_owned(),
            allowed_tools: vec![],
            enabled,
            always_on: false,
        }
    }

    #[test]
    fn lists_two_tools_with_qualified_ids() {
        let tools = tools();
        assert_eq!(tools.len(), 2);
        assert!(tools.iter().any(|t| t.id == SEARCH_TOOL_ID));
        assert!(tools.iter().any(|t| t.id == LOAD_TOOL_ID));
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let reg = registry_with(vec![]);
        assert!(dispatch("nope", json!({}), &reg).await.is_err());
    }

    #[tokio::test]
    async fn load_missing_id_is_an_error() {
        let reg = registry_with(vec![]);
        assert!(dispatch("load", json!({}), &reg).await.is_err());
    }

    #[tokio::test]
    async fn load_returns_body_for_enabled_skill() {
        let reg = registry_with(vec![skill(
            "greeter",
            "Greeter",
            "says hi",
            "Always say hello first.",
            true,
        )]);
        let out = dispatch("load", json!({ "id": "greeter" }), &reg)
            .await
            .expect("ok");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["instructions"], json!("Always say hello first."));
    }

    #[tokio::test]
    async fn load_unknown_id_is_soft_error() {
        let reg = registry_with(vec![]);
        let out = dispatch("load", json!({ "id": "ghost" }), &reg)
            .await
            .expect("dispatch ok");
        assert_eq!(out["ok"], json!(false));
        assert!(out["error"].is_string());
    }

    #[tokio::test]
    async fn load_skips_disabled_skill() {
        let reg = registry_with(vec![skill("off", "Off", "d", "body", false)]);
        let out = dispatch("load", json!({ "id": "off" }), &reg)
            .await
            .expect("dispatch ok");
        assert_eq!(out["ok"], json!(false));
    }

    #[tokio::test]
    async fn search_ranks_name_hits_first() {
        let reg = registry_with(vec![
            skill("a", "Web Researcher", "search the web", "uses spider", true),
            skill("b", "Greeter", "polite hello", "say hi", true),
        ]);
        let out = dispatch("search", json!({ "query": "web" }), &reg)
            .await
            .expect("ok");
        let results = out["results"].as_array().expect("array");
        assert_eq!(results[0]["id"], json!("a"));
    }

    #[tokio::test]
    async fn search_missing_query_is_an_error() {
        let reg = registry_with(vec![]);
        assert!(dispatch("search", json!({}), &reg).await.is_err());
    }
}
