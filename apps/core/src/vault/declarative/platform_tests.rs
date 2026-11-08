//! Tests for token roles, quotas, machines, folders, imports, dynamic and
//! static roles, and broker services.

use serde_json::{json, Value};

use super::*;
use crate::vault::audit::AuditFilter;

const WEBHOOK_SECRET: &str = "declared-webhook-signing-secret-0001";

fn platform_spec(reconcile: bool, secret_env: &str, position: i64) -> Value {
    json!({
        "reconcile": reconcile,
        "tokenRoles": [{
            "name": "deploy", "allowedPolicies": ["ci"], "ttlSecs": 900,
            "boundCidrs": ["10.0.0.0/8"]
        }],
        "quotas": [
            { "name": "agent-rate", "kind": "rate-limit", "path": "agent/", "rate": 120 },
            { "name": "db-leases", "kind": "lease-count", "role": "*", "maxLeases": 10 }
        ],
        "machines": [
            { "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"],
              "tokenConfig": { "numUses": 5 } },
            { "name": "gha", "auth": {
                "kind": "jwt", "issuer": "https://token.actions.githubusercontent.com",
                "jwksUrl": "https://token.actions.githubusercontent.com/.well-known/jwks",
                "audiences": ["ryu"]
            } }
        ],
        "folders": [{ "environment": "default", "path": "payments/" }],
        "imports": [{
            "environment": "default", "path": "/payments",
            "sourceEnvironment": "default", "sourcePath": "/shared", "position": position
        }],
        "dynamicRoles": [
            { "name": "tokens", "provider": { "kind": "random", "length": 24, "charset": "alphanumeric" } },
            {
                "name": "hooked",
                "provider": { "kind": "webhook", "url": "https://issuer.example/hook" },
                "secretRefs": { "signingSecret": format!("env:{secret_env}") },
                "defaultTtlSecs": 600
            }
        ],
        "staticRoles": [{
            "name": "svc",
            "provider": { "kind": "webhook", "url": "https://rotate.example/hook", "username": "svc" },
            "secretRefs": { "signingSecret": format!("env:{secret_env}") },
            "target": { "name": "SVC_PASSWORD" },
            "rotationPeriodSecs": 3600
        }],
        "brokerServices": [{
            "name": "stripe", "host": "API.Stripe.com",
            "auth": { "type": "bearer", "token": "secret:STRIPE_KEY" }
        }]
    })
}

fn spec(value: &Value) -> InitSpec {
    parse(&value.to_string()).unwrap()
}

#[tokio::test]
async fn platform_sections_apply_idempotently_without_leaking_credentials() {
    let env = "RYU_TEST_DECLARATIVE_IDEMPOTENT_SECRET";
    std::env::set_var(env, WEBHOOK_SECRET);
    let store = PluginSecretStore::in_memory().unwrap();
    let declared = spec(&platform_spec(false, env, 0));

    let first = apply(&store, &declared).await.unwrap();
    assert!(first.errors.is_empty(), "{first:?}");
    assert_eq!(first.created.len(), 11, "{first:?}");
    let second = apply(&store, &declared).await.unwrap();
    assert!(
        second.created.is_empty() && second.updated.is_empty() && second.drifted.is_empty(),
        "{second:?}"
    );
    assert_eq!(second.unchanged, 11);

    let role = store.token_role_get("deploy").await.unwrap();
    assert_eq!(role.token.bound_cidrs, vec!["10.0.0.0/8".to_owned()]);
    let quotas = store.quota_list().await.unwrap();
    assert!(quotas.iter().any(|q| q.name == "agent-rate" && !q.builtin));
    let ci = store.machine_get("ci").await.unwrap();
    assert_eq!(ci.policies, vec!["ci".to_owned()]);
    assert_eq!(ci.token_config.num_uses, Some(5));
    assert!(store
        .list_folders("default")
        .await
        .unwrap()
        .contains(&"/payments".to_owned()));
    assert_eq!(store.list_imports().await.unwrap().len(), 1);
    let dynamic = store.dynamic_list_roles().await.unwrap();
    assert_eq!(dynamic.len(), 2);
    let hooked = dynamic.iter().find(|r| r.name == "hooked").unwrap();
    assert_eq!(hooked.default_ttl_secs, 600);
    let svc = store.static_role("svc").await.unwrap();
    assert_eq!(svc.target.name, "SVC_PASSWORD");
    let service = {
        let conn = store.conn.lock().await;
        crate::vault::broker::services::get(&conn, "stripe")
            .unwrap()
            .unwrap()
    };
    assert_eq!(service.input.host, "api.stripe.com");

    // Neither the report nor any audit row carries the credential.
    assert!(!format!("{first:?}{second:?}").contains(WEBHOOK_SECRET));
    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &AuditFilter {
            limit: 500,
            ..Default::default()
        },
    )
    .unwrap();
    assert!(rows.iter().any(
        |row| row.action == "dynamic.role.put" && row.actor.id.as_deref() == Some("bootstrap")
    ));
    assert!(rows.iter().any(|row| row.action == "folder.create"));
    assert!(!format!("{rows:?}").contains(WEBHOOK_SECRET));
}

