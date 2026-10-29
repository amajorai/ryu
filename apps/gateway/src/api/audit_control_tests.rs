//! `POST /v1/audit/control`: the local-admin gate, field bounds, blank-field
//! normalisation, actor defaults, and the persisted `control_change` row Core's
//! org-policy proxy relies on.

use super::{record_control_change, ControlAuditBody};
use crate::audit::{AuditEntry, AuditLogger, AuditQuery};
use crate::config::{ApiKeyConfig, AuditConfig, AuthConfig, EvalsConfig, GatewayConfig};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::state::{AppState, SharedState};
use axum::extract::{ConnectInfo, State};
use axum::http::HeaderMap;
use axum::Json;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

const MASTER: &str = "sk-control-master";
const PLAIN: &str = "sk-control-plain";

/// A unique SQLite path that removes the database and its WAL sidecars on drop.
struct TempDb(String);

impl TempDb {
    fn new() -> Self {
        static N: AtomicU64 = AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::SeqCst);
        Self(
            std::env::temp_dir()
                .join(format!(
                    "ryu-gw-audit-control-{}-{n}.db",
                    std::process::id()
                ))
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

fn plain_key() -> ApiKeyConfig {
    ApiKeyConfig {
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
    }
}

fn master_config() -> GatewayConfig {
    GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some(MASTER.to_owned()),
            api_keys: vec![plain_key()],
        },
        ..GatewayConfig::default()
    }
}

/// Explicit local development posture: no auth and no master key, so an
/// anonymous loopback caller is a local admin.
fn unlocked_local_config() -> GatewayConfig {
    let mut config = GatewayConfig::default();
    config.auth.require_auth = false;
    config.auth.master_key = None;
    config
}

fn state_for(config: GatewayConfig) -> (SharedState, TempDb) {
    let db = TempDb::new();
    let audit = AuditLogger::new(&AuditConfig {
        enabled: true,
        db_path: db.0.clone(),
    })
    .expect("audit logger");
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    (state, db)
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
    headers
}

fn loopback() -> ConnectInfo<SocketAddr> {
    ConnectInfo("127.0.0.1:4243".parse().unwrap())
}

fn remote() -> ConnectInfo<SocketAddr> {
    ConnectInfo("198.51.100.4:443".parse().unwrap())
}

fn body(action: &str, target: &str) -> ControlAuditBody {
    ControlAuditBody {
        action: action.to_owned(),
        target: target.to_owned(),
        summary: None,
        actor_id: None,
        actor_name: None,
        agent_id: None,
    }
}

async fn post(
    state: &SharedState,
    peer: ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: ControlAuditBody,
) -> Result<(), GatewayError> {
    record_control_change(State(Arc::clone(state)), peer, headers, Json(body))
        .await
        .map(|Json(value)| assert_eq!(value["ok"], true))
}

fn control_rows(state: &SharedState) -> Vec<AuditEntry> {
    state
        .audit
        .query(&AuditQuery {
            event_type: Some("control_change".to_owned()),
            ..Default::default()
        })
        .expect("query control rows")
}

/// The writer is a background thread: wait until `expected` rows landed.
async fn wait_for_control_rows(state: &SharedState, expected: usize) -> Vec<AuditEntry> {
    for _ in 0..200 {
        let rows = control_rows(state);
        if rows.len() >= expected {
            return rows;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("audit writer did not persist {expected} control rows in time");
}

fn is_bad_request(result: &Result<(), GatewayError>) -> bool {
    matches!(result, Err(GatewayError::BadRequest(_)))
}

#[tokio::test]
async fn control_audit_refuses_non_admin_callers_and_writes_nothing() {
    let (state, _db) = state_for(master_config());

    let inference_key = post(&state, loopback(), bearer(PLAIN), body("refused", "a")).await;
    assert!(matches!(inference_key, Err(GatewayError::Unauthorized(_))));
    let anonymous_remote = post(&state, remote(), HeaderMap::new(), body("refused", "b")).await;
    assert!(
        anonymous_remote.is_err(),
        "an anonymous peer must be refused"
    );
    let anonymous_loopback = post(&state, loopback(), HeaderMap::new(), body("refused", "c")).await;
    assert!(
        anonymous_loopback.is_err(),
        "loopback without the master key is refused once a master key is configured"
    );

    // A later admitted write is the only row: the refused calls queued nothing
    // ahead of it on the single writer channel.
    post(&state, loopback(), bearer(MASTER), body("admitted", "d"))
        .await
        .expect("master key may write");
    let rows = wait_for_control_rows(&state, 1).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].model, "d");
}

