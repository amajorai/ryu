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
    HalfOpen,
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
            CircuitState::Closed { .. } | CircuitState::HalfOpen => false,
            CircuitState::Open { opened_at } => {
                if opened_at.elapsed() >= reset_timeout {
                    // Transition to half-open; allow one probe request
                    *entry = CircuitState::HalfOpen;
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
            Some(CircuitState::HalfOpen | CircuitState::Open { .. })
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
                    CircuitState::HalfOpen => ProviderHealthSnapshot {
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
            CircuitState::HalfOpen => {
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
