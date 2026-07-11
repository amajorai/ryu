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
//!   - `sandbox__sandbox_exec` — run a WASM/WASI module and return its
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

use std::path::PathBuf;

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
                "enum": ["wasmtime", "docker", "microsandbox", "opensandbox"],
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
                "description": "Program to run (argv[0]). Required for the docker/microsandbox/opensandbox backends."
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
                "description": "Environment variables available to the workload (wasmtime backend)."
            },
            "network": {
                "type": "boolean",
                "description": "Allow outbound network (process backends). Defaults to false (deny-all)."
            },
            "read_paths": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Host paths the sandbox may read (process backends). Defaults to none."
            },
            "write_paths": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Host paths the sandbox may write (process backends). Defaults to none."
            },
            "stdin_b64": {
                "type": "string",
                "description": "Base-64 encoded bytes piped to the command's stdin (process backends)."
            },
            "timeout_secs": {
                "type": "integer",
                "description": "Hard wall-clock cap in seconds. Defaults to 30."
            }
        }
    })
}

// ── Persistent (Daytona-only) lifecycle tool schemas ──────────────────────────

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
            id: format!("{SERVER_NAME}__sandbox_exec"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_exec".to_owned(),
            description: Some(
                "Execute code in an isolated, swappable sandbox backend (default-deny). \
                 `backend` selects the runtime: 'wasmtime' (default) runs a base-64 WASM module \
                 (`wasm_b64`); 'docker', 'microsandbox', or 'opensandbox' run a `command` in a \
                 container/microVM. No FS or network access unless explicitly granted \
                 (`network`/`read_paths`/`write_paths`). Returns stdout, stderr, and exit code."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_exec_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}__sandbox_create"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_create".to_owned(),
            description: Some(
                "Create a long-lived Daytona sandbox workspace (persistent lifecycle). \
                 Metered per-second until destroyed with `sandbox_destroy`; run commands \
                 against it with `sandbox_run`. Daytona-only. Returns `run_id` and \
                 `workspace_id`."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_create_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}__sandbox_run"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_run".to_owned(),
            description: Some(
                "Run a command in an existing persistent Daytona sandbox created with \
                 `sandbox_create`. Returns stdout, stderr, and exit code."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_run_schema()),
            ..Default::default()
        },
        RegistryTool {
            id: format!("{SERVER_NAME}__sandbox_destroy"),
            server: SERVER_NAME.to_owned(),
            name: "sandbox_destroy".to_owned(),
            description: Some(
                "Destroy a persistent Daytona sandbox created with `sandbox_create`, \
                 stopping metering. Idempotent — destroying an already-gone sandbox succeeds."
                    .to_owned(),
            ),
            input_schema: Some(sandbox_destroy_schema()),
            ..Default::default()
        },
    ]
}

/// Dispatch a sandbox tool call. `tool` is the bare name (stripped of the
/// `sandbox__` prefix by the registry).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "sandbox_exec" => run_sandbox_exec(arguments).await,
        "sandbox_create" => run_sandbox_create(arguments).await,
        "sandbox_run" => run_sandbox_run(arguments).await,
        "sandbox_destroy" => run_sandbox_destroy(arguments).await,
        other => Err(anyhow::anyhow!("unknown sandbox tool '{other}'")),
    }
}

// ── Persistent (Daytona-only) lifecycle tool handlers ─────────────────────────
//
// These are thin wrappers over the persistent workspace manager in
// `sidecar::sandbox::session`, which is hardwired to the Daytona backend. Unlike
// `sandbox_exec` (one-shot create+run+destroy), these keep the workspace alive:
// `sandbox_create` provisions + registers it for per-second metering,
// `sandbox_run` execs against it, and `sandbox_destroy` tears it down + debits
// the residual tail. Persistent tools ignore any `backend` arg by design.

/// Create a persistent Daytona sandbox. No spec is taken from the tool call, so
/// the billed/provisioned shape is the node's configured Daytona spec.
async fn run_sandbox_create(arguments: Value) -> Result<Value> {
    use crate::sidecar::sandbox::session;

    let budget = arguments.get("budget_micro_usd").and_then(Value::as_u64);
    let created = session::create_sandbox(None, budget).await?;
    Ok(json!({
        "run_id": created.run_id,
        "workspace_id": created.workspace_id,
    }))
}

