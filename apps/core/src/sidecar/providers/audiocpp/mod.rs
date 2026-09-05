//! audio.cpp native audio runtime.
//!
//! audio.cpp is kept as a separate, optional process rather than being copied
//! into Ryu's individual voice paths. Its server exposes an OpenAI-shaped HTTP
//! contract, while this manager owns only the lifecycle, config, and model
//! paths. That lets the existing Whisper, Parakeet, OuteTTS, and RyuTTS
//! runtimes remain available and makes `audiocpp` an explicit runtime choice.

pub mod downloader;

pub use downloader::{AudioCppDownloader, TARGET_VERSION};

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Canonical release port for the audio.cpp server. The concrete port also
/// honors Ryu's profile offset so development and release stacks never adopt
/// each other's runtime.
pub const AUDIOCPP_PORT_BASE: u16 = 8086;

/// Fixed model id used by the Ryu-generated audio.cpp config for STT.
pub const DEFAULT_STT_MODEL_ID: &str = "ryu-audiocpp-stt";
/// Fixed model id used by the Ryu-generated audio.cpp config for TTS.
pub const DEFAULT_TTS_MODEL_ID: &str = "ryu-audiocpp-tts";
/// The voice exposed by the bundled PocketTTS package.
pub const DEFAULT_TTS_VOICE: &str = "alba";

const DEFAULT_STT_MODEL_FILE: &str = "parakeet-tdt-0.6b-v3-q8_0.gguf";
const DEFAULT_TTS_MODEL_FILE: &str = "pocket-tts-english-q8_0.gguf";
const DEFAULT_TTS_VOICE_FILE: &str = "alba.safetensors";

/// Profile-aware port used by the manager and every request adapter.
pub fn port() -> u16 {
    std::env::var("RYU_AUDIOCPP_PORT")
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .unwrap_or_else(|| crate::profile::port(AUDIOCPP_PORT_BASE))
}

/// Loopback URL for the managed audio.cpp server.
pub fn base_url() -> String {
    format!("http://127.0.0.1:{}", port())
}

/// Ryu-owned model root. Custom model paths can be supplied per capability
/// with `RYU_AUDIOCPP_STT_MODEL`, `RYU_AUDIOCPP_TTS_MODEL`, and
/// `RYU_AUDIOCPP_TTS_VOICE_FILE`.
pub fn model_dir() -> PathBuf {
    std::env::var("RYU_AUDIOCPP_MODEL_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| crate::paths::ryu_dir().join("models").join("audio-cpp"))
}

pub fn stt_model_path() -> PathBuf {
    configured_path(
        "RYU_AUDIOCPP_STT_MODEL",
        model_dir().join("stt").join(DEFAULT_STT_MODEL_FILE),
    )
}

pub fn tts_model_path() -> PathBuf {
    configured_path(
        "RYU_AUDIOCPP_TTS_MODEL",
        model_dir().join("tts").join(DEFAULT_TTS_MODEL_FILE),
    )
}

pub fn tts_voice_path() -> PathBuf {
    configured_path(
        "RYU_AUDIOCPP_TTS_VOICE_FILE",
        model_dir()
            .join("tts")
            .join("embeddings")
            .join(DEFAULT_TTS_VOICE_FILE),
    )
}

/// The config should point at the package directory for Ryu's default layout,
/// because audio.cpp resolves a single GGUF plus its sidecar files together.
/// For an explicit override, preserve exactly the path the operator supplied.
fn model_config_path(env_key: &str, model_path: &PathBuf, default_dir: PathBuf) -> PathBuf {
    if std::env::var(env_key)
        .ok()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
    {
        model_path.clone()
    } else {
        default_dir
    }
}

fn configured_path(env_key: &str, default: PathBuf) -> PathBuf {
    std::env::var(env_key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default)
}

pub fn stt_model_id() -> String {
    env_or_default("RYU_AUDIOCPP_STT_MODEL_ID", DEFAULT_STT_MODEL_ID)
}

pub fn tts_model_id() -> String {
    env_or_default("RYU_AUDIOCPP_TTS_MODEL_ID", DEFAULT_TTS_MODEL_ID)
}

pub fn default_tts_voice() -> String {
    env_or_default("RYU_AUDIOCPP_TTS_VOICE", DEFAULT_TTS_VOICE)
}

fn env_or_default(key: &str, default: &str) -> String {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default.to_string())
}

pub fn stt_model_present() -> bool {
    stt_model_path().exists()
}

pub fn tts_model_present() -> bool {
    tts_model_path().exists() && tts_voice_path().exists()
}

/// Whether the native runtime and at least one capability package are present.
/// TTS and STT can be installed independently, but the binary is always
/// required before the sidecar can become resident.
pub fn runtime_installed() -> bool {
    binary_path().exists() && (stt_model_present() || tts_model_present())
}

/// Whether the native runtime can serve the TTS picker specifically.
pub fn tts_runtime_installed() -> bool {
    binary_path().exists() && tts_model_present()
}

