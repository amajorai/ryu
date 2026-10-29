//! SSH backend implementing the Core [`Sandbox`] trait via the system `ssh`
//! binary.
//!
//! Commands run on an operator-configured remote host, as the configured remote
//! user, inside a fresh remote temporary directory. The isolation boundary is
//! that remote account (and whatever the operator put around the host); Ryu adds
//! no sandbox on top of it, so the conformance entry says exactly that.
//! [`SandboxCapabilities`] are not enforced remotely: the remote user's FS and
//! network access apply.
//!
//! ## Config
//!
//! | Env var                       | Default | Meaning                                 |
//! |-------------------------------|---------|-----------------------------------------|
//! | `RYU_SANDBOX_SSH_HOST`        | unset   | Remote host (required; enables backend) |
//! | `RYU_SANDBOX_SSH_USER`        | unset   | Remote user (`ssh` default when unset)  |
//! | `RYU_SANDBOX_SSH_PORT`        | unset   | Remote port (`ssh` default when unset)  |
//! | `RYU_SANDBOX_SSH_IDENTITY`    | unset   | Private key file passed as `-i`         |
//! | `RYU_SANDBOX_SSH_BINARY`      | `ssh`   | Path / name of the ssh client           |
//!
//! Authentication is non-interactive only (`BatchMode=yes`): keys or an agent
//! must already be set up. Host keys are verified by the user's normal
//! `known_hosts`; the backend never disables host-key checking.
//!
//! ## Shapes
//!
//! - `exec` → `ssh … 'd=$(mktemp -d …) && cd "$d" && <cmd>; rc=$?; rm -rf "$d"; exit $rc'`
//! - `create_workspace` → `ssh … mktemp -d …` (the remote path is the id)
//! - `exec_in_workspace` → `ssh … 'cd <dir> && <cmd>'`
//! - `destroy_workspace` → `ssh … rm -rf -- <dir>`
//!
//! Every argv element is POSIX-single-quoted before it reaches the remote
//! shell. A timeout kills the local `ssh` client; the remote shell receives
//! SIGHUP when the connection drops.

use std::time::Duration;

use anyhow::{anyhow, Result};
use tokio::process::Command;
use tokio::time::timeout;

use super::{ExecOutput, ExecSpec, Sandbox, SandboxCapabilities, WorkspaceId};
use crate::local::run_captured;
use crate::win_process::NoWindow;
use crate::BoxFuture;

pub const ENV_SSH_HOST: &str = "RYU_SANDBOX_SSH_HOST";
pub const ENV_SSH_USER: &str = "RYU_SANDBOX_SSH_USER";
pub const ENV_SSH_PORT: &str = "RYU_SANDBOX_SSH_PORT";
pub const ENV_SSH_IDENTITY: &str = "RYU_SANDBOX_SSH_IDENTITY";
pub const ENV_SSH_BINARY: &str = "RYU_SANDBOX_SSH_BINARY";

const DEFAULT_SSH_BINARY: &str = "ssh";
/// Remote temp dir template; workspace ids must carry this marker.
const REMOTE_DIR_MARKER: &str = "ryu-sandbox-ssh.";
const MKTEMP: &str = "mktemp -d \"${TMPDIR:-/tmp}/ryu-sandbox-ssh.XXXXXXXX\"";
const DETECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Upper bound for the control commands (mktemp / rm) that carry no caller timeout.
const CONTROL_TIMEOUT_SECS: u64 = 30;

/// Resolved SSH connection settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshConfig {
    pub binary: String,
    pub host: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty())
}

impl SshConfig {
    /// Build from an env-style lookup. `None` when no host is configured.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Option<Self>> {
        let Some(host) = non_empty(lookup(ENV_SSH_HOST)) else {
            return Ok(None);
        };
        if host.starts_with('-') {
            return Err(anyhow!("{ENV_SSH_HOST} must not start with '-'"));
        }
        let user = non_empty(lookup(ENV_SSH_USER));
        if user
            .as_deref()
            .is_some_and(|u| u.starts_with('-') || u.contains('@'))
        {
            return Err(anyhow!("{ENV_SSH_USER} is not a valid user name"));
        }
        let port = non_empty(lookup(ENV_SSH_PORT))
            .map(|p| {
                p.parse::<u16>()
                    .map_err(|_| anyhow!("{ENV_SSH_PORT} must be a port number, got '{p}'"))
            })
            .transpose()?;
        Ok(Some(Self {
            binary: non_empty(lookup(ENV_SSH_BINARY))
                .unwrap_or_else(|| DEFAULT_SSH_BINARY.to_owned()),
            host,
            user,
            port,
            identity: non_empty(lookup(ENV_SSH_IDENTITY)),
        }))
    }

    /// Build from the process environment.
    pub fn from_env() -> Result<Option<Self>> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn destination(&self) -> String {
        match &self.user {
            Some(user) => format!("{user}@{}", self.host),
            None => self.host.clone(),
        }
    }

    /// The `ssh` argv (without the binary) that runs `remote_script`.
    pub fn ssh_args(&self, remote_script: &str) -> Vec<String> {
        let mut args = vec![
            "-o".to_owned(),
            "BatchMode=yes".to_owned(),
            "-o".to_owned(),
            "ConnectTimeout=10".to_owned(),
            "-T".to_owned(),
        ];
        if let Some(port) = self.port {
            args.push("-p".to_owned());
            args.push(port.to_string());
        }
        if let Some(identity) = &self.identity {
            args.push("-i".to_owned());
            args.push(identity.clone());
        }
        args.push("--".to_owned());
        args.push(self.destination());
        args.push(remote_script.to_owned());
        args
    }

    fn command(&self, remote_script: &str) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.args(self.ssh_args(remote_script));
        cmd
    }
}

