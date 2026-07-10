use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum GatewayError {
    #[error("Authentication failed: {0}")]
    Unauthorized(String),

    #[error("Rate limit exceeded")]
    RateLimited,

    #[error("Request blocked by firewall: {0}")]
    FirewallBlocked(String),

    #[error("Blocked by control-plane policy: {0}")]
    PolicyViolation(String),

    #[error("No provider available for model: {0}")]
    NoProvider(String),

    #[error("Provider error: {0}")]
    ProviderError(String),

    /// An upstream *provider* returned HTTP 429. Distinct from the gateway's own
    /// inbound [`GatewayError::RateLimited`]: this is a capacity signal the
    /// pipeline acts on — it demotes down the cost-tier fallback chain and rotates
    /// to the next account WITHOUT tripping the provider's circuit breaker (a
    /// rate-limit means "busy", not "broken"), and feeds `retry_after`/`reset_at`
    /// into the quota store. Stable code: `provider_rate_limited`.
    #[error("Provider rate limited: {provider}")]
    ProviderRateLimited {
        provider: String,
        retry_after: Option<u64>,
        reset_at: Option<u64>,
    },

    #[error("Circuit open for provider: {0}")]
    CircuitOpen(&'static str),

    /// The local-engine admission queue is full — too many requests are already
    /// waiting for the resident model's batch slots. Retryable. Stable code:
    /// `engine_overloaded`.
    #[error("Engine overloaded: {0}")]
    Overloaded(String),

    #[error("Budget exceeded")]
    #[allow(dead_code)]
    BudgetExceeded,

    /// A managed-inference org's credit balance is exhausted (pre-flight gate).
    /// Distinct from [`GatewayError::BudgetExceeded`] (token-budget period cap):
    /// this is the org wallet hitting zero. Stable code: `insufficient_credits`.
    #[error("Insufficient credits")]
    InsufficientCredits,

    /// All providers in the fallback chain are unavailable (circuits open or
    /// provider calls failed). Stable code: `all_providers_unavailable`.
    #[error("All providers unavailable: {0}")]
    AllProvidersUnavailable(String),

    #[allow(dead_code)]
    #[error("Bad request: {0}")]
    BadRequest(String),

    #[error("Internal error: {0}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        let (status, type_str, message) = match &self {
            GatewayError::Unauthorized(msg) => {
                (StatusCode::UNAUTHORIZED, "invalid_api_key", msg.as_str())
            }
            GatewayError::RateLimited => (
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
                "Rate limit exceeded. Please retry after a moment.",
            ),
            GatewayError::FirewallBlocked(msg) => {
                (StatusCode::FORBIDDEN, "policy_violation", msg.as_str())
            }
            GatewayError::PolicyViolation(msg) => {
                (StatusCode::FORBIDDEN, "policy_violation", msg.as_str())
            }
            GatewayError::NoProvider(msg) => {
                (StatusCode::NOT_FOUND, "model_not_found", msg.as_str())
            }
            GatewayError::ProviderError(msg) => {
                (StatusCode::BAD_GATEWAY, "provider_error", msg.as_str())
            }
            GatewayError::ProviderRateLimited { .. } => (
                StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limited",
                "Upstream provider rate limit reached. Please retry after a moment.",
            ),
            GatewayError::CircuitOpen(provider) => {
                (StatusCode::SERVICE_UNAVAILABLE, "circuit_open", *provider)
            }
            GatewayError::Overloaded(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "engine_overloaded",
                msg.as_str(),
            ),
            GatewayError::BudgetExceeded => (
                StatusCode::PAYMENT_REQUIRED,
                "budget_exceeded",
                "Token budget exceeded for this period.",
            ),
            GatewayError::InsufficientCredits => (
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_credits",
                "organization credit balance exhausted",
            ),
            GatewayError::AllProvidersUnavailable(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "all_providers_unavailable",
                msg.as_str(),
            ),
            GatewayError::BadRequest(msg) => (
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
                msg.as_str(),
            ),
            GatewayError::Internal(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
                "An internal error occurred.",
            ),
        };

        let body = json!({
            "error": {
                "message": message,
                "type": type_str,
                "code": type_str,
            }
        });

        (status, Json(body)).into_response()
    }
}
