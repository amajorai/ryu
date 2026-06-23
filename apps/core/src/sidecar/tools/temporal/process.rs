//! Managed child process for the Temporal CLI sidecar.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const GRPC_PORT: u16 = 7233;
const UI_PORT: u16 = 7234;

// ── Paths ──────────────────────────────────────────────────────────────────────

fn temporal_dir() -> PathBuf {
    crate::paths::ryu_dir().join("temporal")
}

fn db_path() -> PathBuf {
    temporal_dir().join("temporal.db")
}

fn pid_path() -> PathBuf {
    temporal_dir().join("temporal.pid")
}

// ── ProcessState ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed(String),
}

// ── TemporalProcess ────────────────────────────────────────────────────────────

pub struct TemporalProcess {
    child: Option<Child>,
    binary_path: PathBuf,
    pid_path: PathBuf,
    state: ProcessState,
    /// Handles for stdout/stderr forwarding tasks.
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl TemporalProcess {
    pub fn new(binary_path: PathBuf) -> Self {
        Self {
            child: None,
            binary_path,
            pid_path: pid_path(),
            state: ProcessState::Stopped,
            log_tasks: Vec::new(),
        }
    }

    /// Spawn `temporal server start-dev` and begin forwarding its stdio to tracing.
    pub async fn start(&mut self) -> Result<()> {
        self.cleanup_orphan().await;
        self.state = ProcessState::Starting;

        let mut child = Command::new(&self.binary_path)
            .args([
                "server",
                "start-dev",
                "--db-filename",
                &db_path().to_string_lossy(),
                "--port",
                &GRPC_PORT.to_string(),
                "--ui-port",
                &UI_PORT.to_string(),
                "--log-level",
                "warn",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .spawn()?;

        // Write PID file so we can recover from a crash on next start.
        if let Some(pid) = child.id() {
            tokio::fs::write(&self.pid_path, pid.to_string()).await?;
        }

        // Forward stdout → tracing::info
        if let Some(stdout) = child.stdout.take() {
            let handle = tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "temporal", "{line}");
                }
            });
            self.log_tasks.push(handle);
        }

        // Forward stderr → tracing::warn
        if let Some(stderr) = child.stderr.take() {
            let handle = tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "temporal", "{line}");
                }
            });
            self.log_tasks.push(handle);
        }

        self.child = Some(child);
        self.state = ProcessState::Running;
        Ok(())
    }

    /// Gracefully stop the process: SIGTERM → 5 s wait → SIGKILL.
    pub async fn stop(&mut self) -> Result<()> {
        if self.child.is_none() {
            return Ok(());
        }
        self.state = ProcessState::Stopping;

        // Abort log forwarding tasks first.
        for handle in self.log_tasks.drain(..) {
            handle.abort();
        }

        let child = self.child.as_mut().unwrap();

        // Send graceful termination signal.
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
                tracing::warn!("temporal did not exit within 5 s — sending SIGKILL");
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let _ = tokio::fs::remove_file(&self.pid_path).await;
        self.state = ProcessState::Stopped;
        self.child = None;
        Ok(())
    }

    pub async fn restart(&mut self) -> Result<()> {
        self.stop().await?;
        self.start().await
    }

    /// Returns true if the child process is still alive.
    pub fn is_running(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else {
            return false;
        };
        match child.try_wait() {
            Ok(None) => true,
            _ => {
                self.state = ProcessState::Stopped;
                self.child = None;
                false
            }
        }
    }

    /// Non-blocking exit check.
    pub fn poll_exit(&mut self) -> Option<std::process::ExitStatus> {
        let child = self.child.as_mut()?;
        match child.try_wait() {
            Ok(Some(status)) => {
                self.state = ProcessState::Stopped;
                self.child = None;
                Some(status)
            }
            _ => None,
        }
    }

    /// Returns `true` if a live child process handle is currently held.
    pub fn has_child(&self) -> bool {
        self.child.is_some()
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
