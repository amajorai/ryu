//! Tests for the provider HTTP helper, plus a scripted fake API server the
//! Kubernetes, GCP, and Azure provider tests share.

use super::*;
use std::sync::{Arc, Mutex};

/// One request the fake server saw.
#[derive(Debug, Clone)]
pub(crate) struct Seen {
    pub method: String,
    /// Path and query.
    pub path: String,
    pub authorization: Option<String>,
    pub body: String,
}

impl Seen {
    pub(crate) fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

type Responder = dyn Fn(&Seen) -> (u16, Value) + Send + Sync;

/// Start a fake API on loopback. `respond` scripts each answer; every request
/// is recorded in order.
pub(crate) async fn fake_api(
    respond: impl Fn(&Seen) -> (u16, Value) + Send + Sync + 'static,
) -> (String, Arc<Mutex<Vec<Seen>>>) {
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
                    path: uri
                        .path_and_query()
                        .map(|p| p.as_str().to_owned())
                        .unwrap_or_default(),
                    authorization: headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_owned),
                    body: String::from_utf8_lossy(&body).into_owned(),
                };
                let (status, value) = respond(&seen);
                recorded.lock().unwrap().push(seen);
                (
                    StatusCode::from_u16(status).unwrap(),
                    [("content-type", "application/json")],
                    if value.is_null() {
                        String::new()
                    } else {
                        value.to_string()
                    },
                )
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (format!("http://{address}"), log)
}

#[tokio::test]
async fn errors_name_the_call_and_the_upstream_message() {
    let (base, log) = fake_api(|seen| match seen.path.as_str() {
        "/ok" => (200, serde_json::json!({ "value": "v" })),
        "/gone" => (
            404,
            serde_json::json!({ "error": { "message": "no such key" } }),
        ),
        _ => (500, serde_json::json!({ "error_description": "boom" })),
    })
    .await;
    let (_, value) = json(
        HttpCall::new("GET", format!("{base}/ok")).bearer("t0ken"),
        TargetEgress::Trusted,
        "the test API",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(field(&value, "/value", "test").unwrap(), "v");
    assert!(field(&value, "/missing", "test").is_err());
    assert_eq!(
        log.lock().unwrap()[0].authorization.as_deref(),
        Some("Bearer t0ken")
    );

    // A listed status counts as success with no body.
    let (status, value) = json(
        HttpCall::new("DELETE", format!("{base}/gone")),
        TargetEgress::Trusted,
        "the test API",
        &[404],
    )
    .await
    .unwrap();
    assert_eq!((status, value), (404, Value::Null));

    let error = json(
        HttpCall::new("POST", format!("{base}/fail")).form(&[("a", "b c")]),
        TargetEgress::Trusted,
        "the test API",
        &[],
    )
    .await
    .unwrap_err()
    .to_string();
    assert_eq!(error, "the test API returned 500: boom");
    assert_eq!(log.lock().unwrap()[2].body, "a=b+c");
}

#[tokio::test]
async fn screened_calls_refuse_loopback_and_custom_cas() {
    let (base, log) = fake_api(|_| (200, Value::Null)).await;
    assert!(
        send(HttpCall::new("GET", base.clone()), TargetEgress::Screened)
            .await
            .is_err()
    );
    let error = send(
        HttpCall::new("GET", "https://example.com/").ca(Some("pem")),
        TargetEgress::Screened,
    )
    .await
    .unwrap_err()
    .to_string();
    assert!(error.contains("custom CA"), "{error}");
    assert!(log.lock().unwrap().is_empty());
}

#[test]
fn urls_must_be_https_outside_loopback() {
    assert!(check_https("https://k8s.example.com:6443", "host").is_ok());
    assert!(check_https("http://127.0.0.1:8080", "host").is_ok());
    assert!(check_https("http://k8s.example.com", "host").is_err());
    assert!(check_https("https://user:pw@k8s.example.com", "host").is_err());
    assert!(check_https("not a url", "host").is_err());
}
