//! The buffered chat path up to its provider attempts: admission, the
//! response caches and the budgets (see `chat_buffered_attempts`).

use super::*;

/// The response caches a buffered chat may answer from or populate.
pub(super) struct ChatCache {
    pub(super) allowed: bool,
    pub(super) origin: (ProviderId, String),
    pub(super) key: String,
    pub(super) semantic_scope: String,
    pub(super) semantic_embedding: Option<Vec<f32>>,
}

/// What the provider attempts of a buffered chat start from.
pub(super) struct BufferedChat {
    pub(super) state: Arc<AppState>,
    pub(super) ctx: RequestContext,
    pub(super) body: Value,
    pub(super) decision: RouteDecision,
    pub(super) requested_model: String,
    pub(super) start: Instant,
    pub(super) caller: Option<tokio_util::sync::CancellationToken>,
    pub(super) sampling_extensions: SamplingExtensions,
    pub(super) cache: ChatCache,
    pub(super) pool_route: Option<crate::provider_pools::SelectedPoolRoute>,
    pub(super) execution_ceiling: Option<(tokio::time::Instant, usize)>,
    pub(super) original_max_tokens: Option<Value>,
    pub(super) original_max_completion_tokens: Option<Value>,
    pub(super) budget: Option<BudgetDecision>,
    pub(super) credit_reservation: Option<CreditReservation>,
    pub(super) policy_alert: Option<PolicyAlert>,
}

