//! Kernel host capabilities over the Projects › Bots/Groups › Sessions primitives.
//!
//! An out-of-process app (the Projects app is the first consumer) holds no node
//! token, so it reaches the hierarchy through these capabilities on the broker:
//!
//! - `threads.ensureMainThread` — find or create the main (coordinator) thread of
//!   a project, a bot, or a group, optionally inside a project. Body
//!   `{ project_id?, owner_kind, owner_id, agent_id?, title?, icon? }` →
//!   `{ conversation_id }`. A non-null `icon` (a `GlyphValue`) is written onto
//!   the thread every call, so a project's avatar follows the project.
//! - `threads.placeInProject` — put a conversation in a project (or take it out).
//!   Body `{ conversation_id, project_id?, spawned_by_conversation_id? }` →
//!   `{ ok }`. `spawned_by_conversation_id` records the main thread the app
//!   started this session for, so it shows under that main thread.
//! - `scopeDefaults.set` — write a `project:<id>` or `project:<id>/agent:<id>`
//!   model default (empty values reset it to inherited). Agent-wide scopes stay
//!   desktop-only. Body `{ scope, provider?, model?, effort? }` → `{ ok }`.
//! - `scopeGuidance.set` — write a `project:<id>` or `project:<id>/agent:<id>`
//!   goal, instructions, and brief-replies toggle (see
//!   `conversations::ScopeGuidance`). Body
//!   `{ scope, goal?, instructions?, briefReplies? }` → `{ ok, promptChanged }`.
//!
//! The first three reuse the `chat.sendFollowUp` grant: they only shape where an
//! app's own `chat.startTurn` turns land and which model they use, which is no
//! more than that grant already confers. `scopeGuidance.set` needs its own
//! [`GRANT_PROJECT_GUIDANCE`]: guidance goes into the system prompt of every
//! turn in the project, including turns the user starts, so it reaches far past
//! the app's own turns. All four are refused on shared
//! (org-bound or managed) nodes until the host caller is bound to a verified
//! user, because an app token authenticates the app, not the human.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

/// The grant behind `scopeGuidance.set`. It is in the reserved `chat`
/// namespace, so no app can self-approve it by its id, and the Gateway approves
/// it only for the reviewed Projects app (an owner-exclusive grant).
pub const GRANT_PROJECT_GUIDANCE: &str = "chat:project-guidance";

use super::conversations::{
    is_valid_guidance_scope, is_valid_scope, validate_opaque_id, OwnerKind, ScopeDefaultInput,
    ScopeGuidanceInput, Tenancy,
};
use super::ServerState;

fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": message.into() }))).into_response()
}

/// Authenticate the calling sidecar and refuse shared nodes.
async fn authenticate(
    state: &ServerState,
    headers: &HeaderMap,
    cap: &str,
) -> Result<String, Response> {
    let plugin_id = match crate::sidecar::ext_proxy::authenticate_sidecar(state, headers).await {
        Ok((id, _grants)) => id,
        Err((status, message)) => return Err(error(status, message)),
    };
    if crate::sidecar::control_plane::registered_org().is_some()
        || crate::sidecar::control_plane::is_managed_node()
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            format!("{cap} is unavailable on shared nodes until the host caller is bound to a verified user"),
        ));
    }
    Ok(plugin_id)
}

#[derive(Debug, Deserialize)]
pub struct EnsureMainThreadBody {
    #[serde(default)]
    pub project_id: Option<String>,
    pub owner_kind: String,
    pub owner_id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub icon: Option<serde_json::Value>,
}

