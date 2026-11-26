//! Tests for `POST /api/vault/sys/leases/force-revoke/{id}`. Only a
//! configuration manager who acknowledges that the credential may still be
//! live may mark a retry lease revoked; a delegated admin or a token gets 403
//! even with the acknowledgement, and a handed-out lease is refused.

use serde_json::{json, Value};

use super::*;
use crate::server::vault_api::Ctx;
use crate::vault::leases::NewLease;
use crate::vault::machine::TokenPrincipal;
use crate::vault::policy::{Policy, PolicyRule};

/// A policy granting `admin` on `sys/dynamic/fr`.
fn admin_policy() -> Vec<Policy> {
    vec![Policy {
        name: "ops".into(),
        description: String::new(),
        rules: vec![PolicyRule {
            path: "sys/dynamic/fr".into(),
            capabilities: vec![Capability::Admin],
            deny: false,
            ..Default::default()
        }],
    }]
}

fn leaked_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

fn manager(store: &'static PluginSecretStore) -> Who {
    let mut ctx = Ctx::test_member(store, "u-admin", Vec::new());
    ctx.manager = true;
    Who::Human(ctx)
}

fn delegate(store: &'static PluginSecretStore) -> Who {
    Who::Human(Ctx::test_member(store, "u-delegate", admin_policy()))
}

fn token(store: &'static PluginSecretStore) -> Who {
    Who::Machine {
        store,
        principal: TokenPrincipal {
            accessor: "rva_ops".into(),
            identity_id: "mid_ops".into(),
            identity_name: "ops".into(),
            policies: vec!["ops".into()],
            expires_at: i64::MAX,
        },
        policies: admin_policy(),
    }
}

fn lease_input() -> NewLease<'static> {
    static REVOKE_DATA: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    NewLease {
        role: "fr",
        provider: "random",
        issued_to: Some("user:u-issuer"),
        ttl_secs: 600,
        max_ttl_secs: 600,
        renewable: false,
        revoke_data: REVOKE_DATA.get_or_init(|| json!({})),
    }
}

/// A retry lease on role `fr` (no role row is needed to force-revoke it).
async fn retry_lease(store: &PluginSecretStore) -> String {
    store
        .lease_record_for_revoke(lease_input(), None)
        .await
        .unwrap()
}

fn acknowledged(value: bool) -> ForceRevokeBody {
    serde_json::from_value(json!({ "acknowledgeCredentialMayBeLive": value })).unwrap()
}

async fn status_of(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn is_open(store: &PluginSecretStore, id: &str) -> bool {
    store.lease_get(id).await.unwrap().revoked_at.is_none()
}

/// Refused with 403 although the acknowledgement is sent.
async fn assert_forbidden(who: &Who, store: &PluginSecretStore, id: &str) {
    let (status, response) = status_of(force_revoke_op(who, id, acknowledged(true)).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{response}");
    assert!(
        response
            .to_string()
            .contains("only a configuration manager"),
        "{response}"
    );
    assert!(is_open(store, id).await);
}

#[tokio::test]
async fn a_delegated_admin_is_forbidden() {
    let store = leaked_store();
    let id = retry_lease(store).await;
    assert_forbidden(&delegate(store), store, &id).await;
}

#[tokio::test]
async fn a_token_is_forbidden() {
    let store = leaked_store();
    let id = retry_lease(store).await;
    assert_forbidden(&token(store), store, &id).await;
}

#[tokio::test]
async fn a_manager_must_acknowledge_that_the_credential_may_be_live() {
    let store = leaked_store();
    let id = retry_lease(store).await;
    let who = manager(store);
    let missing: ForceRevokeBody = serde_json::from_value(json!({})).unwrap();
    for body in [missing, acknowledged(false)] {
        let (status, response) = status_of(force_revoke_op(&who, &id, body).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert!(
            response
                .to_string()
                .contains("revokes nothing at the provider"),
            "{response}"
        );
        assert!(is_open(store, &id).await);
    }
    let (status, response) = status_of(force_revoke_op(&who, &id, acknowledged(true)).await).await;
    assert_eq!(status, StatusCode::OK, "{response}");
    assert_eq!(response["lease"]["id"], id.as_str());
    assert_eq!(response["lease"]["pendingRevoke"], true);
    assert!(!response["lease"]["revokedAt"].is_null(), "{response}");
    assert!(!is_open(store, &id).await);
}

#[tokio::test]
async fn a_handed_out_lease_is_refused_for_a_manager() {
    let store = leaked_store();
    let lease = store
        .lease_create(lease_input(), &crate::vault::audit::AuditActor::system())
        .await
        .unwrap();
    let (status, response) =
        status_of(force_revoke_op(&manager(store), &lease.id, acknowledged(true)).await).await;
    assert_eq!(status, StatusCode::CONFLICT, "{response}");
    assert!(is_open(store, &lease.id).await);
}
