//! The streamed chat path's provider attempts: the fallback chain, each
//! attempt's screens, the stream opening and the chain-exhausted error.

use super::*;

/// Try each route of the fallback chain until one opens a stream (see
/// [`run_stream_unaliased`]).
pub(super) async fn run_stream_attempts(
    chat: StreamChat,
) -> Result<PipelineStreamOutput, GatewayError> {
    let StreamChat {
        state,
        ctx,
        mut body,
        mut decision,
        requested_model,
        start,
        settles_after_hang_up,
        mut sampling_extensions,
        pool_route,
        execution_ceiling,
        original_max_tokens,
        original_max_completion_tokens,
        budget,
        mut credit_reservation,
        budget_hold,
        mut policy_alert,
        estimated_tokens,
        tools_restricted,
        tools_active,
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
    let primary_provider_stream = fallback_chain
        .first()
        .map(|attempt| attempt.decision.provider.clone());
    let mut primary_skipped_stream = false;

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
        let canonical_provider =
            match canonical_sdk_provider(&state, &ctx, candidate_provider, &attempt.decision.model)
            {
                Ok(provider) => provider,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            };
        let provider_kind = &canonical_provider;
        if let Err(error) =
            inference_governance::authorize_provider_region(&state, &ctx, provider_kind)
        {
            last_err = Some(error);
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        }
        if state.circuit_breaker.is_open(&provider_circuit_key(
            &state,
            &ctx,
            provider_kind.as_str(),
        )) {
            remember_preferred_provider_error(
                &mut last_err,
                GatewayError::CircuitOpen(provider_kind.as_str().to_string()),
            );
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        }

        let Some(provider) = provider_snapshot(&state, &ctx)
            .providers
            .get_owned(provider_kind.as_str())
        else {
            if Some(provider_kind) == primary_provider_stream.as_ref() {
                primary_skipped_stream = true;
            }
            continue;
        };

        // A refused handoff ends the request, as on the non-streaming path.
        let relay_alert =
            readmit_attempt(&state, &ctx, attempt, &mut body, &decision.model, start).await?;
        policy_alert = merge_alert(policy_alert, relay_alert);

        state.metrics.inc_provider_request(provider.name());

        shape_attempt_body(
            &state,
            &ctx,
            &mut body,
            &mut sampling_extensions,
            provider.name(),
            &decision.model,
        );

        // Admission gate (streaming): same priority queue as the non-stream path.
        // The permit must outlive `run_stream` — a generation occupies an engine
        // slot for its whole duration — so on success it is *moved into* the
        // returned SSE body and dropped only at stream end (see
        // `hold_admission_until_stream_end`). On a provider error it drops here
        // and the slot frees before the fallback attempt. As on the non-stream
        // path, the re-entrant tool-loop case (`tools_active`) is left ungated to
        // avoid a parent holding a slot while a delegated child waits for one.
        // Output guardrails do not bypass this gate: their helper releases the
        // permit after the upstream stream is fully buffered, immediately before
        // any re-entrant LLM judge runs.
        let admission_permit =
            acquire_engine_slot(&state, &ctx, provider.name(), tools_active).await?;

        // Buffered tool loop → synthesized SSE, OR the fast direct stream.
        let (original_provider_options, original_models) =
            apply_node_openrouter_preferences(&state, &ctx, provider.name(), &mut body, true);
        let pool_load = attempt
            .pool
            .as_ref()
            .and_then(|pool| provider_snapshot(&state, &ctx).provider_pools.acquire(pool));
        // Every provider round of a tool loop is billed, not only the one the
        // synthesized stream carries.
        let round_ledger = tools_active.then(|| Arc::new(tool_rounds::ToolRoundLedger::default()));
        // A metered stream opens on its own task: the provider's answer, not
        // a client hang-up, decides whether the prompt is billed.
        let detached_open = (settles_after_hang_up && !tools_active)
            .then(|| Arc::new(DetachedStreamOpen::default()));
        // The observer exists before the provider is called, so work a client
        // abandons before the first byte is still settled. It holds the credit
        // claim from here on.
        let opening = StreamOpening::new(
            StreamObserverState::new(
                Arc::clone(&state),
                ctx.clone(),
                provider.name().to_string(),
                decision.model.clone(),
                prompt_cache_outcome,
                estimated_tokens,
                start,
                // Managed policy-alert (item 4): stamp the matched budget-cap
                // tier onto the stream-end debit. `limit > 0` excludes the
                // wallet-empty decision; only tiers >= Warn ride.
                budget
                    .as_ref()
                    .filter(|b| b.limit > 0 && b.alert >= AlertTier::Warn)
                    .map(|b| b.alert),
                // The credit claim follows the stream's debit, on every exit
                // including a client hang-up.
                credit_reservation.take(),
            )
            .with_online_prompt(&pool_base_body),
            round_ledger.clone(),
            detached_open.clone(),
            settles_after_hang_up,
        );
        // OTel GenAI model-call span for this attempt; on success it rides into
        // the stream observer and ends when the upstream stream does. The
        // buffered tool loop instead gets one span per provider call
        // (`traced_provider`), so its synthesized stream carries no span.
        let model_span = if tools_active {
            crate::telemetry::gen_ai_span::ModelCallSpan::disabled()
        } else {
            gen_ai_telemetry::start_span(
                &state,
                &ctx,
                crate::telemetry::gen_ai_span::OPERATION_CHAT,
                Some(gen_ai_telemetry::chat_output_type(&body)),
                provider.name(),
                &decision.model,
                &body,
                true,
            )
        };
        let open_stream = model_span.instrument(open_upstream(
            UpstreamOpen {
                state: &state,
                ctx: &ctx,
                provider: &provider,
                decision: &decision,
                tools_active,
                tools_restricted,
                round_ledger: &round_ledger,
                detached_open: &detached_open,
                settles_after_hang_up,
            },
            &mut body,
        ));
        let stream_result: Result<Body, GatewayError> =
            if let Some((deadline, _)) = execution_ceiling {
                match tokio::time::timeout_at(deadline, open_stream).await {
                    Ok(result) => result,
                    Err(_) => {
                        let error = GatewayError::ProviderDeliveryUncertain(
                            "Pool final stream opening timed out; accepted calls are not replayed"
                                .into(),
                        );
                        gen_ai_telemetry::finish_error(model_span, &error);
                        return Err(error);
                    }
                }
            } else {
                open_stream.await
            };
        restore_node_openrouter_preferences(
            provider.name(),
            &mut body,
            original_provider_options,
            original_models,
        );
        // Opened or failed: the observer is the caller's again.
        let mut observer = opening.opened();

        match stream_result {
            Ok(stream_body) => {
                return Ok(finish_stream_answer(
                    StreamAnswer {
                        state: &state,
                        ctx,
                        attempt_index,
                        attempt,
                        provider: &provider,
                        decision,
                        body: &body,
                        pool_base_body: &pool_base_body,
                        round_ledger: &round_ledger,
                        observer,
                        model_span,
                        execution_ceiling,
                        admission_permit,
                        budget_hold,
                        pool_load,
                        primary_skipped: primary_skipped_stream,
                        budget,
                        policy_alert,
                        prompt_cache_outcome,
                        start,
                    },
                    stream_body,
                )
                .await);
            }
            Err(e) => {
                let e = upstream_signals::settle(&state, &ctx, attempt_index, e);
                gen_ai_telemetry::finish_error(model_span, &e);
                match round_ledger
                    .as_ref()
                    .map(|ledger| ledger.totals())
                    .filter(|rounds| rounds.rounds > 0)
                {
                    // A tool loop that failed after rounds the provider
                    // answered: those rounds are spend, billed now under their
                    // own ref so a fallback attempt's debit is not taken for a
                    // duplicate of this one. The claim, shrunk to what the
                    // rounds cost, follows this debit.
                    Some(rounds) => {
                        observer.credit_reservation = shrink_credit_claim(
                            &state,
                            &ctx,
                            observer.credit_reservation.take(),
                            tool_rounds_charge_micro_usd(
                                &state,
                                &rounds,
                                provider.name(),
                                &decision.model,
                            ),
                        );
                        observer.tool_rounds = Some(rounds);
                        observer.interruption = Some("tool loop failed after paid provider rounds");
                        observer.ctx.request_id =
                            format!("{}:attempt-{attempt_index}", ctx.request_id);
                        drop(observer);
                    }
                    // Nothing was served: no charge, and the claim goes back to
                    // the attempt loop exactly as before.
                    None => {
                        credit_reservation = observer.credit_reservation.take();
                        observer.done = true;
                    }
                }
                let failed = FailedChatAttempt {
                    provider: provider.name(),
                    circuit_key: provider_circuit_key(&state, &ctx, provider.name()),
                    pool: attempt.pool.as_ref(),
                    was_primary: Some(provider_kind) == primary_provider_stream.as_ref(),
                    // A buffered tool loop can have performed external actions
                    // before its final provider failure. Do not replay it.
                    replay_unsafe: attempt.pool.is_some() && tools_active,
                    unavailable_log:
                        "stream provider unavailable for this account, demoting to next tier",
                    failed_log: "stream provider failed, trying fallback",
                };
                if after_failed_chat_attempt(
                    &state,
                    &ctx,
                    failed,
                    e,
                    &decision.model,
                    start,
                    &mut last_err,
                    &mut primary_skipped_stream,
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
    Err(err)
}
