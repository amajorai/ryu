//! `GET /v1/wallet`: the local-admin gate and the per-org balance contract
//! (unknown is `null`, never `0`; `empty` and `accounting_unavailable` are
//! scoped to the named org).

use super::{get_wallet, WalletQuery};
use crate::audit::AuditLogger;
use crate::config::{ApiKeyConfig, AuditConfig, AuthConfig, EvalsConfig, GatewayConfig};
use crate::error::GatewayError;
use crate::evals::EvalsRunner;
use crate::state::{AppState, SharedState};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::Json;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;

const MASTER: &str = "sk-wallet-master";
const PLAIN: &str = "sk-wallet-plain";

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
    Arc::new(AppState::new_for_test(
        config,
        audit,
        EvalsRunner::new(EvalsConfig::default()),
    ))
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

fn org(org_id: &str) -> Query<WalletQuery> {
    Query(WalletQuery {
        org_id: Some(org_id.to_owned()),
    })
}

fn no_org() -> Query<WalletQuery> {
    Query(WalletQuery { org_id: None })
}

async fn wallet(state: &SharedState, query: Query<WalletQuery>) -> Value {
    let Json(body) = get_wallet(State(Arc::clone(state)), loopback(), bearer(MASTER), query)
        .await
        .expect("master key reads the wallet");
    body
}

#[tokio::test]
async fn wallet_refuses_an_inference_key_and_a_remote_anonymous_peer() {
    let state = locked_state();
    state.wallet.set_org_balance("org-a", 7_000_000);

    let inference_key = get_wallet(
        State(Arc::clone(&state)),
        loopback(),
        bearer(PLAIN),
        org("org-a"),
    )
    .await;
    assert!(
        matches!(inference_key, Err(GatewayError::Unauthorized(_))),
        "an ordinary inference key must not read tenant billing data"
    );

    let open = open_state();
    open.wallet.set_org_balance("org-a", 7_000_000);
    let remote_anon = get_wallet(
        State(Arc::clone(&open)),
        remote(),
        HeaderMap::new(),
        org("org-a"),
    )
    .await;
    assert!(
        matches!(remote_anon, Err(GatewayError::Unauthorized(_))),
        "a network peer must not read the wallet even when base auth is off"
    );

    let local_anon = get_wallet(State(open), loopback(), HeaderMap::new(), org("org-a"))
        .await
        .expect("the unlocked local dev posture is the local admin");
    assert_eq!(local_anon.0["balance_micro_usd"], 7_000_000);

    let body = wallet(&state, org("org-a")).await;
    assert_eq!(body["balance_micro_usd"], 7_000_000);
}

#[tokio::test]
async fn unknown_balance_is_null_not_zero() {
    let state = locked_state();

    let body = wallet(&state, org("org-never-debited")).await;
    assert_eq!(body["org_id"], "org-never-debited");
    assert!(
        body["balance_micro_usd"].is_null(),
        "an org no debit has reported must be unknown, not $0: {body}"
    );
    assert_eq!(body["empty"], false);
    assert_eq!(body["accounting_unavailable"], false);

    let body = wallet(&state, no_org()).await;
    assert!(body["balance_micro_usd"].is_null());
    assert!(body["org_id"].is_null());
    assert!(
        body["empty"].is_null() && body["accounting_unavailable"].is_null(),
        "without an org the per-org verdicts are not reported: {body}"
    );
}

#[tokio::test]
async fn balance_and_flags_are_reported_per_org() {
    let state = locked_state();
    state.wallet.set_org_balance("org-a", 0);
    state.wallet.set_org_balance("org-b", 4_500_000);
    state.wallet.set_org_accounting_unavailable("org-b", true);

    let a = wallet(&state, org("org-a")).await;
    assert_eq!(
        a,
        json!({"org_id":"org-a","balance_micro_usd":0,"empty":true,"accounting_unavailable":false})
    );

    let b = wallet(&state, org("org-b")).await;
    assert_eq!(
        b,
        json!({"org_id":"org-b","balance_micro_usd":4_500_000,"empty":false,"accounting_unavailable":true})
    );

    // Two orgs cached and none named: refuse to guess a wallet.
    let ambiguous = wallet(&state, no_org()).await;
    assert!(ambiguous["balance_micro_usd"].is_null(), "{ambiguous}");
}

#[tokio::test]
async fn a_single_cached_org_answers_without_an_org_id() {
    let state = locked_state();
    state.wallet.set_org_balance("org-only", 1_250_000);

    let body = wallet(&state, no_org()).await;
    assert_eq!(body["balance_micro_usd"], 1_250_000);
}
