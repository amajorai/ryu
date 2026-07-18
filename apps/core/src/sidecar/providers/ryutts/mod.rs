//! Ryu TTS sidecar — the universal multi-engine text-to-speech runtime.
//!
//! Like whisper.cpp (`whisper-server`) and stable-diffusion.cpp (`sd-server`),
//! this is an **external runtime Core manages**, not part of the mutually-exclusive
//! chat-engine swap. The difference is the runtime is a small Python FastAPI
//! server (`apps/tts-sidecar`) that fronts many TTS engines behind one normalized
//! HTTP contract (`/generate`, `/engines`, `/health`). Adding an engine is a
//! registry row in that app — Core never grows a per-engine branch.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): **Core** — it decides *what runs*
//! (which local TTS engine renders the audio). Consumed by the Core
//! `POST /api/voice/speak?engine=<id>` data path (`server::voice`), which proxies
//! text here and streams back the `audio/wav` the sidecar produces.
//!
//! Lifecycle mirrors [`super::sdcpp::StableDiffusionManager`]: adopt an
//! already-running server on the port (e.g. `bun run dev:tts`) rather than
//! spawning a competing process; otherwise spawn `python -m ryu_tts` from the
//! installed sidecar dir. The heavy per-engine inference deps are the user's to
//! `pip install`; Core surfaces a clear hint when they are missing.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;
use serde_json::Value;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

pub mod kokoro;

/// The default TTS engine id used across every surface when a caller does not
/// specify one. Kokoro 82M — an open-weight (Apache-2.0), CPU-friendly ONNX model
/// served by this sidecar's `kokoro` backend. A swappable default, never a lock:
/// override via `RYU_TTS_ENGINE`. Everything else (voice input STT, OuteTTS, the
/// other sidecar engines) stays reachable via explicit selection.
pub const DEFAULT_TTS_ENGINE: &str = "kokoro";

/// Resolve the default TTS engine id (env-overridable). Callers use this instead of
/// hardcoding an engine so the cross-surface default stays swappable in one place.
pub fn default_tts_engine() -> String {
    std::env::var("RYU_TTS_ENGINE")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_TTS_ENGINE.to_string())
}

/// Loopback port the TTS sidecar binds to. Distinct from llama.cpp (8080),
/// embeddings (8081), mlx (8082), sd (8083), mlx-vlm (8084), and whisper (8090).
pub const TTS_PORT: u16 = 8085;
const TTS_ADDR: &str = "127.0.0.1:8085";

/// Base URL the sidecar serves on once resident.
pub fn tts_base_url() -> String {
    format!("http://{TTS_ADDR}")
}

/// Core-managed Hugging Face cache the sidecar's engines download models into.
/// We point the sidecar's `HF_HOME` here so every model's bytes live under
/// `~/.ryu` (Core-owned) instead of the user's default `~/.cache/huggingface`,
/// and so Core's catalog can detect installed models. Overridable via
/// `RYU_TTS_HF_HOME`.
pub fn hf_home_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_TTS_HF_HOME") {
        return std::path::PathBuf::from(dir);
    }
    crate::paths::ryu_dir().join("models").join("hf")
}

/// Directory holding the `ryu_tts` package. Overridable via `RYU_TTS_DIR`;
/// defaults to the install location `~/.ryu/tts-sidecar`.
pub fn sidecar_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("RYU_TTS_DIR") {
        return std::path::PathBuf::from(dir);
    }
    crate::paths::ryu_dir().join("tts-sidecar")
}

