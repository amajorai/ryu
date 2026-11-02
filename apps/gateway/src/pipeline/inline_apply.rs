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
                    Ok(false) if flag_is_injection_only(ev) => {
                        "flagged (not redactable; forwarded)"
                    }
                    Ok(false) => {
                        // A judge or PII/secret flag carries no span the regex
                        // redaction could rewrite: forwarding it would turn
                        // Sanitize into Warn, so refuse it instead.
                        state.metrics.inc_firewall_blocked();
                        audit_inline_evaluator(state, ctx, &model, &ev.id, "blocked", &reason);
                        return Err(GatewayError::FirewallBlocked(
                            format!(
                                "Inbound content flagged by evaluator '{}' could not be redacted",
                                ev.id
                            ),
                            firewall_policy_alert(scanner.config(), ctx, "block"),
                        ));
                    }
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
                let before = response_to_text(response);
                sanitize_response(response, scanner.as_ref());
                drop_choice_logprobs(response);
                // A judge flag names no span: when redaction rewrote nothing,
                // delivering the reply would turn Sanitize into Warn.
                if !flag_is_injection_only(ev) && response_to_text(response) == before {
                    state.metrics.inc_firewall_blocked();
                    audit_inline_evaluator(state, ctx, &model, &ev.id, "blocked", &reason);
                    return Err(GatewayError::FirewallBlocked(
                        format!(
                            "Outbound response flagged by evaluator '{}' could not be redacted",
                            ev.id
                        ),
                        firewall_policy_alert(scanner.config(), ctx, "block"),
                    ));
                }
                // Fail closed: when the evaluator's own detector still matches
                // (a fold-only match, or `redact_pii` off), block rather than
                // deliver flagged text recorded as "sanitized".
                if let Some(survivor) =
                    evaluator_sanitize_survivor(ev, scanner.as_ref(), &response_to_text(response))
                {
                    state.metrics.inc_firewall_blocked();
                    audit_inline_evaluator(state, ctx, &model, &ev.id, "blocked", &reason);
                    warn!(
                        request_id = %ctx.request_id,
                        evaluator = %ev.id,
                        pattern = %survivor.pattern_name,
                        "inline evaluator: match survived Sanitize; blocked outbound response"
                    );
                    return Err(GatewayError::FirewallBlocked(
                        format!(
                            "Outbound response blocked by evaluator '{}': {} survived redaction",
                            ev.id, survivor.pattern_name
                        ),
                        firewall_policy_alert(scanner.config(), ctx, "block"),
                    ));
                }
                warn!(
                    request_id = %ctx.request_id,
                    evaluator = %ev.id,
                    "inline evaluator: sanitized outbound response"
                );
                audit_inline_evaluator(state, ctx, &model, &ev.id, "sanitized", &reason);
            }
        }
    }
    Ok(())
}

/// Whether an inbound Sanitize flag from `ev` may continue unredacted: only an
/// injection detector, whose match cannot be redacted (as with the regex
/// firewall's injection match). Any other flag (an LLM judge, a PII or secret
/// detector, a custom rule) is refused when redaction leaves the text as it was.
pub(super) fn flag_is_injection_only(ev: &Evaluator) -> bool {
    matches!(
        inline_detection_kind(&ev.id),
        Some(
            crate::firewall::DetectionKind::PromptInjection
                | crate::firewall::DetectionKind::CodeInjection
        )
    )
}

/// The match an evaluator's deterministic detector still finds in `text`
/// after its Sanitize ran. `None` for a judge or custom-regex evaluator, whose
/// verdict cannot be re-derived from the redacted text.
pub(super) fn evaluator_sanitize_survivor(
    ev: &Evaluator,
    scanner: &FirewallScanner,
    text: &str,
) -> Option<crate::firewall::FirewallMatch> {
    inline_detection_kind(&ev.id).and_then(|kind| scanner.scan_kind(text, kind))
}

/// For the streamed reply: the first enabled OUTPUT binding with a Sanitize
/// action whose detector still matches the sanitized text, as a block reason.
pub(super) fn output_sanitize_survivor(
    state: &AppState,
    scanner: &FirewallScanner,
    sanitized: &str,
) -> Option<String> {
    let registry = state.evaluator_registry();
    scanner
        .config()
        .evaluators
        .iter()
        .filter(|binding| binding.enabled)
        .find_map(|binding| {
            let ev = registry.get(&binding.id)?;
            if !ev.capabilities.inline
                || ev.target != EvaluatorTarget::Output
                || inline_action_for(binding, ev) != FirewallPolicy::Sanitize
            {
                return None;
            }
            evaluator_sanitize_survivor(ev, scanner, sanitized)
                .map(|m| format!("{}: {} survived redaction", ev.id, m.pattern_name))
        })
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

#[cfg(test)]
#[path = "inline_apply_sanitize_tests.rs"]
mod inline_apply_sanitize_tests;
