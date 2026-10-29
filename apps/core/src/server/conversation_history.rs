//! Opt-in portable conversation checkpoints linked to Git commits.
//!
//! Core owns authorization, redaction, and the portable transcript contract;
//! `ryu-workspace` owns Git object operations. No endpoint pushes a code branch.

use axum::{
    extract::{Path, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Extension, Json,
};
use chrono::{SecondsFormat, TimeZone, Utc};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::identity_verify::{permissions, VerifiedCaller};
use crate::server::conversations::{ConversationSummary, SyncLink, SyncParent};
use crate::server::ServerState;
use ryu_workspace::git::history::VerifiedCheckpointRef;

pub(crate) mod redaction;
use redaction::{redact_custom, redact_text, RedactionCounts};

const FORMAT: &str = "ryu-portable-conversation";
const VERSION: u32 = 1;
const REDACTION_POLICY: &str = "locked-sensitive-v1";
const MAX_MESSAGES: usize = 5_000;
const MAX_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_TITLE_BYTES: usize = 4_096;
const MAX_AGENT_ID_BYTES: usize = 256;
const MAX_BRANCH_BYTES: usize = 1_024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub agent_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortableConversation {
    pub format: String,
    pub version: u32,
    pub source_id: String,
    pub title: String,
    pub agent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub code_commit: Option<String>,
    pub branch: Option<String>,
    pub messages: Vec<PortableMessage>,
    pub omitted_structured_parts: usize,
    pub redaction_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckpointMetadata {
    format: String,
    version: u32,
    checkpoint_id: String,
    source_id: String,
    title: String,
    code_commit: String,
    branch: Option<String>,
    message_count: usize,
    redactions: RedactionCounts,
    updated_at: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryPreview {
    checkpoint_id: String,
    transcript: PortableConversation,
    redactions: RedactionCounts,
    repo_available: bool,
    repo_root: Option<String>,
    repo_error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveBody {
    expected_checkpoint_id: String,
    expected_head: String,
    expected_repo_root: String,
    #[serde(default)]
    extra_redactions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewBody {
    #[serde(default)]
    extra_redactions: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepoQuery {
    cwd: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportBody {
    cwd: String,
    checkpoint_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncBody {
    cwd: String,
    action: String,
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

fn timestamp(ms: i64) -> Result<String, Response> {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|time| time.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or_else(|| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_history",
                "Stored timestamp is invalid",
            )
        })
}

fn sha256(input: &[u8]) -> String {
    hex::encode(Sha256::digest(input))
}

fn stable_id(prefix: &str, raw: &str) -> String {
    sha256(format!("{prefix}:{raw}").as_bytes())
}

fn compile_custom_terms(terms: &[String]) -> Result<Vec<Regex>, Response> {
    if terms.len() > 32 || terms.iter().map(String::len).sum::<usize>() > 4_096 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_redactions",
            "Too many additional redaction terms",
        ));
    }
    let mut expressions = Vec::with_capacity(terms.len());
    for term in terms {
        let trimmed = term.trim();
        if trimmed.is_empty()
            || trimmed.len() > 256
            || trimmed.chars().any(|character| character.is_control())
        {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "invalid_redactions",
                "Additional redaction terms must be 1–256 printable characters",
            ));
        }
        expressions.push(
            RegexBuilder::new(&regex::escape(trimmed))
                .case_insensitive(true)
                .build()
                .map_err(|_| {
                    error(
                        StatusCode::BAD_REQUEST,
                        "invalid_redactions",
                        "Could not prepare additional redaction",
                    )
                })?,
        );
    }
    Ok(expressions)
}

async fn local_source_index(state: &ServerState) -> Result<HashMap<String, String>, Response> {
    let conversations = state
        .conversations
        .list_conversations()
        .await
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "history_unavailable",
                "Could not verify conversation access",
            )
        })?;
    Ok(conversations
        .into_iter()
        .map(|summary: ConversationSummary| {
            (stable_id("ryu-conversation", &summary.id), summary.id)
        })
        .collect())
}

