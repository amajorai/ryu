//! Built-in `sandbox_exec` MCP tool provider (M6 / issue #190).
//!
//! Exposes the wasmtime sandbox backend as a callable tool through the same
//! registry call surface the rest of the tool loop uses
//! (`McpRegistry::list_all_tools` / `call_tool`), following the in-process
//! provider pattern from `exa.rs` and `self_build.rs`.
//!
//! ## Tool surface
//!
//! A single tool is exposed:
//!   - `sandbox.sandbox_exec` — run a WASM/WASI module and return its
//!     stdout, stderr, and exit code.
//!
//! The tool receives WASM bytecode as a base-64 encoded string (`wasm_b64`)
//! plus optional `args` and `env` arrays.  The wasmtime engine is initialised
//! once at first call and reused.
//!
//! ## Enable / disable toggle
//!
//! The sandbox is enabled by default when the `sandbox-wasmtime` feature is
//! compiled in.  It can be disabled at runtime by setting the environment
//! variable `RYU_SANDBOX_DISABLED=1`.  When disabled, `dispatch()` returns
//! an `{ available: false }` result — the tool is still listed so the agent
//! knows it exists.
//!
//! ## Tool-approval integration (AC#3)
//!
//! `sandbox_exec` is registered through the normal MCP tool loop; it does not
//! add any new approval UI.  Any agent that calls it goes through the existing
//! tool-approval path wired in the ACP adapter (#86 DA7).
//!
//! ## Architecture (Core-vs-Gateway)
//!
//! Deciding *what runs* (which WASM module, which capabilities) is Core.
//! Deciding *what is allowed* (DLP policy on the module's stdout, network
//! egress from the sandbox) is Gateway.  This module enforces only the
//! structural default-deny (no FS preopens, no socket WASI ABI) — policy
//! belongs in the Gateway.

use anyhow::Result;
use base64::Engine as _;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::sidecar::sandbox::{
    build_command_backend, configured_backend, ExecSpec, Sandbox as _, SandboxBackend,
    SandboxCapabilities, SandboxScope, WorkspaceAccess,
};

/// Reserved registry server name for the built-in sandbox provider.
pub const SERVER_NAME: &str = "sandbox";

/// Environment variable to disable the sandbox at runtime.
const ENV_DISABLED: &str = "RYU_SANDBOX_DISABLED";

/// Whether the sandbox is currently enabled (not disabled by env var).
pub fn is_enabled() -> bool {
    std::env::var(ENV_DISABLED).ok().as_deref() != Some("1")
}

/// Set the sandbox enabled state by manipulating the env var.
///
/// Called by `POST /api/mcp/sandbox/enable` and `POST /api/mcp/sandbox/disable`
/// (or toggled from ServicesPage). Setting `RYU_SANDBOX_DISABLED=1` is safe
/// at runtime; the change takes effect on the next `dispatch` call.
pub fn set_enabled(enabled: bool) {
    if enabled {
        // SAFETY: single-threaded mutation guarded by the HTTP handler lock.
        unsafe { std::env::remove_var(ENV_DISABLED) };
    } else {
        unsafe { std::env::set_var(ENV_DISABLED, "1") };
    }
}

// ── Unavailable result ────────────────────────────────────────────────────────

fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
    })
}

// ── Tool schema ───────────────────────────────────────────────────────────────

fn sandbox_exec_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "backend": {
                "type": "string",
                "enum": crate::sidecar::sandbox::KNOWN_BACKENDS,
                "description": "Which sandbox backend to run in. Omit to use the node default \
                                (RYU_SANDBOX_BACKEND, or 'wasmtime'). 'wasmtime' runs a WASM \
                                module (`wasm_b64`); the others run a `command` in a container/microVM."
            },
            "wasm_b64": {
                "type": "string",
                "description": "Base-64 encoded WASM/WASI module bytecode. Required for the 'wasmtime' backend."
            },
            "command": {
                "type": "string",
                "description": "Program to run (argv[0]). Required for the docker/microsandbox/opensandbox/mxc backends."
            },
            "args": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Command-line arguments (after argv[0] / the WASM module)."
            },
            "env": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "key": { "type": "string" },
                        "value": { "type": "string" }
                    },
                    "required": ["key", "value"]
                },
                "description": "Environment variables for the WASM guest (wasmtime backend only; other backends reject it). At most 64 entries."
            },
            "stdin_b64": {
                "type": "string",
                "description": "Base-64 encoded bytes piped to the command's stdin (process backends)."
            },
            "timeout_secs": {
                "type": "integer",
                "description": "Hard wall-clock cap in seconds. Defaults to 30; the wasmtime backend caps it at 30."
            }
        }
    })
}

/// Hard ceiling (and default) for a wasmtime `sandbox_exec` run, in seconds.
const WASMTIME_MAX_TIMEOUT_SECS: u64 = 30;

/// The caller's `timeout_secs` for the wasmtime backend, clamped to
/// `1..=WASMTIME_MAX_TIMEOUT_SECS` so a caller can shorten the run but never
/// lift the ceiling (the backend's own default is longer).
fn wasmtime_timeout_secs(arguments: &Value) -> u64 {
    arguments
        .get("timeout_secs")
        .and_then(Value::as_u64)
        .unwrap_or(WASMTIME_MAX_TIMEOUT_SECS)
        .clamp(1, WASMTIME_MAX_TIMEOUT_SECS)
}

