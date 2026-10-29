//! Principal-scoped primary bot: the caller's normal conversational entrypoint.
//!
//! The selection is keyed by the server-verified principal (a signed-in user, or
//! the node operator for trusted node credentials) and never by a submitted id.
//! Model lanes, scope defaults and project coordinators keep their own owners;
//! choosing a primary bot never retargets an existing conversation. Mounted by
//! the hierarchy router ([`super::routes`]).

use super::primary_bot_store::{self, MAX_REVISION};
use crate::identity_verify::{permissions, VerifiedCaller};
use crate::server::ServerState;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Extension, Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

/// The user identity header a desktop, CLI or mobile client attaches.
const USER_JWT_HEADER: &str = "x-ryu-user-jwt";

#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectionInput {
    /// An installed bot id, or `null` to clear back to the inherited default.
    #[serde(deserialize_with = "required_nullable_agent")]
    #[schema(required = true)]
    pub agent_id: Option<String>,
    /// The revision from the latest readback (compare-and-set).
    #[schema(maximum = 9_007_199_254_740_991u64)]
    pub expected_revision: u64,
}

/// Makes `agentId` required while still accepting an explicit `null`.
fn required_nullable_agent<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum SelectionSource {
    Selected,
    Default,
}

#[derive(Debug, Serialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    /// The caller's configured bot, kept even while it is unavailable.
    #[schema(required = true)]
    pub agent_id: Option<String>,
    /// The bot an entrypoint opens now: the configured one, or the default.
    #[schema(required = true)]
    pub effective_agent_id: Option<String>,
    #[schema(maximum = 9_007_199_254_740_991u64)]
    pub revision: u64,
    pub source: SelectionSource,
    /// Why the configured (or default) bot cannot be used, with a recovery step.
    #[schema(required = true)]
    pub unavailable_reason: Option<String>,
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (status, Json(json!({ "code": code, "error": message }))).into_response()
}

fn internal(err: impl std::fmt::Display) -> Response {
    tracing::error!(error = %err, "primary bot selection failed");
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "primary_bot_store_failed",
        "Primary bot could not be saved or loaded. Retry the operation.",
    )
}

fn principal(caller: &Option<VerifiedCaller>) -> String {
    caller.as_ref().map_or_else(
        || "node-operator".to_owned(),
        |c| format!("user:{}", c.user_id),
    )
}

pub fn routes() -> Router<ServerState> {
    Router::new().route("/api/primary-bot", get(get_selection).put(set_selection))
}

/// A supplied user identity must never silently degrade to the node-operator
/// scope. An absent header keeps the operator contract; a present header that
/// fails verification (expired, bad signature, malformed) is refused so the
/// client refreshes the account and retries in the user's own scope.
///
/// The admission layer already resolved the header into `caller` (a verified
/// user JWT, or a managed node delegation carried in the same header), so this
/// only refuses a present header that resolved to no caller at all.
pub(crate) fn require_valid_identity_header(
    headers: &HeaderMap,
    caller: &Option<VerifiedCaller>,
) -> Result<(), Response> {
    if caller.is_some() || !headers.contains_key(USER_JWT_HEADER) {
        return Ok(());
    }
    Err(error(
        StatusCode::UNAUTHORIZED,
        "user_identity_invalid",
        "Your signed-in session could not be verified. Sign in again, then retry.",
    ))
}

/// The exact-resource authorization and availability gate every surface uses
/// before a bot can become a primary bot or a bot main thread.
pub async fn validate_agent_selection(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    id: &str,
) -> Result<(), Response> {
    if id.trim() != id || id.is_empty() || id.len() > 200 || id.chars().any(char::is_control) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_agent_id",
            "Use a non-empty installed bot ID (at most 200 characters).",
        ));
    }
    if !can_run(state, caller, id).await {
        return Err(error(
            StatusCode::FORBIDDEN,
            "primary_bot_forbidden",
            "You do not have permission to run this bot. Choose an authorized bot.",
        ));
    }
    if unavailable_reason(state, id).await?.is_some() {
        return Err(error(
            StatusCode::CONFLICT,
            "primary_bot_unavailable",
            "This bot is deleted, disabled, or unavailable. Install or enable it, or choose another bot.",
        ));
    }
    Ok(())
}

async fn can_run(state: &ServerState, caller: &Option<VerifiedCaller>, id: &str) -> bool {
    crate::server::enforce_permission_on(
        state,
        caller,
        permissions::AGENT_RUN,
        crate::acl::KIND_AGENT,
        id,
    )
    .await
    .is_ok()
}

async fn unavailable_reason(state: &ServerState, id: &str) -> Result<Option<String>, Response> {
    if !crate::fleet::is_agent_available(id) {
        return Ok(Some(
            "Bot is unavailable on this node. Choose another bot or restore its runtime."
                .to_owned(),
        ));
    }
    let agent = state.agent_store.get(id).await.map_err(internal)?;
    if agent.as_ref().is_some_and(|agent| agent.built_in) && id != "ryu" {
        let installed = state.agent_store.installed_ids().await.map_err(internal)?;
        if !installed.contains(id) {
            return Ok(Some(
                "Bot has been removed from the installed set. Install it or choose another bot."
                    .to_owned(),
            ));
        }
    }
    if state
        .agents
        .list_infos()
        .iter()
        .any(|info| info.id == id && info.installed == Some(false))
    {
        return Ok(Some(
            "Bot runtime is unavailable. Install its runtime or choose another bot.".to_owned(),
        ));
    }
    Ok(match agent {
        None => {
            Some("Bot is no longer installed. Install it again or choose another bot.".to_owned())
        }
        Some(agent) if agent.lifecycle_status == crate::agents::AgentLifecycleStatus::Draft => {
            Some("Bot is in draft mode. Activate it or choose another bot.".to_owned())
        }
        Some(_) => None,
    })
}

