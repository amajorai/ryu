//! Chat-to-memory decomposition for the Memory app.
//!
//! Chat messages are source material, not durable memories. This module gives
//! Dream a bounded, visibility-filtered view of recent chats, asks the configured
//! side model for structured facts, and stores those facts as encrypted proposals.
//! Nothing enters the long-term memory set until the user accepts it.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use chrono::Timelike;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{memory, ServerState};

const DREAM_AUTOMATIC_PREF: &str = "memory-dream-automatic";
const DREAM_QUIET_START_PREF: &str = "memory-dream-quiet-start";
const DREAM_QUIET_END_PREF: &str = "memory-dream-quiet-end";
const DREAM_MODEL_PREF: &str = "memory-dream-model";
const DREAM_EFFORT_PREF: &str = "memory-dream-effort";

const DREAM_MAX_CONVERSATIONS: usize = 8;
const DREAM_MESSAGES_PER_CONVERSATION: usize = 24;
const DREAM_MAX_TRANSCRIPT_CHARS: usize = 48_000;
const DREAM_MAX_MEMORY_CHARS: usize = 600;
const DREAM_MAX_REASON_CHARS: usize = 400;
const DREAM_MAX_WHEN_TO_USE_CHARS: usize = 240;
const DREAM_MAX_TAG_CHARS: usize = 40;
const DREAM_MAX_SOURCE_IDS: usize = 12;
const DREAM_AUTOMATIC_INTERVAL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
struct DreamSource {
    conversation_id: String,
    conversation_title: String,
    message_id: String,
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct DreamReviewBody {
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DreamModelOutput {
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    memories: Vec<DreamModelMemory>,
}

#[derive(Debug, Deserialize)]
struct DreamModelMemory {
    content: String,
    #[serde(default)]
    category: Option<String>,
    #[serde(default)]
    importance: Option<i32>,
    #[serde(default)]
    when_to_use: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default, alias = "sourceMessageIds")]
    source_message_ids: Vec<String>,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DreamSettingsPatch {
    #[serde(default)]
    automatic: Option<bool>,
    #[serde(default)]
    quiet_hours_start: Option<u8>,
    #[serde(default)]
    quiet_hours_end: Option<u8>,
}

/// Build the Memory app's Dream routes. The parent memory router applies the
/// Memory App gate to this whole subtree.
pub(super) fn routes() -> Router<ServerState> {
    Router::new()
        .route(
            "/api/memory/dream/review",
            get(get_dream_review).post(run_dream_review),
        )
        .route(
            "/api/memory/dream/review/settings",
            get(get_dream_settings).patch(update_dream_settings),
        )
        .route(
            "/api/memory/dream/review/proposals/:id/accept",
            post(accept_dream_proposal),
        )
        .route(
            "/api/memory/dream/review/proposals/:id/reject",
            post(reject_dream_proposal),
        )
}

/// Start the opt-in Dream review loop. The loop re-reads preferences on every
/// tick so changing automatic mode or quiet hours takes effect without a Core
/// restart. It deliberately skips org-bound nodes because an unattended tick
/// has no verified user identity with which to select a private memory scope.
pub(crate) fn spawn_automatic_review(state: ServerState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(DREAM_AUTOMATIC_INTERVAL);
        // Do not spend a model call during startup; the first review is due on
        // the next normal scheduler interval.
        interval.tick().await;
        loop {
            interval.tick().await;
            run_automatic_review_tick(&state).await;
        }
    });
}

