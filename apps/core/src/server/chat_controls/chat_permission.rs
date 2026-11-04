//! Chat permission, question, cancel, control, retry, resume and browser-link handlers: `PermissionDecision` through `ChatRetryBody`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Body for `POST /api/chat/permission`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct PermissionDecision {
    /// The `requestId` from the `data-ryu-permission` stream part.
    pub(in crate::server) request_id: String,
    /// The chosen `optionId`; omit (or null) to cancel/reject the request.
    #[serde(default)]
    pub(in crate::server) option_id: Option<String>,
}

/// Body for `POST /api/chat/question`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct QuestionAnswerRequest {
    /// The conversation owning the pending ACP turn. This is both the ACL
    /// scope and part of the waiter key, preventing cross-conversation answers.
    pub(in crate::server) conversation_id: String,
    /// The stable ACP `toolCallId` from the Question `tool-input-available`
    /// frame.
    pub(in crate::server) tool_call_id: String,
    /// One answer object per rendered question. Core preserves the structured
    /// answer shape so the ACP adapter/client can interpret single, multi, text,
    /// and skipped answers without fabricating a new user message.
    pub(in crate::server) answers: Vec<serde_json::Value>,
}

/// `POST /api/chat/permission` — deliver the user's decision for an interactive
/// ACP tool-permission prompt, unblocking the awaiting agent turn. `resolved` is
/// `false` when no matching pending request was found (e.g. it already timed out).
#[utoipa::path(
    post,
    path = "/api/chat/permission",
    tag = "Chat",
    summary = "Resolve an interactive tool-permission prompt",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_permission(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<PermissionDecision>,
) -> axum::response::Response {
    // Human-in-the-loop INTEGRITY gate. This handler previously took neither `State`
    // nor the caller, so `attach_verified_caller` was inert on it: any holder of the
    // node token could APPROVE or DENY another user's pending tool-permission prompt.
    // The ids are `perm-<seq>` (sequential, trivially guessable), so that is not a
    // theoretical attack. Its body carries no conversation_id, so the gate is on the
    // PARENT conversation the prompt was raised in.
    let Some(scope) = crate::sidecar::adapters::acp::peek_permission_scope(&body.request_id) else {
        // No such pending request (already answered or timed out). Identical answer
        // to the pre-gate behaviour — and not an existence oracle, since an unowned
        // id and an expired id look the same.
        return Json(serde_json::json!({ "resolved": false })).into_response();
    };
    match scope.as_deref().filter(|s| !s.is_empty()) {
        Some(conversation_id) => {
            // A decision MUTATES the awaiting turn, so WRITE, not read.
            if let Err(resp) = require_resource_write(
                state.conversations.get_access_meta(conversation_id).await,
                caller.as_ref(),
                &format!("permission request '{}' not found", body.request_id),
            ) {
                return resp;
            }
        }
        // Pending, but raised by an ephemeral instance with no conversation to gate
        // on. Unbound node ⇒ single principal, allow (unchanged). BOUND node ⇒ fail
        // closed rather than let any node-token holder answer a prompt they may not
        // own.
        None if node_org_id().is_some() => {
            return json_error(
                StatusCode::FORBIDDEN,
                format!("permission request '{}' not found", body.request_id),
            );
        }
        None => {}
    }
    let resolved =
        crate::sidecar::adapters::acp::resolve_permission(&body.request_id, body.option_id);
    Json(serde_json::json!({ "resolved": resolved })).into_response()
}

/// `POST /api/chat/question` — resolve a structured ACP Question interaction.
/// The pending stream owns the waiter; this route only authenticates the
/// conversation and delivers the answer to that waiter.
#[utoipa::path(
    post,
    path = "/api/chat/question",
    tag = "Chat",
    summary = "Answer a pending structured Question tool call",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_question(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<QuestionAnswerRequest>,
) -> axum::response::Response {
    if body.conversation_id.trim().is_empty()
        || body.tool_call_id.trim().is_empty()
        || body.answers.is_empty()
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "conversation_id, tool_call_id, and at least one answer are required".to_owned(),
        );
    }

    let Some(scope) = crate::sidecar::adapters::acp::peek_question_scope(
        &body.conversation_id,
        &body.tool_call_id,
    ) else {
        return Json(serde_json::json!({ "resolved": false })).into_response();
    };

    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&scope).await,
        caller.as_ref(),
        &format!("question tool call '{}' not found", body.tool_call_id),
    ) {
        return resp;
    }

    let resolved = crate::sidecar::adapters::acp::resolve_question(
        &body.conversation_id,
        &body.tool_call_id,
        serde_json::Value::Array(body.answers),
    );
    Json(serde_json::json!({ "resolved": resolved })).into_response()
}

/// Body for `POST /api/chat/cancel`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct CancelRequest {
    /// The conversation id whose in-flight ACP turn should be cancelled.
    pub(in crate::server) conversation_id: String,
}

