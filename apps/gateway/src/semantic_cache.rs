//! Semantic cache stage — extracted to the `ryu-gw-cache` crate (decomposition W6).
//!
//! This module is now a thin re-export shim: the built-in [`SemanticCache`], the
//! swappable [`SemanticCacheBackend`] trait + [`SemanticCacheRegistry`], the
//! shared embedding helpers [`embed_text`] / [`cosine_similarity`] (also used by
//! the smart router), and the [`SemanticCacheConfig`] value-type all live in the
//! `ryu-gw-cache` crate (`semantic` module). Keeping `crate::semantic_cache::…`
//! paths working (pipeline lookup/store, `router::smart` embedding, `state.rs`
//! wiring) means the extraction is invisible to every consumer.
//! `SemanticCacheConfig` is also re-exported from [`crate::config`], so
//! `GatewayConfig` still embeds `semantic_cache` unchanged.
//!
//! The embedder issues a direct OpenAI-compatible `/embeddings` call, taking a
//! bare `(base_url, api_key)` endpoint; unifying it with Core's `rag` capability
//! is a cross-tier `rag.embed` edge deferred to the decomposition program.

pub use ryu_gw_cache::semantic::*;
