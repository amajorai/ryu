//! MLX process management.
//!
//! Spawns `python -m mlx_lm server` with the configured model and forwards
//! stdout/stderr to tracing. The server listens on 127.0.0.1:8082 by default.
//!
//! Note: `mlx_lm server` defaults to port 8080 (which collides with llama.cpp),
//! so `--port` is passed explicitly, never relied on as a default.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const DEFAULT_HOST: &str = "127.0.0.1";
/// MLX's loopback port. 8082 is free in the 808x block (8080 = llama.cpp,
/// 8081 = embeddings, 8083 = stable-diffusion).
pub const DEFAULT_PORT: u16 = 8082;

pub struct MlxProcess {
    python: String,
    model: String,
    port: u16,
    /// Advanced per-model launch config. MLX's launch surface is minimal, so this
    /// is wired for parity with vLLM/SGLang but currently emits no extra flags
    /// (see `crate::inference::LaunchConfig::to_args` for `Engine::Mlx`).
    launch: crate::inference::LaunchConfig,
    child: Option<Child>,
    log_tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl MlxProcess {
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
        // `python -m mlx_lm server ...` is the non-deprecated invocation
        // (`python -m mlx_lm.server` still works but warns).
        cmd.args([
            "-m",
            "mlx_lm",
            "server",
            "--model",
            &self.model,
            "--host",
            DEFAULT_HOST,
            "--port",
            &self.port.to_string(),
        ]);
        // Advanced inference launch flags (research flags via `extra_args` ride along).
        for arg in self.launch.to_args(crate::inference::Engine::Mlx) {
            cmd.arg(arg);
        }
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .spawn()
            .context("spawning mlx server")?;

        if let Some(stdout) = child.stdout.take() {
            self.log_tasks.push(tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::info!(target: "mlx", "{line}");
                }
            }));
        }

        if let Some(stderr) = child.stderr.take() {
            self.log_tasks.push(tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "mlx", "{line}");
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
                    tracing::warn!("mlx did not exit within 10 s — sending SIGKILL");
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
