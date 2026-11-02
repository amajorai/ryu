//! Sync sources, destinations (push), and store credential errors.

use super::*;

#[tokio::test]
async fn node_writes_into_sourced_folders_conflict() {
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, "http://127.0.0.1:1").await;
    write(&store, node("default", "/db", "OLD"), "v")
        .await
        .unwrap();
    source(
        &store,
        &record.id,
        "/db",
        "apps/db",
        json!({ "mode": "sync" }),
    )
    .await;

    let error = write(&store, node("default", "/db", "NEW"), "v")
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error:#}");
    let error = store
        .soft_delete(node("default", "/db", "OLD"), &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error:#}");
    let error = store
        .restore(node("default", "/db", "OLD"), &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error:#}");
    let error = store
        .destroy(node("default", "/db", "OLD"), None, &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error:#}");
    assert!(store
        .secret_info(&node("default", "/db", "OLD"))
        .await
        .unwrap()
        .is_some());
    // The guard, the live lookup, and the unique key share one node scope id:
    // another node id's folder of the same name is neither guarded nor sourced.
    let mut other_node = node("default", "/db", "NEW");
    other_node.scope_id = "node-2".into();
    write(&store, other_node, "v").await.unwrap();
    assert_eq!(
        store
            .external_live_lookup("node-2", "default", "/db", "NEW")
            .await
            .unwrap(),
        LiveLookup::NotSourced
    );
    // Other folders, environments, and user-scope values are unaffected.
    write(&store, node("default", "/other", "NEW"), "v")
        .await
        .unwrap();
    let mut user = node("default", "/db", "NEW");
    user.scope = SecretScope::User;
    user.scope_id = "user-1".into();
    write(&store, user, "v").await.unwrap();
    // A second source on the same folder is refused.
    let input: SourceInput = serde_json::from_value(json!({
        "storeId": record.id, "environment": "default", "path": "/db",
        "remotePath": "elsewhere", "mode": "live",
    }))
    .unwrap();
    let error = store
        .external_source_create(input, "node-1", &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error));
    // The store cannot be deleted while it is in use.
    let error = store
        .external_store_delete(&record.id, &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error));
}

#[tokio::test]
async fn sync_sources_copy_versions_and_remove_dropped_keys() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert(
            "apps/api".into(),
            json!({ "API_KEY": VALUE, "TOKEN": "t1" }),
        );
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    let src = source(
        &store,
        &record.id,
        "/api",
        "apps/api",
        json!({ "mode": "sync" }),
    )
    .await;

    let report = store.external_tick().await;
    assert_eq!(report.synced, 1, "{report:?}");
    assert_eq!(
        store
            .resolve_vault_secret("/api/API_KEY", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some(VALUE)
    );
    let versions = store
        .list_versions(&node("default", "/api", "API_KEY"))
        .await
        .unwrap();
    assert_eq!(versions[0].source, "external");
    // Not due again until the interval passes.
    assert_eq!(store.external_tick().await, TickReport::default());

    fake.with(|f| f.kv.insert("apps/api".into(), json!({ "API_KEY": "v2" })));
    let report = store.external_sync_source(&src.id, &actor()).await.unwrap();
    assert_eq!(
        report,
        SyncReport {
            written: 1,
            removed: 1,
            unchanged: 0
        }
    );
    assert_eq!(
        store
            .resolve_vault_secret("/api/TOKEN", &ctx())
            .await
            .unwrap(),
        None
    );
    let status = store.external_source(&src.id).await.unwrap();
    assert_eq!(status.last_status.as_deref(), Some("ok"));
    assert_eq!(status.last_count, 1);
}

