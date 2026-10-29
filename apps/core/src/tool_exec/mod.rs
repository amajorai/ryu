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
pub(crate) mod egress_broker;

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

async fn read_http_response_text_capped(mut response: reqwest::Response) -> Result<String, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_HTTP_RESPONSE_BYTES as u64)
    {
        return Err(format!(
            "http tool response exceeds {MAX_HTTP_RESPONSE_BYTES} bytes"
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("http tool response read failed: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_HTTP_RESPONSE_BYTES {
            return Err(format!(
                "http tool response exceeds {MAX_HTTP_RESPONSE_BYTES} bytes"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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
    ryu_egress::is_blocked_ip(std::net::IpAddr::V4(*v4))
}

fn is_internal_ip(ip: &std::net::IpAddr) -> bool {
    ryu_egress::is_blocked_ip(*ip)
}

/// SSRF guard for the `http` plugin tool: reject a `url` whose host is — or
/// resolves to — an internal address, so a grant for a *public* domain can't be
/// turned into a request to an internal service via DNS. Skipped only when the
/// granted host literal is itself internal (an explicit, install-validated intent
/// to reach `localhost`/a private host). Rebinding-resistant: rejects if ANY
/// resolved address is internal.
/// Screen a URL against SSRF before egress. On success returns the exact
/// addresses the request MUST be pinned to (`Some((host, addrs))`), or `None`
/// when no pinning is needed (a deliberate internal/localhost grant, or a
/// literal-IP URL host — neither involves a DNS lookup the attacker can race).
///
/// The `Some` case is load-bearing: the caller MUST build the reqwest client
/// with `.resolve_to_addrs(&host, &addrs)`. Otherwise reqwest re-resolves DNS
/// independently at `send()`, and an attacker who controls the granted domain's
/// DNS can answer THIS guard's lookup with a public IP (passes screening) and
/// reqwest's lookup, milliseconds later with TTL 0, with an internal one
/// (169.254.169.254 metadata, 127.0.0.1, RFC1918) — a TOCTOU/DNS-rebinding
/// bypass that leaks the response body to the caller. Pinning makes the check
/// and the connect use one shared resolution, closing the window.
async fn http_ssrf_guard(
    url: &str,
    granted_host: &str,
) -> Result<Option<(String, Vec<std::net::SocketAddr>)>, String> {
    // Explicit grant for a literal internal host / localhost ⇒ deliberate, allow.
    if granted_host.eq_ignore_ascii_case("localhost") {
        return Ok(None);
    }
    if let Ok(lit) = granted_host.parse::<std::net::IpAddr>() {
        if is_internal_ip(&lit) {
            return Ok(None);
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
            // Literal public IP in the URL: no DNS lookup happens, so there is no
            // rebinding window to pin against.
            Ok(None)
        };
    }
    let port = parsed.port_or_known_default().unwrap_or(443);
    let resolved: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("http tool: dns resolve failed for '{host}': {e}"))?
        .collect();
    if resolved.is_empty() {
        return Err(format!("http tool: host '{host}' did not resolve"));
    }
    for a in &resolved {
        if is_internal_ip(&a.ip()) {
            return Err(format!(
                "http egress: host '{host}' resolves to internal address {} — blocked (SSRF guard)",
                a.ip()
            ));
        }
    }
    Ok(Some((host, resolved)))
}

/// Deep-merge `overlay` ONTO `base` in place: two objects merge key-by-key
/// recursively; for any other type pairing (scalar, array, or a type mismatch)
/// `overlay` REPLACES `base`. Absent keys in `overlay` keep `base`'s value.
///
/// This is the `body_defaults` seam: seeding `base` with the manifest defaults and
/// overlaying the model's body makes the MODEL win on every collision while nested
/// default sub-objects (exa's `contents:{text:true}`) survive when the model omits
/// them. Pure + network-free so it is unit-testable in isolation.
fn deep_merge_json(base: &mut Value, overlay: &Value) {
    match (base, overlay) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, ov) in o {
                deep_merge_json(b.entry(k.clone()).or_insert(Value::Null), ov);
            }
        }
        (b, o) => *b = o.clone(),
    }
}

/// A scalar tool-arg rendered for a URL (path segment or query value). Objects
/// and arrays have no unambiguous URL rendering, so they stay in the JSON body.
fn scalar_to_string(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// The `{name}` path-parameter placeholders in a URL template, in order. A plain
/// scan (no regex dep); names containing `/` are ignored so a stray brace in a
/// path can't swallow a segment.
fn url_placeholders(url: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = url;
    while let Some(open) = rest.find('{') {
        let after = &rest[open + 1..];
        if let Some(close) = after.find('}') {
            let name = &after[..close];
            if !name.is_empty() && !name.contains('/') {
                out.push(name.to_string());
            }
            rest = &after[close + 1..];
        } else {
            break;
        }
    }
    out
}

/// Lower REST-shaped tool args onto a request: fill every `{name}` placeholder in
/// the URL from (and consume) a matching arg, then send the rest as query params
/// for body-less methods (GET/HEAD) or as the JSON body otherwise. Non-object
/// args keep the legacy behavior (the whole value is the body). Returns an error
/// if a required path placeholder has no matching arg. This is what lets a single
/// `http` tool express a real REST operation (`GET /repos/{owner}/{repo}/issues`)
/// instead of only a fixed-URL POST.
type RestRequest = (String, Vec<(String, String)>, Value, Vec<(String, String)>);

fn build_rest_request(
    url: &str,
    args: &Value,
    bodyless: bool,
    header_params: &[String],
    resolved_secret_headers: &[(String, String)],
) -> Result<RestRequest, String> {
    let Some(obj) = args.as_object() else {
        // Scalar/array args: no partitioning. Legacy fixed-URL behavior, but a
        // resolved secret header still rides (it never came from `args`).
        return Ok((
            url.to_string(),
            Vec::new(),
            args.clone(),
            resolved_secret_headers.to_vec(),
        ));
    };
    let mut remaining = obj.clone();
    // 0. Headers first: pull the declared header args out before path/query/body
    //    partitioning (auth token + OpenAPI `in: header` params).
    let mut headers: Vec<(String, String)> = Vec::new();
    for name in header_params {
        if let Some(rendered) = remaining.remove(name).as_ref().and_then(scalar_to_string) {
            headers.push((name.clone(), rendered));
        }
    }
    // 0b. Pre-resolved SECRET headers (server-side sourced from env/vault). These
    //     never touch `remaining` (the model-visible args map), so they never
    //     appear in the path/query/body and never in the input schema — the whole
    //     point of the secret-header seam. Pushed onto the same header vec.
    for (name, value) in resolved_secret_headers {
        headers.push((name.clone(), value.clone()));
    }
    let mut final_url = url.to_string();
    let mut missing: Vec<String> = Vec::new();
    for name in url_placeholders(url) {
        match remaining.remove(&name).as_ref().and_then(scalar_to_string) {
            Some(value) => {
                let encoded = urlencoding::encode(&value);
                final_url = final_url.replace(&format!("{{{name}}}"), &encoded);
            }
            None => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Err(format!(
            "http tool: missing path parameter(s): {}",
            missing.join(", ")
        ));
    }
    if bodyless {
        let mut pairs = Vec::new();
        for (key, value) in &remaining {
            if let Some(rendered) = scalar_to_string(value) {
                pairs.push((key.clone(), rendered));
            }
        }
        Ok((final_url, pairs, Value::Null, headers))
    } else {
        Ok((final_url, Vec::new(), Value::Object(remaining), headers))
    }
}

/// The soft-unavailable envelope a `fail_open` http tool returns instead of an
/// `Err`, mirroring the deleted exa provider's `unavailable()` shape so a downstream
/// consumer's `{available:false,…}` handling (quest evidence gathering / usage_api) is reused.
fn http_unavailable(reason: impl Into<String>) -> Value {
    serde_json::json!({
        "available": false,
        "reason": reason.into(),
        "hint": "The endpoint is unreachable or rejected the request; check the key/host and retry.",
    })
}

/// Pure branching of an http send outcome into the caller-visible result plus the
/// AUDIT tuple, decoupled so `fail_open` never blinds the audit. Network-free and
/// unit-testable. Returns `(result, audit_exit_code, audit_err)`.
///
/// - `fail_open=false` (DEFAULT, byte-identical to today): transport err → `Err`;
///   any response → `Ok({status,body})`.
/// - `fail_open=true`: transport err → `Ok(available:false)` (audit exit 1);
///   status 401|403 → `Ok(available:false)` (audit exit 1); every other status
///   still → `Ok({status,body})` so meaningful data reaches the agent.
/// - `unwrap_body=true`: a 2xx response returns `body_or_text` VERBATIM (no
///   `{status,body}` envelope) so a tool can surface the raw upstream JSON. A
///   non-2xx response, and a `fail_open` 401/403, keep their envelopes — only a
///   success is unwrapped. `false` = today's behavior (every response wraps).
///
/// The audit exit is INDEPENDENT of the caller-visible `Result`: a converted
/// transport/401 outcome still audits exit 1 + the real error so outages and auth
/// failures never vanish from metrics.
fn finalize_http_result(
    fail_open: bool,
    unwrap_body: bool,
    status: Option<u16>,
    body_or_text: Value,
    transport_err: Option<String>,
) -> (Result<Value, String>, i32, Option<String>) {
    finalize_http_result_with_secrets(
        fail_open,
        unwrap_body,
        status,
        body_or_text,
        transport_err,
        &[],
    )
}

fn finalize_http_result_with_secrets(
    fail_open: bool,
    unwrap_body: bool,
    status: Option<u16>,
    body_or_text: Value,
    transport_err: Option<String>,
    secret_values: &[String],
) -> (Result<Value, String>, i32, Option<String>) {
    let body_or_text = redact_secret_values(body_or_text, secret_values);
    match (status, transport_err) {
        // A response arrived.
        (Some(status), _) => {
            let audit_exit = i32::from(status >= 400);
            if fail_open && (status == 401 || status == 403) {
                (
                    Ok(http_unavailable(format!("endpoint returned HTTP {status}"))),
                    audit_exit,
                    Some(format!("http {status}")),
                )
            } else if unwrap_body && (200..300).contains(&status) {
                // Success + unwrap: the parsed upstream body VERBATIM, no envelope.
                (Ok(body_or_text), audit_exit, None)
            } else {
                (
                    Ok(serde_json::json!({ "status": status, "body": body_or_text })),
                    audit_exit,
                    None,
                )
            }
        }
        // A transport failure (no response).
        (None, Some(err)) => {
            if fail_open {
                (
                    Ok(http_unavailable(format!("endpoint not reachable: {err}"))),
                    1,
                    Some(err),
                )
            } else {
                (
                    Err(format!("http tool request failed: {err}")),
                    1,
                    Some(err),
                )
            }
        }
        // Neither a status nor an error should not happen; treat as a transport
        // failure defensively.
        (None, None) => (
            Err("http tool request failed: no response".to_owned()),
            1,
            Some("no response".to_owned()),
        ),
    }
}

fn redact_secret_values(mut value: Value, secret_values: &[String]) -> Value {
    fn visit(value: &mut Value, secret_values: &[String]) {
        match value {
            Value::String(text) => {
                for secret in secret_values {
                    if !secret.is_empty() {
                        *text = text.replace(secret, "[REDACTED]");
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    visit(item, secret_values);
                }
            }
            Value::Object(fields) => {
                for item in fields.values_mut() {
                    visit(item, secret_values);
                }
            }
            Value::Null | Value::Bool(_) | Value::Number(_) => {}
        }
    }
    visit(&mut value, secret_values);
    value
}

/// One `env:`/`vault:` token's resolution within a `secret_headers` template.
///
/// `PartialEq`/`Debug` exist for the resolver's tests only — a real secret is
/// never logged, and nothing on a production path formats this type.
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
enum SecretToken {
    /// The word is not a secret token — the caller keeps it verbatim (literal
    /// text such as the `Bearer` scheme prefix).
    Literal,
    /// The token resolved to a concrete secret value.
    Value(String),
    /// The token resolves to "absent" (missing env var / no bound vault
    /// connection / empty value) — the WHOLE header is then omitted.
    Absent,
}

/// Operator override naming the process env vars ANY plugin may read through an
/// `env:` secret-header token, comma/whitespace separated. Additive on top of the
/// per-plugin prefix below — the escape hatch for a deployment that wants a
/// Community plugin to reach a shared credential (`RYU_TOKEN`, a corporate proxy
/// key) without shipping it a Core-tier id.
const ENV_SECRET_ALLOWLIST: &str = "RYU_PLUGIN_ENV_ALLOWLIST";

/// The per-plugin env-var prefix a Community-tier plugin may read from without any
/// operator configuration. Non-alphanumeric bytes use an explicit hex escape,
/// making the mapping injective: two different plugin ids can never share the
/// same credential namespace.
///
/// # Why the `RYU_PLUGIN_` infix rather than the bare `RYU_<ID>_` BYOK shape
///
/// The obvious rule — mirror the shape first-party manifests already author, where
/// `exa` reads `RYU_EXA_API_KEY` — puts the plugin namespace INSIDE Core's own
/// configuration namespace, and plugin ids are free-form (a bare kebab id like
/// `ghost` or `rtk` is legal, see `validate_plugin_id`). A plugin is therefore free
/// to name ITSELF after a Core config family and read that family's secrets: id
/// `master` → `RYU_MASTER_` ⊃ `RYU_MASTER_KEY`; id `gateway` → `RYU_GATEWAY_` ⊃
/// `RYU_GATEWAY_TOKEN`/`RYU_GATEWAY_KEY`; id `ext` → `RYU_EXT_TOKEN`; id `github` →
/// `RYU_GITHUB_TOKEN`; id `marketplace` → `RYU_MARKETPLACE_SIGNING_KEY`. None of
/// those ids is taken by a compiled-in fixture, so all are claimable by a disk
/// manifest, and the gate would have read as a fence while granting exactly the
/// credentials it exists to protect.
///
/// A denylist of Core's ~270 `RYU_*` vars would be hand-maintained and stale the
/// moment someone adds a var — the same failure mode the audit flagged for the
/// Gateway's hand-listed grant allowlist. Carving out a sub-namespace Core never
/// uses for its own configuration is structural instead: nothing in Core reads a
/// `RYU_PLUGIN_*` var except [`ENV_SECRET_ALLOWLIST`], which this gate refuses
/// explicitly.
///
/// Nothing first-party regresses: every in-repo manifest that authors an `env:`
/// secret header is compiled in, so it takes the provenance arm above and never
/// reaches this prefix at all. The rule binds only third-party disk plugins, which
/// simply name their BYOK var `RYU_PLUGIN_<THEIR_ID>_API_KEY`.
fn plugin_env_prefix(plugin_id: &str) -> String {
    let mut out = String::with_capacity(plugin_id.len() + 12);
    out.push_str("RYU_PLUGIN_");
    for byte in plugin_id.trim().as_bytes() {
        if byte.is_ascii_alphanumeric() {
            out.push((*byte as char).to_ascii_uppercase());
        } else {
            out.push_str(&format!("_X{byte:02X}_"));
        }
    }
    out.push('_');
    out
}

/// Whether `plugin_id` may read the process env var `var` through an `env:`
/// secret-header token.
///
/// # Why this gate exists
///
/// `secret_headers` resolves server-side and its VALUES are deliberately excluded
/// from the firewall/DLP scan and the audit trail (a secret must not land in a log),
/// so an `env:` read is an invisible transfer. Unrestricted, a manifest in the
/// user-writable `~/.ryu/plugins` could pair `secret_headers: {"X-K":
/// "env:ANTHROPIC_API_KEY"}` (or `RYU_MASTER_KEY`, or a gateway token) with a URL it
/// controls and exfiltrate a credential the user never knew it could see.
///
/// App dispatch first filters sources with [`restrict_backend_env_sources`],
/// binding shared-variable access to the actual compiled manifest bytes. This
/// lower-level gate also handles host-generated requests and scoped variables:
///
/// - A **compiled-in** manifest (`plugin_manifest/fixtures/*.manifest.json`, embedded
///   with `include_str!`) reads any var. Its bytes ship inside the binary, and
///   several of them legitimately read a SHARED var that fits no per-plugin prefix:
///   `@ryu/advisor` and `shadow` both authenticate to loopback Core with
///   `env:RYU_TOKEN`. Note this is deliberately NOT `tier_for` — `exa`, `rtk` and
///   `@ryu/advisor` are all Community-tier yet compiled in, so a tier check
///   would break three first-party tools while protecting nothing extra.
/// - A **disk** manifest (`~/.ryu/plugins/<id>/manifest.json`, which the loader
///   validates for semver + id uniqueness and nothing else) reads only its own
///   [`plugin_env_prefix`] namespace, plus whatever an operator names in
///   [`ENV_SECRET_ALLOWLIST`]. Fail-closed.
///
/// Provenance rather than a grant because there is no per-var approval to read: the
/// Gateway vets grant STRINGS, and no grant vocabulary describes "may read env var
/// X". Tightening the namespace is the control that exists.
pub(crate) fn may_read_env_secret(plugin_id: &str, var: &str) -> bool {
    if crate::plugins::builtins::is_compiled_in_manifest(plugin_id) {
        return true;
    }
    may_read_scoped_env_secret(plugin_id, var)
}

fn may_read_scoped_env_secret(plugin_id: &str, var: &str) -> bool {
    // The allowlist var itself is never readable through the gate it configures:
    // a plugin whose id encodes to the `env` namespace would otherwise sit exactly on
    // `RYU_PLUGIN_ENV_` and read the policy naming its own escape hatch.
    if var == ENV_SECRET_ALLOWLIST {
        return false;
    }
    if var.starts_with(&plugin_env_prefix(plugin_id)) {
        return true;
    }
    std::env::var(ENV_SECRET_ALLOWLIST).ok().is_some_and(|raw| {
        raw.split([',', ' ', '\t', '\n', ';'])
            .map(str::trim)
            .any(|entry| !entry.is_empty() && entry == var)
    })
}

/// Check environment sources against the manifest that actually owns execution.
/// Catalog membership of its id cannot establish provenance of installed bytes.
pub(crate) fn restrict_backend_env_sources(
    manifest: &crate::plugin_manifest::PluginManifest,
    backend: &mut crate::plugin_manifest::schema::ToolBackend,
) {
    if crate::plugins::builtins::is_exact_compiled_manifest(manifest) {
        return;
    }
    let allowed = |source: &str| {
        source.split_whitespace().all(|word| {
            word.strip_prefix("env:")
                .is_none_or(|var| may_read_scoped_env_secret(&manifest.id, var))
        })
    };
    match backend {
        crate::plugin_manifest::schema::ToolBackend::Http { secret_headers, .. } => {
            secret_headers.retain(|_, source| allowed(source));
        }
        crate::plugin_manifest::schema::ToolBackend::Command { env, .. } => {
            env.retain(|_, source| allowed(source));
        }
        _ => {}
    }
}

/// Resolve an `env:VARNAME` token to its value, from the process environment or —
/// when the process has none — from the encrypted per-plugin secret store.
///
/// # Why the store is reached under the SAME name
///
/// A BYOK plugin declares its key as `env:RYU_TAVILY_API_KEY` today. Introducing a
/// second grammar (`secret:RYU_TAVILY_API_KEY`) would mean every existing manifest
/// had to be edited before its key became settable from the UI — including
/// third-party ones nobody here can edit. Falling back under the identical name
/// makes every plugin that already ships an `env:` token UI-configurable with ZERO
/// manifest changes, which is the whole point of
/// [`crate::plugin_secrets`].
///
/// # Precedence: live node token, then process env, then store
///
/// `RYU_TOKEN` is Core's internal self-call credential. Runtime rotation updates
/// [`crate::node_token::active_token`] without mutating the multithreaded process
/// environment, so that one name resolves from live state. For every other name,
/// an operator who exports a var in the service unit / shell profile expects that
/// value to be the one in effect, and expects `env | grep` to explain what the
/// process is doing. If the store won, a forgotten UI entry would silently shadow
/// the deployment's configuration and there would be nothing in the environment to
/// point at. So env wins and the store is the fallback — the UI is how you set a
/// key you have *not* otherwise configured, never a way to override one you have.
///
/// # The namespace gate runs FIRST, before either source
///
/// [`may_read_env_secret`] restricts which names a disk manifest may name at all
/// (its own [`plugin_env_prefix`] namespace plus the operator allowlist). It must
/// gate the store lookup exactly as it gates the env read: without it, plugin A
/// could name plugin B's key and — because the store is keyed by the CALLING
/// plugin id — at minimum probe for, and at worst harvest, credentials outside its
/// namespace. The gate is applied once, above the branch, so no future source can
/// be added below it and miss the check.
///
/// `store` is passed in rather than read from the global so tests can exercise the
/// real precedence against an in-memory store; production callers pass
/// [`crate::plugin_secrets::global`].
async fn resolve_env_secret_from(
    plugin_id: &str,
    var: &str,
    store: Option<&crate::plugin_secrets::PluginSecretStore>,
) -> SecretToken {
    // Ungated var → treated exactly like "unset": the header is omitted and the
    // tool surfaces its own auth error. Refusing loudly here would leak which
    // env vars this Core process happens to carry.
    if !may_read_env_secret(plugin_id, var) {
        tracing::warn!(
            "plugin '{plugin_id}' requested env var '{var}' in a secret header, but it is \
             outside the plugin's '{}' namespace and not on the '{ENV_SECRET_ALLOWLIST}' \
             operator allowlist; the header is omitted",
            plugin_env_prefix(plugin_id)
        );
        return SecretToken::Absent;
    }
    let live_node_token = (var == "RYU_TOKEN")
        .then(crate::node_token::active_token)
        .flatten();
    let environment_value = std::env::var(var).ok();
    if let Some(v) = resolve_process_env_value(
        var,
        live_node_token.as_deref(),
        environment_value.as_deref(),
    ) {
        return SecretToken::Value(v);
    }
    let Some(store) = store else {
        return SecretToken::Absent;
    };
    match store.get(plugin_id, var).await {
        Ok(Some(v)) if !v.is_empty() => SecretToken::Value(v),
        Ok(_) => SecretToken::Absent,
        Err(e) => {
            // Storage failure is "absent", not a hard error: same soft-omit posture
            // as an unset var, so a broken db degrades to the pre-store behaviour.
            tracing::warn!("reading plugin secret '{var}' for '{plugin_id}' failed: {e:#}");
            SecretToken::Absent
        }
    }
}

/// Resolve an explicitly declared sidecar environment reference using the same
/// plugin namespace and encrypted-store precedence as HTTP credentials.
/// Callers must apply reserved sidecar environment values after this result.
pub(crate) async fn resolve_sidecar_env_source(
    plugin_id: &str,
    source: &str,
    store: Option<&crate::plugin_secrets::PluginSecretStore>,
    manifest: Option<&crate::plugin_manifest::PluginManifest>,
) -> Option<String> {
    let var = source.strip_prefix("env:")?;
    let trusted = manifest.is_some_and(|manifest| {
        manifest.id == plugin_id && crate::plugins::builtins::is_exact_compiled_manifest(manifest)
    });
    if !trusted && !may_read_scoped_env_secret(plugin_id, var) {
        return None;
    }
    match resolve_env_secret_from(plugin_id, var, store).await {
        SecretToken::Value(value) => Some(value),
        SecretToken::Absent | SecretToken::Literal => None,
    }
}

fn resolve_process_env_value(
    var: &str,
    live_node_token: Option<&str>,
    environment_value: Option<&str>,
) -> Option<String> {
    let value = if var == "RYU_TOKEN" {
        live_node_token
    } else {
        environment_value
    };
    value.filter(|value| !value.is_empty()).map(str::to_owned)
}

/// Resolve a single whitespace-delimited `word` against the secret grammar.
/// A `word` that does not carry a known prefix is [`SecretToken::Literal`] —
/// surrounding scheme text (e.g. `Bearer`) passes through untouched.
///   - `env:VARNAME`    → process env, else the encrypted plugin secret store
///     (the BYOK seam — see [`resolve_env_secret_from`]), gated by
///     [`may_read_env_secret`]; empty/unset/ungated → absent.
///   - `vault:<domain>` → the governed `identity::read_credential` (grant
///     `identity.read` + audit) for the connection bound to `<domain>` among the
///     agent's `profile_ids`.
///   - `secret:NAME`     → the encrypted user-managed vault, resolved against
///     the server-derived node/user/team/org context for this MCP call.
async fn resolve_secret_token(
    word: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
    secret_context: Option<&crate::plugin_secrets::SecretResolutionContext>,
) -> SecretToken {
    if let Some(var) = word.strip_prefix("env:") {
        return resolve_env_secret_from(plugin_id, var, crate::plugin_secrets::global()).await;
    }
    if let Some(domain) = word.strip_prefix("vault:") {
        let domain = domain.trim().to_ascii_lowercase();
        let Some(store) = crate::identity::global() else {
            return SecretToken::Absent;
        };
        // Find the connection bound for this domain across the agent's profiles.
        for profile_id in profile_ids {
            if let Ok(Some(conn)) = store.find(profile_id, &domain).await {
                // A SECOND governed read/audit for this credential (the consult
                // already read+dropped it): this one actually injects it.
                match crate::identity::read_credential(
                    store,
                    &conn.id,
                    session_id.map(str::to_owned),
                )
                .await
                {
                    Ok(Some(state)) => return SecretToken::Value(state.expose().to_owned()),
                    // Bound but no sealed state, or a denied read → omit the header
                    // (the tool then surfaces its own auth error).
                    Ok(None) | Err(_) => return SecretToken::Absent,
                }
            }
        }
        return SecretToken::Absent;
    }
    if let Some(name) = word.strip_prefix("secret:") {
        let (Some(store), Some(context)) = (crate::plugin_secrets::global(), secret_context) else {
            return SecretToken::Absent;
        };
        match store.resolve_vault_secret(name, context).await {
            Ok(Some(value)) if !value.is_empty() => SecretToken::Value(value),
            Ok(_) => SecretToken::Absent,
            Err(error) => {
                tracing::warn!("reading user-managed vault secret failed: {error:#}");
                SecretToken::Absent
            }
        }
    } else {
        SecretToken::Literal
    }
}

/// Resolve a `secret_headers` value TEMPLATE to its concrete header value, or
/// `Ok(None)` when any token resolves to "absent" (missing env var / no bound
/// vault connection) so the header is simply omitted — which, with `fail_open` +
/// a downstream 401, reproduces the exa missing-key path.
///
/// The value is a template: every whitespace-delimited `env:VARNAME` /
/// `vault:<domain>` TOKEN is substituted with its server-side-resolved secret,
/// while surrounding literal text is preserved verbatim. So a value like
/// `"Bearer env:RYU_EXA_API_KEY"` yields `"Bearer <resolved>"` (the scheme
/// prefix the wire wants), and the degenerate whole-value `"env:RYU_EXA_API_KEY"`
/// still resolves to the bare secret (back-compat). Grammar mirrors
/// `run_command_tool`'s `env:` seam plus a governed `vault:<domain>` read:
///   - `env:VARNAME`    → process env, else the encrypted plugin secret store
///     (the BYOK seam), scoped to what `plugin_id` may read (see
///     [`may_read_env_secret`] and [`resolve_env_secret_from`]).
///   - `vault:<domain>` → the governed `identity::read_credential` (grant
///     `identity.read` + audit) for the connection bound to `<domain>` among the
///     agent's `profile_ids`.
///   - `secret:NAME`     → the encrypted user-managed vault, resolved against
///     the server-derived user/node/team/org context.
///
/// A value carrying NO token at all is an `Err` (never a silent skip — mirrors
/// the command `env:` unsupported-source rejection). Resolved values are spliced
/// only into `resolved_secret_headers` (never the args map), so they stay out of
/// the model-visible schema and the firewall/DLP scan.
async fn resolve_secret_header_source(
    header_name: &str,
    source: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    resolve_secret_header_source_with_context(
        header_name,
        source,
        plugin_id,
        profile_ids,
        session_id,
        None,
    )
    .await
}

async fn resolve_secret_header_source_with_context(
    header_name: &str,
    source: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
    secret_context: Option<&crate::plugin_secrets::SecretResolutionContext>,
) -> Result<Option<String>, String> {
    let mut out = String::with_capacity(source.len());
    let mut saw_token = false;
    let mut cursor = 0usize;
    while cursor < source.len() {
        let rest = &source[cursor..];
        // Emit any leading whitespace run verbatim (preserves literal layout).
        let ws_len = rest
            .find(|c: char| !c.is_whitespace())
            .unwrap_or(rest.len());
        if ws_len > 0 {
            out.push_str(&rest[..ws_len]);
            cursor += ws_len;
            continue;
        }
        // A maximal non-whitespace word — a candidate token.
        let word_len = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..word_len];
        cursor += word_len;
        match resolve_secret_token(word, plugin_id, profile_ids, session_id, secret_context).await {
            SecretToken::Literal => out.push_str(word),
            SecretToken::Value(v) => {
                saw_token = true;
                out.push_str(&v);
            }
            // Any token resolving to absent omits the ENTIRE header.
            SecretToken::Absent => return Ok(None),
        }
    }
    if !saw_token {
        return Err(format!(
            "http tool: unsupported secret source '{source}' for header '{header_name}' (expected an 'env:VARNAME', 'vault:<domain>', or 'secret:NAME' token)"
        ));
    }
    Ok(Some(out))
}

/// The URL scheme a manifest uses to reach **this node's own Core** over loopback.
///
/// `core:/api/ext/@ryu/browser/tabs` — note the single slash; everything after
/// `core:` is the path, and the origin is filled in at call time.
pub const CORE_URL_SCHEME: &str = "core:";

/// Core's loopback origin for the ACTIVE profile.
///
/// Only the PORT is taken from `RYU_BIND`, never the host: a node bound to
/// `0.0.0.0:7980` is listening everywhere, but the address to DIAL from inside the
/// same process is still loopback, and `http://0.0.0.0/...` is not a route.
fn core_loopback_origin() -> String {
    let bind = std::env::var("RYU_BIND").ok();
    format!("http://127.0.0.1:{}", core_port_from_bind(bind.as_deref()))
}

/// Core's port for this profile, given the raw `RYU_BIND` value. Pure, so the
/// precedence is testable without mutating process env in a parallel test binary.
///
/// `RYU_BIND` is seeded per profile by `profile::apply_env_defaults`, so reading it
/// keeps this in step with whatever Core actually bound — including an operator who
/// set it by hand. Falling back through `profile::port` keeps the "one offset
/// source" rule when it is absent.
fn core_port_from_bind(bind: Option<&str>) -> u16 {
    bind.and_then(|b| b.rsplit(':').next())
        .and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or_else(|| crate::profile::port(CORE_BASE_PORT))
}

/// [`resolve_core_url`] against an explicit origin. Split out so the scheme
/// expansion is testable independently of the ambient profile.
fn resolve_core_url_with(url: &str, origin: &str) -> String {
    match url.strip_prefix(CORE_URL_SCHEME) {
        Some(path) => format!("{origin}/{}", path.trim_start_matches('/')),
        None => url.to_owned(),
    }
}

/// Core's base (release-profile) bind port. Every other profile is this plus the
/// profile offset, resolved through `profile::port` — never hardcoded shifted.
const CORE_BASE_PORT: u16 = 7980;

/// Expand a `core:`-scheme url into a concrete loopback URL for this profile.
/// Any other url is returned untouched.
///
/// # Why this scheme exists
///
/// A manifest that wants to reach Core's own HTTP surface (the ext-proxy, the memory
/// CRUD) used to hardcode `http://127.0.0.1:7980`. That is wrong on every profile but
/// `release`: `bun dev` runs the `dev` profile, where Core binds 8980, so the tool
/// either reached nothing or — far worse — reached a *release-profile* Core that
/// happened to be running, crossing two profiles' data. `profile.rs` states the rule
/// this restores: there is exactly ONE offset source, and nothing hardcodes a shifted
/// port.
///
/// The egress domain is unchanged (`127.0.0.1`), so a manifest's existing
/// `tool:http-egress:127.0.0.1` grant still gates it.
pub fn resolve_core_url(url: &str) -> String {
    if !url.starts_with(CORE_URL_SCHEME) {
        return url.to_owned();
    }
    resolve_core_url_with(url, &core_loopback_origin())
}

fn node_token_target_is_local_core(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    let is_loopback = host
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| address.is_loopback());
    is_loopback
        && parsed.port_or_known_default()
            == Some(core_port_from_bind(
                std::env::var("RYU_BIND").ok().as_deref(),
            ))
}

fn secret_headers_use_only_node_token(
    secret_headers: &std::collections::BTreeMap<String, String>,
) -> bool {
    !secret_headers.is_empty()
        && secret_headers.values().all(|source| {
            let mut found_node_token = false;
            for word in source.split_whitespace() {
                if word.starts_with("env:") || word.starts_with("vault:") {
                    if word != "env:RYU_TOKEN" {
                        return false;
                    }
                    found_node_token = true;
                }
            }
            found_node_token
        })
}

/// Whether `url` is the local Core ext-proxy, where a calling agent is stamped.
fn targets_local_ext_proxy(url: &str) -> bool {
    node_token_target_is_local_core(url)
        && reqwest::Url::parse(url)
            .ok()
            .is_some_and(|url| url.path().starts_with("/api/ext/"))
}

/// Name `agent_id` on a built request with a proof over its final method, path
/// and query, replacing any agent headers a tool's own header params set.
/// Without an agent (or a node token) both headers are removed, so a tool can
/// never name an agent itself; the proxy refuses an unproven one anyway.
fn sign_agent_lane_request(request: &mut reqwest::Request, agent_id: Option<&str>) {
    let headers = request.headers_mut();
    headers.remove(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID);
    headers.remove(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF);
    let Some(agent_id) = agent_id else {
        return;
    };
    let url = request.url();
    let mut path_and_query = url.path().to_owned();
    if let Some(query) = url.query() {
        path_and_query.push('?');
        path_and_query.push_str(query);
    }
    let method = request.method().as_str().to_owned();
    let Some(proof) =
        crate::sidecar::ext_proxy::sign_agent_lane(agent_id, &method, &path_and_query)
    else {
        return;
    };
    if let (Ok(agent), Ok(proof)) = (
        reqwest::header::HeaderValue::from_str(agent_id),
        reqwest::header::HeaderValue::from_str(&proof),
    ) {
        let headers = request.headers_mut();
        headers.insert(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_ID, agent);
        headers.insert(crate::sidecar::ext_proxy::HDR_CALLER_AGENT_PROOF, proof);
    }
}

fn guarded_http_client(
    pin: Option<&(String, Vec<std::net::SocketAddr>)>,
) -> Result<reqwest::Client, String> {
    // A proxy resolves the target itself, bypassing the addresses already screened
    // by the SSRF guard. This dispatcher must connect to the validated first hop.
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none());
    if let Some((host, addresses)) = pin {
        builder = builder.resolve_to_addrs(host, addresses);
    }
    builder
        .build()
        .map_err(|error| format!("http tool: client build failed: {error}"))
}

/// Proxy a plugin `http` tool call to `url`, Gateway-governed and egress-grant-gated.
///
/// Order matters. The **egress-grant check runs first** (deterministic — no
/// network, no gateway), so an ungranted domain is refused identically whether or
/// not the gateway is reachable. Then the SAME governance the PTC path uses gates
/// the call: a fail-closed budget check and the opt-in firewall/DLP scan, with a
/// post-call audit. Only then does Core make the outbound request.
///
/// `grants` is the owning plugin's grant set — for a Community-tier plugin the
/// RECORD's Gateway-approved grants, resolved by the dispatcher (see
/// `McpRegistry::resolve_app_tool_backend` / `effective_tool_grants`), not the
/// manifest's self-declaration. It must contain `tool:http-egress:<domain>` (or the
/// `*` wildcard). This tool reaches an EXTERNAL service — it never reads local user
/// data — so it needs no ACL principal. `agent_id` is the owning **plugin id** at
/// this seam; it names the audit principal AND scopes which process env vars the
/// `secret_headers` `env:` tokens may read.
#[allow(clippy::too_many_arguments)]
pub async fn run_http_tool(
    url: &str,
    method: &str,
    args: Value,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &std::collections::HashSet<String>,
    profile_ids: &[String],
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    run_http_tool_with_agent(
        url,
        method,
        args,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        grants,
        profile_ids,
        agent_id,
        session_id,
        None,
    )
    .await
}

/// Variant of [`run_http_tool`] that receives the actual calling agent id in
/// addition to the owning plugin id used for grants and secret resolution.
#[allow(clippy::too_many_arguments)]
pub async fn run_http_tool_with_agent(
    url: &str,
    method: &str,
    args: Value,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &std::collections::HashSet<String>,
    profile_ids: &[String],
    agent_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
) -> Result<Value, String> {
    run_http_tool_with_secret_context(
        url,
        method,
        args,
        header_params,
        secret_headers,
        fail_open,
        unwrap_body,
        body_defaults,
        grants,
        profile_ids,
        agent_id,
        session_id,
        audit_agent_id,
        None,
    )
    .await
}

/// Variant of [`run_http_tool_with_agent`] that carries the server-derived
/// user/node/team/org context needed for `secret:NAME` references. The context
/// is only used during this call and is never placed in the model-visible args.
#[allow(clippy::too_many_arguments)]
pub async fn run_http_tool_with_secret_context(
    url: &str,
    method: &str,
    args: Value,
    header_params: &[String],
    secret_headers: &std::collections::BTreeMap<String, String>,
    fail_open: bool,
    unwrap_body: bool,
    body_defaults: &Value,
    grants: &std::collections::HashSet<String>,
    profile_ids: &[String],
    agent_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
    secret_context: Option<&crate::plugin_secrets::SecretResolutionContext>,
) -> Result<Value, String> {
    // 0. Lower the REST args onto the request BEFORE any guard, so the egress /
    //    SSRF checks below run on the FINAL host (path params can appear before
    //    the host in a templated base, and query/body partitioning is settled here).
    let method_upper = method.to_ascii_uppercase();
    let m = reqwest::Method::from_bytes(method_upper.as_bytes())
        .map_err(|_| format!("http tool: invalid method '{method}'"))?;
    let bodyless = matches!(m, reqwest::Method::GET | reqwest::Method::HEAD);
    // Expand `core:` to this profile's loopback origin BEFORE the egress/SSRF
    // guards, so they screen the URL that is actually dialled.
    let url = resolve_core_url(url);
    // Secret headers are deliberately omitted from this first lowering pass. The
    // URL, query, and body do not depend on them, and this lets the cheap egress /
    // SSRF / gateway gates run before Core decrypts any user-managed value.
    let (final_url, query_pairs, mut body, ordinary_headers) =
        build_rest_request(&url, &args, bodyless, header_params, &[])?;

    let is_local_core = node_token_target_is_local_core(&final_url);
    if !secret_headers.is_empty() {
        let scheme = reqwest::Url::parse(&final_url)
            .map_err(|error| format!("http tool: invalid secret-header URL: {error}"))?
            .scheme()
            .to_owned();
        let local_core_node_token =
            is_local_core && secret_headers_use_only_node_token(secret_headers);
        if scheme != "https" && !local_core_node_token {
            return Err("http tool: secret headers require an HTTPS destination".to_owned());
        }
    }

    let uses_node_token = secret_headers.values().any(|source| {
        source
            .split_whitespace()
            .any(|word| word == "env:RYU_TOKEN")
    });
    if uses_node_token && !is_local_core {
        return Err(
            "http tool: the Core node token may only authenticate loopback Core destinations"
                .to_owned(),
        );
    }

    // 0c. Apply the manifest's static `body_defaults` UNDER the model-provided body
    //     (model args win; nested objects merge key-by-key). This is a declarative,
    //     tool-agnostic default+nesting seam — e.g. exa's num_results/use_autoprompt
    //     defaults and its `contents:{text:true}` nesting — that the generic verbatim
    //     forwarding otherwise dropped. `Null` (the default) is a no-op; for bodyless
    //     methods `body` is `Null` and stays `Null` (defaults do not become query).
    if body_defaults.is_object() && !bodyless {
        let mut merged = body_defaults.clone();
        deep_merge_json(&mut merged, &body);
        body = merged;
    }

    // 1. Egress-grant check FIRST (deterministic refusal, before any I/O).
    let domain = http_egress_domain(&final_url)
        .ok_or_else(|| format!("http tool: could not parse a host from url '{final_url}'"))?;
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
    //     Returns the exact addresses to PIN the request to so reqwest cannot
    //     re-resolve DNS to a different (internal) address at send() — closing the
    //     DNS-rebinding TOCTOU window (see `http_ssrf_guard`).
    let ssrf_pin = http_ssrf_guard(&final_url, &domain).await?;

    // 2. Gateway governance: fail-closed budget + opt-in firewall/DLP scan.
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit_with_attribution,
        ExecAuditAttribution, ExecBudgetOutcome, ExecScanOutcome,
    };
    let audit_attribution = ExecAuditAttribution {
        agent_id: audit_agent_id.map(str::to_owned),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };
    let backend = "tool_http";
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_http").await {
        return Err(format!("gateway denied http egress: {reason}"));
    }
    // Scan the method + final URL + body. Header VALUES (auth tokens injected by
    // the identity vault) are deliberately excluded so a secret never lands in the
    // firewall/DLP scan or audit trail.
    let scan_content = format!("{method_upper} {final_url}\n{body}");
    match check_exec_scan(backend, &scan_content, session_id, Some(agent_id)).await {
        ExecScanOutcome::Allow => {}
        ExecScanOutcome::Deny(reason) | ExecScanOutcome::ApprovalRequired(reason) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_http",
                0,
                1,
                session_id.map(str::to_owned),
                Some(format!("scan denied: {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return Err(format!("gateway denied http egress: {reason}"));
        }
    }

    // Remote identity mode consumes vault state inside Passport. Other secret
    // sources retain the owning plugin's existing resolution rules; structured
    // parts ensure their values cannot become new vault references.
    let uses_vault = secret_headers.values().any(|source| {
        source
            .split_whitespace()
            .any(|word| word.starts_with("vault:"))
    });
    if uses_vault && std::env::var_os("RYU_PASSPORT_URL").is_some() {
        let base = std::env::var("RYU_PASSPORT_URL")
            .map_err(|_| "Invalid Passport URL configuration".to_owned())?;
        let calling_agent = audit_agent_id.ok_or_else(|| {
            "Passport HTTP execution requires the calling agent identity".to_owned()
        })?;
        let mut templates = BTreeMap::new();
        for (name, source) in secret_headers {
            let mut parts = Vec::new();
            let mut saw_token = false;
            let mut absent = false;
            for part in source.split_inclusive(char::is_whitespace) {
                use ryu_vault::passport::HeaderPart;
                let word = part.trim_end_matches(char::is_whitespace);
                if let Some(domain) = word.strip_prefix("vault:") {
                    parts.push(HeaderPart::Vault(domain.to_owned()));
                    saw_token = true;
                } else {
                    match resolve_secret_token(
                        word,
                        agent_id,
                        profile_ids,
                        session_id,
                        secret_context,
                    )
                    .await
                    {
                        SecretToken::Literal => parts.push(HeaderPart::Literal(word.to_owned())),
                        SecretToken::Value(value) => {
                            parts.push(HeaderPart::Sensitive(value));
                            saw_token = true;
                        }
                        SecretToken::Absent => {
                            absent = true;
                            break;
                        }
                    }
                }
                let whitespace = &part[word.len()..];
                if !whitespace.is_empty() {
                    parts.push(HeaderPart::Literal(whitespace.to_owned()));
                }
            }
            if absent {
                continue;
            }
            if !saw_token {
                return Err("Passport HTTP header requires a secret source".to_owned());
            }
            templates.insert(name.clone(), parts);
        }
        let mut target =
            url::Url::parse(&final_url).map_err(|_| "Invalid Passport HTTP target".to_owned())?;
        if bodyless && !query_pairs.is_empty() {
            target.query_pairs_mut().extend_pairs(&query_pairs);
        }
        let started = std::time::Instant::now();
        let response = crate::identity::passport::execute_http(
            &base,
            calling_agent,
            profile_ids,
            crate::identity::passport::HttpRequest {
                url: target.to_string(),
                method: method_upper.clone(),
                headers: ordinary_headers.into_iter().collect(),
                credential_headers: BTreeMap::new(),
                header_templates: Some(templates),
                body: (!bodyless).then_some(body),
            },
            session_id.map(str::to_owned),
        )
        .await;
        let (result, exit_code, audit_err) = match response {
            Ok(response) => {
                target.set_query(None);
                target.set_fragment(None);
                let payment = if response.status == 402 {
                    crate::payment::PaymentRequiredEnvelope::from_http_headers(
                        response.payment_challenges.iter().map(String::as_str),
                        serde_json::json!({"kind":"http_tool","method":method_upper,"url":target.as_str()}),
                    )
                } else {
                    None
                };
                if let Some(envelope) = payment {
                    (
                        Ok(envelope.into_value()),
                        2,
                        Some("MPP payment required".to_owned()),
                    )
                } else {
                    finalize_http_result(
                        fail_open,
                        unwrap_body,
                        Some(response.status),
                        response.body,
                        None,
                    )
                }
            }
            Err(error) => finalize_http_result(
                fail_open,
                unwrap_body,
                None,
                Value::Null,
                Some(error.to_string()),
            ),
        };
        report_exec_audit_with_attribution(
            backend,
            "tool_http",
            started.elapsed().as_millis() as u64,
            exit_code,
            session_id.map(str::to_owned),
            audit_err,
            audit_attribution,
        )
        .await;
        return result;
    }

    // 2b. Resolve server-side SECRET headers only after the destination and
    // governance gates pass. Each source (`env:` / `vault:` / `secret:`) resolves
    // to a concrete value or "absent" (header omitted). Secret VALUES never enter
    // the args map, so they never reach the path/query/body, model-visible schema,
    // firewall/DLP scan, or audit trail.
    //
    // The `env:` arm is scoped to what the OWNING PLUGIN may read (`agent_id` is
    // the owning plugin id at this seam — see `resolve_app_tool_backend`), so a
    // disk manifest cannot name an unrelated credential var.
    let mut resolved_secret_headers: Vec<(String, String)> = Vec::new();
    for (name, source) in secret_headers {
        if let Some(value) = resolve_secret_header_source_with_context(
            name,
            source,
            agent_id,
            profile_ids,
            session_id,
            secret_context,
        )
        .await?
        {
            resolved_secret_headers.push((name.clone(), value));
        }
    }
    // Lower the same args a second time to attach the now-resolved headers. The
    // first pass already established the final URL/query/body, so only this
    // metadata-free header projection is used below.
    let (_, _, _, headers) = build_rest_request(
        &url,
        &args,
        bodyless,
        header_params,
        &resolved_secret_headers,
    )?;
    let resolved_secret_values: Vec<String> = resolved_secret_headers
        .iter()
        .map(|(_, value)| value.clone())
        .collect();

    // The calling agent of an app request is Core-owned. When a tool calls the
    // local Core ext-proxy, stamp the dispatcher-selected agent with an HMAC
    // tied to the exact request actually sent (see `sign_agent_lane_request`).
    // The proxy refuses a named agent without it, and forwards the app a grant
    // it hands back on managed provider calls (Treg), so the agent's account
    // access applies there too.
    let lane_agent = audit_agent_id.filter(|_| targets_local_ext_proxy(&final_url));

    // 3. Perform the request. Body is the tool args as JSON for methods that carry
    //    one; GET/HEAD send none. Response is `{ status, body }` (JSON if parseable).
    let started = std::time::Instant::now();
    // Redirects DISABLED: a 3xx is returned to the caller as-is. Following it would
    // re-issue the request to the `Location` host WITHOUT re-running the egress-grant
    // + SSRF checks above — the classic allowlist bypass (granted public domain →
    // 302 → 127.0.0.1 / 169.254.169.254). The guarded first hop is the only hop.
    let client = guarded_http_client(ssrf_pin.as_ref())?;
    let mut req = client
        .request(m.clone(), &final_url)
        .timeout(std::time::Duration::from_secs(30));
    for (name, value) in &headers {
        // Invalid header name/value surfaces as a request error at `.send()`.
        req = req.header(name, value);
    }
    if bodyless {
        if !query_pairs.is_empty() {
            req = req.query(&query_pairs);
        }
    } else {
        req = req.json(&body);
    }
    let sent = match req.build() {
        Ok(mut request) => {
            sign_agent_lane_request(&mut request, lane_agent);
            client.execute(request).await
        }
        Err(error) => Err(error),
    };
    let (result, exit_code, audit_err) = match sent {
        Ok(resp) => {
            let status = resp.status().as_u16();
            if status == reqwest::StatusCode::PAYMENT_REQUIRED.as_u16() {
                let challenge_headers: Vec<String> = resp
                    .headers()
                    .get_all(reqwest::header::WWW_AUTHENTICATE)
                    .iter()
                    .filter_map(|value| value.to_str().ok().map(str::to_owned))
                    .collect();
                let redacted_url = url::Url::parse(&final_url)
                    .map(|mut url| {
                        url.set_query(None);
                        url.set_fragment(None);
                        url.to_string()
                    })
                    .unwrap_or_else(|_| "redacted".to_owned());
                if let Some(envelope) = crate::payment::PaymentRequiredEnvelope::from_http_headers(
                    challenge_headers.iter().map(String::as_str),
                    serde_json::json!({
                        "kind": "http_tool",
                        "method": method_upper,
                        "url": redacted_url,
                    }),
                ) {
                    (
                        Ok(envelope.into_value()),
                        2,
                        Some("MPP payment required".to_owned()),
                    )
                } else {
                    match read_http_response_text_capped(resp).await {
                        Ok(text) => {
                            let body: Value =
                                serde_json::from_str(&text).unwrap_or(Value::String(text));
                            finalize_http_result_with_secrets(
                                fail_open,
                                unwrap_body,
                                Some(status),
                                body,
                                None,
                                &resolved_secret_values,
                            )
                        }
                        Err(error) => finalize_http_result_with_secrets(
                            fail_open,
                            unwrap_body,
                            Some(status),
                            Value::Null,
                            Some(error),
                            &resolved_secret_values,
                        ),
                    }
                }
            } else {
                match read_http_response_text_capped(resp).await {
                    Ok(text) => {
                        let body: Value =
                            serde_json::from_str(&text).unwrap_or(Value::String(text));
                        finalize_http_result_with_secrets(
                            fail_open,
                            unwrap_body,
                            Some(status),
                            body,
                            None,
                            &resolved_secret_values,
                        )
                    }
                    Err(error) => finalize_http_result_with_secrets(
                        fail_open,
                        unwrap_body,
                        Some(status),
                        Value::Null,
                        Some(error),
                        &resolved_secret_values,
                    ),
                }
            }
        }
        Err(e) => finalize_http_result(
            fail_open,
            unwrap_body,
            None,
            Value::Null,
            Some(e.to_string()),
        ),
    };
    report_exec_audit_with_attribution(
        backend,
        "tool_http",
        started.elapsed().as_millis() as u64,
        exit_code,
        session_id.map(str::to_owned),
        audit_err,
        audit_attribution,
    )
    .await;
    result
}

