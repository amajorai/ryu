//! Built-in delegation tool (`delegate__*`) — Claude-Code-Task-style ephemeral
//! sub-agents an agent spins up *itself*, mid-task.
//!
//! This is the agent-native counterpart to the durable coordinator-threads
//! provider ([`super::threads`]). The distinction is deliberate and the two tool
//! descriptions keep it sharp so the model picks the right one:
//!
//!   - **`delegate__fanout`** (this module) — *ephemeral, parallel, clean-context*
//!     subtasks. Each delegate runs once with only its task prompt (never the
//!     parent's history), in parallel, and the combined results come back in one
//!     call. Nothing is persisted as a conversation. Use it to split a task into
//!     independent pieces and gather the answers. (≈ Claude Code's Task tool /
//!     Hermes & OpenClaw subagents.)
//!   - **`threads__*`** — *durable background workers.* Each worker is a real
//!     conversation the coordinator polls over time. Use it to manage long-running
//!     work you check back on.
//!
//! Per the Core-vs-Gateway rule this is **Core** (it decides *what runs*). It is a
//! thin wrapper over the delegation engine ([`crate::workflow::delegation`]) — the
//! same engine the `AgentDelegate` workflow node and the `POST /api/delegate/stream`
//! endpoint use — so the fan-out caps, clean-context invariant, and Gateway-routed
//! sub-agent calls are shared, not re-implemented.
//!
//! Registered as a reserved registry server (`delegate`) like spider/exa/threads,
//! so the `<server>__<tool>` id scheme, per-agent allowlist, catalog search, and
//! the single `call_tool` entry all work for free. With the default (empty/`None`)
//! agent allowlist the tool is offered directly, so an agent can delegate with **no
//! configuration** — the "automatic by default" behavior.
//!
//! # Defaulting to a real agent
//!
//! Each task may name an `agent_id`; when omitted it routes to the node's default
//! agent ([`crate::registry::DEFAULT_AGENT_ID`]) rather than a bare LLM call, so a
//! delegated subtask runs as a *real* agent with its own tools, gateway routing,
//! and persona. (The engine's `PermissionPreset` only governs the bare-LLM path and
//! is therefore not exposed on this tool — a delegate here is always a real agent.)
//!
//! # Bounding fan-out
//!
//! Because the tool is default-on and an agent (or a delegated sub-agent) can call
//! it repeatedly, a process-global semaphore ([`MAX_CONCURRENT_FANOUTS`]) caps how
//! many fan-outs run at once across the whole process. Combined with the engine's
//! per-fan-out concurrency cap this bounds the worst-case number of simultaneous
//! sub-agents and starves runaway re-entrant delegation.

use std::sync::Arc;
use std::sync::OnceLock;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Semaphore;

use super::RegistryTool;
use crate::workflow::delegation::{self, DelegateSpec, DelegationCaps, PermissionPreset};

/// Reserved registry server name for the built-in delegation provider.
pub const SERVER_NAME: &str = "delegate";

/// Max number of fan-outs running concurrently across the whole process. Mirrors
/// the coordinator-threads `MAX_CONCURRENT_WORKERS` ceiling. Excess fan-outs queue
/// for a permit rather than being rejected; combined with the engine's per-fan-out
/// cap this bounds total simultaneous sub-agents and starves runaway re-entrancy.
const MAX_CONCURRENT_FANOUTS: usize = 4;

/// The process-global fan-out concurrency limiter.
fn fanout_semaphore() -> &'static Arc<Semaphore> {
    static SEM: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SEM.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_FANOUTS)))
}

fn fanout_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "tasks": {
                "type": "array",
                "minItems": 1,
                "description": "The independent subtasks to fan out. Each runs once, in parallel, in a clean context (only its own task text — never this conversation's history).",
                "items": {
                    "type": "object",
                    "properties": {
                        "task": { "type": "string", "description": "The self-contained instruction for one sub-agent. Include everything it needs; it cannot see this conversation." },
                        "agent_id": { "type": "string", "description": "Agent to run this subtask (omit to use the node's default agent)." }
                    },
                    "required": ["task"]
                }
            },
            "max_concurrent": { "type": "integer", "minimum": 1, "description": "Max subtasks to run at once (clamped to the engine cap)." },
            "wall_time_secs": { "type": "integer", "minimum": 1, "description": "Per-subtask wall-time limit in seconds." }
        },
        "required": ["tasks"]
    })
}

