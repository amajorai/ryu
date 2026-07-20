//! Active local engine selection.
//!
//! Ryu keeps **at most one local inference engine resident at a time**
//! (llama.cpp *or* ollama *or* vllm, never two). Switching engines is a managed
//! swap: stop the current resident, start the requested one. This module owns
//! the durable record of which engine is currently selected so the choice
//! survives Core restarts, plus the canonical list of which sidecars count as
//! "local engines".
//!
//! The swap logic itself lives on [`crate::sidecar::SidecarManager`]; this
//! module is just the persisted selection and the engine-set helpers.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::sidecar::download_manager::ryu_dir;

/// The local inference engines Ryu manages with swap-on-demand. Exactly one of
/// these may be resident at a time. Keep this in sync with the providers
/// registered in `main.rs`.
pub const LOCAL_ENGINES: &[&str] = &[
    "llamacpp",
    "ollama",
    "vllm",
    "sglang",
    "mlx",
    "mlx-vlm",
    "omlx",
    "docker-model-runner",
    // Apple Foundation Models via the `apfel` server (Apple Silicon macOS 26+).
    "apfel",
];

/// True if `name` is one of the swappable local inference engines.
pub fn is_local_engine(name: &str) -> bool {
    LOCAL_ENGINES.contains(&name)
}

/// The OpenAI-compatible base URL a local engine serves on once resident. Each
/// engine binds a fixed loopback port (see the provider modules under
/// `sidecar/providers/`); chat requests for an agent bound to a local engine are
/// proxied to `{base}/v1/chat/completions`. Returns `None` for non-engines.
pub fn local_engine_base_url(name: &str) -> Option<String> {
    match name {
        // ollama serves its OpenAI-compat API on 11434.
        "ollama" => Some("http://127.0.0.1:11434".to_owned()),
        // llama-server (`--port 8080 --host 127.0.0.1`). Profile-aware: the spawn
        // side (`providers/llamacpp/{process,mod}.rs`) binds the same
        // `profile::port(8080)`, so a dev stack (9080) never collides with release.
        "llamacpp" => Some(format!("http://127.0.0.1:{}", crate::profile::port(8080))),
        // vllm OpenAI server (DEFAULT_PORT = 8000).
        "vllm" => Some("http://127.0.0.1:8000".to_owned()),
        // sglang launch_server (DEFAULT_PORT = 30000).
        "sglang" => Some("http://127.0.0.1:30000".to_owned()),
        // mlx_lm server (DEFAULT_PORT_BASE = 8086). Profile-aware: matches the
        // spawn port in `providers/mlx/process.rs`.
        "mlx" => Some(format!(
            "http://127.0.0.1:{}",
            crate::sidecar::providers::mlx::process::default_port()
        )),
        // mlx_vlm.server (DEFAULT_PORT_BASE = 8084). Profile-aware: matches the
        // spawn port in `providers/mlx_vlm/process.rs`.
        "mlx-vlm" => Some(format!(
            "http://127.0.0.1:{}",
            crate::sidecar::providers::mlx_vlm::process::default_port()
        )),
        // omlx serve (DEFAULT_PORT = 8000 — shared with vLLM; mutually exclusive).
        "omlx" => Some("http://127.0.0.1:8000".to_owned()),
        // Docker Model Runner serves its OpenAI-compat API under `/engines/v1`
        // (not the bare `/v1`). Returning the `/engines` base makes the standard
        // `{base}/v1/chat/completions` join resolve to DMR's real endpoint, so no
        // routing code special-cases it. Adopt-only — Docker owns the process.
        "docker-model-runner" => Some("http://127.0.0.1:12434/engines".to_owned()),
        // apfel serves Apple Foundation Models on :11434 (shared with Ollama —
        // the two never reside at once; `apfel` has no `--port` override).
        "apfel" => Some("http://127.0.0.1:11434".to_owned()),
        _ => None,
    }
}

/// OpenAI-compatible base URL (including the `/v1` suffix) that a local engine
/// serves on. This is the address the gateway's `local` provider forwards to,
/// so a local engine registers into the gateway router like any other provider
/// and "the swap is invisible" to agents (U19).
///
/// The ports mirror each engine's sidecar process definition:
///   - `llamacpp` → `llama-server --port 8080` (`providers/llamacpp/process.rs`)
///   - `ollama`   → Ollama daemon on `11434`
///   - `vllm`     → `vllm serve --port 8000` (`providers/vllm/process.rs`)
///   - `sglang`   → `sglang.launch_server --port 30000` (`providers/sglang/process.rs`)
///   - `mlx`      → `mlx_lm server --port 8086` (`providers/mlx/process.rs`, Apple Silicon only)
///
/// Returns `None` for names that are not managed local engines.
pub fn local_engine_url(name: &str) -> Option<String> {
    match name {
        // Profile-aware (matches the spawn port in `providers/llamacpp`).
        "llamacpp" => Some(format!(
            "http://127.0.0.1:{}/v1",
            crate::profile::port(8080)
        )),
        "ollama" => Some("http://127.0.0.1:11434/v1".to_owned()),
        "vllm" => Some("http://127.0.0.1:8000/v1".to_owned()),
        "sglang" => Some("http://127.0.0.1:30000/v1".to_owned()),
        "mlx" => Some(format!(
            "http://127.0.0.1:{}/v1",
            crate::sidecar::providers::mlx::process::default_port()
        )),
        "mlx-vlm" => Some(format!(
            "http://127.0.0.1:{}/v1",
            crate::sidecar::providers::mlx_vlm::process::default_port()
        )),
        // oMLX shares vLLM's :8000 — safe, the two never reside at once.
        "omlx" => Some("http://127.0.0.1:8000/v1".to_owned()),
        // Docker Model Runner's OpenAI-compat API is under `/engines/v1`; the
        // gateway appends `/chat/completions`, yielding the correct DMR path.
        "docker-model-runner" => Some("http://127.0.0.1:12434/engines/v1".to_owned()),
        // apfel (Apple Foundation Models) — OpenAI-compat on :11434. Shares the
        // port with Ollama; safe, the two never reside at once.
        "apfel" => Some("http://127.0.0.1:11434/v1".to_owned()),
        _ => None,
    }
}

