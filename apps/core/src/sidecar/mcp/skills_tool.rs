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
//! This server is the L2 loader. It exposes three tools through the same registry /
//! `tool_search` plumbing as every other tool, so a model discovers and loads a
//! skill exactly like any other capability:
//!
//! - `skills__search { query }` — find skills by task (id, name, description).
//! - `skills__load { id }` — return a skill's full instruction body. The returned
//!   text *is* the injection: the model reads it as the tool result and follows it
//!   for the rest of the turn (the same mechanism as Claude Code's Skill tool).
//! - `skills__author { name, purpose, procedure, failure_modes, verification, .. }`
//!   — write a structured, reusable `SKILL.md` into the same `~/.claude/skills`
//!   layout the installer targets, then reload + activate it so it is immediately
//!   discoverable by `skills__search` / `skills__load`. Calling it again with the
//!   same slug refines (overwrites) the skill in place — the self-authoring loop:
//!   an agent captures what it learned solving a complex task, and sharpens it on
//!   reuse.
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
//! - `author` writes to the same on-disk location the catalog installer targets
//!   (`SkillRegistry::skills_dir()/<slug>/SKILL.md`) with the same atomic tmp+rename
//!   and `set_active` semantics, so an authored skill is indistinguishable from an
//!   installed one. Like the two read tools it is gated only by the `skills` server
//!   allowlist (an agent that can `search`/`load` can also `author`). The slug is
//!   sanitized to a single safe path segment so a call can never escape the skills
//!   directory, and the rendered file is round-tripped through the loader before it
//!   is committed to disk (fail closed on a malformed body).

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::skills::SkillRegistry;

/// Reserved registry server name for the built-in skills provider.
pub const SERVER_NAME: &str = "skills";

/// Fully-qualified ids of the tools this provider exposes.
pub const SEARCH_TOOL_ID: &str = "skills__search";
pub const LOAD_TOOL_ID: &str = "skills__load";
pub const AUTHOR_TOOL_ID: &str = "skills__author";

/// Default / max search results.
const SEARCH_DEFAULT_LIMIT: usize = 10;
const SEARCH_MAX_LIMIT: usize = 25;

/// Env flag that opts a node into autonomous skill self-authoring.
///
/// **Default OFF.** Unlike `search`/`load` (which only return instruction text),
/// `skills__author` has side effects — it writes a SKILL.md into the shared
/// `~/.claude/skills` directory and flips the global activation set. So it stays
/// gated behind an explicit opt-in and is neither listed nor callable until this is
/// set, mirroring this module's existing `RYU_SKILLS_*` env idiom
/// (`RYU_SKILLS_DIR` / `RYU_SKILLS_ACTIVE_FILE`) and the default-safe rule that new
/// runtime behavior does not change existing defaults.
const AUTHOR_FLAG_ENV: &str = "RYU_SKILLS_AUTHOR";

/// Whether skill self-authoring is enabled on this node. Default `false`; enabled
/// when `RYU_SKILLS_AUTHOR` is a truthy value (`1` / `true` / `yes` / `on`).
fn author_enabled() -> bool {
    std::env::var(AUTHOR_FLAG_ENV)
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

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

fn author_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "name": {
                "type": "string",
                "description": "Human-readable skill name, e.g. \"Resolve merge conflicts\"."
            },
            "slug": {
                "type": "string",
                "description": "Optional stable id / directory name. Sanitized to a single safe path segment (alphanumerics, '-', '_', '.'). Derived from the name when omitted. Reuse the same slug to refine an existing skill in place."
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
                 { id, name, description }. Call skills__load with an id to read a \
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
                 shared skills directory, then activate it so skills__search and \
                 skills__load see it immediately. Call this after solving a complex \
                 task to capture the method for reuse; call it again with the same \
                 slug to refine (overwrite) an existing skill of that slug in place. \
                 Returns { ok, id, path, refined }."
                    .to_owned(),
            ),
            input_schema: Some(author_schema()),
            ..Default::default()
        });
    }
    tools
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
        "author" => do_author(arguments, registry),
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

/// Sanitize a raw slug (or a name to derive one from) into a single safe path
/// segment. Keeps alphanumerics, `-`, `_`, `.`; collapses everything else to a
/// dash; trims leading/trailing dashes and dots. Returns `None` when nothing safe
/// remains (empty, `.`, `..`), so a call can never escape the skills directory via
/// `..`, an absolute path, or a drive/UNC prefix (`:` and separators are neutered).
///
/// Mirrors `skills_catalog::from_source::sanitize_name` but fails closed instead of
/// falling back to a default id, so an unusable slug is a caller error.
fn sanitize_slug(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches(['-', '.']).to_string();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return None;
    }
    Some(trimmed)
}

