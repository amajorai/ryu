//! Opening one streamed chat attempt's upstream, and the stream an attempt
//! that opened returns: observed, screened and holding its claims.

use super::*;

/// What one streamed attempt opens its upstream with.
pub(super) struct UpstreamOpen<'a> {
    pub(super) state: &'a Arc<AppState>,
    pub(super) ctx: &'a RequestContext,
    pub(super) provider: &'a Arc<dyn ryu_gw_providers::Provider>,
    pub(super) decision: &'a RouteDecision,
    pub(super) tools_active: bool,
    pub(super) tools_restricted: bool,
    pub(super) round_ledger: &'a Option<Arc<tool_rounds::ToolRoundLedger>>,
    pub(super) detached_open: &'a Option<Arc<DetachedStreamOpen>>,
    pub(super) settles_after_hang_up: bool,
}

/// Buffered tool loop → synthesized SSE, OR the fast direct stream.
pub(super) async fn open_upstream(
    open: UpstreamOpen<'_>,
    body: &mut Value,
) -> Result<Body, GatewayError> {
    let UpstreamOpen {
        state,
        ctx,
        provider,
        decision,
        tools_active,
        tools_restricted,
        round_ledger,
        detached_open,
        settles_after_hang_up,
    } = open;
    if tools_active {
        let allowed = effective_tool_allowlist(&ctx, &state.config.tools);
        let hints = unified_loop_hints(&ctx, &allowed);
        let (composio_user_id, require_composio_user_id) = unified_composio_identity(&state, &ctx)?;
        let tool_ctx = crate::tools::ToolLoopContext {
            agent_id: ctx.agent_id.clone(),
            user_id: ctx.user_id.clone(),
            composio_user_id,
            require_composio_user_id,
            allowed,
            firewall: Some(tool_loop_screen::firewall(&state, &ctx)),
            untrusted_caller: ctx.untrusted_caller,
            parallel_reads: state.config.tools.parallel_reads,
            host_conversation: ctx.host_conversation.clone(),
            org_tools: org_tool_gate(&state, &ctx),
        };
        inject_unified_loop_tools(&mut *body, &ctx, &state.config.tools, tools_restricted);
        // run_tool_loop forces stream:false internally for the provider calls.
        let affinity = account_affinity(&ctx, &body);
        let metered_rounds = tool_rounds::MeteredRounds::new(
            Arc::clone(&provider),
            Arc::clone(
                round_ledger
                    .as_ref()
                    .expect("tools_active implies a round ledger"),
            ),
            settles_after_hang_up,
        );
        let traced_provider = gen_ai_telemetry::TracedProvider::new(&state, &ctx, &metered_rounds);
        match crate::tools::run_tool_loop_with_hints_for_session(
            &mut *body,
            &traced_provider,
            &decision.model,
            state.tools.as_ref().expect("tools_active implies Some"),
            &tool_ctx,
            state.config.tools.max_rounds,
            state.config.tools.describe_top_n,
            hints.as_deref(),
            affinity.as_deref(),
        )
        .await
        {
            Ok((buffered, billable_tool_calls)) => {
                // Tools have fully executed by the time the loop returns, so
                // the tool-call (Composio) debit fires here rather than at
                // stream end — the synthesized SSE carries only the final
                // turn and would drop the count (#496). The token debit still
                // fires at stream end on the real usage frame.
                spawn_tool_call_debit(&state, &ctx, billable_tool_calls);
                Ok(crate::tools::value_to_sse_stream(&buffered))
            }
            Err(e) => Err(e),
        }
    } else {
        let affinity = account_affinity(&ctx, &body);
        match &detached_open {
            Some(open) => open
                .open(
                    Arc::clone(&provider),
                    decision.model.clone(),
                    body.clone(),
                    affinity,
                )
                .await
                .map_err(GatewayError::from),
            None => provider
                .complete_stream_for_session(&decision.model, &body, affinity.as_deref())
                .await
                .map_err(GatewayError::from),
        }
    }
}

