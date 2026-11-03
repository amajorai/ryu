//! The multimodal pipeline (image / TTS / STT): the same firewall, rate-limit,
//! budget, circuit-breaker and audit governance as chat.

use super::*;

/// Run a non-chat modality request (image-gen, TTS, STT) through the same
/// firewall, rate-limit, budget, circuit-breaker, and audit pipeline as chat.
/// Returns the raw provider JSON response.
///
/// The modality decides which provider method is called:
///   - `Modality::Image`  → `provider.generate_image()`
///   - `Modality::Tts`    → `provider.synthesize_speech()`
///   - `Modality::Stt`    → `provider.transcribe_audio()`
///   - `Modality::Chat`   → falls through to normal chat (`run`)
pub async fn run_multimodal(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
    modality: Modality,
) -> Result<PipelineOutput, GatewayError> {
    if modality == Modality::Tts {
        return Err(GatewayError::BadRequest(
            "Speech requires the bound delivery pipeline".into(),
        ));
    }
    run_multimodal_bound(state, ctx, body, modality)
        .await
        .map(|(output, _)| output)
}

/// Accepted provider work settles once before opaque hosted audio delivery.
pub async fn run_speech(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    run_multimodal_bound(state, ctx, body, Modality::Tts).await
}

/// Metered media generation is detached for the same reason as [`run`]: a
/// client hang-up must not cancel accepted provider work before it is settled.
pub(super) async fn run_multimodal_bound(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
    modality: Modality,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    let detach = settles_after_client_hang_up(&state, &ctx);
    run_buffered(
        detach,
        run_multimodal_bound_attached(state, ctx, body, modality),
    )
    .await
}

