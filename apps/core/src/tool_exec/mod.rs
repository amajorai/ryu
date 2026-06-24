//! **Programmatic tool calling (PTC)** — a JS code-execution sandbox in Core
//! (#476, P4). The model emits one JavaScript program that fans out across many
//! tools via a `tools` proxy; only its final `return` value + console logs come
//! back. Intermediate tool results never re-enter the model — that is the
//! context-saving win over one-tool-call-per-turn.
//!
//! **Core vs Gateway:** *what runs* is Core (this module spawns the sandbox and
//! routes tool calls through [`McpRegistry`]). *What is allowed / measured* is
//! the Gateway: every execution posts `/v1/exec/budget/check` (pre, fail-closed)
//! and `/v1/exec/audit` (post). The per-agent **allowlist** travels unchanged —
//! a program cannot reach a tool the agent could not call in chat (no
//! escalation; `None`/unknown `agent_id` is rejected fail-closed).
//!
//! **Backend (scope-review HIGH #2/#3):** the v1 default is a **Deno
//! subprocess** — real process isolation, killable, deny-by-default
//! permissions, `Send` futures (so enum-dispatch, no `async-trait`/`dyn`, per
//! scope-review HIGH #1/#8). The in-process `rquickjs` backend is gated behind
//! the off-by-default `tool-exec-quickjs` feature and is **not** built for the
//! default surface. The [`CodeExecutor`] enum keeps the choice reversible.
//!
//! **Bounds (security HIGH, non-negotiable):** the sandbox has **no network and
//! no filesystem**; each run carries a wall-clock deadline, a memory cap, and a
//! max-output cap ([`MAX_PREVIEW_CHARS`]); a runaway is killed. Paused
//! executions (awaiting a Composio connect/resume) are held in a **bounded** map
//! (cap [`MAX_PARKED`], TTL [`PARKED_TTL`]) so suspended subprocesses cannot
//! accumulate without limit.

// P4 *produces* Contract 4 (`is_available`, `schema::{execute,resume}_tool_def`,
// `detect_elicitation`, `tool_path_to_id`, the `CodeExecutor` enum). The
// consumers are separate P-units: P2 surfaces the defs on the gateway plane and
// P3 wires `is_available`-gated `execute`/`resume` into the ACP bridge. Until
// those land, parts of this surface are reachable only from tests — by design,
// not dead code.
#![allow(dead_code)]

pub mod schema;

mod invoker;
mod parked;

#[cfg(feature = "tool-exec-deno")]
mod deno_backend;

#[cfg(feature = "tool-exec-quickjs")]
mod rquickjs_backend;

#[cfg(feature = "tool-exec-securexec")]
mod securexec_backend;

#[cfg(feature = "tool-exec-justbash")]
mod justbash_backend;

// `detect_elicitation`/`tool_path_to_id` are re-exported as part of the public
// Contract 4 surface (P3 imports them); not used inside Core yet.
#[allow(unused_imports)]
pub use invoker::{detect_elicitation, tool_path_to_id, SandboxToolInvoker};

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

/// Max bytes of program output (logs + final value, serialized) returned to the
/// model. Reused from the exec-sandbox cap so PTC output and shell-exec preview
/// share one ceiling (spec: "reuse `MAX_PREVIEW_CHARS = 30_000`").
pub const MAX_PREVIEW_CHARS: usize = 30_000;

/// Wall-clock ceiling for a single program. A runaway is killed at this bound.
pub const DEFAULT_DEADLINE_SECS: u64 = 30;

/// V8 old-space memory cap (MiB) handed to Deno via `--v8-flags`.
pub const DEFAULT_MEMORY_MB: u64 = 256;

/// Max number of simultaneously-parked (suspended, awaiting-resume) executions.
/// Each parked entry pins a real blocked subprocess, so this is a hard bound.
pub const MAX_PARKED: usize = 64;

