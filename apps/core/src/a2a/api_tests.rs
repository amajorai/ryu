//! A2A server settings through the shipping management and public routers:
//! only the default tenant is configurable, invalid limits are refused, and a
//! saved configuration persists (a reopened store reads it) and decides whether
//! this node publishes its Agent Card. The process runtime is pointed at a
//! private store by [`super::test_support`].
use super::test_support;
use axum::{body::Body, http::Request, http::StatusCode, Router};
use ryu_a2a::A2aStore;
use serde_json::{json, Value};
use tower::ServiceExt;

struct Harness {
    _directory: tempfile::TempDir,
    router: Router,
}

impl Harness {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let state = crate::server::isolated_plugin_hook_test_state(directory.path());
        let router = super::management_routes()
            .merge(super::public_routes())
            .with_state(state);
        Self {
            _directory: directory,
            router,
        }
    }

    async fn send(&self, method: &str, uri: &str, body: Option<&Value>) -> (StatusCode, Value) {
        let request = Request::builder().method(method).uri(uri);
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_string())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn settings(&self) -> Value {
        let (status, body) = self.send("GET", "/api/a2a/settings", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    async fn put_settings(&self, body: &Value) -> (StatusCode, Value) {
        self.send("PUT", "/api/a2a/settings", Some(body)).await
    }

    async fn agent_card(&self) -> (StatusCode, Value) {
        self.send("GET", "/.well-known/agent-card.json", None).await
    }
}

fn config(enabled: bool) -> Value {
    json!({
        "tenantId": "default",
        "enabled": enabled,
        "displayName": "Ryu Test Node",
        "description": "Answers A2A tasks in tests",
        "publicBaseUrl": "https://agent.example.com",
        "exposeExtendedCard": false,
        "maxPayloadBytes": 2048,
        "maxConcurrentTasks": 4,
        "requireSignedPeerCards": true,
        "updatedAt": "",
    })
}

#[tokio::test]
async fn settings_persist_reject_other_tenants_and_decide_card_publication() {
    let _serial = test_support::SERIAL.lock().await;
    let (_runtime, path) = test_support::runtime();
    let harness = Harness::new();
    let disabled = config(false);
    let (status, _) = harness.put_settings(&disabled).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(harness.agent_card().await.0, StatusCode::NOT_FOUND);

    // Another tenant, or limits outside their bounds, are refused unsaved.
    let mut other_tenant = config(true);
    other_tenant["tenantId"] = json!("acme");
    let mut huge_payload = config(true);
    huge_payload["maxPayloadBytes"] = json!(64 * 1024 * 1024);
    let mut no_tasks = config(true);
    no_tasks["maxConcurrentTasks"] = json!(0);
    let mut plain_http = config(true);
    plain_http["publicBaseUrl"] = json!("http://agent.example.com");
    for refused in [other_tenant, huge_payload, no_tasks, plain_http] {
        let (status, body) = harness.put_settings(&refused).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused} -> {body}");
    }
    let reopened = A2aStore::open(path, test_support::cipher()).unwrap();
    assert!(!reopened.server_config("default").unwrap().enabled);
    assert!(!reopened.server_config("acme").unwrap().enabled);
    assert_eq!(harness.settings().await["enabled"], false);
    assert_eq!(harness.agent_card().await.0, StatusCode::NOT_FOUND);

    // A valid save persists and reads back.
    let (status, saved) = harness.put_settings(&config(true)).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_ne!(saved["updatedAt"], "", "the store stamps the save");
    let read = harness.settings().await;
    assert_eq!(read, saved);
    for field in [
        "enabled",
        "displayName",
        "publicBaseUrl",
        "maxPayloadBytes",
        "maxConcurrentTasks",
        "requireSignedPeerCards",
    ] {
        assert_eq!(read[field], config(true)[field], "{field}");
    }
    let stored = A2aStore::open(path, test_support::cipher())
        .unwrap()
        .server_config("default")
        .unwrap();
    assert!(stored.enabled);
    assert_eq!(stored.max_concurrent_tasks, 4);
    assert_eq!(
        stored.public_base_url.as_deref(),
        Some("https://agent.example.com")
    );

    // And takes effect: the node now publishes its card from the saved values.
    let (status, card) = harness.agent_card().await;
    assert_eq!(status, StatusCode::OK, "{card}");
    assert_eq!(card["name"], "Ryu Test Node");
    assert_eq!(
        card["supportedInterfaces"][0]["url"],
        "https://agent.example.com/a2a"
    );

    // Turning it off withdraws the card again.
    let (status, _) = harness.put_settings(&disabled).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(harness.agent_card().await.0, StatusCode::NOT_FOUND);
}
