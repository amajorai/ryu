//! Upstream abuse signal settlement (spec 03.5). Upstream wording is a test
//! sentinel only.

use super::*;
use crate::audit::{DetectorKind, ViolationDirection};
use crate::custody::GatewayCustody;
use crate::traffic::TrafficOutcome;
use crate::violations::test_support::tenant_ctx;
use axum::response::IntoResponse;
use serde_json::json;

fn state(custody: GatewayCustody) -> AppState {
    let mut state = AppState::new_for_test_default();
    state.custody = custody;
    state
}

fn signalled(scope: SafetyScope, provider: &str) -> GatewayError {
    GatewayError::from(ryu_gw_providers::ProviderError::SafetyRefused {
        provider: provider.to_owned(),
        status: 403,
        scope,
        row: "test.row",
        code: Some("ryu_test_signal".to_owned()),
        message: "RYU_TEST_FIXTURE upstream wording".to_owned(),
    })
}

#[test]
fn the_provider_boundary_keeps_a_signal_an_ordinary_rejection() {
    let error = signalled(SafetyScope::Content, "openai");
    assert!(
        matches!(
            &error,
            GatewayError::ProviderRejected {
                status: 403,
                signal: Some(_),
                ..
            }
        ),
        "{error:?}"
    );
    assert!(!error.is_safety_outcome());
}

#[test]
fn fleet_custody_settles_a_signal_into_a_safety_outcome() {
    for custody in [GatewayCustody::Fleet] {
        let state = state(custody);
        let ctx = tenant_ctx("req-settle");
        let settled = settle(
            &state,
            &ctx,
            1,
            signalled(SafetyScope::Content, "openai-credits"),
        );
        let GatewayError::UpstreamSafetyRefused(refusal) = &settled else {
            panic!("{custody:?}: {settled:?}");
        };
        assert_eq!(refusal.code(), "upstream_content_refused");
        assert!(settled.is_safety_outcome());
        assert!(settled.ends_hosted_attempt());
        let events = state.violations.all_events().expect("outbox");
        assert_eq!(events.len(), 1, "{custody:?}");
        let event = &events[0];
        assert_eq!(event.attempt, 1);
        assert_eq!(event.detector.kind, DetectorKind::Upstream);
        assert_eq!(event.detector.id, "test.row");
        assert_eq!(event.direction, ViolationDirection::Upstream);
        assert_eq!(event.provider.as_deref(), Some("openai-credits"));
        assert_eq!(event.spend, SpendOwner::Ryu);
        assert_eq!(
            event.dedupe_key,
            "req-settle:1:test.row:abuse.upstream_content_refused"
        );
    }
}

#[test]
fn other_custody_drops_the_signal_and_records_nothing() {
    // A managed node cannot yet tell an injected Ryu key from the user's own,
    // so it never raises a signal; a refusal still ends its chain.
    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let state = state(custody);
        let settled = settle(
            &state,
            &tenant_ctx("req-own"),
            0,
            signalled(SafetyScope::Identifier, "openai"),
        );
        assert!(
            matches!(
                &settled,
                GatewayError::ProviderRejected {
                    status: 403,
                    signal: None,
                    ..
                }
            ),
            "{custody:?}: {settled:?}"
        );
        assert!(!settled.is_safety_outcome());
        assert_eq!(
            settled.ends_hosted_attempt() && custody.ends_chain_on_refusal(),
            custody == GatewayCustody::ManagedNode
        );
        assert!(state.violations.all_events().expect("outbox").is_empty());
    }
}

#[test]
fn errors_without_a_signal_pass_through_untouched() {
    let state = state(GatewayCustody::Fleet);
    let ctx = tenant_ctx("req-plain");
    for error in [
        GatewayError::from(ryu_gw_providers::ProviderError::Rejected {
            status: 403,
            message: "forbidden".to_owned(),
        }),
        GatewayError::ProviderError("boom".to_owned()),
        GatewayError::RateLimited,
    ] {
        let before = format!("{error:?}");
        let after = settle(&state, &ctx, 0, error);
        assert_eq!(format!("{after:?}"), before);
    }
    assert!(state.violations.all_events().expect("outbox").is_empty());
}