async fn require_local_source_read(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    local_sources: &HashMap<String, String>,
    source_id: &str,
) -> Result<(), Response> {
    if let Some(conversation_id) = local_sources.get(source_id) {
        super::require_conversation_read_by_id(state, caller, conversation_id).await?;
    }
    Ok(())
}

async fn require_local_source_manage(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    local_sources: &HashMap<String, String>,
    source_id: &str,
) -> Result<(), Response> {
    if let Some(conversation_id) = local_sources.get(source_id) {
        super::require_conversation_access_manager(state, conversation_id, caller.as_ref()).await?;
    }
    Ok(())
}

fn checked_repo_path(raw: &str) -> Result<String, Response> {
    if raw.is_empty() || raw.len() > 4_096 {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "A project folder is required",
        ));
    }
    let path = std::fs::canonicalize(raw).map_err(|_| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "Project folder is unavailable",
        )
    })?;
    if !path.is_dir() {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "Project folder is not a directory",
        ));
    }
    // On a shared node, keep Git reads and ref writes within that node's home.
    // Personal nodes keep the existing ability to select an external project.
    if super::node_org_id().is_some() {
        let home = dirs::home_dir()
            .and_then(|home| std::fs::canonicalize(home).ok())
            .ok_or_else(|| {
                error(
                    StatusCode::FORBIDDEN,
                    "invalid_path",
                    "Node home is unavailable",
                )
            })?;
        if !path.starts_with(&home) {
            return Err(error(
                StatusCode::FORBIDDEN,
                "invalid_path",
                "Project folder must be inside the node home",
            ));
        }
    }
    path.to_str().map(str::to_owned).ok_or_else(|| {
        error(
            StatusCode::BAD_REQUEST,
            "invalid_path",
            "Project folder path is invalid",
        )
    })
}

async fn require_edit(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
) -> Result<(), Response> {
    super::enforce_permission(state, caller, permissions::AGENT_EDIT)
        .await
        .map_err(|_| error(StatusCode::FORBIDDEN, "forbidden", "agent.edit is required"))
}

async fn require_view(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
) -> Result<(), Response> {
    super::enforce_permission(state, caller, permissions::AGENT_VIEW)
        .await
        .map_err(|_| error(StatusCode::FORBIDDEN, "forbidden", "agent.view is required"))
}

