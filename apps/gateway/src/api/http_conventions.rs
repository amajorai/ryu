//! HTTP conventions every Gateway response follows, whichever handler (or
//! none) produced it:
//!
//! - **`x-request-id`** on every response, errors included. The id is minted
//!   once per HTTP request and handed to the first pipeline context built while
//!   serving it ([`claim_request_id`]), so the header, the audit row and the
//!   logs carry the same id. A handler that already set the header keeps it.
//! - **The JSON error envelope** (`{"error":{"message","type","code"}}`, the
//!   shape `GatewayError` writes) for responses axum produces on its own: an
//!   unmatched route (404 `not_found`), a wrong method (405
//!   `method_not_allowed`, keeping axum's `Allow` header), a body-limit refusal
//!   (413 `request_too_large`) and a JSON extractor rejection (400/415/422
//!   `invalid_request_error`). Statuses are unchanged; only the plain-text or
//!   empty body becomes the envelope. Passthrough routes (verbatim upstream
//!   bodies) and the Twilio voice callbacks (TwiML) are left alone.
//! - **A 504 envelope** (`gateway_timeout`) when the server-wide request
//!   timeout drops a request: tower's timeout answers an empty body, which
//!   [`gateway_timeout_envelope`] turns into the same envelope.
//! - **Readable headers for browser callers**: [`exposed_headers`] lists the
//!   response headers the CORS layer exposes cross-origin.

use std::cell::RefCell;

use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderName, HeaderValue, Method, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// The response header carrying the Gateway request id.
pub const REQUEST_ID_HEADER: &str = "x-request-id";

/// Largest plain-text error body read back to become the envelope message.
const MAX_REWRITTEN_BODY_BYTES: usize = 16 * 1024;
/// Longest message (in characters) copied from a rewritten body.
const MAX_MESSAGE_CHARS: usize = 512;
/// Longest request path echoed in a 404 message.
const MAX_ECHOED_PATH_CHARS: usize = 256;

tokio::task_local! {
    /// The id minted for the HTTP request this task is serving, until a
    /// pipeline context claims it.
    static PENDING_REQUEST_ID: RefCell<Option<String>>;
}

fn new_request_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The request id for a new pipeline context: the serving HTTP request's id
/// the first time it is asked for, and a fresh id after that (a second
/// context in one request, such as an eval case or a background job, must not
/// share the id) or outside an HTTP request.
pub fn claim_request_id() -> String {
    PENDING_REQUEST_ID
        .try_with(|slot| slot.borrow_mut().take())
        .ok()
        .flatten()
        .unwrap_or_else(new_request_id)
}

/// Middleware: mint the request id, expose it to [`claim_request_id`] while
/// the request is served, and stamp it on the response unless a handler
/// already set its own `x-request-id`.
pub async fn request_id(request: Request, next: Next) -> Response {
    let id = new_request_id();
    let mut response = PENDING_REQUEST_ID
        .scope(RefCell::new(Some(id.clone())), next.run(request))
        .await;
    if !response.headers().contains_key(REQUEST_ID_HEADER) {
        if let Ok(value) = HeaderValue::from_str(&id) {
            response.headers_mut().insert(REQUEST_ID_HEADER, value);
        }
    }
    response
}

/// Response headers a cross-origin (browser, Tauri webview) caller may read:
/// the request id, the rate-limit signals and the routing headers. None of
/// them is CORS-safelisted, so without this list only the body is readable.
pub fn exposed_headers() -> [HeaderName; 6] {
    [
        HeaderName::from_static(REQUEST_ID_HEADER),
        header::RETRY_AFTER,
        HeaderName::from_static("ratelimit"),
        HeaderName::from_static("ratelimit-policy"),
        HeaderName::from_static("x-provider"),
        HeaderName::from_static("x-routed-model"),
    ]
}

/// Middleware (outside the request timeout): the 504 the timeout writes when
/// it drops a slow request has no body; give it the JSON envelope
/// (`gateway_timeout`). A 504 that already carries a body, and the
/// passthrough/voice paths, are left alone.
pub async fn gateway_timeout_envelope(request: Request, next: Next) -> Response {
    let exempt = is_exempt_path(request.uri().path());
    let response = next.run(request).await;
    if exempt || !is_bodiless_timeout(&response) {
        return response;
    }
    let mut envelope = error_response(
        StatusCode::GATEWAY_TIMEOUT,
        "gateway_timeout",
        "The Gateway timed out before the response started. Retry, or use streaming for long requests.",
    );
    for (name, value) in response.headers() {
        if name != header::CONTENT_TYPE && name != header::CONTENT_LENGTH {
            envelope.headers_mut().insert(name.clone(), value.clone());
        }
    }
    envelope
}