/// Best-effort: ensure the sidecar's Python venv exists with the `kokoro` extra
/// installed, so the default Kokoro engine can actually run.
///
/// Returns `Ok(true)` when the sidecar is provisioned (a venv is present after the
/// call), `Ok(false)` when the sidecar *code* isn't installed yet — there is nothing
/// to provision, and dev instead adopts a `bun run dev:tts` process. Errors surface a
/// real provisioning failure (venv/pip). Idempotent: an existing venv is reused.
///
/// This mirrors the OuteTTS/whisper "download the runtime during onboarding" posture,
/// scoped to the first-party bundled sidecar (so no plugin tier/grant gate applies).
pub async fn ensure_kokoro_runtime() -> anyhow::Result<bool> {
    use crate::sidecar::external_runtime::{self, ExternalRuntimeConfig};

    let dir = sidecar_dir();
    if !dir.exists() {
        return Ok(false);
    }
    if external_runtime::venv_exists(&dir) {
        return Ok(true);
    }

    let cfg = ExternalRuntimeConfig {
        kind: external_runtime::RUNTIME_PYTHON.to_owned(),
        entry: "ryu_tts".to_owned(),
        pyproject_extra: Some("kokoro".to_owned()),
        ..Default::default()
    };
    // The bundled Kokoro sidecar declares no assets, so the DownloadCenter is
    // never exercised for a transfer here; a default client suffices.
    let downloads = crate::downloads::DownloadCenter::with_default_client();
    external_runtime::provision(&cfg, &dir, &downloads)
        .await
        .map(|_| true)
        .map_err(|e| anyhow::anyhow!("provisioning the Kokoro TTS runtime failed: {e}"))
}

/// Resolve the Python interpreter to run the sidecar with. Prefers an explicit
/// `RYU_TTS_PYTHON`, then a venv inside the sidecar dir, then a bare `python3` /
/// `python` on PATH.
fn python_program(dir: &std::path::Path) -> String {
    if let Ok(py) = std::env::var("RYU_TTS_PYTHON") {
        return py;
    }
    let venv = if cfg!(target_os = "windows") {
        dir.join(".venv").join("Scripts").join("python.exe")
    } else {
        dir.join(".venv").join("bin").join("python")
    };
    if venv.exists() {
        return venv.to_string_lossy().to_string();
    }
    if cfg!(target_os = "windows") {
        "python".to_string()
    } else {
        "python3".to_string()
    }
}

