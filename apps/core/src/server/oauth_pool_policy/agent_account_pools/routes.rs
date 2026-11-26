//! HTTP routes for custom account pools and the pool an agent is limited to.
//! They sit under `/api/pi-config/providers`, where the self API already
//! refuses every agent write, so an agent cannot edit pools or its own pool.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;

use super::model::{Catalog, PoolAccount, PoolError, MAX_POOLS, MAX_POOL_ACCOUNTS};
use super::modes::{Backup, Mode, MAX_BACKUPS};
use super::store::{self, EditError};
use crate::server::preferences::PreferencesStore;
use crate::server::ServerState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreatePool {
    pub name: String,
    #[serde(default)]
    pub accounts: Vec<PoolAccount>,
}

/// A missing field keeps that part of the pool as it is.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdatePool {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub accounts: Option<Vec<PoolAccount>>,
}

/// `{"poolId": null}` clears the agent's pool and Auto. `mode` ("none",
/// "auto", "pool") wins over the bare `poolId` when both are sent; `poolId`
/// counts only for "pool". A missing `backups` keeps the agent's backups.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentPool {
    #[serde(default)]
    pub pool_id: Option<String>,
    #[serde(default)]
    pub mode: Option<Mode>,
    #[serde(default)]
    pub backups: Option<Vec<Backup>>,
}

/// What an agent uses: its mode, its pool (for "pool") and its backups.
fn agent_view(catalog: &Catalog, agent_id: &str) -> serde_json::Value {
    let mode = catalog.mode_of(agent_id);
    json!({
        "agentId": agent_id,
        "mode": mode,
        "poolId": (mode == Mode::Pool).then(|| catalog.agents.get(agent_id)).flatten(),
        "backups": catalog.backups_of(agent_id),
    })
}

fn failure(error: EditError) -> Response {
    let status = match error {
        EditError::Pool(PoolError::NotFound) => StatusCode::NOT_FOUND,
        EditError::Pool(PoolError::LimitReached) => StatusCode::CONFLICT,
        EditError::Pool(PoolError::Invalid(_)) => StatusCode::BAD_REQUEST,
        EditError::Storage => StatusCode::INTERNAL_SERVER_ERROR,
    };
    let message = error.message();
    (status, Json(json!({ "error": message }))).into_response()
}

#[utoipa::path(
    get,
    path = "/api/pi-config/providers/account-pools",
    tag = "Agents",
    summary = "List custom account pools and agent assignments",
    responses((status = 200, description = "Pools, the pool of each agent and the limits", body = serde_json::Value),
        (status = 500, description = "Could not read account pools"))
)]
pub async fn list_account_pools(State(state): State<ServerState>) -> Response {
    list(&state.preferences).await
}

