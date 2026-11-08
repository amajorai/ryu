//! JSON-object values: merge patch under check-and-set, and `subkeys`,
//! which a sealed value refuses (see `json_values.rs`).

use super::tests::{actor, audit_actions, code, coords, request, write};
use super::*;
use crate::plugin_secrets::kv::Environment;

#[tokio::test]
async fn json_values_merge_patch_under_cas_and_expose_subkeys_without_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "DB");
    write(
        &store,
        c.clone(),
        r#"{"user":"app","password":"hunter2","tls":{"ca":"pem"}}"#,
    )
    .await;
    let patched = store
        .patch_value(
            c.clone(),
            &json!({ "password": "rotated", "tls": null, "port": 5432 }),
            Some(1),
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(patched.version, 2);
    let value: Value =
        serde_json::from_str(&store.reveal(&c, None, &actor()).await.unwrap()).unwrap();
    assert_eq!(
        value,
        json!({ "user": "app", "password": "rotated", "port": 5432 })
    );
    let stale = store
        .patch_value(c.clone(), &json!({ "a": 1 }), Some(1), &actor())
        .await
        .unwrap_err();
    assert!(code(&stale).starts_with("vault_conflict"));
    assert!(store
        .patch_value(c.clone(), &json!("x"), None, &actor())
        .await
        .is_err());

    let (version, shape) = store.subkeys(&c, 0, &actor()).await.unwrap();
    assert_eq!(version, 2);
    assert_eq!(
        shape,
        json!({ "user": null, "password": null, "port": null })
    );

    let plain = coords("default", "/", "PLAIN");
    write(&store, plain.clone(), "not-json-hunter3").await;
    let not_object = store.subkeys(&plain, 0, &actor()).await.unwrap_err();
    assert!(code(&not_object).contains("not a JSON object"));
    assert!(!code(&not_object).contains("hunter3"));
    assert!(store
        .patch_value(plain, &json!({ "a": 1 }), None, &actor())
        .await
        .is_err());

    let (actions, serialized) = audit_actions(&store).await;
    assert!(actions.iter().any(|action| action == "secret.subkeys"));
    assert!(!serialized.contains("rotated") && !serialized.contains("hunter"));
}

#[tokio::test]
async fn subkeys_refuse_a_sealed_value_without_naming_its_keys() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "SIGNING");
    store
        .write_secret(request(
            c.clone(),
            Some(r#"{"privateKeyPem":"hunter2","kid":"k1"}"#),
            SecretMetadataPatch {
                value_type: Some(crate::plugin_secrets::kv::ValueType::Sealed),
                ..SecretMetadataPatch::default()
            },
            &actor(),
            None,
        ))
        .await
        .unwrap();
    let refused = store.subkeys(&c, 0, &actor()).await.unwrap_err();
    assert!(
        code(&refused).starts_with("vault_denied"),
        "{}",
        code(&refused)
    );
    assert!(!code(&refused).contains("privateKeyPem") && !code(&refused).contains("kid"));
    let (_, serialized) = audit_actions(&store).await;
    let rows: Vec<Value> = serde_json::from_str(&serialized).unwrap();
    let subkeys: Vec<&Value> = rows
        .iter()
        .filter(|row| row["action"] == "secret.subkeys")
        .collect();
    assert_eq!(subkeys.len(), 1, "{serialized}");
    assert_eq!(subkeys[0]["outcome"], "denied");
    assert_eq!(subkeys[0]["details"]["reason"], "sealed");
    assert!(!serialized.contains("privateKeyPem") && !serialized.contains("hunter2"));
}

#[tokio::test]
async fn value_patch_honors_cas_required_on_the_value_and_environment() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "DB");
    store
        .write_secret(request(
            c.clone(),
            Some(r#"{"user":"app"}"#),
            SecretMetadataPatch {
                cas_required: Some(true),
                ..Default::default()
            },
            &actor(),
            None,
        ))
        .await
        .unwrap();
    let unguarded = store
        .patch_value(c.clone(), &json!({ "user": "x" }), None, &actor())
        .await
        .unwrap_err();
    assert!(code(&unguarded).contains("check-and-set"), "{unguarded:#}");
    let guarded = store
        .patch_value(c.clone(), &json!({ "user": "x" }), Some(1), &actor())
        .await
        .unwrap();
    assert_eq!(guarded.version, 2);

    store
        .put_environment(
            &Environment {
                slug: "prod".into(),
                name: "Production".into(),
                protected: false,
                required_approvals: 1,
                position: 1,
                cas_required: true,
            },
            &actor(),
        )
        .await
        .unwrap();
    let p = coords("prod", "/", "DB");
    store
        .write_secret(request(
            p.clone(),
            Some(r#"{"user":"app"}"#),
            SecretMetadataPatch::default(),
            &actor(),
            Some(0),
        ))
        .await
        .unwrap();
    let unguarded = store
        .patch_value(p.clone(), &json!({ "user": "x" }), None, &actor())
        .await
        .unwrap_err();
    assert!(code(&unguarded).contains("check-and-set"), "{unguarded:#}");
    assert_eq!(
        store
            .patch_value(p, &json!({ "user": "x" }), Some(1), &actor())
            .await
            .unwrap()
            .version,
        2
    );
}