#[tokio::test]
async fn syncs_of_one_source_are_serialized() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/api".into(), json!({ "API_KEY": VALUE }));
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    let src = source(
        &store,
        &record.id,
        "/api",
        "apps/api",
        json!({ "mode": "sync" }),
    )
    .await;

    // While another sync of the source runs, a second one waits before it
    // reads the remote folder, so two snapshots never interleave.
    let lock = source_sync_lock(&src.id);
    let running = lock.lock().await;
    let reads = fake.with(|f| f.reads);
    let blocked = tokio::time::timeout(
        Duration::from_millis(200),
        store.external_sync_source(&src.id, &actor()),
    )
    .await;
    assert!(blocked.is_err(), "the second sync waits for the first");
    assert_eq!(fake.with(|f| f.reads), reads, "nothing was read meanwhile");
    drop(running);
    let report = store.external_sync_source(&src.id, &actor()).await.unwrap();
    assert_eq!(report.written, 1);
}

#[tokio::test]
async fn one_invalid_remote_key_aborts_the_whole_sync() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert(
            "apps/api".into(),
            json!({ "API_KEY": VALUE, "not-a-name": "x" }),
        );
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    let src = source(
        &store,
        &record.id,
        "/api",
        "apps/api",
        json!({ "mode": "sync" }),
    )
    .await;
    let error = store
        .external_sync_source(&src.id, &actor())
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("not-a-name"));
    assert_eq!(
        store
            .resolve_vault_secret("/api/API_KEY", &ctx())
            .await
            .unwrap(),
        None
    );
    let status = store.external_source(&src.id).await.unwrap();
    assert_eq!(status.last_status.as_deref(), Some("error"));
}

#[tokio::test]
async fn destinations_push_after_writes_and_refuse_loops() {
    let fake = Fake::default();
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    write(&store, node("default", "/out", "A"), "one")
        .await
        .unwrap();
    let input: DestinationInput = serde_json::from_value(json!({
        "storeId": record.id, "environment": "default", "path": "/out",
        "remotePath": "mirror/out",
    }))
    .unwrap();
    let destination = store
        .external_destination_create(input, "node-1", &actor())
        .await
        .unwrap();
    assert_eq!(store.external_tick().await.pushed, 1);
    assert_eq!(
        fake.with(|f| f.pushed.last().cloned()),
        Some(("mirror/out".into(), json!({ "A": "one" })))
    );
    // Nothing changed: not pushed again.
    assert_eq!(store.external_tick().await.pushed, 0);
    // A write re-flags the destination.
    write(&store, node("default", "/out", "B"), "two")
        .await
        .unwrap();
    assert!(store.external_destination_list().await.unwrap()[0].dirty);
    assert_eq!(store.external_tick().await.pushed, 1);
    assert_eq!(
        fake.with(|f| f.pushed.last().cloned()),
        Some(("mirror/out".into(), json!({ "A": "one", "B": "two" })))
    );
    let rows = serde_json::to_string(&audit_rows(&store).await).unwrap();
    assert!(rows.contains("external.push") && !rows.contains("\"two\""));
    // Delete, restore, and destroy each re-flag the destination.
    store
        .soft_delete(node("default", "/out", "B"), &actor())
        .await
        .unwrap();
    assert_eq!(store.external_tick().await.pushed, 1);
    store
        .restore(node("default", "/out", "B"), &actor())
        .await
        .unwrap();
    assert!(store.external_destination_list().await.unwrap()[0].dirty);
    assert_eq!(store.external_tick().await.pushed, 1);
    assert_eq!(
        fake.with(|f| f.pushed.last().cloned()),
        Some(("mirror/out".into(), json!({ "A": "one", "B": "two" })))
    );
    store
        .destroy(node("default", "/out", "B"), None, &actor())
        .await
        .unwrap();
    assert!(store.external_destination_list().await.unwrap()[0].dirty);
    assert_eq!(store.external_tick().await.pushed, 1);
    assert_eq!(
        fake.with(|f| f.pushed.last().cloned()),
        Some(("mirror/out".into(), json!({ "A": "one" })))
    );

    // Pulling the pushed remote path would loop.
    let input: SourceInput = serde_json::from_value(json!({
        "storeId": record.id, "environment": "default", "path": "/in",
        "remotePath": "mirror/out", "mode": "sync",
    }))
    .unwrap();
    let error = store
        .external_source_create(input, "node-1", &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error));
    store
        .external_destination_delete(&destination.id, &actor())
        .await
        .unwrap();
}

