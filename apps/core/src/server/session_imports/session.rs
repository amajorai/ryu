//! Session handlers (spec unit U004/#118).
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

// ── Session handlers (spec unit U004/#118) ────────────────────────────────────

#[derive(serde::Deserialize)]
pub(in crate::server) struct CreateSessionBody {
    pub(in crate::server) runnable_id: String,
    pub(in crate::server) runnable_kind: crate::runnable::RunnableKind,
    #[serde(default)]
    pub(in crate::server) agent_id: Option<String>,
    #[serde(default)]
    pub(in crate::server) title: Option<String>,
}

#[utoipa::path(
    post,
    path = "/api/sessions",
    tag = "Conversations",
    summary = "Create a session",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_session_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreateSessionBody>,
) -> axum::response::Response {
    if body.runnable_id.trim().is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "runnable_id is required".to_owned(),
        );
    }
    match state
        .conversations
        .create_session(
            body.runnable_id.trim(),
            body.runnable_kind,
            body.agent_id.as_deref(),
            body.title.as_deref(),
            // A session mints a NEW conversation; it is born with its owner stamped by
            // the store's choke point, so every gate keyed on that conversation
            // (get/delete/fork/chat/worktree/…) is non-vacuous from the first instant.
            caller_tenancy(&caller),
        )
        .await
    {
        Ok(session) => Json(json!({ "session": session })).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/sessions/{id}",
    tag = "Conversations",
    summary = "Get a session",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_session_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    if let Err(resp) = require_parent_conversation(
        &state,
        &caller,
        state.conversations.conversation_id_for_session(&id).await,
        false,
        &format!("session '{id}' not found"),
    )
    .await
    {
        return resp;
    }
    match state.conversations.get_session(&id).await {
        Ok(Some(session)) => Json(json!({ "session": session })).into_response(),
        Ok(None) => json_error(StatusCode::NOT_FOUND, format!("session '{id}' not found")),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct UpdateSessionStatusBody {
    pub(in crate::server) status: SessionStatus,
}

#[utoipa::path(
    post,
    path = "/api/sessions/{id}/status",
    tag = "Conversations",
    summary = "Update a session's status",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn update_session_status_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<UpdateSessionStatusBody>,
) -> axum::response::Response {
    if let Err(resp) = require_parent_conversation(
        &state,
        &caller,
        state.conversations.conversation_id_for_session(&id).await,
        true,
        &format!("session '{id}' not found"),
    )
    .await
    {
        return resp;
    }
    match state
        .conversations
        .update_session_status(&id, body.status)
        .await
    {
        Ok(true) => Json(json!({ "success": true })).into_response(),
        Ok(false) => json_error(StatusCode::NOT_FOUND, format!("session '{id}' not found")),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}/sessions",
    tag = "Conversations",
    summary = "List a conversation's sessions",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn list_sessions_for_conversation_handler(
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
    match state
        .conversations
        .list_sessions_for_conversation(&id)
        .await
    {
        Ok(sessions) => {
            Json(json!({ "conversation_id": id, "sessions": sessions })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Resolve a registered agent id to its engine (the `AgentInfo.engine` value,
/// e.g. `claude`/`codex`), so the native-history reader knows which on-disk store
/// to read. Native history is a privileged local capability: an arbitrary agent
/// id must never become an arbitrary filesystem-backed engine selector.
pub(in crate::server) fn resolve_registered_agent_engine(
    state: &ServerState,
    agent_id: &str,
) -> Option<String> {
    state
        .agents
        .list_infos()
        .into_iter()
        .find(|i| i.id == agent_id)
        .and_then(|i| i.engine)
        .map(|engine| engine.strip_prefix("acp:").unwrap_or(&engine).to_string())
}

/// Native-history files belong to the node, so a registered/shared node must
/// establish the caller's tenancy before Core touches the native transcript
/// directory. This check intentionally runs before agent resolution and before
/// `spawn_blocking`: the filesystem reader is not an authorization mechanism.
pub(in crate::server) fn native_history_access_denied(
    caller: Option<&crate::identity_verify::VerifiedCaller>,
) -> Option<axum::response::Response> {
    let node = crate::sidecar::control_plane::registered_node()?;
    let Some(caller) = caller else {
        return Some(json_error(
            StatusCode::FORBIDDEN,
            "native history requires an authenticated caller".to_string(),
        ));
    };
    node_scope_denial_reason(&node, caller).map(|reason| {
        json_error(
            StatusCode::FORBIDDEN,
            format!("native history is outside this caller's node scope: {reason}"),
        )
    })
}

/// List the threads in an agent's own on-disk history store (Claude Code / Codex)
/// that Ryu can import. Optional `?cwd=` filters to threads from one directory.
/// Unsupported engines return an empty list (not an error) so the UI can always
/// offer the affordance and show an empty state.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/threads",
    tag = "Agents",
    summary = "List an agent's importable native threads",
    params(
        ("id" = String, Path),
        ("cwd" = Option<String>, Query, description = "Filter to threads from this working directory")
    ),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn list_agent_threads_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(agent_id): axum::extract::Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> axum::response::Response {
    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        &agent_id,
    )
    .await
    {
        return response;
    }
    if let Some(response) = native_history_access_denied(caller.as_ref()) {
        return response;
    }
    let engine = match resolve_registered_agent_engine(&state, &agent_id) {
        Some(e) => e,
        None => {
            return Json(json!({ "agent_id": agent_id, "threads": [] })).into_response();
        }
    };
    let cwd = params
        .get("cwd")
        .map(String::as_str)
        .filter(|s| !s.is_empty());
    // Blocking filesystem scan — hop off the async runtime.
    let result = tokio::task::spawn_blocking({
        let engine = engine.clone();
        let cwd = cwd.map(str::to_string);
        move || crate::native_history::list_threads(&engine, cwd.as_deref())
    })
    .await;
    match result {
        Ok(Ok(threads)) => Json(json!({
            "agent_id": agent_id,
            "engine": engine,
            "supported": crate::native_history::engine_supports_history(&engine),
            "threads": threads,
        }))
        .into_response(),
        Ok(Err(e)) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct ImportThreadBody {
    pub(in crate::server) thread_id: String,
    #[serde(default)]
    pub(in crate::server) dry_run: bool,
}

/// Return the not-yet-imported tail of a native transcript.
///
/// Ryu messages may have been appended between imports, so this reconciles the
/// imported prefix against all existing messages rather than comparing lengths.
/// Native timestamps are used when present so repeated prompts with the same
/// text remain distinct. Matching independent of stored order also handles a
/// source line without a timestamp sorting after later timestamped lines.
pub(in crate::server) fn missing_imported_message_tail<'a>(
    existing: &[crate::server::conversations::StoredMessage],
    imported: &'a [crate::native_history::ImportedMessage],
) -> &'a [crate::native_history::ImportedMessage] {
    let mut imported_index = 0;
    let mut matched_existing = vec![false; existing.len()];
    for imported_message in imported {
        let existing_index = existing.iter().enumerate().position(|(index, message)| {
            !matched_existing[index]
                && message.role == imported_message.role
                && message.content == imported_message.content
                && imported_message
                    .created_at
                    .is_none_or(|created_at| created_at == message.created_at)
        });
        let Some(existing_index) = existing_index else {
            break;
        };
        matched_existing[existing_index] = true;
        imported_index += 1;
    }
    &imported[imported_index..]
}

pub(in crate::server) fn import_reuse_permission(
    result: Result<(), axum::response::Response>,
) -> Result<bool, axum::response::Response> {
    match result {
        Ok(()) => Ok(true),
        Err(response)
            if matches!(
                response.status(),
                StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
            ) =>
        {
            Ok(false)
        }
        Err(response) => Err(response),
    }
}
