use super::*;

/// Force the vendor safety knobs of a media body to their safe values and
/// refuse a weights reference (see `media_knobs`). Runs first, before the
/// firewall reads the body and before routing, so the screened body is the one
/// dispatched, no provider is chosen for a refused request, and the key in use
/// (master key included) changes nothing.
pub(super) fn screen_media_knobs(
    state: &AppState,
    ctx: &RequestContext,
    body: &mut Value,
    requested_model: &str,
    start: Instant,
) -> Result<(), GatewayError> {
    let rewrites = media_knobs::enforce(state.custody, body).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(state, ctx, requested_model, &e, start);
        e
    })?;
    if !rewrites.is_empty() {
        tracing::info!(
            request_id = %ctx.request_id,
            rewrites = ?rewrites,
            "forced media safety knobs to their safe values"
        );
    }
    Ok(())
}

// ─── Job-based media generation (video, audio) ─────────────────────────────────

/// The provider-side job kind for a job-based modality, or `None` for the
/// synchronous modalities that must never reach the queued-job path.
pub(super) fn media_job_kind(modality: &Modality) -> Option<ryu_gw_providers::MediaJobKind> {
    match modality {
        Modality::Video => Some(ryu_gw_providers::MediaJobKind::Video),
        Modality::Audio => Some(ryu_gw_providers::MediaJobKind::Audio),
        Modality::Chat | Modality::Image | Modality::Tts | Modality::Stt => None,
    }
}

/// Submit a video-generation job. See [`submit_media_job`].
pub async fn submit_video_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<Value, GatewayError> {
    submit_media_job(state, ctx, body, Modality::Video).await
}

/// Submit an audio-generation (music or sound-effect) job. See
/// [`submit_media_job`].
pub async fn submit_audio_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<Value, GatewayError> {
    submit_media_job(state, ctx, body, Modality::Audio).await
}

