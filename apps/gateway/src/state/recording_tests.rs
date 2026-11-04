//! `AppState::record_violation` stores evidence only through the firewall's
//! excerpt redactor, which ignores `redact_pii` / `redact_secrets` and folds
//! Unicode evasions before it scans.

use super::AppState;
use crate::audit::{AuditConfig, AuditLogger, EnforcementAction, PolicyLayer, ViolationDirection};
use crate::config::GatewayConfig;
use crate::config::{CustomPattern, CustomPatternKind, FirewallOverlay};
use crate::evals::EvalsRunner;
use crate::pipeline::RequestContext;
use crate::policy::EffectivePolicy;
use crate::violations::{test_support::tenant_ctx, VerdictInput};
use ryu_gw_screening::TaxonomyId;

/// A Fleet state (Fleet keeps redacted excerpts) whose firewall leaves PII
/// and secrets unredacted in traffic.
fn fleet_state_without_traffic_redaction() -> AppState {
    let mut config = GatewayConfig::default();
    config.firewall.redact_pii = false;
    config.firewall.redact_secrets = false;
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("disabled audit logger");
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = crate::custody::GatewayCustody::Fleet;
    state
}

/// Record a `security.pii` block carrying `evidence` and return the excerpt
/// the outbox holds for it.
fn stored_pii_excerpt(state: &AppState, request_id: &str, evidence: &str) -> Option<String> {
    stored_excerpt_for(state, &tenant_ctx(request_id), evidence)
}

/// [`stored_pii_excerpt`] for a caller-built request context.
fn stored_excerpt_for(state: &AppState, ctx: &RequestContext, evidence: &str) -> Option<String> {
    let input = VerdictInput::regex(
        TaxonomyId::PII,
        "pii.email",
        EnforcementAction::Blocked,
        ViolationDirection::Inbound,
        PolicyLayer::Org,
    )
    .with_evidence(evidence);
    let event_id = state
        .record_violation(ctx, input)
        .expect("the violation is recorded");
    state
        .violations
        .pending(16)
        .expect("outbox readable")
        .into_iter()
        .find(|row| row.event.event_id == event_id)
        .expect("the recorded row is pending")
        .excerpt
}

#[test]
fn a_pii_violation_excerpt_is_redacted_even_when_traffic_redaction_is_off() {
    let state = fleet_state_without_traffic_redaction();
    for (request_id, evidence) in [
        ("req-ascii", "contact alice@example.com today"),
        ("req-fullwidth", "contact alice\u{FF20}example.com today"),
        ("req-dots", "contact alice\u{FF20}example\u{FF0E}com today"),
    ] {
        let excerpt = stored_pii_excerpt(&state, request_id, evidence);
        let stored = excerpt.as_deref().unwrap_or_default();
        assert!(!stored.contains("alice"), "{request_id}: {stored}");
        assert!(!stored.contains("example"), "{request_id}: {stored}");
    }
}

#[test]
fn a_secret_in_violation_evidence_never_reaches_the_outbox() {
    let state = fleet_state_without_traffic_redaction();
    let excerpt = stored_pii_excerpt(
        &state,
        "req-secret",
        "key ghp_abcdefghijklmnopqrstuvwxyz0123456789 ssn 123-45-6789", // Test vector, not a credential. gitleaks:allow skipcq
    );
    let stored = excerpt.as_deref().unwrap_or_default();
    assert!(!stored.contains("ghp_abc"), "{stored}");
    assert!(!stored.contains("6789"), "{stored}");
}

#[test]
fn clean_violation_evidence_is_still_kept_as_an_excerpt() {
    let state = fleet_state_without_traffic_redaction();
    let excerpt = stored_pii_excerpt(&state, "req-clean", "nothing personal in this turn");
    assert_eq!(excerpt.as_deref(), Some("nothing personal in this turn"));
}

