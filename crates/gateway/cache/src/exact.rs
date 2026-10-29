use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use hex::encode as hex_encode;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tracing::debug;

use crate::stats::CacheStatsSnapshot;
use crate::BoxFuture;

/// Opaque boot namespace plus publication sequence supplied by provider runtime.
/// Boot identity must be generated once per runtime, never per request. A fresh
/// UUID prevents persistent/shared cache collisions when sequence restarts at zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CacheEpoch {
    boot: [u8; 16],
    sequence: u64,
}

impl CacheEpoch {
    pub fn new(boot: [u8; 16], sequence: u64) -> Self {
        Self { boot, sequence }
    }
}

/// One captured provider namespace used by both exact and semantic backends.
#[derive(Debug, Clone, Copy)]
pub struct CacheScope<'a> {
    epoch: CacheEpoch,
    tenant: Option<&'a str>,
    /// The caller partition inside a tenant (a credential binding). `None`
    /// keeps the tenant-wide namespace.
    caller: Option<&'a str>,
    provider: &'a str,
    model: &'a str,
}

impl<'a> CacheScope<'a> {
    pub fn new(
        epoch: CacheEpoch,
        tenant: Option<&'a str>,
        provider: &'a str,
        model: &'a str,
    ) -> Self {
        Self {
            epoch,
            tenant,
            caller: None,
            provider,
            model,
        }
    }

    /// Partition the scope by caller so two credentials never share an entry,
    /// even inside one tenant (or when there is no tenant at all).
    pub fn with_caller(mut self, caller: &'a str) -> Self {
        self.caller = Some(caller);
        self
    }

    /// Existing semantic backends accept an opaque string in their tenant slot.
    /// JSON framing distinguishes null/empty tenant and arbitrary field contents.
    pub fn semantic_scope(&self) -> String {
        serde_json::json!([
            "ryu-provider-cache-v3",
            hex_encode(self.epoch.boot),
            self.epoch.sequence,
            self.tenant,
            self.caller,
            self.provider,
            self.model
        ])
        .to_string()
    }
}

