//! MLX-VLM process management.
//!
//! Spawns `python -m mlx_vlm.server` with the configured model and forwards
//! stdout/stderr to tracing. The server listens on 127.0.0.1:8084 by default.
//!
//! `mlx_vlm.server` defaults to host `0.0.0.0` and port `8080` (which collides
//! with llama.cpp), so `--host`/`--port` are passed explicitly, never relied on
//! as defaults. `--model` preloads a model at startup; without it the server
//! lazily loads on the first request. We always pass `--model` so activation
//! binds a concrete model (parity with mlx-lm / vLLM / SGLang).

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::providers::held_child::HeldChild;
use crate::win_process::NoWindow;

pub const DEFAULT_HOST: &str = "127.0.0.1";
/// MLX-VLM's canonical (release) loopback port. 8084 sits in the 808x block
/// (8080 = llama.cpp, 8081 = embeddings, 8082 = rerank, 8083 = classify,
/// 8086 = mlx-lm; stable-diffusion is 8101). The concrete port is profile-aware; see [`default_port`].
pub const DEFAULT_PORT_BASE: u16 = 8084;

/// Profile-aware MLX-VLM port (release 8084, dev 9084, …). Both the spawn side
/// (`--port`) and the client base URL (`active_engine::local_engine_url`) resolve
/// the SAME port through here, so a dev stack never dials the release engine.
pub fn default_port() -> u16 {
    crate::profile::port(DEFAULT_PORT_BASE)
}

/// Flags Core passes (or must not let a user pass) to `mlx_vlm.server`; each
/// takes a value.
const MANAGED_VALUE_FLAGS: &[&str] = &["--model", "--host", "--port", "--api-key"];

pub struct MlxVlmProcess {
    python: String,
    model: String,
    port: u16,
    /// Advanced launch config (engine settings merged with the model's): native
    /// `mlx-vlm` catalog options plus the raw `extra_args` escape hatch — see
    /// `crate::inference::LaunchConfig::to_args` for `Engine::MlxVlm`.
    launch: crate::inference::LaunchConfig,
    held: HeldChild,
}

impl MlxVlmProcess {
    pub fn new(python: String, model: String, port: u16) -> Self {
        Self {
            python,
            model,
            port,
            launch: crate::inference::LaunchConfig::default(),
            held: HeldChild::default(),
        }
    }

    /// Attach an advanced launch config (applied as extra CLI args at spawn).
    pub fn with_launch(mut self, launch: crate::inference::LaunchConfig) -> Self {
        self.launch = launch;
        self
    }

    /// Launch flags appended after the base command: native `mlx-vlm` options,
    /// then raw `extra_args` (last, so a raw flag wins under argparse). This
    /// must use `Engine::MlxVlm`: `Engine::Other` emits nothing, which silently
    /// dropped every user-supplied MLX-VLM launch argument. Core-managed flags
    /// are stripped from the raw args: argparse keeps the last value, so a saved
    /// `--port`/`--host`/`--model` would move the server off what Core probes,
    /// and `--api-key` would break Core's unauthenticated readiness probe.
    fn launch_args(&self) -> Vec<String> {
        crate::sidecar::providers::launch_args_with_filtered_raw(
            &self.launch,
            crate::inference::Engine::MlxVlm,
            MANAGED_VALUE_FLAGS,
            &[],
        )
    }

    /// Saved environment-only options (prefix cache, queue timeout, speculative
    /// coalescing). An inherited variable of the same name stays authoritative.
    fn launch_env(&self) -> Vec<(String, String)> {
        crate::sidecar::providers::native_env_for_spawn("mlx-vlm", &self.launch, &["HF_HOME"])
    }

    pub async fn start(&mut self) -> Result<()> {
        let mut cmd = Command::new(&self.python);
        // `python -m mlx_vlm.server --model <repo> --host <h> --port <p>`.
        cmd.args([
            "-m",
            "mlx_vlm.server",
            "--model",
            &self.model,
            "--host",
            DEFAULT_HOST,
            "--port",
            &self.port.to_string(),
        ]);
        // Advanced inference launch flags (research flags via `extra_args` ride along).
        for arg in self.launch_args() {
            cmd.arg(arg);
        }
        // Keep every Hub download inside the data dir (`models/hf`).
        for (key, value) in crate::sidecar::providers::python_engine_env() {
            cmd.env(key, value);
        }
        for (key, value) in self.launch_env() {
            cmd.env(key, value);
        }
        let child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .no_window()
            .spawn()
            .context("spawning mlx-vlm server")?;
        self.held.attach(
            child,
            |line| tracing::info!(target: "mlx-vlm", "{line}"),
            |line| tracing::warn!(target: "mlx-vlm", "{line}"),
        );
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.held.stop("mlx-vlm").await;
        Ok(())
    }

    /// Wrap an already spawned child, for the provider's start-gate tests.
    #[cfg(test)]
    pub(crate) fn from_child_for_test(child: tokio::process::Child) -> Self {
        let mut process = Self::new(String::new(), String::new(), 0);
        process.held = HeldChild::from_child(child);
        process
    }

    /// OS process id of the held child, when one is held.
    #[cfg(test)]
    pub(crate) fn pid(&self) -> Option<u32> {
        self.held.pid()
    }

    pub fn is_running(&mut self) -> bool {
        self.held.is_running()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_launch_arguments_reach_the_mlx_vlm_command() {
        let process = MlxVlmProcess::new("python3".to_owned(), "repo/model".to_owned(), 1)
            .with_launch(crate::inference::LaunchConfig {
                extra_args: vec!["--max-tokens".to_owned(), "512".to_owned()],
                ..Default::default()
            });
        assert_eq!(process.launch_args(), vec!["--max-tokens", "512"]);
    }

    #[test]
    fn raw_args_cannot_override_core_managed_flags() {
        let process = MlxVlmProcess::new("python3".to_owned(), "repo/model".to_owned(), 1)
            .with_launch(crate::inference::LaunchConfig {
                extra_args: vec![
                    "--port".to_owned(),
                    "1".to_owned(),
                    "--api-key".to_owned(),
                    "x".to_owned(),
                    "--host=0.0.0.0".to_owned(),
                    "--model".to_owned(),
                    "other/model".to_owned(),
                    "--max-tokens".to_owned(),
                    "512".to_owned(),
                ],
                ..Default::default()
            });
        assert_eq!(process.launch_args(), vec!["--max-tokens", "512"]);
    }

    #[test]
    fn native_options_precede_raw_args_and_env_options_reach_the_environment() {
        let process = MlxVlmProcess::new("python3".to_owned(), "repo/model".to_owned(), 1)
            .with_launch(crate::inference::LaunchConfig {
                native: serde_json::json!({
                    "mlx_vlm_max_kv_size": 8192,
                    "mlx_vlm_apc_num_blocks": 512,
                })
                .as_object()
                .cloned()
                .unwrap(),
                extra_args: vec!["--max-kv-size".to_owned(), "4096".to_owned()],
                ..Default::default()
            });
        assert_eq!(
            process.launch_args(),
            vec!["--max-kv-size", "8192", "--max-kv-size", "4096"]
        );
        if std::env::var_os("APC_NUM_BLOCKS").is_none() {
            assert_eq!(
                process.launch_env(),
                vec![("APC_NUM_BLOCKS".to_owned(), "512".to_owned())]
            );
        }
    }
}