// ── Persistent remote workspace lifecycle tool schemas ───────────────────────

fn sandbox_create_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "budget_micro_usd": {
                "type": "integer",
                "description": "Per-run cap in micro-USD; omit for the node default."
            }
        }
    })
}

fn sandbox_run_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": { "type": "string" },
            "command": { "type": "string" },
            "args": { "type": "array", "items": { "type": "string" } },
            "timeout_secs": { "type": "integer" }
        },
        "required": ["run_id", "command"]
    })
}

fn sandbox_destroy_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "run_id": { "type": "string" }
        },
        "required": ["run_id"]
    })
}

/// The set of sandbox tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        RegistryTool {
            id: format!("{SERVER_NAME}.sandbox_exec"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_exec".to_owned(),
            description: Some(
                "Execute code in an isolated, swappable sandbox backend (default-deny). \
                 `backend` selects the runtime: 'wasmtime' (default) runs a base-64 WASM module \
                 (`wasm_b64`); 'docker', 'microsandbox', 'opensandbox', or 'mxc' run a `command` in a \
                 container/microVM/Windows process container. Process backends receive no caller-controlled FS or network \
                 capabilities. Returns stdout, stderr, and exit code."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_exec_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.sandbox_create"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_create".to_owned(),
            description: Some(
                "Create a long-lived remote Box or Daytona workspace (persistent lifecycle). \
                 Metered per-second until destroyed with `sandbox_destroy`; run commands \
                 against it with `sandbox_run`. Returns `run_id`, `workspace_id`, and backend. \
                 `workspace_id`."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_create_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.sandbox_run"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_run".to_owned(),
            description: Some(
                "Run a command in an existing persistent Box or Daytona workspace created with \
                 `sandbox_create`. Returns stdout, stderr, and exit code."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_run_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}.sandbox_destroy"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_destroy".to_owned(),
            description: Some(
                "Destroy a persistent remote workspace created with `sandbox_create`, \
                 stopping metering. Idempotent — destroying an already-gone sandbox succeeds."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_destroy_schema()),
            ..Default::default()
        },
    ]
}

/// Dispatch a sandbox tool call. `tool` is the bare name (stripped of the
/// `sandbox.` prefix by the registry).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    dispatch_with_context(tool, arguments, None, None).await
}

