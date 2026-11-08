//! Tests for environments, policies, bindings, transit keys, and audit devices.

use std::path::Path;

use serde_json::json;

use super::*;
use crate::vault::audit::AuditFilter;
use crate::vault::audit_devices;

fn spec_text(dir: &Path, reconcile: bool, protected: bool) -> String {
    audit_devices::allow_audit_dir_for_test(dir);
    json!({
        "reconcile": reconcile,
        "environments": [{ "slug": "prod", "name": "Production", "protected": protected }],
        "policies": [{ "name": "ci", "rules": [{ "path": "prod/*", "capabilities": ["use"] }] }],
        "bindings": [{ "policy": "ci", "subject": "machine:mi_ci" }],
        "transitKeys": [{ "name": "payments" }],
        "auditDevices": [{
            "id": "file", "kind": "file",
            "options": { "path": dir.join("audit.jsonl").to_string_lossy() }
        }],
    })
    .to_string()
}

#[tokio::test]
async fn applying_twice_is_idempotent_and_audited_as_bootstrap() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    let spec = parse(&spec_text(dir.path(), false, true)).unwrap();
    let first = apply(&store, &spec).await.unwrap();
    assert!(first.errors.is_empty(), "{first:?}");
    assert_eq!(first.created.len(), 5, "{first:?}");
    let second = apply(&store, &spec).await.unwrap();
    assert!(
        second.created.is_empty() && second.drifted.is_empty(),
        "{second:?}"
    );
    assert_eq!(second.unchanged, 5);

    let conn = store.conn.lock().await;
    assert_eq!(audit_devices::list(&conn).unwrap()[0].source, "declarative");
    let rows = crate::vault::audit::list(
        &conn,
        &AuditFilter {
            limit: 50,
            action: Some("bootstrap.apply".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].actor.id.as_deref(), Some("bootstrap"));
    drop(conn);
    // The declared file device now receives every audit row.
    let written = std::fs::read_to_string(dir.path().join("audit.jsonl")).unwrap();
    assert!(written.contains("\"action\":\"bootstrap.apply\""));
}

#[tokio::test]
async fn drift_is_reported_unless_reconcile_is_set() {
    let dir = tempfile::tempdir().unwrap();
    let store = PluginSecretStore::in_memory().unwrap();
    apply(&store, &parse(&spec_text(dir.path(), false, true)).unwrap())
        .await
        .unwrap();
    let drifted = apply(
        &store,
        &parse(&spec_text(dir.path(), false, false)).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(drifted.drifted, vec!["environment:prod".to_owned()]);
    let prod = |envs: Vec<Environment>| envs.into_iter().find(|e| e.slug == "prod").unwrap();
    assert!(prod(store.list_environments().await.unwrap()).protected);

    let reconciled = apply(&store, &parse(&spec_text(dir.path(), true, false)).unwrap())
        .await
        .unwrap();
    assert_eq!(reconciled.updated, vec!["environment:prod".to_owned()]);
    assert!(!prod(store.list_environments().await.unwrap()).protected);
}

fn protected_spec_text(reconcile: bool) -> String {
    json!({
        "reconcile": reconcile,
        "environments": [{ "slug": "prod", "name": "Production", "casRequired": true }],
        "policies": [{ "name": "prod-read", "rules": [
            {
                "path": "prod/*",
                "capabilities": ["read", "write"],
                "allowedParameters": { "*": ["*"] },
                "deniedParameters": { "owner": ["root"] },
                "requiredParameters": ["ticket"],
                "controlGroup": {
                    "ttlSecs": 3600,
                    "factors": [{ "name": "leads", "approvers": ["role:lead"], "approvals": 1 }]
                }
            }
        ] }],
    })
    .to_string()
}

#[tokio::test]
async fn reconcile_keeps_declared_cas_and_control_groups() {
    let store = PluginSecretStore::in_memory().unwrap();
    let spec = parse(&protected_spec_text(true)).unwrap();
    assert!(spec.environments[0].cas_required);
    let rule = &spec.policies[0].rules[0];
    assert!(rule.control_group.is_some());
    assert!(rule.allowed_parameters.is_some() && rule.denied_parameters.is_some());
    assert_eq!(rule.required_parameters, vec!["ticket".to_owned()]);

    let first = apply(&store, &spec).await.unwrap();
    assert!(first.errors.is_empty(), "{first:?}");
    let second = apply(&store, &spec).await.unwrap();
    assert!(
        second.created.is_empty() && second.updated.is_empty() && second.drifted.is_empty(),
        "{second:?}"
    );
    assert_eq!(second.unchanged, 2);
    let prod = store
        .list_environments()
        .await
        .unwrap()
        .into_iter()
        .find(|env| env.slug == "prod")
        .unwrap();
    assert!(prod.cas_required);
}

#[test]
fn inline_secrets_and_unknown_fields_are_rejected() {
    let inline = json!({
        "auditDevices": [{
            "id": "siem", "kind": "http",
            "options": { "url": "https://siem.example", "secret": "sixteen-chars-long!" }
        }]
    });
    assert!(parse(&inline.to_string()).is_err());
    assert!(parse(r#"{"secrets": [{"name": "X", "value": "y"}]}"#).is_err());
    let referenced = json!({
        "auditDevices": [{
            "id": "siem", "kind": "http",
            "options": { "url": "https://siem.example", "secretRef": "env:SIEM_SIGNING_KEY" }
        }]
    });
    assert!(parse(&referenced.to_string()).is_ok());
    for nested in [
        json!({ "environments": [{ "slug": "prod", "name": "P", "value": "s3cr3t" }] }),
        json!({ "environments": [{ "slug": "prod", "name": "P", "requiredApproval": 2 }] }),
        json!({ "policies": [{ "name": "ci", "rules": [
            { "path": "prod/*", "capabilities": ["use"], "value": "x" }
        ] }] }),
        json!({ "policies": [{ "name": "ci", "rules": [{
            "path": "prod/*", "capabilities": ["read"],
            "controlGroup": { "factors": [{ "name": "a", "approvers": ["role:lead"] }], "x": 1 }
        }] }] }),
        json!({ "policies": [{ "name": "ci", "rules": [{
            "path": "prod/*", "capabilities": ["read"],
            "controlGroup": { "factors": [{ "name": "a", "approvers": ["role:lead"], "x": 1 }] }
        }] }] }),
        json!({ "bindings": [{ "policy": "ci", "subject": "machine:mi_ci", "x": 1 }] }),
        json!({ "transitKeys": [{ "name": "payments", "material": "abc" }] }),
        json!({ "auditDevices": [{
            "id": "siem", "kind": "http",
            "options": { "url": "https://siem.example", "token": "abc" }
        }] }),
        json!({ "auditDevices": [{
            "id": "siem", "kind": "http",
            "options": { "url": "https://user:pass@siem.example" }
        }] }),
    ] {
        assert!(parse(&nested.to_string()).is_err(), "{nested}");
    }
}
