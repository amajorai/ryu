use super::*;
use crate::plugin_secrets::kv::{Environment, WriteOptions};
use crate::plugin_secrets::SecretScope;

pub(super) fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

pub(super) fn coords(env: &str, path: &str, name: &str) -> SecretCoords {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: "node-1".into(),
        environment: env.into(),
        path: path.into(),
        binding: None,
        name: name.into(),
    }
}

pub(super) fn request<'a>(
    coords: SecretCoords,
    value: Option<&'a str>,
    patch: SecretMetadataPatch,
    actor: &'a AuditActor,
    expected_version: Option<i64>,
) -> WriteRequest<'a> {
    WriteRequest {
        coords,
        value,
        patch,
        actor,
        source: VersionSource::Write,
        expected_version,
    }
}

pub(super) async fn write(
    store: &PluginSecretStore,
    coords: SecretCoords,
    value: &str,
) -> VaultSecretInfo {
    store
        .write_secret(request(
            coords,
            Some(value),
            SecretMetadataPatch::default(),
            &actor(),
            None,
        ))
        .await
        .unwrap()
}

pub(super) fn code(error: &anyhow::Error) -> String {
    error
        .downcast_ref::<VaultError>()
        .map(|error| error.to_string())
        .unwrap_or_else(|| format!("{error:#}"))
}

pub(super) async fn audit_actions(store: &PluginSecretStore) -> (Vec<String>, String) {
    let conn = store.conn.lock().await;
    let rows = crate::vault::audit::list(
        &conn,
        &crate::vault::audit::AuditFilter {
            limit: 100,
            ..Default::default()
        },
    )
    .unwrap();
    (
        rows.iter().map(|row| row.action.clone()).collect(),
        serde_json::to_string(&rows).unwrap(),
    )
}

#[test]
fn merge_patch_follows_rfc_7386() {
    let mut target = json!({ "a": "b", "c": { "d": "e", "f": "g" } });
    merge_patch(&mut target, &json!({ "a": "z", "c": { "f": null } }));
    assert_eq!(target, json!({ "a": "z", "c": { "d": "e" } }));
    let mut scalar = json!("text");
    merge_patch(&mut scalar, &json!({ "a": { "b": null, "c": 1 } }));
    assert_eq!(scalar, json!({ "a": { "c": 1 } }));
    let mut array = json!({ "a": [1, 2] });
    merge_patch(&mut array, &json!({ "a": [3] }));
    assert_eq!(array, json!({ "a": [3] }));
}

#[test]
fn subkeys_replace_leaves_with_null_and_honor_depth() {
    let value = json!({ "user": "x", "db": { "host": "h", "tls": { "ca": "c" } }, "ports": [1] });
    assert_eq!(
        subkeys_of(&value, 0),
        json!({ "user": null, "db": { "host": null, "tls": { "ca": null } }, "ports": null })
    );
    assert_eq!(
        subkeys_of(&value, 1),
        json!({ "user": null, "db": null, "ports": null })
    );
}

