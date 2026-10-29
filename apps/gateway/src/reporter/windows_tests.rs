//! Usage window reporter tests against a mock control plane (spec 04.4).
//! Content is the spec 00.9 sentinels only.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use chrono::{Duration, TimeZone, Utc};
use serde_json::{json, Value};

use super::*;
use crate::audit::{AuditConfig, AuditLogger, AuditRecord, EventType};
use crate::config::GatewayConfig;
use crate::custody::GatewayCustody;
use crate::evals::EvalsRunner;

const REPORTER_KEY: &str = "rgw_test_window_reporter";
const CREDENTIAL: &str = "6650a1b2c3d4e5f6a7b8c9d0";

#[derive(Default)]
struct Mock {
    /// `(x-gateway-key, body)` per request.
    requests: Mutex<Vec<(String, Value)>>,
    /// Scripted answers, then 200 with every window stored.
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
    let count = body["windows"].as_array().map_or(0, Vec::len);
    mock.requests.lock().unwrap().push((key, body));
    let scripted = mock.script.lock().unwrap().pop_front();
    let (status, answer) = scripted.unwrap_or((
        StatusCode::OK,
        json!({ "ingested": 0, "duplicates": 0, "windows": count, "rejected": [] }),
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

fn state_for(base_url: &str, custody: GatewayCustody) -> AppState {
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
    state.custody = custody;
    state
}

fn record(request_id: &str) -> AuditRecord {
    AuditRecord {
        key_id: Some(CREDENTIAL.to_owned()),
        request_id: request_id.to_owned(),
        api_key: "rgw_test_window_tenant".to_owned(),
        user_name: None,
        org_id: Some("6650a1b2c3d4e5f6a7b8c9d1".to_owned()),
        team_id: None,
        team_ids: None,
        project_id: None,
        provider: "anthropic".to_owned(),
        model: "claude-test".to_owned(),
        input_tokens: 12,
        output_tokens: 4,
        cache_read_tokens: None,
        cache_write_tokens: None,
        cache_hit: false,
        prompt_cache_outcome: None,
        prompt_cache_read_tokens: None,
        prompt_cache_write_tokens: None,
        cache_write_1h_tokens: None,
        latency_ms: 200,
        eval_score: None,
        error: None,
        skill_ids: None,
        session_id: None,
        event_type: EventType::ModelCall,
        backend: None,
        command: None,
        duration_ms: None,
        exit_code: None,
        user_id: None,
        agent_id: None,
        feature: None,
        purpose: None,
        managed_inference: false,
        provider_cost_micro_usd: None,
        widget_instance_id: None,
    }
}

fn completion() -> Value {
    json!({ "kind": "completion", "verdict": { "decided_by": "none", "action": "allow" } })
}

fn ten_oclock() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 23, 10, 0, 20).unwrap()
}

fn fold(state: &AppState, at: chrono::DateTime<Utc>, request_id: &str) {
    state
        .usage_windows
        .observe_at(at, state.custody, &record(request_id), &completion(), None);
}

fn requests(mock: &Mock) -> Vec<(String, Value)> {
    mock.requests.lock().unwrap().clone()
}

#[tokio::test]
async fn an_open_minute_waits_and_a_closed_one_is_sent_once() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base, GatewayCustody::Fleet);
    let at = ten_oclock();
    fold(&state, at, "req-1");
    fold(&state, at, "req-2");

    let open = push_windows_at(&state, at).await.unwrap();
    assert_eq!(open, WindowPushSummary::default());
    assert!(
        requests(&mock).is_empty(),
        "nothing sent for the open minute"
    );

    let summary = push_windows_at(&state, at + Duration::minutes(1))
        .await
        .unwrap();
    assert_eq!(summary.closed, 1);
    assert_eq!(summary.sent, 1);
    assert_eq!(summary.stored, 1);
    assert_eq!(summary.requests, 1);
    let seen = requests(&mock);
    assert_eq!(seen.len(), 1);
    let (key, body) = &seen[0];
    assert_eq!(key, REPORTER_KEY);
    assert_eq!(
        body["events"],
        json!([]),
        "a window request carries no events"
    );
    assert_eq!(body["evidence"], json!({}));
    assert_eq!(
        body["gatewayInstance"],
        crate::policy::gateway_instance_id(),
    );
    let window = &body["windows"][0];
    assert_eq!(window["credentialId"], CREDENTIAL);
    assert_eq!(window["minute"], "2026-10-23T10:00:00Z");
    assert_eq!(window["requests"], 2);
    assert_eq!(window["inputTokens"], 24);
    assert_eq!(window["outcomes"][0]["decidedBy"], "none");
    assert_eq!(window["outcomes"][0]["requests"], 2);

    // Acknowledged: the next tick sends nothing.
    let again = push_windows_at(&state, at + Duration::minutes(2))
        .await
        .unwrap();
    assert_eq!(again.sent, 0);
    assert_eq!(requests(&mock).len(), 1);
}

