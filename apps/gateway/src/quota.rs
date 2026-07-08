//! Per-provider quota / rate-limit tracking (the "capacity" view).
//!
//! The gateway already governs the *caller* side (per-key rate limits, per-user
//! token budgets). This tracks the *upstream* side: what each provider's response
//! headers say about remaining quota and when it resets. Providers report what
//! they observe into this sink on every completion; the pipeline reads nothing
//! from it (it decides via the typed [`crate::error::GatewayError::ProviderRateLimited`]
//! error), and `/metrics` snapshots it so the desktop can render live
//! remaining-quota countdowns.
//!
//! Mirrors the [`crate::circuit_breaker::CircuitBreakers`] shape: a `DashMap`
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
}

/// Live per-provider quota snapshot store. Cheap to clone the `Arc`.
#[derive(Default)]
pub struct ProviderQuotas {
    states: DashMap<String, QuotaState>,
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
