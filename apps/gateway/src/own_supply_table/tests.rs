use super::*;
use axum::{extract::State, http::StatusCode, response::IntoResponse, routing::get, Router};
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

fn row(id: &str, slot: &str, upstream: &str) -> Value {
    json!({
        "id": id, "slot": slot, "upstream": upstream, "priority": 0,
        "canaryRequired": false,
        "userPrice": {"inPer1kMicroUsd": 3000, "outPer1kMicroUsd": 15000}
    })
}

fn body(version: u64, rows: Vec<Value>) -> Value {
    json!({"version": version, "rows": rows, "poolDefaults": {}, "discoveryRequestedAt": null})
}

#[test]
fn a_bad_row_is_skipped_on_its_own() {
    let (table, _) = parse_table(&body(
        3,
        vec![
            row(
                "anthropic/claude-sonnet-4.5",
                "anthropic-credits",
                "claude-sonnet-4-5",
            ),
            // Not an own-supply slot.
            row("openai/gpt-5", "openai", "gpt-5"),
            // No price.
            json!({"id": "openai/o3", "slot": "openai-credits", "upstream": "o3"}),
            // Not a row.
            json!("garbage"),
        ],
    ))
    .unwrap();
    assert_eq!(table.version(), 3);
    assert_eq!(table.rows().len(), 1);
    assert!(parse_table(&json!({"rows": []})).is_none());
}

#[test]
fn the_table_never_downgrades() {
    let runtime = OwnSupplyRuntime::fleet_for_test(OwnSupplyTable::empty(), None);
    let parsed = |version, rows| parse_table(&body(version, rows)).unwrap().0;
    assert!(runtime.offer(
        parsed(5, vec![row("openai/o3", "openai-credits", "o3")]),
        None
    ));
    // Same version, older version, empty with the same version: ignored.
    assert!(!runtime.offer(parsed(5, vec![]), None));
    assert!(!runtime.offer(
        parsed(4, vec![row("openai/gpt-5", "openai-credits", "gpt-5")]),
        None
    ));
    assert_eq!(runtime.table().rows().len(), 1);
    // An empty table needs a higher version.
    assert!(runtime.offer(parsed(6, vec![]), None));
    assert!(runtime.table().is_empty());
}

#[test]
fn fleet_rows_route_only_after_a_canary_and_never_while_quarantined() {
    let table = parse_table(&body(1, vec![row("openai/o3", "openai-credits", "o3")]))
        .unwrap()
        .0;
    let runtime = OwnSupplyRuntime::fleet_for_test(table, None);
    let row = runtime.table().rows()[0].clone();
    assert!(!runtime.is_routable(&row), "no canary yet");
    assert!(runtime.canary_due("openai-credits", "o3", "abcd"));
    runtime.record_canary(
        "openai-credits",
        "O3",
        CanaryResult {
            ok: true,
            at: Instant::now(),
            key_fingerprint: "abcd".into(),
        },
    );
    assert!(runtime.is_routable(&row));
    assert!(!runtime.canary_due("openai-credits", "o3", "abcd"));
    // A rotated key means a fresh check.
    assert!(runtime.canary_due("openai-credits", "o3", "beef"));
    runtime.quarantine("openai-credits", "o3");
    assert!(!runtime.is_routable(&row));
    assert_eq!(
        runtime.take_quarantine_counts("openai-credits"),
        vec![("o3".to_owned(), 1)]
    );
    assert!(runtime.take_quarantine_counts("openai-credits").is_empty());
    // A failed canary never routes.
    let failed = OwnSupplyRuntime::fleet_for_test(runtime.table().as_ref().clone(), None);
    failed.record_canary(
        "openai-credits",
        "o3",
        CanaryResult {
            ok: false,
            at: Instant::now(),
            key_fingerprint: "abcd".into(),
        },
    );
    assert!(!failed.is_routable(&row));
}

#[test]
fn non_fleet_routes_the_seed_except_canary_required_rows() {
    let runtime = OwnSupplyRuntime::default();
    let table = runtime.table();
    let sonnet = table
        .equivalents("anthropic/claude-sonnet-4.5")
        .next()
        .unwrap();
    assert!(runtime.is_routable(sonnet));
    // No seed row needs a canary since the retired Bedrock rows were dropped,
    // so every seed row routes, and none reaches Bedrock.
    assert!(table.rows().iter().all(|row| runtime.is_routable(row)));
    assert!(table.rows().iter().all(|row| row.slot != "bedrock"));
    assert_eq!(table.equivalents("amazon/nova-pro-v1").next(), None);
}

