use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use dashmap::DashMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tracing::debug;

use crate::stats::CacheStatsSnapshot;
use crate::BoxFuture;

// ─── Semantic cache config (moved verbatim from gateway `config.rs`) ──────────
//
// The serde shape the built-in [`SemanticCache`] consumes. It lives here so this
// stage crate is self-contained; gateway `config.rs` re-exports it so
// `crate::config::SemanticCacheConfig` paths are unchanged and `GatewayConfig`
// still embeds `semantic_cache`.

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SemanticCacheConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Cosine-similarity threshold to count as a cache hit. Default: 0.92.
    #[serde(default = "default_similarity_threshold")]
    pub similarity_threshold: f32,
    /// Embedding model to call via the OpenAI provider.
    #[serde(default = "default_embedding_model")]
    pub embedding_model: String,
}

fn default_similarity_threshold() -> f32 {
    0.92
}
fn default_embedding_model() -> String {
    "text-embedding-3-small".to_string()
}

impl Default for SemanticCacheConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            similarity_threshold: default_similarity_threshold(),
            embedding_model: default_embedding_model(),
        }
    }
}

struct Entry {
    org_id: Option<String>,
    embedding: Vec<f32>,
    response: Value,
    inserted_at: Instant,
}

pub struct SemanticCache {
    config: SemanticCacheConfig,
    store: DashMap<u64, Entry>,
    ttl_secs: u64,
    /// Entry cap (the exact cache's `cache.max_entries`). Each entry holds an
    /// embedding plus a full response and every lookup scans all of them, so
    /// the TTL alone does not bound memory or per-request CPU.
    max_entries: usize,
    /// Monotonic counter used as insert key — safe across evictions.
    next_key: AtomicU64,
}

impl SemanticCache {
    pub fn new(config: SemanticCacheConfig, ttl_secs: u64, max_entries: usize) -> Self {
        Self {
            config,
            store: DashMap::new(),
            ttl_secs,
            max_entries,
            next_key: AtomicU64::new(0),
        }
    }

    /// Fetch an embedding vector for `text` via the OpenAI embeddings endpoint,
    /// using this cache's configured embedding model.
    pub async fn get_embedding(
        &self,
        text: &str,
        http: &Client,
        base_url: &str,
        api_key: &str,
    ) -> anyhow::Result<Vec<f32>> {
        embed_text(text, http, base_url, api_key, &self.config.embedding_model).await
    }

    /// Look up a cached response whose embedding is within the similarity threshold.
    ///
    /// `org_id` scopes the nearest-neighbor search to the caller's tenant so the
    /// match can never cross orgs. `None` (no org) forms its own bucket and never
    /// matches a real org's entries.
    pub fn lookup(&self, org_id: Option<&str>, query: &[f32]) -> Option<Value> {
        let threshold = self.config.similarity_threshold;
        let now = Instant::now();

        // Track the best key, not its response: cloning a whole completion on
        // every improving candidate is wasted work, especially on a miss.
        let mut best: Option<(f32, u64)> = None;

        for entry in self.store.iter() {
            if entry.org_id.as_deref() != org_id {
                continue;
            }
            let age = now.duration_since(entry.inserted_at).as_secs();
            if age > self.ttl_secs {
                continue;
            }
            let score = cosine_similarity(query, &entry.embedding);
            if score > best.map_or(-1.0, |(best_score, _)| best_score) {
                best = Some((score, *entry.key()));
            }
        }

        let (best_score, key) = best?;
        if best_score < threshold {
            return None;
        }
        debug!(score = best_score, threshold, "semantic cache hit");
        // An entry evicted since the scan reads as a miss, like a later lookup.
        self.store.get(&key).map(|entry| entry.response.clone())
    }

    /// Store a new embedding + response, tagged with the caller's tenant.
    /// Enforces `max_entries` by evicting the oldest entries when full.
    pub fn insert(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value) {
        // Same cap as the exact cache: at the limit, drop ~10 % (oldest first).
        // `.max(1)` keeps the cap enforced when `max_entries` is under 10.
        if self.store.len() >= self.max_entries {
            self.evict_oldest((self.max_entries / 10).max(1));
        }
        let key = self.next_key.fetch_add(1, Ordering::Relaxed);
        self.store.insert(
            key,
            Entry {
                org_id,
                embedding,
                response,
                inserted_at: Instant::now(),
            },
        );
    }