/// How long a parked execution may wait for `resume` before it is evicted.
pub const PARKED_TTL: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// The backend label string ("deno" | "quickjs" | "wasmtime-qjs").
pub const BACKEND_DENO: &str = "deno";

/// The rquickjs backend label (gated behind `tool-exec-quickjs`).
#[cfg(feature = "tool-exec-quickjs")]
pub const BACKEND_QUICKJS: &str = "quickjs";

/// The secure-exec backend label (gated behind `tool-exec-securexec`).
#[cfg(feature = "tool-exec-securexec")]
pub const BACKEND_SECUREXEC: &str = securexec_backend::BACKEND_SECUREXEC;

/// The just-bash backend label (gated behind `tool-exec-justbash`).
#[cfg(feature = "tool-exec-justbash")]
pub const BACKEND_JUSTBASH: &str = justbash_backend::BACKEND_JUSTBASH;

/// A single tool call the sandbox program made (`tools.<server>.<tool>(args)`).
#[derive(Debug, Clone)]
pub struct ToolInvocation {
    pub path: String,
    pub args: Value,
}

/// The result of one tool call relayed back into the sandbox.
#[derive(Debug, Clone)]
pub struct ToolInvokeResult {
    pub value: Value,
    pub is_error: bool,
    pub error: Option<String>,
}

/// What an invoke produced: a normal result the program continues on, or a
/// suspend (a Composio connect/consent step) that pauses the whole program.
#[derive(Debug, Clone)]
pub enum InvokeOutcome {
    Result(ToolInvokeResult),
    Suspend(Elicitation),
}

/// A human-completable step that pauses an execution (P1 `__ryu_elicitation__`
/// envelope, B-7). Mirrors the Composio shape: `kind` ∈ `url|form|confirm`.
#[derive(Debug, Clone, Serialize)]
pub struct Elicitation {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_schema: Option<Value>,
}

/// The model's decision when resuming a paused execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeDecision {
    Accept,
    Decline,
    Cancel,
}

impl ResumeDecision {
    /// Parse the `resume` tool's `action` enum (`accept|decline|cancel`).
    pub fn parse(action: &str) -> Option<Self> {
        match action {
            "accept" => Some(ResumeDecision::Accept),
            "decline" => Some(ResumeDecision::Decline),
            "cancel" => Some(ResumeDecision::Cancel),
            _ => None,
        }
    }
}

/// The canonical terminal/suspended outcome, consumed verbatim by P2/P3
/// (Contract 4). Serializes flattened under a `status` tag — the wire shape the
/// `/api/tools/exec[/resume]` handlers return.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ExecOutcome {
    Completed {
        result: Option<Value>,
        logs: Vec<String>,
        is_error: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Paused {
        execution_id: String,
        message: String,
        elicitation: Elicitation,
    },
}

impl ExecOutcome {
    /// Build a hard-error completion (used when the backend is missing or the
    /// program could not even start).
    pub fn error(message: impl Into<String>) -> Self {
        ExecOutcome::Completed {
            result: None,
            logs: Vec::new(),
            is_error: true,
            error: Some(message.into()),
        }
    }
}

/// Heterogeneous code backends, closed-enum match-dispatched (no `dyn`/
/// `async-trait` on the default Deno-first path). `backend()` reports the label
/// for audit.
pub enum CodeExecutor {
    #[cfg(feature = "tool-exec-deno")]
    Deno(deno_backend::DenoExecutor),
    /// In-process rquickjs backend (gated behind `tool-exec-quickjs`; a stub
    /// until the native build + Windows smoke probe land — see
    /// [`rquickjs_backend`]).
    #[cfg(feature = "tool-exec-quickjs")]
    Quickjs(rquickjs_backend::QuickjsExecutor),
    /// secure-exec V8-isolate backend (gated behind `tool-exec-securexec`; a stub
    /// until the Node/Bun runtime + tool-bridge harness land).
    #[cfg(feature = "tool-exec-securexec")]
    SecureExec(securexec_backend::SecureExecExecutor),
    /// just-bash in-memory bash backend (gated behind `tool-exec-justbash`; a
    /// stub until the Node runtime + tool bridge land).
    #[cfg(feature = "tool-exec-justbash")]
    JustBash(justbash_backend::JustBashExecutor),
    /// Always-present fallback so the type is non-empty even with no backend
    /// feature; it reports unavailability instead of running anything.
    Unavailable,
}