#[tokio::test]
async fn a_rotated_credential_is_drift_until_reconciled() {
    let env = "RYU_TEST_DECLARATIVE_ROTATED_SECRET";
    std::env::set_var(env, WEBHOOK_SECRET);
    let store = PluginSecretStore::in_memory().unwrap();
    apply(&store, &spec(&platform_spec(false, env, 0)))
        .await
        .unwrap();

    std::env::set_var(env, "declared-webhook-signing-secret-0002");
    let drifted = apply(&store, &spec(&platform_spec(false, env, 0)))
        .await
        .unwrap();
    assert_eq!(
        drifted.drifted,
        vec!["dynamicRole:hooked".to_owned(), "staticRole:svc".to_owned()]
    );
    let reconciled = apply(&store, &spec(&platform_spec(true, env, 0)))
        .await
        .unwrap();
    assert!(reconciled.errors.is_empty(), "{reconciled:?}");
    assert_eq!(
        reconciled.updated,
        vec!["dynamicRole:hooked".to_owned(), "staticRole:svc".to_owned()]
    );
    let again = apply(&store, &spec(&platform_spec(false, env, 0)))
        .await
        .unwrap();
    assert!(again.drifted.is_empty(), "{again:?}");
}

#[tokio::test]
async fn an_unset_reference_fails_only_its_item() {
    let store = PluginSecretStore::in_memory().unwrap();
    let report = apply(
        &store,
        &spec(&platform_spec(false, "RYU_TEST_DECLARATIVE_NEVER_SET", 0)),
    )
    .await
    .unwrap();
    assert_eq!(report.errors.len(), 2, "{report:?}");
    assert!(report.errors[0].starts_with("dynamicRole:hooked: "));
    assert!(report.errors[0].contains("RYU_TEST_DECLARATIVE_NEVER_SET is not set"));
    assert!(!report.created.contains(&"dynamicRole:hooked".to_owned()));
    assert_eq!(report.created.len(), 9, "{report:?}");
}

#[tokio::test]
async fn machine_auth_drift_is_never_reconciled_but_settings_are() {
    let store = PluginSecretStore::in_memory().unwrap();
    let base = json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci"] }] });
    apply(&store, &spec(&base)).await.unwrap();
    let issued_role_id = store.machine_get("ci").await.unwrap().auth;

    let settings = json!({ "reconcile": true, "machines": [{
        "name": "ci", "auth": { "kind": "approle" }, "policies": ["ci", "deploy"], "disabled": true
    }] });
    let updated = apply(&store, &spec(&settings)).await.unwrap();
    assert_eq!(updated.updated, vec!["machine:ci".to_owned()]);
    let ci = store.machine_get("ci").await.unwrap();
    assert!(ci.disabled);
    assert_eq!(ci.policies.len(), 2);
    assert_eq!(ci.auth, issued_role_id, "the generated role id is kept");

    let auth = json!({ "reconcile": true, "machines": [{ "name": "ci", "auth": {
        "kind": "jwt", "issuer": "https://issuer.example",
        "jwksUrl": "https://issuer.example/jwks", "audiences": ["ryu"]
    } }] });
    let report = apply(&store, &spec(&auth)).await.unwrap();
    assert_eq!(report.drifted, vec!["machine:ci".to_owned()]);
    assert!(report.updated.is_empty());
    assert_eq!(store.machine_get("ci").await.unwrap().auth, issued_role_id);
}

#[tokio::test]
async fn import_position_drift_is_replaced_on_reconcile() {
    let env = "RYU_TEST_DECLARATIVE_IMPORT_SECRET";
    std::env::set_var(env, WEBHOOK_SECRET);
    let store = PluginSecretStore::in_memory().unwrap();
    apply(&store, &spec(&platform_spec(false, env, 0)))
        .await
        .unwrap();
    let drift = apply(&store, &spec(&platform_spec(false, env, 3)))
        .await
        .unwrap();
    assert_eq!(
        drift.drifted,
        vec!["import:default:/payments<-default:/shared".to_owned()]
    );
    apply(&store, &spec(&platform_spec(true, env, 3)))
        .await
        .unwrap();
    let imports = store.list_imports().await.unwrap();
    assert_eq!(imports.len(), 1);
    assert_eq!(imports[0].position, 3);
}

