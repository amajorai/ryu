//! oMLX process management.
//!
//! Spawns `omlx serve --model-dir <dir>` (the documented headless invocation)
//! and forwards stdout/stderr to tracing. oMLX is a **multi-model** server: it
//! discovers LLMs / VLMs / embedding models from subdirectories of `--model-dir`
//! and the client selects one via the request `model` field (like Ollama), so —
//! unlike mlx-lm / mlx-vlm / vLLM — there is no single `--model` to bind.
//!
//! oMLX binds **port 8000 by default** (== vLLM's port). That collision is
//! intentional and safe: oMLX and vLLM are both swappable *resident* chat engines
//! and Ryu keeps at most one resident at a time, so they never listen at once. We
//! pass only the documented `--model-dir` flag — `omlx serve`'s `--port`/`--host`
//! flags are unverified here (no Mac to test on), so we avoid guessing flags that
//! could make the binary reject its arguments at runtime.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::win_process::NoWindow;

/// oMLX's default loopback port (documented). Shared with vLLM by design — the
/// two are mutually-exclusive residents (see module docs).
pub const DEFAULT_PORT: u16 = 8000;

/// The oMLX model directory it discovers models from. Default mirrors oMLX's own
/// zero-config default (`~/.omlx/models`); override with `RYU_OMLX_MODEL_DIR`.
pub fn default_model_dir() -> String {
    if let Ok(dir) = std::env::var("RYU_OMLX_MODEL_DIR") {
        return dir;
    }
    dirs::home_dir()
        .map(|h| {
            h.join(".omlx")
                .join("models")
                .to_string_lossy()
                .into_owned()
        })
        .unwrap_or_else(|| "~/.omlx/models".to_string())
}

pub struct OmlxProcess {
    binary: String,
    model_dir: String,
    child: Option<Child>,
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl OmlxProcess {
    pub fn new(binary: String, model_dir: String) -> Self {
        Self {
            binary,
            model_dir,
            child: None,
            log_tasks: Vec::new(),
        }
    }

    pub async fn start(&mut self) -> Result<()> {
        let mut cmd = Command::new(&self.binary);
        cmd.args(["serve", "--model-dir", &self.model_dir]);
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .no_window()
            .spawn()
            .context("spawning omlx serve")?;

        if let Some(stdout) = child.stdout.take() {
            self.log_tasks.push(tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "omlx", "{line}");
                }
            }));
        }

        if let Some(stderr) = child.stderr.take() {
            self.log_tasks.push(tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "omlx", "{line}");
                }
            }));
        }

        self.child = Some(child);
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
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
                    tracing::warn!("omlx did not exit within 10 s — sending SIGKILL");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                }
            }
        }

        Ok(())
    }

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
}
