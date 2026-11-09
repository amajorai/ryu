//! The `POST /api/chat/stream` entry points: the HTTP handler, which keeps the
//! raw body so a phone's device signature can cover the exact bytes, and the
//! in-process entry used by catalog scans and the harness.
// test-exempt: thin extractor wrappers around `run_chat_stream_request`; the
// device-signature path is covered by `device_tools_api` tests.

use crate::server::*;

#[utoipa::path(
    post,
    path = "/api/chat/stream",
    tag = "Chat",
    operation_id = "chat_stream",
    summary = "Stream a chat turn (SSE, Vercel AI format)",
    request_body = serde_json::Value,
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn chat_stream_http(
    state: State<ServerState>,
    headers: axum::http::HeaderMap,
    // Verified human author (Phase 0), attached by `attach_verified_caller`.
    caller: axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    user_jwt: axum::Extension<VerifiedUserJwt>,
    authorization: Option<axum::Extension<ResolvedAuthorization>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let req: ChatStreamRequest = match serde_json::from_slice(&body) {
        Ok(req) => req,
        Err(error) => {
            return json_error(
                StatusCode::UNPROCESSABLE_ENTITY,
                format!("invalid chat request body: {error}"),
            );
        }
    };
    run_chat_stream_request(state, headers, caller, user_jwt, authorization, req, body).await
}

/// In-process chat turn with a server-built request. It has no signed body,
/// so a device declaration on it can never verify and no device tools are
/// offered.
pub(in crate::server) async fn chat_stream(
    state: State<ServerState>,
    headers: axum::http::HeaderMap,
    caller: axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    user_jwt: axum::Extension<VerifiedUserJwt>,
    authorization: Option<axum::Extension<ResolvedAuthorization>>,
    Json(req): Json<ChatStreamRequest>,
) -> axum::response::Response {
    run_chat_stream_request(
        state,
        headers,
        caller,
        user_jwt,
        authorization,
        req,
        axum::body::Bytes::new(),
    )
    .await
}
