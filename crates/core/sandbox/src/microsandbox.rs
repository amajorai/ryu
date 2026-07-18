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
//! Network / volume-mount flags are **not documented** in the CLI today, so the
//! capability descriptor is honored only at the microVM's inherent deny-by-
//! default boundary (no extra flags emitted). This is the same honest-but-
//! conservative posture Core takes for other unverified CLI flag surfaces (e.g.
//! the omlx engine). When the CLI documents network/mount flags, extend
//! [`caps_to_flags`].
//!
//! ## Config
//!
//! | Env var                              | Default   | Meaning                       |
//! |--------------------------------------|-----------|-------------------------------|
//! | `RYU_SANDBOX_MICROSANDBOX_BINARY`    | `msb`     | Path / name of the msb binary |
//! | `RYU_SANDBOX_MICROSANDBOX_IMAGE`     | `python`  | Default image for exec + WS    |
//! | `RYU_SANDBOX_MICROSANDBOX_DETECT_SECS`| `3`      | Detection probe timeout (s)   |

use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::BoxFuture;
use crate::win_process::NoWindow;

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
        Command::new(&binary).arg("--version").no_window().output(),
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

// ── Capability flags ─────────────────────────────────────────────────────────

/// Translate [`SandboxCapabilities`] into `msb` CLI flags.
///
/// The CLI does not currently document network/volume flags, so this returns an
/// empty flag set: the microVM's own deny-by-default boundary provides the
/// isolation. The `caps` argument is retained so this becomes the single edit
/// site once the flag surface is documented.
fn caps_to_flags(_caps: &SandboxCapabilities) -> Vec<String> {
    Vec::new()
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
    let has_stdin = stdin.is_some();
    if has_stdin {
        cmd.stdin(std::process::Stdio::piped());
    } else {
        cmd.stdin(std::process::Stdio::null());
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.no_window();

    let run = async move {
        if let Some(bytes) = stdin {
            let mut child = cmd
                .spawn()
                .map_err(|e| anyhow!("msb {ctx} spawn failed: {e}"))?;
            if let Some(mut writer) = child.stdin.take() {
                use tokio::io::AsyncWriteExt as _;
                writer
                    .write_all(&bytes)
                    .await
                    .map_err(|e| anyhow!("msb {ctx} stdin write failed: {e}"))?;
            }
            child
                .wait_with_output()
                .await
                .map_err(|e| anyhow!("msb {ctx} wait failed: {e}"))
        } else {
            cmd.output()
                .await
                .map_err(|e| anyhow!("msb {ctx} failed: {e}"))
        }
    };

    match timeout_secs {
        Some(secs) => timeout(Duration::from_secs(secs), run)
            .await
            .map_err(|_| anyhow!("msb {ctx} timed out after {secs}s"))?,
        None => run.await,
    }
}

impl Sandbox for MicrosandboxSandbox {
    fn name(&self) -> &'static str {
        "microsandbox"
    }

    // ── Ephemeral exec: `msb run <image> -- <command> [args]` ─────────────────

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let mut cmd = Command::new(binary());
            cmd.arg("run");
            for flag in caps_to_flags(&spec.capabilities) {
                cmd.arg(flag);
            }
            cmd.arg(image());
            cmd.arg("--");
            cmd.arg(&spec.command);
            for arg in &spec.args {
                cmd.arg(arg);
            }
            cmd.no_window();

            let output = run_command(cmd, spec.stdin, spec.timeout_secs, "run").await?;
            Ok(ExecOutput {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        })
    }

    // ── Long-lived workspace ──────────────────────────────────────────────────

    fn create_workspace(
        &self,
        capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            let name = format!("ryu-{}", uuid::Uuid::new_v4());
            let mut cmd = Command::new(binary());
            cmd.arg("create").arg("--name").arg(&name);
            for flag in caps_to_flags(&capabilities) {
                cmd.arg(flag);
            }
            cmd.arg(image());
            cmd.no_window();

            let output = cmd
                .output()
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
                .output()
                .await;

            Ok(WorkspaceId(name))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let name = id.0.clone();
        Box::pin(async move {
            let mut cmd = Command::new(binary());
            cmd.arg("exec").arg(&name).arg("--").arg(&spec.command);
            for arg in &spec.args {
                cmd.arg(arg);
            }
            cmd.no_window();

            let output = run_command(cmd, spec.stdin, spec.timeout_secs, "exec").await?;
            Ok(ExecOutput {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: output.stdout,
                stderr: output.stderr,
            })
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let name = id.0.clone();
        Box::pin(async move {
            // Best-effort stop, then remove.
            let _ = Command::new(binary())
                .arg("stop")
                .arg(&name)
                .no_window()
                .output()
                .await;

            let output = Command::new(binary())
                .arg("rm")
                .arg(&name)
                .no_window()
                .output()
                .await
                .map_err(|e| anyhow!("msb rm failed: {e}"))?;
            if !output.status.success() {
                return Err(anyhow!(
                    "msb rm failed (exit {}): {}",
                    output.status.code().unwrap_or(-1),
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
            Ok(())
        })
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

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
    fn caps_emit_no_flags_yet() {
        // Until msb documents network/mount flags, the mapping is empty and the
        // microVM boundary provides isolation.
        assert!(caps_to_flags(&SandboxCapabilities::default()).is_empty());
        let mut caps = SandboxCapabilities::default();
        caps.network = true;
        assert!(caps_to_flags(&caps).is_empty());
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
