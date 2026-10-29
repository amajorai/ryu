//! SGLang process management.
//!
//! Spawns `python -m sglang.launch_server` with the configured model and
//! forwards stdout/stderr to tracing. The server listens on 127.0.0.1:30000 by
//! default and exposes an OpenAI-compatible API under `/v1`.

use crate::sidecar::providers::python_server::{PythonServer, PythonServerProcess};

pub const DEFAULT_PORT: u16 = 30000;

/// SGLang's launch dialect: the model goes in `--model-path`, and the advanced
/// launch config becomes SGLang CLI flags (`--context-length`,
/// `--mem-fraction-static`, `--speculative-algorithm`, ...).
pub struct Sglang;

impl PythonServer for Sglang {
    const NAME: &'static str = "sglang";
    const MODULE: &'static str = "sglang.launch_server";
    const MODEL_FLAG: &'static str = "--model-path";
    const ENGINE: crate::inference::Engine = crate::inference::Engine::Sglang;

    fn log_stdout(line: &str) {
        tracing::info!(target: "sglang", "{line}");
    }

    fn log_stderr(line: &str) {
        tracing::warn!(target: "sglang", "{line}");
    }
}

pub type SglangProcess = PythonServerProcess<Sglang>;
