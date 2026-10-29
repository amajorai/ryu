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

use crate::sidecar::providers::llamacpp::process::LlamaCppStartOptions;
use crate::sidecar::providers::llamacpp::satellite::{Satellite, SatelliteTier};
use crate::sidecar::{BoxFuture, HealthStatus, Sidecar};

/// Canonical (release) loopback port the reranker server binds to. Distinct from
/// the chat engine's 8080 and the embeddings server's 8081 so all three can run
/// together. The concrete port is profile-aware — see [`rerank_port`].
pub const RERANK_PORT_BASE: u16 = 8082;

/// Profile-aware reranker port (release 8082, dev 9082, …). The RAG client that
/// dials this resolves the SAME port via the `RYU_RERANKER_BASE_URL` env default
/// that `profile::apply_env_defaults` seeds, so spawn and client never diverge.
pub fn rerank_port() -> u16 {
    crate::profile::port(RERANK_PORT_BASE)
}

static TIER: SatelliteTier = SatelliteTier {
    name: "llamacpp-rerank",
    kind: "reranker",
    port: rerank_port,
    on_serving: || {},
    failure_reason: || None,
};

/// Lifecycle manager for the dedicated llama.cpp reranking sidecar.
pub struct LlamaCppRerankManager {
    satellite: Satellite,
}

impl LlamaCppRerankManager {
    pub fn new() -> Self {
        Self {
            satellite: Satellite::new(&TIER),
        }
    }

    /// Inject the global download center (called at the `main.rs` build site).
    pub fn with_downloads(mut self, downloads: crate::downloads::DownloadCenter) -> Self {
        self.satellite.downloads = Some(downloads);
        self
    }
}

impl Default for LlamaCppRerankManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppRerankManager {
    fn name(&self) -> &'static str {
        TIER.name
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let satellite = self.satellite.clone();
        Box::pin(async move {
            // Adopt an already-running reranker server rather than spawning a
            // competing process that would fail to bind the port. The common case on
            // the Spaces search path is that the answering server is our OWN child from
            // an earlier search, so it is classified rather than assumed to be foreign
            // — otherwise the idle reaper's `stop` could never give the memory back.
            if satellite.already_up().await {
                return Ok(());
            }

            let downloads = satellite
                .downloads
                .as_ref()
                .expect("llamacpp-rerank manager: download center not wired (main.rs)");
            satellite.install_llamacpp(downloads).await?;

            // Serve the reranker GGUF downloaded by onboarding. Like the embeddings
            // server, this engine does NOT download the model itself — onboarding
            // (`install_local_stack`) is the single owner of model downloads.
            let registry = crate::registry::ModelRegistry::from_env();
            let model_path =
                satellite.require_model(registry.local_reranker_model.weight_path(), "reranker")?;

            // Saved reranker settings apply on top of the safe batch defaults
            // below; the context size defaults through `ctx_size`.
            let mut launch =
                crate::sidecar::providers::engine_launch_config("llamacpp-rerank").await;
            launch.batch_size.get_or_insert(8192);
            launch.ubatch_size.get_or_insert(8192);
            let opts = LlamaCppStartOptions {
                port: rerank_port(),
                model_path: Some(model_path),
                // The reranker model is text-only — no vision adapter.
                mmproj_path: None,
                // bge-reranker-v2-m3 supports 8192-token inputs; match ctx + batch
                // knobs so long (query, document) pairs aren't truncated/rejected.
                ctx_size: 8192,
                embeddings: false,
                reranking: true,
                launch,
            };
            // Model load takes a few seconds even for the ~438 MB reranker GGUF.
            satellite.spawn(opts, "reranking").await
        })
    }

    fn stop(&self) -> BoxFuture<anyhow::Result<()>> {
        self.satellite.stop()
    }

    fn health_check(&self) -> BoxFuture<HealthStatus> {
        self.satellite.health_check()
    }

    fn is_running(&self) -> bool {
        self.satellite.is_running()
    }

    fn pid(&self) -> Option<u32> {
        self.satellite.pid()
    }

    fn uninstall(&self, _delete_data: bool) -> BoxFuture<anyhow::Result<()>> {
        Box::pin(async move {
            // The binary is shared with the chat engine — do NOT remove it here.
            // Only drop the version-store marker for this sidecar. The reranker
            // GGUF under `models/rerank/` is left intact.
            crate::sidecar::remove_from_version_store("llamacpp-rerank");
            tracing::info!("llamacpp-rerank uninstalled (shared binary + models left intact)");
            Ok(())
        })
    }
}
