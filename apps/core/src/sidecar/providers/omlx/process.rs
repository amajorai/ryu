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
//! and Ryu keeps at most one resident at a time, so they never listen at once. A
//! foreign or stale listener on the port is refused before spawn
//! (`readiness::ensure_port_free`) instead of being mistaken for oMLX.
//!
//! oMLX layers its settings as `settings.json` < `OMLX_*` environment < CLI,
//! and writes every explicitly passed `serve` flag back into its own
//! `settings.json`. Core therefore pins the loopback host and port through
//! `OMLX_HOST`/`OMLX_PORT` (per-run, never persisted), so a host or port saved
//! in the user's oMLX settings cannot move the server off the address Core
//! probes. Saved native options are mostly `OMLX_*` environment for the same
//! reason (see the `omlx` catalog in `ryu-engines`).

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::providers::held_child::HeldChild;
use crate::sidecar::providers::readiness::ReadinessChild;
use crate::win_process::NoWindow;

/// oMLX's default loopback port (documented). Shared with vLLM by design — the
/// two are mutually-exclusive residents (see module docs).
pub const DEFAULT_PORT: u16 = 8000;

/// Ryu's own oMLX model store: `<data dir>/models/chat/omlx`.
pub fn ryu_model_dir() -> std::path::PathBuf {
    crate::sidecar::download_manager::model_family_dir(
        ryu_sidecar_runtime::layout::Modality::Chat,
        "omlx",
    )
}

/// The oMLX model directory it discovers models from: `RYU_OMLX_MODEL_DIR` when
/// set, otherwise [`ryu_model_dir`] (created on demand) so models live in the
/// Ryu data dir rather than `~/.omlx/models`.
pub fn default_model_dir() -> String {
    if let Ok(dir) = std::env::var("RYU_OMLX_MODEL_DIR") {
        if !dir.trim().is_empty() {
            return dir;
        }
    }
    let dir = ryu_model_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        tracing::warn!("could not create {}: {e}", dir.display());
    }
    dir.to_string_lossy().into_owned()
}

/// `serve` flags Core owns (or that would break Core's unauthenticated
/// readiness probe or relocate oMLX's state); dropped from raw args.
const MANAGED_VALUE_FLAGS: &[&str] = &[
    "--model-dir",
    "--host",
    "--port",
    "--api-key",
    "--base-path",
];
/// Environment Core sets or owns for the spawn.
const MANAGED_ENV: &[&str] = &[
    "OMLX_HOST",
    "OMLX_PORT",
    "OMLX_MODEL_DIR",
    "OMLX_API_KEY",
    "OMLX_BASE_PATH",
];

pub struct OmlxProcess {
    binary: String,
    model_dir: String,
    launch: crate::inference::LaunchConfig,
    held: HeldChild,
}

impl OmlxProcess {
    pub fn new(binary: String, model_dir: String) -> Self {
        Self {
            binary,
            model_dir,
            launch: crate::inference::LaunchConfig::default(),
            held: HeldChild::default(),
        }
    }

    /// Attach the saved engine launch settings (native options and raw args).
    pub fn with_launch(mut self, launch: crate::inference::LaunchConfig) -> Self {
        self.launch = launch;
        self
    }

    /// Arguments after the binary: `serve --model-dir <dir>`, then native
    /// options, then raw args with Core-owned flags removed.
    fn command_args(&self) -> Vec<String> {
        let mut args = vec![
            "serve".to_owned(),
            "--model-dir".to_owned(),
            self.model_dir.clone(),
        ];
        args.extend(crate::sidecar::providers::launch_args_with_filtered_raw(
            &self.launch,
            crate::inference::Engine::Omlx,
            MANAGED_VALUE_FLAGS,
            &[],
        ));
        args
    }

    /// Environment for the spawn: saved `OMLX_*` options (an inherited
    /// variable stays authoritative), then Core's loopback binding, which
    /// always wins.
    fn command_env(&self) -> Vec<(String, String)> {
        let mut env =
            crate::sidecar::providers::native_env_for_spawn("omlx", &self.launch, MANAGED_ENV);
        env.push(("OMLX_HOST".to_owned(), "127.0.0.1".to_owned()));
        env.push(("OMLX_PORT".to_owned(), DEFAULT_PORT.to_string()));
        env
    }

    pub async fn start(&mut self) -> Result<()> {
        let mut cmd = Command::new(&self.binary);
        cmd.args(self.command_args());
        for (name, value) in self.command_env() {
            cmd.env(name, value);
        }
        let child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .no_window()
            .spawn()
            .context("spawning omlx serve")?;
        self.held.attach(
            child,
            |line| tracing::info!(target: "omlx", "{line}"),
            |line| tracing::warn!(target: "omlx", "{line}"),
        );
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.held.stop("omlx").await;
        Ok(())
    }

    /// Wrap an already spawned child, for the provider's start-gate tests.
    #[cfg(test)]
    pub(crate) fn from_child_for_test(child: tokio::process::Child) -> Self {
        let mut process = Self::new(String::new(), String::new());
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

impl ReadinessChild for OmlxProcess {
    fn is_running(&mut self) -> bool {
        OmlxProcess::is_running(self)
    }

    fn stderr_tail(&self) -> String {
        self.held.stderr_tail()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process_with(launch: crate::inference::LaunchConfig) -> OmlxProcess {
        OmlxProcess::new("omlx".to_owned(), "/models".to_owned()).with_launch(launch)
    }

    #[test]
    fn native_flags_precede_raw_args_and_managed_flags_are_dropped() {
        let process = process_with(crate::inference::LaunchConfig {
            native: serde_json::json!({ "omlx_memory_guard": "balanced" })
                .as_object()
                .cloned()
                .unwrap(),
            extra_args: [
                "--port",
                "9000",
                "--model-dir=/elsewhere",
                "--sse-keepalive-mode",
                "off",
            ]
            .map(str::to_owned)
            .to_vec(),
            ..Default::default()
        });
        assert_eq!(
            process.command_args(),
            vec![
                "serve",
                "--model-dir",
                "/models",
                "--memory-guard",
                "balanced",
                "--sse-keepalive-mode",
                "off"
            ]
        );
    }

    #[test]
    fn saved_environment_never_moves_the_loopback_binding() {
        let process = process_with(crate::inference::LaunchConfig {
            native: serde_json::json!({ "omlx_headless": true })
                .as_object()
                .cloned()
                .unwrap(),
            ..Default::default()
        });
        let env = process.command_env();
        assert!(env.contains(&("OMLX_HOST".to_owned(), "127.0.0.1".to_owned())));
        assert!(env.contains(&("OMLX_PORT".to_owned(), DEFAULT_PORT.to_string())));
        assert_eq!(env.last().map(|(name, _)| name.as_str()), Some("OMLX_PORT"));
        if std::env::var_os("OMLX_HEADLESS").is_none() {
            assert_eq!(env[0], ("OMLX_HEADLESS".to_owned(), "1".to_owned()));
        }
    }
}