/// Dispatch a sandbox call while preserving the calling agent and Core session
/// for the Gateway audit row. The original two-argument helper remains for
/// agent-less callers and tests.
pub async fn dispatch_with_context(
    tool: &str,
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value> {
    match tool {
        "sandbox_exec" => run_sandbox_exec(arguments, agent_id, session_id).await,
        "sandbox_create" => run_sandbox_create(arguments, agent_id, session_id).await,
        "sandbox_run" => run_sandbox_run(arguments, agent_id, session_id).await,
        "sandbox_destroy" => run_sandbox_destroy(arguments, agent_id, session_id).await,
        other => Err(anyhow::anyhow!("unknown sandbox tool '{other}'")),
    }
}

// ── Persistent remote workspace lifecycle tool handlers ───────────────────────
//
// These are thin wrappers over the persistent workspace manager in
// `sidecar::sandbox::session`, which selects the configured remote backend. Unlike
// `sandbox_exec` (one-shot create+run+destroy), these keep the workspace alive:
// `sandbox_create` provisions + registers it for per-second metering,
// `sandbox_run` execs against it, and `sandbox_destroy` tears it down + debits
// the residual tail. Persistent tools ignore any `backend` arg by design.

/// Create a persistent remote sandbox. No spec is taken from the tool call, so
/// the billed/provisioned shape is the node's configured provider spec.
async fn run_sandbox_create(
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value> {
    use crate::sidecar::sandbox::session;

    let owner = session::SandboxOwner::from_context(agent_id, session_id.as_deref())?;
    let budget = arguments.get("budget_micro_usd").and_then(Value::as_u64);
    let created = session::create_sandbox_owned(None, budget, owner).await?;
    Ok(json!({
        "run_id": created.run_id,
        "workspace_id": created.workspace_id,
        "backend": created.backend,
    }))
}

/// Run a command in an existing persistent remote sandbox.
async fn run_sandbox_run(
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value> {
    use crate::sidecar::sandbox::session;

    let owner = session::SandboxOwner::from_context(agent_id, session_id.as_deref())?;
    let run_id = arguments
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required argument 'run_id'"))?
        .to_owned();
    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required argument 'command'"))?
        .to_owned();
    let args = parse_str_array(&arguments, "args");
    let timeout_secs = arguments.get("timeout_secs").and_then(Value::as_u64);

    let result =
        session::exec_in_sandbox_owned(&run_id, command, args, timeout_secs, &owner).await?;
    Ok(json!({
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }))
}

/// Destroy a persistent remote sandbox (idempotent).
async fn run_sandbox_destroy(
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value> {
    use crate::sidecar::sandbox::session;

    let owner = session::SandboxOwner::from_context(agent_id, session_id.as_deref())?;
    let run_id = arguments
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required argument 'run_id'"))?
        .to_owned();

    session::destroy_sandbox_owned(&run_id, &owner).await?;
    Ok(json!({ "ok": true }))
}

/// Run the `sandbox_exec` tool, gated through the Gateway exec budget (M6 / #192).
///
/// Flow:
/// 1. Pre-run: ask the gateway whether this exec is permitted (fail-closed).
/// 2. Run the backend (wasmtime or stub when feature is off).
/// 3. Post-run: report the completed event to the gateway audit store (best-effort).
async fn run_sandbox_exec(
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value> {
    if !is_enabled() {
        return Ok(unavailable(
            "The sandbox is disabled. \
             Enable it from the Services page or unset RYU_SANDBOX_DISABLED.",
        ));
    }

    // Resolve which backend to run in: explicit `backend` arg wins, else the
    // node default (RYU_SANDBOX_BACKEND, falling back to wasmtime).
    let backend = resolve_backend(&arguments)?;
    if !matches!(backend, SandboxBackend::Wasmtime) {
        return run_process_exec(backend, arguments, agent_id, session_id).await;
    }

    // ── wasmtime path (default): a base-64 WASM module ───────────────────────
    // Decode the WASM bytes.
    let wasm_b64 = arguments
        .get("wasm_b64")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("missing required argument 'wasm_b64'"))?;

    let wasm_bytes = base64::engine::general_purpose::STANDARD
        .decode(wasm_b64)
        .map_err(|e| anyhow::anyhow!("invalid base64 in 'wasm_b64': {e}"))?;

    // Parse optional args.
    let args: Vec<String> = arguments
        .get("args")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();

    // Parse optional env vars; they become the guest's WASI environment.
    let env = parse_env(&arguments)?;

    // The guest gets deny-all capabilities; the caller may shorten, but not
    // extend, the 30-second cap.
    let timeout_secs = wasmtime_timeout_secs(&arguments);

    // ── Step 1: pre-run gateway budget gate (fail-closed) ────────────────────
    let backend_name = "wasmtime";
    let command_name = "wasm";
    {
        use crate::sidecar::gateway::{check_exec_budget, ExecBudgetOutcome};
        match check_exec_budget(backend_name, command_name).await {
            ExecBudgetOutcome::Allow => {}
            ExecBudgetOutcome::Deny(reason) => {
                return Err(anyhow::anyhow!("exec budget exhausted: {reason}"));
            }
        }
    }

    #[cfg(feature = "sandbox-wasmtime")]
    {
        use crate::sidecar::gateway::{report_exec_audit_with_attribution, ExecAuditAttribution};
        use crate::sidecar::sandbox::wasmtime::WasmtimeSandbox;
        use crate::sidecar::sandbox::{ExecSpec, SandboxCapabilities};

        let sandbox = WasmtimeSandbox::new()
            .map_err(|e| anyhow::anyhow!("failed to initialise wasmtime sandbox: {e}"))?;

        let spec = ExecSpec {
            env,
            command: command_name.to_owned(),
            args,
            capabilities: SandboxCapabilities::default(), // deny-all
            stdin: Some(wasm_bytes),
            timeout_secs: Some(timeout_secs),
        };

        // ── Step 2: run the backend ──────────────────────────────────────────
        let start = std::time::Instant::now();
        let exec_result = tokio::task::spawn_blocking(move || {
            // exec() returns a BoxFuture but the blocking work is synchronous
            // inside (wasmtime is sync).  We run it in a blocking thread to
            // avoid starving the async runtime during the Cranelift JIT.
            use crate::sidecar::sandbox::Sandbox as _;
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .map_err(|e| anyhow::anyhow!("blocking runtime: {e}"))?;
            rt.block_on(sandbox.exec(spec))
        })
        .await
        .map_err(|e| anyhow::anyhow!("sandbox task panicked: {e}"));

        let duration_ms = start.elapsed().as_millis() as u64;
        let attribution = ExecAuditAttribution {
            agent_id: agent_id.map(str::to_owned),
            feature: Some("agent".to_owned()),
            ..Default::default()
        };

        // ── Step 3: post-run audit report (best-effort) ──────────────────────
        match &exec_result {
            Ok(Ok(output)) => {
                report_exec_audit_with_attribution(
                    backend_name,
                    command_name,
                    duration_ms,
                    output.exit_code,
                    session_id.clone(),
                    None,
                    attribution.clone(),
                )
                .await;
            }
            Ok(Err(e)) => {
                report_exec_audit_with_attribution(
                    backend_name,
                    command_name,
                    duration_ms,
                    -1,
                    session_id.clone(),
                    Some(e.to_string()),
                    attribution.clone(),
                )
                .await;
            }
            Err(e) => {
                report_exec_audit_with_attribution(
                    backend_name,
                    command_name,
                    duration_ms,
                    -1,
                    session_id.clone(),
                    Some(format!("task join error: {e}")),
                    attribution,
                )
                .await;
            }
        }

        let output = exec_result??;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

        Ok(json!({
            "exit_code": output.exit_code,
            "stdout": stdout,
            "stderr": stderr,
        }))
    }

    #[cfg(not(feature = "sandbox-wasmtime"))]
    {
        use crate::sidecar::gateway::{report_exec_audit_with_attribution, ExecAuditAttribution};

        // Feature off: report a zero-duration stub event and return unavailable.
        report_exec_audit_with_attribution(
            backend_name,
            command_name,
            0,
            0,
            session_id,
            Some("sandbox-wasmtime feature not compiled in".to_owned()),
            ExecAuditAttribution {
                agent_id: agent_id.map(str::to_owned),
                feature: Some("agent".to_owned()),
                ..Default::default()
            },
        )
        .await;

        let _ = wasm_bytes;
        let _ = args;
        let _ = env;
        let _ = timeout_secs;
        Ok(unavailable(
            "wasmtime sandbox is not compiled in. \
             Rebuild ryu-core with `--features sandbox-wasmtime` to enable it.",
        ))
    }
}

// ── Backend resolution + process-backend path ─────────────────────────────────

/// Resolve the backend from the call args, falling back to the node default.
///
/// A non-empty `backend` string must be in the shared backend vocabulary;
/// unknown names are rejected immediately. Empty/absent uses
/// [`configured_backend`].
fn resolve_backend(arguments: &Value) -> Result<SandboxBackend> {
    match arguments.get("backend").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => SandboxBackend::from_name(name.trim()),
        Some(_) => Err(anyhow::anyhow!("sandbox backend name must not be empty")),
        None => Ok(configured_backend()),
    }
}

/// Most `env` entries one call may set.
const MAX_ENV_VARS: usize = 64;

/// Parse the optional `env` argument (`[{ "key", "value" }]`).
///
/// Entries must be objects with string `key` and `value`. A key must be
/// non-empty and free of `=` and NUL, and a value free of NUL, because WASI
/// passes the environment as `KEY=VALUE` C strings.
fn parse_env(arguments: &Value) -> Result<Vec<(String, String)>> {
    let Some(raw) = arguments.get("env") else {
        return Ok(Vec::new());
    };
    if raw.is_null() {
        return Ok(Vec::new());
    }
    let entries = raw
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("'env' must be an array of {{ key, value }} objects"))?;
    anyhow::ensure!(
        entries.len() <= MAX_ENV_VARS,
        "'env' accepts at most {MAX_ENV_VARS} entries"
    );
    entries
        .iter()
        .map(|entry| {
            let key = entry.get("key").and_then(Value::as_str);
            let value = entry.get("value").and_then(Value::as_str);
            let (Some(key), Some(value)) = (key, value) else {
                anyhow::bail!("each 'env' entry needs string 'key' and 'value' fields");
            };
            anyhow::ensure!(
                !key.is_empty() && !key.contains(['=', '\0']),
                "invalid env key {key:?}: must be non-empty without '=' or NUL"
            );
            anyhow::ensure!(
                !value.contains('\0'),
                "invalid value for env key {key:?}: must not contain NUL"
            );
            Ok((key.to_owned(), value.to_owned()))
        })
        .collect()
}

/// Parse a `["a","b"]` string array argument, defaulting to empty.
fn parse_str_array(arguments: &Value, key: &str) -> Vec<String> {
    arguments
        .get(key)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Build deny-by-default [`SandboxCapabilities`] from the call args.
fn parse_capabilities(arguments: &Value) -> SandboxCapabilities {
    let mut caps = SandboxCapabilities::default();
    // Scope and workspace mode are internal policy selectors. The capability
    // sets themselves remain deny-all for process backends; callers cannot turn
    // arbitrary JSON paths or a network flag into host access.
    if let Some(Ok(scope)) = arguments
        .get("scope")
        .and_then(Value::as_str)
        .map(SandboxScope::from_name)
    {
        caps.scope = scope;
    }
    if let Some(Ok(access)) = arguments
        .get("workspace_access")
        .and_then(Value::as_str)
        .map(WorkspaceAccess::from_name)
    {
        caps.workspace_access = access;
    }
    caps
}

/// Run a `command` in a process/container/microVM backend (docker /
/// microsandbox / opensandbox), gated through the same Gateway exec budget +
/// audit as the wasmtime path.
///
/// A malformed call (missing `command`) is a hard `Err`; an environment that
/// is simply not ready (backend not installed/reachable) returns a graceful
/// `unavailable` so the agent gets a clean signal instead of a tool error.
async fn run_process_exec(
    backend: SandboxBackend,
    arguments: Value,
    agent_id: Option<&str>,
    session_id: Option<String>,
) -> Result<Value> {
    use crate::sidecar::gateway::{
        check_exec_budget, report_exec_audit_with_attribution, ExecAuditAttribution,
        ExecBudgetOutcome,
    };

    let backend_label = backend.as_str().to_owned();
    let attribution = ExecAuditAttribution {
        agent_id: agent_id.map(str::to_owned),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };

    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("missing required argument 'command' for backend '{backend_label}'")
        })?
        .to_owned();

    // Process backends start from a cleared environment and have no way to
    // pass `env` through; refuse it instead of silently dropping it.
    if !parse_env(&arguments)?.is_empty() {
        return Err(anyhow::anyhow!(
            "'env' is only supported on the wasmtime backend, not '{backend_label}'"
        ));
    }

    let args = parse_str_array(&arguments, "args");
    let capabilities = parse_capabilities(&arguments);
    let timeout_secs = Some(
        arguments
            .get("timeout_secs")
            .and_then(Value::as_u64)
            .unwrap_or(30),
    );
    let stdin = arguments
        .get("stdin_b64")
        .and_then(Value::as_str)
        .map(|b64| {
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| anyhow::anyhow!("invalid base64 in 'stdin_b64': {e}"))
        })
        .transpose()?;

    // ── Step 1: pre-run gateway budget gate (fail-closed) ────────────────────
    match check_exec_budget(&backend_label, &command).await {
        ExecBudgetOutcome::Allow => {}
        ExecBudgetOutcome::Deny(reason) => {
            return Err(anyhow::anyhow!("exec budget exhausted: {reason}"));
        }
    }

    // Build the backend. An unknown/unsupported backend is a graceful
    // unavailable (e.g. "wasmtime is not a command backend").
    let sandbox = match build_command_backend(&backend) {
        Ok(s) => s,
        Err(e) => return Ok(unavailable(e.to_string())),
    };

    let spec = ExecSpec {
        env: Vec::new(),
        command: command.clone(),
        args,
        capabilities,
        stdin,
        timeout_secs,
    };

    // ── Metering (paid remote backends): register the run for the heartbeat ticker ────
    // Paid Box and Daytona share the node cap and real workspace lifecycle.
    // Explicitly active Box subscription passthrough stays unmetered.
    let subscription_passthrough = backend_label == "box"
        && crate::sidecar::sandbox::box_backend::subscription_passthrough_active().await;
    let workspace = if matches!(backend_label.as_str(), "daytona" | "box") {
        Some(sandbox.create_workspace(spec.capabilities.clone()).await?)
    } else {
        None
    };
    let mut remote_run =
        register_remote_metering(&backend_label, workspace.as_ref(), subscription_passthrough)
            .await;
    if let (Some(meter), Some(workspace)) = (&mut remote_run, &workspace) {
        meter.cleanup_future = Some(sandbox.destroy_workspace(workspace));
    }
    let mut workspace_cleanup = if remote_run.is_none() {
        workspace
            .as_ref()
            .map(|id| crate::sidecar::sandbox::WorkspaceCleanup::new(sandbox.destroy_workspace(id)))
    } else {
        None
    };

    // ── Step 2: run the backend ──────────────────────────────────────────────
    let start = std::time::Instant::now();
    let result = if let Some(workspace) = &workspace {
        let result = sandbox.exec_in_workspace(workspace, spec).await;
        if let Some(meter) = &mut remote_run {
            meter.stop_workspace().await?;
        } else if let Some(cleanup) = &mut workspace_cleanup {
            cleanup.finish().await?;
        }
        result
    } else {
        sandbox.exec(spec).await
    };
    let duration_ms = start.elapsed().as_millis() as u64;

    // ── Metering (paid remote backends): deregister + final residual debit ────────────
    // One-shot runs usually finish inside a single tick, so the periodic ticker
    // may have billed nothing; charge the un-ticked tail here.
    let metering_result = finalize_remote_metering(remote_run, duration_ms).await;

    // ── Step 3: post-run audit report (best-effort) ──────────────────────────
    match &result {
        Ok(output) => {
            report_exec_audit_with_attribution(
                &backend_label,
                &command,
                duration_ms,
                output.exit_code,
                session_id.clone(),
                None,
                attribution.clone(),
            )
            .await;
        }
        Err(e) => {
            report_exec_audit_with_attribution(
                &backend_label,
                &command,
                duration_ms,
                -1,
                session_id,
                Some(e.to_string()),
                attribution,
            )
            .await;
        }
    }

    if let Err(error) = metering_result {
        return Err(anyhow::anyhow!(
            "billable sandbox cleanup or final billing could not be confirmed: {error}"
        ));
    }

    match result {
        Ok(output) => Ok(json!({
            "backend": backend_label,
            "exit_code": output.exit_code,
            "stdout": String::from_utf8_lossy(&output.stdout),
            "stderr": String::from_utf8_lossy(&output.stderr),
        })),
        // A backend that is not installed/reachable is reported as unavailable,
        // not a hard tool error — callers can fall back.
        Err(e) => Ok(unavailable(format!(
            "{backend_label} backend not available: {e}"
        ))),
    }
}