    /// Evict expired entries.  Called from the same background task as the
    /// exact-match cache eviction.
    pub fn evict_expired(&self) {
        let now = Instant::now();
        self.store
            .retain(|_, e| now.duration_since(e.inserted_at).as_secs() <= self.ttl_secs);
    }

    fn evict_oldest(&self, n: usize) {
        // Partition out the oldest n entries without sorting the entire store.
        let mut pairs: Vec<(u64, Instant)> = self
            .store
            .iter()
            .map(|entry| (*entry.key(), entry.value().inserted_at))
            .collect();
        if n < pairs.len() {
            pairs.select_nth_unstable_by_key(n, |(_, inserted_at)| *inserted_at);
        }
        for (key, _) in pairs.into_iter().take(n) {
            self.store.remove(&key);
        }
    }

    /// Flatten the `messages` array into a single string suitable for embedding.
    pub fn messages_to_text(messages: &Value) -> String {
        messages
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let role = m["role"].as_str().unwrap_or("");
                        let content = m["content"].as_str().unwrap_or("");
                        if content.is_empty() {
                            None
                        } else {
                            Some(format!("{role}: {content}"))
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default()
    }
}

// ─── Swappable semantic cache backend (Lg decomposition) ─────────────────────

/// The semantic (embedding-similarity) response cache as a swappable capability.
/// The built-in [`SemanticCache`] (in-process cosine-similarity store + an
/// OpenAI-compatible embedder) is the default; an alternative (e.g. a vector-DB
/// backed store) can register without touching the pipeline, mirroring the
/// gateway `ProviderRegistry` inversion. The pure
/// [`SemanticCache::messages_to_text`] helper stays a concrete associated fn.
///
/// NOTE: unifying the embedder with Core's `rag` capability is a **cross-tier**
/// edge deferred per the platform-decomposition handoff (§4 Track B); this
/// inversion is purely the in-process store/backend seam.
pub trait SemanticCacheBackend: Send + Sync {
    /// Model metadata for the host's governed embedding dispatcher. The host retains keys,
    /// admission and accounting; cache backends only select the embedding model.
    fn embedding_model(&self) -> &str {
        "text-embedding-3-small"
    }
    /// Fetch an embedding vector for `text` via this backend's embedder.
    fn get_embedding<'a>(
        &'a self,
        text: &'a str,
        http: &'a Client,
        base_url: &'a str,
        api_key: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<f32>>> + Send + 'a>>;
    /// Look up a cached response whose embedding is within the similarity
    /// threshold, tenant-scoped by `org_id`.
    fn lookup(&self, org_id: Option<&str>, query: &[f32]) -> Option<Value>;
    /// Store a new embedding + response, tagged with the caller's tenant.
    fn insert(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value);
    /// Evict expired entries (background sweep).
    fn evict_expired(&self);

    /// Async form of [`lookup`](Self::lookup), used by the request pipeline.
    /// In-process backends keep the default; network backends override it.
    fn lookup_async<'a>(
        &'a self,
        org_id: Option<&'a str>,
        query: &'a [f32],
    ) -> BoxFuture<'a, Option<Value>> {
        Box::pin(std::future::ready(self.lookup(org_id, query)))
    }

    /// Async form of [`insert`](Self::insert).
    fn insert_async(
        &self,
        org_id: Option<String>,
        embedding: Vec<f32>,
        response: Value,
    ) -> BoxFuture<'_, ()> {
        self.insert(org_id, embedding, response);
        Box::pin(std::future::ready(()))
    }

    /// Hit/miss/store/error counters, when the backend keeps them.
    fn stats(&self) -> Option<CacheStatsSnapshot> {
        None
    }
}

impl SemanticCacheBackend for SemanticCache {
    fn embedding_model(&self) -> &str {
        &self.config.embedding_model
    }
    fn get_embedding<'a>(
        &'a self,
        text: &'a str,
        http: &'a Client,
        base_url: &'a str,
        api_key: &'a str,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<f32>>> + Send + 'a>> {
        Box::pin(SemanticCache::get_embedding(
            self, text, http, base_url, api_key,
        ))
    }
    fn lookup(&self, org_id: Option<&str>, query: &[f32]) -> Option<Value> {
        SemanticCache::lookup(self, org_id, query)
    }
    fn insert(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value) {
        SemanticCache::insert(self, org_id, embedding, response);
    }
    fn evict_expired(&self) {
        SemanticCache::evict_expired(self);
    }
}