fn is_bodiless_timeout(response: &Response) -> bool {
    use axum::body::HttpBody;
    response.status() == StatusCode::GATEWAY_TIMEOUT
        && !response.headers().contains_key(header::CONTENT_TYPE)
        && response.body().size_hint().exact() == Some(0)
}

/// The Gateway error envelope, the same shape `GatewayError` writes.
pub fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "message": message,
                "type": code,
                "code": code,
            }
        })),
    )
        .into_response()
}

/// The message for a request no route matched. The router installs no
/// catch-all fallback handler (every served route is classified, see the route
/// inventory test), so [`json_error_envelope`] words axum's own empty 404 with
/// this instead.
fn no_route_message(method: &Method, uri: &Uri) -> String {
    let path: String = uri.path().chars().take(MAX_ECHOED_PATH_CHARS).collect();
    format!("No route for {method} {path}")
}

/// The envelope code for an axum-generated error status, or `None` when the
/// status is left as the handler wrote it.
fn rewritten_code(status: StatusCode) -> Option<&'static str> {
    match status.as_u16() {
        400 | 415 | 422 => Some("invalid_request_error"),
        404 => Some("not_found"),
        405 => Some("method_not_allowed"),
        413 => Some("request_too_large"),
        _ => None,
    }
}

/// Paths whose bodies are not Gateway JSON and must pass through untouched.
fn is_exempt_path(path: &str) -> bool {
    path.starts_with("/passthrough/") || path.starts_with("/voice/")
}

/// A body axum (or a bare `StatusCode` handler) produced: empty or plain text.
fn is_plain_or_empty(response: &Response) -> bool {
    match response.headers().get(header::CONTENT_TYPE) {
        None => true,
        Some(value) => value
            .to_str()
            .map(|value| value.trim_start().starts_with("text/plain"))
            .unwrap_or(false),
    }
}

/// Middleware: rewrite axum's plain-text or empty 400/404/405/413/415/422
/// bodies into the JSON envelope, keeping the status and every other header
/// (`Allow` on a 405 in particular).
pub async fn json_error_envelope(request: Request, next: Next) -> Response {
    let exempt = is_exempt_path(request.uri().path());
    let unmatched = no_route_message(request.method(), request.uri());
    let response = next.run(request).await;
    if exempt {
        return response;
    }
    rewrite_plain_error(response, &unmatched).await
}

