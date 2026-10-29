//! Per-provider quota / rate-limit tracking (the "capacity" view).
//!
//! The gateway already governs the *caller* side (per-key rate limits, per-user
//! token budgets). This tracks the *upstream* side: what each provider's response
//! headers say about remaining quota and when it resets. Providers report what
//! they observe into this sink on every completion; the pipeline reads nothing
//! from it (it decides via the typed `ProviderError::RateLimited` /
//! `GatewayError::ProviderRateLimited` error), and `/metrics` snapshots it so the
//! desktop can render live remaining-quota countdowns.
//!
//! Mirrors the gateway's `CircuitBreakers` shape: a `DashMap`
//! keyed by provider name, wrapped in an `Arc` so the (immutable) provider
//! structs can hold a handle and write into it. It is a metrics sink, not a
//! decision maker — providers stay dumb, the pipeline stays the governor.

use std::time::{SystemTime, UNIX_EPOCH};

use dashmap::DashMap;
use serde_json::{json, Value};

/// A rate-limit / quota signal parsed from a provider's response headers.
/// Every field is optional because providers expose different subsets (OpenAI
/// sends `x-ratelimit-*`, Anthropic `anthropic-ratelimit-*`, most send
/// `retry-after` on a 429).
#[derive(Clone, Debug, Default)]
pub struct RateLimitInfo {
    /// Requests/tokens remaining in the current window.
    pub remaining: Option<u64>,
    /// The window's total limit.
    pub limit: Option<u64>,
    /// Unix seconds when the window resets, if reported.
    pub reset_at: Option<u64>,
    /// Seconds to wait before retrying (from `retry-after` on a 429).
    pub retry_after: Option<u64>,
}

impl RateLimitInfo {
    /// Whether any field is populated — used to skip recording empty signals.
    pub fn is_some(&self) -> bool {
        self.remaining.is_some()
            || self.limit.is_some()
            || self.reset_at.is_some()
            || self.retry_after.is_some()
    }
}

/// The last-observed quota state for one provider.
#[derive(Clone, Debug, Default)]
struct QuotaState {
    remaining: Option<u64>,
    limit: Option<u64>,
    reset_at: Option<u64>,
    retry_after: Option<u64>,
    /// Whether the most recent observation was a 429.
    rate_limited: bool,
    /// Unix seconds of the last update.
    updated_at: u64,
    window_seconds: Option<u64>,
}

/// One coherent header observation. Absent fields remain unknown instead of
/// combining stale remaining/limit values from different windows.
#[derive(Clone, Debug)]
pub struct QuotaObservation {
    pub remaining: Option<u64>,
    pub limit: Option<u64>,
    pub reset_at: Option<u64>,
    pub window_seconds: Option<u64>,
    pub observed_at: u64,
}

/// Live per-provider quota snapshot store. Cheap to clone the `Arc`.
#[derive(Default)]
pub struct ProviderQuotas {
    states: DashMap<String, QuotaState>,
    observations: DashMap<String, QuotaObservation>,
}

impl ProviderQuotas {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold a successful response's rate-limit headers into the provider's state.
    /// Only overwrites fields the provider actually reported, so a partial header
    /// set doesn't wipe previously-seen values.
    pub fn record_success(&self, provider: &str, info: &RateLimitInfo) {
        let mut e = self.states.entry(provider.to_string()).or_default();
        let previous_reset = e.reset_at;
        if let Some(reset) = info.reset_at {
            if let Some(previous) = previous_reset.filter(|previous| reset > *previous) {
                e.window_seconds = Some(reset - previous);
            }
        }
        // The routing view is a complete latest observation; the metrics view
        // below retains historical optional fields for display compatibility.
        self.observations.insert(
            provider.to_owned(),
            QuotaObservation {
                remaining: info.remaining,
                limit: info.limit,
                reset_at: info.reset_at,
                window_seconds: e.window_seconds,
                observed_at: now_secs(),
            },
        );
        if info.remaining.is_some() {
            e.remaining = info.remaining;
        }
        if info.limit.is_some() {
            e.limit = info.limit;
        }
        if info.reset_at.is_some() {
            e.reset_at = info.reset_at;
        }
        e.retry_after = None;
        e.rate_limited = false;
        e.updated_at = now_secs();
    }

    /// Record that the provider returned a 429, capturing its back-off hints.
    pub fn record_rate_limited(
        &self,
        provider: &str,
        retry_after: Option<u64>,
        reset_at: Option<u64>,
    ) {
        let mut e = self.states.entry(provider.to_string()).or_default();
        e.retry_after = retry_after;
        if reset_at.is_some() {
            e.reset_at = reset_at;
        }
        e.remaining = Some(0);
        e.rate_limited = true;
        e.updated_at = now_secs();
        self.observations.insert(
            provider.to_owned(),
            QuotaObservation {
                remaining: Some(0),
                limit: e.limit,
                reset_at,
                window_seconds: e.window_seconds,
                observed_at: e.updated_at,
            },
        );
    }

    pub fn observation(&self, provider: &str) -> Option<QuotaObservation> {
        self.observations.get(provider).map(|entry| entry.clone())
    }

