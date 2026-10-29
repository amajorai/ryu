use super::*;

/// Run the resolved policy's **input-target** inline evaluators over the inbound
/// prompt. Blocks (403) on a `Block` action, sanitizes the messages in place on
/// `Sanitize`, and returns a warn-tier [`PolicyAlert`] on `WarnAndContinue`. The
/// common empty-policy path allocates nothing (no registry build).
pub(super) async fn apply_inline_input_evaluators(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
    scanner: &FirewallScanner,
    prompt_text: &str,
) -> Result<Option<PolicyAlert>, GatewayError> {
    if !scanner.config().evaluators.iter().any(|b| b.enabled) {
        return Ok(None);
    }
    let registry = state.evaluator_registry();
    let bindings: Vec<crate::evaluators::EvaluatorBinding> = scanner
        .config()
        .evaluators
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();
    let mut pending: Option<PolicyAlert> = None;

    for binding in &bindings {
        let Some(ev) = registry.get(&binding.id) else {
            continue;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Input {
            continue;
        }
        let (flagged, reason) =
            match flag_inline_binding(ev, scanner, prompt_text, state, ctx).await {
                InlineFlag::Denied(error) => return Err(error),
                InlineFlag::Skip => continue,
                InlineFlag::Ran { flagged, reason } => (flagged, reason),
                InlineFlag::ForceBlock { reason } => {
                    // Fail-closed short-circuit: block regardless of the binding's
                    // configured action (the wasm-policy fail-direction control).
                    let model = body["model"].as_str().unwrap_or("unknown");
                    state.metrics.inc_firewall_blocked();
                    audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                    warn!(
                        request_id = %ctx.request_id,
                        evaluator = %ev.id,
                        %reason,
                        "inline evaluator: fail-closed block (inbound)"
                    );
                    return Err(GatewayError::FirewallBlocked(
                        format!(
                            "Inbound content blocked by evaluator '{}': {}",
                            ev.id, reason
                        ),
                        firewall_policy_alert(scanner.config(), ctx, "block"),
                    ));
                }
            };
        let action = inline_action_for(binding, ev);
        match inline_outcome(flagged, &action) {
            InlineOutcome::Allow => {}
            InlineOutcome::Block => {
                let model = body["model"].as_str().unwrap_or("unknown");
                state.metrics.inc_firewall_blocked();
                audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: blocked inbound content"
                );
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Inbound content blocked by evaluator '{}': {}",
                        ev.id, reason
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            InlineOutcome::Sanitize => {
                let model = body["model"].as_str().unwrap_or("unknown").to_string();
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    "inline evaluator: flagged inbound content under Sanitize action"
                );
                let enforcement = match sanitize_inbound_or_block(
                    state,
                    ctx,
                    body,
                    scanner,
                    "inline evaluator",
                ) {
                    Ok(true) => "sanitized",
                    Ok(false) => "flagged (not redactable; forwarded)",
                    Err(error) => {
                        audit_inline_evaluator(state, ctx, &model, &ev.id, "blocked", &reason);
                        return Err(error);
                    }
                };
                audit_inline_evaluator(state, ctx, &model, &ev.id, enforcement, &reason);
            }
            InlineOutcome::Warn => {
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: inbound flagged (warn-and-continue)"
                );
                pending = merge_alert(
                    pending,
                    firewall_policy_alert(scanner.config(), ctx, "notify"),
                );
            }
        }
    }
    Ok(pending)
}

