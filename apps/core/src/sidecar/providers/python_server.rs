//! Process management shared by the Python OpenAI-compatible servers launched as
//! `python -m <module>` (vLLM, SGLang, MLX).
//!
//! Spawns the engine's entry module with the configured model, forwards
//! stdout/stderr to tracing, and stops it with SIGTERM before a SIGKILL. The
//! engines differ only in what their [`PythonServer`] marker names: the module,
//! the flag that selects the model, the launch-flag dialect and the log target.

use std::marker::PhantomData;
use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::sidecar::providers::held_child::HeldChild;
use crate::sidecar::providers::readiness::ReadinessChild;
use crate::win_process::NoWindow;

const DEFAULT_HOST: &str = "127.0.0.1";

/// What one Python server engine contributes to [`PythonServerProcess`].
pub trait PythonServer: 'static {
    /// Engine name used in spawn errors and shutdown warnings.
    const NAME: &'static str;
    /// Entry module, run as `python -m <MODULE>`.
    const MODULE: &'static str;
    /// Positional arguments after the module (`mlx_lm server`).
    const MODULE_ARGS: &'static [&'static str] = &[];
    /// Flag that names the model to serve.
    const MODEL_FLAG: &'static str;
    /// Dialect the advanced [`crate::inference::LaunchConfig`] is translated to.
    const ENGINE: crate::inference::Engine;

    /// Forward one stdout line to tracing under the engine's own target (a
    /// `tracing` target has to be a literal, so each engine writes the call).
    fn log_stdout(line: &str);
    /// Forward one stderr line to tracing under the engine's own target.
    fn log_stderr(line: &str);
}

pub struct PythonServerProcess<E> {
    python: String,
    model: String,
    port: u16,
    /// Advanced per-model launch config translated to the engine's CLI flags
    /// (see each [`PythonServer`] marker for its dialect).
    launch: crate::inference::LaunchConfig,
    /// `--served-model-name`, set when `model` is a local snapshot path so the
    /// API keeps advertising the original repo id.
    served_name: Option<String>,
    held: HeldChild,
    engine: PhantomData<E>,
}

impl<E: PythonServer> PythonServerProcess<E> {
    pub fn new(python: String, model: String, port: u16) -> Self {
        Self {
            python,
            model,
            port,
            launch: crate::inference::LaunchConfig::default(),
            served_name: None,
            held: HeldChild::default(),
            engine: PhantomData,
        }
    }

    /// Advertise `name` on `/v1/models` instead of the model path.
    pub fn with_served_model_name(mut self, name: Option<String>) -> Self {
        self.served_name = name;
        self
    }

    /// Attach an advanced launch config (applied as extra CLI args at spawn).
    pub fn with_launch(mut self, launch: crate::inference::LaunchConfig) -> Self {
        self.launch = launch;
        self
    }

    pub async fn start(&mut self) -> Result<()> {
        let mut cmd = Command::new(&self.python);
        cmd.args(["-m", E::MODULE]);
        cmd.args(E::MODULE_ARGS);
        cmd.args([
            E::MODEL_FLAG,
            &self.model,
            "--host",
            DEFAULT_HOST,
            "--port",
            &self.port.to_string(),
        ]);
        // Advanced inference launch flags (research flags via `extra_args` ride along).
        for arg in self.launch.to_args(E::ENGINE) {
            cmd.arg(arg);
        }
        if let Some(name) = &self.served_name {
            cmd.args(["--served-model-name", name]);
        }
        // Keep every Hub download inside the data dir (`models/hf`).
        for (key, value) in crate::sidecar::providers::python_engine_env() {
            cmd.env(key, value);
        }
        let child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(false)
            .no_window()
            .spawn()
            .with_context(|| format!("spawning {} server", E::NAME))?;
        self.held.attach(child, E::log_stdout, E::log_stderr);
        Ok(())
    }

    pub async fn stop(&mut self) -> Result<()> {
        self.held.stop(E::NAME).await;
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

impl<E: PythonServer> ReadinessChild for PythonServerProcess<E> {
    fn is_running(&mut self) -> bool {
        PythonServerProcess::is_running(self)
    }

    fn stderr_tail(&self) -> String {
        self.held.stderr_tail()
    }
}
