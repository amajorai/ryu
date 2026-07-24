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
    /// Monotonic counter used as insert key — safe across evictions.
    next_key: AtomicU64,
}

impl SemanticCache {
    pub fn new(config: SemanticCacheConfig, ttl_secs: u64) -> Self {
        Self {
            config,
            store: DashMap::new(),
            ttl_secs,
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

        let mut best_score = -1.0_f32;
        let mut best_response: Option<Value> = None;

        for entry in self.store.iter() {
            if entry.org_id.as_deref() != org_id {
                continue;
            }
            let age = now.duration_since(entry.inserted_at).as_secs();
            if age > self.ttl_secs {
                continue;
            }
            let score = cosine_similarity(query, &entry.embedding);
            if score > best_score {
                best_score = score;
                best_response = Some(entry.response.clone());
            }
        }

        if best_score >= threshold {
            debug!(score = best_score, threshold, "semantic cache hit");
            best_response
        } else {
            None
        }
    }

    /// Store a new embedding + response, tagged with the caller's tenant.
    pub fn insert(&self, org_id: Option<String>, embedding: Vec<f32>, response: Value) {
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
}

impl SemanticCacheBackend for SemanticCache {
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
mod tests {
    use super::*;
    use serde_json::json;

    // ─── SemanticCacheConfig defaults / serde ────────────────────────────────

    #[test]
    fn default_config_is_disabled() {
        let c = SemanticCacheConfig::default();
        assert!(!c.enabled, "semantic cache is opt-in / off by default");
        assert!((c.similarity_threshold - 0.92).abs() < 1e-6);
        assert_eq!(c.embedding_model, "text-embedding-3-small");
    }

    #[test]
    fn serde_fills_defaults() {
        let c: SemanticCacheConfig = serde_json::from_value(json!({})).unwrap();
        assert!(!c.enabled);
        assert!((c.similarity_threshold - 0.92).abs() < 1e-6);
        assert_eq!(c.embedding_model, "text-embedding-3-small");

        let c: SemanticCacheConfig =
            serde_json::from_value(json!({ "enabled": true, "similarity_threshold": 0.5 }))
                .unwrap();
        assert!(c.enabled);
        assert!((c.similarity_threshold - 0.5).abs() < 1e-6);
        assert_eq!(c.embedding_model, "text-embedding-3-small");
    }

    // ─── cosine_similarity ───────────────────────────────────────────────────

    #[test]
    fn cosine_identical_vectors_is_one() {
        assert!((cosine_similarity(&[1.0, 2.0, 3.0], &[1.0, 2.0, 3.0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_vectors_is_zero() {
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_vectors_is_negative_one() {
        assert!((cosine_similarity(&[1.0, 0.0], &[-1.0, 0.0]) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_scaled_vectors_are_still_similar() {
        // Cosine is scale-invariant: v and 5v point the same way.
        assert!((cosine_similarity(&[1.0, 2.0], &[5.0, 10.0]) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_length_mismatch_is_sentinel() {
        assert_eq!(cosine_similarity(&[1.0, 2.0], &[1.0]), -1.0);
    }

    #[test]
    fn cosine_empty_is_sentinel() {
        assert_eq!(cosine_similarity(&[], &[]), -1.0);
    }

    #[test]
    fn cosine_zero_vector_is_sentinel() {
        // Zero norm would divide by zero; guarded to the -1.0 sentinel.
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 1.0]), -1.0);
        assert_eq!(cosine_similarity(&[1.0, 1.0], &[0.0, 0.0]), -1.0);
    }

    // ─── messages_to_text ────────────────────────────────────────────────────

    #[test]
    fn messages_to_text_flattens_roles_and_content() {
        let msgs = json!([
            { "role": "user", "content": "hi" },
            { "role": "assistant", "content": "hello" },
        ]);
        assert_eq!(SemanticCache::messages_to_text(&msgs), "user: hi\nassistant: hello");
    }

    #[test]
    fn messages_to_text_skips_empty_content() {
        let msgs = json!([
            { "role": "system", "content": "" },
            { "role": "user", "content": "keep" },
        ]);
        assert_eq!(SemanticCache::messages_to_text(&msgs), "user: keep");
    }

    #[test]
    fn messages_to_text_treats_missing_role_as_empty() {
        let msgs = json!([{ "content": "orphan" }]);
        assert_eq!(SemanticCache::messages_to_text(&msgs), ": orphan");
    }

    #[test]
    fn messages_to_text_non_string_content_is_skipped() {
        // content that isn't a plain string flattens to empty and is dropped.
        let msgs = json!([{ "role": "user", "content": { "type": "image" } }]);
        assert_eq!(SemanticCache::messages_to_text(&msgs), "");
    }

    #[test]
    fn messages_to_text_non_array_is_empty() {
        assert_eq!(SemanticCache::messages_to_text(&json!(null)), "");
        assert_eq!(SemanticCache::messages_to_text(&json!({ "role": "user" })), "");
    }

    // ─── lookup / insert ─────────────────────────────────────────────────────

    fn cache(threshold: f32, ttl_secs: u64) -> SemanticCache {
        SemanticCache::new(
            SemanticCacheConfig {
                enabled: true,
                similarity_threshold: threshold,
                embedding_model: "m".into(),
            },
            ttl_secs,
        )
    }

    #[test]
    fn lookup_empty_store_is_none() {
        let c = cache(0.92, 3600);
        assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
    }

    #[test]
    fn lookup_returns_hit_above_threshold() {
        let c = cache(0.92, 3600);
        c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "r": 1 }));
        assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), Some(json!({ "r": 1 })));
    }

    #[test]
    fn lookup_below_threshold_is_miss() {
        let c = cache(0.92, 3600);
        // Orthogonal query => cosine 0.0, well below 0.92.
        c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "r": 1 }));
        assert_eq!(c.lookup(Some("org"), &[0.0, 1.0]), None);
    }

    #[test]
    fn lookup_is_tenant_scoped() {
        let c = cache(0.92, 3600);
        c.insert(Some("orgA".into()), vec![1.0, 0.0], json!({ "who": "A" }));
        c.insert(Some("orgB".into()), vec![1.0, 0.0], json!({ "who": "B" }));
        // Same embedding, different tenant => each org sees only its own row.
        assert_eq!(c.lookup(Some("orgA"), &[1.0, 0.0]), Some(json!({ "who": "A" })));
        assert_eq!(c.lookup(Some("orgB"), &[1.0, 0.0]), Some(json!({ "who": "B" })));
        // The no-org bucket never matches a real org's entry.
        assert_eq!(c.lookup(None, &[1.0, 0.0]), None);
    }

    #[test]
    fn lookup_none_bucket_matches_only_none() {
        let c = cache(0.92, 3600);
        c.insert(None, vec![1.0, 0.0], json!({ "shared": true }));
        assert_eq!(c.lookup(None, &[1.0, 0.0]), Some(json!({ "shared": true })));
        assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
    }

    #[test]
    fn lookup_returns_nearest_neighbor() {
        let c = cache(0.5, 3600);
        // Two candidates; the query is much closer to `near` than to `far`.
        c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "which": "near" }));
        c.insert(Some("org".into()), vec![0.7, 0.7], json!({ "which": "far" }));
        assert_eq!(
            c.lookup(Some("org"), &[1.0, 0.05]),
            Some(json!({ "which": "near" }))
        );
    }

    #[test]
    fn insert_uses_monotonic_keys() {
        // Distinct rows with the same tenant + embedding must not overwrite each
        // other — the monotonic counter keys them apart.
        let c = cache(0.99, 3600);
        c.insert(Some("org".into()), vec![1.0, 0.0], json!(1));
        c.insert(Some("org".into()), vec![1.0, 0.0], json!(2));
        assert_eq!(c.store.len(), 2);
    }

    // ─── TTL expiry (seconds granularity => one real sleep) ──────────────────

    #[test]
    fn expired_entries_are_skipped_and_swept() {
        // as_secs() truncates sub-second ages, so a zero-TTL entry only reads as
        // expired once a full second has elapsed. One ~1.1s sleep covers both the
        // lookup skip and the evict_expired removal.
        let c = cache(0.92, 0);
        c.insert(Some("org".into()), vec![1.0, 0.0], json!({ "r": 1 }));
        // Fresh: age truncates to 0, and 0 > 0 is false, so still visible.
        assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), Some(json!({ "r": 1 })));

