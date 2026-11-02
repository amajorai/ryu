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

fn destination_input(store_id: &str, path: &str, remote: &str) -> DestinationInput {
    serde_json::from_value(json!({
        "storeId": store_id, "environment": "default", "path": path, "remotePath": remote,
    }))
    .unwrap()
}

#[path = "destinations_test.rs"]
mod destinations_test;
#[path = "sources_test.rs"]
mod sources_test;

#[path = "k8s_origin_tests.rs"]
mod k8s_origin_tests;
