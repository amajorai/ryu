//! Control-plane client tests against a scripted fake (`pub(crate)` so the
//! route tests can reuse it).

use super::*;
use std::sync::{Arc, Mutex};

/// One request the fake saw: method, path, gateway key, JSON body.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub method: String,
    pub path: String,
    pub key: Option<String>,
    pub body: Value,
}

type Responder = dyn Fn(&Seen) -> (u16, Value) + Send + Sync;

/// What [`ControlPlane::current`] returns in tests (route tests set it).
pub(crate) static TEST_CLOUD: Mutex<Option<ControlPlane>> = Mutex::new(None);

/// A fake control plane on loopback and the [`ControlPlane`] that reaches it.
pub(crate) async fn fake_cloud(
    respond: impl Fn(&Seen) -> (u16, Value) + Send + Sync + 'static,
) -> (ControlPlane, Arc<Mutex<Vec<Seen>>>) {
    use axum::body::Bytes;
    use axum::http::{HeaderMap, Method, StatusCode, Uri};
    let log: Arc<Mutex<Vec<Seen>>> = Arc::default();
    let respond: Arc<Responder> = Arc::new(respond);
    let recorded = log.clone();
    let app = axum::Router::new().fallback(
        move |method: Method, uri: Uri, headers: HeaderMap, body: Bytes| {
            let recorded = recorded.clone();
            let respond = respond.clone();
            async move {
                let seen = Seen {
                    method: method.to_string(),
                    path: uri.path().to_owned(),
                    key: headers
                        .get("x-gateway-key")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_owned),
                    body: serde_json::from_slice(&body).unwrap_or(Value::Null),
                };
                let (status, value) = respond(&seen);
                recorded.lock().unwrap().push(seen);
                (StatusCode::from_u16(status).unwrap(), axum::Json(value))
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (
        ControlPlane {
            base_url: format!("http://{address}"),
            gateway_key: "rgw_node".into(),
        },
        log,
    )
}

#[tokio::test]
async fn links_are_created_and_revoked_with_the_node_key() {
    let (cloud, log) = fake_cloud(|seen| match seen.method.as_str() {
        "POST" => (
            201,
            json!({ "id": "vs_1", "url": "https://ryu.example/secret/tok", "expiresAt": "2026-11-10T00:00:00.000Z" }),
        ),
        "DELETE" => (200, json!({ "revoked": true })),
        _ => (200, json!({ "state": "open" })),
    })
    .await;
    let created = create(&cloud, json!({ "kind": "share", "ciphertext": "abc" }))
        .await
        .unwrap();
    assert_eq!(created.id, "vs_1");
    assert_eq!(status(&cloud, "vs_1").await.unwrap()["state"], "open");
    assert!(revoke(&cloud, "vs_1").await.unwrap());
    let log = log.lock().unwrap().clone();
    assert_eq!(log[0].path, "/api/control-plane/gateway/vault/shares");
    assert_eq!(log[0].key.as_deref(), Some("rgw_node"));
    assert_eq!(log[0].body["kind"], "share");
    assert_eq!(log[2].path, "/api/control-plane/gateway/vault/shares/vs_1");
}

#[tokio::test]
async fn collecting_distinguishes_pending_answered_and_spent() {
    let answer = json!({ "epk": "e", "nonce": "n", "ciphertext": "c" });
    let replies = Arc::new(Mutex::new(vec![
        (409, json!({ "state": "open" })),
        (200, json!({ "response": answer })),
        (
            410,
            json!({ "message": "the answer was already collected" }),
        ),
    ]));
    let (cloud, _) = fake_cloud(move |_| replies.lock().unwrap().remove(0)).await;
    assert_eq!(collect(&cloud, "vs_2").await.unwrap(), None);
    assert_eq!(
        collect(&cloud, "vs_2").await.unwrap(),
        Some(SealedAnswer {
            epk: "e".into(),
            nonce: "n".into(),
            ciphertext: "c".into()
        })
    );
    assert!(collect(&cloud, "vs_2").await.is_err());
}

#[tokio::test]
async fn refusals_carry_the_server_message() {
    let (cloud, _) = fake_cloud(|_| (400, json!({ "message": "ttlSecs is invalid" }))).await;
    let error = create(&cloud, json!({})).await.unwrap_err().to_string();
    assert!(
        error.contains("400") && error.contains("ttlSecs is invalid"),
        "{error}"
    );
}
