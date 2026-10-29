use super::*;

pub(super) fn budget_charge_kind_for_modality(modality: &Modality) -> BudgetChargeKind {
    match modality {
        Modality::Chat => BudgetChargeKind::Model,
        Modality::Image | Modality::Tts | Modality::Stt | Modality::Video | Modality::Audio => {
            BudgetChargeKind::Media
        }
    }
}

// ─── Budget enforcement (U21) ─────────────────────────────────────────────────

/// Check the request against per-user and per-agent budgets and apply the
/// configured action inline. Shared by both the streaming and non-streaming
/// pipelines so enforcement fires on whichever path Core uses.
///
/// Side effects on the action:
///   - `Stop`      → returns `Err(BudgetExceeded)` (the caller aborts).
///   - `Downgrade` → rewrites `body["model"]` and reroutes via the router.
///   - `Restrict`  → strips tool definitions and caps `max_tokens`.
///   - `Notify`    → no body change; just observable.
///
/// Returns the triggered `BudgetDecision` (if any) so the caller can surface it
/// to the client as response headers.
pub(super) fn enforce_budget(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    decision: &mut RouteDecision,
    kind: BudgetChargeKind,
    ceiling: OutputCeiling,
) -> Result<BudgetOutcome, GatewayError> {
    enforce_budget_with(
        state,
        ctx,
        body,
        decision,
        kind,
        ceiling,
        InFlightBudget::Claim,
    )
}

/// Whether a local user/agent/session budget check counts in-flight spend.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum InFlightBudget {
    /// A top-level request: count the estimated spend of requests already
    /// running and claim this one's estimate until its outcome is dropped, so a
    /// parallel burst cannot all start against the same remaining headroom.
    Claim,
    /// A sub-call made on behalf of a request that already holds its claim (a
    /// classifier, inspector, evaluator, or pool leg): checked against recorded
    /// spend only, so a request is never refused because of its own claim.
    SubCall,
}

/// [`enforce_budget`] for an auxiliary sub-call of a running request.
pub(super) fn enforce_sub_call_budget(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    decision: &mut RouteDecision,
    kind: BudgetChargeKind,
    ceiling: OutputCeiling,
) -> Result<BudgetOutcome, GatewayError> {
    enforce_budget_with(
        state,
        ctx,
        body,
        decision,
        kind,
        ceiling,
        InFlightBudget::SubCall,
    )
}

