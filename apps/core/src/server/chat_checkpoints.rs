//! Chat checkpoints: rewind a conversation and/or its working folder to the
//! moment before a user turn.
//!
//! Before a turn runs, Core snapshots the chat's folder (the request `cwd`, or
//! the managed worktree when isolation is on) with
//! [`ryu_workspace::checkpoints`]. The snapshot covers the folder rather than
//! individual tool calls, so it behaves the same for every agent and provider:
//! Pi and other ACP agents, shell commands, and native provider tools. A turn
//! without a folder still gets a conversation-only checkpoint.
//!
//! Core owns authorization and the checkpoint rows (in the conversation store);
//! `ryu-workspace` owns the Git object operations. A restore only ever writes
//! inside the folder recorded with the checkpoint, never a client-supplied path.

use std::path::{Path, PathBuf};

use axum::{
    extract::{Path as AxumPath, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::identity_verify::VerifiedCaller;
use crate::server::conversations::{
    ChatCheckpoint, ChatCheckpointKind, ChatCheckpointRecord, ConversationStore,
};
use crate::server::ServerState;
use ryu_workspace::checkpoints::{
    FileChange, SkipReason, SkippedPath, SnapshotOutcome, WorkspaceCheckpoints,
};

// The restore route lives in `restore.rs`. It starts with `use super::*;`, so the imports
// above and the helpers below reach it exactly as they did in the single file.
mod restore;
#[cfg(test)]
mod tests;
pub mod turn_folders;

pub use restore::*;

const LIST_LIMIT: usize = 200;

fn checkpoint_store() -> WorkspaceCheckpoints {
    WorkspaceCheckpoints::new(crate::paths::state_path("chat-checkpoints"))
}

fn skip_reason_code(reason: &SkipReason) -> &'static str {
    match reason {
        SkipReason::NotADirectory => "notADirectory",
        SkipReason::UnsafeRoot => "unsafeRoot",
        SkipReason::TooManyFiles { .. } => "tooManyFiles",
        SkipReason::GitUnavailable => "gitUnavailable",
    }
}

/// Record the checkpoint for one user turn, before its agent runs. Best-effort:
/// a failure is logged and never blocks the turn. The first capture for a
/// message wins, so a regenerate keeps the state from before the turn first ran.
pub async fn capture_turn(
    conversations: &ConversationStore,
    conversation_id: &str,
    message_id: &str,
    workspace: Option<PathBuf>,
) {
    match conversations
        .has_turn_checkpoint(conversation_id, message_id)
        .await
    {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            tracing::warn!("chat checkpoint lookup failed: {error:#}");
            return;
        }
    }
    let created_at = chrono::Utc::now().timestamp_millis();
    let (workspace_text, commit_id, skip_reason) = match workspace {
        None => (None, None, None),
        Some(path) => {
            let label = format!("Before turn {message_id}");
            let snapshot_path = path.clone();
            let owner = conversation_id.to_owned();
            let outcome = tokio::task::spawn_blocking(move || {
                let store = checkpoint_store();
                store.snapshot_pinned(&snapshot_path, &label, &owner)
            })
            .await;
            spawn_age_prune_once_a_day();
            match outcome {
                Ok(Ok(SnapshotOutcome::Captured(snapshot))) => (
                    Some(snapshot.workspace.to_string_lossy().into_owned()),
                    Some(snapshot.commit),
                    None,
                ),
                Ok(Ok(SnapshotOutcome::Skipped(reason))) => {
                    tracing::info!(?reason, "chat checkpoint skipped the folder snapshot");
                    (
                        Some(path.to_string_lossy().into_owned()),
                        None,
                        Some(skip_reason_code(&reason).to_owned()),
                    )
                }
                Ok(Err(error)) => {
                    tracing::warn!("chat checkpoint snapshot failed: {error}");
                    (
                        Some(path.to_string_lossy().into_owned()),
                        None,
                        Some("error".to_owned()),
                    )
                }
                Err(error) => {
                    tracing::warn!("chat checkpoint task failed: {error}");
                    (
                        Some(path.to_string_lossy().into_owned()),
                        None,
                        Some("error".to_owned()),
                    )
                }
            }
        }
    };
    let record = ChatCheckpointRecord {
        id: uuid::Uuid::new_v4().to_string(),
        conversation_id: conversation_id.to_owned(),
        message_id: Some(message_id.to_owned()),
        kind: ChatCheckpointKind::Turn,
        workspace: workspace_text,
        commit_id,
        skip_reason,
        created_at,
    };
    if let Err(error) = conversations.record_chat_checkpoint(&record).await {
        tracing::warn!("recording chat checkpoint failed: {error:#}");
    }
}

