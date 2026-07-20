//! Recipes: ghost-os parity for the workflow system.
//!
//! A **recipe** is a parameterized, replayable native-desktop automation that a
//! frontier model records once and a small model runs forever — ghost-os's core
//! "workflow" idea ("a frontier model figures out the workflow once, a small
//! model runs it forever"). The record/parameterize/replay *engine* lives in the
//! `ghost-core`/`apps/ghost` desktop-automation server; this crate is the thin
//! surface that lets the rest of Ryu (desktop UI, the workflow DAG) reach it.
//!
//! Core-vs-Gateway (CLAUDE.md §1): a recipe decides *what runs* (which actions, in
//! what order) — so it is **Core**, alongside the workflow engine it plugs into.
//! This crate is consumed by `apps/core` as a **non-optional** path dependency:
//! the workflow executor's `Recipe`/`GhostAction` nodes call [`run`] and
//! [`extract_mcp_json`] unconditionally (they are kernel), so the impl compiles in
//! every build. The `recipes` cargo feature in `apps/core` gates only the HTTP
//! routes ([`routes`]) and the OpenAPI sub-doc.
//!
//! ## Two transports, by statefulness
//! - **Stateless ops** (list / show / save / delete) read or write the recipe
//!   JSON files directly via [`ghost_core::store::RecipeStore`] — the SAME store
//!   (and SAME `~/.ghost/recipes/` path resolution) `apps/ghost` writes through,
//!   so Core and ghost never disagree about where a recipe lives. No subprocess,
//!   no host — a pure `ghost-core` call.
//! - **Replay** (`run`) and the **recording session** (`record_start` …
//!   `record_stop`) need the live ghost engine (input tap, accessibility tree,
//!   action synthesis). Those are kernel machinery (the shared MCP registry and a
//!   dedicated ghost subprocess held across start..stop), so they are inverted
//!   through the [`RecipesHost`] trait — `apps/core` implements it and installs it
//!   once at boot via [`set_global_host`].

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

use async_trait::async_trait;
use ghost_core::store::RecipeStore;
use ghost_core::types::Recipe;

pub mod api;

pub use api::{routes, RecipesCtx};

// ── Host inversion (the kernel couplings live in apps/core) ───────────────────

/// What [`RecipesHost::recorder_start`] reports back: the raw `ghost_learn_start`
/// info payload plus the host-assigned start timestamp for the new session.
///
/// `Serialize`/`Deserialize` so the out-of-process `ryu-recipes` sidecar can carry
/// it over the `/api/host/recipes/record-start` callback verbatim (the live ghost
/// recorder lives in Core; the sidecar only proxies).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderStarted {
    pub started_at: String,
    pub info: Value,
}

/// A snapshot of the active recording ([`RecipesHost::recorder_status`]): the
/// task + start time the host is tracking, and the raw `ghost_learn_status`
/// payload.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderStatus {
    pub task: String,
    pub started_at: String,
    pub status: Value,
}

/// The result of stopping the recorder ([`RecipesHost::recorder_stop`]): the
/// session metadata plus the raw `ghost_learn_stop` payload
/// (`{recording, event_count, events, suggestion}`). The crate flattens this and
/// synthesizes the editable draft on top.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecorderStopped {
    pub task: String,
    pub started_at: String,
    pub payload: Value,
}

/// The narrow seam this crate needs from `apps/core`'s kernel machinery. It
/// carries ONLY the two live-ghost couplings the moved code uses: the shared MCP
/// registry (for stateless replay) and the singleton recording-subprocess
/// lifecycle (a `McpSession` held across start..stop — kernel machinery that must
/// stay in Core). `apps/core` implements this in its `recipes_host` shim.
#[async_trait]
pub trait RecipesHost: Send + Sync {
    /// Replay a recipe by calling `ghost__ghost_run` through the shared MCP
    /// registry. Returns the raw MCP `tools/call` envelope (the crate unwraps it
    /// with [`extract_mcp_json`]).
    async fn call_ghost_run(&self, recipe: &str, params: Value) -> Result<Value>;

