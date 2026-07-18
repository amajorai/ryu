//! Core's implementation of the extracted [`ryu_tool_registry::ToolEmbedder`]
//! seam.
//!
//! The `ryu-tool-registry` crate owns the unified tool-catalog primitive — the
//! Contract-1 descriptor types, the swappable [`ryu_tool_registry::ToolRanker`],
//! argument-schema parsing, and the pure search/describe bodies. What it cannot
//! own — because it is a kernel-configured coupling — is the semantic ranker's
//! embedder: the registry-driven `retrieval::Embedder`. This shim wraps that
//! behind [`ryu_tool_registry::ToolEmbedder`] so the crate stays free of any
//! `apps/core` dependency (the `SearchEmbedder`/`search_host.rs` precedent).

use async_trait::async_trait;
use ryu_tool_registry::ToolEmbedder;

use crate::registry::ModelRegistry;
use ryu_rag::Embedder;

/// The kernel side of the tool-registry semantic-ranking seam: wraps the
/// registry-configured [`Embedder`] so `ryu-tool-registry` never depends on
/// `apps/core`. Built lazily, only when the active ranker is `Semantic`.
pub struct CoreToolEmbedder {
    inner: Embedder,
}

impl CoreToolEmbedder {
    /// Build from the active model registry — the same embedder choice the
    /// pre-extraction inline `semantic_score` made.
    pub fn from_registry() -> Self {
        Self {
            inner: crate::rag_host::embedder_from_registry(&ModelRegistry::load()),
        }
    }
}

#[async_trait]
impl ToolEmbedder for CoreToolEmbedder {
    async fn embed(&self, text: &str) -> Option<Vec<f32>> {
        // `None` on failure → the crate's documented BM25 fallback.
        self.inner.embed(text).await.ok()
    }
}
