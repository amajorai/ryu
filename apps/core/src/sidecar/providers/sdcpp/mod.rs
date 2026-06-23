//! stable-diffusion.cpp media engine (text-to-image, and text/image-to-video).
//!
//! Like the voice engines (whisper.cpp / parakeet), a generative-media engine is
//! **not** part of the mutually-exclusive `LOCAL_ENGINES` chat-engine swap — you
//! run sd-server *alongside* a resident chat engine. It is therefore managed as
//! an ordinary opt-in sidecar (install / start / stop) and consumed by the Core
//! `POST /api/images/generate` and `POST /api/video/generate` data paths
//! (`server::media`), which proxy requests to this server's OpenAI-compatible
//! `/v1/images/generations` and native `/sdcpp/v1/vid_gen` endpoints.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): this is **Core** — it decides *what
//! runs* (which local media engine renders the pixels). Per-attribute Gateway
//! routing of image/video slots is a separate, future enhancement.
//!
//! Lifecycle mirrors [`super::whispercpp::WhisperCppManager`]: adopt an
//! already-running server on the port rather than spawning a competing process;
//! otherwise spawn `sd-server` from `~/.ryu/bin` with a diffusion model resolved
//! from `RYU_SD_MODEL` (or the bundled default).

pub mod downloader;

pub use downloader::{default_model_path, StableDiffusionDownloader};

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Loopback port the sd-server media engine binds to. Distinct from llama.cpp
/// (8080), the embeddings server (8081), and whisper (8090) so they coexist.
pub const SD_PORT: u16 = 8083;
const SD_ADDR: &str = "127.0.0.1:8083";

/// Base URL the media engine serves on once resident. The data paths post to
/// `{base}/v1/images/generations` (image) and `{base}/sdcpp/v1/vid_gen` (video).
pub fn sd_base_url() -> String {
    format!("http://{SD_ADDR}")
}

fn resolved_model_path() -> std::path::PathBuf {
    std::env::var("RYU_SD_MODEL")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| default_model_path())
}

/// Lifecycle manager for the stable-diffusion.cpp media sidecar.
pub struct StableDiffusionManager {
    process: ProcessHandle,
    /// `true` when an sd-server was already running before we tried to start it
    /// (adopted external). We don't own it, so `stop` leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    /// Global download center (#456); wired by main.rs via [`with_downloads`].
    /// The actual install runs through the engine-install route
    /// (`server::mod`), which passes its own center; this field keeps the
    /// manager uniform with the field-injection fan-out.
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl StableDiffusionManager {
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

    fn binary_path() -> std::path::PathBuf {
        let name = if cfg!(target_os = "windows") {
            "sd-server.exe"
        } else {
            "sd-server"
        };
        crate::paths::ryu_dir().join("bin").join(name)
    }

    /// Returns `true` if an sd-server is already answering on its port. Any HTTP
    /// response (even a 404 to `/`) means a server is bound and reachable.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        client.get(sd_base_url()).send().await.is_ok()
    }
}

impl Default for StableDiffusionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for StableDiffusionManager {
    fn name(&self) -> &'static str {
        "sdcpp"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        Box::pin(async move {
            // Adopt an already-running sd-server rather than spawning a competing
            // process that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!("sd-server already running on {SD_ADDR} — adopting existing server");
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            let binary_path = Self::binary_path();
            if !binary_path.exists() {
                anyhow::bail!(
                    "sd-server binary not found at {}. Install the stable-diffusion.cpp \
                     media engine from the Store, or place an `sd-server` binary in \
                     ~/.ryu/bin.",
                    binary_path.display()
                );
            }

            let model = resolved_model_path();
            if !model.exists() {
                anyhow::bail!(
                    "stable diffusion model not found at {}. Install the media engine from \
                     the Store (it bundles a default model), download a diffusion GGUF into \
                     ~/.ryu/models, or set RYU_SD_MODEL to a model path.",
                    model.display()
                );
            }

            tracing::info!("sd-server starting ({})", binary_path.display());

            let args: Vec<String> = vec![
                "-m".into(),
                model.to_string_lossy().to_string(),
                "--listen-ip".into(),
                "127.0.0.1".into(),
                "--listen-port".into(),
                SD_PORT.to_string(),
            ];
            let program = binary_path.to_string_lossy().to_string();
            process
                .start_path_with_args(&program, &args)
                .await
                .context("spawning sd-server process")?;

            // Diffusion weights take a while to load; allow generous startup time.
            tokio::time::timeout(std::time::Duration::from_secs(120), async {
                loop {
                    if tokio::net::TcpStream::connect(SD_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            })
            .await
            .context("sd-server did not start within 120s")?;

            tracing::info!("sd-server started on {SD_ADDR}");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("sd-server was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping sd-server process")?;
            tracing::info!("sd-server stopped");
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
                return HealthStatus::Unhealthy("sd-server process not running".into());
            }
            match client.get(sd_base_url()).send().await {
                Ok(_) => HealthStatus::Healthy,
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when we adopted an external sd-server we don't own.
        self.process.pid()
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("sd-server").await;
            crate::sidecar::remove_ryu_binary("sd-cli").await;
            crate::sidecar::remove_from_version_store("sdcpp");

            if delete_data {
                tracing::info!("sdcpp delete_data: leaving ~/.ryu/models intact");
            }

            tracing::info!("sdcpp uninstalled");
            Ok(())
        })
    }
}
