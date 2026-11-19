//! A static webhook role's account is its full URL and username (identity),
//! while its summary is the URL's origin only (display).

use super::*;
use crate::plugin_secrets::{PluginSecretStore, SecretScope};
use crate::vault::audit::AuditActor;
use serde_json::json;

fn webhook(url: &str) -> StaticProvider {
    serde_json::from_value(json!({
        "kind": "webhook", "url": url,
        "signingSecret": "webhook-signing-secret-0001", "username": "svc"
    }))
    .unwrap()
}

fn input(url: &str) -> StaticRoleInput {
    serde_json::from_value(json!({
        "provider": {
            "kind": "webhook", "url": url,
            "signingSecret": "webhook-signing-secret-0001", "username": "svc"
        },
        "rotationPeriodSecs": 3600,
    }))
    .unwrap()
}

#[test]
fn another_path_on_the_same_host_is_another_account() {
    let a = webhook("https://hooks.example.com/tenantA");
    let b = webhook("https://hooks.example.com/tenantB");
    assert_ne!(a.account(), b.account());
    // The summary shows the origin only, for both.
    assert_eq!(a.summary(), json!({ "url": "https://hooks.example.com", "username": "svc" }));
    assert_eq!(a.summary(), b.summary());
}

#[tokio::test]
async fn a_pending_rotation_still_blocks_a_path_change() {
    // A webhook that refuses every rotation, so one stays pending.
    let app = axum::Router::new().fallback(|| async { axum::http::StatusCode::BAD_GATEWAY });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    let store = PluginSecretStore::in_memory().unwrap();
    let actor = AuditActor::system();
    let target = SecretCoords::root(SecretScope::Node, "local", None, "SVC_PASSWORD");
    store
        .static_put_role("svc", &input(&format!("{base}/tenantA")), target.clone(), &actor)
        .await
        .unwrap();
    assert!(store.static_rotate("svc", &actor).await.is_err());
    let moved = store
        .static_put_role("svc", &input(&format!("{base}/tenantB")), target, &actor)
        .await;
    let error = moved.expect_err("another endpoint is another account");
    assert!(error.to_string().contains("pending rotation"), "{error}");
}

#[test]
fn stored_static_webhook_summaries_are_reduced_to_their_origin_once() {
    let conn = rusqlite::Connection::open_in_memory().unwrap();
    init_schema(&conn).unwrap();
    conn.execute(
        "INSERT INTO vault_static_roles
             (name, provider, summary, target, rotation_period_secs, password_length,
              next_rotation_at, created_at, updated_at, nonce, ciphertext)
         VALUES ('old', 'webhook', ?1, '{}', 3600, 32, 0, 0, 0, x'00', x'00')",
        rusqlite::params![json!({
            "url": "https://u:pw@hooks.example.com/hook/PATHTOKEN?token=QUERYTOKEN",
            "username": "svc"
        })
        .to_string()],
    )
    .unwrap();
    init_schema(&conn).unwrap();
    init_schema(&conn).unwrap();
    let summary: String = conn
        .query_row("SELECT summary FROM vault_static_roles WHERE name = 'old'", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&summary).unwrap(),
        json!({ "url": "https://hooks.example.com", "username": "svc" })
    );
}
