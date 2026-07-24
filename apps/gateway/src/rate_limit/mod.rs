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

    /// Refill, then deduct `cost` unconditionally. Unlike [`Self::try_consume`]
    /// the balance may go negative: this settles usage that has already been
    /// served (a finished stream cannot be un-sent), so any overage is carried
    /// as debt that delays subsequent admissions until the refill covers it.
    fn force_consume(&mut self, cost: f64, capacity: f64, refill_rate: f64) {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * refill_rate).min(capacity);
        self.last_refill = now;
        self.tokens -= cost;
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

    /// Charge already-served tokens against the key's TPM bucket, honouring the
    /// same per-key RBAC override as [`Self::check_tokens_for_key`]. Where the
    /// check admits or rejects BEFORE spend, this settles spend that is only
    /// known after the fact — a stream's real usage arrives at stream end, when
    /// the bytes are already out — so the bucket may go negative and subsequent
    /// admissions wait out the debt.
    pub fn record_tokens_for_key(
        &self,
        key: &str,
        token_count: u64,
        key_cfg: Option<&ApiKeyConfig>,
    ) {
        if !self.config.enabled || token_count == 0 {
            return;
        }
        let tpm = key_cfg
            .and_then(|k| k.tokens_per_minute)
            .or(self.config.tokens_per_minute);
        let Some(tpm) = tpm else { return };
        let capacity = tpm as f64;
        let refill_rate = capacity / 60.0;
        let mut bucket = self
            .token_buckets
            .entry(key.to_string())
            .or_insert_with(|| Bucket::new(capacity));
        bucket.force_consume(token_count as f64, capacity, refill_rate);
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
    /// Charge already-served tokens (streaming settlement; may carry debt).
    fn record_tokens_for_key(&self, key: &str, token_count: u64, key_cfg: Option<&ApiKeyConfig>);
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
    fn record_tokens_for_key(&self, key: &str, token_count: u64, key_cfg: Option<&ApiKeyConfig>) {
        RateLimiter::record_tokens_for_key(self, key, token_count, key_cfg);
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

    /// See [`RateLimiterBackend::record_tokens_for_key`].
    pub fn record_tokens_for_key(
        &self,
        key: &str,
        token_count: u64,
        key_cfg: Option<&ApiKeyConfig>,
    ) {
        self.active.record_tokens_for_key(key, token_count, key_cfg);
    }

    /// See [`RateLimiterBackend::evict_stale`].
    pub fn evict_stale(&self, max_idle: Duration) {
        self.active.evict_stale(max_idle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(enabled: bool, rpm: Option<u64>, tpm: Option<u64>, burst: u32) -> RateLimitConfig {
        RateLimitConfig {
            enabled,
            tokens_per_minute: tpm,
            requests_per_minute: rpm,
            max_burst_per_second: burst,
        }
    }

    fn key_cfg(name: &str, rpm: Option<u64>, tpm: Option<u64>) -> ApiKeyConfig {
        ApiKeyConfig {
            key: format!("sk-{name}"),
            name: name.to_string(),
            org_id: None,
            team_id: None,
            project_id: None,
            requests_per_minute: rpm,
            tokens_per_minute: tpm,
            token_budget_total: None,
            downgrade_to: None,
            trusted_forwarder: false,
        }
    }

    // ─── disabled / bypass edges ─────────────────────────────────────────────

    #[test]
    fn disabled_limiter_allows_everything() {
        let rl = RateLimiter::new(cfg(false, Some(1), Some(1), 1));
        assert!(rl.check_burst("k"));
        assert!(rl.check_request_for_key("k", None));
        assert!(rl.check_tokens_for_key("k", 1_000_000, None));
    }

    #[test]
    fn zero_burst_rps_disables_burst_check() {
        // max_burst_per_second == 0 is the documented "unlimited burst" sentinel.
        let rl = RateLimiter::new(cfg(true, None, None, 0));
        for _ in 0..1000 {
            assert!(rl.check_burst("k"));
        }
    }

    #[test]
    fn no_rpm_configured_allows_all_requests() {
        let rl = RateLimiter::new(cfg(true, None, None, 1000));
        for _ in 0..100 {
            assert!(rl.check_request_for_key("k", None));
        }
    }

    #[test]
    fn no_tpm_configured_allows_all_tokens() {
        let rl = RateLimiter::new(cfg(true, None, None, 1000));
        assert!(rl.check_tokens_for_key("k", u64::MAX / 2, None));
    }

    // ─── request bucket capacity ─────────────────────────────────────────────

    #[test]
    fn request_bucket_allows_up_to_capacity_then_blocks() {
        // rpm 5 => capacity 5 tokens at start. The 6th request within the same
        // instant cannot have refilled a whole token (refill is 5/60 per sec), so
        // it is denied. Asserting the block edge, never the refill amount.
        let rl = RateLimiter::new(cfg(true, Some(5), None, 10_000));
        for i in 0..5 {
            assert!(
                rl.check_request_for_key("k", None),
                "request {i} within capacity"
            );
        }
        assert!(
            !rl.check_request_for_key("k", None),
            "6th request exceeds the rpm-5 bucket"
        );
    }

    #[test]
    fn token_bucket_denies_a_single_over_capacity_request() {
        // tpm 100 => a lone 101-token request cannot be admitted from a full bucket.
        let rl = RateLimiter::new(cfg(true, None, Some(100), 10_000));
        assert!(!rl.check_tokens_for_key("k", 101, None));
        // But an exactly-capacity request fits.
        assert!(rl.check_tokens_for_key("k2", 100, None));
    }

    #[test]
    fn token_bucket_drains_across_calls() {
        let rl = RateLimiter::new(cfg(true, None, Some(100), 10_000));
        assert!(rl.check_tokens_for_key("k", 60, None));
        // 60 consumed, ~40 left (plus negligible refill within the same instant);
        // a 60-token follow-up cannot fit.
        assert!(!rl.check_tokens_for_key("k", 60, None));
    }

    // ─── streaming settlement (record_tokens_for_key) ────────────────────────

    #[test]
    fn record_tokens_carries_debt_into_the_next_check() {
        // tpm 100: settling a 250-token stream leaves the bucket in debt, so the
        // next pre-check is denied (the same-instant refill cannot cover it).
        let rl = RateLimiter::new(cfg(true, None, Some(100), 10_000));
        rl.record_tokens_for_key("k", 250, None);
        assert!(!rl.check_tokens_for_key("k", 1, None));
    }

    #[test]
    fn record_tokens_without_tpm_config_is_a_noop() {
        let rl = RateLimiter::new(cfg(true, None, None, 10_000));
        rl.record_tokens_for_key("k", u64::MAX / 4, None);
        assert!(rl.check_tokens_for_key("k", u64::MAX / 2, None));
    }

    #[test]
    fn record_tokens_honours_per_key_tpm_override() {
        // Global tpm 1000, but this key's override is 10: a 20-token settlement
        // drains the small override bucket into debt.
        let rl = RateLimiter::new(cfg(true, None, Some(1000), 10_000));
        let k = key_cfg("vip", None, Some(10));
        rl.record_tokens_for_key("vip", 20, Some(&k));
        assert!(!rl.check_tokens_for_key("vip", 1, Some(&k)));
    }

    // ─── partial [rate_limit] config sections ────────────────────────────────

    #[test]
    fn partial_rate_limit_section_keeps_default_limits() {
        // A `[rate_limit]` section setting only `enabled` must NOT deserialize
        // the per-minute limits to None (= unlimited): omitted fields fall back
        // to the same values as `RateLimitConfig::default()`.
        let parsed: RateLimitConfig = toml::from_str("enabled = true").expect("partial section");
        let defaults = RateLimitConfig::default();
        assert_eq!(parsed.tokens_per_minute, defaults.tokens_per_minute);
        assert_eq!(parsed.requests_per_minute, defaults.requests_per_minute);
        assert_eq!(parsed.max_burst_per_second, defaults.max_burst_per_second);
        assert!(parsed.tokens_per_minute.is_some(), "must not be unlimited");
        assert!(parsed.requests_per_minute.is_some(), "must not be unlimited");
    }

    #[test]
    fn buckets_are_isolated_per_key() {
        let rl = RateLimiter::new(cfg(true, Some(1), None, 10_000));
        assert!(rl.check_request_for_key("alice", None));
        assert!(!rl.check_request_for_key("alice", None), "alice drained");
        // bob has his own fresh bucket.
        assert!(rl.check_request_for_key("bob", None));
    }

    // ─── per-key RBAC overrides ──────────────────────────────────────────────

    #[test]
    fn per_key_rpm_override_beats_global() {
        // Global rpm is 1, but this key's config raises it to 3.
        let rl = RateLimiter::new(cfg(true, Some(1), None, 10_000));
        let k = key_cfg("vip", Some(3), None);
        assert!(rl.check_request_for_key("vip", Some(&k)));
        assert!(rl.check_request_for_key("vip", Some(&k)));
        assert!(rl.check_request_for_key("vip", Some(&k)));
        assert!(
            !rl.check_request_for_key("vip", Some(&k)),
            "4th exceeds the per-key rpm-3 override"
        );
    }

    #[test]
    fn per_key_none_override_falls_back_to_global() {
        // key_cfg has no rpm override => the global rpm-1 applies.
        let rl = RateLimiter::new(cfg(true, Some(1), None, 10_000));
        let k = key_cfg("basic", None, None);
        assert!(rl.check_request_for_key("basic", Some(&k)));
        assert!(!rl.check_request_for_key("basic", Some(&k)));
    }

    #[test]
    fn per_key_tpm_override_beats_global() {
        let rl = RateLimiter::new(cfg(true, None, Some(10), 10_000));
        let k = key_cfg("vip", None, Some(1000));
        // Global tpm-10 would deny a 500-token request; the override admits it.
        assert!(rl.check_tokens_for_key("vip", 500, Some(&k)));
    }

    // ─── burst check ─────────────────────────────────────────────────────────

    #[test]
    fn burst_check_denies_beyond_capacity_in_one_instant() {
        let rl = RateLimiter::new(cfg(true, None, None, 3));
        assert!(rl.check_burst("k"));
        assert!(rl.check_burst("k"));
        assert!(rl.check_burst("k"));
        assert!(
            !rl.check_burst("k"),
            "4th within one instant exceeds burst 3"
        );
    }

    // ─── eviction ────────────────────────────────────────────────────────────

    #[test]
    fn evict_stale_with_zero_idle_clears_all_buckets() {
        let rl = RateLimiter::new(cfg(true, Some(5), Some(100), 5));
        rl.check_request_for_key("k", None);
        rl.check_tokens_for_key("k", 1, None);
        rl.check_burst("k");
        // A zero max_idle evicts every bucket whose last_refill is not strictly in
        // the future, i.e. all of them.
        rl.evict_stale(Duration::from_secs(0));
        // After eviction, a fresh full bucket is created — capacity is restored.
        for _ in 0..5 {
            assert!(rl.check_request_for_key("k", None));
        }
    }

    #[test]
    fn evict_stale_keeps_recent_buckets() {
        let rl = RateLimiter::new(cfg(true, Some(1), None, 5));
        assert!(rl.check_request_for_key("k", None));
        assert!(!rl.check_request_for_key("k", None), "drained");
        // A large idle window keeps the (just-touched) drained bucket, so the key
        // is still limited immediately after the sweep.
        rl.evict_stale(Duration::from_secs(3600));
        assert!(
            !rl.check_request_for_key("k", None),
            "bucket survived; still drained"
        );
    }

    // ─── RateLimiterRegistry swap seam ───────────────────────────────────────

    #[test]
    fn registry_builtin_active_by_default() {
        let reg = RateLimiterRegistry::new(cfg(true, Some(5), None, 5));
        assert_eq!(reg.active_id(), RateLimiterRegistry::BUILTIN);
        assert_eq!(reg.available(), vec![RateLimiterRegistry::BUILTIN]);
    }

    #[test]
    fn registry_delegates_to_active_backend() {
        let reg = RateLimiterRegistry::new(cfg(true, Some(1), None, 5));
        assert!(reg.check_request_for_key("k", None));
        assert!(!reg.check_request_for_key("k", None));
    }

    #[test]
    fn registry_set_active_unknown_is_false() {
        let mut reg = RateLimiterRegistry::new(cfg(true, Some(5), None, 5));
        assert!(!reg.set_active("nope"));
        assert_eq!(reg.active_id(), RateLimiterRegistry::BUILTIN);
    }

    #[test]
    fn registry_register_and_switch_backend() {
        let mut reg = RateLimiterRegistry::new(cfg(true, Some(5), None, 5));
        let fleet: Arc<dyn RateLimiterBackend> =
            Arc::new(RateLimiter::new(cfg(true, Some(1), None, 5)));
        reg.register("fleet", Arc::clone(&fleet));
        reg.register("fleet", fleet); // idempotent order
        assert_eq!(
            reg.available(),
            vec![
                RateLimiterRegistry::BUILTIN.to_string(),
                "fleet".to_string()
            ]
        );
        assert!(reg.set_active("fleet"));
        // The fleet backend has rpm 1 — one request then deny, proving the swap.
        assert!(reg.check_request_for_key("k", None));
        assert!(!reg.check_request_for_key("k", None));
    }
}