/// The delegation tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__fanout"),
        server: SERVER_NAME.to_owned(),
        name: "fanout".to_owned(),
        description: Some(
            "Delegate one or more independent subtasks to sub-agents that run in parallel, \
             each in a clean context (no access to this conversation's history), and return \
             all of their results in one call. Use this to split work into pieces and gather \
             the answers. For durable, long-running workers you check back on over time, use \
             the threads__* tools instead."
                .to_owned(),
        ),
        input_schema: Some(fanout_schema()),
    }]
}

/// Dispatch a `delegate` tool call. A malformed call returns `Err`; an
/// unavailable dependency (no agent runner) is surfaced per-delegate as an error
/// string in the results, so the agent degrades gracefully.
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "fanout" => fanout(arguments).await,
        other => Err(anyhow::anyhow!("unknown delegate tool '{other}'")),
    }
}

async fn fanout(arguments: Value) -> Result<Value> {
    let raw_tasks = arguments
        .get("tasks")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or_else(|| anyhow::anyhow!("'tasks' must be a non-empty array"))?;

    let default_agent = crate::registry::DEFAULT_AGENT_ID;
    let mut specs: Vec<DelegateSpec> = Vec::with_capacity(raw_tasks.len());
    for (i, item) in raw_tasks.iter().enumerate() {
        let task = item
            .get("task")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("tasks[{i}].task must be a non-empty string"))?;
        // Default each delegate to a real agent so it has tools/governance, not a
        // bare LLM call. An explicit empty/whitespace agent_id falls back too.
        let agent_id = item
            .get("agent_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(default_agent)
            .to_owned();
        specs.push(DelegateSpec {
            id: format!("d{i}"),
            task: task.to_owned(),
            agent_id: Some(agent_id),
            // Preset only governs the bare-LLM path, which this tool never takes
            // (every delegate routes to a real agent). Kept at the safe default.
            preset: PermissionPreset::default(),
        });
    }

    let mut caps = DelegationCaps::default();
    if let Some(n) = arguments.get("max_concurrent").and_then(Value::as_u64) {
        caps.max_concurrent = n as usize;
    }
    if let Some(secs) = arguments.get("wall_time_secs").and_then(Value::as_u64) {
        caps.wall_time_secs = secs;
    }

    // Acquire a process-global permit so concurrent fan-outs (including re-entrant
    // delegation from a sub-agent that also holds this tool) are bounded.
    let _permit = fanout_semaphore()
        .acquire()
        .await
        .expect("delegate fan-out semaphore closed");

    // Depth 1: these are top-level delegates. The engine's depth cap still guards
    // the per-fan-out tree; the global semaphore above bounds re-entrancy.
    let results = delegation::run_fanout(specs, caps, 1, None)
        .await
        .map_err(|e| anyhow::anyhow!("delegation fan-out failed: {e}"))?;

    let tasks_out: Vec<Value> = results
        .into_iter()
        .enumerate()
        .map(|(i, r)| {
            json!({
                "index": i,
                "output": r.output,
                "error": r.error,
            })
        })
        .collect();
    let count = tasks_out.len();
    Ok(json!({ "ok": true, "results": tasks_out, "count": count }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_lists_fanout() {
        let t = tools();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "delegate__fanout");
        assert_eq!(t[0].server, SERVER_NAME);
        assert!(t[0].input_schema.is_some());
    }

    #[tokio::test]
    async fn fanout_rejects_empty_tasks() {
        assert!(dispatch("fanout", json!({ "tasks": [] })).await.is_err());
        assert!(dispatch("fanout", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn fanout_rejects_blank_task_text() {
        let err = dispatch("fanout", json!({ "tasks": [{ "task": "   " }] }))
            .await
            .expect_err("blank task must be rejected");
        assert!(err.to_string().contains("non-empty string"));
    }

    #[tokio::test]
    async fn unknown_tool_errors() {
        assert!(dispatch("nope", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn fanout_runs_and_returns_per_task_results() {
        // No agent runner is wired in the test context and the gateway is
        // unreachable, so each delegate fails fast — but the fan-out itself must
        // succeed and return one result per task, in order, with an error each.
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
            std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        }
        let out = dispatch(
            "fanout",
            json!({
                "tasks": [{ "task": "first" }, { "task": "second" }],
                "wall_time_secs": 2
            }),
        )
        .await
        .expect("fan-out itself succeeds");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["count"], json!(2));
        let results = out["results"].as_array().expect("results array");
        assert_eq!(results.len(), 2);
        assert_eq!(results[0]["index"], json!(0));
        assert_eq!(results[1]["index"], json!(1));
        for r in results {
            assert!(r["error"].is_string(), "each delegate must carry an error");
        }
        unsafe {
            std::env::remove_var("RYU_GATEWAY_URL");
        }
    }
}
