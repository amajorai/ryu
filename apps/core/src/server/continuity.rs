//! RNP v0 conversation continuity.
//!
//! A trusted client reads a bounded, consent-scoped snapshot from one configured
//! Core node and writes it to another with that node's own credential. Core never
//! connects to a URL supplied by the request, and the bundle carries no auth,
//! filesystem, structured tool, or node-local ACP session state.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use utoipa::ToSchema;

use super::conversations::StoredMessage;
use super::sync::{apply_sync_payload_unlinked, SyncMessage, SyncPayload};
use super::{
    caller_tenancy, json_error, require_resource_read, require_resource_write, ServerState,
};
use crate::identity_verify::VerifiedCaller;

/// Working-tree handoff: capability-probed endpoints beside the v0 bundle.
pub(crate) mod workspace;

const PROTOCOL: &str = "ryu-node-continuity";
const VERSION: u8 = 0;
const MAX_WIRE_BYTES: usize = 2 * 1024 * 1024;
const MAX_MESSAGES: usize = 200;
const MAX_MESSAGE_BYTES: usize = 64 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 1536 * 1024;
const MAX_CONTEXT_ITEMS: usize = 16;
const MAX_CONTEXT_ITEM_BYTES: usize = 32 * 1024;
const MAX_CONTEXT_BYTES: usize = 256 * 1024;
const MAX_ID_BYTES: usize = 128;
const MAX_LABEL_BYTES: usize = 256;
static RESUME_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

