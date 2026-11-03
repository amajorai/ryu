//! The buffered chat path's provider attempts: the fallback chain, each
//! attempt's screens and dispatch, and the chain-exhausted error.

use super::*;

/// Try each route of the fallback chain until one answers (see
/// [`run_attached`]).
pub(super) async fn run_buffered_attempts(
    chat: BufferedChat,
) -> Result<PipelineOutput, GatewayError> {
    let BufferedChat {
        state,
        ctx,
        mut body,
        mut decision,
        requested_model,
        start,
        caller,
        mut sampling_extensions,
        cache,
        pool_route,
        execution_ceiling,
        original_max_tokens,
        original_max_completion_tokens,
        budget,
        mut credit_reservation,
        mut policy_alert,
    } = chat;
    let pool_base_body = body.clone();
    let fallback_chain = if execution_ceiling.is_some() {
        vec![ChatAttemptRoute {
            decision: decision.clone(),
            pool: None,
        }]
    } else {
        chat_attempt_routes(&state, &ctx, &decision, pool_route.as_ref())
    };
    let mut last_err: Option<GatewayError> = None;
    // Track whether the primary provider (first in chain) was skipped so we
    // can signal DegradedMode::Fallback when a later provider serves the request.
    let primary_provider = fallback_chain
        .first()
        .map(|attempt| attempt.decision.provider.clone());
    let mut primary_skipped = false;

    // Stamp markers after request transforms. A pool retry restores the request
    // body and applies markers again for that member's model and dialect.
    let mut prompt_cache_outcome = apply_prompt_cache(&state, &ctx, &decision.model, &mut body);

    for (attempt_index, attempt) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        if attempt_index > 0 {
            let base = AttemptBase {
                requested_model: &requested_model,
                budget: &budget,
                // Generic retries retain any completed tool turns. Explicit pool
                // retries keep their existing per-member request reset semantics.
                pool_base_body: pool_route.is_some().then_some(&pool_base_body),
                original_max_tokens: original_max_tokens.as_ref(),
                original_max_completion_tokens: original_max_completion_tokens.as_ref(),
            };
            if let Err(error) = prepare_fallback_attempt(
                &state,
                &ctx,
                &base,
                attempt,
                &mut body,
                &mut decision,
                &mut credit_reservation,
                &mut prompt_cache_outcome,
            ) {
                last_err = Some(error);
                continue;
            }
        }
        let candidate_provider = &attempt.decision.provider;
        let route = match bind_route(
            &state,
            &ctx,
            &RouteDecision {
                provider: candidate_provider.clone(),
                model: attempt.decision.model.clone(),
            },
        ) {
            Ok(route) => route,
            Err(error) => {
                last_err = Some(error);
                continue;
            }
        };
        let provider_kind = &route.provider_id;
        if let Err(error) = inference_governance::authorize_bound_route_region(&state, &ctx, &route)
        {
            last_err = Some(error);
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }
        // 7. Circuit breaker check
        if state.circuit_breaker.is_open(&bound_circuit_key(&route)) {
            debug!(
                provider = provider_kind.as_str(),
                "circuit open, skipping provider"
            );
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }

        let relay_alert =
            readmit_attempt(&state, &ctx, attempt, &mut body, &decision.model, start).await?;
        policy_alert = merge_alert(policy_alert, relay_alert);
        let provider = Arc::clone(&route.provider);

        state.metrics.inc_provider_request(provider.name());

        shape_attempt_body(
            &state,
            &ctx,
            &mut body,
            &mut sampling_extensions,
            provider.name(),
            &decision.model,
        );

        // 7b. Admission: gate concurrent access to the resident local engine so
        // interactive chat is served ahead of background fan-out (the engine has
        // a fixed batch-slot count). Held across the whole completion. Remote
        // providers and disabled gating return an instant ungated permit. A full
        // queue rejects with `engine_overloaded` (retryable) rather than piling
        // on the engine's internal FIFO.
        //
        // IMPORTANT — re-entrancy: the unified tool loop runs while we'd hold the
        // permit, and a tool (e.g. `delegate.fanout`) can route a child request
        // back to this same local provider. Gating those would deadlock (parent
        // holds the slot while the engine idles, waiting on the child). So we gate
        // only NON-tool-loop completions — exactly the plain-chat traffic where
        // batching + priority matter most; the tool-loop path stays ungated.
        // Raw passthrough (`x-ryu-raw-tools`) forces the plain branch; otherwise
        // unified (catalog + signal) wins, then legacy Composio, then plain.
        let tools_restricted = matches!(
            budget.as_ref().map(|b| b.action),
            Some(crate::config::BudgetAction::Restrict)
        );
        let loop_kind = select_tool_loop(
            &ctx,
            state.tools.is_some(),
            state.composio.is_some(),
            &state.config.tools,
            tools_restricted,
        );
        let runs_tool_loop = matches!(loop_kind, ToolLoopKind::Unified);
        let _admission = acquire_engine_slot(&state, &ctx, provider.name(), runs_tool_loop).await?;

        // 8. Forward (retry baked into provider). Precedence (#475):
        //   a) unified search-based tool loop — when the tools client is wired
        //      (CORE_URL set) AND the request carries the tool signal
        //      (x-ryu-tools present OR x-ryu-tool-search: on);
        //   b) else legacy Composio tool loop — when Composio is configured;
        //   c) else a plain completion.
        let (original_provider_options, original_models) =
            apply_node_openrouter_preferences(&state, &ctx, provider.name(), &mut body, true);
        let _pool_load = attempt
            .pool
            .as_ref()
            .and_then(|pool| provider_snapshot(&state, &ctx).provider_pools.acquire(pool));
        // A tool loop calls the provider once per round; each round is billed,
        // not only the final one the loop returns.
        let round_ledger = (loop_kind != ToolLoopKind::Plain)
            .then(|| Arc::new(tool_rounds::ToolRoundLedger::default()));
        let completion_result = dispatch_buffered(
            BufferedDispatch {
                state: &state,
                ctx: &ctx,
                provider: &provider,
                decision: &decision,
                loop_kind,
                tools_restricted,
                round_ledger: &round_ledger,
                caller: caller.as_ref(),
                execution_ceiling,
                attempt_index,
                budget: &budget,
                start,
            },
            &mut body,
            &mut credit_reservation,
        )
        .await?;
        restore_node_openrouter_preferences(
            provider.name(),
            &mut body,
            original_provider_options,
            original_models,
        );

        match completion_result {
            Ok((response, billable_tool_calls)) => {
                return finish_buffered_answer(
                    BufferedAnswer {
                        state: &state,
                        ctx,
                        attempt_index,
                        attempt,
                        route: &route,
                        provider: &provider,
                        decision,
                        body: &body,
                        pool_base_body: &pool_base_body,
                        round_ledger: &round_ledger,
                        execution_ceiling,
                        budget,
                        credit_reservation,
                        start,
                        admission: _admission,
                        primary_skipped,
                        prompt_cache_outcome,
                        policy_alert,
                        cache,
                    },
                    response,
                    billable_tool_calls,
                )
                .await;
            }
            Err(e) => {
                // A recognised upstream safety refusal on a Ryu-held
                // credential becomes a safety outcome here (spec 03.5).
                let e = upstream_signals::settle(&state, &ctx, attempt_index, e);
                // Rounds the provider answered before the loop failed are spend.
                if let Some(rounds) = round_ledger
                    .as_ref()
                    .map(|ledger| ledger.totals())
                    .filter(|rounds| rounds.rounds > 0)
                {
                    settle_failed_tool_rounds(
                        &state,
                        &ctx,
                        attempt_index,
                        rounds,
                        provider.name(),
                        &decision.model,
                        budget.clone(),
                        start,
                        credit_reservation.take(),
                        Some(&e),
                    );
                }
                if matches!(e, GatewayError::AccountingUnavailable) {
                    if let Some(org_id) = ctx.org_id.as_deref() {
                        state.wallet.set_org_accounting_unavailable(org_id, true);
                    }
                    return Err(e);
                }
                let failed = FailedChatAttempt {
                    provider: provider.name(),
                    circuit_key: bound_circuit_key(&route),
                    pool: attempt.pool.as_ref(),
                    was_primary: Some(provider_kind) == primary_provider.as_ref(),
                    // A managed tool loop may already have performed side effects
                    // before its model call failed. Never replay it on a member.
                    replay_unsafe: attempt.pool.is_some() && loop_kind != ToolLoopKind::Plain,
                    unavailable_log: "provider unavailable for this account, demoting to next tier",
                    failed_log: "provider failed, trying fallback",
                };
                if after_failed_chat_attempt(
                    &state,
                    &ctx,
                    failed,
                    e,
                    &decision.model,
                    start,
                    &mut last_err,
                    &mut primary_skipped,
                )? {
                    break;
                }
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let err = exhausted_chain_error(&state, last_err, &format!("model '{}'", decision.model));
    audit_failure(&state, &ctx, &decision.model, &err, start);
    let error_code = match &err {
        GatewayError::AllProvidersUnavailable(_) => "all_providers_unavailable",
        GatewayError::ProviderRateLimited { .. } => "provider_rate_limited",
        GatewayError::ProviderPaymentRequired { .. } => "provider_payment_required",
        GatewayError::RateLimited | GatewayError::RateLimitedBy(_) => "rate_limit_exceeded",
        GatewayError::InsufficientCredits => "insufficient_credits",
        GatewayError::AccountingUnavailable => "credit_accounting_unavailable",
        GatewayError::BudgetStoreUnavailable(_) => "budget_store_unavailable",
        GatewayError::BudgetExceeded(_) => "budget_exceeded",
        GatewayError::FirewallBlocked(_, _) | GatewayError::PolicyViolation(_) => {
            "policy_violation"
        }
        _ => "gateway_error",
    };
    crate::ryu_analytics::emit_model_call(
        "chat",
        "unknown",
        &decision.model,
        0,
        0,
        start.elapsed().as_millis() as u64,
        "error",
        Some(error_code),
    );
    Err(err)
}

#[cfg(test)]
#[path = "pool_runtime_tests.rs"]
mod pool_runtime_tests;
