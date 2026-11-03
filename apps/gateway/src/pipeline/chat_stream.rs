//! The streamed chat path up to its provider attempts: admission and the
//! budgets (see `chat_stream_attempts`).

use super::*;

/// What the provider attempts of a streamed chat start from.
pub(super) struct StreamChat {
    pub(super) state: Arc<AppState>,
    pub(super) ctx: RequestContext,
    pub(super) body: Value,
    pub(super) decision: RouteDecision,
    pub(super) requested_model: String,
    pub(super) start: Instant,
    pub(super) settles_after_hang_up: bool,
    pub(super) sampling_extensions: SamplingExtensions,
    pub(super) pool_route: Option<crate::provider_pools::SelectedPoolRoute>,
    pub(super) execution_ceiling: Option<(tokio::time::Instant, usize)>,
    pub(super) original_max_tokens: Option<Value>,
    pub(super) original_max_completion_tokens: Option<Value>,
    pub(super) budget: Option<BudgetDecision>,
    pub(super) credit_reservation: Option<CreditReservation>,
    pub(super) budget_hold: Option<BudgetHold>,
    pub(super) policy_alert: Option<PolicyAlert>,
    pub(super) estimated_tokens: u64,
    pub(super) tools_restricted: bool,
    pub(super) tools_active: bool,
}

pub async fn run_stream(
    state: Arc<AppState>,
    ctx: RequestContext,
    body: Value,
) -> Result<PipelineStreamOutput, GatewayError> {
    let managed = ctx.managed_inference;
    // See `run`. A stream that has started is never re-run: only an error
    // returned before the response exists falls back.
    if let Some(plan) = own_supply_plan(&state, &ctx, &body) {
        let (attempt_ctx, attempt_body) = own_supply_attempt(&ctx, &body, &plan);
        let attempt = run_stream_unaliased(Arc::clone(&state), attempt_ctx, attempt_body).await;
        if let Err(error) = &attempt {
            note_own_supply_failure(&state, &plan, error);
        }
        match attempt {
            Ok(mut output) => {
                output.body = model_alias::alias_stream(output.body, plan.shown_model.clone());
                output.model_used = plan.shown_model;
                output.provider_used = model_alias::ALIAS_PROVIDER_LABEL;
                mask_degraded(&mut output.degraded, managed);
                return Ok(output);
            }
            Err(error) if own_supply::may_fall_back(&error, &ctx) => {
                warn!(
                    request_id = %ctx.request_id,
                    slot = %plan.slot,
                    error = %error,
                    "own supply failed before output; streaming from the Ryu Router route"
                );
            }
            Err(error) => return Err(mask_own_supply_error(error, &plan, managed)),
        }
    }
    // See `run`: every streamed frame names the alias the client asked for.
    let alias = model_alias::requested_alias(&body);
    let mut output = run_stream_unaliased(state, ctx, body)
        .await
        .map_err(|error| {
            model_alias::mask_pool_slots(model_alias::mask_error(error, alias), managed)
        })?;
    let shown: Option<String> = alias
        .map(str::to_owned)
        .or_else(|| model_alias::served_display_id(output.provider_used, &output.model_used));
    if let Some(shown) = shown {
        output.body = model_alias::alias_stream(output.body, shown.clone());
        output.model_used = shown;
        output.provider_used = model_alias::ALIAS_PROVIDER_LABEL;
    }
    mask_degraded(&mut output.degraded, managed);
    mask_provider_used(&mut output.provider_used, managed);
    Ok(output)
}