/// Environment override for the checkpoint age cap, in days (0 turns it off).
const MAX_AGE_DAYS_ENV: &str = "RYU_CHAT_CHECKPOINT_MAX_AGE_DAYS";
/// Folder snapshots older than this are dropped (the conversation rewind still
/// works; restoring files of such a turn reports that the snapshot is gone).
pub const DEFAULT_MAX_AGE_DAYS: u64 = 30;

fn max_age_days() -> u64 {
    std::env::var(MAX_AGE_DAYS_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(DEFAULT_MAX_AGE_DAYS)
}

/// Run the age cap over every checkpoint store, at most once a day per
/// process, off the request path.
fn spawn_age_prune_once_a_day() {
    use std::sync::Mutex;
    static LAST_RUN: Mutex<Option<std::time::Instant>> = Mutex::new(None);
    let days = max_age_days();
    if days == 0 {
        return;
    }
    {
        let mut last = LAST_RUN
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < std::time::Duration::from_secs(24 * 60 * 60)) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    tokio::task::spawn_blocking(move || {
        let max_age = std::time::Duration::from_secs(days.saturating_mul(24 * 60 * 60));
        match checkpoint_store().prune_older_than(max_age) {
            Ok(report) if report.dropped_snapshots > 0 || report.removed_stores > 0 => {
                tracing::info!(
                    dropped = report.dropped_snapshots,
                    removed_stores = report.removed_stores,
                    "chat checkpoints: applied the {days}-day age cap"
                );
            }
            Ok(_) => {}
            Err(error) => tracing::warn!("chat checkpoint age cap failed: {error}"),
        }
    });
}

/// Folders a conversation's checkpoints cover. Read before the conversation is
/// deleted, so [`release_conversation`] can drop their snapshots afterwards.
pub async fn conversation_workspaces(
    conversations: &ConversationStore,
    conversation_id: &str,
) -> Vec<PathBuf> {
    let mut folders: Vec<PathBuf> = conversations
        .list_chat_checkpoints(conversation_id, 10_000)
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|checkpoint| checkpoint.has_files)
        .filter_map(|checkpoint| checkpoint.workspace.map(PathBuf::from))
        .collect();
    folders.sort();
    folders.dedup();
    folders
}

/// Drop a deleted conversation's folder snapshots (and any store left with
/// nothing in it). Best-effort: failures are logged.
pub async fn release_conversation(conversation_id: &str, workspaces: Vec<PathBuf>) {
    if workspaces.is_empty() {
        return;
    }
    let owner = conversation_id.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let store = checkpoint_store();
        for workspace in workspaces {
            if let Err(error) = store.release_owner(&workspace, &owner) {
                tracing::warn!("releasing chat checkpoints failed: {error}");
            }
        }
    })
    .await;
    if let Err(error) = result {
        tracing::warn!("releasing chat checkpoints failed: {error}");
    }
}

/// Drop the folder snapshots of several deleted conversations. Releases are
/// grouped by folder so each store is garbage-collected once, however many of
/// the conversations pinned snapshots in it. Best-effort: failures are logged.
pub async fn release_conversations(conversations: Vec<(String, Vec<PathBuf>)>) {
    let mut by_workspace: std::collections::BTreeMap<PathBuf, Vec<String>> =
        std::collections::BTreeMap::new();
    for (conversation_id, workspaces) in conversations {
        for workspace in workspaces {
            by_workspace
                .entry(workspace)
                .or_default()
                .push(conversation_id.clone());
        }
    }
    if by_workspace.is_empty() {
        return;
    }
    let result = tokio::task::spawn_blocking(move || {
        let store = checkpoint_store();
        for (workspace, owners) in by_workspace {
            let owners: Vec<&str> = owners.iter().map(String::as_str).collect();
            if let Err(error) = store.release_owners(&workspace, &owners) {
                tracing::warn!("releasing chat checkpoints failed: {error}");
            }
        }
    })
    .await;
    if let Err(error) = result {
        tracing::warn!("releasing chat checkpoints failed: {error}");
    }
}

fn error(status: StatusCode, code: &'static str, message: impl AsRef<str>) -> Response {
    (
        status,
        Json(json!({ "code": code, "error": message.as_ref() })),
    )
        .into_response()
}

fn private_json<T: Serialize>(value: T) -> Response {
    ([(header::CACHE_CONTROL, "private, no-store")], Json(value)).into_response()
}