/// Parse `RYU_COMMAND_TOOL_ALLOWLIST` (`name=/abs/path` entries separated by `,`
/// or `;`) into a KEY→path map. **Pure** — no env read, no filesystem access, so
/// it is unit-testable without process-global races. Malformed entries (no `=`,
/// empty name, non-absolute path) are skipped; the map is intentionally empty
/// (⇒ fail-closed) for an empty/garbage string.
pub fn parse_command_allowlist(raw: &str) -> BTreeMap<String, std::path::PathBuf> {
    let mut map = BTreeMap::new();
    for entry in raw.split([',', ';']) {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        let Some((name, path)) = entry.split_once('=') else {
            continue;
        };
        let name = name.trim();
        let path = path.trim();
        if name.is_empty() || path.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(path);
        // Only absolute targets: the allowlist maps a logical key to an exact
        // binary, never a PATH-relative name an attacker could shadow.
        if !p.is_absolute() {
            continue;
        }
        map.insert(name.to_owned(), p);
    }
    map
}

/// Process-global seed of TRUSTED built-in command-tool bins (key → absolute
/// path), populated ONCE from the compiled-in manifests at startup by
/// [`seed_builtin_command_allowlist`]. Merged UNDER the env allowlist in
/// [`resolve_command_bin`] (env wins), so a built-in command tool (spider/rtk) is
/// runnable out of the box while a user can still add/override bins via
/// `RYU_COMMAND_TOOL_ALLOWLIST` — and an untrusted `~/.ryu/plugins` manifest can
/// never self-allowlist a bin (only `load_builtins()` feeds this).
static BUILTIN_COMMAND_SEED: std::sync::OnceLock<BTreeMap<String, std::path::PathBuf>> =
    std::sync::OnceLock::new();

