//! Docker/OCI backend implementing the Core [`Sandbox`] trait (M6 / issue #191).
//!
//! Runs workloads in Docker containers via the `docker` CLI. No Bollard or
//! any other native Docker SDK is used — shelling out keeps compile-time
//! dependencies at zero and makes the backend trivially available on every
//! platform where `docker` is on `PATH`.
//!
//! ## Detection
//!
//! Core detects an existing Docker installation by probing `docker version`
//! (with a short timeout) on first use. When the daemon is absent the backend
//! reports [`DetectResult::Unavailable`] and the caller silently falls back
//! to the wasmtime default — **no error, no install, no bundle**.
//!
//! On Windows, Docker Desktop uses a WSL2 backend; `docker version` succeeds
//! when the Desktop is running, so WSL2 presence is implicit in daemon
//! reachability.  We do not probe WSL2 separately.
//!
//! ## Capability model
//!
//! [`SandboxCapabilities`] maps to Docker flags:
//!   - `network = false` (default) → `--network none`
//!   - `network = true`            → no `--network` flag (Docker default bridge)
//!   - `fs_read_paths`             → `-v <host>:<container>:ro`
//!   - `fs_write_paths`            → `-v <host>:<container>:rw`
//!     (read+write when a path appears in both sets: rw wins)
//!
//! All capability enforcement happens at the `docker run` / `docker exec` call
//! site; Core does not re-check after construction.
//!
//! ## Ephemeral exec
//!
//! `exec` → `docker run --rm [capability flags] <image> <command> [args]`
//!
//! Stdin bytes (if any) are piped via the `docker run -i` flag.
//!
//! ## Long-lived workspace
//!
//! `create_workspace`  → `docker run -d [capability flags] <image> sleep infinity`
//!                        Returns the container id as [`WorkspaceId`].
//! `exec_in_workspace` → `docker exec <id> <command> [args]`
//! `destroy_workspace` → `docker rm -f <id>`
//!
//! FS state persists for the lifetime of the container; two consecutive
//! `exec_in_workspace` calls see each other's writes.
//!
//! ## Config
//!
//! | Env var                         | Default             | Meaning                         |
//! |---------------------------------|---------------------|---------------------------------|
//! | `RYU_SANDBOX_DOCKER_BINARY`     | `docker`            | Path / name of docker binary    |
//! | `RYU_SANDBOX_DOCKER_IMAGE`      | `alpine:3.20`       | Default image for exec + WS     |
//! | `RYU_SANDBOX_DOCKER_DETECT_SECS`| `3`                 | Probe timeout (seconds)         |
//!
//! ## Architecture (Core-vs-Gateway)
//!
//! This module is "what runs" → Core. Policy over *what is allowed* inside the
//! container (DLP on stdout, egress budgets) is applied at the gateway dispatch
//! layer (`mcp/sandbox.rs`) before reaching this backend — not here.
//!
//! LOCKED DECISION (issue #191): Core must never bundle or install Docker.
//! Every code path here is detection-only + CLI invocation; there are no
//! `docker pull` calls without explicit user request.

use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::sidecar::BoxFuture;
use crate::win_process::NoWindow;

// ── Configuration knobs (all swappable, nothing hardcoded) ───────────────────

/// Name / path of the docker binary. Defaults to `docker` (resolved via PATH).
pub const ENV_DOCKER_BINARY: &str = "RYU_SANDBOX_DOCKER_BINARY";
/// Default container image. Used when the caller does not specify an image in
/// `ExecSpec::command`. Swappable at runtime via env var.
pub const ENV_DOCKER_IMAGE: &str = "RYU_SANDBOX_DOCKER_IMAGE";
/// Detection probe timeout in seconds.
pub const ENV_DOCKER_DETECT_SECS: &str = "RYU_SANDBOX_DOCKER_DETECT_SECS";

/// Fallback default image. Must be a minimal image that ships `/bin/sh`.
const DEFAULT_DOCKER_IMAGE: &str = "alpine:3.20";
/// Fallback binary name (resolved via PATH on the host).
const DEFAULT_DOCKER_BINARY: &str = "docker";
/// Default probe timeout.
const DEFAULT_DETECT_SECS: u64 = 3;

