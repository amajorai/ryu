//! microsandbox backend implementing the Core [`Sandbox`] trait.
//!
//! Runs workloads in microVMs via the `msb` CLI (project:
//! `superradcompany/microsandbox`). Like [`super::docker`], this shells out to a
//! CLI that must already be on `PATH` — there is **no compile-time dependency**
//! and **no install/bundle path**: Core detects `msb` and uses it, or silently
//! falls back to the wasmtime default.
//!
//! ## Why microVMs
//!
//! microsandbox gives hardware-level isolation (KVM on Linux, Apple's
//! Hypervisor on Apple Silicon) with sub-100ms boot. The microVM boundary is
//! deny-by-default for network and filesystem, which is why the capability
//! mapping below is conservative: the strong default is "isolated", and we only
//! relax it where the CLI exposes a documented flag.
//!
//! ## Platform reality
//!
//! `msb` only runs where a hypervisor is available (Linux + KVM, macOS Apple
//! Silicon). On every other host [`detect`] returns
//! [`super::docker::DetectResult::Unavailable`] equivalent (`Unavailable`) and
//! the caller falls back to wasmtime. The code itself compiles everywhere.
//!
//! ## CLI surface (per the project README)
//!
//! - Ephemeral: `msb run <image> -- <command> [args]`
//! - Workspace: `msb create --name <id> <image>` → `msb exec <id> -- <cmd>` →
//!   `msb rm <id>`
//!
//! Network / volume-mount flags are **not documented** in the CLI today. Core
//! therefore accepts only the deny-all capability set for this backend and
//! rejects any request that would require an unverified flag. This prevents a
//! requested read, write, or network grant from being silently ignored.
//!
//! ## Config
//!
//! | Env var                              | Default   | Meaning                       |
//! |--------------------------------------|-----------|-------------------------------|
//! | `RYU_SANDBOX_MICROSANDBOX_BINARY`    | `msb`     | Path / name of the msb binary |
//! | `RYU_SANDBOX_MICROSANDBOX_IMAGE`     | `python`  | Default image for exec + WS    |
//! | `RYU_SANDBOX_MICROSANDBOX_DETECT_SECS`| `3`      | Detection probe timeout (s)   |

use crate::capture::BoundedCommand;
use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::process::Command;
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::process_output::output_capped;
use crate::win_process::NoWindow;
use crate::BoxFuture;

// ── Configuration knobs (all swappable, nothing hardcoded) ───────────────────

/// Name / path of the `msb` binary. Defaults to `msb` (resolved via PATH).
pub const ENV_BINARY: &str = "RYU_SANDBOX_MICROSANDBOX_BINARY";
/// Default microVM image. Swappable at runtime via env var.
pub const ENV_IMAGE: &str = "RYU_SANDBOX_MICROSANDBOX_IMAGE";
/// Detection probe timeout in seconds.
pub const ENV_DETECT_SECS: &str = "RYU_SANDBOX_MICROSANDBOX_DETECT_SECS";

const DEFAULT_BINARY: &str = "msb";
/// The README's documented image; carries a Python runtime + a shell.
const DEFAULT_IMAGE: &str = "python";
const DEFAULT_DETECT_SECS: u64 = 3;

fn binary() -> String {
    std::env::var(ENV_BINARY).unwrap_or_else(|_| DEFAULT_BINARY.to_owned())
}

fn image() -> String {
    std::env::var(ENV_IMAGE).unwrap_or_else(|_| DEFAULT_IMAGE.to_owned())
}

fn detect_timeout() -> Duration {
    let secs = std::env::var(ENV_DETECT_SECS)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DETECT_SECS);
    Duration::from_secs(secs)
}

// ── Detection ────────────────────────────────────────────────────────────────

/// Result of the `msb` availability probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// `msb` is on PATH and responded to `--version`.
    Available,
    /// Binary missing, timed out, or hypervisor unavailable.
    Unavailable(String),
}

/// Probe whether `msb` is usable on this host. Detection-only: runs
/// `msb --version` with a short timeout, never installs anything.
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
            DetectResult::Unavailable(format!("msb probe timed out after {}s", deadline.as_secs()))
        }
        Ok(Err(io_err)) => {
            DetectResult::Unavailable(format!("msb binary not found or not executable: {io_err}"))
        }
        Ok(Ok(output)) => {
            if output.status.success() {
                DetectResult::Available
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                DetectResult::Unavailable(format!("msb not usable: {}", stderr.trim()))
            }
        }
    }
}

// ── Capability validation ────────────────────────────────────────────────────

/// Reject capabilities that the documented `msb` CLI cannot express safely.
///
/// The microVM remains deny-by-default, but an empty flag list must not be
/// mistaken for enforcement of a requested grant. Once `msb` documents and
/// Core verifies equivalent flags, this is the single edit site to extend.
fn ensure_capabilities_supported(caps: &SandboxCapabilities) -> Result<()> {
    if caps.network || !caps.fs_read_paths.is_empty() || !caps.fs_write_paths.is_empty() {
        return Err(anyhow!(
            "microsandbox cannot safely express requested filesystem or network capabilities; use wasmtime or docker"
        ));
    }
    Ok(())
}