fn resume_lock() -> &'static tokio::sync::Mutex<()> {
    RESUME_LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum RnpTranscriptScopeV0 {
    All,
    Recent {
        #[serde(rename = "maxMessages")]
        max_messages: usize,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContextSourceV0 {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContextTextV0 {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub media_type: String,
    pub text: String,
    pub source: RnpContextSourceV0,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContextBundleV0 {
    pub version: u8,
    pub items: Vec<RnpContextTextV0>,
}

impl Default for RnpContextBundleV0 {
    fn default() -> Self {
        Self {
            version: VERSION,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpMessageV0 {
    pub source_id: String,
    pub role: String,
    pub text: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContinuitySourceV0 {
    pub conversation_id: String,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_hint: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContinuitySelectionV0 {
    pub transcript: RnpTranscriptScopeV0,
    pub omitted_earlier_messages: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpContinuityBundleV0 {
    pub protocol: String,
    pub version: u8,
    pub bundle_id: String,
    pub created_at: i64,
    pub source: RnpContinuitySourceV0,
    pub selection: RnpContinuitySelectionV0,
    pub messages: Vec<RnpMessageV0>,
    pub context: RnpContextBundleV0,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpExportRequestV0 {
    pub version: u8,
    #[serde(default)]
    pub if_updated_at: Option<i64>,
    pub transcript: RnpTranscriptScopeV0,
    #[serde(default)]
    pub context: Option<RnpContextBundleV0>,
    #[serde(default)]
    pub include_agent_hint: bool,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpImportedCountsV0 {
    pub messages: usize,
    pub context_items: usize,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct RnpResumeResultV0 {
    pub version: u8,
    pub conversation_id: String,
    pub status: String,
    pub imported: RnpImportedCountsV0,
    pub warnings: Vec<String>,
}

#[derive(Debug)]
struct ValidationError {
    status: StatusCode,
    message: String,
}

impl ValidationError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::PAYLOAD_TOO_LARGE,
            message: message.into(),
        }
    }

    fn response(self) -> Response {
        json_error(self.status, self.message)
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn valid_text(value: &str, max_bytes: usize, allow_empty: bool) -> bool {
    (allow_empty || !value.trim().is_empty())
        && value.len() <= max_bytes
        && !value.chars().any(|character| character.is_control())
}

fn validate_context(context: &RnpContextBundleV0) -> Result<(), ValidationError> {
    if context.version != VERSION {
        return Err(ValidationError::invalid(
            "unsupported context bundle version",
        ));
    }
    if context.items.len() > MAX_CONTEXT_ITEMS {
        return Err(ValidationError::too_large("too many context items"));
    }
    let mut ids = HashSet::new();
    let mut bytes = 0usize;
    for item in &context.items {
        if item.kind != "text" {
            return Err(ValidationError::invalid(
                "only text context items are supported",
            ));
        }
        if !valid_text(&item.id, MAX_ID_BYTES, false) || !ids.insert(item.id.as_str()) {
            return Err(ValidationError::invalid(
                "context ids must be valid and unique",
            ));
        }
        if !valid_text(&item.label, MAX_LABEL_BYTES, false) {
            return Err(ValidationError::too_large(
                "context label is missing or too long",
            ));
        }
        if item.media_type != "text/plain" && item.media_type != "text/markdown" {
            return Err(ValidationError::invalid("unsupported context media type"));
        }
        if !matches!(
            item.source.kind.as_str(),
            "browser-selection"
                | "clip-transcript"
                | "composer"
                | "manual"
                | "recent-activity"
                | "other"
        ) {
            return Err(ValidationError::invalid("unsupported context source"));
        }
        if let Some(label) = item.source.label.as_deref() {
            if !valid_text(label, MAX_LABEL_BYTES, false) {
                return Err(ValidationError::too_large(
                    "context source label is too long",
                ));
            }
        }
        if item.text.len() > MAX_CONTEXT_ITEM_BYTES {
            return Err(ValidationError::too_large("context item is too large"));
        }
        bytes = bytes.saturating_add(item.text.len());
        if bytes > MAX_CONTEXT_BYTES {
            return Err(ValidationError::too_large("context bundle is too large"));
        }
    }
    Ok(())
}

fn validate_bundle(bundle: &RnpContinuityBundleV0) -> Result<(), ValidationError> {
    if bundle.protocol != PROTOCOL {
        return Err(ValidationError::invalid("unsupported continuity protocol"));
    }
    if bundle.version != VERSION {
        return Err(ValidationError::invalid("unsupported continuity version"));
    }
    if !valid_text(&bundle.bundle_id, MAX_ID_BYTES, false)
        || !valid_text(&bundle.source.conversation_id, MAX_ID_BYTES, false)
    {
        return Err(ValidationError::invalid(
            "bundle and conversation ids are required",
        ));
    }
    if bundle.created_at < 0 || bundle.source.updated_at < 0 {
        return Err(ValidationError::invalid(
            "bundle timestamps must be non-negative",
        ));
    }
    if let Some(value) = bundle.source.checkpoint_message_id.as_deref() {
        if !valid_text(value, MAX_ID_BYTES, false) {
            return Err(ValidationError::invalid("checkpoint message id is invalid"));
        }
    }
    if let Some(value) = bundle.source.agent_hint.as_deref() {
        if !valid_text(value, MAX_ID_BYTES, false) {
            return Err(ValidationError::invalid("agent hint is invalid"));
        }
    }
    if let Some(value) = bundle.source.title.as_deref() {
        if !valid_text(value, MAX_LABEL_BYTES, false) {
            return Err(ValidationError::too_large("source title is too long"));
        }
    }
    if bundle.messages.len() > MAX_MESSAGES {
        return Err(ValidationError::too_large("too many messages"));
    }
    if let RnpTranscriptScopeV0::Recent { max_messages } = &bundle.selection.transcript {
        if *max_messages == 0 || *max_messages > MAX_MESSAGES {
            return Err(ValidationError::invalid(
                "recent transcript limit is invalid",
            ));
        }
    }
    let mut ids = HashSet::new();
    let mut bytes = 0usize;
    for message in &bundle.messages {
        if !valid_text(&message.source_id, MAX_ID_BYTES, false)
            || !ids.insert(message.source_id.as_str())
        {
            return Err(ValidationError::invalid(
                "message ids must be valid and unique",
            ));
        }
        if message.source_id.starts_with("rnp-context-") {
            return Err(ValidationError::invalid(
                "message id uses the reserved context namespace",
            ));
        }
        if message.role != "user" && message.role != "assistant" {
            return Err(ValidationError::invalid(
                "only user and assistant messages can move",
            ));
        }
        if message.created_at < 0 {
            return Err(ValidationError::invalid("message timestamp is invalid"));
        }
        if message.text.len() > MAX_MESSAGE_BYTES {
            return Err(ValidationError::too_large("message text is too large"));
        }
        bytes = bytes.saturating_add(message.text.len());
        if bytes > MAX_TRANSCRIPT_BYTES {
            return Err(ValidationError::too_large("transcript is too large"));
        }
    }
    validate_context(&bundle.context)
}

fn selected_messages(
    messages: Vec<StoredMessage>,
    scope: &RnpTranscriptScopeV0,
) -> Result<(Vec<StoredMessage>, bool), ValidationError> {
    let portable: Vec<_> = messages
        .into_iter()
        .filter(|message| message.role == "user" || message.role == "assistant")
        .collect();
    let max_messages = match scope {
        RnpTranscriptScopeV0::All => {
            if portable.len() > MAX_MESSAGES {
                return Err(ValidationError::too_large(format!(
                    "conversation has more than {MAX_MESSAGES} portable messages"
                )));
            }
            MAX_MESSAGES
        }
        RnpTranscriptScopeV0::Recent { max_messages } => {
            if *max_messages == 0 || *max_messages > MAX_MESSAGES {
                return Err(ValidationError::invalid(
                    "recent transcript limit is invalid",
                ));
            }
            *max_messages
        }
    };
    let omitted = portable.len() > max_messages;
    let start = portable.len().saturating_sub(max_messages);
    Ok((portable.into_iter().skip(start).collect(), omitted))
}

fn context_message_id(bundle_id: &str, context_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(bundle_id.as_bytes());
    digest.update([0]);
    digest.update(context_id.as_bytes());
    format!("rnp-context-{}", hex::encode(digest.finalize()))
}

fn context_message(item: &RnpContextTextV0) -> String {
    format!("[Imported context: {}]\n\n{}", item.label, item.text)
}

pub fn router() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/rnp/v0/conversations/:id/export",
            post(export_conversation),
        )
        .route(
            "/api/rnp/v0/conversations/:id/resume",
            post(resume_conversation),
        )
        .layer(DefaultBodyLimit::max(MAX_WIRE_BYTES))
        // Merged after the layer so the blob routes keep their own body limit.
        .merge(workspace::router())
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/export",
    tag = "Conversations",
    summary = "Export a consent-scoped RNP v0 continuity bundle",
    params(("id" = String, Path)),
    request_body = RnpExportRequestV0,
    responses((status = 200, body = RnpContinuityBundleV0), (status = 409), (status = 413))
)]
pub(crate) async fn export_conversation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(request): Json<RnpExportRequestV0>,
) -> Response {
    if request.version != VERSION {
        return json_error(
            StatusCode::BAD_REQUEST,
            "unsupported continuity version".to_owned(),
        );
    }
    if let Err(response) = require_resource_read(
        state.conversations.get_access_meta(&id).await,
        caller.as_ref(),
        &format!("conversation '{id}' not found"),
    ) {
        return response;
    }
    let Some(summary) = (match state.conversations.get_summary(&id).await {
        Ok(summary) => summary,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }) else {
        return json_error(
            StatusCode::NOT_FOUND,
            format!("conversation '{id}' not found"),
        );
    };
    if summary.run_status.as_deref() == Some("running") {
        return json_error(
            StatusCode::CONFLICT,
            "wait for the active response to finish before continuing elsewhere".to_owned(),
        );
    }
    if request
        .if_updated_at
        .is_some_and(|value| value != summary.updated_at)
    {
        return json_error(
            StatusCode::CONFLICT,
            "conversation changed after the handoff review; review it again".to_owned(),
        );
    }
    let context = request.context.unwrap_or_default();
    if let Err(error) = validate_context(&context) {
        return error.response();
    }
    let messages = match state.conversations.get_active_messages(&id).await {
        Ok(messages) => messages,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let summary_after_snapshot = match state.conversations.get_summary(&id).await {
        Ok(summary) => summary,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let Some(summary_after_snapshot) = summary_after_snapshot else {
        return json_error(
            StatusCode::CONFLICT,
            "conversation changed while preparing the handoff".to_owned(),
        );
    };
    if summary_after_snapshot.updated_at != summary.updated_at {
        return json_error(
            StatusCode::CONFLICT,
            "conversation changed while preparing the handoff; review it again".to_owned(),
        );
    }
    let summary = summary_after_snapshot;
    let (selected, omitted) = match selected_messages(messages, &request.transcript) {
        Ok(result) => result,
        Err(error) => return error.response(),
    };
    let checkpoint_message_id = selected.last().map(|message| message.id.clone());
    let messages: Vec<_> = selected
        .into_iter()
        .map(|message| RnpMessageV0 {
            source_id: message.id,
            role: message.role,
            text: message.content,
            created_at: message.created_at,
        })
        .collect();
    let bundle = RnpContinuityBundleV0 {
        protocol: PROTOCOL.to_owned(),
        version: VERSION,
        bundle_id: uuid::Uuid::new_v4().to_string(),
        created_at: now_millis(),
        source: RnpContinuitySourceV0 {
            conversation_id: id,
            updated_at: summary.updated_at,
            checkpoint_message_id,
            title: summary.title,
            agent_hint: request
                .include_agent_hint
                .then_some(summary.agent_id)
                .flatten(),
        },
        selection: RnpContinuitySelectionV0 {
            transcript: request.transcript,
            omitted_earlier_messages: omitted,
        },
        messages,
        context,
    };
    if let Err(error) = validate_bundle(&bundle) {
        return error.response();
    }
    Json(bundle).into_response()
}

#[utoipa::path(
    post,
    path = "/api/rnp/v0/conversations/{id}/resume",
    tag = "Conversations",
    summary = "Resume an RNP v0 continuity bundle on this node",
    params(("id" = String, Path)),
    request_body = RnpContinuityBundleV0,
    responses((status = 200, body = RnpResumeResultV0), (status = 409), (status = 413))
)]
pub(crate) async fn resume_conversation(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(id): Path<String>,
    Json(bundle): Json<RnpContinuityBundleV0>,
) -> Response {
    if let Err(error) = validate_bundle(&bundle) {
        return error.response();
    }
    if id != bundle.source.conversation_id {
        return json_error(
            StatusCode::BAD_REQUEST,
            "path conversation id does not match the continuity bundle".to_owned(),
        );
    }
    // RNP resumes are serialized inside one Core process. This closes the
    // check/insert race between two handoffs while the store's conditional
    // creation below closes the ownership race with other conversation writers.
    let _resume_guard = resume_lock().lock().await;
    let existing_meta = match state.conversations.get_access_meta(&id).await {
        Ok(meta) => meta,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let existed = existing_meta.is_some();
    if existed {
        if let Err(response) = require_resource_write(
            Ok(existing_meta),
            caller.as_ref(),
            &format!("conversation '{id}' not found"),
        ) {
            return response;
        }
    }
    let mut warnings = Vec::new();
    let resolved_agent_id = if let Some(agent_hint) = bundle.source.agent_hint.as_deref() {
        match state.agent_store.get(agent_hint).await {
            Ok(Some(_)) => Some(agent_hint.to_owned()),
            Ok(None) => {
                warnings.push("agent-unavailable".to_owned());
                None
            }
            Err(error) => {
                return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
            }
        }
    } else {
        None
    };
    let payload_created_at = bundle
        .messages
        .first()
        .map(|message| message.created_at)
        .unwrap_or(bundle.created_at);
    let tenancy = caller_tenancy(&caller);
    if !existed {
        if let Err(error) = state
            .conversations
            .ensure_sync_conversation(
                &id,
                resolved_agent_id.as_deref(),
                bundle.source.title.as_deref(),
                payload_created_at,
                bundle.source.updated_at,
                tenancy.clone(),
            )
            .await
        {
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
        if let Err(response) = require_resource_write(
            state.conversations.get_access_meta(&id).await,
            caller.as_ref(),
            &format!("conversation '{id}' not found"),
        ) {
            return response;
        }
    }
    let existing_summary = match state.conversations.get_summary(&id).await {
        Ok(summary) => summary,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let metadata_changed = existed
        && existing_summary.as_ref().is_some_and(|summary| {
            bundle.source.updated_at > summary.updated_at
                && (bundle
                    .source
                    .title
                    .as_ref()
                    .is_some_and(|title| summary.title.as_ref() != Some(title))
                    || resolved_agent_id
                        .as_ref()
                        .is_some_and(|agent_id| summary.agent_id.as_ref() != Some(agent_id)))
        });
    let existing_messages = match state.conversations.get_messages(&id).await {
        Ok(messages) => messages,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let existing_by_id: HashMap<_, _> = existing_messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect();
    for incoming in &bundle.messages {
        if let Some(existing) = existing_by_id.get(incoming.source_id.as_str()) {
            if existing.role != incoming.role
                || existing.content != incoming.text
                || existing.created_at != incoming.created_at
            {
                return json_error(
                    StatusCode::CONFLICT,
                    format!(
                        "message '{}' conflicts with the target copy",
                        incoming.source_id
                    ),
                );
            }
        }
    }
    let inserted_messages = bundle
        .messages
        .iter()
        .filter(|message| !existing_by_id.contains_key(message.source_id.as_str()))
        .count();
    let mut messages: Vec<SyncMessage> = bundle
        .messages
        .iter()
        .map(|message| SyncMessage {
            id: message.source_id.clone(),
            role: message.role.clone(),
            content: message.text.clone(),
            created_at: message.created_at,
            parent_message_id: None,
            version_root: false,
        })
        .collect();
    let mut imported_context = 0usize;
    for (index, item) in bundle.context.items.iter().enumerate() {
        let message_id = context_message_id(&bundle.bundle_id, &item.id);
        let content = context_message(item);
        let created_at = bundle.created_at.saturating_add(index as i64);
        if let Some(existing) = existing_by_id.get(message_id.as_str()) {
            if existing.role != "user"
                || existing.content != content
                || existing.created_at != created_at
            {
                return json_error(
                    StatusCode::CONFLICT,
                    format!("context item '{}' conflicts with the target copy", item.id),
                );
            }
        } else {
            imported_context += 1;
        }
        messages.push(SyncMessage {
            id: message_id,
            role: "user".to_owned(),
            content,
            created_at,
            parent_message_id: None,
            version_root: false,
        });
    }
    let payload = SyncPayload {
        conversation_id: id.clone(),
        title: bundle.source.title.clone(),
        agent_id: resolved_agent_id,
        folder_path: None,
        branch: None,
        worktree_path: None,
        run_status: None,
        owner_user_id: caller.as_ref().map(|value| value.user_id.clone()),
        created_at: payload_created_at,
        updated_at: bundle.source.updated_at,
        messages,
    };
    // Insert without linking: `link_resumed_messages` below places the rows.
    if let Err(error) = apply_sync_payload_unlinked(&state.conversations, &payload, tenancy).await {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let stored_messages = match state.conversations.get_messages(&id).await {
        Ok(messages) => messages,
        Err(error) => return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    };
    let stored_by_id: HashMap<_, _> = stored_messages
        .iter()
        .map(|message| (message.id.as_str(), message))
        .collect();
    for expected in &payload.messages {
        let matches = stored_by_id
            .get(expected.id.as_str())
            .is_some_and(|stored| {
                stored.role == expected.role
                    && stored.content == expected.content
                    && stored.created_at == expected.created_at
            });
        if !matches {
            return json_error(
                StatusCode::CONFLICT,
                format!("message '{}' changed during the handoff", expected.id),
            );
        }
    }
    // A branched target reads only the parent chain from its leaf, so chain the
    // rows this resume added onto it; otherwise the merge would be invisible.
    // The payload is the bundle transcript followed by its context items.
    let (transcript_ids, context_ids): (Vec<String>, Vec<String>) = {
        let ids: Vec<String> = payload
            .messages
            .iter()
            .map(|message| message.id.clone())
            .collect();
        let split = bundle.messages.len().min(ids.len());
        let (transcript, context) = ids.split_at(split);
        (transcript.to_vec(), context.to_vec())
    };
    let inserted_ids: HashSet<String> = transcript_ids
        .iter()
        .chain(&context_ids)
        .filter(|message_id| !existing_by_id.contains_key(message_id.as_str()))
        .cloned()
        .collect();
    if let Err(error) = state
        .conversations
        .link_resumed_messages(&id, &transcript_ids, &context_ids, &inserted_ids)
        .await
    {
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
    }
    let imported_total = inserted_messages + imported_context;
    let status = if !existed {
        "created"
    } else if imported_total > 0 || metadata_changed {
        "merged"
    } else {
        "unchanged"
    };
    if bundle.selection.omitted_earlier_messages {
        warnings.push("earlier-messages-omitted".to_owned());
    }
    Json(RnpResumeResultV0 {
        version: VERSION,
        conversation_id: id,
        status: status.to_owned(),
        imported: RnpImportedCountsV0 {
            messages: inserted_messages,
            context_items: imported_context,
        },
        warnings,
    })
    .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::conversations::{ConversationStore, Tenancy};
    use crate::server::sync::apply_sync_payload;

    #[test]
    fn shared_types_accept_the_protocol_fixture() {
        let bundle: RnpContinuityBundleV0 = serde_json::from_str(include_str!(
            "../../../../packages/protocol/fixtures/continuity-v0.json"
        ))
        .expect("fixture must deserialize");
        validate_bundle(&bundle).expect("fixture must satisfy Rust limits");
        assert_eq!(
            bundle.source.checkpoint_message_id.as_deref(),
            Some("message-fixture-2")
        );
    }

    #[test]
    fn validation_rejects_privileged_roles_and_duplicate_ids() {
        let fixture = include_str!("../../../../packages/protocol/fixtures/continuity-v0.json");
        let mut bundle: RnpContinuityBundleV0 = serde_json::from_str(fixture).unwrap();
        bundle.messages[0].role = "system".to_owned();
        assert!(validate_bundle(&bundle).is_err());

        let mut bundle: RnpContinuityBundleV0 = serde_json::from_str(fixture).unwrap();
        bundle.messages.push(bundle.messages[0].clone());
        assert!(validate_bundle(&bundle).is_err());

        let mut bundle: RnpContinuityBundleV0 = serde_json::from_str(fixture).unwrap();
        bundle.messages[0].source_id = "rnp-context-reserved".to_owned();
        assert!(validate_bundle(&bundle).is_err());
    }

    #[test]
    fn context_ids_are_deterministic_but_do_not_reveal_bundle_text() {
        let first = context_message_id("bundle-secret", "item-secret");
        let second = context_message_id("bundle-secret", "item-secret");
        assert_eq!(first, second);
        assert!(!first.contains("secret"));
        assert!(first.len() <= MAX_ID_BYTES);
    }

    #[tokio::test]
    async fn same_reviewed_bundle_is_idempotent_against_a_real_store() {
        let store = ConversationStore::open_in_memory().unwrap();
        let bundle: RnpContinuityBundleV0 = serde_json::from_str(include_str!(
            "../../../../packages/protocol/fixtures/continuity-v0.json"
        ))
        .unwrap();
        let mut messages: Vec<SyncMessage> = bundle
            .messages
            .iter()
            .map(|message| SyncMessage {
                id: message.source_id.clone(),
                role: message.role.clone(),
                content: message.text.clone(),
                created_at: message.created_at,
                parent_message_id: None,
                version_root: false,
            })
            .collect();
        for (index, item) in bundle.context.items.iter().enumerate() {
            messages.push(SyncMessage {
                id: context_message_id(&bundle.bundle_id, &item.id),
                role: "user".to_owned(),
                content: context_message(item),
                created_at: bundle.created_at + index as i64,
                parent_message_id: None,
                version_root: false,
            });
        }
        let payload = SyncPayload {
            conversation_id: bundle.source.conversation_id.clone(),
            title: bundle.source.title.clone(),
            agent_id: None,
            folder_path: None,
            branch: None,
            worktree_path: None,
            run_status: None,
            owner_user_id: None,
            created_at: bundle.messages[0].created_at,
            updated_at: bundle.source.updated_at,
            messages,
        };

        apply_sync_payload(&store, &payload, Tenancy::Unattributed)
            .await
            .unwrap();
        apply_sync_payload(&store, &payload, Tenancy::Unattributed)
            .await
            .unwrap();

        let stored = store
            .get_messages(&bundle.source.conversation_id)
            .await
            .unwrap();
        assert_eq!(
            stored.len(),
            bundle.messages.len() + bundle.context.items.len()
        );
    }
}

#[cfg(test)]
mod routes_test;