// ── Remote metering (register on launch, debit on completion) ─────────────────

/// A registered paid remote metering run, carried from [`register_remote_metering`]
/// to [`finalize_remote_metering`]. `None` for local and active subscription-passthrough backends.
struct RemoteMetering {
    run_id: String,
    /// Owning/bill-to org, or `None` when Core cannot resolve one.
    org_id: Option<String>,
    /// The billed *resource* shape (distinct from the exec command spec).
    spec: crate::sidecar::sandbox::spec::SandboxSpec,
    /// Per-run execution cap in micro-USD; `0` = no cap.
    budget_micro_usd: u64,
    started: std::time::Instant,
    workspace: crate::sidecar::sandbox::WorkspaceId,
    backend: String,
    cleanup_future: Option<crate::sidecar::sandbox::BoxFuture<anyhow::Result<()>>>,
    workspace_stopped: bool,
}

impl RemoteMetering {
    async fn stop_workspace(&mut self) -> anyhow::Result<()> {
        let result = self
            .cleanup_future
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("remote sandbox cleanup was not attached"))?
            .await;
        self.cleanup_future = None;
        self.workspace_stopped = result.is_ok();
        result
    }
}

fn remote_backend_is_metered(backend: &str, subscription_passthrough: bool) -> bool {
    backend == "daytona" || (backend == "box" && !subscription_passthrough)
}

