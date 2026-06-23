pub mod downloader;
pub use downloader::OllamaDownloader;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::Context;

use crate::sidecar::{BoxFuture, HealthStatus, ProcessHandle, Sidecar};

/// Default host:port that `ollama serve` binds to.
const OLLAMA_ADDR: &str = "127.0.0.1:11434";
const OLLAMA_HEALTH_URL: &str = "http://127.0.0.1:11434/api/version";

/// Lifecycle manager for the ollama sidecar process.
///
/// `ollama serve` launches an HTTP server on `127.0.0.1:11434`. The binary is
/// downloaded by [`OllamaDownloader`]; this manager owns the running process via
/// the shared [`ProcessHandle`] and probes `/api/version` for health.
pub struct OllamaManager {
    process: ProcessHandle,
    /// `true` when ollama was already running before we tried to start it (e.g.
    /// a system-installed background service). We don't own that process, so
    /// `stop` is a no-op for it, but health still reports green.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl OllamaManager {
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
            "ollama.exe"
        } else {
            "ollama"
        };
        crate::paths::ryu_dir().join("bin").join(name)
    }

    /// Returns `true` if an ollama server is already answering on its port.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        matches!(
            client.get(OLLAMA_HEALTH_URL).send().await,
            Ok(resp) if resp.status().is_success()
        )
    }
}

impl Default for OllamaManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for OllamaManager {
    fn name(&self) -> &'static str {
        "ollama"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // If a server is already up (e.g. a system ollama service), adopt it
            // rather than spawning a competing process that would fail to bind.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                tracing::info!(
                    "ollama already running on {OLLAMA_ADDR} — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            // Download the binary if it isn't installed yet.
            let downloads = downloads.expect("ollama manager: download center not wired (main.rs)");
            OllamaDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing ollama")?;

            let binary_path = Self::binary_path();
            tracing::info!("ollama sidecar starting ({})", binary_path.display());

            // `ollama serve` starts the HTTP server; the bare binary just prints help.
            process
                .start_with_args(&binary_path, &["serve"])
                .await
                .context("spawning ollama serve process")?;

            // Wait for the HTTP port to accept connections.
            tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if tokio::net::TcpStream::connect(OLLAMA_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("ollama did not start within 30s")?;

            // Advanced inference (#mtp-advanced-inference): Ollama's daemon serves
            // many models and takes no per-model launch CLI flags, and its
            // OpenAI-compat endpoint accepts no `options` passthrough. Launch +
            // non-standard sampling knobs therefore have to be baked into a
            // Modelfile (`ollama create` with PARAMETER directives) per model.
            // That derived-model generation is not wired yet; surface what would
            // be applied so the config is never a silent no-op.
            if let Ok(prefs) = crate::server::preferences::PreferencesStore::open_default() {
                let cfg = prefs.resolve_launch_config("", "ollama").await;
                let params = cfg.to_ollama_modelfile();
                if !params.is_empty() {
                    tracing::warn!(
                        "ollama launch config present ({params:?}) but Ollama tuning requires a \
                         Modelfile (`ollama create` PARAMETER ...); derived-model generation is \
                         not yet implemented, so these are NOT applied. Set them in a Modelfile \
                         for now (tracked as a follow-up)."
                    );
                }
            }

            tracing::info!("ollama sidecar started");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = self.process.clone();
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            // We never spawned the adopted external server, so we must not kill it.
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("ollama was an adopted external server — leaving it running");
                return Ok(());
            }
            process.stop().await.context("stopping ollama process")?;
            tracing::info!("ollama sidecar stopped");
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
                return HealthStatus::Unhealthy("process not running".into());
            }

            match client.get(OLLAMA_HEALTH_URL).send().await {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        self.process.is_running() || self.adopted_external.load(Ordering::Relaxed)
    }

    fn uninstall(&self, delete_data: bool) -> crate::sidecar::BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            crate::sidecar::remove_ryu_binary("ollama").await;
            crate::sidecar::remove_from_version_store("ollama");

            if delete_data {
                // Ollama stores models and config in ~/.ollama on all platforms
                // (Linux, macOS, and Windows %HOMEPATH%\.ollama).
                if let Some(home) = dirs::home_dir() {
                    crate::sidecar::remove_dir(&home.join(".ollama")).await;
                }
            }

            tracing::info!("ollama uninstalled");
            Ok(())
        })
    }
}
