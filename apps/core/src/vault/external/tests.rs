//! External-store tests against a local fake that implements the subset of
//! the Vault/OpenBao KV v2 and Infisical v3 APIs Core uses. No live service is
//! contacted.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use serde_json::{json, Value};

use super::*;
use crate::plugin_secrets::SecretResolutionContext;
use crate::vault::audit::AuditFilter;

const VALUE: &str = "hunter2-very-secret";
const K8S_JWT: &str = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJyeXUifQ.c2lnbmF0dXJl";

#[derive(Default)]
struct FakeInner {
    kv: HashMap<String, Value>,
    version: i64,
    down: bool,
    redirect_to: Option<String>,
    logins: usize,
    reads: usize,
    hits: usize,
    namespaces: Vec<String>,
    pushed: Vec<(String, Value)>,
    infisical: BTreeMap<String, String>,
    infisical_calls: Vec<String>,
    infisical_queries: Vec<String>,
}

#[derive(Clone, Default)]
struct Fake(Arc<Mutex<FakeInner>>);

impl Fake {
    fn with<T>(&self, f: impl FnOnce(&mut FakeInner) -> T) -> T {
        f(&mut self.0.lock().unwrap())
    }
}

fn reply(status: StatusCode, body: Value) -> Response {
    (status, axum::Json(body)).into_response()
}

async fn handle(
    State(fake): State<Fake>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let mut inner = fake.0.lock().unwrap();
    inner.hits += 1;
    if inner.down {
        return reply(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({ "errors": ["sealed"] }),
        );
    }
    if let Some(location) = inner.redirect_to.clone() {
        return Response::builder()
            .status(StatusCode::FOUND)
            .header("location", location)
            .body(axum::body::Body::empty())
            .unwrap();
    }
    let path = uri.path().to_owned();
    let vault_ok = header("x-vault-token") == "vt-1";
    let infisical_ok = header("authorization") == "Bearer it-1";
    match (method.as_str(), path.as_str()) {
        ("POST", "/v1/auth/approle/login") => {
            if body["role_id"] == "role" && body["secret_id"] == "s3cret" {
                inner.logins += 1;
                inner.namespaces.push(header("x-vault-namespace"));
                reply(
                    StatusCode::OK,
                    json!({ "auth": { "client_token": "vt-1" } }),
                )
            } else {
                reply(StatusCode::BAD_REQUEST, json!({ "errors": ["invalid"] }))
            }
        }
        ("POST", "/v1/auth/kubernetes/login") => {
            if body["role"] == "ryu" && body["jwt"] == K8S_JWT {
                inner.logins += 1;
                inner.namespaces.push(header("x-vault-namespace"));
                reply(
                    StatusCode::OK,
                    json!({ "auth": { "client_token": "vt-1" } }),
                )
            } else {
                reply(StatusCode::FORBIDDEN, json!({ "errors": ["denied"] }))
            }
        }
        ("GET", "/v1/auth/token/lookup-self") if vault_ok => reply(StatusCode::OK, json!({})),
        ("GET", p) if p.starts_with("/v1/kv1/") && vault_ok => {
            inner.reads += 1;
            inner.namespaces.push(header("x-vault-namespace"));
            let key = p.trim_start_matches("/v1/kv1/").to_owned();
            match inner.kv.get(&key) {
                Some(data) => reply(StatusCode::OK, json!({ "data": data })),
                None => reply(StatusCode::NOT_FOUND, json!({ "errors": [] })),
            }
        }
        ("POST", p) if p.starts_with("/v1/kv1/") && vault_ok => {
            let key = p.trim_start_matches("/v1/kv1/").to_owned();
            inner.pushed.push((key.clone(), body.clone()));
            inner.kv.insert(key, body);
            reply(StatusCode::NO_CONTENT, Value::Null)
        }
        ("GET", p) if p.starts_with("/v1/secret/data/") && vault_ok => {
            inner.reads += 1;
            inner.namespaces.push(header("x-vault-namespace"));
            let key = p.trim_start_matches("/v1/secret/data/").to_owned();
            match inner.kv.get(&key) {
                Some(data) => reply(
                    StatusCode::OK,
                    json!({ "data": { "data": data, "metadata": { "version": inner.version } } }),
                ),
                None => reply(StatusCode::NOT_FOUND, json!({ "errors": [] })),
            }
        }
        ("POST", p) if p.starts_with("/v1/secret/data/") && vault_ok => {
            let key = p.trim_start_matches("/v1/secret/data/").to_owned();
            inner.pushed.push((key.clone(), body["data"].clone()));
            inner.kv.insert(key, body["data"].clone());
            reply(StatusCode::OK, json!({ "data": { "version": 1 } }))
        }
        ("POST", "/api/v1/auth/universal-auth/login") => {
            if body["clientId"] == "cid" && body["clientSecret"] == "csec" {
                inner.logins += 1;
                reply(
                    StatusCode::OK,
                    json!({ "accessToken": "it-1", "expiresIn": 600 }),
                )
            } else {
                reply(StatusCode::UNAUTHORIZED, json!({ "message": "bad" }))
            }
        }
        ("GET", "/api/v3/secrets/raw") if infisical_ok => {
            inner.reads += 1;
            inner
                .infisical_queries
                .push(uri.query().unwrap_or_default().to_owned());
            let secrets: Vec<Value> = inner
                .infisical
                .iter()
                .map(|(k, v)| json!({ "secretKey": k, "secretValue": v, "version": 4 }))
                .collect();
            reply(StatusCode::OK, json!({ "secrets": secrets, "imports": [] }))
        }
        (verb @ ("PATCH" | "POST"), p) if p.starts_with("/api/v3/secrets/raw/") && infisical_ok => {
            let key = p.trim_start_matches("/api/v3/secrets/raw/").to_owned();
            inner.infisical_calls.push(format!("{verb} {key}"));
            if verb == "PATCH" && !inner.infisical.contains_key(&key) {
                return reply(StatusCode::NOT_FOUND, json!({ "message": "missing" }));
            }
            let value = body["secretValue"].as_str().unwrap_or_default().to_owned();
            inner.infisical.insert(key, value);
            reply(StatusCode::OK, json!({ "secret": {} }))
        }
        _ => reply(
            StatusCode::FORBIDDEN,
            json!({ "errors": ["permission denied"] }),
        ),
    }
}

