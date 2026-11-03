//! How a failed provider attempt is logged, classified and remembered.

use super::*;

// Upstream error strings may echo prompts or credentials. Logs retain only
// governed failure metadata; the response path applies its own policy.
pub(super) fn log_provider_failure(provider: &str, error: &GatewayError, context: &'static str) {
    warn!(
        provider,
        error_kind = provider_error_log_kind(error),
        context,
        "upstream provider request failed"
    );
}

pub(super) fn provider_error_log_kind(error: &GatewayError) -> &'static str {
    match error {
        GatewayError::ProviderRateLimited { .. } => "rate_limited",
        GatewayError::ProviderPaymentRequired { .. } => "payment_required",
        GatewayError::ProviderTransport(_) => "transport",
        GatewayError::ProviderDeliveryUncertain(_) => "delivery_uncertain",
        GatewayError::ProviderError(_) => "provider_error",
        GatewayError::ProviderRejected { .. } => "request_rejected",
        _ => "request_failure",
    }
}

/// Whether this error says the provider itself is unhealthy, so it counts
/// toward the provider circuit (and pool-member demotion) every tenant shares.
///
/// A positive allowlist of genuine upstream health faults: a 5xx, a 408 or an
/// unreadable reply (all `ProviderError`), and a credential the upstream no
/// longer accepts (a 401 rejection), which is broken for every caller. Nothing
/// else counts. Safety and policy outcomes are decisions about one request
/// (see [`GatewayError::is_safety_outcome`]); any other upstream 4xx, including
/// a 403 content refusal, is about one request's content; rate limits and
/// payment-required replies are capacity or account state; a transport or
/// delivery-uncertain failure is the network path, not the provider. The match
/// is exhaustive so a new variant must be classified before it compiles.
pub(super) fn penalizes_provider_circuit(error: &GatewayError) -> bool {
    match error {
        GatewayError::ProviderError(_) => true,
        GatewayError::ProviderRejected { status, .. } => *status == 401,
        GatewayError::FirewallBlocked(..)
        | GatewayError::UpstreamSafetyRefused(_)
        | GatewayError::PolicyViolation(_)
        | GatewayError::PlatformRefused { .. }
        | GatewayError::ScreeningUnavailable { .. }
        | GatewayError::ContentBlocked(_)
        | GatewayError::ScreeningDegradedThrottle { .. }
        | GatewayError::ScreeningCapacityExceeded
        | GatewayError::StandingRefused(_)
        | GatewayError::StandingUnavailable
        | GatewayError::AbuseThrottled(_)
        | GatewayError::AccountRestricted(_)
        | GatewayError::NewKeyRateLimited { .. }
        | GatewayError::RateLimited
        | GatewayError::RateLimitedBy(_)
        | GatewayError::ConfigConflict(_)
        | GatewayError::Unauthorized(_)
        | GatewayError::NoProvider(_)
        | GatewayError::ProviderTransport(_)
        | GatewayError::ProviderDeliveryUncertain(_)
        | GatewayError::ProviderPaymentRequired { .. }
        | GatewayError::ProviderRateLimited { .. }
        | GatewayError::CircuitOpen(_)
        | GatewayError::Overloaded(_)
        | GatewayError::BudgetExceeded(_)
        | GatewayError::BudgetStoreUnavailable(_)
        | GatewayError::InsufficientCredits
        | GatewayError::AccountingUnavailable
        | GatewayError::ToolUnpriced(_)
        | GatewayError::ToolNotServable(_)
        | GatewayError::ToolPaymentRequired(_)
        | GatewayError::ProviderResponseTooLarge { .. }
        | GatewayError::ProviderBodyUnreadable { .. }
        | GatewayError::AllProvidersUnavailable(_)
        | GatewayError::BadRequest(_)
        | GatewayError::InvalidRequest { .. }
        | GatewayError::Internal(_) => false,
    }
}

/// Whether a failed attempt ends the fallback chain instead of moving to the
/// next provider: on the hosted fleet and on a managed node an upstream 4xx
/// other than 408 and 429 is returned as is (see
/// [`crate::custody::GatewayCustody::ends_chain_on_refusal`] and
/// [`GatewayError::ends_hosted_attempt`]). Callers return safety outcomes
/// before this on every custody.
pub(super) fn ends_attempt_chain(state: &AppState, error: &GatewayError) -> bool {
    state.custody.ends_chain_on_refusal() && error.ends_hosted_attempt()
}

/// Keep an actionable payment-required failure if later fallbacks also fail.
/// A generic outage may explain the last attempt, but it must not erase the
/// account recovery the caller can actually perform.
pub(super) fn remember_preferred_provider_error(
    slot: &mut Option<GatewayError>,
    error: GatewayError,
) {
    let existing_is_payment = matches!(
        slot.as_ref(),
        Some(GatewayError::ProviderPaymentRequired { .. })
    );
    let current_is_payment = matches!(&error, GatewayError::ProviderPaymentRequired { .. });
    if current_is_payment || !existing_is_payment {
        *slot = Some(error);
    }
}

#[cfg(test)]
#[path = "transport_circuit_tests.rs"]
mod transport_circuit_tests;
