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
//! scope-review HIGH #1/#8). The [`CodeExecutor`] enum is the swappable registry
//! (AGENTS.md §"nothing hardcoded"): the second real backend, `securexec`, plugs
//! in behind its own feature flag and is selected by [`CodeExecutor::default_backend`]
//! with no code change here.
//!
//! **Only backends that can actually RUN are offered.** Two placeholder backends
//! (`rquickjs`, `just-bash`) used to sit in this enum; both were stubs whose
//! `execute` unconditionally returned "not yet wired" and whose `*_available()`
//! was a hardcoded `false`. They were unreachable in the default build (Deno wins
//! in `default_backend`), so they were not a user-facing lie — but a
//! `--no-default-features --features tool-exec-quickjs` build produced a Core
//! whose PTC path could never execute anything. A registry that lists a backend
//! that cannot run is not a swappable default, it is a trap; they are removed.
//! The seam they were supposed to demonstrate is the enum itself, which stays.
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

// The pure eval-function runner (P4). Reuses the same deny-all Deno sandbox as
// the PTC path but with NO tool bridge — a `(ctx) -> {score,pass?,detail?}`
// function. Consumed by [`crate::eval_code`]; gated on the Deno backend feature.
#[cfg(feature = "tool-exec-deno")]
pub(crate) use deno_backend::{run_eval_js, EvalJsOutcome};

#[cfg(feature = "tool-exec-securexec")]
mod securexec_backend;

// `detect_elicitation`/`tool_path_to_id` are re-exported as part of the public
// Contract 4 surface (P3 imports them); not used inside Core yet.
#[allow(unused_imports)]
pub use invoker::{detect_elicitation, tool_path_to_id, SandboxBridge, SandboxToolInvoker};

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

/// The Deno backend label (the default; used for audit).
pub const BACKEND_DENO: &str = "deno";

/// The secure-exec backend label (gated behind `tool-exec-securexec`).
#[cfg(feature = "tool-exec-securexec")]
pub const BACKEND_SECUREXEC: &str = securexec_backend::BACKEND_SECUREXEC;

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
///
/// This enum IS the swappable-backend registry. Every variant is a backend that
/// can really execute a program on a machine that satisfies its preconditions —
/// nothing is listed here that is guaranteed to fail.
pub enum CodeExecutor {
    /// Deno subprocess (the default): real process isolation, deny-by-default
    /// permissions, killable. Runnable when the `deno` binary is on `PATH`.
    #[cfg(feature = "tool-exec-deno")]
    Deno(deno_backend::DenoExecutor),
    /// secure-exec V8-isolate backend (gated behind `tool-exec-securexec`).
    /// Runnable on Linux with `bun` on `PATH` + `RYU_SECUREXEC_DIR` set.
    #[cfg(feature = "tool-exec-securexec")]
    SecureExec(securexec_backend::SecureExecExecutor),
    /// Always-present fallback so the type is non-empty even with no backend
    /// feature; it reports unavailability instead of running anything.
    Unavailable,
}

