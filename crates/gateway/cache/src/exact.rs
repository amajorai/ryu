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
        // Simple cap: if at limit, remove ~10 % of entries (oldest by insertion time).
        // `.max(1)` keeps the cap enforced for small `max_entries` (< 10), where the
        // 10 % share would otherwise floor to 0 and let the cache grow unbounded.
        if self.entries.len() >= self.config.max_entries {
            self.evict_oldest((self.config.max_entries / 10).max(1));
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
mod cache_tests {
    use super::*;
    use serde_json::json;
    use std::thread;

    fn cfg(enabled: bool, ttl_secs: u64, max_entries: usize) -> CacheConfig {
        CacheConfig {
            enabled,
            ttl_secs,
            max_entries,
        }
    }

    // ─── CacheConfig defaults / serde ────────────────────────────────────────

    #[test]
    fn default_config_matches_documented_values() {
        let c = CacheConfig::default();
        assert!(c.enabled);
        assert_eq!(c.ttl_secs, 300);
        assert_eq!(c.max_entries, 1000);
    }

    #[test]
    fn serde_fills_defaults_for_missing_fields() {
        // Empty object => every field falls back to its serde default.
        let c: CacheConfig = serde_json::from_value(json!({})).unwrap();
        assert!(c.enabled);
        assert_eq!(c.ttl_secs, 300);
        assert_eq!(c.max_entries, 1000);

        // Partial object => only the given field overrides.
        let c: CacheConfig = serde_json::from_value(json!({ "ttl_secs": 7 })).unwrap();
        assert!(c.enabled);
        assert_eq!(c.ttl_secs, 7);
        assert_eq!(c.max_entries, 1000);
    }

    // ─── make_key: determinism, tenant scoping, field sensitivity ────────────

    #[test]
    fn make_key_is_deterministic() {
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        let a = Cache::make_key(Some("org1"), "gpt-4", &msgs);
        let b = Cache::make_key(Some("org1"), "gpt-4", &msgs);
        assert_eq!(a, b);
        // SHA-256 hex is 64 chars.
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn make_key_is_whitespace_invariant() {
        // Compact serialisation means JSON whitespace can't change the key.
        let compact: Value = serde_json::from_str(r#"[{"role":"user","content":"hi"}]"#).unwrap();
        let spaced: Value =
            serde_json::from_str("[ { \"role\" : \"user\" , \"content\" : \"hi\" } ]").unwrap();
        assert_eq!(
            Cache::make_key(Some("org1"), "gpt-4", &compact),
            Cache::make_key(Some("org1"), "gpt-4", &spaced),
        );
    }

    #[test]
    fn make_key_separates_tenants() {
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        let org1 = Cache::make_key(Some("org1"), "m", &msgs);
        let org2 = Cache::make_key(Some("org2"), "m", &msgs);
        let none = Cache::make_key(None, "m", &msgs);
        assert_ne!(org1, org2, "distinct orgs must not share a key");
        assert_ne!(org1, none, "an org must not collide with the no-org bucket");
        assert_ne!(org2, none);
    }

    #[test]
    fn make_key_none_bucket_is_stable() {
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        assert_eq!(
            Cache::make_key(None, "m", &msgs),
            Cache::make_key(None, "m", &msgs),
        );
    }

    #[test]
    fn make_key_discriminant_prevents_prefix_collision() {
        // The [1u8] tag + separator keep an org named like a model/message run
        // from colliding with the no-org bucket. Any change to org, model or
        // messages must move the key.
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        let base = Cache::make_key(Some("org1"), "gpt-4", &msgs);
        assert_ne!(base, Cache::make_key(Some("org1"), "gpt-5", &msgs));
        let other = json!([{ "role": "user", "content": "bye" }]);
        assert_ne!(base, Cache::make_key(Some("org1"), "gpt-4", &other));
    }

    // ─── get / insert: hit, miss, disabled, TTL ──────────────────────────────

    #[test]
    fn insert_then_get_round_trips() {
        let cache = Cache::new(cfg(true, 3600, 1000));
        cache.insert("k".into(), json!({ "answer": 42 }));
        assert_eq!(cache.get("k"), Some(json!({ "answer": 42 })));
    }

    #[test]
    fn get_missing_key_is_none() {
        let cache = Cache::new(cfg(true, 3600, 1000));
        assert_eq!(cache.get("absent"), None);
    }

    #[test]
    fn disabled_cache_never_stores_or_serves() {
        let cache = Cache::new(cfg(false, 3600, 1000));
        cache.insert("k".into(), json!({ "a": 1 }));
        // insert was a no-op...
        assert_eq!(cache.entries.len(), 0);
        // ...and get short-circuits to None even if something were present.
        assert_eq!(cache.get("k"), None);
    }

    #[test]
    fn expired_entry_is_not_served() {
        // ttl_secs = 0 => TTL is Duration::ZERO, so any elapsed time is >= TTL
        // and the entry reads as expired without a sleep.
        let cache = Cache::new(cfg(true, 0, 1000));
        cache.insert("k".into(), json!({ "a": 1 }));
        assert_eq!(cache.get("k"), None, "zero-TTL entry must read as expired");
        // The stale row is still physically present until a sweep runs.
        assert_eq!(cache.entries.len(), 1);
    }

    // ─── evict_expired ───────────────────────────────────────────────────────

    #[test]
    fn evict_expired_drops_stale_rows() {
        let cache = Cache::new(cfg(true, 0, 1000));
        cache.insert("a".into(), json!(1));
        cache.insert("b".into(), json!(2));
        assert_eq!(cache.entries.len(), 2);
        cache.evict_expired();
        assert_eq!(cache.entries.len(), 0, "all zero-TTL rows should be swept");
    }

    #[test]
    fn evict_expired_keeps_fresh_rows() {
        let cache = Cache::new(cfg(true, 3600, 1000));
        cache.insert("a".into(), json!(1));
        cache.evict_expired();
        assert_eq!(cache.get("a"), Some(json!(1)));
    }

    #[test]
    fn evict_expired_is_a_noop_when_disabled() {
        // Disabled sweep must not touch the map (it also can't insert, so seed
        // directly to prove the retain() branch is skipped).
        let cache = Cache::new(cfg(false, 0, 1000));
        cache.entries.insert(
            "k".into(),
            CachedEntry {
                response: json!(1),
                inserted_at: Instant::now(),
            },
        );
        cache.evict_expired();
        assert_eq!(cache.entries.len(), 1, "disabled sweep must be a no-op");
    }

    // ─── eviction / capacity ─────────────────────────────────────────────────

    #[test]
    fn insert_caps_at_max_entries() {
        // max_entries = 20 => at capacity, evict 20/10 = 2 oldest, then insert.
        let cache = Cache::new(cfg(true, 3600, 20));
        for i in 0..200 {
            cache.insert(format!("k{i}"), json!(i));
        }
        assert!(
            cache.entries.len() <= 20,
            "len {} should stay within max_entries",
            cache.entries.len()
        );
        assert!(cache.entries.len() > 0);
    }

    #[test]
    fn small_max_entries_still_bounds_the_cache() {
        // Regression: max_entries < 10 made 10 % floor to 0, so evict_oldest(0)
        // removed nothing and the cache grew without bound. `.max(1)` fixes it.
        let cache = Cache::new(cfg(true, 3600, 5));
        for i in 0..100 {
            cache.insert(format!("k{i}"), json!(i));
        }
        assert!(
            cache.entries.len() <= 5,
            "len {} must respect a small max_entries",
            cache.entries.len()
        );
    }

    #[test]
    fn eviction_removes_oldest_first() {
        // Fill to capacity with keys inserted in a known order, then push one
        // more; the earliest-inserted key should be the one evicted.
        let cache = Cache::new(cfg(true, 3600, 10));
        for i in 0..10 {
            cache.insert(format!("k{i}"), json!(i));
            // Nudge the clock so inserted_at ordering is unambiguous.
            std::thread::sleep(Duration::from_millis(1));
        }
        // At capacity; this insert evicts 1 oldest (k0) before adding k10.
        cache.insert("k10".into(), json!(10));
        assert_eq!(cache.get("k0"), None, "oldest key should be evicted first");
        assert_eq!(cache.get("k10"), Some(json!(10)), "newest key present");
    }

    // ─── concurrency ─────────────────────────────────────────────────────────

    #[test]
    fn concurrent_inserts_and_reads_are_consistent() {
        // High cap so eviction never fires mid-run and the final count is exact.
        let cache = Arc::new(Cache::new(cfg(true, 3600, 100_000)));
        let threads = 8;
        let per_thread = 500;

        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let cache = Arc::clone(&cache);
                thread::spawn(move || {
                    for i in 0..per_thread {
                        let key = format!("t{t}-{i}");
                        cache.insert(key.clone(), json!(i));
                        // Read-back under contention must see our own write.
                        assert_eq!(cache.get(&key), Some(json!(i)));
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().expect("worker thread panicked");
        }

        assert_eq!(
            cache.entries.len(),
            threads * per_thread,
            "every distinct key should survive with no eviction"
        );
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

    #[test]
    fn registry_delegates_evict_and_exposes_backends() {
        // Drive the built-in through the registry across every delegating verb,
        // including the background sweep (exercises Cache's CacheBackend impl too).
        let reg = CacheRegistry::new(CacheConfig {
            enabled: true,
            ttl_secs: 0, // zero-TTL => rows read as expired without sleeping
            max_entries: 100,
        });
        reg.insert("k".to_string(), json!({ "a": 1 }));
        // Zero-TTL: the row is present but reads as expired.
        assert_eq!(reg.get("k"), None);
        // The sweep drops it via the active backend.
        reg.evict_expired();

        // backend() resolves the built-in; an unknown id yields None.
        assert!(reg.backend(CacheRegistry::BUILTIN).is_some());
        assert!(reg.backend("absent").is_none());
        assert_eq!(reg.available(), vec![CacheRegistry::BUILTIN.to_string()]);
    }
}
