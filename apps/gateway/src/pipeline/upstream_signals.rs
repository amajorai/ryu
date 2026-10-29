//! Upstream abuse signals (managed guardrails spec 03.5).
//!
//! The provider crate recognises a safety refusal in an error body from its
//! static table and carries it on [`GatewayError::ProviderRejected`]. Only a
//! dispatch site knows which attempt the refusal ended and whose credential
//! it spent, so the signal is settled here:
//!
//! - an attempt on the hosted fleet, where every built-in provider slot holds
//!   a key from Ryu's vault, becomes [`GatewayError::UpstreamSafetyRefused`],
//!   a safety outcome: one violation event, a live-feed verdict, no fallback
//!   to another vendor (decision D16), no circuit penalty, no account
//!   cooldown;
//! - any other attempt keeps an ordinary rejection and records nothing, so a
//!   tenant's own key or endpoint can never raise a safety signal against
//!   anyone. That includes a managed node: attempts there carry no
//!   credential origin yet, so an injected Ryu key cannot be told apart from
//!   the user's own, and the node stamps no upstream identifier. A rejection
//!   still ends the chain there (`ends_chain_on_refusal`), so it is never
//!   shopped to another vendor either.
//!
//! A sub-call that sends the tenant's text to a provider on the request's
//! behalf (the inspector, a smart-routing classifier or escalation judge,
//! the semantic cache's embedding) is settled the same way, under
//! [`AUXILIARY_ATTEMPT`]: a refusal of it ends the request instead of
//! failing open into the main dispatch.
//!
//! Tenant SDK connections run on the GenAI adapter, which never consults the
//! table, so a tenant's own key cannot produce a signal on the fleet either.
//!
//! A successful response that the model's own safety system cut
//! (`finish_reason: "content_filter"`, which is also what the Anthropic
//! adapter maps `stop_reason: "refusal"` to) is a soft signal: it records
//! `abuse.upstream_content_refused` and returns the response unchanged.

use serde_json::Value;

use crate::audit::{EnforcementAction, Severity, SpendOwner};
use crate::error::{vendor_of, GatewayError, UpstreamRefusal, UpstreamSignal};
use crate::pipeline::RequestContext;
use crate::state::AppState;
use crate::traffic::{DecidedBy, TrafficVerdict, VerdictAction};
use crate::violations::VerdictInput;
use ryu_gw_providers::SafetyScope;

/// Whether an upstream safety signal on this request counts: the attempt
/// spent a Ryu-held credential. Only the hosted fleet knows that today (the
/// same custody upstream identity stamping runs on), and never on the
/// caller-subscription passthrough routes.
pub(crate) fn reads_upstream_signals(state: &AppState) -> bool {
    state.custody.is_fleet()
        && crate::violations::spend_for(state.custody, crate::traffic::current_route().as_deref())
            == SpendOwner::Ryu
}

/// The own-supply slot an attempt is pinned to, for the event's `slotId`.
fn slot_of(ctx: &RequestContext) -> Option<&str> {
    ctx.own_supply_route.as_ref().map(|(slot, _)| slot.as_str())
}

const fn action_for(scope: SafetyScope) -> EnforcementAction {
    match scope {
        SafetyScope::Content => EnforcementAction::RefusedUpstream,
        SafetyScope::Identifier | SafetyScope::Account => EnforcementAction::BlockedUpstream,
    }
}

/// Spec 03.5.2: `high` for an identifier block, `critical` for an account
/// warning. A content refusal keeps the severity its action implies.
const fn severity_for(scope: SafetyScope) -> Option<Severity> {
    match scope {
        SafetyScope::Identifier => Some(Severity::High),
        SafetyScope::Account => Some(Severity::Critical),
        SafetyScope::Content => None,
    }
}

/// The attempt a refusal of one of the Gateway's own sub-calls carrying the
/// tenant's text is recorded under. Direct attempts take their chain
/// position and pool legs their leg position, both far below it, so its
/// dedupe key never collides with theirs. The first such refusal ends the
/// request, so one slot is enough.
pub(crate) const AUXILIARY_ATTEMPT: usize = 255;

fn attempt_u8(attempt: usize) -> u8 {
    u8::try_from(attempt).unwrap_or(u8::MAX)
}

/// Settle a failed attempt's error. Call it first in every dispatch error
/// arm, before the safety-outcome check, with the attempt's chain position.
/// Any error other than a rejection that carries a signal is returned as is.
pub(crate) fn settle(
    state: &AppState,
    ctx: &RequestContext,
    attempt: usize,
    error: GatewayError,
) -> GatewayError {
    let GatewayError::ProviderRejected {
        status,
        message,
        signal: Some(signal),
    } = error
    else {
        return error;
    };
    if !reads_upstream_signals(state) {
        return GatewayError::ProviderRejected {
            status,
            message,
            signal: None,
        };
    }
    let signal = *signal;
    record(state, ctx, attempt, &signal);
    if signal.scope == SafetyScope::Account {
        // Operations decide whether to drain the slot: the signal never opens
        // the circuit by itself (spec 03.5.2).
        tracing::error!(
            page = "operations",
            request_id = %ctx.request_id,
            provider = %signal.provider,
            slot = ?slot_of(ctx),
            row = signal.row,
            "upstream account warning on a Ryu-held credential"
        );
    }
    GatewayError::UpstreamSafetyRefused(Box::new(UpstreamRefusal { signal, status }))
}

/// Record the violation event and note the live-feed verdict for `signal`.
fn record(state: &AppState, ctx: &RequestContext, attempt: usize, signal: &UpstreamSignal) {
    let category = signal.category();
    let mut input = VerdictInput::upstream(
        category,
        signal.row,
        action_for(signal.scope),
        attempt_u8(attempt),
        &signal.provider,
    )
    .with_slot(slot_of(ctx));
    if let Some(severity) = severity_for(signal.scope) {
        input = input.with_severity(severity);
    }
    let event_id = state.record_violation(ctx, input);
    state.traffic.note_verdict(
        &ctx.request_id,
        TrafficVerdict::new(DecidedBy::Upstream, VerdictAction::Block)
            .with_detector(signal.row)
            .with_category(category.as_str())
            .with_event(event_id),
    );
}

/// The detector id of a soft refusal by `provider`'s vendor.
fn soft_refusal_row(provider: &str) -> String {
    format!("{}.content_filter", vendor_of(provider))
}

/// Record a soft signal when a successful completion was cut by the model's
/// own safety system. The response is never changed.
pub(crate) fn note_soft_refusal(
    state: &AppState,
    ctx: &RequestContext,
    attempt: usize,
    provider: &str,
    response: &Value,
) {
    if !reads_upstream_signals(state)
        || !ryu_gw_providers::safety_signals::is_soft_refusal(response)
    {
        return;
    }
    let row = soft_refusal_row(provider);
    let category = ryu_gw_screening::TaxonomyId::UPSTREAM_CONTENT_REFUSED;
    let event_id = state.record_violation(
        ctx,
        VerdictInput::upstream(
            category,
            &row,
            EnforcementAction::RefusedUpstream,
            attempt_u8(attempt),
            provider,
        )
        .with_slot(slot_of(ctx)),
    );
    state.traffic.note_verdict(
        &ctx.request_id,
        TrafficVerdict::new(DecidedBy::Upstream, VerdictAction::Warn)
            .with_detector(&row)
            .with_category(category.as_str())
            .with_event(event_id),
    );
}

#[cfg(test)]
#[path = "upstream_signals_tests.rs"]
mod tests;
