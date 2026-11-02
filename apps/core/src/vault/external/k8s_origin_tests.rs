//! Kubernetes auth: the Core host's service-account token goes only to a
//! store origin the operator pinned in `RYU_VAULT_EXTERNAL_K8S_ALLOWED_ORIGINS`.

use super::*;

/// These tests change process environment the login reads.
static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn k8s_input(address: &str) -> StoreInput {
    serde_json::from_value(json!({
        "name": "k8s-pin",
        "kind": "openbao",
        "address": address,
        "authMethod": "kubernetes",
        "role": "ryu",
        "mount": "kv",
    }))
    .unwrap()
}

fn is_invalid(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Invalid(_))
    )
}

#[tokio::test]
async fn kubernetes_token_goes_only_to_the_pinned_store_origin() {
    let _env = ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let jwt_path = dir.path().join("token");
    std::fs::write(&jwt_path, K8S_JWT).unwrap();
    std::env::set_var(client::ENV_K8S_JWT_PATH, &jwt_path);
    let fake = Fake::default();
    let address = serve(fake.clone()).await;
    let store = PluginSecretStore::in_memory().unwrap();

    // Unpinned, or pinned to another origin: the store is refused.
    for pin in [None, Some("https://vault.example.com")] {
        match pin {
            Some(pin) => std::env::set_var(k8s_origin::ENV_K8S_ALLOWED_ORIGINS, pin),
            None => std::env::remove_var(k8s_origin::ENV_K8S_ALLOWED_ORIGINS),
        }
        let error = store
            .external_store_create(k8s_input(&address), &actor())
            .await
            .unwrap_err();
        assert!(is_invalid(&error), "{error:#}");
        assert!(format!("{error:#}").contains(k8s_origin::ENV_K8S_ALLOWED_ORIGINS));
    }
    assert_eq!(
        fake.with(|f| f.hits),
        0,
        "the token was sent to an unpinned store"
    );

    // Pinned to the store's origin: the store logs in with the token.
    std::env::set_var(k8s_origin::ENV_K8S_ALLOWED_ORIGINS, &address);
    let record = store
        .external_store_create(k8s_input(&address), &actor())
        .await
        .unwrap();
    store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap();
    let logins = fake.with(|f| f.logins);
    assert!(logins >= 1);

    // A stored record is re-checked at login when the pin no longer lists it.
    std::env::set_var(
        k8s_origin::ENV_K8S_ALLOWED_ORIGINS,
        "https://vault.example.com",
    );
    let hits = fake.with(|f| f.hits);
    let error = store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains(k8s_origin::ENV_K8S_ALLOWED_ORIGINS),
        "{error:#}"
    );
    assert_eq!(
        fake.with(|f| f.hits),
        hits,
        "the token was sent after the pin changed"
    );
    assert_eq!(fake.with(|f| f.logins), logins);

    std::env::remove_var(client::ENV_K8S_JWT_PATH);
    std::env::remove_var(k8s_origin::ENV_K8S_ALLOWED_ORIGINS);
}

#[tokio::test]
async fn kv_v1_with_kubernetes_auth_reads_and_writes_with_the_namespace() {
    let _env = ENV_LOCK.lock().await;
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": VALUE }));
    });
    let dir = tempfile::tempdir().unwrap();
    let jwt_path = dir.path().join("token");
    std::fs::write(&jwt_path, format!("{K8S_JWT}\n")).unwrap();
    std::env::set_var(client::ENV_K8S_JWT_PATH, &jwt_path);
    let address = serve(fake.clone()).await;
    std::env::set_var(k8s_origin::ENV_K8S_ALLOWED_ORIGINS, &address);
    let store = PluginSecretStore::in_memory().unwrap();
    let input: StoreInput = serde_json::from_value(json!({
        "name": "k8s",
        "kind": "hashicorp-vault",
        "address": address,
        "namespace": "team-b",
        "authMethod": "kubernetes",
        "role": "ryu",
        "mount": "kv1",
        "kvVersion": 1,
    }))
    .unwrap();
    let record = store.external_store_create(input, &actor()).await.unwrap();
    source(&store, &record.id, "/db", "apps/db", json!({})).await;
    assert_eq!(
        store
            .resolve_vault_secret("/db/PASSWORD", &ctx())
            .await
            .unwrap()
            .as_deref(),
        Some(VALUE)
    );
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
    assert_eq!(
        store
            .external_push(&destination.id, &actor())
            .await
            .unwrap(),
        1
    );
    // KV v1 bodies are the bare map, without a `data` wrapper.
    assert_eq!(
        fake.with(|f| f.pushed.last().cloned()),
        Some(("mirror/out".into(), json!({ "A": "one" })))
    );
    assert!(fake.with(|f| f.logins) >= 2);
    assert!(fake.with(|f| !f.namespaces.is_empty() && f.namespaces.iter().all(|ns| ns == "team-b")));

    // A token file that is not a JWT is never sent, and errors name no path.
    std::fs::write(&jwt_path, "placeholder service account token without JWT segments").unwrap();
    let logins = fake.with(|f| f.logins);
    let error = store
        .external_store_test(&record.id, &actor())
        .await
        .unwrap_err();
    let text = format!("{error:#}");
    assert!(text.contains("not a JWT"), "{text}");
    assert!(!text.contains(&jwt_path.display().to_string()), "{text}");
    assert_eq!(fake.with(|f| f.logins), logins);
    std::env::remove_var(client::ENV_K8S_JWT_PATH);
    std::env::remove_var(k8s_origin::ENV_K8S_ALLOWED_ORIGINS);
}