/// Lifecycle manager for the Ryu TTS sidecar (Python multi-engine runtime).
pub struct RyuTtsManager {
    process: ProcessHandle,
    /// `true` when a sidecar was already running before we tried to start it
    /// (adopted external, e.g. `bun run dev:tts`). We don't own it, so `stop`
    /// leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl RyuTtsManager {
    pub fn new() -> Self {
        Self {
            process: ProcessHandle::new(),
            adopted_external: Arc::new(AtomicBool::new(false)),
            client: reqwest::Client::builder()
                .user_agent("ryu-core/0.1")
                .timeout(std::time::Duration::from_secs(3))
                .build()
                .expect("reqwest client"),
            downloads: None,
        }
    }

    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    /// Returns `true` if a sidecar is already answering `/health` on the port.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        client
            .get(format!("{}/health", tts_base_url()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

impl Default for RyuTtsManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for RyuTtsManager {
    fn name(&self) -> &'static str {
        "ryutts"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Adopt an already-running sidecar (e.g. `bun run dev:tts`) instead of
            // spawning a competitor that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!("ryu-tts already running on {TTS_ADDR} — adopting existing server");
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let dir = sidecar_dir();
            if !dir.exists() {
                anyhow::bail!(
                    "Ryu TTS sidecar not found at {}. Install it (copy `apps-store/voice/sidecar` there \
                     and `pip install -e \".[kitten]\"`), set RYU_TTS_DIR to its path, or run \
                     `bun run dev:tts` and Core will adopt it.",
                    dir.display()
                );
            }

            let program = python_program(&dir);
            tracing::info!(
                "ryu-tts starting ({} -m ryu_tts, dir={})",
                program,
                dir.display()
            );

            // Point HF model downloads at a Core-managed cache (so bytes live
            // under ~/.ryu and Core can detect installed models). Best-effort dir
            // create — huggingface_hub also creates it on first use.
            let hf_home = hf_home_dir();
            let _ = std::fs::create_dir_all(&hf_home);
            let env: Vec<(String, String)> = vec![
                // Make `ryu_tts` importable without depending on the cwd.
                ("PYTHONPATH".into(), dir.to_string_lossy().to_string()),
                ("RYU_TTS_HOST".into(), "127.0.0.1".into()),
                ("RYU_TTS_PORT".into(), TTS_PORT.to_string()),
                ("HF_HOME".into(), hf_home.to_string_lossy().to_string()),
                // Point the default `kokoro` backend at the model artifacts Core
                // downloads during onboarding (the engine only serves them).
                (
                    "RYU_KOKORO_MODEL".into(),
                    kokoro::model_path().to_string_lossy().to_string(),
                ),
                (
                    "RYU_KOKORO_VOICES".into(),
                    kokoro::voices_path().to_string_lossy().to_string(),
                ),
            ];
            let args: Vec<String> = vec!["-m".into(), "ryu_tts".into()];
            process
                .start_path_with_env(&program, &args, &env)
                .await
                .with_context(|| {
                    format!(
                        "spawning the Ryu TTS sidecar ({program} -m ryu_tts). Is Python installed \
                         and the base deps available? See apps-store/voice/sidecar/README.md."
                    )
                })?;

            // Uvicorn binds quickly, but the first import can take a moment.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(TTS_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            })
            .await
            .context("ryu-tts did not start within 30s")?;

            tracing::info!("ryu-tts started on {TTS_ADDR}");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("ryu-tts was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping ryu-tts process")?;
            tracing::info!("ryu-tts stopped");
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            let owned_running = process.is_running();
            if !owned_running && !adopted_external.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("ryu-tts process not running".into());
            }
            match client
                .get(format!("{}/health", tts_base_url()))
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => HealthStatus::Healthy,
                Ok(r) => HealthStatus::Unhealthy(format!("ryu-tts health returned {}", r.status())),
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when adopted (no owned child). Note: the TTS sidecar is a Python
        // parent that may fork model workers, so this samples the parent only.
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_from_version_store("ryutts");
            if delete_data {
                tracing::info!("ryutts delete_data: leaving the sidecar dir intact");
            }
            tracing::info!("ryutts uninstalled");
            Ok(())
        })
    }
}

/// Fetch the sidecar's engine catalog (`GET /engines`) so Core can mirror it for
/// the desktop picker. Returns the raw JSON array the sidecar serves.
pub async fn list_engines(client: &reqwest::Client) -> anyhow::Result<Value> {
    let url = format!("{}/engines", tts_base_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("ryu-tts not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("ryu-tts /engines returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing /engines JSON")
}

/// Fetch the sidecar's curated, installable TTS model catalog (`GET /models`).
/// Each row is a known-good model variant bound to its engine + cache state.
pub async fn list_models(client: &reqwest::Client) -> anyhow::Result<Value> {
    let url = format!("{}/models", tts_base_url());
    let resp = client
        .get(&url)
        .send()
        .await
        .with_context(|| format!("ryu-tts not reachable at {url}"))?;
    if !resp.status().is_success() {
        anyhow::bail!("ryu-tts /models returned {}", resp.status());
    }
    resp.json::<Value>().await.context("parsing /models JSON")
}

/// Install (download) a curated model via the sidecar's `POST /models/install`,
/// which runs `huggingface_hub.snapshot_download` into the Core-managed HF cache
/// (`HF_HOME`). Returns the sidecar's JSON result. Idempotent (cache hit = fast).
pub async fn install_model(
    client: &reqwest::Client,
    engine: &str,
    model_name: &str,
) -> anyhow::Result<Value> {
    let url = format!("{}/models/install", tts_base_url());
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "engine": engine, "model_name": model_name }))
        .send()
        .await
        .with_context(|| format!("ryu-tts not reachable at {url}"))?;
    let status = resp.status();
    let body = resp
        .json::<Value>()
        .await
        .context("parsing /models/install JSON")?;
    if !status.is_success() {
        let err = body
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        anyhow::bail!("ryu-tts model install failed ({status}): {err}");
    }
    Ok(body)
}