fn active_engine_path() -> PathBuf {
    ryu_dir().join("active-engine.json")
}

/// Durable record of the currently selected local engine, persisted to
/// `~/.ryu/active-engine.json`. Mirrors the load/save shape of
/// [`crate::sidecar::download_manager::VersionStore`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ActiveEngineStore {
    /// Name of the selected local engine, or `None` if none has been chosen.
    #[serde(default)]
    pub active: Option<String>,
}

impl ActiveEngineStore {
    /// Load the persisted selection, returning a default (no selection) when the
    /// file is missing or unreadable.
    pub fn load() -> Self {
        let path = active_engine_path();
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Persist `active` as the selected local engine.
    pub fn save_active(active: Option<&str>) -> anyhow::Result<()> {
        let path = active_engine_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let store = Self {
            active: active.map(str::to_string),
        };
        let json = serde_json::to_string_pretty(&store)?;
        std::fs::write(&path, json)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_local_engines_are_recognized() {
        assert!(is_local_engine("llamacpp"));
        assert!(is_local_engine("ollama"));
        assert!(is_local_engine("vllm"));
        assert!(is_local_engine("sglang"));
        assert!(is_local_engine("mlx"));
        assert!(is_local_engine("mlx-vlm"));
        assert!(is_local_engine("omlx"));
        assert!(is_local_engine("docker-model-runner"));
        assert!(is_local_engine("apfel"));
    }

    #[test]
    fn non_engines_are_rejected() {
        // Agents and tools must never be treated as swappable local engines.
        assert!(!is_local_engine("zeroclaw"));
        assert!(!is_local_engine("ghost"));
        assert!(!is_local_engine(""));
    }

    #[test]
    fn local_engines_expose_base_urls() {
        assert_eq!(
            local_engine_base_url("ollama").as_deref(),
            Some("http://127.0.0.1:11434")
        );
        // llamacpp is profile-aware; under the (default) release profile in tests
        // it is the original :8080.
        assert_eq!(
            local_engine_base_url("llamacpp").as_deref(),
            Some("http://127.0.0.1:8080")
        );
        assert_eq!(
            local_engine_base_url("vllm").as_deref(),
            Some("http://127.0.0.1:8000")
        );
        assert_eq!(
            local_engine_base_url("sglang").as_deref(),
            Some("http://127.0.0.1:30000")
        );
        // mlx is profile-aware; under the (default) release profile in tests it is
        // the canonical :8086 (moved off 8082 to free the reranker's port).
        assert_eq!(
            local_engine_base_url("mlx").as_deref(),
            Some("http://127.0.0.1:8086")
        );
        // Non-engines (agents/tools) have no local inference endpoint.
        assert_eq!(local_engine_base_url("zeroclaw"), None);
        assert_eq!(local_engine_base_url(""), None);
    }

    #[test]
    fn every_local_engine_has_a_serving_url() {
        // Each managed local engine must map to a routable OpenAI-compatible URL
        // so the gateway can register it as a provider. A missing entry would
        // silently drop an engine from gateway routing.
        for engine in LOCAL_ENGINES {
            let url = local_engine_url(engine)
                .unwrap_or_else(|| panic!("no serving URL for local engine {engine}"));
            assert!(
                url.starts_with("http://"),
                "{engine} url must be http: {url}"
            );
            assert!(
                url.ends_with("/v1"),
                "{engine} url must end with /v1: {url}"
            );
        }
    }

    #[test]
    fn non_engines_have_no_serving_url() {
        assert!(local_engine_url("zeroclaw").is_none());
        assert!(local_engine_url("ghost").is_none());
        assert!(local_engine_url("").is_none());
    }

    #[test]
    fn store_round_trips_through_json() {
        let json = serde_json::to_string(&ActiveEngineStore {
            active: Some("ollama".into()),
        })
        .unwrap();
        let parsed: ActiveEngineStore = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.active.as_deref(), Some("ollama"));
    }

    #[test]
    fn missing_active_defaults_to_none() {
        let parsed: ActiveEngineStore = serde_json::from_str("{}").unwrap();
        assert!(parsed.active.is_none());
    }
}
