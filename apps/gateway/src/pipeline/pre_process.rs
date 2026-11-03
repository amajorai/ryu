//! Shared pre-processing: the governance stages in their resolved order.

use super::*;

/// Shared pre-processing: rate-limit + burst check + inbound-firewall + routing.
/// Returns the routing decision and exact-match cache key.
///
/// The route stage computes whether [`apply_smart_routing`] rewrote
/// `body["model"]`; in that case eval-driven A/B routing is skipped so the
/// classifier's choice is honored (otherwise `eval_route` would override the
/// model's provider — see the no-slot branch below).
pub(super) async fn pre_process(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
) -> Result<
    (
        RouteDecision,
        String,
        Option<PolicyAlert>,
        Option<crate::provider_pools::SelectedPoolRoute>,
    ),
    GatewayError,
> {
    zero_data_retention::enforce_requested_zdr(state, ctx, body)?;
    // Server tools and non-caching betas are refused on the fleet before any
    // provider is chosen, so no fallback can carry them elsewhere.
    upstream_features::enforce(state.custody, body)?;
    // Ok-path policy alert accumulated during pre-processing (currently a
    // firewall warn-and-continue match). Merged with any budget alert by the
    // caller and stamped onto the response header via the router's map_response.
    let mut pending_alert: Option<PolicyAlert> = None;

    // Per-request inputs shared by the firewall / inspector / policy / companion
    // stages. Resolved ONCE here (not per stage): `resolved_scanner` hands back a
    // cached `Arc<FirewallScanner>` (node→org→agent, no lock held), reused across
    // the regex scan, the inspector's `.await`, the locked-guardrail scan, and the
    // companion redaction. `prompt_text` is the single text extraction the pre-W6d
    // code also did once. Hoisting them above the stage loop (rather than computing
    // inside the firewall step) is what lets the governance stages be reordered
    // freely; the only cost is one extra text extraction on the rate-limited reject
    // path, which is immaterial and not a behavior change.
    let prompt_text = extract_text_for_scanning(body);
    let definition_text = extract_definition_text(body);
    // Every other provider-bound string (a top-level `prompt`, non-text content
    // parts, escaped tool arguments). Detection-only: see `outbound_text`.
    // The chat slot model header replaces `model` at the Route stage, after
    // this screen, so it is screened here like `model` itself.
    let residual_text =
        outbound_text::chat_residual_text(body).with_control_token(ctx.slot_model.as_deref());
    let scanner = state.resolved_scanner(ctx);
    state
        .evaluator_registry()
        .validate_inline_bindings(&scanner.config().evaluators)
        .map_err(GatewayError::BadRequest)?;
    let requested_model = body["model"].as_str().unwrap_or("gpt-4o").to_string();

    // The routing decision, produced by the pinned `Route` stage. `StageOrder`
    // guarantees `Route` is present in every resolved order, so this is `Some`
    // after the loop.
    let mut decision: Option<RouteDecision> = None;

    // Run the pre-processing stages in the resolved, validated order. The order is
    // DATA (`state.stage_order`, resolved once at config-apply time — zero
    // per-request allocation to know it), so the default reproduces the exact
    // pre-W6d numbered sequence while config can reorder / disable the governance
    // block within the pinned safety skeleton (rate-limit → firewall → … → route
    // → audit). See `pipeline::stages`.
    for &stage in state.stage_order.stages() {
        match stage {
            // Steps 1 + 2: per-key request rate limit + burst / bot detection.
            PipelineStage::RateLimit => {
                if let Err(error) = admit_request(state, ctx) {
                    warn!(key_id = %crate::audit::credential_log_id(&ctx.api_key), request_id = %ctx.request_id, policy = rate_limit_policy_name(&error), "rate limit exceeded");
                    state.metrics.inc_rate_limited();
                    return Err(error);
                }
            }

            // Step 3: inbound regex firewall on the per-request RESOLVED scanner
            // (node → org → agent).
            PipelineStage::Firewall => {
                let alert = firewall_stage(
                    state,
                    ctx,
                    body,
                    &scanner,
                    &prompt_text,
                    &definition_text,
                    &residual_text,
                )
                .await?;
                pending_alert = merge_alert(pending_alert, alert);
            }

            // Step 3a: LLM traffic inspector (opt-in, inbound-only). Calls a cheap
            // model directly (never the tool loop). A missing verdict follows
            // `inspector.fail_mode`; see `inspector_stage`. Gated by `enabled` and
            // `min_chars`, so it is a cheap no-op when disabled.
            PipelineStage::Inspector => inspector_stage(state, ctx, body, &scanner).await?,

            // Step 3a-ii: unified-evaluator inline guardrails — INPUT target (P3).
            // Reuses the SAME block/sanitize/warn machinery as the regex firewall
            // and the inspector. A no-op (allocation-free) when no binding is enabled.
            PipelineStage::InlineInput => {
                if let Some(alert) =
                    apply_inline_input_evaluators(state, ctx, body, scanner.as_ref(), &prompt_text)
                        .await?
                {
                    pending_alert = merge_alert(pending_alert, Some(alert));
                }
            }

            // Step 3b: control-plane policy (U28). The master key bypasses
            // (operator escape hatch), matching rate-limit semantics elsewhere.
            PipelineStage::Policy => policy_stage(
                state,
                ctx,
                &scanner,
                &requested_model,
                &prompt_text,
                &definition_text,
                &residual_text,
            )?,

            // Step 3c: companion DLP egress guard (M7 / #199). When Core tags a
            // request as companion-sourced (screen-capture text), unconditionally
            // redact PII and secrets from the inbound prompt before the provider
            // call — regardless of whether the local firewall is enabled (AC3).
            // `redact_companion_egress()` ignores `config.enabled`/`redact_pii`/
            // `redact_secrets`; detections are recorded via the audit path (AC2).
            PipelineStage::CompanionDlp => {
                companion_dlp_stage(state, ctx, body, &scanner, &prompt_text);
            }

            // Step 4: model routing (Plane A). Per-agent chat slot override wins
            // over eval/model routing (M3 / #164); eval-driven A/B routing only
            // applies when no slot is set and the classifier did not already choose.
            PipelineStage::Route => decision = Some(route_stage(state, ctx, body).await?),

            // Ordering anchor only. Auditing needs the provider response, so the
            // real `audit.log` runs post-provider in `run` / `run_stream` — which
            // is genuinely last. Modelled as a pinned terminal stage purely so
            // "audit is always last" is an enforceable, testable invariant; here it
            // is a deliberate no-op, NOT a missing implementation.
            PipelineStage::Audit => {}
        }
    }

    // Keep the provider prompt-cache prefix stable. A Sanitize stage above only
    // redacts on a turn it flags, but the flag depends on the whole request (the
    // newest message, an LLM inspector verdict), while the redaction rewrites
    // every turn and the tool definitions. Without this pass the same history
    // and tools egress redacted on one turn and raw on the next, so the
    // provider's cached prefix (tools → system → earlier messages) is
    // invalidated. Redaction is a pure per-string transform and idempotent, so
    // applying it whenever a Sanitize posture is configured makes each string's
    // egress form depend on config alone. A turn a stage already sanitized is
    // unchanged here.
    if sanitize_posture_configured(state, scanner.as_ref())
        && sanitize_messages(body, scanner.as_ref())
    {
        debug!(
            request_id = %ctx.request_id,
            "sanitize: redacted unflagged content to keep the cached prompt prefix stable"
        );
    }

    // `Route` is pinned present in every resolved `StageOrder`, so the loop always
    // produced a decision.
    let mut decision =
        decision.expect("Route stage is pinned present in every resolved StageOrder");
    let pool_route = resolve_provider_pool(state, ctx, body, &mut decision).await?;
    canonicalize_sdk_decision(state, ctx, &mut decision)?;

    // Build exact-match cache key from the (possibly sanitized) body.
    let tenant = cache_tenant(ctx);
    let cache_key = Cache::make_key(
        &provider_cache_scope(
            state,
            ctx,
            tenant.as_deref(),
            decision.provider.as_str(),
            &decision.model,
        ),
        &body["messages"],
        body.get("tools"),
        ctx.capability_hints.as_deref(),
    );

    Ok((decision, cache_key, pending_alert, pool_route))
}