impl CodeExecutor {
    /// The backend label ("deno" | "quickjs" | "wasmtime-qjs" | "none").
    pub fn backend(&self) -> &'static str {
        match self {
            #[cfg(feature = "tool-exec-deno")]
            CodeExecutor::Deno(_) => BACKEND_DENO,
            #[cfg(feature = "tool-exec-quickjs")]
            CodeExecutor::Quickjs(_) => BACKEND_QUICKJS,
            #[cfg(feature = "tool-exec-securexec")]
            CodeExecutor::SecureExec(_) => BACKEND_SECUREXEC,
            #[cfg(feature = "tool-exec-justbash")]
            CodeExecutor::JustBash(_) => BACKEND_JUSTBASH,
            CodeExecutor::Unavailable => "none",
        }
    }

    /// Construct the default executor for this build. Deno wins when both
    /// backend features are on (it is the spec's v1 default); rquickjs is only
    /// selected when Deno is not compiled in.
    pub fn default_backend() -> Self {
        #[cfg(feature = "tool-exec-deno")]
        {
            CodeExecutor::Deno(deno_backend::DenoExecutor::new())
        }
        #[cfg(all(not(feature = "tool-exec-deno"), feature = "tool-exec-quickjs"))]
        {
            CodeExecutor::Quickjs(rquickjs_backend::QuickjsExecutor::new())
        }
        #[cfg(all(
            not(feature = "tool-exec-deno"),
            not(feature = "tool-exec-quickjs"),
            feature = "tool-exec-securexec"
        ))]
        {
            CodeExecutor::SecureExec(securexec_backend::SecureExecExecutor::new())
        }
        #[cfg(all(
            not(feature = "tool-exec-deno"),
            not(feature = "tool-exec-quickjs"),
            not(feature = "tool-exec-securexec"),
            feature = "tool-exec-justbash"
        ))]
        {
            CodeExecutor::JustBash(justbash_backend::JustBashExecutor::new())
        }
        #[cfg(not(any(
            feature = "tool-exec-deno",
            feature = "tool-exec-quickjs",
            feature = "tool-exec-securexec",
            feature = "tool-exec-justbash"
        )))]
        {
            CodeExecutor::Unavailable
        }
    }
}

/// Whether a code-execution backend is actually runnable on this machine. P3
/// gates wiring the `execute`/`resume` defs into the bridge on this. For Deno
/// that means the binary is on `PATH`; with no backend feature it is always
/// `false`.
pub fn is_available() -> bool {
    #[cfg(feature = "tool-exec-deno")]
    {
        deno_backend::deno_on_path()
    }
    #[cfg(all(not(feature = "tool-exec-deno"), feature = "tool-exec-quickjs"))]
    {
        rquickjs_backend::quickjs_available()
    }
    #[cfg(all(
        not(feature = "tool-exec-deno"),
        not(feature = "tool-exec-quickjs"),
        feature = "tool-exec-securexec"
    ))]
    {
        securexec_backend::securexec_available()
    }
    #[cfg(all(
        not(feature = "tool-exec-deno"),
        not(feature = "tool-exec-quickjs"),
        not(feature = "tool-exec-securexec"),
        feature = "tool-exec-justbash"
    ))]
    {
        justbash_backend::justbash_available()
    }
    #[cfg(not(any(
        feature = "tool-exec-deno",
        feature = "tool-exec-quickjs",
        feature = "tool-exec-securexec",
        feature = "tool-exec-justbash"
    )))]
    {
        false
    }
}