pub(super) fn enforce_budget_with(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    decision: &mut RouteDecision,
    kind: BudgetChargeKind,
    ceiling: OutputCeiling,
    in_flight: InFlightBudget,
) -> Result<BudgetOutcome, GatewayError> {
    // The coordinator's shared verdict and the key's lifetime token cap gate
    // every top-level request here, so streamed chat and media are covered as
    // well as buffered chat. A sub-call's parent request already passed them.
    // The key's `downgrade_to` names a chat model, so a media request over its
    // cap is refused rather than rerouted through the chat router.
    if in_flight == InFlightBudget::Claim {
        let routed = decision.clone();
        let lifetime =
            super::inference_governance::enforce_lifetime_budget(state, ctx, body, decision)
                .and_then(|()| {
                    let rerouted = decision.provider.as_str() != routed.provider.as_str()
                        || decision.model != routed.model;
                    if kind == BudgetChargeKind::Media && rerouted {
                        return Err(GatewayError::BudgetExceeded(None));
                    }
                    Ok(())
                });
        if let Err(err) = lifetime {
            warn!(
                key_id = %crate::audit::credential_log_id(&ctx.api_key),
                "shared or lifetime token budget exceeded"
            );
            state.metrics.inc_budget_exceeded();
            state.metrics.inc_errors();
            return Err(err);
        }
    }
    if ctx.is_master_key {
        return Ok(BudgetOutcome::default());
    }
    if let Some(err) = accounting_unavailable_gate(state, ctx) {
        state.metrics.inc_errors();
        warn!(
            org_id = ?ctx.org_id,
            "credits: control-plane accounting unavailable, rejecting managed request (503)"
        );
        return Err(err);
    }
    if let Some(err) = spend_store_gate(state, ctx) {
        state.metrics.inc_errors();
        warn!("budget store unavailable, rejecting metered request (503)");
        return Err(err);
    }
    // Charged-cost budget decision (U21) and the credit-wallet-empty decision (#486)
    // are both expressed as a `BudgetDecision`; pick the more severe so a single
    // `match` applies one action. The wallet decision reuses the existing budget
    // machinery — no new denial path (spec §4).
    //
    // Per-session running cap (#510): one global rule, counter keyed by
    // x-ryu-session-id. Folded into the same most-severe chain so a session
    // decision flows through the existing Notify/Downgrade/Restrict/Stop arms.
    let session_key = budget_session_key(
        &ctx.owner_binding,
        ctx.org_id.as_deref(),
        ctx.user_id.as_deref(),
        ctx.session_id.as_deref(),
    );
    // Spend is recorded only after the response, so a top-level request also
    // counts (and claims) the estimated cost of requests still running. The
    // estimate is the one the credit reservation uses; a lone request is never
    // counted against its own claim.
    let BudgetAdmission {
        decision: token_decision,
        session: session_decision,
        hold: budget_hold,
    } = match in_flight {
        InFlightBudget::Claim => {
            let estimate = u64::try_from(reservation_estimate_micro_usd(state, body)).unwrap_or(0);
            state.with_budget(|b| {
                b.admit_charge(
                    ctx.user_id.as_deref(),
                    ctx.agent_id.as_deref(),
                    session_key.as_deref(),
                    kind,
                    estimate,
                )
            })
        }
        InFlightBudget::SubCall => state.with_budget(|b| BudgetAdmission {
            decision: b.evaluate_charge(ctx.user_id.as_deref(), ctx.agent_id.as_deref(), kind),
            session: b.evaluate_session_charge(session_key.as_deref(), kind),
            hold: None,
        }),
    };
    let wallet_decision = wallet_empty_decision(state, ctx);
    // Control-plane org limits (C1) for a resolved `rgw_` tenant: every
    // applicable member / team / key / org cap, folded into the same chain so
    // the local `BudgetConfig` and the org limits both apply.
    let limits = crate::org_limits::evaluate_for(state, ctx);

    // The propagated alert tier is the MAX across every matched decision (not
    // just the most-severe-enforcement one), so a low-enforcement rule with a
    // high alert tier still fans out. Computed before `most_severe` consumes the
    // decisions.
    let max_tier = [
        token_decision.as_ref(),
        wallet_decision.as_ref(),
        session_decision.as_ref(),
        limits.decision.as_ref(),
    ]
    .into_iter()
    .flatten()
    .map(|d| d.alert)
    .max()
    .unwrap_or(AlertTier::Silent);

    let budget = most_severe(
        most_severe(
            most_severe(token_decision, wallet_decision),
            session_decision,
        ),
        limits.decision,
    );

    // Build the Ok/Err-path PolicyAlert once (source/scope inferred from the
    // winning decision), only when a matched rule asked for a real alert. An
    // org-limit early-warning threshold rides along when nothing outranks it.
    let alert = budget.as_ref().and_then(|budget| {
        (max_tier >= AlertTier::Warn).then(|| {
            PolicyAlert::from_budget_decision(budget, max_tier, ctx.org_id.as_deref().unwrap_or(""))
        })
    });
    let alert = merge_alert(alert, limits.alert);

    if let Some(budget) = budget.as_ref() {
        match budget.action {
            BudgetAction::Notify => {
                state.metrics.inc_budget_notified();
                warn!(
                    scope = budget.scope.as_str(),
                    key_id = %crate::audit::credential_log_id(&budget.key),
                    used_micro_usd = budget.used,
                    limit_micro_usd = budget.limit,
                    "budget reached (notify)"
                );
            }
            BudgetAction::Downgrade => {
                if let Some(ref model) = budget.downgrade_to {
                    state.metrics.inc_budget_downgraded();
                    info!(
                        scope = budget.scope.as_str(),
                        key_id = %crate::audit::credential_log_id(&budget.key),
                        downgrade = %model,
                        "budget reached, downgrading model"
                    );
                    body["model"] = Value::String(model.clone());
                    *decision = provider_snapshot(&state, &ctx).router.route(model);
                    canonicalize_sdk_decision(state, ctx, decision)?;
                }
            }
            BudgetAction::Restrict => {
                state.metrics.inc_budget_restricted();
                warn!(
                    scope = budget.scope.as_str(),
                    key_id = %crate::audit::credential_log_id(&budget.key),
                    cap = budget.restrict_max_tokens,
                    "budget reached, restricting request"
                );
                // Strip tools and clamp the output length so an over-budget caller
                // still gets a minimal answer instead of a hard failure.
                if let Some(obj) = body.as_object_mut() {
                    obj.remove("tools");
                    obj.remove("tool_choice");
                }
                body["max_tokens"] = Value::from(budget.restrict_max_tokens);
            }
            BudgetAction::Stop => {
                state.metrics.inc_budget_exceeded();
                state.metrics.inc_errors();
                warn!(
                    scope = budget.scope.as_str(),
                    key_id = %crate::audit::credential_log_id(&budget.key),
                    used_micro_usd = budget.used,
                    limit_micro_usd = budget.limit,
                    "budget exceeded (stop)"
                );
                return Err(GatewayError::BudgetExceeded(alert));
            }
        }
    }

    // Apply the budget action before reserving managed credits. A Downgrade may
    // switch provider and credit pool; a Restrict may lower max_tokens. The
    // reservation and output ceiling must describe the route actually sent.
    let reservation = reserve_route_credit(state, ctx, body, decision, ceiling)?;

    Ok(BudgetOutcome {
        decision: budget,
        alert,
        reservation,
        budget_hold,
    })
}