/// Step 4: model routing (Plane A), canonicalized for SDK connections.
async fn route_stage(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
) -> Result<RouteDecision, GatewayError> {
    let smart_routed = apply_smart_routing(state, ctx, body).await?;
    let requested_model = body["model"].as_str().unwrap_or("gpt-4o").to_owned();
    auxiliary::authorize_model(state, ctx, &requested_model)?;
    // ALLOWLIST CLAMP on the client-supplied chat slot model. The
    // `Policy` stage above checked `allows_model` against
    // `body["model"]` only — but the slot below REPLACES the model
    // actually dispatched. An `rgw_` bearer could therefore name an
    // approved model in the body and the real one in
    // `x-ryu-slot-chat-model`, and route around the org's
    // `approved_models` entirely. A disallowed slot model is IGNORED
    // (the fleet's own routing takes over) rather than rejected: the
    // turn still runs, under a model the org DID approve.
    //
    // Guarded exactly like the `Policy` stage — same master-key
    // bypass, same `resolved_policy || snapshot` fallback — so the
    // static-key / single-org paths this bypass never touched keep
    // their behaviour. With an empty `approved_models` (every
    // non-allowlisted deployment) `allows_model` is `true`, so this
    // is a no-op there.
    let slot_model = if ctx.is_master_key {
        ctx.slot_model.as_deref()
    } else {
        let policy = ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| state.policy_snapshot());
        if node_routing::slot_model_allowed(ctx.slot_model.as_deref(), &policy) {
            ctx.slot_model.as_deref()
        } else {
            warn!(
                request_id = %ctx.request_id,
                slot_model = ?ctx.slot_model,
                "policy: ignoring a chat slot model outside the control-plane allowlist"
            );
            None
        }
    };
    let mut decision = if let Some((slot, upstream)) = ctx.own_supply_route.as_ref() {
        // A free-credit own-supply attempt: the plan already chose
        // the slot and the upstream id; the body still names the
        // id the user picked (authorized just above).
        RouteDecision {
            provider: slot.clone(),
            model: upstream.clone(),
        }
    } else if ctx.slot_provider.is_some() || slot_model.is_some() {
        provider_snapshot(&state, &ctx)
            .router
            .route_modality_with_slot(
                &crate::config::Modality::Chat,
                &requested_model,
                ctx.slot_provider.as_ref(),
                slot_model,
            )
    } else if smart_routed {
        // The classifier already chose this model — route it straight
        // to its provider and skip eval/A-B routing, which would
        // otherwise reassign the provider and break the smart-routed
        // model (#473 smart routing).
        provider_snapshot(&state, &ctx)
            .router
            .route(&requested_model)
    } else {
        provider_snapshot(&state, &ctx)
            .router
            .eval_route(&requested_model, |p| state.evals.provider_score(p.as_str()))
            .unwrap_or_else(|| {
                provider_snapshot(&state, &ctx)
                    .router
                    .route(&requested_model)
            })
    };
    canonicalize_sdk_decision(state, ctx, &mut decision)?;
    Ok(decision)
}