/// Resolve a TRUSTED Core-side absolute path for a built-in command-tool bin KEY.
/// The manifest carries only the KEY (path-shaped values are structurally rejected
/// at `resolve_backend`), so the KEY→path mapping is Core-controlled here. Returns
/// a path even when the binary is not installed (so [`resolve_command_bin`] can
/// degrade gracefully to "not installed" rather than fail-closed) — only genuinely
/// unknown built-in keys map to `None`. Honors the same dev-override envs the
/// deleted native providers did (`RYU_SPIDER_BIN`, `RYU_RTK_BIN`).
///
/// # No PATH discovery
///
/// Both arms resolve to an operator-set absolute override or Ryu's OWN
/// `~/.ryu/bin/<name>`, never to a `$PATH` walk. [`parse_command_allowlist`]
/// enforces "only absolute targets — never a PATH-relative name an attacker could
/// shadow" for env-supplied entries, and this seed feeds the SAME allowlist, so it
/// has to honour the same invariant. `rtk` used to fall through to
/// [`crate::rtk_config::rtk_bin_path`], which returns the first `rtk` on `$PATH`
/// (resolved once at startup) — a writable directory earlier on Core's PATH was
/// enough to make an attacker-planted binary the allowlisted `rtk`. That module
/// keeps its PATH probe for the Phase-2 auto-wrap availability check, which spawns
/// `rtk init` for a user-driven toggle rather than admitting a bin to the
/// model-reachable tool allowlist.
fn trusted_builtin_bin_path(bin_key: &str) -> Option<std::path::PathBuf> {
    let ryu_bin = || crate::paths::bin_dir();
    match bin_key {
        "spider" => Some(
            std::env::var_os("RYU_SPIDER_BIN")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ryu_bin().join("spider")),
        ),
        "rtk" => Some(
            std::env::var_os("RYU_RTK_BIN")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ryu_bin().join("rtk")),
        ),
        "bws" => Some(
            std::env::var_os("RYU_BWS_BIN")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ryu_bin().join("bws")),
        ),
        _ => None,
    }
}

