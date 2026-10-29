//! Reporter tests against a mock control plane (spec ID-14). Content is the
//! spec 00.9 sentinels only.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Value};

use super::*;
use crate::audit::{AuditConfig, AuditLogger, EnforcementAction, PolicyLayer, ViolationDirection};
use crate::config::GatewayConfig;
use crate::evals::EvalsRunner;
use crate::violations::test_support::{tenant_ctx, TENANT_CREDENTIAL, TENANT_ORG};
use crate::violations::VerdictInput;
use ryu_gw_screening::TaxonomyId;

const REPORTER_KEY: &str = "rgw_test_violation_reporter";

#[derive(Default)]
struct Mock {
    /// `(x-gateway-key, body)` per request.
    requests: Mutex<Vec<(String, Value)>>,
    /// Scripted answers, then 200 with every event ingested.
    script: Mutex<VecDeque<(StatusCode, Value)>>,
}

async fn ingest(
    State(mock): State<Arc<Mock>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    let key = headers
        .get("x-gateway-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    let count = body["events"].as_array().map_or(0, Vec::len);
    mock.requests.lock().unwrap().push((key, body));
    let scripted = mock.script.lock().unwrap().pop_front();
    let (status, answer) = scripted.unwrap_or((
        StatusCode::OK,
        json!({ "ingested": count, "duplicates": 0, "windows": 0, "rejected": [] }),
    ));
    (status, Json(answer))
}

async fn mock_control_plane() -> (Arc<Mock>, String) {
    let mock = Arc::new(Mock::default());
    let app = Router::new()
        .route("/api/abuse/ingest", post(ingest))
        .with_state(Arc::clone(&mock));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (mock, format!("http://{address}"))
}

fn state_for(base_url: &str) -> AppState {
    let mut config = GatewayConfig::default();
    config.control_plane.enabled = true;
    config.control_plane.base_url = base_url.to_owned();
    config.control_plane.gateway_key = Some(REPORTER_KEY.to_owned());
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .unwrap();
    let mut state = AppState::new_for_test(config, audit, EvalsRunner::new(Default::default()));
    state.custody = crate::custody::GatewayCustody::Fleet;
    state
}

fn classifier(code: TaxonomyId, action: EnforcementAction) -> VerdictInput {
    VerdictInput::classifier(
        code,
        "decision_local",
        "test-model@00000000#t1".to_owned(),
        0.95,
        action,
        ViolationDirection::Inbound,
        PolicyLayer::Platform,
    )
    .with_screening_id("scr_reporter")
}

fn requests(mock: &Mock) -> Vec<(String, Value)> {
    mock.requests.lock().unwrap().clone()
}

#[tokio::test]
async fn a_failed_ingest_holds_the_cursor_and_the_retry_resends_the_same_event() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base);
    mock.script.lock().unwrap().push_back((
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "boom" }),
    ));
    let ctx = tenant_ctx("req-retry");
    let event_id = state
        .record_violation(
            &ctx,
            classifier(TaxonomyId::S9, EnforcementAction::Blocked)
                .with_evidence("RYU_TEST_HAZARD_S9 retry"),
        )
        .expect("recorded");

    assert!(push_violations(&state).await.is_err());
    assert_eq!(state.violations.cursor().unwrap(), 0, "cursor held on 500");
    assert!(state.violations.has_excerpt(&event_id).unwrap());

    let summary = push_violations(&state).await.unwrap();
    assert_eq!(summary.sent, 1);
    assert_eq!(summary.ingested, 1);
    let seen = requests(&mock);
    assert_eq!(seen.len(), 2);
    for (key, body) in &seen {
        assert_eq!(key, REPORTER_KEY);
        let event = &body["events"][0];
        assert_eq!(event["eventId"], event_id.as_str(), "same eventId resent");
        assert_eq!(event["orgId"], TENANT_ORG);
        assert_eq!(event["credentialId"], TENANT_CREDENTIAL);
        assert_eq!(
            event["dedupeKey"],
            format!(
                "{}:{}:{}:{}",
                event["requestId"].as_str().unwrap(),
                event["attempt"],
                event["detector"]["id"].as_str().unwrap(),
                event["category"].as_str().unwrap()
            )
        );
        let reference = format!("evd_{event_id}");
        assert_eq!(event["evidenceRef"], reference.as_str());
        assert_eq!(
            body["evidence"][&reference]["hmac"], event["evidenceHmac"],
            "the evidence hash matches the event"
        );
        assert_eq!(body["windows"], json!([]));
    }
    assert!(
        !state.violations.has_excerpt(&event_id).unwrap(),
        "excerpt cleared once acknowledged"
    );
    assert!(
        state.violations.cursor().unwrap() > 0,
        "cursor advanced on 200"
    );
    // The audit report cursor is independent and untouched.
    assert_eq!(
        state
            .report_cursor
            .load(std::sync::atomic::Ordering::Acquire),
        0
    );
    // Nothing left to send.
    let idle = push_violations(&state).await.unwrap();
    assert_eq!(idle, PushSummary::default());
    assert_eq!(requests(&mock).len(), 2);
}

