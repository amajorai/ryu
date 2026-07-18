//! Ryu Gateway response-cache stage (extracted, decomposition W6).
//!
//! Two response caches, each a swappable capability with an in-memory built-in:
//!
//! - [`exact`] — the exact-match TTL cache ([`Cache`] / [`CacheBackend`] /
//!   [`CacheRegistry`]), keyed by a deterministic `(org, model, messages)` hash.
//! - [`semantic`] — the embedding-similarity cache ([`SemanticCache`] /
//!   [`SemanticCacheBackend`] / [`SemanticCacheRegistry`]), plus the shared
//!   embedding helpers [`embed_text`] / [`cosine_similarity`] (also used by the
//!   gateway smart router).
//!
//! The config value-types ([`CacheConfig`], [`SemanticCacheConfig`]) live here so
//! the crate is self-contained; the gateway `config` module re-exports them so
//! `crate::config::{CacheConfig, SemanticCacheConfig}` paths are unchanged.
//!
//! The embedder issues a direct OpenAI-compatible `/embeddings` call today,
//! taking a bare `(base_url, api_key)` endpoint rather than the gateway's
//! `OpenAiProviderConfig`. Unifying it with Core's `rag` capability is a
//! cross-tier `rag.embed` edge deferred to the platform-decomposition program.

pub mod exact;
pub mod semantic;

pub use exact::{Cache, CacheBackend, CacheConfig, CacheRegistry};
pub use semantic::{
    cosine_similarity, embed_text, SemanticCache, SemanticCacheBackend, SemanticCacheConfig,
    SemanticCacheRegistry,
};
