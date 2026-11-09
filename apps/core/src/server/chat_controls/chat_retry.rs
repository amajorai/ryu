//! Chat permission, question, cancel, control, retry, resume and browser-link handlers: `chat_retry` through `chat_browser_session_link`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/chat/retry/:conversation_id` — start one bounded retry for a
/// terminal chat run that the reconnect-retry desktop feature observed during a
/// connectivity outage.
///
/// Core owns the important part of this contract: ACL, permission, terminal-state
/// validation, and the atomic claim. The desktop only supplies an outage signal;
/// it cannot force a second turn into a conversation it cannot write.
#[utoipa::path(
    post,
    path = "/api/chat/retry/{conversation_id}",
    tag = "Chat",
    summary = "Retry a terminal chat turn after reconnect",
    params(("conversation_id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 202, description = "Retry accepted", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_retry(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Extension(user_jwt): Extension<Option<String>>,
    Path(conversation_id): Path<String>,
    Json(body): Json<ChatRetryBody>,
) -> axum::response::Response {
    if body.reason.as_deref() != Some("network_reconnect") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "unsupported chat retry reason".to_owned(),
        );
    }
    if enforce_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_RUN,
    )
    .await
    .is_err()
    {
        return json_error(
            StatusCode::FORBIDDEN,
            "insufficient permissions: agent.run".to_owned(),
        );
    }
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&conversation_id).await,
        caller.as_ref(),
        "conversation not found",
    ) {
        return resp;
    }

    let summary = match state.conversations.get_run_summary(&conversation_id).await {
        Ok(Some(summary)) => summary,
        Ok(None) => {
            return json_error(StatusCode::NOT_FOUND, "conversation not found".to_owned());
        }
        Err(error) => {
            tracing::warn!(conversation_id, "failed to load retry summary: {error:#}");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "conversation lookup failed".to_owned(),
            );
        }
    };
    if !matches!(
        summary.run_status.as_deref(),
        Some("failed" | "interrupted")
    ) {
        return json_error(
            StatusCode::CONFLICT,
            format!(
                "conversation is not retryable in its current state: {}",
                summary.run_status.as_deref().unwrap_or("idle")
            ),
        );
    }

    let messages = match state
        .conversations
        .get_active_messages(&conversation_id)
        .await
    {
        Ok(messages) => messages,
        Err(error) => {
            tracing::warn!(conversation_id, "failed to load retry history: {error:#}");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "conversation history lookup failed".to_owned(),
            );
        }
    };
    let Some(last_user) = messages.iter().rev().find(|message| message.role == "user") else {
        return json_error(
            StatusCode::CONFLICT,
            "conversation has no persisted user turn to retry".to_owned(),
        );
    };
    if last_user.content.trim().is_empty() {
        return json_error(
            StatusCode::CONFLICT,
            "conversation's last user turn is empty".to_owned(),
        );
    }

    // The conditional update closes the two-window race between the summary read
    // and starting the background stream. Only one reconnecting desktop can win.
    match state
        .conversations
        .claim_terminal_run_for_retry(&conversation_id)
        .await
    {
        Ok(true) => {}
        Ok(false) => {
            return json_error(
                StatusCode::CONFLICT,
                "conversation was already claimed or is no longer retryable".to_owned(),
            );
        }
        Err(error) => {
            tracing::warn!(conversation_id, "failed to claim chat retry: {error:#}");
            return json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "could not claim chat retry".to_owned(),
            );
        }
    }

    let mut req = rerun_request_from_history(&conversation_id, summary, messages);
    req.author_user_id = caller.as_ref().map(|value| value.user_id.clone());
    req.verified_caller = caller;
    req.user_jwt = user_jwt;
    spawn_detached_chat_turn(state, req);

    (
        StatusCode::ACCEPTED,
        Json(json!({
            "ok": true,
            "conversation_id": conversation_id,
            "run_status": "running"
        })),
    )
        .into_response()
}

/// Rebuild the request that runs a conversation's last persisted user turn
/// again, with no client attached. The user row already exists, so the turn
/// only appends a fresh assistant reply. Shared by the reconnect retry route and
/// the boot auto-resume task; callers add the caller identity when they have one.
pub(crate) fn rerun_request_from_history(
    conversation_id: &str,
    summary: conversations::ConversationSummary,
    messages: Vec<conversations::StoredMessage>,
) -> ChatStreamRequest {
    let messages = messages
        .into_iter()
        .map(|message| {
            let parts = message
                .parts
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            UiMessage {
                metadata: None,
                role: message.role,
                content: UiContent::Text(message.content),
                parts,
            }
        })
        .collect();
    ChatStreamRequest {
        messages,
        agent_id: summary.agent_id,
        conversation_id: Some(conversation_id.to_owned()),
        cwd: summary.folder_path.clone(),
        workspace_folders: summary.folder_path.into_iter().collect(),
        worktree_isolation: summary.worktree_path.is_some(),
        branch: summary.branch,
        worktree_path: summary.worktree_path,
        persist: true,
        skip_user_append: true,
        ..Default::default()
    }
}