#[tokio::test]
async fn control_audit_rejects_blank_and_oversized_fields() {
    let (state, _db) = state_for(master_config());
    let master = || bearer(MASTER);
    let long = |n: usize| "x".repeat(n);

    let cases: Vec<(&str, ControlAuditBody)> = vec![
        ("blank action", body("   ", "policy")),
        ("blank target", body("update", "\t")),
        ("action > 120", body(&long(121), "policy")),
        ("target > 120", body("update", &long(121))),
        (
            "summary > 400",
            ControlAuditBody {
                summary: Some(long(401)),
                ..body("update", "policy")
            },
        ),
        (
            "actor_id > 240",
            ControlAuditBody {
                actor_id: Some(long(241)),
                ..body("update", "policy")
            },
        ),
        (
            "actor_name > 240",
            ControlAuditBody {
                actor_name: Some(long(241)),
                ..body("update", "policy")
            },
        ),
        (
            "agent_id > 240",
            ControlAuditBody {
                agent_id: Some(long(241)),
                ..body("update", "policy")
            },
        ),
    ];
    for (label, case) in cases {
        let result = post(&state, loopback(), master(), case).await;
        assert!(is_bad_request(&result), "{label}: {result:?}");
    }

    // Exactly at every bound (counted in chars, after trimming) is accepted.
    let at_bounds = ControlAuditBody {
        summary: Some(format!("  {}  ", "é".repeat(400))),
        actor_id: Some(long(240)),
        actor_name: Some(long(240)),
        agent_id: Some(long(240)),
        ..body(&format!(" {} ", long(120)), &long(120))
    };
    post(&state, loopback(), master(), at_bounds)
        .await
        .expect("values at the bounds are accepted");
    let rows = wait_for_control_rows(&state, 1).await;
    assert_eq!(rows.len(), 1, "only the in-bounds call wrote a row");
    assert_eq!(
        rows[0].command.as_deref(),
        Some(format!("{}: {}", long(120), "é".repeat(400)).as_str())
    );
}

#[tokio::test]
async fn control_audit_records_attribution_and_master_key_actor_default() {
    let (state, _db) = state_for(master_config());

    post(
        &state,
        remote(),
        bearer(MASTER),
        ControlAuditBody {
            summary: Some("  enabled web search  ".to_owned()),
            actor_id: Some(" user-42 ".to_owned()),
            actor_name: Some("Ada Admin".to_owned()),
            agent_id: Some("agent-support".to_owned()),
            ..body(" org_policy.update ", " tools ")
        },
    )
    .await
    .expect("master key may write from anywhere");
    let rows = wait_for_control_rows(&state, 1).await;
    let row = &rows[0];
    assert_eq!(row.event_type, "control_change");
    assert_eq!(row.provider, "gateway_control");
    assert_eq!(row.model, "tools", "target is trimmed");
    assert_eq!(
        row.command.as_deref(),
        Some("org_policy.update: enabled web search")
    );
    assert_eq!(row.user_name.as_deref(), Some("Ada Admin"));
    assert_eq!(row.user_id.as_deref(), Some("user-42"));
    assert_eq!(row.agent_id.as_deref(), Some("agent-support"));
    assert!(
        !row.api_key.contains(MASTER),
        "the raw master key is never returned"
    );

    // Blank summary and actor fields collapse to None; the actor then defaults.
    post(
        &state,
        loopback(),
        bearer(MASTER),
        ControlAuditBody {
            summary: Some("   ".to_owned()),
            actor_id: Some("  ".to_owned()),
            actor_name: Some("".to_owned()),
            agent_id: Some(" ".to_owned()),
            ..body("budget.update", "wallet")
        },
    )
    .await
    .expect("blank optional fields are accepted");
    let rows = wait_for_control_rows(&state, 2).await;
    let row = rows
        .iter()
        .find(|row| row.model == "wallet")
        .expect("second control row");
    assert_eq!(row.command.as_deref(), Some("budget.update"));
    assert_eq!(row.user_name.as_deref(), Some("master-key"));
    assert_eq!(row.user_id, None);
    assert_eq!(row.agent_id, None);
}

#[tokio::test]
async fn control_audit_defaults_a_non_master_local_admin_to_loopback_admin() {
    let (state, _db) = state_for(unlocked_local_config());

    post(
        &state,
        loopback(),
        HeaderMap::new(),
        body("tool.toggle", "shell"),
    )
    .await
    .expect("an unlocked local gateway admits its loopback admin");
    let rows = wait_for_control_rows(&state, 1).await;
    assert_eq!(rows[0].user_name.as_deref(), Some("loopback-admin"));
    assert_eq!(rows[0].model, "shell");
}
