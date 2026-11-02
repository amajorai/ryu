//! Live sources: read-through cache, fail-closed lookups, and stale-if-error.

use super::*;

#[tokio::test]
async fn live_sources_read_through_with_a_ttl_cache() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert(
            "apps/db".into(),
            json!({ "PASSWORD": VALUE, "bad-key": "x" }),
        );
        f.version = 7;
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    let src = source(&store, &record.id, "/db", "apps/db", json!({})).await;

    let resolved = store
        .resolve_vault_secret("/db/PASSWORD", &ctx())
        .await
        .unwrap();
    assert_eq!(resolved.as_deref(), Some(VALUE));
    // Absent remotely, absent locally: nothing falls back.
    assert_eq!(
        store
            .resolve_vault_secret("/db/OTHER", &ctx())
            .await
            .unwrap(),
        None
    );
    // Second read is served from the cache, even after a remote change.
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": "rotated" }))
    });
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some(VALUE)
    );
    assert_eq!(fake.with(|f| f.reads), 1);
    assert!(fake.with(|f| f.namespaces.iter().all(|ns| ns == "team-a")));
    // Once the TTL passes the next resolution sees the remote change.
    age_cache(&src.id, Duration::from_secs(120));
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some("rotated")
    );

    let rows = audit_rows(&store).await;
    assert!(rows.iter().any(|row| row.action == "secret.use"
        && row.outcome == "ok"
        && row.details["source"] == "external"
        && row.details["version"] == 7));
    let serialized = serde_json::to_string(&rows).unwrap();
    assert!(!serialized.contains(VALUE) && !serialized.contains("rotated"));
    assert!(!serialized.contains("s3cret"));
}

#[tokio::test]
async fn live_values_are_withheld_when_fail_closed_audit_is_refused() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": VALUE }));
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    source(&store, &record.id, "/db", "apps/db", json!({})).await;
    crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
    let refused = store.resolve_vault_secret("/db/PASSWORD", &ctx()).await;
    crate::vault::audit_devices::set_fail_closed_for_test(None);
    assert!(matches!(
        refused.unwrap_err().downcast_ref::<VaultError>(),
        Some(VaultError::AuditUnavailable)
    ));
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some(VALUE)
    );
}

#[tokio::test]
async fn an_unreachable_live_store_fails_closed() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": VALUE }));
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    let src = source(&store, &record.id, "/db", "apps/db", json!({})).await;
    // A same-named value in the default folder must not stand in for it.
    write(&store, node("default", "/", "PASSWORD"), "fallback")
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_imports
                (id, environment, path, source_environment, source_path, position, created_at)
             VALUES ('imp1', 'default', '/db', 'default', '/', 0, 0)",
            [],
        )
        .unwrap();
    }
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some(VALUE)
    );
    fake.with(|f| f.down = true);
    age_cache(&src.id, Duration::from_secs(120));
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap(),
        None,
        "an outage must not fall through to an import or a lower scope"
    );
    let rows = audit_rows(&store).await;
    assert!(rows
        .iter()
        .any(|row| row.action == "secret.use" && row.outcome == "unavailable"));
    let status = store.external_source(&src.id).await.unwrap();
    assert_eq!(status.last_status.as_deref(), Some("error"));
    assert!(status.last_error.unwrap().contains("503"));
    // A sealed vault resolves nothing through a store either.
    fake.with(|f| f.down = false);
    store.keyring.seal();
    assert_eq!(
        store
            .external_live_lookup("node-1", "default", "/db", "PASSWORD")
            .await
            .unwrap(),
        LiveLookup::Unavailable
    );
}

#[tokio::test]
async fn stale_if_error_serves_the_last_good_answer_for_its_window() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": VALUE }));
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    let src = source(
        &store,
        &record.id,
        "/db",
        "apps/db",
        json!({ "cacheTtlSecs": 30, "staleIfErrorSecs": 300 }),
    )
    .await;
    let lookup = || store.external_live_lookup("node-1", "default", "/db", "PASSWORD");
    assert!(matches!(lookup().await.unwrap(), LiveLookup::Found { .. }));
    fake.with(|f| f.down = true);
    age_cache(&src.id, Duration::from_secs(60));
    assert!(matches!(lookup().await.unwrap(), LiveLookup::Found { .. }));
    age_cache(&src.id, Duration::from_secs(600));
    assert_eq!(lookup().await.unwrap(), LiveLookup::Unavailable);
}
