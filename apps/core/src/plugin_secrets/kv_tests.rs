use super::*;

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

pub(super) async fn write(
    store: &PluginSecretStore,
    coords: SecretCoords,
    value: &str,
) -> VaultSecretInfo {
    store
        .write_secret(WriteRequest {
            coords,
            value: Some(value),
            patch: SecretMetadataPatch::default(),
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap()
}

pub(super) fn ctx() -> SecretResolutionContext {
    SecretResolutionContext::node_only("node-1", Vec::new())
}

#[tokio::test]
async fn every_write_appends_a_version_and_rollback_restores_old_values() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    assert_eq!(write(&store, c.clone(), "one").await.version, 1);
    assert_eq!(write(&store, c.clone(), "two").await.version, 2);
    let versions = store.list_versions(&c).await.unwrap();
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![2, 1]
    );
    assert!(versions[0].current);

    let rolled = store.rollback(c.clone(), 1, &actor()).await.unwrap();
    assert_eq!(rolled.version, 3);
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("one")
    );
    assert_eq!(store.reveal(&c, Some(2), &actor()).await.unwrap(), "two");
}

#[tokio::test]
async fn optimistic_concurrency_rejects_stale_writes() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    let stale = store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("two"),
            patch: SecretMetadataPatch::default(),
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: Some(7),
        })
        .await
        .unwrap_err();
    assert!(stale.to_string().starts_with("vault_conflict"));
}

#[tokio::test]
async fn retention_keeps_only_max_versions() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("v1"),
            patch: SecretMetadataPatch {
                max_versions: Some(2),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    write(&store, c.clone(), "v2").await;
    write(&store, c.clone(), "v3").await;
    let versions = store.list_versions(&c).await.unwrap();
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![3, 2]
    );
}

#[tokio::test]
async fn soft_delete_hides_and_restore_revives_with_history() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    assert!(store.soft_delete(c.clone(), &actor()).await.unwrap());
    assert_eq!(
        store.resolve_vault_secret("API_KEY", &ctx()).await.unwrap(),
        None
    );
    assert!(store.list_vault_secrets().await.unwrap().is_empty());
    let restored = store.restore(c.clone(), &actor()).await.unwrap();
    assert_eq!(restored.version, 1);
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("one")
    );
    // Writing after a delete revives the row with a new version.
    store.soft_delete(c.clone(), &actor()).await.unwrap();
    assert_eq!(write(&store, c.clone(), "two").await.version, 2);
}

#[tokio::test]
async fn destroy_removes_versions_permanently() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "API_KEY");
    write(&store, c.clone(), "one").await;
    write(&store, c.clone(), "two").await;
    assert!(store
        .destroy(c.clone(), Some(&[2]), &actor())
        .await
        .is_err());
    assert_eq!(
        store
            .destroy(c.clone(), Some(&[1]), &actor())
            .await
            .unwrap(),
        1
    );
    assert!(store.reveal(&c, Some(1), &actor()).await.is_err());
    assert!(store.rollback(c.clone(), 1, &actor()).await.is_err());
    store.destroy(c.clone(), None, &actor()).await.unwrap();
    assert_eq!(store.secret_info(&c).await.unwrap(), None);
}

