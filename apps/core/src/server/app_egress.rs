//! Generic sidecar → Ryu guarded HTTP egress capability.
//!
//! App protocols keep their own origin, payment, and redirect policy. Core owns
//! the security-sensitive network substrate: URL screening, DNS resolution,
//! private-address rejection, IP pinning, timeout, and response limits.

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::ServerState;
use crate::sidecar::ext_proxy::authenticate_sidecar;

const MAX_HEADERS: usize = 128;
const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct HeaderBody {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FetchBody {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<HeaderBody>,
    #[serde(default)]
    pub body_base64: Option<String>,
}

#[derive(Debug, Serialize)]
struct FetchResponse {
    status: u16,
    headers: Vec<HeaderBody>,
    body_base64: String,
}

fn validate_request(body: &FetchBody) -> Result<(String, Vec<(String, String)>), String> {
    let method = body.method.trim().to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
    ) {
        return Err("method is not supported by guarded egress".to_owned());
    }
    if body.headers.len() > MAX_HEADERS {
        return Err("too many request headers".to_owned());
    }
    let header_bytes = body
        .headers
        .iter()
        .map(|header| header.name.len().saturating_add(header.value.len()))
        .sum::<usize>();
    if header_bytes > MAX_HEADER_BYTES {
        return Err("request headers are too large".to_owned());
    }
    let headers = body
        .headers
        .iter()
        .map(|header| (header.name.clone(), header.value.clone()))
        .collect();
    Ok((method, headers))
}

/// `POST /api/host/capability/egress.fetch` — execute one DNS-pinned outbound
/// request for a sidecar. The sidecar remains responsible for protocol-specific
/// allowlists and redirect rules; it never receives a node token for Core's
/// network client and never implements the private-address guard itself.
pub(crate) async fn host_egress_fetch(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<FetchBody>,
) -> Response {
    if let Err((status, message)) = authenticate_sidecar(&state, &headers).await {
        return (status, Json(json!({ "error": message }))).into_response();
    }
    let (method, request_headers) = match validate_request(&body) {
        Ok(value) => value,
        Err(message) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": message })),
            )
                .into_response();
        }
    };
    let request_body = match body.body_base64 {
        Some(value) => match STANDARD.decode(value) {
            Ok(bytes) if (bytes.len() as u64) <= MAX_BODY_BYTES => Some(bytes),
            Ok(_) => {
                return (
                    axum::http::StatusCode::PAYLOAD_TOO_LARGE,
                    Json(json!({ "error": "request body is too large" })),
                )
                    .into_response();
            }
            Err(_) => {
                return (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "request body is not valid base64" })),
                )
                    .into_response();
            }
        },
        None => None,
    };

    let result = ryu_egress::guarded_request(
        ryu_egress::GuardedRequest {
            method,
            url: body.url,
            headers: request_headers,
            body: request_body,
        },
        ryu_egress::GuardedFetchPolicy {
            allow_http: false,
            max_body_bytes: MAX_BODY_BYTES,
            ..ryu_egress::GuardedFetchPolicy::default()
        },
    )
    .await;
    match result {
        Ok(response) => Json(FetchResponse {
            status: response.status,
            headers: response
                .headers
                .into_iter()
                .map(|(name, value)| HeaderBody { name, value })
                .collect(),
            body_base64: STANDARD.encode(response.body),
        })
        .into_response(),
        Err(message) => (
            axum::http::StatusCode::BAD_GATEWAY,
            Json(json!({ "error": message })),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_request, FetchBody, HeaderBody};

    #[test]
    fn only_supported_request_methods_are_admitted() {
        let body = FetchBody {
            method: "CONNECT".to_owned(),
            url: "https://example.com".to_owned(),
            headers: Vec::new(),
            body_base64: None,
        };
        assert!(validate_request(&body).is_err());
    }

    #[test]
    fn headers_are_forwarded_as_plain_pairs() {
        let body = FetchBody {
            method: "POST".to_owned(),
            url: "https://example.com".to_owned(),
            headers: vec![HeaderBody {
                name: "content-type".to_owned(),
                value: "application/json".to_owned(),
            }],
            body_base64: None,
        };
        let (method, headers) = validate_request(&body).expect("valid headers");
        assert_eq!(method, "POST");
        assert_eq!(
            headers,
            vec![("content-type".to_owned(), "application/json".to_owned())]
        );
    }

    #[test]
    fn methods_are_trimmed_and_canonicalized_before_forwarding() {
        let body = FetchBody {
            method: " post ".to_owned(),
            url: "https://example.com".to_owned(),
            headers: Vec::new(),
            body_base64: None,
        };
        let (method, _) = validate_request(&body).expect("valid method");
        assert_eq!(method, "POST");
    }
}
