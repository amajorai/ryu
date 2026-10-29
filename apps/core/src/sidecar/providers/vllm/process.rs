//! vLLM process management.
//!
//! Spawns `python -m vllm.entrypoints.openai.api_server` with the configured
//! model and forwards stdout/stderr to tracing. The server listens on
//! 127.0.0.1:8000 by default.

use crate::sidecar::providers::python_server::{PythonServer, PythonServerProcess};

pub const DEFAULT_PORT: u16 = 8000;

/// vLLM's launch dialect: the model goes in `--model`, and the advanced launch
/// config becomes vLLM CLI flags (`--max-model-len`, `--gpu-memory-utilization`,
/// `--speculative-config`, ...).
pub struct Vllm;

impl PythonServer for Vllm {
    const NAME: &'static str = "vllm";
    const MODULE: &'static str = "vllm.entrypoints.openai.api_server";
    const MODEL_FLAG: &'static str = "--model";
    const ENGINE: crate::inference::Engine = crate::inference::Engine::Vllm;

    fn log_stdout(line: &str) {
        tracing::info!(target: "vllm", "{line}");
    }

    fn log_stderr(line: &str) {
        tracing::warn!(target: "vllm", "{line}");
    }
}

pub type VllmProcess = PythonServerProcess<Vllm>;
