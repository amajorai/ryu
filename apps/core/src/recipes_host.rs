//! Core's implementation of the extracted [`ryu_recipes::RecipesHost`] seam.
//!
//! The `ryu-recipes` crate owns the recipe store surface, the replay/record
//! *logic*, the `/api/recipes/*` handlers, and the deterministic draft synthesis.
//! What it cannot own — because they are kernel machinery that must stay in Core —
//! are the two live-ghost couplings: the shared MCP registry (for stateless
//! replay) and the **dedicated recording subprocess** ([`McpSession`]) held across
//! `record_start`..`record_stop` (the in-process input tap is a shared OS resource
//! that must survive between calls). This shim implements those two verbs; Core
//! installs it once at boot via [`ryu_recipes::set_global_host`].
//!
//! The recording session is a process-global single slot: only one recording can
//! be active at a time. A `tokio` mutex because the guard is held across the
//! `.await` of a ghost `tools/call`.

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::OnceLock;
use tokio::sync::Mutex;

use ryu_recipes::{RecipesHost, RecorderStarted, RecorderStatus, RecorderStopped};

use crate::sidecar::mcp::client::{McpSession, McpStdioCommand};

/// Fully-qualified ghost tool id used for replay.
const GHOST_RUN: &str = "ghost__ghost_run";

/// A live recording session: the ghost subprocess (holding the input tap) plus
/// the metadata the desktop shows while recording.
struct Recording {
    session: McpSession,
    task: String,
    started_at: String,
}

/// Process-global single-slot recording session. Only one recording can be
/// active at a time (the input tap is a shared OS resource).
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

/// Core's `RecipesHost` — the kernel side of the recipes seam.
pub struct CoreRecipesHost;

#[async_trait]
impl RecipesHost for CoreRecipesHost {
    async fn call_ghost_run(&self, recipe: &str, params: Value) -> Result<Value> {
        let registry = crate::sidecar::mcp::global_registry()
            .ok_or_else(|| anyhow!("MCP registry not initialized"))?;
        registry
            .call_tool(
                GHOST_RUN,
                json!({ "recipe": recipe, "params": params }),
                None,
            )
            .await
            .map_err(|e| anyhow!("recipe replay failed: {e}"))
    }

    async fn recorder_start(&self, task: &str) -> Result<RecorderStarted> {
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
            .and_then(|r| ryu_recipes::extract_mcp_json(&r));
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
        Ok(RecorderStarted { started_at, info })
    }

    async fn recorder_status(&self) -> Result<Option<RecorderStatus>> {
        let mut guard = recording().lock().await;
        match guard.as_mut() {
            None => Ok(None),
            Some(rec) => {
                let status = rec
                    .session
                    .call_tool("ghost_learn_status", json!({}))
                    .await
                    .and_then(|r| ryu_recipes::extract_mcp_json(&r))
                    .unwrap_or(Value::Null);
                Ok(Some(RecorderStatus {
                    task: rec.task.clone(),
                    started_at: rec.started_at.clone(),
                    status,
                }))
            }
        }
    }

    async fn recorder_stop(&self) -> Result<RecorderStopped> {
        let mut guard = recording().lock().await;
        let mut rec = guard
            .take()
            .ok_or_else(|| anyhow!("no active recording session to stop"))?;
        let payload = rec
            .session
            .call_tool("ghost_learn_stop", json!({}))
            .await
            .and_then(|r| ryu_recipes::extract_mcp_json(&r));
        rec.session.shutdown().await;
        let payload = payload?;
        Ok(RecorderStopped {
            task: rec.task,
            started_at: rec.started_at,
            payload,
        })
    }
}
