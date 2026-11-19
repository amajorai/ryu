//! `PUT /api/vault/dynamic/roles/{name}`: only a configuration manager may
//! send `rebindRetryLeases`; a token or delegated admin gets 403.

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::machine::TokenPrincipal;
use crate::vault::policy::{Policy, PolicyRule};

/// A policy granting `admin` on `sys/dynamic/<role>`.
fn admin_policy(role: &str) -> Vec<Policy> {
    vec![Policy {
        name: "ops".into(),
        description: String::new(),
        rules: vec![PolicyRule {
            path: format!("sys/dynamic/{role}"),
            capabilities: vec![Capability::Admin],
            deny: false,
            ..Default::default()
        }],
    }]
}

/// A machine token holding `admin` on `sys/dynamic/<role>`.
fn token_admin(store: &'static PluginSecretStore, role: &str) -> Who {
    Who::Machine {
        store,
        principal: TokenPrincipal {
            accessor: "rva_ops".into(),
            identity_id: "mid_ops".into(),
            identity_name: "ops".into(),
            policies: vec!["ops".into()],
            expires_at: i64::MAX,
        },
        policies: admin_policy(role),
    }
}

fn body(rebind: bool) -> DynamicRoleBody {
    serde_json::from_value(json!({
        "provider": {
            "kind": "webhook",
            "url": "https://hooks.example.com/hook",
            "signingSecret": "webhook-signing-secret-0001"
        },
        "defaultTtlSecs": 600,
        "maxTtlSecs": 600,
        "rebindRetryLeases": rebind,
    }))
    .unwrap()
}

async fn status_of(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

fn leaked_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

/// Refused with the flag, allowed without it (so the flag is the reason).
async fn assert_flag_forbidden(who: &Who, store: &PluginSecretStore) {
    let (status, response) = status_of(dynamic_put_role_op(who, "ops-role", body(true)).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{response}");
    assert!(store.dynamic_list_roles().await.unwrap().is_empty());
    let (status, response) =
        status_of(dynamic_put_role_op(who, "ops-role", body(false)).await).await;
    assert_eq!(status, StatusCode::OK, "{response}");
}

#[tokio::test]
async fn a_delegated_admin_sending_rebind_retry_leases_is_forbidden() {
    let store = leaked_store();
    let member = Ctx::test_member(store, "user-1", admin_policy("ops-role"));
    assert_flag_forbidden(&Who::Human(member), store).await;
}

#[tokio::test]
async fn a_token_sending_rebind_retry_leases_is_forbidden() {
    let store = leaked_store();
    assert_flag_forbidden(&token_admin(store, "ops-role"), store).await;
}