/// Command-bin keys whose paths are trusted by Core independently of plugin
/// enablement or manifest loading. These plugins are ordinary marketplace
/// packages in production, so they are not necessarily present in
/// `load_builtins()` even though their command keys remain Core-owned trust
/// decisions.
const TRUSTED_COMMAND_BIN_KEYS: &[&str] = &["spider", "rtk", "bws"];

/// Compute the built-in command-bin seed map from Core's trusted command keys.
/// This deliberately does not scan manifests: `load_builtins()` is a runtime
/// system-manifest catalog, not the source of truth for command trust. **Pure**
/// (no global mutation): tests call this directly and assert the contents
/// without poisoning the process-global [`BUILTIN_COMMAND_SEED`].
pub fn builtin_command_seed() -> BTreeMap<String, std::path::PathBuf> {
    let mut map = BTreeMap::new();
    for &bin in TRUSTED_COMMAND_BIN_KEYS {
        if let Some(path) = trusted_builtin_bin_path(bin) {
            map.insert(bin.to_owned(), path);
        }
    }
    map
}

/// Seed [`BUILTIN_COMMAND_SEED`] once from Core's trusted command keys. Called
/// from `main.rs` at startup so a granted spider/rtk call resolves out of the
/// box even when their ordinary marketplace manifests are not compiled in.
/// Idempotent; safe to call more than once (only the first wins).
pub fn seed_builtin_command_allowlist() {
    let _ = BUILTIN_COMMAND_SEED.set(builtin_command_seed());
}