pub(super) async fn run_stream_unaliased(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
) -> Result<PipelineStreamOutput, GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();
    // A metered stream settles provider work its client abandons before the
    // first byte (see `StreamOpening`); an unmetered one keeps cancel-on-drop.
    let settles_after_hang_up = settles_after_client_hang_up(&state, &ctx);

    state.metrics.inc_requests();
    let sampling_extensions = SamplingExtensions::take(&mut body);

    // Admission and content governance precede optional smart-router inference.
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    let (mut decision, _cache_key, mut pre_alert, mut pool_route) =
        pre_process(&state, &ctx, &mut body).await.map_err(|e| {
            state.metrics.inc_errors();
            audit_failure(&state, &ctx, &requested_model, &e, start);
            e
        })?;
    state.traffic.note_screen(
        &ctx.request_id,
        crate::traffic::current_route(),
        start.elapsed().as_millis() as u64,
    );

    // Skills injection, then a screen of the injected text (P0-4).
    let skills_alert =
        edit_rescan::inject_skills(&state, &ctx, &mut body, &requested_model, start)?;
    pre_alert = merge_alert(pre_alert, skills_alert);

    let mut execution_ceiling = None;
    if let Some(route) = pool_route
        .as_ref()
        .filter(|route| route.execution.is_some())
    {
        match pool_dispatch::prepare(Arc::clone(&state), &ctx, route, body.clone()).await? {
            Some(pool_dispatch::PreparedExecution::Single {
                target,
                mut response,
            }) => {
                apply_outbound_json_dlp(&state, &ctx, &mut response)?;
                apply_inline_output_evaluators(&state, &ctx, &mut response).await?;
                screen_buffered_output(&state, &ctx, &response).await?;
                let bound = provider_snapshot(&state, &ctx).bind(&RouteDecision {
                    provider: ProviderId::from(target.provider.as_str()),
                    model: target.model.clone(),
                })?;
                let data = crate::tools::value_to_sse_stream(&response);
                return Ok(PipelineStreamOutput {
                    body: data,
                    context: ctx,
                    provider_used: bound.provider.name(),
                    model_used: target.model,
                    budget: None,
                    degraded: None,
                    policy_alert: pre_alert,
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                });
            }
            Some(pool_dispatch::PreparedExecution::Final {
                target,
                body: prepared,
                timeout_ms,
                output_bytes,
            }) => {
                body = prepared;
                decision = RouteDecision {
                    provider: ProviderId::from(target.provider.as_str()),
                    model: target.model,
                };
                execution_ceiling = Some((
                    tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms),
                    output_bytes,
                ));
                pool_route = None;
            }
            None => {}
        }
    }

    let execution_final_route = execution_ceiling.map(|_| decision.clone());
    let original_max_tokens = body.get("max_tokens").cloned();
    let original_max_completion_tokens = body.get("max_completion_tokens").cloned();

    // Per-user / per-agent budgets (U21). Enforcement must run on the streaming
    // path too: Core's chat forwards `stream: true`, so without this the budget
    // would never fire for the gateway's primary caller.
    let BudgetOutcome {
        decision: budget,
        alert: budget_alert,
        // NOT dropped at the end of this function. A streaming handler returns as
        // soon as the response HEAD is ready and the bytes flow afterwards, so
        // releasing here would free the claim while the request is still running
        // — the exact window the reservation exists to cover. It is moved into
        // `StreamObserverState` below and released when the stream ends by ANY
        // means, including a client that hangs up mid-answer.
        reservation: credit_reservation,
        // Same lifetime: the stream observer records the spend at stream end,
        // and this in-flight claim is released only after that.
        budget_hold,
    } = enforce_budget(
        &state,
        &ctx,
        &mut body,
        &mut decision,
        BudgetChargeKind::Model,
        OutputCeiling::Clamp,
    )?;
    if execution_final_route.as_ref().is_some_and(|target| {
        target.provider != decision.provider || target.model != decision.model
    }) {
        return Err(GatewayError::BudgetExceeded(None));
    }
    authorize_routed_model(&state, &ctx, &requested_model, &decision)?;
    reconcile_pool_after_budget(&decision, &mut pool_route)?;
    // Firewall (Ok-path) alert first so it wins a same-tier tie deterministically.
    let mut policy_alert = merge_alert(pre_alert, budget_alert);

    // Compress once before streaming dispatch, matching the regular chat path
    // (screened, and fail closed on the hosted fleet).
    let compression_alert =
        edit_rescan::compress(&state, &ctx, &mut body, &decision.model, start).await?;
    policy_alert = merge_alert(policy_alert, compression_alert);

    // Ask the provider to emit a terminal usage frame so the stream observer
    // can parse real token counts at stream end. Falls back to the estimates
    // for non-conforming providers (e.g. local llama.cpp builds that ignore
    // stream_options). `evals.stream_usage` is the swappable default (issue
    // #179), but a METERED stream always asks, overriding a client `false`:
    // it is billed from that frame.
    let stream_metered = state.config.credits.is_active() || ctx.managed_inference;
    if state.config.evals.stream_usage || stream_metered {
        inject_stream_usage_option(&mut body);
    }

    // Rough prompt-token estimate used for budget enforcement while the stream
    // is live. Real counts (when the provider emits a terminal usage frame) are
    // captured by the stream observer at stream end and recorded in the audit
    // row. We advance local counters here with the estimate so callers are
    // accountable immediately; the audit row will carry the real counts.
    let estimated_tokens = estimate_prompt_tokens(&body);

    // Per-minute token rate limit, streaming pre-admission. The non-streaming
    // path checks the bucket with real usage at step 10; a stream's real usage
    // is only known at stream end, so admission is gated on the prompt estimate
    // here and the observer settles the remainder when the stream finishes —
    // without this, `stream: true` bypasses the TPM bucket entirely. Key
    // derivation mirrors the non-streaming check exactly.
    if estimated_tokens > 0
        && (!state.rate_limiter.check_tokens_for_key(
            &ctx.api_key,
            estimated_tokens,
            ctx.key_config.as_ref(),
        ) || !crate::org_limits::check_tokens(&state, &ctx, estimated_tokens))
    {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), tokens = estimated_tokens, "token-per-minute budget exceeded (stream admission)");
        state.metrics.inc_rate_limited();
        state.metrics.inc_errors();
        return Err(GatewayError::RateLimited);
    }

    // Unified tool loop on the streaming path (#475, Decision A). When the tools
    // client is wired (CORE_URL) AND the request carries the tool signal, run the
    // search→describe→call loop NON-streamed over the provider, then synthesize
    // the final SSE from the buffered turn (carrying usage so the observer records
    // real tokens). The default path (no signal) falls through to the fast stream
    // below with zero added latency.
    // Raw passthrough (`x-ryu-raw-tools`) suppresses the unified loop here too, so
    // an SDK-side agent's own tools stream through untouched.
    let tools_restricted = matches!(
        budget.as_ref().map(|b| b.action),
        Some(crate::config::BudgetAction::Restrict)
    );

    let tools_active = select_tool_loop(
        &ctx,
        state.tools.is_some(),
        false,
        &state.config.tools,
        tools_restricted,
    ) == ToolLoopKind::Unified;

    run_stream_attempts(StreamChat {
        state,
        ctx,
        body,
        decision,
        requested_model,
        start,
        settles_after_hang_up,
        sampling_extensions,
        pool_route,
        execution_ceiling,
        original_max_tokens,
        original_max_completion_tokens,
        budget,
        credit_reservation,
        budget_hold,
        policy_alert,
        estimated_tokens,
        tools_restricted,
        tools_active,
    })
    .await
}
