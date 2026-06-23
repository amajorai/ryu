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
