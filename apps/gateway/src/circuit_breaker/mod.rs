use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::CircuitBreakerConfig;

#[derive(Debug, Clone)]
enum CircuitState {
    /// Normal operation.
    Closed { consecutive_failures: u32 },
    /// Circuit tripped; all requests are rejected immediately.
    Open { opened_at: Instant },
    /// One probe request allowed through to test if provider has recovered.
    /// `probe_in_flight` is true while that single probe is outstanding; further
    /// requests are rejected until the probe resolves via record_success (→ Closed)
    /// or record_failure (→ Open).
    HalfOpen { probe_in_flight: bool },
}

/// Public snapshot of a single provider's circuit-breaker state.
/// Serialised to the `/metrics` response under `provider_health`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealthSnapshot {
    /// `"closed"` | `"open"` | `"half_open"`
    pub circuit: String,
    /// Consecutive failures recorded while the circuit was Closed.
    /// `0` once the circuit trips (the count is superseded by `circuit`).
    pub consecutive_failures: u32,
    /// Seconds since the circuit was opened, `null` when not Open.
    pub open_for_secs: Option<u64>,
}

pub struct CircuitBreakers {
    // Keyed by the provider's open registry id (owned `String`), so a provider
    // registered under a novel runtime id is trackable — not limited to the
    // former closed set of `&'static str` names.
    states: DashMap<String, CircuitState>,
    config: CircuitBreakerConfig,
}

impl CircuitBreakers {
    pub fn new(config: CircuitBreakerConfig) -> Self {
        Self {
            states: DashMap::new(),
            config,
        }
    }

    /// Returns `true` if the circuit is open and this provider should be skipped.
    pub fn is_open(&self, provider: &str) -> bool {
        if !self.config.enabled {
            return false;
        }

        let reset_timeout = Duration::from_secs(self.config.reset_timeout_secs);

        let mut entry = self
            .states
            .entry(provider.to_string())
            .or_insert(CircuitState::Closed {
                consecutive_failures: 0,
            });

        match *entry {
            CircuitState::Closed { .. } => false,
            CircuitState::HalfOpen {
                probe_in_flight: true,
            } => {
                // A probe is already outstanding; reject further concurrent
                // requests until it resolves via record_success/record_failure.
                true
            }
            CircuitState::HalfOpen {
                probe_in_flight: false,
            } => {
                // No probe currently in flight (shouldn't normally be observed —
                // record_success/record_failure always move out of HalfOpen —
                // but handled for completeness): admit this caller as the probe.
                *entry = CircuitState::HalfOpen {
                    probe_in_flight: true,
                };
                false
            }
            CircuitState::Open { opened_at } => {
                if opened_at.elapsed() >= reset_timeout {
                    // Transition to half-open; allow exactly one probe request
                    // through (this caller), then gate everyone else out.
                    *entry = CircuitState::HalfOpen {
                        probe_in_flight: true,
                    };
                    info!(
                        provider,
                        "circuit breaker: half-open, allowing probe request"
                    );
                    false
                } else {
                    true
                }
            }
        }
    }

    /// Record a successful provider response. Closes the circuit.
    pub fn record_success(&self, provider: &str) {
        if !self.config.enabled {
            return;
        }
        let was_open = matches!(
            self.states.get(provider).as_deref(),
            Some(CircuitState::HalfOpen { .. } | CircuitState::Open { .. })
        );
        self.states.insert(
            provider.to_string(),
            CircuitState::Closed {
                consecutive_failures: 0,
            },
        );
        if was_open {
            info!(provider, "circuit breaker: closed after successful probe");
        }
    }

