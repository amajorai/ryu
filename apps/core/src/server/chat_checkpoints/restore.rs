//! Restore: put a checkpoint's folder back and/or rewind the conversation to it.
// test-exempt: moved verbatim out of server/chat_checkpoints.rs by the module split; covered by chat_checkpoints/tests.rs.

use super::*;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FilesRestored {
    restored: Vec<String>,
    removed: Vec<String>,
    /// Paths left untouched because changing them could lose work that no
    /// snapshot holds. Empty for a full restore.
    skipped: Vec<SkippedPath>,
    /// Checkpoint of the folder as it was just before this restore.
    undo_checkpoint: Option<ChatCheckpoint>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversationRewound {
    /// The user message that left the active thread.
    rewound_message_id: String,
    /// That message's text, so the client can put it back in the composer.
    rewound_text: String,
    /// The new active leaf; `null` when the first turn was rewound.
    active_leaf_message_id: Option<String>,
    /// `true` when the rewound turn was the first one: the client sends the
    /// next prompt as an edit of `rewoundMessageId` so the thread restarts.
    resend_as_edit: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreResponse {
    files: Option<FilesRestored>,
    conversation: Option<ConversationRewound>,
}

#[utoipa::path(
    post,
    path = "/api/conversations/{id}/checkpoints/{checkpoint_id}/restore",
    tag = "Conversations",
    summary = "Rewind code and/or conversation to a checkpoint",
    description = "Restores the checkpoint's folder (files changed or deleted since are written back, files created since are removed; ignored files are untouched) and/or moves the conversation's active thread to just before the checkpoint's user message. A folder snapshot of the current state is taken first and returned as `files.undoCheckpoint`. A path is changed only when its current bytes are in that snapshot; anything else (ignored, too large, unreadable, blocked by a folder, or below a symbolic link) is left untouched and listed in `files.skipped`. Refused with 409 `turn_in_progress` or `folder_busy` while this chat or another chat in the same folder is running.",
    params(("id" = String, Path), ("checkpoint_id" = String, Path)),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "Restored", body = serde_json::Value),
        (status = 404, description = "Checkpoint not found"),
        (status = 409, description = "A turn is running in this conversation or folder, or nothing to restore for this mode"),
        (status = 410, description = "The file snapshot is no longer available")
    )
)]
pub async fn restore_chat_checkpoint(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    AxumPath((id, checkpoint_id)): AxumPath<(String, String)>,
    Json(body): Json<RestoreBody>,
) -> Response {
    if let Err(response) = super::super::require_resource_write(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return response;
    }
    if crate::sidecar::adapters::acp::has_live_turn(&id) {
        return error(
            StatusCode::CONFLICT,
            "turn_in_progress",
            "Stop the running turn before rewinding",
        );
    }
    // `has_live_turn` only sees ACP turns. Every provider path marks the
    // conversation `running` before dispatch, so this covers native turns too,
    // whose terminal persist would otherwise land under the rewound leaf.
    match state.conversations.is_run_running(&id).await {
        Ok(false) => {}
        Ok(true) => {
            return error(
                StatusCode::CONFLICT,
                "turn_in_progress",
                "Stop the running turn before rewinding",
            )
        }
        Err(err) => {
            tracing::warn!("reading conversation run status failed: {err:#}");
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "checkpoint_failed",
                "Could not confirm the conversation is idle",
            );
        }
    }
    let record = match load_checkpoint(&state, &id, &checkpoint_id).await {
        Ok(record) => record,
        Err(response) => return response,
    };
    let rewind_message = if body.mode.rewinds_conversation() {
        match (record.kind, record.message_id.clone()) {
            (ChatCheckpointKind::Turn, Some(message_id)) => Some(message_id),
            _ => {
                return error(
                    StatusCode::CONFLICT,
                    "no_conversation_point",
                    "This checkpoint only restores files",
                )
            }
        }
    } else {
        None
    };

    let files = if body.mode.restores_code() {
        let (workspace, commit) = match file_snapshot(&record) {
            Ok(snapshot) => snapshot,
            Err(response) => return response,
        };
        // On a shared node the stored folder must still be a member folder.
        if !turn_folders::stored_folder_allowed(&workspace) {
            return folder_not_allowed();
        }
        if let Err(response) = refuse_if_folder_busy(&state, &id, &workspace).await {
            return response;
        }
        match restore_files(&state.conversations, &id, &record, workspace, commit).await {
            Ok(files) => Some(files),
            Err(response) => return response,
        }
    } else {
        None
    };

    let conversation = match rewind_message {
        Some(message_id) => match rewind_conversation(&state, &id, &message_id).await {
            Ok(rewound) => Some(rewound),
            Err(response) => return response,
        },
        None => None,
    };

    private_json(RestoreResponse {
        files,
        conversation,
    })
}

