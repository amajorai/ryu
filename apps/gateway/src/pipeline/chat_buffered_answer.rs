//! A buffered chat attempt that answered: settlement, the outbound screens,
//! the response caches, evals and the output.

use super::*;

/// Everything the answering attempt hands to [`finish_buffered_answer`].
pub(super) struct BufferedAnswer<'a> {
    pub(super) state: &'a Arc<AppState>,
    pub(super) ctx: RequestContext,
    pub(super) attempt_index: usize,
    pub(super) attempt: &'a ChatAttemptRoute,
    pub(super) route: &'a crate::providers::BoundRoute,
    pub(super) provider: &'a Arc<dyn ryu_gw_providers::Provider>,
    pub(super) decision: RouteDecision,
    pub(super) body: &'a Value,
    pub(super) pool_base_body: &'a Value,
    pub(super) round_ledger: &'a Option<Arc<tool_rounds::ToolRoundLedger>>,
    pub(super) execution_ceiling: Option<(tokio::time::Instant, usize)>,
    pub(super) budget: Option<BudgetDecision>,
    pub(super) credit_reservation: Option<CreditReservation>,
    pub(super) start: Instant,
    pub(super) admission: crate::concurrency::AdmissionPermit,
    pub(super) primary_skipped: bool,
    pub(super) prompt_cache_outcome: ryu_gw_providers::PromptCacheOutcome,
    pub(super) policy_alert: Option<PolicyAlert>,
    pub(super) cache: ChatCache,
}

