//! Local reranker server — a dedicated llama.cpp `--reranking` instance.
//!
//! Mirrors the embeddings sidecar (`embed.rs`) but serves the bge cross-encoder
//! GGUF on port 8082, exposing llama-server's `/rerank` endpoint (whose
//! `{results:[{index, relevance_score}]}` shape matches what
//! `server::retrieval::remote_rerank` already parses). Spaces RAG points here for
//! neural reranking of top-K candidates.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): deciding *which* model reranks is
//! "what runs" → Core. The model + URL are swappable registry defaults
//! (`local_reranker_model`), never hardcoded.
//!
//! Unlike the embeddings server, this sidecar is **off by default** — it is NOT
//! in `startup_order`, so it consumes no memory until something needs it. The
//! Spaces search path lazily starts it on first use (`SidecarManager::
//! start_sidecar("llamacpp-rerank")`) and reranking fails open (returns the
//! vector order) whenever the server is not yet reachable.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::providers::llamacpp::{
    process::{LlamaCppProcess, LlamaCppStartOptions},
    LlamaCppDownloader,
};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Loopback port the reranker server binds to. Distinct from the chat engine's
/// 8080 and the embeddings server's 8081 so all three can run together.
pub const RERANK_PORT: u16 = 8082;
const RERANK_ADDR: &str = "127.0.0.1:8082";

/// Lifecycle manager for the dedicated llama.cpp reranking sidecar.
pub struct LlamaCppRerankManager {
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<LlamaCppProcess>>>,
    /// `true` when a reranker server was already running before we tried to
    /// start it (adopted external). We don't own it, so `stop` leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    /// Global download center (#456), injected at construction in `main.rs`.
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl LlamaCppRerankManager {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            process: Arc::new(Mutex::new(None)),
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
            "llama-server.exe"
        } else {
            "llama-server"
        };
        crate::paths::ryu_dir().join("bin").join(name)
    }

    /// `true` if a reranker server already answers on the port.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        client
            .get(format!("http://{RERANK_ADDR}/health"))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

impl Default for LlamaCppRerankManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppRerankManager {
    fn name(&self) -> &'static str {
        "llamacpp-rerank"
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        let client = self.client.clone();
        let downloads = self.downloads.clone();
        Box::pin(async move {
            // Adopt an already-running reranker server rather than spawning a
            // competing process that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                running.store(true, Ordering::Relaxed);
                tracing::info!(
                    "reranker server already running on {RERANK_ADDR} — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            // Ensure the llama.cpp binary is installed (shared with the chat engine).
            let downloads =
                downloads.expect("llamacpp-rerank manager: download center not wired (main.rs)");
            LlamaCppDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing llama.cpp for reranker server")?;

            // Serve the reranker GGUF downloaded by onboarding. Like the embeddings
            // server, this engine does NOT download the model itself — onboarding
            // (`install_local_stack`) is the single owner of model downloads.
            let registry = crate::registry::ModelRegistry::from_env();
            let model_path = registry.local_reranker_model.weight_path();
            if !model_path.exists() {
                anyhow::bail!(
                    "reranker model not found at {} — onboarding may still be downloading it, \
                     or the download failed. The reranker server will start once the model is \
                     present (it is fetched by default during onboarding).",
                    model_path.display()
                );
            }
            tracing::info!("reranker server will serve model: {}", model_path.display());

            tracing::info!("llamacpp-rerank sidecar starting on {RERANK_ADDR}");
            let mut proc = LlamaCppProcess::new(Self::binary_path());
            let opts = LlamaCppStartOptions {
                port: RERANK_PORT,
                model_path: Some(model_path),
                // The reranker model is text-only — no vision adapter.
                mmproj_path: None,
                // bge-reranker-v2-m3 supports 8192-token inputs; match ctx + batch
                // knobs so long (query, document) pairs aren't truncated/rejected.
                ctx_size: 8192,
                embeddings: false,
                reranking: true,
                launch: crate::inference::LaunchConfig {
                    batch_size: Some(8192),
                    ubatch_size: Some(8192),
                    ..Default::default()
                },
            };
            proc.start_with(opts)
                .await
                .context("spawning llama-server (reranking)")?;
            *process.lock().unwrap() = Some(proc);

            // Wait for the HTTP port to accept connections (model load takes a few
            // seconds even for the ~438 MB reranker GGUF).
            tokio::time::timeout(std::time::Duration::from_secs(120), async {
                loop {
                    if tokio::net::TcpStream::connect(RERANK_ADDR).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("llamacpp-rerank did not start within 120s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("llamacpp-rerank sidecar started on {RERANK_ADDR}");
            Ok(())
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        let process = Arc::clone(&self.process);
        let running = Arc::clone(&self.running);
        let adopted_external = Arc::clone(&self.adopted_external);
        Box::pin(async move {
            running.store(false, Ordering::Relaxed);
            if adopted_external.swap(false, Ordering::Relaxed) {
                tracing::info!("reranker server was adopted external — leaving it running");
                return Ok(());
            }
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("llamacpp-rerank stop error: {e}");
                }
            }
            Ok(())
        })
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        let running = Arc::clone(&self.running);
        let client = self.client.clone();
        Box::pin(async move {
            if !running.load(Ordering::Relaxed) {
                return HealthStatus::Unhealthy("reranker process not running".into());
            }
            match client
                .get(format!("http://{RERANK_ADDR}/health"))
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => HealthStatus::Healthy,
                Ok(resp) => {
                    HealthStatus::Unhealthy(format!("health endpoint returned {}", resp.status()))
                }
                Err(e) => HealthStatus::Unhealthy(format!("health check failed: {e}")),
            }
        })
    }

    fn is_running(&self) -> bool {
        if self.adopted_external.load(Ordering::Relaxed) {
            return true;
        }
        let mut guard = self.process.lock().unwrap();
        guard.as_mut().map(|p| p.is_running()).unwrap_or(false)
    }

    fn pid(&self) -> Option<u32> {
        // `None` when we adopted an external reranker server we don't own.
        self.process.lock().unwrap().as_ref().and_then(|p| p.pid())
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // The binary is shared with the chat engine — do NOT remove it here.
            // Only drop the version-store marker for this sidecar. The reranker
            // GGUF under ~/.ryu/models is left intact.
            crate::sidecar::remove_from_version_store("llamacpp-rerank");
            tracing::info!("llamacpp-rerank uninstalled (shared binary + models left intact)");
            Ok(())
        })
    }
}
