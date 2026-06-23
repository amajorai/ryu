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
    states: DashMap<&'static str, CircuitState>,
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
    pub fn is_open(&self, provider: &'static str) -> bool {
        if !self.config.enabled {
            return false;
        }

        let reset_timeout = Duration::from_secs(self.config.reset_timeout_secs);

        let mut entry = self.states.entry(provider).or_insert(CircuitState::Closed {
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
    pub fn record_success(&self, provider: &'static str) {
        if !self.config.enabled {
            return;
        }
        let was_open = matches!(
            self.states.get(provider).as_deref(),
            Some(CircuitState::HalfOpen | CircuitState::Open { .. })
        );
        self.states.insert(
            provider,
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
    pub fn record_failure(&self, provider: &'static str) {
        if !self.config.enabled {
            return;
        }
        let mut entry = self.states.entry(provider).or_insert(CircuitState::Closed {
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
