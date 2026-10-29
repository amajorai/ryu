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
//! Network / volume flags are not documented in the README excerpt. Core
//! therefore accepts only the deny-all capability set and rejects any request
//! that would require an unverified flag. The connection (domain / protocol /
//! api-key) is configured out-of-band via `osb config set …`; Core does not
//! manage it.
//!
//! ## Config
//!
//! | Env var                            | Default        | Meaning                     |
//! |------------------------------------|----------------|-----------------------------|
//! | `RYU_SANDBOX_OPENSANDBOX_BINARY`   | `osb`          | Path / name of osb binary   |
//! | `RYU_SANDBOX_OPENSANDBOX_IMAGE`    | `python:3.12`  | Default image               |
//! | `RYU_SANDBOX_OPENSANDBOX_TIMEOUT`  | `30m`          | Sandbox lifetime            |
//! | `RYU_SANDBOX_OPENSANDBOX_DETECT_SECS`| `3`          | Detection probe timeout (s) |

use crate::capture::BoundedCommand;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::process_output::output_capped;
use crate::win_process::NoWindow;
use crate::BoxFuture;

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
        Command::new(&binary)
            .arg("--version")
            .no_window()
            .bounded_output(),
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
    pub fn governed() -> crate::governed::GovernedOpenSandbox {
        crate::governed::GovernedOpenSandbox::new(binary().into(), image(), lifetime())
    }
}

impl Default for OpenSandboxSandbox {
    fn default() -> Self {
        Self::new()
    }
}

/// Reject capabilities that the documented `osb` CLI cannot express safely.
fn ensure_capabilities_supported(caps: &SandboxCapabilities) -> Result<()> {
    if caps.network || !caps.fs_read_paths.is_empty() || !caps.fs_write_paths.is_empty() {
        return Err(anyhow!(
            "opensandbox cannot safely express requested filesystem or network capabilities; use wasmtime or docker"
        ));
    }
    Ok(())
}

/// Create a sandbox and return its id (parsed from the `-o json` create output).
async fn create_sandbox(caps: &SandboxCapabilities) -> Result<String> {
    ensure_capabilities_supported(caps)?;
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
        .bounded_output()
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
    run_in_with_binary(id, spec, binary()).await
}

async fn run_in_with_binary(id: &str, spec: &ExecSpec, binary: String) -> Result<ExecOutput> {
    ensure_capabilities_supported(&spec.capabilities)?;
    let mut cmd = Command::new(&binary);
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

    cmd.stdin(if spec.stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    })
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .no_window();
    let cleanup_id = id.to_owned();
    let mut cleanup = crate::WorkspaceCleanup::new(Box::pin(async move {
        delete_sandbox_with_binary(&cleanup_id, &binary).await;
        Ok(())
    }));
    let output = output_capped(
        &mut cmd,
        spec.stdin.clone(),
        spec.timeout_secs,
        "osb command run",
    )
    .await;
    if output.is_err() {
        cleanup.finish().await?;
    } else {
        cleanup.disarm();
    }
    let output = output?;

    Ok(ExecOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

/// Best-effort sandbox deletion. Errors are swallowed: a leaked sandbox is the
/// runtime's own timeout to reap, and a delete failure must not mask a result.
async fn delete_sandbox(id: &str) {
    delete_sandbox_with_binary(id, &binary()).await;
}

async fn delete_sandbox_with_binary(id: &str, binary: &str) {
    let mut cmd = Command::new(binary);
    cmd.args(["sandbox", "delete", id])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .no_window();
    let _ = timeout(Duration::from_secs(3), cmd.status()).await;
}

impl Sandbox for OpenSandboxSandbox {
    fn name(&self) -> &'static str {
        "opensandbox"
    }

    // ── Ephemeral exec = create → run → delete ────────────────────────────────

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            crate::process_output::execution_timeout(spec.timeout_secs, 30)?;
            let id = create_sandbox(&spec.capabilities).await?;
            let mut cleanup = crate::WorkspaceCleanup::new(
                OpenSandboxSandbox::new().destroy_workspace(&WorkspaceId(id.clone())),
            );
            let result = run_in(&id, &spec).await;
            cleanup.finish().await?;
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
        Box::pin(async move {
            crate::process_output::execution_timeout(spec.timeout_secs, 30)?;
            let result = run_in(&id, &spec).await;
            if result.is_err() {
                delete_sandbox(&id).await;
            }
            result
        })
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

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_command_captures_stdin_streams_and_guest_exit_without_deleting_workspace() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("fake-osb");
        let log = directory.path().join("commands.log");
        std::fs::write(&binary, format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\ncat; printf 'guest stdout'; printf 'guest stderr' >&2; exit 7\n", log.display()
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut spec = ExecSpec::new("echo", vec!["hello".to_owned()]);
        spec.stdin = Some(b"guest stdin\n".to_vec());
        let output =
            run_in_with_binary("workspace-1", &spec, binary.to_string_lossy().into_owned())
                .await
                .unwrap();
        assert_eq!(output.exit_code, 7);
        assert_eq!(output.stdout, b"guest stdin\nguest stdout");
        assert_eq!(output.stderr, b"guest stderr");
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "command run workspace-1 -o raw -- echo hello\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_workspace_command_deletes_its_exact_workspace() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("fake-osb");
        let log = directory.path().join("commands.log");
        std::fs::write(&binary, format!(
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = command ]; then sleep 3; fi\n", log.display()
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut spec = ExecSpec::new("echo", vec!["hello".to_owned()]);
        spec.timeout_secs = Some(1);
        let error = run_in_with_binary("workspace-1", &spec, binary.to_string_lossy().into_owned())
            .await
            .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "command run workspace-1 -o raw -- echo hello\nsandbox delete workspace-1\n"
        );
    }

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

    #[test]
    fn unsupported_capabilities_fail_closed() {
        assert!(ensure_capabilities_supported(&SandboxCapabilities::default()).is_ok());
        let mut caps = SandboxCapabilities::default();
        caps.network = true;
        assert!(ensure_capabilities_supported(&caps).is_err());
        caps.network = false;
        caps.fs_write_paths.insert(std::path::PathBuf::from("/tmp"));
        assert!(ensure_capabilities_supported(&caps).is_err());
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
