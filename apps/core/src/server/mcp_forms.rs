//! Authenticated form answers share the owning conversation's write ACL.
use super::ServerState;
use axum::extract::{Extension, Query, State};
use axum::response::IntoResponse;
use axum::{http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormQuery {
    #[serde(alias = "conversation_id")]
    conversation_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormAnswer {
    #[serde(alias = "conversation_id")]
    conversation_id: String,
    id: String,
    action: String,
    content: Option<Value>,
}

#[utoipa::path(get, path = "/api/chat/forms", tag = "Chat", summary = "List pending MCP forms for a conversation", params(("conversationId" = String, Query)), responses((status = 200, description = "Pending forms", body = serde_json::Value)))]
pub async fn list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Query(query): Query<FormQuery>,
) -> axum::response::Response {
    if let Err(response) = super::require_resource_write(
        state
            .conversations
            .get_access_meta(&query.conversation_id)
            .await,
        caller.as_ref(),
        "conversation not found",
    ) {
        return response;
    }
    Json(json!({ "forms": crate::sidecar::mcp::forms::list(&query.conversation_id) }))
        .into_response()
}
#[utoipa::path(post, path = "/api/chat/forms", tag = "Chat", summary = "Answer a pending MCP form", request_body = serde_json::Value, responses((status = 200, description = "Resolution result", body = serde_json::Value), (status = 400, description = "Invalid form answer")))]
pub async fn answer(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<FormAnswer>,
) -> axum::response::Response {
    if let Err(response) = super::require_resource_write(
        state
            .conversations
            .get_access_meta(&body.conversation_id)
            .await,
        caller.as_ref(),
        "conversation not found",
    ) {
        return response;
    }
    match crate::sidecar::mcp::forms::resolve(
        &body.conversation_id,
        &body.id,
        &body.action,
        body.content,
    ) {
        Ok(resolved) => Json(json!({ "resolved": resolved })).into_response(),
        Err(error) => super::json_error(StatusCode::BAD_REQUEST, error.to_string()),
    }
}
