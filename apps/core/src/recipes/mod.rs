//! Desktop recipes surface (ghost-os parity for the workflow system).
//!
//! A **recipe** is a parameterized, replayable native-desktop automation that a
//! frontier model records once and a small model runs forever — ghost-os's core
//! "workflow" idea ("a frontier model figures out the workflow once, a small
//! model runs it forever"). The record/parameterize/replay *engine* already lives
//! in the `ghost-core`/`apps/ghost` desktop-automation server; this module is the
//! thin Core surface that lets the rest of Ryu (desktop UI, the workflow DAG)
//! reach it.
//!
//! Core-vs-Gateway (CLAUDE.md §1): a recipe decides *what runs* (which actions, in
//! what order) — so it is **Core**, alongside the workflow engine it plugs into.
//!
//! ## Two transports, by statefulness
//! - **Stateless ops** (list / show / save / delete) read or write the recipe
//!   JSON files directly via [`ghost_core::store::RecipeStore`] — the SAME store
//!   (and SAME `~/.ghost/recipes/` path resolution) `apps/ghost` writes through,
//!   so Core and ghost never disagree about where a recipe lives. No subprocess.
//! - **Replay** (`run`) and the **recording session** (`learn_start` …
//!   `learn_stop`) need the live ghost engine (input tap, accessibility tree,
//!   action synthesis), so they go through the ghost MCP server. Replay is a
//!   single stateless `call_tool`; recording holds a long-lived [`McpSession`]
//!   because the in-process input tap must survive between start and stop.

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::sync::Mutex;

use crate::sidecar::mcp::client::{McpSession, McpStdioCommand};
use ghost_core::store::RecipeStore;
use ghost_core::types::Recipe;

/// Fully-qualified ghost tool ids used for replay.
const GHOST_RUN: &str = "ghost__ghost_run";

/// A compact recipe row for the list view (mirrors `ghost_recipes`).
#[derive(Debug, Clone, Serialize)]
pub struct RecipeSummary {
    pub name: String,
    pub description: String,
    pub app: Option<String>,
    /// Names of the recipe's declared parameters (the `{{param}}` slots).
    pub params: Vec<String>,
    pub step_count: usize,
}

