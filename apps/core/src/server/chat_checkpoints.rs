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
    if let Err(response) = super::require_resource_write(
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restore_modes_cover_both_halves() {
        assert!(RestoreMode::CodeAndConversation.restores_code());
        assert!(RestoreMode::CodeAndConversation.rewinds_conversation());
        assert!(RestoreMode::Code.restores_code());
        assert!(!RestoreMode::Code.rewinds_conversation());
        assert!(!RestoreMode::Conversation.restores_code());
        assert!(RestoreMode::Conversation.rewinds_conversation());
        let body: RestoreBody =
            serde_json::from_str(r#"{"mode":"codeAndConversation"}"#).expect("mode");
        assert_eq!(body.mode, RestoreMode::CodeAndConversation);
        assert!(serde_json::from_str::<RestoreBody>(r#"{"mode":"all"}"#).is_err());
    }

    #[test]
    fn turn_workspace_prefers_the_worktree() {
        let folder = tempfile::tempdir().expect("folder");
        let worktree = tempfile::tempdir().expect("worktree");
        let cwd = folder.path().to_string_lossy().into_owned();
        assert_eq!(
            turn_workspace(Some(&cwd), Some(worktree.path())),
            Some(worktree.path().to_path_buf())
        );
        assert_eq!(
            turn_workspace(Some(&cwd), None),
            Some(folder.path().to_path_buf())
        );
        assert_eq!(turn_workspace(Some("  "), None), None);
        assert_eq!(turn_workspace(None, None), None);
    }

    async fn call(
        router: &axum::Router,
        method: &str,
        uri: &str,
        body: Option<serde_json::Value>,
    ) -> (StatusCode, serde_json::Value) {
        use tower::ServiceExt as _;
        let request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(match body {
                Some(body) => axum::body::Body::from(body.to_string()),
                None => axum::body::Body::empty(),
            })
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_default())
    }

    fn snapshot_files(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
        let mut out = std::collections::BTreeMap::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    let relative = path
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned();
                    out.insert(relative, std::fs::read(&path).unwrap());
                }
            }
        }
        out
    }

    /// The whole chain through the real HTTP routes: turns are captured, an
    /// "agent" edits the folder, a busy folder is refused, code and
    /// conversation rewind together, the undo checkpoint reverses it, and a
    /// conversation-only rewind leaves files alone.
    #[tokio::test]
    async fn http_rewind_round_trip() {
        let data = tempfile::tempdir().expect("data");
        let state = super::super::isolated_plugin_hook_test_state(data.path());
        let store = state.conversations.clone();
        let router = axum::Router::new()
            .route(
                "/api/conversations/:id/checkpoints",
                axum::routing::get(list_chat_checkpoints),
            )
            .route(
                "/api/conversations/:id/checkpoints/:checkpoint_id/changes",
                axum::routing::get(chat_checkpoint_changes),
            )
            .route(
                "/api/conversations/:id/checkpoints/:checkpoint_id/restore",
                axum::routing::post(restore_chat_checkpoint),
            )
            .layer(axum::Extension(None::<VerifiedCaller>))
            .with_state(state);

        let workspace = tempfile::tempdir().expect("workspace");
        let root = workspace.path();
        std::fs::write(root.join("main.rs"), b"fn main() {}\n").unwrap();
        std::fs::write(root.join("lib.rs"), b"pub fn lib() {}\n").unwrap();
        let original = snapshot_files(root);

        let conv = format!("conv-e2e-{}", uuid::Uuid::new_v4());
        let first = store
            .append_message(&conv, "user", "refactor main", None, None, None)
            .await
            .unwrap();
        capture_turn(&store, &conv, &first, Some(root.to_path_buf())).await;
        // The agent's first turn.
        std::fs::write(root.join("main.rs"), b"fn main() { run() }\n").unwrap();
        std::fs::remove_file(root.join("lib.rs")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/run.rs"), b"pub fn run() {}\n").unwrap();
        let reply = store
            .append_message(&conv, "assistant", "done", None, None, None)
            .await
            .unwrap();
        let second = store
            .append_message(&conv, "user", "now add tests", None, None, None)
            .await
            .unwrap();
        capture_turn(&store, &conv, &second, Some(root.to_path_buf())).await;
        let after_first_turn = snapshot_files(root);
        // The agent's second turn.
        std::fs::write(root.join("tests.rs"), b"#[test] fn t() {}\n").unwrap();
        let after_second_turn = snapshot_files(root);

        let (status, body) = call(
            &router,
            "GET",
            &format!("/api/conversations/{conv}/checkpoints"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let checkpoints = body["checkpoints"].as_array().unwrap();
        assert_eq!(checkpoints.len(), 2);
        assert!(
            checkpoints.iter().all(|cp| cp["hasFiles"] == true),
            "{body}"
        );
        let id_for = |message: &str| {
            checkpoints
                .iter()
                .find(|cp| cp["messageId"] == message)
                .unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned()
        };
        let first_cp = id_for(&first);
        let second_cp = id_for(&second);

        let (status, body) = call(
            &router,
            "GET",
            &format!("/api/conversations/{conv}/checkpoints/{first_cp}/changes"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["changes"].as_array().unwrap().len(), 4, "{body}");

        // Another chat running in the same folder blocks a file restore.
        let other = format!("conv-busy-{}", uuid::Uuid::new_v4());
        store
            .append_message(&other, "user", "busy", None, None, None)
            .await
            .unwrap();
        store
            .set_run_metadata(&other, Some(&root.to_string_lossy()), None, None)
            .await
            .unwrap();
        store.set_run_status(&other, "running").await.unwrap();
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{first_cp}/restore"),
            Some(json!({ "mode": "codeAndConversation" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "folder_busy");
        assert_eq!(snapshot_files(root), after_second_turn, "nothing touched");
        store.set_run_status(&other, "completed").await.unwrap();

        // A turn running in this same conversation (any provider, not only
        // ACP) blocks even a conversation-only rewind.
        let leaf_before = store.get_active_messages(&conv).await.unwrap();
        store.set_run_status(&conv, "running").await.unwrap();
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{second_cp}/restore"),
            Some(json!({ "mode": "conversation" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "turn_in_progress");
        let leaf_after = store.get_active_messages(&conv).await.unwrap();
        assert_eq!(
            leaf_after.iter().map(|m| &m.id).collect::<Vec<_>>(),
            leaf_before.iter().map(|m| &m.id).collect::<Vec<_>>(),
            "active thread untouched"
        );
        store.set_run_status(&conv, "completed").await.unwrap();

        // Rewind code and conversation to before the first turn.
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{first_cp}/restore"),
            Some(json!({ "mode": "codeAndConversation" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            snapshot_files(root),
            original,
            "folder is back to before turn 1"
        );
        assert_eq!(body["files"]["skipped"], json!([]));
        assert_eq!(body["conversation"]["rewoundText"], "refactor main");
        assert_eq!(body["conversation"]["resendAsEdit"], true);
        let undo = body["files"]["undoCheckpoint"]["id"]
            .as_str()
            .unwrap()
            .to_owned();

        // The undo checkpoint puts every file back.
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{undo}/restore"),
            Some(json!({ "mode": "code" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(
            snapshot_files(root),
            after_second_turn,
            "undo reversed the rewind"
        );
        // An undo checkpoint has no conversation point.
        let (status, _) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{undo}/restore"),
            Some(json!({ "mode": "conversation" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);

        // Conversation-only rewind leaves files alone.
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{second_cp}/restore"),
            Some(json!({ "mode": "conversation" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["files"], serde_json::Value::Null);
        assert_eq!(body["conversation"]["activeLeafMessageId"], json!(reply));
        assert_eq!(snapshot_files(root), after_second_turn);
        let active = store.get_active_messages(&conv).await.unwrap();
        assert_eq!(
            active
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec!["refactor main", "done"]
        );

        // Code-only rewind to before turn 2 keeps the conversation.
        let (status, body) = call(
            &router,
            "POST",
            &format!("/api/conversations/{conv}/checkpoints/{second_cp}/restore"),
            Some(json!({ "mode": "code" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["conversation"], serde_json::Value::Null);
        assert_eq!(snapshot_files(root), after_first_turn);
    }

    async fn send_turn(
        store: &ConversationStore,
        conversation_id: &str,
        cwd: &Path,
        text: &str,
        skip_user_append: bool,
    ) {
        use crate::sidecar::adapters::{
            acp::AcpAgentRegistry, route_chat_stream, ChatStreamRequest,
        };
        let request: ChatStreamRequest = serde_json::from_value(json!({
            "conversation_id": conversation_id,
            "messages": [{ "role": "user", "parts": [{ "type": "text", "text": text }] }],
            "enable_long_term": false,
            "persist": true,
            "cwd": cwd.to_string_lossy(),
            "skip_user_append": skip_user_append,
        }))
        .unwrap();
        let response = route_chat_stream(
            request,
            std::sync::Arc::new(AcpAgentRegistry::new()),
            store.clone(),
            crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap(),
            crate::sidecar::SidecarManager::new_noop(),
            crate::server::memory::MemoryStore::open_in_memory().unwrap(),
            std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
            ryu_skills::SkillRegistry::empty(),
            ryu_tracing::TraceStore::open_in_memory().unwrap(),
            None,
            None,
            crate::routing_policy::reactive::TurnWatch::off(),
            None,
        )
        .await;
        // The checkpoint is taken before the model stream; no provider is called.
        drop(response);
    }

    /// The production chat route captures a checkpoint for every user turn
    /// before any agent runs; a regenerate keeps the original pre-turn state
    /// and an edit gets its own checkpoint.
    #[tokio::test]
    async fn chat_route_captures_a_checkpoint_before_each_turn() {
        let store = ConversationStore::open_in_memory().expect("store");
        let workspace = tempfile::tempdir().expect("workspace");
        let root = workspace.path();
        let conv = format!("conv-route-{}", uuid::Uuid::new_v4());
        std::fs::write(root.join("a.txt"), b"before turn 1").unwrap();

        send_turn(&store, &conv, root, "first", false).await;
        let rows = store.list_chat_checkpoints(&conv, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "one checkpoint per sent turn");
        assert!(rows[0].has_files, "{:?}", rows[0]);
        assert_eq!(rows[0].preview.as_deref(), Some("first"));
        let first_message = rows[0].message_id.clone().unwrap();

        // The "agent" edits, then the turn is regenerated: same user turn.
        std::fs::write(root.join("a.txt"), b"agent output").unwrap();
        store.prepare_regenerate(&conv, &first_message).await.ok();
        send_turn(&store, &conv, root, "first", true).await;
        assert_eq!(
            store.list_chat_checkpoints(&conv, 10).await.unwrap().len(),
            1,
            "a regenerate keeps the original checkpoint"
        );

        // An edit creates a new user version, which gets its own checkpoint.
        let edited = store
            .edit_user_message(&conv, &first_message, "first, edited")
            .await
            .unwrap()
            .unwrap();
        send_turn(&store, &conv, root, "first, edited", true).await;
        let rows = store.list_chat_checkpoints(&conv, 10).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows
            .iter()
            .any(|row| row.message_id.as_deref() == Some(edited.as_str())));

        // The first checkpoint still restores the folder to before turn 1.
        let record = store
            .get_chat_checkpoint(
                &conv,
                &rows
                    .iter()
                    .find(|r| r.message_id.as_deref() == Some(first_message.as_str()))
                    .unwrap()
                    .id,
            )
            .await
            .unwrap()
            .unwrap();
        let (workspace_path, commit) = file_snapshot(&record).unwrap();
        checkpoint_store()
            .restore(&workspace_path, &commit)
            .unwrap();
        assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"before turn 1");
    }

    #[tokio::test]
    async fn turn_checkpoint_round_trip_rewinds_files_and_thread() {
        let store = ConversationStore::open_in_memory().expect("conversation store");
        let first = store
            .append_message("conv-rewind", "user", "first", None, None, None)
            .await
            .expect("first");
        store
            .append_message("conv-rewind", "assistant", "reply", None, None, None)
            .await
            .expect("reply");
        let second = store
            .append_message("conv-rewind", "user", "second", None, None, None)
            .await
            .expect("second");

        let record = |message: &str| ChatCheckpointRecord {
            id: format!("cp-{message}"),
            conversation_id: "conv-rewind".into(),
            message_id: Some(message.to_owned()),
            kind: ChatCheckpointKind::Turn,
            workspace: None,
            commit_id: None,
            skip_reason: None,
            created_at: 1,
        };
        assert!(store.record_chat_checkpoint(&record(&first)).await.unwrap());
        assert!(store
            .record_chat_checkpoint(&record(&second))
            .await
            .unwrap());
        let mut duplicate = record(&second);
        duplicate.id = "cp-again".into();
        assert!(
            !store.record_chat_checkpoint(&duplicate).await.unwrap(),
            "the first capture of a turn wins"
        );
        let listed = store
            .list_chat_checkpoints("conv-rewind", 10)
            .await
            .unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed
            .iter()
            .any(|checkpoint| checkpoint.preview.as_deref() == Some("second")));

        let rewound = store
            .rewind_to_message("conv-rewind", &second)
            .await
            .unwrap()
            .expect("user message");
        assert!(rewound.active_leaf_message_id.is_some());
        assert_eq!(rewound.text, "second");
        let active = store.get_active_messages("conv-rewind").await.unwrap();
        assert_eq!(
            active
                .iter()
                .map(|m| m.content.as_str())
                .collect::<Vec<_>>(),
            vec!["first", "reply"]
        );
        let first_rewound = store
            .rewind_to_message("conv-rewind", &first)
            .await
            .unwrap()
            .expect("first turn");
        assert_eq!(
            first_rewound.active_leaf_message_id, None,
            "the first turn has no parent to point at"
        );
        assert!(store
            .rewind_to_message("conv-rewind", "missing")
            .await
            .unwrap()
            .is_none());
    }
}
