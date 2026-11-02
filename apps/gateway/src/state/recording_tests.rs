//! `AppState::record_violation` stores evidence only through the firewall's
//! excerpt redactor, which ignores `redact_pii` / `redact_secrets` and folds
//! Unicode evasions before it scans.

use super::AppState;
use crate::audit::{AuditConfig, AuditLogger, EnforcementAction, PolicyLayer, ViolationDirection};
use crate::config::GatewayConfig;
use crate::evals::EvalsRunner;
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
    let input = VerdictInput::regex(
        TaxonomyId::PII,
        "pii.email",
        EnforcementAction::Blocked,
        ViolationDirection::Inbound,
        PolicyLayer::Org,
    )
    .with_evidence(evidence);
    let event_id = state
        .record_violation(&tenant_ctx(request_id), input)
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
        "key ghp_abcdefghijklmnopqrstuvwxyz0123456789 ssn 123-45-6789",
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
