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
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::json;

use super::conversations::{
    is_valid_guidance_scope, is_valid_scope, resolve_cascade, validate_opaque_id, CascadeLevels,
    ConversationSummary, DefaultsRole, OwnerKind, ScopeDefault, ScopeDefaultInput, ScopeGuidance,
    ScopeGuidanceInput, GLOBAL_SCOPE,
};
use super::{json_error, ServerState};
use crate::identity_verify::{permissions, VerifiedCaller};

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
        .route("/api/scope-defaults", get(list_scope_defaults))
        .route(
            "/api/hierarchy/effective-defaults",
            get(effective_scope_defaults),
        )
        .route(
            "/api/scope-defaults/*scope",
            put(set_scope_default).delete(clear_scope_default),
        )
        .route("/api/scope-guidance", get(list_scope_guidance))
        .route(
            "/api/scope-guidance/*scope",
            get(get_scope_guidance)
                .put(set_scope_guidance)
                .delete(clear_scope_guidance),
        )
        .route(
            "/api/hierarchy/memory/rekey-project",
            post(rekey_project_memory),
        )
}

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

async fn find_main_thread(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Query(query): Query<MainThreadQuery>,
) -> Response {
    let kind = match parse_owner(&query.owner_kind, &query.owner_id) {
        Ok(kind) => kind,
        Err(response) => return response,
    };
    match state
        .conversations
        .find_main_thread(query.project_id.as_deref(), kind, &query.owner_id)
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
    Json(body): Json<EnsureMainThreadBody>,
) -> Response {
    let kind = match parse_owner(&body.owner_kind, &body.owner_id) {
        Ok(kind) => kind,
        Err(response) => return response,
    };
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
            super::caller_tenancy(&caller),
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

async fn list_scope_defaults(State(state): State<ServerState>) -> Response {
    match state.conversations.list_scope_defaults().await {
        Ok(rows) => {
            let defaults: serde_json::Map<String, serde_json::Value> = rows
                .into_iter()
                .map(|(scope, value)| (scope, json!(value)))
                .collect();
            Json(json!({ "defaults": defaults })).into_response()
        }
        Err(error) => internal(error),
    }
}

fn scope_permission(scope: &str) -> &'static str {
    // The node-wide default changes every chat's model, like Gateway › Defaults.
    if scope == GLOBAL_SCOPE {
        permissions::GATEWAY_CONFIGURE
    } else if scope.starts_with("agent:") {
        permissions::AGENT_EDIT
    } else {
        permissions::PROJECTS_MANAGE
    }
}

async fn write_scope_default(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    scope: &str,
    value: ScopeDefault,
) -> Response {
    if !is_valid_scope(scope) {
        return bad_request(
            "scope must be global, project:<id>, agent:<id>, or project:<id>/agent:<id>",
        );
    }
    if let Err(status) = super::enforce_permission(state, caller, scope_permission(scope)).await {
        return json_error(status, "not allowed to change these defaults".to_owned());
    }
    match state.conversations.set_scope_default(scope, value).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => internal(error),
    }
}

async fn set_scope_default(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(scope): Path<String>,
    Json(input): Json<ScopeDefaultInput>,
) -> Response {
    // Omitted coordinator fields keep their stored values (see
    // `ScopeDefaultInput`), so an older client never wipes them.
    let stored = match state.conversations.scope_default(&scope).await {
        Ok(stored) => stored.unwrap_or_default(),
        Err(error) => return internal(error),
    };
    write_scope_default(&state, &caller, &scope, input.merged_over(stored)).await
}

async fn clear_scope_default(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(scope): Path<String>,
) -> Response {
    write_scope_default(&state, &caller, &scope, ScopeDefault::default()).await
}

async fn list_scope_guidance(State(state): State<ServerState>) -> Response {
    match state.conversations.list_scope_guidance().await {
        Ok(rows) => {
            let guidance: serde_json::Map<String, serde_json::Value> = rows
                .into_iter()
                .map(|(scope, value)| (scope, json!(value)))
                .collect();
            Json(json!({ "guidance": guidance })).into_response()
        }
        Err(error) => internal(error),
    }
}

async fn get_scope_guidance(
    State(state): State<ServerState>,
    Path(scope): Path<String>,
) -> Response {
    if !is_valid_guidance_scope(&scope) {
        return bad_request("scope must be project:<id>, agent:<id>, or project:<id>/agent:<id>");
    }
    match state.conversations.scope_guidance(&scope).await {
        Ok(value) => {
            Json(json!({ "scope": scope, "guidance": value.unwrap_or_default() })).into_response()
        }
        Err(error) => internal(error),
    }
}

/// Store one scope's guidance. The response's `promptChanged` is true when the
/// stored value actually changed: every thread in the scope then re-sends its
/// whole prompt uncached on its next turn, which the editors warn about.
async fn write_scope_guidance(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    scope: &str,
    value: ScopeGuidance,
) -> Response {
    if !is_valid_guidance_scope(scope) {
        return bad_request("scope must be project:<id>, agent:<id>, or project:<id>/agent:<id>");
    }
    if let Err(status) = super::enforce_permission(state, caller, scope_permission(scope)).await {
        return json_error(status, "not allowed to change this guidance".to_owned());
    }
    match state.conversations.set_scope_guidance(scope, value).await {
        Ok(changed) => Json(json!({ "ok": true, "promptChanged": changed })).into_response(),
        Err(error) => bad_request(error.to_string()),
    }
}

