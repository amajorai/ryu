//! Local host backend implementing the Core [`Sandbox`] trait.
//!
//! Runs the command as a plain subprocess of Core inside a fresh temporary
//! working directory. **This is not an isolation boundary**: the child runs as
//! the Core user, can read and write anything that user can, and has whatever
//! network the host has. Its conformance entry says so (`isolation: none`).
//!
//! ## What it does provide
//!
//! - a fresh, empty working directory per ephemeral exec (removed afterwards)
//!   or per workspace (removed on [`Sandbox::destroy_workspace`]);
//! - a cleared environment: only `PATH` is inherited, `HOME`/`TMPDIR`/`TMP`/
//!   `TEMP` point at the working directory (plus the handful of variables
//!   Windows needs to start a process at all), so host secrets in Core's own
//!   environment never leak into the child;
//! - the same timeout / stdin / exit-code / stdout / stderr contract the
//!   Docker backend satisfies. A timed-out child is killed (`kill_on_drop`).
//!
//! ## What it does NOT provide
//!
//! [`SandboxCapabilities`] cannot be enforced on the host: FS paths outside the
//! working directory and the network stay reachable. Callers that need the
//! deny-all posture must pick `wasmtime`, `docker`, `microsandbox`, or
//! `opensandbox`.
//!
//! ## Explicit opt-in
//!
//! Because host execution is not isolation, the backend refuses to run unless
//! the operator opts in with `RYU_SANDBOX_LOCAL_ENABLE=1`. Selecting `local` by
//! name without that opt-in fails loudly (and [`detect`] reports it
//! unavailable), so a stray picker choice or env value can never silently turn
//! every sandboxed exec into host execution. It is never a fallback.
//!
//! | Env var                     | Default | Meaning                              |
//! |-----------------------------|---------|--------------------------------------|
//! | `RYU_SANDBOX_LOCAL_ENABLE`  | unset   | `1`/`true` allows host execution     |

use std::path::{Path, PathBuf};
use std::process::Stdio;

use anyhow::{anyhow, Context, Result};
use tokio::process::Command;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::win_process::NoWindow;
use crate::BoxFuture;

/// Operator opt-in for host execution.
pub const ENV_LOCAL_ENABLE: &str = "RYU_SANDBOX_LOCAL_ENABLE";

/// Prefix of every working directory this backend creates. Workspace ids are
/// validated against it so `destroy_workspace` can never delete anything else.
const WORKDIR_PREFIX: &str = "ryu-sandbox-local-";

/// Result of the local backend probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// The operator opted in; host execution is allowed.
    Available,
    /// Host execution has not been enabled.
    Unavailable(String),
}

