//! Per-session token buckets for brokered requests.
//!
//! Each session refills at `rps` tokens per second up to `burst`; a request
//! with no token left gets a 429 with `Retry-After`. Buckets are in memory and
//! idle ones are dropped once the map grows past [`MAX_BUCKETS`].

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_BUCKETS: usize = 4096;

struct Bucket {
    tokens: f64,
    updated: Instant,
}

/// A keyed token-bucket limiter.
pub struct RateLimiter {
    rps: f64,
    burst: f64,
    buckets: Mutex<HashMap<String, Bucket>>,
}

impl RateLimiter {
    pub fn new(rps: f64, burst: f64) -> Self {
        Self {
            rps: rps.max(0.001),
            burst: burst.max(1.0),
            buckets: Mutex::new(HashMap::new()),
        }
    }

    /// Take one token for `key`, or return how long until one is available.
    pub fn check(&self, key: &str) -> Result<(), Duration> {
        self.check_at(key, Instant::now())
    }

    fn check_at(&self, key: &str, now: Instant) -> Result<(), Duration> {
        let Ok(mut buckets) = self.buckets.lock() else {
            // Fail closed if another thread panicked mid-update.
            return Err(Duration::from_secs(1));
        };
        if buckets.len() >= MAX_BUCKETS && !buckets.contains_key(key) {
            let full = self.burst;
            let rps = self.rps;
            buckets.retain(|_, bucket| {
                bucket.tokens + now.duration_since(bucket.updated).as_secs_f64() * rps < full
            });
        }
        let bucket = buckets.entry(key.to_owned()).or_insert(Bucket {
            tokens: self.burst,
            updated: now,
        });
        let elapsed = now.saturating_duration_since(bucket.updated).as_secs_f64();
        bucket.tokens = (bucket.tokens + elapsed * self.rps).min(self.burst);
        bucket.updated = now;
        if bucket.tokens >= 1.0 {
            bucket.tokens -= 1.0;
            Ok(())
        } else {
            Err(Duration::from_secs_f64((1.0 - bucket.tokens) / self.rps))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_drain_refill_and_are_per_key() {
        let limiter = RateLimiter::new(2.0, 3.0);
        let start = Instant::now();
        for _ in 0..3 {
            assert!(limiter.check_at("a", start).is_ok());
        }
        let wait = limiter.check_at("a", start).unwrap_err();
        assert!(wait > Duration::ZERO && wait <= Duration::from_millis(500));
        assert!(limiter.check_at("b", start).is_ok());
        assert!(limiter
            .check_at("a", start + Duration::from_millis(600))
            .is_ok());
        assert!(limiter
            .check_at("a", start + Duration::from_millis(600))
            .is_err());
    }
}