/// Merge the built-in seed map with the env allowlist. The env is ADDITIVE and
/// wins on a key collision (so a user can override a built-in path and tests that
/// set the env keep working). **Pure** — takes both maps explicitly.
fn merge_command_allowlist(
    seed: &BTreeMap<String, std::path::PathBuf>,
    env_map: BTreeMap<String, std::path::PathBuf>,
) -> BTreeMap<String, std::path::PathBuf> {
    let mut merged = seed.clone();
    for (k, v) in env_map {
        merged.insert(k, v);
    }
    merged
}

/// The outcome of resolving a command-tool bin KEY, splitting the two failure
/// classes the caller must treat differently:
///   - an UNKNOWN key is a fail-closed `Err` (the allowlist IS the security
///     control — a bin nobody trusted must never run);
///   - an allowlisted key whose file is absent/not-a-file is `NotInstalled`, an
///     OPERATIONAL failure the caller degrades to a graceful `{available:false}`.
enum BinResolution {
    Ready(std::path::PathBuf),
    NotInstalled(String),
}

/// Resolve a command-tool bin KEY to its absolute path via the merged allowlist
/// (built-in seed ∪ env, env wins), verifying the target is an existing regular
/// file. An UNKNOWN key is refused fail-closed (`Err`); an allowlisted key whose
/// file is missing/not-a-file is [`BinResolution::NotInstalled`] (graceful). THIS
/// is the primary control — a manifest never supplies a path, only a key.
fn resolve_command_bin(bin_key: &str) -> Result<BinResolution, String> {
    let raw = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).unwrap_or_default();
    let env_map = parse_command_allowlist(&raw);
    let seed = BUILTIN_COMMAND_SEED.get().cloned().unwrap_or_default();
    let map = merge_command_allowlist(&seed, env_map);
    let Some(path) = map.get(bin_key) else {
        return Err(format!(
            "command tool: bin '{bin_key}' is not in the command allowlist (set {ENV_COMMAND_TOOL_ALLOWLIST})"
        ));
    };
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() && is_executable_mode(&meta) => {
            Ok(BinResolution::Ready(path.clone()))
        }
        Ok(meta) if meta.is_file() => Ok(BinResolution::NotInstalled(format!(
            "command tool: bin '{bin_key}' path {} is not executable",
            path.display()
        ))),
        Ok(_) => Ok(BinResolution::NotInstalled(format!(
            "command tool: bin '{bin_key}' path {} is not a regular file",
            path.display()
        ))),
        Err(e) => Ok(BinResolution::NotInstalled(format!(
            "command tool: bin '{bin_key}' is not installed at {} ({e})",
            path.display()
        ))),
    }
}

