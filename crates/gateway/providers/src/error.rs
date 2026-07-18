//! The provider-boundary error type.
//!
//! The concrete providers cannot name the gateway's `GatewayError` (it carries a
//! `PolicyAlert`, which drags `budget` + `config` + the axum `IntoResponse` HTTP
//! semantics — the gateway trust/response layer that must not leave the app). So
//! the `Provider` trait returns this narrow, self-contained error carrying only
//! the two signals a provider actually produces, and `apps/gateway` maps it 1:1
//! to `GatewayError` at the pipeline call boundary via `impl From<ProviderError>
//! for GatewayError`. Doing the conversion at the boundary (never by inspecting
//! `ProviderError` downstream) preserves the pipeline's rate-limit-vs-error
//! distinction: a `RateLimited` demotes tiers / rotates accounts WITHOUT tripping
//! the circuit breaker, an `Provider` error trips it.

use std::fmt;

/// An error returned by a backend [`crate::Provider`] call.
#[derive(Debug, Clone)]
pub enum ProviderError {
    /// A generic provider failure (non-2xx that is not a 429, a parse failure, a
    /// transport error, or an unsupported modality). Maps to
    /// `GatewayError::ProviderError`.
    Provider(String),

    /// The upstream provider returned HTTP 429. A capacity signal, not a fault:
    /// maps to `GatewayError::ProviderRateLimited` so the pipeline demotes down
    /// the cost-tier fallback chain and rotates accounts WITHOUT tripping the
    /// provider's circuit breaker, feeding `retry_after`/`reset_at` into the
    /// quota store.
    RateLimited {
        provider: String,
        retry_after: Option<u64>,
        reset_at: Option<u64>,
    },
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderError::Provider(msg) => write!(f, "Provider error: {msg}"),
            ProviderError::RateLimited { provider, .. } => {
                write!(f, "Provider rate limited: {provider}")
            }
        }
    }
}

impl std::error::Error for ProviderError {}
