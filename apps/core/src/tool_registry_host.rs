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

/// Upper bound on cached tool-text vectors. The catalog is a few hundred
/// descriptors, so this holds every one with room for model switches; hitting
/// it clears the cache rather than tracking recency.
const DOC_VECTOR_CACHE_CAP: usize = 4096;

type DocVectorCache =
    std::sync::Mutex<std::collections::HashMap<(String, String), std::sync::Arc<Vec<f32>>>>;

/// Tool descriptions barely change between searches, but the semantic ranker
/// embeds every candidate on every search. Vectors are keyed by embedder model
/// and text, so a model switch or an edited description misses naturally.
fn doc_vector_cache() -> &'static DocVectorCache {
    static CACHE: std::sync::OnceLock<DocVectorCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

#[async_trait]
impl ToolEmbedder for CoreToolEmbedder {
    async fn embed(&self, text: &str) -> Option<Vec<f32>> {
        // `None` on failure → the crate's documented BM25 fallback.
        self.inner.embed(text).await.ok()
    }

    async fn embed_batch(&self, texts: &[String]) -> Vec<Option<Vec<f32>>> {
        let model = self.inner.model_id().to_owned();
        let mut out: Vec<Option<Vec<f32>>> = Vec::with_capacity(texts.len());
        let mut missing = Vec::new();
        {
            let cache = doc_vector_cache()
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            for (index, text) in texts.iter().enumerate() {
                let hit = cache.get(&(model.clone(), text.clone()));
                if hit.is_none() {
                    missing.push(index);
                }
                out.push(hit.map(|vector| vector.as_ref().clone()));
            }
        }
        if missing.is_empty() {
            return out;
        }

        let batch: Vec<String> = missing.iter().map(|&index| texts[index].clone()).collect();
        let embedded = match self.inner.embed_batch(&batch).await {
            Ok(vectors) if vectors.len() == batch.len() => vectors.into_iter().map(Some).collect(),
            // A failed or short batch falls back to one call per text, so one bad
            // input still scores 0.0 alone instead of failing the whole ranking.
            _ => {
                let mut singles = Vec::with_capacity(batch.len());
                for text in &batch {
                    singles.push(self.inner.embed(text).await.ok());
                }
                singles
            }
        };

        let mut cache = doc_vector_cache()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if cache.len() + missing.len() > DOC_VECTOR_CACHE_CAP {
            cache.clear();
        }
        for (&index, vector) in missing.iter().zip(embedded) {
            if let Some(vector) = &vector {
                cache.insert(
                    (model.clone(), texts[index].clone()),
                    std::sync::Arc::new(vector.clone()),
                );
            }
            out[index] = vector;
        }
        out
    }
}