fn opt_in_value_enabled(value: Option<&str>) -> bool {
    matches!(
        value.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

fn local_enabled() -> bool {
    opt_in_value_enabled(std::env::var(ENV_LOCAL_ENABLE).ok().as_deref())
}

/// Whether host execution is enabled on this node. Detection-only.
pub async fn detect() -> DetectResult {
    if local_enabled() {
        DetectResult::Available
    } else {
        DetectResult::Unavailable(format!(
            "local host execution is not isolation; set {ENV_LOCAL_ENABLE}=1 to allow it"
        ))
    }
}

fn ensure_enabled() -> Result<()> {
    if local_enabled() {
        Ok(())
    } else {
        Err(anyhow!(
            "sandbox backend 'local' runs commands on the host without isolation and is \
             disabled; set {ENV_LOCAL_ENABLE}=1 to allow it"
        ))
    }
}

/// Create a fresh working directory under the system temp dir.
fn create_workdir() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join(format!("{WORKDIR_PREFIX}{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir)
        .with_context(|| format!("create local sandbox dir {}", dir.display()))?;
    Ok(dir)
}

/// Resolve a workspace id back to a directory this backend created.
fn workspace_dir(id: &WorkspaceId) -> Result<PathBuf> {
    let dir = PathBuf::from(&id.0);
    let is_ours = dir.parent() == Some(std::env::temp_dir().as_path())
        && dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(WORKDIR_PREFIX));
    if !is_ours {
        return Err(anyhow!("'{}' is not a local sandbox workspace", id.0));
    }
    Ok(dir)
}

/// Build the child command with a cleared environment rooted at `workdir`.
fn host_command(spec: &ExecSpec, workdir: &Path) -> Command {
    let mut cmd = Command::new(&spec.command);
    cmd.args(&spec.args).current_dir(workdir).env_clear();
    if let Some(path) = std::env::var_os("PATH") {
        cmd.env("PATH", path);
    }
    for key in ["HOME", "TMPDIR", "TMP", "TEMP", "USERPROFILE"] {
        cmd.env(key, workdir);
    }
    #[cfg(windows)]
    for key in ["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd
}

/// Spawn `cmd`, feed `stdin`, and capture its output under the optional
/// timeout. Shared by the host-process backends (`local`, `ssh`). The child is
/// killed when the timeout drops the future.
pub(crate) async fn run_captured(
    mut cmd: Command,
    stdin: Option<Vec<u8>>,
    timeout_secs: Option<u64>,
    label: &str,
) -> Result<ExecOutput> {
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .no_window();

    let output = crate::capture::command(cmd, stdin, timeout_secs)
        .await
        .map_err(|error| {
            if error.to_string() == "sandbox command timed out" {
                anyhow!(
                    "{label} exec timed out after {}s",
                    timeout_secs.unwrap_or(120)
                )
            } else {
                error.context(format!("{label} execution failed"))
            }
        })?;

    Ok(ExecOutput {
        exit_code: output.status.code().unwrap_or(-1),
        stdout: output.stdout,
        stderr: output.stderr,
    })
}

/// Host-process backend with no isolation boundary. See the module docs.
#[derive(Debug, Clone, Default)]
pub struct LocalSandbox;

impl LocalSandbox {
    /// Construct without I/O.
    pub fn new() -> Self {
        Self
    }
}

impl Sandbox for LocalSandbox {
    fn name(&self) -> &'static str {
        "local"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            ensure_enabled()?;
            let workdir = create_workdir()?;
            let cmd = host_command(&spec, &workdir);
            let result = run_captured(cmd, spec.stdin, spec.timeout_secs, "local").await;
            // Best-effort teardown; a failed cleanup must not mask the result.
            let _ = std::fs::remove_dir_all(&workdir);
            result
        })
    }

    fn create_workspace(
        &self,
        _capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            ensure_enabled()?;
            let dir = create_workdir()?;
            Ok(WorkspaceId(dir.to_string_lossy().into_owned()))
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let id = id.clone();
        Box::pin(async move {
            ensure_enabled()?;
            let dir = workspace_dir(&id)?;
            if !dir.is_dir() {
                return Err(anyhow!("local sandbox workspace '{}' does not exist", id.0));
            }
            let cmd = host_command(&spec, &dir);
            run_captured(cmd, spec.stdin, spec.timeout_secs, "local").await
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let id = id.clone();
        Box::pin(async move {
            let dir = workspace_dir(&id)?;
            match std::fs::remove_dir_all(&dir) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(anyhow!(
                    "remove local sandbox workspace {}: {e}",
                    dir.display()
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialises tests that flip the process-wide opt-in env var.
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn set_enabled(enabled: bool) {
        // SAFETY: guarded by `lock_env`; no other thread reads this var concurrently.
        unsafe {
            if enabled {
                std::env::set_var(ENV_LOCAL_ENABLE, "1");
            } else {
                std::env::remove_var(ENV_LOCAL_ENABLE);
            }
        }
    }

    #[test]
    fn opt_in_values() {
        for yes in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(opt_in_value_enabled(Some(yes)), "{yes}");
        }
        for no in ["", "0", "false", "off", "nope"] {
            assert!(!opt_in_value_enabled(Some(no)), "{no}");
        }
        assert!(!opt_in_value_enabled(None));
    }

    #[test]
    fn workspace_ids_outside_temp_prefix_are_rejected() {
        assert!(workspace_dir(&WorkspaceId("/".to_owned())).is_err());
        assert!(workspace_dir(&WorkspaceId("/etc/passwd".to_owned())).is_err());
        let foreign = std::env::temp_dir().join("not-ours");
        assert!(workspace_dir(&WorkspaceId(foreign.to_string_lossy().into_owned())).is_err());
        let ours = std::env::temp_dir().join(format!("{WORKDIR_PREFIX}abc"));
        assert_eq!(
            workspace_dir(&WorkspaceId(ours.to_string_lossy().into_owned())).unwrap(),
            ours
        );
    }

    #[tokio::test]
    async fn disabled_by_default_refuses_to_run() {
        let _lock = lock_env();
        set_enabled(false);
        assert!(matches!(detect().await, DetectResult::Unavailable(_)));
        let err = LocalSandbox::new()
            .exec(ExecSpec::new("true", vec![]))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(ENV_LOCAL_ENABLE), "{err}");
    }

    #[tokio::test]
    async fn shared_local_and_ssh_capture_rejects_excessive_output() {
        #[cfg(windows)]
        let mut command = Command::new("powershell");
        #[cfg(windows)]
        command.args([
            "-NoProfile",
            "-Command",
            "[Console]::Out.Write('x' * 5000000)",
        ]);
        #[cfg(unix)]
        let mut command = Command::new("sh");
        #[cfg(unix)]
        command.args(["-c", "head -c 5000000 /dev/zero"]);
        let error = run_captured(command, None, Some(20), "capture-security")
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains("capture limit"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exec_captures_output_exit_code_and_stdin_in_clean_env() {
        let _lock = lock_env();
        set_enabled(true);
        assert_eq!(detect().await, DetectResult::Available);
        let sandbox = LocalSandbox::new();

        let mut spec = ExecSpec::new(
            "sh",
            vec![
                "-c".to_owned(),
                "cat; echo err >&2; pwd; echo \"secret=${RYU_TEST_SECRET:-unset}\"; exit 3"
                    .to_owned(),
            ],
        );
        spec.stdin = Some(b"from-stdin\n".to_vec());
        spec.timeout_secs = Some(10);
        // SAFETY: guarded by `lock_env`.
        unsafe { std::env::set_var("RYU_TEST_SECRET", "leak") };
        let out = sandbox.exec(spec).await.unwrap();
        unsafe { std::env::remove_var("RYU_TEST_SECRET") };

        let stdout = String::from_utf8_lossy(&out.stdout);
        assert_eq!(out.exit_code, 3);
        assert!(stdout.starts_with("from-stdin\n"), "{stdout}");
        assert!(
            stdout.contains(WORKDIR_PREFIX),
            "runs in a fresh temp dir: {stdout}"
        );
        assert!(
            stdout.contains("secret=unset"),
            "host env must not leak: {stdout}"
        );
        assert_eq!(String::from_utf8_lossy(&out.stderr).trim(), "err");
        set_enabled(false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn exec_times_out() {
        let _lock = lock_env();
        set_enabled(true);
        let mut spec = ExecSpec::new("sleep", vec!["5".to_owned()]);
        spec.timeout_secs = Some(1);
        let err = LocalSandbox::new()
            .exec(spec)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("timed out after 1s"), "{err}");
        set_enabled(false);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_persists_between_execs_and_is_destroyed() {
        let _lock = lock_env();
        set_enabled(true);
        let sandbox = LocalSandbox::new();
        let id = sandbox
            .create_workspace(SandboxCapabilities::default())
            .await
            .unwrap();
        let write = ExecSpec::new("sh", vec!["-c".to_owned(), "echo hi > note".to_owned()]);
        assert_eq!(
            sandbox
                .exec_in_workspace(&id, write)
                .await
                .unwrap()
                .exit_code,
            0
        );
        let read = sandbox
            .exec_in_workspace(&id, ExecSpec::new("cat", vec!["note".to_owned()]))
            .await
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&read.stdout).trim(), "hi");
        sandbox.destroy_workspace(&id).await.unwrap();
        assert!(!PathBuf::from(&id.0).exists());
        assert!(sandbox
            .exec_in_workspace(&id, ExecSpec::new("true", vec![]))
            .await
            .is_err());
        set_enabled(false);
    }
}