// ── MicrosandboxSandbox ──────────────────────────────────────────────────────

/// microsandbox backend: detect-only, CLI-driven, zero compile-time dependency.
#[derive(Clone)]
pub struct MicrosandboxSandbox;

impl MicrosandboxSandbox {
    /// Construct the backend. Cheap: no I/O at construction time.
    pub fn new() -> Self {
        Self
    }
}

impl Default for MicrosandboxSandbox {
    fn default() -> Self {
        Self::new()
    }
}

/// Run a `Command`, applying `spec`'s stdin + timeout, and collect the output.
async fn run_command(
    mut cmd: Command,
    stdin: Option<Vec<u8>>,
    timeout_secs: Option<u64>,
    ctx: &'static str,
) -> Result<std::process::Output> {
    cmd.stdin(if stdin.is_some() {
        std::process::Stdio::piped()
    } else {
        std::process::Stdio::null()
    })
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped())
    .no_window();

    let label = format!("msb {ctx}");
    output_capped(&mut cmd, stdin, timeout_secs, &label).await
}

async fn stop_remove_workspace(binary: &str, name: &str) -> Result<()> {
    force_remove_ephemeral(binary, name).await
}

async fn force_remove_ephemeral(binary: &str, name: &str) -> Result<()> {
    let mut cmd = Command::new(binary);
    cmd.arg("rm").arg("--force").arg(name).no_window();
    let output = run_command(cmd, None, Some(5), "rm --force").await?;
    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(256)
            .collect();
        return Err(anyhow!(
            "msb rm --force failed for {name}: {} {detail}",
            output.status
        ));
    }
    Ok(())
}