impl Drop for RemoteMetering {
    fn drop(&mut self) {
        use crate::sidecar::sandbox::{build_command_backend, heartbeat, SandboxBackend};
        if !heartbeat::list_active_runs()
            .iter()
            .any(|run| run.run_id == self.run_id)
        {
            return;
        }
        let (run_id, org_id, spec, budget, workspace, backend, started) = (
            self.run_id.clone(),
            self.org_id.clone(),
            self.spec.clone(),
            self.budget_micro_usd,
            self.workspace.clone(),
            self.backend.clone(),
            self.started,
        );
        let cleanup = self.cleanup_future.take().or_else(|| {
            if self.workspace_stopped {
                return None;
            }
            SandboxBackend::from_name(&backend)
                .and_then(|backend| build_command_backend(&backend))
                .ok()
                .map(|sandbox| sandbox.destroy_workspace(&workspace))
        });
        let workspace_stopped = self.workspace_stopped;
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let stopped = if workspace_stopped {
                    true
                } else if let Some(cleanup) = cleanup {
                    matches!(
                        tokio::time::timeout(std::time::Duration::from_secs(90), cleanup).await,
                        Ok(Ok(()))
                    )
                } else {
                    false
                };
                if !stopped {
                    // Keep billing and the node cap attached to a still-live workspace.
                    tracing::warn!("cancelled remote sandbox teardown could not be confirmed");
                    return;
                }
                let Some(residual) = heartbeat::deregister_for_final_debit(&run_id) else {
                    return;
                };
                let seconds = (started.elapsed().as_millis() as u64)
                    .div_ceil(1000)
                    .max(1)
                    .saturating_sub(residual.ticked_seconds);
                if heartbeat::debit_final(run_id, org_id, spec, seconds, budget, residual)
                    .await
                    .is_err()
                {
                    tracing::warn!("cancelled sandbox final debit could not be confirmed");
                }
            });
        }
    }
}