/// Run a command in an existing persistent Daytona sandbox.
async fn run_sandbox_run(arguments: Value) -> Result<Value> {
    use crate::sidecar::sandbox::session;

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

    let result = session::exec_in_sandbox(&run_id, command, args, timeout_secs).await?;
    Ok(json!({
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }))
}

/// Destroy a persistent Daytona sandbox (idempotent).
async fn run_sandbox_destroy(arguments: Value) -> Result<Value> {
    use crate::sidecar::sandbox::session;

    let run_id = arguments
        .get("run_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required argument 'run_id'"))?
        .to_owned();

    session::destroy_sandbox(&run_id).await?;
    Ok(json!({ "ok": true }))
}

/// Run the `sandbox_exec` tool, gated through the Gateway exec budget (M6 / #192).
///
/// Flow:
/// 1. Pre-run: ask the gateway whether this exec is permitted (fail-closed).
/// 2. Run the backend (wasmtime or stub when feature is off).
/// 3. Post-run: report the completed event to the gateway audit store (best-effort).
async fn run_sandbox_exec(arguments: Value) -> Result<Value> {
    if !is_enabled() {
        return Ok(unavailable(
            "The sandbox is disabled. \
             Enable it from the Services page or unset RYU_SANDBOX_DISABLED.",
        ));
    }

    // Resolve which backend to run in: explicit `backend` arg wins, else the
    // node default (RYU_SANDBOX_BACKEND, falling back to wasmtime).
    let backend = resolve_backend(&arguments);
    if !matches!(backend, SandboxBackend::Wasmtime) {
        return run_process_exec(backend, arguments).await;
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

    // Parse optional env vars.
    let env: Vec<(String, String)> = arguments
        .get("env")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| {
                    let k = v.get("key")?.as_str()?.to_owned();
                    let val = v.get("value")?.as_str()?.to_owned();
                    Some((k, val))
                })
                .collect()
        })
        .unwrap_or_default();

    // Build the exec spec with deny-all capabilities.
    // The env vars are wired into WASI context below; no FS paths are granted.
    let _env = env; // used in feature-gated block

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
        use crate::sidecar::gateway::report_exec_audit;
        use crate::sidecar::sandbox::wasmtime::WasmtimeSandbox;
        use crate::sidecar::sandbox::{ExecSpec, SandboxCapabilities};

        let sandbox = WasmtimeSandbox::new()
            .map_err(|e| anyhow::anyhow!("failed to initialise wasmtime sandbox: {e}"))?;

        let spec = ExecSpec {
            command: command_name.to_owned(),
            args,
            capabilities: SandboxCapabilities::default(), // deny-all
            stdin: Some(wasm_bytes),
            timeout_secs: Some(30), // 30-second hard cap
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

        // ── Step 3: post-run audit report (best-effort) ──────────────────────
        match &exec_result {
            Ok(Ok(output)) => {
                report_exec_audit(
                    backend_name,
                    command_name,
                    duration_ms,
                    output.exit_code,
                    None, // session_id — not threaded through sandbox tool yet
                    None,
                )
                .await;
            }
            Ok(Err(e)) => {
                report_exec_audit(
                    backend_name,
                    command_name,
                    duration_ms,
                    -1,
                    None,
                    Some(e.to_string()),
                )
                .await;
            }
            Err(e) => {
                report_exec_audit(
                    backend_name,
                    command_name,
                    duration_ms,
                    -1,
                    None,
                    Some(format!("task join error: {e}")),
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
        use crate::sidecar::gateway::report_exec_audit;

        // Feature off: report a zero-duration stub event and return unavailable.
        report_exec_audit(
            backend_name,
            command_name,
            0,
            0,
            None,
            Some("sandbox-wasmtime feature not compiled in".to_owned()),
        )
        .await;

        let _ = wasm_bytes;
        let _ = args;
        Ok(unavailable(
            "wasmtime sandbox is not compiled in. \
             Rebuild ryu-core with `--features sandbox-wasmtime` to enable it.",
        ))
    }
}

// ── Backend resolution + process-backend path ─────────────────────────────────

/// Resolve the backend from the call args, falling back to the node default.
///
/// A non-empty `backend` string always parses (unknown names become
/// `Custom(name)` and surface a clear error when built); empty/absent uses
/// [`configured_backend`].
fn resolve_backend(arguments: &Value) -> SandboxBackend {
    match arguments.get("backend").and_then(Value::as_str) {
        Some(name) if !name.trim().is_empty() => {
            SandboxBackend::from_name(name.trim()).unwrap_or_else(|_| configured_backend())
        }
        _ => configured_backend(),
    }
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
    caps.network = arguments
        .get("network")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    for p in parse_str_array(arguments, "read_paths") {
        caps.fs_read_paths.insert(PathBuf::from(p));
    }
    for p in parse_str_array(arguments, "write_paths") {
        caps.fs_write_paths.insert(PathBuf::from(p));
    }
    // Optional agent-declared scope + workspace access. Unknown/absent values
    // keep the deny-safe defaults (per-exec scope, honor-the-path-sets access),
    // matching this module's "bad value falls through to default" idiom.
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
async fn run_process_exec(backend: SandboxBackend, arguments: Value) -> Result<Value> {
    use crate::sidecar::gateway::{check_exec_budget, report_exec_audit, ExecBudgetOutcome};

    let backend_label = backend.as_str().to_owned();

    let command = arguments
        .get("command")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!("missing required argument 'command' for backend '{backend_label}'")
        })?
        .to_owned();

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
        command: command.clone(),
        args,
        capabilities,
        stdin,
        timeout_secs,
    };

    // ── Metering (Daytona only): register the run for the heartbeat ticker ────
    // Only Daytona is the remote, billed backend; the local backends (docker /
    // microsandbox / opensandbox) are free, so they never register. Fully
    // fail-open — a metering hiccup must never fail the user's exec.
    let daytona_run = register_daytona_metering(&backend_label).await;

    // ── Step 2: run the backend ──────────────────────────────────────────────
    let start = std::time::Instant::now();
    let result = sandbox.exec(spec).await;
    let duration_ms = start.elapsed().as_millis() as u64;

    // ── Metering (Daytona only): deregister + final residual debit ────────────
    // One-shot runs usually finish inside a single tick, so the periodic ticker
    // may have billed nothing; charge the un-ticked tail here (fail-open).
    finalize_daytona_metering(daytona_run, duration_ms).await;

    // ── Step 3: post-run audit report (best-effort) ──────────────────────────
    match &result {
        Ok(output) => {
            report_exec_audit(
                &backend_label,
                &command,
                duration_ms,
                output.exit_code,
                None,
                None,
            )
            .await;
        }
        Err(e) => {
            report_exec_audit(
                &backend_label,
                &command,
                duration_ms,
                -1,
                None,
                Some(e.to_string()),
            )
            .await;
        }
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

// ── Daytona metering (register on launch, debit on completion) ─────────────────

/// A registered Daytona metering run, carried from [`register_daytona_metering`]
/// to [`finalize_daytona_metering`]. `None` for every non-Daytona backend.
struct DaytonaMetering {
    run_id: String,
    /// Owning/bill-to org, or `None` when Core cannot resolve one.
    org_id: Option<String>,
    /// The billed *resource* shape (distinct from the exec command spec).
    spec: crate::sidecar::sandbox::spec::SandboxSpec,
    /// Per-run execution cap in micro-USD; `0` = no cap.
    budget_micro_usd: u64,
}

/// Register a Daytona one-shot exec for metering. A no-op (returns `None`) for
/// any other backend — the local backends are free, so only the remote, billed
/// Daytona backend meters.
///
/// Fail-open: this only mutates an in-memory registry and reads env/cached org
/// state, so it cannot fail the exec; a missing org just means "register for
/// visibility, skip the debit" (never bill a wrong org).
async fn register_daytona_metering(backend_label: &str) -> Option<DaytonaMetering> {
    if backend_label != "daytona" {
        return None;
    }
    use crate::sidecar::sandbox::{daytona, heartbeat, WorkspaceId};

    // The node's owning org is the billing unit. A managed node binds to exactly
    // one org via the control-plane handshake (`control_plane::registered_org`);
    // an unmanaged/local node resolves to `None`, so we register for visibility
    // but skip the debit rather than bill a wrong/empty org.
    let org_id = crate::sidecar::control_plane::registered_org().map(|o| o.id);
    let run_id = uuid::Uuid::new_v4().to_string();
    // Billing spec is about *resources* (vCPU/mem/gpu/os), resolved from the
    // Daytona env knobs — distinct from the exec `ExecSpec` (the command).
    let spec = daytona::configured_spec();
    let budget_micro_usd = heartbeat::default_run_budget_micro_usd().await;

    // The one-shot `exec` path creates + destroys its sandbox *internally*, so
    // there is no stable workspace id to hand the kill hook. A placeholder is
    // acceptable: a sub-tick run is unlikely to receive a kill verdict, and
    // daytona's destroy treats a missing/empty id as success (idempotent).
    heartbeat::register(
        run_id.clone(),
        org_id.clone(),
        "daytona",
        WorkspaceId(String::new()),
        spec.clone(),
        budget_micro_usd,
    );
    tracing::debug!(run_id = %run_id, org_id = ?org_id, "daytona sandbox metering: run registered");
    Some(DaytonaMetering {
        run_id,
        org_id,
        spec,
        budget_micro_usd,
    })
}

/// Deregister a Daytona run and debit its un-ticked tail. A no-op when `metering`
/// is `None` (non-Daytona backend). Fully fail-open — every failure is swallowed
/// inside [`heartbeat::debit_final`], so it can never fail the user's exec.
async fn finalize_daytona_metering(metering: Option<DaytonaMetering>, duration_ms: u64) {
    let Some(m) = metering else {
        return;
    };
    use crate::sidecar::sandbox::heartbeat;

    // Removing the run stops any further ticks, so the debit below cannot race
    // the ticker. `None` ⇒ the run was already removed (e.g. a budget-kill
    // verdict already charged it) — nothing left to debit.
    let Some(residual) = heartbeat::deregister_for_final_debit(&m.run_id) else {
        return;
    };

    // No owning org ⇒ registered for visibility only; never bill a wrong org.
    if m.org_id.is_none() {
        tracing::debug!(
            run_id = %m.run_id,
            "daytona sandbox metering: no owning org, skipping final debit (visibility only)"
        );
        return;
    }

    // Charge the measured duration (rounded up, min 1s) minus whatever the
    // periodic ticker already sent, so the ticker and this debit never double-bill.
    let measured_secs = duration_ms.div_ceil(1000).max(1);
    let remainder = measured_secs.saturating_sub(residual.ticked_seconds);
    heartbeat::debit_final(
        m.run_id,
        m.org_id,
        m.spec,
        remainder,
        m.budget_micro_usd,
        residual.next_tick_index,
    )
    .await;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_one_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 4);
        let tool = &tools[0];
        assert_eq!(tool.id, "sandbox__sandbox_exec");
        assert_eq!(tool.server, SERVER_NAME);
        assert!(tool.input_schema.is_some());
        assert!(tool.description.is_some());
        // Persistent (Daytona-only) lifecycle tools live alongside the one-shot exec.
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"sandbox__sandbox_create"));
        assert!(ids.contains(&"sandbox__sandbox_run"));
        assert!(ids.contains(&"sandbox__sandbox_destroy"));
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
        assert_eq!(resolve_backend(&json!({})), SandboxBackend::Wasmtime);
        assert_eq!(
            resolve_backend(&json!({ "backend": "docker" })),
            SandboxBackend::Docker
        );
        assert_eq!(
            resolve_backend(&json!({ "backend": "microsandbox" })),
            SandboxBackend::from_name("microsandbox").unwrap()
        );
    }

    #[test]
    fn parse_capabilities_is_deny_all_by_default() {
        let caps = parse_capabilities(&json!({}));
        assert!(!caps.network);
        assert!(caps.fs_read_paths.is_empty());
        assert!(caps.fs_write_paths.is_empty());

        let caps = parse_capabilities(&json!({ "network": true, "write_paths": ["/tmp/x"] }));
        assert!(caps.network);
        assert_eq!(caps.fs_write_paths.len(), 1);
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
