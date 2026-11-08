//! Value types (`config`, `secret`, `sealed`): a sealed value resolves at run
//! time but is never revealed or exported, and never stops being sealed.
//!
//! These exercise the type through every store path it touches:
//! `metadata::ValueType` and `SecretMetadataPatch::apply`, `coords::info_from_row`
//! and `store_metadata`, `write::write_secret`, `read::reveal`,
//! `environments::add_import`, `resolve::resolve_vault_secret`,
//! `resolve_context::effective_local_values`, `rotation::rotate_generated`, and
//! `kv_folder::kv_folder_replace`.

use super::*;

fn actor() -> AuditActor {
    AuditActor::new("user", Some("u1"))
}

fn coords(path: &str, name: &str) -> SecretCoords {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: "node-1".into(),
        environment: "default".into(),
        path: path.into(),
        binding: None,
        name: name.into(),
    }
}

fn ctx() -> SecretResolutionContext {
    SecretResolutionContext::node_only("node-1", Vec::new())
}

async fn write(
    store: &PluginSecretStore,
    coords: SecretCoords,
    value: &str,
    value_type: Option<ValueType>,
) -> Result<VaultSecretInfo> {
    store
        .write_secret(WriteRequest {
            coords,
            value: Some(value),
            patch: SecretMetadataPatch {
                value_type,
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
}

fn is_denied(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Denied(_))
    )
}

#[tokio::test]
async fn values_default_to_secret_and_config_reveals() {
    let store = PluginSecretStore::in_memory().unwrap();
    let plain = write(&store, coords("/", "API_KEY"), "k", None)
        .await
        .unwrap();
    assert_eq!(plain.metadata.value_type, ValueType::Secret);
    let config = write(
        &store,
        coords("/", "LOG_LEVEL"),
        "debug",
        Some(ValueType::Config),
    )
    .await
    .unwrap();
    assert_eq!(config.metadata.value_type, ValueType::Config);
    let listed = serde_json::to_value(&config.metadata).unwrap();
    assert_eq!(listed["valueType"], "config");
    assert_eq!(
        store
            .reveal(&coords("/", "LOG_LEVEL"), None, &actor())
            .await
            .unwrap(),
        "debug"
    );
}

#[tokio::test]
async fn a_sealed_value_resolves_but_is_never_revealed() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("/", "SIGNING_KEY");
    write(&store, c.clone(), "v1", None).await.unwrap();
    write(&store, c.clone(), "v2", Some(ValueType::Sealed))
        .await
        .unwrap();
    for version in [None, Some(1), Some(2)] {
        let error = store.reveal(&c, version, &actor()).await.unwrap_err();
        assert!(is_denied(&error), "{error:#}");
        assert!(!format!("{error:#}").contains("v1"));
    }
    assert_eq!(
        store
            .resolve_vault_secret("SIGNING_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("v2")
    );
    // A rewrite that leaves the type out keeps it sealed.
    let rotated = write(&store, c.clone(), "v3", None).await.unwrap();
    assert_eq!(rotated.metadata.value_type, ValueType::Sealed);
}

#[tokio::test]
async fn a_sealed_value_cannot_be_unsealed() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("/", "SIGNING_KEY");
    write(&store, c.clone(), "v1", Some(ValueType::Sealed))
        .await
        .unwrap();
    let error = write(&store, c.clone(), "v2", Some(ValueType::Secret))
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("stays sealed"));
    let error = store
        .patch_metadata(
            c.clone(),
            &serde_json::json!({ "valueType": "config" }),
            None,
            &actor(),
        )
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("stays sealed"));
    let info = store.secret_info(&c).await.unwrap().unwrap();
    assert_eq!(info.metadata.value_type, ValueType::Sealed);
    assert_eq!(info.version, 1);
}

#[tokio::test]
async fn export_withholds_sealed_values_without_falling_through() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("/shared", "TOKEN"), "shared-token", None)
        .await
        .unwrap();
    write(
        &store,
        coords("/app", "TOKEN"),
        "app-sealed",
        Some(ValueType::Sealed),
    )
    .await
    .unwrap();
    write(
        &store,
        coords("/app", "LOG_LEVEL"),
        "info",
        Some(ValueType::Config),
    )
    .await
    .unwrap();
    store
        .add_import(
            &FolderImport {
                id: String::new(),
                environment: "default".into(),
                path: "/app".into(),
                source_environment: "default".into(),
                source_path: "/shared".into(),
                position: 0,
            },
            &actor(),
        )
        .await
        .unwrap();
    let effective = store
        .effective_local_values(&ctx(), "default", "/app", |_| true)
        .await
        .unwrap();
    assert_eq!(
        effective.keys().cloned().collect::<Vec<_>>(),
        vec!["LOG_LEVEL".to_owned()]
    );
    // The sealed name is reported as withheld so a caller merging another
    // tier (shared values) drops that name as well.
    let (values, withheld) = store
        .effective_local_values_and_withheld(&ctx(), "default", "/app", |_| true)
        .await
        .unwrap();
    assert_eq!(values.len(), 1);
    assert_eq!(
        withheld.into_iter().collect::<Vec<_>>(),
        vec!["TOKEN".to_owned()]
    );
    // Runtime resolution still uses the sealed value, not the import.
    assert_eq!(
        store
            .resolve_vault_secret("/app/TOKEN", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("app-sealed")
    );
}

#[tokio::test]
async fn rotation_and_kv_folder_writes_keep_a_value_sealed() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("/", "SIGNING_KEY");
    store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("v1"),
            patch: SecretMetadataPatch {
                value_type: Some(ValueType::Sealed),
                generator: Some(Some(Generator::Random {
                    length: 16,
                    charset: Charset::Alphanumeric,
                })),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    let rotated = store.rotate_generated(c.clone(), &actor()).await.unwrap();
    assert_eq!(rotated.version, 2);
    assert_eq!(rotated.metadata.value_type, ValueType::Sealed);
    assert!(is_denied(
        &store.reveal(&c, None, &actor()).await.unwrap_err()
    ));

    let folder = KvFolder {
        scope_id: "node-1".into(),
        environment: "default".into(),
        path: "/".into(),
    };
    let state = store
        .kv_folder_replace(KvFolderReplace {
            folder: folder.clone(),
            writes: vec![(c.clone(), "v3".to_owned())],
            removable: BTreeSet::new(),
            cas: None,
            actor: &actor(),
        })
        .await
        .unwrap();
    let key = state.keys.iter().find(|info| info.name == "SIGNING_KEY");
    assert_eq!(key.unwrap().metadata.value_type, ValueType::Sealed);
    assert!(is_denied(
        &store.reveal(&c, None, &actor()).await.unwrap_err()
    ));
}

#[test]
fn unknown_stored_types_fail_closed() {
    assert_eq!(ValueType::from_column("config"), ValueType::Config);
    assert_eq!(ValueType::from_column("secret"), ValueType::Secret);
    assert_eq!(ValueType::from_column("sealed"), ValueType::Sealed);
    assert_eq!(ValueType::from_column("something-new"), ValueType::Sealed);
    assert!(!ValueType::Sealed.is_revealable());
    let patch: SecretMetadataPatch = serde_json::from_str(r#"{"valueType":"sealed"}"#).unwrap();
    assert_eq!(patch.value_type, Some(ValueType::Sealed));
    assert!(serde_json::from_str::<SecretMetadataPatch>(r#"{"valueType":"public"}"#).is_err());
}
