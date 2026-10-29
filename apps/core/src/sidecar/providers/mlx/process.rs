//! MLX process management.
//!
//! Spawns `python -m mlx_lm server` with the configured model and forwards
//! stdout/stderr to tracing. The server listens on 127.0.0.1:8086 by default.
//!
//! Note: `mlx_lm server` defaults to port 8080 (which collides with llama.cpp),
//! so `--port` is passed explicitly, never relied on as a default.

use crate::sidecar::providers::python_server::{PythonServer, PythonServerProcess};

/// MLX's canonical (release) loopback port. 8086 is free in the 808x block
/// (8080 = llama.cpp, 8081 = embeddings, 8082 = rerank, 8083 = classify,
/// 8084 = mlx-vlm, 8085 = tts, 8087 = research, 8088 = speech processing,
/// 8089 = apfel, 8090 = whisper, 8091 = audio.cpp) — moved off the
/// old 8082 which collided with the reranker. The concrete port is profile-aware;
/// see [`default_port`].
pub const DEFAULT_PORT_BASE: u16 = 8086;

/// Profile-aware MLX port (release 8086, dev 9086, …). Both the spawn side
/// (`--port`) and the client base URL (`active_engine::local_engine_url`) resolve
/// the SAME port through here, so a dev stack never dials the release engine.
pub fn default_port() -> u16 {
    crate::profile::port(DEFAULT_PORT_BASE)
}

/// MLX's launch dialect: `python -m mlx_lm server --model <model>` (the
/// non-deprecated invocation; `python -m mlx_lm.server` still works but warns).
/// MLX's launch surface is minimal, so the advanced launch config is wired for
/// parity with vLLM/SGLang but currently emits no extra flags (see
/// `crate::inference::LaunchConfig::to_args` for `Engine::Mlx`).
pub struct Mlx;

impl PythonServer for Mlx {
    const NAME: &'static str = "mlx";
    const MODULE: &'static str = "mlx_lm";
    const MODULE_ARGS: &'static [&'static str] = &["server"];
    const MODEL_FLAG: &'static str = "--model";
    const ENGINE: crate::inference::Engine = crate::inference::Engine::Mlx;

    fn log_stdout(line: &str) {
        tracing::info!(target: "mlx", "{line}");
    }

    fn log_stderr(line: &str) {
        tracing::warn!(target: "mlx", "{line}");
    }
}

pub type MlxProcess = PythonServerProcess<Mlx>;
