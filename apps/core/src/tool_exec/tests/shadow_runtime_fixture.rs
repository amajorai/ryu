//! The loopback stand-in for Core's own HTTP surface that the Shadow
//! runtime proof sends its `core:` requests to. It records every request and
//! answers like the Shadow routes would.

use super::*;

pub(super) async fn shadow_fixture_request(
    State(observed): State<Arc<tokio::sync::Mutex<Vec<Value>>>>,
    request: Request<Body>,
) -> Response {
    let (parts, body) = request.into_parts();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .expect("read Shadow fixture request body");
    let body = String::from_utf8(bytes.to_vec()).expect("HTTP request body is UTF-8");
    let query = parts.uri.query().map(str::to_owned);
    let query_map = query
        .as_deref()
        .map(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .into_owned()
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    let query_value = query_map.get("q").map(String::as_str).unwrap_or_default();
    let record = serde_json::json!({
        "method": parts.method.as_str(),
        "path": parts.uri.path(),
        "query": query,
        "host": parts.headers.get(header::HOST).and_then(|value| value.to_str().ok()),
        "authorization": parts.headers.get(header::AUTHORIZATION).and_then(|value| value.to_str().ok()),
        "body": body,
    });
    observed.lock().await.push(record);

    let known_get = [
        "/api/shadow/search",
        "/api/shadow/search/semantic",
        "/api/shadow/timeline",
        "/api/shadow/context/recent",
    ];
    let computer_use = parts.method == axum::http::Method::POST
        && parts.uri.path() == "/api/shadow/computer-use/run";
    if !(computer_use
        || (parts.method == axum::http::Method::GET && known_get.contains(&parts.uri.path())))
    {
        return StatusCode::NOT_FOUND.into_response();
    }
    if parts
        .headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        != Some(format!("Bearer {TEST_NODE_TOKEN}").as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if computer_use {
        assert!(query.is_none());
        let input: Value = serde_json::from_str(&body).expect("real computer-use POST JSON");
        let goal = input["goal"].as_str().expect("goal is a string");
        assert_eq!(
            input.as_object().unwrap().len(),
            1,
            "no credential or model-only fields forwarded"
        );
        return match goal {
            "fixture-unauthorized" => (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error":"fixture rejected token"}))).into_response(),
            "fixture-unavailable" => (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({"error":"fixture service unavailable"}))).into_response(),
            "" => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"goal required"}))).into_response(),
            "Open the visible \"Settings\" panel\nwithout submitting a form" => Json(serde_json::json!({"planner":"native","status":"completed","steps":[{"action":"click","target":"Settings"}],"message":"Requested visible panel opened"})).into_response(),
            _ => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"unknown fixture goal"}))).into_response(),
        };
    }
    match query_value {
        "fixture-unauthorized" => (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "fixture rejected token" })),
        )
            .into_response(),
        "fixture-unavailable" => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "fixture service unavailable" })),
        )
            .into_response(),
        _ => (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "path": parts.uri.path(),
                "query": query_map,
            })),
        )
            .into_response(),
    }
}
