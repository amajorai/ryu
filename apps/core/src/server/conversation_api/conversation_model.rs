//! Conversation history handlers and local content sealing: `get_conversation_model_selection_handler` through `set_conversation_visibility_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/conversations/:id/model-selection` returns the shared current
/// selection and its durable history. The newest event is the current value.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/model-selection",
    tag = "Conversations",
    summary = "Read a conversation's provider and model history",
    params(("id" = String, Path)),
    responses((
        status = 200,
        description = "OK",
        body = crate::server::conversations::ConversationModelSelectionState
    ))
)]
pub(in crate::server) async fn get_conversation_model_selection_handler(
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
    let changes = match state.conversations.list_model_changes(&id).await {
        Ok(changes) => changes,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let handoffs = match state.conversations.list_context_handoffs(&id).await {
        Ok(handoffs) => handoffs,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    // A change handed off on several branches (an edit before the switch) shows
    // the marker for the branch the thread is on now.
    let active_ids = if context_handoff::has_branched_handoffs(&handoffs) {
        match state.conversations.get_active_messages(&id).await {
            Ok(messages) => Some(
                messages
                    .into_iter()
                    .map(|message| message.id)
                    .collect::<std::collections::HashSet<_>>(),
            ),
            Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
        }
    } else {
        None
    };
    let handoffs = context_handoff::markers_for_thread(handoffs, active_ids.as_ref());
    let current = changes.last().cloned();
    Json(
        crate::server::conversations::ConversationModelSelectionState {
            current,
            changes,
            handoffs,
        },
    )
    .into_response()
}

/// `PUT /api/conversations/:id/model-selection` stores a shared model/provider
/// choice and publishes it to everyone currently in the conversation room.
#[utoipa::path(
    put,
    path = "/api/conversations/{id}/model-selection",
    tag = "Conversations",
    summary = "Change a conversation's provider and model",
    params(("id" = String, Path)),
    request_body = SetConversationModelSelectionBody,
    responses(
        (
            status = 200,
            description = "OK",
            body = crate::server::conversations::ConversationModelSelectionWriteResult
        ),
        (status = 403, description = "Conversation is read-only"),
        (status = 404, description = "Conversation not found")
    )
)]
pub(in crate::server) async fn set_conversation_model_selection_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetConversationModelSelectionBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }

    let valid_optional_text = |value: &Option<String>, max_bytes: usize| {
        value.as_ref().is_none_or(|value| {
            !value.trim().is_empty()
                && value.len() <= max_bytes
                && !value.chars().any(char::is_control)
        })
    };
    if body.change_id.trim().is_empty()
        || body.change_id.len() > 256
        || body.change_id.chars().any(char::is_control)
        || !valid_optional_text(&body.provider_id, 256)
        || !valid_optional_text(&body.provider_label, 128)
        || !valid_optional_text(&body.model_id, 512)
        || !valid_optional_text(&body.model_label, 256)
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid provider/model selection".to_owned(),
        );
    }

    let changed_by = caller.as_ref().map(|identity| identity.user_id.clone());
    let input = crate::server::conversations::ConversationModelSelectionInput {
        id: body.change_id.trim().to_owned(),
        kind: body.kind,
        provider_id: body.provider_id.map(|value| value.trim().to_owned()),
        provider_label: body.provider_label.map(|value| value.trim().to_owned()),
        model_id: body.model_id.map(|value| value.trim().to_owned()),
        model_label: body.model_label.map(|value| value.trim().to_owned()),
        changed_by,
    };
    match state.conversations.record_model_selection(&id, input).await {
        Ok((change, changed)) => Json(
            crate::server::conversations::ConversationModelSelectionWriteResult { change, changed },
        )
        .into_response(),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

/// `GET /api/conversations/:id/context` — what currently occupies this
/// conversation's context window, itemized.
///
//// `POST /api/conversations/:id/icon` — set or clear a conversation glyph.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/icon",
    tag = "Conversations",
    summary = "Set or clear a conversation glyph",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_icon_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetEntityIconBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.set_icon(&id, body.icon.as_ref()).await {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/visibility` — share a conversation with the
/// organization or return it to the owner-only private scope.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/access",
    tag = "Conversations",
    summary = "Get who can access a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_conversation_access_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    let tenancy = match state.conversations.get_access_meta(&id).await {
        Ok(Some(tenancy)) => tenancy,
        Ok(None) => {
            return json_error(
                StatusCode::NOT_FOUND,
                format!("conversation '{id}' not found"),
            );
        }
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if let Err(response) = resource_access(
        Ok(Some(tenancy.clone())),
        caller.as_ref(),
        node_org_id().as_deref(),
        &format!("conversation '{id}' not found"),
    ) {
        return response;
    }
    let collaborators = match state.conversations.list_collaborators(&id).await {
        Ok(collaborators) => collaborators,
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    Json(json!({
        "visibility": tenancy.visibility,
        "team_id": tenancy.team_id,
        "owner_user_id": tenancy.owner_user_id,
        "collaborators": collaborators,
        "can_manage": conversation_access_manager_authorized(
            &tenancy,
            caller.as_ref(),
            node_org_id().as_deref(),
        ),
    }))
    .into_response()
}

#[utoipa::path(
    put,
    path = "/api/conversations/{id}/access",
    tag = "Conversations",
    summary = "Change who can access a conversation",
    params(("id" = String, Path)),
    request_body(content = serde_json::Value, description = "`{ \"visibility\"?: string, \"team_id\"?: string, \"collaborators\"?: [...] }`"),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_access_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetConversationAccessBody>,
) -> axum::response::Response {
    if let Err(response) = require_conversation_access_manager(&state, &id, caller.as_ref()).await {
        return response;
    }
    let (visibility, team_id) =
        match validate_conversation_visibility(body.visibility.as_deref(), body.team_id.as_deref())
        {
            Ok(value) => value,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
        };
    if !conversation_team_scope_authorized(team_id, caller.as_ref(), node_org_id().as_deref()) {
        return json_error(StatusCode::FORBIDDEN, "team membership required".to_owned());
    }
    match state
        .conversations
        .set_access(&id, visibility, team_id, &body.collaborators, true)
        .await
    {
        Ok(true) => Json(json!({
            "ok": true,
            "visibility": visibility,
            "team_id": team_id,
            "collaborators": body.collaborators,
            "can_manage": true,
        }))
        .into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(error) => {
            let message = error.to_string();
            let status = if message.contains("collaborator")
                || message.contains("visibility")
                || message.contains("team_id")
            {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, message)
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/conversations/{id}/visibility",
    tag = "Conversations",
    summary = "Set a conversation's sharing visibility",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_conversation_visibility_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SetVisibilityBody>,
) -> axum::response::Response {
    if let Err(resp) = require_conversation_access_manager(&state, &id, caller.as_ref()).await {
        return resp;
    }
    let (visibility, team_id) =
        match validate_conversation_visibility(body.visibility.as_deref(), body.team_id.as_deref())
        {
            Ok(value) => value,
            Err(message) => return json_error(StatusCode::BAD_REQUEST, message),
        };
    if !conversation_team_scope_authorized(team_id, caller.as_ref(), node_org_id().as_deref()) {
        return json_error(StatusCode::FORBIDDEN, "team membership required".to_owned());
    }
    match state
        .conversations
        .set_visibility(&id, visibility, team_id, true)
        .await
    {
        Ok(true) => Json(json!({
            "ok": true,
            "visibility": visibility,
            "team_id": team_id,
        }))
        .into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        ),
        Err(e) => {
            let message = e.to_string();
            let status = if message.contains("only organization admins") {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_error(status, message)
        }
    }
}
