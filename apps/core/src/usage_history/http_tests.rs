//! Owner history routes driven through the shipping router: tracking consent,
//! durable import progress and account-sync input errors.
//!
//! The ledger and progress store are process-wide (`http::STORE`/`OPERATIONS`),
//! and only this file installs them in the test binary. Everything that depends on
//! the install order therefore runs inside the single test below, in sequence:
//! first with nothing installed, then against a real SQLite ledger in a temp dir.
use super::live::TurnHistory;
use super::operations::{ImportOperation, ImportOperations};
use super::UsageHistoryStore;
use axum::{body::Body, http::Request, http::StatusCode, Router};
use serde_json::{json, Value};
use tower::ServiceExt;

struct Harness {
    _directory: tempfile::TempDir,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let router = super::http::routes().with_state(state);
        Self {
            _directory: directory,
            router,
        }
    }

    async fn send(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let request = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        let value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        (status, value)
    }
}

/// Rows in the ledger, read through an independent SQLite connection.
fn ledger_rows(path: &std::path::Path) -> i64 {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row("SELECT COUNT(*) FROM usage_history_records", [], |row| {
            row.get(0)
        })
        .unwrap()
}

/// One completed native-session ACP turn, through the live recorder.
fn record_live_turn() {
    let mut turn = TurnHistory::new("codex", Some("openai".into()), Some("gpt".into()), None);
    turn.session_info(&json!({"sessionId":"native-session"}));
    turn.record(&json!({"done":true,"promptTokens":10,"completionTokens":2}));
}

#[tokio::test]
async fn tracking_consent_progress_and_account_sync_routes() {
    let harness = Harness::new();

    // ── Nothing installed: every route fails closed with 503. ────────────────
    let (status, body) = harness
        .send("GET", "/api/usage/history/tracking", None)
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(body["code"], "history_unavailable");
    let (status, body) = harness
        .send(
            "PUT",
            "/api/usage/history/tracking",
            Some(json!({"enabled":true})),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    let unknown_operation = uuid::Uuid::new_v4().to_string();
    let (status, _) = harness
        .send(
            "GET",
            &format!("/api/usage/history/import/operations/{unknown_operation}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);

    // ── Install a real ledger and progress store. ────────────────────────────
    let data = tempfile::tempdir().unwrap();
    let ledger = data.path().join("usage-history.db");
    let operations = ImportOperations::open(&data.path().join("operations.db")).unwrap();
    super::http::install_for_test(
        UsageHistoryStore::open(&ledger).unwrap(),
        operations.clone(),
    );

    // Off by default, and the live recorder keeps nothing while off.
    let (status, body) = harness
        .send("GET", "/api/usage/history/tracking", None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"enabled":false}));
    record_live_turn();
    assert_eq!(ledger_rows(&ledger), 0, "no consent, no metadata");

    // Unknown fields are refused and change nothing.
    let (status, _) = harness
        .send(
            "PUT",
            "/api/usage/history/tracking",
            Some(json!({"enabled":true,"retainPrompts":true})),
        )
        .await;
    assert!(status.is_client_error(), "{status}");
    assert!(!UsageHistoryStore::open(&ledger)
        .unwrap()
        .tracking_enabled()
        .unwrap());

    // Opting in persists (a reopened store reads it) and starts the recorder.
    let (status, body) = harness
        .send(
            "PUT",
            "/api/usage/history/tracking",
            Some(json!({"enabled":true})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({"enabled":true}));
    assert!(UsageHistoryStore::open(&ledger)
        .unwrap()
        .tracking_enabled()
        .unwrap());
    let (_, body) = harness
        .send("GET", "/api/usage/history/tracking", None)
        .await;
    assert_eq!(body, json!({"enabled":true}));
    record_live_turn();
    assert_eq!(ledger_rows(&ledger), 1, "consented turn is recorded");

    // Opting out stops new records and keeps what was recorded.
    let (status, _) = harness
        .send(
            "PUT",
            "/api/usage/history/tracking",
            Some(json!({"enabled":false})),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    record_live_turn();
    assert_eq!(ledger_rows(&ledger), 1);

    // ── Import progress: malformed id 400, unretained id 404, known id 200. ──
    let (status, body) = harness
        .send(
            "GET",
            "/api/usage/history/import/operations/not-a-uuid",
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "invalid_import_operation");
    let (status, body) = harness
        .send(
            "GET",
            &format!("/api/usage/history/import/operations/{unknown_operation}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "import_operation_not_found");
    let (operation, created) = operations.start("digest-a").unwrap();
    assert!(created);
    let ImportOperation::Running { id, .. } = &operation else {
        panic!("a new operation is running");
    };
    let (status, body) = harness
        .send(
            "GET",
            &format!("/api/usage/history/import/operations/{id}"),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["state"], "running");
    assert_eq!(body["id"], id.as_str());

    // ── Account sync: invalid input is a typed 400 before any provider call. ─
    let credential = "sk-admin-must-never-echo";
    let sync = |source: &str, start: &str, end: &str| {
        json!({
            "sourceId": source,
            "accountId": "org-a",
            "credential": credential,
            "startDate": start,
            "endDate": end,
        })
    };
    for input in [
        sync("openai-org-usage", "2025-02-01", "2025-01-01"),
        sync("openai-org-usage", "2025-01-01", "2026-06-01"),
        sync("openai-org-usage", "January", "2025-02-01"),
        sync("someone-elses-endpoint", "2025-01-01", "2025-02-01"),
    ] {
        let (status, body) = harness
            .send("POST", "/api/usage/history/account-sync", Some(input))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "invalid_account_import");
        assert!(!body.to_string().contains(credential), "never echoed");
    }
    let mut with_endpoint = sync("openai-org-usage", "2025-01-01", "2025-02-01");
    with_endpoint["endpoint"] = json!("https://attacker.example");
    let (status, body) = harness
        .send(
            "POST",
            "/api/usage/history/account-sync",
            Some(with_endpoint),
        )
        .await;
    assert!(status.is_client_error(), "{status}");
    assert!(!body.to_string().contains(credential));
    assert_eq!(ledger_rows(&ledger), 1, "refused syncs write nothing");
}