/// Register paid Box and Daytona runs using their real workspace IDs.
/// Active Box subscription passthrough and local backends are unmetered.
///
/// Fail-open: this only mutates an in-memory registry and reads env/cached org
/// state, so it cannot fail the exec; a missing org just means "register for
/// visibility, skip the debit" (never bill a wrong org).
async fn register_remote_metering(
    backend_label: &str,
    workspace: Option<&crate::sidecar::sandbox::WorkspaceId>,
    subscription_passthrough: bool,
) -> Option<RemoteMetering> {
    if !remote_backend_is_metered(backend_label, subscription_passthrough) {
        return None;
    }
    use crate::sidecar::sandbox::{box_backend, daytona, heartbeat};

    // The node's owning org is the billing unit. A managed node binds to exactly
    // one org via the control-plane handshake (`control_plane::registered_org`);
    // an unmanaged/local node resolves to `None`, so we register for visibility
    // but skip the debit rather than bill a wrong/empty org.
    let org_id = crate::sidecar::control_plane::registered_org().map(|o| o.id);
    let run_id = uuid::Uuid::new_v4().to_string();
    // Billing spec is about *resources* (vCPU/mem/gpu/os), resolved from the
    // Daytona env knobs — distinct from the exec `ExecSpec` (the command).
    let spec = if backend_label == "box" {
        box_backend::configured_spec()
    } else {
        daytona::configured_spec()
    };
    let budget_micro_usd = heartbeat::default_run_budget_micro_usd().await;

    let workspace = workspace?.clone();
    heartbeat::register(
        run_id.clone(),
        org_id.clone(),
        backend_label,
        workspace.clone(),
        spec.clone(),
        budget_micro_usd,
    );
    tracing::debug!(run_id = %run_id, org_id = ?org_id, "daytona sandbox metering: run registered");
    Some(RemoteMetering {
        run_id,
        org_id,
        spec,
        budget_micro_usd,
        started: std::time::Instant::now(),
        workspace,
        backend: backend_label.to_owned(),
        cleanup_future: None,
        workspace_stopped: false,
    })
}

