//! Per-attempt steps the buffered and streamed chat paths share: resetting
//! the request for a fallback attempt, the per-attempt screens and wire
//! shaping, the engine admission slot, and what a failed attempt does to the
//! fallback chain.

use super::*;

/// What a fallback attempt restores the request from.
pub(super) struct AttemptBase<'a> {
    pub(super) requested_model: &'a str,
    pub(super) budget: &'a Option<BudgetDecision>,
    /// The request as admitted, restored before a pool retry. `None` for a
    /// generic retry, which keeps any completed tool turns.
    pub(super) pool_base_body: Option<&'a Value>,
    pub(super) original_max_tokens: Option<&'a Value>,
    pub(super) original_max_completion_tokens: Option<&'a Value>,
}

/// Re-point the request at fallback `attempt`: release the previous claim,
/// restore the token ceilings, re-apply a Restrict budget, then canonicalize,
/// authorize and reserve for the new route and stamp its prompt-cache
/// markers. An error skips this attempt.
#[allow(clippy::too_many_arguments)]
pub(super) fn prepare_fallback_attempt(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    base: &AttemptBase<'_>,
    attempt: &ChatAttemptRoute,
    body: &mut Value,
    decision: &mut RouteDecision,
    credit_reservation: &mut Option<CreditReservation>,
    prompt_cache_outcome: &mut ryu_gw_providers::PromptCacheOutcome,
) -> Result<(), GatewayError> {
    drop(credit_reservation.take());
    if let Some(pool_base_body) = base.pool_base_body {
        *body = pool_base_body.clone();
    }
    restore_token_ceiling(body, "max_tokens", base.original_max_tokens);
    restore_token_ceiling(
        body,
        "max_completion_tokens",
        base.original_max_completion_tokens,
    );
    if let Some(restrict) = base
        .budget
        .as_ref()
        .filter(|rule| rule.action == crate::config::BudgetAction::Restrict)
    {
        body["max_tokens"] = Value::from(restrict.restrict_max_tokens);
    }
    *decision = attempt.decision.clone();
    canonicalize_sdk_decision(state, ctx, decision)?;
    authorize_routed_model(state, ctx, base.requested_model, decision)?;
    *credit_reservation = reserve_route_credit(state, ctx, body, decision, OutputCeiling::Clamp)?;
    *prompt_cache_outcome = apply_prompt_cache(state, ctx, &decision.model, body);
    Ok(())
}

/// Append a context-relay pool's handoff, screened, then re-admit the body
/// this attempt sends. Returns the handoff screen's Ok-path alert.
///
/// A refused handoff ends the request: retrying it on the next member would
/// send the same content to another provider. The re-admission (spec 02.12
/// and 00.12) has the hazard screener read the body this attempt sends,
/// skills, compression and relay edits included. Unchanged segments answer
/// from the segment cache, so a fallback attempt costs no second classifier
/// call.
pub(super) async fn readmit_attempt(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    attempt: &ChatAttemptRoute,
    body: &mut Value,
    model: &str,
    start: Instant,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let relay_alert = apply_pool_relay(state, ctx, attempt.pool.as_ref(), body, model, start)?;
    if let Err(error) = crate::screening::admit::screen_chat_as(
        state,
        ctx,
        body,
        crate::screening::admit::Surface::Chat,
        &attempt.decision.model,
    )
    .await
    {
        state.metrics.inc_errors();
        audit_failure(state, ctx, model, &error, start);
        return Err(error);
    }
    Ok(relay_alert)
}

/// Per-attempt wire shaping for `provider`, since a fallback swaps it. Only an
/// Anthropic-dialect provider reads the caller's betas; for anyone else the
/// private field is an unknown top-level key that would 400 a strict
/// endpoint.
pub(super) fn shape_attempt_body(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
    sampling_extensions: &mut SamplingExtensions,
    provider: &str,
    model: &str,
) {
    strip_anthropic_beta_for(body, provider);
    strip_cache_control_for(body, provider, model);
    sampling_extensions.apply_for(body, provider);
    stamp_upstream_identity(
        state,
        ctx,
        body,
        provider,
        crate::identity::UpstreamSurface::Chat,
    );
}

/// The local-engine admission slot for one attempt, or an instant ungated
/// permit when `ungated` (the re-entrant tool-loop case). A full queue
/// refuses with `engine_overloaded`.
pub(super) async fn acquire_engine_slot(
    state: &AppState,
    ctx: &RequestContext,
    provider: &str,
    ungated: bool,
) -> Result<crate::concurrency::AdmissionPermit, GatewayError> {
    if ungated {
        return Ok(crate::concurrency::AdmissionPermit::none());
    }
    state
        .admission
        .acquire_for(provider, ctx.priority, ctx.org_id.as_deref())
        .await
        .map_err(|full| {
            GatewayError::Overloaded(format!(
                "Local engine busy: {} requests already queued. Retry shortly.",
                full.queued
            ))
        })
}

