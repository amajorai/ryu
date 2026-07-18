//! **Programmatic tool calling (PTC)** — Core host shim for the extracted
//! [`ryu_tool_exec`] sandbox primitive.
//!
//! The sandbox itself (#476, P4) — the Deno / secure-exec subprocess machinery,
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
    build_inline_tool_program, detect_elicitation, is_available, run_sandboxed, schema,
    tool_path_to_id, CodeExecutor, Elicitation, ExecOutcome, InvokeOutcome, RegistryToolInvoker,
    ResumeDecision, SandboxBridge, SandboxToolInvoker, ToolCaller, ToolInvocation, ToolInvokeResult,
    BACKEND_DENO, DEFAULT_DEADLINE_SECS, DEFAULT_MEMORY_MB, GRANT_TOOL_EXECUTE, MAX_PARKED,
    MAX_PREVIEW_CHARS, PARKED_TTL,
};

#[cfg(feature = "tool-exec-securexec")]
pub use ryu_tool_exec::BACKEND_SECUREXEC;

// The pure JS eval-evaluator runner (`run_eval_js`/`EvalJsOutcome`) is consumed
// directly from `ryu_tool_exec` by the `ryu-eval-code` crate — Core no longer
// re-exports it here.

use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

use crate::sidecar::mcp::McpRegistry;

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

/// Core's implementation of the crate's narrow [`ToolCaller`] seam: routes a PTC
/// program's `tools.*` call through the same [`McpRegistry::call_tool_with_identity`]
/// path (and the same resolved allowlist) the chat tool loop uses. Keeping this
/// impl Core-side is what frees `ryu-tool-exec` of any `apps/core` dependency —
/// the `tool_registry_host`/`ToolEmbedder` precedent. `Arc<McpRegistry>` coerces
/// to `Arc<dyn ToolCaller>` at the invoker construction sites unchanged.
#[async_trait]
impl ToolCaller for McpRegistry {
    async fn call_tool_with_identity(
        &self,
        tool_id: &str,
        arguments: Value,
        allowlist: Option<&[String]>,
        user_id: Option<&str>,
        profile_ids: &[String],
        session_id: Option<String>,
        host_conversation_id: Option<&str>,
    ) -> Result<Value, String> {
        // The inherent method wins path resolution over this trait method.
        McpRegistry::call_tool_with_identity(
            self,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
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
    let backend = CodeExecutor::default_backend().backend();

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
/// Grant prefix authorizing an `http` tool's egress to a domain:
/// `tool:http-egress:<domain>` (or the wildcard `tool:http-egress:*`).
pub const GRANT_HTTP_EGRESS_PREFIX: &str = "tool:http-egress:";

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
