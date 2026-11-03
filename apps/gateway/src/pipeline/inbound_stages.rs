//! The inbound governance stages `pre_process` runs over the request: the
//! regex firewall, the control-plane policy and the companion DLP guard.

use super::*;

/// Step 3: the inbound regex firewall on the per-request RESOLVED scanner
/// (node → org → agent), then the residual screen and the hazard screener.
/// Returns the Ok-path alert a warn-tier match or the residual screen raised.
pub(super) async fn firewall_stage(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
    scanner: &Arc<FirewallScanner>,
    prompt_text: &str,
    definition_text: &str,
    residual_text: &outbound_text::Residual,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let mut pending_alert: Option<PolicyAlert> = None;
    let mut sanitized = false;
    if let Some(violation) = scanner
        .scan_inbound(&prompt_text)
        .or_else(|| scan_definitions_inbound(scanner.as_ref(), &definition_text))
    {
        // Violation events cover blocks and redactions only (spec
        // 03.4.3); a warn-tier match is on the feed, not the ledger.
        let (traffic_action, event_action) = match scanner.policy() {
            FirewallPolicy::Block => (
                crate::traffic::VerdictAction::Block,
                Some(crate::audit::EnforcementAction::Blocked),
            ),
            FirewallPolicy::Sanitize => (
                crate::traffic::VerdictAction::Sanitize,
                Some(crate::audit::EnforcementAction::Redacted),
            ),
            FirewallPolicy::WarnAndContinue => (crate::traffic::VerdictAction::Warn, None),
        };
        let layers = state.firewall_layers(ctx);
        let event_id = event_action.and_then(|event_action| {
            crate::violations::record_firewall_match(state, ctx, &violation, &layers, event_action)
        });
        state.traffic.note_verdict(
            &ctx.request_id,
            crate::traffic::firewall_verdict(
                &violation.pattern_name,
                &violation.kind,
                &layers,
                traffic_action,
            )
            .with_event(event_id),
        );
        match scanner.policy() {
            FirewallPolicy::Block => {
                state.metrics.inc_firewall_blocked();
                return Err(GatewayError::FirewallBlocked(
                    format!(
                        "Inbound content blocked: {} ({:?})",
                        violation.pattern_name, violation.kind
                    ),
                    firewall_policy_alert(scanner.config(), ctx, "block"),
                ));
            }
            FirewallPolicy::Sanitize => {
                warn!(
                    request_id = %ctx.request_id,
                    pattern = %violation.pattern_name,
                    "firewall: inbound violation under Sanitize policy"
                );
                sanitized =
                    sanitize_inbound_or_block(state, ctx, body, scanner.as_ref(), "firewall")?;
            }
            FirewallPolicy::WarnAndContinue => {
                warn!(
                    request_id = %ctx.request_id,
                    pattern = %violation.pattern_name,
                    "firewall: inbound violation (warn-and-continue)"
                );
                // Ok-path stamp: a warn-tier firewall match propagates
                // its alert to the response via the pending-alert return.
                pending_alert = merge_alert(
                    pending_alert,
                    firewall_policy_alert(scanner.config(), ctx, "notify"),
                );
            }
        }
    }
    // Screen the residual of the body as Sanitize left it, so the
    // decoded form of a redacted leaf is redacted too.
    let sanitized_residual = sanitized.then(|| {
        outbound_text::chat_residual_text(body).with_control_token(ctx.slot_model.as_deref())
    });
    let residual_alert = outbound_text::screen_residual_inbound(
        state,
        ctx,
        scanner.as_ref(),
        sanitized_residual.as_ref().unwrap_or(&residual_text),
    )?;
    pending_alert = merge_alert(pending_alert, residual_alert);
    // The hazard screener, after the regex floor and over the bytes
    // Sanitize left. It keys off custody and tier only, never the
    // tenant scanner's switches (`crate::screening`).
    crate::screening::admit::screen_chat_with(
        state,
        ctx,
        body,
        sanitized_residual
            .as_ref()
            .unwrap_or(&residual_text)
            .screened_text(),
        crate::screening::admit::Surface::Chat,
    )
    .await?;
    Ok(pending_alert)
}

