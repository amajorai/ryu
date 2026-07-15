//! Local embeddings server — a dedicated llama.cpp `--embeddings` instance.
//!
//! Unlike the chat `LlamaCppManager` (port 8080, mutually-exclusive resident
//! chat engine), this runs a **second** llama-server on port 8081 serving the
//! nomic embedding GGUF, exposing an OpenAI-compatible `/v1/embeddings` endpoint.
//! It runs *alongside* the chat engine so RAG (Spaces + retrieval) gets real
//! semantic embeddings on install with zero setup — `Embedder::from_registry`
//! defaults its base URL here.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): deciding *which* model serves
//! embeddings is "what runs" → Core. The model + URL are swappable registry
//! defaults (`local_embed_model`), never hardcoded.
//!
//! Lifecycle mirrors the chat engine: ensure the llama.cpp binary + nomic GGUF
//! are present, then spawn `llama-server --embeddings`. If something is already
//! answering on the port we adopt it rather than fighting for the bind.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::Context;

use crate::sidecar::providers::llamacpp::{
    process::{LlamaCppProcess, LlamaCppStartOptions},
    LlamaCppDownloader,
};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Canonical (release) loopback port the embeddings server binds to. Distinct
/// from the chat engine's 8080 so both run together. The concrete port is
/// profile-aware — see [`embed_port`].
pub const EMBED_PORT_BASE: u16 = 8081;

/// Profile-aware embeddings port (release 8081, dev 9081, …). The RAG client that
/// dials this resolves the SAME port via the `RYU_EMBED_BASE_URL` env default that
/// `profile::apply_env_defaults` seeds, so spawn and client never diverge.
pub fn embed_port() -> u16 {
    crate::profile::port(EMBED_PORT_BASE)
}

/// Loopback `host:port` the embeddings server binds to (profile-aware).
fn embed_addr() -> String {
    format!("127.0.0.1:{}", embed_port())
}

/// Lifecycle manager for the dedicated llama.cpp embeddings sidecar.
pub struct LlamaCppEmbedManager {
    running: Arc<AtomicBool>,
    process: Arc<Mutex<Option<LlamaCppProcess>>>,
    /// `true` when an embeddings server was already running before we tried to
    /// start it (adopted external). We don't own it, so `stop` leaves it alone.
    adopted_external: Arc<AtomicBool>,
    client: reqwest::Client,
    /// Global download center (#456), injected at construction in `main.rs`.
    downloads: Option<crate::downloads::DownloadCenter>,
}

impl LlamaCppEmbedManager {
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

    /// `true` if an embeddings server already answers on the port.
    async fn server_reachable(client: &reqwest::Client) -> bool {
        client
            .get(format!("http://{}/health", embed_addr()))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }
}

impl Default for LlamaCppEmbedManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppEmbedManager {
    fn name(&self) -> &'static str {
        "llamacpp-embed"
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
            let addr = embed_addr();
            // Adopt an already-running embeddings server (e.g. user-managed) rather
            // than spawning a competing process that would fail to bind the port.
            if Self::server_reachable(&client).await {
                adopted_external.store(true, Ordering::Relaxed);
                running.store(true, Ordering::Relaxed);
                tracing::info!(
                    "embeddings server already running on {addr} — adopting existing server"
                );
                return Ok(());
            }
            adopted_external.store(false, Ordering::Relaxed);

            // Ensure the llama.cpp binary is installed (shared with the chat engine).
            let downloads =
                downloads.expect("llamacpp-embed manager: download center not wired (main.rs)");
            LlamaCppDownloader::new()
                .ensure_installed(&downloads)
                .await
                .context("installing llama.cpp for embeddings server")?;

            // Serve the embedding GGUF downloaded by onboarding. This engine does
            // NOT download the model itself — onboarding (`install_local_stack`)
            // is the single owner of model downloads (mirrors the chat engine,
            // which also resolves a pre-downloaded weight). That avoids a
            // concurrent double-download race against onboarding on first boot.
            let registry = crate::registry::ModelRegistry::from_env();
            let model_path = registry.local_embed_model.weight_path();
            if !model_path.exists() {
                anyhow::bail!(
                    "embedding model not found at {} — onboarding may still be downloading it, \
                     or the download failed. The embeddings server will start once the model is \
                     present (it is fetched by default during onboarding).",
                    model_path.display()
                );
            }
            tracing::info!(
                "embeddings server will serve model: {}",
                model_path.display()
            );

            tracing::info!("llamacpp-embed sidecar starting on {addr}");
            let mut proc = LlamaCppProcess::new(Self::binary_path());
            let opts = LlamaCppStartOptions {
                port: embed_port(),
                model_path: Some(model_path),
                // The embedding model is text-only — no vision adapter.
                mmproj_path: None,
                // nomic-embed-text supports 8192-token inputs; set ctx + both
                // batch knobs to match so long messages don't get HTTP 500
                // "input too large" from the default 512-token physical batch.
                ctx_size: 8192,
                embeddings: true,
                reranking: false,
                launch: crate::inference::LaunchConfig {
                    batch_size: Some(8192),
                    ubatch_size: Some(8192),
                    ..Default::default()
                },
            };
            proc.start_with(opts)
                .await
                .context("spawning llama-server (embeddings)")?;
            *process.lock().unwrap() = Some(proc);

            // Wait for the HTTP port to accept connections (model load can take
            // a few seconds even for the small nomic GGUF).
            tokio::time::timeout(std::time::Duration::from_secs(120), async {
                loop {
                    if tokio::net::TcpStream::connect(&addr).await.is_ok() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            })
            .await
            .context("llamacpp-embed did not start within 120s")?;

            running.store(true, Ordering::Relaxed);
            tracing::info!("llamacpp-embed sidecar started on {addr}");
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
                tracing::info!("embeddings server was adopted external — leaving it running");
                return Ok(());
            }
            let proc = process.lock().unwrap().take();
            if let Some(mut p) = proc {
                if let Err(e) = p.stop().await {
                    tracing::warn!("llamacpp-embed stop error: {e}");
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
                return HealthStatus::Unhealthy("embeddings process not running".into());
            }
            match client
                .get(format!("http://{}/health", embed_addr()))
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
        // `None` when we adopted an external embeddings server we don't own.
        self.process.lock().unwrap().as_ref().and_then(|p| p.pid())
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // The binary is shared with the chat engine — do NOT remove it here.
            // Only drop the version-store marker for this sidecar. The embedding
            // GGUF lives under ~/.ryu/models and is left intact (chat GGUFs share
            // the directory; per-file deletion is out of scope).
            crate::sidecar::remove_from_version_store("llamacpp-embed");
            tracing::info!("llamacpp-embed uninstalled (shared binary + models left intact)");
            Ok(())
        })
    }
}
