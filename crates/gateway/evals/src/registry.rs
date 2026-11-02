//! The runner as a swappable [`EvalsBackend`] behind an id-keyed registry.

use serde_json::Value;

use crate::config::EvalsConfig;
use crate::runner::{EvalResult, EvalsRunner};

// ─── Swappable evals backend (Lg decomposition) ──────────────────────────────

/// The live eval runner (per-request sampling + provider-score EMA) as a
/// swappable capability. The built-in [`EvalsRunner`] is the default; an
/// alternative scorer can register without touching the pipeline, mirroring the
/// gateway `providers::ProviderRegistry` inversion. The pure dataset scorers
/// (`score_case`, `aggregate_scores`, `builtin_dataset`, …) stay free module
/// functions — they are backend-independent and their call sites name them
/// directly.
pub trait EvalsBackend: Send + Sync {
    /// Whether the current request should be scored.
    fn should_sample(&self) -> bool;
    /// Score a completed non-streaming response (`None` when disabled).
    fn score(&self, latency_ms: u64, response: &Value, policy_pass: bool) -> Option<EvalResult>;
    /// Fold a fresh `overall` score into `provider`'s rolling average.
    fn record_provider_score(&self, provider: &str, overall: f32);
    /// Snapshot every scored provider's rolling eval score.
    fn all_provider_scores(&self) -> std::collections::HashMap<String, f32>;
    /// Total requests considered for sampling.
    fn sampled_count(&self) -> u64;
    /// Current rolling eval score for `provider`, if scored at least once.
    fn provider_score(&self, provider: &str) -> Option<f32>;
}

impl EvalsBackend for EvalsRunner {
    fn should_sample(&self) -> bool {
        EvalsRunner::should_sample(self)
    }
    fn score(&self, latency_ms: u64, response: &Value, policy_pass: bool) -> Option<EvalResult> {
        EvalsRunner::score(self, latency_ms, response, policy_pass)
    }
    fn record_provider_score(&self, provider: &str, overall: f32) {
        EvalsRunner::record_provider_score(self, provider, overall);
    }
    fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
        EvalsRunner::all_provider_scores(self)
    }
    fn sampled_count(&self) -> u64 {
        EvalsRunner::sampled_count(self)
    }
    fn provider_score(&self, provider: &str) -> Option<f32> {
        EvalsRunner::provider_score(self, provider)
    }
}

/// Id-keyed registry over [`EvalsBackend`] implementations. The built-in
/// [`EvalsRunner`] is registered first under [`EvalsRegistry::BUILTIN`] and
/// active by default, so behavior is byte-identical with no config change.
/// Delegating verbs forward to the active backend, keeping every call site
/// unchanged.
pub struct EvalsRegistry {
    backends: std::collections::HashMap<String, std::sync::Arc<dyn EvalsBackend>>,
    order: Vec<String>,
    active_id: String,
    active: std::sync::Arc<dyn EvalsBackend>,
}

impl EvalsRegistry {
    /// Stable id of the built-in eval runner.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering a fresh built-in
    /// [`EvalsRunner`] as the default active backend.
    pub fn new(config: EvalsConfig) -> Self {
        Self::from_runner(EvalsRunner::new(config))
    }

    /// Build the registry around an already-constructed [`EvalsRunner`],
    /// registering it as the built-in active backend. Lets a caller (e.g. a test)
    /// keep a handle to the exact runner the pipeline will use.
    pub fn from_runner(runner: EvalsRunner) -> Self {
        let builtin: std::sync::Arc<dyn EvalsBackend> = std::sync::Arc::new(runner);
        let mut registry = Self {
            backends: std::collections::HashMap::new(),
            order: Vec::new(),
            active_id: Self::BUILTIN.to_string(),
            active: std::sync::Arc::clone(&builtin),
        };
        registry.register(Self::BUILTIN, builtin);
        registry
    }

    /// Register a backend under a stable id (open extension point). Re-registering
    /// replaces in place; refreshes the live handle if it is the active id.
    pub fn register(&mut self, id: impl Into<String>, backend: std::sync::Arc<dyn EvalsBackend>) {
        let id = id.into();
        if !self.backends.contains_key(&id) {
            self.order.push(id.clone());
        }
        let is_active = id == self.active_id;
        self.backends.insert(id, std::sync::Arc::clone(&backend));
        if is_active {
            self.active = backend;
        }
    }

    /// Select the active backend by id. `false` (unchanged) if `id` is unknown.

    pub fn set_active(&mut self, id: &str) -> bool {
        match self.backends.get(id) {
            Some(backend) => {
                self.active = std::sync::Arc::clone(backend);
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

    // ─── Delegating verbs (byte-identical call sites) ────────────────────────

    /// See [`EvalsBackend::should_sample`].
    pub fn should_sample(&self) -> bool {
        self.active.should_sample()
    }

    /// See [`EvalsBackend::score`].
    pub fn score(
        &self,
        latency_ms: u64,
        response: &Value,
        policy_pass: bool,
    ) -> Option<EvalResult> {
        self.active.score(latency_ms, response, policy_pass)
    }

    /// See [`EvalsBackend::record_provider_score`].
    pub fn record_provider_score(&self, provider: &str, overall: f32) {
        self.active.record_provider_score(provider, overall);
    }

    /// See [`EvalsBackend::all_provider_scores`].
    pub fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
        self.active.all_provider_scores()
    }

    /// See [`EvalsBackend::sampled_count`].
    pub fn sampled_count(&self) -> u64 {
        self.active.sampled_count()
    }

    /// See [`EvalsBackend::provider_score`].
    pub fn provider_score(&self, provider: &str) -> Option<f32> {
        self.active.provider_score(provider)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixed(f32);

    impl EvalsBackend for Fixed {
        fn should_sample(&self) -> bool {
            false
        }
        fn score(&self, _: u64, _: &Value, _: bool) -> Option<EvalResult> {
            None
        }
        fn record_provider_score(&self, _: &str, _: f32) {}
        fn all_provider_scores(&self) -> std::collections::HashMap<String, f32> {
            std::collections::HashMap::new()
        }
        fn sampled_count(&self) -> u64 {
            7
        }
        fn provider_score(&self, _: &str) -> Option<f32> {
            Some(self.0)
        }
    }

    /// The built-in runner is active until another registered id is chosen;
    /// an unknown id leaves the active backend unchanged.
    #[test]
    fn delegating_verbs_follow_the_active_backend() {
        let mut registry = EvalsRegistry::new(EvalsConfig::default());
        assert_eq!(registry.active_id(), EvalsRegistry::BUILTIN);
        assert!(registry.should_sample());
        assert_eq!(registry.provider_score("p"), None);

        registry.register("fixed", std::sync::Arc::new(Fixed(0.25)));
        assert_eq!(registry.available(), vec!["builtin", "fixed"]);
        assert!(!registry.set_active("missing"));
        assert_eq!(registry.active_id(), EvalsRegistry::BUILTIN);

        assert!(registry.set_active("fixed"));
        assert!(!registry.should_sample());
        assert_eq!(registry.sampled_count(), 7);
        assert_eq!(registry.provider_score("p"), Some(0.25));
    }
}