async fn build_preview(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    conversation_id: &str,
    custom_terms: &[Regex],
) -> Result<HistoryPreview, Response> {
    super::require_conversation_read_by_id(state, caller, conversation_id).await?;
    let summary = state
        .conversations
        .get_run_summary(conversation_id)
        .await
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "history_unavailable",
                "Conversation metadata is unavailable",
            )
        })?
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "not_found",
                "Conversation was not found",
            )
        })?;
    let detail = state
        .conversations
        .get_conversation_detail(conversation_id)
        .await
        .map_err(|_| {
            error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "history_unavailable",
                "Conversation messages are unavailable",
            )
        })?
        .ok_or_else(|| {
            error(
                StatusCode::NOT_FOUND,
                "not_found",
                "Conversation was not found",
            )
        })?;
    if detail.messages.len() > MAX_MESSAGES {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "history_too_large",
            "This conversation exceeds the 5,000-message checkpoint limit",
        ));
    }

    let mut redactions = RedactionCounts::default();
    let title = redact_custom(
        summary.title.as_deref().unwrap_or("Untitled conversation"),
        &mut redactions,
        custom_terms,
    );
    let mut omitted_structured_parts = 0;
    let mut messages = Vec::with_capacity(detail.messages.len());
    let source_id = stable_id("ryu-conversation", &summary.id);
    for message in detail.messages {
        if let Some(parts) = message.parts.as_ref() {
            omitted_structured_parts += parts.as_array().map_or(1, Vec::len);
        }
        messages.push(PortableMessage {
            id: stable_id(&source_id, &message.id),
            role: redact_custom(&message.role, &mut redactions, custom_terms),
            content: redact_custom(&message.content, &mut redactions, custom_terms),
            agent_id: message
                .agent_id
                .map(|id| redact_custom(&id, &mut redactions, custom_terms)),
            created_at: timestamp(message.created_at)?,
        });
    }
    let (repo, repo_error) = match summary.folder_path.as_deref() {
        Some(folder) => match checked_repo_path(folder) {
            Ok(path) => match tokio::task::spawn_blocking(move || {
                ryu_workspace::git::history::repository_head(&path)
            })
            .await
            {
                Ok(Ok(info)) => (Some(info), None),
                _ => (
                    None,
                    Some("The conversation folder has no committed Git repository".to_owned()),
                ),
            },
            Err(_) => (
                None,
                Some("The conversation folder is unavailable on this node".to_owned()),
            ),
        },
        None => (
            None,
            Some("Choose a project folder for this conversation".to_owned()),
        ),
    };
    let transcript = PortableConversation {
        format: FORMAT.to_owned(),
        version: VERSION,
        source_id,
        title,
        agent_id: summary
            .agent_id
            .map(|id| redact_custom(&id, &mut redactions, custom_terms)),
        created_at: timestamp(summary.created_at)?,
        updated_at: timestamp(summary.updated_at)?,
        code_commit: repo.as_ref().map(|info| info.head.clone()),
        branch: repo
            .as_ref()
            .and_then(|info| info.branch.as_deref())
            .map(|branch| redact_custom(branch, &mut redactions, custom_terms)),
        messages,
        omitted_structured_parts,
        redaction_policy: REDACTION_POLICY.to_owned(),
    };
    if transcript.title.len() > MAX_TITLE_BYTES
        || transcript
            .agent_id
            .as_ref()
            .is_some_and(|value| value.len() > MAX_AGENT_ID_BYTES)
        || transcript
            .branch
            .as_ref()
            .is_some_and(|value| value.len() > MAX_BRANCH_BYTES)
    {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "history_too_large",
            "Conversation metadata exceeds the checkpoint limit",
        ));
    }
    let bytes = serde_json::to_vec(&transcript).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "history_unavailable",
            "Could not prepare transcript",
        )
    })?;
    if bytes.len() > MAX_PAYLOAD_BYTES {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "history_too_large",
            "This conversation exceeds the 8 MiB checkpoint limit",
        ));
    }
    Ok(HistoryPreview {
        checkpoint_id: sha256(&bytes),
        transcript,
        redactions,
        repo_available: repo.is_some(),
        repo_root: repo.as_ref().map(|info| info.root.clone()),
        repo_error,
    })
}

fn summary_metadata(preview: &HistoryPreview) -> Result<Vec<u8>, Response> {
    let transcript = &preview.transcript;
    let code_commit = transcript.code_commit.clone().ok_or_else(|| {
        error(
            StatusCode::CONFLICT,
            "git_unavailable",
            "A committed Git repository is required",
        )
    })?;
    let metadata = CheckpointMetadata {
        format: FORMAT.to_owned(),
        version: VERSION,
        checkpoint_id: preview.checkpoint_id.clone(),
        source_id: transcript.source_id.clone(),
        title: transcript.title.clone(),
        code_commit,
        branch: transcript.branch.clone(),
        message_count: transcript.messages.len(),
        redactions: preview.redactions.clone(),
        updated_at: transcript.updated_at.clone(),
    };
    serde_json::to_vec(&metadata).map_err(|_| {
        error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "history_unavailable",
            "Could not prepare checkpoint metadata",
        )
    })
}

fn parse_safe_metadata(id: &str, bytes: &[u8]) -> Option<CheckpointMetadata> {
    let metadata: CheckpointMetadata = serde_json::from_slice(bytes).ok()?;
    let mut redactions = RedactionCounts::default();
    if metadata.checkpoint_id != id
        || metadata.format != FORMAT
        || metadata.version != VERSION
        || metadata.source_id.len() != 64
        || !metadata
            .source_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || !((metadata.code_commit.len() == 40 || metadata.code_commit.len() == 64)
            && metadata
                .code_commit
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()))
        || metadata.message_count > MAX_MESSAGES
        || metadata.title.len() > MAX_TITLE_BYTES
        || metadata
            .branch
            .as_ref()
            .is_some_and(|value| value.len() > MAX_BRANCH_BYTES)
        || chrono::DateTime::parse_from_rfc3339(&metadata.updated_at).is_err()
        || redact_text(&metadata.title, &mut redactions) != metadata.title
        || metadata
            .branch
            .as_ref()
            .is_some_and(|branch| redact_text(branch, &mut redactions) != *branch)
    {
        return None;
    }
    Some(metadata)
}