/// `POST /api/chat/cancel` — explicitly stop a conversation's in-flight agent turn.
/// Unlike a mere SSE disconnect (which Core lets finish so the assistant message
/// persists), this propagates ACP `session/cancel` or A2A `CancelTask` so the agent
/// actually stops, and stops any other persisted turn's detached driver.
/// `cancelled` is `false` when no live turn was found.
#[utoipa::path(
    post,
    path = "/api/chat/cancel",
    tag = "Chat",
    summary = "Cancel a conversation's in-flight agent turn",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_cancel(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CancelRequest>,
) -> axum::response::Response {
    // Per-resource ACL: cancelling someone else's in-flight turn is a write.
    if let Err(resp) =
        require_conversation_access_if_known(&state, &caller, &body.conversation_id, true).await
    {
        return resp;
    }
    let cancelled = cancel_conversation_turn(&body.conversation_id);
    Json(serde_json::json!({ "cancelled": cancelled })).into_response()
}

/// Stop a conversation's in-flight turn wherever it runs: the ACP agent
/// (`session/cancel`), the remote A2A task (`CancelTask`), and the durable driver
/// that streams the turn and its plugin hooks.
///
/// Every mechanism is signalled, never just the first that matches: an ACP or
/// A2A turn is itself driven by a durable driver wrapping the plugin hook loop,
/// and stopping only the agent would let a post-turn `continue` hook (goal,
/// auto-continue, proof) start the next turn right after the user pressed Stop.
/// Returns whether anything was running.
pub(crate) fn cancel_conversation_turn(conversation_id: &str) -> bool {
    signal_every_canceller(
        conversation_id,
        &[
            crate::sidecar::adapters::acp::request_cancel,
            crate::a2a::request_cancel,
            crate::sidecar::adapters::live_turn::request_cancel,
        ],
    )
}

/// Run every canceller, never stopping at the first that reports a live turn.
pub(in crate::server) fn signal_every_canceller(
    conversation_id: &str,
    cancellers: &[fn(&str) -> bool],
) -> bool {
    let mut cancelled = false;
    for cancel in cancellers {
        cancelled |= cancel(conversation_id);
    }
    cancelled
}

/// Body for `POST /api/chat/control`.
#[derive(serde::Deserialize)]
pub(in crate::server) struct ChatControlRequest {
    /// The conversation that owns the active turn. This is checked separately
    /// from the opaque turn id so a stale control cannot cross conversations.
    pub(in crate::server) conversation_id: String,
    /// Core-issued id for the live native provider turn.
    pub(in crate::server) turn_id: String,
    /// Extensible action field; the first supported action is `answer_now`.
    pub(in crate::server) action: String,
}

/// `POST /api/chat/control` — request a supported native provider to leave its
/// reasoning phase and continue with the final answer. This is intentionally a
/// separate action from `/api/chat/cancel`: Stop ends the whole turn, while
/// Answer now asks only the provider's reasoning loop to finish early.
#[utoipa::path(
    post,
    path = "/api/chat/control",
    tag = "Chat",
    summary = "Control a supported in-flight chat turn",
    request_body = serde_json::Value,
    responses((status = 200, description = "Accepted", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_control(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<ChatControlRequest>,
) -> axum::response::Response {
    if body.action != "answer_now" {
        return json_error(
            StatusCode::BAD_REQUEST,
            "unsupported chat control action".to_owned(),
        );
    }
    if let Err(resp) =
        require_conversation_access_if_known(&state, &caller, &body.conversation_id, true).await
    {
        return resp;
    }
    match crate::sidecar::adapters::turn_control::request_answer_now(
        &body.conversation_id,
        &body.turn_id,
    )
    .await
    {
        Ok(()) => Json(serde_json::json!({
            "accepted": true,
            "action": body.action,
            "strategy": "native",
        }))
        .into_response(),
        Err(crate::sidecar::adapters::turn_control::AnswerNowError::NotFound) => json_error(
            StatusCode::NOT_FOUND,
            "no supported in-flight turn was found".to_owned(),
        ),
        Err(crate::sidecar::adapters::turn_control::AnswerNowError::NotReady) => json_error(
            StatusCode::CONFLICT,
            "the turn is not ready for Answer now".to_owned(),
        ),
        Err(crate::sidecar::adapters::turn_control::AnswerNowError::AlreadyRequested) => {
            json_error(
                StatusCode::CONFLICT,
                "Answer now is already in progress".to_owned(),
            )
        }
        Err(crate::sidecar::adapters::turn_control::AnswerNowError::Provider(error)) => {
            json_error(StatusCode::BAD_GATEWAY, error)
        }
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct ChatRetryBody {
    /// The only currently supported automatic retry reason. Keeping the reason
    /// explicit makes this endpoint auditable and prevents a generic hidden
    /// "run the last prompt again" action from appearing by accident.
    #[serde(default)]
    pub(in crate::server) reason: Option<String>,
}