/// Run a persisted chat turn in the background with nobody reading the SSE
/// response. Draining the stream keeps the turn alive and lets it persist its
/// outcome; any mounted ChatPage can attach through the normal resume endpoint.
pub(crate) fn spawn_detached_chat_turn(
    state: ServerState,
    req: ChatStreamRequest,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        use futures_util::StreamExt;

        let response = run_chat_with_hooks(state, req).await;
        let mut stream = response.into_body().into_data_stream();
        while let Some(chunk) = stream.next().await {
            if chunk.is_err() {
                break;
            }
        }
    })
}

/// `GET /api/chat/stream/resume/:conversation_id` — reconnect to an in-flight
/// turn's live UI frame stream. Replays the turn so far (compacted UI message
/// chunks: text, reasoning, tool and data parts), then forwards live frames until
/// the turn completes. The `x-ryu-resume-replay` response header is `full` when
/// the replay starts at the turn's first chunk, or `live` when an oversized turn
/// could replay only its still-open parts. Returns 404 when no turn is running
/// for the conversation.
#[utoipa::path(
    get,
    path = "/api/chat/stream/resume/{conversation_id}",
    tag = "Chat",
    summary = "Resume an in-flight chat turn (SSE)",
    params(("conversation_id" = String, Path)),
    responses((status = 200, description = "Server-Sent Events stream"))
)]
pub(in crate::server) async fn chat_stream_resume(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(conversation_id): axum::extract::Path<String>,
) -> axum::response::Response {
    // Per-resource ACL: this replays the accumulated reply text of a live turn and
    // then forwards every token of it — a read of the conversation by another name.
    if let Err(resp) =
        require_conversation_access_if_known(&state, &caller, &conversation_id, false).await
    {
        return resp;
    }
    match crate::sidecar::adapters::subscribe_live_stream(&conversation_id) {
        Some(subscription) => {
            use crate::sidecar::adapters::live_turn::{
                RESUME_REPLAY_FULL, RESUME_REPLAY_HEADER, RESUME_REPLAY_LIVE,
            };
            let mut response = crate::sidecar::adapters::sse_response(
                axum::body::Body::from_stream(subscription.frames),
            );
            // Core states what the replay holds rather than leaving the client to
            // infer it from the first chunk (a hook note can precede `start`).
            response.headers_mut().insert(
                axum::http::HeaderName::from_static(RESUME_REPLAY_HEADER),
                axum::http::HeaderValue::from_static(if subscription.replay_complete {
                    RESUME_REPLAY_FULL
                } else {
                    RESUME_REPLAY_LIVE
                }),
            );
            response
        }
        None => {
            // No live turn — return 404 so the client knows not to wait.
            axum::response::Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header("Content-Type", "application/json")
                .body(axum::body::Body::from(
                    serde_json::json!({ "error": "no running turn" }).to_string(),
                ))
                .unwrap_or_default()
        }
    }
}

#[derive(Debug, Deserialize)]
pub(in crate::server) struct ClientToolResultBody {
    pub(in crate::server) conversation_id: String,
    pub(in crate::server) tool_call_id: String,
    pub(in crate::server) nonce: String,
    pub(in crate::server) result: serde_json::Value,
    pub(in crate::server) provenance: serde_json::Value,
}

