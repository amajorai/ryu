//! OpenSandbox backend implementing the Core [`Sandbox`] trait.
//!
//! Runs workloads via the `osb` CLI (project:
//! `opensandbox-group/OpenSandbox`). OpenSandbox fronts secure container
//! runtimes (gVisor / Kata / Firecracker) behind a uniform API; Core drives it
//! through the CLI exactly like [`super::docker`] and [`super::microsandbox`] —
//! **no compile-time dependency, no install/bundle path**. Core detects `osb`
//! and uses it, or falls back to wasmtime.
//!
//! ## CLI surface (per the project README)
//!
//! OpenSandbox has no one-shot exec; a run is always *create → run → delete*:
//! - create: `osb sandbox create --image <image> --timeout <t> -o json` → JSON
//!   carrying the sandbox id.
//! - run:    `osb command run <id> -o raw -- <command> [args]`
//! - delete: `osb sandbox delete <id>`
//!
//! So [`Sandbox::exec`] composes all three (create, run, best-effort delete),
//! while the workspace methods map one-to-one to create / run / delete and keep
//! the sandbox alive between calls.
//!
//! Network / volume flags are not documented in the README excerpt, so the
//! capability descriptor is honored only at the runtime's inherent isolation
//! boundary (no extra flags emitted) — the same conservative posture as the
//! microsandbox backend. The connection (domain / protocol / api-key) is
//! configured out-of-band via `osb config set …`; Core does not manage it.
//!
//! ## Config
//!
//! | Env var                            | Default        | Meaning                     |
//! |------------------------------------|----------------|-----------------------------|
//! | `RYU_SANDBOX_OPENSANDBOX_BINARY`   | `osb`          | Path / name of osb binary   |
//! | `RYU_SANDBOX_OPENSANDBOX_IMAGE`    | `python:3.12`  | Default image               |
//! | `RYU_SANDBOX_OPENSANDBOX_TIMEOUT`  | `30m`          | Sandbox lifetime            |
//! | `RYU_SANDBOX_OPENSANDBOX_DETECT_SECS`| `3`          | Detection probe timeout (s) |

use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::sidecar::BoxFuture;
use crate::win_process::NoWindow;

// ── Configuration knobs ──────────────────────────────────────────────────────

pub const ENV_BINARY: &str = "RYU_SANDBOX_OPENSANDBOX_BINARY";
pub const ENV_IMAGE: &str = "RYU_SANDBOX_OPENSANDBOX_IMAGE";
pub const ENV_TIMEOUT: &str = "RYU_SANDBOX_OPENSANDBOX_TIMEOUT";
pub const ENV_DETECT_SECS: &str = "RYU_SANDBOX_OPENSANDBOX_DETECT_SECS";

const DEFAULT_BINARY: &str = "osb";
const DEFAULT_IMAGE: &str = "python:3.12";
const DEFAULT_TIMEOUT: &str = "30m";
const DEFAULT_DETECT_SECS: u64 = 3;

fn binary() -> String {
    std::env::var(ENV_BINARY).unwrap_or_else(|_| DEFAULT_BINARY.to_owned())
}

fn image() -> String {
    std::env::var(ENV_IMAGE).unwrap_or_else(|_| DEFAULT_IMAGE.to_owned())
}

fn lifetime() -> String {
    std::env::var(ENV_TIMEOUT).unwrap_or_else(|_| DEFAULT_TIMEOUT.to_owned())
}

fn detect_timeout() -> Duration {
    let secs = std::env::var(ENV_DETECT_SECS)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DETECT_SECS);
    Duration::from_secs(secs)
}

// ── Detection ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    Available,
    Unavailable(String),
}

/// Probe whether `osb` is usable. Detection-only: `osb --version`, short
/// timeout, never installs anything.
pub async fn detect() -> DetectResult {
    let binary = binary();
    let deadline = detect_timeout();

    let probe = timeout(
        deadline,
        Command::new(&binary).arg("--version").no_window().output(),
    )
    .await;

    match probe {
        Err(_elapsed) => {
            DetectResult::Unavailable(format!("osb probe timed out after {}s", deadline.as_secs()))
        }
        Ok(Err(io_err)) => {
            DetectResult::Unavailable(format!("osb binary not found or not executable: {io_err}"))
        }
        Ok(Ok(output)) => {
            if output.status.success() {
                DetectResult::Available
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                DetectResult::Unavailable(format!("osb not usable: {}", stderr.trim()))
            }
        }
    }
}

// ── OpenSandbox ──────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct OpenSandboxSandbox;

impl OpenSandboxSandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for OpenSandboxSandbox {
    fn default() -> Self {
        Self::new()
    }
}

