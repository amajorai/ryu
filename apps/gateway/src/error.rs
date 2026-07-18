use axum::{
    http::{HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

use crate::policy_alert::{PolicyAlert, POLICY_ALERT_HEADER};

#[derive(Debug, Error)]
pub enum GatewayError {
    #[error("Authentication failed: {0}")]
    Unauthorized(String),

    #[error("Rate limit exceeded")]
    RateLimited,

    /// A firewall / DLP inbound match blocked the request (403). Carries the
    /// optional [`PolicyAlert`] stamped when the matched firewall rule's `alert`
    /// tier is `>= Warn`, so `into_response` emits `x-ryu-policy-alert` on the
    /// error response (the F1 error-path stamp — this Response only exists here).
    #[error("Request blocked by firewall: {0}")]
    FirewallBlocked(String, Option<PolicyAlert>),

    #[error("Blocked by control-plane policy: {0}")]
    PolicyViolation(String),

    // Never constructed since #218/#362 (f4e22a92) replaced the "no provider"
    // path with a structured degraded-mode 503; kept as the reserved public
    // error contract with its stable 404 `model_not_found` mapping below.
    #[allow(dead_code)]
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
    CircuitOpen(String),

    /// The local-engine admission queue is full — too many requests are already
    /// waiting for the resident model's batch slots. Retryable. Stable code:
    /// `engine_overloaded`.
    #[error("Engine overloaded: {0}")]
    Overloaded(String),

    /// A per-user / per-agent / per-session token budget (or the wallet-empty
    /// rule) hit `Stop` (402). Carries the optional [`PolicyAlert`] stamped when
    /// the matched rule's `alert` tier is `>= Warn`, so `into_response` emits
    /// `x-ryu-policy-alert` on the 402 (the F1 error-path stamp).
    #[error("Budget exceeded")]
    BudgetExceeded(Option<PolicyAlert>),

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

/// Map the provider-crate's boundary error 1:1 to the gateway error. The
/// providers (`ryu-gw-providers`) cannot name `GatewayError` (it carries
/// `PolicyAlert` → `budget`/`config` + the axum `IntoResponse` HTTP layer), so
/// the `Provider` trait returns a narrow [`ryu_gw_providers::ProviderError`] and
/// the pipeline converts at the call boundary. Doing it here — never by
/// inspecting `ProviderError` downstream — is what preserves the pipeline's
/// rate-limit-vs-fault distinction: `RateLimited` demotes tiers / rotates
/// accounts WITHOUT tripping the circuit breaker, `Provider` trips it.
impl From<ryu_gw_providers::ProviderError> for GatewayError {
    fn from(e: ryu_gw_providers::ProviderError) -> Self {
        match e {
            ryu_gw_providers::ProviderError::Provider(msg) => GatewayError::ProviderError(msg),
            ryu_gw_providers::ProviderError::RateLimited {
                provider,
                retry_after,
                reset_at,
            } => GatewayError::ProviderRateLimited {
                provider,
                retry_after,
                reset_at,
            },
        }
    }
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
            GatewayError::FirewallBlocked(msg, _) => {
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
                (StatusCode::SERVICE_UNAVAILABLE, "circuit_open", provider.as_str())
            }
            GatewayError::Overloaded(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "engine_overloaded",
                msg.as_str(),
            ),
            GatewayError::BudgetExceeded(_) => (
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

        let mut response = (status, Json(body)).into_response();

        // F1 error-path stamp: budget-stop (402) and firewall-block (403) return
        // BEFORE any Ok Response exists, so the ONLY place their PolicyAlert can be
        // written onto the wire is here. Mirror the Ok-path `x-ryu-policy-alert`
        // header so a block-tier alert reaches Core on the error response too.
        let alert = match &self {
            GatewayError::BudgetExceeded(a) => a.as_ref(),
            GatewayError::FirewallBlocked(_, a) => a.as_ref(),
            _ => None,
        };
        if let Some(alert) = alert {
            if let Ok(v) = HeaderValue::from_str(&alert.to_header()) {
                response.headers_mut().insert(POLICY_ALERT_HEADER, v);
            }
        }

        response
    }
}