    /// Return a health snapshot for every provider whose circuit state has been
    /// observed (i.e. at least one `is_open`, `record_success`, or
    /// `record_failure` call has been made for that provider).
    pub fn snapshot(&self) -> std::collections::HashMap<String, ProviderHealthSnapshot> {
        self.states
            .iter()
            .map(|entry| {
                let name = entry.key().to_string();
                let snap = match *entry.value() {
                    CircuitState::Closed {
                        consecutive_failures,
                    } => ProviderHealthSnapshot {
                        circuit: "closed".to_string(),
                        consecutive_failures,
                        open_for_secs: None,
                    },
                    CircuitState::Open { opened_at } => ProviderHealthSnapshot {
                        circuit: "open".to_string(),
                        consecutive_failures: 0,
                        open_for_secs: Some(opened_at.elapsed().as_secs()),
                    },
                    CircuitState::HalfOpen { .. } => ProviderHealthSnapshot {
                        circuit: "half_open".to_string(),
                        consecutive_failures: 0,
                        open_for_secs: None,
                    },
                };
                (name, snap)
            })
            .collect()
    }

    /// Record a provider failure. Opens the circuit after `failure_threshold` consecutive failures.
    pub fn record_failure(&self, provider: &str) {
        if !self.config.enabled {
            return;
        }
        let mut entry = self
            .states
            .entry(provider.to_string())
            .or_insert(CircuitState::Closed {
                consecutive_failures: 0,
            });

        *entry = match *entry {
            CircuitState::Closed {
                consecutive_failures,
            } => {
                let next = consecutive_failures + 1;
                if next >= self.config.failure_threshold {
                    warn!(
                        provider,
                        failures = next,
                        "circuit breaker: opening circuit"
                    );
                    CircuitState::Open {
                        opened_at: Instant::now(),
                    }
                } else {
                    CircuitState::Closed {
                        consecutive_failures: next,
                    }
                }
            }
            // A failure during half-open immediately re-opens
            CircuitState::HalfOpen { .. } => {
                warn!(
                    provider,
                    "circuit breaker: probe failed, re-opening circuit"
                );
                CircuitState::Open {
                    opened_at: Instant::now(),
                }
            }
            CircuitState::Open { .. } => return,
        };
    }
}

// ─── Swappable circuit breaker (Lg decomposition) ────────────────────────────

/// The per-provider circuit breaker as a swappable, in-process capability. The
/// built-in [`CircuitBreakers`] (in-memory failure counting) is the default; an
/// alternative (e.g. one sharing state across a gateway fleet) can register
/// without touching the pipeline. This is a HOT per-request primitive, so the
/// swap is in-process only (never IPC) — the trait is a swap-seam, mirroring the
/// [`crate::providers::ProviderRegistry`] inversion.
pub trait CircuitBreakerBackend: Send + Sync {
    /// `true` if the provider's circuit is open and it should be skipped.
    fn is_open(&self, provider: &str) -> bool;
    /// Record a successful response, closing the circuit.
    fn record_success(&self, provider: &str);
    /// Record a failure, opening the circuit past the threshold.
    fn record_failure(&self, provider: &str);
    /// Health snapshot of every observed provider (for `/metrics`).
    fn snapshot(&self) -> HashMap<String, ProviderHealthSnapshot>;
}

impl CircuitBreakerBackend for CircuitBreakers {
    fn is_open(&self, provider: &str) -> bool {
        CircuitBreakers::is_open(self, provider)
    }
    fn record_success(&self, provider: &str) {
        CircuitBreakers::record_success(self, provider);
    }
    fn record_failure(&self, provider: &str) {
        CircuitBreakers::record_failure(self, provider);
    }
    fn snapshot(&self) -> HashMap<String, ProviderHealthSnapshot> {
        CircuitBreakers::snapshot(self)
    }
}

/// Id-keyed registry over [`CircuitBreakerBackend`] implementations. The
/// built-in [`CircuitBreakers`] is registered first under
/// [`CircuitBreakerRegistry::BUILTIN`] and active by default, so behavior is
/// byte-identical with no config change. Delegating verbs forward to the active
/// backend, keeping every call site unchanged.
pub struct CircuitBreakerRegistry {
    backends: HashMap<String, Arc<dyn CircuitBreakerBackend>>,
    order: Vec<String>,
    active_id: String,
    active: Arc<dyn CircuitBreakerBackend>,
}

