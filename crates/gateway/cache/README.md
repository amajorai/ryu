# ryu-gw-cache

Ryu **Gateway** response-cache stage (decomposition W6), extracted into a self-contained crate.

## What it is

Two response caches, each a swappable capability with an in-memory built-in:

- **`exact`** — exact-match TTL cache keyed by a deterministic `(org, model, messages)` hash
  (`sha2`). Types: `Cache`, `CacheBackend`, `CacheRegistry`, `CacheConfig`.
- **`semantic`** — embedding-similarity cache: a request hits a cached reply when its prompt
  embedding is within a cosine threshold of a stored one. Types: `SemanticCache`,
  `SemanticCacheBackend`, `SemanticCacheRegistry`, `SemanticCacheConfig`, plus the shared
  `embed_text` / `cosine_similarity` helpers (also used by the Gateway smart router).

## Role in the decomposition

An **extracted gateway stage crate**. The swap seam is a **backend trait + id-keyed registry** per
cache (`CacheBackend`/`CacheRegistry`, `SemanticCacheBackend`/`SemanticCacheRegistry`) with an
in-memory built-in active by default. Config value-types live here; the Gateway `config` module
re-exports them, so `crate::config::{CacheConfig, SemanticCacheConfig}` paths are unchanged.

## Notable seam

The semantic embedder issues a direct OpenAI-compatible `/embeddings` call today, taking a bare
`(base_url, api_key)` endpoint rather than the Gateway's provider config. Unifying it with Core's
`rag` capability is a cross-tier `rag.embed` edge deferred to the platform-decomposition program.

## How it is consumed

Compiled **into the Gateway** binary (`apps/gateway`), which owns the pipeline wiring. Not a sidecar.
Swap either cache by registering a different backend on its registry.