#[test]
fn credentials_must_be_references() {
    let role = |provider: Value, refs: Value| json!({ "dynamicRoles": [{ "name": "r", "provider": provider, "secretRefs": refs }] });
    let webhook = json!({ "kind": "webhook", "url": "https://issuer.example/hook" });
    let rejected = [
        // Inline credential.
        role(
            json!({ "kind": "webhook", "url": "https://issuer.example/hook", "signingSecret": WEBHOOK_SECRET }),
            json!({}),
        ),
        // Missing reference.
        role(webhook.clone(), json!({})),
        // A reference that is not env: or file:.
        role(webhook.clone(), json!({ "signingSecret": WEBHOOK_SECRET })),
        // A reference for a field the provider does not have.
        role(
            webhook.clone(),
            json!({ "signingSecret": "env:A", "url": "env:B" }),
        ),
        // An unknown provider field.
        role(
            json!({ "kind": "webhook", "url": "https://issuer.example/hook", "extra": 1 }),
            json!({ "signingSecret": "env:A" }),
        ),
        // Credentials of AWS are both references.
        role(
            json!({ "kind": "aws-sts", "region": "us-east-1", "roleArn": "arn:aws:iam::1:role/r", "accessKeyId": "AKIA" }),
            json!({ "secretAccessKey": "env:AWS_SECRET" }),
        ),
        json!({ "staticRoles": [{
            "name": "ant", "provider": { "kind": "anthropic" },
            "secretRefs": { "adminApiKey": "env:ADMIN", "replacementApiKey": "env:NEXT" },
            "target": { "name": "ANTHROPIC_API_KEY" }, "rotationPeriodSecs": 86400
        }] }),
        json!({ "staticRoles": [{
            "name": "ant", "provider": { "kind": "anthropic" },
            "secretRefs": { "adminApiKey": "env:ADMIN" },
            "target": { "name": "ANTHROPIC_API_KEY" }, "rotationPeriodSecs": 60
        }] }),
    ];
    for document in rejected {
        let error = parse(&document.to_string()).unwrap_err();
        assert!(!format!("{error:#}").contains(WEBHOOK_SECRET), "{error:#}");
    }
    assert!(parse(
        &role(
            webhook,
            json!({ "signingSecret": "file:/run/secrets/hook" })
        )
        .to_string()
    )
    .is_ok());
}

#[test]
fn unknown_fields_in_platform_sections_are_rejected() {
    for document in [
        json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" }, "secretId": "x" }] }),
        json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle", "roleId": "role_x" } }] }),
        json!({ "machines": [{ "name": "gha", "auth": {
            "kind": "jwt", "issuer": "https://i.example", "jwksUrl": "https://i.example/jwks",
            "audiences": ["ryu"], "clientSecret": "x"
        } }] }),
        json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" },
            "tokenConfig": { "boundCidr": ["10.0.0.0/8"] } }] }),
        json!({ "machines": [{ "name": "ci", "auth": { "kind": "approle" },
            "tokenConfig": { "numUse": 1 } }] }),
        json!({ "tokenRoles": [{ "name": "deploy", "createdAt": 1 }] }),
        json!({ "quotas": [{ "name": "q", "kind": "rate-limit", "rate": 1, "burst": 2 }] }),
        json!({ "quotas": [{ "name": "default-login", "kind": "rate-limit", "rate": 1 }] }),
        json!({ "folders": [{ "environment": "default", "path": "/a", "value": "x" }] }),
        json!({ "folders": [{ "environment": "default", "path": "/../etc" }] }),
        json!({ "imports": [{ "environment": "default", "path": "/a", "sourceEnvironment": "default", "sourcePath": "/a" }] }),
        json!({ "brokerServices": [{
            "name": "stripe", "host": "api.stripe.com",
            "auth": { "type": "bearer", "token": "secret:STRIPE_KEY", "value": "sk_live" }
        }] }),
        json!({ "brokerServices": [{
            "name": "stripe", "host": "api.stripe.com", "apiKey": "sk_live",
            "auth": { "type": "bearer", "token": "secret:STRIPE_KEY" }
        }] }),
        json!({ "staticRoles": [{
            "name": "svc", "provider": { "kind": "webhook", "url": "https://r.example", "username": "svc" },
            "secretRefs": { "signingSecret": "env:A" },
            "target": { "name": "SVC", "scope": "org" }, "rotationPeriodSecs": 3600
        }] }),
    ] {
        assert!(parse(&document.to_string()).is_err(), "{document}");
    }
}