async fn set_scope_guidance(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(scope): Path<String>,
    Json(input): Json<ScopeGuidanceInput>,
) -> Response {
    let stored = match state.conversations.scope_guidance(&scope).await {
        Ok(stored) => stored.unwrap_or_default(),
        Err(error) => return internal(error),
    };
    write_scope_guidance(&state, &caller, &scope, input.merged_over(stored)).await
}

async fn clear_scope_guidance(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(scope): Path<String>,
) -> Response {
    write_scope_guidance(&state, &caller, &scope, ScopeGuidance::default()).await
}

#[derive(Deserialize)]
struct EffectiveQuery {
    project_id: Option<String>,
    agent_id: Option<String>,
    /// The composer's current pin, when the client has one (the session level).
    session_provider: Option<String>,
    session_model: Option<String>,
    session_effort: Option<String>,
    /// `main` for a coordinator thread; anything else resolves the thread
    /// defaults.
    thread_role: Option<String>,
    /// Exclude the session level, to show what "Reset to inherited" would give.
    #[serde(default)]
    inherited_only: bool,
}

/// The effective defaults for `(project, agent)` with where each value comes
/// from — what the pickers render as "inherited from …".
async fn effective_scope_defaults(
    State(state): State<ServerState>,
    Query(query): Query<EffectiveQuery>,
) -> Response {
    let mut levels: CascadeLevels = match state
        .conversations
        .stored_cascade_levels(
            query.project_id.as_deref(),
            query.agent_id.as_deref(),
            DefaultsRole::for_thread_role(query.thread_role.as_deref().unwrap_or_default()),
        )
        .await
    {
        Ok(levels) => levels,
        Err(error) => return internal(error),
    };
    if !query.inherited_only {
        let session = ScopeDefault {
            provider: query.session_provider.unwrap_or_default(),
            model: query.session_model.unwrap_or_default(),
            effort: query.session_effort.unwrap_or_default(),
            ..ScopeDefault::default()
        };
        levels.session = (!session.is_empty()).then_some(session);
    }
    if let Some(agent_id) = query.agent_id.as_deref().filter(|a| !a.trim().is_empty()) {
        if let Ok(Some(record)) = state.agent_store.get(agent_id).await {
            levels.agent_binding_model = record.model;
        }
    }
    let global = crate::agent_selection::chat_default_selection();
    levels.global = Some(ScopeDefault {
        provider: global.provider,
        model: global.model,
        effort: global.effort,
        ..ScopeDefault::default()
    });
    let resolved = resolve_cascade(&levels);
    Json(json!({
        "resolved": resolved,
        "levels": {
            "session": levels.session,
            "project_agent": levels.project_agent,
            "agent": levels.agent,
            "agent_binding_model": levels.agent_binding_model,
            "project": levels.project,
            "settings": levels.settings,
            "global": levels.global,
        },
    }))
    .into_response()
}

#[derive(Deserialize)]
struct RekeyBody {
    /// The legacy Project memory scope id (a working-folder path).
    from_scope_id: String,
    /// The project id it now belongs to.
    to_project_id: String,
}

/// Move Project-scoped memory from a legacy folder-derived scope id onto a
/// project id. Used once when the Projects app migrates a desktop-local folder
/// project into a node project, so the bots keep remembering what they learned.
async fn rekey_project_memory(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Json(body): Json<RekeyBody>,
) -> Response {
    if let Err(status) =
        super::enforce_permission(&state, &caller, permissions::PROJECTS_MANAGE).await
    {
        return json_error(status, "not allowed to migrate project memory".to_owned());
    }
    if let Err(error) = validate_opaque_id(&body.to_project_id) {
        return bad_request(error.to_string());
    }
    let from = body.from_scope_id.trim();
    if from.is_empty() || from == body.to_project_id.trim() {
        return Json(json!({ "moved": 0 })).into_response();
    }
    let entries = match state
        .memory
        .list(&crate::server::memory::MemoryFilter {
            scope: Some(crate::server::memory::MemoryScope::Project),
            scope_id: Some(from.to_owned()),
            ..Default::default()
        })
        .await
    {
        Ok(entries) => entries,
        Err(error) => return internal(error),
    };
    let mut moved = 0_u64;
    for entry in entries {
        let patch = crate::server::memory::MemoryPatch {
            scope_id: Some(Some(body.to_project_id.trim().to_owned())),
            ..Default::default()
        };
        match state.memory.update(&entry.id, patch).await {
            Ok(Some(updated)) => {
                super::index_memory_entry(&state, &updated).await;
                moved += 1;
            }
            Ok(None) => {}
            Err(error) => return internal(error),
        }
    }
    Json(json!({ "moved": moved })).into_response()
}

#[cfg(test)]
#[path = "hierarchy_runtime_test.rs"]
mod hierarchy_runtime_test;
