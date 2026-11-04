//! Screening a residual and the refusals it produces.

use super::*;

pub(super) fn residual_too_large(state: &AppState) -> GatewayError {
    state.metrics.inc_firewall_blocked();
    GatewayError::PolicyViolation(format!(
        "Provider input carries more than {MAX_SCREENED_BYTES} bytes of text outside the screened fields"
    ))
}

/// The refusal for a non-chat request whose governed text fields together
/// exceed [`MAX_SCREENED_BYTES`]: text past the cap is refused rather than
/// forwarded unscreened, whichever screen would have read it.
pub(in crate::pipeline) fn governed_text_too_large(state: &AppState) -> GatewayError {
    state.metrics.inc_firewall_blocked();
    GatewayError::PolicyViolation(format!(
        "Provider input carries more than {MAX_SCREENED_BYTES} bytes of text"
    ))
}

pub(super) fn residual_blocked(
    state: &AppState,
    ctx: &RequestContext,
    scanner: &dyn FirewallBackend,
    violation: &FirewallMatch,
) -> GatewayError {
    warn!(
        request_id = %ctx.request_id,
        pattern = %violation.pattern_name,
        "firewall: inbound violation outside the redactable fields; blocked"
    );
    state.metrics.inc_firewall_blocked();
    let layers = state.firewall_layers(ctx);
    let event_id = crate::violations::record_firewall_match(
        state,
        ctx,
        violation,
        &layers,
        crate::audit::EnforcementAction::Blocked,
    );
    state.traffic.note_verdict(
        &ctx.request_id,
        crate::traffic::firewall_verdict(
            &violation.pattern_name,
            &violation.kind,
            &layers,
            crate::traffic::VerdictAction::Block,
        )
        .with_event(event_id),
    );
    GatewayError::FirewallBlocked(
        format!(
            "Inbound content blocked: {} ({:?})",
            violation.pattern_name, violation.kind
        ),
        super::super::firewall_policy_alert(scanner.config(), ctx, "block"),
    )
}

/// The inbound regex firewall over the residual, under the scanner's own
/// `enabled` / `scan_inbound` gate. Callers pass the residual of the body as it
/// stands after their Sanitize step, so a decoded form of a redacted leaf is
/// redacted too. The secrets-only part runs the secret patterns alone. Block
/// refuses any match. Sanitize refuses an uncovered or secrets-only match (it
/// does not own those leaves, so it cannot redact them) and, in a decoded
/// covered leaf, a secret or PII match that survived redaction; any other
/// match, like WarnAndContinue, returns the notify alert.
pub(crate) fn screen_residual_inbound(
    state: &AppState,
    ctx: &RequestContext,
    scanner: &dyn FirewallBackend,
    residual: &Residual,
) -> Result<Option<PolicyAlert>, GatewayError> {
    let config = scanner.config();
    if !config.enabled || !config.scan_inbound {
        return Ok(None);
    }
    let parts = residual.parts().map_err(|_| residual_too_large(state))?;
    let decoded = parts.decoded;
    let uncovered_hit = scanner
        .scan_inbound(parts.uncovered)
        .or_else(|| scan_secrets(scanner, parts.secrets_only, &["secrets".to_owned()]));
    let decoded_hit = scanner.scan_inbound(decoded);
    let blocking = match scanner.policy() {
        FirewallPolicy::Block => uncovered_hit.clone().or_else(|| decoded_hit.clone()),
        FirewallPolicy::Sanitize => uncovered_hit.clone().or_else(|| {
            let mut categories = Vec::with_capacity(2);
            if config.redact_pii {
                categories.push("pii".to_owned());
            }
            if config.redact_secrets {
                categories.push("secrets".to_owned());
            }
            decoded_hit
                .as_ref()
                .filter(|_| !categories.is_empty())
                .and_then(|_| scanner.scan_locked_guardrails(decoded, &categories))
        }),
        FirewallPolicy::WarnAndContinue => None,
    };
    if let Some(violation) = blocking {
        return Err(residual_blocked(state, ctx, scanner, &violation));
    }
    let Some(violation) = uncovered_hit.or(decoded_hit) else {
        return Ok(None);
    };
    warn!(
        request_id = %ctx.request_id,
        pattern = %violation.pattern_name,
        "firewall: inbound violation outside the redactable fields; forwarded"
    );
    Ok(super::super::firewall_policy_alert(config, ctx, "notify"))
}

/// The locked guardrails over the residual; only a locked secret category
/// reads the secrets-only part. An over-limit residual is refused whenever a
/// guardrail is locked, since it cannot be screened.
pub(crate) fn residual_locked_violation(
    state: &AppState,
    scanner: &dyn FirewallBackend,
    guardrails: &[String],
    residual: &Residual,
) -> Result<Option<FirewallMatch>, GatewayError> {
    if guardrails.is_empty() {
        return Ok(None);
    }
    let parts = residual.parts().map_err(|_| residual_too_large(state))?;
    let secrets: Vec<String> = guardrails
        .iter()
        .filter(|name| {
            ["secret", "secrets"]
                .iter()
                .any(|dlp| name.eq_ignore_ascii_case(dlp))
        })
        .cloned()
        .collect();
    Ok(scanner
        .scan_locked_guardrails(parts.uncovered, guardrails)
        .or_else(|| scanner.scan_locked_guardrails(parts.decoded, guardrails))
        .or_else(|| scan_secrets(scanner, parts.secrets_only, &secrets)))
}

/// The secret patterns over the secrets-only part. `secrets` names the
/// secret categories that apply (none skips the scan).
pub(super) fn scan_secrets(
    scanner: &dyn FirewallBackend,
    text: &str,
    secrets: &[String],
) -> Option<FirewallMatch> {
    if text.is_empty() || secrets.is_empty() {
        return None;
    }
    scanner.scan_locked_guardrails(text, secrets)
}