/// Run the resolved policy's **output-target** inline evaluators over the
/// (non-streaming) response. Blocks on `Block`, redacts in place on `Sanitize`,
/// logs on `WarnAndContinue`. Resolves the per-agent scanner from `ctx` (cached),
/// so it needs no state threaded from `pre_process`. No-op (allocation-free) when
/// no binding is enabled.
pub(super) async fn apply_inline_output_evaluators(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    response: &mut Value,
) -> Result<(), GatewayError> {
    let scanner = state.resolved_scanner(ctx);
    if !scanner.config().evaluators.iter().any(|b| b.enabled) {
        return Ok(());
    }
    let registry = state.evaluator_registry();
    let bindings: Vec<crate::evaluators::EvaluatorBinding> = scanner
        .config()
        .evaluators
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();
    let response_text = response_to_text(response);

    for binding in &bindings {
        let Some(ev) = registry.get(&binding.id) else {
            continue;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Output {
            continue;
        }
        let (flagged, reason) =
            match flag_inline_binding(ev, scanner.as_ref(), &response_text, state, ctx).await {
                InlineFlag::Denied(error) => return Err(error),
                InlineFlag::Skip => continue,
                InlineFlag::Ran { flagged, reason } => (flagged, reason),
                InlineFlag::ForceBlock { reason } => {
                    // Fail-closed short-circuit on the outbound path too (a wasm
                    // policy may be bound Output-target). Block regardless of action.
                    let model = response["model"].as_str().unwrap_or("unknown");
                    state.metrics.inc_firewall_blocked();
                    audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                    warn!(
                        request_id = %ctx.request_id,
                        evaluator = %ev.id,
                        %reason,
                        "inline evaluator: fail-closed block (outbound)"
                    );
                    return Err(GatewayError::FirewallBlocked(
                        format!(
                            "Outbound response blocked by evaluator '{}': {}",
                            ev.id, reason
                        ),
                        firewall_policy_alert(scanner.config(), ctx, "block"),
                    ));
                }
            };
        let action = inline_action_for(binding, ev);
        match inline_outcome(flagged, &action) {
            InlineOutcome::Allow | InlineOutcome::Warn => {
                if flagged {
                    warn!(
                        request_id = %ctx.request_id,
                        evaluator = %ev.id,
                        %reason,
                        "inline evaluator: outbound flagged (warn-and-continue)"
                    );
                }
            }
            InlineOutcome::Block => {
                let model = response["model"].as_str().unwrap_or("unknown");
                state.metrics.inc_firewall_blocked();
                audit_inline_evaluator(state, ctx, model, &ev.id, "blocked", &reason);
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    %reason,
                    "inline evaluator: blocked outbound response"
                );
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Outbound response blocked by evaluator '{}': {}",
                        ev.id, reason
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            InlineOutcome::Sanitize => {
                let model = response["model"].as_str().unwrap_or("unknown").to_string();
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    "inline evaluator: sanitizing outbound response"
                );
                audit_inline_evaluator(state, ctx, &model, &ev.id, "sanitized", &reason);
                sanitize_response(response, scanner.as_ref());
            }
        }
    }
    Ok(())
}

/// Whether any enabled OUTPUT-target inline binding would BLOCK or SANITIZE — the
/// streaming firewall must buffer the whole response in that case, even when the
/// node firewall policy is warn/off (otherwise a blocking output evaluator would
/// never fire on the default streaming chat path).
#[cfg(test)]
pub(super) fn output_inline_wants_transform(
    scanner: &FirewallScanner,
    registry: &EvaluatorRegistry,
) -> bool {
    scanner.config().evaluators.iter().any(|b| {
        if !b.enabled {
            return false;
        }
        let Some(ev) = registry.get(&b.id) else {
            return false;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Output {
            return false;
        }
        matches!(
            inline_action_for(b, ev),
            FirewallPolicy::Block | FirewallPolicy::Sanitize
        )
    })
}

/// Evaluate the resolved OUTPUT-target inline evaluators against assembled
/// streamed text, returning the STRICTEST outcome (Block > Sanitize > Warn >
/// Allow) plus a reason, so the streaming firewall can emit the right frame.
pub(super) async fn evaluate_output_inline_stream(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    scanner: &FirewallScanner,
    assembled: &str,
) -> (InlineOutcome, String) {
    let registry = state.evaluator_registry();
    let bindings: Vec<crate::evaluators::EvaluatorBinding> = scanner
        .config()
        .evaluators
        .iter()
        .filter(|b| b.enabled)
        .cloned()
        .collect();

    let mut strictest = InlineOutcome::Allow;
    let mut reason = String::new();
    for binding in &bindings {
        let Some(ev) = registry.get(&binding.id) else {
            continue;
        };
        if !ev.capabilities.inline || ev.target != EvaluatorTarget::Output {
            continue;
        }
        let (flagged, r) = match flag_inline_binding(ev, scanner, assembled, state, ctx).await {
            InlineFlag::Denied(error) => return (InlineOutcome::Block, error.to_string()),
            InlineFlag::Skip => continue,
            InlineFlag::Ran { flagged, reason } => (flagged, reason),
            InlineFlag::ForceBlock { reason: fc_reason } => {
                // Fail-closed → Block is the strictest possible streamed outcome;
                // nothing can outrank it, so short-circuit.
                return (InlineOutcome::Block, format!("{}: {fc_reason}", ev.id));
            }
        };
        let outcome = inline_outcome(flagged, &inline_action_for(binding, ev));
        if inline_outcome_rank(outcome) > inline_outcome_rank(strictest) {
            strictest = outcome;
            reason = format!("{}: {}", ev.id, r);
        }
    }
    let _ = ctx;
    (strictest, reason)
}

/// Strictness rank for picking the winning streamed-output outcome.
pub(super) fn inline_outcome_rank(o: InlineOutcome) -> u8 {
    match o {
        InlineOutcome::Allow => 0,
        InlineOutcome::Warn => 1,
        InlineOutcome::Sanitize => 2,
        InlineOutcome::Block => 3,
    }
}