/// Resolve one paused client tool call. The lane is chosen by the pending
/// call record, never by the client: a pending device call takes the device
/// lane (signed by the target phone, bound to its claim and frozen input
/// hash; see `device_tools_api`), anything else the browser lane, whose nonce
/// is single-use and short-lived. The conversation ACL and verified caller are
/// checked before any waiter is released.
#[utoipa::path(
	post,
	path = "/api/chat/client-tool-result",
	tag = "Chat",
	summary = "Resume a paused client browser tool call",
	request_body = serde_json::Value,
	responses((status = 200, description = "Accepted", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_client_tool_result(
    State(state): State<ServerState>,
    headers: axum::http::HeaderMap,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    authorization: Option<Extension<ResolvedAuthorization>>,
    body: axum::body::Bytes,
) -> axum::response::Response {
    let Ok(routing) = serde_json::from_slice::<ClientToolResultRouting>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid client tool result".to_owned(),
        );
    };
    if let Err(resp) =
        require_conversation_access_if_known(&state, &caller, &routing.conversation_id, true).await
    {
        return resp;
    }
    if is_device_result(&routing.conversation_id, &routing.tool_call_id) {
        return resolve_device_result(
            &headers,
            &body,
            authorization.as_ref().map(|Extension(auth)| auth),
            caller.as_ref(),
        );
    }
    let Ok(body) = serde_json::from_slice::<ClientToolResultBody>(&body) else {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid browser tool result".to_owned(),
        );
    };
    // An owned conversation never accepts an anonymous browser result.
    let conversation_owner = state
        .conversations
        .get_access_meta(&body.conversation_id)
        .await
        .ok()
        .flatten()
        .and_then(|meta| meta.owner_user_id);
    if !crate::sidecar::adapters::browser_result_owner_ok(
        conversation_owner.as_deref(),
        caller.as_ref().map(|value| value.user_id.as_str()),
    ) {
        return json_error(
            StatusCode::FORBIDDEN,
            "browser tool result owner mismatch".to_owned(),
        );
    }
    match crate::sidecar::adapters::resolve_client_tool_result(
        &body.conversation_id,
        &body.tool_call_id,
        &body.nonce,
        body.result,
        &body.provenance,
        caller.as_ref().map(|value| value.user_id.as_str()),
    ) {
        Ok(()) => (StatusCode::OK, Json(json!({ "ok": true }))).into_response(),
        Err(error) => json_error(StatusCode::BAD_REQUEST, error),
    }
}

/// The fields that select a lane, read before either lane's full body.
#[derive(Debug, Deserialize)]
pub(in crate::server) struct ClientToolResultRouting {
    pub(in crate::server) conversation_id: String,
    pub(in crate::server) tool_call_id: String,
}

#[derive(Debug, serde::Deserialize)]
pub(in crate::server) struct BrowserSessionLinkBody {
    pub(in crate::server) assistant_text: String,
    pub(in crate::server) browser_model: String,
    pub(in crate::server) browser_surface: String,
    pub(in crate::server) conversation_id: String,
    pub(in crate::server) page_title: String,
    pub(in crate::server) page_url: String,
    #[serde(default)]
    pub(in crate::server) tool_summary: Vec<String>,
    pub(in crate::server) user_text: String,
}

/// Persist the browser-local transcript as a normal Core conversation while
/// keeping page bodies, DOM indexes, screenshots, and raw tool results local.
#[utoipa::path(
    post,
    path = "/api/chat/browser-session-link",
    tag = "Chat",
    summary = "Link a browser-local transcript",
    request_body = serde_json::Value,
    responses((status = 200, description = "Linked", body = serde_json::Value))
)]
pub(in crate::server) async fn chat_browser_session_link(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<BrowserSessionLinkBody>,
) -> axum::response::Response {
    if !matches!(
        body.browser_surface.as_str(),
        "dashboard" | "new-tab" | "ask-ryu" | "in-page"
    ) {
        return json_error(
            StatusCode::BAD_REQUEST,
            "invalid browser surface".to_owned(),
        );
    }
    if body.conversation_id.len() > 160
        || body.user_text.len() > 12_000
        || body.assistant_text.len() > 12_000
        || body.page_title.len() > 500
        || body.page_url.len() > 2_000
        || body.tool_summary.len() > 32
        || body.tool_summary.iter().any(|value| value.len() > 240)
    {
        return json_error(
            StatusCode::BAD_REQUEST,
            "browser session link is too large".to_owned(),
        );
    }
    if let Err(resp) =
        require_conversation_access_if_known(&state, &caller, &body.conversation_id, true).await
    {
        return resp;
    }

    let metadata = format!(
        "[Browser session] surface={} model={} page_title={} page_url={} tools={}",
        body.browser_surface,
        body.browser_model,
        body.page_title,
        body.page_url,
        body.tool_summary.join(", ")
    );
    let tenancy = conversations::Tenancy::owned_by(
        caller.as_ref().map(|value| value.user_id.as_str()),
        caller.as_ref().and_then(|value| value.org_id.as_deref()),
    );
    if let Err(error) = state
        .conversations
        .append_message_as(
            &body.conversation_id,
            "user",
            &format!("{metadata}\n\n{}", body.user_text),
            None,
            caller.as_ref().map(|value| value.user_id.as_str()),
            None,
            tenancy.clone(),
        )
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    if let Err(error) = state
        .conversations
        .append_message_as(
            &body.conversation_id,
            "assistant",
            &body.assistant_text,
            Some(body.browser_model.as_str()),
            None,
            None,
            tenancy,
        )
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    (StatusCode::OK, Json(json!({ "linked": true }))).into_response()
}
