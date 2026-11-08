use std::sync::{Arc, Mutex};

use axum::http::{HeaderMap, Method, StatusCode, Uri};
use serde_json::{json, Value};

use super::ai_keys::{hint_matches, AI_ENDPOINT};
use super::*;
use crate::plugin_secrets::{PluginSecretStore, SecretScope};
use crate::vault::audit::AuditActor;

const OPENAI_ADMIN: &str = "sk-admin-test-openai-admin-key";
const ANTHROPIC_ADMIN: &str = "sk-ant-admin01-test-anthropic-admin";

fn target() -> SecretCoords {
    SecretCoords::root(SecretScope::Node, "local", None, "AI_API_KEY")
}

/// One fake for both vendors' Admin APIs.
#[derive(Default)]
struct FakeVendor {
    /// OpenAI service accounts still present.
    service_accounts: Vec<String>,
    created: usize,
    fail_delete: bool,
    /// Anthropic keys: (id, full key, status).
    keys: Vec<(String, String, String)>,
    fail_list: bool,
    /// Credentials sent to the Admin APIs.
    auth: Vec<String>,
    /// Keys the staged-key probe (`GET /v1/models`) was called with.
    probes: Vec<String>,
}

fn hint(key: &str) -> String {
    format!("{}...{}", &key[..12], &key[key.len() - 4..])
}

async fn fake_vendor() -> Arc<Mutex<FakeVendor>> {
    let fake = Arc::new(Mutex::new(FakeVendor::default()));
    let state = fake.clone();
    let handler = move |method: Method, uri: Uri, headers: HeaderMap, body: String| {
        let state = state.clone();
        async move {
            let mut vendor = state.lock().unwrap();
            let path = uri.path().to_owned();
            let segments: Vec<&str> = path.trim_matches('/').split('/').collect();
            let reply = |status: StatusCode, body: Value| (status, axum::Json(body));
            if (method.as_str(), segments.as_slice()) == ("GET", ["v1", "models"].as_slice()) {
                let key = headers
                    .get("x-api-key")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_owned();
                vendor.probes.push(key.clone());
                let live = vendor
                    .keys
                    .iter()
                    .any(|(_, full, status)| full == &key && status == "active");
                return if live {
                    reply(StatusCode::OK, json!({ "data": [], "has_more": false }))
                } else {
                    reply(
                        StatusCode::UNAUTHORIZED,
                        json!({ "error": { "type": "authentication_error",
                            "message": format!("invalid x-api-key {key}") } }),
                    )
                };
            }
            for name in ["authorization", "x-api-key"] {
                if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
                    vendor.auth.push(value.to_owned());
                }
            }
            match (method.as_str(), segments.as_slice()) {
                ("POST", ["v1", "organization", "projects", _, "service_accounts"]) => {
                    vendor.created += 1;
                    let id = format!("svc_acct_{}", vendor.created);
                    vendor.service_accounts.push(id.clone());
                    let name = serde_json::from_str::<Value>(&body).unwrap()["name"].clone();
                    reply(
                        StatusCode::CREATED,
                        json!({ "id": id, "name": name, "api_key": {
                            "id": format!("key_{}", vendor.created),
                            "value": format!("sk-svcacct-secret-{}", vendor.created),
                        }}),
                    )
                }
                ("DELETE", ["v1", "organization", "projects", _, "service_accounts", id]) => {
                    if vendor.fail_delete {
                        return reply(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            json!({ "error": { "type": "server_error",
                                "message": format!("leaked {OPENAI_ADMIN}") } }),
                        );
                    }
                    let id = (*id).to_owned();
                    if vendor.service_accounts.contains(&id) {
                        vendor.service_accounts.retain(|sa| sa != &id);
                        reply(StatusCode::OK, json!({ "deleted": true }))
                    } else {
                        reply(
                            StatusCode::NOT_FOUND,
                            json!({ "error": { "type": "not_found" } }),
                        )
                    }
                }
                ("GET", ["v1", "organizations", "api_keys"]) => {
                    if vendor.fail_list {
                        return reply(
                            StatusCode::UNAUTHORIZED,
                            json!({ "error": { "type": "authentication_error",
                                "message": format!("bad key {ANTHROPIC_ADMIN}") } }),
                        );
                    }
                    let data: Vec<Value> = vendor
                        .keys
                        .iter()
                        .filter(|(_, _, status)| status == "active")
                        .map(|(id, key, status)| {
                            json!({ "id": id, "partial_key_hint": hint(key), "status": status })
                        })
                        .collect();
                    reply(StatusCode::OK, json!({ "data": data, "has_more": false }))
                }
                ("POST", ["v1", "organizations", "api_keys", id]) => {
                    let status = serde_json::from_str::<Value>(&body).unwrap()["status"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    match vendor.keys.iter_mut().find(|(key_id, _, _)| key_id == id) {
                        Some(entry) => {
                            entry.2 = status;
                            reply(StatusCode::OK, json!({ "id": id }))
                        }
                        None => reply(StatusCode::NOT_FOUND, json!({})),
                    }
                }
                _ => reply(
                    StatusCode::BAD_REQUEST,
                    json!({ "error": { "type": "bad" } }),
                ),
            }
        }
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, axum::Router::new().fallback(handler))
            .await
            .ok();
    });
    AI_ENDPOINT.with(|cell| *cell.borrow_mut() = Some(format!("http://{addr}")));
    fake
}

