//! whisper.cpp voice engine (speech-to-text).
//!
//! Unlike the chat providers (llama.cpp / Ollama / vLLM / SGLang), a voice engine
//! is **not** part of the mutually-exclusive `LOCAL_ENGINES` swap — you run
//! whisper *alongside* a resident chat engine. It is therefore managed as an
//! ordinary opt-in sidecar (install / start / stop), and consumed by the Core
//! `POST /api/voice/transcribe` data path (`server::voice`), which proxies audio
//! to this server's `/inference` endpoint (whisper.cpp's multipart STT API).
//!
//! Lifecycle, mirroring [`super::ollama::OllamaManager`]: if a whisper server is
//! already answering on the port we **adopt** it (never killing a process we did
//! not spawn); otherwise we spawn `whisper-server` from `~/.ryu/bin` with a GGML
//! model resolved from `RYU_WHISPER_MODEL` (or the default model path).

pub mod downloader;

pub use downloader::WhisperCppDownloader;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Loopback port the whisper voice server binds to. Deliberately distinct from
/// llama.cpp's 8080 so a chat engine and the voice engine can run together.
pub const WHISPER_PORT: u16 = 8090;
const WHISPER_ADDR: &str = "127.0.0.1:8090";

/// Base URL the whisper server serves on once resident. The transcribe data
/// path posts audio to `{base}/inference` (whisper.cpp's multipart STT API).
pub fn whisper_base_url() -> String {
    format!("http://{WHISPER_ADDR}")
}

/// Default GGML model file whisper loads when `RYU_WHISPER_MODEL` is unset. A
/// small English base model is a sensible default, not a lock: point
/// `RYU_WHISPER_MODEL` at any whisper GGML model to override.
fn default_model_path() -> std::path::PathBuf {
    crate::paths::ryu_dir()
        .join("models")
        .join("ggml-base.en.bin")
}

fn resolved_model_path() -> std::path::PathBuf {
    std::env::var("RYU_WHISPER_MODEL")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| default_model_path())
}

/// Lifecycle manager for the whisper.cpp voice (STT) sidecar.
pub struct WhisperCppManager {
    process: ProcessHandle,
    /// `true` when a whisper server was already running before we tried to start
    /// it (adopted external). We don't own it, so `stop` leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    /// Global download center (#456), injected at construction in `main.rs`.
    /// Routes the binary + model install through the center so they show in the
    /// overlay. (`DownloadCenter` is itself a cheap `Arc` wrapper.)
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl WhisperCppManager {
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

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.downloads = Some(downloads);
        self
    }

    fn binary_path() -> std::path::PathBuf {
        let name = if cfg!(target_os = "windows") {
            "whisper-server.exe"
        } else {
            "whisper-server"
        };
        crate::paths::ryu_dir().join("bin").join(name)
    }

    /// Returns `true` if a whisper server is already answering on its port. Any
    /// HTTP response (even a 404 to `/`) means a server is bound and reachable.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        client.get(whisper_base_url()).send().await.is_ok()
    }
}

impl Default for WhisperCppManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for WhisperCppManager {
    fn name(&self) -> &'static str {
        "whispercpp"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Adopt an already-running whisper server rather than spawning a
            // competing process that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    "whisper server already running on {WHISPER_ADDR} — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let binary_path = Self::binary_path();
            if !binary_path.exists() {
                anyhow::bail!(
                    "whisper-server binary not found at {}. Install the whisper.cpp \
                     voice engine from the Store, or place a `whisper-server` binary \
                     in ~/.ryu/bin.",
                    binary_path.display()
                );
            }

            let model = resolved_model_path();
            if !model.exists() {
                anyhow::bail!(
                    "whisper GGML model not found at {}. Download a model (e.g. \
                     ggml-base.en.bin) into ~/.ryu/models, or set RYU_WHISPER_MODEL \
                     to a model path.",
                    model.display()
                );
            }

            tracing::info!("whisper-server starting ({})", binary_path.display());

            let args: Vec<String> = vec![
                "--host".into(),
                "127.0.0.1".into(),
                "--port".into(),
                WHISPER_PORT.to_string(),
                "-m".into(),
                model.to_string_lossy().to_string(),
            ];
            let program = binary_path.to_string_lossy().to_string();
            process
                .start_path_with_args(&program, &args)
                .await
                .context("spawning whisper-server process")?;

            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(WHISPER_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("whisper-server did not start within 30s")?;

            tracing::info!("whisper-server started on {WHISPER_ADDR}");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("whisper was an adopted external server — leaving it running");
                return Ok(());
            }
            process
                .stop()
                .await
                .context("stopping whisper-server process")?;
            tracing::info!("whisper-server stopped");
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
                return HealthStatus::Unhealthy("whisper process not running".into());
            }
            match client.get(whisper_base_url()).send().await {
                Ok(_) => HealthStatus::Healthy,
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when we adopted an external whisper server we don't own.
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("whisper-server").await;
            crate::sidecar::remove_from_version_store("whispercpp");

            if delete_data {
                // GGML voice models live under ~/.ryu/models; leave other models
                // (chat GGUFs) untouched by removing only whisper `ggml-*` files
                // is out of scope — data deletion here is best-effort no-op.
                tracing::info!("whispercpp delete_data: leaving ~/.ryu/models intact");
            }

            tracing::info!("whispercpp uninstalled");
            Ok(())
        })
    }
}