#[tokio::test]
async fn a_failed_ingest_holds_the_cursor_and_resends_the_same_window() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base, GatewayCustody::Fleet);
    mock.script.lock().unwrap().push_back((
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({ "error": "boom" }),
    ));
    let at = ten_oclock();
    fold(&state, at, "req-retry");

    assert!(push_windows_at(&state, at + Duration::minutes(1))
        .await
        .is_err());
    assert_eq!(
        state.violations.window_cursor().unwrap(),
        0,
        "cursor held on 500"
    );
    // A row folded after the failed close goes to a later minute, never
    // into the queued window.
    fold(&state, at, "req-late");

    let summary = push_windows_at(&state, at + Duration::minutes(1))
        .await
        .unwrap();
    assert_eq!(summary.sent, 1);
    let seen = requests(&mock);
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].1, seen[1].1, "the retry is the same body");
    assert_eq!(seen[1].1["windows"][0]["requests"], 1);
    assert!(state.violations.window_cursor().unwrap() > 0);
    assert_eq!(
        state.usage_windows.open_count(),
        1,
        "the late row waits in 10:01"
    );
}

#[tokio::test]
async fn a_self_hosted_gateway_never_sends_windows() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base, GatewayCustody::SelfHosted);
    let at = ten_oclock();
    fold(&state, at, "req-self");
    state.log_audit(record("req-self-live"));
    // Even a window already queued (a custody change across restarts) stays.
    state
        .violations
        .enqueue_windows(
            "inst-before",
            &[crate::audit::WindowRecord {
                credential_id: CREDENTIAL.to_owned(),
                minute: "2026-10-23T09:59:00Z".to_owned(),
                json: json!({ "credentialId": CREDENTIAL }).to_string(),
            }],
        )
        .unwrap();

    let summary = push_windows_at(&state, at + Duration::minutes(5))
        .await
        .unwrap();
    assert_eq!(summary, WindowPushSummary::default());
    assert!(requests(&mock).is_empty());
    assert_eq!(state.usage_windows.open_count(), 0);
}

#[tokio::test]
async fn a_managed_node_sends_its_windows() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base, GatewayCustody::ManagedNode);
    let at = ten_oclock();
    fold(&state, at, "req-node");
    let summary = push_windows_at(&state, at + Duration::minutes(1))
        .await
        .unwrap();
    assert_eq!(summary.sent, 1);
    assert_eq!(requests(&mock).len(), 1);
}

#[tokio::test]
async fn windows_from_before_a_restart_keep_their_instance_id() {
    let (mock, base) = mock_control_plane().await;
    let state = state_for(&base, GatewayCustody::Fleet);
    let queued = |minute: &str| crate::audit::WindowRecord {
        credential_id: CREDENTIAL.to_owned(),
        minute: minute.to_owned(),
        json: json!({ "credentialId": CREDENTIAL, "minute": minute }).to_string(),
    };
    state
        .violations
        .enqueue_windows("inst-before-restart", &[queued("2026-10-23T09:58:00Z")])
        .unwrap();
    let at = ten_oclock();
    fold(&state, at, "req-now");

    let summary = push_windows_at(&state, at + Duration::minutes(1))
        .await
        .unwrap();
    assert_eq!(summary.requests, 2, "one request per instance id");
    let seen = requests(&mock);
    assert_eq!(seen[0].1["gatewayInstance"], "inst-before-restart");
    assert_eq!(seen[0].1["windows"][0]["minute"], "2026-10-23T09:58:00Z");
    assert_eq!(
        seen[1].1["gatewayInstance"],
        crate::policy::gateway_instance_id()
    );
}

#[test]
fn a_batch_stops_at_the_byte_budget_and_the_window_cap() {
    let big = "x".repeat(MAX_BODY_BYTES / 3);
    let rows: Vec<WindowRow> = (0..5)
        .map(|id| WindowRow {
            id,
            instance_id: "inst".to_owned(),
            json: big.clone(),
        })
        .collect();
    assert_eq!(
        next_batch(&rows).len(),
        2,
        "a third row would pass the budget"
    );

    let small: Vec<WindowRow> = (0..(MAX_WINDOWS as i64 + 5))
        .map(|id| WindowRow {
            id,
            instance_id: "inst".to_owned(),
            json: "{}".to_owned(),
        })
        .collect();
    assert_eq!(next_batch(&small).len(), MAX_WINDOWS);

    // One row larger than the budget still goes alone rather than stalling.
    let huge = vec![WindowRow {
        id: 1,
        instance_id: "inst".to_owned(),
        json: "x".repeat(MAX_BODY_BYTES + 1),
    }];
    assert_eq!(next_batch(&huge).len(), 1);
}