fn openai_input() -> StaticRoleInput {
    serde_json::from_value(json!({
        "provider": { "kind": "openai", "adminApiKey": OPENAI_ADMIN, "projectId": "proj_abc123" },
        "rotationPeriodSecs": 86400,
    }))
    .unwrap()
}

fn anthropic_input(replacement: Option<&str>) -> StaticRoleInput {
    serde_json::from_value(json!({
        "provider": { "kind": "anthropic", "adminApiKey": ANTHROPIC_ADMIN,
                      "replacementApiKey": replacement },
        "rotationPeriodSecs": 86400,
    }))
    .unwrap()
}

#[test]
fn ai_providers_validate_their_configuration() {
    assert!(openai_input().provider.validate().is_ok());
    assert!(anthropic_input(Some("sk-ant-api03-abcdefgh"))
        .provider
        .validate()
        .is_ok());
    for bad in [
        json!({ "kind": "openai", "adminApiKey": "", "projectId": "proj_a" }),
        json!({ "kind": "openai", "adminApiKey": "k", "projectId": "abc" }),
        json!({ "kind": "openai", "adminApiKey": "k", "projectId": "proj_a",
                "serviceAccountName": "has space" }),
        json!({ "kind": "anthropic", "adminApiKey": "sk-ant-api03-notadmin" }),
        json!({ "kind": "anthropic", "adminApiKey": ANTHROPIC_ADMIN,
                "replacementApiKey": "sk-ant-admin01-other" }),
        json!({ "kind": "anthropic", "adminApiKey": ANTHROPIC_ADMIN,
                "replacementApiKey": "not-a-key" }),
    ] {
        let provider: StaticProvider = serde_json::from_value(bad.clone()).unwrap();
        assert!(provider.validate().is_err(), "{bad}");
    }
    // Listings never carry the admin key or a staged key.
    let summary = anthropic_input(Some("sk-ant-api03-abcdefgh"))
        .provider
        .summary();
    assert_eq!(summary["replacementStaged"], true);
    assert!(!summary.to_string().contains("sk-ant"));
    assert!(!openai_input()
        .provider
        .summary()
        .to_string()
        .contains(OPENAI_ADMIN));
}

#[test]
fn partial_key_hints_match_only_their_key() {
    let key = "sk-ant-api03-R2D2abcdefghijklmnopigAA";
    assert!(hint_matches("sk-ant-api03...igAA", key));
    assert!(!hint_matches("sk-ant-api03...xxAA", key));
    assert!(!hint_matches("sk-ant...igAA", key), "too short a prefix");
    assert!(!hint_matches("sk-ant-api03-R2D2", key), "no ellipsis");
}

#[tokio::test]
async fn openai_rotations_mint_service_accounts_and_delete_the_previous_one() {
    let vendor = fake_vendor().await;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("openai", &openai_input(), target(), &actor)
        .await
        .unwrap();
    let info = store.static_rotate("openai", &actor).await.unwrap();
    assert_eq!(info.provider, "openai");
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "sk-svcacct-secret-1"
    );

    // The previous service account cannot be deleted: kept and retried.
    vendor.lock().unwrap().fail_delete = true;
    let info = store.static_rotate("openai", &actor).await.unwrap();
    let error = info.last_error.unwrap();
    assert!(error.contains("svc_acct_1") && error.contains("server_error"));
    assert!(
        !error.contains(OPENAI_ADMIN),
        "no upstream body in lastError"
    );
    assert_eq!(
        store.reveal(&target(), None, &actor).await.unwrap(),
        "sk-svcacct-secret-2"
    );
    let (_, state) = store.static_state("openai").await.unwrap();
    assert_eq!(state.retired_access_keys, ["svc_acct_1"]);
    assert_eq!(
        state.provider.current_key_id().as_deref(),
        Some("svc_acct_2")
    );

    vendor.lock().unwrap().fail_delete = false;
    let info = store.static_rotate("openai", &actor).await.unwrap();
    assert!(info.last_error.is_none());
    assert_eq!(vendor.lock().unwrap().service_accounts, ["svc_acct_3"]);
    assert_eq!(store.list_versions(&target()).await.unwrap().len(), 3);
    let auth = vendor.lock().unwrap().auth.clone();
    assert!(auth
        .iter()
        .all(|value| value == &format!("Bearer {OPENAI_ADMIN}")));
    AI_ENDPOINT.with(|cell| *cell.borrow_mut() = None);
}

