//! Workflows as code: the `Script` node.
//!
//! A script is a JavaScript body that orchestrates sub-agents with a small API:
//!
//! ```js
//! phase("Research");
//! const [a, b] = await parallel([
//!   () => agent("Survey approach A for " + args.topic),
//!   () => agent("Survey approach B for " + args.topic),
//! ]);
//! phase("Decide");
//! return await agent(`Compare and recommend:\n${a}\n---\n${b}`, { label: "judge" });
//! ```
//!
//! - `agent(prompt, opts?)` runs one sub-agent and resolves to its text (or to
//!   parsed JSON when `opts.schema` / `opts.json` is set). `opts`: `label`,
//!   `phase`, `preset` (`research` | `code_read` | `code_write` | `summarise`),
//!   `agent_id`, `max_tokens`, `timeout_secs`, `schema`, `json`.
//! - `parallel(thunks)` runs thunks concurrently; a thunk that throws yields `null`.
//! - `pipeline(items, ...stages)` streams every item through the stages; items
//!   run concurrently, an item whose stage throws yields `null`.
//! - `phase(title)` labels the agents that follow; `log(...)` records progress.
//! - `args` is the node input (parsed JSON when it is JSON).
//!
//! # Durability
//!
//! The body runs in the Deno sandbox (no FS, network, or env) and its only way
//! out is the `script.agents` bridge, which runs each batch of `agent()` calls
//! as a checkpointed fan-out keyed by the call itself: `(prompt, preset,
//! agent_id, max_tokens)` plus its occurrence count. Every successful result is
//! on disk before the script sees it, so re-running the node after a crash, a
//! sandbox timeout, a panicked task, or a limit wait replays finished agents
//! instantly and only runs what never finished. That is the Claude-workflow
//! resume model: unchanged `agent()` calls return their cached result.
//!
//! A sub-agent stopped by a rate, usage, or session limit makes the whole node
//! fail with that limit error (even if the script caught it), so the executor
//! parks the run until the limit resets instead of finishing with holes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::delegation::{self, DelegateSpec, DelegationCaps, PermissionPreset};

/// Most `agent()` calls one script node may make, cached replays included.
pub const MAX_SCRIPT_AGENTS: usize = 200;

/// Wall-clock budget for one script attempt. Agent time counts against it; a
/// script that runs out is retried (or resumed) with its finished agents cached.
pub const SCRIPT_DEADLINE: Duration = Duration::from_secs(2 * 60 * 60);

/// Default per-agent wall time. Longer than a plain delegate's, because a
/// script agent is usually a full task, not a single completion.
pub const DEFAULT_AGENT_WALL_TIME_SECS: u64 = 600;

/// Upper bound for a per-agent `timeout_secs`.
pub const MAX_AGENT_WALL_TIME_SECS: u64 = 3600;

/// Sandbox bridge path the prelude calls for a batch of `agent()` calls.
const AGENTS_PATH: &str = "script.agents";

/// The helpers every script body sees. Batching matters: the sandbox relays one
/// host call at a time, so `agent()` calls made in the same tick are queued and
/// sent as one fan-out, which Core runs concurrently.
const PRELUDE: &str = r#"
const __ryuScript = { phase: null };
let __ryuQueue = [];
let __ryuFlushing = false;
let __ryuScheduled = false;
function __ryuSchedule() {
  if (__ryuScheduled || __ryuFlushing) return;
  __ryuScheduled = true;
  setTimeout(__ryuFlush, 0);
}
async function __ryuFlush() {
  __ryuScheduled = false;
  if (__ryuQueue.length === 0) return;
  __ryuFlushing = true;
  const batch = __ryuQueue;
  __ryuQueue = [];
  try {
    const reply = await tools.script.agents({ calls: batch.map((b) => b.call) });
    const results = (reply && reply.results) || [];
    batch.forEach((b, i) => {
      const r = results[i];
      if (r && r.ok) b.resolve(r.output ?? "");
      else b.reject(new Error((r && r.error) || "agent failed"));
    });
  } catch (e) {
    for (const b of batch) b.reject(e);
  } finally {
    __ryuFlushing = false;
    if (__ryuQueue.length > 0) __ryuSchedule();
  }
}
function __ryuParseJson(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse((fenced ? fenced[1] : String(text)).trim());
}
function log(...parts) { console.log(...parts); }
function phase(title) {
  __ryuScript.phase = title == null ? null : String(title);
  console.log("phase: " + __ryuScript.phase);
}
function agent(prompt, opts) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return Promise.reject(new Error("agent(prompt): prompt must be a non-empty string"));
  }
  const o = opts ?? {};
  let text = prompt;
  if (o.schema) {
    text += "\n\nRespond with only JSON that matches this JSON Schema:\n" + JSON.stringify(o.schema);
  }
  const call = {
    prompt: text,
    label: o.label ?? null,
    phase: o.phase ?? __ryuScript.phase,
    preset: o.preset ?? null,
    agent_id: o.agent_id ?? o.agentId ?? null,
    max_tokens: o.max_tokens ?? o.maxTokens ?? null,
    timeout_secs: o.timeout_secs ?? o.timeoutSecs ?? null,
  };
  const pending = new Promise((resolve, reject) => {
    __ryuQueue.push({ call, resolve, reject });
    __ryuSchedule();
  });
  return o.schema || o.json ? pending.then(__ryuParseJson) : pending;
}
async function parallel(thunks) {
  return Promise.all((thunks ?? []).map(async (thunk, i) => {
    try {
      return await (typeof thunk === "function" ? thunk() : thunk);
    } catch (e) {
      console.log("parallel[" + i + "] failed: " + (e && e.message ? e.message : String(e)));
      return null;
    }
  }));
}
async function pipeline(items, ...stages) {
  return Promise.all((items ?? []).map(async (item, i) => {
    let value = item;
    try {
      for (const stage of stages) value = await stage(value, item, i);
      return value;
    } catch (e) {
      console.log("pipeline[" + i + "] failed: " + (e && e.message ? e.message : String(e)));
      return null;
    }
  }));
}
"#;

