//! Managed child process for the Restate server sidecar.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

/// HTTP/gRPC port Restate binds by default.
pub const RESTATE_HTTP_PORT: u16 = 8080;
/// Admin (management) port Restate exposes by default.
pub const RESTATE_ADMIN_PORT: u16 = 9070;
/// Ingress port for service invocations.
pub const RESTATE_INGRESS_PORT: u16 = 8080;

// ── Paths ──────────────────────────────────────────────────────────────────────

pub fn restate_dir() -> PathBuf {
    crate::paths::ryu_dir().join("restate")
}

fn pid_path() -> PathBuf {
    restate_dir().join("restate.pid")
}

// ── RestateProcess ─────────────────────────────────────────────────────────────

pub struct RestateProcess {
    child: Option<Child>,
    binary_path: PathBuf,
    pid_path: PathBuf,
    /// Handles for stdout/stderr forwarding tasks.
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl RestateProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            child: None,
            binary_path,
            pid_path: pid_path(),
            log_tasks: Vec::new(),
        }
    }

    /// Spawn `restate-server` and begin forwarding its stdio to tracing.
    pub async fn start(&mut self) -> Result<()> {
        self.cleanup_orphan().await;

        let data_dir = restate_dir().join("data");
        tokio::fs::create_dir_all(&data_dir).await?;

        let mut child = Command::new(&self.binary_path)
            .env("RESTATE_BASE_DIR", data_dir.to_string_lossy().as_ref())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .spawn()?;

        // Write PID file so we can recover from a crash on next start.
        if let Some(pid) = child.id() {
            tokio::fs::write(&self.pid_path, pid.to_string()).await?;
        }

        // Forward stdout -> tracing::info
        if let Some(stdout) = child.stdout.take() {
            let handle = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "restate", "{line}");
                }
            });
            self.log_tasks.push(handle);
        }

        // Forward stderr -> tracing::warn
        if let Some(stderr) = child.stderr.take() {
            let handle = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "restate", "{line}");
                }
            });
            self.log_tasks.push(handle);
        }

        self.child = Some(child);
        Ok(())
    }

    /// Gracefully stop the process: SIGTERM -> 5 s wait -> SIGKILL.
    pub async fn stop(&mut self) -> Result<()> {
        if self.child.is_none() {
            return Ok(());
        }

        // Abort log forwarding tasks first.
        for handle in self.log_tasks.drain(..) {
            handle.abort();
        }

        let child = self.child.as_mut().unwrap();

        #[cfg(unix)]
        if let Some(raw_pid) = child.id() {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            let _ = kill(Pid::from_raw(raw_pid as i32), Signal::SIGTERM);
        }

        #[cfg(windows)]
        {
            let _ = child.kill().await;
        }

        // Wait up to 5 s for the process to exit; force-kill on timeout.
        let child = self.child.as_mut().unwrap();
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                tracing::warn!("restate did not exit within 5 s — sending SIGKILL");
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let _ = tokio::fs::remove_file(&self.pid_path).await;
        self.child = None;
        Ok(())
    }

    /// Returns true if the child process is still alive.
    pub fn is_running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                self.child = None;
                false
            }
        }
    }

    /// Kill any leftover process whose PID is recorded in the PID file.
    pub async fn cleanup_orphan(&self) {
        let Ok(content) = tokio::fs::read_to_string(&self.pid_path).await else {
            return;
        };
        let Ok(pid) = content.trim().parse::<i32>() else {
            return;
        };

        #[cfg(unix)]
        {
            use nix::sys::signal::{kill, Signal};
            use nix::unistd::Pid;
            let nix_pid = Pid::from_raw(pid);
            let _ = kill(nix_pid, Signal::SIGTERM);
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = kill(nix_pid, Signal::SIGKILL);
        }

        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/PID", &pid.to_string()])
                .output();
        }
    }
}