/// Everything the opened attempt hands to [`finish_stream_answer`].
pub(super) struct StreamAnswer<'a> {
    pub(super) state: &'a Arc<AppState>,
    pub(super) ctx: RequestContext,
    pub(super) attempt_index: usize,
    pub(super) attempt: &'a ChatAttemptRoute,
    pub(super) provider: &'a Arc<dyn ryu_gw_providers::Provider>,
    pub(super) decision: RouteDecision,
    pub(super) body: &'a Value,
    pub(super) pool_base_body: &'a Value,
    pub(super) round_ledger: &'a Option<Arc<tool_rounds::ToolRoundLedger>>,
    pub(super) observer: StreamObserverState,
    pub(super) model_span: crate::telemetry::gen_ai_span::ModelCallSpan,
    pub(super) execution_ceiling: Option<(tokio::time::Instant, usize)>,
    pub(super) admission_permit: crate::concurrency::AdmissionPermit,
    pub(super) budget_hold: Option<BudgetHold>,
    pub(super) pool_load: Option<ryu_gw_router::pool::PoolLease>,
    pub(super) primary_skipped: bool,
    pub(super) budget: Option<BudgetDecision>,
    pub(super) policy_alert: Option<PolicyAlert>,
    pub(super) prompt_cache_outcome: ryu_gw_providers::PromptCacheOutcome,
    pub(super) start: Instant,
}

/// Wrap the opened upstream `stream_body` in the observer, the outbound
/// screens and the claims it holds, and return it.
pub(super) async fn finish_stream_answer(
    answer: StreamAnswer<'_>,
    stream_body: Body,
) -> PipelineStreamOutput {
    let StreamAnswer {
        state,
        ctx,
        attempt_index,
        attempt,
        provider,
        decision,
        body,
        pool_base_body,
        round_ledger,
        mut observer,
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
    } = answer;
    state
        .circuit_breaker
        .record_success(&provider_circuit_key(&state, &ctx, provider.name()));
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

    // Determine degraded mode for the stream path (#218).
    let degraded = if primary_skipped_stream {
        state.metrics.inc_degraded_fallback();
        Some(DegradedMode::Fallback(provider.name().to_string()))
    } else {
        None
    };

    info!(
        request_id = %ctx.request_id,
        provider = provider.name(),
        model = %decision.model,
        degraded = ?degraded,
        "streaming request started"
    );

    // 9. Outbound firewall on the streaming path.
    //
    // The non-streaming `run` scans the full response after it
    // arrives. Streaming responses are parsed and redacted frame by
    // frame and released once the violation scan has covered them
    // (`stream_dlp`); under Block a violation ends the stream with
    // the block notice before any matched text is released. Custom
    // patterns and output evaluators keep the fully buffered scan.
    // Observe original upstream usage before client-facing DLP can replace frames.
    // A tool loop's stream bills every round the loop ran.
    observer.tool_rounds = round_ledger.as_ref().map(|ledger| ledger.totals());
    // The attempt's model-call span ends when the upstream stream does.
    observer.model_span = Some(model_span);
    // Standing is checked before every output window, beneath the
    // stream observer, so a stream cut by a refusal still settles.
    let stream_body =
        crate::standing::guard_stream(stream_body, Arc::clone(&state), ctx.standing.clone());
    let observed_body = observe_stream(stream_body, observer);
    let observed_body = if let Some((deadline, limit)) = execution_ceiling {
        bound_pool_stream(observed_body, deadline, limit)
    } else {
        observed_body
    };

    let (observed_body, admission_permit) = apply_outbound_firewall_stream(
        observed_body,
        Arc::clone(&state),
        ctx.clone(),
        admission_permit,
    )
    .await;
    // 9b. Hazard screener windows over what the client receives
    // (screener addendum section 8): asynchronous, and a block
    // ends the stream with the output-blocked error frame.
    let observed_body = crate::screening::output::guard_stream(
        observed_body,
        Arc::clone(&state),
        ctx.at_attempt(attempt_index, &attempt.decision.provider),
        Some(decision.model.clone()),
    );

    // Hold any remaining admission slot (the pass-through path) for
    // the *whole* client stream: move it into the body so it drops
    // only when the SSE is fully consumed (or the client
    // disconnects). Buffered guardrail paths already released the
    // engine slot after the upstream generation ended. The credit
    // claim is held by the observer's debit task instead.
    let observed_body = hold_admission_until_stream_end(observed_body, admission_permit);
    let observed_body = hold_until_stream_end(observed_body, budget_hold);
    // The ladder's in-flight slots (spec 04.8.1) are held until
    // the client has the whole stream, not until headers.
    let observed_body = hold_until_stream_end(observed_body, ctx.enforcement.clone());
    let observed_body = hold_pool_load_until_stream_end(observed_body, pool_load);
    let observed_body = if let Some(route) = attempt.pool.clone() {
        capture_pool_relay_stream(
            observed_body,
            Arc::clone(&state),
            ctx.clone(),
            route,
            pool_base_body.clone(),
        )
    } else {
        observed_body
    };

    PipelineStreamOutput {
        body: observed_body,
        context: ctx,
        provider_used: provider.name(),
        model_used: decision.model,
        budget,
        degraded,
        policy_alert,
        prompt_cache: prompt_cache_outcome,
    }
}