/// Submit a job-based media generation (video or audio). Runs the SAME
/// governance as `run_multimodal` (inbound firewall, rate limit, routing,
/// budget) but, because cloud video and music run for minutes, it does not
/// block: it kicks off the provider's async job, stores a
/// [`crate::jobs::MediaJob`] keyed by a fresh execution id, and returns the job
/// envelope (`{ id, status, model }`) for the client to poll.
pub async fn submit_media_job(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    modality: Modality,
) -> Result<Value, GatewayError> {
    let Some(job_kind) = media_job_kind(&modality) else {
        return Err(GatewayError::BadRequest(format!(
            "{} is not a job-based media modality",
            modality.as_str()
        )));
    };
    let label = modality.as_str();
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();
    state.metrics.inc_requests();
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();

    // Ladder L3 takes video generation away (spec 04.8.1). Polling a job
    // submitted before the restriction is not refused.
    if let Err(e) = crate::enforcement::refuse_media(&ctx) {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }
    screen_media_knobs(&state, &ctx, &mut body, &requested_model, start)?;
    let _input_alert =
        inference_governance::inspect_multimodal_input(&state, &ctx, &mut body, &modality)
            .map_err(|e| {
                state.metrics.inc_errors();
                audit_failure(&state, &ctx, &requested_model, &e, start);
                e
            })?;

    if let Err(e) = crate::screening::admit::screen_value(
        &state,
        &ctx,
        &body,
        crate::screening::admit::Surface::Media,
    )
    .await
    {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // Rate limit + burst.
    if let Err(e) = admit_request(&state, &ctx) {
        state.metrics.inc_rate_limited();
        audit_failure(&state, &ctx, &requested_model, &e, start);
        return Err(e);
    }

    // Route (honor the per-agent slot for this modality) + budget.
    let decision = provider_snapshot(&state, &ctx)
        .router
        .route_modality_with_slot(
            &modality,
            &requested_model,
            ctx.slot_provider.as_ref(),
            ctx.slot_model.as_deref(),
        );
    let mut decision = decision;
    canonicalize_sdk_decision(&state, &ctx, &mut decision)?;
    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
    // Media jobs are job-based, so the reservation must move into the tracked
    // in-memory job record and live until the provider reaches a terminal state.
    // Dropping it at the end of submit reopens the exact headroom that concurrent
    // jobs are meant to claim.
    let BudgetOutcome {
        reservation: credit_reservation,
        ..
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Media,
        OutputCeiling::Untouched,
    )
    .map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &requested_model, &e, start);

        e
    })?;

    inference_governance::authorize_model(&state, &ctx, &decision.model).map_err(|e| {
        state.metrics.inc_errors();
        audit_failure(&state, &ctx, &decision.model, &e, start);
        e
    })?;
    inference_governance::authorize_provider_region(&state, &ctx, &decision.provider).map_err(
        |e| {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &decision.model, &e, start);
            e
        },
    )?;

    let provider_kind = decision.provider.clone();
    if state
        .circuit_breaker
        .is_open(&provider_circuit_key(&state, &ctx, provider_kind.as_str()))
    {
        let e = GatewayError::CircuitOpen(provider_kind.as_str().to_string());
        audit_failure(&state, &ctx, &decision.model, &e, start);
        return Err(e);
    }
    let Some(provider) = provider_snapshot(&state, &ctx)
        .providers
        .get_owned(provider_kind.as_str())
    else {
        let e = GatewayError::AllProvidersUnavailable(format!(
            "{label} provider '{}' not configured",
            provider_kind.as_str()
        ));
        audit_failure(&state, &ctx, &decision.model, &e, start);
        return Err(e);
    };

    state.metrics.inc_provider_request(provider.name());
    stamp_upstream_identity(
        &state,
        &ctx,
        &mut body,
        provider.name(),
        crate::identity::UpstreamSurface::Video,
    );
    let accepted = provider
        .submit_media_job_bound(&decision.model, &body, job_kind)
        .await
        .map_err(GatewayError::from)
        .map_err(|e| {
            // Same rule as every other provider path: a rejected request, a
            // 429/402, or a transport fault says nothing about the provider's
            // health and must not open the circuit every tenant shares.
            if penalizes_provider_circuit(&e) {
                state.circuit_breaker.record_failure(&provider_circuit_key(
                    &state,
                    &ctx,
                    provider.name(),
                ));
            }
            state.metrics.inc_provider_error(provider.name());
            audit_failure(&state, &ctx, &decision.model, &e, start);
            e
        })?;
    state
        .circuit_breaker
        .record_success(&provider_circuit_key(&state, &ctx, provider.name()));
    let job = accepted.initial;
    let origin = if job.status.is_terminal() {
        None
    } else {
        Some(accepted.origin)
    };

    let media_job = crate::jobs::MediaJob {
        // Correlation is caller-controlled on trusted relays; execution and debit
        // identity must be unique for each newly accepted provider job.
        id: Uuid::new_v4().to_string(),
        modality: modality.clone(),
        provider: provider_kind,
        origin,
        poll_blocked: None,
        model: decision.model.clone(),
        status: job.status,
        output: job.output,
        error: job.error,
        created_ms: crate::jobs::now_ms(),
        last_activity_ms: crate::jobs::now_ms(),
        org_id: ctx.org_id.clone(),
        user_id: ctx.user_id.clone(),
        agent_id: ctx.agent_id.clone(),
        session_id: ctx.session_id.clone(),
        client_key_binding: crate::jobs::JobClientKeyBinding::new(&ctx.api_key),
        owner_binding: ctx.owner_binding.clone(),
        reservation: credit_reservation.map(Arc::new),
        org_limit_subject: crate::org_limits::subject_for(&ctx),
    };
    // If the provider completed the job synchronously at submit, bill here — no
    // later poll will observe a Queued→Succeeded transition. Idempotent via the
    // `{id}:{modality}` ref so it never double-charges against the poll debit.
    let terminal_success = media_job.status == crate::jobs::JobStatus::Succeeded;
    let terminal = media_job.status.is_terminal();
    let has_output = media_job
        .output
        .as_ref()
        .and_then(|o| o["data"].as_array())
        .is_some_and(|a| !a.is_empty());
    let job_id = media_job.id.clone();
    let job_org = media_job.org_id.clone();
    let job_budget_org = job_org.clone();
    let job_owner_binding = media_job.owner_binding.clone();
    let job_user_id = media_job.user_id.clone();
    let job_agent_id = media_job.agent_id.clone();
    let job_session_id = media_job.session_id.clone();
    let job_org_limit_subject = media_job.org_limit_subject.clone();
    let response = media_job.to_response();
    state.jobs.insert(media_job);

    if terminal_success && has_output {
        if let Some(org_id) = job_org.filter(|s| !s.is_empty()) {
            // PRICED FROM THE PROVIDER'S REPORTED COMPUTE TIME, exactly like the
            // synchronous media path above — not from the flat rate.
            //
            // This read `media_cost_micro_usd(Video)` (the flat rate) and then
            // `if cost > 0`, which meant an async video job billed NOTHING under
            // the default config, because `cost_per_video_micro_usd` defaults to
            // 0. The startup gate deliberately stopped guarding the video rate on
            // the grounds that "image and video are metered from the provider's
            // reported cost, so a flat rate of 0 there is an unreached fallback
            // rather than a leak" — true of the sync path, false here, which is
            // what made this silent. `to_response()` flattens the provider's
            // output, so `usage.compute_seconds` is present when the provider
            // reports it.
            let (cost, estimated) = state
                .config
                .credits
                .media_cost_from_response(&modality, &response);
            record_charged_budget_for_ids(
                &state,
                &job_owner_binding,
                job_budget_org.as_deref(),
                job_user_id.as_deref(),
                job_agent_id.as_deref(),
                job_session_id.as_deref(),
                BudgetChargeKind::Media,
                state
                    .config
                    .credits
                    .debit_amount_for_provider(Some(provider.name()), cost),
                job_org_limit_subject.as_ref(),
            );
            // Outside the `cost > 0` guard — see the sync media path above. A
            // fallback priced at zero is precisely the case that must not be silent.
            if estimated {
                warn!(
                    cost,
                    billed = cost > 0,
                    modality = label,
                    "credits: media job billed at the FLAT fallback rate — \
                     the provider reported no compute time"
                );
            }
            if cost > 0 {
                let fail_closed_sticky = state.config.credits.fail_closed && ctx.managed_inference;
                let credit_reservation = state.jobs.take_reservation(&job_id);
                let provider_name = provider.name().to_owned();
                let pool = crate::credit_pools::pool_for_gateway_provider(provider.name());
                let model = decision.model.clone();
                let duration_ms = response["usage"]["compute_seconds"]
                    .as_f64()
                    .filter(|seconds| *seconds > 0.0)
                    .map(|seconds| (seconds * 1000.0).round() as u64);
                let user_id = ctx.user_id.clone();
                let tags = job_org_limit_subject
                    .as_ref()
                    .map(|subject| subject.tags.clone())
                    .unwrap_or_default();
                let task_label = media_task_label(&modality, estimated);
                let debit_ref = format!("{job_id}:{label}");
                let state_debit = state.clone();
                tokio::spawn(async move {
                    debit_wallet_for_request(
                        state_debit,
                        org_id,
                        debit_ref,
                        CreditDebitReason::GatewayUsage,
                        cost,
                        fail_closed_sticky,
                        None,
                        pool,
                        DebitAttribution {
                            provider: Some(provider_name),
                            model: Some(model),
                            // Present exactly when the provider reported compute
                            // time; absent means this row was priced at the flat
                            // fallback rate. (submit)
                            duration_ms,
                            user_id,
                            task_label: Some(task_label),
                            estimated: Some(estimated),
                            tags,
                            ..Default::default()
                        },
                    )
                    .await;
                    drop(credit_reservation);
                });
            }
        }
    }

    // A synchronous failure, an empty/zero-cost success, or a non-managed job
    // has no debit task to own the claim. Release any remaining job-held permit;
    // a successful paid job already moved it into the debit task above.
    if terminal {
        drop(state.jobs.take_reservation(&job_id));
    }

    info!(
        request_id = %ctx.request_id,
        provider = provider.name(),
        model = %decision.model,
        modality = label,
        "media job submitted"
    );
    Ok(response)
}