impl CodeExecutor {
    /// The backend label ("deno" | "securexec" | "none").
    pub fn backend(&self) -> &'static str {
        match self {
            #[cfg(feature = "tool-exec-deno")]
            CodeExecutor::Deno(_) => BACKEND_DENO,
            #[cfg(feature = "tool-exec-securexec")]
            CodeExecutor::SecureExec(_) => BACKEND_SECUREXEC,
            CodeExecutor::Unavailable => "none",
        }
    }

    /// Construct the default executor for this build. Deno wins whenever it is
    /// compiled in (the spec's v1 default); `securexec` is selected only when
    /// Deno is not. With no backend feature at all this is
    /// [`CodeExecutor::Unavailable`], which reports the miss instead of pretending.
    pub fn default_backend() -> Self {
        #[cfg(feature = "tool-exec-deno")]
        {
            CodeExecutor::Deno(deno_backend::DenoExecutor::new())
        }
        #[cfg(all(not(feature = "tool-exec-deno"), feature = "tool-exec-securexec"))]
        {
            CodeExecutor::SecureExec(securexec_backend::SecureExecExecutor::new())
        }
        #[cfg(not(any(feature = "tool-exec-deno", feature = "tool-exec-securexec")))]
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
    #[cfg(all(not(feature = "tool-exec-deno"), feature = "tool-exec-securexec"))]
    {
        securexec_backend::securexec_available()
    }
    #[cfg(not(any(feature = "tool-exec-deno", feature = "tool-exec-securexec")))]
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
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit, ExecBudgetOutcome, ExecScanOutcome,
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
            report_exec_audit(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan denied: {reason}")),
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
            report_exec_audit(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan approval_required (denied): {reason}")),
            )
            .await;
            return ExecOutcome::error(format!("execution requires approval: {reason}"));
        }
    }

    let started = std::time::Instant::now();
    let outcome = match executor {
        #[cfg(feature = "tool-exec-deno")]
        CodeExecutor::Deno(exec) => exec.execute(&code, invoker, agent_id).await,
        #[cfg(feature = "tool-exec-securexec")]
        CodeExecutor::SecureExec(exec) => exec.execute(&code, invoker, agent_id).await,
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

/// Run a JS `program` in the sandbox with a caller-supplied `invoker`, **without**
/// the PTC gateway exec-budget/audit framing. Used by the plugin turn-hook
/// runtime ([`crate::plugin_host`]): a hook is orchestration, and any side-model
/// call it makes is itself gateway-governed inside `call_side_model`, so the hook
/// run must not be double-budgeted or mislabeled as `tool_exec`.
///
/// Returns [`ExecOutcome::Completed`] (final value + logs) or
/// [`ExecOutcome::Paused`] (unused by hooks today; treated as a no-op by the
/// caller). When no backend is built / Deno is absent, returns an error outcome
/// so the caller can degrade gracefully (chat is never blocked).
pub async fn run_sandboxed(
    program: String,
    invoker: Arc<SandboxToolInvoker>,
    agent_id: &str,
) -> ExecOutcome {
    let executor = CodeExecutor::default_backend();
    match executor {
        #[cfg(feature = "tool-exec-deno")]
        CodeExecutor::Deno(exec) => exec.execute(&program, invoker, agent_id).await,
        #[cfg(feature = "tool-exec-securexec")]
        CodeExecutor::SecureExec(exec) => exec.execute(&program, invoker, agent_id).await,
        CodeExecutor::Unavailable => {
            ExecOutcome::error("no code-execution backend is built (enable feature tool-exec-deno)")
        }
    }
}

// ── Plugin tool backends (plugin-tools, M3) ──────────────────────────────────
//
// A plugin's `kind:"tool"` Runnable can ship NET-NEW behavior (not just alias an
// existing tool) via two swappable config backends — the "nothing hardcoded, the
// tool backend is a swappable config kind" seam:
//   - `inline_deno` runs the tool body in the SAME Deno sandbox as a turn hook,
//     with the SAME grant model (`host.*` gated by the plugin's grants);
//   - `http` proxies the call to a declared URL under Gateway egress governance.
// The dispatch that selects between them lives in `sidecar/mcp` (it owns the
// registry + the plugin grant set); this module owns the two execution shapes.

/// Grant a plugin must hold for an `inline_deno` tool to execute.
pub const GRANT_TOOL_EXECUTE: &str = "tool:execute";

/// Grant prefix authorizing an `http` tool's egress to a domain:
/// `tool:http-egress:<domain>` (or the wildcard `tool:http-egress:*`).
pub const GRANT_HTTP_EGRESS_PREFIX: &str = "tool:http-egress:";

/// Wrap a plugin tool's `inline_deno` body into a sandbox program.
///
/// Mirrors the turn-hook substrate (`crate::plugin_host::build_hook_program`) but
/// injects `input` (the call arguments) instead of `ctx`. The `host` facade is
/// identical, so the same [`crate::plugin_host::PluginHookBridge`] serves both:
/// `host.sideModel` / `host.runAgent` / `host.storage.*` / `host.log`, each gated
/// by the plugin's grants. `code` is the SDK-serialized body — it references
/// `input` + `host` and `return`s the tool result, which the sandbox reports as
/// the program's final value.
pub fn build_inline_tool_program(input: &Value, code: &str) -> String {
    let input_json = serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string());
    format!(
        r#"const input = {input};
const host = {{
  sideModel: (a) => tools.host.sideModel(a ?? {{}}),
  runAgent: (a) => tools.host.runAgent(a ?? {{}}),
  storage: {{
    get: (k, ns) => tools.host.storage_get({{ key: String(k), namespace: ns }}),
    set: (k, v, ns) => tools.host.storage_set({{ key: String(k), value: typeof v === "string" ? v : JSON.stringify(v), namespace: ns }}),
    delete: (k, ns) => tools.host.storage_delete({{ key: String(k), namespace: ns }}),
    keys: (ns) => tools.host.storage_keys({{ namespace: ns }}),
  }},
  log: (...a) => console.log(...a),
}};
{code}
"#,
        input = input_json,
        code = code,
    )
}

/// Extract the egress domain (host) from an `http` tool's URL, for the
/// `tool:http-egress:<domain>` grant check. `None` for a URL with no host.
pub fn http_egress_domain(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned))
}