#[utoipa::path(
    get,
    path = "/api/conversations/{id}/history-preview",
    tag = "Conversations",
    summary = "Preview a redacted portable conversation checkpoint",
    params(("id" = String, Path)),
    responses((status = 200, description = "Redacted preview", body = serde_json::Value))
)]
pub async fn preview(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    match build_preview(&state, &caller, &id, &[]).await {
        Ok(preview) => private_json(preview),
        Err(response) => response,
    }
}

#[utoipa::path(
    post,
    path = "/api/conversations/{id}/history-preview",
    tag = "Conversations",
    summary = "Preview a conversation with additional literal redaction terms",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "Redacted preview", body = serde_json::Value))
)]
pub async fn preview_custom(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<PreviewBody>,
) -> Response {
    if let Err(response) = super::require_conversation_read_by_id(&state, &caller, &id).await {
        return response;
    }
    let expressions = match compile_custom_terms(&body.extra_redactions) {
        Ok(expressions) => expressions,
        Err(response) => return response,
    };
    match build_preview(&state, &caller, &id, &expressions).await {
        Ok(preview) => private_json(preview),
        Err(response) => response,
    }
}

#[utoipa::path(
    post,
    path = "/api/conversations/{id}/git-history",
    tag = "Conversations",
    summary = "Save a redacted conversation checkpoint to local Git refs",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "Checkpoint stored", body = serde_json::Value))
)]
pub async fn save(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(body): Json<SaveBody>,
) -> Response {
    if let Err(response) = require_edit(&state, &caller).await {
        return response;
    }
    if let Err(response) =
        super::require_conversation_access_manager(&state, &id, caller.as_ref()).await
    {
        return response;
    }
    let custom_terms = match compile_custom_terms(&body.extra_redactions) {
        Ok(expressions) => expressions,
        Err(response) => return response,
    };
    let preview = match build_preview(&state, &caller, &id, &custom_terms).await {
        Ok(preview) => preview,
        Err(response) => return response,
    };
    if preview.checkpoint_id != body.expected_checkpoint_id
        || preview.transcript.code_commit.as_deref() != Some(body.expected_head.as_str())
        || preview.repo_root.as_deref() != Some(body.expected_repo_root.as_str())
    {
        return error(
            StatusCode::CONFLICT,
            "stale_preview",
            "Conversation or Git HEAD changed; refresh the preview",
        );
    }
    let summary = match state.conversations.get_run_summary(&id).await {
        Ok(Some(summary)) => summary,
        _ => {
            return error(
                StatusCode::NOT_FOUND,
                "not_found",
                "Conversation was not found",
            )
        }
    };
    let path = match summary.folder_path.as_deref().map(checked_repo_path) {
        Some(Ok(path)) => path,
        _ => {
            return error(
                StatusCode::CONFLICT,
                "git_unavailable",
                "Conversation has no usable project folder",
            )
        }
    };
    let payload = match serde_json::to_vec(&preview.transcript) {
        Ok(payload) => payload,
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "history_unavailable",
                "Could not prepare transcript",
            )
        }
    };
    let metadata = match summary_metadata(&preview) {
        Ok(metadata) => metadata,
        Err(response) => return response,
    };
    let expected_head = body.expected_head;
    let expected_root = body.expected_repo_root;
    let checkpoint_id = preview.checkpoint_id;
    match tokio::task::spawn_blocking(move || {
        ryu_workspace::git::history::save_checkpoint(
            &path,
            &expected_root,
            &expected_head,
            &checkpoint_id,
            &payload,
            &metadata,
        )
    })
    .await
    {
        Ok(Ok(saved)) => {
            Json(json!({ "checkpoint": saved, "redactions": preview.redactions })).into_response()
        }
        Ok(Err(message)) => error(StatusCode::CONFLICT, "git_history_failed", message),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "git_history_failed",
            "Git checkpoint task failed",
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/git/history",
    tag = "Git",
    summary = "List local portable conversation checkpoints in a repository",
    responses((status = 200, description = "Local checkpoint metadata", body = serde_json::Value))
)]
pub async fn list(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Query(query): Query<RepoQuery>,
) -> Response {
    if let Err(response) = require_view(&state, &caller).await {
        return response;
    }
    let cwd = match checked_repo_path(&query.cwd) {
        Ok(path) => path,
        Err(response) => return response,
    };
    match tokio::task::spawn_blocking(move || {
        let ids = ryu_workspace::git::history::list_checkpoint_ids(&cwd)?;
        let mut entries = Vec::new();
        let mut skipped = 0;
        for id in ids {
            match ryu_workspace::git::history::read_checkpoint_metadata(&cwd, &id)
                .ok()
                .and_then(|bytes| parse_safe_metadata(&id, &bytes))
            {
                Some(metadata) => entries.push(metadata),
                None => skipped += 1,
            }
        }
        Ok::<_, String>((entries, skipped))
    })
    .await
    {
        Ok(Ok((entries, skipped))) => {
            let local_sources = match local_source_index(&state).await {
                Ok(index) => index,
                Err(response) => return response,
            };
            let mut visible = Vec::new();
            for entry in entries {
                if require_local_source_read(&state, &caller, &local_sources, &entry.source_id)
                    .await
                    .is_ok()
                {
                    visible.push(entry);
                }
            }
            private_json(json!({ "entries": visible, "skipped": skipped }))
        }
        Ok(Err(message)) => error(StatusCode::CONFLICT, "git_history_failed", message),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "git_history_failed",
            "Could not list Git history",
        ),
    }
}

