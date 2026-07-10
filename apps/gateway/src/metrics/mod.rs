use std::sync::atomic::{AtomicU64, Ordering};

use dashmap::DashMap;
use serde_json::{json, Value};

/// In-memory metrics counters.  All increments use `Relaxed` ordering — exact
/// consistency is not required for operational dashboards.
#[derive(Default)]
pub struct Metrics {
    pub total_requests: AtomicU64,
    pub total_errors: AtomicU64,
    pub cache_hits: AtomicU64,
    pub cache_misses: AtomicU64,
    pub rate_limited: AtomicU64,
    pub firewall_blocked: AtomicU64,
    pub total_input_tokens: AtomicU64,
    pub total_output_tokens: AtomicU64,
    /// Aggregated tokens saved by context compression (egress transform).
    pub compression_tokens_saved: AtomicU64,
    pub budget_exceeded: AtomicU64,
    pub budget_notified: AtomicU64,
    pub budget_downgraded: AtomicU64,
    pub budget_restricted: AtomicU64,
    pub composio_calls: AtomicU64,
    pub semantic_cache_hits: AtomicU64,
    /// Requests served by a fallback provider (primary circuit was open).
    pub degraded_fallback: AtomicU64,
    /// Requests that exhausted the entire fallback chain (all providers unavailable).
    pub degraded_exhausted: AtomicU64,
    provider_requests: DashMap<String, u64>,
    provider_errors: DashMap<String, u64>,
}