/// List every installed recipe (summary form).
pub fn list() -> Result<Vec<RecipeSummary>> {
    let store = RecipeStore::open()?;
    let mut out: Vec<RecipeSummary> = store
        .list()?
        .into_iter()
        .map(|r| {
            let mut params: Vec<String> = r
                .params
                .as_ref()
                .map(|p| p.keys().cloned().collect())
                .unwrap_or_default();
            params.sort();
            RecipeSummary {
                name: r.name,
                description: r.description,
                app: r.app,
                params,
                step_count: r.steps.len(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Load a single recipe's full definition (mirrors `ghost_recipe_show`).
pub fn get(name: &str) -> Result<Recipe> {
    RecipeStore::open()?.get(name)
}

/// Install (create or overwrite) a recipe from a JSON document. Validation —
/// schema shape, parameter declarations — is the store's, so a malformed recipe
/// is rejected here exactly as it would be through `ghost_recipe_save`.
pub fn save(recipe_json: &str) -> Result<Recipe> {
    RecipeStore::open()?.save_json(recipe_json)
}

/// Delete a recipe by name (mirrors `ghost_recipe_delete`).
pub fn delete(name: &str) -> Result<()> {
    RecipeStore::open()?.delete(name)
}

/// Replay a recipe with parameter substitution (mirrors `ghost_run`). Routes to
/// the live ghost engine through the MCP registry: the recorded steps execute as
/// real clicks/types against native apps, with `{{param}}` slots filled from
/// `params`. Returns the structured `RecipeRunResult` (per-step success/timing).
pub async fn run(name: &str, params: Value) -> Result<Value> {
    let registry = crate::sidecar::mcp::global_registry()
        .ok_or_else(|| anyhow!("MCP registry not initialized"))?;
    let result = registry
        .call_tool(GHOST_RUN, json!({ "recipe": name, "params": params }), None)
        .await
        .map_err(|e| anyhow!("recipe replay failed: {e}"))?;
    extract_mcp_json(&result)
}

// ── Recording session (stateful: one ghost child across start..stop) ──────────

/// A live recording session: the ghost subprocess (holding the input tap) plus
/// the metadata the desktop shows while recording.
struct Recording {
    session: McpSession,
    task: String,
    started_at: String,
}

/// Process-global single-slot recording session. Only one recording can be
/// active at a time (the input tap is a shared OS resource). A `tokio` mutex
/// because the guard is held across the `.await` of a ghost `tools/call`.
fn recording() -> &'static Mutex<Option<Recording>> {
    static R: OnceLock<Mutex<Option<Recording>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(None))
}

/// The command that launches the ghost MCP server (`<bin> mcp`). Mirrors the
/// built-in registered in [`crate::sidecar::mcp`].
fn ghost_command() -> McpStdioCommand {
    McpStdioCommand {
        command: crate::sidecar::tools::ghost::ghost_bin_path()
            .to_string_lossy()
            .into_owned(),
        args: vec!["mcp".to_string()],
        env: Vec::new(),
    }
}

/// Start a recording session: spawn a dedicated ghost child and begin observing
/// user input (`ghost_learn_start`). The child stays alive — held in the global
/// slot — until [`record_stop`]. Errors if a session is already active.
pub async fn record_start(task: &str) -> Result<Value> {
    let mut guard = recording().lock().await;
    if guard.is_some() {
        return Err(anyhow!(
            "a recording session is already active — stop it before starting another"
        ));
    }
    let mut session = McpSession::connect(&ghost_command()).await.map_err(|e| {
        anyhow!("could not start the ghost recorder: {e}. Install the ghost sidecar (Windows-first) to record recipes.")
    })?;
    let info = session
        .call_tool("ghost_learn_start", json!({ "task": task }))
        .await
        .and_then(|r| extract_mcp_json(&r));
    let info = match info {
        Ok(v) => v,
        Err(e) => {
            // learn_start failed — don't leak the child.
            session.shutdown().await;
            return Err(anyhow!("ghost_learn_start failed: {e}"));
        }
    };
    let started_at = chrono::Utc::now().to_rfc3339();
    *guard = Some(Recording {
        session,
        task: task.to_string(),
        started_at: started_at.clone(),
    });
    Ok(json!({
        "recording": true,
        "task": task,
        "started_at": started_at,
        "info": info,
    }))
}

/// Poll the active recording (`ghost_learn_status`): how many events captured so
/// far, elapsed time. Returns `{ "recording": false }` when nothing is running.
pub async fn record_status() -> Result<Value> {
    let mut guard = recording().lock().await;
    match guard.as_mut() {
        None => Ok(json!({ "recording": false })),
        Some(rec) => {
            let status = rec
                .session
                .call_tool("ghost_learn_status", json!({}))
                .await
                .and_then(|r| extract_mcp_json(&r))
                .unwrap_or(Value::Null);
            Ok(json!({
                "recording": true,
                "task": rec.task,
                "started_at": rec.started_at,
                "status": status,
            }))
        }
    }
}

/// Stop the active recording (`ghost_learn_stop`), tear down the ghost child, and
/// return the captured action sequence. The caller (or a model) turns these
/// AX-enriched events into a recipe and persists it via [`save`]. Errors when no
/// session is active.
pub async fn record_stop() -> Result<Value> {
    let mut guard = recording().lock().await;
    let mut rec = guard
        .take()
        .ok_or_else(|| anyhow!("no active recording session to stop"))?;
    let payload = rec
        .session
        .call_tool("ghost_learn_stop", json!({}))
        .await
        .and_then(|r| extract_mcp_json(&r));
    rec.session.shutdown().await;
    let payload = payload?;
    let task = rec.task.clone();
    // Flatten ghost's `{recording, event_count, events, suggestion}` payload up
    // alongside the session metadata so the desktop reads `events` directly
    // (not `events.events`).
    let mut out = json!({ "task": task, "started_at": rec.started_at, "recording": false });
    if let (Some(dst), Some(src)) = (out.as_object_mut(), payload.as_object()) {
        for (k, v) in src {
            dst.insert(k.clone(), v.clone());
        }
    }
    // Core builds the editable recipe draft from the captured events so every
    // client gets the same scaffold (the transform used to live only in the
    // desktop). The client may still refine it before saving via `save`.
    let events = out
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(dst) = out.as_object_mut() {
        dst.insert("draft".to_string(), draft_from_events(&task, &events));
    }
    Ok(out)
}

/// Slugify a task description into a safe recipe name (lowercase, non-alnum →
/// single hyphens, trimmed). Mirrors the desktop slug so names match.
fn slugify_task(task: &str) -> String {
    let mut slug = String::new();
    let mut prev_dash = false;
    for ch in task.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "recorded-recipe".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Build an editable recipe draft from a captured action sequence — the ghost-os
/// "a frontier model synthesizes the recipe" step, done deterministically as a
/// starting point the user refines before saving. Owned by Core so every client
/// (not just the desktop) gets the same scaffold from `record/stop`. Each event
/// maps to a step using its AX context as the locator; typed text becomes a
/// `type` step the user can parameterize with `{{param}}`.
fn draft_from_events(task: &str, events: &[Value]) -> Value {
    let str_field = |e: &Value, k: &str| -> Option<String> {
        e.get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let mut steps = Vec::with_capacity(events.len());
    for (i, e) in events.iter().enumerate() {
        let id = (i + 1) as i64;
        let event_type = e.get("event_type").and_then(Value::as_str).unwrap_or("");
        let key = str_field(e, "key").unwrap_or_default();
        let app = str_field(e, "app_name");
        let name = str_field(e, "element_name");
        let role = str_field(e, "element_role");
        let elem_id = str_field(e, "element_id");
        let target = if name.is_some() || role.is_some() || elem_id.is_some() || app.is_some() {
            json!({ "query": name, "role": role, "identifier": elem_id, "app": app })
        } else {
            Value::Null
        };
        let step = match event_type {
            "type" => {
                json!({ "id": id, "action": "type", "target": target, "params": { "text": key } })
            }
            "press" => json!({ "id": id, "action": "press", "params": { "key": key } }),
            "hotkey" => json!({ "id": id, "action": "hotkey", "params": { "keys": key } }),
            "scroll" => {
                let direction = if key.is_empty() {
                    "down".to_string()
                } else {
                    key
                };
                json!({ "id": id, "action": "scroll", "params": { "direction": direction } })
            }
            "app_switch" => {
                json!({ "id": id, "action": "focus", "params": { "app": app.clone().unwrap_or_default() } })
            }
            _ => json!({ "id": id, "action": "click", "target": target, "note": name }),
        };
        steps.push(step);
    }
    let app = events.iter().find_map(|e| str_field(e, "app_name"));
    json!({
        "schema_version": 2,
        "name": slugify_task(task),
        "description": if task.is_empty() { "Recorded workflow" } else { task },
        "app": app,
        "params": {},
        "steps": steps,
        "on_failure": "abort",
    })
}

/// Unwrap a ghost MCP `tools/call` result envelope into structured JSON.
///
/// ghost replies `{ "content": [{ "type": "text", "text": "<json>" }], "isError"?
/// }` (see `apps/ghost/src/mcp/server.rs`): the structured tool value is the
/// stringified JSON inside `content[0].text`. This parses it back, surfaces
/// `isError` as an `Err`, and falls back to the raw text/string when the payload
/// is not JSON.
pub fn extract_mcp_json(result: &Value) -> Result<Value> {
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|first| first.get("text"))
        .and_then(Value::as_str);
    if result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(anyhow!("{}", text.unwrap_or("tool error")));
    }
    match text {
        Some(t) => Ok(serde_json::from_str::<Value>(t).unwrap_or(Value::String(t.to_string()))),
        None => Ok(result.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_unwraps_text_json() {
        let env = json!({ "content": [{ "type": "text", "text": "{\"a\":1}" }] });
        assert_eq!(extract_mcp_json(&env).unwrap(), json!({ "a": 1 }));
    }

    #[test]
    fn extract_surfaces_is_error() {
        let env =
            json!({ "content": [{ "type": "text", "text": "Error: boom" }], "isError": true });
        let err = extract_mcp_json(&env).unwrap_err().to_string();
        assert!(err.contains("boom"), "unexpected error: {err}");
    }

    #[test]
    fn extract_falls_back_to_plain_text() {
        let env = json!({ "content": [{ "type": "text", "text": "not json" }] });
        assert_eq!(extract_mcp_json(&env).unwrap(), json!("not json"));
    }

    #[test]
    fn slugify_task_is_safe() {
        assert_eq!(slugify_task("Open the App!"), "open-the-app");
        assert_eq!(slugify_task("  "), "recorded-recipe");
    }

    #[test]
    fn draft_maps_events_to_steps() {
        let events = json!([
            { "event_type": "app_switch", "app_name": "Calculator" },
            { "event_type": "click", "element_name": "Seven", "element_role": "button" },
            { "event_type": "type", "key": "42", "element_name": "Field" },
            { "event_type": "scroll" },
        ]);
        let draft = draft_from_events("Add numbers", events.as_array().unwrap());
        assert_eq!(draft["schema_version"], json!(2));
        assert_eq!(draft["name"], json!("add-numbers"));
        assert_eq!(draft["app"], json!("Calculator"));
        let steps = draft["steps"].as_array().unwrap();
        assert_eq!(steps.len(), 4);
        assert_eq!(steps[0]["action"], json!("focus"));
        assert_eq!(steps[0]["params"]["app"], json!("Calculator"));
        assert_eq!(steps[1]["action"], json!("click"));
        assert_eq!(steps[1]["target"]["query"], json!("Seven"));
        assert_eq!(steps[2]["action"], json!("type"));
        assert_eq!(steps[2]["params"]["text"], json!("42"));
        assert_eq!(steps[3]["action"], json!("scroll"));
        assert_eq!(steps[3]["params"]["direction"], json!("down"));
    }
}