fn validate_checkpoint(id: &str, bytes: &[u8]) -> Result<PortableConversation, Response> {
    if sha256(bytes) != id {
        return Err(error(
            StatusCode::CONFLICT,
            "invalid_checkpoint",
            "Checkpoint content does not match its id",
        ));
    }
    let transcript: PortableConversation = serde_json::from_slice(bytes).map_err(|_| {
        error(
            StatusCode::CONFLICT,
            "invalid_checkpoint",
            "Checkpoint format is invalid",
        )
    })?;
    if transcript.format != FORMAT
        || transcript.version != VERSION
        || transcript.redaction_policy != REDACTION_POLICY
    {
        return Err(error(
            StatusCode::CONFLICT,
            "invalid_checkpoint",
            "Checkpoint version or redaction policy is unsupported",
        ));
    }
    if transcript.messages.len() > MAX_MESSAGES
        || transcript.title.len() > MAX_TITLE_BYTES
        || transcript
            .agent_id
            .as_ref()
            .is_some_and(|value| value.len() > MAX_AGENT_ID_BYTES)
        || transcript
            .branch
            .as_ref()
            .is_some_and(|value| value.len() > MAX_BRANCH_BYTES)
        || chrono::DateTime::parse_from_rfc3339(&transcript.created_at).is_err()
        || chrono::DateTime::parse_from_rfc3339(&transcript.updated_at).is_err()
        || transcript.omitted_structured_parts > MAX_MESSAGES * 1_000
        || transcript.source_id.len() != 64
        || !transcript
            .source_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || transcript.code_commit.as_ref().is_none_or(|commit| {
            !((commit.len() == 40 || commit.len() == 64)
                && commit.bytes().all(|byte| byte.is_ascii_hexdigit()))
        })
    {
        return Err(error(
            StatusCode::CONFLICT,
            "invalid_checkpoint",
            "Checkpoint metadata is invalid",
        ));
    }
    for message in &transcript.messages {
        if !matches!(message.role.as_str(), "user" | "assistant" | "tool")
            || message.id.len() != 64
            || !message.id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || message.content.len() > MAX_PAYLOAD_BYTES
            || message
                .agent_id
                .as_ref()
                .is_some_and(|value| value.len() > MAX_AGENT_ID_BYTES)
            || chrono::DateTime::parse_from_rfc3339(&message.created_at).is_err()
        {
            return Err(error(
                StatusCode::CONFLICT,
                "invalid_checkpoint",
                "Checkpoint contains an invalid message",
            ));
        }
    }
    let mut unexpected = RedactionCounts::default();
    let mut sensitive = redact_text(&transcript.title, &mut unexpected) != transcript.title;
    if let Some(branch) = &transcript.branch {
        sensitive |= redact_text(branch, &mut unexpected) != *branch;
    }
    if let Some(agent_id) = &transcript.agent_id {
        sensitive |= redact_text(agent_id, &mut unexpected) != *agent_id;
    }
    for message in &transcript.messages {
        sensitive |= redact_text(&message.content, &mut unexpected) != message.content;
        if let Some(agent_id) = &message.agent_id {
            sensitive |= redact_text(agent_id, &mut unexpected) != *agent_id;
        }
    }
    if sensitive {
        return Err(error(
            StatusCode::CONFLICT,
            "invalid_checkpoint",
            "Checkpoint still contains detected sensitive information",
        ));
    }
    Ok(transcript)
}

