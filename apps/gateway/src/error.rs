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
            GatewayError::CircuitOpen(provider) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "circuit_open",
                provider.as_str(),
            ),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AlertTier;

    /// Read the JSON error envelope out of a `GatewayError` response.
    async fn body_json(err: GatewayError) -> (StatusCode, serde_json::Value) {
        let resp = err.into_response();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .expect("error body must collect");
        let json: serde_json::Value =
            serde_json::from_slice(&bytes).expect("error body must be JSON");
        (status, json)
    }

    /// The `error.{type,code}` fields are the stable wire contract clients match
    /// on, so the full mapping is asserted per variant — status + type + code.
    #[tokio::test]
    async fn status_and_code_mapping_is_stable_per_variant() {
        let cases: Vec<(GatewayError, StatusCode, &str)> = vec![
            (
                GatewayError::Unauthorized("bad key".into()),
                StatusCode::UNAUTHORIZED,
                "invalid_api_key",
            ),
            (
                GatewayError::RateLimited,
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limit_exceeded",
            ),
            (
                GatewayError::FirewallBlocked("ssn".into(), None),
                StatusCode::FORBIDDEN,
                "policy_violation",
            ),
            (
                GatewayError::PolicyViolation("blocked".into()),
                StatusCode::FORBIDDEN,
                "policy_violation",
            ),
            (
                GatewayError::NoProvider("gpt-9".into()),
                StatusCode::NOT_FOUND,
                "model_not_found",
            ),
            (
                GatewayError::ProviderError("upstream 500".into()),
                StatusCode::BAD_GATEWAY,
                "provider_error",
            ),
            (
                GatewayError::ProviderRateLimited {
                    provider: "openai".into(),
                    retry_after: Some(5),
                    reset_at: None,
                },
                StatusCode::TOO_MANY_REQUESTS,
                "provider_rate_limited",
            ),
            (
                GatewayError::CircuitOpen("openai".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "circuit_open",
            ),
            (
                GatewayError::Overloaded("queue full".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "engine_overloaded",
            ),
            (
                GatewayError::BudgetExceeded(None),
                StatusCode::PAYMENT_REQUIRED,
                "budget_exceeded",
            ),
            (
                GatewayError::InsufficientCredits,
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_credits",
            ),
            (
                GatewayError::AllProvidersUnavailable("all down".into()),
                StatusCode::SERVICE_UNAVAILABLE,
                "all_providers_unavailable",
            ),
            (
                GatewayError::BadRequest("nope".into()),
                StatusCode::BAD_REQUEST,
                "invalid_request_error",
            ),
            (
                GatewayError::Internal(anyhow::anyhow!("boom")),
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal_error",
            ),
        ];

        for (err, want_status, want_code) in cases {
            let (status, json) = body_json(err).await;
            assert_eq!(status, want_status, "status for code {want_code}");
            assert_eq!(json["error"]["type"], want_code, "type field");
            assert_eq!(json["error"]["code"], want_code, "code field");
            assert!(
                json["error"]["message"].is_string(),
                "message must be present for {want_code}"
            );
        }
    }

    #[tokio::test]
    async fn message_passthrough_uses_the_variant_string() {
        // Variants carrying a caller-facing string surface it verbatim in message.
        let (_, json) = body_json(GatewayError::Unauthorized("no header".into())).await;
        assert_eq!(json["error"]["message"], "no header");
    }

    #[tokio::test]
    async fn internal_error_does_not_leak_the_underlying_message() {
        // Internal(anyhow) must be redacted to a generic message, never echoing the
        // source error (which could carry secrets or internals).
        let (_, json) = body_json(GatewayError::Internal(anyhow::anyhow!(
            "db password=hunter2 leaked"
        )))
        .await;
        assert_eq!(json["error"]["message"], "An internal error occurred.");
    }

    #[test]
    fn from_provider_error_maps_generic_to_provider_error() {
        let e: GatewayError = ryu_gw_providers::ProviderError::Provider("boom".into()).into();
        match e {
            GatewayError::ProviderError(msg) => assert_eq!(msg, "boom"),
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    #[test]
    fn from_provider_error_preserves_rate_limit_signal_fields() {
        // The rate-limit arm must survive intact so the pipeline can demote tiers /
        // rotate accounts WITHOUT tripping the circuit breaker.
        let e: GatewayError = ryu_gw_providers::ProviderError::RateLimited {
            provider: "anthropic".into(),
            retry_after: Some(12),
            reset_at: Some(99),
        }
        .into();
        match e {
            GatewayError::ProviderRateLimited {
                provider,
                retry_after,
                reset_at,
            } => {
                assert_eq!(provider, "anthropic");
                assert_eq!(retry_after, Some(12));
                assert_eq!(reset_at, Some(99));
            }
            other => panic!("expected ProviderRateLimited, got {other:?}"),
        }
    }

    #[test]
    fn non_alert_variant_stamps_no_policy_alert_header() {
        // Only BudgetExceeded / FirewallBlocked carry a PolicyAlert; every other
        // variant must leave the header absent.
        let resp = GatewayError::ProviderError("x".into()).into_response();
        assert!(resp.headers().get(POLICY_ALERT_HEADER).is_none());
    }

    #[test]
    fn budget_exceeded_without_alert_stamps_no_header() {
        // A budget stop with no attached alert (tier below Warn) writes no header.
        let resp = GatewayError::BudgetExceeded(None).into_response();
        assert_eq!(resp.status(), StatusCode::PAYMENT_REQUIRED);
        assert!(resp.headers().get(POLICY_ALERT_HEADER).is_none());
    }

    #[test]
    fn firewall_blocked_with_alert_stamps_header() {
        let alert = PolicyAlert::firewall("block", AlertTier::Warn, "org1");
        let resp = GatewayError::FirewallBlocked("blocked".into(), Some(alert)).into_response();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert!(resp.headers().get(POLICY_ALERT_HEADER).is_some());
    }
}
