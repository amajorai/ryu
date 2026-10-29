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

/// How long a 402-refused account stays out of rotation. Pass it to
/// `AccountPool::record_account_rejection`, never `record_rate_limit`: a refused
/// payment belongs to that one key, so it must not cool a shared quota domain or
/// the last usable key, whose real `PaymentRequired` has to stay visible.
pub(crate) const PAYMENT_REQUIRED_COOLDOWN: std::time::Duration =
    std::time::Duration::from_secs(300);

/// An error returned by a backend [`crate::Provider`] call.
#[derive(Debug, Clone)]
pub enum ProviderError {
    /// A generic provider failure (non-2xx that is not a 429, a parse failure, a
    /// non-connect request error, or an unsupported modality). Maps to
    /// `GatewayError::ProviderError`.
    Provider(String),

    /// The upstream refused this request with a 4xx other than 402, 408 or
    /// 429: a bad parameter, unknown model, oversized input, a refused
    /// credential (401) or a refusal of the content itself (403). `status` is
    /// the upstream HTTP status, so callers classify by code and never by the
    /// message text. Apart from a 401 it says nothing about the provider's
    /// health, so the gateway must not count it toward the provider's shared
    /// circuit breaker, or one caller's refused requests would cut the
    /// provider off for every tenant on the node.
    Rejected { status: u16, message: String },

    /// Connection or timeout failure after retries. Kept distinct so an
    /// egress-proxy pool can cool down the selected transport without treating
    /// an upstream 5xx or malformed response as a broken proxy.
    Transport(String),
    /// Request delivery may have occurred; neither account nor provider fallback may replay it.
    DeliveryUncertain(String),

    /// The upstream provider returned HTTP 402. This is an account/payment
    /// condition, not a provider outage: callers must preserve it so the chat
    /// surface can tell a user to refill or switch the selected provider.
    PaymentRequired { provider: String, message: String },

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

    /// An upstream 4xx whose body matched a row of the safety-signal table
    /// ([`crate::safety_signals`]): the provider refused this request for a
    /// safety reason. Built only from the table, never from message text.
    /// The gateway decides whether it counts: an attempt that spent a tenant's
    /// own credential treats it as an ordinary [`ProviderError::Rejected`].
    /// `message` is the upstream's own wording, kept for that downgrade and
    /// never shown by `Display`, because it can echo the request.
    SafetyRefused {
        provider: String,
        status: u16,
        scope: crate::safety_signals::SafetyScope,
        /// The table row that matched.
        row: &'static str,
        /// The vendor code or type the row matched, when it had one.
        code: Option<String>,
        message: String,
    },
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProviderError::Provider(msg) => write!(f, "Provider error: {msg}"),
            ProviderError::Rejected { message, .. } => {
                write!(f, "Provider rejected the request: {message}")
            }
            ProviderError::Transport(msg) => write!(f, "Transport error: {msg}"),
            ProviderError::DeliveryUncertain(msg) => write!(f, "Delivery uncertain: {msg}"),
            ProviderError::PaymentRequired { provider, message } => {
                write!(f, "Provider payment required: {provider}: {message}")
            }
            ProviderError::RateLimited { provider, .. } => {
                write!(f, "Provider rate limited: {provider}")
            }
            ProviderError::SafetyRefused {
                provider, scope, ..
            } => write!(
                f,
                "Provider safety refusal: {provider} ({})",
                scope.as_str()
            ),
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
    fn transport_error_is_a_distinct_signal() {
        let error = ProviderError::Transport("openai connection failed".to_owned());
        assert_eq!(
            error.to_string(),
            "Transport error: openai connection failed"
        );
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
    fn display_safety_refusal_never_carries_the_upstream_message() {
        let e = ProviderError::SafetyRefused {
            provider: "openai".to_owned(),
            status: 400,
            scope: crate::safety_signals::SafetyScope::Content,
            row: "openai.invalid_prompt",
            code: Some("invalid_prompt".to_owned()),
            message: "RYU_TEST_FIXTURE echoed request text".to_owned(),
        };
        let shown = e.to_string();
        assert_eq!(shown, "Provider safety refusal: openai (content)");
        assert!(!shown.contains("RYU_TEST_FIXTURE"));
    }
}
