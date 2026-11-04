//! Conversation history handlers and local content sealing: `get_conversation_read_receipts_handler` through `put_agent_ui_state_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `GET /api/conversations/:id/read-receipts` — hydrate all durable read
/// markers for a conversation in one read. The route shares the normal
/// conversation ACL, so viewers can see the roster only when they can read the
/// conversation itself.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/read-receipts",
    tag = "Conversations",
    summary = "Get conversation read receipts",
    params(("id" = String, Path)),
    responses((status = 200, description = "Read receipt roster", body = ConversationReadReceiptsResponse))
)]
pub(in crate::server) async fn get_conversation_read_receipts_handler(
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
    match state.conversations.list_read_receipts(&id).await {
        Ok(receipts) => {
            let receipt_user_ids: std::collections::HashSet<&str> = receipts
                .iter()
                .map(|receipt| receipt.user_id.as_str())
                .collect();
            let users = if !receipt_user_ids.is_empty()
                && caller.as_ref().is_some_and(|value| value.org_id.is_some())
                && crate::sidecar::control_plane::registered_org().is_some()
            {
                tokio::time::timeout(
                    READ_RECEIPT_ROSTER_TIMEOUT,
                    crate::sidecar::control_plane::resolve_notify_targets(&state.client, None),
                )
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
                .into_iter()
                .filter(|user| receipt_user_ids.contains(user.user_id.as_str()))
                .map(|user| conversations::MessageReadReceiptUser {
                    id: user.user_id.clone(),
                    name: user.name.unwrap_or_else(|| user.user_id.clone()),
                    avatar: user.image,
                })
                .collect()
            } else {
                Vec::new()
            };
            Json(ConversationReadReceiptsResponse { receipts, users }).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// The identity a reaction is attributed to: the verified caller's `user_id`, or
/// the `LOCAL_USER` sentinel when the request is anonymous (loopback / node-token
/// single-tenant flow). Never read from a request body.
///
/// Deliberately NOT [`memory_owner_user_id`]: that one collapses to `LOCAL_USER`
/// on an *unbound* node even for a verified caller, because memory is scoped per
/// tenant. A reaction is per **person** — collapsing two signed-in users onto one
/// id would merge their reactions in the `(message_id, user_id, emoji)` key.
pub(in crate::server) fn reaction_user_id(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> String {
    caller
        .as_ref()
        .map(|c| c.user_id.clone())
        .unwrap_or_else(|| memory::LOCAL_USER.to_owned())
}

/// `POST|DELETE /api/conversations/:id/messages/:message_id/reactions` body.
#[derive(serde::Deserialize)]
pub(in crate::server) struct MessageReactionBody {
    /// The emoji to add/remove. Required — a missing field is a 422, not a silent
    /// no-op. The reacting user is NOT in this body; it comes from the JWT.
    pub(in crate::server) emoji: String,
}

/// Longest accepted `emoji` in bytes. Comfortably covers the longest real
/// grapheme cluster (a ZWJ family sequence with skin-tone modifiers is ~35 bytes)
/// while stopping the field being used as an unbounded per-message write
/// primitive — it lands in a TEXT PRIMARY KEY column with no other constraint.
pub(in crate::server) const MAX_REACTION_EMOJI_BYTES: usize = 64;

/// Validate and normalize a reaction emoji, or return the 400 to send back.
pub(in crate::server) fn normalize_reaction_emoji(
    raw: &str,
) -> Result<String, axum::response::Response> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            "emoji must not be empty".to_owned(),
        ));
    }
    if trimmed.len() > MAX_REACTION_EMOJI_BYTES {
        return Err(json_error(
            StatusCode::BAD_REQUEST,
            format!("emoji must be at most {MAX_REACTION_EMOJI_BYTES} bytes"),
        ));
    }
    Ok(trimmed.to_owned())
}

