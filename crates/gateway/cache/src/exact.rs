use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use hex::encode as hex_encode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::debug;

// ─── Exact-match cache config (moved verbatim from gateway `config.rs`) ───────
//
// The serde shape the built-in [`Cache`] consumes. It lives here (not in gateway
// `config.rs`) so this stage crate is self-contained; gateway `config.rs`
// re-exports it so `crate::config::CacheConfig` paths are unchanged and
// `GatewayConfig` still embeds `cache`.

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CacheConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How long a cached entry is valid (seconds). Default: 300 (5 min).
    #[serde(default = "default_cache_ttl")]
    pub ttl_secs: u64,
    /// Maximum number of entries before the oldest are evicted. Default: 1000.
    #[serde(default = "default_cache_max_entries")]
    pub max_entries: usize,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            ttl_secs: default_cache_ttl(),
            max_entries: default_cache_max_entries(),
        }
    }
}

fn default_true() -> bool {
    true
}
fn default_cache_ttl() -> u64 {
    300
}
fn default_cache_max_entries() -> usize {
    1000
}

struct CachedEntry {
    response: Value,
    inserted_at: Instant,
}

pub struct Cache {
    entries: DashMap<String, CachedEntry>,
    config: CacheConfig,
}

impl Cache {
    pub fn new(config: CacheConfig) -> Self {
        Self {
            entries: DashMap::new(),
            config,
        }
    }

    /// Build a deterministic cache key from the tenant, model and messages array.
    ///
    /// `org_id` scopes the key per tenant so one org can never be served
    /// another org's cached response. A discriminant byte keeps `None` (no org,
    /// e.g. single-tenant or master key) in its own bucket: it can never collide
    /// with a real org, and two distinct orgs never share a key.
    pub fn make_key(org_id: Option<&str>, model: &str, messages: &Value) -> String {
        let mut hasher = Sha256::new();
        match org_id {
            Some(org) => {
                hasher.update([1u8]);
                hasher.update(org.as_bytes());
            }
            None => hasher.update([0u8]),
        }
        hasher.update(b"\n");
        hasher.update(model.as_bytes());
        hasher.update(b"\n");
        // Use compact serialisation so key is stable regardless of JSON whitespace
        hasher.update(
            serde_json::to_string(messages)
                .unwrap_or_default()
                .as_bytes(),
        );
        hex_encode(hasher.finalize())
    }

    /// Return a cached response if one exists and has not expired.
    pub fn get(&self, key: &str) -> Option<Value> {
        if !self.config.enabled {
            return None;
        }
        let ttl = Duration::from_secs(self.config.ttl_secs);
        self.entries.get(key).and_then(|e| {
            if e.inserted_at.elapsed() < ttl {
                debug!(key, "cache hit");
                Some(e.response.clone())
            } else {
                None
            }
        })
    }

    /// Store a response. Enforces max_entries by evicting the oldest entries when full.
    pub fn insert(&self, key: String, response: Value) {
        if !self.config.enabled {
            return;
        }
        // Simple cap: if at limit, remove ~10 % of entries (oldest by insertion time)
        if self.entries.len() >= self.config.max_entries {
            self.evict_oldest(self.config.max_entries / 10);
        }
        self.entries.insert(
            key,
            CachedEntry {
                response,
                inserted_at: Instant::now(),
            },
        );
    }

    /// Remove all entries whose TTL has elapsed. Called from a background task.
    pub fn evict_expired(&self) {
        if !self.config.enabled {
            return;
        }
        let ttl = Duration::from_secs(self.config.ttl_secs);
        self.entries.retain(|_, e| e.inserted_at.elapsed() < ttl);
    }

    fn evict_oldest(&self, n: usize) {
        // Collect keys with their ages, sort by oldest first, remove the first n
        let mut pairs: Vec<(String, Instant)> = self
            .entries
            .iter()
            .map(|e| (e.key().clone(), e.value().inserted_at))
            .collect();
        pairs.sort_by_key(|(_, t)| *t);
        for (key, _) in pairs.into_iter().take(n) {
            self.entries.remove(&key);
        }
    }
}

// ─── Swappable exact-match cache backend (Lg decomposition) ──────────────────

/// The exact-match response cache as a swappable capability. The built-in
/// [`Cache`] (in-process TTL map) is the default; an alternative backend (e.g. a
/// Redis-backed shared cache) can register under its own id without touching the
/// pipeline, mirroring the provider-side `ProviderRegistry` inversion.
///
/// Only the hot-path verbs are on the trait; the pure key derivation
/// [`Cache::make_key`] stays a concrete associated function (its call sites name
/// the type and are backend-independent).
pub trait CacheBackend: Send + Sync {
    /// Return a cached response if one exists and has not expired.
    fn get(&self, key: &str) -> Option<Value>;
    /// Store a response, evicting to stay within capacity.
    fn insert(&self, key: String, response: Value);
    /// Drop entries whose TTL has elapsed (background sweep).
    fn evict_expired(&self);
}

impl CacheBackend for Cache {
    fn get(&self, key: &str) -> Option<Value> {
        Cache::get(self, key)
    }
    fn insert(&self, key: String, response: Value) {
        Cache::insert(self, key, response);
    }
    fn evict_expired(&self) {
        Cache::evict_expired(self);
    }
}