#[tokio::test]
async fn infisical_universal_auth_reads_and_upserts() {
    let fake = Fake::default();
    fake.with(|f| {
        f.infisical.insert("DB_URL".into(), VALUE.into());
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let input: StoreInput = serde_json::from_value(json!({
        "name": "inf",
        "kind": "infisical",
        "address": serve(fake.clone()).await,
        "authMethod": "universal-auth",
        "projectId": "proj-1",
        "infisicalEnvironment": "prod",
        "secretPath": "/backend",
        "credentials": { "clientId": "cid", "clientSecret": "csec" },
    }))
    .unwrap();
    let record = store.external_store_create(input, &actor()).await.unwrap();
    store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap();
    source(&store, &record.id, "/inf", "db", json!({})).await;
    assert_eq!(
        store
            .resolve_vault_secret("/inf/DB_URL", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some(VALUE)
    );
    let query = fake.with(|f| f.infisical_queries.last().cloned()).unwrap();
    assert!(query.contains("workspaceId=proj-1"), "{query}");
    assert!(query.contains("environment=prod"), "{query}");
    assert!(query.contains("secretPath=%2Fbackend%2Fdb"), "{query}");

    write(&store, node("default", "/push", "NEW_KEY"), "n")
        .await
        .unwrap();
    let input: DestinationInput = serde_json::from_value(json!({
        "storeId": record.id, "environment": "default", "path": "/push",
    }))
    .unwrap();
    let destination = store
        .external_destination_create(input, "node-1", &actor())
        .await
        .unwrap();
    assert_eq!(
        store
            .external_push(&destination.id, &actor())
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        fake.with(|f| f.infisical_calls.clone()),
        vec!["PATCH NEW_KEY".to_owned(), "POST NEW_KEY".to_owned()]
    );
    assert_eq!(
        fake.with(|f| f.infisical.get("NEW_KEY").cloned())
            .as_deref(),
        Some("n")
    );
}

#[tokio::test]
async fn bad_credentials_and_redirects_do_not_resolve() {
    let target = Fake::default();
    let target_url = serve(target.clone()).await;
    let redirecting = Fake::default();
    redirecting.with(|f| f.redirect_to = Some(format!("{target_url}/v1/secret/data/apps/db")));
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(redirecting.clone()).await).await;
    source(&store, &record.id, "/db", "apps/db", json!({})).await;
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap(),
        None
    );
    assert!(redirecting.with(|f| f.hits) >= 1);
    assert_eq!(target.with(|f| f.hits), 0, "a redirect was followed");

    let input: StoreInput = serde_json::from_value(json!({
        "name": "wrong",
        "kind": "openbao",
        "address": target_url,
        "authMethod": "approle",
        "credentials": { "roleId": "role", "secretId": "nope" },
    }))
    .unwrap();
    let wrong = store.external_store_create(input, &actor()).await.unwrap();
    let error = store
        .external_store_test(&wrong.id, &actor())
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains("HTTP 400"));
    assert!(!format!("{error:#}").contains("nope"));
}

