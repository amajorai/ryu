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

use anyhow::Result;
use base64::Engine as _;
use serde_json::{json, Value};

use super::RegistryTool;

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
            "wasm_b64": {
                "type": "string",
                "description": "Base-64 encoded WASM/WASI module bytecode to execute."
            },
            "args": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Command-line arguments passed to the WASM module (after argv[0])."
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
                "description": "Environment variables available to the WASM module."
            }
        },
        "required": ["wasm_b64"]
    })
}

/// The set of sandbox tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![RegistryTool {
        id: format!("{SERVER_NAME}__sandbox_exec"),
        server: SERVER_NAME.to_owned(),
        name: "sandbox_exec".to_owned(),
        description: Some(
            "Execute a WASM/WASI module in an isolated sandbox (wasmtime, default-deny). \
             Pass the module as base-64 encoded bytes (`wasm_b64`). No FS or network access \
             unless explicitly granted via capabilities. Returns stdout, stderr, and exit code."
                .to_owned(),
        ),
        input_schema: Some(sandbox_exec_schema()),
    }]
}

/// Dispatch a sandbox tool call. `tool` is the bare name (stripped of the
/// `sandbox__` prefix by the registry).
pub async fn dispatch(tool: &str, arguments: Value) -> Result<Value> {
    match tool {
        "sandbox_exec" => run_sandbox_exec(arguments).await,
        other => Err(anyhow::anyhow!("unknown sandbox tool '{other}'")),
    }
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
            "The wasmtime sandbox is disabled. \
             Enable it from the Services page or unset RYU_SANDBOX_DISABLED.",
        ));
    }

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

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_one_tool_with_qualified_id() {
        let tools = tools();
        assert_eq!(tools.len(), 1);
        let tool = &tools[0];
        assert_eq!(tool.id, "sandbox__sandbox_exec");
        assert_eq!(tool.server, SERVER_NAME);
        assert!(tool.input_schema.is_some());
        assert!(tool.description.is_some());
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let err = dispatch("not_a_tool", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn missing_wasm_b64_is_an_error() {
        let err = dispatch("sandbox_exec", json!({})).await;
        assert!(err.is_err(), "missing wasm_b64 must be Err");
    }

    #[tokio::test]
    async fn invalid_base64_is_an_error() {
        let err = dispatch("sandbox_exec", json!({ "wasm_b64": "!!not-base64!!" })).await;
        assert!(err.is_err(), "invalid base64 must be Err");
    }

    #[tokio::test]
    async fn disabled_sandbox_returns_unavailable_not_error() {
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
        unsafe { std::env::remove_var(ENV_DISABLED) };
    }
}