/// Wrap a script body into a sandbox program. `export` keywords are dropped so
/// a body written as a module (`export const meta = {...}`) still runs as the
/// async function body it becomes; a top-level `return` sets the node output.
pub fn build_script_program(code: &str, args: &Value) -> String {
    let body: String = code
        .lines()
        .map(|line| {
            let trimmed = line.trim_start();
            match trimmed.strip_prefix("export ") {
                Some(rest) if !trimmed.starts_with("export {") => {
                    format!("{}{}", &line[..line.len() - trimmed.len()], rest)
                }
                _ => line.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let args_json = serde_json::to_string(args).unwrap_or_else(|_| "null".to_owned());
    format!("{PRELUDE}\nconst args = {args_json};\nreturn await (async () => {{\n{body}\n}})();\n")
}

/// The node input as the script's `args`: parsed JSON when it is JSON, else the
/// raw string (`null` when empty).
pub fn script_args(input: &str) -> Value {
    if input.trim().is_empty() {
        return Value::Null;
    }
    serde_json::from_str(input).unwrap_or_else(|_| Value::String(input.to_owned()))
}

/// One `agent()` call as the prelude sends it.
#[derive(Debug, Clone, Deserialize)]
struct AgentCall {
    prompt: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    phase: Option<String>,
    #[serde(default)]
    preset: Option<PermissionPreset>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    max_tokens: Option<u32>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct AgentBatch {
    #[serde(default)]
    calls: Vec<AgentCall>,
}

/// Per-attempt bookkeeping shared between the bridge and the node runner.
#[derive(Default)]
struct ScriptState {
    /// Calls seen so far, for the [`MAX_SCRIPT_AGENTS`] cap.
    calls: usize,
    /// Occurrences per call identity, so two identical calls get distinct keys.
    occurrences: HashMap<String, u32>,
    /// The first limit error a sub-agent reported in this attempt.
    limit_error: Option<String>,
}

/// Where a script node's agents run and what they may do.
#[derive(Debug, Clone)]
pub struct ScriptContext {
    pub run_id: String,
    pub node_id: String,
    /// Nesting depth of the node's run; delegates run one level deeper.
    pub depth: usize,
    /// Agent every `agent()` call runs as. When set, a call cannot pick another.
    pub agent_id: Option<String>,
    /// Preset for calls that do not name one.
    pub default_preset: PermissionPreset,
    /// Whether calls may use a mutating preset (`code_write`), whatever the
    /// call or `default_preset` asks for.
    pub allow_mutation: bool,
}

/// The `script.agents` bridge: runs a batch of `agent()` calls as one
/// checkpointed fan-out.
struct ScriptBridge {
    ctx: ScriptContext,
    state: Mutex<ScriptState>,
}

impl ScriptBridge {
    /// Stable delegate id for a call: hash of what determines its result plus its
    /// occurrence, so an edited prompt runs fresh while an unchanged one replays.
    fn delegate_id(
        &self,
        call: &AgentCall,
        agent_id: Option<&str>,
        preset: PermissionPreset,
    ) -> String {
        let identity = json!([call.prompt, agent_id, preset, call.max_tokens]).to_string();
        let occurrence = {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let count = state.occurrences.entry(identity.clone()).or_insert(0);
            *count += 1;
            *count
        };
        let digest = Sha256::digest(format!("{identity}\u{0}{occurrence}").as_bytes());
        format!("a{}", &hex::encode(digest)[..32])
    }

    async fn run_batch(&self, args: Value) -> Result<Value, String> {
        let batch: AgentBatch =
            serde_json::from_value(args).map_err(|e| format!("invalid agent batch: {e}"))?;
        if batch.calls.is_empty() {
            return Ok(json!({ "results": [] }));
        }
        {
            let mut state = self
                .state
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(limit) = &state.limit_error {
                // The node is going to park on this limit anyway; do not start
                // more agents into the same wall.
                let results: Vec<Value> = batch
                    .calls
                    .iter()
                    .map(|_| json!({ "ok": false, "error": limit }))
                    .collect();
                return Ok(json!({ "results": results }));
            }
            state.calls += batch.calls.len();
            if state.calls > MAX_SCRIPT_AGENTS {
                return Err(format!("script exceeded {MAX_SCRIPT_AGENTS} agent() calls"));
            }
        }

        let mut specs = Vec::with_capacity(batch.calls.len());
        let mut max_tokens = 0u32;
        let mut wall_time = 0u64;
        for call in &batch.calls {
            let agent_id = match (&self.ctx.agent_id, &call.agent_id) {
                (Some(locked), Some(asked)) if asked != locked => {
                    return Err(format!(
                        "agent(): this script runs as agent '{locked}' and cannot run '{asked}'"
                    ));
                }
                (Some(locked), _) => Some(locked.clone()),
                (None, asked) => asked.clone().filter(|id| !id.is_empty()),
            };
            let preset = call.preset.unwrap_or(self.ctx.default_preset);
            if preset.allows_mutation() && !self.ctx.allow_mutation {
                return Err(
                    "agent(): preset 'code_write' is not allowed in this script run".to_owned(),
                );
            }
            if preset.allows_mutation() && agent_id.is_none() {
                return Err("agent(): preset 'code_write' needs an agent_id".to_owned());
            }
            max_tokens = max_tokens.max(call.max_tokens.unwrap_or(delegation::DEFAULT_MAX_TOKENS));
            wall_time = wall_time.max(
                call.timeout_secs
                    .unwrap_or(DEFAULT_AGENT_WALL_TIME_SECS)
                    .clamp(1, MAX_AGENT_WALL_TIME_SECS),
            );
            let id = self.delegate_id(call, agent_id.as_deref(), preset);
            tracing::debug!(
                run_id = %self.ctx.run_id,
                node_id = %self.ctx.node_id,
                delegate = %id,
                label = call.label.as_deref().unwrap_or(""),
                phase = call.phase.as_deref().unwrap_or(""),
                "script agent queued"
            );
            specs.push(DelegateSpec {
                id,
                task: call.prompt.clone(),
                agent_id,
                preset,
                inline: None,
            });
        }

        let caps = DelegationCaps {
            max_tokens,
            wall_time_secs: wall_time,
            ..DelegationCaps::default()
        };
        let key = Arc::new(delegation::FanoutCheckpointKey {
            run_id: self.ctx.run_id.clone(),
            node_id: self.ctx.node_id.clone(),
        });
        let results = delegation::run_fanout_with_checkpoint(
            specs,
            caps,
            self.ctx.depth + 1,
            None,
            Some(key),
        )
        .await
        .map_err(|e| e.to_string())?;

        let replies: Vec<Value> = results
            .into_iter()
            .map(|result| match (result.output, result.error) {
                (Some(output), None) => json!({ "ok": true, "output": output }),
                (_, error) => {
                    let error = error.unwrap_or_else(|| "agent produced no output".to_owned());
                    if super::limits::is_limit_error(&error) {
                        let mut state = self
                            .state
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner);
                        state.limit_error.get_or_insert_with(|| error.clone());
                    }
                    json!({ "ok": false, "error": error })
                }
            })
            .collect();
        Ok(json!({ "results": replies }))
    }
}

impl ryu_tool_exec::SandboxBridge for ScriptBridge {
    fn handle(
        &self,
        path: String,
        args: Value,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = ryu_tool_exec::InvokeOutcome> + Send + '_>,
    > {
        Box::pin(async move {
            let result = if path == AGENTS_PATH {
                self.run_batch(args).await
            } else {
                Err(format!("'{path}' is not available to workflow scripts"))
            };
            ryu_tool_exec::InvokeOutcome::Result(match result {
                Ok(value) => ryu_tool_exec::ToolInvokeResult {
                    value,
                    is_error: false,
                    error: None,
                },
                Err(error) => ryu_tool_exec::ToolInvokeResult {
                    value: Value::Null,
                    is_error: true,
                    error: Some(error),
                },
            })
        })
    }
}

/// Run one attempt of a `Script` node. `Ok` is the script's return value as the
/// node output (strings verbatim, anything else as JSON).
pub async fn run_script(code: &str, input: &str, ctx: ScriptContext) -> Result<String, String> {
    if code.trim().is_empty() {
        return Err("script node: code is empty".to_owned());
    }
    if !ryu_tool_exec::is_available() {
        return Err(
            "script node: the sandbox runtime (Deno) is not installed on this node".to_owned(),
        );
    }
    let program = build_script_program(code, &script_args(input));
    let bridge = Arc::new(ScriptBridge {
        ctx,
        state: Mutex::new(ScriptState::default()),
    });
    let invoker = Arc::new(ryu_tool_exec::SandboxToolInvoker::bridge(bridge.clone()));
    let outcome = ryu_tool_exec::run_sandboxed_with_augment_and_deadline(
        program,
        invoker,
        "workflow-script",
        None,
        &ryu_tool_exec::SandboxAugment::default(),
        SCRIPT_DEADLINE,
    )
    .await;

    let limit = bridge
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .limit_error
        .clone();
    if let Some(limit) = limit {
        return Err(format!("script agent hit a provider limit: {limit}"));
    }
    match outcome {
        ryu_tool_exec::ExecOutcome::Completed {
            result,
            is_error: false,
            ..
        } => Ok(match result {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(text)) => text,
            Some(other) => other.to_string(),
        }),
        ryu_tool_exec::ExecOutcome::Completed { error, logs, .. } => {
            let tail = logs
                .last()
                .map(|line| format!(" (last log: {line})"))
                .unwrap_or_default();
            Err(format!(
                "script failed: {}{tail}",
                error.unwrap_or_else(|| "unknown error".to_owned())
            ))
        }
        ryu_tool_exec::ExecOutcome::Paused { .. } => {
            Err("script node: unexpected pause".to_owned())
        }
    }
}

// ── Ad-hoc script runs (started by an agent through a plugin tool) ─────────

/// Largest script body an agent may submit.
pub const MAX_SCRIPT_BYTES: usize = 256 * 1024;

/// Run id prefix for agent-started script runs.
pub const SCRIPT_RUN_PREFIX: &str = "sr-";

/// Input key a script workflow reads its `args` from.
const ARGS_KEY: &str = "args";

fn short_hash(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update([0]);
    }
    hex::encode(hasher.finalize())[..32].to_owned()
}

/// Digest of a caller scope as stored on a script run
/// ([`super::store::WorkflowRun::caller_scope`]). Domain-separated from the run
/// id hash, and the raw scope (plugin, agent, conversation ids) never lands on
/// disk.
pub(crate) fn scope_digest(scope: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"ryu-script-run-scope\0");
    hasher.update(scope.as_bytes());
    hex::encode(hasher.finalize())
}

/// The answer for a run the caller may not see. Identical to the unknown-id
/// answer, so a run id is not an existence oracle for other callers.
const RUN_NOT_FOUND: &str = "run not found";

/// The one-node workflow an ad-hoc script runs as: `args` → script → `result`.
/// Content-addressed, so the same script (and agent/preset/mutation allowance)
/// is one definition.
///
/// The mutation allowance only holds with a locked `agent_id`: without one,
/// `agent(prompt, { preset: "code_write", agent_id })` would let the script
/// pick any registered agent's full tool loop, skipping the per-agent
/// availability and `agent.run` checks `host.runFanout` applies.
pub fn script_workflow(
    code: &str,
    agent_id: Option<&str>,
    preset: Option<PermissionPreset>,
    allow_mutation: bool,
) -> super::Workflow {
    use super::{NodeKind, Workflow, WorkflowEdge, WorkflowNode};
    let allow_mutation = allow_mutation && agent_id.is_some_and(|id| !id.trim().is_empty());
    let preset_label = preset.map(|p| format!("{p:?}")).unwrap_or_default();
    let mut id_parts = vec![code, agent_id.unwrap_or(""), &preset_label];
    if allow_mutation {
        id_parts.push("allow_mutation");
    }
    let id = format!(
        "{}{}",
        super::store::SCRIPT_WORKFLOW_PREFIX,
        short_hash(&id_parts)
    );
    let node = |id: &str, kind: NodeKind| WorkflowNode {
        id: id.to_owned(),
        retry: None,
        timeout_ms: None,
        repeat: None,
        kind,
    };
    let edge = |from: &str, to: &str| WorkflowEdge {
        from: from.to_owned(),
        to: to.to_owned(),
        branch: None,
    };
    Workflow {
        id,
        name: "Workflow script".to_owned(),
        description: None,
        nodes: vec![
            node(
                "args",
                NodeKind::Input {
                    key: Some(ARGS_KEY.to_owned()),
                },
            ),
            node(
                "script",
                NodeKind::Script {
                    code: code.to_owned(),
                    agent_id: agent_id.map(str::to_owned),
                    preset,
                    allow_mutation: Some(allow_mutation),
                },
            ),
            node(
                "result",
                NodeKind::Output {
                    key: Some("result".to_owned()),
                },
            ),
        ],
        edges: vec![edge("args", "script"), edge("script", "result")],
        triggers: Vec::new(),
        max_concurrency: None,
        created_at: None,
        updated_at: None,
    }
}

/// A request to start (or re-attach to) an ad-hoc script run.
pub struct ScriptRunRequest<'a> {
    pub code: &'a str,
    pub args: &'a Value,
    /// Agent every `agent()` call runs as (the calling agent).
    pub agent_id: Option<&'a str>,
    pub preset: Option<PermissionPreset>,
    /// Whether the script's agents may use a mutating preset (`code_write`),
    /// e.g. because the starting plugin holds `hook:run-agent:write`.
    pub allow_mutation: bool,
    /// Who is asking (e.g. plugin + conversation). Part of the default run id,
    /// so one caller re-issuing the same call re-attaches instead of starting
    /// over, and two callers never share a run.
    pub scope: &'a str,
    /// Caller-chosen run key, for running the same script twice on purpose.
    pub run_key: Option<&'a str>,
}

