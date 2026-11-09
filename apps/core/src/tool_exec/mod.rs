//! **Programmatic tool calling (PTC)** — Core host shim for the extracted
//! [`ryu_tool_exec`] sandbox primitive.
//!
//! The sandbox itself (#476, P4) — the in-process QuickJS-on-Wasmtime runtime,
//! the parked-execution store, the `CodeExecutor` backend enum, the
//! `SandboxToolInvoker`/`SandboxBridge` bridge, the Contract-4 schema defs — now
//! lives in the `ryu-tool-exec` crate (in-process, function-call hot path). This
//! module keeps only what belongs to a *different plane*, re-exports the crate's
//! surface so every `crate::tool_exec::*` consumer is unchanged, and installs the
//! crate's Core-side seams:
//!
//! - **Gateway governance bracket** (*what is allowed / measured*): [`execute_code`],
//!   [`resume_execution`]/[`resume_execution_opt`], and the governed `http`
//!   plugin-tool egress [`run_http_tool`] wrap the crate's `run_sandboxed` /
//!   `resume_parked` with the fail-closed budget/scan/audit calls
//!   (`/v1/exec/*`). This is Gateway-plane, so it stays in Core.
//! - **Core registry coupling**: [`resolve_agent_allowlist`] (the `AcpAgentRegistry`
//!   lookup) and the [`ToolCaller`] impl for `McpRegistry` below — the crate's
//!   narrow MCP seam (the `ToolEmbedder`/`tool_registry_host` precedent).
//! - **Security-scrubber seam**: `install_tool_exec_host_hooks` (called from
//!   `main.rs`) hands the crate Core's single-source `strip_template_tokens` +
//!   `scrub_child_env` so they never drift.

// Re-export the crate's full Contract-4 surface so every `crate::tool_exec::*`
// consumer is unchanged. Some items are part of the public surface but not used
// inside Core today (the original module carried the same allow).
#[allow(unused_imports)]
pub use ryu_tool_exec::{
    build_capability_adapter_program, build_inline_tool_program, detect_elicitation, is_available,
    run_sandboxed, run_sandboxed_warm, schema, tool_path_to_id, CodeExecutor, Elicitation,
    ExecOutcome, InvokeOutcome, RegistryToolInvoker, ResumeDecision, RunDataFlow, SandboxBridge,
    SandboxToolInvoker, ToolCaller, ToolInvocation, ToolInvokeResult, CAPABILITY_ADAPTER_CALL_PATH,
    CAPABILITY_ADAPTER_NAMED_PATH, DEFAULT_DEADLINE_SECS, DEFAULT_MEMORY_MB, GRANT_TOOL_EXECUTE,
    MAX_PARKED, MAX_PREVIEW_CHARS, PARKED_TTL,
};

#[cfg(feature = "js-sandbox")]
pub use ryu_tool_exec::BACKEND_JS;

// The pure JS eval-evaluator runner (`run_eval_js`/`EvalJsOutcome`) is consumed
// directly from `ryu_tool_exec` by the `ryu-eval-code` crate — Core no longer
// re-exports it here.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::Arc;

use crate::sidecar::mcp::McpRegistry;

pub(crate) mod bin_version;
mod command_allowlist;
mod command_args;
mod command_confinement;
mod command_tool;
pub(crate) mod egress_broker;
mod env_secrets;
mod http_request;
mod http_tool;
mod secret_headers;
mod workspace_paths;
pub use command_allowlist::*;
pub use command_args::*;
pub use command_tool::*;
pub(crate) use env_secrets::*;
pub use http_request::*;
pub use http_tool::*;
pub use secret_headers::*;
pub(crate) use workspace_paths::*;

/// Install the crate's Core-side security-scrubber seams. Called once from
/// `main.rs` at startup so the sandbox's final-value/log scrub and child-env
/// scrub stay single-source with Core's `untrusted::strip_template_tokens` /
/// `env_scrub::scrub_child_env` (no duplicated, drift-prone copies in the crate).
pub fn install_tool_exec_host_hooks() {
    ryu_tool_exec::install_host_hooks(ryu_tool_exec::HostHooks {
        scrub_child_env: |vars| crate::sidecar::env_scrub::scrub_child_env(vars, &[]),
        strip_template_tokens: crate::sidecar::untrusted::strip_template_tokens,
    });
}