/// Render a structured `SKILL.md`: quoted-safe YAML front-matter (name, optional
/// description, optional allowed-tools) followed by the four `##` body sections.
///
/// The front-matter is serialized with `serde_yml` (the same crate `parse_skill_md`
/// reads back), so a `name`/`description` containing quotes, colons, newlines, or a
/// `---` sequence is escaped correctly instead of breaking the block.
fn render_skill_md(
    name: &str,
    description: Option<&str>,
    allowed_tools: &[String],
    purpose: &str,
    procedure: &str,
    failure_modes: &str,
    verification: &str,
) -> Result<String> {
    let mut front = serde_json::Map::new();
    front.insert("name".to_owned(), json!(name));
    if let Some(d) = description {
        front.insert("description".to_owned(), json!(d));
    }
    if !allowed_tools.is_empty() {
        front.insert("allowed-tools".to_owned(), json!(allowed_tools));
    }
    let yaml = serde_yml::to_string(&Value::Object(front))
        .map_err(|e| anyhow::anyhow!("failed to render skill front-matter: {e}"))?;

    Ok(format!(
        "---\n{yaml}---\n\n## Purpose\n\n{purpose}\n\n## Procedure\n\n{procedure}\n\n## Failure modes\n\n{failure_modes}\n\n## Verification\n\n{verification}\n",
        yaml = yaml,
        purpose = purpose.trim(),
        procedure = procedure.trim(),
        failure_modes = failure_modes.trim(),
        verification = verification.trim(),
    ))
}

/// Read a required non-empty string argument, or `Err` (a malformed call — same
/// contract as `do_load`'s missing-`id` behavior).
fn required_str<'a>(arguments: &'a Value, key: &str) -> Result<&'a str> {
    arguments
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