#[tokio::test]
async fn environments_and_folders_scope_resolution() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "DB_URL"), "dev-db").await;
    write(&store, coords("prod", "/db", "DB_URL"), "prod-db").await;
    assert_eq!(
        store
            .resolve_vault_secret("DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("dev-db")
    );
    assert_eq!(
        store
            .resolve_vault_secret("prod:/db/DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("prod-db")
    );
    assert_eq!(
        store
            .resolve_vault_secret("prod:DB_URL", &ctx())
            .await
            .unwrap(),
        None
    );
    let mut prod = ctx();
    prod.environment = Some("prod".into());
    assert_eq!(
        store
            .resolve_vault_secret("/db/DB_URL", &prod)
            .await
            .unwrap()
            .as_deref(),
        Some("prod-db")
    );
    assert_eq!(
        store.list_folders("prod").await.unwrap(),
        vec!["/".to_owned(), "/db".to_owned()]
    );
}

#[tokio::test]
async fn imports_are_a_lower_precedence_fallback_within_each_scope() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(
        &store,
        coords("default", "/shared", "TOKEN"),
        "shared-token",
    )
    .await;
    write(
        &store,
        coords("default", "/shared", "OTHER"),
        "shared-other",
    )
    .await;
    write(&store, coords("default", "/app", "OTHER"), "app-other").await;
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
    assert_eq!(
        store
            .resolve_vault_secret("/app/TOKEN", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("shared-token")
    );
    assert_eq!(
        store
            .resolve_vault_secret("/app/OTHER", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("app-other")
    );
    let effective = store
        .effective_local_values(&ctx(), "default", "/app", |_| true)
        .await
        .unwrap();
    assert_eq!(effective.get("TOKEN").unwrap().1, "shared-token");
    assert_eq!(effective.get("OTHER").unwrap().1, "app-other");
}

#[tokio::test]
async fn references_expand_only_when_enabled_and_fail_closed() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "DB_USER"), "app").await;
    write(&store, coords("default", "/", "DB_PASS"), "s3cret").await;
    let url = coords("default", "/", "DB_URL");
    store
        .write_secret(WriteRequest {
            coords: url.clone(),
            value: Some("postgres://${DB_USER}:${DB_PASS}@db/app?x=$${literal}"),
            patch: SecretMetadataPatch {
                expand_references: Some(true),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("postgres://app:s3cret@db/app?x=${literal}")
    );
    store
        .soft_delete(coords("default", "/", "DB_PASS"), &actor())
        .await
        .unwrap();
    assert_eq!(
        store.resolve_vault_secret("DB_URL", &ctx()).await.unwrap(),
        None
    );

    // A self-reference cycle resolves to absent rather than looping.
    let a = coords("default", "/", "LOOP");
    store
        .write_secret(WriteRequest {
            coords: a,
            value: Some("x${LOOP}"),
            patch: SecretMetadataPatch {
                expand_references: Some(true),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store.resolve_vault_secret("LOOP", &ctx()).await.unwrap(),
        None
    );

    // The same reference used twice is not a cycle.
    store
        .write_secret(WriteRequest {
            coords: coords("default", "/", "PAIR"),
            value: Some("${DB_USER}:${DB_USER}"),
            patch: SecretMetadataPatch {
                expand_references: Some(true),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(
        store
            .resolve_vault_secret("PAIR", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("app:app")
    );
}

#[tokio::test]
async fn expired_values_do_not_resolve_and_report_their_status() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "TEMP");
    let info = store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: Some("short-lived"),
            patch: SecretMetadataPatch {
                expires_at: Some(Some(now_millis() - 1)),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    assert_eq!(info.status(now_millis()), SecretStatus::Expired);
    assert_eq!(
        store.resolve_vault_secret("TEMP", &ctx()).await.unwrap(),
        None
    );
}

#[tokio::test]
async fn generated_values_rotate_when_due() {
    let store = PluginSecretStore::in_memory().unwrap();
    let c = coords("default", "/", "DB_PASSWORD");
    let created = store
        .write_secret(WriteRequest {
            coords: c.clone(),
            value: None,
            patch: SecretMetadataPatch {
                generator: Some(Some(Generator::Random {
                    length: 24,
                    charset: Charset::Alphanumeric,
                })),
                rotation_period_secs: Some(Some(MIN_ROTATION_PERIOD_SECS)),
                ..Default::default()
            },
            actor: &actor(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
    let first = store.reveal(&c, None, &actor()).await.unwrap();
    assert_eq!(first.len(), 24);
    assert!(store.due_generated_rotations().await.unwrap().is_empty());
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE vault_secrets SET rotated_at = 0", [])
            .unwrap();
    }
    assert_eq!(
        store.due_generated_rotations().await.unwrap(),
        vec![c.clone()]
    );
    let rotated = store
        .rotate_generated(c.clone(), &AuditActor::system())
        .await
        .unwrap();
    assert_eq!(rotated.version, created.version + 1);
    assert_ne!(store.reveal(&c, None, &actor()).await.unwrap(), first);
}

#[tokio::test]
async fn deny_policies_block_runtime_use() {
    let store = PluginSecretStore::in_memory().unwrap();
    write(&store, coords("default", "/", "API_KEY"), "v").await;
    {
        let conn = store.conn.lock().await;
        policy::put_policy(
            &conn,
            &policy::Policy {
                name: "block".into(),
                description: String::new(),
                rules: vec![policy::PolicyRule {
                    path: "default/**".into(),
                    capabilities: vec![Capability::Use],
                    deny: true,
                    ..Default::default()
                }],
            },
        )
        .unwrap();
        policy::bind(&conn, "block", "user:u9", None, None).unwrap();
        policy::bind(&conn, "block", "role:viewer", None, None).unwrap();
    }
    let mut context = ctx();
    assert!(store
        .resolve_vault_secret("API_KEY", &context)
        .await
        .unwrap()
        .is_some());
    context.user_id = Some("u9".into());
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &context)
            .await
            .unwrap(),
        None
    );
    // A role-bound deny applies at dispatch too.
    let mut viewer = ctx();
    viewer.roles = vec!["viewer".into()];
    assert_eq!(
        store
            .resolve_vault_secret("API_KEY", &viewer)
            .await
            .unwrap(),
        None
    );
}