/// Compile the JavaScript sandbox's guest on a background thread at startup.
/// On unix the compiled guest is cached under `<data dir>/cache/js-sandbox` so
/// later starts load it instead of compiling; on other platforms it is compiled
/// in memory once per process and leftover cache files there are deleted. Called
/// once from `main.rs`; the first hook or program then runs without waiting on
/// compilation.
pub fn warm_up_sandbox() {
    let cache_dir = crate::paths::cache_path("js-sandbox");
    ryu_tool_exec::warm_up(Some(cache_dir));
}

/// Core's implementation of the crate's narrow [`ToolCaller`] seam: routes a PTC
/// program's `tools.*` call through the same [`McpRegistry::call_tool_with_identity`]
/// path (and the same resolved allowlist) the chat tool loop uses. Keeping this
/// impl Core-side is what frees `ryu-tool-exec` of any `apps/core` dependency —
/// the `tool_registry_host`/`ToolEmbedder` precedent. `Arc<McpRegistry>` coerces
/// to `Arc<dyn ToolCaller>` at the invoker construction sites unchanged.
///
/// The call runs inside the program run's data-flow scope, so the registry's
/// dispatch can apply the exfiltration guard
/// ([`crate::approvals::exfiltration_guard`]) to it. No other ingress sets that
/// scope.
#[async_trait]
impl ToolCaller for McpRegistry {
    async fn call_tool_with_identity(
        &self,
        agent_id: Option<&str>,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
        data_flow: &Arc<RunDataFlow>,
    ) -> Result<Value, String> {
        // The inherent method wins path resolution over this trait method.
        crate::approvals::exfiltration_guard::scope_sandbox_run(
            Arc::clone(data_flow),
            McpRegistry::call_tool_with_identity(
                self,
                agent_id,
                tool_id,
                arguments,
                allowlist,
                user_id,
                profile_ids,
                session_id,
                host_conversation_id,
            ),
        )
        .await
        .map_err(|e| e.to_string())
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
    if agents.find_exact(agent_id).is_none() {
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
    let backend = CodeExecutor::default_backend().backend();

    // Pre-run gateway budget gate (fail-closed).
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit_with_attribution,
        ExecAuditAttribution, ExecBudgetOutcome, ExecScanOutcome,
    };
    let audit_attribution = ExecAuditAttribution {
        agent_id: Some(agent_id.to_owned()),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_exec").await {
        return ExecOutcome::error(format!("gateway denied execution: {reason}"));
    }

    // Pre-run command-approval scan gate (opt-in via RYU_EXEC_APPROVAL_MODE;
    // Allow with no network call when unset/off, so prior behavior is preserved).
    // The actual program is the command scanned so the gateway sees real content.
    match check_exec_scan(backend, &code, None, Some(agent_id)).await {
        ExecScanOutcome::Allow => {}
        ExecScanOutcome::Deny(reason) => {
            // Block + audit the denied exec via the same reporter the budget path
            // uses, then surface the error the way a budget deny is surfaced.
            report_exec_audit_with_attribution(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan denied: {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return ExecOutcome::error(format!("gateway denied execution: {reason}"));
        }
        ExecScanOutcome::ApprovalRequired(reason) => {
            // The approvals engine is fire-and-forget and `ExecOutcome` has no
            // pre-run pending-gate variant, so there is no in-process way to raise
            // an approval and block this synchronous, deadline-bounded exec on the
            // decision. Fail closed: treat approval-required as a deny, audit it,
            // and warn clearly.
            tracing::warn!(
                %reason,
                "exec scan requires approval but no in-process approval-await path exists; denying"
            );
            report_exec_audit_with_attribution(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan approval_required (denied): {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return ExecOutcome::error(format!("execution requires approval: {reason}"));
        }
    }

    let started = std::time::Instant::now();
    // The sandbox run itself is the crate's job (governance-free); this Core shim
    // brackets it with the budget/scan (above) + audit (below).
    let outcome = run_sandboxed(code, invoker, agent_id).await;

    let (exit_code, err) = match &outcome {
        ExecOutcome::Completed {
            is_error, error, ..
        } => (if *is_error { 1 } else { 0 }, error.clone()),
        // A pause is not a failure — it is a successful partial run awaiting input.
        ExecOutcome::Paused { .. } => (0, None),
    };
    report_exec_audit_with_attribution(
        backend,
        "tool_exec",
        started.elapsed().as_millis() as u64,
        exit_code,
        None,
        err,
        audit_attribution,
    )
    .await;

    outcome
}
/// Grant prefix authorizing an `http` tool's egress to a domain:
/// `tool:http-egress:<domain>` (or the wildcard `tool:http-egress:*`).
pub const GRANT_HTTP_EGRESS_PREFIX: &str = "tool:http-egress:";

/// Grant prefix authorizing a `command` tool to exec an allowlisted bin:
/// `tool:command:<bin>` (or the wildcard `tool:command:*`).
pub const GRANT_COMMAND_PREFIX: &str = "tool:command:";

/// Env var naming the command-tool bin allowlist: a comma/semicolon-separated
/// list of `name=/abs/path` entries. Empty/unset ⇒ every command tool is refused
/// (fail-closed — the allowlist IS the control).
pub const ENV_COMMAND_TOOL_ALLOWLIST: &str = "RYU_COMMAND_TOOL_ALLOWLIST";

/// Hard cap on bytes read from a command tool's stdout (bounded read; the rest is
/// drained and discarded so the child never blocks on a full pipe).
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 1024 * 1024; // 1 MiB

/// Max length of a single interpolated command argument value.
pub const MAX_COMMAND_ARG_LEN: usize = 8 * 1024;
const MAX_HTTP_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

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
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit_with_attribution,
        ExecAuditAttribution, ExecBudgetOutcome, ExecScanOutcome,
    };
    let audit_attribution = ExecAuditAttribution {
        agent_id: Some(agent_id.to_owned()),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };
    let backend = CodeExecutor::default_backend().backend();
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_exec").await {
        return Some(ExecOutcome::error(format!(
            "gateway denied resume: {reason}"
        )));
    }

    // Pre-resume command-approval scan gate (opt-in). LIMITATION: the resumed
    // program's source is parked inside the backend and not available at this
    // layer, so the scan can only carry the "tool_exec" label — the gateway
    // cannot inspect the actual resumed code here (unlike `execute_code`, which
    // passes the full program). The gate still enforces mode + fail-closed
    // reachability semantics on resume.
    match check_exec_scan(backend, "tool_exec", None, Some(agent_id)).await {
        ExecScanOutcome::Allow => {}
        ExecScanOutcome::Deny(reason) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan denied (resume): {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return Some(ExecOutcome::error(format!(
                "gateway denied resume: {reason}"
            )));
        }
        ExecScanOutcome::ApprovalRequired(reason) => {
            tracing::warn!(
                %reason,
                "exec scan requires approval on resume but no in-process approval-await path exists; denying"
            );
            report_exec_audit_with_attribution(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan approval_required (resume, denied): {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return Some(ExecOutcome::error(format!(
                "resume requires approval: {reason}"
            )));
        }
    }

    let started = std::time::Instant::now();
    // The parked-subprocess resume is the crate's job (governance-free); this Core
    // shim brackets it with the same budget/scan (above) + audit (below) as the
    // initial run so a resumed segment is metered too (security M1).
    let outcome = ryu_tool_exec::resume_parked(execution_id, agent_id, decision, content).await;

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
        report_exec_audit_with_attribution(
            backend,
            "tool_exec",
            started.elapsed().as_millis() as u64,
            exit_code,
            None,
            err,
            audit_attribution,
        )
        .await;
    }

    outcome
}

#[cfg(test)]
mod split_modules_tests;
#[cfg(test)]
mod tests;
