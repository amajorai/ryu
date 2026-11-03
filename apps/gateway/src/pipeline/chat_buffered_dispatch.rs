//! One buffered chat attempt's provider call: the unified or Composio tool
//! loop, or a plain completion, under the pool deadline and the caller's
//! hang-up.

use super::*;

/// What one buffered attempt dispatches with.
pub(super) struct BufferedDispatch<'a> {
    pub(super) state: &'a Arc<AppState>,
    pub(super) ctx: &'a RequestContext,
    pub(super) provider: &'a Arc<dyn ryu_gw_providers::Provider>,
    pub(super) decision: &'a RouteDecision,
    pub(super) loop_kind: ToolLoopKind,
    pub(super) tools_restricted: bool,
    pub(super) round_ledger: &'a Option<Arc<tool_rounds::ToolRoundLedger>>,
    /// Cancelled when the client of a detached (metered) call hangs up.
    pub(super) caller: Option<&'a tokio_util::sync::CancellationToken>,
    pub(super) execution_ceiling: Option<(tokio::time::Instant, usize)>,
    pub(super) attempt_index: usize,
    pub(super) budget: &'a Option<BudgetDecision>,
    pub(super) start: Instant,
}

/// Run one attempt's completion. The outer error ends the request: the pool's
/// final-execution deadline passed, or the caller hung up mid-loop, and the
/// rounds already run are billed. The inner result is the provider's.
pub(super) async fn dispatch_buffered(
    dispatch: BufferedDispatch<'_>,
    body: &mut Value,
    credit_reservation: &mut Option<CreditReservation>,
) -> Result<Result<(Value, u64), GatewayError>, GatewayError> {
    let BufferedDispatch {
        state,
        ctx,
        provider,
        decision,
        loop_kind,
        tools_restricted,
        round_ledger,
        caller,
        execution_ceiling,
        attempt_index,
        budget,
        start,
    } = dispatch;
    // A detached (metered) call stops its tool loop when the client hangs
    // up, so its rounds run on their own tasks: the round in flight then
    // finishes and is billed from its real usage.
    let loop_caller = caller.filter(|_| round_ledger.is_some());
    let metered_rounds = round_ledger.as_ref().map(|ledger| {
        tool_rounds::MeteredRounds::new(
            Arc::clone(&provider),
            Arc::clone(ledger),
            loop_caller.is_some(),
        )
    });
    let loop_provider: &dyn ryu_gw_providers::Provider = match &metered_rounds {
        Some(metered) => metered,
        None => provider.as_ref(),
    };
    // OTel GenAI model-call span for this attempt: a child of the inbound
    // HTTP server span, ended when the provider returns or fails. Provider
    // requests made inside carry its `traceparent`. A tool loop makes
    // several provider calls with tool runs in between, so it gets one
    // span per provider call (`traced_provider`) instead of one around
    // the whole loop.
    let model_span = if matches!(loop_kind, ToolLoopKind::Plain) {
        gen_ai_telemetry::start_span(
            &state,
            &ctx,
            crate::telemetry::gen_ai_span::OPERATION_CHAT,
            Some(gen_ai_telemetry::chat_output_type(&body)),
            provider.name(),
            &decision.model,
            &body,
            false,
        )
    } else {
        crate::telemetry::gen_ai_span::ModelCallSpan::disabled()
    };
    let traced_provider = gen_ai_telemetry::TracedProvider::new(&state, &ctx, loop_provider);
    let completion = model_span.instrument(async {
        match loop_kind {
            ToolLoopKind::Unified => {
                let catalog = state
                    .tools
                    .as_ref()
                    .expect("Unified selected ⇒ tools catalog present");
                let allowed = effective_tool_allowlist(&ctx, &state.config.tools);
                let hints = unified_loop_hints(&ctx, &allowed);
                let (composio_user_id, require_composio_user_id) =
                    unified_composio_identity(&state, &ctx)?;
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
                let affinity = account_affinity(&ctx, &body);
                crate::tools::run_tool_loop_with_hints_for_session(
                    &mut *body,
                    &traced_provider,
                    &decision.model,
                    catalog,
                    &tool_ctx,
                    state.config.tools.max_rounds,
                    state.config.tools.describe_top_n,
                    hints.as_deref(),
                    affinity.as_deref(),
                )
                .await
            }
            ToolLoopKind::Composio => {
                let composio = state
                    .composio
                    .as_ref()
                    .expect("Composio selected ⇒ Composio configured");
                // Legacy Composio loop: returns (response, billable_tool_calls).
                state.metrics.inc_composio_calls();
                if state.resolve_cache.is_some() && ctx.org_id.is_none() {
                    return Err(GatewayError::Unauthorized(
                        "managed Composio calls require an authenticated organization".to_owned(),
                    ));
                }
                let entity_id = composio.entity_for_request(
                    ctx.org_id.as_deref(),
                    super::auth_identity::box_governance::composio_entity_user(&ctx),
                )?;
                // A request header may narrow the operator's Composio grants,
                // never introduce an action absent from global configuration.
                let allowed =
                    legacy_composio_allowlist(ctx.tool_actions.as_deref(), composio.actions());
                let affinity = account_affinity(&ctx, &body);
                let on_charge = |cost, transaction_id: &str| {
                    spawn_external_tool_debit_for_ids(
                        &state,
                        &ctx.owner_binding,
                        ctx.user_id.as_deref(),
                        ctx.agent_id.as_deref(),
                        ctx.session_id.as_deref(),
                        ctx.org_id.as_deref(),
                        &ctx.request_id,
                        ctx.managed_inference,
                        "composio",
                        None,
                        Some(cost),
                        Some(transaction_id),
                        false,
                        Some("Composio tool execution with provider receipt"),
                        1,
                        crate::org_limits::subject_for(&ctx).as_ref(),
                    );
                };
                composio
                    .run_tool_loop_for_session(
                        &mut *body,
                        &traced_provider,
                        &decision.model,
                        &entity_id,
                        &allowed,
                        state
                            .tools
                            .as_ref()
                            .map(|catalog| catalog as &dyn crate::tools::CoreCatalog),
                        ctx.agent_id.as_deref(),
                        affinity.as_deref(),
                        Some(&tool_loop_screen::firewall(&state, &ctx)),
                        &org_tool_gate(&state, &ctx),
                        &on_charge,
                    )
                    .await
            }
            ToolLoopKind::Plain => {
                // Plain completion: no tool loop ⇒ no billable tool calls. Also the
                // raw-passthrough target — the caller's own tools/tool_calls pass
                // through untouched.
                let affinity = account_affinity(&ctx, &body);
                provider
                    .complete_for_session(&decision.model, &body, affinity.as_deref())
                    .await
                    .map_err(GatewayError::from)
                    .map(|v| (v, 0u64))
            }
        }
    });
    let completion = unless_caller_gone(completion, loop_caller);
    let completion_outcome = if let Some((deadline, _)) = execution_ceiling {
        match tokio::time::timeout_at(deadline, completion).await {
            Ok(outcome) => outcome,
            Err(_) => {
                // Rounds the provider answered are spend, and so is a
                // metered round still in flight.
                if let Some(ledger) = round_ledger.as_ref() {
                    settle_timed_out_tool_rounds(
                        &state,
                        &ctx,
                        attempt_index,
                        ledger,
                        provider.name(),
                        &decision.model,
                        budget.clone(),
                        start,
                        credit_reservation.take(),
                    );
                }
                let error = GatewayError::ProviderDeliveryUncertain(
                    "Pool final execution timed out and is not replayed".into(),
                );
                gen_ai_telemetry::finish_error(model_span, &error);
                return Err(error);
            }
        }
    } else {
        completion.await
    };
    let completion_result = match completion_outcome {
        LoopOutcome::Finished(result) => result,
        LoopOutcome::CallerGone => {
            // The client hung up mid-loop. Bill every round the provider
            // answered, including the one in flight once it finishes,
            // under the request id; nobody reads the response.
            let rounds = match round_ledger.as_ref() {
                Some(ledger) => ledger.settled(ABANDONED_PROVIDER_WAIT).await,
                None => tool_rounds::ToolRoundTotals::default(),
            };
            if rounds.rounds > 0 {
                settle_unanswered_tool_rounds(
                    &state,
                    &ctx,
                    ctx.request_id.clone(),
                    rounds,
                    provider.name(),
                    &decision.model,
                    budget.clone(),
                    start,
                    credit_reservation.take(),
                    "client disconnected during the tool loop",
                    None,
                );
            }
            return Err(GatewayError::Internal(anyhow::anyhow!(
                "the client disconnected during the tool loop"
            )));
        }
    };
    match &completion_result {
        Ok((response, _)) => gen_ai_telemetry::finish_chat(model_span, response),
        Err(error) => gen_ai_telemetry::finish_error(model_span, error),
    }
    Ok(completion_result)
}
