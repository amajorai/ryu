//! Embeddings and reranking through the same governance as chat: admission,
//! input screens, budgets, the embedding cache and the fallback chain.

use super::*;

/// Run embeddings or reranking through the same governance used by chat and
/// multimodal calls. These endpoints still consume provider tokens and wallet
/// credits even though their response shape is not a chat completion.
/// Metered calls are detached for the same reason as [`run`]: a client hang-up
/// must not cancel an accepted embedding or rerank call before it is settled.
pub async fn run_embedding(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
    operation: EmbeddingOperation,
) -> Result<PipelineOutput, GatewayError> {
    let detach = settles_after_client_hang_up(&state, &ctx);
    run_buffered(detach, run_embedding_attached(state, ctx, body, operation)).await
}

pub(super) async fn run_embedding_attached(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    operation: EmbeddingOperation,
) -> Result<PipelineOutput, GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();
    state.metrics.inc_requests();
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    if let Err(error) = admit_request(&state, &ctx) {
        state.metrics.inc_rate_limited();
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }

    let shape = match operation {
        EmbeddingOperation::Embed => inference_governance::InputShape::Embedding,
        EmbeddingOperation::Rerank => inference_governance::InputShape::Rerank,
    };
    let mut decision = provider_snapshot(&state, &ctx)
        .router
        .route(&requested_model);
    canonicalize_sdk_decision(&state, &ctx, &mut decision)?;
    let input_alert = (|| {
        inference_governance::authorize_model(&state, &ctx, &requested_model)?;
        inference_governance::enforce_lifetime_budget(&state, &ctx, &mut body, &mut decision)?;
        inference_governance::inspect_input(&state, &ctx, &mut body, shape)
    })()
    .map_err(|error| {
        audit_failure(&state, &ctx, &requested_model, &error, start);
        error
    })?;
    if let Err(error) = crate::screening::admit::screen_value(
        &state,
        &ctx,
        &body,
        crate::screening::admit::Surface::Embeddings,
    )
    .await
    {
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }
    let estimated_input = inference_governance::input_token_estimate(&body, shape);
    if !state.rate_limiter.check_tokens_for_key(
        &ctx.api_key,
        estimated_input,
        ctx.key_config.as_ref(),
    ) || !crate::org_limits::check_tokens(&state, &ctx, estimated_input)
    {
        let error = GatewayError::RateLimited;
        audit_failure(&state, &ctx, &requested_model, &error, start);
        return Err(error);
    }

    let original_max_tokens = body.get("max_tokens").cloned();
    let BudgetOutcome {
        decision: budget,
        alert: policy_alert,
        reservation: mut credit_reservation,
        budget_hold: _budget_hold,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Untouched,
    )
    .map_err(|error| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &error, start);
        error
    })?;

    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|error| {
        audit_failure(&state, &ctx, &decision.model, &error, start);
        error
    })?;
    inference_governance::authorize_provider_region(&state, &ctx, &decision.provider).map_err(
        |error| {
            audit_failure(&state, &ctx, &decision.model, &error, start);
            error
        },
    )?;
    body["model"] = json!(decision.model);
    // Restrict is a text-generation budget action; do not add a chat-only field to this wire shape.
    if let Some(max_tokens) = original_max_tokens {
        body["max_tokens"] = max_tokens;
    } else if let Some(object) = body.as_object_mut() {
        object.remove("max_tokens");
    }
    let mut input_reservation =
        inference_governance::reserve_input_credit(&state, &ctx, &decision, estimated_input)
            .map_err(|error| {
                audit_failure(&state, &ctx, &decision.model, &error, start);
                error
            })?;
    let policy_alert = merge_alert(input_alert, policy_alert);
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    // Embedding cache: a request whose every input is cached is answered without
    // a provider call, after all admission and input governance above ran.
    let embedding_slot = embedding_cache_slot(&state, &ctx, &decision, &body, operation);
    if let (Some(cache), Some((scope, request))) =
        (state.embedding_cache.as_ref(), embedding_slot.as_ref())
    {
        if let Some(cached) = cache.lookup(scope, &decision.model, request).await {
            debug!(request_id = %ctx.request_id, "embedding cache hit");
            state.metrics.inc_embedding_cache_hit();
            audit_cache_hit(
                &state,
                &ctx,
                "cache",
                &model_alias::display_model(decision.provider.as_str(), &decision.model),
                &cached,
                start,
            );
            return Ok(PipelineOutput {
                response: cached,
                context: ctx,
                provider_used: "cache",
                model_used: decision.model,
                cache_hit: true,
                budget: None,
                eval_score: None,
                degraded: None,
                policy_alert,
                prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            });
        }
        state.metrics.inc_embedding_cache_miss();
    }

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let primary_provider = fallback_chain.first().cloned();
    let mut primary_skipped = false;
    let mut last_error: Option<GatewayError> = None;

    for (attempt_index, candidate_provider) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        let canonical_provider =
            match canonical_sdk_provider(&state, &ctx, candidate_provider, &decision.model) {
                Ok(provider) => provider,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            };
        let provider_kind = &canonical_provider;
        if let Err(error) =
            inference_governance::authorize_provider_region(&state, &ctx, provider_kind)
        {
            last_error = Some(error);
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }
        if state.circuit_breaker.is_open(&provider_circuit_key(
            &state,
            &ctx,
            provider_kind.as_str(),
        )) {
            last_error = Some(GatewayError::CircuitOpen(
                provider_kind.as_str().to_string(),
            ));
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        }

        let Some(provider) = provider_snapshot(&state, &ctx)
            .providers
            .get_owned(provider_kind.as_str())
        else {
            if Some(provider_kind) == primary_provider.as_ref() {
                primary_skipped = true;
            }
            continue;
        };
        if attempt_index > 0 {
            drop(credit_reservation.take());
            drop(input_reservation.take());
            let retry = RouteDecision {
                provider: provider_kind.clone(),
                model: decision.model.clone(),
            };
            let pool = crate::credit_pools::pool_for_gateway_provider(provider_kind.as_str());
            if let Some(error) = preflight_credit_gate(&ctx, pool) {
                last_error = Some(error);
                continue;
            }
            match inference_governance::reserve_input_credit(&state, &ctx, &retry, estimated_input)
            {
                Ok(reservation) => input_reservation = reservation,
                Err(error) => {
                    last_error = Some(error);
                    continue;
                }
            }
        }
        state.metrics.inc_provider_request(provider.name());

        let mut provider_body = body.clone();
        node_routing::apply_openrouter_preferences(
            ctx.openrouter_routing_enabled,
            ctx.node_routing.as_ref(),
            &state.config.node_routing,
            provider.name(),
            &mut provider_body,
        );
        let embedding_surface = match operation {
            EmbeddingOperation::Embed => crate::identity::UpstreamSurface::Embedding,
            EmbeddingOperation::Rerank => crate::identity::UpstreamSurface::Rerank,
        };
        stamp_upstream_identity(
            &state,
            &ctx,
            &mut provider_body,
            provider.name(),
            embedding_surface,
        );
        let model_span = gen_ai_telemetry::start_span(
            &state,
            &ctx,
            gen_ai_telemetry::embedding_operation(operation),
            None,
            provider.name(),
            &decision.model,
            &provider_body,
            false,
        );
        let result = model_span
            .instrument(async {
                match operation {
                    EmbeddingOperation::Embed => provider
                        .embed(&decision.model, &provider_body)
                        .await
                        .map_err(GatewayError::from),
                    EmbeddingOperation::Rerank => provider
                        .rerank(&decision.model, &provider_body)
                        .await
                        .map_err(GatewayError::from),
                }
            })
            .await;
        match &result {
            Ok(response) => gen_ai_telemetry::finish_reported(model_span, response),
            Err(error) => gen_ai_telemetry::finish_error(model_span, error),
        }

        match result {
            Ok(response) => {
                state.circuit_breaker.record_success(&provider_circuit_key(
                    &state,
                    &ctx,
                    provider.name(),
                ));
                let exceeded = inference_governance::settle_completion(
                    &state,
                    &ctx,
                    &response,
                    inference_governance::CompletionReceipt {
                        provider: provider.name().to_owned(),
                        model: decision.model.clone(),
                        purpose: Some(operation.as_str()),
                        audit_provider: format!("{}:{}", provider.name(), operation.as_str()),
                        backend: None,
                        start,
                        admitted_tokens: estimated_input,
                        estimated_input,
                        budget: budget.clone(),
                        reservations: [credit_reservation.take(), input_reservation.take()]
                            .into_iter()
                            .flatten()
                            .collect(),
                        zero_cost: false,
                    },
                );
                if exceeded.overrun {
                    state.metrics.inc_rate_limited();
                    state.metrics.inc_errors();
                    return Err(GatewayError::RateLimited);
                }

                // Only the provider the cache scope names may populate it; a
                // fallback provider's vectors live in a different space.
                if provider_kind == &decision.provider {
                    if let (Some(cache), Some((scope, request))) =
                        (state.embedding_cache.as_ref(), embedding_slot.as_ref())
                    {
                        cache.store(scope, request, &response).await;
                    }
                }

                let degraded = if primary_skipped {
                    state.metrics.inc_degraded_fallback();
                    Some(DegradedMode::Fallback(provider.name().to_string()))
                } else {
                    None
                };
                return Ok(PipelineOutput {
                    response,
                    context: ctx,
                    provider_used: provider.name(),
                    model_used: decision.model,
                    cache_hit: false,
                    budget,
                    eval_score: None,
                    degraded,
                    policy_alert,
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
                });
            }
            Err(error) => {
                let error = upstream_signals::settle(&state, &ctx, attempt_index, error);
                // A safety outcome ends the request: see the chat arm.
                if error.is_safety_outcome() {
                    audit_failure(&state, &ctx, &decision.model, &error, start);
                    return Err(error);
                }
                if matches!(&error, GatewayError::ProviderDeliveryUncertain(_)) {
                    state.metrics.inc_provider_error(provider.name());
                    last_error = Some(error);
                    break;
                }
                if penalizes_provider_circuit(&error) {
                    state.circuit_breaker.record_failure(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.name(),
                    ));
                }
                state.metrics.inc_provider_error(provider.name());
                let ends_chain = ends_attempt_chain(&state, &error);
                last_error = Some(error);
                if ends_chain {
                    break;
                }
                if Some(provider_kind) == primary_provider.as_ref() {
                    primary_skipped = true;
                }
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let error = exhausted_chain_error(
        &state,
        last_error,
        &format!("{} model '{}'", operation.as_str(), decision.model),
    );
    audit_failure(&state, &ctx, &decision.model, &error, start);
    Err(error)
}
