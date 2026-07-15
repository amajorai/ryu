//! HTTP API for ghost recipes (`/api/recipes/*`).
//!
//! Surfaces the record / list / show / run / delete flow that gives Ryu's
//! workflow system ghost-os parity. Stateless ops hit the on-disk recipe store;
//! replay and the recording session go through the live ghost engine. See
//! [`crate::recipes`] for the transport split and rationale.

use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;

/// Map an `anyhow::Error` to a 500 JSON body. Recipe failures are operational
/// (ghost not installed, recipe not found, malformed JSON), not request-shape
/// errors, so a uniform 500 with the message is the right surface.
fn err(status: StatusCode, e: impl std::fmt::Display) -> (StatusCode, Json<Value>) {
    (status, Json(json!({ "error": e.to_string() })))
}

/// `GET /api/recipes` — list installed recipes (summary form).
#[utoipa::path(
    get,
    path = "/api/recipes",
    tag = "Recipes",
    summary = "list installed recipes (summary form).",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn list_recipes(State(_state): State<ServerState>) -> (StatusCode, Json<Value>) {
    match crate::recipes::list() {
        Ok(recipes) => (StatusCode::OK, Json(json!({ "recipes": recipes }))),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// `GET /api/recipes/:name` — one recipe's full definition.
#[utoipa::path(
    get,
    path = "/api/recipes/{name}",
    tag = "Recipes",
    summary = "one recipe's full definition.",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn get_recipe(
    State(_state): State<ServerState>,
    Path(name): Path<String>,
) -> (StatusCode, Json<Value>) {
    match crate::recipes::get(&name) {
        Ok(recipe) => (StatusCode::OK, Json(json!({ "recipe": recipe }))),
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

/// Body for `POST /api/recipes`: a full recipe JSON document (ghost-os schema).
#[derive(Debug, Deserialize)]
pub struct SaveRecipeBody {
    /// The recipe document. Accepted either as a JSON object (the recipe itself)
    /// or as a `{ "recipe_json": "<stringified>" }` envelope — both round-trip
    /// through the store's validator.
    #[serde(default)]
    pub recipe: Option<Value>,
    #[serde(default)]
    pub recipe_json: Option<String>,
}

/// `POST /api/recipes` — install (create or overwrite) a recipe.
#[utoipa::path(
    post,
    path = "/api/recipes",
    tag = "Recipes",
    summary = "install (create or overwrite) a recipe.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn save_recipe(
    State(_state): State<ServerState>,
    Json(body): Json<SaveRecipeBody>,
) -> (StatusCode, Json<Value>) {
    let json_str = match (body.recipe, body.recipe_json) {
        (Some(v), _) => v.to_string(),
        (None, Some(s)) => s,
        (None, None) => {
            return err(
                StatusCode::BAD_REQUEST,
                "provide `recipe` (object) or `recipe_json` (string)",
            )
        }
    };
    match crate::recipes::save(&json_str) {
        Ok(recipe) => (
            StatusCode::OK,
            Json(json!({ "saved": true, "name": recipe.name, "recipe": recipe })),
        ),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}

/// `DELETE /api/recipes/:name` — remove a recipe.
#[utoipa::path(
    delete,
    path = "/api/recipes/{name}",
    tag = "Recipes",
    summary = "remove a recipe.",
    params(("name" = String, Path)),
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn delete_recipe(
    State(_state): State<ServerState>,
    Path(name): Path<String>,
) -> (StatusCode, Json<Value>) {
    match crate::recipes::delete(&name) {
        Ok(()) => (
            StatusCode::OK,
            Json(json!({ "deleted": true, "name": name })),
        ),
        Err(e) => err(StatusCode::NOT_FOUND, e),
    }
}

/// Body for `POST /api/recipes/:name/run`: the parameter substitutions.
#[derive(Debug, Default, Deserialize)]
pub struct RunRecipeBody {
    #[serde(default)]
    pub params: Value,
}

/// `POST /api/recipes/:name/run` — replay a recipe against native apps.
#[utoipa::path(
    post,
    path = "/api/recipes/{name}/run",
    tag = "Recipes",
    summary = "replay a recipe against native apps.",
    params(("name" = String, Path)),
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn run_recipe(
    State(_state): State<ServerState>,
    Path(name): Path<String>,
    body: Option<Json<RunRecipeBody>>,
) -> (StatusCode, Json<Value>) {
    let params = body.map(|b| b.0.params).unwrap_or(Value::Null);
    match crate::recipes::run(&name, params).await {
        Ok(result) => (StatusCode::OK, Json(json!({ "result": result }))),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// Body for `POST /api/recipes/record/start`: the task being demonstrated.
#[derive(Debug, Deserialize)]
pub struct RecordStartBody {
    #[serde(default)]
    pub task: String,
}

/// `POST /api/recipes/record/start` — begin observing user input.
#[utoipa::path(
    post,
    path = "/api/recipes/record/start",
    tag = "Recipes",
    summary = "begin observing user input.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn record_start(
    State(_state): State<ServerState>,
    body: Option<Json<RecordStartBody>>,
) -> (StatusCode, Json<Value>) {
    let task = body.map(|b| b.0.task).unwrap_or_default();
    match crate::recipes::record_start(&task).await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => err(StatusCode::CONFLICT, e),
    }
}

/// `GET /api/recipes/record/status` — poll the active recording.
#[utoipa::path(
    get,
    path = "/api/recipes/record/status",
    tag = "Recipes",
    summary = "poll the active recording.",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn record_status(State(_state): State<ServerState>) -> (StatusCode, Json<Value>) {
    match crate::recipes::record_status().await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// `POST /api/recipes/record/stop` — stop recording and return captured events.
#[utoipa::path(
    post,
    path = "/api/recipes/record/stop",
    tag = "Recipes",
    summary = "stop recording and return captured events.",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub async fn record_stop(State(_state): State<ServerState>) -> (StatusCode, Json<Value>) {
    match crate::recipes::record_stop().await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}
