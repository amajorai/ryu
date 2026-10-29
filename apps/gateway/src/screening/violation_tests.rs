//! Violation events from the screener and the regex floor (G5, screener
//! addendum 11.1 and 12.2). Content is the spec 00.9 sentinels only.

use super::*;
use crate::audit::{
    DetectorKind, EnforcementAction, EnforcementMode, PolicyLayer, Severity, SpendOwner,
    ViolationDirection, ViolationEvent,
};
use crate::violations::test_support::{tenant_ctx, TENANT_CREDENTIAL, TENANT_ORG};

fn events(state: &AppState) -> Vec<ViolationEvent> {
    state.violations.all_events().expect("outbox reads")
}

/// SG-1 plus spec 00.9 "blocked": one event, tenant org and credential,
/// classifier detector with its version, the error's screening id.
#[tokio::test]
async fn a_blocked_hard_code_records_one_event_for_the_tenant() {
    let (g, _) = qualified_fleet("ok");
    let ctx = tenant_ctx("req-sg1");
    let error = screen_chat(
        &g.state,
        &ctx,
        &chat_body(&format!("{SENTINEL_HAZARD_S9} screening probe")),
        Surface::Chat,
    )
    .await
    .expect_err("blocked");
    let GatewayError::ContentBlocked(block) = error else {
        panic!("a content block");
    };
    let recorded = events(&g.state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    let event = &recorded[0];
    assert_eq!(event.category, "hazard.S9");
    assert_eq!(event.org_id.as_deref(), Some(TENANT_ORG));
    assert_eq!(event.credential_id.as_deref(), Some(TENANT_CREDENTIAL));
    assert_eq!(event.detector.kind, DetectorKind::Classifier);
    assert_eq!(event.detector.id, "decision_local");
    assert!(event
        .detector
        .version
        .as_deref()
        .is_some_and(|v| v.contains("#t")));
    assert_eq!(event.action, EnforcementAction::Blocked);
    assert_eq!(event.direction, ViolationDirection::Inbound);
    assert_eq!(event.spend, SpendOwner::Ryu);
    assert_eq!(
        event.policy.as_ref().map(|p| p.layer),
        Some(PolicyLayer::Platform)
    );
    assert_eq!(
        event.screening_id.as_deref(),
        Some(block.screening_id.as_str())
    );
    assert_eq!(event.dedupe_key, "req-sg1:0:decision_local:hazard.S9");
    assert!(event.confidence.is_some_and(|c| (0.0..=1.0).contains(&c)));
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}

/// SG-2: a flag is recorded `logged_only` and the request proceeds.
#[tokio::test]
async fn a_flagged_code_records_a_logged_only_event() {
    let (g, _) = qualified_fleet("ok");
    let ctx = tenant_ctx("req-sg2");
    screen_chat(
        &g.state,
        &ctx,
        &chat_body(SENTINEL_HAZARD_S1),
        Surface::Chat,
    )
    .await
    .expect("a flag passes");
    let recorded = events(&g.state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert_eq!(recorded[0].category, "hazard.S1");
    assert_eq!(recorded[0].action, EnforcementAction::LoggedOnly);
    assert_eq!(recorded[0].enforcement, EnforcementMode::Enforced);
}

/// SG-18: one attempt flagged S1 and blocked S9 by the same backend gives two
/// events with distinct dedupe keys.
#[tokio::test]
async fn a_flag_and_a_block_from_one_backend_are_two_events() {
    let (g, _) = qualified_fleet("ok");
    let ctx = tenant_ctx("req-sg18");
    let body = chat_body(&format!("{SENTINEL_HAZARD_S1} and {SENTINEL_HAZARD_S9}"));
    assert!(screen_chat(&g.state, &ctx, &body, Surface::Chat)
        .await
        .is_err());
    let recorded = events(&g.state);
    assert_eq!(recorded.len(), 2, "{recorded:?}");
    let keys: std::collections::BTreeSet<_> =
        recorded.iter().map(|e| e.dedupe_key.as_str()).collect();
    assert_eq!(keys.len(), 2);
    let s1 = recorded.iter().find(|e| e.category == "hazard.S1").unwrap();
    let s9 = recorded.iter().find(|e| e.category == "hazard.S9").unwrap();
    assert_eq!(s1.action, EnforcementAction::LoggedOnly);
    assert_eq!(s9.action, EnforcementAction::Blocked);
}

/// SG-17 / SC-4: re-screening an identical body (a fallback attempt, a tool
/// round) adds no second event for the same dedupe key.
#[tokio::test]
async fn re_admission_records_one_event_per_dedupe_key() {
    let (g, _) = qualified_fleet("ok");
    let ctx = tenant_ctx("req-sg17");
    let body = chat_body(SENTINEL_HAZARD_S1);
    for _ in 0..3 {
        screen_chat(&g.state, &ctx, &body, Surface::Chat)
            .await
            .unwrap();
    }
    assert_eq!(events(&g.state).len(), 1);
}

/// S4: the event carries its keyed hash, never an excerpt, and no field
/// holds the screened text.
#[tokio::test]
async fn an_s4_block_records_no_excerpt() {
    let (g, _) = qualified_fleet("ok");
    let ctx = tenant_ctx("req-s4-admit");
    assert!(screen_chat(
        &g.state,
        &ctx,
        &chat_body(SENTINEL_HAZARD_S4),
        Surface::Chat
    )
    .await
    .is_err());
    let rows = g.state.violations.pending(10).unwrap();
    let s4 = rows
        .iter()
        .find(|row| row.event.category == "hazard.S4")
        .expect("an S4 event");
    assert!(s4.excerpt.is_none());
    assert!(s4.event.evidence_ref.is_none());
    assert!(s4.event.evidence_hmac.is_some());
    assert_eq!(s4.event.severity, Severity::Critical);
    for row in &rows {
        assert!(
            row.excerpt.is_none(),
            "no excerpt for any code of an S4 request"
        );
        let wire = serde_json::to_string(&row.event).unwrap();
        assert!(!wire.contains(SENTINEL_HAZARD_S4));
    }
}

/// A non-S4 block keeps a redacted excerpt of the screened text, and only
/// there: the event itself carries no prompt text.
#[tokio::test]
async fn an_s9_block_keeps_its_excerpt_out_of_the_event() {
    let (g, _) = qualified_fleet("ok");
    let ctx = tenant_ctx("req-s9-excerpt");
    let text = format!("{SENTINEL_HAZARD_S9} with surrounding benign words");
    assert!(
        screen_chat(&g.state, &ctx, &chat_body(&text), Surface::Chat)
            .await
            .is_err()
    );
    let rows = g.state.violations.pending(10).unwrap();
    assert_eq!(rows.len(), 1);
    let excerpt = rows[0].excerpt.as_deref().expect("S9 keeps an excerpt");
    assert!(excerpt.contains(SENTINEL_HAZARD_S9));
    assert!(excerpt.len() <= crate::audit::violation::MAX_EXCERPT_BYTES);
    let wire = serde_json::to_string(&rows[0].event).unwrap();
    assert!(!wire.contains(SENTINEL_HAZARD_S9));
    assert!(!wire.contains("surrounding benign words"));
}

/// Output: a buffered block is `blocked` outbound; a stream cut is
/// `stream_terminated`.
#[tokio::test]
async fn output_blocks_record_outbound_events() {
    let (g, _) = qualified_fleet(&format!("reply {SENTINEL_HAZARD_S9}"));
    let (status, _, _) = chat(&g, "benign question").await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let recorded = events(&g.state);
    assert_eq!(recorded.len(), 1, "{recorded:?}");
    assert_eq!(recorded[0].category, "hazard.S9");
    assert_eq!(recorded[0].direction, ViolationDirection::Outbound);
    assert_eq!(recorded[0].action, EnforcementAction::Blocked);

    let (g, _) = qualified_fleet(SENTINEL_HAZARD_S4);
    let body = json!({
        "model": "fixture-model",
        "stream": true,
        "messages": [{ "role": "user", "content": "benign question" }]
    });
    let (_, _, raw) = send(&g.app, Method::POST, "/v1/chat/completions", Some(&body)).await;
    assert!(raw.contains("platform_floor_output_blocked"));
    let recorded = events(&g.state);
    let cut = recorded
        .iter()
        .find(|e| e.category == "hazard.S4")
        .expect("an S4 output event");
    assert_eq!(cut.action, EnforcementAction::StreamTerminated);
    assert_eq!(cut.direction, ViolationDirection::Outbound);
    assert!(!g.state.violations.has_excerpt(&cut.event_id).unwrap());
}

/// The regex platform floor records its own event, which is the only
/// enforcement signal while no backend is healthy and qualified.
#[tokio::test]
async fn a_regex_floor_block_records_a_regex_event() {
    let backend =
        Arc::new(TestBackend::new("decision_local").fail_always(BackendError::Unavailable("down")));
    let g = gateway(
        GatewayCustody::Fleet,
        runtime_with(&Default::default(), std::slice::from_ref(&backend)),
        Some(floor(
            3,
            Some(screener_json(&["decision_local"], true, json!({}))),
        )),
        "ok",
    );
    let (status, _, body) = chat(&g, SENTINEL_LEXICON).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let recorded = events(&g.state);
    let regex = recorded
        .iter()
        .find(|e| e.detector.kind == DetectorKind::Regex)
        .expect("a regex event");
    assert_eq!(regex.action, EnforcementAction::Blocked);
    assert_eq!(
        regex.policy.as_ref().map(|p| p.layer),
        Some(PolicyLayer::Platform)
    );
    assert!(
        !regex.detector.id.contains("lexicon"),
        "a floor pattern name never leaves the replica"
    );
    assert_eq!(g.calls.load(Ordering::SeqCst), 0);
}