/// Write a structured, reusable SKILL.md into the shared skills directory and make
/// it immediately discoverable. Additive and idempotent per slug: re-authoring the
/// same slug overwrites the body in place (the refine-on-reuse loop).
///
/// `Err` only for a malformed call (missing required arg, unsafe slug, or a body
/// that does not round-trip through the loader). A successful write returns
/// `{ ok: true, id, path, refined }`.
fn do_author(arguments: Value, registry: &SkillRegistry) -> Result<Value> {
    // Defense in depth: the tool is normally hidden when the opt-in is off (see
    // `tools()`), but never let a direct call by id write files when disabled.
    if !author_enabled() {
        return Ok(json!({
            "ok": false,
            "available": false,
            "error": "skill authoring is disabled on this node (set RYU_SKILLS_AUTHOR to enable)",
        }));
    }

    let name = required_str(&arguments, "name")?;
    let purpose = required_str(&arguments, "purpose")?;
    let procedure = required_str(&arguments, "procedure")?;
    let failure_modes = required_str(&arguments, "failure_modes")?;
    let verification = required_str(&arguments, "verification")?;

    let description = arguments
        .get("description")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let allowed_tools: Vec<String> = arguments
        .get("allowed_tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    // Prefer an explicit slug; otherwise derive one from the name. Fail closed if
    // nothing safe remains so a call can never escape the skills directory.
    let slug_source = arguments
        .get("slug")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(name);
    let slug = sanitize_slug(slug_source).ok_or_else(|| {
        anyhow::anyhow!("could not derive a safe skill slug from '{slug_source}'")
    })?;

    let md = render_skill_md(
        name,
        description,
        &allowed_tools,
        purpose,
        procedure,
        failure_modes,
        verification,
    )?;

    // Fail closed: the file we are about to persist must parse back through the
    // exact loader `reload()` uses, so we never leave an unreadable skill on disk.
    crate::skills::parse_skill_md(&slug, &md).map_err(|e| {
        anyhow::anyhow!("authored skill did not round-trip through the loader: {e}")
    })?;

    let skill_dir = SkillRegistry::skills_dir().join(&slug);
    std::fs::create_dir_all(&skill_dir)
        .map_err(|e| anyhow::anyhow!("creating skill dir {}: {e}", skill_dir.display()))?;

    let dest = skill_dir.join("SKILL.md");
    let refined = dest.exists();

    // Atomic tmp+rename (mirrors the catalog installer) so a concurrent registry
    // reload never observes a half-written SKILL.md.
    let tmp = skill_dir.join("SKILL.md.tmp");
    std::fs::write(&tmp, md.as_bytes())
        .map_err(|e| anyhow::anyhow!("writing {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &dest)
        .map_err(|e| anyhow::anyhow!("rename {} -> {}: {e}", tmp.display(), dest.display()))?;

    // A self-authored skill is active by default (it injects on the default route),
    // matching the catalog install paths. Then reload so search/load see it now.
    crate::skills::set_active(&slug, true);
    registry.reload();

    Ok(json!({
        "ok": true,
        "id": slug,
        "path": dest.to_string_lossy(),
        "refined": refined,
    }))
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
    fn lists_two_read_tools_by_default() {
        // Serialize on the shared env lock: another test may be toggling the flag.
        let _env = crate::skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::env::remove_var(AUTHOR_FLAG_ENV);
        let tools = tools();
        assert_eq!(tools.len(), 2, "author is hidden by default");
        assert!(tools.iter().any(|t| t.id == SEARCH_TOOL_ID));
        assert!(tools.iter().any(|t| t.id == LOAD_TOOL_ID));
        assert!(!tools.iter().any(|t| t.id == AUTHOR_TOOL_ID));
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
    }

    #[test]
    fn lists_author_tool_when_enabled() {
        let _env = crate::skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        std::env::set_var(AUTHOR_FLAG_ENV, "1");
        let tools = tools();
        std::env::remove_var(AUTHOR_FLAG_ENV);
        assert_eq!(tools.len(), 3);
        assert!(tools.iter().any(|t| t.id == SEARCH_TOOL_ID));
        assert!(tools.iter().any(|t| t.id == LOAD_TOOL_ID));
        assert!(tools.iter().any(|t| t.id == AUTHOR_TOOL_ID));
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

    // ── skills__author ────────────────────────────────────────────────────────

    /// Point the skills dir + activation file at fresh tempdirs and hold the env
    /// lock for the life of the returned guard, so author tests can round-trip real
    /// disk I/O without clobbering each other.
    struct AuthorEnv {
        _guard: std::sync::MutexGuard<'static, ()>,
        _skills: tempfile::TempDir,
        _active: tempfile::TempDir,
        skills_dir: std::path::PathBuf,
    }

    impl Drop for AuthorEnv {
        fn drop(&mut self) {
            std::env::remove_var("RYU_SKILLS_DIR");
            std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
            std::env::remove_var(AUTHOR_FLAG_ENV);
        }
    }

    fn author_env() -> AuthorEnv {
        // Shared with the `skills` and `skills_catalog::from_source` test modules:
        // all three point the global RYU_SKILLS_* vars at their own tempdirs, so
        // they must serialize or a clobbered set_var falls through to the real dir.
        let guard = crate::skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let skills = tempfile::tempdir().expect("skills tempdir");
        let active = tempfile::tempdir().expect("active tempdir");
        std::env::set_var("RYU_SKILLS_DIR", skills.path());
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", active.path().join("active.json"));
        // The author tool is default-off; opt this test node in.
        std::env::set_var(AUTHOR_FLAG_ENV, "1");
        let skills_dir = skills.path().to_path_buf();
        AuthorEnv {
            _guard: guard,
            _skills: skills,
            _active: active,
            skills_dir,
        }
    }

    fn author_args(name: &str, slug: &str, procedure: &str) -> Value {
        json!({
            "name": name,
            "slug": slug,
            "description": "does a thing",
            "purpose": "when you need to do the thing",
            "procedure": procedure,
            "failure_modes": "watch out for the edge",
            "verification": "confirm it worked",
        })
    }

    #[tokio::test]
    async fn authored_skill_roundtrips_through_loader() {
        let env = author_env();
        let reg = SkillRegistry::empty();

        let out = dispatch(
            "author",
            author_args("My Skill", "my-skill", "do step one"),
            &reg,
        )
        .await
        .expect("author ok");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["id"], json!("my-skill"));
        assert_eq!(out["refined"], json!(false));

        let md_path = env.skills_dir.join("my-skill").join("SKILL.md");
        assert!(md_path.exists(), "SKILL.md written to skills_dir/<slug>");

        let contents = std::fs::read_to_string(&md_path).expect("read back");
        let rec = crate::skills::parse_skill_md("my-skill", &contents)
            .expect("authored file parses through the loader");
        assert_eq!(rec.name, "My Skill");
        assert!(rec.instructions.contains("## Purpose"));
        assert!(rec.instructions.contains("## Procedure"));
        assert!(rec.instructions.contains("## Failure modes"));
        assert!(rec.instructions.contains("## Verification"));
        assert!(rec.instructions.contains("do step one"));
    }

    #[tokio::test]
    async fn author_then_search_and_load() {
        let _env = author_env();
        let reg = SkillRegistry::empty();

        dispatch(
            "author",
            author_args("Conflict Resolver", "conflict-resolver", "rebase carefully"),
            &reg,
        )
        .await
        .expect("author ok");

        // reload (inside do_author) + set_active make it enabled and discoverable.
        let found = dispatch("search", json!({ "query": "conflict" }), &reg)
            .await
            .expect("search ok");
        let results = found["results"].as_array().expect("array");
        assert!(
            results
                .iter()
                .any(|r| r["id"] == json!("conflict-resolver")),
            "authored skill is searchable after authoring"
        );

        let loaded = dispatch("load", json!({ "id": "conflict-resolver" }), &reg)
            .await
            .expect("load ok");
        assert_eq!(loaded["ok"], json!(true));
        assert!(loaded["instructions"]
            .as_str()
            .expect("body")
            .contains("rebase carefully"));
    }

    #[tokio::test]
    async fn refine_overwrites_existing() {
        let _env = author_env();
        let reg = SkillRegistry::empty();

        let first = dispatch(
            "author",
            author_args("Refiner", "refiner", "first procedure text"),
            &reg,
        )
        .await
        .expect("first author ok");
        assert_eq!(first["refined"], json!(false));

        let second = dispatch(
            "author",
            author_args("Refiner", "refiner", "second procedure text"),
            &reg,
        )
        .await
        .expect("second author ok");
        assert_eq!(second["refined"], json!(true));

        let loaded = dispatch("load", json!({ "id": "refiner" }), &reg)
            .await
            .expect("load ok");
        let body = loaded["instructions"].as_str().expect("body");
        assert!(
            body.contains("second procedure text"),
            "refined body persists"
        );
        assert!(!body.contains("first procedure text"), "old body replaced");
    }

    #[tokio::test]
    async fn author_is_a_noop_when_disabled() {
        let _guard = crate::skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let skills = tempfile::tempdir().expect("skills tempdir");
        let active = tempfile::tempdir().expect("active tempdir");
        std::env::set_var("RYU_SKILLS_DIR", skills.path());
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", active.path().join("active.json"));
        std::env::remove_var(AUTHOR_FLAG_ENV); // default-off

        let reg = SkillRegistry::empty();
        let out = dispatch("author", author_args("Nope", "nope", "x"), &reg)
            .await
            .expect("dispatch ok (soft)");

        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");

        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["available"], json!(false));
        assert!(
            !skills.path().join("nope").join("SKILL.md").exists(),
            "disabled author must write nothing"
        );
    }

    #[tokio::test]
    async fn author_missing_required_arg_is_an_error() {
        let _env = author_env();
        let reg = SkillRegistry::empty();
        // No `verification`.
        let args = json!({
            "name": "x",
            "slug": "x",
            "purpose": "p",
            "procedure": "pr",
            "failure_modes": "f",
        });
        assert!(dispatch("author", args, &reg).await.is_err());
    }

    #[tokio::test]
    async fn author_slug_cannot_escape_skills_dir() {
        let env = author_env();
        let reg = SkillRegistry::empty();

        // A traversal slug is sanitized to a single safe segment; nothing is ever
        // written outside skills_dir.
        let out = dispatch("author", author_args("Evil", "../evil", "x"), &reg).await;
        if let Ok(v) = out {
            let path = v["path"].as_str().expect("path");
            assert!(
                std::path::Path::new(path).starts_with(&env.skills_dir),
                "authored skill must stay inside skills_dir, got {path}"
            );
        }
        let escaped = env
            .skills_dir
            .parent()
            .expect("parent")
            .join("evil")
            .join("SKILL.md");
        assert!(!escaped.exists(), "traversal must not write a sibling dir");

        // A slug that sanitizes to nothing safe is a hard error (writes nothing).
        assert!(dispatch("author", author_args("Dots", "..", "x"), &reg)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn author_front_matter_escaping_roundtrips() {
        let env = author_env();
        let reg = SkillRegistry::empty();

        // Quotes, a colon, and a `---` sequence in the name must stay inside the
        // YAML value instead of breaking the front-matter block.
        let tricky = r#"Weird: "quoted" --- name"#;
        let args = json!({
            "name": tricky,
            "slug": "tricky",
            "purpose": "p",
            "procedure": "pr",
            "failure_modes": "f",
            "verification": "v",
        });
        let out = dispatch("author", args, &reg).await.expect("author ok");
        assert_eq!(out["ok"], json!(true));

        let md = std::fs::read_to_string(env.skills_dir.join("tricky").join("SKILL.md"))
            .expect("read back");
        let rec =
            crate::skills::parse_skill_md("tricky", &md).expect("escaped front-matter round-trips");
        assert_eq!(rec.name, tricky);
    }
}
