//! The off-by-default **secure-exec** PTC backend (feature `tool-exec-securexec`).
//!
//! Backed by rivet's `secure-exec` (`rivet-dev/secure-exec`): the guest program
//! runs inside a fully virtualized VM (a native sidecar — strong isolation, not
//! just a V8 isolate) and reaches Core's tools only through a single registered
//! host tool. This module is the Core (Rust) half; the Node/Bun half is
//! [`securexec_harness.mjs`] (embedded via `include_str!`).
//!
//! ## Architecture (two stdio hops)
//!
//! ```text
//!   Core (this file) ──tagged stdio──> bun harness.mjs ──secure-exec tool──> guest VM
//!        pump tool calls  <─TAG_CALL──     host handler   <─execFileSync──   tools.* proxy
//! ```
//!
//! Core speaks the **same tagged stdio protocol as the Deno backend**
//! (`TAG_CALL`/`TAG_LOG`/`TAG_DONE`/`TAG_ERROR`) to the harness; the harness is
//! the privileged host that runs the secure-exec VM and relays the guest's
//! `tools.*` calls back here. The protocol pump below is intentionally a
//! self-contained copy of the Deno pump (NOT a shared refactor) so the proven
//! Deno path is never touched.
//!
//! ## Availability / platform
//!
//! secure-exec's sidecar currently supports **Linux x64/arm64 only**, so this
//! backend reports unavailable on every other OS. It also needs `bun` on PATH
//! and a directory where `secure-exec` is installed (`RYU_SECUREXEC_DIR`,
//! containing `node_modules/secure-exec`) — Core does not bundle the npm package.
//!
//! ## Scope (v1)
//!
//! Supports the **execute** path with full tool fan-out, logs, return value,
//! wall-clock deadline, and output caps. Composio **elicitation (pause/resume)
//! is not supported yet** — a suspend surfaces to the guest as a tool error;
//! [`resume_parked`] never parks anything. Use the Deno backend for connect/
//! resume flows.
//!
//! ## Verification status
//!
//! The harness is syntax/bundle-checked against `secure-exec@0.3.0`'s real API
//! and the Rust side is compile-checked, but the end-to-end round-trip is **not
//! runtime-verified** here because the sidecar is Linux-only and the build host
//! is Windows. Enable on Linux to exercise it.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};

use super::{
    ExecOutcome, InvokeOutcome, ResumeDecision, SandboxToolInvoker, ToolInvocation,
    DEFAULT_DEADLINE_SECS, MAX_PREVIEW_CHARS,
};

/// The backend label used for audit.
pub const BACKEND_SECUREXEC: &str = "securexec";

// stdout line tags the harness emits — identical to the Deno backend's.
const TAG_CALL: &str = "@@RYU_TOOL_CALL@@";
const TAG_LOG: &str = "@@RYU_LOG@@";
const TAG_DONE: &str = "@@RYU_DONE@@";
const TAG_ERROR: &str = "@@RYU_ERROR@@";

/// The Node/Bun harness, embedded at compile time (kept as a real `.mjs` so it is
/// independently syntax/bundle-checkable with `bun build`).
const HARNESS_JS: &str = include_str!("securexec_harness.mjs");

/// The bun binary name/path. Overridable via `RYU_BUN_BIN` ("nothing hardcoded").
fn bun_bin() -> String {
    std::env::var("RYU_BUN_BIN").unwrap_or_else(|_| "bun".to_owned())
}

/// Directory containing `node_modules/secure-exec`, set via `RYU_SECUREXEC_DIR`.
/// The harness is written here and run with this as cwd so the `secure-exec`
/// import resolves. Core never installs the package — the operator provisions it.
fn securexec_dir() -> Option<PathBuf> {
    std::env::var("RYU_SECUREXEC_DIR")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
}