/// Resolve an agent's tool allowlist, rejecting an absent or unknown agent
/// (fail-closed, mirrors `call_mcp_tool`). `Ok(None)` means "no restriction"
/// (the flagship `ryu` default — policy (a)); `Ok(Some(list))` restricts; `Err`
/// means the agent itself is invalid and the call must be refused.
pub fn resolve_agent_allowlist(
    agents: &crate::sidecar::adapters::acp::AcpAgentRegistry,
    agent_id: Option<&str>,
) -> Result<Option<Vec<String>>, String> {
    let Some(agent_id) = agent_id.filter(|s| !s.is_empty()) else {
        return Err("agent_id is required to execute a program".to_owned());
    };
    if agents.find_by_prefix(agent_id).is_none() {
        return Err(format!("unknown agent '{agent_id}'"));
    }
    Ok(agents.allowlist_for(agent_id))
}

/// Run a JS program in the sandbox. `invoker` carries the resolved allowlist and
/// routes `tools.*` calls through the registry. Emits gateway budget (pre) +
/// audit (post) so PTC execution is measured.
///
/// Returns [`ExecOutcome::Completed`] (with the final value + logs) or
/// [`ExecOutcome::Paused`] (a Composio connect step the user must complete,
/// continued via [`resume_execution`]).
pub async fn execute_code(
    code: String,
    invoker: Arc<SandboxToolInvoker>,
    agent_id: &str,
) -> ExecOutcome {
    let executor = CodeExecutor::default_backend();
    let backend = executor.backend();

    // Pre-run gateway budget gate (fail-closed).
    use crate::sidecar::gateway::{check_exec_budget, report_exec_audit, ExecBudgetOutcome};
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_exec").await {
        return ExecOutcome::error(format!("gateway denied execution: {reason}"));
    }

    let started = std::time::Instant::now();
    let outcome = match executor {
        #[cfg(feature = "tool-exec-deno")]
        CodeExecutor::Deno(exec) => exec.execute(&code, invoker, agent_id).await,
        #[cfg(feature = "tool-exec-quickjs")]
        CodeExecutor::Quickjs(exec) => exec.execute(&code, invoker, agent_id).await,
        #[cfg(feature = "tool-exec-securexec")]
        CodeExecutor::SecureExec(exec) => exec.execute(&code, invoker, agent_id).await,
        #[cfg(feature = "tool-exec-justbash")]
        CodeExecutor::JustBash(exec) => exec.execute(&code, invoker, agent_id).await,
        CodeExecutor::Unavailable => {
            ExecOutcome::error("no code-execution backend is built (enable feature tool-exec-deno)")
        }
    };

    let (exit_code, err) = match &outcome {
        ExecOutcome::Completed {
            is_error, error, ..
        } => (if *is_error { 1 } else { 0 }, error.clone()),
        // A pause is not a failure — it is a successful partial run awaiting input.
        ExecOutcome::Paused { .. } => (0, None),
    };
    report_exec_audit(
        backend,
        "tool_exec",
        started.elapsed().as_millis() as u64,
        exit_code,
        None,
        err,
    )
    .await;

    outcome
}

/// Continue a paused execution after the user completed the auth/consent step
/// (Contract 4 free-fn shim, byte-identical signature: `action: String` parsed
/// to a [`ResumeDecision`], returning a flat [`ExecOutcome`]). A bad `action` or
/// an unknown `execution_id` maps to a terminal error completion. Part 2's route
/// can call [`resume_execution_opt`] directly when it wants to distinguish an
/// unknown id (`None` → `404 execution_not_found`).
pub async fn resume_execution(
    execution_id: String,
    agent_id: &str,
    action: String,
    content: Value,
) -> ExecOutcome {
    let Some(decision) = ResumeDecision::parse(&action) else {
        return ExecOutcome::error(format!(
            "invalid resume action '{action}' (expected accept|decline|cancel)"
        ));
    };
    resume_execution_opt(execution_id, agent_id, decision, content)
        .await
        .unwrap_or_else(|| ExecOutcome::error("execution_not_found"))
}

