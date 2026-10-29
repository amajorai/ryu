//! The shared error and reply decoding for Core-owned operations an app reaches
//! through a kernel-capability row or the app host bridge (`server::app_*`).
//!
//! Each operation drives the SAME route handler a REST client reaches, in
//! process, and turns that handler's reply into a JSON value or a
//! [`KernelOpError`] carrying the handler's status and message. The entry point
//! (the sidecar capability route or `plugin_bridge_api`) then maps the error onto
//! its own wire contract.

use axum::{
    body::Bytes,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

/// The largest handler reply decoded in process.
pub(crate) const MAX_REPLY_BYTES: usize = 8 * 1024 * 1024;

/// The longest non-JSON error body (an axum extractor rejection) kept as a message.
const MAX_TEXT_ERROR_BYTES: usize = 512;

/// A refused or failed operation: the HTTP status and a human message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct KernelOpError {
    pub(crate) status: StatusCode,
    pub(crate) message: String,
}

impl KernelOpError {
    pub(crate) fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    /// A refused request (`400`): bad arguments from the caller.
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    /// The kernel-capability (sidecar) reply for this error.
    pub(crate) fn into_capability_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

/// Read an in-process handler reply's status and body (at most
/// [`MAX_REPLY_BYTES`]).
pub(crate) async fn read_handler_reply(
    response: Response,
) -> Result<(StatusCode, Bytes), KernelOpError> {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), MAX_REPLY_BYTES)
        .await
        .map_err(|e| KernelOpError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok((status, bytes))
}

/// Decode a handler reply read by [`read_handler_reply`].
///
/// - An empty body is `null`.
/// - A 2xx body is parsed as JSON.
/// - A non-2xx reply becomes an error whose message is the JSON `error` string
///   when there is one; otherwise a non-JSON body (an axum `Json` / `Path`
///   rejection is plain text) is kept as text, capped at 512 bytes; otherwise
///   `request failed: <status>`. A non-JSON error body is never itself a decode
///   failure.
pub(crate) fn decode_reply_bytes(status: StatusCode, bytes: &[u8]) -> Result<Value, KernelOpError> {
    if status.is_success() {
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        return serde_json::from_slice(bytes)
            .map_err(|e| KernelOpError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()));
    }
    let fallback = || format!("request failed: {status}");
    let message = match serde_json::from_slice::<Value>(bytes) {
        Ok(body) => body
            .get("error")
            .and_then(Value::as_str)
            .map_or_else(fallback, str::to_owned),
        Err(_) => text_message(bytes).unwrap_or_else(fallback),
    };
    Err(KernelOpError::new(status, message))
}

/// Read and decode an in-process handler reply (see [`decode_reply_bytes`]).
pub(crate) async fn decode_handler_reply(response: Response) -> Result<Value, KernelOpError> {
    let (status, bytes) = read_handler_reply(response).await?;
    decode_reply_bytes(status, &bytes)
}

/// A plain-text error body as a message: trimmed, valid UTF-8 cut at a character
/// boundary within [`MAX_TEXT_ERROR_BYTES`]. `None` when empty.
fn text_message(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    if text.len() <= MAX_TEXT_ERROR_BYTES {
        return Some(text.to_owned());
    }
    let mut end = MAX_TEXT_ERROR_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    Some(text[..end].to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_success_is_null_and_json_success_is_parsed() {
        assert_eq!(decode_reply_bytes(StatusCode::OK, b""), Ok(Value::Null));
        assert_eq!(
            decode_reply_bytes(StatusCode::OK, br#"{"ok":true}"#),
            Ok(json!({ "ok": true }))
        );
        assert_eq!(
            decode_reply_bytes(StatusCode::OK, b"not json")
                .unwrap_err()
                .status,
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn error_messages_come_from_json_text_or_the_status() {
        let json_error =
            decode_reply_bytes(StatusCode::CONFLICT, br#"{"ok":false,"error":"reload"}"#)
                .unwrap_err();
        assert_eq!(
            json_error,
            KernelOpError::new(StatusCode::CONFLICT, "reload")
        );

        let rejection = decode_reply_bytes(
            StatusCode::UNPROCESSABLE_ENTITY,
            b"Failed to deserialize the JSON body: unknown field `reviewed_by`",
        )
        .unwrap_err();
        assert_eq!(rejection.status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(rejection.message.contains("unknown field `reviewed_by`"));

        let long = "x".repeat(2_000);
        let capped = decode_reply_bytes(StatusCode::BAD_REQUEST, long.as_bytes()).unwrap_err();
        assert_eq!(capped.message.len(), MAX_TEXT_ERROR_BYTES);

        let multibyte = "é".repeat(400);
        let cut = decode_reply_bytes(StatusCode::BAD_REQUEST, multibyte.as_bytes()).unwrap_err();
        assert!(cut.message.len() <= MAX_TEXT_ERROR_BYTES);
        assert!(cut.message.chars().all(|c| c == 'é'));

        let empty = decode_reply_bytes(StatusCode::NOT_FOUND, b"").unwrap_err();
        assert_eq!(empty.message, "request failed: 404 Not Found");
        let no_error_field =
            decode_reply_bytes(StatusCode::NOT_FOUND, br#"{"ok":false}"#).unwrap_err();
        assert_eq!(no_error_field.message, "request failed: 404 Not Found");
    }
}
