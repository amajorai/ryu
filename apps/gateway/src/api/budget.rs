//! Budget spend read surface.
//!
//! `GET /v1/budget/spend` exposes the live in-memory per-user / per-agent /
//! per-session token spend the budget stage already tracks
//! ([`crate::budget::BudgetBackend::spend_snapshot`]). The counters existed but
//! had no HTTP read surface, so the desktop could not show spend (P2 #1).
//!
//! Auth: the SAME admin gate as `GET /v1/config` and `GET /v1/audit`
//! ([`crate::api::config::require_local_admin`]) — per-identity spend is
//! tenant-scoped and sensitive, unlike the ungated aggregate `/metrics`. The
//! master key always passes; otherwise only a loopback peer under the
//! zero-config dev posture (the Core-proxy path).
//!
//! NOTE: there is no per-org spend *number* to expose here — org budgets are a
//! control-plane wallet whose only local state is a "wallet empty" boolean
//! (`WalletState`), not a running total. The three token-counter scopes the
//! built-in enforcer keeps (users / agents / sessions) are what this returns.

use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    error::GatewayError,
    pipeline::{authenticate, AuthInputs},
    state::SharedState,
};

/// Optional scope filters for `GET /v1/budget/spend`. Each narrows the snapshot
/// to a single id in that scope (the desktop showing one session's / user's /
/// agent's spend). Absent ⇒ the full snapshot for that scope.
#[derive(Debug, Default, Deserialize)]
pub struct SpendQuery {
    pub user_id: Option<String>,
    pub agent_id: Option<String>,
    pub session_id: Option<String>,
}

/// Retain only `key` in `map` (single-id filter), or leave it untouched when no
/// filter was requested for that scope.
fn filter_scope(
    map: std::collections::HashMap<String, u64>,
    key: &Option<String>,
) -> std::collections::HashMap<String, u64> {
    match key {
        Some(id) => map
            .into_iter()
            .filter(|(k, _)| k == id)
            .collect(),
        None => map,
    }
}

/// `GET /v1/budget/spend` — live per-scope token spend.
///
/// Returns `{ users, agents, sessions }` maps of id → lifetime tokens
/// (input + output), plus the configured limits so the desktop can render
/// spend-vs-limit without a second `/v1/config` round-trip. In-memory only: a
/// gateway restart resets the counters.
pub async fn get_spend(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(q): Query<SpendQuery>,
) -> Result<Json<Value>, GatewayError> {
    let raw_key = headers.get("authorization").and_then(|v| v.to_str().ok());
    let ctx = authenticate(&state, AuthInputs::with_key(raw_key)).await?;
    crate::api::config::require_local_admin(&state, &peer, ctx.is_master_key, "Budget spend access")?;

    let snapshot = state.with_budget(|b| b.spend_snapshot());
    let config = state.with_budget(|b| b.config().clone());

    Ok(Json(json!({
        "users": filter_scope(snapshot.users, &q.user_id),
        "agents": filter_scope(snapshot.agents, &q.agent_id),
        "sessions": filter_scope(snapshot.sessions, &q.session_id),
        // Configured caps so a caller can compute spend / limit inline. The
        // per-user / per-agent limits are keyed by id (0 = unlimited); the
        // session cap is a single global rule (0 = disabled).
        "limits": {
            "users": config.users.iter().map(|(k, r)| (k.clone(), r.limit)).collect::<std::collections::HashMap<_, _>>(),
            "agents": config.agents.iter().map(|(k, r)| (k.clone(), r.limit)).collect::<std::collections::HashMap<_, _>>(),
            "session": config.session.limit,
        },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn filter_scope_narrows_to_single_id() {
        let mut m = HashMap::new();
        m.insert("a".to_string(), 10u64);
        m.insert("b".to_string(), 20u64);
        // No filter ⇒ full map.
        let full = filter_scope(m.clone(), &None);
        assert_eq!(full.len(), 2);
        // Filter ⇒ only the requested id.
        let one = filter_scope(m, &Some("a".to_string()));
        assert_eq!(one.len(), 1);
        assert_eq!(one.get("a"), Some(&10));
    }

    #[test]
    fn filter_scope_missing_id_is_empty() {
        let mut m = HashMap::new();
        m.insert("a".to_string(), 10u64);
        let none = filter_scope(m, &Some("zzz".to_string()));
        assert!(none.is_empty());
    }
}