fn binary_path() -> PathBuf {
    if let Ok(custom) = std::env::var("RYU_AUDIOCPP_BIN") {
        let custom = custom.trim();
        if !custom.is_empty() {
            return PathBuf::from(custom);
        }
    }
    let name = if cfg!(target_os = "windows") {
        "audiocpp_server.exe"
    } else {
        "audiocpp_server"
    };
    crate::paths::ryu_dir()
        .join("bin")
        .join("audiocpp")
        .join(name)
}

fn binary_dir() -> PathBuf {
    binary_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::paths::ryu_dir().join("bin").join("audiocpp"))
}

pub fn config_path() -> PathBuf {
    crate::paths::ryu_dir()
        .join("audio-cpp")
        .join("server.json")
}

fn backend_name() -> String {
    let configured = std::env::var("RYU_AUDIOCPP_BACKEND")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    if let Some(backend) = configured {
        if matches!(backend.as_str(), "cpu" | "cuda" | "vulkan" | "metal") {
            return backend;
        }
        tracing::warn!(backend = %backend, "unknown audio.cpp backend; using the platform default");
    }
    if cfg!(target_os = "macos") {
        "metal".to_string()
    } else {
        "cpu".to_string()
    }
}

fn positive_env_u64(key: &str, default: u64) -> u64 {
    std::env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

fn model_entries() -> Vec<Value> {
    let mut models = Vec::new();
    if stt_model_present() {
        models.push(json!({
            "id": stt_model_id(),
            "family": "parakeet_tdt",
            "path": model_config_path(
                "RYU_AUDIOCPP_STT_MODEL",
                &stt_model_path(),
                model_dir().join("stt"),
            ),
            "task": "asr",
            "mode": "offline",
            "lazy": true,
            "busy_timeout_ms": 120000,
        }));
    }
    if tts_model_present() {
        models.push(json!({
            "id": tts_model_id(),
            "family": "pocket_tts",
            "path": model_config_path(
                "RYU_AUDIOCPP_TTS_MODEL",
                &tts_model_path(),
                model_dir().join("tts"),
            ),
            "task": "tts",
            "mode": "offline",
            "load_options": { "language": "english" },
            "session_options": { "language": "english" },
            "default_request_options": { "speaking_rate": 1.0 },
            "default_voice_preset": { "voice_id": default_tts_voice() },
            "lazy": true,
            "busy_timeout_ms": 120000,
        }));
    }
    models
}

async fn write_config() -> Result<PathBuf> {
    let models = model_entries();
    if models.is_empty() {
        anyhow::bail!(
            "no audio.cpp model is installed. Install the `audiocpp` runtime first, or set a valid RYU_AUDIOCPP_STT_MODEL or RYU_AUDIOCPP_TTS_MODEL path."
        );
    }
    let path = config_path();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .with_context(|| format!("creating audio.cpp config directory {}", parent.display()))?;
    }
    let device = positive_env_u64("RYU_AUDIOCPP_DEVICE", 0);
    let threads = positive_env_u64("RYU_AUDIOCPP_THREADS", 4);
    let config = json!({
        "host": "127.0.0.1",
        "port": port(),
        "backend": backend_name(),
        "device": device,
        "threads": threads,
        "lazy_load": true,
        "log_request_body": false,
        "max_request_body_bytes": 2147483648u64,
        "max_loaded_models": 2,
        "busy_timeout_ms": 120000,
        "ui": false,
        "models": models,
    });
    let bytes = serde_json::to_vec_pretty(&config).context("serializing audio.cpp config")?;
    tokio::fs::write(&path, bytes)
        .await
        .with_context(|| format!("writing audio.cpp config {}", path.display()))?;
    Ok(path)
}

/// Confirm that the dedicated loopback port is the Ryu-configured audio.cpp
/// server. `/health` proves readiness; `/v1/models` proves the protocol and a
/// model id owned by this manager. A generic loopback service that happens to
/// expose a `models` field is therefore not adopted as the runtime.
pub async fn server_reachable(client: &reqwest::Client) -> bool {
    let health = match client.get(format!("{}/health", base_url())).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    if health.json::<Value>().await.is_err() {
        return false;
    }
    let models = match client.get(format!("{}/v1/models", base_url())).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => return false,
    };
    models
        .json::<Value>()
        .await
        .is_ok_and(|body| models_payload_has_ryu_id(&body))
}

fn models_payload_has_ryu_id(body: &Value) -> bool {
    let expected = [stt_model_id(), tts_model_id()];
    body.get("data")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| expected.iter().any(|candidate| candidate == id))
            })
        })
}

/// Curated TTS engine row used by Core's engine picker even before the native
/// runtime is installed. This keeps the alternate visible and lets the UI
/// distinguish an unavailable engine from a missing catalog entry.
pub fn tts_engine_row(installed: bool, loaded: bool) -> Value {
    json!({
        "id": "audiocpp",
        "display_name": "audio.cpp",
        "description": "Native ggml audio runtime · PocketTTS with Parakeet STT · loopback managed",
        "voices": [default_tts_voice()],
        "default_voice": default_tts_voice(),
        "sample_rate": 24000,
        "supports_cloning": true,
        "languages": ["en", "de", "it", "pt", "es"],
        "size_mb": 1030,
        "installed": installed,
        "loaded": loaded,
    })
}