/// Create a sandbox and return its id (parsed from the `-o json` create output).
async fn create_sandbox(_caps: &SandboxCapabilities) -> Result<String> {
    let output = Command::new(binary())
        .arg("sandbox")
        .arg("create")
        .arg("--image")
        .arg(image())
        .arg("--timeout")
        .arg(lifetime())
        .arg("-o")
        .arg("json")
        .no_window()
        .output()
        .await
        .map_err(|e| anyhow!("osb sandbox create failed: {e}"))?;

    if !output.status.success() {
        return Err(anyhow!(
            "osb sandbox create failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    extract_sandbox_id(&stdout).ok_or_else(|| {
        anyhow!(
            "osb sandbox create returned no recognisable id: {}",
            stdout.trim()
        )
    })
}

/// Pull a sandbox id out of the create command's JSON, tolerating the common
/// key spellings (`id`, `sandbox_id`, `sandboxId`), at top level or nested under
/// a `data`/`sandbox` object.
fn extract_sandbox_id(stdout: &str) -> Option<String> {
    let json: Value = serde_json::from_str(stdout.trim()).ok()?;
    fn id_in(obj: &Value) -> Option<String> {
        for key in ["id", "sandbox_id", "sandboxId"] {
            if let Some(s) = obj.get(key).and_then(Value::as_str) {
                if !s.is_empty() {
                    return Some(s.to_owned());
                }
            }
        }
        None
    }
    id_in(&json)
        .or_else(|| json.get("data").and_then(id_in))
        .or_else(|| json.get("sandbox").and_then(id_in))
}

/// Run a command in an existing sandbox via `osb command run <id> -o raw`.
async fn run_in(id: &str, spec: &ExecSpec) -> Result<ExecOutput> {
    let mut cmd = Command::new(binary());
    cmd.arg("command")
        .arg("run")
        .arg(id)
        .arg("-o")
        .arg("raw")
        .arg("--")
        .arg(&spec.command);
    for arg in &spec.args {
        cmd.arg(arg);
    }

    let has_stdin = spec.stdin.is_some();
    if has_stdin {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.no_window();

    let stdin = spec.stdin.clone();
    let run = async move {
        if let Some(bytes) = stdin {
            let mut child = cmd
                .spawn()
                .map_err(|e| anyhow!("osb command run spawn failed: {e}"))?;
            if let Some(mut writer) = child.stdin.take() {
                use tokio::io::AsyncWriteExt as _;
                writer
                    .write_all(&bytes)
                    .await
                    .map_err(|e| anyhow!("osb command run stdin write failed: {e}"))?;
            }
            child
                .wait_with_output()
                .await
                .map_err(|e| anyhow!("osb command run wait failed: {e}"))
        } else {
            cmd.output()
                .await
                .map_err(|e| anyhow!("osb command run failed: {e}"))
        }
    };

    let output = match spec.timeout_secs {
        Some(secs) => timeout(Duration::from_secs(secs), run)
            .await
            .map_err(|_| anyhow!("osb command run timed out after {secs}s"))?,
        None => run.await,
    }?;

    Ok(ExecOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

/// Best-effort sandbox deletion. Errors are swallowed: a leaked sandbox is the
/// runtime's own timeout to reap, and a delete failure must not mask a result.
async fn delete_sandbox(id: &str) {
    let _ = Command::new(binary())
        .arg("sandbox")
        .arg("delete")
        .arg(id)
        .no_window()
        .output()
        .await;
}

impl Sandbox for OpenSandboxSandbox {
    fn name(&self) -> &'static str {
        "opensandbox"
    }

    // ── Ephemeral exec = create → run → delete ────────────────────────────────

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let id = create_sandbox(&spec.capabilities).await?;
            let result = run_in(&id, &spec).await;
            delete_sandbox(&id).await;
            result
        })
    }

    // ── Long-lived workspace ──────────────────────────────────────────────────

    fn create_workspace(
        &self,
        capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            let id = create_sandbox(&capabilities).await?;
            Ok(WorkspaceId(id))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let id = id.0.clone();
        Box::pin(async move { run_in(&id, &spec).await })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let id = id.0.clone();
        Box::pin(async move {
            delete_sandbox(&id).await;
            Ok(())
        })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_name_is_opensandbox() {
        assert_eq!(OpenSandboxSandbox::new().name(), "opensandbox");
    }

    #[test]
    fn id_extraction_handles_key_variants() {
        assert_eq!(
            extract_sandbox_id(r#"{"id":"sbx-1"}"#).as_deref(),
            Some("sbx-1")
        );
        assert_eq!(
            extract_sandbox_id(r#"{"sandbox_id":"sbx-2"}"#).as_deref(),
            Some("sbx-2")
        );
        assert_eq!(
            extract_sandbox_id(r#"{"data":{"sandboxId":"sbx-3"}}"#).as_deref(),
            Some("sbx-3")
        );
        assert!(extract_sandbox_id("not json").is_none());
        assert!(extract_sandbox_id(r#"{"other":"x"}"#).is_none());
    }

    #[tokio::test]
    async fn detect_never_hangs() {
        let result =
            tokio::time::timeout(Duration::from_secs(DEFAULT_DETECT_SECS * 2 + 2), detect())
                .await
                .expect("detect() must not hang beyond 2× timeout");
        match result {
            DetectResult::Available => {}
            DetectResult::Unavailable(reason) => assert!(!reason.is_empty()),
        }
    }

    #[tokio::test]
    async fn exec_with_missing_binary_returns_err() {
        unsafe { std::env::set_var(ENV_BINARY, "/nonexistent-osb-ryu-test") };
        let sb = OpenSandboxSandbox::new();
        let result = sb.exec(ExecSpec::new("echo", vec!["hi".to_owned()])).await;
        assert!(result.is_err(), "exec with missing binary must be Err");
        unsafe { std::env::remove_var(ENV_BINARY) };
    }
}
