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

- **`redis`** — `RedisExactCache` (`SET … PX` / `GET`) and `RedisSemanticCache` (per-scope sorted-set
  index capped at `max_entries`; brute-force cosine over the newest entries, or RediSearch
  `FT.SEARCH … KNN 1` over a per-dimension `FLAT COSINE` index). Registered by the Gateway under the
  `"redis"` id when `RYU_GATEWAY_REDIS_URL` is set; settings in `RedisCacheConfig` (`[redis_cache]`).
- **`embedding`** — `EmbeddingCache` for `/v1/embeddings`, keyed by provider scope, `dimensions`,
  `encoding_format`, and a hash of each normalized input; memory LRU store (entry + byte caps) or
  Redis store. Config: `EmbeddingCacheConfig` (`[embedding_cache]`).
- **`stats`** — `CacheStats` counters surfaced under `cache_backends` in Gateway metrics.

Both trait families carry async verbs (`get_async`/`insert_async`, `lookup_async`/`insert_async`)
with sync defaults so in-process backends are unchanged and network backends never block a worker.
Redis failures are counted and served as misses. Redis transport is `ryu-redis-wire`.

Tests: `cargo test -p ryu-gw-cache` (Redis paths run over an in-process RESP server). Set
`RYU_TEST_REDIS_URL` / `RYU_TEST_REDISEARCH_URL` to also run `tests/redis_live.rs` against real servers.

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