/// Id-keyed registry over [`SemanticCacheBackend`] implementations. Unlike the
/// always-on stages, the semantic cache is optional: when disabled there is no
/// active backend ([`SemanticCacheRegistry::active`] returns `None`), matching
/// the old `Option<SemanticCache>` field. The built-in [`SemanticCache`] is
/// registered + active when config enables it, so behavior is byte-identical
/// with no config change. `register` / `set_active` are the open extension
/// point.
pub struct SemanticCacheRegistry {
    backends: HashMap<String, Arc<dyn SemanticCacheBackend>>,
    order: Vec<String>,
    active_id: Option<String>,
    active: Option<Arc<dyn SemanticCacheBackend>>,
}

impl SemanticCacheRegistry {
    /// Stable id of the built-in semantic cache.
    pub const BUILTIN: &'static str = "builtin";

    /// A disabled registry: no active backend (the semantic cache is off).
    pub fn disabled() -> Self {
        Self {
            backends: HashMap::new(),
            order: Vec::new(),
            active_id: None,
            active: None,
        }
    }

    /// Build the registry from an already-constructed built-in [`SemanticCache`],
    /// registering it as the default active backend.
    pub fn from_cache(cache: SemanticCache) -> Self {
        let builtin: Arc<dyn SemanticCacheBackend> = Arc::new(cache);
        let mut registry = Self::disabled();
        registry.register(Self::BUILTIN, Arc::clone(&builtin));
        registry.active_id = Some(Self::BUILTIN.to_string());
        registry.active = Some(builtin);
        registry
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    pub fn register(&mut self, id: impl Into<String>, backend: Arc<dyn SemanticCacheBackend>) {
        let id = id.into();
        if !self.backends.contains_key(&id) {
            self.order.push(id.clone());
        }
        let is_active = self.active_id.as_deref() == Some(id.as_str());
        self.backends.insert(id, Arc::clone(&backend));
        if is_active {
            self.active = Some(backend);
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.
    /// Called during `AppState::new` (config-driven build); a disabled cache has
    /// no registered backends, so only the default `"builtin"` no-op is accepted.
    pub fn set_active(&mut self, id: &str) -> bool {
        match self.backends.get(id) {
            Some(backend) => {
                self.active = Some(Arc::clone(backend));
                self.active_id = Some(id.to_string());
                true
            }
            None => false,
        }
    }

    /// The active backend, or `None` when the semantic cache is disabled — the
    /// drop-in replacement for the old `Option<SemanticCache>` field access.
    pub fn active(&self) -> Option<&Arc<dyn SemanticCacheBackend>> {
        self.active.as_ref()
    }

    /// The registered backend ids in registration order.
    pub fn available(&self) -> Vec<String> {
        self.order.clone()
    }
}

/// Fetch an embedding vector for `text` via an OpenAI-compatible `/embeddings`
/// endpoint with the given model. Shared by the semantic cache and the
/// `Embedding` routing strategy so both hit the same (local by default) embedder.
///
/// Takes a bare `(base_url, api_key)` endpoint rather than the gateway's
/// `OpenAiProviderConfig` so this crate stays free of gateway provider types;
/// callers pass `openai.base_url` / `openai.api_key`.
pub async fn embed_text(
    text: &str,
    http: &Client,
    base_url: &str,
    api_key: &str,
    model: &str,
) -> anyhow::Result<Vec<f32>> {
    let url = format!("{base_url}/embeddings");
    let resp = http
        .post(&url)
        .bearer_auth(api_key)
        .json(&json!({
            "model": model,
            "input": text,
        }))
        .send()
        .await?
        .error_for_status()?
        .json::<Value>()
        .await?;

    let embedding = resp["data"][0]["embedding"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("missing embedding in response"))?
        .iter()
        .filter_map(|v| v.as_f64().map(|f| f as f32))
        .collect();

    Ok(embedding)
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return -1.0;
    }
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm_a == 0.0 || norm_b == 0.0 {
        return -1.0;
    }
    dot / (norm_a * norm_b)
}

#[cfg(test)]
#[path = "semantic_tests.rs"]
mod tests;
