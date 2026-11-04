//! Conversation history handlers and local content sealing: `validate_agent_ui_state` through `get_conversation_title_history_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Shape and size checks for a widget-state write, or the 400 to send back.
pub(in crate::server) fn validate_agent_ui_state(
    tool_call_id: &str,
    value: &serde_json::Value,
) -> Result<(), axum::response::Response> {
    if tool_call_id.trim().is_empty() || tool_call_id.len() > MAX_AGENT_UI_TOOL_CALL_ID_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            format!("tool_call_id must be 1-{MAX_AGENT_UI_TOOL_CALL_ID_BYTES} bytes"),
        ));
    }
    if !value.is_object() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "state must be a JSON object".to_owned(),
        ));
    }
    // Same size (64 KiB) and nesting bounds as MCP app widget state: form values
    // and checklist flags, never a blob store.
    widgets::validate_widget_state(value)
        .map_err(|message| json_error(StatusCode::BAD_REQUEST, message.to_owned()))
}

/// `GET /api/conversations/:id/context` — the per-category token attribution for
/// the last turn Core assembled on this conversation (skills, tool definitions,
/// memory, conversation history, …).
///
/// Served from an in-memory cache rather than the transcript: a breakdown
/// describes the prompt Core built for one turn, so it is meaningless after a
/// restart and is regenerated on the next turn. `{ "breakdown": null }` is the
/// normal answer for a conversation that has not run a turn in this process —
/// the panel renders an empty state, not an error.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/context",
    tag = "Conversations",
    summary = "Get the context-window breakdown for a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_conversation_context_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let breakdown = crate::sidecar::adapters::context_breakdown::remembered(&id);
    Json(json!({ "breakdown": breakdown })).into_response()
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct SetFlagBody {
    pub(in crate::server) value: bool,
}

/// `POST /api/conversations/:id/pinned` — pin or unpin a conversation. Body:
/// `{ "value": true|false }`. Server-backed (the same column the coordinator
/// `threads` tool writes), so a pin set here surfaces to every client.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/pinned",
    tag = "Conversations",
    summary = "Pin or unpin a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_pinned_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetFlagBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.set_pinned(&id, body.value).await {
        Ok(()) => Json(json!({ "ok": true, "pinned": body.value })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/archived` — archive or unarchive a conversation.
/// Body: `{ "value": true|false }`. Server-backed, shared with the coordinator
/// `threads` tool's `set_thread_archived`.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/archived",
    tag = "Conversations",
    summary = "Archive or unarchive a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_archived_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetFlagBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.set_archived(&id, body.value).await {
        Ok(()) => Json(json!({ "ok": true, "archived": body.value })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/pull-requests` request body.
#[derive(serde::Deserialize)]
pub(in crate::server) struct SetConversationPullRequestBody {
    pub(in crate::server) url: String,
    #[serde(default = "default_true_bool")]
    pub(in crate::server) linked: bool,
}

/// `POST /api/conversations/:id/pull-requests` — link or unlink one GitHub pull
/// request URL. Body: `{ "url": "https://github.com/o/r/pull/1", "linked": bool }`.
/// Returns the conversation's full linked list.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/pull-requests",
    tag = "Conversations",
    summary = "Link or unlink a pull request to a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_pull_request_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetConversationPullRequestBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let Some(url) = conversations::normalize_pull_request_url(&body.url) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "expected a GitHub pull request URL".to_owned(),
        );
    };
    match state
        .conversations
        .set_pull_request_linked(&id, &url, body.linked)
        .await
    {
        Ok(Some(linked)) => {
            Json(json!({ "ok": true, "linked_pull_requests": linked })).into_response()
        }
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(e) => json_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

/// `POST /api/conversations/:id/folder` request body. A null folder detaches
/// the chat from its project; a string assigns it to that workspace folder.
#[derive(serde::Deserialize)]
pub(in crate::server) struct SetConversationFolderBody {
    pub(in crate::server) folder_path: Option<String>,
}

/// Change the workspace folder that groups a conversation in desktop clients.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/folder",
    tag = "Conversations",
    summary = "Set or clear a conversation workspace folder",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_folder_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetConversationFolderBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let folder_path = body
        .folder_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    match state.conversations.set_folder_path(&id, folder_path).await {
        Ok(true) => Json(json!({ "ok": true, "folder_path": folder_path })).into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/title` request body.
#[derive(serde::Deserialize)]
pub(in crate::server) struct SetTitleBody {
    pub(in crate::server) title: String,
}

/// `PUT /api/conversations/:id/model-selection` request body.
#[derive(serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct SetConversationModelSelectionBody {
    pub(in crate::server) change_id: String,
    pub(in crate::server) kind: crate::server::conversations::ConversationModelChangeKind,
    pub(in crate::server) provider_id: Option<String>,
    pub(in crate::server) provider_label: Option<String>,
    pub(in crate::server) model_id: Option<String>,
    pub(in crate::server) model_label: Option<String>,
}

/// `POST /api/conversations/:id/title` — manually rename a conversation. Body:
/// `{ "title": "..." }`. This marks the title user-chosen (`title_custom = 1`)
/// so the background auto-namer never overwrites it. Server-backed, so the new
/// title surfaces to every client (and to the coordinator `threads` view).
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/title",
    tag = "Conversations",
    summary = "Rename a conversation",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_title_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetTitleBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let title = body.title.trim();
    if title.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "title must not be empty".to_string(),
        );
    }
    match state.conversations.set_title(&id, title).await {
        Ok(()) => Json(json!({ "ok": true, "title": title })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    post, path = "/api/conversations/{id}/retitle", tag = "Conversations",
    summary = "Auto-rename a conversation on demand", params(("id" = String, Path)),
    responses((status = 200, description = "Generated title", body = serde_json::Value),
              (status = 422, description = "No usable title generated"))
)]
pub(in crate::server) async fn retitle_conversation_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match auto_title::retitle_conversation(&state, &id).await {
        Some(title) => Json(json!({"ok": true, "title": title})).into_response(),
        None => json_error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "couldn't generate a title (no titling model available, or the reply was empty)"
                .to_owned(),
        ),
    }
}

/// `GET /api/conversations/:id/title-history` — past titles for a conversation
/// (derived placeholder, auto-renames, and manual renames), oldest → newest.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/title-history",
    tag = "Conversations",
    summary = "List conversation title history",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_conversation_title_history_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.list_title_history(&id).await {
        Ok(entries) => Json(json!({ "history": entries })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
