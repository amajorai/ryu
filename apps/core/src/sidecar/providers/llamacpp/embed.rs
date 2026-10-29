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
//! answering on the port we adopt it rather than fighting for the bind (the
//! lifecycle shared with the other llama.cpp satellites is in `satellite.rs`).

use crate::sidecar::providers::llamacpp::process::LlamaCppStartOptions;
use crate::sidecar::providers::llamacpp::satellite::{Satellite, SatelliteTier};
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

static TIER: SatelliteTier = SatelliteTier {
    name: "llamacpp-embed",
    kind: "embeddings",
    port: embed_port,
    on_serving: || {},
    failure_reason: || None,
};

/// Lifecycle manager for the dedicated llama.cpp embeddings sidecar.
pub struct LlamaCppEmbedManager {
    satellite: Satellite,
}

impl LlamaCppEmbedManager {
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

impl Default for LlamaCppEmbedManager {
    fn default() -> Self {
        Self::new()
    }
}

impl Sidecar for LlamaCppEmbedManager {
    fn name(&self) -> &'static str {
        TIER.name
    }

    fn is_required(&self) -> bool {
        false
    }

    fn start(&self) -> BoxFuture<anyhow::Result<()>> {
        let satellite = self.satellite.clone();
        Box::pin(async move {
            // Adopt an already-running embeddings server (e.g. user-managed) rather
            // than spawning a competing process that would fail to bind the port. The
            // answering server is usually our OWN child from an earlier start
            // (`llamacpp-embed` is in `startup_order`), so it is classified rather
            // than assumed to be foreign.
            if satellite.already_up().await {
                return Ok(());
            }

            let downloads = satellite
                .downloads
                .as_ref()
                .expect("llamacpp-embed manager: download center not wired (main.rs)");
            satellite.install_llamacpp(downloads).await?;

            // Serve the embedding GGUF downloaded by onboarding. This engine does
            // NOT download the model itself — onboarding (`install_local_stack`)
            // is the single owner of model downloads (mirrors the chat engine,
            // which also resolves a pre-downloaded weight). That avoids a
            // concurrent double-download race against onboarding on first boot.
            let registry = crate::registry::ModelRegistry::from_env();
            let model_path =
                satellite.require_model(registry.local_embed_model.weight_path(), "embedding")?;

            let mut launch =
                crate::sidecar::providers::engine_launch_config("llamacpp-embed").await;
            // The embedding model supports 8192-token inputs. Keep these safe
            // defaults unless the user explicitly chooses different values.
            launch.batch_size.get_or_insert(8192);
            launch.ubatch_size.get_or_insert(8192);
            let opts = LlamaCppStartOptions {
                port: embed_port(),
                model_path: Some(model_path),
                // The embedding model is text-only — no vision adapter.
                mmproj_path: None,
                // Default context for nomic-embed-text. The engine launch config
                // can override this through its `ctx_size` field.
                ctx_size: 8192,
                embeddings: true,
                reranking: false,
                launch,
            };
            // Model load can take a few seconds even for the small nomic GGUF.
            satellite.spawn(opts, "embeddings").await
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
            // Only drop the version-store marker for this sidecar. The embedding
            // GGUF lives under `models/embedding/` and is left intact (the
            // registry owns it; per-file deletion is out of scope).
            crate::sidecar::remove_from_version_store("llamacpp-embed");
            tracing::info!("llamacpp-embed uninstalled (shared binary + models left intact)");
            Ok(())
        })
    }
}
