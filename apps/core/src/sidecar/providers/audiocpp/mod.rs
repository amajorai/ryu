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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use ryu_sidecar_runtime::layout::{EngineGroup, Modality};

use crate::sidecar::download_manager::{engine_dir, model_family_dir};
use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Canonical release port for the audio.cpp server. The concrete port also
/// honors Ryu's profile offset so development and release stacks never adopt
/// each other's runtime. 8091 is the first free slot after whisper.cpp (8090);
/// it was 8086, which MLX already binds (see
/// `providers::tests::local_engine_default_ports_are_unique_per_profile`).
pub const AUDIOCPP_PORT_BASE: u16 = 8091;

/// Fixed model id used by the Ryu-generated audio.cpp config for STT.
pub const DEFAULT_STT_MODEL_ID: &str = "ryu-audiocpp-stt";
/// Fixed model id used by the Ryu-generated audio.cpp config for TTS.
pub const DEFAULT_TTS_MODEL_ID: &str = "ryu-audiocpp-tts";
/// The voice exposed by the bundled PocketTTS package.
pub const DEFAULT_TTS_VOICE: &str = "alba";

const DEFAULT_STT_MODEL_FILE: &str = "parakeet-tdt-0.6b-v3-q8_0.gguf";
const DEFAULT_TTS_MODEL_FILE: &str = "pocket-tts-english-q8_0.gguf";
const DEFAULT_TTS_VOICE_FILE: &str = "alba.safetensors";
const RUNTIME_SETTINGS_PREFERENCE: &str = "engine.audiocpp.runtime";

/// User-tunable audio.cpp server settings persisted per node.
#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct AudioCppRuntimeSettings {
    pub backend: Option<String>,
    pub device: Option<u64>,
    pub threads: Option<u64>,
    pub max_loaded_models: Option<u64>,
}

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