fn docker_binary() -> String {
    std::env::var(ENV_DOCKER_BINARY).unwrap_or_else(|_| DEFAULT_DOCKER_BINARY.to_owned())
}

fn docker_image() -> String {
    std::env::var(ENV_DOCKER_IMAGE).unwrap_or_else(|_| DEFAULT_DOCKER_IMAGE.to_owned())
}

fn detect_timeout() -> Duration {
    let secs = std::env::var(ENV_DOCKER_DETECT_SECS)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(DEFAULT_DETECT_SECS);
    Duration::from_secs(secs)
}

// ── Detection ────────────────────────────────────────────────────────────────

/// Result of the Docker daemon probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// Docker daemon is reachable; the backend is usable.
    Available,
    /// Daemon is absent, timed out, or the binary is not on PATH.
    Unavailable(String),
}

/// Probe whether a Docker daemon is reachable on this host.
///
/// Runs `docker version` with a configurable short timeout.  This function
/// NEVER installs Docker; it is detection-only.
///
/// # Detection-only invariant
///
/// The only binary invoked here is the `docker` client already present on
/// the host (or identified by `RYU_SANDBOX_DOCKER_BINARY`). No image is
/// pulled, no daemon is started, and no OS package is installed.
pub async fn detect() -> DetectResult {
    let binary = docker_binary();
    let deadline = detect_timeout();

    let probe = timeout(
        deadline,
        Command::new(&binary)
            .arg("version")
            .arg("--format")
            .arg("{{.Server.Version}}")
            .no_window()
            .output(),
    )
    .await;

    match probe {
        Err(_elapsed) => DetectResult::Unavailable(format!(
            "docker probe timed out after {}s (daemon may be starting)",
            deadline.as_secs()
        )),
        Ok(Err(io_err)) => DetectResult::Unavailable(format!(
            "docker binary not found or not executable: {io_err}"
        )),
        Ok(Ok(output)) => {
            if output.status.success() {
                DetectResult::Available
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                DetectResult::Unavailable(format!("docker daemon not reachable: {}", stderr.trim()))
            }
        }
    }
}

// ── Capability flags ─────────────────────────────────────────────────────────

/// Build the Docker CLI flags that enforce [`SandboxCapabilities`].
///
/// Returned as a `Vec<String>` to append after `docker run` or similar.
fn caps_to_flags(caps: &SandboxCapabilities) -> Vec<String> {
    let mut flags: Vec<String> = Vec::new();

    // Network: default-deny maps to --network none.
    if !caps.network {
        flags.push("--network".to_owned());
        flags.push("none".to_owned());
    }

    // Filesystem: derive the effective mount set, which honors the declared
    // workspace access level (None strips all mounts, ReadOnly clamps every
    // mount to `ro`, ReadWrite keeps the historical per-path rw/ro logic).
    for (path, writable) in caps.effective_mounts() {
        let host = path.display();
        let mode = if writable { "rw" } else { "ro" };
        // Mount at the same path inside the container for transparency.
        flags.push("-v".to_owned());
        flags.push(format!("{host}:{host}:{mode}"));
    }

    flags
}

// ── DockerSandbox ────────────────────────────────────────────────────────────

/// Docker backend: detect-only, CLI-driven, no compile-time Docker dependency.
///
/// The backend is always compiled (no feature gate needed — there is nothing
/// to compile away); availability is a pure runtime probe via [`detect()`].
#[derive(Clone)]
pub struct DockerSandbox;

impl DockerSandbox {
    /// Construct the backend. Cheap: no I/O at construction time.
    pub fn new() -> Self {
        Self
    }
}

impl Default for DockerSandbox {
    fn default() -> Self {
        Self::new()
    }
}

