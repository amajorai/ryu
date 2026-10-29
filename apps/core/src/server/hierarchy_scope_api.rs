//! Scope defaults, scope guidance and project-memory rekey routes of the
//! hierarchy REST surface. Split from [`super`] so each file stays focused; the
//! router in [`super::routes`] mounts these handlers unchanged.

use axum::{
    extract::{Path, Query, State},
    response::{IntoResponse, Response},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::json;

use super::{bad_request, internal, Caller};
use crate::identity_verify::{permissions, VerifiedCaller};
use crate::server::conversations::{
    is_valid_guidance_scope, is_valid_scope, resolve_cascade, validate_opaque_id, CascadeLevels,
    DefaultsRole, ScopeDefault, ScopeDefaultInput, ScopeGuidance, ScopeGuidanceInput, GLOBAL_SCOPE,
};
use crate::server::{json_error, ServerState};

pub(super) async fn list_scope_defaults(State(state): State<ServerState>) -> Response {
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

pub(super) async fn write_scope_default(
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
    if let Err(status) =
        crate::server::enforce_permission(state, caller, scope_permission(scope)).await
    {
        return json_error(status, "not allowed to change these defaults".to_owned());
    }
    match state.conversations.set_scope_default(scope, value).await {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(error) => internal(error),
    }
}

pub(super) async fn set_scope_default(
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

pub(super) async fn clear_scope_default(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(scope): Path<String>,
) -> Response {
    write_scope_default(&state, &caller, &scope, ScopeDefault::default()).await
}

pub(super) async fn list_scope_guidance(State(state): State<ServerState>) -> Response {
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

pub(super) async fn get_scope_guidance(
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
pub(super) async fn write_scope_guidance(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    scope: &str,
    value: ScopeGuidance,
) -> Response {
    if !is_valid_guidance_scope(scope) {
        return bad_request("scope must be project:<id>, agent:<id>, or project:<id>/agent:<id>");
    }
    if let Err(status) =
        crate::server::enforce_permission(state, caller, scope_permission(scope)).await
    {
        return json_error(status, "not allowed to change this guidance".to_owned());
    }
    match state.conversations.set_scope_guidance(scope, value).await {
        Ok(changed) => Json(json!({ "ok": true, "promptChanged": changed })).into_response(),
        Err(error) => bad_request(error.to_string()),
    }
}

pub(super) async fn set_scope_guidance(
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

pub(super) async fn clear_scope_guidance(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Path(scope): Path<String>,
) -> Response {
    write_scope_guidance(&state, &caller, &scope, ScopeGuidance::default()).await
}

#[derive(Deserialize)]
pub(super) struct EffectiveQuery {
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
pub(super) async fn effective_scope_defaults(
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
pub(super) struct RekeyBody {
    /// The legacy Project memory scope id (a working-folder path).
    from_scope_id: String,
    /// The project id it now belongs to.
    to_project_id: String,
}

/// Move Project-scoped memory from a legacy folder-derived scope id onto a
/// project id. Used once when the Projects app migrates a desktop-local folder
/// project into a node project, so the bots keep remembering what they learned.
pub(super) async fn rekey_project_memory(
    State(state): State<ServerState>,
    Extension(caller): Caller,
    Json(body): Json<RekeyBody>,
) -> Response {
    if let Err(status) =
        crate::server::enforce_permission(&state, &caller, permissions::PROJECTS_MANAGE).await
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
                crate::server::index_memory_entry(&state, &updated).await;
                moved += 1;
            }
            Ok(None) => {}
            Err(error) => return internal(error),
        }
    }
    Json(json!({ "moved": moved })).into_response()
}