fn require_config() -> Result<SshConfig> {
    SshConfig::from_env()?
        .ok_or_else(|| anyhow!("sandbox backend 'ssh' is not configured; set {ENV_SSH_HOST}"))
}

/// POSIX single-quote `value` for a remote `sh`.
pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Quote the command line of `spec` for the remote shell.
fn remote_command_line(spec: &ExecSpec) -> String {
    std::iter::once(spec.command.as_str())
        .chain(spec.args.iter().map(String::as_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

/// Remote script for an ephemeral exec: fresh temp dir, run, clean up, keep rc.
pub fn ephemeral_script(spec: &ExecSpec) -> String {
    format!(
        "d=$({MKTEMP}) || exit 125; cd \"$d\" || exit 125; {}; rc=$?; cd /; rm -rf -- \"$d\"; exit $rc",
        remote_command_line(spec)
    )
}

/// Validate a workspace id as a remote dir this backend created.
fn workspace_path(id: &WorkspaceId) -> Result<&str> {
    let path = id.0.as_str();
    let valid = path.starts_with('/')
        && !path.contains('\n')
        && !path.contains("..")
        && path
            .rsplit('/')
            .next()
            .is_some_and(|leaf| leaf.starts_with(REMOTE_DIR_MARKER));
    if valid {
        Ok(path)
    } else {
        Err(anyhow!("'{path}' is not an ssh sandbox workspace"))
    }
}

/// Result of the SSH backend probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DetectResult {
    /// The ssh client is present and a host is configured.
    Available,
    /// Missing client, missing/invalid config.
    Unavailable(String),
}

/// Probe: a host is configured and the ssh client runs (`ssh -V`). Does not
/// open a connection, so it never prompts and never touches the remote host.
pub async fn detect() -> DetectResult {
    let config = match SshConfig::from_env() {
        Ok(Some(config)) => config,
        Ok(None) => return DetectResult::Unavailable(format!("{ENV_SSH_HOST} is not set")),
        Err(e) => return DetectResult::Unavailable(e.to_string()),
    };
    let probe = timeout(
        DETECT_TIMEOUT,
        Command::new(&config.binary)
            .arg("-V")
            .stdin(std::process::Stdio::null())
            .no_window()
            .output(),
    )
    .await;
    match probe {
        Ok(Ok(output)) if output.status.success() => DetectResult::Available,
        Ok(Ok(output)) => DetectResult::Unavailable(format!(
            "ssh client exited with {}",
            output.status.code().unwrap_or(-1)
        )),
        Ok(Err(e)) => DetectResult::Unavailable(format!("ssh client not found: {e}")),
        Err(_) => DetectResult::Unavailable("ssh client probe timed out".to_owned()),
    }
}

/// Remote-host backend over the system ssh client. See the module docs.
#[derive(Debug, Clone, Default)]
pub struct SshSandbox;

impl SshSandbox {
    /// Construct without I/O; configuration is read per call.
    pub fn new() -> Self {
        Self
    }
}

fn ensure_success(output: &ExecOutput, what: &str) -> Result<()> {
    if output.exit_code == 0 {
        return Ok(());
    }
    Err(anyhow!(
        "ssh {what} failed (exit {}): {}",
        output.exit_code,
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

impl Sandbox for SshSandbox {
    fn name(&self) -> &'static str {
        "ssh"
    }

    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        Box::pin(async move {
            let config = require_config()?;
            let cmd = config.command(&ephemeral_script(&spec));
            run_captured(cmd, spec.stdin, spec.timeout_secs, "ssh").await
        })
    }

    fn create_workspace(
        &self,
        _capabilities: SandboxCapabilities,
    ) -> BoxFuture<Result<WorkspaceId>> {
        Box::pin(async move {
            let config = require_config()?;
            let output = run_captured(
                config.command(MKTEMP),
                None,
                Some(CONTROL_TIMEOUT_SECS),
                "ssh",
            )
            .await?;
            ensure_success(&output, "mktemp")?;
            let id = WorkspaceId(String::from_utf8_lossy(&output.stdout).trim().to_owned());
            workspace_path(&id)?;
            Ok(id)
        })
    }

    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>> {
        let id = id.clone();
        Box::pin(async move {
            let config = require_config()?;
            let dir = workspace_path(&id)?;
            let script = format!(
                "cd {} || exit 125; {}",
                shell_quote(dir),
                remote_command_line(&spec)
            );
            run_captured(
                config.command(&script),
                spec.stdin,
                spec.timeout_secs,
                "ssh",
            )
            .await
        })
    }

    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>> {
        let id = id.clone();
        Box::pin(async move {
            let config = require_config()?;
            let dir = workspace_path(&id)?;
            let script = format!("rm -rf -- {}", shell_quote(dir));
            let output = run_captured(
                config.command(&script),
                None,
                Some(CONTROL_TIMEOUT_SECS),
                "ssh",
            )
            .await?;
            ensure_success(&output, "rm")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(pairs: &[(&str, &str)]) -> Result<Option<SshConfig>> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        SshConfig::from_lookup(|key| map.get(key).cloned())
    }

    #[test]
    fn no_host_means_unconfigured() {
        assert_eq!(config(&[]).unwrap(), None);
        assert_eq!(config(&[(ENV_SSH_HOST, "  ")]).unwrap(), None);
    }

    #[test]
    fn full_config_builds_batch_mode_argv() {
        let cfg = config(&[
            (ENV_SSH_HOST, "build.example.com"),
            (ENV_SSH_USER, "ryu"),
            (ENV_SSH_PORT, "2222"),
            (ENV_SSH_IDENTITY, "/keys/id_ed25519"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(cfg.binary, "ssh");
        let args = cfg.ssh_args("true");
        assert_eq!(
            args,
            [
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "-T",
                "-p",
                "2222",
                "-i",
                "/keys/id_ed25519",
                "--",
                "ryu@build.example.com",
                "true"
            ]
        );
        assert!(!args.iter().any(|a| a.contains("StrictHostKeyChecking")));
    }

    #[test]
    fn invalid_config_is_rejected() {
        assert!(config(&[(ENV_SSH_HOST, "-oProxyCommand=x")]).is_err());
        assert!(config(&[(ENV_SSH_HOST, "h"), (ENV_SSH_PORT, "http")]).is_err());
        assert!(config(&[(ENV_SSH_HOST, "h"), (ENV_SSH_USER, "a@b")]).is_err());
    }

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn ephemeral_script_quotes_argv_and_cleans_up() {
        let spec = ExecSpec::new("echo", vec!["a b".to_owned(), "$HOME".to_owned()]);
        let script = ephemeral_script(&spec);
        assert!(script.contains("'echo' 'a b' '$HOME'"), "{script}");
        assert!(script.contains("rm -rf -- \"$d\""), "{script}");
        assert!(script.ends_with("exit $rc"), "{script}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ephemeral_script_runs_under_local_sh() {
        // Exercise the generated remote script with a local POSIX shell (no
        // network): output, exit code, and the temp-dir cleanup.
        let spec = ExecSpec::new(
            "sh",
            vec![
                "-c".to_owned(),
                "pwd; printf '%s' \"it's\"; exit 4".to_owned(),
            ],
        );
        let out = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(ephemeral_script(&spec))
            .output()
            .await
            .unwrap();
        assert_eq!(out.status.code(), Some(4));
        let stdout = String::from_utf8_lossy(&out.stdout);
        let dir = stdout.lines().next().unwrap();
        assert!(dir.contains(REMOTE_DIR_MARKER), "{stdout}");
        assert!(stdout.ends_with("it's"), "{stdout}");
        assert!(
            !std::path::Path::new(dir).exists(),
            "temp dir must be removed"
        );
    }

    #[test]
    fn workspace_ids_are_validated() {
        assert!(workspace_path(&WorkspaceId("/tmp/ryu-sandbox-ssh.AbC123".to_owned())).is_ok());
        for bad in [
            "/",
            "/home/user",
            "relative/ryu-sandbox-ssh.x",
            "/tmp/../ryu-sandbox-ssh.x",
        ] {
            assert!(
                workspace_path(&WorkspaceId(bad.to_owned())).is_err(),
                "{bad}"
            );
        }
    }

    #[tokio::test]
    async fn unconfigured_exec_errors_honestly() {
        if std::env::var(ENV_SSH_HOST).is_ok() {
            return;
        }
        let err = SshSandbox::new()
            .exec(ExecSpec::new("true", vec![]))
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains(ENV_SSH_HOST), "{err}");
        assert!(matches!(detect().await, DetectResult::Unavailable(_)));
    }
}
