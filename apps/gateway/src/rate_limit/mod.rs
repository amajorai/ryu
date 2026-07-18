use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tracing::warn;

use crate::config::{ApiKeyConfig, RateLimitConfig};

struct Bucket {
    tokens: f64,
    last_refill: Instant,
}

impl Bucket {
    fn new(capacity: f64) -> Self {
        Self {
            tokens: capacity,
            last_refill: Instant::now(),
        }
    }

    fn try_consume(&mut self, cost: f64, capacity: f64, refill_rate: f64) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * refill_rate).min(capacity);
        self.last_refill = now;

        if self.tokens >= cost {
            self.tokens -= cost;
            true
        } else {
            false
        }
    }
}

pub struct RateLimiter {
    config: RateLimitConfig,
    request_buckets: DashMap<String, Bucket>,
    token_buckets: DashMap<String, Bucket>,
    /// Per-second burst buckets (for bot/abuse detection).
    burst_buckets: DashMap<String, Bucket>,
}

impl RateLimiter {
    pub fn new(config: RateLimitConfig) -> Self {
        Self {
            config,
            request_buckets: DashMap::new(),
            token_buckets: DashMap::new(),
            burst_buckets: DashMap::new(),
        }
    }

    /// Check per-second burst rate for bot/abuse detection.
    ///
    /// Returns `true` if the request is within the allowed burst rate,
    /// `false` if the key is sending requests too fast.
    pub fn check_burst(&self, key: &str) -> bool {
        if !self.config.enabled {
            return true;
        }
        let max_rps = self.config.max_burst_per_second as f64;
        if max_rps == 0.0 {
            return true;
        }
        // capacity = max_rps, refills at max_rps tokens/second
        let mut bucket = self
            .burst_buckets
            .entry(key.to_string())
            .or_insert_with(|| Bucket::new(max_rps));
        let allowed = bucket.try_consume(1.0, max_rps, max_rps);
        if !allowed {
            warn!(key, rps = max_rps, "bot detection: burst rate exceeded");
        }
        allowed
    }

    /// Like `check_request` but honours per-key RBAC overrides from `ApiKeyConfig`.
    pub fn check_request_for_key(&self, key: &str, key_cfg: Option<&ApiKeyConfig>) -> bool {
        if !self.config.enabled {
            return true;
        }
        let rpm = key_cfg
            .and_then(|k| k.requests_per_minute)
            .or(self.config.requests_per_minute);
        let Some(rpm) = rpm else { return true };
        let capacity = rpm as f64;
        let refill_rate = capacity / 60.0;
        let mut bucket = self
            .request_buckets
            .entry(key.to_string())
            .or_insert_with(|| Bucket::new(capacity));
        bucket.try_consume(1.0, capacity, refill_rate)
    }

    /// Like `check_tokens` but honours per-key RBAC overrides from `ApiKeyConfig`.
    pub fn check_tokens_for_key(
        &self,
        key: &str,
        token_count: u64,
        key_cfg: Option<&ApiKeyConfig>,
    ) -> bool {
        if !self.config.enabled {
            return true;
        }
        let tpm = key_cfg
            .and_then(|k| k.tokens_per_minute)
            .or(self.config.tokens_per_minute);
        let Some(tpm) = tpm else { return true };
        let capacity = tpm as f64;
        let refill_rate = capacity / 60.0;
        let cost = token_count as f64;
        let mut bucket = self
            .token_buckets
            .entry(key.to_string())
            .or_insert_with(|| Bucket::new(capacity));
        bucket.try_consume(cost, capacity, refill_rate)
    }

    /// Evict stale buckets older than `max_idle` to prevent unbounded memory growth.
    pub fn evict_stale(&self, max_idle: Duration) {
        let now = Instant::now();
        self.request_buckets
            .retain(|_, b| now.duration_since(b.last_refill) < max_idle);
        self.token_buckets
            .retain(|_, b| now.duration_since(b.last_refill) < max_idle);
        self.burst_buckets
            .retain(|_, b| now.duration_since(b.last_refill) < max_idle);
    }
}

// ─── Swappable rate limiter (Lg decomposition) ───────────────────────────────