/// Id-keyed registry over [`CacheBackend`] implementations. The built-in
/// [`Cache`] is registered first under [`CacheRegistry::BUILTIN`] and is the
/// active backend by default, so behavior is byte-identical with no config
/// change. `register` + `set_active` are the open extension point for a cache
/// plugin; the delegating verbs forward to the resolved active backend so every
/// call site is unchanged.
pub struct CacheRegistry {
    backends: HashMap<String, Arc<dyn CacheBackend>>,
    order: Vec<String>,
    active_id: String,
    active: Arc<dyn CacheBackend>,
}

impl CacheRegistry {
    /// Stable id of the built-in in-process cache.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering the built-in [`Cache`] as the
    /// default active backend.
    pub fn new(config: CacheConfig) -> Self {
        let builtin: Arc<dyn CacheBackend> = Arc::new(Cache::new(config));
        let mut registry = Self {
            backends: HashMap::new(),
            order: Vec::new(),
            active_id: Self::BUILTIN.to_string(),
            active: Arc::clone(&builtin),
        };
        registry.register(Self::BUILTIN, builtin);
        registry
    }

    /// Register a backend under a stable id. Re-registering an id replaces it in
    /// place (preserving iteration order); if it is the active id the live
    /// handle is refreshed. This is the open extension point for cache plugins.
    pub fn register(&mut self, id: impl Into<String>, backend: Arc<dyn CacheBackend>) {
        let id = id.into();
        if !self.backends.contains_key(&id) {
            self.order.push(id.clone());
        }
        let is_active = id == self.active_id;
        self.backends.insert(id, Arc::clone(&backend));
        if is_active {
            self.active = backend;
        }
    }

    /// Select the active backend by id. Returns `false` (and leaves the active
    /// backend unchanged) if no backend is registered under `id`. Called during
    /// `AppState::new` (config-driven build).
    pub fn set_active(&mut self, id: &str) -> bool {
        match self.backends.get(id) {
            Some(backend) => {
                self.active = Arc::clone(backend);
                self.active_id = id.to_string();
                true
            }
            None => false,
        }
    }

    /// The id of the currently active backend.

    #[allow(dead_code)]
    pub fn active_id(&self) -> &str {
        &self.active_id
    }

    /// The registered backend ids in deterministic registration order.
    pub fn available(&self) -> Vec<String> {
        self.order.clone()
    }

    /// Look up a registered backend by id (registry surface, not the hot path).

    #[allow(dead_code)]
    pub fn backend(&self, id: &str) -> Option<&Arc<dyn CacheBackend>> {
        self.backends.get(id)
    }

    // ─── Delegating hot-path verbs (byte-identical call sites) ───────────────

    /// Return a cached response if present and unexpired.
    pub fn get(&self, key: &str) -> Option<Value> {
        self.active.get(key)
    }

    /// Store a response in the active backend.
    pub fn insert(&self, key: String, response: Value) {
        self.active.insert(key, response);
    }

    /// Background TTL sweep on the active backend.
    pub fn evict_expired(&self) {
        self.active.evict_expired();
    }
}

#[cfg(test)]
mod registry_tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A stub backend that records inserts and always answers `get` with a fixed
    /// sentinel — proof the registry actually dispatches to a swapped-in impl and
    /// is not write-only.
    struct StubBackend {
        inserts: AtomicUsize,
    }
    impl CacheBackend for StubBackend {
        fn get(&self, _key: &str) -> Option<Value> {
            Some(json!({ "stub": true }))
        }
        fn insert(&self, _key: String, _response: Value) {
            self.inserts.fetch_add(1, Ordering::Relaxed);
        }
        fn evict_expired(&self) {}
    }

    fn enabled_config() -> CacheConfig {
        CacheConfig {
            enabled: true,
            ttl_secs: 60,
            max_entries: 100,
        }
    }

    #[test]
    fn builtin_is_the_default_active_backend() {
        let reg = CacheRegistry::new(enabled_config());
        assert_eq!(reg.active_id(), CacheRegistry::BUILTIN);
        assert_eq!(reg.available(), vec![CacheRegistry::BUILTIN.to_string()]);
        // Round-trips through the built-in in-process cache unchanged.
        reg.insert("k".to_string(), json!({ "a": 1 }));
        assert_eq!(reg.get("k"), Some(json!({ "a": 1 })));
    }

    #[test]
    fn register_then_set_active_swaps_the_live_backend() {
        let mut reg = CacheRegistry::new(enabled_config());
        // Seed the built-in with a real entry so we can prove the swap bypasses it.
        reg.insert("k".to_string(), json!({ "builtin": true }));
        assert_eq!(reg.get("k"), Some(json!({ "builtin": true })));

        let stub = Arc::new(StubBackend {
            inserts: AtomicUsize::new(0),
        });
        reg.register("stub", Arc::clone(&stub) as Arc<dyn CacheBackend>);
        // Registered but not yet active: built-in still answers.
        assert_eq!(reg.get("k"), Some(json!({ "builtin": true })));

        assert!(reg.set_active("stub"));
        assert_eq!(reg.active_id(), "stub");
        // Now the stub's sentinel answers for ANY key — the swap is live.
        assert_eq!(reg.get("k"), Some(json!({ "stub": true })));
        reg.insert("k2".to_string(), json!({ "b": 2 }));
        assert_eq!(stub.inserts.load(Ordering::Relaxed), 1);

        // Unknown id is a no-op that keeps the current active backend.
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), "stub");
    }
}