/// True when a regular file's mode lets it be executed (any execute bit on
/// unix; always true elsewhere, where executability is not a mode bit).
fn is_executable_mode(meta: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        true
    }
}

/// The soft-unavailable envelope a `command` tool returns instead of an `Err` for
/// an OPERATIONAL failure (not-installed bin, spawn failure, timeout) so the
/// agent's turn continues — mirroring the deleted spider/rtk providers. Security
/// gates (grant / egress / budget / scan / unknown-bin) still fail-closed `Err`.
fn command_unavailable(reason: impl Into<String>) -> Value {
    serde_json::json!({
        "available": false,
        "reason": reason.into(),
        "hint": "The command is unavailable (not installed, failed to start, or timed out); install it or retry.",
    })
}

/// Substitute `{name}` placeholders in ONE argv template element from the
/// tool-call `args`. Scalar-only (objects/arrays are rejected via
/// [`scalar_to_string`]); a placeholder with no matching arg is an error; each
/// interpolated value is length-capped and, as an option-injection guard, may not
/// begin with `-` (a leading-dash value could be read as a FLAG by the target
/// bin — argv arrays alone do not prevent that). The template author's own literal
/// text (including a leading `-` in the template, e.g. `--query={q}`) is never
/// guarded — only the interpolated value is.
fn render_command_arg(template: &str, args: &Value) -> Result<String, String> {
    let obj = args.as_object();
    let mut out = String::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let Some(close) = after.find('}') else {
            // Unbalanced brace: keep the remainder literally.
            out.push_str(&rest[open..]);
            return Ok(out);
        };
        let name = &after[..close];
        // A `{...}` that is not a plausible arg name (empty, or containing `/`) is
        // kept literally — mirrors `url_placeholders`' defensive scan.
        if name.is_empty() || name.contains('/') {
            out.push('{');
            out.push_str(name);
            out.push('}');
            rest = &after[close + 1..];
            continue;
        }
        let value = obj
            .and_then(|o| o.get(name))
            .ok_or_else(|| format!("command tool: missing argument '{name}'"))?;
        let rendered = scalar_to_string(value)
            .ok_or_else(|| format!("command tool: argument '{name}' must be a scalar"))?;
        if rendered.len() > MAX_COMMAND_ARG_LEN {
            return Err(format!(
                "command tool: argument '{name}' exceeds {MAX_COMMAND_ARG_LEN} bytes"
            ));
        }
        if rendered.starts_with('-') {
            return Err(format!(
                "command tool: argument '{name}' may not begin with '-' (option-injection guard)"
            ));
        }
        out.push_str(&rendered);
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

/// Replace declared filesystem arguments with canonical paths inside the active
/// workspace. The command backend remains argv-only, but argv separation alone
/// does not stop a read-only binary from opening an arbitrary absolute path.
/// Canonicalization happens after the grant check and before spawn, so a command
/// tool gets neither a path outside its caller's workspace nor a symlink escape.
/// `hidden` holds the canonical stores the calling agent's account access
/// hides from it ([`account_hidden_paths`]): a path inside one, or a folder
/// that contains one (which a recursive tool would walk into), is refused.
fn prepare_workspace_path_args(
    args: &mut Value,
    path_args: &[String],
    workspace_root: Option<&std::path::Path>,
    hidden: &[std::path::PathBuf],
) -> Result<(), String> {
    if path_args.is_empty() {
        return Ok(());
    }
    let root = workspace_root.ok_or_else(|| {
        "command tool: an active workspace is required for filesystem path arguments".to_owned()
    })?;
    let root = std::fs::canonicalize(root)
        .map_err(|e| format!("command tool: workspace root is unavailable: {e}"))?;
    if !root.is_dir() {
        return Err("command tool: workspace root is not a directory".to_owned());
    }
    let object = args
        .as_object_mut()
        .ok_or_else(|| "command tool: filesystem path arguments require an object".to_owned())?;
    for name in path_args {
        let raw = object
            .get(name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("command tool: missing filesystem path argument '{name}'"))?;
        let resolved = resolve_workspace_path(&root, raw)?;
        let resolved_path = std::path::Path::new(&resolved);
        if hidden.iter().any(|store| {
            path_is_within(resolved_path, store) || path_is_within(store, resolved_path)
        }) {
            return Err(
                "command tool: this agent's account access hides that path from it".to_owned(),
            );
        }
        object.insert(name.clone(), Value::String(resolved));
    }
    Ok(())
}

/// Resolve one command-tool path against a canonical workspace root.
/// Existing paths are required so the check can reject symlink components rather
/// than checking a path that may later resolve somewhere else. The command still
/// receives the canonical path, not the caller's spelling.
fn resolve_workspace_path(workspace_root: &std::path::Path, raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("command tool: filesystem path must not be empty".to_owned());
    }
    if raw.len() > MAX_COMMAND_ARG_LEN {
        return Err(format!(
            "command tool: filesystem path exceeds {MAX_COMMAND_ARG_LEN} bytes"
        ));
    }
    if raw.contains('\0') {
        return Err("command tool: filesystem path contains a NUL byte".to_owned());
    }

    let requested = std::path::Path::new(raw);
    let candidate = if requested.is_absolute() {
        requested.to_owned()
    } else {
        workspace_root.join(requested)
    };
    let canonical = std::fs::canonicalize(&candidate)
        .map_err(|_| "command tool: filesystem path could not be resolved".to_owned())?;
    if !path_is_within(&canonical, workspace_root) {
        return Err(
            "command tool: filesystem path must stay inside the active workspace".to_owned(),
        );
    }
    if path_has_symlink_component_below_root(&candidate, workspace_root) {
        return Err("command tool: filesystem path may not contain symlinks".to_owned());
    }
    if is_or_contains_protected_host_path(&canonical) {
        return Err("command tool: protected host paths are not searchable".to_owned());
    }
    Ok(canonical.to_string_lossy().into_owned())
}

/// The stores the OS sandbox hides from a limited agent's engine
/// ([`crate::agent_access::AccountConfinement`]), canonical: Ryu's data dir,
/// the home credential stores (SSH, cloud, package-registry and Git keys,
/// browser profiles), the Ryu Desktop's and Ryu Browser's data and, when its
/// model providers are limited, the user's provider sign-in and key stores.
/// Empty for an unrestricted agent or an unattributed call.
async fn account_hidden_paths(agent_id: Option<&str>) -> Vec<std::path::PathBuf> {
    let (Some(agent_id), Some(store)) = (agent_id, crate::agents::global()) else {
        return Vec::new();
    };
    let confinement = crate::agent_access::account_confinement_for_agent(store, agent_id).await;
    if !confinement.is_confined() {
        return Vec::new();
    }
    let provider_stores = confinement
        .hides_providers()
        .then(crate::agent_access::user_provider_stores);
    confined_hidden_paths(
        &crate::paths::ryu_dir(),
        dirs::home_dir().as_deref(),
        provider_stores.as_deref(),
    )
}

/// The canonical stores a confined agent's command tools may not reach:
/// `ryu_dir`, the home credential stores under `home`
/// ([`crate::agent_sandbox::home_credential_masks`]), the user's Keychain
/// files ([`crate::agent_sandbox::keychain_masks`]), the Ryu Desktop's and
/// Ryu Browser's data, and `provider_stores` when given. Each is resolved
/// through symlinks, so a store linked elsewhere is hidden where it really
/// lives; a store that does not exist is skipped, since a path inside it
/// cannot resolve either. `home` itself is not a store: a workspace in the
/// home folder keeps its ordinary paths, though a folder containing a store
/// is refused by [`prepare_workspace_path_args`].
fn confined_hidden_paths(
    ryu_dir: &std::path::Path,
    home: Option<&std::path::Path>,
    provider_stores: Option<&[std::path::PathBuf]>,
) -> Vec<std::path::PathBuf> {
    let mut paths = vec![ryu_dir.to_owned()];
    paths.extend(crate::agent_sandbox::home_credential_masks(home));
    paths.extend(crate::agent_sandbox::keychain_masks(home));
    paths.extend(crate::agent_sandbox::ryu_app_data_masks(
        &crate::agent_sandbox::ryu_app_data_roots(home),
    ));
    if let Some(stores) = provider_stores {
        paths.extend(stores.iter().cloned());
    }
    let mut hidden: Vec<std::path::PathBuf> = paths
        .into_iter()
        .filter_map(|path| std::fs::canonicalize(path).ok())
        .collect();
    hidden.sort();
    hidden.dedup();
    hidden
}

fn path_is_within(path: &std::path::Path, root: &std::path::Path) -> bool {
    path == root || path.strip_prefix(root).is_ok()
}

/// Check workspace-relative spelling supplied to `canonicalize`, not only its
/// resolved target. Parent directories outside the workspace may legitimately be
/// symlinks (for example macOS's `/tmp`), so only components below the canonical
/// workspace root are rejected.
fn path_has_symlink_component_below_root(
    path: &std::path::Path,
    workspace_root: &std::path::Path,
) -> bool {
    let Ok(relative) = path.strip_prefix(workspace_root) else {
        return false;
    };
    let mut current = workspace_root.to_owned();
    for component in relative.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(_) => break,
        }
    }
    false
}

/// Ryu's own data and the conventional per-user credential directories are not
/// valid workspace search targets, even when an operator accidentally selects a
/// parent directory as the active workspace. Known Ryu credential filenames are
/// denied at any depth as a second defense for copied or nested data directories.
pub(crate) fn is_protected_host_path(path: &std::path::Path) -> bool {
    if protected_host_roots()
        .iter()
        .any(|root| path_is_within(path, root))
    {
        return true;
    }

    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        file_name.to_ascii_lowercase().as_str(),
        "node-auth.token" | "core.token" | "gateway.token" | "pairing.token"
    )
}

/// True when `path` is a protected store or a directory that holds one (a parent
/// of the home folder such as `/home`, or of `~/.ssh`). A tool that mounts or
/// walks the whole directory, `just-bash` reading `alice/.ssh/id_ed25519` through
/// `/home`, would otherwise reach the store although the path itself is not inside it.
fn is_or_contains_protected_host_path(path: &std::path::Path) -> bool {
    is_protected_host_path(path)
        || protected_host_roots()
            .iter()
            .any(|root| path_is_within(root, path))
}

/// The conventional protected stores, canonical; a store that does not exist is skipped.
fn protected_host_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![crate::paths::ryu_dir()];
    if let Some(home) = dirs::home_dir() {
        roots.extend([
            home.join(".ssh"),
            home.join(".gnupg"),
            home.join(".aws"),
            home.join(".azure"),
            home.join(".codex"),
            home.join(".pi"),
            home.join(".config").join("gcloud"),
        ]);
    }
    roots
        .into_iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect()
}

