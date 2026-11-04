//! Conversation history handlers and local content sealing: `regenerate_message_handler` through `mark_conversation_messages_read_handler`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/conversations/:id/messages/:message_id/regenerate`
///
/// Point the active leaf at the user turn above the named assistant message so a
/// subsequent stream (with `skip_user_append`) appends a fresh assistant sibling.
/// Returns the parent (user) message id the reply will attach beneath.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/messages/{message_id}/regenerate",
    tag = "Conversations",
    summary = "Prepare to regenerate an assistant message",
    params(("id" = String, Path), ("message_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn regenerate_message_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, message_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state
        .conversations
        .prepare_regenerate(&id, &message_id)
        .await
    {
        Ok(Some(parent_id)) => {
            Json(json!({ "ok": true, "parent_message_id": parent_id })).into_response()
        }
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("assistant message '{message_id}' with a parent not found in '{id}'"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/messages/:message_id/select`
///
/// Switch the active version at a branch point to the given sibling and descend
/// to its leaf. The caller re-reads the active path to re-render the thread.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/messages/{message_id}/select",
    tag = "Conversations",
    summary = "Select a message version",
    params(("id" = String, Path), ("message_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn select_version_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, message_id)): axum::extract::Path<(String, String)>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    match state.conversations.select_version(&id, &message_id).await {
        Ok(Some(leaf)) => Json(json!({ "ok": true, "leaf_message_id": leaf })).into_response(),
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("message '{message_id}' not found in conversation '{id}'"),
        ),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// `POST /api/conversations/:id/messages/:message_id/feedback` body.
/// `rating` is `"up"` / `"down"` to set, or `null` (or omitted) to clear.
#[derive(serde::Deserialize)]
pub(in crate::server) struct MessageFeedbackBody {
    #[serde(default)]
    pub(in crate::server) rating: Option<String>,
    /// When true, and the exact `message_id` isn't in the conversation (a live
    /// reply still under its client-generated id, not yet reloaded), retarget the
    /// vote at the conversation's newest assistant message. The client sets this
    /// only for the latest turn, so the fallback can't mis-hit an older reply.
    #[serde(default)]
    pub(in crate::server) allow_latest_fallback: bool,
}

/// `POST /api/conversations/:id/messages/:message_id/feedback` — record a thumbs
/// 👍/👎 on an assistant reply. Persists the vote on the message (so the button
/// stays lit across reloads) and fans it out to the continual-learning reward and
/// RAG-memory sinks, each independently consent-gated (see
/// [`crate::learning::apply_message_feedback`]).
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/messages/{message_id}/feedback",
    tag = "Conversations",
    summary = "Thumbs up/down an assistant message",
    params(("id" = String, Path), ("message_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn set_message_feedback_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path((id, message_id)): axum::extract::Path<(String, String)>,
    Json(body): Json<MessageFeedbackBody>,
) -> axum::response::Response {
    // A vote mutates the message row AND feeds the learning/reward sinks, so it is
    // a write on the conversation.
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    // Normalize the rating: only "up"/"down" set a vote; anything else clears it.
    let rating = match body.rating.as_deref().map(str::trim) {
        Some("up") => Some("up"),
        Some("down") => Some("down"),
        Some("") | None => None,
        Some(other) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!("rating must be 'up', 'down', or null (got '{other}')"),
            );
        }
    };
    // Persist on the message first (source of truth for the UI state). If the id
    // isn't in this conversation (a live reply still under its client-generated
    // id) and the client flagged this as the latest turn, retarget the newest
    // assistant message so voting on a fresh reply works before any reload.
    let mut target = message_id.clone();
    let mut set = match state
        .conversations
        .set_message_feedback(&id, &target, rating)
        .await
    {
        Ok(set) => set,
        Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    if !set && body.allow_latest_fallback {
        match state.conversations.latest_assistant_message_id(&id).await {
            Ok(Some(latest)) => {
                set = state
                    .conversations
                    .set_message_feedback(&id, &latest, rating)
                    .await
                    .unwrap_or(false);
                if set {
                    target = latest;
                }
            }
            Ok(None) => {}
            Err(e) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    }
    if !set {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("message '{message_id}' not found in conversation '{id}'"),
        );
    }
    // Fan out to the reward + memory sinks (fail-soft; never fails the click).
    let outcome = crate::learning::apply_message_feedback(
        &state,
        &id,
        &target,
        rating,
        caller.as_ref().map(|value| value.user_id.as_str()),
    )
    .await;
    Json(json!({
        "ok": true,
        "rating": rating,
        "message_id": target,
        "reward_captured": outcome.reward_captured,
        "memory_captured": outcome.memory_captured,
    }))
    .into_response()
}

/// `GET /api/conversations/:id/feedback` — the rated messages of a conversation as
/// a `{ message_id: "up" | "down" }` map (un-rated messages omitted). Lets a
/// reloaded transcript restore its thumbs state without inflating the message read.
#[utoipa::path(
    get,
    path = "/api/conversations/{id}/feedback",
    tag = "Conversations",
    summary = "Get thumbs feedback for a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_conversation_feedback_handler(
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
    match state.conversations.list_feedback(&id).await {
        Ok(pairs) => {
            let map: serde_json::Map<String, serde_json::Value> = pairs
                .into_iter()
                .map(|(mid, rating)| (mid, serde_json::Value::String(rating)))
                .collect();
            Json(json!({ "feedback": map })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// The maximum number of message ids accepted by one read acknowledgement. A
/// visible viewport normally sends only a handful; the cap keeps a malformed
/// client from turning this idempotent endpoint into an unbounded write batch.
pub(in crate::server) const MAX_READ_MESSAGE_IDS: usize = 100;
pub(in crate::server) const READ_RECEIPT_ROSTER_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(2);

/// `POST /api/conversations/:id/read` body. The user identity is always taken
/// from the verified JWT, never from this payload.
#[derive(Debug, serde::Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct MarkConversationReadBody {
    #[serde(alias = "message_ids")]
    pub(in crate::server) message_ids: Vec<String>,
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct ConversationReadReceiptsResponse {
    pub(in crate::server) receipts: Vec<conversations::MessageReadReceipt>,
    pub(in crate::server) users: Vec<conversations::MessageReadReceiptUser>,
}

#[derive(Debug, serde::Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct MarkConversationReadResponse {
    pub(in crate::server) ok: bool,
    pub(in crate::server) receipts: Vec<conversations::MessageReadReceipt>,
}

/// `POST /api/conversations/:id/read` — persist the caller's read markers for
/// the supplied messages and fan out newly-created markers to other live viewers.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/read",
    tag = "Conversations",
    summary = "Mark conversation messages read",
    params(("id" = String, Path)),
    request_body = MarkConversationReadBody,
    responses((status = 200, description = "Read markers recorded", body = MarkConversationReadResponse))
)]
pub(in crate::server) async fn mark_conversation_messages_read_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<MarkConversationReadBody>,
) -> axum::response::Response {
    if let Err(resp) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    if body.message_ids.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "messageIds must contain at least one message id".to_owned(),
        );
    }
    if body.message_ids.len() > MAX_READ_MESSAGE_IDS {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!("messageIds must contain at most {MAX_READ_MESSAGE_IDS} ids"),
        );
    }
    let mut message_ids = Vec::with_capacity(body.message_ids.len());
    for raw_id in body.message_ids {
        let message_id = raw_id.trim();
        if message_id.is_empty() || message_id.len() > 200 {
            return json_error(
                StatusCode::BAD_REQUEST,
                "messageIds must contain non-empty ids up to 200 bytes".to_owned(),
            );
        }
        if !message_ids.iter().any(|existing| existing == message_id) {
            message_ids.push(message_id.to_owned());
        }
    }
    let Some(caller) = caller.as_ref() else {
        // Legacy local chats remain readable without a JWT, but a read marker
        // must still name a real human so it cannot become a spoofable team
        // receipt.
        return json_error(
            StatusCode::UNAUTHORIZED,
            "verified caller required for read receipts".to_owned(),
        );
    };
    match state
        .conversations
        .mark_messages_read(&id, &message_ids, &caller.user_id, caller.email.as_deref())
        .await
    {
        Ok(receipts) => Json(MarkConversationReadResponse { ok: true, receipts }).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
