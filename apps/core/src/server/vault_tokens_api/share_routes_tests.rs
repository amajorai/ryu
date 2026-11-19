//! Share and request link routes over the shipping handlers, with a fake
//! Ryu Cloud installed through `TEST_CLOUD`.

use super::*;
use crate::vault::shared::links::client::tests::{fake_cloud, TEST_CLOUD};
use crate::vault::shared::links::tests::browser_seal;
use axum::body::Body;
use std::sync::{Arc, Mutex};
use tower::ServiceExt;

fn unique(prefix: &str) -> String {
    format!(
        "{prefix}_{}",
        uuid::Uuid::new_v4().simple().to_string()[..10].to_uppercase()
    )
}

/// One server state per test process: building it opens the durable agent
/// store under the shared data dir, which concurrent builds would lock.
fn state() -> ServerState {
    static STATE: std::sync::OnceLock<ServerState> = std::sync::OnceLock::new();
    STATE
        .get_or_init(|| {
            crate::plugin_secrets::set_global(
                crate::plugin_secrets::PluginSecretStore::in_memory().unwrap(),
            );
            let directory = Box::leak(Box::new(tempfile::tempdir().unwrap()));
            crate::server::isolated_plugin_hook_test_state(directory.path())
        })
        .clone()
}

async fn send(method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let state = state();
    let mut request = axum::http::Request::builder().method(method).uri(uri);
    let body = match body {
        Some(body) => {
            request = request.header("content-type", "application/json");
            Body::from(body.to_string())
        }
        None => Body::empty(),
    };
    let response = sharing_routes()
        .route(
            "/api/vault/secrets/:name",
            axum::routing::put(crate::server::vault_api::put_secret),
        )
        .layer(axum::Extension(None::<VerifiedCaller>))
        .with_state(state)
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

/// All cloud-backed flows in one test: `TEST_CLOUD` is process-global.
#[tokio::test]
async fn shares_and_requests_round_trip_through_the_routes() {
    crate::sidecar::control_plane::with_test_node_binding(false, None, async {
        // Without Ryu Cloud nothing is revealed or consumed.
        *TEST_CLOUD.lock().unwrap() = None;
        let name = unique("SHARED");
        let (status, _) = send(
            "PUT",
            &format!("/api/vault/secrets/{name}"),
            Some(json!({ "value": "correct-horse" })),
        )
        .await;
        assert!(status.is_success(), "{status}");
        let (status, body) = send("POST", "/api/vault/shares", Some(json!({ "name": name }))).await;
        if status == StatusCode::CONFLICT {
            assert!(body.to_string().contains("vault_share_unavailable"), "{body}");
        }

        let public_key: Arc<Mutex<Option<String>>> = Arc::default();
        let captured = public_key.clone();
        let (cloud, log) = fake_cloud(move |seen| match (seen.method.as_str(), seen.path.as_str()) {
            ("POST", path) if path.ends_with("/collect") => {
                let key = captured.lock().unwrap().clone().unwrap();
                let answer = if path.contains("vc_route") {
                    r#"{"type":"credential","username":"ops-bot","password":"pw-from-browser"}"#
                } else {
                    "sk_live_route"
                };
                (200, json!({ "response": browser_seal(&key, answer) }))
            }
            ("POST", _) => {
                if let Some(key) = seen.body["publicKey"].as_str() {
                    *captured.lock().unwrap() = Some(key.to_owned());
                }
                let id = match (seen.body["kind"].as_str(), seen.body.get("form")) {
                    (Some("request"), Some(_)) => "vc_route",
                    (Some("request"), None) => "vr_route",
                    _ => "vs_route",
                };
                (201, json!({ "id": id, "url": format!("https://ryu.example/x/{id}"), "expiresAt": "2026-11-10T00:00:00.000Z" }))
            }
            _ => (200, json!({ "state": "open", "revoked": true })),
        })
        .await;
        *TEST_CLOUD.lock().unwrap() = Some(cloud);

        // Share an existing value: the URL carries the key, the upload does not.
        let (status, body) = send(
            "POST",
            "/api/vault/shares",
            Some(json!({ "name": name, "label": "Staging", "ttlSecs": 600 })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let url = body["link"]["url"].as_str().unwrap();
        assert!(url.starts_with("https://ryu.example/x/vs_route#"), "{url}");
        let upload = log.lock().unwrap().last().unwrap().body.to_string();
        assert!(!upload.contains("correct-horse"), "{upload}");

        // Ask for a value, then claim the browser's answer into the vault.
        let target = unique("ASKED");
        let (status, body) = send(
            "POST",
            "/api/vault/share-requests",
            Some(json!({ "name": target, "label": "Your API key" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = send("POST", "/api/vault/shares/vr_route/claim", None).await;
        assert!(status.is_success(), "{status} {body}");
        let store = crate::plugin_secrets::global().unwrap();
        let listed = store.share_link_list(None).await.unwrap();
        let claimed = listed.iter().find(|link| link.id == "vr_route").unwrap();
        assert_eq!(claimed.status, "claimed");
        let (status, _) = send("POST", "/api/vault/shares/vr_route/claim", None).await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Ask for an agent's sign-in: the claim saves an agent account and
        // answers with metadata only.
        let (status, body) = send(
            "POST",
            "/api/vault/credential-requests",
            Some(json!({ "agentId": "agent-cred", "site": "github.com", "label": "Release bot", "totp": true })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let upload = log.lock().unwrap().last().unwrap().body.clone();
        assert_eq!(upload["form"]["site"], "https://github.com");
        assert!(!upload.to_string().contains("agent-cred"), "{upload}");
        let (status, body) = send("POST", "/api/vault/shares/vc_route/claim", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["account"]["host"], "github.com");
        assert_eq!(body["account"]["has_password"], true);
        assert!(!body.to_string().contains("pw-from-browser"), "{body}");
        let accounts = crate::vault::agent_accounts::list(store, Some("agent-cred"), None)
            .await
            .unwrap();
        assert_eq!(accounts.len(), 1);

        let (status, body) = send("DELETE", "/api/vault/shares/vs_route", None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = send("GET", "/api/vault/shares", None).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body["links"].as_array().unwrap().len() >= 2);
        *TEST_CLOUD.lock().unwrap() = None;
    })
    .await;
}

#[tokio::test]
async fn malformed_bodies_and_unknown_links_are_refused() {
    let (status, _) = send(
        "POST",
        "/api/vault/shares",
        Some(json!({ "name": "A_KEY", "wrapToken": "rvw_x" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send("POST", "/api/vault/shares", Some(json!({}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send("GET", "/api/vault/shares/nope", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = send("POST", "/api/vault/shares/nope/claim", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A credential request needs a label and a site, and takes nothing else.
    for body in [
        json!({ "site": "github.com" }),
        json!({ "site": "github.com", "label": "x", "password": "no" }),
    ] {
        let (status, _) = send("POST", "/api/vault/credential-requests", Some(body)).await;
        assert!(status.is_client_error(), "{status}");
    }
}