/// Feed a failed pool attempt into the pool's member state: a rate limit or
/// payment-required reply rests the member, and a health fault feeds the Auto
/// strategy's observed reliability (without it the ring would only ever hold
/// successes).
pub(super) fn record_pool_failure(
    state: &AppState,
    ctx: &RequestContext,
    pool: Option<&crate::provider_pools::SelectedPoolRoute>,
    error: &GatewayError,
) {
    let Some(route) = pool else {
        return;
    };
    match error {
        GatewayError::ProviderRateLimited { retry_after, .. } => {
            provider_snapshot(state, ctx)
                .provider_pools
                .record_rate_limit(route, *retry_after);
        }
        GatewayError::ProviderPaymentRequired { .. } => {
            provider_snapshot(state, ctx)
                .provider_pools
                .record_rate_limit(route, Some(300));
        }
        error if penalizes_provider_circuit(error) => {
            provider_snapshot(state, ctx)
                .provider_pools
                .record_failure(route);
        }
        _ => {}
    }
}

/// One failed chat attempt, as [`after_failed_chat_attempt`] judges it.
pub(super) struct FailedChatAttempt<'a> {
    pub(super) provider: &'static str,
    pub(super) circuit_key: String,
    pub(super) pool: Option<&'a crate::provider_pools::SelectedPoolRoute>,
    /// The attempt was the chain's primary provider.
    pub(super) was_primary: bool,
    /// The attempt may have run tools with side effects, so the chain must
    /// not replay it on another member.
    pub(super) replay_unsafe: bool,
    pub(super) unavailable_log: &'static str,
    pub(super) failed_log: &'static str,
}

/// What a failed chat attempt does to the chain. `Err` ends the request
/// (a safety or policy outcome, audited); `Ok(true)` stops the chain with
/// `last_err` set; `Ok(false)` moves to the next attempt.
///
/// A safety or policy outcome (a tool loop stopped by the firewall, a
/// refused route) is not a provider failure: no circuit penalty and no
/// fallback, which would shop the request to another provider and run the
/// loop and its tools again. Capacity (429) and account payment (402) are
/// retry/fallback signals, not provider outages; neither may poison health
/// state.
#[allow(clippy::too_many_arguments)]
pub(super) fn after_failed_chat_attempt(
    state: &AppState,
    ctx: &RequestContext,
    failed: FailedChatAttempt<'_>,
    error: GatewayError,
    model: &str,
    start: Instant,
    last_err: &mut Option<GatewayError>,
    primary_skipped: &mut bool,
) -> Result<bool, GatewayError> {
    if error.is_safety_outcome() {
        audit_failure(state, ctx, model, &error, start);
        return Err(error);
    }
    record_pool_failure(state, ctx, failed.pool, &error);
    if matches!(&error, GatewayError::ProviderDeliveryUncertain(_)) {
        state.metrics.inc_provider_error(failed.provider);
        *last_err = Some(error);
        return Ok(true);
    }
    if !penalizes_provider_circuit(&error) {
        state.metrics.inc_provider_error(failed.provider);
        log_provider_failure(failed.provider, &error, failed.unavailable_log);
    } else {
        state.circuit_breaker.record_failure(&failed.circuit_key);
        state.metrics.inc_provider_error(failed.provider);
        log_provider_failure(failed.provider, &error, failed.failed_log);
    }
    if ends_attempt_chain(state, &error) {
        *last_err = Some(error);
        return Ok(true);
    }
    if failed.was_primary {
        *primary_skipped = true;
    }
    remember_preferred_provider_error(last_err, error);
    Ok(failed.replay_unsafe)
}

/// The error a request returns once every attempt of its chain failed.
/// `subject` names what was requested (`model 'x'`). A refusal that ended
/// the chain on the hosted fleet or a managed node is returned as itself:
/// the providers did not all fail. Generic chain errors become the typed
/// `all_providers_unavailable`, not a 404 or 502.
pub(super) fn exhausted_chain_error(
    state: &AppState,
    last_err: Option<GatewayError>,
    subject: &str,
) -> GatewayError {
    last_err.map_or_else(
        || {
            GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for {subject}"
            ))
        },
        |prev| match prev {
            GatewayError::ProviderRejected { .. } if state.custody.ends_chain_on_refusal() => prev,
            GatewayError::CircuitOpen(_)
            | GatewayError::ProviderError(_)
            | GatewayError::ProviderRejected { .. }
            | GatewayError::ProviderTransport(_) => GatewayError::AllProvidersUnavailable(format!(
                "All providers unavailable for {subject}: {prev}"
            )),
            other => other,
        },
    )
}
