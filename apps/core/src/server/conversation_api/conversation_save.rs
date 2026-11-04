//! Conversation history handlers and local content sealing: `save_temporary_conversation_handler` through `delete_annotation_items_for_run`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/conversations/:id/save` — promote a temporary chat snapshot into
/// a normal conversation. Temporary turns stay client-held until this explicit
/// action, so the endpoint is a creation path rather than an update path.
#[utoipa::path(
    post,
    path = "/api/conversations/{id}/save",
    tag = "Conversations",
    summary = "Save a temporary chat",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 201, description = "Saved conversation", body = serde_json::Value))
)]
pub(in crate::server) async fn save_temporary_conversation_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    Json(body): Json<SaveTemporaryConversationBody>,
) -> axum::response::Response {
    // Saving promotes client-held content into the conversation store. Use the
    // same agent-run gate as the chat route so an unverified node-token caller or
    // a valid JWT from another organization cannot mint an owned conversation.
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
    let conversation_id = id.trim();
    if conversation_id.is_empty() || conversation_id.len() > 200 {
        return json_error(
            StatusCode::BAD_REQUEST,
            "temporary chat id must be between 1 and 200 bytes".to_owned(),
        );
    }
    if body.messages.is_empty() {
        return json_error(
            StatusCode::BAD_REQUEST,
            "a temporary chat must contain at least one message".to_owned(),
        );
    }
    if body.messages.len() > MAX_TEMPORARY_SNAPSHOT_MESSAGES {
        return json_error(
            StatusCode::BAD_REQUEST,
            format!(
                "a temporary chat may contain at most {MAX_TEMPORARY_SNAPSHOT_MESSAGES} messages"
            ),
        );
    }

    let agent_id = body
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let folder_path = body
        .folder_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let caller_user_id = caller.as_ref().map(|value| value.user_id.clone());
    let created_at = chrono_now_ms();
    let mut messages = Vec::with_capacity(body.messages.len());
    for (index, message) in body.messages.into_iter().enumerate() {
        let role = message.role.trim();
        if !matches!(role, "user" | "assistant") {
            return json_error(
                StatusCode::BAD_REQUEST,
                "temporary chat messages must be user or assistant turns".to_owned(),
            );
        }
        if message.content.len() > MAX_TEMPORARY_SNAPSHOT_MESSAGE_BYTES {
            return json_error(
                StatusCode::BAD_REQUEST,
                format!(
                    "temporary chat message {index} is too large (max {MAX_TEMPORARY_SNAPSHOT_MESSAGE_BYTES} bytes)"
                ),
            );
        }
        let parts = (!message.parts.is_empty()).then(|| serde_json::Value::Array(message.parts));
        if let Some(parts) = parts.as_ref() {
            let parts_bytes = match serde_json::to_vec(parts) {
                Ok(bytes) => bytes.len(),
                Err(_) => {
                    return json_error(
                        StatusCode::BAD_REQUEST,
                        format!("temporary chat message {index} has invalid parts"),
                    );
                }
            };
            if parts_bytes > MAX_TEMPORARY_SNAPSHOT_PARTS_BYTES {
                return json_error(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "temporary chat message {index} parts are too large (max {MAX_TEMPORARY_SNAPSHOT_PARTS_BYTES} bytes)"
                    ),
                );
            }
        }
        messages.push(conversations::TemporaryConversationMessage {
            role: role.to_owned(),
            content: message.content,
            agent_id: (role == "assistant").then(|| agent_id.clone()).flatten(),
            author_user_id: (role == "user").then(|| caller_user_id.clone()).flatten(),
            parts,
            metadata: message.metadata.filter(|value| value.is_object()),
            created_at: created_at + index as i64,
        });
    }

    match state.conversations.get_access_meta(conversation_id).await {
        Ok(Some(_)) => {
            return json_error(
                StatusCode::CONFLICT,
                "conversation already exists".to_owned(),
            );
        }
        Ok(None) => {}
        Err(error) => {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }

    match state
        .conversations
        .save_temporary_conversation(
            conversation_id,
            agent_id.as_deref(),
            folder_path.as_deref(),
            &messages,
            caller_tenancy(&caller),
        )
        .await
    {
        Ok(conversation) => (
            StatusCode::CREATED,
            Json(json!({ "conversation": conversation })),
        )
            .into_response(),
        Err(error) if error.to_string().contains("conversation already exists") => json_error(
            StatusCode::CONFLICT,
            "conversation already exists".to_owned(),
        ),
        Err(error) => json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    delete,
    path = "/api/conversations/{id}",
    tag = "Conversations",
    summary = "Delete a conversation",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn delete_conversation(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> axum::response::Response {
    // Per-resource ACL: deleting is a write, so a read-only grant is refused too.
    // Runs BEFORE the session_end hooks — a denied caller must not be able to fire
    // another user's hooks (which snapshot that user's transcript into the event).
    if let Err(resp) = require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return resp;
    }
    // SessionEnd hooks (Claude parity): fire BEFORE the delete so a hook can still
    // observe the transcript (snapshotted into `event`). Observation-only + fully
    // detached — never blocks or fails the deletion.
    fire_session_end_hooks(&state, &id).await;
    match delete_conversation_with_residue(&state, &id).await {
        Ok(removed) => {
            // A thread's working-memory scratchpad does not outlive the thread.
            // Best-effort: the conversation is already gone, so a cleanup failure
            // only leaves an unreachable encrypted row.
            if removed {
                if let Err(error) = state.memory.delete_thread_working_memory(&id).await {
                    tracing::warn!("working memory cleanup failed for {id}: {error:#}");
                }
            }
            // A deleted conversation can never be resumed, so its cloud task
            // binding is released (workspace torn down, marker removed).
            cloud_tasks::release_deleted_conversation(&id).await;
            Json(json!({ "success": true, "removed": removed })).into_response()
        }
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

/// Delete a conversation and the local residue it leaves outside the store:
/// its chat checkpoint snapshots and the agent transcripts (Pi, pi-acp) kept
/// under its id. Single deletes go through here; the Settings > Data "Clear
/// chats" path (`data_admin`) collects the same residue for every conversation
/// it removes and releases it through [`release_conversation_residue`].
pub(in crate::server) async fn delete_conversation_with_residue(
    state: &ServerState,
    id: &str,
) -> anyhow::Result<bool> {
    // Folder snapshots outlive the rows that point at them, so read their
    // folders before the rows go and drop the snapshots afterwards.
    let checkpoint_folders =
        chat_checkpoints::conversation_workspaces(&state.conversations, id).await;
    let removed = state.conversations.delete_conversation(id).await?;
    if removed {
        release_conversation_residue(id, checkpoint_folders).await;
    }
    Ok(removed)
}

/// Release what a deleted conversation left outside the store: its checkpoint
/// pins in `checkpoint_folders` (read before the rows were deleted) and its
/// agent transcripts. Best-effort; failures are logged.
pub(in crate::server) async fn release_conversation_residue(
    id: &str,
    checkpoint_folders: Vec<std::path::PathBuf>,
) {
    chat_checkpoints::release_conversation(id, checkpoint_folders).await;
    delete_annotation_items_for_run(id).await;
    delete_agent_transcripts(id).await;
}

/// Release the residue of every conversation a bulk clear removed, detached
/// from the request: the rows are already gone, so a dropped or timed-out
/// request must not cancel the release partway and strand checkpoint pins or
/// plaintext transcripts. Checkpoint releases are batched per folder (one
/// garbage collection per store). Returns the task so tests can await it.
pub(crate) fn spawn_cleared_residue_release(
    residue: Vec<conversations::ClearedConversationResidue>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let ids: Vec<String> = residue
            .iter()
            .map(|entry| entry.conversation_id.clone())
            .collect();
        chat_checkpoints::release_conversations(
            residue
                .into_iter()
                .map(|entry| (entry.conversation_id, entry.checkpoint_workspaces))
                .collect(),
        )
        .await;
        for id in ids {
            delete_annotation_items_for_run(&id).await;
            delete_agent_transcripts(&id).await;
        }
    })
}

/// Annotation queue items hold a copy of the exchange they were added from;
/// deleting the conversation must not leave that copy behind.
pub(in crate::server) async fn delete_annotation_items_for_run(conversation_id: &str) {
    let Some(store) = crate::annotation_queues::AnnotationQueueStore::global() else {
        return;
    };
    if let Err(error) = store.delete_items_for_run(conversation_id).await {
        tracing::warn!(
            "annotation items copied from deleted conversation '{conversation_id}' were not removed: {error:#}"
        );
    }
}