/// Reject workspace roots that would turn a narrowly selected project search
/// into a host-wide search. The active root must be a real directory below the
/// filesystem root and must not be the user's home, a parent of it (`/home`,
/// `/Users`), or a protected host store or a folder holding one.
pub(crate) fn is_usable_workspace_root(path: &std::path::Path) -> bool {
    if !path.is_dir() || path.parent().is_none() {
        return false;
    }
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_owned());
    if is_or_contains_protected_host_path(&canonical) {
        return false;
    }
    dirs::home_dir()
        .and_then(|home| std::fs::canonicalize(home).ok())
        .is_none_or(|home| !path_is_within(&home, &canonical))
}

/// Build argv from a structured [`ArgSpec`] list (the `command_args` template
/// grammar's superset). Each spec reads one call arg and expands to 0..N tokens:
///
///   - `map` + `default`: the arg's string value is a KEY selecting the token
///     list; a key mapping to `[]` emits nothing (rtk `mode:"wrap"` → no
///     subcommand). An absent arg falls back to `default`; a value with no
///     matching key (and no usable default) is an error.
///   - `split:"shell"`: the arg's string value is `shell_words`-split into
///     variadic argv (quotes honored, never a shell). The split tokens are NOT
///     option-injection-guarded (a wrapped command legitimately carries `-la` /
///     `--all`); the bin grant + exec-scan are the controls, exactly as they were
///     for the deleted native provider. A `required` spec errors on a blank arg.
///   - neither: the arg's scalar value is emitted as ONE guarded token (same
///     leading-`-` guard + length cap as [`render_command_arg`]).
///
/// No shell is ever involved — the result is a plain argv array.
fn expand_arg_specs(
    specs: &[crate::plugin_manifest::schema::ArgSpec],
    args: &Value,
) -> Result<Vec<String>, String> {
    let obj = args.as_object();
    let mut argv: Vec<String> = Vec::new();
    for spec in specs {
        let raw = obj.and_then(|o| o.get(&spec.from));
        if let Some(map) = &spec.map {
            // Enum-map: the arg's string value is a key. Absent → `default`.
            let key: String = match raw.and_then(Value::as_str) {
                Some(s) => s.to_owned(),
                None => spec.default.clone().ok_or_else(|| {
                    format!("command tool: missing required argument '{}'", spec.from)
                })?,
            };
            let tokens = map.get(&key).ok_or_else(|| {
                format!(
                    "command tool: argument '{}' has unknown value '{key}'",
                    spec.from
                )
            })?;
            for t in tokens {
                argv.push(t.clone());
            }
        } else if spec.split.as_deref() == Some("shell") {
            // Shell-split one string arg into variadic argv — quotes honored,
            // never handed to a shell (metacharacters stay literal args).
            let s = raw.and_then(Value::as_str).unwrap_or_default().trim();
            if s.is_empty() {
                if spec.required.unwrap_or(false) {
                    return Err(format!(
                        "command tool: argument '{}' must be a non-empty string",
                        spec.from
                    ));
                }
                continue;
            }
            match shell_words::split(s) {
                Ok(parts) if !parts.is_empty() => {
                    for p in parts {
                        if p.len() > MAX_COMMAND_ARG_LEN {
                            return Err(format!(
                                "command tool: a token of argument '{}' exceeds {MAX_COMMAND_ARG_LEN} bytes",
                                spec.from
                            ));
                        }
                        argv.push(p);
                    }
                }
                Ok(_) => {
                    if spec.required.unwrap_or(false) {
                        return Err(format!(
                            "command tool: argument '{}' must be a non-empty string",
                            spec.from
                        ));
                    }
                }
                Err(e) => {
                    return Err(format!(
                        "command tool: could not parse argument '{}' ({e}); check quoting",
                        spec.from
                    ))
                }
            }
        } else {
            // Plain single token — same guards as a `command_args` interpolation.
            match raw {
                Some(v) => {
                    let rendered = scalar_to_string(v).ok_or_else(|| {
                        format!("command tool: argument '{}' must be a scalar", spec.from)
                    })?;
                    if rendered.len() > MAX_COMMAND_ARG_LEN {
                        return Err(format!(
                            "command tool: argument '{}' exceeds {MAX_COMMAND_ARG_LEN} bytes",
                            spec.from
                        ));
                    }
                    if rendered.starts_with('-') {
                        return Err(format!(
                            "command tool: argument '{}' may not begin with '-' (option-injection guard)",
                            spec.from
                        ));
                    }
                    argv.push(rendered);
                }
                None => {
                    if spec.required.unwrap_or(false) {
                        return Err(format!(
                            "command tool: missing required argument '{}'",
                            spec.from
                        ));
                    }
                }
            }
        }
    }
    Ok(argv)
}

/// Exec an allowlisted local CLI as a declarative `command` plugin tool —
/// Gateway-governed and bin-grant-gated. The exact `run_http_tool` bracket: the
/// **grant check runs first** (deterministic, no I/O), then the Core-controlled
/// **allowlist resolution** (the control), then arg templating into an argv ARRAY
/// (never a shell string), then the SAME budget + exec-approval scan + audit the
/// PTC/http paths use, and only then the spawn — under a hard timeout with a
/// bounded stdout read and a concurrent stderr drain.
///
/// `grants` is the owning plugin's grant set; it must contain
/// `tool:command:<bin>` (or the `*` wildcard). Env VALUES are deliberately
/// excluded from the scan and audit content, mirroring how `http` excludes header
/// values. `plugin_id` remains the grant and secret namespace, while
/// `audit_agent_id` preserves the actual agent that invoked the tool when the
/// dispatcher has that context.
#[allow(clippy::too_many_arguments)]
pub async fn run_command_tool(
    bin_key: &str,
    arg_templates: &[String],
    arg_specs: Option<&[crate::plugin_manifest::schema::ArgSpec]>,
    env_map: &BTreeMap<String, String>,
    cwd: Option<&str>,
    timeout_secs: u64,
    output: crate::plugin_manifest::schema::CommandOutput,
    egress_url_arg: Option<&str>,
    arg_bounds: &BTreeMap<String, crate::plugin_manifest::schema::ArgBounds>,
    args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    run_command_tool_with_agent(
        bin_key,
        arg_templates,
        arg_specs,
        env_map,
        cwd,
        timeout_secs,
        output,
        egress_url_arg,
        arg_bounds,
        args,
        grants,
        plugin_id,
        session_id,
        None,
    )
    .await
}

/// Variant of [`run_command_tool`] that preserves the calling agent id while
/// keeping the owning plugin id as the grant/secret boundary.
#[allow(clippy::too_many_arguments)]
pub async fn run_command_tool_with_agent(
    bin_key: &str,
    arg_templates: &[String],
    arg_specs: Option<&[crate::plugin_manifest::schema::ArgSpec]>,
    env_map: &BTreeMap<String, String>,
    cwd: Option<&str>,
    timeout_secs: u64,
    output: crate::plugin_manifest::schema::CommandOutput,
    egress_url_arg: Option<&str>,
    arg_bounds: &BTreeMap<String, crate::plugin_manifest::schema::ArgBounds>,
    args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
) -> Result<Value, String> {
    run_command_tool_with_agent_and_workspace(
        bin_key,
        arg_templates,
        arg_specs,
        env_map,
        cwd,
        timeout_secs,
        output,
        egress_url_arg,
        arg_bounds,
        args,
        grants,
        plugin_id,
        session_id,
        audit_agent_id,
        None,
        &[],
        None,
    )
    .await
}