impl CircuitBreakerRegistry {
    /// Stable id of the built-in in-process circuit breaker.
    pub const BUILTIN: &'static str = "builtin";

    /// Build the registry from config, registering the built-in
    /// [`CircuitBreakers`] as the default active backend.
    pub fn new(config: CircuitBreakerConfig) -> Self {
        let builtin: Arc<dyn CircuitBreakerBackend> = Arc::new(CircuitBreakers::new(config));
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
    pub fn register(&mut self, id: impl Into<String>, backend: Arc<dyn CircuitBreakerBackend>) {
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

    /// See [`CircuitBreakerBackend::is_open`].
    pub fn is_open(&self, provider: &str) -> bool {
        self.active.is_open(provider)
    }

    /// See [`CircuitBreakerBackend::record_success`].
    pub fn record_success(&self, provider: &str) {
        self.active.record_success(provider);
    }

    /// See [`CircuitBreakerBackend::record_failure`].
    pub fn record_failure(&self, provider: &str) {
        self.active.record_failure(provider);
    }

    /// See [`CircuitBreakerBackend::snapshot`].
    pub fn snapshot(&self) -> HashMap<String, ProviderHealthSnapshot> {
        self.active.snapshot()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(enabled: bool, threshold: u32, reset_secs: u64) -> CircuitBreakerConfig {
        CircuitBreakerConfig {
            enabled,
            failure_threshold: threshold,
            reset_timeout_secs: reset_secs,
        }
    }

    // ─── CircuitBreakers state machine ───────────────────────────────────────

    #[test]
    fn fresh_provider_circuit_is_closed() {
        let cb = CircuitBreakers::new(config(true, 3, 30));
        assert!(!cb.is_open("openai"));
    }

    #[test]
    fn disabled_breaker_never_opens_even_past_threshold() {
        let cb = CircuitBreakers::new(config(false, 1, 30));
        // Even one failure would trip a threshold-1 breaker, but disabled short
        // circuits every verb before it touches state.
        for _ in 0..10 {
            cb.record_failure("openai");
        }
        assert!(!cb.is_open("openai"));
        // No state was ever recorded, so the snapshot is empty.
        assert!(cb.snapshot().is_empty());
    }

    #[test]
    fn opens_only_after_threshold_consecutive_failures() {
        let cb = CircuitBreakers::new(config(true, 3, 30));
        cb.record_failure("openai");
        assert!(!cb.is_open("openai"), "1 < 3 stays closed");
        cb.record_failure("openai");
        assert!(!cb.is_open("openai"), "2 < 3 stays closed");
        cb.record_failure("openai");
        // The third consecutive failure hits the threshold and opens. Reset is a
        // large 30s so `is_open` sees ~0s elapsed and reports open, not half-open.
        assert!(cb.is_open("openai"), "3 >= 3 opens the circuit");
    }

    #[test]
    fn success_resets_the_consecutive_failure_count() {
        let cb = CircuitBreakers::new(config(true, 3, 30));
        cb.record_failure("openai");
        cb.record_failure("openai");
        // A success in the Closed state zeroes the running count, so the next two
        // failures are not enough to trip the threshold-3 breaker.
        cb.record_success("openai");
        cb.record_failure("openai");
        cb.record_failure("openai");
        assert!(!cb.is_open("openai"), "count reset by success; 2 < 3");
    }

    #[test]
    fn open_circuit_transitions_to_half_open_after_reset_timeout() {
        // reset_timeout 0 => an Open circuit is instantly eligible for a probe, so
        // the first `is_open` after opening flips it to HalfOpen and returns false.
        let cb = CircuitBreakers::new(config(true, 1, 0));
        cb.record_failure("openai"); // threshold 1 => opens immediately
        assert!(
            !cb.is_open("openai"),
            "reset elapsed => half-open probe allowed"
        );
        assert_eq!(cb.snapshot()["openai"].circuit, "half_open");
    }

    #[test]
    fn half_open_probe_success_closes_the_circuit() {
        let cb = CircuitBreakers::new(config(true, 1, 0));
        cb.record_failure("openai");
        assert!(!cb.is_open("openai")); // -> half-open
        cb.record_success("openai"); // probe succeeded
        let snap = cb.snapshot();
        assert_eq!(snap["openai"].circuit, "closed");
        assert_eq!(snap["openai"].consecutive_failures, 0);
    }

    #[test]
    fn half_open_probe_failure_reopens_the_circuit() {
        // reset 0 lets us reach HalfOpen without sleeping. `snapshot` reads the
        // stored state directly (it does not re-evaluate the reset timer), so
        // immediately after the probe failure it reports "open" — proof the
        // HalfOpen -> Open transition fired.
        let cb = CircuitBreakers::new(config(true, 1, 0));
        cb.record_failure("openai"); // opens
        assert!(!cb.is_open("openai")); // -> half-open (probe allowed)
        assert_eq!(cb.snapshot()["openai"].circuit, "half_open");
        cb.record_failure("openai"); // probe failed -> re-open
        assert_eq!(cb.snapshot()["openai"].circuit, "open");
    }

    #[test]
    fn open_circuit_stays_open_before_reset_timeout_elapses() {
        let cb = CircuitBreakers::new(config(true, 1, 30));
        cb.record_failure("openai");
        // ~0s elapsed < 30s reset => still open on every immediate check.
        assert!(cb.is_open("openai"));
        assert!(cb.is_open("openai"));
        assert_eq!(cb.snapshot()["openai"].circuit, "open");
    }

    #[test]
    fn record_failure_is_noop_while_already_open() {
        let cb = CircuitBreakers::new(config(true, 1, 30));
        cb.record_failure("openai"); // opens, records opened_at
        let opened_for = cb.snapshot()["openai"].open_for_secs;
        assert!(opened_for.is_some());
        // A further failure while Open returns early and must NOT reset opened_at
        // to a new Instant or change consecutive_failures (which is 0 while open).
        cb.record_failure("openai");
        assert_eq!(cb.snapshot()["openai"].consecutive_failures, 0);
    }

    #[test]
    fn circuits_are_tracked_independently_per_provider() {
        let cb = CircuitBreakers::new(config(true, 2, 30));
        cb.record_failure("openai");
        cb.record_failure("openai");
        cb.record_failure("anthropic");
        assert!(cb.is_open("openai"), "openai hit threshold 2");
        assert!(!cb.is_open("anthropic"), "anthropic only 1 failure");
    }

    #[test]
    fn snapshot_only_lists_observed_providers() {
        let cb = CircuitBreakers::new(config(true, 5, 30));
        cb.record_failure("openai");
        cb.is_open("anthropic"); // observing also inserts a Closed entry
        let snap = cb.snapshot();
        assert!(snap.contains_key("openai"));
        assert!(snap.contains_key("anthropic"));
        assert!(!snap.contains_key("modal"), "never-touched provider absent");
        assert_eq!(snap["openai"].consecutive_failures, 1);
        assert_eq!(snap["openai"].circuit, "closed");
    }

    #[test]
    fn snapshot_open_reports_open_for_secs_not_null() {
        let cb = CircuitBreakers::new(config(true, 1, 30));
        cb.record_failure("openai");
        let snap = cb.snapshot();
        assert_eq!(snap["openai"].circuit, "open");
        assert!(snap["openai"].open_for_secs.is_some());
        // Consecutive-failure count is superseded by the `circuit` string once open.
        assert_eq!(snap["openai"].consecutive_failures, 0);
    }

    #[test]
    fn half_open_admits_exactly_one_probe() {
        // reset 0 => the Open circuit is instantly eligible; the FIRST is_open
        // call after opening flips to HalfOpen and admits its own caller as the
        // probe. Any further concurrent callers must be rejected, not admitted.
        let cb = CircuitBreakers::new(config(true, 1, 0));
        cb.record_failure("openai"); // threshold 1 => opens immediately
        assert!(
            !cb.is_open("openai"),
            "first caller is admitted as the probe"
        );
        assert!(
            cb.is_open("openai"),
            "second concurrent caller must be rejected, not admitted"
        );
        assert!(
            cb.is_open("openai"),
            "third concurrent caller must also be rejected"
        );
    }

    #[test]
    fn probe_failure_reopens_and_gates_again() {
        let cb = CircuitBreakers::new(config(true, 1, 0));
        cb.record_failure("openai"); // opens
        assert!(!cb.is_open("openai")); // -> half-open, this call is the probe
        cb.record_failure("openai"); // probe failed -> re-open
                                     // reset_timeout_secs: 0 means the freshly-reopened circuit is again
                                     // instantly eligible: the next is_open flips to HalfOpen and admits
                                     // exactly one caller as the new probe, then gates the rest again.
        assert!(
            !cb.is_open("openai"),
            "first caller after re-open is admitted as the new probe"
        );
        assert!(
            cb.is_open("openai"),
            "second caller after re-open must be rejected"
        );
    }

    #[test]
    fn probe_success_closes() {
        let cb = CircuitBreakers::new(config(true, 1, 0));
        cb.record_failure("openai"); // opens
        assert!(!cb.is_open("openai")); // -> half-open, this call is the probe
        cb.record_success("openai"); // probe succeeded -> closed
        assert!(!cb.is_open("openai"));
        assert!(!cb.is_open("openai"));
        assert!(!cb.is_open("openai"));
    }

    // ─── CircuitBreakerRegistry swap seam ────────────────────────────────────

    #[test]
    fn registry_builtin_is_active_by_default() {
        let reg = CircuitBreakerRegistry::new(config(true, 5, 30));
        assert_eq!(reg.active_id(), CircuitBreakerRegistry::BUILTIN);
        assert_eq!(reg.available(), vec![CircuitBreakerRegistry::BUILTIN]);
    }

    #[test]
    fn registry_delegates_verbs_to_active_backend() {
        let reg = CircuitBreakerRegistry::new(config(true, 1, 30));
        reg.record_failure("openai");
        assert!(reg.is_open("openai"));
        reg.record_success("openai");
        assert!(!reg.is_open("openai"));
        assert!(reg.snapshot().contains_key("openai"));
    }

    #[test]
    fn registry_set_active_unknown_id_is_false_and_unchanged() {
        let mut reg = CircuitBreakerRegistry::new(config(true, 5, 30));
        assert!(!reg.set_active("does-not-exist"));
        assert_eq!(reg.active_id(), CircuitBreakerRegistry::BUILTIN);
    }

    #[test]
    fn registry_register_is_idempotent_on_order() {
        let mut reg = CircuitBreakerRegistry::new(config(true, 5, 30));
        let extra: Arc<dyn CircuitBreakerBackend> =
            Arc::new(CircuitBreakers::new(config(true, 5, 30)));
        reg.register("fleet", Arc::clone(&extra));
        reg.register("fleet", extra); // re-register same id must not duplicate order
        assert_eq!(
            reg.available(),
            vec![
                CircuitBreakerRegistry::BUILTIN.to_string(),
                "fleet".to_string()
            ]
        );
    }

    #[test]
    fn registry_set_active_switches_backend() {
        let mut reg = CircuitBreakerRegistry::new(config(true, 5, 30));
        let extra: Arc<dyn CircuitBreakerBackend> =
            Arc::new(CircuitBreakers::new(config(true, 1, 30)));
        reg.register("fleet", extra);
        assert!(reg.set_active("fleet"));
        assert_eq!(reg.active_id(), "fleet");
        // The fleet backend has threshold 1, so a single failure opens via the
        // registry's delegating verb — proof the swap took effect.
        reg.record_failure("openai");
        assert!(reg.is_open("openai"));
    }
}