#[test]
fn a_settled_refusal_is_never_an_own_supply_or_circuit_fault() {
    let state = state(GatewayCustody::Fleet);
    let ctx = tenant_ctx("req-own-supply");
    let settled = settle(
        &state,
        &ctx,
        0,
        signalled(SafetyScope::Content, "anthropic-credits"),
    );
    assert!(!super::super::own_supply::may_fall_back(&settled, &ctx));
    assert!(!super::super::own_supply::is_row_unavailable(&settled));
    assert!(!super::super::penalizes_provider_circuit(&settled));
}

#[tokio::test]
async fn the_envelope_is_fixed_and_names_the_vendor_only() {
    let state = state(GatewayCustody::Fleet);
    for (scope, code, remedy) in [
        (
            SafetyScope::Identifier,
            "upstream_identifier_blocked",
            "appeal",
        ),
        (
            SafetyScope::Content,
            "upstream_content_refused",
            "report_false_positive",
        ),
        (SafetyScope::Account, "principal_blocked", "appeal"),
    ] {
        let settled = settle(
            &state,
            &tenant_ctx("req-envelope"),
            0,
            signalled(scope, "openai-credits"),
        );
        assert_eq!(settled.wire_status_and_code().1, code);
        let response = settled.into_response();
        assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        let body: Value = serde_json::from_slice(&bytes).expect("JSON");
        assert_eq!(body["error"]["type"], "policy_violation", "{code}");
        assert_eq!(body["error"]["code"], code);
        assert_eq!(body["error"]["layer"], "upstream");
        assert_eq!(body["error"]["provider"], "openai");
        assert_eq!(body["error"]["remedy"], remedy);
        let text = body.to_string();
        assert!(!text.contains("RYU_TEST_FIXTURE"), "{text}");
        assert!(!text.contains("test.row"), "{text}");
        assert!(!text.contains("ryu_test_signal"), "{text}");
    }
}

#[test]
fn the_failure_row_joins_the_recorded_event_on_the_live_feed() {
    let state = state(GatewayCustody::Fleet);
    let ctx = tenant_ctx("req-feed");
    let settled = settle(&state, &ctx, 0, signalled(SafetyScope::Content, "openai"));
    let event_id = state.violations.all_events().expect("outbox")[0]
        .event_id
        .clone();
    let outcome = TrafficOutcome::failure(&settled);
    assert_eq!(outcome.status, Some(403));
    assert_eq!(outcome.verdict.decided_by, DecidedBy::Upstream);
    assert_eq!(outcome.verdict.action, VerdictAction::Block);
    assert_eq!(outcome.verdict.code, Some("upstream_content_refused"));
    assert_eq!(
        outcome.verdict.categories,
        vec!["abuse.upstream_content_refused"]
    );
    let mut receiver = state.traffic.subscribe();
    super::super::audit_failure(&state, &ctx, "m", &settled, std::time::Instant::now());
    let event = receiver.try_recv().expect("published");
    assert_eq!(event["verdict"]["decided_by"], "upstream");
    assert_eq!(event["verdict"]["event_id"], json!(event_id));
    assert_eq!(event["error"], "blocked by upstream");
    assert!(!event.to_string().contains("RYU_TEST_FIXTURE"));
}

#[test]
fn soft_refusals_count_only_on_ryu_custody() {
    let refused = json!({ "choices": [{ "finish_reason": "content_filter" }] });
    let fleet = state(GatewayCustody::Fleet);
    note_soft_refusal(
        &fleet,
        &tenant_ctx("req-soft"),
        0,
        "anthropic-credits",
        &refused,
    );
    let events = fleet.violations.all_events().expect("outbox");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].detector.id, "anthropic.content_filter");
    assert_eq!(events[0].action, EnforcementAction::RefusedUpstream);

    for custody in [GatewayCustody::SelfHosted, GatewayCustody::ManagedNode] {
        let own = state(custody);
        note_soft_refusal(&own, &tenant_ctx("req-soft"), 0, "anthropic", &refused);
        assert!(own.violations.all_events().expect("outbox").is_empty());
    }

    let served = json!({ "choices": [{ "finish_reason": "stop" }] });
    let clean = state(GatewayCustody::Fleet);
    note_soft_refusal(&clean, &tenant_ctx("req-soft"), 0, "openai", &served);
    assert!(clean.violations.all_events().expect("outbox").is_empty());
}