fn bun_on_path() -> bool {
    std::process::Command::new(bun_bin())
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Whether the secure-exec backend is runnable on this node: Linux (the sidecar's
/// only supported OS family), `bun` on PATH, and a provisioned `secure-exec`
/// install. Detection-only — never installs anything.
pub fn securexec_available() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    let Some(dir) = securexec_dir() else {
        return false;
    };
    if !dir.join("node_modules").join("secure-exec").exists() {
        return false;
    }
    bun_on_path()
}

/// The secure-exec executor. Stateless — there is no parked map (no resume).
pub struct SecureExecExecutor;

impl SecureExecExecutor {
    pub fn new() -> Self {
        SecureExecExecutor
    }

    /// Run `code` to completion in a secure-exec VM, bridging `tools.*` calls
    /// back to Core via `invoker`. `agent_id` is unused (no parking/resume).
    pub async fn execute(
        &self,
        code: &str,
        invoker: Arc<SandboxToolInvoker>,
        _agent_id: &str,
    ) -> ExecOutcome {
        if !securexec_available() {
            return ExecOutcome::error(
                "secure-exec backend unavailable: needs Linux + `bun` on PATH + RYU_SECUREXEC_DIR \
                 pointing at a directory with `secure-exec` installed (node_modules/secure-exec)",
            );
        }
        // Safe: `securexec_available()` already confirmed the dir exists.
        let dir = match securexec_dir() {
            Some(d) => d,
            None => return ExecOutcome::error("RYU_SECUREXEC_DIR is not set"),
        };

        // The harness must live where `secure-exec` resolves, so write it (and the
        // user code) into the provisioned dir under unique names.
        let token = uuid::Uuid::new_v4();
        let harness_path = dir.join(format!(".ryu-securexec-harness-{token}.mjs"));
        let code_path = dir.join(format!(".ryu-securexec-code-{token}.js"));
        if let Err(e) = std::fs::write(&harness_path, HARNESS_JS) {
            return ExecOutcome::error(format!("failed to write securexec harness: {e}"));
        }
        if let Err(e) = std::fs::write(&code_path, code) {
            let _ = std::fs::remove_file(&harness_path);
            return ExecOutcome::error(format!("failed to write securexec program: {e}"));
        }

        let result = run_harness(&dir, &harness_path, &code_path, invoker).await;

        let _ = std::fs::remove_file(&harness_path);
        let _ = std::fs::remove_file(&code_path);
        result
    }
}

/// Spawn the harness and pump the tagged stdio protocol until completion, error,
/// or the wall-clock deadline.
async fn run_harness(
    dir: &Path,
    harness_path: &Path,
    code_path: &Path,
    invoker: Arc<SandboxToolInvoker>,
) -> ExecOutcome {
    let mut child = match Command::new(bun_bin())
        .arg(harness_path)
        .arg(code_path)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return ExecOutcome::error(format!("failed to spawn bun: {e}")),
    };

    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut logs: Vec<String> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(DEFAULT_DEADLINE_SECS);

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            let _ = child.kill().await;
            return ExecOutcome::error("execution exceeded the wall-clock deadline and was killed");
        }

        let mut line = String::new();
        match tokio::time::timeout(remaining, stdout.read_line(&mut line)).await {
            Err(_) => {
                let _ = child.kill().await;
                return ExecOutcome::error(
                    "execution exceeded the wall-clock deadline and was killed",
                );
            }
            Ok(Ok(0)) => {
                let _ = child.wait().await;
                return completed(
                    logs,
                    None,
                    true,
                    Some("securexec harness exited unexpectedly"),
                );
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return ExecOutcome::error(format!("error reading harness output: {e}"));
            }
        }
        let line = line.trim_end_matches(['\n', '\r']);

        if let Some(rest) = line.strip_prefix(TAG_LOG) {
            push_log(&mut logs, rest);
        } else if let Some(rest) = line.strip_prefix(TAG_ERROR) {
            let _ = child.wait().await;
            return completed(logs, None, true, Some(rest));
        } else if let Some(rest) = line.strip_prefix(TAG_DONE) {
            let value = serde_json::from_str::<Value>(rest)
                .ok()
                .filter(|v| !v.is_null());
            let _ = child.wait().await;
            return completed(logs, value, false, None);
        } else if let Some(rest) = line.strip_prefix(TAG_CALL) {
            let req: Value = match serde_json::from_str(rest) {
                Ok(v) => v,
                Err(e) => {
                    let _ = child.kill().await;
                    return ExecOutcome::error(format!("malformed tool-call from harness: {e}"));
                }
            };
            let id = req.get("id").cloned().unwrap_or(Value::Null);
            let path = req
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let args = req.get("args").cloned().unwrap_or(Value::Null);

            let remaining = deadline.saturating_duration_since(Instant::now());
            let invoked =
                tokio::time::timeout(remaining, invoker.invoke(ToolInvocation { path, args }))
                    .await;
            let outcome = match invoked {
                Ok(o) => o,
                Err(_) => {
                    let _ = child.kill().await;
                    return ExecOutcome::error(
                        "execution exceeded the wall-clock deadline and was killed",
                    );
                }
            };
            let reply = match outcome {
                InvokeOutcome::Result(r) => json!({
                    "id": id,
                    "ok": !r.is_error,
                    "value": sanitize_value(&r.value),
                    "error": r.error,
                }),
                // Pause/resume is not supported on this backend yet: surface it to
                // the guest as a tool error rather than hanging the sync call.
                InvokeOutcome::Suspend(_) => json!({
                    "id": id,
                    "ok": false,
                    "value": Value::Null,
                    "error": "Composio elicitation is not supported on the secure-exec backend yet; use the Deno backend for connect/resume flows.",
                }),
            };
            if let Err(e) = write_line(&mut stdin, &reply.to_string()).await {
                let _ = child.kill().await;
                return ExecOutcome::error(format!("failed to reply to harness: {e}"));
            }
        }
        // Any other line is ignored — the protocol is tagged.
    }
}