#[utoipa::path(
    get,
    path = "/api/git/history/{checkpoint_id}",
    tag = "Git",
    summary = "Read a local portable conversation checkpoint",
    params(("checkpoint_id" = String, Path)),
    responses((status = 200, description = "Portable conversation", body = serde_json::Value))
)]
pub async fn get(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(checkpoint_id): Path<String>,
    Query(query): Query<RepoQuery>,
) -> Response {
    if let Err(response) = require_view(&state, &caller).await {
        return response;
    }
    let cwd = match checked_repo_path(&query.cwd) {
        Ok(path) => path,
        Err(response) => return response,
    };
    let lookup_id = checkpoint_id.clone();
    match tokio::task::spawn_blocking(move || {
        ryu_workspace::git::history::read_checkpoint(&cwd, &lookup_id)
    })
    .await
    {
        Ok(Ok(bytes)) => match validate_checkpoint(&checkpoint_id, &bytes) {
            Ok(transcript) => {
                let local_sources = match local_source_index(&state).await {
                    Ok(index) => index,
                    Err(response) => return response,
                };
                if let Err(response) = require_local_source_read(
                    &state,
                    &caller,
                    &local_sources,
                    &transcript.source_id,
                )
                .await
                {
                    return response;
                }
                private_json(json!({ "transcript": transcript }))
            }
            Err(response) => response,
        },
        Ok(Err(message)) => error(StatusCode::NOT_FOUND, "checkpoint_not_found", message),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "git_history_failed",
            "Could not read Git checkpoint",
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/git/history/import",
    tag = "Git",
    summary = "Import a portable conversation checkpoint into Core",
    request_body = serde_json::Value,
    responses((status = 200, description = "Conversation imported", body = serde_json::Value))
)]
pub async fn import(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<ImportBody>,
) -> Response {
    if let Err(response) = require_edit(&state, &caller).await {
        return response;
    }
    let cwd = match checked_repo_path(&body.cwd) {
        Ok(path) => path,
        Err(response) => return response,
    };
    let id = body.checkpoint_id;
    let raw = match tokio::task::spawn_blocking({
        let cwd = cwd.clone();
        let id = id.clone();
        move || ryu_workspace::git::history::read_checkpoint(&cwd, &id)
    })
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(message)) => return error(StatusCode::NOT_FOUND, "checkpoint_not_found", message),
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "git_history_failed",
                "Could not read Git checkpoint",
            )
        }
    };
    let transcript = match validate_checkpoint(&id, &raw) {
        Ok(transcript) => transcript,
        Err(response) => return response,
    };
    let local_sources = match local_source_index(&state).await {
        Ok(index) => index,
        Err(response) => return response,
    };
    if let Err(response) =
        require_local_source_read(&state, &caller, &local_sources, &transcript.source_id).await
    {
        return response;
    }
    let principal = caller
        .as_ref()
        .map(|person| person.user_id.as_str())
        .unwrap_or("local");
    let conversation_id = format!("git-{}", &stable_id(principal, &transcript.source_id)[..32]);
    match state.conversations.get_access_meta(&conversation_id).await {
        Ok(Some(_)) => {
            if let Err(response) =
                super::require_conversation_read_by_id(&state, &caller, &conversation_id).await
            {
                return response;
            }
        }
        Ok(None) => {}
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "import_failed",
                "Could not verify imported conversation access",
            )
        }
    }
    let tenancy = super::caller_tenancy(&caller);
    if state
        .conversations
        .ensure_conversation(
            &conversation_id,
            None,
            Some(&transcript.title),
            tenancy.clone(),
        )
        .await
        .is_err()
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "import_failed",
            "Could not create imported conversation",
        );
    }
    // The checkpoint is one linear active-thread export, so each row replies to
    // its predecessor. The first continues the target's own thread.
    let mut links = Vec::with_capacity(transcript.messages.len());
    let mut inserted_ids = std::collections::HashSet::new();
    for message in transcript.messages {
        let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&message.created_at) else {
            return error(
                StatusCode::CONFLICT,
                "invalid_checkpoint",
                "Checkpoint contains an invalid timestamp",
            );
        };
        let message_id = format!("git-{}", &stable_id(&conversation_id, &message.id)[..32]);
        let parent = links
            .last()
            .map_or(SyncParent::Unknown, |previous: &SyncLink| {
                SyncParent::Message(previous.id.clone())
            });
        links.push(SyncLink {
            id: message_id.clone(),
            parent,
        });
        match state
            .conversations
            .append_sync_message_with_id(
                &conversation_id,
                &message_id,
                &message.role,
                &message.content,
                message.agent_id.as_deref(),
                created_at.timestamp_millis(),
            )
            .await
        {
            Ok(true) => {
                inserted_ids.insert(message_id);
            }
            Ok(false) => {}
            Err(_) => {
                return error(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "import_failed",
                    "Could not restore a message",
                )
            }
        }
    }
    let inserted = inserted_ids.len();
    if state
        .conversations
        .link_synced_messages(&conversation_id, &links, &inserted_ids)
        .await
        .is_err()
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "import_failed",
            "Could not place restored messages in the conversation",
        );
    }
    if state
        .conversations
        .set_folder_path(&conversation_id, Some(&cwd))
        .await
        .is_err()
    {
        return error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "import_failed",
            "Could not link imported conversation to the project",
        );
    }
    Json(
        json!({ "conversationId": conversation_id, "messagesAdded": inserted, "checkpointId": id }),
    )
    .into_response()
}

