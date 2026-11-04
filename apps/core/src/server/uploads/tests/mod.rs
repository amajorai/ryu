use crate::server::uploads::{
    base64_wire_ceiling, decoded_len_lower_bound, decoded_len_upper_bound, header,
    safe_inline_mime, upload_limits, BodyEncoding, Bytes, Observed, StatusCode, FILE_ROUTE_LIMITS,
    JSON_ENVELOPE_SLACK_BYTES, MAX_UPLOAD_BYTES, SPACE_FILE_BODY_LIMIT, UPLOADS_BODY_LIMIT,
};

/// Axum 0.7's implicit body limit for any route that does not layer its own
/// [`axum::extract::DefaultBodyLimit`]. Not exported by axum, so it is restated
/// here and *proved* by [`a_route_without_an_explicit_limit_caps_at_axums_default`]
/// rather than trusted.
const AXUM_DEFAULT_BODY_LIMIT: usize = 2 * 1024 * 1024;

/// A router shaped exactly like one `.route(path, post(handler))` registration,
/// with the body limit applied only when `limit` is `Some`.
fn json_router(limit: Option<usize>) -> axum::Router {
    let route = axum::routing::post(|_: Bytes| async { StatusCode::OK });
    let route = match limit {
        Some(n) => route.layer(axum::extract::DefaultBodyLimit::max(n)),
        None => route,
    };
    axum::Router::new().route("/f", route)
}

async fn post_bytes(router: axum::Router, len: usize) -> StatusCode {
    use tower::ServiceExt as _;
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/f")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(vec![b'x'; len]))
        .unwrap();
    router.oneshot(request).await.unwrap().status()
}

/// The same body an unlayered route refuses is accepted once the route declares
/// the limit this module compiles in — which is what makes [`MAX_UPLOAD_BYTES`]
/// the number `/api/uploads` truly enforces, and therefore the only upload
/// ceiling a settings panel may print.
/// The premise the test below rests on, checked at COMPILE time: if
/// [`MAX_UPLOAD_BYTES`] ever drops to or under axum's default, the test stops
/// distinguishing the layered route from the unlayered one and would keep
/// passing while proving nothing.
const _: () = assert!(MAX_UPLOAD_BYTES > AXUM_DEFAULT_BODY_LIMIT);

/// A JSON envelope shaped exactly like `CreateFileBody`, wrapping `file_bytes`
/// bytes of file. The envelope is part of the measurement: the wire cost of an
/// upload is the base64 payload *plus* the object around it.
fn create_file_envelope(file_bytes: usize) -> Vec<u8> {
    use base64::Engine as _;
    let data = base64::engine::general_purpose::STANDARD.encode(vec![0u8; file_bytes]);
    serde_json::to_vec(&serde_json::json!({
        "title": "f.bin",
        "mime": "application/octet-stream",
        "data_base64": data,
    }))
    .unwrap()
}

async fn post_body(router: axum::Router, body: Vec<u8>) -> (StatusCode, String) {
    use tower::ServiceExt as _;
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/f")
        .header(header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body))
        .unwrap();
    let response = router.oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

mod limit_file;