#[test]
fn fleet_boot_reads_the_last_known_good_file_else_starts_empty() {
    let dir = std::env::temp_dir().join(format!("ryu-own-supply-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let empty = OwnSupplyRuntime::for_process_unmirrored(true, Some(&dir));
    assert!(empty.table().is_empty());
    let table = parse_table(&body(9, vec![row("openai/o3", "openai-credits", "o3")]))
        .unwrap()
        .0;
    assert!(empty.offer(table, Some("2026-10-12T00:00:00Z".into())));
    let rebooted = OwnSupplyRuntime::for_process_unmirrored(true, Some(&dir));
    assert_eq!(rebooted.table().version(), 9);
    assert_eq!(rebooted.table().rows().len(), 1);
    assert_eq!(
        rebooted.discovery_requested_at().as_deref(),
        Some("2026-10-12T00:00:00Z")
    );
    // Non-fleet ignores the file and uses the seed.
    let seed = OwnSupplyRuntime::for_process_unmirrored(false, Some(&dir));
    assert_eq!(seed.table().version(), 0);
    assert!(!seed.table().is_empty());
    std::fs::remove_dir_all(&dir).ok();
}

#[derive(Clone)]
struct Mock {
    status: Arc<std::sync::Mutex<(StatusCode, Value)>>,
    hits: Arc<AtomicUsize>,
    saw_secret: Arc<AtomicUsize>,
}

async fn handler(State(mock): State<Mock>, headers: axum::http::HeaderMap) -> impl IntoResponse {
    mock.hits.fetch_add(1, Ordering::SeqCst);
    if headers
        .get("x-ryu-internal-secret")
        .and_then(|v| v.to_str().ok())
        == Some("s3cret")
    {
        mock.saw_secret.fetch_add(1, Ordering::SeqCst);
    }
    let (status, body) = mock.status.lock().unwrap().clone();
    (status, axum::Json(body))
}

#[tokio::test]
async fn the_poller_installs_keeps_and_survives_failures() {
    let mock = Mock {
        status: Arc::new(std::sync::Mutex::new((
            StatusCode::OK,
            body(2, vec![row("openai/o3", "openai-credits", "o3")]),
        ))),
        hits: Arc::default(),
        saw_secret: Arc::default(),
    };
    let app = Router::new()
        .route("/api/own-supply/fleet/table", get(handler))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let endpoint = crate::provider_vault::control_plane_endpoint(
        &format!("http://127.0.0.1:{}", addr.port()),
        "own-supply/fleet/table",
    )
    .unwrap();
    let http = reqwest::Client::new();
    let runtime = OwnSupplyRuntime::fleet_for_test(OwnSupplyTable::empty(), None);

    assert_eq!(
        poll_once(&http, &endpoint, "s3cret", &runtime).await,
        PollOutcome::Installed(2)
    );
    assert_eq!(mock.saw_secret.load(Ordering::SeqCst), 1);
    // 500: keep the table.
    *mock.status.lock().unwrap() = (StatusCode::INTERNAL_SERVER_ERROR, json!({}));
    assert_eq!(
        poll_once(&http, &endpoint, "s3cret", &runtime).await,
        PollOutcome::Failed
    );
    assert_eq!(runtime.table().version(), 2);
    // Same version, empty rows: ignored.
    *mock.status.lock().unwrap() = (StatusCode::OK, body(2, vec![]));
    assert_eq!(
        poll_once(&http, &endpoint, "s3cret", &runtime).await,
        PollOutcome::Kept
    );
    assert_eq!(runtime.table().rows().len(), 1);
    // 304: not modified.
    *mock.status.lock().unwrap() = (StatusCode::NOT_MODIFIED, json!(null));
    assert_eq!(
        poll_once(&http, &endpoint, "s3cret", &runtime).await,
        PollOutcome::NotModified
    );
}

#[test]
fn the_fleet_module_accepts_an_empty_published_table() {
    let (table, requested) = fleet::parse_table(&body(7, vec![])).expect("parses");
    assert!(table.rows().is_empty());
    assert_eq!(requested, None);
}