#[tokio::test]
async fn an_excerpt_the_control_plane_refuses_is_dropped_and_the_event_resent_once() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base);
    let ctx = tenant_ctx("req-forbidden");
    let event_id = state
        .record_violation(
            &ctx,
            classifier(TaxonomyId::S9, EnforcementAction::Blocked)
                .with_evidence("RYU_TEST_HAZARD_S9 refused"),
        )
        .unwrap();
    mock.script.lock().unwrap().push_back((
        StatusCode::OK,
        json!({ "ingested": 0, "duplicates": 0, "windows": 0, "rejected": [
            { "eventId": event_id, "reason": "evidence_forbidden_for_category" }
        ] }),
    ));
    let summary = push_violations(&state).await.unwrap();
    assert_eq!(summary.resent_without_excerpt, 1);
    assert!(summary.rejected.is_empty());
    let seen = requests(&mock);
    assert_eq!(seen.len(), 2, "one resend, no retry loop");
    let resend = &seen[1].1;
    assert_eq!(resend["events"][0]["eventId"], event_id.as_str());
    assert!(resend["events"][0]["evidenceRef"].is_null());
    assert_eq!(resend["evidence"], json!({}));
    assert!(!resend.to_string().contains("RYU_TEST_HAZARD_S9"));
    assert!(!state.violations.has_excerpt(&event_id).unwrap());
}

#[tokio::test]
async fn s4_events_never_send_an_excerpt_and_no_prompt_text_leaves_beyond_the_excerpt() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base);
    let ctx = tenant_ctx("req-s4-report");
    state
        .record_violation(
            &ctx,
            classifier(TaxonomyId::S9, EnforcementAction::LoggedOnly)
                .with_evidence("RYU_TEST_HAZARD_S9 earlier"),
        )
        .unwrap();
    state
        .record_violation(
            &ctx,
            classifier(TaxonomyId::S4, EnforcementAction::Blocked)
                .with_evidence("RYU_TEST_HAZARD_S4 sentinel"),
        )
        .unwrap();
    let other = tenant_ctx("req-s9-report");
    state
        .record_violation(
            &other,
            classifier(TaxonomyId::S9, EnforcementAction::Blocked)
                .with_evidence("RYU_TEST_HAZARD_S9 kept"),
        )
        .unwrap();
    push_violations(&state).await.unwrap();
    let body = requests(&mock).pop().unwrap().1;
    let events = body["events"].as_array().unwrap();
    assert_eq!(events.len(), 3);
    for event in events {
        if event["requestId"] == "req-s4-report" {
            assert!(
                event["evidenceRef"].is_null(),
                "an S4 request carries no excerpt, not even for its other codes"
            );
        }
        if event["category"] == "hazard.S4" {
            assert!(event["evidenceHmac"].as_str().unwrap().starts_with("evh1."));
            assert_eq!(event["severity"], "critical");
        }
    }
    let evidence = body["evidence"].as_object().unwrap();
    assert_eq!(
        evidence.len(),
        1,
        "only the other request's S9 excerpt travels"
    );
    let text = body.to_string();
    assert!(!text.contains("RYU_TEST_HAZARD_S4"));
    assert!(!text.contains("earlier"));
    // Outside the evidence map no screened text appears at all.
    let mut stripped = body.clone();
    stripped["evidence"] = json!({});
    assert!(!stripped.to_string().contains("RYU_TEST_HAZARD_S9"));
}

#[tokio::test]
async fn events_without_a_tenant_org_stay_local_and_the_cursor_moves_past_them() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base);
    let mut ctx = tenant_ctx("req-no-org");
    ctx.org_id = None;
    state
        .record_violation(&ctx, classifier(TaxonomyId::S9, EnforcementAction::Blocked))
        .unwrap();
    let summary = push_violations(&state).await.unwrap();
    assert_eq!(summary.local_only, 1);
    assert_eq!(summary.sent, 0);
    assert!(requests(&mock).is_empty());
    assert!(state.violations.cursor().unwrap() > 0);
    assert_eq!(state.violations.len().unwrap(), 1, "kept for the local log");
}

#[tokio::test]
async fn a_backlog_drains_in_batches_of_at_most_500() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base);
    for n in 0..(MAX_BATCH + 3) {
        let ctx = tenant_ctx(&format!("req-batch-{n}"));
        state
            .record_violation(
                &ctx,
                classifier(TaxonomyId::S1, EnforcementAction::LoggedOnly),
            )
            .unwrap();
    }
    assert_eq!(push_violations(&state).await.unwrap().sent, MAX_BATCH);
    assert_eq!(push_violations(&state).await.unwrap().sent, 3);
    let seen = requests(&mock);
    assert_eq!(seen[0].1["events"].as_array().unwrap().len(), MAX_BATCH);
    assert_eq!(seen[1].1["events"].as_array().unwrap().len(), 3);
}

#[tokio::test]
async fn other_rejections_are_logged_and_not_retried() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base);
    let ctx = tenant_ctx("req-rejected");
    let event_id = state
        .record_violation(&ctx, classifier(TaxonomyId::S9, EnforcementAction::Blocked))
        .unwrap();
    mock.script.lock().unwrap().push_back((
        StatusCode::OK,
        json!({ "ingested": 0, "duplicates": 0, "windows": 0, "rejected": [
            { "eventId": event_id, "reason": "credential_org_mismatch" }
        ] }),
    ));
    let summary = push_violations(&state).await.unwrap();
    assert_eq!(
        summary.rejected,
        vec![(event_id, "credential_org_mismatch".to_owned())]
    );
    assert!(push_violations(&state).await.unwrap().sent == 0);
    assert_eq!(requests(&mock).len(), 1);
}