async fn serve(fake: Fake) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().fallback(handle).with_state(fake);
    tokio::spawn(async move {
        axum::serve(listener, app).await.ok();
    });
    format!("http://{addr}")
}

fn actor() -> AuditActor {
    AuditActor::new("operator", None)
}

fn ctx() -> SecretResolutionContext {
    SecretResolutionContext::node_only("node-1", Vec::new())
}

fn node(environment: &str, path: &str, name: &str) -> SecretCoords {
    SecretCoords {
        scope: SecretScope::Node,
        scope_id: "node-1".into(),
        environment: environment.into(),
        path: path.into(),
        binding: None,
        name: name.into(),
    }
}

async fn write(store: &PluginSecretStore, coords: SecretCoords, value: &str) -> Result<()> {
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
        .map(|_| ())
}

async fn bao_store(store: &PluginSecretStore, address: &str) -> StoreRecord {
    let input: StoreInput = serde_json::from_value(json!({
        "name": "bao",
        "kind": "openbao",
        "address": address,
        "namespace": "team-a",
        "authMethod": "approle",
        "mount": "secret",
        "credentials": { "roleId": "role", "secretId": "s3cret" },
    }))
    .unwrap();
    store.external_store_create(input, &actor()).await.unwrap()
}

async fn source(
    store: &PluginSecretStore,
    store_id: &str,
    path: &str,
    remote: &str,
    extra: Value,
) -> SourceRecord {
    let mut body = json!({
        "storeId": store_id,
        "environment": "default",
        "path": path,
        "remotePath": remote,
        "mode": "live",
    });
    for (key, value) in extra.as_object().unwrap() {
        body[key] = value.clone();
    }
    store
        .external_source_create(serde_json::from_value(body).unwrap(), "node-1", &actor())
        .await
        .unwrap()
}

async fn audit_rows(store: &PluginSecretStore) -> Vec<crate::vault::audit::AuditRow> {
    let conn = store.conn.lock().await;
    crate::vault::audit::list(
        &conn,
        &AuditFilter {
            limit: 500,
            ..AuditFilter::default()
        },
    )
    .unwrap()
}

fn is_conflict(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<VaultError>(),
        Some(VaultError::Conflict(_))
    )
}

