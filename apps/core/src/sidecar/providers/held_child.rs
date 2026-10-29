//! The lifecycle of a spawned engine server process that Core holds.
//!
//! The Python servers (vLLM, SGLang, MLX), MLX-VLM and oMLX each build and spawn
//! their own command; [`HeldChild`] then owns the child: it forwards stdout and
//! stderr to tracing, keeps a stderr tail for readiness errors, reports liveness,
//! and stops the process with SIGTERM before a SIGKILL.

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Child;

use crate::sidecar::providers::readiness::StderrTail;

#[derive(Default)]
pub(super) struct HeldChild {
    child: Option<Child>,
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
    /// Recent stderr, reported when the child exits before becoming ready.
    stderr_tail: StderrTail,
}

impl HeldChild {
    /// Hold `child`, forwarding each stdout line to `out` and each stderr line
    /// to `err` (after recording it in the stderr tail). A `tracing` target has
    /// to be a literal, so each engine passes its own logging closures.
    pub(super) fn attach(
        &mut self,
        mut child: Child,
        out: impl Fn(&str) + Send + 'static,
        err: impl Fn(&str) + Send + 'static,
    ) {
        if let Some(stdout) = child.stdout.take() {
            self.log_tasks.push(forward_lines(stdout, out));
        }

        if let Some(stderr) = child.stderr.take() {
            let tail = self.stderr_tail.clone();
            self.log_tasks.push(forward_lines(stderr, move |line| {
                tail.push(line);
                err(line);
            }));
        }

        self.child = Some(child);
    }

    /// Stop the log forwarders, then SIGTERM the child (kill on Windows) and
    /// SIGKILL it if it has not exited within 10 s. `name` labels the warning.
    pub(super) async fn stop(&mut self, name: &str) {
        for handle in self.log_tasks.drain(..) {
            handle.abort();
        }

        if let Some(mut child) = self.child.take() {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                use nix::sys::signal::{kill, Signal};
                use nix::unistd::Pid;
                let _ = kill(Pid::from_raw(pid as i32), Signal::SIGTERM);
            }

            #[cfg(windows)]
            let _ = child.kill().await;

            let mut child = child;
            match tokio::time::timeout(std::time::Duration::from_secs(10), child.wait()).await {
                Ok(_) => {}
                Err(_) => {
                    tracing::warn!("{name} did not exit within 10 s — sending SIGKILL");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }
    }

    /// Whether the held child is still alive; an exited child is released.
    pub(super) fn is_running(&mut self) -> bool {
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

    pub(super) fn stderr_tail(&self) -> String {
        self.stderr_tail.snapshot()
    }

    /// Hold an already spawned child without forwarding its output (tests).
    #[cfg(test)]
    pub(super) fn from_child(child: Child) -> Self {
        Self {
            child: Some(child),
            ..Self::default()
        }
    }

    /// OS process id of the held child, when one is held.
    #[cfg(test)]
    pub(super) fn pid(&self) -> Option<u32> {
        self.child.as_ref().and_then(Child::id)
    }
}

/// Hand every line `reader` produces to `log` until the stream closes.
fn forward_lines<R>(reader: R, log: impl Fn(&str) + Send + 'static) -> tokio::task::JoinHandle<()>
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