/// An overlay adding one custom pattern of `kind` that the node baseline
/// does not know.
fn overlay_with(name: &str, regex: &str, kind: CustomPatternKind) -> FirewallOverlay {
    FirewallOverlay {
        custom_patterns: vec![CustomPattern {
            name: name.into(),
            regex: regex.into(),
            kind,
        }],
        ..FirewallOverlay::default()
    }
}

/// A tenant request whose control-plane policy carries `policy`.
fn ctx_with_policy(request_id: &str, policy: EffectivePolicy) -> RequestContext {
    let mut ctx = tenant_ctx(request_id);
    ctx.resolved_policy = Some(policy);
    ctx
}

#[test]
fn an_org_overlay_custom_pii_pattern_drops_the_excerpt() {
    let state = fleet_state_without_traffic_redaction();
    let org_policy = || EffectivePolicy {
        firewall: Some(overlay_with(
            "acme_employee_id",
            r"EMP-\d{6}",
            CustomPatternKind::Pii,
        )),
        ..EffectivePolicy::default()
    };
    // Without the overlay the node backend sees nothing to redact.
    let control = stored_excerpt_for(
        &state,
        &tenant_ctx("req-org-control"),
        "badge EMP-482913 at the door",
    );
    assert_eq!(control.as_deref(), Some("badge EMP-482913 at the door"));
    for (request_id, evidence) in [
        ("req-org-plain", "badge EMP-482913 at the door"),
        ("req-org-zwsp", "badge EMP-48\u{200B}2913 at the door"),
        ("req-org-fullwidth", "badge \u{FF25}MP-482913 at the door"),
    ] {
        let excerpt =
            stored_excerpt_for(&state, &ctx_with_policy(request_id, org_policy()), evidence);
        assert_eq!(excerpt, None, "{request_id}");
    }
}

#[test]
fn an_agent_overlay_custom_secret_pattern_drops_the_excerpt() {
    let state = fleet_state_without_traffic_redaction();
    let mut policy = EffectivePolicy::default();
    policy.agent_overlays.insert(
        "agent-billing".to_owned(),
        overlay_with("vault_ref", r"vault:[a-z]{8}", CustomPatternKind::Secret),
    );
    let mut ctx = ctx_with_policy("req-agent", policy);
    ctx.agent_id = Some("agent-billing".to_owned());
    let excerpt = stored_excerpt_for(&state, &ctx, "use vault:qwertyui now");
    assert_eq!(excerpt, None);
}

#[test]
fn a_standalone_org_overlay_store_pattern_drops_the_excerpt() {
    let state = fleet_state_without_traffic_redaction();
    state.resolver.set_org_overlay(
        crate::violations::test_support::TENANT_ORG.to_owned(),
        overlay_with("acme_employee_id", r"EMP-\d{6}", CustomPatternKind::Pii),
    );
    let excerpt = stored_pii_excerpt(&state, "req-org-store", "badge EMP-482913 at the door");
    assert_eq!(excerpt, None);
}

#[test]
fn an_overlay_pattern_that_does_not_match_keeps_the_excerpt() {
    let state = fleet_state_without_traffic_redaction();
    let policy = EffectivePolicy {
        firewall: Some(overlay_with(
            "acme_employee_id",
            r"EMP-\d{6}",
            CustomPatternKind::Pii,
        )),
        ..EffectivePolicy::default()
    };
    let excerpt = stored_excerpt_for(
        &state,
        &ctx_with_policy("req-org-clean", policy),
        "nothing personal in this turn",
    );
    assert_eq!(excerpt.as_deref(), Some("nothing personal in this turn"));
}

#[test]
fn a_team_overlay_custom_pii_pattern_drops_the_excerpt() {
    let state = fleet_state_without_traffic_redaction();
    let policy = EffectivePolicy {
        team_firewall: Some(overlay_with(
            "team_case_ref",
            r"CASE-\d{5}",
            CustomPatternKind::Pii,
        )),
        ..EffectivePolicy::default()
    };
    let excerpt = stored_excerpt_for(
        &state,
        &ctx_with_policy("req-team", policy),
        "see CASE-31337 for details",
    );
    assert_eq!(excerpt, None);
}