    /// Start a dedicated ghost recorder for `task` (spawns the subprocess holding
    /// the input tap and calls `ghost_learn_start`). Errors if a recording is
    /// already active or the recorder can't launch.
    async fn recorder_start(&self, task: &str) -> Result<RecorderStarted>;

    /// Poll the active recorder (`ghost_learn_status`). Returns `None` when no
    /// session is running.
    async fn recorder_status(&self) -> Result<Option<RecorderStatus>>;

    /// Stop the active recorder (`ghost_learn_stop`) and tear down the subprocess.
    /// Errors if no session is active.
    async fn recorder_stop(&self) -> Result<RecorderStopped>;
}

/// Process-global recipes host, installed once at boot by `apps/core`.
fn host_slot() -> &'static OnceLock<Arc<dyn RecipesHost>> {
    static HOST: OnceLock<Arc<dyn RecipesHost>> = OnceLock::new();
    &HOST
}

/// Install the host implementation. Called once from `apps/core` at startup
/// (unconditionally — the executor's recipe nodes reach [`run`] in every build,
/// including the lean one). Idempotent: a second call is ignored.
pub fn set_global_host(host: Arc<dyn RecipesHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host, erroring if [`set_global_host`] was never called.
fn host() -> Result<Arc<dyn RecipesHost>> {
    host_slot()
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("recipes host not initialized"))
}

// ── Stateless store ops (pure ghost-core; no host) ────────────────────────────

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

// ── Replay (stateless, through the shared MCP registry via the host) ──────────

/// Replay a recipe with parameter substitution (mirrors `ghost_run`). Routes to
/// the live ghost engine through the host's shared MCP registry: the recorded
/// steps execute as real clicks/types against native apps, with `{{param}}` slots
/// filled from `params`. Returns the structured `RecipeRunResult`
/// (per-step success/timing).
pub async fn run(name: &str, params: Value) -> Result<Value> {
    let result = host()?
        .call_ghost_run(name, params)
        .await
        .map_err(|e| anyhow!("recipe replay failed: {e}"))?;
    extract_mcp_json(&result)
}

// ── Recording session (stateful: the McpSession lifecycle lives in the host) ──

/// Start a recording session: the host spawns a dedicated ghost child, begins
/// observing user input (`ghost_learn_start`), and holds the subprocess alive
/// until [`record_stop`]. Errors if a session is already active.
pub async fn record_start(task: &str) -> Result<Value> {
    let started = host()?.recorder_start(task).await?;
    Ok(json!({
        "recording": true,
        "task": task,
        "started_at": started.started_at,
        "info": started.info,
    }))
}

/// Poll the active recording (`ghost_learn_status`): how many events captured so
/// far, elapsed time. Returns `{ "recording": false }` when nothing is running.
pub async fn record_status() -> Result<Value> {
    match host()?.recorder_status().await? {
        None => Ok(json!({ "recording": false })),
        Some(rec) => Ok(json!({
            "recording": true,
            "task": rec.task,
            "started_at": rec.started_at,
            "status": rec.status,
        })),
    }
}

/// Stop the active recording (`ghost_learn_stop`), tear down the ghost child, and
/// return the captured action sequence plus a deterministic editable draft. The
/// caller (or a model) turns these AX-enriched events into a recipe and persists
/// it via [`save`]. Errors when no session is active.
pub async fn record_stop() -> Result<Value> {
    let stopped = host()?.recorder_stop().await?;
    let task = stopped.task.clone();
    // Flatten ghost's `{recording, event_count, events, suggestion}` payload up
    // alongside the session metadata so the desktop reads `events` directly
    // (not `events.events`).
    let mut out = json!({ "task": task, "started_at": stopped.started_at, "recording": false });
    if let (Some(dst), Some(src)) = (out.as_object_mut(), stopped.payload.as_object()) {
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
/// starting point the user refines before saving. Owned here so every client
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
/// is not JSON. Pure — used by the workflow executor's `GhostAction` node as well
/// as [`run`], so it takes no host.
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
