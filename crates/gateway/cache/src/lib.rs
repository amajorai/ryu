//! Ryu Gateway response-cache stage (extracted, decomposition W6).
//!
//! Two response caches, each a swappable capability with an in-memory built-in
//! and a Redis/Valkey backend, plus an embedding cache:
//!
//! - [`exact`] — the exact-match TTL cache ([`Cache`] / [`CacheBackend`] /
//!   [`CacheRegistry`]), keyed by a deterministic `(org, model, messages)` hash.
//! - [`semantic`] — the embedding-similarity cache ([`SemanticCache`] /
//!   [`SemanticCacheBackend`] / [`SemanticCacheRegistry`]), plus the shared
//!   embedding helpers [`embed_text`] / [`cosine_similarity`] (also used by the
//!   gateway smart router).
//! - [`redis`] — [`RedisExactCache`] and [`RedisSemanticCache`] (brute-force or
//!   RediSearch KNN search), registered under the `"redis"` backend id when
//!   `RYU_GATEWAY_REDIS_URL` is set, configured by [`RedisCacheConfig`].
//! - [`embedding`] — the `/v1/embeddings` cache ([`EmbeddingCache`]) keyed by
//!   provider scope, model, output parameters, and normalized input hash, with
//!   a bounded LRU memory store or a Redis store.
//! - [`stats`] — per-backend hit/miss/store/eviction/error counters.
//!
//! The config value-types ([`CacheConfig`], [`SemanticCacheConfig`],
//! [`RedisCacheConfig`], [`EmbeddingCacheConfig`]) live here so the crate is
//! self-contained; the gateway `config` module re-exports them.
//!
//! The embedder issues a direct OpenAI-compatible `/embeddings` call today,
//! taking a bare `(base_url, api_key)` endpoint rather than the gateway's
//! `OpenAiProviderConfig`. Unifying it with Core's `rag` capability is a
//! cross-tier `rag.embed` edge deferred to the platform-decomposition program.

use std::future::Future;
use std::pin::Pin;

pub mod embedding;
pub mod exact;
pub mod redis;
pub mod semantic;
pub mod stats;

/// Boxed, `Send` future returned by the object-safe async cache verbs.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub use embedding::{EmbeddingCache, EmbeddingCacheConfig, EmbeddingRequest, EmbeddingStore};
pub use exact::{Cache, CacheBackend, CacheConfig, CacheRegistry};
pub use redis::{
    redis_url_from_env, RedisCacheConfig, RedisExactCache, RedisSemanticCache, SemanticSearch,
    REDIS_BACKEND_ID, REDIS_URL_ENV,
};
pub use semantic::{
    cosine_similarity, embed_text, SemanticCache, SemanticCacheBackend, SemanticCacheConfig,
    SemanticCacheRegistry,
};
pub use stats::{CacheStats, CacheStatsSnapshot};
