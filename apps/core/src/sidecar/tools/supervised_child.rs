//! Child-process supervision shared by the Ghost and Shadow tool sidecars.
//!
//! Each runs one binary with piped stdio forwarded to tracing, records its PID
//! so an orphan left by a crash is reaped on the next start (only while the PID
//! still names the tool's own binary; see `orphan.rs`), and stops it with
//! SIGTERM → a grace period (5 s unless the tool asks for longer) → SIGKILL.
//! The tools differ only in how they build their command, which tracing target
//! their output goes to, and (Shadow) how long a stop may take.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};

use crate::win_process::NoWindow;

/// How long [`SupervisedChild::stop`] waits after SIGTERM before a hard kill.
const DEFAULT_STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq)]
pub enum ProcessState {
    Starting,
    Running,
    Stopping,
    Stopped,
    Failed(String),
}

pub(super) struct SupervisedChild {
    /// Tool name, used in shutdown warnings.
    name: &'static str,
    child: Option<Child>,
    pid_path: PathBuf,
    state: ProcessState,
    /// Handles for stdout/stderr forwarding tasks.
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl SupervisedChild {
    pub(super) fn new(name: &'static str, pid_path: PathBuf) -> Self {
        Self {
            name,
            child: None,
            pid_path,
            state: ProcessState::Stopped,
            log_tasks: Vec::new(),
        }
    }

    /// Stop any orphan of `binary_path` from an earlier crash and mark a start as
    /// in progress.
    pub(super) async fn begin_start(&mut self, binary_path: &Path) {
        self.cleanup_orphan(binary_path).await;
        self.state = ProcessState::Starting;
    }

    /// Spawn `command` with piped stdio, record its PID, and forward stdout and
    /// stderr line by line to `log_stdout` / `log_stderr` (each tool logs under
    /// its own target, which `tracing` requires to be a literal at the call site).
    pub(super) async fn spawn(
        &mut self,
        command: &mut Command,
        log_stdout: fn(&str),
        log_stderr: fn(&str),
    ) -> Result<()> {
        let mut child = command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .no_window()
            .spawn()?;

        // Write PID file so we can recover from a crash on next start.
        if let Some(pid) = child.id() {
            tokio::fs::write(&self.pid_path, pid.to_string()).await?;
        }

        if let Some(stdout) = child.stdout.take() {
            self.log_tasks.push(forward_lines(stdout, log_stdout));
        }
        if let Some(stderr) = child.stderr.take() {
            self.log_tasks.push(forward_lines(stderr, log_stderr));
        }

        self.child = Some(child);
        self.state = ProcessState::Running;
        Ok(())
    }

    /// Gracefully stop the process: SIGTERM → 5 s wait → SIGKILL.
    pub(super) async fn stop(&mut self) -> Result<()> {
        self.stop_within(DEFAULT_STOP_GRACE, None::<std::future::Ready<()>>)
            .await
    }

    /// [`Self::stop`] with an explicit grace period before the hard kill. On
    /// Windows (no SIGTERM) `windows_stop`, when given, asks the child to exit on
    /// its own instead of killing it at once; elsewhere it is not awaited.
    pub(super) async fn stop_within<F>(
        &mut self,
        grace: Duration,
        windows_stop: Option<F>,
    ) -> Result<()>
    where
        F: std::future::Future<Output = ()>,
    {
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
        match windows_stop {
            Some(request) => request.await,
            None => {
                let _ = child.kill().await;
            }
        }
        #[cfg(not(windows))]
        drop(windows_stop);

        // Wait up to `grace` for the process to exit; force-kill on timeout.
        let child = self.child.as_mut().unwrap();
        match tokio::time::timeout(grace, child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                tracing::warn!(
                    "{} did not exit within {} s — killing it",
                    self.name,
                    grace.as_secs()
                );
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        let _ = tokio::fs::remove_file(&self.pid_path).await;
        self.state = ProcessState::Stopped;
        self.child = None;
        Ok(())
    }

    /// Returns true if the child process is still alive.
    pub(super) fn is_running(&mut self) -> bool {
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

    /// OS process id of the live child, when this process spawned one.
    pub(super) fn pid(&mut self) -> Option<u32> {
        if !self.is_running() {
            return None;
        }
        self.child.as_ref().and_then(Child::id)
    }

    #[cfg(test)]
    pub(super) fn state(&self) -> &ProcessState {
        &self.state
    }

    /// Supervise an already spawned `child` (tests drive [`Self::stop`] on a
    /// stand-in process).
    #[cfg(test)]
    pub(super) fn adopt_for_test(&mut self, child: Child) {
        self.child = Some(child);
        self.state = ProcessState::Running;
    }

    /// Stop a leftover process recorded in the PID file, but only while it is
    /// still `binary_path`'s own orphan (the PID may have been reused since).
    pub(super) async fn cleanup_orphan(&self, binary_path: &Path) {
        super::orphan::reap(&self.pid_path, binary_path, self.name).await;
    }
}

/// Hand every line `reader` produces to `log` until the stream closes.
fn forward_lines<R>(reader: R, log: fn(&str)) -> tokio::task::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log(&line);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // NOTE: these cover only the pure state-machine defaults. `spawn`/`stop`/
    // `cleanup_orphan` are deliberately NOT exercised — they spawn or signal real
    // processes, which a unit test must never do. The orphan identity checks are
    // covered in `sidecar::tools::orphan`.

    #[test]
    fn new_starts_in_stopped_state_with_no_child() {
        let mut child = SupervisedChild::new("tool", PathBuf::from("/tmp/tool.pid"));
        assert_eq!(child.state(), &ProcessState::Stopped);
        // No child was spawned, so it is not running and the state is unchanged.
        assert!(!child.is_running());
        assert_eq!(child.state(), &ProcessState::Stopped);
    }
}