#[tokio::test]
async fn store_credentials_are_sealed_and_never_listed() {
    let store = PluginSecretStore::in_memory().unwrap();
    let record = bao_store(&store, "http://127.0.0.1:1").await;
    let listed = serde_json::to_string(&store.external_store_list().await.unwrap()).unwrap();
    assert!(listed.contains("\"bao\""));
    assert!(!listed.contains("s3cret"), "credentials leaked: {listed}");
    let conn = store.conn.lock().await;
    let (ciphertext, key_version): (Vec<u8>, u32) = conn
        .query_row(
            "SELECT ciphertext, key_version FROM vault_external_stores WHERE id = ?1",
            params![record.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(!String::from_utf8_lossy(&ciphertext).contains("s3cret"));
    assert_eq!(key_version, store.keyring.active_version());
    assert!(crate::vault::ENCRYPTED_TABLES.contains(&"vault_external_stores"));
    // The keyring rotation path rewraps the sealed credentials.
    store.keyring.rotate(&conn).unwrap();
    drop(conn);
    store.rewrap_all(&actor()).await.unwrap();
    let (_, credentials) = store.external_connection(&record.id).await.unwrap();
    assert_eq!(credentials.secret_id.as_deref(), Some("s3cret"));
    assert_eq!(format!("{credentials:?}"), "StoreCredentials(<redacted>)");
}

#[tokio::test]
async fn store_input_is_validated() {
    let store = PluginSecretStore::in_memory().unwrap();
    let cases = [
        json!({ "name": "x", "kind": "openbao", "address": "http://vault.example.com",
                "authMethod": "token", "credentials": { "token": "t" } }),
        json!({ "name": "x", "kind": "openbao", "address": "https://169.254.169.254",
                "authMethod": "token", "credentials": { "token": "t" } }),
        json!({ "name": "x", "kind": "openbao", "address": "https://vault.example.com",
                "authMethod": "approle", "credentials": { "roleId": "r" } }),
        json!({ "name": "x", "kind": "infisical", "address": "https://app.infisical.com",
                "authMethod": "approle", "projectId": "p", "infisicalEnvironment": "prod",
                "credentials": { "roleId": "r", "secretId": "s" } }),
        json!({ "name": "x", "kind": "infisical", "address": "https://app.infisical.com",
                "authMethod": "universal-auth",
                "credentials": { "clientId": "c", "clientSecret": "s" } }),
        json!({ "name": "Bad Name", "kind": "openbao", "address": "https://vault.example.com",
                "authMethod": "token", "credentials": { "token": "t" } }),
        json!({ "name": "x", "kind": "openbao", "address": "https://vault.example.com",
                "authMethod": "token", "mount": "../sys", "credentials": { "token": "t" } }),
        // The Kubernetes token location is operator configuration, never input.
        json!({ "name": "x", "kind": "openbao", "address": "https://vault.example.com",
                "authMethod": "kubernetes", "role": "ryu",
                "jwtPath": "/home/user/.ssh/id_ed25519" }),
    ];
    for case in cases {
        let input: StoreInput = serde_json::from_value(case.clone()).unwrap();
        let error = store
            .external_store_create(input, &actor())
            .await
            .unwrap_err();
        assert!(
            matches!(
                error.downcast_ref::<VaultError>(),
                Some(VaultError::Invalid(_))
            ),
            "{case}: {error:#}"
        );
    }
}

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

fn destination_input(store_id: &str, path: &str, remote: &str) -> DestinationInput {
    serde_json::from_value(json!({
        "storeId": store_id, "environment": "default", "path": path, "remotePath": remote,
    }))
    .unwrap()
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

#[tokio::test]
async fn kv_v1_with_kubernetes_auth_reads_and_writes_with_the_namespace() {
    let fake = Fake::default();
    fake.with(|f| {
        f.kv.insert("apps/db".into(), json!({ "PASSWORD": VALUE }));
    });
    let dir = tempfile::tempdir().unwrap();
    let jwt_path = dir.path().join("token");
    std::fs::write(&jwt_path, format!("{K8S_JWT}\n")).unwrap();
    std::env::set_var(client::ENV_K8S_JWT_PATH, &jwt_path);
    let store = PluginSecretStore::in_memory().unwrap();
    let input: StoreInput = serde_json::from_value(json!({
        "name": "k8s",
        "kind": "hashicorp-vault",
        "address": serve(fake.clone()).await,
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
    std::fs::write(&jwt_path, "-----BEGIN OPENSSH PRIVATE KEY-----").unwrap();
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
}