/// True for a loopback / link-local / private / CGNAT / 0.0.0.0-8 IPv4 — the SSRF
/// sinks (cloud metadata `169.254.169.254`, `127.0.0.1`, internal LAN) a plugin
/// granted a *public* domain must never reach.
fn is_internal_v4(v4: &std::net::Ipv4Addr) -> bool {
    let o = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || o[0] == 0 // 0.0.0.0/8
        || (o[0] == 100 && (64..128).contains(&o[1])) // 100.64.0.0/10 CGNAT
}

fn is_internal_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_internal_v4(v4),
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || v6.to_ipv4_mapped().is_some_and(|v4| is_internal_v4(&v4))
        }
    }
}

/// SSRF guard for the `http` plugin tool: reject a `url` whose host is — or
/// resolves to — an internal address, so a grant for a *public* domain can't be
/// turned into a request to an internal service via DNS. Skipped only when the
/// granted host literal is itself internal (an explicit, install-validated intent
/// to reach `localhost`/a private host). Rebinding-resistant: rejects if ANY
/// resolved address is internal.
async fn http_ssrf_guard(url: &str, granted_host: &str) -> Result<(), String> {
    // Explicit grant for a literal internal host / localhost ⇒ deliberate, allow.
    if granted_host.eq_ignore_ascii_case("localhost") {
        return Ok(());
    }
    if let Ok(lit) = granted_host.parse::<std::net::IpAddr>() {
        if is_internal_ip(&lit) {
            return Ok(());
        }
    }
    let parsed =
        reqwest::Url::parse(url).map_err(|e| format!("http tool: could not parse url: {e}"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "http tool: url has no host".to_string())?
        .to_owned();
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return if is_internal_ip(&ip) {
            Err(format!("http egress to internal address '{ip}' is blocked"))
        } else {
            Ok(())
        };
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("http tool: dns resolve failed for '{host}': {e}"))?;
    for a in addrs {
        if is_internal_ip(&a.ip()) {
            return Err(format!(
                "http egress: host '{host}' resolves to internal address {} — blocked (SSRF guard)",
                a.ip()
            ));
        }
    }
    Ok(())
}