/// Resume is not supported by the secure-exec backend (it never parks).
pub async fn resume_parked(
    _execution_id: &str,
    _agent_id: &str,
    _decision: ResumeDecision,
    _content: Value,
) -> Option<ExecOutcome> {
    None
}

// ── stdio + sanitization helpers (self-contained; mirror the Deno backend) ─────

async fn write_line(stdin: &mut ChildStdin, line: &str) -> std::io::Result<()> {
    stdin.write_all(line.as_bytes()).await?;
    stdin.write_all(b"\n").await?;
    stdin.flush().await
}

fn completed(
    logs: Vec<String>,
    result: Option<Value>,
    is_error: bool,
    error: Option<&str>,
) -> ExecOutcome {
    ExecOutcome::Completed {
        result: result.map(|v| sanitize_value(&v)),
        logs,
        is_error,
        error: error.map(sanitize_text),
    }
}

/// Append a log line, capping total log volume at [`MAX_PREVIEW_CHARS`].
fn push_log(logs: &mut Vec<String>, line: &str) {
    let used: usize = logs.iter().map(String::len).sum();
    if used >= MAX_PREVIEW_CHARS {
        return;
    }
    let room = MAX_PREVIEW_CHARS - used;
    let stripped = strip_control(line);
    logs.push(truncate_bytes(&stripped, room));
}

fn truncate_bytes(s: &str, max_bytes: usize) -> String {
    let mut used = 0usize;
    let mut out = String::with_capacity(max_bytes.min(s.len()));
    for c in s.chars() {
        let w = c.len_utf8();
        if used + w > max_bytes {
            break;
        }
        out.push(c);
        used += w;
    }
    out
}

fn strip_control(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .collect()
}

fn sanitize_text(s: &str) -> String {
    let stripped = strip_control(s);
    truncate_bytes(&stripped, MAX_PREVIEW_CHARS)
}

fn sanitize_value(v: &Value) -> Value {
    let cleaned = strip_value_strings(v);
    let serialized = cleaned.to_string();
    if serialized.len() > MAX_PREVIEW_CHARS {
        json!({ "__truncated__": true, "preview": truncate_bytes(&serialized, MAX_PREVIEW_CHARS) })
    } else {
        cleaned
    }
}

fn strip_value_strings(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(strip_control(s)),
        Value::Array(a) => Value::Array(a.iter().map(strip_value_strings).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| (k.clone(), strip_value_strings(val)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_off_linux_or_without_dir() {
        // On the Windows build host this is always false (sidecar is Linux-only).
        // On Linux without RYU_SECUREXEC_DIR it is also false.
        if cfg!(not(target_os = "linux")) {
            assert!(!securexec_available());
        }
    }

    #[test]
    fn sanitize_caps_oversized_value() {
        let big = "x".repeat(MAX_PREVIEW_CHARS + 500);
        let out = sanitize_value(&json!({ "data": big }));
        assert_eq!(out["__truncated__"], true);
    }

    #[test]
    fn strip_control_removes_escapes_keeps_tabs() {
        assert_eq!(strip_control("a\u{1b}[31mb\tc"), "a[31mb\tc");
    }

    #[tokio::test]
    async fn resume_is_unsupported() {
        let out = resume_parked("x", "ryu", ResumeDecision::Accept, json!({})).await;
        assert!(out.is_none());
    }
}