pub(crate) async fn list(preferences: &PreferencesStore) -> Response {
    match store::load(preferences).await {
        Ok(catalog) => Json(json!({
            "pools": catalog.pools,
            "agents": catalog.agents,
            "auto": catalog.auto,
            "backups": catalog.backups,
            "maxPools": MAX_POOLS,
            "maxPoolAccounts": MAX_POOL_ACCOUNTS,
            "maxBackups": MAX_BACKUPS,
        }))
        .into_response(),
        Err(error) => {
            tracing::error!(%error, "could not read account pools");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[utoipa::path(
    post,
    path = "/api/pi-config/providers/account-pools",
    tag = "Agents",
    summary = "Create a custom account pool",
    request_body = serde_json::Value,
    responses((status = 201, description = "Created pool", body = serde_json::Value),
        (status = 400, description = "Invalid name or accounts"),
        (status = 409, description = "Pool limit reached"),
        (status = 500, description = "Could not save account pools"))
)]
pub async fn create_account_pool(
    State(state): State<ServerState>,
    Json(body): Json<CreatePool>,
) -> Response {
    create(&state.preferences, body).await
}

pub(crate) async fn create(preferences: &PreferencesStore, body: CreatePool) -> Response {
    match store::edit(preferences, |catalog| {
        catalog.create(&body.name, body.accounts)
    })
    .await
    {
        Ok((pool, _)) => (StatusCode::CREATED, Json(pool)).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(
    put,
    path = "/api/pi-config/providers/account-pools/{pool_id}",
    tag = "Agents",
    summary = "Rename a custom account pool or set its accounts",
    params(("pool_id" = String, Path, description = "Pool id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved pool", body = serde_json::Value),
        (status = 400, description = "Invalid name or accounts"),
        (status = 404, description = "Pool not found"),
        (status = 500, description = "Could not save account pools"))
)]
pub async fn update_account_pool(
    State(state): State<ServerState>,
    Path(pool_id): Path<String>,
    Json(body): Json<UpdatePool>,
) -> Response {
    update(&state.preferences, &pool_id, body).await
}

pub(crate) async fn update(
    preferences: &PreferencesStore,
    pool_id: &str,
    body: UpdatePool,
) -> Response {
    match store::edit(preferences, |catalog| {
        catalog.update(pool_id, body.name.as_deref(), body.accounts)
    })
    .await
    {
        Ok((pool, _)) => Json(pool).into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(
    delete,
    path = "/api/pi-config/providers/account-pools/{pool_id}",
    tag = "Agents",
    summary = "Delete a custom account pool and clear it from every agent",
    params(("pool_id" = String, Path, description = "Pool id")),
    responses((status = 204, description = "Deleted"),
        (status = 404, description = "Pool not found"),
        (status = 500, description = "Could not save account pools"))
)]
pub async fn delete_account_pool(
    State(state): State<ServerState>,
    Path(pool_id): Path<String>,
) -> Response {
    delete(&state.preferences, &pool_id).await
}

pub(crate) async fn delete(preferences: &PreferencesStore, pool_id: &str) -> Response {
    match store::edit(preferences, |catalog| catalog.delete(pool_id)).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => failure(error),
    }
}

#[utoipa::path(
    get,
    path = "/api/pi-config/providers/account-pools/agents/{agent_id}",
    tag = "Agents",
    summary = "The custom account pool an agent is limited to",
    params(("agent_id" = String, Path, description = "Agent id")),
    responses((status = 200, description = "Pool id, or null when the agent has none", body = serde_json::Value),
        (status = 500, description = "Could not read account pools"))
)]
pub async fn get_agent_account_pool(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
) -> Response {
    agent_pool(&state.preferences, &agent_id).await
}

pub(crate) async fn agent_pool(preferences: &PreferencesStore, agent_id: &str) -> Response {
    match store::load(preferences).await {
        Ok(catalog) => Json(agent_view(&catalog, agent_id)).into_response(),
        Err(error) => {
            tracing::error!(%error, "could not read account pools");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[utoipa::path(
    put,
    path = "/api/pi-config/providers/account-pools/agents/{agent_id}",
    tag = "Agents",
    summary = "Limit an agent to a custom account pool, or clear its pool",
    params(("agent_id" = String, Path, description = "Agent id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved assignment", body = serde_json::Value),
        (status = 400, description = "Invalid agent id"),
        (status = 404, description = "Pool not found"),
        (status = 500, description = "Could not save account pools"))
)]
pub async fn put_agent_account_pool(
    State(state): State<ServerState>,
    Path(agent_id): Path<String>,
    Json(body): Json<AgentPool>,
) -> Response {
    assign(&state.preferences, &agent_id, body).await
}

pub(crate) async fn assign(
    preferences: &PreferencesStore,
    agent_id: &str,
    body: AgentPool,
) -> Response {
    let mode = body.mode.unwrap_or(if body.pool_id.is_some() {
        Mode::Pool
    } else {
        Mode::None
    });
    match store::edit(preferences, |catalog| {
        catalog.set_mode(agent_id, mode, body.pool_id.as_deref())?;
        if let Some(backups) = body.backups {
            catalog.set_backups(agent_id, backups)?;
        }
        Ok(())
    })
    .await
    {
        Ok((_, catalog)) => Json(agent_view(&catalog, agent_id)).into_response(),
        Err(error) => failure(error),
    }
}
