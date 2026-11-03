//! A multimodal attempt that answered: the outbound screens, the audit row,
//! managed media metering and the output.

use super::*;

/// Everything the answering attempt hands to [`finish_media_answer`].
pub(super) struct MediaAnswer<'a> {
    pub(super) state: &'a Arc<AppState>,
    pub(super) ctx: RequestContext,
    pub(super) attempt_index: usize,
    pub(super) candidate_provider: &'a ProviderId,
    pub(super) provider: &'a Arc<dyn ryu_gw_providers::Provider>,
    pub(super) decision: RouteDecision,
    pub(super) modality: Modality,
    pub(super) start: Instant,
    pub(super) primary_skipped: bool,
    pub(super) budget: Option<BudgetDecision>,
    pub(super) credit_reservation: Option<CreditReservation>,
    pub(super) policy_alert: Option<PolicyAlert>,
    pub(super) speech_origin: Option<ryu_gw_providers::HostedSpeechOrigin>,
}

/// Screen, audit and meter the provider's `response`, then return it.
pub(super) async fn finish_media_answer(
    answer: MediaAnswer<'_>,
    mut response: Value,
) -> Result<(PipelineOutput, Option<ryu_gw_providers::HostedSpeechOrigin>), GatewayError> {
    let MediaAnswer {
        state,
        ctx,
        attempt_index,
        candidate_provider,
        provider,
        decision,
        modality,
        start,
        primary_skipped: primary_skipped_mm,
        budget,
        mut credit_reservation,
        policy_alert,
        speech_origin,
    } = answer;
    state
        .circuit_breaker
        .record_success(&provider_circuit_key(&state, &ctx, provider.name()));
    let latency_ms = start.elapsed().as_millis() as u64;

    apply_outbound_json_dlp(&state, &ctx, &mut response).map_err(|e| {
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
    // Hazard screener on the output role: chat text and STT
    // transcripts are classified before return (spec 02.11.3).
    // Generated images are not classified yet (no vision backend).
    let screened_output = match modality {
        Modality::Chat => Some(crate::screening::output::response_text(&response)),
        Modality::Stt => response["text"].as_str().map(str::to_owned),
        _ => None,
    };
    if let Some(text) = screened_output {
        crate::screening::output::screen_buffered(
            &state,
            &ctx.at_attempt(attempt_index, candidate_provider),
            &text,
            Some(decision.model.as_str()),
        )
        .await
        .map_err(|e| {
            audit_failure(&state, &ctx, &decision.model, &e, start);
            e
        })?;
    }

    let degraded = if primary_skipped_mm {
        state.metrics.inc_degraded_fallback();
        Some(DegradedMode::Fallback(provider.name().to_string()))
    } else {
        None
    };
    let provider_cost_micro_usd = response_reported_cost_usd(&response).and_then(cost_usd_to_micro);
    let has_output =
        modality != Modality::Image || response["data"].as_array().is_some_and(|a| !a.is_empty());
    let (media_cost_micro_usd, estimated_media_cost) =
        media_cost_from_response(&state, &modality, &response);
    if has_output {
        record_charged_budget_kind(
            &state,
            &ctx,
            BudgetChargeKind::Media,
            state
                .config
                .credits
                .debit_amount_for_provider(Some(provider.name()), media_cost_micro_usd),
        );
    }

    state.log_audit(AuditRecord {
        request_id: ctx.request_id.clone(),
        api_key: ctx.api_key.clone(),
        user_name: ctx.user_name.clone(),
        org_id: ctx.org_id.clone(),
        team_id: ctx.team_id.clone(),
        team_ids: ctx.audit_team_ids(),
        key_id: ctx.key_id(),
        project_id: ctx.project_id.clone(),
        provider: format!("{}:{}", provider.name(), modality.as_str()),
        model: decision.model.clone(),
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms,
        eval_score: None,
        error: None,
        skill_ids: ctx.skill_ids.clone(),
        session_id: ctx.session_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        feature: ctx.feature.clone(),
        purpose: ctx.purpose.clone(),
        managed_inference: ctx.managed_inference,
        provider_cost_micro_usd,
        event_type: crate::audit::EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        widget_instance_id: None,
    });

    // The OTel GenAI span (`generate_content`, or `chat` for a chat
    // modality) ended when the provider returned, carrying only the
    // token counts the provider actually reported.
    crate::ryu_analytics::emit_model_call(
        modality.as_str(),
        provider.name(),
        &decision.model,
        0,
        0,
        latency_ms,
        "ok",
        None,
    );

    info!(
        request_id = %ctx.request_id,
        provider = provider.name(),
        modality = modality.as_str(),
        model = %decision.model,
        latency_ms,
        degraded = ?degraded,
        "multimodal request completed"
    );

    // Managed media metering: debit the configured flat per-modality
    // rate on success. Cloud media providers don't report a
    // usage.cost like chat, so managed nodes meter media at a fixed
    // rate through the same at-cost + markup path as tokens. NOP
    // unless credits are active and an org is present, so local/BYOK
    // installs are unaffected. (The rates themselves no longer default
    // to 0 — an unset one resolves to a real fallback, and only an
    // explicit 0 in the deploy config gives a modality away.)
    // Filter empty org (mirrors the chat debit path) and, for image,
    // skip billing a "success" that produced no media (content-
    // filtered / empty output).
    if let Some(org_id) = ctx.org_id.clone().filter(|s| !s.is_empty()) {
        // Priced from the compute time the provider REPORTED where
        // it gave one; the flat rate is a fallback, and `estimated`
        // records which of the two paid for this row so a later
        // reconciliation against the provider invoice can tell them
        // apart.
        // OUTSIDE the `cost > 0` guard, deliberately. A fallback that
        // prices to zero is the exact combination that shipped unbilled
        // media twice, and inside the guard it is the one case that
        // cannot warn — no debit, no log, no invoice line to reconcile
        // against. This is the smallest change that would have surfaced
        // both on their first production call.
        if estimated_media_cost && has_output {
            warn!(
                modality = modality.as_str(),
                cost = media_cost_micro_usd,
                billed = media_cost_micro_usd > 0,
                "credits: media billed at the FLAT fallback rate — the \
                 provider reported no compute time"
            );
        }
        if media_cost_micro_usd > 0 && has_output {
            let fail_closed_sticky = state.config.credits.fail_closed && ctx.managed_inference;
            // The credit permit rides INTO the task so it outlives
            // the debit, not the handler. Image generation is the
            // most expensive per-call managed surface, so this is
            // the path where a freed-early claim costs the most.
            let credit_permit = credit_reservation.take();
            let state_debit = state.clone();
            let ref_id = media_debit_reference(&modality);
            let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
            let debit_attribution = DebitAttribution {
                provider: Some(provider.name().to_string()),
                upstream_provider: provider_usage::response_upstream_provider(&response),
                model: Some(decision.model.clone()),
                // The provider's REPORTED compute time when the
                // metered path priced this call, absent when it fell
                // back to the flat rate — so a statement row with no
                // duration is exactly a row that was estimated.
                duration_ms: response["usage"]["compute_seconds"]
                    .as_f64()
                    .filter(|s| *s > 0.0)
                    .map(|s| (s * 1000.0).round() as u64),
                user_id: ctx.user_id.clone(),
                task_label: Some(media_task_label(&modality, estimated_media_cost)),
                estimated: Some(estimated_media_cost),
                tags: crate::org_limits::tags_for(&ctx),
                scope: crate::org_limits::LedgerScope::for_request(&ctx),
                ..Default::default()
            };
            tokio::spawn(async move {
                debit_wallet_for_request(
                    state_debit,
                    org_id,
                    ref_id,
                    CreditDebitReason::GatewayUsage,
                    media_cost_micro_usd,
                    fail_closed_sticky,
                    // Media debits carry no budget-cap tier (item 4
                    // is scoped to charged-cost budgets).
                    None,
                    pool,
                    // No token counts: media has none.
                    debit_attribution,
                )
                .await;
                drop(credit_permit);
            });
        }
    }

    Ok((
        PipelineOutput {
            response,
            context: ctx,
            provider_used: provider.name(),
            model_used: decision.model,
            cache_hit: false,
            budget,
            eval_score: None,
            degraded,
            policy_alert,
            // Media/multimodal path: prompt caching does not apply.
            prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
        },
        speech_origin,
    ))
}