async fn load_checkpoint(
    state: &ServerState,
    conversation_id: &str,
    checkpoint_id: &str,
) -> Result<ChatCheckpointRecord, Response> {
    match state
        .conversations
        .get_chat_checkpoint(conversation_id, checkpoint_id)
        .await
    {
        Ok(Some(record)) => Ok(record),
        Ok(None) => Err(error(
            StatusCode::NOT_FOUND,
            "checkpoint_not_found",
            "Checkpoint not found",
        )),
        Err(err) => {
            tracing::warn!("reading chat checkpoint failed: {err:#}");
            Err(error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "checkpoint_read_failed",
                "Could not read the checkpoint",
            ))
        }
    }
}

fn file_snapshot(record: &ChatCheckpointRecord) -> Result<(PathBuf, String), Response> {
    match (record.workspace.as_deref(), record.commit_id.as_deref()) {
        (Some(workspace), Some(commit)) => Ok((PathBuf::from(workspace), commit.to_owned())),
        _ => Err(error(
            StatusCode::CONFLICT,
            "no_file_snapshot",
            "This checkpoint has no file snapshot to restore",
        )),
    }
}

/// 403 for a checkpoint whose folder lies outside the node's member folders.
fn folder_not_allowed() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "folder_not_allowed",
        turn_folders::FOLDER_UNAVAILABLE_MESSAGE,
    )
}

fn workspace_error(err: &std::io::Error) -> Response {
    match err.kind() {
        std::io::ErrorKind::NotFound => error(
            StatusCode::GONE,
            "checkpoint_unavailable",
            "The checkpoint's file snapshot is no longer available",
        ),
        std::io::ErrorKind::Unsupported => error(
            StatusCode::CONFLICT,
            "workspace_unavailable",
            err.to_string(),
        ),
        _ => {
            tracing::warn!("chat checkpoint operation failed: {err}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "checkpoint_failed",
                "The checkpoint operation failed",
            )
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}/checkpoints",
    tag = "Conversations",
    summary = "List a conversation's rewind checkpoints",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "Checkpoints, newest first", body = serde_json::Value),
        (status = 404, description = "Conversation not found")
    )
)]
pub async fn list_chat_checkpoints(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    AxumPath(id): AxumPath<String>,
) -> Response {
    if let Err(response) = super::require_conversation_read_by_id(&state, &caller, &id).await {
        return response;
    }
    match state
        .conversations
        .list_chat_checkpoints(&id, LIST_LIMIT)
        .await
    {
        Ok(checkpoints) => private_json(json!({ "checkpoints": checkpoints })),
        Err(err) => {
            tracing::warn!("listing chat checkpoints failed: {err:#}");
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "checkpoint_list_failed",
                "Could not list checkpoints",
            )
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangesResponse {
    workspace: String,
    changes: Vec<FileChange>,
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}/checkpoints/{checkpoint_id}/changes",
    tag = "Conversations",
    summary = "List the file changes a checkpoint restore would undo",
    params(("id" = String, Path), ("checkpoint_id" = String, Path)),
    responses(
        (status = 200, description = "Files changed since the checkpoint", body = serde_json::Value),
        (status = 404, description = "Checkpoint not found"),
        (status = 409, description = "The checkpoint has no file snapshot")
    )
)]
pub async fn chat_checkpoint_changes(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    AxumPath((id, checkpoint_id)): AxumPath<(String, String)>,
) -> Response {
    if let Err(response) = super::require_conversation_read_by_id(&state, &caller, &id).await {
        return response;
    }
    let record = match load_checkpoint(&state, &id, &checkpoint_id).await {
        Ok(record) => record,
        Err(response) => return response,
    };
    let (workspace, commit) = match file_snapshot(&record) {
        Ok(snapshot) => snapshot,
        Err(response) => return response,
    };
    // On a shared node the stored folder must still be a member folder.
    if !turn_folders::stored_folder_allowed(&workspace) {
        return folder_not_allowed();
    }
    let task_workspace = workspace.clone();
    let result = tokio::task::spawn_blocking(move || {
        checkpoint_store().changes_since(&task_workspace, &commit)
    })
    .await;
    match result {
        Ok(Ok(changes)) => private_json(ChangesResponse {
            workspace: workspace.to_string_lossy().into_owned(),
            changes,
        }),
        Ok(Err(err)) => workspace_error(&err),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "checkpoint_failed",
            "The checkpoint task failed",
        ),
    }
}

/// What a restore puts back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RestoreMode {
    /// Restore the folder and rewind the conversation.
    CodeAndConversation,
    /// Rewind the conversation only; files stay as they are.
    Conversation,
    /// Restore the folder only; the conversation stays as it is.
    Code,
}

impl RestoreMode {
    fn restores_code(self) -> bool {
        matches!(self, Self::CodeAndConversation | Self::Code)
    }

    fn rewinds_conversation(self) -> bool {
        matches!(self, Self::CodeAndConversation | Self::Conversation)
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RestoreBody {
    mode: RestoreMode,
}