/// Refuse while any live turn (this chat's or another's) may be writing the
/// folder: a restore underneath a running agent would race its edits.
async fn refuse_if_folder_busy(
    state: &ServerState,
    conversation_id: &str,
    workspace: &Path,
) -> Result<(), Response> {
    let running = match state.conversations.running_run_folders().await {
        Ok(running) => running,
        Err(err) => {
            tracing::warn!("reading running turns failed: {err:#}");
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "checkpoint_failed",
                "Could not confirm the folder is idle",
            ));
        }
    };
    for (running_id, folders) in running {
        let busy = folders
            .iter()
            .any(|folder| crate::paths::paths_overlap(Path::new(folder), workspace));
        if busy {
            let message = if running_id == conversation_id {
                "Stop the running turn before rewinding"
            } else {
                "Another chat is running in this folder. Stop it before rewinding"
            };
            return Err(error(StatusCode::CONFLICT, "folder_busy", message));
        }
    }
    Ok(())
}

async fn restore_files(
    conversations: &ConversationStore,
    conversation_id: &str,
    record: &ChatCheckpointRecord,
    workspace: PathBuf,
    commit: String,
) -> Result<FilesRestored, Response> {
    let owner = conversation_id.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let store = checkpoint_store();
        // The pre-restore snapshot is this conversation's "undo" checkpoint,
        // pinned under the same lock as the restore.
        store.restore_pinned(&workspace, &commit, &owner)
    })
    .await;
    let report = match result {
        Ok(Ok(report)) => report,
        Ok(Err(err)) => return Err(workspace_error(&err)),
        Err(_) => {
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "checkpoint_failed",
                "The checkpoint task failed",
            ))
        }
    };
    let undo = ChatCheckpointRecord {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_owned(),
        message_id: record.message_id.clone(),
        kind: ChatCheckpointKind::PreRestore,
        workspace: Some(report.pre_restore.workspace.to_string_lossy().into_owned()),
        commit_id: Some(report.pre_restore.commit.clone()),
        skip_reason: None,
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    let undo_checkpoint = match conversations.record_chat_checkpoint(&undo).await {
        Ok(_) => Some(ChatCheckpoint::from_record(undo, None)),
        Err(err) => {
            tracing::warn!("recording the pre-restore checkpoint failed: {err:#}");
            None
        }
    };
    Ok(FilesRestored {
        restored: report.restored,
        removed: report.removed,
        skipped: report.skipped,
        undo_checkpoint,
    })
}

async fn rewind_conversation(
    state: &ServerState,
    conversation_id: &str,
    message_id: &str,
) -> Result<ConversationRewound, Response> {
    let rewound = match state
        .conversations
        .rewind_to_message(conversation_id, message_id)
        .await
    {
        Ok(Some(rewound)) => rewound,
        Ok(None) => {
            return Err(error(
                StatusCode::NOT_FOUND,
                "message_not_found",
                "The checkpoint's message is no longer in this conversation",
            ))
        }
        Err(err) => {
            tracing::warn!("rewinding conversation failed: {err:#}");
            return Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "rewind_failed",
                "Could not rewind the conversation",
            ));
        }
    };
    forget_agent_sessions(conversation_id).await;
    Ok(ConversationRewound {
        rewound_message_id: message_id.to_owned(),
        rewound_text: rewound.text,
        resend_as_edit: rewound.active_leaf_message_id.is_none(),
        active_leaf_message_id: rewound.active_leaf_message_id,
    })
}

/// A rewound conversation must not continue inside an agent session that still
/// remembers the rewound turns. Close the pooled ACP instances (Pi, Claude
/// Code, Codex, …) and drop their resume bindings, so the next turn starts a
/// fresh native session from Ryu's rewound transcript. Native provider turns
/// are rebuilt from the active thread on every request and need nothing here.
pub async fn forget_agent_sessions(conversation_id: &str) {
    crate::sidecar::adapters::acp::close_conversation_instances(conversation_id);
    if let Some(store) = crate::server::agent_sync::global_store() {
        if let Err(err) = store.forget_acp_bindings(conversation_id).await {
            tracing::warn!("forgetting ACP bindings after rewind failed: {err:#}");
        }
    }
}

/// The folder a turn's checkpoint covers: the managed worktree when isolation
/// is on, otherwise the chat's own folder.
pub fn turn_workspace(cwd: Option<&str>, worktree: Option<&Path>) -> Option<PathBuf> {
    worktree.map(Path::to_path_buf).or_else(|| {
        cwd.map(str::trim)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
    })
}
