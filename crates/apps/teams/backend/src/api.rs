//! HTTP API for agent teams (`/api/teams/*`): CRUD over team config records plus
//! incremental member add/remove (the desktop drag-an-agent-into-a-team gesture).
//!
//! A team is a persisted, ordered collection of agent ids plus a coordination
//! strategy; this surface owns only the persistence. The `@team` chat orchestration
//! that *interprets* the strategy (`route_team_chat_stream` / `run_team_reply_text`)
//! stays in Core's session loop — it is welded to the streaming chat path, the
//! agent registry, and conversation persistence, so it consumes this crate's
//! [`TeamRecord`]/[`Coordination`] types rather than living here.
//!
//! The router is built with its own state ([`TeamsCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. The routes are declared relative
//! to `/api/teams` (Core nests this service at that prefix behind the Teams-App
//! gate), while the OpenAPI annotations keep the full external paths.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{delete, get, post},
    Json, Router,
};
use serde_json::json;

use crate::store::{CreateTeam, TeamStore, UpdateTeam};

/// Router state for the teams HTTP surface: the [`TeamStore`] (cheap to clone,
/// `Arc` inside). The same store instance is shared with Core's `@team` chat
/// orchestration and the `agent_builder` tool via `ServerState.teams`.
#[derive(Clone)]
pub struct TeamsCtx {
    pub store: TeamStore,
}

impl TeamsCtx {
    pub fn new(store: TeamStore) -> Self {
        Self { store }
    }
}

/// Build the `/api/teams/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/teams` behind the App gate.
pub fn routes(ctx: TeamsCtx) -> Router<()> {
    Router::new()
        .route("/", get(list_teams).post(create_team))
        .route(
            "/:id",
            get(get_team).patch(update_team).delete(delete_team),
        )
        .route("/:id/members", post(add_team_member))
        .route("/:id/members/:agent_id", delete(remove_team_member))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the teams surface, merged into Core's spec when
/// the `teams` feature is enabled.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <TeamsApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    list_teams,
    create_team,
    get_team,
    update_team,
    delete_team,
    add_team_member,
    remove_team_member,
))]
struct TeamsApiDoc;

#[utoipa::path(
    get,
    path = "/api/teams",
    tag = "Teams",
    summary = "List agent teams",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn list_teams(State(ctx): State<TeamsCtx>) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.store.list().await {
        Ok(teams) => (StatusCode::OK, Json(json!({ "teams": teams }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    post,
    path = "/api/teams",
    tag = "Teams",
    summary = "Create a team",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn create_team(
    State(ctx): State<TeamsCtx>,
    Json(input): Json<CreateTeam>,
) -> (StatusCode, Json<serde_json::Value>) {
    if input.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "team name is required" })),
        );
    }
    match ctx.store.create(input).await {
        Ok(team) => (StatusCode::CREATED, Json(json!({ "team": team }))),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    get,
    path = "/api/teams/{id}",
    tag = "Teams",
    summary = "Get a team by id",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn get_team(
    State(ctx): State<TeamsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.store.get(&id).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    patch,
    path = "/api/teams/{id}",
    tag = "Teams",
    summary = "Update a team",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn update_team(
    State(ctx): State<TeamsCtx>,
    Path(id): Path<String>,
    Json(patch): Json<UpdateTeam>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.store.update(&id, patch).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    delete,
    path = "/api/teams/{id}",
    tag = "Teams",
    summary = "Delete a team",
    params(("id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn delete_team(
    State(ctx): State<TeamsCtx>,
    Path(id): Path<String>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.store.delete(&id).await {
        Ok(true) => (StatusCode::OK, Json(json!({ "success": true }))),
        Ok(false) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

/// Body for `POST /api/teams/:id/members` — add one agent to the team. Used by
/// the desktop's drag-an-agent-into-a-team gesture.
#[derive(serde::Deserialize)]
struct AddTeamMemberRequest {
    agent_id: String,
}

#[utoipa::path(
    post,
    path = "/api/teams/{id}/members",
    tag = "Teams",
    summary = "Add a member agent to a team",
    params(("id" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn add_team_member(
    State(ctx): State<TeamsCtx>,
    Path(id): Path<String>,
    Json(body): Json<AddTeamMemberRequest>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.store.add_member(&id, &body.agent_id).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}

#[utoipa::path(
    delete,
    path = "/api/teams/{id}/members/{agent_id}",
    tag = "Teams",
    summary = "Remove a member from a team",
    params(("id" = String, Path), ("agent_id" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
async fn remove_team_member(
    State(ctx): State<TeamsCtx>,
    Path((id, agent_id)): Path<(String, String)>,
) -> (StatusCode, Json<serde_json::Value>) {
    match ctx.store.remove_member(&id, &agent_id).await {
        Ok(Some(team)) => (StatusCode::OK, Json(json!({ "team": team }))),
        Ok(None) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("team '{id}' not found") })),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        ),
    }
}