#[utoipa::path(
    post,
    path = "/api/git/history/sync",
    tag = "Git",
    summary = "Explicitly push or fetch only portable conversation refs",
    request_body = serde_json::Value,
    responses((status = 200, description = "History refs synchronized", body = serde_json::Value))
)]
pub async fn sync(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<SyncBody>,
) -> Response {
    if let Err(response) = require_edit(&state, &caller).await {
        return response;
    }
    let cwd = match checked_repo_path(&body.cwd) {
        Ok(path) => path,
        Err(response) => return response,
    };
    if body.action != "push" && body.action != "fetch" {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_action",
            "Action must be push or fetch",
        );
    }
    let action = body.action;
    let sync_action = action.clone();
    let checked = match tokio::task::spawn_blocking({
        let cwd = cwd.clone();
        let sync_action = sync_action.clone();
        move || {
            let verified_ids = if sync_action == "push" {
                let ids = ryu_workspace::git::history::list_all_checkpoint_ids_for_push(&cwd)?;
                let mut verified_refs = Vec::with_capacity(ids.len());
                let mut sources = Vec::with_capacity(ids.len());
                for id in &ids {
                    let object_id = ryu_workspace::git::history::checkpoint_ref_oid(&cwd, id)?;
                    let payload =
                        ryu_workspace::git::history::read_checkpoint_at_oid(&cwd, &object_id)?;
                    let transcript = validate_checkpoint(id, &payload).map_err(|_| {
                        "A checkpoint failed the privacy or integrity check".to_owned()
                    })?;
                    sources.push(transcript.source_id.clone());
                    let metadata_bytes =
                        ryu_workspace::git::history::read_checkpoint_metadata_at_oid(
                            &cwd, &object_id,
                        )?;
                    let metadata = parse_safe_metadata(id, &metadata_bytes)
                        .ok_or_else(|| "A checkpoint has unsafe metadata".to_owned())?;
                    if metadata.source_id != transcript.source_id
                        || metadata.title != transcript.title
                        || metadata.code_commit
                            != transcript.code_commit.clone().unwrap_or_default()
                        || metadata.branch != transcript.branch
                        || metadata.message_count != transcript.messages.len()
                    {
                        return Err(
                            "A checkpoint metadata record does not match its transcript".to_owned()
                        );
                    }
                    verified_refs.push(VerifiedCheckpointRef {
                        checkpoint_id: id.clone(),
                        object_id,
                    });
                }
                (verified_refs, sources)
            } else {
                (Vec::new(), Vec::new())
            };
            Ok::<_, String>(verified_ids)
        }
    })
    .await
    {
        Ok(Ok(verified)) => verified,
        Ok(Err(message)) => return error(StatusCode::CONFLICT, "git_history_failed", message),
        Err(_) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "git_history_failed",
                "Git history validation failed",
            )
        }
    };
    if sync_action == "push" {
        let local_sources = match local_source_index(&state).await {
            Ok(index) => index,
            Err(response) => return response,
        };
        for source_id in &checked.1 {
            if let Err(response) =
                require_local_source_manage(&state, &caller, &local_sources, source_id).await
            {
                return response;
            }
        }
    }
    let verified_ids = checked.0;
    match tokio::task::spawn_blocking(move || {
        ryu_workspace::git::history::sync_history(&cwd, &sync_action, &verified_ids)
    })
    .await
    {
        Ok(Ok(())) => Json(json!({ "ok": true, "action": action })).into_response(),
        Ok(Err(message)) => error(StatusCode::CONFLICT, "git_history_failed", message),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "git_history_failed",
            "Git history sync failed",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(content: &str) -> PortableConversation {
        PortableConversation {
            format: FORMAT.to_owned(),
            version: VERSION,
            source_id: "a".repeat(64),
            title: "A safe title".to_owned(),
            agent_id: None,
            created_at: "2026-09-30T00:00:00.000Z".to_owned(),
            updated_at: "2026-09-30T00:00:00.000Z".to_owned(),
            code_commit: Some("b".repeat(40)),
            branch: Some("main".to_owned()),
            messages: vec![PortableMessage {
                id: "c".repeat(64),
                role: "user".to_owned(),
                content: content.to_owned(),
                agent_id: None,
                created_at: "2026-09-30T00:00:00.000Z".to_owned(),
            }],
            omitted_structured_parts: 0,
            redaction_policy: REDACTION_POLICY.to_owned(),
        }
    }

    #[test]
    fn import_rejects_forged_redaction_label_with_raw_secret() {
        let safe = serde_json::to_vec(&artifact("A safe message")).expect("serialize");
        assert!(validate_checkpoint(&sha256(&safe), &safe).is_ok());

        let unsafe_bytes =
            serde_json::to_vec(&artifact("password='hunter2'")).expect("serialize unsafe artifact");
        assert!(validate_checkpoint(&sha256(&unsafe_bytes), &unsafe_bytes).is_err());
        assert!(validate_checkpoint(&"0".repeat(64), &safe).is_err());

        let mut malformed = artifact("Safe message");
        malformed.created_at = "password='hunter2'".to_owned();
        let malformed_bytes = serde_json::to_vec(&malformed).expect("serialize malformed artifact");
        assert!(validate_checkpoint(&sha256(&malformed_bytes), &malformed_bytes).is_err());
    }

    #[test]
    fn versioned_preview_fixture_matches_the_core_wire_shape() {
        let fixture = include_str!(
            "../../../../packages/core-client/fixtures/portable-history-preview-v1.json"
        );
        let parsed: HistoryPreview = serde_json::from_str(fixture).expect("preview fixture");
        assert_eq!(parsed.transcript.version, VERSION);
        assert_eq!(parsed.transcript.format, FORMAT);
        assert_eq!(
            serde_json::to_value(parsed).expect("serialize preview"),
            serde_json::from_str::<serde_json::Value>(fixture).expect("fixture json")
        );
    }
}