#[tokio::test]
async fn anthropic_rotations_adopt_the_staged_key_and_deactivate_the_previous_one() {
    let vendor = fake_vendor().await;
    let first = "sk-ant-api03-FIRSTkeyvalue0000aaaa";
    let second = "sk-ant-api03-SECONDkeyvalue111bbbb";
    vendor.lock().unwrap().keys = vec![
        ("apikey_1".into(), first.into(), "active".into()),
        ("apikey_2".into(), second.into(), "active".into()),
    ];
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();

    // Nothing staged: the rotation fails and writes nothing.
    store
        .static_put_role("claude", &anthropic_input(None), target(), &actor)
        .await
        .unwrap();
    let error = store.static_rotate("claude", &actor).await.unwrap_err();
    assert!(error.to_string().contains("replacementApiKey"));
    assert!(store.reveal(&target(), None, &actor).await.is_err());

    store
        .static_put_role("claude", &anthropic_input(Some(first)), target(), &actor)
        .await
        .unwrap();
    let info = store.static_rotate("claude", &actor).await.unwrap();
    assert_eq!(
        info.summary["replacementStaged"], false,
        "the staged key is consumed"
    );
    assert_eq!(store.reveal(&target(), None, &actor).await.unwrap(), first);

    // The same key again is refused; the value stays.
    store
        .static_put_role("claude", &anthropic_input(Some(first)), target(), &actor)
        .await
        .unwrap();
    assert!(store.static_rotate("claude", &actor).await.is_err());
    // A key the Admin API cannot see is refused too.
    store
        .static_put_role(
            "claude",
            &anthropic_input(Some("sk-ant-api03-UNKNOWNkey99zzzz")),
            target(),
            &actor,
        )
        .await
        .unwrap();
    assert!(store.static_rotate("claude", &actor).await.is_err());
    assert_eq!(store.reveal(&target(), None, &actor).await.unwrap(), first);

    // An edit without a key keeps a staged one; the rotation deactivates
    // the previous key.
    store
        .static_put_role("claude", &anthropic_input(Some(second)), target(), &actor)
        .await
        .unwrap();
    store
        .static_put_role("claude", &anthropic_input(None), target(), &actor)
        .await
        .unwrap();
    let info = store.static_rotate("claude", &actor).await.unwrap();
    assert!(info.last_error.is_none());
    assert_eq!(store.reveal(&target(), None, &actor).await.unwrap(), second);
    let keys = vendor.lock().unwrap().keys.clone();
    assert_eq!(keys[0].2, "inactive");
    assert_eq!(keys[1].2, "active");
    let auth = vendor.lock().unwrap().auth.clone();
    assert!(auth.iter().all(|value| value == ANTHROPIC_ADMIN));
    let probes = vendor.lock().unwrap().probes.clone();
    assert_eq!(probes, vec![first.to_owned(), second.to_owned()]);
    AI_ENDPOINT.with(|cell| *cell.borrow_mut() = None);
}

#[tokio::test]
async fn anthropic_refuses_a_staged_key_that_matches_the_hint_but_does_not_authenticate() {
    let vendor = fake_vendor().await;
    let first = "sk-ant-api03-FIRSTkeyvalue0000aaaa";
    let second = "sk-ant-api03-SECONDkeyvalue111bbbb";
    // Same prefix and suffix as `second` (so its hint matches), corrupted
    // in the middle.
    let mistyped = "sk-ant-api03-SECONDkeyTYPO0111bbbb";
    assert!(hint_matches(&hint(second), mistyped));
    vendor.lock().unwrap().keys = vec![
        ("apikey_1".into(), first.into(), "active".into()),
        ("apikey_2".into(), second.into(), "active".into()),
    ];
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role("claude", &anthropic_input(Some(first)), target(), &actor)
        .await
        .unwrap();
    store.static_rotate("claude", &actor).await.unwrap();

    store
        .static_put_role("claude", &anthropic_input(Some(mistyped)), target(), &actor)
        .await
        .unwrap();
    let error = store.static_rotate("claude", &actor).await.unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("401"), "{message}");
    assert!(message.contains("authentication_error"), "{message}");
    assert!(!message.contains(mistyped), "{message}");
    assert_eq!(store.reveal(&target(), None, &actor).await.unwrap(), first);
    let keys = vendor.lock().unwrap().keys.clone();
    assert_eq!(keys[0].2, "active", "the working key stays active");
    assert_eq!(keys[1].2, "active");
    AI_ENDPOINT.with(|cell| *cell.borrow_mut() = None);
}

#[tokio::test]
async fn anthropic_upstream_errors_never_echo_the_response_body() {
    let vendor = fake_vendor().await;
    vendor.lock().unwrap().fail_list = true;
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    store
        .static_put_role(
            "claude",
            &anthropic_input(Some("sk-ant-api03-FIRSTkeyvalue0000aaaa")),
            target(),
            &actor,
        )
        .await
        .unwrap();
    let error = store.static_rotate("claude", &actor).await.unwrap_err();
    let message = format!("{error:#}");
    assert!(message.contains("authentication_error"));
    assert!(!message.contains(ANTHROPIC_ADMIN));
    let info = store.static_role("claude").await.unwrap();
    assert!(!info.last_error.unwrap().contains(ANTHROPIC_ADMIN));
    AI_ENDPOINT.with(|cell| *cell.borrow_mut() = None);
}