/// Start a script run in the background, or re-attach to the existing one.
///
/// The default run id is derived from the scope, script, and args, so an agent
/// whose turn was interrupted (and auto-resumed) re-issuing the same tool call
/// lands on the same durable run: finished agents are not run again. A
/// `Failed` run is continued from its checkpoints; a `Waiting` run keeps its
/// limit wait. Returns the run id.
pub fn start_script_run(request: &ScriptRunRequest<'_>) -> Result<String, String> {
    if request.code.trim().is_empty() {
        return Err("script is empty".to_owned());
    }
    if request.code.len() > MAX_SCRIPT_BYTES {
        return Err(format!("script exceeds {MAX_SCRIPT_BYTES} bytes"));
    }
    let mutating = request
        .preset
        .is_some_and(PermissionPreset::allows_mutation);
    if mutating && !request.allow_mutation {
        return Err("preset 'code_write' is not allowed for this caller".to_owned());
    }
    if mutating && request.agent_id.is_none() {
        return Err("preset 'code_write' needs a calling agent".to_owned());
    }
    let workflow = script_workflow(
        request.code,
        request.agent_id,
        request.preset,
        request.allow_mutation,
    );
    let args_json = serde_json::to_string(request.args).map_err(|e| e.to_string())?;
    let run_id = format!(
        "{SCRIPT_RUN_PREFIX}{}",
        short_hash(&[
            request.scope,
            &workflow.id,
            &args_json,
            request.run_key.unwrap_or("")
        ])
    );
    super::store::save_script_workflow(&workflow)
        .map_err(|e| format!("could not save the script: {e}"))?;

    let caller_scope = scope_digest(request.scope);
    match super::store::load_run(&run_id) {
        Ok(mut run) => {
            match run.caller_scope.as_deref() {
                Some(owner) if owner == caller_scope => {}
                Some(_) => return Err(RUN_NOT_FOUND.to_owned()),
                None => {
                    // Written before runs recorded their scope. The run id is a
                    // hash over this caller's scope, so deriving it proves
                    // ownership: stamp the scope so status reads work again.
                    run.caller_scope = Some(caller_scope);
                    super::store::save_run(&run).map_err(|e| e.to_string())?;
                }
            }
            match run.status {
                super::store::RunStatus::Failed => {
                    // Asked again after a failure: continue from the checkpoints.
                    run.status = super::store::RunStatus::Running;
                    run.error = None;
                    super::store::save_run(&run).map_err(|e| e.to_string())?;
                    super::auto_resume::spawn_supervised(run_id.clone());
                }
                super::store::RunStatus::Running => {
                    // Interrupted with nobody executing it: pick it back up.
                    if !super::executor::is_run_executing(&run_id) {
                        super::auto_resume::spawn_supervised(run_id.clone());
                    }
                }
                super::store::RunStatus::Waiting => super::auto_resume::schedule_wake(&run),
                super::store::RunStatus::Completed | super::store::RunStatus::AwaitingInput => {}
            }
        }
        Err(_) => {
            let input = HashMap::from([(ARGS_KEY.to_owned(), args_json)]);
            let mut run = super::store::WorkflowRun::new(run_id.clone(), workflow.id, input);
            run.caller_scope = Some(caller_scope);
            super::store::save_run(&run).map_err(|e| format!("could not start the run: {e}"))?;
            super::auto_resume::spawn_supervised(run_id.clone());
        }
    }
    Ok(run_id)
}

