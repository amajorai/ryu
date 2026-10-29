//! REST surface for the Projects › Bots/Groups › Sessions hierarchy.
//!
//! Generic, app-agnostic endpoints over [`super::conversations`]' hierarchy
//! primitives. The Projects app (`@ryu/projects`) and the desktop use them to
//! place threads in a project, find or create the main (coordinator) thread of a
//! project, bot, or group, list the sessions a main thread spawned, and read or
//! write per-scope model defaults and prompt guidance (project goals, bot goals,
//! a bot's goal inside one project, brief main-thread replies). Core never
//! interprets a project id.
//!
//! ACL: thread reads/writes go through the same per-conversation gates as the
//! rest of the conversation API; listings drop rows the caller cannot read.
//! Scope-default writes need `projects.manage` for project scopes,
//! `agent.edit` for agent scopes and `gateway.configure` for the node-wide
//! `global` scope. Scope-guidance writes use the same permissions.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use super::conversations::{validate_opaque_id, ConversationSummary, OwnerKind, Tenancy};
// The runtime tests (`use super::*`) validate scope shapes through this import.
#[cfg(test)]
use super::conversations::is_valid_scope;
use super::{json_error, ServerState};
use crate::identity_verify::VerifiedCaller;

type Caller = Extension<Option<VerifiedCaller>>;

pub fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/hierarchy/threads/:id", get(get_thread_hierarchy))
        .route(
            "/api/hierarchy/threads/:id/project",
            put(set_thread_project),
        )
        .route(
            "/api/hierarchy/threads/:id/coordination",
            put(set_thread_coordination),
        )
        .route("/api/hierarchy/threads/:id/sessions", get(list_sessions))
        .route(
            "/api/hierarchy/main-threads",
            get(find_main_thread).post(ensure_main_thread),
        )
        .route(
            "/api/hierarchy/projects/:project_id/threads",
            get(list_project_threads),
        )
        .route("/api/scope-defaults", get(scope::list_scope_defaults))
        .route(
            "/api/hierarchy/effective-defaults",
            get(scope::effective_scope_defaults),
        )
        .route(
            "/api/scope-defaults/*scope",
            put(scope::set_scope_default).delete(scope::clear_scope_default),
        )
        .route("/api/scope-guidance", get(scope::list_scope_guidance))
        .route(
            "/api/scope-guidance/*scope",
            get(scope::get_scope_guidance)
                .put(scope::set_scope_guidance)
                .delete(scope::clear_scope_guidance),
        )
        .route(
            "/api/hierarchy/memory/rekey-project",
            post(scope::rekey_project_memory),
        )
        .merge(primary_bot::routes())
}

#[path = "hierarchy_scope_api.rs"]
mod scope;

#[path = "primary_bot.rs"]
pub mod primary_bot;
#[path = "primary_bot_store.rs"]
pub mod primary_bot_store;

fn bad_request(message: impl Into<String>) -> Response {
    json_error(StatusCode::BAD_REQUEST, message.into())
}

fn internal(error: impl std::fmt::Display) -> Response {
    json_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

async fn require_read(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<(), Response> {
    super::require_conversation_read_by_id(state, caller, id).await
}

async fn require_write(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<(), Response> {
    super::require_resource_write(
        state.conversations.get_access_meta(id).await,
        caller.as_ref(),
        &format!("conversation ':id' not found"),
    )
}

/// Keep only rows the caller may read.
async fn visible(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    rows: Vec<ConversationSummary>,
) -> Vec<ConversationSummary> {
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        if require_read(state, caller, &row.id).await.is_ok() {
            out.push(row);
        }
    }
    out
}

async fn get_thread_hierarchy(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_read(&state, &caller, &id).await {
        return response;
    }
    match state.conversations.thread_hierarchy(&id).await {
        Ok(Some(hierarchy)) => {
            Json(json!({ "conversation_id": id, "hierarchy": hierarchy })).into_response()
        }
        Ok(None) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation ':id' not found"),
        ),
        Err(error) => internal(error),
    }
}

#[derive(Deserialize)]
struct ProjectBody {
    project_id: Option<String>,
    /// Optionally record the main thread this thread now sits under (e.g. a
    /// migrated folder chat under its project's coordinator thread), so it is
    /// reachable from that thread's Sessions panel.
    #[serde(default)]
    spawned_by_conversation_id: Option<String>,
}

async fn set_thread_project(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
    Json(body): Json<ProjectBody>,
) -> Response {
    if let Err(response) = require_write(&state, &caller, &id).await {
        return response;
    }
    if let Some(project_id) = body.project_id.as_deref().filter(|p| !p.trim().is_empty()) {
        if let Err(error) = validate_opaque_id(project_id) {
            return bad_request(error.to_string());
        }
    }
    let parent = body
        .spawned_by_conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|parent| !parent.is_empty());
    // Authorize both ends before changing the child. A refused parent must not
    // leave a project move acknowledged only by the database.
    if let Some(parent) = parent {
        if let Err(response) = require_read(&state, &caller, parent).await {
            return response;
        }
    }
    match state
        .conversations
        .place_thread_in_project(&id, body.project_id.as_deref(), parent)
        .await
    {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => json_error(
            StatusCode::NOT_FOUND,
            format!("conversation ':id' not found"),
        ),
        Err(error) => internal(error),
    }
}

#[derive(Deserialize)]
struct CoordinationBody {
    coordination: Option<String>,
}