#[tokio::test]
async fn custom_metadata_is_validated_and_persisted() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    let mut custom = BTreeMap::new();
    custom.insert("owner".to_owned(), "payments".to_owned());
    let info = store
        .write_secret(request(
            c.clone(),
            Some("v"),
            SecretMetadataPatch {
                custom_metadata: Some(custom.clone()),
                ..Default::default()
            },
            &actor(),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(info.metadata.custom_metadata, custom);
    assert_eq!(info.metadata_version, 1);
    let reread = store.secret_info(&c).await.unwrap().unwrap();
    assert_eq!(reread.metadata.custom_metadata, custom);

    let too_many: BTreeMap<String, String> = (0..65)
        .map(|index| (format!("k{index}"), "v".to_owned()))
        .collect();
    let long_value: BTreeMap<String, String> =
        [("k".to_owned(), "x".repeat(513))].into_iter().collect();
    let long_key: BTreeMap<String, String> =
        [("k".repeat(129), "v".to_owned())].into_iter().collect();
    for bad in [too_many, long_value, long_key] {
        let error = store
            .write_secret(request(
                c.clone(),
                None,
                SecretMetadataPatch {
                    custom_metadata: Some(bad),
                    ..Default::default()
                },
                &actor(),
                None,
            ))
            .await
            .unwrap_err();
        assert!(code(&error).contains("customMetadata"), "{error:#}");
    }
    let bad_after = SecretMetadataPatch {
        delete_version_after_secs: Some(Some(5)),
        ..Default::default()
    };
    assert!(bad_after.apply(&SecretMetadata::default()).is_err());
}

#[tokio::test]
async fn metadata_merge_patch_does_not_write_a_version_and_honors_metadata_cas() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "secret-value").await;
    let patched = store
        .patch_metadata(
            c.clone(),
            &json!({ "customMetadata": { "owner": "ops", "tier": "1" }, "description": " db " }),
            Some(1),
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(patched.version, 1);
    assert_eq!(patched.metadata_version, 2);
    assert_eq!(patched.metadata.description, "db");
    let patched = store
        .patch_metadata(
            c.clone(),
            &json!({ "customMetadata": { "tier": null, "team": "core" } }),
            None,
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(
        patched
            .metadata
            .custom_metadata
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec!["owner".to_owned(), "team".to_owned()]
    );
    assert_eq!(patched.metadata_version, 3);

    // A no-op patch keeps the counter.
    let same = store
        .patch_metadata(c.clone(), &json!({ "description": "db" }), None, &actor())
        .await
        .unwrap();
    assert_eq!(same.metadata_version, 3);

    // Stale metadata CAS, unknown fields, and invalid values are refused.
    let stale = store
        .patch_metadata(c.clone(), &json!({ "description": "x" }), Some(1), &actor())
        .await
        .unwrap_err();
    assert!(code(&stale).starts_with("vault_conflict"), "{stale:#}");
    let unknown = store
        .patch_metadata(c.clone(), &json!({ "nope": 1 }), None, &actor())
        .await
        .unwrap_err();
    assert!(code(&unknown).contains("unknown metadata field"));
    let invalid = store
        .patch_metadata(c.clone(), &json!({ "maxVersions": 0 }), None, &actor())
        .await
        .unwrap_err();
    assert!(code(&invalid).starts_with("vault_invalid"), "{invalid:#}");
    assert!(store
        .patch_metadata(c.clone(), &json!(["x"]), None, &actor())
        .await
        .is_err());
    assert!(store
        .patch_metadata(
            coords("default", "/", "MISSING"),
            &json!({}),
            None,
            &actor()
        )
        .await
        .is_err());

    // The PUT path honors metadata CAS too.
    let stale_put = store
        .write_secret_with(
            request(
                c.clone(),
                None,
                SecretMetadataPatch {
                    description: Some("new".into()),
                    ..Default::default()
                },
                &actor(),
                None,
            ),
            WriteOptions {
                expected_metadata_version: Some(2),
            },
        )
        .await
        .unwrap_err();
    assert!(code(&stale_put).starts_with("vault_conflict"));
    let put = store
        .write_secret_with(
            request(
                c.clone(),
                None,
                SecretMetadataPatch {
                    description: Some("new".into()),
                    ..Default::default()
                },
                &actor(),
                None,
            ),
            WriteOptions {
                expected_metadata_version: Some(3),
            },
        )
        .await
        .unwrap();
    assert_eq!((put.version, put.metadata_version), (1, 4));
    let (actions, serialized) = audit_actions(&store).await;
    assert!(actions.iter().any(|action| action == "secret.metadata"));
    assert!(!serialized.contains("secret-value"));
}

#[tokio::test]
async fn cas_required_rejects_unguarded_value_writes() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    store
        .write_secret(request(
            c.clone(),
            Some("one"),
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
        .write_secret(request(
            c.clone(),
            Some("two"),
            SecretMetadataPatch::default(),
            &actor(),
            None,
        ))
        .await
        .unwrap_err();
    assert!(code(&unguarded).contains("check-and-set"), "{unguarded:#}");
    let guarded = store
        .write_secret(request(
            c.clone(),
            Some("two"),
            SecretMetadataPatch::default(),
            &actor(),
            Some(1),
        ))
        .await
        .unwrap();
    assert_eq!(guarded.version, 2);
    // Metadata-only writes and system sources (rollback) are not value
    // writes by a caller and stay allowed.
    store
        .write_secret(request(
            c.clone(),
            None,
            SecretMetadataPatch {
                description: Some("d".into()),
                ..Default::default()
            },
            &actor(),
            None,
        ))
        .await
        .unwrap();
    assert_eq!(
        store
            .rollback(c.clone(), 1, &actor())
            .await
            .unwrap()
            .version,
        3
    );

    // Environment-level casRequired covers creates as well.
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
    assert!(
        store
            .environment("prod")
            .await
            .unwrap()
            .unwrap()
            .cas_required
    );
    let p = coords("prod", "/", "DB_URL");
    let create = store
        .write_secret(request(
            p.clone(),
            Some("x"),
            SecretMetadataPatch::default(),
            &actor(),
            None,
        ))
        .await
        .unwrap_err();
    assert!(code(&create).contains("check-and-set"));
    let created = store
        .write_secret(request(
            p.clone(),
            Some("x"),
            SecretMetadataPatch::default(),
            &actor(),
            Some(0),
        ))
        .await
        .unwrap();
    assert_eq!(created.version, 1);
    assert!(store
        .write_secret(request(
            p,
            Some("y"),
            SecretMetadataPatch::default(),
            &actor(),
            Some(0),
        ))
        .await
        .is_err());
}

#[tokio::test]
async fn metadata_patch_prunes_versions_and_refuses_deleted_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    for value in ["one", "two", "three", "four"] {
        write(&store, c.clone(), value).await;
    }
    assert_eq!(store.list_versions(&c).await.unwrap().len(), 4);
    store
        .patch_metadata(c.clone(), &json!({ "maxVersions": 2 }), None, &actor())
        .await
        .unwrap();
    let kept: Vec<i64> = store
        .list_versions(&c)
        .await
        .unwrap()
        .iter()
        .map(|version| version.version)
        .collect();
    assert_eq!(kept, vec![4, 3]);
    assert!(store.reveal(&c, Some(1), &actor()).await.is_err());

    store.soft_delete(c.clone(), &actor()).await.unwrap();
    let deleted = store
        .patch_metadata(c.clone(), &json!({ "description": "x" }), None, &actor())
        .await
        .unwrap_err();
    assert!(code(&deleted).starts_with("vault_not_found"), "{deleted:#}");
}
