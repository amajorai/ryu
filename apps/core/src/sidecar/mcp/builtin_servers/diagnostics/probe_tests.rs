//! Loopback reads against an ephemeral stand-in for Core.

use axum::{http::HeaderMap, routing::get, Json, Router};
use serde_json::json;

use super::*;

/// Serve `app` on a free loopback port and return its base URL.
async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}")
}

fn loopback<'a>(
    http: &'a reqwest::Client,
    base: &str,
    node_token: Option<&str>,
    acting_user: Option<&str>,
) -> Loopback<'a> {
    Loopback {
        http,
        base: base.to_owned(),
        node_token: node_token.map(str::to_owned),
        acting_user: acting_user.map(str::to_owned),
    }
}

fn echo_headers() -> Router {
    Router::new().route(
        "/api/version",
        get(|headers: HeaderMap| async move {
            let read = |name: &str| {
                headers
                    .get(name)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_owned)
            };
            Json(json!({
                "authorization": read("authorization"),
                "proof": read(crate::self_api::SELF_CALL_PROOF_HEADER),
                "user": read(crate::self_api::SELF_CALL_USER_HEADER),
            }))
        }),
    )
}

#[tokio::test]
async fn a_read_on_a_personal_node_carries_the_node_credential_and_no_person() {
    let base = serve(echo_headers()).await;
    let http = reqwest::Client::new();
    let probe = loopback(&http, &base, Some("fake-node-credential"), None)
        .get("/api/version")
        .await;
    let body = match &probe {
        Probe::Answered(body) => body.clone(),
        other => panic!("expected an answer, got {other:?}"),
    };
    assert_eq!(body["authorization"], json!("Bearer fake-node-credential"));
    assert_eq!(body["proof"], json!(null));
    assert_eq!(body["user"], json!(null));
}

#[tokio::test]
async fn a_read_on_a_shared_node_acts_for_the_person_in_the_chat() {
    let base = serve(echo_headers()).await;
    let http = reqwest::Client::new();
    let probe = loopback(&http, &base, None, Some("u-1"))
        .get("/api/version")
        .await;
    let body = match &probe {
        Probe::Answered(body) => body.clone(),
        other => panic!("expected an answer, got {other:?}"),
    };
    assert_eq!(body["proof"], json!(crate::self_api::self_call_proof()));
    assert_eq!(body["user"], json!("u-1"));
    assert_eq!(body["authorization"], json!(null));
}

#[tokio::test]
async fn a_refusal_keeps_only_its_status() {
    let app = Router::new().route(
        "/api/gateway/doctor",
        get(|| async { axum::http::StatusCode::FORBIDDEN }),
    );
    let base = serve(app).await;
    let http = reqwest::Client::new();
    let probe = loopback(&http, &base, None, None)
        .get("/api/gateway/doctor")
        .await;
    assert_eq!(probe, Probe::Refused(403));
    // A route Core does not serve is a refusal too, not a transport fault.
    let missing = loopback(&http, &base, None, None).get("/api/nope").await;
    assert_eq!(missing, Probe::Refused(404));
}

#[tokio::test]
async fn a_body_that_is_not_json_is_answered_as_null() {
    let app = Router::new().route("/api/version", get(|| async { "plain text" }));
    let base = serve(app).await;
    let http = reqwest::Client::new();
    let probe = loopback(&http, &base, None, None).get("/api/version").await;
    assert_eq!(probe, Probe::Answered(serde_json::Value::Null));
}

#[tokio::test]
async fn a_closed_port_is_unreachable_and_names_no_address() {
    // Bind, read the port, then drop the listener so nothing answers on it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let http = reqwest::Client::new();
    let probe = loopback(&http, &base, None, None).get("/api/version").await;
    let reason = match &probe {
        Probe::Unreachable(reason) => *reason,
        other => panic!("expected no answer, got {other:?}"),
    };
    assert!(!reason.contains("127.0.0.1"), "{reason}");
    assert!(!reason.is_empty());
}

#[test]
fn only_a_plain_id_is_a_single_path_segment() {
    for id in [
        "conv-1",
        "0b7c1f6e-2a4d-4d55-9a3e-1f2b3c4d5e6f",
        "thread_42",
    ] {
        assert!(is_single_segment(id), "{id}");
    }
    for id in [
        "", "a/b", "a\\b", "..", "a..b", "a%2fb", "a?b=1", "a#b", "a b", "a\nb",
    ] {
        assert!(!is_single_segment(id), "{id:?}");
    }
    assert!(!is_single_segment(&"x".repeat(201)));
}
