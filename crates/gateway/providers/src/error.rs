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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_provider_error() {
        let e = ProviderError::Provider("boom".to_string());
        assert_eq!(e.to_string(), "Provider error: boom");
    }

    #[test]
    fn display_rate_limited_names_provider_but_not_backoff() {
        let e = ProviderError::RateLimited {
            provider: "openai".to_string(),
            retry_after: Some(30),
            reset_at: Some(12345),
        };
        let s = e.to_string();
        assert_eq!(s, "Provider rate limited: openai");
        // The Display form is a summary — it does not leak the numeric back-off.
        assert!(!s.contains("30"));
        assert!(!s.contains("12345"));
    }

    #[test]
    fn clone_and_debug_are_available() {
        let e = ProviderError::RateLimited {
            provider: "anthropic".to_string(),
            retry_after: None,
            reset_at: None,
        };
        let cloned = e.clone();
        assert_eq!(cloned.to_string(), e.to_string());
        // Debug is derived; exercise it so the impl is covered.
        assert!(format!("{e:?}").contains("RateLimited"));
    }

    #[test]
    fn is_usable_as_std_error() {
        // Ensure the std::error::Error impl compiles/behaves (source() defaults None).
        let e: Box<dyn std::error::Error> = Box::new(ProviderError::Provider("x".into()));
        assert!(e.source().is_none());
    }
}
