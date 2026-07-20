//! HTTP API for ghost recipes (`/api/recipes/*`).
//!
//! Surfaces the record / list / show / run / delete flow that gives Ryu's
//! workflow system ghost-os parity. Stateless ops hit the on-disk recipe store;
//! replay and the recording session go through the live ghost engine (via the
//! host). See the crate root for the transport split and rationale.
//!
//! The router is built with its own state ([`RecipesCtx`]) inside this crate so it
//! returns a state-less, mergeable `Router<()>`. Routes are declared relative to
//! `/api/recipes` (Core nests this service at that prefix behind the Recipes-App
//! gate), while the OpenAPI annotations keep the full external paths. Static
//! `record/*` segments are registered before `:name` so they match first (Axum
//! would otherwise capture `record` as a recipe name).

use axum::{
    extract::Path,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

/// Router state for the recipes HTTP surface. Empty: the handlers reach the store
/// directly (via `ghost-core`) and the live ghost engine through the process-
/// global [`crate::RecipesHost`], so there is no per-request state to carry. Kept
/// as a named type so the router bakes a concrete state and returns `Router<()>`.
#[derive(Clone, Default)]
pub struct RecipesCtx;

impl RecipesCtx {
    pub fn new() -> Self {
        Self
    }
}

/// Build the `/api/recipes/*` router with its own state baked in, returning a
/// state-less `Router<()>` the host nests at `/api/recipes` behind the App gate.
pub fn routes(ctx: RecipesCtx) -> Router<()> {
    Router::new()
        .route("/record/start", post(record_start))
        .route("/record/status", get(record_status))
        .route("/record/stop", post(record_stop))
        .route("/", get(list_recipes).post(save_recipe))
        .route("/:name/run", post(run_recipe))
        .route("/:name", get(get_recipe).delete(delete_recipe))
        .with_state(ctx)
}

/// The OpenAPI sub-document for the recipes surface, merged into Core's spec when
/// the `recipes` feature is enabled.
pub fn openapi() -> utoipa::openapi::OpenApi {
    <RecipesApiDoc as utoipa::OpenApi>::openapi()
}

#[derive(utoipa::OpenApi)]
#[openapi(paths(
    delete_recipe,
    get_recipe,
    list_recipes,
    record_start,
    record_status,
    record_stop,
    run_recipe,
    save_recipe,
))]
struct RecipesApiDoc;

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
pub async fn list_recipes() -> (StatusCode, Json<Value>) {
    match crate::list() {
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
pub async fn get_recipe(Path(name): Path<String>) -> (StatusCode, Json<Value>) {
    match crate::get(&name) {
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
pub async fn save_recipe(Json(body): Json<SaveRecipeBody>) -> (StatusCode, Json<Value>) {
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
    match crate::save(&json_str) {
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
pub async fn delete_recipe(Path(name): Path<String>) -> (StatusCode, Json<Value>) {
    match crate::delete(&name) {
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
    Path(name): Path<String>,
    body: Option<Json<RunRecipeBody>>,
) -> (StatusCode, Json<Value>) {
    let params = body.map(|b| b.0.params).unwrap_or(Value::Null);
    match crate::run(&name, params).await {
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
pub async fn record_start(body: Option<Json<RecordStartBody>>) -> (StatusCode, Json<Value>) {
    let task = body.map(|b| b.0.task).unwrap_or_default();
    match crate::record_start(&task).await {
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
pub async fn record_status() -> (StatusCode, Json<Value>) {
    match crate::record_status().await {
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
pub async fn record_stop() -> (StatusCode, Json<Value>) {
    match crate::record_stop().await {
        Ok(v) => (StatusCode::OK, Json(v)),
        Err(e) => err(StatusCode::BAD_REQUEST, e),
    }
}
