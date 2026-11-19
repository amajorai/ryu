//! Session history, relabeling, and never-expiring mints over the shipping
//! router. The handlers read the process-global vault store, so every label
//! here is unique and effects are read back through the routes.

use std::sync::OnceLock;

use axum::body::Body;
use tower::ServiceExt;

use super::*;
use crate::vault::broker::services::test_service;
use crate::vault::policy::PolicyRule;

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}{}",
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    )
}

fn vault() -> &'static PluginSecretStore {
    crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
    crate::plugin_secrets::global().unwrap()
}

fn state() -> ServerState {
    static STATE: OnceLock<(tempfile::TempDir, ServerState)> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let directory = tempfile::tempdir().unwrap();
            let state = crate::server::isolated_plugin_hook_test_state(directory.path());
            (directory, state)
        })
        .1
        .clone()
}

async fn send(method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    vault();
    let mut request = axum::http::Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = routes()
        .layer(axum::Extension(None::<VerifiedCaller>))
        .with_state(state())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .unwrap();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn with_service() -> String {
    let name = unique("svc-");
    let conn = vault().conn.lock().await;
    services::insert(
        &conn,
        test_service(&name, &format!("{name}.example.com"), None, "/"),
    )
    .unwrap();
    name
}

#[tokio::test]
async fn sessions_never_expire_get_relabeled_and_stay_in_history() {
    let service = with_service().await;
    let label = unique("label-");
    let (status, minted) = send(
        "POST",
        "/api/vault/broker/sessions",
        Some(json!({ "services": [service], "label": label, "neverExpires": true })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{minted}");
    let id = minted["session"]["id"].as_str().unwrap().to_owned();
    // Timestamps render as RFC 3339: the last millisecond of year 9999.
    assert_eq!(
        minted["session"]["expiresAt"],
        json!("9999-12-31T23:59:59.999+00:00")
    );

    let (status, listed) = send(
        "GET",
        &format!("/api/vault/broker/sessions?label={label}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed["sessions"][0]["id"], json!(id));
    assert_eq!(listed["sessions"][0]["neverExpires"], json!(true));
    assert_eq!(listed["sessions"][0]["status"], json!("live"));

    let relabeled = unique("relabeled-");
    let (status, _) = send(
        "PATCH",
        &format!("/api/vault/broker/sessions/{id}"),
        Some(json!({ "label": relabeled })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send("DELETE", &format!("/api/vault/broker/sessions/{id}"), None).await;
    assert_eq!(status, StatusCode::OK);

    let (status, history) = send(
        "GET",
        &format!("/api/vault/broker/sessions/history?label={relabeled}"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{history}");
    assert_eq!(history["sessions"][0]["id"], json!(id));
    assert_eq!(history["sessions"][0]["status"], json!("revoked"));
    assert!(history["sessions"][0].get("token").is_none());
    let (_, live) = send(
        "GET",
        &format!("/api/vault/broker/sessions?label={relabeled}"),
        None,
    )
    .await;
    assert_eq!(live["sessions"], json!([]));

    let (status, _) = send(
        "PATCH",
        "/api/vault/broker/sessions/bvs_missing",
        Some(json!({ "label": "x" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_never_sentinel_is_refused_as_a_raw_ttl_and_with_a_ttl() {
    let service = with_service().await;
    for body in [
        json!({ "services": [service], "ttlSecs": sessions::TTL_NEVER }),
        json!({ "services": [service], "ttlSecs": 600, "neverExpires": true }),
    ] {
        let (status, error) = send("POST", "/api/vault/broker/sessions", Some(body)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{error}");
    }
}

#[test]
fn never_expiring_sessions_need_broker_admin() {
    let store: &'static PluginSecretStore =
        Box::leak(Box::new(PluginSecretStore::in_memory().unwrap()));
    let ctx = |rules: Vec<PolicyRule>| Ctx {
        store,
        node: None,
        node_id: crate::vault::broker::local_node_id(),
        caller: None,
        manager: false,
        policies: vec![Policy {
            name: "p".into(),
            description: String::new(),
            rules,
        }],
        jwt: None,
    };
    let never = SessionBody {
        never_expires: true,
        ..SessionBody::default()
    };
    let user = ctx(vec![PolicyRule {
        path: "sys/broker/gh".into(),
        capabilities: vec![Capability::Use],
        ..Default::default()
    }]);
    assert_eq!(
        human_ttl(&user, &never).unwrap_err().status(),
        StatusCode::FORBIDDEN
    );
    let admin = ctx(vec![PolicyRule {
        path: "sys/broker".into(),
        capabilities: vec![Capability::Admin],
        ..Default::default()
    }]);
    assert_eq!(
        human_ttl(&admin, &never).unwrap(),
        Some(sessions::TTL_NEVER)
    );
    let timed = SessionBody {
        ttl_secs: Some(600),
        ..SessionBody::default()
    };
    assert_eq!(human_ttl(&user, &timed).unwrap(), Some(600));
}