/// What a caller sees of a script run.
pub fn script_run_summary(run: &super::store::WorkflowRun) -> Value {
    let result = run.output.get("result").map(|text| {
        serde_json::from_str::<Value>(text).unwrap_or_else(|_| Value::String(text.clone()))
    });
    json!({
        "run_id": run.run_id,
        "status": run.status,
        "result": result,
        "error": run.error,
        "resume_at": run.resume_at,
        "wait_reason": run.wait_reason,
        "updated_at": run.updated_at,
    })
}

/// Load a script run for `scope`. A run started under another scope, or one
/// with no recorded scope, reads exactly like an unknown run id.
fn load_script_run_for(run_id: &str, scope: &str) -> Result<super::store::WorkflowRun, String> {
    let run = super::store::load_run(run_id).map_err(|_| RUN_NOT_FOUND.to_owned())?;
    if run.caller_scope.as_deref() != Some(scope_digest(scope).as_str()) {
        return Err(RUN_NOT_FOUND.to_owned());
    }
    Ok(run)
}

/// Wait up to `wait` for a script run to leave `Running`, then summarize it.
/// Only ad-hoc script runs started under the same caller `scope` (see
/// [`ScriptRunRequest::scope`]) are visible here.
pub async fn wait_for_script_run(
    run_id: &str,
    scope: &str,
    wait: Duration,
) -> Result<Value, String> {
    if !run_id.starts_with(SCRIPT_RUN_PREFIX) {
        return Err("not a workflow script run id".to_owned());
    }
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        // Ownership is checked on the first load, so a foreign run id answers
        // at once, like an unknown one, instead of waiting on it.
        let run = load_script_run_for(run_id, scope)?;
        if run.status != super::store::RunStatus::Running || tokio::time::Instant::now() >= deadline
        {
            return Ok(script_run_summary(&run));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn module_style_bodies_lose_their_export_keywords() {
        let program = build_script_program(
            "export const meta = { name: 'x' };\n  export async function go() { return 1; }\nreturn meta.name;",
            &json!({ "topic": "t" }),
        );
        assert!(program.contains("\nconst meta = { name: 'x' };"));
        assert!(program.contains("\n  async function go()"));
        assert!(program.contains("const args = {\"topic\":\"t\"};"));
        assert!(!program.contains("export const"));
    }

    #[test]
    fn args_are_json_when_they_parse() {
        assert_eq!(script_args(""), Value::Null);
        assert_eq!(script_args(r#"{"a":1}"#), json!({ "a": 1 }));
        assert_eq!(script_args("plain text"), json!("plain text"));
    }

    fn bridge(agent_id: Option<&str>) -> ScriptBridge {
        ScriptBridge {
            ctx: ScriptContext {
                run_id: "r".into(),
                node_id: "n".into(),
                depth: 0,
                agent_id: agent_id.map(str::to_owned),
                default_preset: PermissionPreset::Research,
                allow_mutation: true,
            },
            state: Mutex::new(ScriptState::default()),
        }
    }

    fn call(prompt: &str) -> AgentCall {
        AgentCall {
            prompt: prompt.into(),
            label: Some("cosmetic".into()),
            phase: None,
            preset: None,
            agent_id: None,
            max_tokens: None,
            timeout_secs: None,
        }
    }

    #[test]
    fn delegate_ids_replay_unchanged_calls_and_split_repeats() {
        let first = bridge(None);
        let a1 = first.delegate_id(&call("same"), None, PermissionPreset::Research);
        let a2 = first.delegate_id(&call("same"), None, PermissionPreset::Research);
        let b = first.delegate_id(&call("other"), None, PermissionPreset::Research);
        assert_ne!(a1, a2, "a repeated call is a separate agent");
        assert_ne!(a1, b);

        // A re-run of the same script sees the same ids in the same order.
        let replay = bridge(None);
        assert_eq!(
            replay.delegate_id(&call("same"), None, PermissionPreset::Research),
            a1
        );
        assert_eq!(
            replay.delegate_id(&call("same"), None, PermissionPreset::Research),
            a2
        );

        // Labels are cosmetic; the preset is not.
        let mut relabelled = call("same");
        relabelled.label = Some("renamed".into());
        assert_eq!(
            bridge(None).delegate_id(&relabelled, None, PermissionPreset::Research),
            a1
        );
        assert_ne!(
            bridge(None).delegate_id(&call("same"), None, PermissionPreset::Summarise),
            a1
        );
        assert!(a1.len() <= 128 && a1.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[tokio::test]
    async fn a_locked_agent_cannot_be_swapped_and_writes_need_an_agent() {
        let locked = bridge(Some("me"));
        let error = locked
            .run_batch(json!({ "calls": [{ "prompt": "x", "agent_id": "someone-else" }] }))
            .await
            .unwrap_err();
        assert!(error.contains("cannot run 'someone-else'"), "{error}");

        let free = bridge(None);
        let error = free
            .run_batch(json!({ "calls": [{ "prompt": "x", "preset": "code_write" }] }))
            .await
            .unwrap_err();
        assert!(error.contains("needs an agent_id"), "{error}");
    }

    #[tokio::test]
    async fn a_read_only_script_refuses_mutating_presets() {
        let mut read_only = bridge(Some("me"));
        read_only.ctx.allow_mutation = false;
        let error = read_only
            .run_batch(json!({ "calls": [{ "prompt": "x", "preset": "code_write" }] }))
            .await
            .unwrap_err();
        assert!(error.contains("not allowed"), "{error}");

        // A mutating default preset is refused the same way.
        read_only.ctx.default_preset = PermissionPreset::CodeWrite;
        let error = read_only
            .run_batch(json!({ "calls": [{ "prompt": "x" }] }))
            .await
            .unwrap_err();
        assert!(error.contains("not allowed"), "{error}");
    }

    #[tokio::test]
    async fn the_agent_cap_is_enforced_across_batches() {
        let capped = bridge(None);
        capped.state.lock().unwrap().calls = MAX_SCRIPT_AGENTS;
        let error = capped
            .run_batch(json!({ "calls": [{ "prompt": "one more" }] }))
            .await
            .unwrap_err();
        assert!(error.contains("exceeded"), "{error}");
    }

    fn ctx(run_id: &str) -> ScriptContext {
        ScriptContext {
            run_id: run_id.into(),
            node_id: "script".into(),
            depth: 0,
            agent_id: None,
            default_preset: PermissionPreset::Research,
            allow_mutation: false,
        }
    }

    /// Record `output` as the finished result of the `occurrence`-th
    /// `agent(prompt)` call of `run_id`, as an earlier attempt would have.
    fn seed_finished_agent(run_id: &str, prompt: &str, output: &str) {
        let seeding = bridge(None);
        let id = seeding.delegate_id(&call(prompt), None, PermissionPreset::Research);
        delegation::save_delegate_checkpoint(
            &delegation::FanoutCheckpointKey {
                run_id: run_id.into(),
                node_id: "script".into(),
            },
            &delegation::DelegateResult::ok(id, PermissionPreset::Research, output.into()),
        );
    }

    #[tokio::test]
    async fn scripts_return_values_from_args() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let run_id = format!("script-args-{}", uuid::Uuid::new_v4().simple());
        let out = run_script(
            "export const meta = { name: 'double' };\nreturn { doubled: args.n * 2, name: meta.name };",
            r#"{"n":21}"#,
            ctx(&run_id),
        )
        .await
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&out).unwrap(),
            json!({ "doubled": 42, "name": "double" })
        );
    }

    /// The resume guarantee end to end: agents an earlier attempt finished are
    /// served from their checkpoints (no model call is possible in this test),
    /// batched through `parallel` and `pipeline` like a live run.
    #[tokio::test]
    async fn finished_agents_replay_from_checkpoints() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let run_id = format!("script-replay-{}", uuid::Uuid::new_v4().simple());
        seed_finished_agent(&run_id, "research A", "alpha");
        seed_finished_agent(&run_id, "research B", "beta");
        seed_finished_agent(&run_id, "summarise alpha", "A!");
        seed_finished_agent(&run_id, "summarise beta", "B!");
        let code = r#"
phase("Research");
const found = await parallel([() => agent("research A"), () => agent("research B")]);
phase("Summarise");
const summaries = await pipeline(found, (text) => agent("summarise " + text));
return summaries.join(" ");
"#;
        let out = run_script(code, "", ctx(&run_id)).await.unwrap();
        assert_eq!(out, "A! B!");
    }

    #[tokio::test]
    async fn a_limit_error_fails_the_node_with_a_parkable_error() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let run_id = format!("script-limit-{}", uuid::Uuid::new_v4().simple());
        let error = run_script(
            r#"throw new Error("usage limit reached, resets in 2 hours");"#,
            "",
            ctx(&run_id),
        )
        .await
        .unwrap_err();
        assert!(super::super::limits::is_limit_error(&error), "{error}");
    }

    #[tokio::test]
    async fn agent_started_runs_finish_in_the_background_and_reattach() {
        if !ryu_tool_exec::is_available() {
            eprintln!("skipping: Deno sandbox runtime not installed");
            return;
        }
        let scope = format!("test-scope-{}", uuid::Uuid::new_v4().simple());
        let args = json!({ "n": 2 });
        let request = ScriptRunRequest {
            code: "return { squared: args.n * args.n };",
            args: &args,
            agent_id: None,
            preset: None,
            allow_mutation: false,
            scope: &scope,
            run_key: None,
        };
        let run_id = start_script_run(&request).unwrap();
        assert!(run_id.starts_with(SCRIPT_RUN_PREFIX));
        let summary = wait_for_script_run(&run_id, &scope, Duration::from_secs(30))
            .await
            .unwrap();
        assert_eq!(summary["status"], "completed", "{summary}");
        assert_eq!(summary["result"], json!({ "squared": 4 }));

        // Re-issuing the same call (an interrupted turn retrying it) attaches
        // to the finished run instead of running the script again.
        let before = super::super::store::load_run(&run_id).unwrap().updated_at;
        assert_eq!(start_script_run(&request).unwrap(), run_id);
        assert_eq!(
            super::super::store::load_run(&run_id).unwrap().updated_at,
            before
        );

        // A run key is a deliberate second run; other scopes never share runs.
        let keyed = ScriptRunRequest {
            run_key: Some("again"),
            ..request
        };
        assert_ne!(start_script_run(&keyed).unwrap(), run_id);
        let other_scope = ScriptRunRequest {
            scope: "someone-else",
            run_key: None,
            ..keyed
        };
        assert_ne!(start_script_run(&other_scope).unwrap(), run_id);

        assert!(
            wait_for_script_run("not-a-script-run", &scope, Duration::ZERO)
                .await
                .is_err()
        );
        // Another caller holding the run id reads it as unknown.
        assert_eq!(
            wait_for_script_run(&run_id, "someone-else", Duration::ZERO)
                .await
                .unwrap_err(),
            RUN_NOT_FOUND
        );
    }

    /// The run id `start_script_run` derives for `request`, so a test can seed
    /// a record without starting (and executing) the script.
    fn derived_run_id(request: &ScriptRunRequest<'_>) -> (String, String) {
        let workflow = script_workflow(
            request.code,
            request.agent_id,
            request.preset,
            request.allow_mutation,
        );
        let args_json = serde_json::to_string(request.args).unwrap();
        let run_id = format!(
            "{SCRIPT_RUN_PREFIX}{}",
            short_hash(&[
                request.scope,
                &workflow.id,
                &args_json,
                request.run_key.unwrap_or("")
            ])
        );
        (run_id, workflow.id)
    }

    fn seed_completed_run(run_id: &str, workflow_id: &str, caller_scope: Option<String>) {
        let mut run = super::super::store::WorkflowRun::new(
            run_id.to_owned(),
            workflow_id.to_owned(),
            HashMap::new(),
        );
        run.status = super::super::store::RunStatus::Completed;
        run.output
            .insert("result".to_owned(), r#"{"secret":"owner-only"}"#.to_owned());
        run.caller_scope = caller_scope;
        super::super::store::save_run(&run).unwrap();
    }

    #[tokio::test]
    async fn script_run_reads_are_scoped_to_the_caller_that_started_them() {
        let owner = format!(
            "plugin-a\u{0}agent-1\u{0}conv-{}",
            uuid::Uuid::new_v4().simple()
        );
        let args = json!({ "n": 1 });
        let request = ScriptRunRequest {
            code: "return 1;",
            args: &args,
            agent_id: None,
            preset: None,
            allow_mutation: false,
            scope: &owner,
            run_key: None,
        };
        let (run_id, workflow_id) = derived_run_id(&request);
        seed_completed_run(&run_id, &workflow_id, Some(scope_digest(&owner)));

        let summary = wait_for_script_run(&run_id, &owner, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(summary["result"], json!({ "secret": "owner-only" }));

        let unknown = format!("{SCRIPT_RUN_PREFIX}{}", "0".repeat(32));
        let unknown_error = wait_for_script_run(&unknown, &owner, Duration::ZERO)
            .await
            .unwrap_err();
        let other_plugin = owner.replacen("plugin-a", "plugin-b", 1);
        let other_agent = owner.replacen("agent-1", "agent-2", 1);
        let other_conversation = format!("{owner}-other");
        for foreign in [
            &other_plugin,
            &other_agent,
            &other_conversation,
            &String::new(),
        ] {
            // Same answer as an unknown id, and it does not wait on the run.
            let started = std::time::Instant::now();
            let error = wait_for_script_run(&run_id, foreign, Duration::from_secs(30))
                .await
                .unwrap_err();
            assert_eq!(error, unknown_error, "scope {foreign:?}");
            assert!(started.elapsed() < Duration::from_secs(5));
        }
    }

    #[tokio::test]
    async fn legacy_script_runs_are_unreadable_until_their_owner_reattaches() {
        let owner = format!("plugin-a\u{0}\u{0}conv-{}", uuid::Uuid::new_v4().simple());
        let args = json!({ "legacy": true });
        let request = ScriptRunRequest {
            code: "return 'legacy';",
            args: &args,
            agent_id: None,
            preset: None,
            allow_mutation: false,
            scope: &owner,
            run_key: None,
        };
        let (run_id, workflow_id) = derived_run_id(&request);
        // A run written before runs recorded their caller scope.
        seed_completed_run(&run_id, &workflow_id, None);

        for reader in [owner.as_str(), "plugin-b\u{0}\u{0}", ""] {
            assert_eq!(
                wait_for_script_run(&run_id, reader, Duration::ZERO)
                    .await
                    .unwrap_err(),
                RUN_NOT_FOUND
            );
        }

        // The owner re-issuing its call derives the same id, which proves the
        // scope: the run is stamped (not restarted) and readable again.
        assert_eq!(start_script_run(&request).unwrap(), run_id);
        let stored = super::super::store::load_run(&run_id).unwrap();
        assert_eq!(stored.caller_scope, Some(scope_digest(&owner)));
        assert_eq!(stored.status, super::super::store::RunStatus::Completed);
        let summary = wait_for_script_run(&run_id, &owner, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(summary["result"], json!({ "secret": "owner-only" }));
        assert_eq!(
            wait_for_script_run(&run_id, "plugin-b\u{0}\u{0}", Duration::ZERO)
                .await
                .unwrap_err(),
            RUN_NOT_FOUND
        );
    }

    #[test]
    fn script_runs_validate_their_input() {
        let args = Value::Null;
        let request = |code| ScriptRunRequest {
            code,
            args: &args,
            agent_id: None,
            preset: None,
            allow_mutation: false,
            scope: "s",
            run_key: None,
        };
        assert!(start_script_run(&request("  ")).is_err());
        let huge = "x".repeat(MAX_SCRIPT_BYTES + 1);
        assert!(start_script_run(&request(&huge)).is_err());
        let writer = ScriptRunRequest {
            preset: Some(PermissionPreset::CodeWrite),
            allow_mutation: true,
            ..request("return 1;")
        };
        assert!(start_script_run(&writer)
            .unwrap_err()
            .contains("calling agent"));
        let ungranted_writer = ScriptRunRequest {
            preset: Some(PermissionPreset::CodeWrite),
            agent_id: Some("me"),
            ..request("return 1;")
        };
        assert!(start_script_run(&ungranted_writer)
            .unwrap_err()
            .contains("not allowed"));
    }

    #[test]
    fn the_mutation_allowance_is_part_of_the_script_identity() {
        let read_only = script_workflow("return 1;", Some("me"), None, false);
        let writable = script_workflow("return 1;", Some("me"), None, true);
        assert_ne!(read_only.id, writable.id);
        assert!(matches!(
            read_only.nodes[1].kind,
            super::super::NodeKind::Script {
                allow_mutation: Some(false),
                ..
            }
        ));
    }

    #[test]
    fn scripts_without_a_calling_agent_never_allow_mutation() {
        // With no locked agent, a per-call `code_write` could name any agent.
        let unlocked = script_workflow("return 1;", None, None, true);
        assert_eq!(
            unlocked.id,
            script_workflow("return 1;", None, None, false).id
        );
        assert!(matches!(
            unlocked.nodes[1].kind,
            super::super::NodeKind::Script {
                allow_mutation: Some(false),
                ..
            }
        ));
    }

    #[tokio::test]
    async fn after_a_limit_no_more_agents_start() {
        let limited = bridge(None);
        limited.state.lock().unwrap().limit_error = Some("usage limit reached".into());
        let reply = limited
            .run_batch(json!({ "calls": [{ "prompt": "a" }, { "prompt": "b" }] }))
            .await
            .unwrap();
        let results = reply["results"].as_array().unwrap();
        assert_eq!(results.len(), 2);
        assert!(results.iter().all(|r| r["ok"] == false));
        assert_eq!(limited.state.lock().unwrap().calls, 0);
    }
}
