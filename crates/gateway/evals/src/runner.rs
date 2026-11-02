//! The live per-request runner: deterministic sampling and the provider-score EMA.

use std::sync::atomic::{AtomicU64, Ordering};

use dashmap::DashMap;
use serde_json::Value;
use tracing::debug;

use crate::config::EvalsConfig;

/// Scores for a single completed request.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct EvalResult {
    /// 1.0 = instant, 0.0 = at or beyond `max_latency_ms`.
    pub latency_score: f32,
    /// Ratio of output tokens to input tokens, clamped to [0, 1].
    /// Higher means the model produced proportionally more output (loosely useful).
    pub token_efficiency: f32,
    /// Whether the request passed all firewall/policy checks.
    pub policy_pass: bool,
    /// Weighted overall score: 0.4·latency + 0.3·token_eff + 0.3·policy.
    pub overall: f32,
}

/// Rolling exponential-moving-average score for a single provider.
///
/// Stored as a fixed-point `u64` (score × `SCALE`) so it can live in a lock-free
/// `DashMap` and be read on the (hot) routing path without taking a mutex.
struct ProviderScore {
    /// EMA of `overall`, fixed-point (× `SCALE`).
    ema: AtomicU64,
    /// Number of scored samples that have fed this average.
    samples: AtomicU64,
}

const SCALE: f32 = 1_000_000.0;
/// Weight given to each new sample in the EMA. Smaller = smoother/slower.
const EMA_ALPHA: f32 = 0.2;

pub struct EvalsRunner {
    config: EvalsConfig,
    /// Provider name → rolling eval score. Feeds eval-driven routing.
    provider_scores: DashMap<String, ProviderScore>,
    /// Monotonic counter used for deterministic sampling without an RNG dep.
    sample_counter: AtomicU64,
}

impl EvalsRunner {
    pub fn new(config: EvalsConfig) -> Self {
        Self {
            config,
            provider_scores: DashMap::new(),
            sample_counter: AtomicU64::new(0),
        }
    }

    /// Decide whether the current request should be scored.
    ///
    /// Returns `false` when evals are disabled or the configured `sample_rate`
    /// excludes this request. Sampling is deterministic and evenly spaced so a
    /// rate of `0.25` scores roughly one request in four.
    pub fn should_sample(&self) -> bool {
        if !self.config.enabled {
            return false;
        }
        let rate = self.config.sample_rate.clamp(0.0, 1.0);
        if rate >= 1.0 {
            return true;
        }
        if rate <= 0.0 {
            return false;
        }

        // Evenly-spaced deterministic sampling: increment a counter and keep the
        // request whenever crossing a 1/rate boundary.
        let n = self.sample_counter.fetch_add(1, Ordering::Relaxed);
        let period = (1.0 / rate).round().max(1.0) as u64;
        n % period == 0
    }

    /// Score a completed (non-streaming) response.
    ///
    /// Returns `None` when evals are disabled. Callers gate this with
    /// [`should_sample`](Self::should_sample); it does not re-check the rate.
    pub fn score(
        &self,
        latency_ms: u64,
        response: &Value,
        policy_pass: bool,
    ) -> Option<EvalResult> {
        if !self.config.enabled {
            return None;
        }

        let max = self.config.max_latency_ms as f32;
        let latency_score = if max == 0.0 {
            1.0
        } else {
            (1.0 - (latency_ms as f32 / max)).clamp(0.0, 1.0)
        };

        let input_tokens = response["usage"]["prompt_tokens"]
            .as_u64()
            .unwrap_or(1)
            .max(1) as f32;
        let output_tokens = response["usage"]["completion_tokens"].as_u64().unwrap_or(0) as f32;
        // Normalise to [0, 1]: clamp ratio at 2× (very verbose) = 1.0.
        let token_efficiency = (output_tokens / input_tokens / 2.0).clamp(0.0, 1.0);

        let policy_score = if policy_pass { 1.0_f32 } else { 0.0 };

        let overall = 0.4 * latency_score + 0.3 * token_efficiency + 0.3 * policy_score;

        debug!(
            latency_ms,
            latency_score, token_efficiency, policy_pass, overall, "eval scores"
        );

        Some(EvalResult {
            latency_score,
            token_efficiency,
            policy_pass,
            overall,
        })
    }

    /// Fold a fresh `overall` score into the rolling average for `provider`.
    /// This is what closes the loop: routing later reads these averages.
    pub fn record_provider_score(&self, provider: &str, overall: f32) {
        let entry = self
            .provider_scores
            .entry(provider.to_string())
            .or_insert_with(|| ProviderScore {
                ema: AtomicU64::new((overall * SCALE) as u64),
                samples: AtomicU64::new(0),
            });

        let prev_samples = entry.samples.fetch_add(1, Ordering::Relaxed);
        if prev_samples == 0 {
            // First sample seeds the EMA directly (already done above when newly
            // inserted, but an existing zero-sample entry needs the seed too).
            entry.ema.store((overall * SCALE) as u64, Ordering::Relaxed);
            return;
        }

        let prev = entry.ema.load(Ordering::Relaxed) as f32 / SCALE;
        let next = (1.0 - EMA_ALPHA) * prev + EMA_ALPHA * overall;
        entry.ema.store((next * SCALE) as u64, Ordering::Relaxed);
    }

    /// Snapshot every provider's current rolling eval score (those scored at
    /// least once). Used by the control-plane reporter to push eval data up.
    pub fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
        self.provider_scores
            .iter()
            .filter(|e| e.value().samples.load(Ordering::Relaxed) > 0)
            .map(|e| {
                let score = e.value().ema.load(Ordering::Relaxed) as f32 / SCALE;
                (e.key().clone(), score)
            })
            .collect()
    }

    /// Total number of requests that have been considered for sampling (regardless
    /// of whether they were actually scored). Used by metrics consumers to report
    /// sampling throughput.
    pub fn sampled_count(&self) -> u64 {
        self.sample_counter.load(Ordering::Relaxed)
    }

    /// Current rolling eval score for `provider`, if it has been scored at least
    /// once. Used by eval-driven routing to pick the leader.
    pub fn provider_score(&self, provider: &str) -> Option<f32> {
        self.provider_scores.get(provider).and_then(|s| {
            if s.samples.load(Ordering::Relaxed) == 0 {
                None
            } else {
                Some(s.ema.load(Ordering::Relaxed) as f32 / SCALE)
            }
        })
    }
}

#[cfg(test)]
#[path = "runner_tests.rs"]
mod tests;