/// Deregister a Daytona run and debit its un-ticked tail. A no-op when `metering`
/// is `None` (non-Daytona backend). Billable failures are returned to the caller
/// after the remote workspace has been removed.
async fn finalize_remote_metering(
    metering: Option<RemoteMetering>,
    duration_ms: u64,
) -> Result<(), String> {
    let Some(m) = metering else {
        return Ok(());
    };
    use crate::sidecar::sandbox::heartbeat;

    // Removing the run stops any further ticks, so the debit below cannot race
    // the ticker. `None` ⇒ the run was already removed (e.g. a budget-kill
    // verdict already charged it) — nothing left to debit.
    let Some(residual) = heartbeat::deregister_for_final_debit(&m.run_id) else {
        if let Some(kill) = heartbeat::kill_record(&m.run_id) {
            return Err(format!(
                "sandbox was stopped by metering: {:?}",
                kill.reason
            ));
        }
        return Ok(());
    };

    // No owning org ⇒ registered for visibility only; never bill a wrong org.
    if m.org_id.is_none() {
        tracing::debug!(
            run_id = %m.run_id,
            "daytona sandbox metering: no owning org, skipping final debit (visibility only)"
        );
        return Ok(());
    }

    // Charge the measured duration (rounded up, min 1s) minus whatever the
    // periodic ticker already sent, so the ticker and this debit never double-bill.
    let measured_secs = duration_ms.div_ceil(1000).max(1);
    let remainder = measured_secs.saturating_sub(residual.ticked_seconds);
    let (run_id, org_id, spec, budget) = (
        m.run_id.clone(),
        m.org_id.clone(),
        m.spec.clone(),
        m.budget_micro_usd,
    );
    let mut final_debit = crate::sidecar::sandbox::WorkspaceCleanup::new(Box::pin(async move {
        heartbeat::debit_final(run_id, org_id, spec, remainder, budget, residual)
            .await
            .map_err(anyhow::Error::msg)
    }));
    final_debit
        .finish()
        .await
        .map_err(|error| error.to_string())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wasmtime_timeout_is_clamped_to_the_hard_cap() {
        assert_eq!(wasmtime_timeout_secs(&json!({})), 30);
        assert_eq!(wasmtime_timeout_secs(&json!({ "timeout_secs": 5 })), 5);
        assert_eq!(wasmtime_timeout_secs(&json!({ "timeout_secs": 0 })), 1);
        assert_eq!(wasmtime_timeout_secs(&json!({ "timeout_secs": 600 })), 30);
    }

    #[test]
    fn paid_remote_backends_cannot_skip_metering() {
        assert!(remote_backend_is_metered("daytona", false));
        assert!(remote_backend_is_metered("daytona", true));
        assert!(remote_backend_is_metered("box", false));
        assert!(!remote_backend_is_metered("box", true));
        assert!(!remote_backend_is_metered("docker", false));
    }
    #[tokio::test]
    async fn box_paid_and_passthrough_registration_use_the_shared_meter() {
        use crate::sidecar::sandbox::{heartbeat, WorkspaceId};
        let workspace = WorkspaceId("box-paid-workspace".into());
        let paid = register_remote_metering("box", Some(&workspace), false)
            .await
            .unwrap();
        assert!(heartbeat::list_active_runs()
            .iter()
            .any(|run| run.run_id == paid.run_id && run.backend == "box"));
        let run_id = paid.run_id.clone();
        heartbeat::unregister(&run_id);
        drop(paid);
        assert!(!heartbeat::list_active_runs()
            .iter()
            .any(|run| run.run_id == run_id));
        assert!(register_remote_metering("box", Some(&workspace), true)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn cancelled_paid_cleanup_keeps_the_cap_until_stop_is_confirmed() {
        use crate::sidecar::sandbox::{heartbeat, WorkspaceId};
        let workspace = WorkspaceId("cancelled-paid-workspace".into());
        let mut meter = register_remote_metering("box", Some(&workspace), false)
            .await
            .unwrap();
        meter.org_id = None; // This probe never calls a live wallet.
        let run_id = meter.run_id.clone();
        let (started, ready) = tokio::sync::oneshot::channel();
        let (resume, continuation) = tokio::sync::oneshot::channel();
        let (stopped, stop_confirmed) = tokio::sync::oneshot::channel();
        meter.cleanup_future = Some(Box::pin(async move {
            started.send(()).unwrap();
            continuation.await?;
            stopped.send(()).unwrap();
            Ok(())
        }));
        let task = tokio::spawn(async move {
            meter.stop_workspace().await.unwrap();
        });
        ready.await.unwrap();
        task.abort();
        let _ = task.await;
        assert!(heartbeat::list_active_runs()
            .iter()
            .any(|run| run.run_id == run_id));
        resume.send(()).unwrap();
        stop_confirmed.await.unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while heartbeat::list_active_runs()
                .iter()
                .any(|run| run.run_id == run_id)
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[test]
    fn lists_one_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 4);
        let tool = &tools[0];
        assert_eq!(tool.id, "sandbox.sandbox_exec");
        assert_eq!(tool.server, SERVER_NAME);
        assert!(tool.input_schema.is_some());
        assert!(tool.description.is_some());
        // Persistent remote workspace lifecycle tools live alongside the one-shot exec.
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"sandbox.sandbox_create"));
        assert!(ids.contains(&"sandbox.sandbox_run"));
        assert!(ids.contains(&"sandbox.sandbox_destroy"));
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.input_schema.is_some());
            assert!(t.description.is_some());
        }
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let err = dispatch("not_a_tool", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn missing_wasm_b64_is_an_error() {
        // `dispatch` short-circuits to `unavailable` (Ok) when the sandbox is
        // disabled, so serialize against every test that toggles the disabled
        // flag (RYU_SANDBOX_DISABLED) — including gateway's policy_flags_roundtrip.
        let _lock = crate::sidecar::gateway_policy::lock_policy_flags();
        std::env::remove_var(crate::sidecar::sandbox::ENV_SANDBOX_BACKEND);
        let err = dispatch("sandbox_exec", json!({})).await;
        assert!(err.is_err(), "missing wasm_b64 must be Err");
    }

    #[test]
    fn resolve_backend_reads_arg_then_default() {
        std::env::remove_var(crate::sidecar::sandbox::ENV_SANDBOX_BACKEND);
        assert_eq!(
            resolve_backend(&json!({})).unwrap(),
            SandboxBackend::Wasmtime
        );
        assert_eq!(
            resolve_backend(&json!({ "backend": "docker" })).unwrap(),
            SandboxBackend::Docker
        );
        assert_eq!(
            resolve_backend(&json!({ "backend": "microsandbox" })).unwrap(),
            SandboxBackend::Microsandbox
        );
    }

    #[test]
    fn tool_schema_lists_every_known_backend_in_stable_order() {
        let schema = sandbox_exec_schema();
        assert_eq!(
            schema["properties"]["backend"]["enum"],
            json!(crate::sidecar::sandbox::KNOWN_BACKENDS)
        );
        assert!(crate::sidecar::sandbox::KNOWN_BACKENDS.contains(&"daytona"));
    }

    #[test]
    fn unknown_backend_is_rejected_without_fallback() {
        let err = resolve_backend(&json!({ "backend": "typo" })).unwrap_err();
        assert!(err.to_string().contains("unknown sandbox backend 'typo'"));
    }

    #[test]
    fn parse_capabilities_is_deny_all_by_default() {
        let caps = parse_capabilities(&json!({}));
        assert!(!caps.network);
        assert!(caps.fs_read_paths.is_empty());
        assert!(caps.fs_write_paths.is_empty());

        let caps = parse_capabilities(&json!({
            "network": true,
            "read_paths": ["/tmp/x"],
            "write_paths": ["/tmp/y"],
            "scope": "workspace",
            "workspace_access": "read-write"
        }));
        assert!(!caps.network);
        assert!(caps.fs_read_paths.is_empty());
        assert!(caps.fs_write_paths.is_empty());
    }

    #[tokio::test]
    async fn process_backend_missing_command_is_error() {
        // `command` is parsed before the budget gate, so this is gateway-free.
        // Serialize against the sandbox disabled-flag toggles (see above).
        let _lock = crate::sidecar::gateway_policy::lock_policy_flags();
        let err = dispatch("sandbox_exec", json!({ "backend": "docker" })).await;
        assert!(err.is_err(), "process backend without command must be Err");
    }

    #[tokio::test]
    async fn process_backend_rejects_env_instead_of_dropping_it() {
        // `env` is checked before the budget gate, so this is gateway-free.
        let _lock = crate::sidecar::gateway_policy::lock_policy_flags();
        let err = dispatch(
            "sandbox_exec",
            json!({
                "backend": "docker",
                "command": "env",
                "env": [{ "key": "GREETING", "value": "hi" }],
            }),
        )
        .await
        .expect_err("process backend with env must be Err");
        assert!(err
            .to_string()
            .contains("only supported on the wasmtime backend"));
    }

    #[test]
    fn parse_env_reads_pairs_and_rejects_malformed_entries() {
        assert!(parse_env(&json!({})).unwrap().is_empty());
        assert!(parse_env(&json!({ "env": null })).unwrap().is_empty());
        assert_eq!(
            parse_env(&json!({ "env": [
                { "key": "A", "value": "1" },
                { "key": "B", "value": "" },
            ] }))
            .unwrap(),
            vec![
                ("A".to_owned(), "1".to_owned()),
                ("B".to_owned(), String::new())
            ]
        );
        for bad in [
            json!({ "env": "A=1" }),
            json!({ "env": [{ "key": "A" }] }),
            json!({ "env": [{ "key": "", "value": "1" }] }),
            json!({ "env": [{ "key": "A=B", "value": "1" }] }),
            json!({ "env": [{ "key": "A\u{0}", "value": "1" }] }),
            json!({ "env": [{ "key": "A", "value": "1\u{0}" }] }),
        ] {
            assert!(parse_env(&bad).is_err(), "{bad} must be rejected");
        }
        let too_many: Vec<Value> = (0..=MAX_ENV_VARS)
            .map(|i| json!({ "key": format!("K{i}"), "value": "v" }))
            .collect();
        assert!(parse_env(&json!({ "env": too_many })).is_err());
    }

    #[tokio::test]
    async fn invalid_base64_is_an_error() {
        // Serialize against the sandbox disabled-flag toggles (see above).
        let _lock = crate::sidecar::gateway_policy::lock_policy_flags();
        let err = dispatch("sandbox_exec", json!({ "wasm_b64": "!!not-base64!!" })).await;
        assert!(err.is_err(), "invalid base64 must be Err");
    }

    #[tokio::test]
    async fn disabled_sandbox_returns_unavailable_not_error() {
        // This flips the process-global RYU_SANDBOX_DISABLED; hold the shared
        // policy-flags lock so it never clobbers a concurrent sandbox_exec test,
        // and restore the flag on exit.
        let _lock = crate::sidecar::gateway_policy::lock_policy_flags();
        let prev = std::env::var(ENV_DISABLED).ok();
        // Temporarily disable via env var.
        unsafe { std::env::set_var(ENV_DISABLED, "1") };
        let result = dispatch(
            "sandbox_exec",
            json!({ "wasm_b64": base64::engine::general_purpose::STANDARD.encode(b"fake") }),
        )
        .await
        .expect("disabled sandbox must not return Err");
        assert_eq!(
            result.get("available").and_then(Value::as_bool),
            Some(false),
            "disabled result must have available=false"
        );
        unsafe {
            match prev {
                Some(v) => std::env::set_var(ENV_DISABLED, v),
                None => std::env::remove_var(ENV_DISABLED),
            }
        }
    }
}