/// `POST /api/conversations/:id/messages/:message_id/reactions` — add an emoji
/// reaction to a persisted message, as the verified caller.
///
/// 404s when the message is not in this conversation, which is also the
/// **persistence gate**: a still-streaming reply carries a client-generated id
/// that has no row yet, so it cannot be reacted to until it lands. There is
/// deliberately no `allow_latest_fallback` twin of the feedback retarget hack —
/// retargeting a *per-person* row at "the newest assistant message" would attach
/// someone's reaction to a message they never saw.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/messages/{message_id}/reactions",
    tag = "Conversations",
    summary = "Add an emoji reaction to a message",
    params(("id" = String, Path), ("message_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn add_message_reaction_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, message_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<MessageReactionBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let emoji = match normalize_reaction_emoji(&body.emoji) {
        Ok(emoji) => emoji,
        Err(resp) => return resp,
    };
    let user_id = reaction_user_id(&caller);
    match state
        .conversations
        .add_reaction(&id, &message_id, &user_id, &emoji)
        .await
    {
        Ok(true) => Json(json!({
            "ok": true,
            "message_id": message_id,
            "emoji": emoji,
        }))
        .into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("message '{message_id}' not found in conversation '{id}'"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `DELETE /api/conversations/:id/messages/:message_id/reactions` — remove the
/// caller's own `{ emoji }` reaction. Removing one that was never placed is a
/// success (idempotent un-react); an unknown message is still a 404.
#[utoipa::path(
    delete,
    path = "/api/conversations/{id}/messages/{message_id}/reactions",
    tag = "Conversations",
    summary = "Remove an emoji reaction from a message",
    params(("id" = String, Path), ("message_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn remove_message_reaction_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, message_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<MessageReactionBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    let emoji = match normalize_reaction_emoji(&body.emoji) {
        Ok(emoji) => emoji,
        Err(resp) => return resp,
    };
    let user_id = reaction_user_id(&caller);
    match state
        .conversations
        .remove_reaction(&id, &message_id, &user_id, &emoji)
        .await
    {
        Ok(true) => Json(json!({
            "ok": true,
            "message_id": message_id,
            "emoji": emoji,
        }))
        .into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("message '{message_id}' not found in conversation '{id}'"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `GET /api/conversations/:id/reactions` — every reaction bucket of a
/// conversation as `{ reactions: [{ message_id, emoji, count, reacted_by_me }] }`.
///
/// ONE call fetched alongside the transcript, exactly like the feedback read and
/// for the same reason: it restores the chip row on reload without inflating
/// `get_messages` (which has many non-UI callers). `reacted_by_me` is resolved
/// against the verified caller.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/reactions",
    tag = "Conversations",
    summary = "Get emoji reactions for a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_conversation_reactions_handler(
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
    let user_id = reaction_user_id(&caller);
    match state.conversations.list_reactions(&id, &user_id).await {
        Ok(reactions) => Json(json!({ "reactions": reactions })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Longest accepted tool call id. Provider ids are short; this only bounds the key.
pub(in crate::server) const MAX_AGENT_UI_TOOL_CALL_ID_BYTES: usize = 256;

/// `PUT /api/conversations/:id/ui-state/:tool_call_id` body.
#[derive(serde::Deserialize)]
pub(in crate::server) struct AgentUiStateBody {
    /// The widget's state. Opaque to Core beyond being a JSON object.
    pub(in crate::server) state: serde_json::Value,
}

/// `GET /api/conversations/:id/ui-state` — every saved `ui.render` widget state in
/// a conversation as `{ states: { "<tool_call_id>": <state> } }`. One call fetched
/// alongside the transcript, like reactions, so widgets reopen as the user left
/// them without inflating `get_messages`.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/ui-state",
    tag = "Conversations",
    summary = "Get saved generative-UI widget state for a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_agent_ui_state_handler(
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
    match state.conversations.list_agent_ui_states(&id).await {
        Ok(rows) => {
            let states: serde_json::Map<String, serde_json::Value> = rows
                .into_iter()
                .map(|row| (row.tool_call_id, row.state))
                .collect();
            Json(json!({ "states": states })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `PUT /api/conversations/:id/ui-state/:tool_call_id` — save one widget's state.
/// Last write wins; the widget is shared by everyone who can write the
/// conversation, like the transcript itself.
#[utoipa::path(
    put,
    path = "/api/conversations/{id}/ui-state/{tool_call_id}",
    tag = "Conversations",
    summary = "Save a generative-UI widget's state",
    params(("id" = String, Path), ("tool_call_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn put_agent_ui_state_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, tool_call_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<AgentUiStateBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    if let Err(resp) = validate_agent_ui_state(&tool_call_id, &body.state) {
        return resp;
    }
    let state_json = body.state.to_string();
    match state
        .conversations
        .set_agent_ui_state(&id, &tool_call_id, &state_json)
        .await
    {
        Ok(true) => Json(json!({ "ok": true, "tool_call_id": tool_call_id })).into_response(),
        Ok(false) => json_error(
            StatusCode::CONFLICT,
            format!(
                "conversation '{id}' already stores the maximum of {} widget states",
                conversations::MAX_AGENT_UI_STATES
            ),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