async fn set_thread_coordination(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
    Json(body): Json<CoordinationBody>,
) -> Response {
    if let Err(response) = require_write(&state, &caller, &id).await {
        return response;
    }
    match state
        .conversations
        .set_group_coordination(&id, body.coordination.as_deref())
        .await
    {
        Ok(true) => Json(json!({ "ok": true })).into_response(),
        Ok(false) => bad_request("coordination applies only to a group's main thread"),
        Err(error) => bad_request(error.to_string()),
    }
}

async fn list_sessions(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(id): Path<String>,
) -> Response {
    if let Err(response) = require_read(&state, &caller, &id).await {
        return response;
    }
    match state.conversations.list_spawned_sessions(&id).await {
        Ok(rows) => {
            Json(json!({ "sessions": visible(&state, &caller, rows).await })).into_response()
        }
        Err(error) => internal(error),
    }
}

#[derive(Deserialize)]
struct MainThreadQuery {
    project_id: Option<String>,
    owner_kind: String,
    owner_id: String,
}

fn parse_owner(kind: &str, id: &str) -> Result<OwnerKind, Response> {
    let Some(kind) = OwnerKind::parse(kind) else {
        return Err(bad_request("owner_kind must be project, agent, or group"));
    };
    validate_opaque_id(id).map_err(|error| bad_request(error.to_string()))?;
    Ok(kind)
}

/// The tenancy a main thread is found or created under. A bot's personal main
/// thread (no project) follows the verified principal even on an unbound node,
/// so two signed-in users choosing the same bot never share one conversation.
/// Project and group main threads keep the existing tenancy contract.
fn main_thread_tenancy(
    caller: &Option<VerifiedCaller>,
    kind: OwnerKind,
    project_id: Option<&str>,
) -> Tenancy {
    main_thread_tenancy_from_existing(caller, kind, project_id, super::caller_tenancy(caller))
}

fn main_thread_tenancy_from_existing(
    caller: &Option<VerifiedCaller>,
    kind: OwnerKind,
    project_id: Option<&str>,
    existing: Tenancy,
) -> Tenancy {
    // Bound nodes already stamp their canonical node organization; keep it.
    if matches!(existing, Tenancy::Owned { .. }) {
        return existing;
    }
    let personal = kind == OwnerKind::Agent
        && project_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .is_none();
    match caller {
        Some(caller) if personal => Tenancy::Owned {
            user_id: caller.user_id.clone(),
            org_id: caller.org_id.clone(),
        },
        _ => existing,
    }
}

async fn find_main_thread(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    headers: HeaderMap,
    Query(query): Query<MainThreadQuery>,
) -> Response {
    if let Err(response) = primary_bot::require_valid_identity_header(&headers, &caller) {
        return response;
    }
    let kind = match parse_owner(&query.owner_kind, &query.owner_id) {
        Ok(kind) => kind,
        Err(response) => return response,
    };
    match state
        .conversations
        .find_main_thread_for_tenancy(
            query.project_id.as_deref(),
            kind,
            &query.owner_id,
            &main_thread_tenancy(&caller, kind, query.project_id.as_deref()),
        )
        .await
    {
        Ok(Some(id)) => {
            if require_read(&state, &caller, &id).await.is_err() {
                return Json(json!({ "conversation_id": null })).into_response();
            }
            Json(json!({ "conversation_id": id })).into_response()
        }
        Ok(None) => Json(json!({ "conversation_id": null })).into_response(),
        Err(error) => internal(error),
    }
}

#[derive(Deserialize)]
struct EnsureMainThreadBody {
    project_id: Option<String>,
    owner_kind: String,
    owner_id: String,
    agent_id: Option<String>,
    title: Option<String>,
}

async fn ensure_main_thread(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    headers: HeaderMap,
    Json(body): Json<EnsureMainThreadBody>,
) -> Response {
    if let Err(response) = primary_bot::require_valid_identity_header(&headers, &caller) {
        return response;
    }
    let kind = match parse_owner(&body.owner_kind, &body.owner_id) {
        Ok(kind) => kind,
        Err(response) => return response,
    };
    // Naming a bot in the owner fields must not make it runnable for the caller:
    // a bot's main thread runs that bot, behind the same gate as a primary pick.
    if kind == OwnerKind::Agent {
        if body
            .agent_id
            .as_deref()
            .is_some_and(|id| id != body.owner_id)
        {
            return bad_request("an agent main thread must use its owning bot");
        }
        if let Err(response) =
            primary_bot::validate_agent_selection(&state, &caller, &body.owner_id).await
        {
            return response;
        }
    }
    if let Some(project_id) = body.project_id.as_deref().filter(|p| !p.trim().is_empty()) {
        if let Err(error) = validate_opaque_id(project_id) {
            return bad_request(error.to_string());
        }
    }
    match state
        .conversations
        .ensure_main_thread(
            body.project_id.as_deref(),
            kind,
            &body.owner_id,
            body.agent_id.as_deref(),
            body.title.as_deref(),
            main_thread_tenancy(&caller, kind, body.project_id.as_deref()),
        )
        .await
    {
        Ok(id) => {
            if let Err(response) = require_read(&state, &caller, &id).await {
                return response;
            }
            Json(json!({ "conversation_id": id })).into_response()
        }
        Err(error) => internal(error),
    }
}

async fn list_project_threads(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(project_id): Path<String>,
) -> Response {
    if let Err(error) = validate_opaque_id(&project_id) {
        return bad_request(error.to_string());
    }
    match state.conversations.list_project_threads(&project_id).await {
        Ok(rows) => {
            Json(json!({ "threads": visible(&state, &caller, rows).await })).into_response()
        }
        Err(error) => internal(error),
    }
}

#[cfg(test)]
#[path = "hierarchy_runtime_test.rs"]
mod hierarchy_runtime_test;