/// Gate, size, and claim credits for the route that will actually dispatch.
/// The budget action has already run, so a downgrade uses its new provider,
/// credit pool, and model. Hold the returned permit through completion or the
/// whole client stream; dropping it early reopens concurrent spend headroom.
pub(super) fn reserve_route_credit(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    decision: &RouteDecision,
    ceiling: OutputCeiling,
) -> Result<Option<CreditReservation>, GatewayError> {
    let routed_pool = crate::credit_pools::pool_for_gateway_provider(decision.provider.as_str());
    if let Some(err) = preflight_credit_gate(ctx, routed_pool) {
        state.metrics.inc_budget_exceeded();
        warn!(
            org_id = ?ctx.org_id,
            remaining_budget_micro_usd = ?ctx.remaining_budget_micro_usd,
            unrestricted_budget_micro_usd = ?ctx.unrestricted_budget_micro_usd,
            pool = ?routed_pool,
            "credits: managed tenant wallet exhausted, rejecting pre-flight (402)"
        );
        return Err(err);
    }

    // Clamp before claiming: the reservation estimate reads the ceiling this
    // writes. An untagged provider uses unrestricted credit only. Generic
    // fallback still needs a fresh gate when it switches credit pools.
    let clamped = clamp_output_ceiling(state, ctx, body, &decision.model, routed_pool, ceiling)
        .map_err(|err| {
            state.metrics.inc_budget_exceeded();
            warn!(
                org_id = ?ctx.org_id,
                pool = ?routed_pool,
                "credits: balance does not cover this request's prompt, rejecting pre-flight (402)"
            );
            err
        })?;
    if let Some(clamped) = clamped {
        debug!(
            org_id = ?ctx.org_id,
            pool = ?routed_pool,
            max_output_tokens = clamped,
            "credits: lowered this request's output ceiling to the affordable maximum"
        );
    }

    let reserved = if ceiling == OutputCeiling::Clamp {
        // A text completion is priced for its prompt AND its (just clamped)
        // output ceiling, at the routed model's own rates.
        reserve_credit_estimate(
            state,
            ctx,
            routed_pool,
            chat_reservation_estimate_micro_usd(state, body, &decision.model),
        )
    } else {
        maybe_reserve_credit(state, ctx, body, routed_pool)
    };
    reserved.map_err(|err| {
        state.metrics.inc_budget_exceeded();
        warn!(
            org_id = ?ctx.org_id,
            pool = ?routed_pool,
            "credits: in-flight reservations already claim this org's balance, rejecting pre-flight (402)"
        );
        err
    })
}

// ─── Credit-wallet debit hook (#486) ──────────────────────────────────────────