/// Curated model row consumed by the existing TTS model installer UI. The
/// install operation provisions the complete audio.cpp runtime because the
/// server can host both the TTS and STT model in one process.
pub fn tts_model_row() -> Value {
    json!({
        "default": true,
        "engine": "audiocpp",
        "model_name": "pocket_tts_english_q8_0",
        "display_name": "PocketTTS English Q8_0 (audio.cpp)",
        "engine_display_name": "audio.cpp",
        "description": "CPU-friendly PocketTTS package with the Alba voice; installing it also provisions the audio.cpp runtime.",
        "hf_repo_id": "audio-cpp/audio.cpp-gguf",
        "languages": ["en", "de", "it", "pt", "es"],
        "size_mb": 1040,
        "installed": tts_model_present(),
    })
}

/// Lifecycle manager for the optional audio.cpp server.
pub struct AudioCppManager {
    process: ProcessHandle,
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
}

impl AudioCppManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client"),
        }
    }
}

impl Default for AudioCppManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for AudioCppManager {
    fn name(&self) -> &'static str {
        "audiocpp"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            if process.is_running() {
                return Ok(());
            }
            if server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    port = port(),
                    "audio.cpp server already running — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let binary = binary_path();
            if !binary.exists() {
                anyhow::bail!(
                    "audio.cpp server binary not found at {}. Install the `audiocpp` runtime from the Store, or set RYU_AUDIOCPP_BIN to an existing audiocpp_server binary.",
                    binary.display()
                );
            }

            let config = write_config().await?;
            let args = vec![
                "--config".to_string(),
                config.to_string_lossy().to_string(),
                "--no-ui".to_string(),
            ];
            let program = binary.to_string_lossy().to_string();
            process
                .start_path_with_args(&program, &args)
                .await
                .context("spawning audiocpp_server")?;

            let readiness = tokio::time::timeout(std::time::Duration::from_secs(120), async {
                loop {
                    if server_reachable(&client).await {
                        return Ok::<(), anyhow::Error>(());
                    }
                    if process.has_exited() {
                        anyhow::bail!(
                            "audiocpp_server exited before its health endpoint became ready"
                        );
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            })
            .await;
            match readiness {
                Ok(result) => result?,
                Err(_) => {
                    let _ = process.stop().await;
                    anyhow::bail!("audiocpp_server did not become ready within 120s");
                }
            }
            tracing::info!(port = port(), "audiocpp_server started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("audio.cpp was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping audiocpp_server")?;
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            if !process.is_running() && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("audio.cpp process not running".into());
            }
            if server_reachable(&client).await {
                HealthStatus::Healthy
            } else {
                HealthStatus::Unhealthy("audio.cpp health endpoint is not reachable".into())
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn has_exited(&self) -> bool {
        self.process.has_exited()
    }

    fn pid(&self) -> Option<u32> {
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            if std::env::var("RYU_AUDIOCPP_BIN").is_err() {
                let dir = binary_dir();
                if dir.exists() {
                    tokio::fs::remove_dir_all(&dir).await.with_context(|| {
                        format!("removing audio.cpp binaries at {}", dir.display())
                    })?;
                }
            }
            crate::sidecar::remove_from_version_store("audiocpp");
            let config = config_path();
            let _ = tokio::fs::remove_file(&config).await;
            if delete_data && std::env::var("RYU_AUDIOCPP_MODEL_DIR").is_err() {
                let dir = model_dir();
                if dir.exists() {
                    tokio::fs::remove_dir_all(&dir).await.with_context(|| {
                        format!("removing audio.cpp models at {}", dir.display())
                    })?;
                }
            }
            tracing::info!("audio.cpp uninstalled");
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_expose_the_alternate_runtime_and_curated_model() {
        let engine = tts_engine_row(false, false);
        assert_eq!(engine["id"], "audiocpp");
        assert_eq!(engine["default_voice"], DEFAULT_TTS_VOICE);

        let model = tts_model_row();
        assert_eq!(model["engine"], "audiocpp");
        assert_eq!(model["model_name"], "pocket_tts_english_q8_0");
    }

    #[test]
    fn default_runtime_paths_are_capability_specific() {
        assert!(stt_model_path().ends_with("stt/parakeet-tdt-0.6b-v3-q8_0.gguf"));
        assert!(tts_model_path().ends_with("tts/pocket-tts-english-q8_0.gguf"));
        assert!(tts_voice_path().ends_with("tts/embeddings/alba.safetensors"));
    }

    #[test]
    fn adoption_requires_a_configured_ryu_model_id() {
        assert!(models_payload_has_ryu_id(&serde_json::json!({
            "data": [{ "id": DEFAULT_STT_MODEL_ID }]
        })));
        assert!(!models_payload_has_ryu_id(&serde_json::json!({
            "data": [{ "id": "unrelated-local-service" }]
        })));
        assert!(!models_payload_has_ryu_id(&serde_json::json!({
            "models": 2
        })));
    }
}