async fn run_automatic_review_tick(state: &ServerState) {
    if crate::sidecar::control_plane::registered_org().is_some() {
        tracing::debug!("Dream automatic review skipped on an org-bound node without a caller");
        return;
    }
    let settings = match read_settings(state).await {
        Ok(settings) => settings,
        Err(error) => {
            tracing::warn!("Dream automatic review could not read settings: {error:#}");
            return;
        }
    };
    if !settings["automatic"].as_bool().unwrap_or(false) {
        return;
    }
    let hour = chrono::Local::now().hour() as u8;
    let quiet_start = settings["quiet_hours_start"].as_u64().unwrap_or(22) as u8;
    let quiet_end = settings["quiet_hours_end"].as_u64().unwrap_or(8) as u8;
    if is_quiet_hour(hour, quiet_start, quiet_end) {
        tracing::debug!(
            hour,
            quiet_start,
            quiet_end,
            "Dream automatic review is in quiet hours"
        );
        return;
    }
    match run_dream_review_inner(state, &None, "automatic").await {
        Ok(body) => {
            let proposal_count = body["review"]["proposals"].as_array().map_or(0, Vec::len);
            tracing::info!(proposal_count, "Dream automatic review completed");
        }
        Err((status, message)) if status == StatusCode::CONFLICT => {
            tracing::debug!(%message, "Dream automatic review is not ready");
        }
        Err((status, message)) => {
            tracing::warn!(%status, %message, "Dream automatic review failed");
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/memory/dream/review",
    tag = "Memory",
    summary = "List pending chat-derived memory proposals",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn get_dream_review(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    let owner = super::memory_owner_user_id(&caller);
    let include_sensitive = state
        .memory
        .include_sensitive_topics(&owner)
        .await
        .unwrap_or(false);
    match pending_proposals(&state, &owner, include_sensitive).await {
        Ok(proposals) => Json(review_body(
            "manual",
            &proposals,
            if proposals.is_empty() {
                None
            } else {
                Some("Chat-derived suggestions waiting for your review.")
            },
        ))
        .into_response(),
        Err(error) => super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    post,
    path = "/api/memory/dream/review",
    tag = "Memory",
    summary = "Decompose recent chats into reviewable memory proposals",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn run_dream_review(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<DreamReviewBody>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let mode = requested_mode(body.mode.as_deref());
    match run_dream_review_inner(&state, &caller, mode).await {
        Ok(body) => Json(body).into_response(),
        Err((status, message)) => super::json_error(status, message),
    }
}

/// Run one Dream decomposition using the same path for manual and automatic
/// reviews. Keeping proposal creation in one function prevents the scheduler
/// from becoming a second, weaker implementation of the review contract.
async fn run_dream_review_inner(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    mode: &str,
) -> Result<Value, (StatusCode, String)> {
    if !state.conversations.chat_memory_enabled() {
        return Err((
            StatusCode::CONFLICT,
            "turn on Remember chats before running Dream review".to_owned(),
        ));
    }

    let owner = super::memory_owner_user_id(caller);
    let include_sensitive = state
        .memory
        .include_sensitive_topics(&owner)
        .await
        .unwrap_or(false);
    let sources = load_sources(state, caller, include_sensitive)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if sources.is_empty() {
        return Ok(review_body(
            mode,
            &[],
            Some("No recent chat sources are available to decompose."),
        ));
    }

    let (model, effort) = resolve_dream_model(state).await;
    let (system, user) = dream_prompt(&sources);
    let raw = super::call_side_model(state, &model, &effort, &system, &user)
        .await
        .map_err(|error| {
            (
                StatusCode::BAD_GATEWAY,
                format!("Dream model unavailable: {error}"),
            )
        })?;
    let output = parse_model_output(&raw).map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("Dream returned invalid structured output: {error}"),
        )
    })?;

    let pending = pending_proposals(state, &owner, include_sensitive)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let visible = memory_visibility(caller);
    let active = state
        .memory
        .list_visible_with_sensitive(
            &memory::MemoryFilter {
                lifecycle: Some(memory::MemoryLifecycle::Active),
                limit: Some(500),
                ..Default::default()
            },
            visible,
            include_sensitive,
        )
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let mut known_content: HashSet<String> = active
        .into_iter()
        .map(|entry| normalize_key(&entry.content))
        .chain(
            pending
                .iter()
                .map(|proposal| normalize_key(&proposal.draft.content)),
        )
        .collect();
    let source_by_id: HashMap<String, DreamSource> = sources
        .iter()
        .cloned()
        .map(|source| (source.message_id.clone(), source))
        .collect();

    for candidate in output.memories.into_iter().take(20) {
        let Some(content) = bounded_text(&candidate.content, DREAM_MAX_MEMORY_CHARS) else {
            continue;
        };
        if !include_sensitive && !memory::detect_sensitive_topics(&content).is_empty() {
            continue;
        }
        let key = normalize_key(&content);
        if key.is_empty() || !known_content.insert(key) {
            continue;
        }

        let source_ids = candidate
            .source_message_ids
            .iter()
            .map(|id| id.trim())
            .filter(|id| source_by_id.contains_key(*id))
            .take(DREAM_MAX_SOURCE_IDS)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if source_ids.is_empty() {
            continue;
        }

        let first_source = source_ids.iter().find_map(|id| source_by_id.get(id));
        let provenance = memory::MemoryProvenance {
            source: memory::MemorySource::Consolidation,
            conversation_id: first_source.map(|source| source.conversation_id.clone()),
            message_ids: source_ids,
            memory_ids: Vec::new(),
            confidence: None,
        };
        let rationale = bounded_text(
            candidate
                .reason
                .as_deref()
                .unwrap_or("Derived from recent chat context; review before saving."),
            DREAM_MAX_REASON_CHARS,
        )
        .unwrap_or_else(|| "Derived from recent chat context; review before saving.".to_owned());
        let when_to_use = candidate
            .when_to_use
            .as_deref()
            .and_then(|value| bounded_text(value, DREAM_MAX_WHEN_TO_USE_CHARS));
        let tags = candidate
            .tags
            .iter()
            .filter_map(|tag| bounded_text(tag, DREAM_MAX_TAG_CHARS))
            .map(|tag| tag.to_ascii_lowercase())
            .take(8)
            .collect();
        let draft = memory::MemoryProposalDraft {
            content,
            scope: memory::MemoryScope::User,
            scope_id: None,
            category: candidate
                .category
                .as_deref()
                .map(memory::MemoryCategory::from_str)
                .unwrap_or_default(),
            importance: candidate
                .importance
                .unwrap_or(memory::DEFAULT_IMPORTANCE)
                .clamp(1, 5),
            when_to_use,
            tags,
            author_agent_id: Some("dream".to_owned()),
            metadata: memory::MemoryMetadata {
                provenance,
                ..Default::default()
            },
        };
        let proposal = memory::NewMemoryProposal {
            owner_user_id: owner.clone(),
            agent_id: "dream".to_owned(),
            target_memory_id: None,
            operation: memory::MemoryProposalOperation::Create,
            draft,
            rationale,
        };
        state
            .memory
            .create_proposal(proposal)
            .await
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }

    let proposals = pending_proposals(state, &owner, include_sensitive)
        .await
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let summary = bounded_text(
        output
            .summary
            .as_deref()
            .unwrap_or("Dream decomposed recent chats into reviewable memory suggestions."),
        DREAM_MAX_REASON_CHARS,
    );
    Ok(review_body(mode, &proposals, summary.as_deref()))
}

#[utoipa::path(
    get,
    path = "/api/memory/dream/review/settings",
    tag = "Memory",
    summary = "Read Dream review settings",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn get_dream_settings(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    match read_settings(&state).await {
        Ok(settings) => Json(json!({ "settings": settings })).into_response(),
        Err(error) => super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

#[utoipa::path(
    patch,
    path = "/api/memory/dream/review/settings",
    tag = "Memory",
    summary = "Update Dream review settings",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn update_dream_settings(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(patch): Json<DreamSettingsPatch>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    for hour in [patch.quiet_hours_start, patch.quiet_hours_end]
        .into_iter()
        .flatten()
    {
        if hour > 23 {
            return super::json_error(
                StatusCode::BAD_REQUEST,
                "Dream quiet hours must be between 0 and 23".to_owned(),
            );
        }
    }
    let current = match read_settings(&state).await {
        Ok(settings) => settings,
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    let automatic = patch
        .automatic
        .unwrap_or(current["automatic"].as_bool().unwrap_or(false));
    let quiet_hours_start = patch
        .quiet_hours_start
        .map(u64::from)
        .unwrap_or_else(|| current["quiet_hours_start"].as_u64().unwrap_or(22));
    let quiet_hours_end = patch
        .quiet_hours_end
        .map(u64::from)
        .unwrap_or_else(|| current["quiet_hours_end"].as_u64().unwrap_or(8));
    let writes = [
        (DREAM_AUTOMATIC_PREF, automatic.to_string()),
        (DREAM_QUIET_START_PREF, quiet_hours_start.to_string()),
        (DREAM_QUIET_END_PREF, quiet_hours_end.to_string()),
    ];
    for (key, value) in writes {
        if let Err(error) = state.preferences.set(key, &value).await {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    }
    Json(json!({
        "settings": {
            "automatic": automatic,
            "quiet_hours_start": quiet_hours_start,
            "quiet_hours_end": quiet_hours_end,
        }
    }))
    .into_response()
}

#[utoipa::path(
    post,
    path = "/api/memory/dream/review/proposals/{id}/accept",
    tag = "Memory",
    summary = "Accept a Dream memory proposal",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn accept_dream_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let owner = super::memory_owner_user_id(&caller);
    let reviewer = caller.as_ref().map(|caller| caller.user_id.clone());
    let memory = state.memory;
    let retrieval = state.retrieval;
    review_dream_proposal(memory, retrieval, owner, reviewer, &id, true).await
}

#[utoipa::path(
    post,
    path = "/api/memory/dream/review/proposals/{id}/reject",
    tag = "Memory",
    summary = "Reject a Dream memory proposal",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(super) async fn reject_dream_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = super::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let owner = super::memory_owner_user_id(&caller);
    let reviewer = caller.as_ref().map(|caller| caller.user_id.clone());
    let memory = state.memory;
    let retrieval = state.retrieval;
    review_dream_proposal(memory, retrieval, owner, reviewer, &id, false).await
}

async fn review_dream_proposal(
    memory: memory::MemoryStore,
    retrieval: crate::server::retrieval::RetrievalStore,
    owner: String,
    reviewer: Option<String>,
    id: &str,
    approve: bool,
) -> Response {
    let proposal = match memory.get_proposal(id).await {
        Ok(Some(proposal)) if proposal.owner_user_id == owner => proposal,
        Ok(_) => return super::json_error(StatusCode::NOT_FOUND, "proposal not found".to_owned()),
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if approve
        && !memory::detect_sensitive_topics(&proposal.draft.content).is_empty()
        && !memory
            .include_sensitive_topics(&owner)
            .await
            .unwrap_or(false)
    {
        return super::json_error(
            StatusCode::BAD_REQUEST,
            "sensitive topics are disabled in Settings → Memory".to_owned(),
        );
    }
    let reviewed = match memory
        .review_proposal(id, approve, reviewer.as_deref())
        .await
    {
        Ok(Some(reviewed)) => reviewed,
        Ok(None) => {
            return super::json_error(StatusCode::NOT_FOUND, "proposal not found".to_owned())
        }
        Err(error) => {
            return super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
        }
    };
    if !approve {
        return Json(json!({ "success": true })).into_response();
    }

    let Some(memory_id) = reviewed.applied_memory_id.as_deref() else {
        return super::json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "accepted proposal did not produce a memory".to_owned(),
        );
    };
    match memory.get(memory_id).await {
        Ok(Some(entry)) => {
            if let Some(superseded_id) = entry.supersedes_id.as_deref() {
                // A revision creates a new source row; remove the old derived
                // vector before it can remain recallable as a stale answer.
                let _ = retrieval.remove_chunk(superseded_id).await;
            }
            index_reviewed_memory(memory.clone(), retrieval, entry.clone()).await;
            Json(json!({ "memory": entry })).into_response()
        }
        Ok(None) => super::json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "accepted memory could not be read back".to_owned(),
        ),
        Err(error) => super::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()),
    }
}

async fn index_reviewed_memory(
    memory: memory::MemoryStore,
    retrieval: crate::server::retrieval::RetrievalStore,
    entry: memory::LongTermEntry,
) {
    let consent_user = entry.owner_user_id.as_deref().unwrap_or(memory::LOCAL_USER);
    if !entry.sensitive_topics.is_empty()
        && !memory
            .include_sensitive_topics(consent_user)
            .await
            .unwrap_or(false)
    {
        let _ = retrieval.remove_chunk(&entry.id).await;
        return;
    }
    let node_org = super::node_org_id();
    let owner = match (node_org.as_deref(), entry.owner_user_id.as_deref()) {
        (Some(org), Some(uid)) if uid != memory::LOCAL_USER => {
            crate::server::retrieval::RetrievalOwner::owned(Some(uid), Some(org), None)
        }
        _ => crate::server::retrieval::RetrievalOwner::shared(),
    };
    if let Err(error) = retrieval
        .index_memory_chunk_with_metadata(
            &entry.id,
            &entry.content,
            entry.scope.as_str(),
            entry.scope_id.as_deref(),
            entry.category.as_str(),
            entry.importance,
            entry.author_agent_id.as_deref(),
            !entry.sensitive_topics.is_empty(),
            owner,
        )
        .await
    {
        tracing::warn!(
            "memory: indexing entry {} failed (search may lag): {error:#}",
            entry.id
        );
    }
}

async fn pending_proposals(
    state: &ServerState,
    owner: &str,
    include_sensitive: bool,
) -> anyhow::Result<Vec<memory::MemoryRevisionProposal>> {
    let proposals = state
        .memory
        .list_proposals(
            owner,
            &memory::MemoryProposalFilter {
                status: Some(memory::MemoryProposalStatus::Pending),
                limit: Some(100),
            },
        )
        .await?;
    Ok(if include_sensitive {
        proposals
    } else {
        proposals
            .into_iter()
            .filter(|proposal| memory::detect_sensitive_topics(&proposal.draft.content).is_empty())
            .collect()
    })
}

async fn load_sources(
    state: &ServerState,
    caller: &Option<crate::identity_verify::VerifiedCaller>,
    include_sensitive: bool,
) -> anyhow::Result<Vec<DreamSource>> {
    let summaries = state
        .conversations
        .list_conversations_visible(
            caller.as_ref().map(|caller| caller.user_id.as_str()),
            caller.as_ref().and_then(|caller| caller.org_id.as_deref()),
            crate::sidecar::control_plane::registered_org().is_some(),
        )
        .await?;
    let mut sources = Vec::new();
    let mut transcript_chars = 0;
    'conversations: for summary in summaries.into_iter().take(DREAM_MAX_CONVERSATIONS) {
        let messages = state
            .conversations
            .get_recent_messages(&summary.id, DREAM_MESSAGES_PER_CONVERSATION)
            .await?;
        for message in messages {
            if !matches!(message.role.as_str(), "user" | "assistant")
                || message.content.trim().is_empty()
            {
                continue;
            }
            if !include_sensitive && !memory::detect_sensitive_topics(&message.content).is_empty() {
                continue;
            }
            let Some(content) = bounded_text(&message.content, 4_000) else {
                continue;
            };
            let cost = content.len() + message.id.len() + 40;
            if transcript_chars + cost > DREAM_MAX_TRANSCRIPT_CHARS && !sources.is_empty() {
                break 'conversations;
            }
            transcript_chars += cost;
            sources.push(DreamSource {
                conversation_id: summary.id.clone(),
                conversation_title: summary
                    .title
                    .clone()
                    .unwrap_or_else(|| "Conversation".to_owned()),
                message_id: message.id,
                role: message.role,
                content,
            });
        }
    }
    Ok(sources)
}

fn dream_prompt(sources: &[DreamSource]) -> (String, String) {
    let transcript = sources
        .iter()
        .map(|source| {
            format!(
                "[message_id={} | conversation={}]\n{}: {}",
                source.message_id, source.conversation_title, source.role, source.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let system = "You are Dream, Ryu's private chat-to-memory decomposer. Extract only durable, \
                  useful facts from the supplied recent chat sources. A durable fact is a stable \
                  user preference, user fact, project decision, reusable procedure, relationship, \
                  or standing directive. Ignore greetings, one-off requests, speculation, secrets, \
                  credentials, and facts that are not supported by the sources. Never copy a raw \
                  transcript into a memory. Return ONLY valid JSON with this shape: \
                  {\"summary\":\"short summary\",\"memories\":[{\"content\":\"one concise \
                  durable fact\",\"category\":\"user_fact|preference|domain_knowledge|organization|\
                  project_context|relationship|directive|procedure|event|other\",\"importance\":1,\
                  \"when_to_use\":\"optional short trigger\",\"tags\":[\"optional\"],\
                  \"source_message_ids\":[\"message id from the sources\"],\
                  \"reason\":\"why this is durable\"}]}. Every memory MUST cite one or more exact \
                  source_message_ids. Keep the list short and prefer high-confidence facts.";
    let user = format!(
        "Decompose these recent chat sources into reviewable memory proposals. The proposals are \
         not saved automatically; they will be shown to the user first.\n\n{}",
        transcript
    );
    (system.to_owned(), user)
}

async fn resolve_dream_model(state: &ServerState) -> (String, String) {
    if let Some(resolved) = crate::agent_selection::resolve_side_model(
        &state.preferences,
        DREAM_MODEL_PREF,
        Some(DREAM_EFFORT_PREF),
    )
    .await
    {
        return (resolved.model, resolved.effort);
    }
    let effort = state
        .preferences
        .get(DREAM_EFFORT_PREF)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    (
        crate::registry::DEFAULT_LOCAL_CHAT_MODEL_ID.to_owned(),
        effort,
    )
}

fn parse_model_output(raw: &str) -> Result<DreamModelOutput, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("the model returned an empty response".to_owned());
    }
    if let Ok(output) = serde_json::from_str::<DreamModelOutput>(trimmed) {
        return Ok(output);
    }
    let start = trimmed
        .find('{')
        .ok_or_else(|| "no JSON object found".to_owned())?;
    let end = trimmed
        .rfind('}')
        .ok_or_else(|| "JSON object was not closed".to_owned())?;
    if end < start {
        return Err("JSON object was not closed".to_owned());
    }
    serde_json::from_str(&trimmed[start..=end])
        .map_err(|error| format!("could not parse JSON: {error}"))
}

fn review_body(
    mode: &str,
    proposals: &[memory::MemoryRevisionProposal],
    summary: Option<&str>,
) -> Value {
    json!({
        "review": {
            "generated_at": chrono::Utc::now().timestamp_millis(),
            "mode": mode,
            "proposals": proposals.iter().map(proposal_wire).collect::<Vec<_>>(),
            "summary": summary,
        }
    })
}

fn proposal_wire(proposal: &memory::MemoryRevisionProposal) -> Value {
    let draft = &proposal.draft;
    json!({
        "created_at": proposal.created_at,
        "current": Value::Null,
        "id": proposal.id,
        "proposed": {
            "author_agent_id": draft.author_agent_id.as_deref(),
            "category": draft.category.as_str(),
            "content": draft.content.as_str(),
            "created_at": proposal.created_at,
            "id": format!("proposal-memory-{}", proposal.id),
            "importance": draft.importance,
            "scope": draft.scope.as_str(),
            "scope_id": draft.scope_id.as_deref(),
            "tags": &draft.tags,
            "updated_at": proposal.updated_at,
            "when_to_use": draft.when_to_use.as_deref(),
        },
        "reason": proposal.rationale.as_str(),
        "source": "Chat decomposition",
        "status": proposal.status.as_str(),
    })
}

async fn read_settings(state: &ServerState) -> anyhow::Result<Value> {
    let automatic = state
        .preferences
        .get(DREAM_AUTOMATIC_PREF)
        .await?
        .as_deref()
        .map(parse_bool)
        .unwrap_or(false);
    let quiet_hours_start = state
        .preferences
        .get(DREAM_QUIET_START_PREF)
        .await?
        .as_deref()
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|hour| *hour <= 23)
        .unwrap_or(22);
    let quiet_hours_end = state
        .preferences
        .get(DREAM_QUIET_END_PREF)
        .await?
        .as_deref()
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|hour| *hour <= 23)
        .unwrap_or(8);
    Ok(json!({
        "automatic": automatic,
        "quiet_hours_start": quiet_hours_start,
        "quiet_hours_end": quiet_hours_end,
    }))
}