/// Settle and screen the provider's `response`, then return it.
pub(super) async fn finish_buffered_answer(
    answer: BufferedAnswer<'_>,
    mut response: Value,
    billable_tool_calls: u64,
) -> Result<PipelineOutput, GatewayError> {
    let BufferedAnswer {
        state,
        ctx,
        attempt_index,
        attempt,
        route,
        provider,
        decision,
        body,
        pool_base_body,
        round_ledger,
        execution_ceiling,
        budget,
        mut credit_reservation,
        start,
        admission: _admission,
        primary_skipped,
        prompt_cache_outcome,
        policy_alert,
        cache:
            ChatCache {
                allowed: cache_allowed,
                origin: cache_origin,
                key: cache_key,
                semantic_scope,
                semantic_embedding,
            },
    } = answer;
    let provider_kind = &route.provider_id;
    upstream_signals::note_soft_refusal(&state, &ctx, attempt_index, provider.name(), &response);
    // A tool loop settles every round it ran. The client still
    // receives the final round's own usage.
    let round_totals = round_ledger.as_ref().map(|ledger| ledger.totals());
    let billed = round_totals.map(|rounds| rounds.billing_view(&response));
    // Only the answering round is judged against the token limits;
    // `admitted_tokens` keeps the earlier rounds out of that check.
    let earlier_round_tokens = round_totals.map_or(0, |rounds| rounds.earlier_round_tokens());
    if execution_ceiling.is_some_and(|(_, limit)| {
        pool_execution::response_text_bytes(&response).map_or(true, |bytes| bytes > limit)
    }) {
        // Settle accepted work below before rejecting oversized output.
        let _settlement = inference_governance::settle_completion(
            &state,
            &ctx,
            billed.as_ref().unwrap_or(&response),
            inference_governance::CompletionReceipt {
                provider: provider.name().to_owned(),
                model: decision.model.clone(),
                purpose: Some("pool_output_limit"),
                audit_provider: provider.name().into(),
                backend: Some("pool-final"),
                start,
                admitted_tokens: earlier_round_tokens,
                estimated_input: estimate_prompt_tokens(&body),
                budget: budget.clone(),
                reservations: credit_reservation.take().into_iter().collect(),
                zero_cost: false,
            },
        );
        record_earlier_round_tokens(&state, &ctx, earlier_round_tokens);
        return Err(GatewayError::ProviderError(
            "Pool final output exceeds configured byte limit".into(),
        ));
    }
    // Provider generation is complete and the response is fully
    // buffered. Release the local-engine slot before an output
    // evaluator makes a judge call through the same provider; a
    // single-slot local engine must be re-entrant for that
    // post-generation governance pass.
    drop(_admission);
    state
        .circuit_breaker
        .record_success(&bound_circuit_key(&route));
    if let Some(route) = attempt.pool.as_ref() {
        let affinity = account_affinity(&ctx, &body);
        provider_snapshot(&state, &ctx)
            .provider_pools
            .record_success_facts(
                route,
                affinity.as_deref(),
                &pool_signals::scoped_request_facts(&state, &ctx, &pool_base_body),
                start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            );
    }
    // Determine degraded mode: we served via a fallback when the primary
    // was skipped and a different provider is now responding (#218).
    let degraded = if primary_skipped {
        state.metrics.inc_degraded_fallback();
        Some(DegradedMode::Fallback(provider.name().to_string()))
    } else {
        None
    };

    let billed_response = billed.as_ref().unwrap_or(&response);
    let input_tokens = billed_response["usage"]["prompt_tokens"]
        .as_u64()
        .unwrap_or(0);
    let output_tokens = billed_response["usage"]["completion_tokens"]
        .as_u64()
        .unwrap_or(0);
    let cache_read_reported = provider_cached_tokens_reported(&response);
    let cache_write_reported = provider_cache_write_tokens_reported(&response);
    let cached_tokens = cache_read_reported.unwrap_or(0);
    let cache_write_tokens = cache_write_reported.unwrap_or(0);
    if cached_tokens > 0 {
        state.metrics.add_cached_tokens(cached_tokens);
    }
    if cache_write_tokens > 0 {
        state.metrics.add_cache_write_tokens(cache_write_tokens);
    }

    let mut settlement = inference_governance::settle_completion(
        &state,
        &ctx,
        billed_response,
        inference_governance::CompletionReceipt {
            provider: provider.name().to_owned(),
            model: decision.model.clone(),
            purpose: None,
            audit_provider: provider.name().into(),
            backend: None,
            start,
            admitted_tokens: earlier_round_tokens,
            estimated_input: estimate_prompt_tokens(&body),
            budget: budget.clone(),
            reservations: credit_reservation.take().into_iter().collect(),
            zero_cost: false,
        },
    );
    record_earlier_round_tokens(&state, &ctx, earlier_round_tokens);
    {
        let record = settlement.record_mut();
        record.prompt_cache_outcome = Some(prompt_cache_outcome.as_str().to_owned());
        record.prompt_cache_read_tokens = cache_read_reported;
        record.prompt_cache_write_tokens = cache_write_reported;
    }
    // Tools have already executed too; output rejection must not erase their bill.
    spawn_tool_call_debit(&state, &ctx, billable_tool_calls);
    // 9. Outbound firewall
    let policy_pass = apply_outbound_json_dlp(&state, &ctx, &mut response).map_err(|error| {
        settlement.fail(&error);
        error
    })?;

    // 9b. Unified-evaluator inline guardrails — OUTPUT target (P3).
    // Runs the resolved per-agent policy's enabled output evaluators
    // (pii_leakage regex, toxicity/bias LLM-judge) over the response,
    // reusing the firewall block/sanitize machinery. No-op when no
    // binding is enabled.
    apply_inline_output_evaluators(&state, &ctx, &mut response)
        .await
        .map_err(|error| {
            settlement.fail(&error);
            error
        })?;

    // 9c. Hazard screener on the output role (screener addendum
    // section 8). Classified before return; a block withholds the
    // response after the provider ran, so the settlement fails.
    // Its events name this attempt and its provider (spec 00.5).
    screen_buffered_output(
        &state,
        &ctx.at_attempt(attempt_index, &attempt.decision.provider),
        &response,
    )
    .await
    .map_err(|error| {
        settlement.fail(&error);
        error
    })?;

    if settlement.overrun {
        state.metrics.inc_rate_limited();
        state.metrics.inc_errors();
        return Err(GatewayError::RateLimited);
    }

    if let Some(route) = attempt.pool.as_ref() {
        if let Some(session) = account_affinity(&ctx, &pool_base_body) {
            let scope_session = format!("{}:{}", auxiliary::scope(&state, &ctx), session);
            let latest_user = pool_base_body["messages"]
                .as_array()
                .and_then(|messages| {
                    messages
                        .iter()
                        .rev()
                        .find(|message| message["role"] == "user")
                })
                .and_then(|message| message["content"].as_str())
                .unwrap_or_default();
            provider_snapshot(&state, &ctx).provider_pools.record_relay(
                route,
                &scope_session,
                &response,
                latest_user,
            );
        }
    }

    // 11. Eval scoring (sampled). When this request is sampled, score
    //      it and fold the result into the provider's rolling average
    //      so eval-driven routing can react to it.
    let latency_ms = start.elapsed().as_millis() as u64;
    let eval_score = if state.evals.should_sample() {
        let eval = state.evals.score(latency_ms, &response, policy_pass);
        if let Some(ref e) = eval {
            state
                .evals
                .record_provider_score(provider.name(), e.overall);
        }
        eval.map(|e| e.overall)
    } else {
        None
    };

    // 12. Exact-match cache store
    if cache_allowed
        && provider_kind == &decision.provider
        && decision.provider == cache_origin.0
        && decision.model == cache_origin.1
        && route.cache_allowed
    {
        state.cache.insert_async(cache_key, response.clone()).await;
    }

    // 12b. Semantic cache store (if we fetched an embedding earlier)
    if cache_allowed
        && provider_kind == &decision.provider
        && decision.provider == cache_origin.0
        && decision.model == cache_origin.1
        && route.cache_allowed
    {
        if let (Some(sc), Some(emb)) = (state.semantic_cache.active(), semantic_embedding) {
            sc.insert_async(Some(semantic_scope.clone()), emb, response.clone())
                .await;
        }
    }

    // 11b. Online evals (`[evals.online]`): offer a sampled copy of
    //      the DLP-processed exchange to the background scorer.
    //      Non-blocking; a full queue drops the sample.
    if state.online_evals.is_running() {
        crate::online_evals::maybe_enqueue(
            &state,
            &ctx,
            &crate::online_evals::latest_user_text(&pool_base_body),
            &crate::online_evals::response_text(&response),
            &decision.model,
            provider.name(),
        );
    }

    settlement.record_mut().eval_score = eval_score;
    settlement.record_mut().latency_ms = latency_ms;

    // 14b. The OTel GenAI model-call span already ended when the
    // provider returned (`gen_ai_telemetry::finish_chat` above).
    crate::ryu_analytics::emit_model_call(
        "chat",
        provider.name(),
        &decision.model,
        input_tokens,
        output_tokens,
        latency_ms,
        "ok",
        None,
    );

    info!(
        request_id = %ctx.request_id,
        provider = provider.name(),
        model = %decision.model,
        input_tokens,
        output_tokens,
        cached_tokens,
        cache_write_tokens,
        latency_ms,
        eval_score = ?eval_score,
        degraded = ?degraded,
        "request completed"
    );

    Ok(PipelineOutput {
        response,
        context: ctx,
        provider_used: provider.name(),
        model_used: decision.model,
        cache_hit: false,
        budget,
        eval_score,
        degraded,
        policy_alert,
        prompt_cache: prompt_cache_outcome,
        cache_read_tokens: cached_tokens,
        cache_write_tokens,
    })
}