/// `unmatched` words an empty 404: only the router's default fallback answers
/// one, so it always means no route matched.
async fn rewrite_plain_error(response: Response, unmatched: &str) -> Response {
    let status = response.status();
    let Some(code) = rewritten_code(status) else {
        return response;
    };
    if !is_plain_or_empty(&response) {
        return response;
    }
    let (mut parts, body) = response.into_parts();
    let text = axum::body::to_bytes(body, MAX_REWRITTEN_BODY_BYTES)
        .await
        .ok()
        .and_then(|bytes| String::from_utf8(bytes.to_vec()).ok())
        .unwrap_or_default();
    let trimmed = text.trim();
    let message: String = if trimmed.is_empty() && status == StatusCode::NOT_FOUND {
        unmatched.to_owned()
    } else if trimmed.is_empty() {
        status
            .canonical_reason()
            .unwrap_or("Request failed")
            .to_owned()
    } else {
        trimmed.chars().take(MAX_MESSAGE_CHARS).collect()
    };
    let payload = json!({
        "error": {
            "message": message,
            "type": code,
            "code": code,
        }
    });
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Response::from_parts(parts, Body::from(payload.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body_json(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body collects");
        serde_json::from_slice(&bytes).expect("body is JSON")
    }

    #[tokio::test]
    async fn claim_hands_out_the_request_id_once_then_fresh_ids() {
        let (first, second) = PENDING_REQUEST_ID
            .scope(RefCell::new(Some("req-1".to_owned())), async {
                (claim_request_id(), claim_request_id())
            })
            .await;
        assert_eq!(first, "req-1");
        assert_ne!(second, "req-1");
        assert!(uuid::Uuid::parse_str(&second).is_ok());
        // Outside a served request every claim is fresh.
        assert_ne!(claim_request_id(), claim_request_id());
    }

    #[tokio::test]
    async fn plain_rejections_become_the_envelope_with_status_and_headers_kept() {
        let mut response = (StatusCode::METHOD_NOT_ALLOWED, "").into_response();
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET,HEAD"));
        let rewritten = rewrite_plain_error(response, "").await;
        assert_eq!(rewritten.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(rewritten.headers().get(header::ALLOW).unwrap(), "GET,HEAD");
        assert_eq!(
            rewritten.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let body = body_json(rewritten).await;
        assert_eq!(body["error"]["code"], "method_not_allowed");
        assert_eq!(body["error"]["type"], "method_not_allowed");
        assert_eq!(body["error"]["message"], "Method Not Allowed");

        let rejection = (
            StatusCode::UNPROCESSABLE_ENTITY,
            "Failed to deserialize the JSON body into the target type: missing field `model`",
        )
            .into_response();
        let rewritten = rewrite_plain_error(rejection, "").await;
        assert_eq!(rewritten.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let body = body_json(rewritten).await;
        assert_eq!(body["error"]["code"], "invalid_request_error");
        assert!(body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("missing field `model`"));
    }

    #[tokio::test]
    async fn json_bodies_and_other_statuses_are_untouched() {
        let json_error = error_response(StatusCode::BAD_REQUEST, "custom", "kept");
        let body = body_json(rewrite_plain_error(json_error, "").await).await;
        assert_eq!(body["error"]["code"], "custom");

        let unauthorized = (StatusCode::UNAUTHORIZED, "nope").into_response();
        let kept = rewrite_plain_error(unauthorized, "").await;
        assert_eq!(kept.status(), StatusCode::UNAUTHORIZED);
        assert!(kept
            .headers()
            .get(header::CONTENT_TYPE)
            .is_some_and(|v| v.to_str().unwrap().starts_with("text/plain")));
    }

    #[tokio::test]
    async fn a_timed_out_request_answers_the_envelope() {
        use std::time::Duration;
        use tower::ServiceExt;
        let app = axum::Router::new()
            .route(
                "/slow",
                axum::routing::get(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "late"
                }),
            )
            .route(
                "/upstream-504",
                axum::routing::get(|| async {
                    error_response(StatusCode::GATEWAY_TIMEOUT, "kept", "kept")
                }),
            )
            .layer(tower_http::timeout::TimeoutLayer::with_status_code(
                StatusCode::GATEWAY_TIMEOUT,
                Duration::from_millis(10),
            ))
            .layer(axum::middleware::from_fn(gateway_timeout_envelope));
        let response = app
            .clone()
            .oneshot(Request::builder().uri("/slow").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/json"
        );
        let body = body_json(response).await;
        assert_eq!(body["error"]["code"], "gateway_timeout");
        assert_eq!(body["error"]["type"], "gateway_timeout");

        // A 504 that already has a body keeps it.
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/upstream-504")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(body_json(response).await["error"]["code"], "kept");
    }

    #[test]
    fn passthrough_and_voice_paths_are_exempt() {
        assert!(is_exempt_path("/passthrough/anthropic/v1/messages"));
        assert!(is_exempt_path("/voice/twilio/answer"));
        assert!(!is_exempt_path("/v1/chat/completions"));
    }

    #[tokio::test]
    async fn long_messages_and_paths_are_capped() {
        let long = "x".repeat(MAX_MESSAGE_CHARS * 2);
        let body = body_json(
            rewrite_plain_error((StatusCode::BAD_REQUEST, long).into_response(), "").await,
        )
        .await;
        assert_eq!(
            body["error"]["message"].as_str().unwrap().len(),
            MAX_MESSAGE_CHARS
        );
        let uri: Uri = format!("/{}", "a".repeat(1000)).parse().unwrap();
        let message = no_route_message(&Method::GET, &uri);
        assert!(message.len() < 300);
        assert!(message.starts_with("No route for GET /"));
    }
}