fn memory_visibility(
    caller: &Option<crate::identity_verify::VerifiedCaller>,
) -> memory::MemoryVisibility<'_> {
    memory::MemoryVisibility::for_caller_in_org(
        caller.as_ref().map(|caller| caller.user_id.as_str()),
        caller.as_ref().and_then(|caller| caller.org_id.as_deref()),
        crate::sidecar::control_plane::registered_org().is_some(),
    )
}

fn requested_mode(mode: Option<&str>) -> &'static str {
    if mode.is_some_and(|mode| mode.eq_ignore_ascii_case("automatic")) {
        "automatic"
    } else {
        "manual"
    }
}

fn parse_bool(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "on" | "yes"
    )
}

fn is_quiet_hour(hour: u8, start: u8, end: u8) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        (start..end).contains(&hour)
    } else {
        hour >= start || hour < end
    }
}

fn bounded_text(value: &str, max_chars: usize) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(max_chars).collect())
}

fn normalize_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::{is_quiet_hour, parse_model_output, requested_mode};

    #[test]
    fn parses_json_after_model_prose() {
        let output = parse_model_output(
            "Here is the result: {\"summary\":\"one fact\",\"memories\":[{\"content\":\"Likes concise answers\",\"source_message_ids\":[\"m1\"]}]}",
        )
        .unwrap();
        assert_eq!(output.memories.len(), 1);
        assert_eq!(output.memories[0].source_message_ids, ["m1"]);
    }

    #[test]
    fn ignores_unknown_mode() {
        assert_eq!(requested_mode(Some("future")), "manual");
        assert_eq!(requested_mode(Some("automatic")), "automatic");
    }

    #[test]
    fn quiet_hours_support_ranges_that_cross_midnight() {
        assert!(is_quiet_hour(23, 22, 8));
        assert!(is_quiet_hour(3, 22, 8));
        assert!(!is_quiet_hour(12, 22, 8));
        assert!(!is_quiet_hour(8, 8, 8));
    }
}