#[tokio::test]
async fn failing_destinations_back_off_instead_of_retrying_every_tick() {
    let fake = Fake::default();
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    write(&store, node("default", "/out", "A"), "one")
        .await
        .unwrap();
    let destination = store
        .external_destination_create(
            destination_input(&record.id, "/out", "mirror/out"),
            "node-1",
            &actor(),
        )
        .await
        .unwrap();
    fake.with(|f| f.down = true);
    assert_eq!(store.external_tick().await.failed, 1);
    let hits = fake.with(|f| f.hits);
    // Still dirty, but inside its backoff: no new attempt, no new audit row.
    let audits = audit_rows(&store).await.len();
    assert_eq!(store.external_tick().await, TickReport::default());
    write(&store, node("default", "/out", "B"), "two")
        .await
        .unwrap();
    assert_eq!(store.external_tick().await, TickReport::default());
    assert_eq!(fake.with(|f| f.hits), hits);
    assert_eq!(
        audit_rows(&store).await.len(),
        audits + 1,
        "only the write was audited"
    );
    let listed = store.external_destination_list().await.unwrap();
    assert_eq!((listed[0].failures, listed[0].dirty), (1, true));

    let age = |by_ms: i64| {
        let store = &store;
        let id = destination.id.clone();
        async move {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_external_destinations SET last_push_at = last_push_at - ?1
                 WHERE id = ?2",
                params![by_ms, id],
            )
            .unwrap();
        }
    };
    // The first retry waits one tick; the second waits twice as long.
    age(10_000).await;
    assert_eq!(store.external_tick().await.failed, 1);
    age(10_000).await;
    assert_eq!(store.external_tick().await, TickReport::default());
    // The backoff never exceeds the destination's interval.
    assert_eq!(retry_backoff_ms(40, 3600), 3_600_000);
    assert_eq!(retry_backoff_ms(1, 3600), 10_000);
    // Recovery clears the failure count.
    fake.with(|f| f.down = false);
    age(10_000).await;
    assert_eq!(store.external_tick().await.pushed, 1);
    let listed = store.external_destination_list().await.unwrap();
    assert_eq!((listed[0].failures, listed[0].dirty), (0, false));
    assert_eq!(
        fake.with(|f| f.pushed.last().cloned()),
        Some(("mirror/out".into(), json!({ "A": "one", "B": "two" })))
    );
}

#[tokio::test]
async fn live_folders_cannot_be_pushed_and_empty_folders_never_wipe_kv() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": VALUE }));
        f.kv.insert("mirror/keep".into(), json!({ "KEEP": "me" }));
    });
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, &serve(fake.clone()).await).await;
    source(&store, &record.id, "/db", "apps/db", json!({})).await;
    let error = store
        .external_destination_create(
            destination_input(&record.id, "/db", "mirror/db"),
            "node-1",
            &actor(),
        )
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error:#}");
    // The other direction: a live source on a pushed folder is refused; sync
    // is fine because it writes the folder's local rows.
    store
        .external_destination_create(
            destination_input(&record.id, "/out", "mirror/out"),
            "node-1",
            &actor(),
        )
        .await
        .unwrap();
    let live: SourceInput = serde_json::from_value(json!({
        "storeId": record.id, "environment": "default", "path": "/out",
        "remotePath": "apps/other", "mode": "live",
    }))
    .unwrap();
    let error = store
        .external_source_create(live, "node-1", &actor())
        .await
        .unwrap_err();
    assert!(is_conflict(&error), "{error:#}");

    // An empty folder pushed onto a non-empty KV secret is refused.
    let keep = store
        .external_destination_create(
            destination_input(&record.id, "/typo", "mirror/keep"),
            "node-1",
            &actor(),
        )
        .await
        .unwrap();
    let error = store.external_push(&keep.id, &actor()).await.unwrap_err();
    assert!(
        format!("{error:#}").contains("refusing to wipe"),
        "{error:#}"
    );
    assert_eq!(
        fake.with(|f| f.kv.get("mirror/keep").cloned()),
        Some(json!({ "KEEP": "me" }))
    );
    // Onto an absent secret it is a no-op.
    let empty = store
        .external_destination_create(
            destination_input(&record.id, "/empty", "mirror/empty"),
            "node-1",
            &actor(),
        )
        .await
        .unwrap();
    assert_eq!(store.external_push(&empty.id, &actor()).await.unwrap(), 0);
    assert!(fake.with(|f| f.pushed.is_empty()));
}