    /// A JSON object keyed by provider name, each carrying its remaining quota and
    /// a live `reset_in_secs` countdown computed against the current time. Folded
    /// into the `/metrics` payload for the desktop cost/quota dashboard.
    pub fn snapshot(&self) -> Value {
        let now = now_secs();
        let mut map = serde_json::Map::new();
        for kv in self.states.iter() {
            let s = kv.value();
            let reset_in = s.reset_at.map(|r| r.saturating_sub(now));
            map.insert(
                kv.key().clone(),
                json!({
                    "remaining": s.remaining,
                    "limit": s.limit,
                    "reset_at": s.reset_at,
                    "reset_in_secs": reset_in,
                    "retry_after": s.retry_after,
                    "rate_limited": s.rate_limited,
                    "updated_at": s.updated_at,
                }),
            );
        }
        Value::Object(map)
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_info_is_some_detects_any_field() {
        assert!(!RateLimitInfo::default().is_some());
        assert!(RateLimitInfo {
            remaining: Some(1),
            ..Default::default()
        }
        .is_some());
        assert!(RateLimitInfo {
            limit: Some(1),
            ..Default::default()
        }
        .is_some());
        assert!(RateLimitInfo {
            reset_at: Some(1),
            ..Default::default()
        }
        .is_some());
        assert!(RateLimitInfo {
            retry_after: Some(1),
            ..Default::default()
        }
        .is_some());
    }

    #[test]
    fn routing_observation_does_not_pair_new_remaining_with_old_limit() {
        let quotas = ProviderQuotas::new();
        quotas.record_success(
            "openai",
            &RateLimitInfo {
                remaining: Some(10),
                limit: Some(100),
                reset_at: Some(1000),
                retry_after: None,
            },
        );
        quotas.record_success(
            "openai",
            &RateLimitInfo {
                remaining: Some(20),
                ..Default::default()
            },
        );
        let observed = quotas.observation("openai").unwrap();
        assert_eq!(observed.remaining, Some(20));
        assert_eq!(observed.limit, None);
        assert_eq!(observed.reset_at, None);
    }

    #[test]
    fn routing_window_requires_two_reported_reset_boundaries() {
        let quotas = ProviderQuotas::new();
        quotas.record_success(
            "openai",
            &RateLimitInfo {
                reset_at: Some(1000),
                ..Default::default()
            },
        );
        assert_eq!(quotas.observation("openai").unwrap().window_seconds, None);
        quotas.record_success(
            "openai",
            &RateLimitInfo {
                reset_at: Some(1060),
                ..Default::default()
            },
        );
        assert_eq!(
            quotas.observation("openai").unwrap().window_seconds,
            Some(60)
        );
    }

    #[test]
    fn record_success_stores_reported_fields() {
        let q = ProviderQuotas::new();
        q.record_success(
            "openai",
            &RateLimitInfo {
                remaining: Some(500),
                limit: Some(1000),
                reset_at: Some(now_secs() + 60),
                retry_after: None,
            },
        );
        let snap = q.snapshot();
        assert_eq!(snap["openai"]["remaining"], json!(500));
        assert_eq!(snap["openai"]["limit"], json!(1000));
        assert_eq!(snap["openai"]["rate_limited"], json!(false));
        // reset_in_secs is a live countdown (<= 60, > 0) derived from reset_at.
        let reset_in = snap["openai"]["reset_in_secs"].as_u64().unwrap();
        assert!(reset_in <= 60 && reset_in > 0, "reset_in={reset_in}");
    }

    #[test]
    fn record_success_partial_headers_do_not_wipe_prior_values() {
        let q = ProviderQuotas::new();
        q.record_success(
            "p",
            &RateLimitInfo {
                remaining: Some(500),
                limit: Some(1000),
                ..Default::default()
            },
        );
        // A later success reports only `remaining` — `limit` must survive.
        q.record_success(
            "p",
            &RateLimitInfo {
                remaining: Some(400),
                ..Default::default()
            },
        );
        let snap = q.snapshot();
        assert_eq!(snap["p"]["remaining"], json!(400));
        assert_eq!(snap["p"]["limit"], json!(1000));
    }

    #[test]
    fn record_rate_limited_sets_flag_and_zero_remaining() {
        let q = ProviderQuotas::new();
        let reset = now_secs() + 30;
        q.record_rate_limited("anthropic", Some(15), Some(reset));
        let snap = q.snapshot();
        assert_eq!(snap["anthropic"]["rate_limited"], json!(true));
        assert_eq!(snap["anthropic"]["remaining"], json!(0));
        assert_eq!(snap["anthropic"]["retry_after"], json!(15));
        assert_eq!(snap["anthropic"]["reset_at"], json!(reset));
    }

    #[test]
    fn success_after_rate_limit_clears_flag_and_retry_after() {
        let q = ProviderQuotas::new();
        q.record_rate_limited("p", Some(20), None);
        q.record_success(
            "p",
            &RateLimitInfo {
                remaining: Some(100),
                ..Default::default()
            },
        );
        let snap = q.snapshot();
        assert_eq!(snap["p"]["rate_limited"], json!(false));
        // record_success unconditionally clears retry_after.
        assert_eq!(snap["p"]["retry_after"], Value::Null);
    }

    #[test]
    fn snapshot_reset_in_secs_saturates_to_zero_for_past_reset() {
        let q = ProviderQuotas::new();
        // A reset instant in the past must not underflow — saturating_sub → 0.
        q.record_rate_limited("p", Some(1), Some(1));
        let snap = q.snapshot();
        assert_eq!(snap["p"]["reset_in_secs"], json!(0));
    }

    #[test]
    fn snapshot_of_empty_store_is_empty_object() {
        let q = ProviderQuotas::new();
        assert_eq!(q.snapshot(), json!({}));
    }
}
