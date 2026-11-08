//! Shared fixtures for the audit endpoint tests: a trusted-forwarder key, a
//! plain key, a state builder with an isolated SQLite audit store, and request
//! extractors.

use crate::audit::{AuditLogger, AuditQuery};
use crate::config::{ApiKeyConfig, AuditConfig, AuthConfig, EvalsConfig, GatewayConfig};
use crate::evals::EvalsRunner;
use crate::state::{AppState, SharedState};
use axum::extract::ConnectInfo;
use axum::http::HeaderMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

pub(super) fn unique_db_path() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::SeqCst);
    let pid = std::process::id();
    std::env::temp_dir()
        .join(format!("ryu-gw-audit-test-{pid}-{n}.db"))
        .to_string_lossy()
        .to_string()
}

/// A trusted-forwarder key ("Core"), plus a plain untrusted key.
pub(super) fn trusted_key() -> ApiKeyConfig {
    ApiKeyConfig {
        key: "sk-core".to_string(),
        name: "core".to_string(),
        org_id: None,
        team_id: None,
        channel_id: None,
        project_id: None,
        requests_per_minute: None,
        tokens_per_minute: None,
        token_budget_total: None,
        downgrade_to: None,
        trusted_forwarder: true,
        allowed_operations: vec![crate::config::ApiKeyOperation::Inference],
    }
}

pub(super) fn plain_key() -> ApiKeyConfig {
    ApiKeyConfig {
        key: "sk-plain".to_string(),
        name: "plain".to_string(),
        trusted_forwarder: false,
        ..trusted_key()
    }
}

pub(super) fn state_with(audit_enabled: bool) -> SharedState {
    state_with_credits(audit_enabled, false)
}

pub(super) fn state_with_credits(audit_enabled: bool, managed_credits: bool) -> SharedState {
    let db_path = if audit_enabled {
        unique_db_path()
    } else {
        String::new()
    };
    let audit = AuditLogger::new(&AuditConfig {
        enabled: audit_enabled,
        db_path,
    })
    .expect("audit logger");
    let mut config = GatewayConfig {
        auth: AuthConfig {
            require_auth: true,
            master_key: Some("sk-master".to_string()),
            api_keys: vec![trusted_key(), plain_key()],
        },
        ..GatewayConfig::default()
    };
    if managed_credits {
        config.credits.enabled = true;
        config.credits.internal_secret = Some("test-internal-secret".to_string());
    }
    Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ))
}

pub(super) fn bearer(key: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    h.insert("authorization", format!("Bearer {key}").parse().unwrap());
    h
}

pub(super) fn loopback() -> ConnectInfo<SocketAddr> {
    ConnectInfo("127.0.0.1:1".parse().unwrap())
}

pub(super) async fn wait_for_audit_entries(state: &SharedState, expected: usize) {
    let query = AuditQuery::default();
    for _ in 0..200 {
        let count = state.audit.query(&query).expect("audit query").len();
        if count >= expected {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("audit writer did not persist {expected} entries in time");
}
