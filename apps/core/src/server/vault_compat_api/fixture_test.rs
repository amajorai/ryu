//! Shared fixture for the `/v1` compat tests: an in-memory store, a `ci`
//! policy, an AppRole identity, and request helpers.

pub(super) use axum::body::Body;
pub(super) use axum::http::{Request, StatusCode};
pub(super) use axum::Router;
pub(super) use serde_json::{json, Value};
pub(super) use std::collections::BTreeMap;
pub(super) use tower::ServiceExt;

pub(super) use super::*;
pub(super) use crate::plugin_secrets::kv::{Environment, ListFilter};
pub(super) use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretScope, VersionSource, WriteRequest,
};
pub(super) use crate::vault::audit::AuditActor;
pub(super) use crate::vault::machine::AuthMethod;
pub(super) use crate::vault::policy::{Capability, Policy, PolicyRule};

pub(super) const NODE: &str = "node-compat-test";

pub(super) struct Fixture {
    pub(super) app: Router,
    pub(super) store: &'static PluginSecretStore,
    pub(super) role_id: String,
    pub(super) secret_id: String,
}

pub(super) async fn fixture(rules: Vec<PolicyRule>) -> Fixture {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let admin = AuditActor::new("user", Some("admin"));
    {
        let conn = store.conn.lock().await;
        crate::vault::policy::put_policy(
            &conn,
            &Policy {
                name: "ci".into(),
                description: String::new(),
                rules,
            },
        )
        .unwrap();
    }
    let identity = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec!["ci".into()],
            Some(600),
            &admin,
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth else {
        panic!("approle identity")
    };
    let (secret_id, _) = store
        .machine_issue_secret_id("ci", None, None, &admin)
        .await
        .unwrap();
    let app = router_with(CompatState {
        store: Some(store),
        node_id: Some(NODE.to_owned()),
    });
    Fixture {
        app,
        store,
        role_id,
        secret_id,
    }
}

pub(super) fn all_caps(path: &str) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: vec![
            Capability::List,
            Capability::Read,
            Capability::Write,
            Capability::Delete,
        ],
        deny: false,
        ..Default::default()
    }
}

pub(super) async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    call_in(app, None, method, uri, token, body).await
}

/// [`call`] with an optional `X-Ryu-Environment` header.
pub(super) async fn call_in(
    app: &Router,
    environment: Option<&str>,
    method: &str,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(token) = token {
        request = request.header("X-Vault-Token", token);
    }
    if let Some(environment) = environment {
        request = request.header("X-Ryu-Environment", environment);
    }
    let body = body.map_or_else(Body::empty, |body| Body::from(body.to_string()));
    let response = app
        .clone()
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, value)
}

pub(super) async fn login(fixture: &Fixture) -> String {
    let (status, body) = call(
        &fixture.app,
        "POST",
        "/v1/auth/approle/login",
        None,
        Some(json!({ "role_id": fixture.role_id, "secret_id": fixture.secret_id })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["auth"]["policies"], json!(["ci"]));
    assert!(body["auth"]["lease_duration"].as_i64().unwrap() > 0);
    body["auth"]["client_token"].as_str().unwrap().to_owned()
}

pub(super) fn rule(path: &str, capabilities: &[Capability], deny: bool) -> PolicyRule {
    PolicyRule {
        path: path.into(),
        capabilities: capabilities.to_vec(),
        deny,
        ..Default::default()
    }
}

pub(super) async fn native_write(
    store: &PluginSecretStore,
    environment: &str,
    path: &str,
    name: &str,
) {
    store
        .write_secret(WriteRequest {
            coords: SecretCoords {
                scope: SecretScope::Node,
                scope_id: NODE.into(),
                environment: environment.into(),
                path: path.into(),
                binding: None,
                name: name.into(),
            },
            value: Some("native"),
            patch: Default::default(),
            actor: &AuditActor::system(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .unwrap();
}

pub(super) async fn put(app: &Router, token: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    call(app, "PUT", uri, Some(token), Some(body)).await
}

pub(super) fn is_cas_error(body: &Value) -> bool {
    body["errors"][0]
        .as_str()
        .is_some_and(|message| message.contains("check-and-set"))
}

/// Seal the fixture's vault in memory (as `POST /api/vault/sys/seal` does).
pub(super) fn seal(fixture: &Fixture) {
    fixture.store.keyring.seal();
}

/// Unseal the fixture's (auto-mode) vault again.
pub(super) async fn unseal(fixture: &Fixture) {
    let conn = fixture.store.conn.lock().await;
    fixture.store.keyring.unseal_auto(&conn).unwrap();
}