impl Metrics {
    pub fn inc_requests(&self) {
        self.total_requests.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_errors(&self) {
        self.total_errors.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_cache_hit(&self) {
        self.cache_hits.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_cache_miss(&self) {
        self.cache_misses.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_rate_limited(&self) {
        self.rate_limited.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_firewall_blocked(&self) {
        self.firewall_blocked.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_budget_exceeded(&self) {
        self.budget_exceeded.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_budget_notified(&self) {
        self.budget_notified.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_budget_downgraded(&self) {
        self.budget_downgraded.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_budget_restricted(&self) {
        self.budget_restricted.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_composio_calls(&self) {
        self.composio_calls.fetch_add(1, Ordering::Relaxed);
    }
    pub fn inc_semantic_cache_hit(&self) {
        self.semantic_cache_hits.fetch_add(1, Ordering::Relaxed);
    }
    /// Increment the counter for requests served by a fallback provider (degraded
    /// path AC3 of #218).
    pub fn inc_degraded_fallback(&self) {
        self.degraded_fallback.fetch_add(1, Ordering::Relaxed);
    }
    /// Increment the counter for requests that exhausted the entire fallback chain
    /// (AC3 of #218).
    pub fn inc_degraded_exhausted(&self) {
        self.degraded_exhausted.fetch_add(1, Ordering::Relaxed);
    }
    pub fn add_tokens(&self, input: u64, output: u64) {
        self.total_input_tokens.fetch_add(input, Ordering::Relaxed);
        self.total_output_tokens
            .fetch_add(output, Ordering::Relaxed);
    }
    /// Add to the aggregated context-compression tokens-saved counter.
    pub fn add_compression_saved(&self, n: u64) {
        self.compression_tokens_saved
            .fetch_add(n, Ordering::Relaxed);
    }
    pub fn inc_provider_request(&self, provider: &str) {
        *self
            .provider_requests
            .entry(provider.to_string())
            .or_insert(0) += 1;
    }
    pub fn inc_provider_error(&self, provider: &str) {
        *self
            .provider_errors
            .entry(provider.to_string())
            .or_insert(0) += 1;
    }

    /// Return a JSON snapshot of all counters.
    ///
    /// Pass the evals runner to include per-provider rolling scores in the
    /// snapshot under the `"evals"` key. Existing consumers that call
    /// `snapshot()` without evals (e.g. unit tests) still work unchanged.
    pub fn snapshot(&self) -> Value {
        self.snapshot_with_evals(None)
    }

    /// Like [`snapshot`] but includes an `"evals"` object sourced from the
    /// provided runner and an optional `"provider_health"` map from the circuit
    /// breaker. Called by the metrics handler so that `/metrics` and
    /// `/v1/metrics` expose both without requiring separate round-trips.
    pub fn snapshot_with_evals(
        &self,
        evals: Option<(&std::collections::HashMap<String, f32>, bool, f32, u64)>,
    ) -> Value {
        self.snapshot_with_evals_and_health(evals, None)
    }

    /// Full snapshot with evals and per-provider circuit-breaker health.
    pub fn snapshot_with_evals_and_health(
        &self,
        evals: Option<(&std::collections::HashMap<String, f32>, bool, f32, u64)>,
        provider_health: Option<
            &std::collections::HashMap<String, crate::circuit_breaker::ProviderHealthSnapshot>,
        >,
    ) -> Value {
        let hits = self.cache_hits.load(Ordering::Relaxed);
        let misses = self.cache_misses.load(Ordering::Relaxed);
        let total_cache = hits + misses;
        let hit_rate = if total_cache == 0 {
            0.0_f64
        } else {
            hits as f64 / total_cache as f64
        };

        let provider_requests: std::collections::HashMap<String, u64> = self
            .provider_requests
            .iter()
            .map(|e| (e.key().clone(), *e.value()))
            .collect();
        let provider_errors: std::collections::HashMap<String, u64> = self
            .provider_errors
            .iter()
            .map(|e| (e.key().clone(), *e.value()))
            .collect();

        let evals_value = match evals {
            Some((scores, enabled, sample_rate, sampled)) => json!({
                "enabled":     enabled,
                "sample_rate": sample_rate,
                "sampled":     sampled,
                "providers":   scores,
            }),
            None => json!({
                "enabled": false,
                "providers": {},
            }),
        };

        let health_value = match provider_health {
            Some(health) => serde_json::to_value(health).unwrap_or(json!({})),
            None => json!({}),
        };

        json!({
            "requests": {
                "total":            self.total_requests.load(Ordering::Relaxed),
                "errors":           self.total_errors.load(Ordering::Relaxed),
                "rate_limited":     self.rate_limited.load(Ordering::Relaxed),
                "firewall_blocked": self.firewall_blocked.load(Ordering::Relaxed),
                "budget_exceeded":  self.budget_exceeded.load(Ordering::Relaxed),
                "budget_notified":  self.budget_notified.load(Ordering::Relaxed),
                "budget_downgraded": self.budget_downgraded.load(Ordering::Relaxed),
                "budget_restricted": self.budget_restricted.load(Ordering::Relaxed),
                "degraded_fallback": self.degraded_fallback.load(Ordering::Relaxed),
                "degraded_exhausted": self.degraded_exhausted.load(Ordering::Relaxed),
            },
            "cache": {
                "exact_hits":    hits,
                "semantic_hits": self.semantic_cache_hits.load(Ordering::Relaxed),
                "misses":        misses,
                "hit_rate":      hit_rate,
            },
            "tokens": {
                "input":  self.total_input_tokens.load(Ordering::Relaxed),
                "output": self.total_output_tokens.load(Ordering::Relaxed),
            },
            "composio": {
                "calls": self.composio_calls.load(Ordering::Relaxed),
            },
            "providers": {
                "requests": provider_requests,
                "errors":   provider_errors,
            },
            "evals": evals_value,
            "provider_health": health_value,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn snapshot_without_evals_includes_disabled_evals_block() {
        let metrics = Metrics::default();
        let snap = metrics.snapshot();

        let evals = snap.get("evals").expect("evals key present");
        assert_eq!(evals["enabled"], false);
        assert!(
            evals["providers"]
                .as_object()
                .expect("providers is object")
                .is_empty(),
            "providers must be empty when evals not supplied"
        );
    }

    #[test]
    fn snapshot_with_evals_includes_provider_scores() {
        let metrics = Metrics::default();
        metrics.inc_requests();
        metrics.inc_cache_hit();

        let mut scores: HashMap<String, f32> = HashMap::new();
        scores.insert("openai".to_string(), 0.85);
        scores.insert("anthropic".to_string(), 0.72);

        let snap = metrics.snapshot_with_evals(Some((&scores, true, 0.5, 42)));

        assert_eq!(snap["requests"]["total"], 1);
        assert_eq!(snap["cache"]["exact_hits"], 1);

        let evals = snap.get("evals").expect("evals key present");
        assert_eq!(evals["enabled"], true);
        assert!((evals["sample_rate"].as_f64().unwrap() - 0.5).abs() < 1e-6);
        assert_eq!(evals["sampled"], 42);

        let providers = evals["providers"].as_object().expect("providers is object");
        assert_eq!(providers.len(), 2);
        assert!((providers["openai"].as_f64().unwrap() - 0.85).abs() < 1e-3);
        assert!((providers["anthropic"].as_f64().unwrap() - 0.72).abs() < 1e-3);
    }

    #[test]
    fn snapshot_with_evals_disabled_returns_empty_providers() {
        let metrics = Metrics::default();
        let scores: HashMap<String, f32> = HashMap::new();
        let snap = metrics.snapshot_with_evals(Some((&scores, false, 1.0, 0)));

        let evals = snap.get("evals").expect("evals key present");
        assert_eq!(evals["enabled"], false);
        assert!(evals["providers"]
            .as_object()
            .expect("providers is object")
            .is_empty());
    }

    /// AC3 (#218): degraded_fallback and degraded_exhausted counters are
    /// incremented independently and visible in the metrics snapshot.
    #[test]
    fn degraded_counters_increment_independently_and_appear_in_snapshot() {
        let metrics = Metrics::default();

        // Initially both are zero.
        let snap = metrics.snapshot();
        assert_eq!(snap["requests"]["degraded_fallback"], 0);
        assert_eq!(snap["requests"]["degraded_exhausted"], 0);

        metrics.inc_degraded_fallback();
        metrics.inc_degraded_fallback();
        metrics.inc_degraded_exhausted();

        let snap = metrics.snapshot();
        assert_eq!(
            snap["requests"]["degraded_fallback"], 2,
            "degraded_fallback must count each fallback-served request"
        );
        assert_eq!(
            snap["requests"]["degraded_exhausted"], 1,
            "degraded_exhausted must count each chain-exhausted request"
        );
    }
}
