//! Sidecar → Core host callbacks for the out-of-process `ryu-recipes` app.
//!
//! Recipes' stateless CRUD surface (list/get/save/delete) runs fully in the
//! standalone `ryu-recipes` sidecar (pure `ghost-core` `RecipeStore` reads/writes
//! against the shared `~/.ghost/recipes/` store). Its two LIVE-GHOST paths cannot:
//! - **replay** (`run`) needs Core's shared MCP registry to call `ghost__ghost_run`;
//! - the **recording session** (`record_start`..`record_stop`) holds a dedicated
//!   ghost recorder subprocess (`McpSession`) across SEPARATE HTTP calls — that
//!   session lives in [`CoreRecipesHost`]'s process-global slot, not in the sidecar
//!   and not spanning any single request.
//!
//! Both are kernel machinery (see [`crate::recipes_host`]). The sidecar therefore
//! proxies each of those calls BACK to Core here; Core executes them against the
//! live host and returns the RAW trait-level result. The `ryu-recipes` crate
//! wrapper (`run`/`record_*`) then shapes that raw result into the final HTTP
//! response exactly as the in-process path does — so each endpoint here mirrors ONE
//! [`RecipesHost`] trait method, never the crate wrapper (that would double-wrap).
//!
//! Auth mirrors `monitors_client`/`meetings_client`: [`authenticate_sidecar`]
//! (minted `RYU_EXT_TOKEN` bearer + enabled check) plus an assertion the caller IS
//! the Recipes app. No `host_api` grant block is required (same as monitors).

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

use ryu_recipes::RecipesHost;

use crate::plugins::builtins::RECIPES_PLUGIN_ID;
use crate::recipes_host::CoreRecipesHost;
use crate::server::ServerState;
use crate::sidecar::ext_proxy::authenticate_sidecar;

/// Shared front half of every `/api/host/recipes/*` handler: authenticate the
/// sidecar callback and assert it IS the Recipes app. Returns the error `Response`
/// to short-circuit on failure.
async fn authorize(state: &ServerState, headers: &HeaderMap) -> Result<(), Response> {
    let plugin_id = match authenticate_sidecar(state, headers).await {
        Ok((id, _grants)) => id,
        Err((status, msg)) => {
            return Err((status, Json(json!({ "error": msg }))).into_response());
        }
    };
    if plugin_id != RECIPES_PLUGIN_ID {
        return Err((
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "not the recipes app" })),
        )
            .into_response());
    }
    Ok(())
}

/// `POST /api/host/recipes/run` — replay a recipe through the live Ghost MCP
/// registry. Body `{ recipe, params }`; returns the RAW ghost MCP `tools/call`
/// envelope (the sidecar's `run()` wrapper unwraps it with `extract_mcp_json`).
pub(crate) async fn host_recipes_run(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    let recipe = body.get("recipe").and_then(Value::as_str).unwrap_or("");
    if recipe.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing recipe" })),
        )
            .into_response();
    }
    let params = body.get("params").cloned().unwrap_or(Value::Null);
    match CoreRecipesHost.call_ghost_run(recipe, params).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/recipes/record-start` — spawn the ghost recorder into Core's
/// process-global slot. Body `{ task }`; returns the raw [`ryu_recipes::RecorderStarted`].
pub(crate) async fn host_recipes_record_start(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    let task = body.get("task").and_then(Value::as_str).unwrap_or("");
    match CoreRecipesHost.recorder_start(task).await {
        Ok(started) => Json(started).into_response(),
        Err(e) => (
            StatusCode::CONFLICT,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/recipes/record-status` — poll Core's held recorder. Returns the
/// raw `Option<`[`ryu_recipes::RecorderStatus`]`>` (JSON `null` when idle).
pub(crate) async fn host_recipes_record_status(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    match CoreRecipesHost.recorder_status().await {
        Ok(status) => Json(status).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/host/recipes/record-stop` — stop and tear down Core's held recorder.
/// Returns the raw [`ryu_recipes::RecorderStopped`].
pub(crate) async fn host_recipes_record_stop(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&state, &headers).await {
        return resp;
    }
    match CoreRecipesHost.recorder_stop().await {
        Ok(stopped) => Json(stopped).into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": e.to_string() })),
        )
            .into_response(),
    }
}