pub(super) async fn run_multimodal_bound_attached(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    modality: Modality,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();

    state.metrics.inc_requests();

    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    // Ladder L3 takes media generation and transcription away (spec
    // 04.8.1). Chat through this path is not media.
    if modality != Modality::Chat {
        if let Err(e) = crate::enforcement::refuse_media(&ctx) {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            return Err(e);
        }
    }
    screen_media_knobs(&state, &ctx, &mut body, &requested_model, start)?;
    let input_alert =
        inference_governance::inspect_multimodal_input(&state, &ctx, &mut body, &modality)
            .map_err(|e| {
                state.metrics.inc_errors();
                audit_failure(&state, &ctx, &requested_model, &e, start);
                e
            })?;
    let screen_surface = match modality {
        Modality::Chat => crate::screening::admit::Surface::Chat,
        Modality::Stt => crate::screening::admit::Surface::Transcription,
        _ => crate::screening::admit::Surface::Media,
    };
    if let Err(e) = crate::screening::admit::screen_value(&state, &ctx, &body, screen_surface).await
    {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // An unavailable guardrail must never silently permit a billed media request.
    let scanner = state.resolved_scanner(&ctx);
    state
        .evaluator_registry()
        .validate_inline_bindings(&scanner.config().evaluators)
        .map_err(|reason| {
            let error = GatewayError::BadRequest(reason);
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &error, start);
            error
        })?;

    // Rate limit + burst check.
    if let Err(e) = admit_request(&state, &ctx) {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), policy = rate_limit_policy_name(&e), "rate limit exceeded (multimodal)");
        state.metrics.inc_rate_limited();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // Modality-aware routing — honor the per-agent slot override forwarded by
    // Core (M3 / #164) so each modality call from the same carded agent can
    // reach a different provider. Governance (firewall, budgets, policy) runs
    // after routing and is never bypassed.
    let decision = provider_snapshot(&state, &ctx)
        .router
        .route_modality_with_slot(
            &modality,
            &requested_model,
            ctx.slot_provider.as_ref(),
            ctx.slot_model.as_deref(),
        );

    // Budget enforcement (reuse the chat path's enforcer).
    let mut decision = decision;
    canonicalize_sdk_decision(&state, &ctx, &mut decision)?;
    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
    let BudgetOutcome {
        decision: budget,
        alert: policy_alert,
        // Same shape as the non-streamed chat path, and for the same reason:
        // the media debit is SPAWNED, so a permit dropped when this function
        // returns would free the claim while the debit is still in flight and
        // `remaining_budget_micro_usd` still reads the stale cached figure.
        // `.take()`n into the task below; if no debit fires (credits inactive,
        // no org, zero rate, empty output) it stays here and drops on return.
        reservation: mut credit_reservation,
        // Media spend is recorded before this returns; hold the claim until then.
        budget_hold: _budget_hold,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        budget_charge_kind_for_modality(&modality),
        OutputCeiling::Untouched,
    )
    .map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        e
    })?;

    let policy_alert = merge_alert(input_alert, policy_alert);

    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    let fallback_chain = clamped_fallback_chain(&state, &ctx, &decision);
    let mut last_err: Option<GatewayError> = None;
    let primary_provider_mm = fallback_chain.first().cloned();
    let mut primary_skipped_mm = false;

    for (attempt_index, candidate_provider) in fallback_chain.iter().enumerate() {
        // Standing first on every attempt (spec 05.5): a push that lands
        // while an attempt fails must stop the next one from dispatching.
        crate::standing::recheck(&state, &ctx).await?;
        let canonical_provider =
            match canonical_sdk_provider(&state, &ctx, candidate_provider, &decision.model) {
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
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
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
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        }

        let Some(provider) = provider_snapshot(&state, &ctx)
            .providers
            .get_owned(provider_kind.as_str())
        else {
            if Some(provider_kind) == primary_provider_mm.as_ref() {
                primary_skipped_mm = true;
            }
            continue;
        };

        if attempt_index > 0 {
            drop(credit_reservation.take());
            let retry = RouteDecision {
                provider: provider_kind.clone(),
                model: decision.model.clone(),
            };
            match reserve_route_credit(&state, &ctx, &mut body, &retry, OutputCeiling::Untouched) {
                Ok(reservation) => credit_reservation = reservation,
                Err(error) => {
                    last_err = Some(error);
                    continue;
                }
            }
        }

        state.metrics.inc_provider_request(provider.name());

        stamp_upstream_identity(
            &state,
            &ctx,
            &mut body,
            provider.name(),
            crate::identity::UpstreamSurface::for_modality(&modality),
        );

        let (original_provider_options, original_models) =
            apply_node_openrouter_preferences(&state, &ctx, provider.name(), &mut body, false);
        let speech_affinity = account_affinity(&ctx, &body);
        let mut speech_origin = None;
        let (gen_ai_operation, gen_ai_output_type) =
            gen_ai_telemetry::multimodal_operation(&modality, &body);
        let model_span = gen_ai_telemetry::start_span(
            &state,
            &ctx,
            gen_ai_operation,
            Some(gen_ai_output_type),
            provider.name(),
            &decision.model,
            &body,
            false,
        );
        let result = model_span
            .instrument(async {
                match modality {
                    Modality::Image => provider
                        .generate_image(&decision.model, &body)
                        .await
                        .map_err(GatewayError::from),
                    Modality::Tts => provider
                        .synthesize_speech_bound(&decision.model, &body, speech_affinity.as_deref())
                        .await
                        .map(|bound| {
                            let (response, origin) = bound.into_parts();
                            speech_origin = origin;
                            response
                        })
                        .map_err(GatewayError::from),
                    Modality::Stt => provider
                        .transcribe_audio(&decision.model, &body)
                        .await
                        .map_err(GatewayError::from),
                    Modality::Chat => {
                        let affinity = account_affinity(&ctx, &body);
                        provider
                            .complete_for_session(&decision.model, &body, affinity.as_deref())
                            .await
                            .map_err(GatewayError::from)
                    }
                    // Video and audio generation are job-based (submit + poll);
                    // they never flow through the block-and-return path.
                    // `submit_media_job` handles them instead.
                    Modality::Video => Err(GatewayError::ProviderError(
                        "video generation is job-based; use POST /v1/videos/generations"
                            .to_string(),
                    )),
                    Modality::Audio => Err(GatewayError::ProviderError(
                        "audio generation is job-based; use POST /v1/audio/generations".to_string(),
                    )),
                }
            })
            .await;
        match &result {
            Ok(response) if modality == Modality::Chat => {
                gen_ai_telemetry::finish_chat(model_span, response)
            }
            Ok(response) => gen_ai_telemetry::finish_reported(model_span, response),
            Err(error) => gen_ai_telemetry::finish_error(model_span, error),
        }
        restore_node_openrouter_preferences(
            provider.name(),
            &mut body,
            original_provider_options,
            original_models,
        );

        match result {
            Ok(response) => {
                return finish_media_answer(
                    MediaAnswer {
                        state: &state,
                        ctx,
                        attempt_index,
                        candidate_provider,
                        provider: &provider,
                        decision,
                        modality: modality.clone(),
                        start,
                        primary_skipped: primary_skipped_mm,
                        budget,
                        credit_reservation,
                        policy_alert,
                        speech_origin,
                    },
                    response,
                )
                .await;
            }
            Err(e) => {
                let e = upstream_signals::settle(&state, &ctx, attempt_index, e);
                // A safety outcome ends the request: see the chat arm.
                if e.is_safety_outcome() {
                    audit_failure(&state, &ctx, &decision.model, &e, start);
                    return Err(e);
                }
                if matches!(&e, GatewayError::ProviderDeliveryUncertain(_)) {
                    state.metrics.inc_provider_error(provider.name());
                    last_err = Some(e);
                    break;
                }
                if penalizes_provider_circuit(&e) {
                    state.circuit_breaker.record_failure(&provider_circuit_key(
                        &state,
                        &ctx,
                        provider.name(),
                    ));
                }
                state.metrics.inc_provider_error(provider.name());
                log_provider_failure(
                    provider.name(),
                    &e,
                    "multimodal provider failed, trying fallback",
                );
                if ends_attempt_chain(&state, &e) {
                    last_err = Some(e);
                    break;
                }
                if Some(provider_kind) == primary_provider_mm.as_ref() {
                    primary_skipped_mm = true;
                }
                remember_preferred_provider_error(&mut last_err, e);
            }
        }
    }

    state.metrics.inc_errors();
    state.metrics.inc_degraded_exhausted();
    let err = exhausted_chain_error(
        &state,
        last_err,
        &format!("{modality:?} model '{}'", decision.model),
    );
    audit_failure(&state, &ctx, &decision.model, &err, start);
    Err(err)
}

/// Extract the user-visible input text from a multimodal request body for
/// inbound firewall scanning. TTS: `input`; image, video and audio: `prompt`
/// plus every other non-`data:` string leaf (see
/// `inference_governance::multimodal_text_fields`); STT: no text. These are the
/// fields Sanitize rewrites; every other string the provider receives is
/// screened as the residual (see `outbound_text`).
pub(super) fn multimodal_input_text(body: &Value, modality: &Modality) -> String {
    inference_governance::multimodal_text_fields(body, modality).join("\n")
}

#[cfg(test)]
#[path = "audio_tests.rs"]
mod audio_tests;
