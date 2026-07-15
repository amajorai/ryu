//! vLLM process management.
//!
//! Spawns `python -m vllm.entrypoints.openai.api_server` with the configured
//! model and forwards stdout/stderr to tracing. The server listens on
//! 127.0.0.1:8000 by default.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::win_process::NoWindow;

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 8000;

pub struct VllmProcess {
    python: String,
    model: String,
    port: u16,
    /// Advanced per-model launch config translated to vLLM CLI flags
    /// (`--max-model-len`, `--gpu-memory-utilization`, `--speculative-config`, ...).
    launch: crate::inference::LaunchConfig,
    child: Option<Child>,
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl VllmProcess {
    pub fn new(python: String, model: String, port: u16) -> Self {
        Self {
            python,
            model,
            port,
            launch: crate::inference::LaunchConfig::default(),
            child: None,
            log_tasks: Vec::new(),
        }
    }

    /// Attach an advanced launch config (applied as extra CLI args at spawn).
    pub fn with_launch(mut self, launch: crate::inference::LaunchConfig) -> Self {
        self.launch = launch;
        self
    }

    pub async fn start(&mut self) -> Result<()> {
        let mut cmd = Command::new(&self.python);
        cmd.args([
            "-m",
            "vllm.entrypoints.openai.api_server",
            "--model",
            &self.model,
            "--host",
            DEFAULT_HOST,
            "--port",
            &self.port.to_string(),
        ]);
        // Advanced inference launch flags (research flags via `extra_args` ride along).
        for arg in self.launch.to_args(crate::inference::Engine::Vllm) {
            cmd.arg(arg);
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .no_window()
            .spawn()
            .context("spawning vllm server")?;

        if let Some(stdout) = child.stdout.take() {
            self.log_tasks.push(tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "vllm", "{line}");
                }
            }));
        }

        if let Some(stderr) = child.stderr.take() {
            self.log_tasks.push(tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "vllm", "{line}");
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
                    tracing::warn!("vllm did not exit within 10 s — sending SIGKILL");
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