/// Proxy a plugin `http` tool call to `url`, Gateway-governed and egress-grant-gated.
///
/// Order matters. The **egress-grant check runs first** (deterministic — no
/// network, no gateway), so an ungranted domain is refused identically whether or
/// not the gateway is reachable. Then the SAME governance the PTC path uses gates
/// the call: a fail-closed budget check and the opt-in firewall/DLP scan, with a
/// post-call audit. Only then does Core make the outbound request.
///
/// `grants` is the owning plugin's grant set (resolved by the dispatcher from the
/// enabled manifest); it must contain `tool:http-egress:<domain>` (or the `*`
/// wildcard). This tool reaches an EXTERNAL service — it never reads local user
/// data — so it needs no ACL principal.
pub async fn run_http_tool(
    url: &str,
    method: &str,
    args: Value,
    grants: &std::collections::HashSet<String>,
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    // 1. Egress-grant check FIRST (deterministic refusal, before any I/O).
    let domain = http_egress_domain(url)
        .ok_or_else(|| format!("http tool: could not parse a host from url '{url}'"))?;
    let needed = format!("{GRANT_HTTP_EGRESS_PREFIX}{domain}");
    let wildcard = format!("{GRANT_HTTP_EGRESS_PREFIX}*");
    if !(grants.contains(&needed) || grants.contains(&wildcard)) {
        return Err(format!(
            "http egress to '{domain}' is not granted (needs '{needed}')"
        ));
    }

    // 1b. SSRF guard: the granted domain must not be — or resolve to — an internal
    //     address, unless it was explicitly granted as one. Blocks the metadata /
    //     loopback / LAN sinks a public-domain grant could otherwise reach via DNS.
    http_ssrf_guard(url, &domain).await?;

    // 2. Gateway governance: fail-closed budget + opt-in firewall/DLP scan.
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit, ExecBudgetOutcome, ExecScanOutcome,
    };
    let backend = "tool_http";
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_http").await {
        return Err(format!("gateway denied http egress: {reason}"));
    }
    let scan_content = format!("{method} {url}\n{args}");
    match check_exec_scan(backend, &scan_content, session_id, Some(agent_id)).await {
        ExecScanOutcome::Allow => {}
        ExecScanOutcome::Deny(reason) | ExecScanOutcome::ApprovalRequired(reason) => {
            report_exec_audit(
                backend,
                "tool_http",
                0,
                1,
                session_id.map(str::to_owned),
                Some(format!("scan denied: {reason}")),
            )
            .await;
            return Err(format!("gateway denied http egress: {reason}"));
        }
    }

    // 3. Perform the request. Body is the tool args as JSON for methods that carry
    //    one; GET/HEAD send none. Response is `{ status, body }` (JSON if parseable).
    let started = std::time::Instant::now();
    let m = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|_| format!("http tool: invalid method '{method}'"))?;
    // Redirects DISABLED: a 3xx is returned to the caller as-is. Following it would
    // re-issue the request to the `Location` host WITHOUT re-running the egress-grant
    // + SSRF checks above — the classic allowlist bypass (granted public domain →
    // 302 → 127.0.0.1 / 169.254.169.254). The guarded first hop is the only hop.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http tool: client build failed: {e}"))?;
    let mut req = client
        .request(m.clone(), url)
        .timeout(std::time::Duration::from_secs(30));
    if !matches!(m, reqwest::Method::GET | reqwest::Method::HEAD) {
        req = req.json(&args);
    }
    let (result, exit_code, audit_err) = match req.send().await {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            let body: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
            let exit = i32::from(status >= 400);
            (
                Ok(serde_json::json!({ "status": status, "body": body })),
                exit,
                None,
            )
        }
        Err(e) => (
            Err(format!("http tool request failed: {e}")),
            1,
            Some(e.to_string()),
        ),
    };
    report_exec_audit(
        backend,
        "tool_http",
        started.elapsed().as_millis() as u64,
        exit_code,
        session_id.map(str::to_owned),
        audit_err,
    )
    .await;
    result
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
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit, ExecBudgetOutcome, ExecScanOutcome,
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
            report_exec_audit(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan denied (resume): {reason}")),
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
            report_exec_audit(
                backend,
                "tool_exec",
                0,
                1,
                None,
                Some(format!("scan approval_required (resume, denied): {reason}")),
            )
            .await;
            return Some(ExecOutcome::error(format!(
                "resume requires approval: {reason}"
            )));
        }
    }

    let started = std::time::Instant::now();
    let outcome = {
        #[cfg(feature = "tool-exec-deno")]
        {
            deno_backend::resume_parked(&execution_id, agent_id, decision, content).await
        }
        #[cfg(all(not(feature = "tool-exec-deno"), feature = "tool-exec-securexec"))]
        {
            securexec_backend::resume_parked(&execution_id, agent_id, decision, content).await
        }
        #[cfg(not(any(feature = "tool-exec-deno", feature = "tool-exec-securexec")))]
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
        // These are process-global vars other modules' tests also mutate, so hold
        // the shared gateway-env lock across the whole body and restore on exit —
        // otherwise a parallel test can strip RYU_ALLOW_GATEWAY_FALLBACK during
        // the await and flip this into a fail-closed deny.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let prev_url = std::env::var("RYU_GATEWAY_URL").ok();
        let prev_fb = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
        std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
        std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
        let out = resume_execution(
            "exec_does_not_exist".into(),
            "ryu",
            "accept".into(),
            serde_json::json!({}),
        )
        .await;
        match prev_url {
            Some(v) => std::env::set_var("RYU_GATEWAY_URL", v),
            None => std::env::remove_var("RYU_GATEWAY_URL"),
        }
        match prev_fb {
            Some(v) => std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", v),
            None => std::env::remove_var("RYU_ALLOW_GATEWAY_FALLBACK"),
        }
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

    #[test]
    fn ssrf_guard_classifies_internal_addresses() {
        use std::net::IpAddr;
        for s in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.5",
            "172.16.9.9",
            "169.254.169.254", // cloud metadata
            "100.64.0.1",      // CGNAT
            "0.0.0.0",
            "::1",
            "fe80::1",
            "fc00::1",
            "::ffff:127.0.0.1", // v4-mapped loopback
        ] {
            assert!(
                is_internal_ip(&s.parse::<IpAddr>().unwrap()),
                "{s} must be classified internal"
            );
        }
        for s in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"] {
            assert!(
                !is_internal_ip(&s.parse::<IpAddr>().unwrap()),
                "{s} must be classified public"
            );
        }
    }

    #[tokio::test]
    async fn ssrf_guard_blocks_ip_literal_and_exempts_explicit_grant() {
        // A URL whose host is an internal IP literal is blocked when the grant was
        // for a public domain...
        assert!(
            http_ssrf_guard("http://169.254.169.254/latest/meta-data/", "example.com")
                .await
                .is_err()
        );
        // ...but allowed when the plugin explicitly holds a grant for that literal
        // internal host (deliberate, install-validated intent).
        assert!(
            http_ssrf_guard("http://127.0.0.1:9000/health", "127.0.0.1")
                .await
                .is_ok()
        );
        assert!(
            http_ssrf_guard("http://localhost:9000/health", "localhost")
                .await
                .is_ok()
        );
    }
}
