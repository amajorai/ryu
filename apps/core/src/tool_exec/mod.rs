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
    build_capability_adapter_program, build_inline_tool_program, detect_elicitation, is_available,
    run_sandboxed, schema, tool_path_to_id, CodeExecutor, Elicitation, ExecOutcome, InvokeOutcome,
    RegistryToolInvoker, ResumeDecision, SandboxBridge, SandboxToolInvoker, ToolCaller,
    ToolInvocation, ToolInvokeResult, BACKEND_DENO, CAPABILITY_ADAPTER_CALL_PATH,
    CAPABILITY_ADAPTER_NAMED_PATH, DEFAULT_DEADLINE_SECS, DEFAULT_MEMORY_MB, GRANT_TOOL_EXECUTE,
    MAX_PARKED, MAX_PREVIEW_CHARS, PARKED_TTL,
};

#[cfg(feature = "tool-exec-securexec")]
pub use ryu_tool_exec::BACKEND_SECUREXEC;

// The pure JS eval-evaluator runner (`run_eval_js`/`EvalJsOutcome`) is consumed
// directly from `ryu_tool_exec` by the `ryu-eval-code` crate — Core no longer
// re-exports it here.

use async_trait::async_trait;
use serde_json::Value;
use std::collections::BTreeMap;
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
        agent_id: Option<&str>,
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
            agent_id,
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
/// consumer's `{available:false,…}` handling (quests_client / usage_api) is reused.
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
/// operator configuration: `RYU_PLUGIN_<UPPER(plugin_id)>_`, with every
/// non-alphanumeric character folded to `_` (so `com.acme.weather` →
/// `RYU_PLUGIN_COM_ACME_WEATHER_`).
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
    // A scoped id's leading `@` is dropped rather than folded, so `@acme/weather`
    // yields `RYU_PLUGIN_ACME_WEATHER_` instead of a double-underscore
    // `RYU_PLUGIN__ACME_WEATHER_`. The `/` still folds like any other separator, so
    // the namespace stays unambiguous — `@a/b` and `a-b` both fold to `A_B`, and
    // colliding there costs a third-party plugin only its own namespace.
    for ch in plugin_id.trim_start_matches('@').chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_uppercase());
        } else {
            out.push('_');
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
/// The discriminator is manifest **provenance**, not tier
/// ([`crate::plugins::builtins::is_compiled_in_manifest`]):
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
    // The allowlist var itself is never readable through the gate it configures:
    // a plugin whose id folds to `env` would otherwise sit exactly on
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
async fn resolve_secret_token(
    word: &str,
    plugin_id: &str,
    profile_ids: &[String],
    session_id: Option<&str>,
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
    SecretToken::Literal
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
        match resolve_secret_token(word, plugin_id, profile_ids, session_id).await {
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
            "http tool: unsupported secret source '{source}' for header '{header_name}' (expected an 'env:VARNAME' or 'vault:<domain>' token)"
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
    // 0. Resolve the server-side SECRET headers (async + governed) BEFORE building
    //    the request. Each source (`env:` / `vault:`) resolves to a concrete value
    //    or "absent" (header omitted). These are pre-resolved so `build_rest_request`
    //    stays PURE (no env, no await) — the same testability reason the allowlist
    //    parse was extracted. Secret VALUES never enter the args map, so they never
    //    reach the path/query/body or the model-visible schema.
    //    The `env:` arm is scoped to what the OWNING PLUGIN may read (`agent_id` is
    //    the owning plugin id at this seam — see `resolve_app_tool_backend`), so a
    //    disk manifest cannot name an unrelated credential var.
    let mut resolved_secret_headers: Vec<(String, String)> = Vec::new();
    for (name, source) in secret_headers {
        if let Some(value) =
            resolve_secret_header_source(name, source, agent_id, profile_ids, session_id).await?
        {
            resolved_secret_headers.push((name.clone(), value));
        }
    }

    // 0b. Lower the REST args onto the request BEFORE any guard, so the egress /
    //    SSRF checks below run on the FINAL host (path params can appear before
    //    the host in a templated base, and query/body partitioning is settled here).
    let method_upper = method.to_ascii_uppercase();
    let m = reqwest::Method::from_bytes(method_upper.as_bytes())
        .map_err(|_| format!("http tool: invalid method '{method}'"))?;
    let bodyless = matches!(m, reqwest::Method::GET | reqwest::Method::HEAD);
    // Expand `core:` to this profile's loopback origin BEFORE the egress/SSRF
    // guards, so they screen the URL that is actually dialled.
    let url = resolve_core_url(url);
    let (final_url, query_pairs, mut body, headers) = build_rest_request(
        &url,
        &args,
        bodyless,
        header_params,
        &resolved_secret_headers,
    )?;

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
        check_exec_budget, check_exec_scan, report_exec_audit, ExecBudgetOutcome, ExecScanOutcome,
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
    // Redirects DISABLED: a 3xx is returned to the caller as-is. Following it would
    // re-issue the request to the `Location` host WITHOUT re-running the egress-grant
    // + SSRF checks above — the classic allowlist bypass (granted public domain →
    // 302 → 127.0.0.1 / 169.254.169.254). The guarded first hop is the only hop.
    let mut client_builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
    // Pin the connection to the addresses the SSRF guard validated. Without this,
    // reqwest re-resolves the host at send() and an attacker who controls the
    // granted domain's DNS could answer with an internal address the guard never
    // saw (DNS rebinding). `None` = a deliberate internal/localhost/literal-IP
    // grant with no DNS lookup to race, so no pin is needed.
    if let Some((host, addrs)) = &ssrf_pin {
        client_builder = client_builder.resolve_to_addrs(host, addrs);
    }
    let client = client_builder
        .build()
        .map_err(|e| format!("http tool: client build failed: {e}"))?;
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
    let (result, exit_code, audit_err) = match req.send().await {
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
                    let text = resp.text().await.unwrap_or_default();
                    let body: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
                    finalize_http_result(fail_open, unwrap_body, Some(status), body, None)
                }
            } else {
                let text = resp.text().await.unwrap_or_default();
                let body: Value = serde_json::from_str(&text).unwrap_or(Value::String(text));
                finalize_http_result(fail_open, unwrap_body, Some(status), body, None)
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
    let ryu_bin = || crate::paths::ryu_dir().join("bin");
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
        Ok(meta) if meta.is_file() => Ok(BinResolution::Ready(path.clone())),
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
/// values. `plugin_id` fills the audit principal (there is no separate agent id at
/// the dispatch call site, mirroring `run_http_tool`).
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
    mut args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
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

    // 1b. EGRESS SCREEN (SSRF): when this command fetches a URL arg (a crawler /
    //     scraper), screen that arg's value BEFORE any spawn — scheme allowlist +
    //     internal-address rejection (loopback / RFC1918 / link-local /
    //     169.254.169.254 metadata / ULA / CGNAT), the SAME guard `run_http_tool`
    //     applies. Runs before allowlist/gateway/spawn so a network CLI can never
    //     be turned into an SSRF probe. The child re-resolves DNS itself, so this
    //     is a pre-spawn screen (no IP-pinning) — the inherent residual for any
    //     shell-out fetcher, env-tunable via `RYU_AGENT_EGRESS_SSRF_GUARD` /
    //     `RYU_AGENT_EGRESS_ALLOW_HOSTS`.
    if let Some(arg_name) = egress_url_arg {
        let url = args
            .get(arg_name)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("command tool: missing required url argument '{arg_name}'"))?;
        crate::server::screen_agent_egress_url(url)
            .await
            .map_err(|e| e.to_string())?;
    }

    // 2. ALLOWLIST RESOLUTION (the control): KEY → absolute path, file-verified.
    //    An UNKNOWN key stays a fail-closed `Err` (the allowlist is the security
    //    control); an allowlisted-but-not-installed bin degrades gracefully so the
    //    agent's turn continues (the seed-the-path → degrade-until-installed
    //    interplay between gaps #3 and #4).
    let abs_path = match resolve_command_bin(bin_key)? {
        BinResolution::Ready(path) => path,
        BinResolution::NotInstalled(reason) => return Ok(command_unavailable(reason)),
    };

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

    // 4. ENV: inherit → scrub secret-shaped keys → layer ONLY the declared vars.
    //    Declared VALUES never enter the scan/audit content below.
    let scrubbed = crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]);
    let mut child_env: BTreeMap<String, String> = scrubbed.into_iter().collect();
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
        check_exec_budget, check_exec_scan, report_exec_audit, ExecBudgetOutcome, ExecScanOutcome,
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
            report_exec_audit(
                backend,
                "tool_command",
                0,
                1,
                session_id.map(str::to_owned),
                Some(format!("scan denied: {reason}")),
            )
            .await;
            return Err(format!("gateway denied command exec: {reason}"));
        }
    }

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
            report_exec_audit(
                backend,
                "tool_command",
                started.elapsed().as_millis() as u64,
                1,
                session_id.map(str::to_owned),
                Some(e.to_string()),
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
            report_exec_audit(
                backend,
                "tool_command",
                started.elapsed().as_millis() as u64,
                124,
                session_id.map(str::to_owned),
                Some(format!("timeout after {timeout_secs}s")),
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
    report_exec_audit(
        backend,
        "tool_command",
        started.elapsed().as_millis() as u64,
        exit_code,
        session_id.map(str::to_owned),
        None,
    )
    .await;

    let truncated = stdout_bytes.len() >= MAX_COMMAND_OUTPUT_BYTES;
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
            Err(_) => Ok(serde_json::json!({
                "available": true,
                "content": merge_stderr(stdout_str, &stderr_str),
                "exit_code": exit_code,
            })),
        },
    }
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
    use crate::plugin_manifest::schema::CommandOutput;
    use crate::sidecar::adapters::acp::AcpAgentRegistry;

    // ── Declarative `command` ToolBackend ─────────────────────────────────────

    fn grants(items: &[&str]) -> std::collections::HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn test_absolute_path(path: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        {
            let name = path
                .trim_start_matches('/')
                .trim_start_matches('\\')
                .replace('/', "_")
                .replace('\\', "_");
            std::env::temp_dir().join(format!("ryu-core-test-path-{name}"))
        }
        #[cfg(not(windows))]
        {
            std::path::PathBuf::from(path)
        }
    }

    fn test_command_path(_name: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        {
            std::env::var_os("SystemRoot")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe")
        }
        #[cfg(not(windows))]
        {
            let path = std::env::var_os("PATH").and_then(|value| {
                std::env::split_paths(&value)
                    .map(|dir| dir.join(_name))
                    .find(|candidate| candidate.is_file())
            });
            path.unwrap_or_else(|| std::path::PathBuf::from(format!("/bin/{_name}")))
        }
    }

    fn test_allowlist_entry(name: &str) -> String {
        format!("{name}={}", test_command_path(name).display())
    }

    /// Return the platform-native child arguments used by command-tool tests.
    /// Windows PowerShell's `-File` mode keeps the rendered values in `$args`,
    /// rather than reparsing them as a `-Command` string, so metacharacter and
    /// JSON tests retain their literal-argv coverage.
    fn test_command_args(
        command: &str,
        placeholders: &[&str],
    ) -> (Option<tempfile::TempDir>, Vec<String>) {
        #[cfg(windows)]
        {
            let script_body = match command {
                "echo" => "[Console]::WriteLine([String]::Join(' ', $args))\n",
                "sleep" => "Start-Sleep -Seconds 30\n",
                "dd" => "[byte[]]$bytes = New-Object byte[] 2097152\n[Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)\n[Console]::Error.WriteLine('records')\n",
                "env" => "Get-ChildItem Env: | ForEach-Object { '{0}={1}' -f $_.Name, $_.Value }\n",
                "sh" => "[Console]::WriteLine('the-stdout')\n[Console]::Error.WriteLine('the-stderr')\n",
                _ => panic!("unknown Windows test command: {command}"),
            };
            let dir = tempfile::tempdir().expect("test command tempdir");
            let script = dir.path().join(format!("{command}.ps1"));
            std::fs::write(&script, script_body).expect("write PowerShell test script");
            let mut args = vec![
                "-NoProfile".to_owned(),
                "-ExecutionPolicy".to_owned(),
                "Bypass".to_owned(),
                "-File".to_owned(),
                script.to_string_lossy().into_owned(),
            ];
            args.extend(placeholders.iter().map(|name| format!("{{{name}}}")));
            (Some(dir), args)
        }
        #[cfg(not(windows))]
        {
            let args = match command {
                "echo" => placeholders
                    .iter()
                    .map(|name| format!("{{{name}}}"))
                    .collect(),
                "sleep" => vec!["30".to_owned()],
                "dd" => vec![
                    "if=/dev/zero".to_owned(),
                    "bs=1024".to_owned(),
                    "count=2048".to_owned(),
                ],
                "env" => Vec::new(),
                "sh" => vec![
                    "-c".to_owned(),
                    "printf 'the-stdout\\n'; printf 'the-stderr\\n' 1>&2".to_owned(),
                ],
                _ => panic!("unknown Unix test command: {command}"),
            };
            (None, args)
        }
    }

    #[test]
    fn parse_command_allowlist_keeps_only_absolute_named_entries() {
        let echo = test_command_path("echo");
        let sleep = test_command_path("sleep");
        let invalid_name = test_command_path("invalid");
        let dd = test_command_path("dd");
        let map = parse_command_allowlist(&format!(
            "echo={}, sleep = {} ; bad=relative/path, ={}, noeq, dd={}",
            echo.display(),
            sleep.display(),
            invalid_name.display(),
            dd.display()
        ));
        assert_eq!(map.get("echo"), Some(&echo));
        assert_eq!(map.get("sleep"), Some(&sleep));
        assert_eq!(map.get("dd"), Some(&dd));
        // Relative path, empty name, and malformed entries are dropped.
        assert!(!map.contains_key("bad"));
        assert_eq!(map.len(), 3);
        // Empty string ⇒ empty map ⇒ fail-closed.
        assert!(parse_command_allowlist("").is_empty());
    }

    #[test]
    fn render_command_arg_substitutes_rejects_and_guards() {
        let args = serde_json::json!({ "q": "hello", "n": 5, "obj": { "a": 1 } });
        // Glued flag keeps the value one token.
        assert_eq!(
            render_command_arg("--query={q}", &args).unwrap(),
            "--query=hello"
        );
        // Numbers stringify.
        assert_eq!(render_command_arg("--num={n}", &args).unwrap(), "--num=5");
        // Missing placeholder → error.
        assert!(render_command_arg("{missing}", &args).is_err());
        // Non-scalar arg → error.
        assert!(render_command_arg("{obj}", &args).is_err());
        // Option-injection guard: a leading-dash interpolated VALUE is rejected …
        let dash = serde_json::json!({ "q": "-rf" });
        assert!(render_command_arg("{q}", &dash).is_err());
        // … but a leading dash in the TEMPLATE (author-controlled) is fine.
        assert_eq!(
            render_command_arg("--flag={q}", &serde_json::json!({ "q": "ok" })).unwrap(),
            "--flag=ok"
        );
    }

    /// Build the exact `rtk` arg-spec list (mode-map + shell-split command).
    fn rtk_specs() -> Vec<crate::plugin_manifest::schema::ArgSpec> {
        serde_json::from_value(serde_json::json!([
            { "from": "mode", "map": { "wrap": [], "proxy": ["proxy"], "test": ["test"], "err": ["err"] }, "default": "wrap" },
            { "from": "command", "split": "shell", "required": true }
        ]))
        .unwrap()
    }

    #[test]
    fn expand_arg_specs_reproduces_rtk_argv() {
        let specs = rtk_specs();
        // mode "wrap" contributes ZERO tokens; command shell-splits into variadic.
        assert_eq!(
            expand_arg_specs(
                &specs,
                &serde_json::json!({ "command": "git status", "mode": "wrap" })
            )
            .unwrap(),
            vec!["git", "status"]
        );
        // Absent mode defaults to "wrap" → still zero mode tokens.
        assert_eq!(
            expand_arg_specs(&specs, &serde_json::json!({ "command": "cargo test" })).unwrap(),
            vec!["cargo", "test"]
        );
        // A non-wrap mode prepends its subcommand token.
        assert_eq!(
            expand_arg_specs(
                &specs,
                &serde_json::json!({ "command": "ls -la", "mode": "proxy" })
            )
            .unwrap(),
            vec!["proxy", "ls", "-la"]
        );
        // Split tokens carrying leading dashes are NOT option-injection-guarded
        // (a wrapped command legitimately has flags).
        assert_eq!(
            expand_arg_specs(&specs, &serde_json::json!({ "command": "grep -rn foo" })).unwrap(),
            vec!["grep", "-rn", "foo"]
        );
    }

    #[test]
    fn expand_arg_specs_error_paths() {
        let specs = rtk_specs();
        // Unknown mode → error (mirrors the old mode_prefix rejection).
        assert!(expand_arg_specs(
            &specs,
            &serde_json::json!({ "command": "ls", "mode": "bogus" })
        )
        .is_err());
        // Blank required command → error.
        assert!(expand_arg_specs(&specs, &serde_json::json!({ "command": "   " })).is_err());
        // Missing required command → error.
        assert!(expand_arg_specs(&specs, &serde_json::json!({})).is_err());
        // Unbalanced quotes → parse error, nothing spawned.
        assert!(
            expand_arg_specs(&specs, &serde_json::json!({ "command": "git \"status" })).is_err()
        );
    }

    #[tokio::test]
    async fn command_tool_missing_grant_refused_before_allowlist_io() {
        // No grant → deterministic refusal before any allowlist read or spawn.
        let err = run_command_tool(
            "echo",
            &["{msg}".to_string()],
            None,
            &BTreeMap::new(),
            None,
            5,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({ "msg": "hi" }),
            &grants(&[]),
            "com.test.cmd",
            None,
        )
        .await
        .expect_err("missing grant must be refused");
        assert!(
            err.contains("not granted") && err.contains("tool:command:echo"),
            "{err}"
        );
    }

    /// Run a granted command tool with an `egress_url_arg` pointed at `url` and
    /// return the outcome. The SSRF screen runs after the grant check but BEFORE
    /// allowlist resolution / spawn, so a blocked URL never needs a real binary.
    ///
    /// No `RYU_COMMAND_TOOL_ALLOWLIST` is configured, so a URL that PASSES the
    /// screen fails DOWNSTREAM at allowlist resolution with an error containing
    /// `"allowlist"` — a string the egress screen's own errors (scheme / "blocked
    /// egress to …") never contain. That textual distinction is what lets the
    /// tests below tell "blocked by the screen" apart from "failed later anyway",
    /// so they actually verify the `egress_url_arg` guard rather than passing
    /// vacuously on the allowlist error.
    async fn crawl_url(url: &str) -> Result<Value, String> {
        // Pin the guard to its default posture (ON, no host allowlist) so the
        // assertions don't depend on ambient env; these are the process defaults,
        // so writing them is harmless even if it leaks to a sibling test.
        std::env::set_var("RYU_AGENT_EGRESS_SSRF_GUARD", "1");
        std::env::remove_var("RYU_AGENT_EGRESS_ALLOW_HOSTS");
        run_command_tool(
            "spider",
            &["crawl".to_string(), "--".to_string(), "{url}".to_string()],
            None,
            &BTreeMap::new(),
            None,
            5,
            CommandOutput::Json,
            Some("url"),
            &BTreeMap::new(),
            serde_json::json!({ "url": url }),
            &grants(&["tool:command:spider"]),
            "spider",
            None,
        )
        .await
    }

    /// A URL was rejected BY THE EGRESS SCREEN (not by some later stage): it is an
    /// error, and that error is NOT the downstream allowlist error.
    fn assert_blocked_by_screen(res: &Result<Value, String>, what: &str) {
        let err = res.as_ref().expect_err(what);
        assert!(
            !err.contains("allowlist"),
            "{what}: expected an egress-screen rejection, but the error came from \
             allowlist resolution (screen let it through): {err}"
        );
    }

    // The following tests re-host the SSRF contract previously guarded by the
    // deleted native `sidecar/mcp/spider.rs` provider (its `non_http_scheme`,
    // `flag_smuggling`, `metadata_ip`, `private_ip` tests) onto the generic
    // `command` backend's `egress_url_arg` screen — the crawler is now declarative.

    #[tokio::test]
    async fn command_tool_egress_passes_public_ip_to_allowlist() {
        // POSITIVE CONTROL: a public literal IP must PASS the screen (proving the
        // screen discriminates and is not a block-everything no-op). With no
        // command allowlist configured it then fails DOWNSTREAM — and that error
        // DOES mention the allowlist, which is exactly what the negative assertion
        // in the blocked tests keys off of.
        let err = crawl_url("http://93.184.216.34/")
            .await
            .expect_err("no allowlist configured, so it fails after the screen");
        assert!(
            err.contains("allowlist"),
            "a public IP must pass the screen and reach allowlist resolution, got: {err}"
        );
    }

    #[tokio::test]
    async fn command_tool_egress_rejects_non_http_scheme() {
        assert_blocked_by_screen(
            &crawl_url("file:///etc/passwd").await,
            "file:// must be rejected",
        );
        assert_blocked_by_screen(
            &crawl_url("ftp://example.com").await,
            "ftp:// must be rejected",
        );
    }

    #[tokio::test]
    async fn command_tool_egress_rejects_flag_smuggling_url() {
        // A flag-shaped "url" is not valid http/https, so the scheme screen catches
        // it before it can ever reach argv as an injected option.
        assert_blocked_by_screen(
            &crawl_url("--config=/etc/shadow").await,
            "flag-like URL must be rejected",
        );
    }

    #[tokio::test]
    async fn command_tool_egress_blocks_metadata_ip() {
        assert_blocked_by_screen(
            &crawl_url("http://169.254.169.254/").await,
            "cloud metadata IP must be blocked before any spawn",
        );
    }

    #[tokio::test]
    async fn command_tool_egress_blocks_private_ip() {
        for url in [
            "http://10.0.0.1/",
            "http://127.0.0.1/",
            "https://192.168.1.1/",
        ] {
            assert_blocked_by_screen(
                &crawl_url(url).await,
                &format!("private/loopback IP {url} must be blocked"),
            );
        }
    }

    #[tokio::test]
    async fn command_tool_unknown_bin_refused_with_no_spawn() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        std::env::remove_var(ENV_COMMAND_TOOL_ALLOWLIST);
        let err = run_command_tool(
            "echo",
            &[],
            None,
            &BTreeMap::new(),
            None,
            5,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:echo"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect_err("unknown bin (empty allowlist) must be refused");
        assert!(err.contains("command allowlist"), "{err}");
    }

    /// Arm the fail-open gateway posture + disarm the exec-approval scan so a
    /// spawn test reaches the actual child (the scan is armed BY DEFAULT and the
    /// budget gate fails CLOSED on an unreachable gateway), and RESTORE those
    /// process-global vars on drop so the posture never leaks into sibling tests.
    /// Must be constructed while holding [`lock_gateway_env`].
    struct CmdEnvGuard {
        previous_gateway_url: Option<String>,
        previous_fallback: Option<String>,
        previous_exec_mode: Option<String>,
        previous_allowlist: Option<String>,
    }
    impl CmdEnvGuard {
        fn armed() -> Self {
            let previous_gateway_url = std::env::var("RYU_GATEWAY_URL").ok();
            let previous_fallback = std::env::var("RYU_ALLOW_GATEWAY_FALLBACK").ok();
            let previous_exec_mode = std::env::var("RYU_EXEC_APPROVAL_MODE").ok();
            let previous_allowlist = std::env::var(ENV_COMMAND_TOOL_ALLOWLIST).ok();
            // A live default Gateway may belong to another local process and return
            // 401 for this test's local bearer. Force the documented unreachable
            // path so the fallback posture is deterministic.
            std::env::set_var("RYU_GATEWAY_URL", "http://127.0.0.1:1");
            std::env::set_var("RYU_ALLOW_GATEWAY_FALLBACK", "1");
            std::env::set_var("RYU_EXEC_APPROVAL_MODE", "off");
            Self {
                previous_gateway_url,
                previous_fallback,
                previous_exec_mode,
                previous_allowlist,
            }
        }
    }
    impl Drop for CmdEnvGuard {
        fn drop(&mut self) {
            restore_env("RYU_GATEWAY_URL", self.previous_gateway_url.take());
            restore_env("RYU_ALLOW_GATEWAY_FALLBACK", self.previous_fallback.take());
            restore_env("RYU_EXEC_APPROVAL_MODE", self.previous_exec_mode.take());
            restore_env(ENV_COMMAND_TOOL_ALLOWLIST, self.previous_allowlist.take());
        }
    }

    fn restore_env(name: &str, value: Option<String>) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }

    #[tokio::test]
    async fn command_tool_no_shell_metachars_are_literal() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("echo"));
        // A value packed with shell metacharacters must arrive as ONE literal argv
        // element — proving there is no shell (this asserts literal argv, NOT scan
        // denial; the scan is disarmed in this test env).
        let payload = "; echo $(whoami) `id` && echo pwned";
        let (_script_dir, command_args) = test_command_args("echo", &["msg"]);
        let out = run_command_tool(
            "echo",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            10,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({ "msg": payload }),
            &grants(&["tool:command:echo"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("echo runs");
        let stdout = out
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            stdout.contains(payload),
            "metachars must be literal, got: {stdout:?}"
        );
        assert_eq!(out.get("exit_code").and_then(|v| v.as_i64()), Some(0));
    }

    #[tokio::test]
    async fn command_tool_timeout_kills_child() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("sleep"));
        let (_script_dir, command_args) = test_command_args("sleep", &[]);
        let out = run_command_tool(
            "sleep",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            1, // 1s timeout vs a 30s sleep
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:sleep"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("a timed-out command degrades gracefully (turn-continuation), not Err");
        // Graceful degradation: the child was killed and the result is a soft
        // {available:false} envelope naming the timeout (the audit still records
        // exit 124 independently).
        assert_eq!(out.get("available").and_then(Value::as_bool), Some(false));
        assert!(
            out.get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("timed out"),
            "reason must name the timeout, got: {out}"
        );
    }

    #[tokio::test]
    async fn command_tool_output_cap_and_stderr_drain() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("dd"));
        let (_script_dir, command_args) = test_command_args("dd", &[]);
        // The test command writes ~2 MiB of zeros to stdout (> the 1 MiB cap) and
        // reports on stderr;
        // the bounded read must cap stdout and the concurrent stderr drain must keep
        // the child from deadlocking on a full stderr pipe.
        let out = run_command_tool(
            "dd",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            20,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:dd"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("dd runs to completion without deadlock");
        assert_eq!(out.get("truncated").and_then(|v| v.as_bool()), Some(true));
        // The `stdout` field now carries the bounded stdout PLUS the merged (also
        // bounded) stderr, so each stream is capped at MAX and the field stays
        // bounded by 2×MAX — the child never deadlocks and memory stays bounded.
        let len = out
            .get("stdout")
            .and_then(|v| v.as_str())
            .map(str::len)
            .unwrap_or(0);
        assert!(
            len <= 2 * MAX_COMMAND_OUTPUT_BYTES,
            "merged output must stay bounded, was {len}"
        );
        // The test command reports its transfer on stderr — proof the merge fired.
        let stdout = out
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            stdout.contains("records"),
            "dd's stderr stats must be merged into the output"
        );
    }

    #[tokio::test]
    async fn command_tool_json_output_parsed_and_invalid_errors() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("echo"));
        let (_script_dir, command_args) = test_command_args("echo", &["payload"]);
        // Valid JSON passed via an interpolated arg is parsed into the result.
        let out = run_command_tool(
            "echo",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            10,
            CommandOutput::Json,
            None,
            &BTreeMap::new(),
            serde_json::json!({ "payload": "{\"a\":1}" }),
            &grants(&["tool:command:echo"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("json echo runs");
        assert_eq!(out.get("a").and_then(|v| v.as_i64()), Some(1));
        // Non-JSON stdout under output=json degrades gracefully (spider's posture):
        // the agent still receives the raw text as `content`, not a hard error.
        let soft = run_command_tool(
            "echo",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            10,
            CommandOutput::Json,
            None,
            &BTreeMap::new(),
            serde_json::json!({ "payload": "not json" }),
            &grants(&["tool:command:echo"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("non-JSON stdout under output=json degrades to raw content, not Err");
        assert_eq!(soft.get("available").and_then(Value::as_bool), Some(true));
        assert!(
            soft.get("content")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("not json"),
            "raw stdout must be surfaced as content, got: {soft}"
        );
    }

    #[tokio::test]
    async fn command_tool_env_injects_declared_and_scrubs_secrets() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("env"));
        let (_script_dir, command_args) = test_command_args("env", &[]);
        // The source var sits in THIS plugin's own `RYU_PLUGIN_<ID>_` namespace, which
        // is what `may_read_env_secret` admits for a disk manifest. It used to be a
        // bare `RYU_CMD_TEST_SRC`; that only worked because the child-env `env:` arm
        // was ungated, so keeping it would mean this test silently asserted the hole.
        // The gate's REFUSAL path has its own test
        // (`a_command_tools_child_env_obeys_the_same_namespace_gate_as_headers`).
        std::env::set_var("RYU_PLUGIN_COM_TEST_CMD_SRC", "injected-value");
        assert_eq!(
            std::env::var("RYU_PLUGIN_COM_TEST_CMD_SRC").as_deref(),
            Ok("injected-value")
        );
        assert!(may_read_env_secret(
            "com.test.cmd",
            "RYU_PLUGIN_COM_TEST_CMD_SRC"
        ));
        // A secret-shaped inherited var that must be scrubbed from the child.
        std::env::set_var("RYU_CMD_TEST_SECRET_TOKEN", "leak-me");
        let mut env_map = BTreeMap::new();
        env_map.insert(
            "RYU_CMD_TEST_DEST".to_string(),
            "env:RYU_PLUGIN_COM_TEST_CMD_SRC".to_string(),
        );
        let out = run_command_tool(
            "env",
            &command_args,
            None,
            &env_map,
            None,
            10,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:env"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("env runs");
        assert_eq!(
            out.get("available"),
            None,
            "env command should execute, got unavailable payload: {out}"
        );
        let stdout = out
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            stdout.contains("RYU_CMD_TEST_DEST=injected-value"),
            "declared env var must be injected, got: {stdout}"
        );
        assert!(
            !stdout.contains("leak-me") && !stdout.contains("RYU_CMD_TEST_SECRET_TOKEN"),
            "secret-shaped inherited var must be scrubbed, got: {stdout}"
        );
        std::env::remove_var("RYU_PLUGIN_COM_TEST_CMD_SRC");
        std::env::remove_var("RYU_CMD_TEST_SECRET_TOKEN");
    }

    // ── #4 command graceful degradation + #3 allowlist seeding + #5 clamp ────────

    #[tokio::test]
    async fn command_tool_allowlisted_but_absent_file_degrades_gracefully() {
        // An allowlisted key whose file does not exist is an OPERATIONAL failure →
        // graceful {available:false} "not installed", NOT a fail-closed Err (which
        // is reserved for an UNKNOWN/unlisted key — the security control).
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        let missing_dir = tempfile::tempdir().expect("missing command tempdir");
        let missing_path = missing_dir.path().join("ghost-binary");
        std::env::set_var(
            ENV_COMMAND_TOOL_ALLOWLIST,
            format!("ghost={}", missing_path.display()),
        );
        let out = run_command_tool(
            "ghost",
            &[],
            None,
            &BTreeMap::new(),
            None,
            5,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:ghost"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("an allowlisted-but-not-installed bin degrades gracefully, not Err");
        assert_eq!(out.get("available").and_then(Value::as_bool), Some(false));
        assert!(
            out.get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .contains("not installed"),
            "reason must say not installed, got: {out}"
        );
    }

    #[test]
    fn builtin_command_seed_covers_only_trusted_builtin_bins() {
        // The trusted command keys are seeded independently of the runtime
        // manifest catalog, and an untrusted/user manifest bin never could be.
        // Pure — never touches the process-global OnceLock.
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        // Deterministic paths regardless of the dev box's PATH.
        std::env::set_var("RYU_SPIDER_BIN", "/opt/ryu/bin/spider");
        std::env::set_var("RYU_RTK_BIN", "/opt/ryu/bin/rtk");
        std::env::set_var("RYU_BWS_BIN", "/opt/ryu/bin/bws");
        let seed = builtin_command_seed();
        assert_eq!(
            seed.get("spider"),
            Some(&std::path::PathBuf::from("/opt/ryu/bin/spider"))
        );
        assert_eq!(
            seed.get("rtk"),
            Some(&std::path::PathBuf::from("/opt/ryu/bin/rtk"))
        );
        assert_eq!(
            seed.get("bws"),
            Some(&std::path::PathBuf::from("/opt/ryu/bin/bws"))
        );
        // No arbitrary/untrusted bin is ever auto-allowlisted.
        assert!(!seed.contains_key("bash"));
        assert!(!seed.contains_key("echo"));
        std::env::remove_var("RYU_SPIDER_BIN");
        std::env::remove_var("RYU_RTK_BIN");
        std::env::remove_var("RYU_BWS_BIN");
    }

    #[test]
    fn trusted_command_keys_are_independent_of_builtin_manifests() {
        assert_eq!(TRUSTED_COMMAND_BIN_KEYS, &["spider", "rtk", "bws"]);
        let seed = builtin_command_seed();
        let keys = seed.keys().map(String::as_str).collect::<Vec<_>>();
        assert_eq!(keys, ["bws", "rtk", "spider"]);
    }

    #[test]
    fn merge_command_allowlist_env_wins_and_is_additive() {
        let seed_spider = test_absolute_path("/seed/spider");
        let seed_rtk = test_absolute_path("/seed/rtk");
        let env_spider = test_absolute_path("/env/spider");
        let env_extra = test_absolute_path("/env/extra");
        let mut seed = BTreeMap::new();
        seed.insert("spider".to_owned(), seed_spider.clone());
        seed.insert("rtk".to_owned(), seed_rtk.clone());
        let env = parse_command_allowlist(&format!(
            "spider={}, extra={}",
            env_spider.display(),
            env_extra.display()
        ));
        let merged = merge_command_allowlist(&seed, env);
        // Env overrides a seeded key …
        assert_eq!(merged.get("spider"), Some(&env_spider));
        // … keeps a seed-only key …
        assert_eq!(merged.get("rtk"), Some(&seed_rtk));
        // … and adds an env-only key.
        assert_eq!(merged.get("extra"), Some(&env_extra));
    }

    #[tokio::test]
    async fn command_tool_clamps_and_defaults_from_input_schema() {
        // #5: bounds sourced from input_schema clamp at render time via the
        // `command_args` path (so spider's real `depth`/`limit` flow is exercised),
        // and an integral clamp renders as "10", not "10.0".
        use crate::plugin_manifest::schema::extract_arg_bounds;
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("echo"));
        let (_script_dir, command_args) = test_command_args("echo", &["depth", "limit"]);
        let bounds = extract_arg_bounds(Some(&serde_json::json!({
            "properties": {
                "depth": { "type": "integer", "default": 1, "maximum": 10 },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
            }
        })));
        // depth=9999 clamps to 10; limit=0 clamps to 1 — both echoed as integers.
        let out = run_command_tool(
            "echo",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            10,
            CommandOutput::Stdout,
            None,
            &bounds,
            serde_json::json!({ "depth": 9999, "limit": 0 }),
            &grants(&["tool:command:echo"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("echo runs");
        let stdout = out
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert_eq!(stdout.trim(), "10 1", "clamped integers, got: {stdout:?}");

        // Absent depth falls back to its schema default (1).
        let (_script_dir2, command_args2) = test_command_args("echo", &["depth"]);
        let out2 = run_command_tool(
            "echo",
            &command_args2,
            None,
            &BTreeMap::new(),
            None,
            10,
            CommandOutput::Stdout,
            None,
            &bounds,
            serde_json::json!({ "limit": 5 }),
            &grants(&["tool:command:echo"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("echo runs");
        assert_eq!(
            out2.get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim(),
            "1",
            "absent depth must use the schema default"
        );
    }

    // ── #1 http secret headers + fail-open ───────────────────────────────────────

    #[test]
    fn build_rest_request_injects_resolved_secret_header() {
        // A pre-resolved secret header rides onto the request without ever being a
        // model arg: it is not consumed from `args`, not required, and never in the
        // url/query/body.
        let (final_url, query, body, headers) = build_rest_request(
            "https://api.exa.ai/search",
            &serde_json::json!({ "query": "hi" }),
            false,
            &[],
            &[("Authorization".to_owned(), "Bearer abc".to_owned())],
        )
        .unwrap();
        assert_eq!(final_url, "https://api.exa.ai/search");
        assert!(query.is_empty());
        assert!(
            headers
                .iter()
                .any(|(n, v)| n == "Authorization" && v == "Bearer abc"),
            "secret header must be present"
        );
        // The body still carries the real arg, and NOT the secret name.
        assert_eq!(body.get("query").and_then(Value::as_str), Some("hi"));
        assert!(body.get("Authorization").is_none());
    }

    #[test]
    fn build_rest_request_secret_header_absent_when_empty() {
        let (_url, _q, _body, headers) = build_rest_request(
            "https://api.example.com/x",
            &serde_json::json!({ "X-Head": "v", "q": "1" }),
            true,
            &["X-Head".to_owned()],
            &[],
        )
        .unwrap();
        // Only the declared header_params entry, no secret header (back-compat).
        assert_eq!(headers, vec![("X-Head".to_owned(), "v".to_owned())]);
    }

    #[test]
    fn finalize_http_result_matrix() {
        // Default `unwrap_body=false` throughout this matrix (envelope behavior).
        // fail_open=false: transport err → Err; any response → Ok({status,body}).
        let (r, exit, err) =
            finalize_http_result(false, false, None, Value::Null, Some("boom".to_owned()));
        assert!(r.is_err() && exit == 1 && err.as_deref() == Some("boom"));
        let (r, exit, _) = finalize_http_result(
            false,
            false,
            Some(200),
            serde_json::json!({ "ok": 1 }),
            None,
        );
        assert_eq!(r.unwrap()["status"], 200);
        assert_eq!(exit, 0);

        // fail_open=true: transport err + 401/403 → Ok(available:false) but audit
        // exit stays 1 (audit-decoupling — outages/auth failures never vanish).
        let (r, exit, err) =
            finalize_http_result(true, false, None, Value::Null, Some("boom".to_owned()));
        assert_eq!(r.unwrap()["available"], false);
        assert_eq!(exit, 1);
        assert!(err.is_some());
        let (r, exit, _) = finalize_http_result(true, false, Some(401), Value::Null, None);
        assert_eq!(r.unwrap()["available"], false);
        assert_eq!(exit, 1);
        let (r, _, _) = finalize_http_result(true, false, Some(403), Value::Null, None);
        assert_eq!(r.unwrap()["available"], false);
        // Every other status still returns {status,body} even with fail_open.
        let (r, exit, _) =
            finalize_http_result(true, false, Some(404), serde_json::json!("x"), None);
        assert_eq!(r.unwrap()["status"], 404);
        assert_eq!(exit, 1);
        let (r, exit, _) =
            finalize_http_result(true, false, Some(200), serde_json::json!("y"), None);
        assert_eq!(r.unwrap()["status"], 200);
        assert_eq!(exit, 0);
    }

    #[test]
    fn finalize_http_result_unwrap_body_returns_2xx_verbatim() {
        // GAP A: `unwrap_body=true` returns the parsed 2xx body VERBATIM — no
        // `{status,body}` envelope — reproducing the original exa raw-JSON shape.
        let raw = serde_json::json!({ "results": [{ "title": "t", "url": "u" }] });
        let (r, exit, _) = finalize_http_result(false, true, Some(200), raw.clone(), None);
        assert_eq!(r.unwrap(), raw);
        assert_eq!(exit, 0);
        // A 201 is still a success → still unwrapped verbatim.
        let (r, _, _) =
            finalize_http_result(false, true, Some(201), serde_json::json!({ "id": 5 }), None);
        assert_eq!(r.unwrap()["id"], 5);

        // Non-2xx is NOT unwrapped even with unwrap_body: the envelope preserves the
        // status so an error is legible (500 without fail_open).
        let (r, exit, _) =
            finalize_http_result(false, true, Some(500), serde_json::json!("oops"), None);
        let v = r.unwrap();
        assert_eq!(v["status"], 500);
        assert_eq!(v["body"], "oops");
        assert_eq!(exit, 1);

        // fail_open 401/403 still wins over unwrap → {available:false}, not verbatim.
        let (r, exit, _) = finalize_http_result(true, true, Some(401), Value::Null, None);
        assert_eq!(r.unwrap()["available"], false);
        assert_eq!(exit, 1);
    }

    #[test]
    fn deep_merge_json_defaults_under_model_args() {
        // GAP B: manifest `body_defaults` deep-merged UNDER the model body — the
        // model wins on every collision, nested default sub-objects survive omission.
        let defaults = serde_json::json!({
            "num_results": 10,
            "use_autoprompt": true,
            "contents": { "text": true }
        });
        // Model supplies only `query` + overrides `num_results`; omits the rest.
        let model = serde_json::json!({ "query": "cats", "num_results": 3 });
        let mut merged = defaults.clone();
        deep_merge_json(&mut merged, &model);
        assert_eq!(merged["query"], "cats");
        // Model wins on the collision.
        assert_eq!(merged["num_results"], 3);
        // Untouched default carried through.
        assert_eq!(merged["use_autoprompt"], true);
        // Nested default sub-object survives when the model omits it.
        assert_eq!(merged["contents"]["text"], true);

        // A nested object collision merges key-by-key (model wins per leaf).
        let mut merged2 = defaults.clone();
        deep_merge_json(
            &mut merged2,
            &serde_json::json!({ "contents": { "text": false, "summary": true } }),
        );
        assert_eq!(merged2["contents"]["text"], false);
        assert_eq!(merged2["contents"]["summary"], true);
        // Sibling default still present.
        assert_eq!(merged2["num_results"], 10);
    }

    #[test]
    fn exa_search_manifest_resolves_unwrap_and_body_defaults() {
        // GAP A+B, exa success shape: the shipped exa search fixture resolves to an
        // Http backend with unwrap_body ON and the full body_defaults object, so the
        // declarative knobs (not exa-specific code) close both parity gaps.
        use crate::plugin_manifest::schema::{ToolBackend, ToolConfig};
        let cfg: ToolConfig = serde_json::from_value(serde_json::json!({
            "slug": "exa.search",
            "backend": "http",
            "method": "POST",
            "url": "https://api.exa.ai/search",
            "secret_headers": { "Authorization": "env:RYU_EXA_API_KEY" },
            "fail_open": true,
            "unwrap_body": true,
            "body_defaults": {
                "num_results": 10,
                "use_autoprompt": true,
                "contents": { "text": true }
            }
        }))
        .unwrap();
        match cfg.resolve_backend().unwrap() {
            ToolBackend::Http {
                unwrap_body,
                body_defaults,
                fail_open,
                ..
            } => {
                assert!(unwrap_body);
                assert!(fail_open);
                assert_eq!(body_defaults["num_results"], 10);
                assert_eq!(body_defaults["use_autoprompt"], true);
                assert_eq!(body_defaults["contents"]["text"], true);
            }
            other => panic!("expected Http backend, got {other:?}"),
        }

        // A non-object body_defaults is a manifest authoring error.
        let bad: ToolConfig = serde_json::from_value(serde_json::json!({
            "slug": "x", "backend": "http", "url": "https://api.example.com/x",
            "body_defaults": [1, 2, 3]
        }))
        .unwrap();
        assert!(bad.resolve_backend().is_err());
    }

    #[test]
    fn http_unavailable_shape() {
        let v = http_unavailable("nope");
        assert_eq!(v["available"], false);
        assert_eq!(v["reason"], "nope");
        assert!(v["hint"].is_string());
    }

    #[tokio::test]
    async fn resolve_secret_header_source_env_and_unsupported() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        std::env::set_var("RYU_TEST_SECRET_TOK", "Bearer topsecret");
        // env: source resolves without the model supplying anything.
        let v = resolve_secret_header_source(
            "Authorization",
            "env:RYU_TEST_SECRET_TOK",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .unwrap();
        assert_eq!(v.as_deref(), Some("Bearer topsecret"));
        // A missing env var resolves to "absent" (header omitted), NOT an error.
        let none = resolve_secret_header_source(
            "X",
            "env:RYU_TEST_MISSING_XYZ",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .unwrap();
        assert!(none.is_none());
        // An unsupported prefix is a hard error (never a silent skip).
        assert!(
            resolve_secret_header_source("X", "foo:bar", SECRET_HEADER_TEST_PLUGIN, &[], None)
                .await
                .is_err()
        );
        std::env::remove_var("RYU_TEST_SECRET_TOK");
    }

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
    fn allowlist_rejects_an_agent_id_that_only_prefix_matches() {
        let reg = AcpAgentRegistry::new();
        let err = resolve_agent_allowlist(&reg, Some("ryu-forged"))
            .expect_err("authorization must require the exact registered principal");
        assert!(err.contains("unknown agent"));
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
        // internal host (deliberate, install-validated intent). A deliberate
        // internal grant needs no address pin (there is no attacker-raceable DNS
        // lookup), so the guard returns `None`.
        assert_eq!(
            http_ssrf_guard("http://127.0.0.1:9000/health", "127.0.0.1")
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            http_ssrf_guard("http://localhost:9000/health", "localhost")
                .await
                .unwrap(),
            None
        );
        // A literal public IP in the URL also needs no pin — no DNS lookup happens.
        assert_eq!(
            http_ssrf_guard("http://93.184.216.34/", "example.com")
                .await
                .unwrap(),
            None
        );
    }

    /// The pin mechanism the guard hands back MUST actually override reqwest's DNS
    /// resolution. This is the load-bearing half of the F5 DNS-rebinding fix: the
    /// guard screens one set of addresses, and the request has to connect to THOSE,
    /// not re-resolve the name to something else. `evil.test` is a reserved,
    /// never-resolvable name (RFC 6761), so a request that reaches a listener at all
    /// proves reqwest honored the pinned addr instead of resolving the host.
    #[tokio::test]
    async fn resolve_to_addrs_pins_connection_and_skips_re_resolution() {
        // A local listener standing in for "the address the guard validated".
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_addr = listener.local_addr().unwrap();
        let port = local_addr.port();

        // Accept exactly one connection and answer with a minimal HTTP/1.1 200.
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut sock, &mut buf).await;
            tokio::io::AsyncWriteExt::write_all(
                &mut sock,
                b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok",
            )
            .await
            .unwrap();
        });

        // Pin the un-resolvable `evil.test` to the local listener, exactly as
        // `run_http_tool` does with the guard's `Some((host, addrs))`.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs("evil.test", &[local_addr])
            .build()
            .unwrap();

        let resp = client
            .get(format!("http://evil.test:{port}/"))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await
            .expect("request must reach the pinned listener, not re-resolve evil.test");
        assert_eq!(resp.status().as_u16(), 200);
        assert_eq!(resp.text().await.unwrap(), "ok");
        server.await.unwrap();
    }

    // ── `secret_headers` value-TEMPLATE resolution ───────────────────────────

    /// The plugin id every template-grammar test resolves under. A COMPILED-IN id,
    /// so `may_read_env_secret` is unrestricted and these tests keep exercising the
    /// template grammar (literal text, multi-token, absent → omit) rather than the
    /// env-namespace gate, which has its own tests below.
    const SECRET_HEADER_TEST_PLUGIN: &str = "@ryu/shadow";

    #[tokio::test]
    async fn secret_header_bearer_scheme_substitutes_env_token() {
        // "Bearer env:X" → "Bearer <resolved>": the scheme prefix is literal text
        // preserved around the substituted token (the exa 401 fix).
        std::env::set_var("RYU_HDR_TEST_BEARER", "sk-abc123");
        let out = resolve_secret_header_source(
            "Authorization",
            "Bearer env:RYU_HDR_TEST_BEARER",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .expect("valid template resolves");
        assert_eq!(out.as_deref(), Some("Bearer sk-abc123"));
        std::env::remove_var("RYU_HDR_TEST_BEARER");
    }

    #[tokio::test]
    async fn secret_header_multi_token_substitution() {
        // Multiple tokens in one value each resolve; literal separators survive.
        std::env::set_var("RYU_HDR_TEST_ID", "id-9");
        std::env::set_var("RYU_HDR_TEST_SECRET", "shh");
        let out = resolve_secret_header_source(
            "X-Auth",
            "Token env:RYU_HDR_TEST_ID env:RYU_HDR_TEST_SECRET",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .expect("multi-token template resolves");
        assert_eq!(out.as_deref(), Some("Token id-9 shh"));
        std::env::remove_var("RYU_HDR_TEST_ID");
        std::env::remove_var("RYU_HDR_TEST_SECRET");
    }

    #[tokio::test]
    async fn secret_header_whole_value_backcompat() {
        // The degenerate whole-value `env:NAME` still yields the bare secret.
        std::env::set_var("RYU_HDR_TEST_WHOLE", "bare-value");
        let out = resolve_secret_header_source(
            "X-Api-Key",
            "env:RYU_HDR_TEST_WHOLE",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .expect("whole-value template resolves");
        assert_eq!(out.as_deref(), Some("bare-value"));
        std::env::remove_var("RYU_HDR_TEST_WHOLE");
    }

    #[tokio::test]
    async fn secret_header_missing_env_omits_header() {
        // An unset env token → the WHOLE header is omitted (Ok(None)), which with
        // fail_open + a downstream 401 reproduces the exa missing-key path.
        std::env::remove_var("RYU_HDR_TEST_UNSET");
        let out = resolve_secret_header_source(
            "Authorization",
            "Bearer env:RYU_HDR_TEST_UNSET",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .expect("missing env is a soft omit, not an Err");
        assert_eq!(out, None);
    }

    #[tokio::test]
    async fn secret_header_no_token_is_rejected() {
        // A value carrying no `env:`/`vault:` token at all is an unsupported
        // source (never a silent skip) — mirrors the command `env:` rejection.
        let err = resolve_secret_header_source(
            "Authorization",
            "Bearer static",
            SECRET_HEADER_TEST_PLUGIN,
            &[],
            None,
        )
        .await
        .expect_err("a token-less value must be rejected");
        assert!(err.contains("unsupported secret source"), "got: {err}");
    }

    // ── `env:` secret-header namespace gate ──────────────────────────────────

    /// Serializes the tests that mutate process-global env vars. Reuses the SAME
    /// guard the rest of this module already takes (`lock_gateway_env`) rather than
    /// a private mutex — two independent locks would not serialize against each
    /// other, and `RYU_RTK_BIN` in particular is set by both the built-in-seed test
    /// and the PATH-shadowing test below.
    fn lock_env_secret() -> std::sync::MutexGuard<'static, ()> {
        crate::sidecar::gateway::lock_gateway_env()
    }

    /// A Community-tier manifest naming an unrelated credential var must resolve to
    /// "absent" — the header is omitted rather than shipped. `secret_headers` values
    /// are excluded from the firewall/DLP scan and the audit trail by design, so an
    /// unrestricted `env:` read would be an invisible credential transfer to
    /// whatever URL the same manifest names.
    #[tokio::test]
    async fn community_plugin_cannot_read_an_unrelated_env_secret() {
        let _lock = lock_env_secret();
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-victim");
        std::env::remove_var(ENV_SECRET_ALLOWLIST);

        let out = resolve_secret_header_source(
            "X-K",
            "env:ANTHROPIC_API_KEY",
            "com.evil.plugin",
            &[],
            None,
        )
        .await
        .expect("an ungated var is a soft omit, not an Err");
        assert_eq!(
            out, None,
            "a Community plugin must not read a credential outside its own namespace"
        );

        std::env::remove_var("ANTHROPIC_API_KEY");
    }

    /// A third-party plugin's OWN `RYU_PLUGIN_<UPPER(id)>_*` namespace resolves with
    /// no operator configuration at all — the BYOK seam still works, it just lives
    /// in a namespace Core does not use for its own configuration.
    #[tokio::test]
    async fn community_plugin_reads_its_own_prefixed_env_secret() {
        let _lock = lock_env_secret();
        std::env::set_var("RYU_PLUGIN_COM_ACME_WEATHER_API_KEY", "acme-key");
        std::env::remove_var(ENV_SECRET_ALLOWLIST);

        let out = resolve_secret_header_source(
            "Authorization",
            "Bearer env:RYU_PLUGIN_COM_ACME_WEATHER_API_KEY",
            "com.acme.weather",
            &[],
            None,
        )
        .await
        .expect("own-namespace var resolves");
        assert_eq!(out.as_deref(), Some("Bearer acme-key"));

        std::env::remove_var("RYU_PLUGIN_COM_ACME_WEATHER_API_KEY");
    }

    /// NAMESPACE SQUATTING: plugin ids are free-form (a bare kebab id is legal), so
    /// a `RYU_<UPPER(id)>_` prefix would let a plugin name ITSELF after a Core
    /// config family and read that family's secrets — id `master` covering
    /// `RYU_MASTER_KEY` is the worst case, and `gateway`/`ext`/`github`/
    /// `marketplace` are all equally claimable (none is a compiled-in fixture id).
    /// The prefix must therefore live under `RYU_PLUGIN_`, which Core never uses for
    /// its own configuration.
    #[test]
    fn a_plugin_cannot_squat_a_core_env_namespace_by_choosing_its_id() {
        for (squatter_id, core_var) in [
            ("master", "RYU_MASTER_KEY"),
            ("gateway", "RYU_GATEWAY_TOKEN"),
            ("gateway", "RYU_GATEWAY_KEY"),
            ("ext", "RYU_EXT_TOKEN"),
            ("github", "RYU_GITHUB_TOKEN"),
            ("marketplace", "RYU_MARKETPLACE_SIGNING_KEY"),
            ("default-llm", "RYU_DEFAULT_LLM_API_KEY"),
        ] {
            assert!(
                !crate::plugins::builtins::is_compiled_in_manifest(squatter_id),
                "'{squatter_id}' must be claimable by a disk manifest for this test to mean \
                 anything — if it became a built-in id, pick another squatter"
            );
            assert!(
                !may_read_env_secret(squatter_id, core_var),
                "a plugin calling itself '{squatter_id}' must not reach Core's '{core_var}'"
            );
        }
    }

    /// The allowlist var is never readable through the gate it configures (a plugin
    /// whose id folds to `env` sits exactly on `RYU_PLUGIN_ENV_`).
    #[test]
    fn the_env_allowlist_var_is_not_itself_plugin_readable() {
        assert!(!may_read_env_secret("env", ENV_SECRET_ALLOWLIST));
    }

    /// The COMMAND tool's child-env is the crate's SECOND `env:` reader, and the
    /// more dangerous one: a header value stays inside a request Core builds, while
    /// this hands the raw secret to a spawned child that can do anything with it.
    /// It must obey the same namespace gate as `secret_headers` — a disk manifest
    /// declaring `{"env": {"KEY": "env:ANTHROPIC_API_KEY"}}` on an allowlisted binary
    /// must not read Core's env.
    ///
    /// This spawns a platform-native environment command and reads the child's
    /// actual environment rather than asserting `may_read_env_secret` directly.
    /// Asserting the predicate would
    /// be vacuous: it passes whether or not the spawn path consults it, which is
    /// exactly the bug being guarded against (the gate existed for `secret_headers`
    /// and this path simply did not call it).
    #[tokio::test]
    async fn a_command_tools_child_env_obeys_the_same_namespace_gate_as_headers() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("env"));
        let (_script_dir, command_args) = test_command_args("env", &[]);

        let disk_plugin = "evil";
        assert!(
            !crate::plugins::builtins::is_compiled_in_manifest(disk_plugin),
            "'{disk_plugin}' must be a disk-manifest id for this test to mean anything"
        );
        // This models the ACTUAL attack. The child inherits Core's env with
        // `scrub_child_env` applied, which already strips secret-SHAPED keys — so a
        // real secret (ANTHROPIC_API_KEY, RYU_MASTER_KEY, RYU_TOKEN) never rides in
        // by inheritance. The declared `env:` map was the way to put one BACK, under
        // a fresh name the scrubber has no opinion about. So the victim var here must
        // itself be secret-shaped (hence `_TOKEN`): that proves the gate closes the
        // re-introduction path rather than re-proving what the scrubber already does.
        std::env::set_var("RYU_CMD_VICTIM_TOKEN", "victim-secret");
        let mut env_map = BTreeMap::new();
        env_map.insert("STOLEN".to_string(), "env:RYU_CMD_VICTIM_TOKEN".to_string());

        let out = run_command_tool(
            "env",
            &command_args,
            None,
            &env_map,
            None,
            10,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:env"]),
            disk_plugin,
            None,
        )
        .await
        .expect("env runs");
        let stdout = out
            .get("stdout")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            !stdout.contains("victim-secret") && !stdout.contains("STOLEN="),
            "an out-of-namespace env source must never reach the child, got: {stdout}"
        );
        std::env::remove_var("RYU_CMD_VICTIM_TOKEN");
    }

    /// The operator escape hatch: a var named in `RYU_PLUGIN_ENV_ALLOWLIST` is
    /// readable by any plugin, so a deployment can share a credential without
    /// handing out a Core-tier id.
    #[tokio::test]
    async fn operator_allowlist_opens_a_shared_env_secret() {
        let _lock = lock_env_secret();
        std::env::set_var("RYU_SHARED_PROXY_KEY", "shared");
        std::env::set_var(ENV_SECRET_ALLOWLIST, "OTHER_VAR, RYU_SHARED_PROXY_KEY");

        let out = resolve_secret_header_source(
            "X-K",
            "env:RYU_SHARED_PROXY_KEY",
            "com.acme.weather",
            &[],
            None,
        )
        .await
        .expect("allowlisted var resolves");
        assert_eq!(out.as_deref(), Some("shared"));

        std::env::remove_var(ENV_SECRET_ALLOWLIST);
        std::env::remove_var("RYU_SHARED_PROXY_KEY");
    }

    /// First-party regression: `@ryu/advisor` and `shadow` authenticate to
    /// loopback Core with the SHARED `env:RYU_TOKEN`, which by construction fits no
    /// per-plugin prefix. Both ship as compiled-in fixtures, so the gate must not
    /// touch them — and `@ryu/advisor` is Community-TIER, which is exactly why
    /// the gate keys on provenance rather than tier. The live node token wins over
    /// the process environment so rotation never races a child spawn.
    #[tokio::test]
    async fn compiled_in_plugins_still_read_the_shared_ryu_token() {
        let _lock = lock_env_secret();
        std::env::remove_var(ENV_SECRET_ALLOWLIST);
        let expected = crate::node_token::active_token().expect("node token is available");
        let expected_header = format!("Bearer {expected}");

        for plugin_id in ["@ryu/shadow", "@ryu/advisor"] {
            let out = resolve_secret_header_source(
                "Authorization",
                "Bearer env:RYU_TOKEN",
                plugin_id,
                &[],
                None,
            )
            .await
            .expect("core-tier read resolves");
            assert_eq!(
                out.as_deref(),
                Some(expected_header.as_str()),
                "{plugin_id} must keep reading the shared RYU_TOKEN"
            );
        }
    }

    /// The prefix is a BYOK seam of the same SHAPE first-party manifests author
    /// (`exa` reads `env:RYU_EXA_API_KEY`), but rooted one level deeper so it cannot
    /// reach into Core's own configuration namespace. `exa` is compiled in and takes
    /// the provenance arm at runtime; a third-party plugin authored the same way
    /// names its var `RYU_PLUGIN_<ID>_API_KEY` and needs no operator configuration.
    #[test]
    fn the_prefix_rule_is_rooted_under_the_plugin_namespace() {
        assert_eq!(plugin_env_prefix("@ryu/exa"), "RYU_PLUGIN_RYU_EXA_");
        assert!("RYU_PLUGIN_RYU_EXA_API_KEY".starts_with(&plugin_env_prefix("@ryu/exa")));
        // Crucially NOT Core's own `RYU_EXA_API_KEY` namespace — which `exa` still
        // reads, but by PROVENANCE (it is compiled in), not by prefix. Every in-repo
        // manifest that authors an `env:` secret header (`exa`, `shadow`, `advisor`)
        // is a compiled-in fixture, so narrowing the prefix regresses none of them.
        assert!(!"RYU_EXA_API_KEY".starts_with(&plugin_env_prefix("@ryu/exa")));
        assert!(may_read_env_secret("@ryu/exa", "RYU_EXA_API_KEY"));
        // Dots and dashes in a reverse-DNS id fold to `_`.
        assert_eq!(
            plugin_env_prefix("com.acme.my-app"),
            "RYU_PLUGIN_COM_ACME_MY_APP_"
        );
        // And the rule is a real fence: the shared loopback token fits no prefix.
        assert!(!may_read_env_secret("com.acme.weather", "RYU_TOKEN"));
    }

    // ── `env:` → encrypted plugin secret store fallback ──────────────────────

    /// THE GAP THIS CLOSES: `exa`/`tavily` declare `env:RYU_<X>_API_KEY` and there
    /// was no way to set such a var from the UI, so swapping the `web.search`
    /// capability to a provider whose key was never exported produced a silently
    /// unauthenticated tool. With the store wired, the SAME manifest token resolves
    /// from an encrypted row — no manifest edit anywhere.
    #[tokio::test]
    async fn an_unset_env_var_falls_back_to_the_plugin_secret_store() {
        let _lock = lock_env_secret();
        std::env::remove_var("RYU_TAVILY_API_KEY");
        std::env::remove_var(ENV_SECRET_ALLOWLIST);

        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        store
            .set("@ryu/tavily", "RYU_TAVILY_API_KEY", "tvly-from-ui")
            .await
            .unwrap();

        let out = resolve_env_secret_from("@ryu/tavily", "RYU_TAVILY_API_KEY", Some(&store)).await;
        assert_eq!(out, SecretToken::Value("tvly-from-ui".to_string()));

        // With no store published at all, behaviour is exactly the pre-store one.
        assert_eq!(
            resolve_env_secret_from("@ryu/tavily", "RYU_TAVILY_API_KEY", None).await,
            SecretToken::Absent
        );
    }

    /// Precedence is env-then-store, never the reverse: an operator who exported the
    /// var in a service unit must see that value in effect, and must be able to
    /// explain the process with `env | grep`. A stale UI entry silently shadowing
    /// the deployment's own configuration is the failure this pins.
    #[tokio::test]
    async fn the_process_environment_wins_over_a_stored_secret() {
        let _lock = lock_env_secret();
        std::env::set_var("RYU_TAVILY_API_KEY", "tvly-from-env");
        std::env::remove_var(ENV_SECRET_ALLOWLIST);

        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        store
            .set("@ryu/tavily", "RYU_TAVILY_API_KEY", "tvly-from-ui")
            .await
            .unwrap();

        let out = resolve_env_secret_from("@ryu/tavily", "RYU_TAVILY_API_KEY", Some(&store)).await;
        assert_eq!(out, SecretToken::Value("tvly-from-env".to_string()));

        std::env::remove_var("RYU_TAVILY_API_KEY");
    }

    #[test]
    fn live_node_token_wins_over_the_startup_environment_after_rotation() {
        assert_eq!(
            resolve_process_env_value("RYU_TOKEN", Some("live-token"), Some("startup-token")),
            Some("live-token".to_owned())
        );
        assert_eq!(
            resolve_process_env_value(
                "RYU_TAVILY_API_KEY",
                Some("unrelated-node-token"),
                Some("provider-key")
            ),
            Some("provider-key".to_owned())
        );
    }

    /// THE LOAD-BEARING GUARD. The store is keyed by the CALLING plugin id, so
    /// without the namespace gate a disk manifest could name any variable and read
    /// whatever the UI had stored under that name for it — turning a write-only
    /// settings field into a credential-harvesting surface. The gate must run BEFORE
    /// the fallback, not only before the env read.
    ///
    /// Asserted through `resolve_env_secret_from` (the real path) rather than
    /// against `may_read_env_secret` directly: the predicate passes whether or not
    /// the fallback consults it, which is exactly the bug being guarded against.
    #[tokio::test]
    async fn the_namespace_gate_also_guards_the_store_fallback() {
        let _lock = lock_env_secret();
        std::env::remove_var(ENV_SECRET_ALLOWLIST);
        std::env::remove_var("ANTHROPIC_API_KEY");

        let evil = "com.evil.plugin";
        assert!(
            !crate::plugins::builtins::is_compiled_in_manifest(evil),
            "'{evil}' must be a disk-manifest id for this test to mean anything"
        );

        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        // The attacker stored a value under its OWN row, using a name outside its
        // namespace. The row exists; the gate is the only thing standing between the
        // manifest token and the value.
        store
            .set(evil, "ANTHROPIC_API_KEY", "stolen-shape")
            .await
            .unwrap();

        assert_eq!(
            resolve_env_secret_from(evil, "ANTHROPIC_API_KEY", Some(&store)).await,
            SecretToken::Absent,
            "a plugin must not reach a stored secret named outside its namespace"
        );
        // Its own namespace still works — the gate is a fence, not a wall.
        store
            .set(evil, "RYU_PLUGIN_COM_EVIL_PLUGIN_API_KEY", "mine")
            .await
            .unwrap();
        assert_eq!(
            resolve_env_secret_from(evil, "RYU_PLUGIN_COM_EVIL_PLUGIN_API_KEY", Some(&store)).await,
            SecretToken::Value("mine".to_string())
        );
    }

    /// An empty stored value is "absent", matching the env branch's
    /// `.filter(|v| !v.is_empty())` — so the whole header is omitted rather than a
    /// `Bearer ` with nothing after it being shipped to the provider.
    #[tokio::test]
    async fn an_empty_stored_secret_resolves_to_absent() {
        let _lock = lock_env_secret();
        std::env::remove_var("RYU_PLUGIN_COM_ACME_WEATHER_API_KEY");
        std::env::remove_var(ENV_SECRET_ALLOWLIST);

        let store = crate::plugin_secrets::PluginSecretStore::in_memory().unwrap();
        store
            .set(
                "com.acme.weather",
                "RYU_PLUGIN_COM_ACME_WEATHER_API_KEY",
                "k",
            )
            .await
            .unwrap();
        // Clearing it through the same API used by `PUT` with a blank body.
        store
            .set(
                "com.acme.weather",
                "RYU_PLUGIN_COM_ACME_WEATHER_API_KEY",
                "  ",
            )
            .await
            .unwrap();

        assert_eq!(
            resolve_env_secret_from(
                "com.acme.weather",
                "RYU_PLUGIN_COM_ACME_WEATHER_API_KEY",
                Some(&store)
            )
            .await,
            SecretToken::Absent
        );
    }

    // ── built-in command-bin allowlist seed ──────────────────────────────────

    /// The `rtk` allowlist entry must resolve to an operator-set absolute override
    /// or Ryu's own `~/.ryu/bin/rtk` — never to a `$PATH` walk. `parse_command_allowlist`
    /// documents "never a PATH-relative name an attacker could shadow" and enforces
    /// it for env-supplied entries; the built-in seed feeds the same allowlist, so a
    /// writable directory early on Core's PATH must not be able to plant the bin the
    /// model can then invoke.
    #[test]
    fn rtk_builtin_bin_never_resolves_through_path() {
        let _lock = lock_env_secret();

        let planted_dir =
            std::env::temp_dir().join(format!("ryu-rtk-shadow-{}", std::process::id()));
        std::fs::create_dir_all(&planted_dir).expect("temp dir");
        let exe = if cfg!(windows) { "rtk.exe" } else { "rtk" };
        let planted = planted_dir.join(exe);
        std::fs::write(&planted, b"#!/bin/sh\n").expect("plant a shadowing rtk");

        let prev_path = std::env::var_os("PATH");
        let prev_bin = std::env::var_os("RYU_RTK_BIN");
        std::env::remove_var("RYU_RTK_BIN");
        std::env::set_var("PATH", &planted_dir);

        let resolved = trusted_builtin_bin_path("rtk").expect("rtk is a known built-in key");

        match prev_path {
            Some(v) => std::env::set_var("PATH", v),
            None => std::env::remove_var("PATH"),
        }
        if let Some(v) = prev_bin {
            std::env::set_var("RYU_RTK_BIN", v);
        }
        let _ = std::fs::remove_dir_all(&planted_dir);

        assert_ne!(
            resolved, planted,
            "a PATH-planted rtk must never become the allowlisted binary"
        );
        assert_eq!(
            resolved,
            crate::paths::ryu_dir().join("bin").join("rtk"),
            "rtk must fall back to Ryu's own bin dir, like spider"
        );
    }

    /// The operator override still wins, and `spider`'s arm is untouched.
    #[test]
    fn builtin_bin_env_overrides_still_win() {
        let _lock = lock_env_secret();

        let prev = std::env::var_os("RYU_RTK_BIN");
        let abs = if cfg!(windows) {
            "C:\\ops\\rtk.exe"
        } else {
            "/opt/ops/rtk"
        };
        std::env::set_var("RYU_RTK_BIN", abs);
        let resolved = trusted_builtin_bin_path("rtk").expect("rtk key");
        match prev {
            Some(v) => std::env::set_var("RYU_RTK_BIN", v),
            None => std::env::remove_var("RYU_RTK_BIN"),
        }
        assert_eq!(resolved, std::path::PathBuf::from(abs));
        assert!(trusted_builtin_bin_path("nope").is_none());
    }

    // ── command SUCCESS merges child stderr into the text output ──────────────

    #[tokio::test]
    async fn command_tool_success_merges_stderr_into_output() {
        let _lock = crate::sidecar::gateway::lock_gateway_env();
        let _env = CmdEnvGuard::armed();
        std::env::set_var(ENV_COMMAND_TOOL_ALLOWLIST, test_allowlist_entry("sh"));
        let (_script_dir, command_args) = test_command_args("sh", &[]);
        let out = run_command_tool(
            "sh",
            &command_args,
            None,
            &BTreeMap::new(),
            None,
            10,
            CommandOutput::Stdout,
            None,
            &BTreeMap::new(),
            serde_json::json!({}),
            &grants(&["tool:command:sh"]),
            "com.test.cmd",
            None,
        )
        .await
        .expect("sh runs");
        assert_eq!(out.get("exit_code").and_then(Value::as_i64), Some(0));
        let stdout = out
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(
            stdout.contains("the-stdout"),
            "stdout must be present, got: {stdout:?}"
        );
        assert!(
            stdout.contains("the-stderr"),
            "non-empty stderr must be merged into the output, got: {stdout:?}"
        );
    }

    /// The BYOK providers the layer feature ships MUST pass the namespace gate, or
    /// the settings panel renders "Stored, but this plugin is not allowed to read
    /// this name" on the one feature added to make them configurable.
    ///
    /// They pass by PROVENANCE, not tier: both are Community-tier yet compiled into
    /// the binary, and `is_compiled_in_manifest` is what the gate consults. A future
    /// change that moved either out of `BUILTIN_MANIFESTS` would silently break BYOK
    /// for it, which is what this pins.
    #[test]
    fn the_shipped_byok_providers_may_read_their_own_keys() {
        assert!(may_read_env_secret("@ryu/tavily", "RYU_TAVILY_API_KEY"));
        assert!(may_read_env_secret("@ryu/exa", "RYU_EXA_API_KEY"));
        // And the gate still holds sideways: one plugin cannot read another's key by
        // simply naming it.
        assert!(!may_read_env_secret(
            "acme-thirdparty",
            "RYU_TAVILY_API_KEY"
        ));
    }

    /// `core:` must resolve to the ACTIVE profile's Core port, never a hardcoded
    /// 7980. The bug this pins: under the `dev` profile (what `bun dev` runs) Core
    /// binds 8980, so a hardcoded manifest url reached nothing — or reached a
    /// release-profile Core running alongside it, crossing two profiles' data.
    #[test]
    fn the_core_scheme_resolves_to_this_profiles_loopback_port() {
        // Only the PORT is taken from RYU_BIND; a node bound to 0.0.0.0 is still
        // dialled on loopback, because `http://0.0.0.0/...` is not a route.
        // Only the PORT is taken from RYU_BIND; a node bound to 0.0.0.0 is still
        // dialled on loopback, because `http://0.0.0.0/...` is not a route.
        assert_eq!(core_port_from_bind(Some("0.0.0.0:8980")), 8980);
        assert_eq!(core_port_from_bind(Some("127.0.0.1:7980")), 7980);
        // Absent / malformed falls back through the ONE offset source.
        assert_eq!(
            core_port_from_bind(None),
            crate::profile::port(CORE_BASE_PORT)
        );
        assert_eq!(
            core_port_from_bind(Some("not-a-bind")),
            crate::profile::port(CORE_BASE_PORT)
        );

        let origin = "http://127.0.0.1:8980";
        assert_eq!(
            resolve_core_url_with("core:/api/shadow/search", origin),
            "http://127.0.0.1:8980/api/shadow/search"
        );
        // A leading slash is optional in the manifest and never doubles up.
        assert_eq!(
            resolve_core_url_with("core:api/memory", origin),
            "http://127.0.0.1:8980/api/memory"
        );
    }

    #[test]
    fn a_non_core_url_is_returned_untouched() {
        // The scheme is opt-in: every external provider url must pass through byte
        // for byte, or the egress guard would screen something other than what is
        // dialled.
        for url in [
            "https://api.exa.ai/search",
            "https://api.tavily.com/extract",
            "http://127.0.0.1:9999/whatever",
        ] {
            assert_eq!(resolve_core_url(url), url);
            assert_eq!(resolve_core_url_with(url, "http://127.0.0.1:8980"), url);
        }
    }

    /// Every shipped manifest that addresses Core must use `core:`, or it silently
    /// breaks on a non-release profile. Guards the migration from regressing.
    #[test]
    fn no_shipped_manifest_hardcodes_cores_port() {
        for manifest in crate::plugin_manifest::PluginManifestLoader::load_builtins() {
            for entry in &manifest.runnables {
                let Some(cfg) = entry.config.as_ref() else {
                    continue;
                };
                let raw = cfg.to_string();
                assert!(
                    !raw.contains("127.0.0.1:7980"),
                    "manifest '{}' hardcodes Core's release port; use the core: scheme \
                     so it resolves per profile",
                    manifest.id
                );
            }
        }
    }
}