pub(super) async fn run_attached(
    state: Arc<AppState>,
    mut ctx: RequestContext,
    mut body: Value,
    // Cancelled when the client of a detached (metered) call hangs up.
    caller: Option<tokio_util::sync::CancellationToken>,
) -> Result<PipelineOutput, GatewayError> {
    capture_provider_snapshot(&state, &mut ctx);
    let start = Instant::now();

    state.metrics.inc_requests();
    let sampling_extensions = SamplingExtensions::take(&mut body);

    // Admission and content governance precede optional smart-router inference.
    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    let (mut decision, cache_key, mut pre_alert, mut pool_route) =
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

    let cache_route = bind_route(&state, &ctx, &decision)?;

    // Gateway response caches have no account dimension. A multi-key provider
    // uses session-sticky upstream prompt caching instead; serving a Gateway
    // hit here could reuse an answer from a different account or obscure a
    // quota failover before the account is even selected.
    let cache_allowed = pool_route.is_none()
        && ctx.capability_hints.is_none()
        && ctx.node_routing.is_none()
        && cache_route.cache_allowed;
    let cache_origin = (cache_route.provider_id.clone(), cache_route.model.clone());
    let semantic_tenant = cache_tenant(&ctx);
    let semantic_scope = provider_cache_scope(
        &state,
        &ctx,
        semantic_tenant.as_deref(),
        cache_route.provider_id.as_str(),
        &cache_route.model,
    )
    .semantic_scope();

    // 5a. Exact-match cache lookup — return early on hit
    if cache_allowed {
        if let Some(cached) = state.cache.get_async(&cache_key).await {
            debug!(request_id = %ctx.request_id, "exact cache hit");
            state.metrics.inc_cache_hit();
            // Output-target inline evaluators must run on cache hits too: the exact
            // cache key is (org, model, messages) — NOT scoped by agent — so an agent
            // with `toxicity: Block` / `pii_leakage: Sanitize` could otherwise be
            // served a sibling agent's cached toxic/PII response with the guardrail
            // silently bypassed. No-op (allocation-free) when the agent has no
            // output evaluators, so a plain cache hit stays fast.
            let mut cached = cached;
            // The entry holds the response as DLP'd for whoever populated it;
            // this caller's own (possibly stricter) outbound policy applies too.
            apply_outbound_json_dlp(&state, &ctx, &mut cached)?;
            apply_inline_output_evaluators(&state, &ctx, &mut cached).await?;
            screen_buffered_output(&state, &ctx, &cached).await?;
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
                policy_alert: pre_alert.clone(),
                // Our own response cache answered; no provider was called, so there
                // is no provider prompt-cache activity to report.
                prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            });
        }
    }

    // 5b. Semantic cache lookup (optional)
    let mut semantic_embedding: Option<Vec<f32>> = None;
    if cache_allowed {
        if let (Some(sc), Some(_openai_cfg)) = (
            state.semantic_cache.active(),
            provider_snapshot(&state, &ctx).config.openai.as_ref(),
        ) {
            let text = SemanticCache::messages_to_text(&body["messages"]);
            let inference = auxiliary::GovernedInference::new(
                Arc::clone(&state),
                ctx.clone(),
                "semantic-cache",
            );
            if let Some(emb) = inference.embed(sc.embedding_model(), &text, 30_000).await? {
                if let Some(cached) = sc.lookup_async(Some(&semantic_scope), &emb).await {
                    debug!(request_id = %ctx.request_id, "semantic cache hit");
                    state.metrics.inc_semantic_cache_hit();
                    state.metrics.inc_cache_hit();
                    // Same per-agent bypass concern as the exact cache above: the
                    // semantic cache is org-scoped, not agent-scoped, so run the
                    // output-target inline evaluators before serving a cached hit.
                    let mut cached = cached;
                    apply_outbound_json_dlp(&state, &ctx, &mut cached)?;
                    apply_inline_output_evaluators(&state, &ctx, &mut cached).await?;
                    screen_buffered_output(&state, &ctx, &cached).await?;
                    audit_cache_hit(
                        &state,
                        &ctx,
                        "semantic-cache",
                        &model_alias::display_model(decision.provider.as_str(), &decision.model),
                        &cached,
                        start,
                    );
                    return Ok(PipelineOutput {
                        response: cached,
                        context: ctx,
                        provider_used: "semantic-cache",
                        model_used: decision.model,
                        cache_hit: true,
                        budget: None,
                        eval_score: None,
                        degraded: None,
                        policy_alert: pre_alert.clone(),
                        prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                        cache_read_tokens: 0,
                        cache_write_tokens: 0,
                    });
                }
                semantic_embedding = Some(emb);
            }
        }
    }

    state.metrics.inc_cache_miss();

    // 6. Skills injection, then a screen of the injected text (P0-4).
    let skills_alert =
        edit_rescan::inject_skills(&state, &ctx, &mut body, &requested_model, start)?;
    pre_alert = merge_alert(pre_alert, skills_alert);

    // 6a. Shared (cross-machine) budget — enforce the control-plane coordinator's
    // most recent verdict. The master key always bypasses budget gates.
    if !ctx.is_master_key && state.shared_budget.is_shared_exceeded() {
        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), "shared budget exceeded (coordinator verdict)");
        state.metrics.inc_budget_exceeded();
        state.metrics.inc_errors();
        return Err(GatewayError::BudgetExceeded(None));
    }

    // 6b. Lifetime token budget — check before calling provider and optionally downgrade
    if let Some(key_cfg) = &ctx.key_config {
        if let Some(budget) = key_cfg.token_budget_total {
            if budget > 0 {
                let used = state.audit.token_usage(&ctx.api_key);
                if used >= budget {
                    if let Some(ref downgrade_model) = key_cfg.downgrade_to {
                        info!(
                            key_id = %crate::audit::credential_log_id(&ctx.api_key),
                            used,
                            budget,
                            downgrade = %downgrade_model,
                            "token budget exceeded, downgrading model"
                        );
                        body["model"] = Value::String(downgrade_model.clone());
                        decision = provider_snapshot(&state, &ctx)
                            .router
                            .route(downgrade_model);
                    } else {
                        warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), used, budget, "token budget exceeded");
                        state.metrics.inc_budget_exceeded();
                        state.metrics.inc_errors();
                        return Err(GatewayError::BudgetExceeded(None));
                    }
                }
            }
        }
    }

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
                return Ok(PipelineOutput {
                    response,
                    context: ctx,
                    provider_used: bound.provider.name(),
                    model_used: target.model,
                    cache_hit: false,
                    budget: None,
                    eval_score: None,
                    degraded: None,
                    policy_alert: pre_alert,
                    prompt_cache: ryu_gw_providers::PromptCacheOutcome::Disabled,
                    cache_read_tokens: 0,
                    cache_write_tokens: 0,
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

    // 6c. Per-user / per-agent charged-spend budgets with local counters (U21).
    // Stop aborts;
    // downgrade/restrict mutate the body+route in place; notify is observable.
    let BudgetOutcome {
        decision: budget,
        alert: budget_alert,
        // MOVED INTO THE DEBIT TASK BELOW, not dropped at the end of this
        // function. The debit is `tokio::spawn`ed, so returning from here would
        // free the claim while the charge is still in flight in a detached task
        // (up to `credits.timeout_ms`) — and `ctx.remaining_budget_micro_usd` is
        // the cached figure, which nothing has decremented yet. The freed
        // headroom would be immediately re-claimable against a balance that has
        // not moved: the exact window the reservation exists to close. `.take()`
        // rather than a move because the debit site sits inside the fallback
        // loop; if no debit fires (credits inactive, no org) the permit stays
        // here and drops on return, which is correct.
        reservation: credit_reservation,
        // Local budgets are recorded synchronously before this returns, so the
        // in-flight claim simply lives until then.
        budget_hold: _budget_hold,
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
    // One response, one header: firewall (Ok-path) alert first so it wins a tie
    // against a same-tier budget alert (deterministic).
    let mut policy_alert = merge_alert(pre_alert, budget_alert);

    // 6d. Context compression (egress transform). When enabled, send the
    // messages to the compression service and swap in the result before any
    // provider call. Runs once for the whole fallback chain. The swapped-in
    // messages are screened; a failed compression leaves the body untouched,
    // except on the hosted fleet, where it refuses the request (see
    // `edit_rescan::compress`).
    let compression_alert =
        edit_rescan::compress(&state, &ctx, &mut body, &decision.model, start).await?;
    policy_alert = merge_alert(policy_alert, compression_alert);

    run_buffered_attempts(BufferedChat {
        state,
        ctx,
        body,
        decision,
        requested_model,
        start,
        caller,
        sampling_extensions,
        cache: ChatCache {
            allowed: cache_allowed,
            origin: cache_origin,
            key: cache_key,
            semantic_scope,
            semantic_embedding,
        },
        pool_route,
        execution_ceiling,
        original_max_tokens,
        original_max_completion_tokens,
        budget,
        credit_reservation,
        policy_alert,
    })
    .await
}