async fn exec_named(
    spec: ExecSpec,
    binary: String,
    cancelled: Option<oneshot::Receiver<()>>,
) -> Result<ExecOutput> {
    crate::process_output::execution_timeout(spec.timeout_secs, 30)?;
    ensure_capabilities_supported(&spec.capabilities)?;
    // A named VM remains addressable after the CLI is killed on timeout.
    // Always remove it explicitly so guest work cannot outlive our run.
    let name = format!("ryu-run-{}", uuid::Uuid::new_v4());
    let mut cmd = Command::new(&binary);
    cmd.arg("run").arg("--name").arg(&name);
    cmd.arg(image());
    cmd.arg("--");
    cmd.arg(&spec.command);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    cmd.no_window();

    let mut run = Box::pin(run_command(cmd, spec.stdin, spec.timeout_secs, "run"));
    let output = if let Some(mut cancelled) = cancelled {
        tokio::select! {
            output = &mut run => output,
            _ = &mut cancelled => Err(anyhow!("msb run cancelled")),
        }
    } else {
        (&mut run).await
    };
    // Drop the CLI future before VM removal; kill_on_drop terminates its child.
    drop(run);
    let removal = force_remove_ephemeral(&binary, &name).await;
    // A cleanup failure means the guest may still be consuming resources.
    let output = match (output, removal) {
        (Ok(output), Ok(())) => output,
        (Err(run_error), Ok(())) => return Err(run_error),
        (Ok(_), Err(removal_error)) => return Err(removal_error),
        (Err(run_error), Err(removal_error)) => {
            return Err(anyhow!("{run_error}; VM cleanup failed: {removal_error}"));
        }
    };
    Ok(ExecOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

fn spawn_owned_exec(spec: ExecSpec, binary: String) -> BoxFuture<Result<ExecOutput>> {
    Box::pin(async move {
        // Cancellation drops this sender. The owner then kills the CLI and
        // removes the named VM before it exits.
        let (cancel_tx, cancel_rx) = oneshot::channel();
        let result = tokio::spawn(exec_named(spec, binary, Some(cancel_rx)))
            .await
            .map_err(|error| anyhow!("msb execution task failed: {error}"));
        drop(cancel_tx);
        result?
    })
}

impl Sandbox for MicrosandboxSandbox {
    fn name(&self) -> &'static str {
        "microsandbox"
    }

    // ── Ephemeral exec: `msb run <image> -- <command> [args]` ─────────────────

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        spawn_owned_exec(spec, binary())
    }

    // ── Long-lived workspace ──────────────────────────────────────────────────

    fn create_workspace(
        &self,
        capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            ensure_capabilities_supported(&capabilities)?;
            let name = format!("ryu-{}", uuid::Uuid::new_v4());
            let mut cleanup = crate::WorkspaceCleanup::new(
                MicrosandboxSandbox::new().destroy_workspace(&WorkspaceId(name.clone())),
            );
            let mut cmd = Command::new(binary());
            cmd.arg("create").arg("--name").arg(&name);
            cmd.arg(image());
            cmd.no_window();

            let output = cmd
                .bounded_output()
                .await
                .map_err(|e| anyhow!("msb create failed: {e}"))?;
            if !output.status.success() {
                return Err(anyhow!(
                    "msb create failed (exit {}): {}",
                    output.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }

            // Start the sandbox so `exec` can attach (idempotent if already up).
            let _ = Command::new(binary())
                .arg("start")
                .arg(&name)
                .no_window()
                .bounded_output()
                .await;

            cleanup.disarm();
            Ok(WorkspaceId(name))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let name = id.0.clone();
        Box::pin(async move {
            crate::process_output::execution_timeout(spec.timeout_secs, 30)?;
            ensure_capabilities_supported(&spec.capabilities)?;
            let binary = binary();
            let mut cmd = Command::new(&binary);
            cmd.arg("exec").arg(&name).arg("--").arg(&spec.command);
            for arg in &spec.args {
                cmd.arg(arg);
            }
            cmd.no_window();

            let mut cleanup = crate::WorkspaceCleanup::new(
                MicrosandboxSandbox::new().destroy_workspace(&WorkspaceId(name.clone())),
            );
            let result = run_command(cmd, spec.stdin, spec.timeout_secs, "exec").await;
            if result.is_err() {
                cleanup.finish().await?;
            } else {
                cleanup.disarm();
            }
            let output = result?;
            Ok(ExecOutput {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let name = id.0.clone();
        Box::pin(async move { force_remove_ephemeral(&binary(), &name).await })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_run_force_removes_the_named_guest() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!("ryu-msb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("fake-msb");
        let log = directory.join("commands.log");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = run ]; then sleep 3; fi\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut spec = ExecSpec::new("echo", vec!["hello".to_owned()]);
        spec.timeout_secs = Some(1);
        let result = exec_named(spec, binary.to_string_lossy().into_owned(), None).await;
        let commands = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<_> = commands.lines().collect();
        assert!(result.unwrap_err().to_string().contains("timed out"));
        assert_eq!(lines.len(), 2, "run and forced removal must both occur");
        let name = lines[0].split_whitespace().nth(2).unwrap();
        assert!(lines[0].starts_with("run --name ryu-run-"));
        assert_eq!(lines[1], format!("rm --force {name}"));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_wait_still_removes_the_named_guest() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!("ryu-msb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("fake-msb");
        let log = directory.join("commands.log");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = run ]; then sleep 3; fi\n",
                log.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let spec = ExecSpec::new("echo", vec!["hello".to_owned()]);
        let waiting = tokio::spawn(spawn_owned_exec(
            spec,
            binary.to_string_lossy().into_owned(),
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while !log.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        waiting.abort();
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if std::fs::read_to_string(&log).is_ok_and(|commands| {
                    commands.lines().any(|line| line.starts_with("rm --force"))
                }) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled owner must force-remove before the guest finishes");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn completed_run_removes_guest_and_reports_cleanup_failure() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!("ryu-msb-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let binary = directory.join("fake-msb");
        let log = directory.join("commands.log");
        let fail_marker = directory.join("fail-removal");
        std::fs::write(
            &binary,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nif [ \"$1\" = rm ] && [ -f '{}' ]; then exit 7; fi\nif [ \"$1\" = run ]; then cat; printf 'guest stdout'; printf 'guest stderr' >&2; fi\n",
                log.display(),
                fail_marker.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let binary = binary.to_string_lossy().into_owned();
        let mut spec = ExecSpec::new("echo", vec!["ok".to_owned()]);
        spec.stdin = Some(b"guest stdin\n".to_vec());
        let output = exec_named(spec, binary.clone(), None).await.unwrap();
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout, b"guest stdin\nguest stdout");
        assert_eq!(output.stderr, b"guest stderr");
        std::fs::write(&fail_marker, "1").unwrap();
        let error = exec_named(
            ExecSpec::new("echo", vec!["again".to_owned()]),
            binary,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("rm --force failed"));
        let commands = std::fs::read_to_string(log).unwrap();
        assert_eq!(commands.lines().count(), 4);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn backend_name_is_microsandbox() {
        assert_eq!(MicrosandboxSandbox::new().name(), "microsandbox");
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

    #[test]
    fn unsupported_capabilities_fail_closed() {
        assert!(ensure_capabilities_supported(&SandboxCapabilities::default()).is_ok());
        let mut caps = SandboxCapabilities::default();
        caps.network = true;
        assert!(ensure_capabilities_supported(&caps).is_err());
        caps.network = false;
        caps.fs_read_paths.insert(std::path::PathBuf::from("/tmp"));
        assert!(ensure_capabilities_supported(&caps).is_err());
    }

    #[tokio::test]
    async fn exec_with_missing_binary_returns_err() {
        unsafe { std::env::set_var(ENV_BINARY, "/nonexistent-msb-ryu-test") };
        let sb = MicrosandboxSandbox::new();
        let result = sb.exec(ExecSpec::new("echo", vec!["hi".to_owned()])).await;
        assert!(result.is_err(), "exec with missing binary must be Err");
        unsafe { std::env::remove_var(ENV_BINARY) };
    }
}