/// Resume a parked execution, returning `None` for an unknown id (or an
/// ownership mismatch, security M2) so the route can map it to `404
/// execution_not_found`. The typed-[`ResumeDecision`] form used internally and
/// by Part 2's handler.
///
/// The resumed compute segment runs further `tools.*` calls, so it is metered
/// the same way as the initial run (security M1): a fail-closed gateway budget
/// gate (pre) and an audit report (post) bracket the resume — without this a
/// program could pause then resume to run an unmetered, unaudited second
/// segment.
pub async fn resume_execution_opt(
    execution_id: String,
    agent_id: &str,
    decision: ResumeDecision,
    content: Value,
) -> Option<ExecOutcome> {
    // Pre-resume gateway budget gate (fail-closed), mirroring `execute_code`.
    use crate::sidecar::gateway::{check_exec_budget, report_exec_audit, ExecBudgetOutcome};
    let backend = CodeExecutor::default_backend().backend();
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_exec").await {
        return Some(ExecOutcome::error(format!(
            "gateway denied resume: {reason}"
        )));
    }

    let started = std::time::Instant::now();
    let outcome = {
        #[cfg(feature = "tool-exec-deno")]
        {
            deno_backend::resume_parked(&execution_id, agent_id, decision, content).await
        }
        #[cfg(all(not(feature = "tool-exec-deno"), feature = "tool-exec-quickjs"))]
        {
            rquickjs_backend::resume_parked(&execution_id, agent_id, decision, content).await
        }
        #[cfg(all(
            not(feature = "tool-exec-deno"),
            not(feature = "tool-exec-quickjs"),
            feature = "tool-exec-securexec"
        ))]
        {
            securexec_backend::resume_parked(&execution_id, agent_id, decision, content).await
        }
        #[cfg(all(
            not(feature = "tool-exec-deno"),
            not(feature = "tool-exec-quickjs"),
            not(feature = "tool-exec-securexec"),
            feature = "tool-exec-justbash"
        ))]
        {
            justbash_backend::resume_parked(&execution_id, agent_id, decision, content).await
        }
        #[cfg(not(any(
            feature = "tool-exec-deno",
            feature = "tool-exec-quickjs",
            feature = "tool-exec-securexec",
            feature = "tool-exec-justbash"
        )))]
        {
            let _ = (&execution_id, agent_id, decision, content);
            None
        }
    };

    // Audit the resumed segment (post) when it actually ran. An unknown id /
    // ownership mismatch (`None`) never resumed anything, so there is nothing to
    // meter — skip the audit so a 404 is not recorded as an execution.
    if let Some(ref oc) = outcome {
        let (exit_code, err) = match oc {
            ExecOutcome::Completed {
                is_error, error, ..
            } => (if *is_error { 1 } else { 0 }, error.clone()),
            ExecOutcome::Paused { .. } => (0, None),
        };
        report_exec_audit(
            backend,
            "tool_exec",
            started.elapsed().as_millis() as u64,
            exit_code,
            None,
            err,
        )
        .await;
    }

    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sidecar::adapters::acp::AcpAgentRegistry;

    #[test]
    fn resume_decision_parses_enum() {
        assert_eq!(
            ResumeDecision::parse("accept"),
            Some(ResumeDecision::Accept)
        );
        assert_eq!(
            ResumeDecision::parse("decline"),
            Some(ResumeDecision::Decline)
        );
        assert_eq!(
            ResumeDecision::parse("cancel"),
            Some(ResumeDecision::Cancel)
        );
        assert_eq!(ResumeDecision::parse("bogus"), None);
        assert_eq!(ResumeDecision::parse(""), None);
    }

    #[test]
    fn exec_outcome_completed_serializes_flat() {
        let out = ExecOutcome::Completed {
            result: Some(serde_json::json!(42)),
            logs: vec!["hi".into()],
            is_error: false,
            error: None,
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["status"], "completed");
        assert_eq!(v["result"], 42);
        assert_eq!(v["logs"][0], "hi");
        assert_eq!(v["is_error"], false);
        // `error: None` is skipped.
        assert!(v.get("error").is_none());
    }

    #[test]
    fn exec_outcome_paused_serializes_flat() {
        let out = ExecOutcome::Paused {
            execution_id: "exec_1".into(),
            message: "connect github".into(),
            elicitation: Elicitation {
                kind: "url".into(),
                message: "connect github".into(),
                url: Some("https://x".into()),
                requested_schema: None,
            },
        };
        let v = serde_json::to_value(&out).unwrap();
        assert_eq!(v["status"], "paused");
        assert_eq!(v["execution_id"], "exec_1");
        assert_eq!(v["elicitation"]["kind"], "url");
        assert_eq!(v["elicitation"]["url"], "https://x");
        // requested_schema is skipped when None.
        assert!(v["elicitation"].get("requested_schema").is_none());
    }

    #[tokio::test]
    async fn resume_execution_rejects_bad_action() {
        // The Contract-4 shim parses `action: String`; a bad action is a
        // terminal error completion (not a panic, not a silent success).
        let out = resume_execution(
            "exec_x".into(),
            "ryu",
            "bogus".into(),
            serde_json::json!({}),
        )
        .await;
        match out {
            ExecOutcome::Completed {
                is_error, error, ..
            } => {
                assert!(is_error);
                assert!(error.unwrap_or_default().contains("invalid resume action"));
            }
            ExecOutcome::Paused { .. } => panic!("expected error completion"),
        }
    }

    #[tokio::test]
    async fn resume_execution_unknown_id_is_error_completion() {
        // A valid action but unknown id → the shim maps None → execution_not_found.
        // The resume now runs a fail-closed gateway budget pre-gate (security M1).
        // To exercise the id-lookup path (not a budget deny), point the gate at a
        // guaranteed-unreachable gateway and enable the unreachable→allow
        // fallback (deterministic regardless of any gateway running locally); the
        // gate's deny behavior is covered by the gateway module's own tests.
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
        let out = resume_execution(
            "exec_does_not_exist".into(),
            "ryu",
            "accept".into(),
            serde_json::json!({}),
        )
        .await;
        std::env::remove_var("RYU_GATEWAY_URL");
        std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK");
        match out {
            ExecOutcome::Completed {
                is_error, error, ..
            } => {
                assert!(is_error);
                assert_eq!(error.as_deref(), Some("execution_not_found"));
            }
            ExecOutcome::Paused { .. } => panic!("expected error completion"),
        }
    }

    #[test]
    fn allowlist_rejects_missing_agent_id() {
        let reg = AcpAgentRegistry::new();
        assert!(resolve_agent_allowlist(&reg, None).is_err());
        assert!(resolve_agent_allowlist(&reg, Some("")).is_err());
    }

    #[test]
    fn allowlist_rejects_unknown_agent() {
        let reg = AcpAgentRegistry::new();
        let err = resolve_agent_allowlist(&reg, Some("does-not-exist-xyz")).unwrap_err();
        assert!(err.contains("unknown agent"));
    }

    #[test]
    fn allowlist_accepts_flagship_ryu_with_no_restriction() {
        // Ensure no env allowlist leaks in from the environment.
        std::env::remove_var("RYU_MCP_ALLOWLIST");
        std::env::remove_var("RYU_MCP_ALLOWLIST_RYU");
        let reg = AcpAgentRegistry::new();
        // Policy (a): the flagship default agent has no restriction (None) so
        // tool_search → execute does not 403 the demo.
        let resolved = resolve_agent_allowlist(&reg, Some("ryu")).expect("ryu is a known agent");
        assert!(
            resolved.is_none(),
            "flagship ryu must default to no restriction"
        );
    }
}