/// Variant of [`run_command_tool_with_agent`] for command tools that declare
/// caller-workspace path arguments or a `bin_version` requirement (the two
/// wrappers above pass neither, so they refuse any `egress_url_arg`; the MCP
/// dispatcher passes the manifest's).
/// The workspace root is resolved by the MCP registry from the server-owned
/// conversation context; passing it separately
/// keeps this generic command runner independent of conversation storage.
#[allow(clippy::too_many_arguments)]
pub async fn run_command_tool_with_agent_and_workspace(
    bin_key: &str,
    arg_templates: &[String],
    arg_specs: Option<&[crate::plugin_manifest::schema::ArgSpec]>,
    env_map: &BTreeMap<String, String>,
    cwd: Option<&str>,
    timeout_secs: u64,
    output: crate::plugin_manifest::schema::CommandOutput,
    egress_url_arg: Option<&str>,
    arg_bounds: &BTreeMap<String, crate::plugin_manifest::schema::ArgBounds>,
    mut args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
    workspace_root: Option<&std::path::Path>,
    workspace_path_args: &[String],
    bin_version_req: Option<&crate::plugin_manifest::schema::CommandBinVersion>,
) -> Result<Value, String> {
    use crate::plugin_manifest::schema::CommandOutput;
    use tokio::io::AsyncReadExt;

    // 0. Schema-sourced defaults + clamp: inject each absent numeric arg's
    //    `default` and clamp a present one into `[minimum, maximum]`, sourced from
    //    the tool's own `input_schema`. Applied to BOTH the `command_args` and
    //    `arg_specs` render paths below, and it defends a raw-JSON caller that
    //    bypasses the MCP schema's own `minimum`/`maximum` (the original purpose).
    crate::plugin_manifest::schema::clamp_and_default_args(&mut args, arg_bounds);

    // 1. GRANT CHECK FIRST (deterministic refusal, before any I/O).
    let needed = format!("{GRANT_COMMAND_PREFIX}{bin_key}");
    let wildcard = format!("{GRANT_COMMAND_PREFIX}*");
    if !(grants.contains(&needed) || grants.contains(&wildcard)) {
        return Err(format!(
            "command tool: exec of '{bin_key}' is not granted (needs '{needed}')"
        ));
    }

    // 1b. EGRESS ⇒ VERSION: the egress broker only mediates a binary release that
    //     was verified to honour `HTTP(S)_PROXY`, so a URL-fetching command tool
    //     must never run unversioned. Manifest validation already requires
    //     `bin_version` alongside `egress_url_arg`; this runner-level refusal holds
    //     the same invariant for every entry point (including the wrappers above,
    //     which pass no requirement), before any I/O.
    if egress_url_arg.is_some() && bin_version_req.is_none() {
        return Err(format!(
            "command tool: '{bin_key}' declares egress_url_arg but no bin_version requirement \
             (the egress proxy only mediates a verified binary release)"
        ));
    }

    let hidden = account_hidden_paths(audit_agent_id).await;
    prepare_workspace_path_args(&mut args, workspace_path_args, workspace_root, &hidden)?;

    // URL-fetching child: screen the URL argument first (fail fast on private,
    // internal, non-http(s), and disallowed-port targets), snapshotting the
    // policy the per-invocation egress broker will apply to EVERY connection the
    // child opens. The broker itself is started right before spawn.
    let egress_policy = match egress_url_arg {
        Some(arg_name) => Some(screen_command_egress_url(&args, arg_name, timeout_secs).await?),
        None => None,
    };

    // 2. ALLOWLIST RESOLUTION (the control): KEY → absolute path, file-verified.
    //    An UNKNOWN key stays a fail-closed `Err` (the allowlist is the security
    //    control); an allowlisted-but-not-installed bin degrades gracefully so the
    //    agent's turn continues (the seed-the-path → degrade-until-installed
    //    interplay between gaps #3 and #4).
    let abs_path = match resolve_command_bin(bin_key)? {
        BinResolution::Ready(path) => path,
        BinResolution::NotInstalled(reason) => return Ok(command_unavailable(reason)),
    };

    // 4. ENV (computed here so the version probe runs under the same posture):
    //    inherit → scrub secret-shaped keys. The declared overlay is layered below.
    let scrubbed = crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]);
    let mut child_env: BTreeMap<String, String> = scrubbed.into_iter().collect();

    // 2b. BINARY VERSION: a declared `bin_version` requirement is probed against
    //     the resolved binary (cached per path/size/mtime) and refused fail-closed
    //     when unparsable or out of range — before argv, Gateway, broker, or spawn.
    if let Some(requirement) = bin_version_req {
        let probe_timeout = bin_version::BIN_VERSION_PROBE_TIMEOUT
            .min(std::time::Duration::from_secs(timeout_secs.max(1)));
        bin_version::check_bin_version(bin_key, &abs_path, requirement, &child_env, probe_timeout)
            .await?;
    }

    // 3. ARGV BUILD (NO shell). Structured `arg_specs` (map/split) supersede the
    //    `command_args` template path when present — the map/split expansions the
    //    one-slot template model cannot express (rtk's zero-token mode + variadic
    //    shell-split command). Otherwise, one slot per template element.
    let argv: Vec<String> = match arg_specs {
        Some(specs) => expand_arg_specs(specs, &args)?,
        None => {
            let mut v = Vec::with_capacity(arg_templates.len());
            for tmpl in arg_templates {
                v.push(render_command_arg(tmpl, &args)?);
            }
            v
        }
    };

    // 4b. ENV overlay: layer ONLY the declared vars onto the scrubbed base.
    //     Declared VALUES never enter the scan/audit content below.
    for (child_key, source) in env_map {
        // v1 supports only `env:VARNAME` — read Core's process env.
        if let Some(var) = source.strip_prefix("env:") {
            // SAME gate as the http tool's `secret_headers` (see `may_read_env_secret`).
            // This arm is the second `env:` reader in the crate and it is the more
            // dangerous of the two: a header value at least stays inside a request Core
            // builds, whereas this hands the raw value to a spawned child process that
            // can do anything with it. Without the gate a disk manifest could declare
            // `{"env": {"X": "env:ANTHROPIC_API_KEY"}}` on an allowlisted binary and
            // read any Core env var. Ungated → skipped, exactly like a missing var, so
            // Core's env inventory is not disclosed by a distinguishable error.
            if !may_read_env_secret(plugin_id, var) {
                tracing::warn!(
                    plugin_id,
                    var,
                    "command tool: refused an out-of-namespace env source"
                );
                continue;
            }
            // DELIBERATELY process-env ONLY: this arm does NOT fall back to
            // `crate::plugin_secrets` the way `resolve_secret_token` does. The
            // fallback exists so a UI-entered BYOK key can be interpolated into a
            // request header Core itself builds and sends to one known URL. Handing
            // that same key to a spawned child — which can exfiltrate it anywhere,
            // and whose whole reason for the scrubber above is to keep credentials
            // OUT of child environments — is a materially larger blast radius for no
            // demonstrated need (no in-repo command tool declares a BYOK key). If a
            // command tool ever needs one, wire it here explicitly and with its own
            // test, rather than by making the two paths implicitly symmetric.
            if let Ok(val) = std::env::var(var) {
                child_env.insert(child_key.clone(), val);
            }
            // A missing source var is silently skipped (the child just won't get it).
        } else {
            return Err(format!(
                "command tool: unsupported env source '{source}' for '{child_key}' (v1 supports only 'env:VARNAME')"
            ));
        }
    }

    // 5. GATEWAY governance: fail-closed budget + opt-in firewall/DLP scan.
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit_with_attribution,
        ExecAuditAttribution, ExecBudgetOutcome, ExecScanOutcome,
    };
    let audit_attribution = ExecAuditAttribution {
        agent_id: audit_agent_id
            .map(str::to_owned)
            .or_else(|| Some(plugin_id.to_owned())),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };
    let backend = "tool_command";
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_command").await {
        return Err(format!("gateway denied command exec: {reason}"));
    }
    // Scan the bin + argv (the injection surface). Env VALUES are excluded — a
    // secret in a declared var never lands in the firewall/DLP scan or the audit.
    let scan_content = format!("{bin_key} {}", argv.join(" "));
    match check_exec_scan(backend, &scan_content, session_id, Some(plugin_id)).await {
        ExecScanOutcome::Allow => {}
        // ApprovalRequired is a fail-closed DENY on a synchronous exec: there is no
        // place to park an interactive sign-off in a blocking tool call.
        ExecScanOutcome::Deny(reason) | ExecScanOutcome::ApprovalRequired(reason) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_command",
                0,
                1,
                session_id.map(str::to_owned),
                Some(format!("scan denied: {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return Err(format!("gateway denied command exec: {reason}"));
        }
    }

    // 5b. EGRESS BROKER for URL-fetching children: a loopback forward proxy with
    //     a random per-invocation credential that re-screens and IP-pins every
    //     connection. Installed AFTER the declared env so a manifest cannot
    //     override the proxy variables or exempt hosts through `NO_PROXY`. The
    //     handle lives until this function returns (child exited or killed) and
    //     its lifetime is capped at the tool timeout.
    let _egress_broker = match egress_policy {
        Some(policy) => {
            let broker = egress_broker::EgressBroker::start(policy)
                .await
                .map_err(|e| format!("command tool: failed to start egress broker: {e}"))?;
            broker.apply_to_env(&mut child_env);
            Some(broker)
        }
        None => None,
    };

    // 6. SPAWN — argv array, cleared+declared env, piped stdout/stderr, no stdin.
    let started = std::time::Instant::now();
    let mut cmd = tokio::process::Command::new(&abs_path);
    cmd.args(&argv).env_clear();
    for (k, v) in &child_env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_command",
                started.elapsed().as_millis() as u64,
                1,
                session_id.map(str::to_owned),
                Some(e.to_string()),
                audit_attribution.clone(),
            )
            .await;
            // OPERATIONAL failure → graceful degradation (audit still records the
            // real error above via exit 1). Turn-continuation, not a hard error.
            return Ok(command_unavailable(format!(
                "command tool: failed to spawn '{bin_key}': {e}"
            )));
        }
    };

    // Read stdout (bounded) and drain stderr CONCURRENTLY in separate tasks so a
    // full stderr pipe cannot deadlock the child while we wait on it.
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "command tool: no stdout pipe".to_owned())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "command tool: no stderr pipe".to_owned())?;
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        {
            let mut limited = (&mut stdout).take(MAX_COMMAND_OUTPUT_BYTES as u64);
            let _ = limited.read_to_end(&mut buf).await;
        }
        // Drain any remainder past the cap so the child never blocks writing.
        let mut scratch = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut scratch).await {
            if n == 0 {
                break;
            }
        }
        buf
    });
    let err_task = tokio::spawn(async move {
        // Capture stderr (bounded, same cap as stdout) so a successful command's
        // diagnostics — which many CLIs write to stderr — survive into the result.
        let mut buf = Vec::new();
        {
            let mut limited = (&mut stderr).take(MAX_COMMAND_OUTPUT_BYTES as u64);
            let _ = limited.read_to_end(&mut buf).await;
        }
        // Drain any remainder past the cap so the child never blocks writing.
        let mut scratch = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut scratch).await {
            if n == 0 {
                break;
            }
        }
        buf
    });

    // 7. Hard timeout + explicit kill.
    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait(),
    )
    .await
    {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            out_task.abort();
            err_task.abort();
            return Err(format!("command tool: wait on '{bin_key}' failed: {e}"));
        }
        Err(_elapsed) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            out_task.abort();
            err_task.abort();
            report_exec_audit_with_attribution(
                backend,
                "tool_command",
                started.elapsed().as_millis() as u64,
                124,
                session_id.map(str::to_owned),
                Some(format!("timeout after {timeout_secs}s")),
                audit_attribution.clone(),
            )
            .await;
            // OPERATIONAL failure → graceful degradation (audit records exit 124
            // above). Turn-continuation posture, mirroring the deleted providers.
            return Ok(command_unavailable(format!(
                "command tool: '{bin_key}' timed out after {timeout_secs}s"
            )));
        }
    };
    let stdout_bytes = out_task.await.unwrap_or_default();
    let stderr_bytes = err_task.await.unwrap_or_default();

    let exit_code = status.code().unwrap_or(-1);
    report_exec_audit_with_attribution(
        backend,
        "tool_command",
        started.elapsed().as_millis() as u64,
        exit_code,
        session_id.map(str::to_owned),
        None,
        audit_attribution,
    )
    .await;

    let truncated = stdout_bytes.len() >= MAX_COMMAND_OUTPUT_BYTES
        || stderr_bytes.len() >= MAX_COMMAND_OUTPUT_BYTES;
    let stdout_str = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();
    // A non-zero exit is returned as `Ok` (the exit code is in the payload +
    // audit), deliberately consistent with `run_http_tool` returning a non-2xx as
    // Ok — the caller/agent decides what a failed command means.
    match output {
        // Merge non-empty stderr into the returned text: many CLIs write
        // progress/warnings/diagnostics to stderr on an OTHERWISE successful run,
        // and the original merged-provider contract surfaced them (dropping them
        // silently masked useful output). General behavior, not tool-specific.
        CommandOutput::Stdout => Ok(serde_json::json!({
            "exit_code": exit_code,
            "stdout": merge_stderr(stdout_str, &stderr_str),
            "truncated": truncated,
        })),
        // Non-JSON stdout under output=json degrades gracefully (spider's posture,
        // chosen as the generic contract): the agent still receives the raw text
        // as `content` rather than losing the turn to a hard parse error.
        CommandOutput::Json => match serde_json::from_str::<Value>(stdout_str.trim()) {
            // Structured JSON stdout is returned verbatim: it has no free-text
            // field, and splicing stderr in would corrupt the parsed value.
            Ok(v) => Ok(v),
            // A stream past the cap is cut mid-document, so it lands here too; say so
            // rather than hand the agent half a JSON envelope as if it were whole.
            Err(_) => Ok(serde_json::json!({
                "available": true,
                "content": merge_stderr(stdout_str, &stderr_str),
                "exit_code": exit_code,
                "truncated": truncated,
            })),
        },
    }
}

/// Pre-spawn screen for a command tool's `egress_url_arg`: the URL must be a
/// string, pass Core's agent egress screen ([`crate::server::screen_agent_egress_url`]:
/// http/https only, internal hosts and private/loopback/metadata addresses refused
/// unless allowlisted), and use a port the egress broker will permit. Returns the
/// broker policy snapshot so the URL screen and the per-connection screen agree.
async fn screen_command_egress_url(
    args: &Value,
    arg_name: &str,
    timeout_secs: u64,
) -> Result<egress_broker::BrokerPolicy, String> {
    let raw = args.get(arg_name).and_then(Value::as_str).ok_or_else(|| {
        format!("command tool: egress URL argument '{arg_name}' must be a string")
    })?;
    let parsed = crate::server::screen_agent_egress_url(raw)
        .await
        .map_err(|e| format!("command tool: egress URL refused: {e}"))?;
    let policy =
        egress_broker::BrokerPolicy::from_env(std::time::Duration::from_secs(timeout_secs));
    let host = parsed.host_str().unwrap_or_default();
    let port = parsed.port_or_known_default().unwrap_or(80);
    policy
        .check_port(host, port)
        .map_err(|e| format!("command tool: egress URL refused: {e}"))?;
    Ok(policy)
}

/// Append non-empty `stderr` to a command's `text` output, matching the original
/// merged-provider contract: a single `\n` separates them only when `text` is
/// non-empty and does not already end in a newline. Whitespace-only stderr is
/// dropped.
fn merge_stderr(mut text: String, stderr: &str) -> String {
    if !stderr.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    text
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
mod tests;