/// Step 3b: control-plane policy (U28): the model allowlist and the locked
/// guardrails. The master key bypasses.
pub(super) fn policy_stage(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    scanner: &Arc<FirewallScanner>,
    requested_model: &str,
    prompt_text: &str,
    definition_text: &str,
    residual_text: &outbound_text::Residual,
) -> Result<(), GatewayError> {
    if !ctx.is_master_key {
        // A dynamically-resolved `rgw_` tenant enforces its OWN
        // control-plane policy; single-org / static-key paths use the
        // global startup policy.
        let policy = ctx
            .resolved_policy
            .clone()
            .unwrap_or_else(|| state.policy_snapshot());

        // Model allowlist.
        if !policy.allows_model(&requested_model) {
            warn!(
                request_id = %ctx.request_id,
                model = %requested_model,
                "policy: model not on the control-plane allowlist"
            );
            state.metrics.inc_firewall_blocked();
            return Err(GatewayError::PolicyViolation(format!(
                "Model '{requested_model}' is not approved by control-plane policy"
            )));
        }

        // Locked guardrails: scan even if the local firewall config
        // disabled them, so a lower level cannot bypass an admin-locked
        // guardrail. Uses the same per-request resolved scanner (its
        // custom patterns participate).
        if policy.requires_firewall() {
            let violation = match scanner
                .scan_locked_guardrails(&prompt_text, &policy.locked_guardrails)
                .or_else(|| {
                    scanner.scan_locked_guardrails(
                        &definition_text,
                        &definition_dlp_guardrails(&policy.locked_guardrails),
                    )
                }) {
                Some(violation) => Some(violation),
                None => outbound_text::residual_locked_violation(
                    state,
                    scanner.as_ref(),
                    &policy.locked_guardrails,
                    &residual_text,
                )?,
            };
            if let Some(violation) = violation {
                warn!(
                    request_id = %ctx.request_id,
                    pattern = %violation.pattern_name,
                    "policy: locked guardrail violation in inbound request"
                );
                state.metrics.inc_firewall_blocked();
                return Err(GatewayError::PolicyViolation(format!(
                    "Inbound content violates a locked guardrail: {} ({:?})",
                    violation.pattern_name, violation.kind
                )));
            }
        }
    }
    Ok(())
}

/// Step 3c: companion DLP egress guard (M7 / #199) for companion-sourced
/// requests.
pub(super) fn companion_dlp_stage(
    state: &Arc<AppState>,
    ctx: &RequestContext,
    body: &mut Value,
    scanner: &Arc<FirewallScanner>,
    prompt_text: &str,
) {
    if ctx.companion_source {
        let (_, redacted_categories) = scanner.redact_companion_egress(&prompt_text);
        // Redact message bodies unconditionally (categories may be empty
        // for clean text).
        scanner.companion_sanitize_messages(&mut body["messages"]);
        if !redacted_categories.is_empty() {
            warn!(
                request_id = %ctx.request_id,
                categories = ?redacted_categories,
                "companion DLP: redacted PII/secrets from companion-sourced prompt before egress"
            );
            // Emit an audit record so redaction events are observable (AC2).
            let category_names: Vec<&str> =
                redacted_categories.iter().map(|c| c.as_str()).collect();
            state.metrics.inc_firewall_blocked();
            let verdict = category_names.iter().fold(
                crate::traffic::TrafficVerdict::new(
                    crate::traffic::DecidedBy::Node,
                    crate::traffic::VerdictAction::Sanitize,
                ),
                |verdict, category| verdict.with_detector(category),
            );
            let record = crate::audit::AuditRecord {
                request_id: ctx.request_id.clone(),
                api_key: ctx.api_key.clone(),
                user_name: ctx.user_name.clone(),
                org_id: ctx.org_id.clone(),
                team_id: ctx.team_id.clone(),
                team_ids: ctx.audit_team_ids(),
                key_id: ctx.key_id(),
                project_id: ctx.project_id.clone(),
                provider: "companion-dlp".to_string(),
                model: body["model"].as_str().unwrap_or("unknown").to_string(),
                input_tokens: 0,
                output_tokens: 0,
                cache_read_tokens: None,
                cache_write_tokens: None,
                cache_hit: false,
                prompt_cache_outcome: None,
                prompt_cache_read_tokens: None,
                prompt_cache_write_tokens: None,
                cache_write_1h_tokens: None,
                latency_ms: 0,
                eval_score: None,
                error: Some(format!(
                    "companion DLP redacted: {}",
                    category_names.join(",")
                )),
                skill_ids: ctx.skill_ids.clone(),
                session_id: ctx.session_id.clone(),
                user_id: ctx.user_id.clone(),
                agent_id: ctx.agent_id.clone(),
                feature: ctx.feature.clone(),
                purpose: ctx.purpose.clone(),
                managed_inference: ctx.managed_inference,
                provider_cost_micro_usd: None,
                event_type: crate::audit::EventType::ModelCall,
                backend: Some("companion".to_string()),
                command: None,
                duration_ms: None,
                exit_code: None,
                widget_instance_id: None,
            };
            state.log_audit_with(record, crate::traffic::TrafficOutcome::verdict(verdict));
        }
    }
}

#[cfg(test)]
#[path = "phase0_bypass_tests.rs"]
mod phase0_bypass_tests;