/// Operator override for the audio.cpp model root (`RYU_AUDIOCPP_MODEL_DIR`),
/// which keeps its own `stt/` and `tts/` subfolders.
fn model_dir_override() -> Option<PathBuf> {
    std::env::var("RYU_AUDIOCPP_MODEL_DIR")
        .ok()
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

/// Speech-recognition package dir: `models/speech-to-text/audio-cpp`, or
/// `$RYU_AUDIOCPP_MODEL_DIR/stt`. Custom model paths can also be supplied per
/// capability with `RYU_AUDIOCPP_STT_MODEL`, `RYU_AUDIOCPP_TTS_MODEL`, and
/// `RYU_AUDIOCPP_TTS_VOICE_FILE`.
pub fn stt_model_dir() -> PathBuf {
    model_dir_override().map_or_else(
        || model_family_dir(Modality::SpeechToText, "audio-cpp"),
        |dir| dir.join("stt"),
    )
}

/// Speech-synthesis package dir: `models/text-to-speech/audio-cpp`, or
/// `$RYU_AUDIOCPP_MODEL_DIR/tts`.
pub fn tts_model_dir() -> PathBuf {
    model_dir_override().map_or_else(
        || model_family_dir(Modality::TextToSpeech, "audio-cpp"),
        |dir| dir.join("tts"),
    )
}

/// `<data dir>/engines/audio/audiocpp` — the runtime archive (server binary and
/// its shared libraries) plus the generated `server.json`.
pub fn engine_install_dir() -> PathBuf {
    engine_dir(EngineGroup::Audio, "audiocpp")
}

pub fn stt_model_path() -> PathBuf {
    configured_path(
        "RYU_AUDIOCPP_STT_MODEL",
        stt_model_dir().join(DEFAULT_STT_MODEL_FILE),
    )
}

pub fn tts_model_path() -> PathBuf {
    configured_path(
        "RYU_AUDIOCPP_TTS_MODEL",
        tts_model_dir().join(DEFAULT_TTS_MODEL_FILE),
    )
}

pub fn tts_voice_path() -> PathBuf {
    configured_path(
        "RYU_AUDIOCPP_TTS_VOICE_FILE",
        tts_model_dir()
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
    engine_install_dir().join(name)
}

fn binary_dir() -> PathBuf {
    binary_path()
        .parent()
        .map_or_else(engine_install_dir, PathBuf::from)
}

/// The generated server config, kept with the engine it configures.
pub fn config_path() -> PathBuf {
    engine_install_dir().join("server.json")
}

fn backend_name(preference: Option<&str>) -> String {
    let configured = std::env::var("RYU_AUDIOCPP_BACKEND")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "auto");
    let preferred = preference
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| !value.is_empty() && value != "auto");
    if let Some(backend) = configured.or(preferred) {
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

fn nonnegative_setting(env_key: &str, preference: Option<u64>, default: u64) -> u64 {
    std::env::var(env_key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .or(preference)
        .unwrap_or(default)
}

fn positive_setting(env_key: &str, preference: Option<u64>, default: u64) -> u64 {
    std::env::var(env_key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .or(preference.filter(|value| *value > 0))
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
                stt_model_dir(),
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
                tts_model_dir(),
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
    let settings = match crate::server::preferences::PreferencesStore::open_default() {
        Ok(preferences) => match preferences.get(RUNTIME_SETTINGS_PREFERENCE).await {
            Ok(Some(value)) => serde_json::from_str(&value).unwrap_or_default(),
            Ok(None) => AudioCppRuntimeSettings::default(),
            Err(error) => {
                tracing::warn!(%error, "could not read audio.cpp runtime settings");
                AudioCppRuntimeSettings::default()
            }
        },
        Err(error) => {
            tracing::warn!(%error, "could not open preferences for audio.cpp runtime settings");
            AudioCppRuntimeSettings::default()
        }
    };
    let device = nonnegative_setting("RYU_AUDIOCPP_DEVICE", settings.device, 0);
    let threads = positive_setting("RYU_AUDIOCPP_THREADS", settings.threads, 4);
    let max_loaded_models = positive_setting(
        "RYU_AUDIOCPP_MAX_LOADED_MODELS",
        settings.max_loaded_models,
        2,
    );
    let config = json!({
        "host": "127.0.0.1",
        "port": port(),
        "backend": backend_name(settings.backend.as_deref()),
        "device": device,
        "threads": threads,
        "lazy_load": true,
        "log_request_body": false,
        "max_request_body_bytes": 2147483648u64,
        "max_loaded_models": max_loaded_models,
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
            // Saved engine launch settings: native options, then raw args minus
            // the flags Core owns. Only a Ryu-started server receives them.
            let launch = super::engine_launch_config("audiocpp").await;
            let args = launch_args(&config, &launch);
            let env = super::native_env_for_spawn("audiocpp", &launch, &[]);
            let program = binary.to_string_lossy().to_string();
            process
                .start_path_with_env(&program, &args, &env)
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
            if delete_data && model_dir_override().is_none() {
                for dir in [stt_model_dir(), tts_model_dir()] {
                    if dir.exists() {
                        tokio::fs::remove_dir_all(&dir).await.with_context(|| {
                            format!("removing audio.cpp models at {}", dir.display())
                        })?;
                    }
                }
            }
            tracing::info!("audio.cpp uninstalled");
            Ok(())
        })
    }
}

/// Flags Core owns that take a value. audio.cpp lets CLI flags override
/// `server.json`, so a raw `--threads` or `--backend` would silently beat the
/// audio.cpp runtime settings and Core's busy timeout and model specs.
const MANAGED_VALUE_FLAGS: &[&str] = &[
    "--config",
    "--host",
    "--port",
    "--cors-origins",
    "--backend",
    "--device",
    "--threads",
    "--max-loaded-models",
    "--busy-timeout-ms",
    "--model-spec-override",
];
/// Bare flags Core owns: the web UI switches, and help/device listing, which
/// make the binary exit instead of serving.
const MANAGED_BARE_FLAGS: &[&str] = &[
    "--ui",
    "--no-ui",
    "--ui-management",
    "--list-devices",
    "--help",
    "-h",
];

/// `audiocpp_server` arguments: Core's config file and headless mode, then
/// native options, then raw args. audio.cpp reads the first occurrence of a
/// flag, so a native option wins over the same flag in the raw args.
fn launch_args(config: &std::path::Path, launch: &crate::inference::LaunchConfig) -> Vec<String> {
    let mut args = vec![
        "--config".to_string(),
        config.to_string_lossy().to_string(),
        "--no-ui".to_string(),
    ];
    args.extend(crate::inference::native_args("audiocpp", &launch.native));
    args.extend(super::strip_managed_flags(
        &launch.extra_args,
        MANAGED_VALUE_FLAGS,
        MANAGED_BARE_FLAGS,
    ));
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_args_keep_core_flags_first_and_strip_managed_raw_args() {
        let launch = crate::inference::LaunchConfig {
            native: serde_json::json!({ "audiocpp_idle_unload_ms": 60000, "audiocpp_log": true })
                .as_object()
                .cloned()
                .unwrap(),
            extra_args: [
                "--threads",
                "2",
                "--ui",
                "--voice-dir",
                "/voices",
                "--port=1",
            ]
            .map(str::to_owned)
            .to_vec(),
            ..Default::default()
        };
        assert_eq!(
            launch_args(std::path::Path::new("/cfg/server.json"), &launch),
            vec![
                "--config",
                "/cfg/server.json",
                "--no-ui",
                "--idle-unload-ms",
                "60000",
                "--log",
                "--voice-dir",
                "/voices"
            ]
        );
    }

    #[test]
    fn default_layout_splits_models_by_modality_and_keeps_config_with_the_engine() {
        if std::env::var_os("RYU_AUDIOCPP_MODEL_DIR").is_some()
            || std::env::var_os("RYU_AUDIOCPP_BIN").is_some()
        {
            return;
        }
        assert!(stt_model_dir().ends_with("models/speech-to-text/audio-cpp"));
        assert!(tts_model_dir().ends_with("models/text-to-speech/audio-cpp"));
        assert!(config_path().ends_with("engines/audio/audiocpp/server.json"));
        assert!(binary_dir().ends_with("engines/audio/audiocpp"));
    }

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
        assert!(
            stt_model_path().ends_with("speech-to-text/audio-cpp/parakeet-tdt-0.6b-v3-q8_0.gguf")
        );
        assert!(tts_model_path().ends_with("text-to-speech/audio-cpp/pocket-tts-english-q8_0.gguf"));
        assert!(tts_voice_path().ends_with("text-to-speech/audio-cpp/embeddings/alba.safetensors"));
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
