//! `POST /v1/audit/prune`: the local-admin gate, the retention pass actually
//! deleting expired rows, and a store failure surfacing as a 500.

use super::prune_audit;
use crate::audit::{
    AuditBackend, AuditEntry, AuditLogger, AuditPruneSummary, AuditQuery, AuditRecord,
    AuditSummary, AuditUsageEvent, AuditUsageQuery,
};
use crate::config::{ApiKeyConfig, AuditConfig, AuthConfig, EvalsConfig, GatewayConfig};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::state::{AppState, SharedState};
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const MASTER: &str = "sk-prune-master";
const PLAIN: &str = "sk-prune-plain";

/// A unique SQLite path that removes the database and its WAL sidecars on drop,
/// so repeated runs do not leak files into the temp dir.
struct TempDb(String);

impl TempDb {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        Self(
            std::env::temp_dir()
                .join(format!("ryu-gw-audit-prune-{}-{n}.db", std::process::id()))
                .to_string_lossy()
                .to_string(),
        )
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", self.0));
        }
    }
}

fn config() -> GatewayConfig {
    GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some(MASTER.to_owned()),
            api_keys: vec![ApiKeyConfig {
                key: PLAIN.to_owned(),
                name: "plain".to_owned(),
                org_id: None,
                team_id: None,
                channel_id: None,
                project_id: None,
                requests_per_minute: None,
                tokens_per_minute: None,
                token_budget_total: None,
                downgrade_to: None,
                trusted_forwarder: false,
                allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
            }],
        },
        ..GatewayConfig::default()
    }
}

/// A persistent audit store holding one row past the 90-day retention window
/// and one fresh row, written straight to SQLite so no writer thread is raced.
fn state_with_rows() -> (SharedState, TempDb) {
    let db = TempDb::new();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db.0.clone(),
    })
    .expect("audit logger");
    let conn = rusqlite::Connection::open(&db.0).expect("open audit db");
    conn.execute_batch(
        "INSERT INTO audit_log (timestamp, request_id, api_key, provider, model)
             VALUES (datetime('now', '-200 days'), 'expired', 'k', 'openai', 'gpt'),
                    (datetime('now'), 'fresh', 'k', 'openai', 'gpt');",
    )
    .expect("seed audit rows");
    let state = Arc::new(AppState::new_for_test(
        config(),
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    (state, db)
}

fn request_ids(db: &TempDb) -> Vec<String> {
    let conn = rusqlite::Connection::open(&db.0).expect("open audit db");
    let mut stmt = conn
        .prepare("SELECT request_id FROM audit_log ORDER BY id")
        .expect("prepare");
    let ids: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query")
        .map(|row| row.expect("row"))
        .collect();
    ids
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
    headers
}

fn loopback() -> ConnectInfo<SocketAddr> {
    ConnectInfo("127.0.0.1:4243".parse().unwrap())
}

#[tokio::test]
async fn prune_refuses_non_admin_callers_and_deletes_nothing() {
    let (state, db) = state_with_rows();

    let inference_key = prune_audit(State(Arc::clone(&state)), loopback(), bearer(PLAIN)).await;
    assert!(matches!(inference_key, Err(GatewayError::Unauthorized(_))));

    let remote = prune_audit(
        State(Arc::clone(&state)),
        ConnectInfo("198.51.100.4:443".parse().unwrap()),
        HeaderMap::new(),
    )
    .await;
    assert!(
        remote.is_err(),
        "an anonymous network peer must not prune the audit log"
    );

    assert_eq!(
        request_ids(&db),
        vec!["expired".to_owned(), "fresh".to_owned()],
        "a refused caller must not have run the retention pass"
    );
}

#[tokio::test]
async fn prune_deletes_expired_rows_and_reports_the_policy() {
    let (state, db) = state_with_rows();

    let Json(body) = prune_audit(State(Arc::clone(&state)), loopback(), bearer(MASTER))
        .await
        .expect("master key may prune");

    assert_eq!(body["kind"], "retention");
    assert_eq!(body["deleted_rows"], 1, "{body}");
    assert_eq!(body["retention_days"], 90);
    assert_eq!(body["max_rows"], 1_000_000);
    assert_eq!(request_ids(&db), vec!["fresh".to_owned()]);

    // Idempotent: a second pass has nothing left to delete.
    let Json(again) = prune_audit(State(state), loopback(), bearer(MASTER))
        .await
        .expect("second prune");
    assert_eq!(again["deleted_rows"], 0);
}

/// An audit sink whose retention pass fails (e.g. a locked or corrupt store).
struct FailingPruneBackend;

impl AuditBackend for FailingPruneBackend {
    fn log(&self, _record: AuditRecord) {}
    fn is_enabled(&self) -> bool {
        true
    }
    fn token_usage(&self, _api_key: &str) -> u64 {
        0
    }
    fn add_tokens(&self, _api_key: &str, _n: u64) {}
    fn query(&self, _query: &AuditQuery) -> anyhow::Result<Vec<AuditEntry>> {
        Ok(Vec::new())
    }
    fn summary(&self) -> anyhow::Result<AuditSummary> {
        Ok(AuditSummary::default())
    }
    fn usage_rollup(&self, _query: &AuditUsageQuery) -> anyhow::Result<Vec<AuditUsageEvent>> {
        Ok(Vec::new())
    }
    fn prune(&self) -> anyhow::Result<AuditPruneSummary> {
        anyhow::bail!("database is locked")
    }
}

#[tokio::test]
async fn prune_store_failure_is_a_500() {
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("audit logger");
    let mut app = AppState::new_for_test(config(), audit, EvalsRunner::new(EvalsConfig::default()));
    app.audit.register("failing", Arc::new(FailingPruneBackend));
    assert!(app.audit.set_active("failing"));
    let state = Arc::new(app);

    let error = prune_audit(State(state), loopback(), bearer(MASTER))
        .await
        .expect_err("a failed retention pass must not report success");
    assert!(matches!(error, GatewayError::Internal(_)), "{error:?}");
    assert_eq!(
        error.into_response().status(),
        StatusCode::INTERNAL_SERVER_ERROR
    );
}