/// The per-key rate limiter as a swappable, in-process capability. The built-in
/// [`RateLimiter`] (token-bucket over local `DashMap`s) is the default; an
/// alternative (e.g. a fleet-shared limiter) can register without touching the
/// pipeline. This is a HOT per-request primitive, so the swap is in-process only
/// (never IPC) — the trait is a swap-seam, mirroring the
/// [`crate::providers::ProviderRegistry`] inversion.
pub trait RateLimiterBackend: Send + Sync {
    /// Per-second burst check for bot/abuse detection.
    fn check_burst(&self, key: &str) -> bool;
    /// Per-minute request check, honouring per-key RBAC overrides.
    fn check_request_for_key(&self, key: &str, key_cfg: Option<&ApiKeyConfig>) -> bool;
    /// Per-minute token check, honouring per-key RBAC overrides.
    fn check_tokens_for_key(
        &self,
        key: &str,
        token_count: u64,
        key_cfg: Option<&ApiKeyConfig>,
    ) -> bool;
    /// Evict idle buckets older than `max_idle` (background sweep).
    fn evict_stale(&self, max_idle: Duration);
}

impl RateLimiterBackend for RateLimiter {
    fn check_burst(&self, key: &str) -> bool {
        RateLimiter::check_burst(self, key)
    }
    fn check_request_for_key(&self, key: &str, key_cfg: Option<&ApiKeyConfig>) -> bool {
        RateLimiter::check_request_for_key(self, key, key_cfg)
    }
    fn check_tokens_for_key(
        &self,
        key: &str,
        token_count: u64,
        key_cfg: Option<&ApiKeyConfig>,
    ) -> bool {
        RateLimiter::check_tokens_for_key(self, key, token_count, key_cfg)
    }
    fn evict_stale(&self, max_idle: Duration) {
        RateLimiter::evict_stale(self, max_idle);
    }
}

/// Id-keyed registry over [`RateLimiterBackend`] implementations. The built-in
/// [`RateLimiter`] is registered first under [`RateLimiterRegistry::BUILTIN`] and
/// active by default, so behavior is byte-identical with no config change.
/// Delegating verbs forward to the active backend, keeping every call site
/// unchanged.
pub struct RateLimiterRegistry {
    backends: HashMap<String, Arc<dyn RateLimiterBackend>>,
    order: Vec<String>,
    active_id: String,
    active: Arc<dyn RateLimiterBackend>,
}

impl RateLimiterRegistry {
    /// Stable id of the built-in in-process rate limiter.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering the built-in [`RateLimiter`]
    /// as the default active backend.
    pub fn new(config: RateLimitConfig) -> Self {
        let builtin: Arc<dyn RateLimiterBackend> = Arc::new(RateLimiter::new(config));
        let mut registry = Self {
            backends: HashMap::new(),
            order: Vec::new(),
            active_id: Self::BUILTIN.to_string(),
            active: Arc::clone(&builtin),
        };
        registry.register(Self::BUILTIN, builtin);
        registry
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    pub fn register(&mut self, id: impl Into<String>, backend: Arc<dyn RateLimiterBackend>) {
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

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.

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

    /// The registered backend ids in registration order.

    pub fn available(&self) -> Vec<String> {
        self.order.clone()
    }

    // ─── Delegating hot-path verbs (byte-identical call sites) ───────────────

    /// See [`RateLimiterBackend::check_burst`].
    pub fn check_burst(&self, key: &str) -> bool {
        self.active.check_burst(key)
    }

    /// See [`RateLimiterBackend::check_request_for_key`].
    pub fn check_request_for_key(&self, key: &str, key_cfg: Option<&ApiKeyConfig>) -> bool {
        self.active.check_request_for_key(key, key_cfg)
    }

    /// See [`RateLimiterBackend::check_tokens_for_key`].
    pub fn check_tokens_for_key(
        &self,
        key: &str,
        token_count: u64,
        key_cfg: Option<&ApiKeyConfig>,
    ) -> bool {
        self.active.check_tokens_for_key(key, token_count, key_cfg)
    }

    /// See [`RateLimiterBackend::evict_stale`].
    pub fn evict_stale(&self, max_idle: Duration) {
        self.active.evict_stale(max_idle);
    }
}