/// Build a `BudgetDecision` from the cached credit-wallet-empty flag for this
/// request's org, if the credits hook is active and the org is flagged empty.
///
/// The flag is set POST-call by the debit hook (the cost is only known after the
/// response); this gate fires PRE-call on the NEXT request for that org. Returns
/// the configured wallet-empty action (Stop by default, or Downgrade) so the
/// shared `enforce_budget` machinery applies it — no new denial path (spec §4).
/// Pre-flight credit gate for the multi-tenant data plane (§4). A managed-inference
/// tenant (resolved from an `rgw_` token) whose control-plane-resolved remaining
/// wallet balance is non-positive is rejected before dispatch with a hard
/// `InsufficientCredits` (402). Reads only the resolved balance carried on the
/// ctx — it is refreshed on the resolve cache's 60s TTL, so a top-up auto-recovers
/// (no sticky flag to strand a re-funded org). Returns `None` for non-managed,
/// uncapped (`None` budget), or positive-balance requests.
///
/// `pool` is the credit pool this request is ROUTED to (see
/// [`crate::credit_pools`]), and it is what makes the gate able to answer a
/// question the total cannot: a wallet holding $50 of Bedrock grant and nothing
/// else has a positive total, yet funds no Cloudflare token at all. With a pool,
/// the spendable amount is the unrestricted buckets PLUS that one pool's grant —
/// grants for every other pool are unreachable by construction, because no other
/// entry of the map is ever added in.
///
/// `pool == None` (the provider is not pool-tagged — `openai`, `anthropic`,
/// `local`, …) is NOT the pre-pool check. It gates on the UNRESTRICTED balance,
/// because a restricted grant cannot pay an untagged provider: the debit that
/// follows carries no pool, so `debitWallet` skips every grant row and drives
/// the top-up bucket negative while the grant sits untouched. Gating such a
/// request on the blended total would admit it against money it can never
/// spend, and Ryu would absorb the provider's bill. Concretely: a Founding-50
/// claimant with `sub=0, topup=0, bedrock grant=$50` sending `gpt-4o`.
///
/// One degradation is deliberate and must stay:
///   - `unrestricted_budget_micro_usd == None` (control plane predates pool
///     segregation) ⇒ treat the whole balance as unrestricted, i.e. the pre-pool
///     check again, on BOTH branches. Collapsing this into `0` would gate every
///     request to death the moment the gateway outran the control plane.
/// The provider chain to dispatch over: the fleet's own `fallback_chain` for the
/// routed primary, re-ordered (never extended) by the node's stated preference.
///
/// The single seam all three chain-expansion sites — non-stream `run`, streaming
/// `run_stream`, and `run_multimodal` — go through, so they cannot drift. It owns
/// the `provider_snapshot(&state, &ctx).router.fallback_chain` call rather than taking a chain, which is
/// what makes the swap a one-liner at each site: the multimodal path never runs
/// `pre_process`, so a clamp result threaded out of `pre_process` would not have
/// reached it at all.
///
/// The clamp is fed the REAL credit gate, so an entry the preference would
/// promote is re-checked against its own credit pool. That matters because
/// `preflight_credit_gate` in `enforce_budget` only ever saw the PRIMARY's pool,
/// before this expansion — see [`node_routing`] for the full argument.
pub(super) fn clamped_fallback_chain(
    state: &AppState,
    ctx: &RequestContext,
    decision: &RouteDecision,
) -> Vec<ProviderId> {
    let fleet_chain = provider_snapshot(&state, &ctx)
        .router
        .fallback_chain(&decision.provider);
    let clamped = node_routing::clamp_fallback(
        ctx.node_routing.as_ref(),
        &state.config.node_routing,
        ctx,
        fleet_chain,
        |c, pool| preflight_credit_gate(c, pool).is_none(),
    );
    if !clamped.dropped.is_empty() {
        debug!(
            request_id = %ctx.request_id,
            dropped = ?clamped.dropped,
            "node routing: parts of the node's fallback preference were not honoured"
        );
    }
    keep_own_supply_in_its_lane(&decision.provider, clamped.chain)
}

/// Own supply is a billing decision, not interchangeable capacity: a request
/// whose primary is one of Ryu's own-supply slots (reached through an alias,
/// a namespace or own-supply routing) never fails over to ANOTHER slot — a
/// retry there would bill a different bucket under the same label, and the
/// own-supply → Ryu Router fallback is `run`'s job, with the user's id. And a
/// request whose primary is anything else (BYOK, OpenRouter, local) never
/// fails over ONTO an own-supply slot, which would spend donated supply on
/// traffic nobody routed there.
pub(super) fn keep_own_supply_in_its_lane(
    primary: &ProviderId,
    chain: Vec<ProviderId>,
) -> Vec<ProviderId> {
    let own = |provider: &ProviderId| {
        crate::credit_pools::pool_for_gateway_provider(provider.as_str())
            .is_some_and(crate::credit_pools::is_own_supply_pool)
    };
    if own(primary) {
        return chain.into_iter().filter(|p| p == primary).collect();
    }
    chain.into_iter().filter(|p| !own(p)).collect()
}

#[cfg(test)]
#[path = "budget_lifetime_test.rs"]
mod lifetime_tests;