        std::thread::sleep(std::time::Duration::from_millis(1100));

        // Now age >= 1 > ttl_secs(0): lookup skips it...
        assert_eq!(c.lookup(Some("org"), &[1.0, 0.0]), None);
        assert_eq!(c.store.len(), 1, "still physically present before sweep");
        // ...and the sweep removes it.
        c.evict_expired();
        assert_eq!(c.store.len(), 0);
    }

    #[test]
    fn evict_expired_keeps_fresh_entries() {
        let c = cache(0.92, 3600);
        c.insert(Some("org".into()), vec![1.0, 0.0], json!(1));
        c.evict_expired();
        assert_eq!(c.store.len(), 1);
    }

    // ─── SemanticCacheRegistry ───────────────────────────────────────────────

    struct StubBackend;
    impl SemanticCacheBackend for StubBackend {
        fn get_embedding<'a>(
            &'a self,
            _text: &'a str,
            _http: &'a Client,
            _base_url: &'a str,
            _api_key: &'a str,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<Vec<f32>>> + Send + 'a>> {
            Box::pin(async { Ok(vec![0.0]) })
        }
        fn lookup(&self, _org_id: Option<&str>, _query: &[f32]) -> Option<Value> {
            Some(json!({ "stub": true }))
        }
        fn insert(&self, _org_id: Option<String>, _embedding: Vec<f32>, _response: Value) {}
        fn evict_expired(&self) {}
    }

    #[test]
    fn disabled_registry_has_no_active_backend() {
        let reg = SemanticCacheRegistry::disabled();
        assert!(reg.active().is_none());
        assert!(reg.available().is_empty());
    }

    #[test]
    fn from_cache_registers_builtin_as_active() {
        let reg = SemanticCacheRegistry::from_cache(cache(0.92, 3600));
        assert!(reg.active().is_some());
        assert_eq!(reg.available(), vec![SemanticCacheRegistry::BUILTIN.to_string()]);
        // The active built-in answers a real lookup (empty store => None).
        assert_eq!(reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]), None);
    }

    #[test]
    fn set_active_unknown_id_is_rejected() {
        let mut reg = SemanticCacheRegistry::from_cache(cache(0.92, 3600));
        assert!(!reg.set_active("nope"));
        // Active backend unchanged (still the built-in).
        assert!(reg.active().is_some());
    }

    #[test]
    fn register_then_set_active_swaps_backend() {
        let mut reg = SemanticCacheRegistry::from_cache(cache(0.92, 3600));
        reg.register("stub", Arc::new(StubBackend) as Arc<dyn SemanticCacheBackend>);
        // Registered but not yet active: built-in still answers (None on empty).
        assert_eq!(reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]), None);

        assert!(reg.set_active("stub"));
        // Now the stub's sentinel answers for any lookup.
        assert_eq!(
            reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]),
            Some(json!({ "stub": true }))
        );
        assert_eq!(
            reg.available(),
            vec![
                SemanticCacheRegistry::BUILTIN.to_string(),
                "stub".to_string()
            ]
        );
    }

    #[test]
    fn register_replacing_active_refreshes_live_handle() {
        // Re-registering the active id must swap the live handle in place.
        let mut reg = SemanticCacheRegistry::disabled();
        reg.register(
            SemanticCacheRegistry::BUILTIN,
            Arc::new(cache(0.92, 3600)) as Arc<dyn SemanticCacheBackend>,
        );
        assert!(reg.set_active(SemanticCacheRegistry::BUILTIN));
        // Replace builtin with the stub under the same id while it is active.
        reg.register(
            SemanticCacheRegistry::BUILTIN,
            Arc::new(StubBackend) as Arc<dyn SemanticCacheBackend>,
        );
        assert_eq!(
            reg.active().unwrap().lookup(Some("org"), &[1.0, 0.0]),
            Some(json!({ "stub": true })),
            "live handle should reflect the replacement"
        );
        // Re-registering the same id must not duplicate it in the order list.
        assert_eq!(reg.available(), vec![SemanticCacheRegistry::BUILTIN.to_string()]);
    }
}
