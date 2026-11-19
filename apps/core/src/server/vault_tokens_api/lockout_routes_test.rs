//! Login lockout layer tests against an in-memory store.

use super::*;
use crate::vault::machine::AuthMethod;

fn login(path: &str, body: Value) -> Request {
    axum::http::Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

async fn store_with_identity() -> (PluginSecretStore, String) {
    let store = PluginSecretStore::in_memory().unwrap();
    let identity = store
        .machine_create(
            "ci",
            AuthMethod::AppRole {
                role_id: String::new(),
            },
            vec!["default".into()],
            Some(600),
            &AuditActor::system(),
        )
        .await
        .unwrap();
    let AuthMethod::AppRole { role_id } = identity.auth else {
        panic!("approle")
    };
    store
        .lockout_set_config(
            &LockoutConfig {
                threshold: 2,
                ..LockoutConfig::default()
            },
            &AuditActor::system(),
        )
        .await
        .unwrap();
    (store, role_id)
}

#[test]
fn login_bodies_name_their_principal() {
    let post = Method::POST;
    let body = |value: Value| value.to_string().into_bytes();
    assert_eq!(
        login_principal(
            &post,
            "/api/vault/auth/approle/login",
            &body(json!({ "roleId": "r1" }))
        ),
        Some(LoginPrincipal::RoleId("r1".into()))
    );
    assert_eq!(
        login_principal(
            &post,
            "/v1/auth/approle/login",
            &body(json!({ "role_id": "r1" }))
        ),
        Some(LoginPrincipal::RoleId("r1".into()))
    );
    assert_eq!(
        login_principal(&post, "/v1/auth/jwt/login", &body(json!({ "role": "ci" }))),
        Some(LoginPrincipal::Identity("ci".into()))
    );
    for path in [
        "/api/vault/auth/jwt/login",
        "/api/vault/auth/cert/login",
        "/api/vault/auth/aws/login",
        "/api/vault/auth/kubernetes/login",
    ] {
        assert_eq!(
            login_principal(&post, path, &body(json!({ "identity": "ci" }))),
            Some(LoginPrincipal::Identity("ci".into())),
            "{path}"
        );
    }
    assert_eq!(
        login_principal(
            &Method::GET,
            "/api/vault/auth/jwt/login",
            &body(json!({ "identity": "ci" }))
        ),
        None
    );
    assert_eq!(
        login_principal(&post, "/api/vault/auth/jwt/login", b"not json"),
        None
    );
    assert_eq!(
        login_principal(
            &post,
            "/api/vault/secrets",
            &body(json!({ "identity": "ci" }))
        ),
        None
    );
}

#[tokio::test]
async fn refused_logins_lock_and_the_locked_identity_is_refused_first() {
    let (store, role_id) = store_with_identity().await;
    let native = || {
        login(
            "/api/vault/auth/approle/login",
            json!({ "roleId": role_id, "secretId": "x" }),
        )
    };

    // The request passes through with its body intact.
    let (request, principal) = before_login(&store, native()).await.unwrap();
    let bytes = axum::body::to_bytes(request.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["roleId"],
        role_id.as_str()
    );
    // Bad requests and outages do not count; refusals do.
    after_login(&store, principal.clone(), StatusCode::BAD_REQUEST).await;
    after_login(&store, principal.clone(), StatusCode::SERVICE_UNAVAILABLE).await;
    after_login(&store, principal.clone(), StatusCode::FORBIDDEN).await;
    assert!(before_login(&store, native()).await.is_ok());
    after_login(&store, principal, StatusCode::UNAUTHORIZED).await;

    let refused = before_login(&store, native()).await.unwrap_err();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert!(refused
        .headers()
        .contains_key(axum::http::header::RETRY_AFTER));
    // The body is the route's ordinary bad-credential refusal.
    let body = axum::body::to_bytes(refused.into_body(), 1024)
        .await
        .unwrap();
    assert!(
        String::from_utf8_lossy(&body).contains("invalid role id or secret id"),
        "{}",
        String::from_utf8_lossy(&body)
    );
    let named = before_login(
        &store,
        login(
            "/api/vault/auth/kubernetes/login",
            json!({ "identity": "ci", "jwt": "x" }),
        ),
    )
    .await
    .unwrap_err();
    let body = axum::body::to_bytes(named.into_body(), 1024).await.unwrap();
    assert!(String::from_utf8_lossy(&body).contains("login rejected"));
    // The `/v1` surface gets Vault's opaque refusal for the same identity.
    let compat = before_login(
        &store,
        login("/v1/auth/jwt/login", json!({ "role": "ci", "jwt": "x" })),
    )
    .await
    .unwrap_err();
    assert_eq!(compat.status(), StatusCode::FORBIDDEN);
    let body = axum::body::to_bytes(compat.into_body(), 1024)
        .await
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({ "errors": ["permission denied"] })
    );

    store
        .lockout_unlock("ci", &AuditActor::system())
        .await
        .unwrap();
    let (_, principal) = before_login(&store, native()).await.unwrap();
    after_login(&store, principal, StatusCode::OK).await;
    assert!(store.lockout_list().await.unwrap().is_empty());
}

#[tokio::test]
async fn other_routes_pass_untouched() {
    let (store, _) = store_with_identity().await;
    let request = axum::http::Request::builder()
        .method("GET")
        .uri("/api/vault/agent/self/lookup")
        .body(Body::empty())
        .unwrap();
    let (_, principal) = before_login(&store, request).await.unwrap();
    assert_eq!(principal, None);
}
