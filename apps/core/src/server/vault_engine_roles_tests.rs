//! Role writes need a grant on the issuer or CA they bind, and SSH key IDs
//! are always the caller's identity.

use axum::http::StatusCode;
use serde_json::{json, Value};

use super::*;
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::AuditActor;
use crate::vault::machine::TokenPrincipal;
use crate::vault::policy::{Policy, PolicyRule};

fn operator() -> AuditActor {
    AuditActor::new("user", Some("operator"))
}

/// A machine caller holding exactly `grants` (no baseline).
fn caller(store: &'static PluginSecretStore, grants: &[(&str, &[Capability])]) -> Who {
    let rules = grants
        .iter()
        .map(|(path, capabilities)| PolicyRule {
            path: (*path).into(),
            capabilities: capabilities.to_vec(),
            deny: false,
            ..Default::default()
        })
        .collect();
    Who::Machine {
        store,
        principal: TokenPrincipal {
            accessor: "rva_team".into(),
            identity_id: "mid_team".into(),
            identity_name: "team".into(),
            policies: vec!["team".into()],
            expires_at: i64::MAX,
        },
        policies: vec![Policy {
            name: "team".into(),
            description: String::new(),
            rules,
        }],
    }
}

async fn read(response: Response) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn leaked_store() -> &'static PluginSecretStore {
    Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()))
}

fn pki_role(issuer: &str) -> Value {
    json!({
        "issuer": issuer, "allowedDomains": ["*.svc.local", "api.bank.example"],
        "defaultTtlSecs": 3600, "maxTtlSecs": 7200, "clientFlag": true,
    })
}

const ADMIN_USE: &[Capability] = &[Capability::Admin, Capability::Use];
const USE: &[Capability] = &[Capability::Use];

#[tokio::test]
async fn pki_role_needs_a_grant_on_the_issuer_it_binds() {
    let store = leaked_store();
    store
        .pki_create_root("prod", "Prod Root", 86_400, &operator())
        .await
        .unwrap();
    store
        .pki_create_root("team", "Team Root", 86_400, &operator())
        .await
        .unwrap();

    // A role grant alone cannot bind the role to an issuer.
    let delegate = caller(store, &[("sys/pki/team-*", ADMIN_USE)]);
    let (status, body) = read(pki_put_role_op(&delegate, "team-x", pki_role("prod")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().contains("sys/pki/issuers/prod"), "{body}");
    assert!(store.pki_list_roles().await.unwrap().is_empty());
    assert!(store
        .pki_issue("team-x", "api.bank.example", &[], &[], None, &operator())
        .await
        .is_err());

    // With `use` on the issuer the role is written and issues certificates.
    let granted = caller(
        store,
        &[("sys/pki/team-*", ADMIN_USE), ("sys/pki/issuers/team", USE)],
    );
    let (status, body) = read(pki_put_role_op(&granted, "team-x", pki_role("team")).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(store
        .pki_issue("team-x", "a.svc.local", &[], &[], None, &operator())
        .await
        .is_ok());

    // Re-pointing the role at an issuer without a grant is refused.
    let (status, _) = read(pki_put_role_op(&granted, "team-x", pki_role("prod")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let roles = store.pki_list_roles().await.unwrap();
    assert_eq!(roles.len(), 1);
    assert_eq!(roles[0].issuer, "team");

    // Moving a role off an issuer also needs a grant on the old one.
    let other = caller(
        store,
        &[("sys/pki/team-*", ADMIN_USE), ("sys/pki/issuers/prod", USE)],
    );
    let (status, body) = read(pki_put_role_op(&other, "team-x", pki_role("prod")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().contains("sys/pki/issuers/team"), "{body}");
    assert_eq!(store.pki_list_roles().await.unwrap()[0].issuer, "team");
}

fn ssh_role(ca: &str) -> Value {
    json!({
        "ca": ca, "certType": "user", "allowedPrincipals": ["root", "deploy"],
        "defaultTtlSecs": 600, "maxTtlSecs": 3600,
    })
}

#[tokio::test]
async fn ssh_role_needs_a_grant_on_the_ca_it_binds() {
    let store = leaked_store();
    store.ssh_create_ca("prod-ssh", &operator()).await.unwrap();
    store.ssh_create_ca("team-ssh", &operator()).await.unwrap();

    let delegate = caller(store, &[("sys/ssh/team-*", ADMIN_USE)]);
    let (status, body) =
        read(ssh_put_role_op(&delegate, "team-x", ssh_role("prod-ssh")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(body.to_string().contains("sys/ssh/cas/prod-ssh"), "{body}");
    assert!(store.ssh_list_roles().await.unwrap().is_empty());

    let granted = caller(
        store,
        &[("sys/ssh/team-*", ADMIN_USE), ("sys/ssh/cas/team-ssh", USE)],
    );
    let (status, body) =
        read(ssh_put_role_op(&granted, "team-x", ssh_role("team-ssh")).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = read(ssh_put_role_op(&granted, "team-x", ssh_role("prod-ssh")).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(store.ssh_list_roles().await.unwrap()[0].ca, "team-ssh");
}

fn sign_body(public_key: &str, key_id: Option<&str>) -> SshSignBody {
    serde_json::from_value(json!({
        "publicKey": public_key, "principals": ["deploy"], "keyId": key_id,
    }))
    .unwrap()
}

#[tokio::test]
async fn ssh_key_id_is_the_callers_identity() {
    let store = leaked_store();
    let public_key = store.ssh_create_ca("ops", &operator()).await.unwrap();
    let operator_who = caller(
        store,
        &[("sys/ssh/dev", ADMIN_USE), ("sys/ssh/cas/ops", USE)],
    );
    let (status, body) = read(ssh_put_role_op(&operator_who, "dev", ssh_role("ops")).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let signer = caller(store, &[("sys/ssh/dev", USE)]);
    // A caller-chosen key ID that impersonates someone else is refused.
    let (status, body) =
        read(ssh_sign_op(&signer, "dev", sign_body(&public_key, Some("user:victim"))).await).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(!body.to_string().contains("BEGIN"), "{body}");

    // Without one, the certificate carries the caller's identity.
    let (status, body) =
        read(ssh_sign_op(&signer, "dev", sign_body(&public_key, None)).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["certificate"]["keyId"], "machine:mid_team");
    assert!(body["certificate"]["certificate"]
        .as_str()
        .unwrap()
        .ends_with(" machine:mid_team"));
}