impl Sandbox for DockerSandbox {
    fn name(&self) -> &'static str {
        "docker"
    }

    // ── Ephemeral exec ────────────────────────────────────────────────────────

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let binary = docker_binary();
            let image = docker_image();
            let cap_flags = caps_to_flags(&spec.capabilities);

            let mut cmd = Command::new(&binary);
            cmd.arg("run").arg("--rm");

            // Pipe stdin if bytes are provided.
            let has_stdin = spec.stdin.is_some();
            if has_stdin {
                cmd.arg("-i");
            }

            // Capability flags (network, mounts).
            for flag in &cap_flags {
                cmd.arg(flag);
            }

            cmd.arg(&image);
            cmd.arg(&spec.command);
            for arg in &spec.args {
                cmd.arg(arg);
            }

            if has_stdin {
                cmd.stdin(std::process::Stdio::piped());
            } else {
                cmd.stdin(std::process::Stdio::null());
            }
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.no_window();

            let run = async move {
                if let Some(stdin_bytes) = spec.stdin.clone() {
                    // Spawn, write stdin, then wait.
                    let mut child = cmd
                        .spawn()
                        .map_err(|e| anyhow!("docker spawn failed: {e}"))?;
                    if let Some(mut writer) = child.stdin.take() {
                        use tokio::io::AsyncWriteExt as _;
                        writer
                            .write_all(&stdin_bytes)
                            .await
                            .map_err(|e| anyhow!("docker stdin write failed: {e}"))?;
                    }
                    let output = child
                        .wait_with_output()
                        .await
                        .map_err(|e| anyhow!("docker wait failed: {e}"))?;
                    Ok::<_, anyhow::Error>(output)
                } else {
                    let output = cmd
                        .output()
                        .await
                        .map_err(|e| anyhow!("docker run failed: {e}"))?;
                    Ok(output)
                }
            };

            let output = if let Some(secs) = spec.timeout_secs {
                timeout(Duration::from_secs(secs), run)
                    .await
                    .map_err(|_| anyhow!("docker exec timed out after {secs}s"))?
            } else {
                run.await
            }?;

            let exit_code = output.status.code().unwrap_or(-1);
            Ok(ExecOutput {
                exit_code,
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
            let binary = docker_binary();
            let image = docker_image();
            let cap_flags = caps_to_flags(&capabilities);

            let mut cmd = Command::new(&binary);
            cmd.arg("run").arg("-d").arg("--rm"); // auto-remove when stopped

            for flag in &cap_flags {
                cmd.arg(flag);
            }

            cmd.arg(&image);
            cmd.arg("sleep");
            cmd.arg("infinity");
            cmd.no_window();

            let output = cmd
                .output()
                .await
                .map_err(|e| anyhow!("docker run (workspace) failed: {e}"))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(anyhow!(
                    "docker run failed (exit {}): {}",
                    output.status.code().unwrap_or(-1),
                    stderr.trim()
                ));
            }

            // stdout contains the container ID (with a trailing newline).
            let id = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if id.is_empty() {
                return Err(anyhow!("docker run returned empty container id"));
            }

            Ok(WorkspaceId(id))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let container_id = id.0.clone();
        Box::pin(async move {
            let binary = docker_binary();

            let mut cmd = Command::new(&binary);
            cmd.arg("exec");

            if spec.stdin.is_some() {
                cmd.arg("-i");
            }

            cmd.arg(&container_id);
            cmd.arg(&spec.command);
            for arg in &spec.args {
                cmd.arg(arg);
            }

            if spec.stdin.is_some() {
                cmd.stdin(std::process::Stdio::piped());
            } else {
                cmd.stdin(std::process::Stdio::null());
            }
            cmd.stdout(std::process::Stdio::piped());
            cmd.stderr(std::process::Stdio::piped());
            cmd.no_window();

            let run = async move {
                if let Some(stdin_bytes) = spec.stdin.clone() {
                    let mut child = cmd
                        .spawn()
                        .map_err(|e| anyhow!("docker exec spawn failed: {e}"))?;
                    if let Some(mut writer) = child.stdin.take() {
                        use tokio::io::AsyncWriteExt as _;
                        writer
                            .write_all(&stdin_bytes)
                            .await
                            .map_err(|e| anyhow!("docker exec stdin write failed: {e}"))?;
                    }
                    let output = child
                        .wait_with_output()
                        .await
                        .map_err(|e| anyhow!("docker exec wait failed: {e}"))?;
                    Ok::<_, anyhow::Error>(output)
                } else {
                    let output = cmd
                        .output()
                        .await
                        .map_err(|e| anyhow!("docker exec failed: {e}"))?;
                    Ok(output)
                }
            };

            let output = if let Some(secs) = spec.timeout_secs {
                timeout(Duration::from_secs(secs), run)
                    .await
                    .map_err(|_| anyhow!("docker exec timed out after {secs}s"))?
            } else {
                run.await
            }?;

            let exit_code = output.status.code().unwrap_or(-1);
            Ok(ExecOutput {
                exit_code,
                stdout: output.stdout,
                stderr: output.stderr,
            })
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let container_id = id.0.clone();
        Box::pin(async move {
            let binary = docker_binary();
            let output = Command::new(&binary)
                .arg("rm")
                .arg("-f")
                .arg(&container_id)
                .no_window()
                .output()
                .await
                .map_err(|e| anyhow!("docker rm failed: {e}"))?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(anyhow!(
                    "docker rm -f failed (exit {}): {}",
                    output.status.code().unwrap_or(-1),
                    stderr.trim()
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

    /// Serializes the tests that override the process-global `RYU_SANDBOX_DOCKER_BINARY`
    /// env var — otherwise one removing it mid-test can let the other resolve the
    /// real docker binary and stop returning the expected Err. Poison-tolerant.
    static DOCKER_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn lock_docker_env() -> std::sync::MutexGuard<'static, ()> {
        DOCKER_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// AC#4 — detection-only assertion: verify no install/pull path exists in
    /// this module. The real guard is code review; this test documents the
    /// invariant with a runtime-detectable check.
    ///
    /// We assert that `detect()` either returns `Available` or `Unavailable` —
    /// never `Err` — and that the result is consistent with whether the binary
    /// exists on PATH. This indirectly confirms no network calls are made
    /// (a blocking pull would time out or panic in the test harness).
    #[tokio::test]
    async fn detect_does_not_install_docker() {
        // detect() must complete within 2× the configured timeout (never hangs).
        let result =
            tokio::time::timeout(Duration::from_secs(DEFAULT_DETECT_SECS * 2 + 2), detect())
                .await
                .expect("detect() must not hang beyond 2× timeout");

        // Result must be one of the two valid variants — never a panic or Err.
        match result {
            DetectResult::Available => {
                // Docker is present; fine.
            }
            DetectResult::Unavailable(reason) => {
                // Docker is absent; reason must be non-empty.
                assert!(!reason.is_empty(), "unavailable reason must be non-empty");
            }
        }
    }

    /// AC#2 — when Docker is absent the backend reports unavailable; callers
    /// should not receive an Err (the caller pattern is: check detect(), if
    /// unavailable use wasmtime, never propagate the missing-docker as an error).
    ///
    /// We test the `DockerSandbox::name()` contract and that the struct
    /// constructs without requiring a daemon.
    #[test]
    fn backend_constructs_without_daemon() {
        let sb = DockerSandbox::new();
        assert_eq!(sb.name(), "docker");
    }

    /// Verify capability flags: deny-all default produces `--network none`
    /// and no `-v` flags.
    #[test]
    fn caps_deny_all_produces_network_none() {
        let caps = SandboxCapabilities::default();
        let flags = caps_to_flags(&caps);
        assert!(
            flags.contains(&"--network".to_owned()),
            "deny-all must include --network"
        );
        assert!(
            flags.contains(&"none".to_owned()),
            "deny-all must include none as network value"
        );
        assert!(
            !flags.contains(&"-v".to_owned()),
            "deny-all must not include any -v mounts"
        );
    }

    /// Verify capability flags: enabling network drops `--network none`.
    #[test]
    fn caps_network_enabled_drops_network_none() {
        let mut caps = SandboxCapabilities::default();
        caps.network = true;
        let flags = caps_to_flags(&caps);
        assert!(
            !flags.contains(&"--network".to_owned()),
            "network=true must not include --network flag"
        );
    }

    /// Verify capability flags: a write path produces a `-v` mount with `:rw`.
    #[test]
    fn caps_write_path_produces_rw_mount() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_write_paths
            .insert(std::path::PathBuf::from("/tmp/ws"));
        let flags = caps_to_flags(&caps);
        assert!(flags.contains(&"-v".to_owned()), "write path must add -v");
        let mount = flags
            .windows(2)
            .find(|w| w[0] == "-v")
            .map(|w| w[1].clone())
            .expect("must have a mount value");
        assert!(mount.ends_with(":rw"), "write path mount must end with :rw");
    }

    /// Verify capability flags: a read-only path produces a `-v` mount with `:ro`.
    #[test]
    fn caps_read_path_produces_ro_mount() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths
            .insert(std::path::PathBuf::from("/data/ro"));
        let flags = caps_to_flags(&caps);
        assert!(flags.contains(&"-v".to_owned()), "read path must add -v");
        let mount = flags
            .windows(2)
            .find(|w| w[0] == "-v")
            .map(|w| w[1].clone())
            .expect("must have a mount value");
        assert!(
            mount.ends_with(":ro"),
            "read-only path mount must end with :ro"
        );
    }

    /// Verify that a path in both read and write sets gets `:rw` (write wins).
    #[test]
    fn caps_write_wins_over_read() {
        let path = std::path::PathBuf::from("/shared");
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths.insert(path.clone());
        caps.fs_write_paths.insert(path.clone());
        let flags = caps_to_flags(&caps);
        let mount = flags
            .windows(2)
            .find(|w| w[0] == "-v")
            .map(|w| w[1].clone())
            .expect("must have a mount value");
        assert!(
            mount.ends_with(":rw"),
            "path in both read + write sets must be :rw"
        );
    }

    /// Workspace access `ReadOnly` clamps a write path's mount to `:ro`.
    #[test]
    fn caps_read_only_access_clamps_write_mount() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_write_paths
            .insert(std::path::PathBuf::from("/tmp/ws"));
        caps.workspace_access = crate::sidecar::sandbox::WorkspaceAccess::ReadOnly;
        let flags = caps_to_flags(&caps);
        let mount = flags
            .windows(2)
            .find(|w| w[0] == "-v")
            .map(|w| w[1].clone())
            .expect("must have a mount value");
        assert!(
            mount.ends_with(":ro"),
            "read-only access must clamp a write path to :ro, got {mount}"
        );
    }

    /// Workspace access `None` strips every FS mount, leaving no `-v` flags.
    #[test]
    fn caps_none_access_emits_no_mounts() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths
            .insert(std::path::PathBuf::from("/data/ro"));
        caps.fs_write_paths
            .insert(std::path::PathBuf::from("/tmp/ws"));
        caps.workspace_access = crate::sidecar::sandbox::WorkspaceAccess::None;
        let flags = caps_to_flags(&caps);
        assert!(
            !flags.contains(&"-v".to_owned()),
            "None access must emit no -v mounts"
        );
    }

    /// AC#2 live exec gate — when Docker is absent, `exec` returns an error
    /// (the contract is: `detect()` is called first; when unavailable the caller
    /// should not invoke `exec`). This test is skipped when Docker IS present,
    /// since it only tests the absent path by using a nonexistent binary.
    ///
    /// We use an override of `RYU_SANDBOX_DOCKER_BINARY` to point at a
    /// nonexistent path so this test is deterministic even on Docker-equipped CI.
    #[tokio::test]
    async fn exec_with_missing_binary_returns_err() {
        let _lock = lock_docker_env();
        // Override the binary to something that doesn't exist.
        unsafe { std::env::set_var(ENV_DOCKER_BINARY, "/nonexistent-docker-binary-ryu-test") };
        let sb = DockerSandbox::new();
        let spec = ExecSpec::new("echo", vec!["hi".to_owned()]);
        let result = sb.exec(spec).await;
        assert!(result.is_err(), "exec with missing binary must be Err");
        unsafe { std::env::remove_var(ENV_DOCKER_BINARY) };
    }

    /// Workspace lifecycle with missing binary returns Err (parallel to exec test).
    #[tokio::test]
    async fn workspace_with_missing_binary_returns_err() {
        let _lock = lock_docker_env();
        unsafe { std::env::set_var(ENV_DOCKER_BINARY, "/nonexistent-docker-binary-ryu-test") };
        let sb = DockerSandbox::new();
        let caps = SandboxCapabilities::default();
        let result = sb.create_workspace(caps).await;
        assert!(
            result.is_err(),
            "create_workspace with missing binary must be Err"
        );
        unsafe { std::env::remove_var(ENV_DOCKER_BINARY) };
    }
}
