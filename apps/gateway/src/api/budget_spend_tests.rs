//! `GET /v1/budget/spend`: the local-admin gate (an inference key and a remote
//! anonymous peer are refused) and the master-key projection — per-scope
//! filters plus the configured `limits` in micro-USD.

use super::{get_spend, SpendQuery};
use crate::audit::AuditLogger;
use crate::config::{
    ApiKeyConfig, AuditConfig, AuthConfig, BudgetConfig, EvalsConfig, GatewayConfig,
};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::state::{AppState, SharedState};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;

const MASTER: &str = "sk-spend-master";
const PLAIN: &str = "sk-spend-plain";

fn plain_key() -> ApiKeyConfig {
    ApiKeyConfig {
        key: PLAIN.to_owned(),
        name: "plain".to_owned(),
        org_id: Some("org-a".to_owned()),
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

fn budget_rules() -> BudgetConfig {
    serde_json::from_value(json!({
        "users": {
            "u1": { "limit": 5_000_000 },
            "u2": { "limit": 2_000_000 }
        },
        "agents": {
            "a1": { "limit": 3_000_000 },
            "a2": { "limit": 0 }
        },
        "session": { "limit": 750_000 }
    }))
    .expect("budget rules")
}

fn state_with(auth: AuthConfig) -> SharedState {
    let audit = AuditLogger::new(&AuditConfig {
        enabled: false,
        db_path: String::new(),
    })
    .expect("audit logger");
    let config = GatewayConfig {
        auth,
        ..GatewayConfig::default()
    };
    let state = Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ));
    state.update_budget_config(budget_rules());
    state.with_budget(|b| {
        b.record(Some("u1"), Some("a1"), 1_200_000);
        b.record(Some("u2"), Some("a2"), 300_000);
        b.record_session(Some("s1"), 400_000);
        b.record_session(Some("s2"), 90_000);
    });
    state
}

/// A deployed node: base auth on, a master key and one ordinary inference key.
fn locked_state() -> SharedState {
    state_with(AuthConfig {
        require_auth: true,
        master_key: Some(MASTER.to_owned()),
        api_keys: vec![plain_key()],
    })
}

/// The zero-config dev posture: no auth, no master key.
fn open_state() -> SharedState {
    state_with(AuthConfig {
        require_auth: false,
        master_key: None,
        api_keys: Vec::new(),
    })
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("authorization", format!("Bearer {key}").parse().unwrap());
    headers
}

fn loopback() -> ConnectInfo<SocketAddr> {
    ConnectInfo("127.0.0.1:4242".parse().unwrap())
}

fn remote() -> ConnectInfo<SocketAddr> {
    ConnectInfo("203.0.113.9:443".parse().unwrap())
}

fn all() -> Query<SpendQuery> {
    Query(SpendQuery::default())
}

async fn spend(state: &SharedState, query: Query<SpendQuery>) -> Value {
    let Json(body) = get_spend(State(Arc::clone(state)), loopback(), bearer(MASTER), query)
        .await
        .expect("master key reads budget spend");
    body
}

fn unauthorized_message(result: Result<Json<Value>, GatewayError>) -> String {
    match result {
        Err(GatewayError::Unauthorized(message)) => message,
        Err(other) => panic!("expected Unauthorized, got {other:?}"),
        Ok(Json(body)) => panic!("expected Unauthorized, got a spend body: {body}"),
    }
}

#[tokio::test]
async fn spend_refuses_an_inference_key_and_a_remote_anonymous_peer() {
    let state = locked_state();
    let inference_key =
        get_spend(State(Arc::clone(&state)), loopback(), bearer(PLAIN), all()).await;
    let message = unauthorized_message(inference_key);
    assert!(
        message.contains("Budget spend access requires the master key"),
        "{message}"
    );

    let anonymous_on_locked = get_spend(
        State(Arc::clone(&state)),
        loopback(),
        HeaderMap::new(),
        all(),
    )
    .await;
    assert!(
        matches!(anonymous_on_locked, Err(GatewayError::Unauthorized(_))),
        "a locked gateway must not serve spend without a key"
    );

    let open = open_state();
    let remote_anon = get_spend(State(Arc::clone(&open)), remote(), HeaderMap::new(), all()).await;
    let message = unauthorized_message(remote_anon);
    assert!(
        message.contains("Budget spend access requires the master key"),
        "{message}"
    );

    let Json(local_anon) = get_spend(State(open), loopback(), HeaderMap::new(), all())
        .await
        .expect("the unlocked local dev posture is the local admin");
    assert_eq!(local_anon["users"]["u1"], 1_200_000);
}

#[tokio::test]
async fn master_key_reads_full_spend_and_configured_limits() {
    let state = locked_state();
    let body = spend(&state, all()).await;
    assert_eq!(
        body,
        json!({
            "users": { "u1": 1_200_000, "u2": 300_000 },
            "agents": { "a1": 1_200_000, "a2": 300_000 },
            "sessions": { "s1": 400_000, "s2": 90_000 },
            "currency": "USD",
            "unit": "micro_usd",
            "limits": {
                "users": { "u1": 5_000_000, "u2": 2_000_000 },
                "agents": { "a1": 3_000_000, "a2": 0 },
                "session": 750_000
            }
        })
    );
}

#[tokio::test]
async fn query_filters_narrow_each_scope_independently() {
    let state = locked_state();
    let body = spend(
        &state,
        Query(SpendQuery {
            user_id: Some("u2".to_owned()),
            agent_id: Some("a1".to_owned()),
            session_id: Some("s2".to_owned()),
        }),
    )
    .await;
    assert_eq!(body["users"], json!({ "u2": 300_000 }));
    assert_eq!(body["agents"], json!({ "a1": 1_200_000 }));
    assert_eq!(body["sessions"], json!({ "s2": 90_000 }));
    // Filters narrow spend, never the configured limits.
    assert_eq!(
        body["limits"]["users"],
        json!({ "u1": 5_000_000, "u2": 2_000_000 })
    );

    let only_user = spend(
        &state,
        Query(SpendQuery {
            user_id: Some("u-unknown".to_owned()),
            ..SpendQuery::default()
        }),
    )
    .await;
    assert_eq!(only_user["users"], json!({}));
    assert_eq!(
        only_user["agents"],
        json!({ "a1": 1_200_000, "a2": 300_000 })
    );
    assert_eq!(
        only_user["sessions"],
        json!({ "s1": 400_000, "s2": 90_000 })
    );
}

#[tokio::test]
async fn limits_follow_a_live_budget_config_update() {
    let state = locked_state();
    let mut rules = budget_rules();
    rules.users.get_mut("u1").expect("u1 rule").limit = 9_000_000;
    rules.session.limit = 0;
    state.update_budget_config(rules);

    let body = spend(&state, all()).await;
    assert_eq!(body["limits"]["users"]["u1"], 9_000_000);
    assert_eq!(body["limits"]["session"], 0);
}
