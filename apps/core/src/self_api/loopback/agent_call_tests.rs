//! The mark every self-API loopback carries, so a handler can tell an agent's
//! tool call from the person's own client (security finding CE-20).

use super::*;

fn enable_route() -> CoreApiRoute {
    CoreApiRoute {
        id: "ryu_api.post_api_plugins_id_enable".to_owned(),
        method: "POST".to_owned(),
        path_template: "/api/plugins/{id}/enable".to_owned(),
        summary: String::new(),
        path_params: vec!["id".to_owned()],
        query_params: vec![],
        has_body: false,
        input_schema: json!({ "type": "object" }),
    }
}

/// A stand-in for Core that answers with what [`is_self_api_call`] reads from
/// the request it received.
async fn core_that_reports_the_caller() -> String {
    use axum::{http::HeaderMap, routing::post, Json, Router};
    let app = Router::new().route(
        "/api/plugins/:id/enable",
        post(|headers: HeaderMap| async move {
            Json(json!({ "agent_call": is_self_api_call(&headers) }))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    base
}

#[tokio::test]
async fn every_self_api_loopback_says_an_agent_made_it() {
    let base = core_that_reports_the_caller().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let arguments = json!({ "id": "com.example.notes" });

    // The owner loopback of a personal node: node token only, no acting person.
    let owner = send_request(&client, &base, None, &enable_route(), &arguments)
        .await
        .unwrap();
    assert_eq!(owner["status"], json!(200));
    assert_eq!(owner["body"]["agent_call"], json!(true));

    // The acting loopback of an organization node carries it as well.
    let acting = send_request_as(
        &client,
        &base,
        None,
        &enable_route(),
        &arguments,
        Some("u-1"),
    )
    .await
    .unwrap();
    assert_eq!(acting["body"]["agent_call"], json!(true));
}

#[tokio::test]
async fn a_request_without_the_mark_is_the_persons_own_client() {
    let base = core_that_reports_the_caller().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    // What the desktop sends: the same route, no self-API mark.
    let answer: Value = client
        .post(format!("{base}/api/plugins/com.example.notes/enable"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(answer["agent_call"], json!(false));
}

#[test]
fn the_mark_is_read_by_name_whatever_its_value() {
    use axum::http::{HeaderMap, HeaderValue};
    let mut headers = HeaderMap::new();
    assert!(!is_self_api_call(&headers));
    headers.insert(SELF_API_CALL_HEADER, HeaderValue::from_static(""));
    assert!(is_self_api_call(&headers));
    headers.insert(SELF_API_CALL_HEADER, HeaderValue::from_static("1"));
    assert!(is_self_api_call(&headers));
}
