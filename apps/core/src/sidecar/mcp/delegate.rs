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
//! is therefore not exposed on this tool.)
//!
//! # Inline "dynamic subagents"
//!
//! Alternatively a task may carry a `system_prompt` (plus optional `model` and
//! `tools`), which defines an **ephemeral sub-agent inline** — the LangChain-style
//! "dynamic subagent" the calling model invents at runtime instead of naming a
//! pre-registered agent. Such a delegate runs as a single **clean-context Gateway
//! completion** ([`InlineAgentDef`]): no ACP tool loop, no persisted agent row, but
//! every call still routes through the Gateway firewall/DLP/budget/audit. Because
//! there is no tool loop, an inline sub-agent's `tools` are advisory prompt text
//! only — it cannot *execute* them. When a `system_prompt` is present, `agent_id`
//! is ignored (uniformly, at every entry point). Use `agent_id` for a
//! tool-executing specialist; use `system_prompt` to spin up a purpose-built
//! reasoner for one task with zero setup.
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
use crate::workflow::delegation::{
    self, DelegateSpec, DelegationCaps, InlineAgentDef, PermissionPreset,
};

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
                        "agent_id": { "type": "string", "description": "Existing agent to run this subtask (omit to use the node's default agent). Ignored when system_prompt is set." },
                        "system_prompt": { "type": "string", "description": "Define a sub-agent inline (a 'dynamic subagent'): its role and instructions. When set, this subtask runs as a fresh clean-context agent with these instructions — no pre-registered agent needed — and agent_id is ignored. Use this to spin up a purpose-built specialist for one task." },
                        "model": { "type": "string", "description": "Optional model for an inline sub-agent (only used together with system_prompt)." },
                        "tools": { "type": "array", "items": { "type": "string" }, "description": "Tool names listed in an inline sub-agent's prompt for awareness ONLY (used with system_prompt). An inline sub-agent runs as a single completion and cannot execute tools — use agent_id for a tool-executing specialist." }
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
        ..Default::default()
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
        // An inline `system_prompt` defines an ephemeral "dynamic subagent": the
        // subtask runs as a fresh, clean-context agent authored right here (routed
        // through the Gateway), with no registered agent_id. Otherwise default the
        // delegate to a real agent so it has tools/governance, not a bare LLM call.
        let inline = item
            .get("system_prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|system_prompt| {
                let model = item
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
                let tools = item
                    .get("tools")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                InlineAgentDef {
                    system_prompt: system_prompt.to_owned(),
                    model,
                    tools,
                }
            });

        // An inline sub-agent takes the clean-context Gateway path (no registered
        // agent_id); otherwise route to a real agent (explicit empty/whitespace
        // agent_id falls back to the node's default).
        let agent_id = if inline.is_some() {
            None
        } else {
            Some(
                item.get("agent_id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(default_agent)
                    .to_owned(),
            )
        };
        specs.push(DelegateSpec {
            id: format!("d{i}"),
            task: task.to_owned(),
            agent_id,
            // Preset only governs the bare-LLM path (no agent_id, no inline). Kept
            // at the safe default; inline defs supply their own system prompt.
            preset: PermissionPreset::default(),
            inline,
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
    async fn fanout_inline_subagent_runs_via_gateway() {
        // A task carrying a system_prompt defines an inline "dynamic subagent":
        // it must run through the clean-context Gateway path (no registered agent),
        // so with an unreachable gateway it fails fast but the fan-out still
        // returns one result for it.
        // These are process-global vars other modules' tests also mutate; hold the
        // shared gateway-env lock across the body and restore on exit so this test
        // neither reads nor writes them under another test's feet.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        unsafe {
            std::env::set_var("RYU_GATEWAY_URL", "http://10.255.255.1:1");
            std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        }
        let out = dispatch(
            "fanout",
            json!({
                "tasks": [{
                    "task": "summarise the attached note",
                    "system_prompt": "You are a one-sentence summariser.",
                    "model": "gpt-4o-mini",
                    "tools": ["read_memory"]
                }],
                "wall_time_secs": 2
            }),
        )
        .await
        .expect("fan-out itself succeeds");
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["count"], json!(1));
        let results = out["results"].as_array().expect("results array");
        assert_eq!(results.len(), 1);
        assert!(
            results[0]["error"].is_string(),
            "inline delegate must carry a fail-closed gateway error"
        );
        unsafe {
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
            match prev_fb {
                Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
                None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
            }
        }
    }

    #[test]
    fn fanout_schema_advertises_inline_fields() {
        let schema = fanout_schema();
        let item_props = &schema["properties"]["tasks"]["items"]["properties"];
        assert!(item_props.get("system_prompt").is_some());
        assert!(item_props.get("model").is_some());
        assert!(item_props.get("tools").is_some());
    }

    #[tokio::test]
    async fn fanout_runs_and_returns_per_task_results() {
        // No agent runner is wired in the test context and the gateway is
        // unreachable, so each delegate fails fast — but the fan-out itself must
        // succeed and return one result per task, in order, with an error each.
        // Serialize on the shared gateway-env lock and restore both vars on exit.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
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
            match prev_url {
                Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
                None => std::env::remove_var("RYU_GATEWAY_URL"),
            }
            match prev_fb {
                Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
                None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
            }
        }
    }
}