fn hash_segment(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_be_bytes());
    hasher.update(bytes);
}

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
    /// Also caps the semantic cache, which evicts its oldest entries the same way.
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

    /// Derive a backend-independent key from the captured provider epoch and
    /// request dimensions. The epoch is required even for one-account providers.
    pub fn make_key(
        scope: &CacheScope<'_>,
        messages: &Value,
        tools: Option<&Value>,
        capability_hints: Option<&str>,
    ) -> String {
        let mut hasher = Sha256::new();
        hasher.update(b"ryu-exact-cache-v2\0");
        hash_segment(&mut hasher, scope.semantic_scope().as_bytes());
        hash_segment(&mut hasher, messages.to_string().as_bytes());
        match tools.filter(|value| !value.is_null()) {
            Some(value) => {
                hasher.update([1]);
                hash_segment(&mut hasher, value.to_string().as_bytes());
            }
            None => hasher.update([0]),
        }
        match capability_hints.filter(|value| !value.is_empty()) {
            Some(value) => {
                hasher.update([1]);
                hash_segment(&mut hasher, value.as_bytes());
            }
            None => hasher.update([0]),
        }
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
        // Partition out the oldest n entries without sorting the entire cache.
        let mut pairs: Vec<(String, Instant)> = self
            .entries
            .iter()
            .map(|e| (e.key().clone(), e.value().inserted_at))
            .collect();
        if n < pairs.len() {
            pairs.select_nth_unstable_by_key(n, |(_, t)| *t);
        }
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
/// [`Cache::make_key`] requires the captured scope and stays a concrete associated function (its call sites name
/// the type and are backend-independent).
pub trait CacheBackend: Send + Sync {
    /// Return a cached response if one exists and has not expired.
    fn get(&self, key: &str) -> Option<Value>;
    /// Store a response, evicting to stay within capacity.
    fn insert(&self, key: String, response: Value);
    /// Drop entries whose TTL has elapsed (background sweep).
    fn evict_expired(&self);

    /// Async form of [`get`](Self::get), used by the request pipeline. In-process
    /// backends keep the default (the sync verb, already complete); network
    /// backends (Redis) override it so a lookup never blocks a runtime worker.
    fn get_async<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Option<Value>> {
        Box::pin(std::future::ready(self.get(key)))
    }

    /// Async form of [`insert`](Self::insert); see [`get_async`](Self::get_async).
    fn insert_async(&self, key: String, response: Value) -> BoxFuture<'_, ()> {
        self.insert(key, response);
        Box::pin(std::future::ready(()))
    }

    /// Hit/miss/store/error counters, when the backend keeps them.
    fn stats(&self) -> Option<CacheStatsSnapshot> {
        None
    }
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

    /// Async lookup on the active backend (the request-path form).
    pub async fn get_async(&self, key: &str) -> Option<Value> {
        self.active.get_async(key).await
    }

    /// Async store on the active backend (the request-path form).
    pub async fn insert_async(&self, key: String, response: Value) {
        self.active.insert_async(key, response).await;
    }

    /// The active backend's counters, if it keeps them.
    pub fn stats(&self) -> Option<CacheStatsSnapshot> {
        self.active.stats()
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

    fn key(tenant: Option<&str>, model: &str, messages: &Value) -> String {
        request_key(tenant, model, messages, None, None)
    }
    fn request_key(
        tenant: Option<&str>,
        model: &str,
        messages: &Value,
        tools: Option<&Value>,
        hints: Option<&str>,
    ) -> String {
        provider_key(tenant, "fixture-provider", model, messages, tools, hints)
    }
    fn provider_key(
        tenant: Option<&str>,
        provider: &str,
        model: &str,
        messages: &Value,
        tools: Option<&Value>,
        hints: Option<&str>,
    ) -> String {
        Cache::make_key(
            &CacheScope::new(CacheEpoch::new([1; 16], 0), tenant, provider, model),
            messages,
            tools,
            hints,
        )
    }

    // ─── make_key: determinism, tenant scoping, field sensitivity ────────────

    #[test]
    fn make_key_is_deterministic() {
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        let a = key(Some("org1"), "gpt-4", &msgs);
        let b = key(Some("org1"), "gpt-4", &msgs);
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
            key(Some("org1"), "gpt-4", &compact),
            key(Some("org1"), "gpt-4", &spaced),
        );
    }

    #[test]
    fn make_key_separates_tenants() {
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        let org1 = key(Some("org1"), "m", &msgs);
        let org2 = key(Some("org2"), "m", &msgs);
        let none = key(None, "m", &msgs);
        assert_ne!(org1, org2, "distinct orgs must not share a key");
        assert_ne!(org1, none, "an org must not collide with the no-org bucket");
        assert_ne!(org2, none);
    }

    #[test]
    fn make_key_none_bucket_is_stable() {
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        assert_eq!(key(None, "m", &msgs), key(None, "m", &msgs),);
    }

    #[test]
    fn request_key_separates_capability_sensitive_fields() {
        let messages = json!([{ "role": "user", "content": "send it" }]);
        let tools_a = json!([{ "type": "function", "function": { "name": "mail.send" } }]);
        let tools_b = json!([{ "type": "function", "function": { "name": "calendar.create" } }]);
        let base = request_key(None, "m", &messages, None, None);
        let a = request_key(None, "m", &messages, Some(&tools_a), Some("a"));
        let b = request_key(None, "m", &messages, Some(&tools_b), Some("b"));
        assert_ne!(base, a);
        assert_ne!(a, b);
    }

    #[test]
    fn request_key_separates_resolved_providers() {
        let messages = json!([{ "role": "user", "content": "hi" }]);
        let openai = provider_key(Some("org"), "openai", "shared-model", &messages, None, None);
        let anthropic = provider_key(
            Some("org"),
            "anthropic",
            "shared-model",
            &messages,
            None,
            None,
        );
        assert_ne!(openai, anthropic);
    }

    #[test]
    fn one_account_replacement_and_policy_context_epochs_isolate_identical_requests() {
        let messages = json!([{ "role":"user", "content":"same request" }]);
        let cache = Cache::new(cfg(true, 3600, 100));
        let first = CacheScope::new(
            CacheEpoch::new([1; 16], 1),
            Some("tenant"),
            "openai",
            "model",
        );
        let old_key = Cache::make_key(&first, &messages, None, None);
        cache.insert(old_key.clone(), json!({"account":"old"}));
        // The runtime advances this same input for credential, context or policy.
        for sequence in [2, 3, 4] {
            let updated = CacheScope::new(
                CacheEpoch::new([1; 16], sequence),
                Some("tenant"),
                "openai",
                "model",
            );
            let updated_key = Cache::make_key(&updated, &messages, None, None);
            assert_ne!(old_key, updated_key);
            assert_eq!(cache.get(&updated_key), None);
            // A delayed completion retains its captured old namespace.
            cache.insert(old_key.clone(), json!({"account":"late-old"}));
            assert_eq!(cache.get(&updated_key), None);
        }
    }

    #[test]
    fn shared_plugin_backend_does_not_collide_when_boot_sequence_restarts() {
        let shared: Arc<dyn CacheBackend> = Arc::new(Cache::new(cfg(true, 3600, 100)));
        let mut before = CacheRegistry::new(cfg(true, 3600, 100));
        before.register("shared", shared.clone());
        assert!(before.set_active("shared"));
        let mut after = CacheRegistry::new(cfg(true, 3600, 100));
        after.register("shared", shared);
        assert!(after.set_active("shared"));
        let messages = json!([{"content":"same"}]);
        let old = Cache::make_key(
            &CacheScope::new(CacheEpoch::new([1; 16], 0), None, "provider", "model"),
            &messages,
            None,
            None,
        );
        let new = Cache::make_key(
            &CacheScope::new(CacheEpoch::new([2; 16], 0), None, "provider", "model"),
            &messages,
            None,
            None,
        );
        before.insert(old.clone(), json!({"answer":"old-boot"}));
        assert_eq!(after.get(&new), None);
        after.insert(new.clone(), json!({"answer":"new-boot"}));
        before.insert(old, json!({"answer":"late-old-boot"}));
        assert_eq!(after.get(&new), Some(json!({"answer":"new-boot"})));
    }

    #[test]
    fn semantic_backend_scope_isolates_epochs_and_late_old_writes() {
        let cache = crate::semantic::SemanticCache::new(
            crate::semantic::SemanticCacheConfig {
                enabled: true,
                ..Default::default()
            },
            3600,
            1000,
        );
        let first = CacheScope::new(
            CacheEpoch::new([1; 16], 1),
            Some("tenant"),
            "provider",
            "model",
        )
        .semantic_scope();
        let second = CacheScope::new(
            CacheEpoch::new([1; 16], 2),
            Some("tenant"),
            "provider",
            "model",
        )
        .semantic_scope();
        let restarted = CacheScope::new(
            CacheEpoch::new([2; 16], 1),
            Some("tenant"),
            "provider",
            "model",
        )
        .semantic_scope();
        cache.insert(Some(first.clone()), vec![1.0, 0.0], json!({"answer":"old"}));
        assert_eq!(cache.lookup(Some(&second), &[1.0, 0.0]), None);
        assert_eq!(cache.lookup(Some(&restarted), &[1.0, 0.0]), None);
        cache.insert(
            Some(second.clone()),
            vec![1.0, 0.0],
            json!({"answer":"new"}),
        );
        cache.insert(Some(first), vec![1.0, 0.0], json!({"answer":"late-old"}));
        assert_eq!(
            cache.lookup(Some(&second), &[1.0, 0.0]),
            Some(json!({"answer":"new"}))
        );
    }

    #[test]
    fn scope_framing_distinguishes_empty_tenants_and_delimiter_contents() {
        let epoch = CacheEpoch::new([1; 16], 0);
        let messages = json!([]);
        let scopes = [
            CacheScope::new(epoch, None, "provider", "model"),
            CacheScope::new(epoch, Some(""), "provider", "model"),
            CacheScope::new(epoch, Some("a\nb"), "c", "model"),
            CacheScope::new(epoch, Some("a"), "b\nc", "model"),
        ];
        for (index, scope) in scopes.iter().enumerate() {
            for other in scopes.iter().skip(index + 1) {
                assert_ne!(scope.semantic_scope(), other.semantic_scope());
                assert_ne!(
                    Cache::make_key(scope, &messages, None, None),
                    Cache::make_key(other, &messages, None, None)
                );
            }
        }
    }

    #[test]
    fn caller_partition_separates_credentials_in_one_tenant() {
        let epoch = CacheEpoch::new([1; 16], 0);
        let messages = json!([{ "role": "user", "content": "hi" }]);
        let shared = CacheScope::new(epoch, None, "provider", "model");
        let alpha = shared.with_caller("alpha");
        let beta = shared.with_caller("beta");
        assert_ne!(alpha.semantic_scope(), beta.semantic_scope());
        assert_ne!(alpha.semantic_scope(), shared.semantic_scope());
        assert_ne!(
            Cache::make_key(&alpha, &messages, None, None),
            Cache::make_key(&beta, &messages, None, None)
        );
        // A caller id that looks like a tenant never collides with that tenant.
        let as_tenant = CacheScope::new(epoch, Some("alpha"), "provider", "model");
        assert_ne!(alpha.semantic_scope(), as_tenant.semantic_scope());
    }

    #[test]
    fn make_key_discriminant_prevents_prefix_collision() {
        // The [1u8] tag + separator keep an org named like a model/message run
        // from colliding with the no-org bucket. Any change to org, model or
        // messages must move the key.
        let msgs = json!([{ "role": "user", "content": "hi" }]);
        let base = key(Some("org1"), "gpt-4", &msgs);
        assert_ne!(base, key(Some("org1"), "gpt-5", &msgs));
        let other = json!([{ "role": "user", "content": "bye" }]);
        assert_ne!(base, key(Some("org1"), "gpt-4", &other));
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

    #[test]
    fn performance_eviction_selects_the_same_oldest_entries() {
        let cache = Cache::new(cfg(true, 3600, 20_000));
        let now = Instant::now();
        for i in 0..20_000 {
            cache.entries.insert(
                format!("k{i}"),
                CachedEntry {
                    response: json!(i),
                    inserted_at: now - Duration::from_micros(i),
                },
            );
        }
        let mut before: Vec<_> = cache
            .entries
            .iter()
            .map(|e| (e.key().clone(), e.inserted_at))
            .collect();
        let mut after = before.clone();
        let start = Instant::now();
        before.sort_by_key(|(_, t)| *t);
        let baseline = start.elapsed();
        let start = Instant::now();
        after.select_nth_unstable_by_key(2000, |(_, t)| *t);
        let optimized = start.elapsed();
        let expected: std::collections::HashSet<_> =
            before.into_iter().take(2000).map(|(key, _)| key).collect();
        let selected: std::collections::HashSet<_> =
            after.into_iter().take(2000).map(|(key, _)| key).collect();
        assert_eq!(expected, selected);
        cache.evict_oldest(2000);
        assert_eq!(cache.entries.len(), 18_000);
        assert!(expected.iter().all(|key| cache.get(key).is_none()));
        cache.evict_oldest(0);
        assert_eq!(cache.entries.len(), 18_000);
        cache.evict_oldest(30_000);
        assert!(cache.entries.is_empty());
        cache.evict_oldest(1);
        eprintln!("Eviction selection 20,000 entries: before={baseline:?}, after={optimized:?}");
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
