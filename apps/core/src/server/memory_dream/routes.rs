//! Dream's HTTP handlers: read and run a review, read and update its
//! settings, and accept or reject a proposal. The review itself, and what it
//! reports when the proposal was already handled, lives in `review`; undo lives
//! in `rollback`.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use super::automatic::read_settings;
use super::candidates::{pending_proposals, run_dream_review_inner};
use super::review::review_dream_proposal;
use super::rollback::{recent_applied, recent_wire, rollback_dream_proposal};
use super::run_state::read_run_state;
use super::wire::{pending_summary, requested_mode, review_body};
use super::{DREAM_AUTOMATIC_PREF, DREAM_QUIET_END_PREF, DREAM_QUIET_START_PREF};
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
pub(super) struct DreamReviewBody {
    #[serde(default)]
    pub(super) mode: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(super) struct DreamSettingsPatch {
    #[serde(default)]
    automatic: Option<bool>,
    #[serde(default)]
    quiet_hours_start: Option<u8>,
    #[serde(default)]
    quiet_hours_end: Option<u8>,
}

/// Build the Memory app's Dream routes. The parent memory router applies the
/// Memory App gate to this whole subtree.
pub(in crate::server) fn routes() -> Router<ServerState> {
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
        .route(
            "/api/memory/dream/review/proposals/:id/rollback",
            post(rollback_dream_proposal),
        )
}

#[utoipa::path(
    get,
    path = "/api/memory/dream/review",
    tag = "Memory",
    summary = "List pending chat-derived memory proposals",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_dream_review(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_READ,
    )
    .await
    {
        return response;
    }
    let owner = crate::server::memory_owner_user_id(&caller);
    let include_sensitive = state
        .memory
        .include_sensitive_topics(&owner)
        .await
        .unwrap_or(false);
    match pending_proposals(&state, &owner, include_sensitive).await {
        Ok(proposals) => {
            let last_run = read_run_state(&state).await.last_run;
            let mut body = review_body("manual", &proposals, pending_summary(&proposals), last_run);
            // Accepted changes that can still be undone. A failure here only
            // hides the list; the queue itself still loads.
            let now = chrono::Utc::now().timestamp_millis();
            match recent_applied(&state, &owner, include_sensitive, now).await {
                Ok(recent) => body["review"]["recent"] = recent_wire(&recent),
                Err(error) => tracing::warn!("memory: listing recent Dream proposals: {error:#}"),
            }
            // Sealed recall indexes search vectors from memory: report how much
            // is hydrated and how many rows did not open, so degraded semantic
            // recall is visible rather than silent. Counts only, no content.
            body["recall_diagnostics"] =
                crate::rag_host::recall_diagnostics(&state.retrieval, &state.conversations);
            Json(body).into_response()
        }
        Err(error) => {
            crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        }
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
pub(in crate::server) async fn run_dream_review(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<DreamReviewBody>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
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
        Err((status, message)) => crate::server::json_error(status, message),
    }
}

#[utoipa::path(
    get,
    path = "/api/memory/dream/review/settings",
    tag = "Memory",
    summary = "Read Dream review settings",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn get_dream_settings(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
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
        Err(error) => {
            crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
        }
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
pub(in crate::server) async fn update_dream_settings(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(patch): Json<DreamSettingsPatch>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
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
            return crate::server::json_error(
                StatusCode::BAD_REQUEST,
                "Dream quiet hours must be between 0 and 23".to_owned(),
            );
        }
    }
    let current = match read_settings(&state).await {
        Ok(settings) => settings,
        Err(error) => {
            return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
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
            return crate::server::json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string());
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
    description = "Writes the proposed memory, or archives its target, and returns the memory. Accepting an already accepted proposal returns it again. Refused with 409 when the proposal cannot apply; the body's `code` is `already_rejected`, `already_undone`, `target_deleted` (the memory it targets was deleted) or `target_changed` (that memory was revised or archived since).",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 400, description = "The proposal has sensitive topics and they are turned off"),
        (status = 403, description = "The caller may not write memory"),
        (status = 404, description = "No such proposal for this caller"),
        (status = 409, description = "The proposal was already handled or its target changed"),
        (status = 422, description = "The proposal cannot be applied as written")
    )
)]
pub(in crate::server) async fn accept_dream_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let owner = crate::server::memory_owner_user_id(&caller);
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
    description = "Declines a pending proposal; nothing is written. Rejecting a proposal a reviewer already rejected succeeds again. Refused with 409 when the proposal is in another state; the body's `code` is `already_accepted`, `already_undone` or `target_deleted` (the memory it targeted was deleted, so it was rejected automatically).",
    params(("id" = String, Path)),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "The caller may not write memory"),
        (status = 404, description = "No such proposal for this caller"),
        (status = 409, description = "The proposal was already handled")
    )
)]
pub(in crate::server) async fn reject_dream_proposal(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = crate::server::require_memory_permission(
        &state,
        &caller,
        crate::identity_verify::permissions::SPACE_WRITE,
    )
    .await
    {
        return response;
    }
    let owner = crate::server::memory_owner_user_id(&caller);
    let reviewer = caller.as_ref().map(|caller| caller.user_id.clone());
    let memory = state.memory;
    let retrieval = state.retrieval;
    review_dream_proposal(memory, retrieval, owner, reviewer, &id, false).await
}