async fn require_access(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
) -> Result<(), Response> {
    crate::server::enforce_permission(state, caller, permissions::AGENT_VIEW)
        .await
        .map_err(|_| {
            error(
                StatusCode::FORBIDDEN,
                "primary_bot_forbidden",
                "A verified user with bot access is required on this node.",
            )
        })
}

/// The bot the existing chat-default resolver would pick for this caller.
async fn default_agent(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
) -> Result<Option<String>, Response> {
    let lane = crate::agent_selection::chat_default_selection().agent_id;
    // A model-only lane does not select an agent; keep the agent-consuming
    // fallback to the flagship without changing its model.
    let default = if lane.trim().is_empty() {
        crate::agent_selection::builtin_default_selection().agent_id
    } else {
        lane
    };
    if default.is_empty() || unavailable_reason(state, &default).await?.is_some() {
        return Ok(None);
    }
    Ok(can_run(state, caller, &default).await.then_some(default))
}

/// The caller's configured and effective selection.
pub async fn read(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
) -> Result<Selection, Response> {
    require_access(state, caller).await?;
    let store = primary_bot_store::current().map_err(internal)?;
    let (agent_id, revision) = store.read(&principal(caller)).await.map_err(internal)?;
    let mut reason = None;
    let mut effective = None;
    if let Some(id) = agent_id.as_deref() {
        reason = unavailable_reason(state, id).await?;
        if reason.is_none() && can_run(state, caller, id).await {
            effective = Some(id.to_owned());
        } else if reason.is_none() {
            reason = Some(
                "You can no longer run the selected bot. Choose an authorized bot.".to_owned(),
            );
        }
    }
    let source = if effective.is_some() {
        SelectionSource::Selected
    } else {
        SelectionSource::Default
    };
    if effective.is_none() {
        effective = default_agent(state, caller).await?;
        if effective.is_none() && reason.is_none() {
            reason = Some(
                "The default bot is unavailable. Choose an installed, authorized primary bot."
                    .to_owned(),
            );
        }
    }
    Ok(Selection {
        agent_id,
        effective_agent_id: effective,
        revision,
        source,
        unavailable_reason: reason,
    })
}

/// Validate and compare-and-set the caller's selection, then read it back.
pub async fn mutate(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    input: SelectionInput,
) -> Result<Selection, Response> {
    require_access(state, caller).await?;
    if input.expected_revision > MAX_REVISION {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "invalid_primary_bot_selection",
            "expectedRevision is out of range. Reload the current selection and retry.",
        ));
    }
    if let Some(id) = input.agent_id.as_deref() {
        validate_agent_selection(state, caller, id).await?;
    }
    let store = primary_bot_store::current().map_err(internal)?;
    let saved = store
        .compare_and_set(
            &principal(caller),
            input.agent_id.as_deref(),
            input.expected_revision,
        )
        .await
        .map_err(internal)?;
    if !saved {
        return Err(error(
            StatusCode::CONFLICT,
            "primary_bot_revision_conflict",
            "Primary bot changed elsewhere. Reload the current selection and retry with its revision.",
        ));
    }
    read(state, caller).await
}

#[utoipa::path(get, path = "/api/primary-bot", tag = "Agents",
    summary = "Read the caller's primary conversational bot",
    description = "Scope comes from the verified user identity; trusted node credentials without a user identity use the node operator scope, and a supplied but invalid user identity is refused with 401. No user or project ids are accepted. Callers without a stored choice inherit the current chat default at revision 0. A configured bot that became unavailable is kept and the readback explains the fallback. Never changes conversations or model defaults.",
    responses((status = 200, description = "Configured and effective selection", body = Selection), (status = 401, description = "Supplied user identity could not be verified"), (status = 403, description = "Caller lacks bot access"), (status = 500, description = "Store unavailable")))]
pub(super) async fn get_selection(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = require_valid_identity_header(&headers, &caller) {
        return response;
    }
    match read(&state, &caller).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[utoipa::path(put, path = "/api/primary-bot", tag = "Agents",
    summary = "Choose or clear the caller's primary conversational bot",
    description = "Requires bot access and agent.run on the target bot. agentId null clears back to the inherited chat default. expectedRevision is a mandatory compare-and-set: a stale write returns primary_bot_revision_conflict and needs a fresh read. Scope is derived by the server; project coordinators stay owned by the Projects app. No existing conversation is retargeted.",
    request_body = SelectionInput,
    responses((status = 200, description = "Persisted selection readback", body = Selection), (status = 400, description = "Invalid bot id or malformed JSON"), (status = 401, description = "Supplied user identity could not be verified"), (status = 403, description = "Caller or bot unauthorized"), (status = 409, description = "Stale revision or unavailable bot"), (status = 422, description = "Invalid selection input"), (status = 500, description = "Store unavailable")))]
pub(super) async fn set_selection(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    headers: HeaderMap,
    input: Result<Json<SelectionInput>, axum::extract::rejection::JsonRejection>,
) -> Response {
    if let Err(response) = require_valid_identity_header(&headers, &caller) {
        return response;
    }
    let input = match input {
        Ok(Json(input)) => input,
        Err(rejection) => {
            return error(
                rejection.status(),
                "invalid_primary_bot_selection",
                "Provide agentId (an installed bot ID or null) and expectedRevision (a nonnegative integer). User and project scopes cannot be supplied.",
            );
        }
    };
    match mutate(&state, &caller, input).await {
        Ok(value) => Json(value).into_response(),
        Err(response) => response,
    }
}

#[cfg(test)]
#[path = "primary_bot_tests.rs"]
mod tests;