pub async fn host_ensure_main_thread(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<EnsureMainThreadBody>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers, "threads.ensureMainThread").await {
        return response;
    }
    let Some(kind) = OwnerKind::parse(&body.owner_kind) else {
        return error(
            StatusCode::BAD_REQUEST,
            "owner_kind must be project, agent, or group",
        );
    };
    if let Err(e) = validate_opaque_id(&body.owner_id) {
        return error(StatusCode::BAD_REQUEST, e.to_string());
    }
    match state
        .conversations
        .ensure_main_thread(
            body.project_id.as_deref(),
            kind,
            &body.owner_id,
            body.agent_id.as_deref(),
            body.title.as_deref(),
            Tenancy::Unattributed,
        )
        .await
    {
        Ok(conversation_id) => {
            if let Some(icon) = body.icon.as_ref().filter(|icon| !icon.is_null()) {
                if let Err(e) = state
                    .conversations
                    .set_icon(&conversation_id, Some(icon))
                    .await
                {
                    return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                }
            }
            Json(json!({ "conversation_id": conversation_id })).into_response()
        }
        Err(e) => error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct PlaceInProjectBody {
    pub conversation_id: String,
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub spawned_by_conversation_id: Option<String>,
}

pub async fn host_place_in_project(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<PlaceInProjectBody>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers, "threads.placeInProject").await {
        return response;
    }
    let conversation_id = body.conversation_id.trim();
    if conversation_id.is_empty() {
        return error(StatusCode::BAD_REQUEST, "conversation_id is required");
    }
    // A turn the app has started but that is still pending approval has no row
    // yet; create it so the placement is not lost.
    if let Err(e) = state
        .conversations
        .ensure_conversation(conversation_id, None, None, Tenancy::Unattributed)
        .await
    {
        return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
    }
    if let Err(e) = state
        .conversations
        .set_thread_project(conversation_id, body.project_id.as_deref())
        .await
    {
        return error(StatusCode::BAD_REQUEST, e.to_string());
    }
    if let Some(parent) = body
        .spawned_by_conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|parent| !parent.is_empty())
    {
        if let Err(e) = state
            .conversations
            .mark_spawned_by(conversation_id, parent, None)
            .await
        {
            return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Debug, Deserialize)]
pub struct SetScopeDefaultBody {
    pub scope: String,
    /// Absent coordinator fields keep what is stored, so an app that only knows
    /// the thread pair never wipes the coordinator values a user set from the
    /// desktop.
    #[serde(flatten)]
    pub value: ScopeDefaultInput,
}

pub async fn host_set_scope_default(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<SetScopeDefaultBody>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers, "scopeDefaults.set").await {
        return response;
    }
    if !body.scope.starts_with("project:") || !is_valid_scope(&body.scope) {
        return error(
            StatusCode::BAD_REQUEST,
            "apps may set only project:<id> or project:<id>/agent:<id> defaults",
        );
    }
    let stored = match state.conversations.scope_default(&body.scope).await {
        Ok(stored) => stored.unwrap_or_default(),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let value = body.value.merged_over(stored);
    match state
        .conversations
        .set_scope_default(&body.scope, value)
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Debug, Deserialize)]
pub struct SetScopeGuidanceBody {
    pub scope: String,
    /// Omitted fields keep what is stored, like [`SetScopeDefaultBody`].
    #[serde(flatten)]
    pub value: ScopeGuidanceInput,
}

pub async fn host_set_scope_guidance(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<SetScopeGuidanceBody>,
) -> Response {
    if let Err(response) = authenticate(&state, &headers, "scopeGuidance.set").await {
        return response;
    }
    if !body.scope.starts_with("project:") || !is_valid_guidance_scope(&body.scope) {
        return error(
            StatusCode::BAD_REQUEST,
            "apps may set only project:<id> or project:<id>/agent:<id> guidance",
        );
    }
    let stored = match state.conversations.scope_guidance(&body.scope).await {
        Ok(stored) => stored.unwrap_or_default(),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let value = body.value.merged_over(stored);
    match state
        .conversations
        .set_scope_guidance(&body.scope, value)
        .await
    {
        Ok(changed) => Json(json!({ "ok": true, "promptChanged": changed })).into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}
