//! ACP agent config, accounts, sessions, updates and capability overrides: `acp_account_switch` through `agent_npm_package`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/agents/:id/accounts/switch` — switch an ACP agent's active
/// account. Managed Pi accounts live in a provider scope (switch = materialize
/// that credential); every other agent's accounts are opaque, so switching means
/// re-signing-in — the response flags `reauthenticate` for the UI to drive it.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/accounts/switch",
    tag = "Agents",
    summary = "Switch an ACP agent's active account",
    params(("id" = String, Path, description = "Agent id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn acp_account_switch(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(body): Json<AccountAction>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "switched": false, "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::pi_config::native_accounts::for_spawn(&spawn_cmd) {
        Ok(Some(native)) => {
            return match native.select(&body.account_id) {
                Ok(()) => Json(json!({"switched":true,"verified":true})).into_response(),
                Err(error) => (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"switched":false,"error":error.to_string()})),
                )
                    .into_response(),
            };
        }
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":error.to_string()})),
            )
                .into_response();
        }
        Ok(None) => {}
    }
    match crate::pi_config::switch_acp_account(
        &spawn_cmd,
        &body.account_id,
        body.provider.as_deref(),
    ) {
        Ok(true) if !spawn_cmd.contains("PI_CODING_AGENT_DIR") => {
            // The exact scoped record exists, but native credentials have not
            // changed. A new vendor login is required before reporting success.
            Json(serde_json::json!({ "switched": false, "reauthenticate": true })).into_response()
        }
        Ok(true) => Json(serde_json::json!({ "switched": true })).into_response(),
        Ok(false) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "switched": false, "error": "no such account" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "switched": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `POST /api/agents/:id/accounts/remove` — remove an ACP agent account.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/accounts/remove",
    tag = "Agents",
    summary = "Remove an ACP agent account",
    params(("id" = String, Path, description = "Agent id")),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn acp_account_remove(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(body): Json<AccountAction>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "removed": false, "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::pi_config::native_accounts::for_spawn(&spawn_cmd) {
        Ok(Some(native)) => {
            native_accounts::cancel_account(&agent_id, &body.account_id).await;
            return match native.remove(&body.account_id) {
                Ok(removed) => {
                    Json(json!({"removed":removed,"vendorLogoutConfirmed":false})).into_response()
                }
                Err(error) => (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":error.to_string()})),
                )
                    .into_response(),
            };
        }
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":error.to_string()})),
            )
                .into_response();
        }
        Ok(None) => {}
    }
    match crate::pi_config::remove_acp_account(&spawn_cmd, &body.account_id) {
        Ok(true) => Json(serde_json::json!({ "removed": true })).into_response(),
        Ok(false) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "removed": false, "error": "no such account" })),
        )
            .into_response(),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "removed": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `GET /api/agents/:id/sessions` — the sessions an ACP agent is tracking (ACP
/// `session/list`). Best-effort: agents that don't implement it (the flagship pi)
/// return `{ sessions: [] }`.
#[utoipa::path(
    get,
    path = "/api/agents/{id}/sessions",
    tag = "Agents",
    summary = "List an ACP agent's sessions",
    params(("id" = String, Path, description = "Agent id")),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent view permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn list_acp_sessions_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_VIEW,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return Json(serde_json::json!({ "sessions": [] })).into_response();
    };
    match crate::sidecar::adapters::acp::list_acp_sessions(spawn_cmd).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "sessions": [], "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// `DELETE /api/agents/:id/sessions/:sid` — delete an ACP agent session (ACP
/// `session/close`).
#[utoipa::path(
    delete,
    path = "/api/agents/{id}/sessions/{sid}",
    tag = "Agents",
    summary = "Delete an ACP agent session",
    params(
        ("id" = String, Path, description = "Agent id"),
        ("sid" = String, Path, description = "Session id")
    ),
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn delete_acp_session_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent_id, sid)): Path<(String, String)>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    match crate::sidecar::adapters::acp::close_acp_session(spawn_cmd, sid).await {
        Ok(true) => Json(serde_json::json!({ "deleted": true })).into_response(),
        // The agent connected fine and simply does not implement `session/close`
        // (pi-acp, qwen-code and factory-droid advertise no `close` capability).
        // A 200 saying so, not the 502 this used to return — nothing failed, and
        // a transport error here would mean something very different.
        Ok(false) => Json(serde_json::json!({
            "deleted": false,
            "unsupported": true,
            "error": "This agent does not support deleting sessions.",
        }))
        .into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "deleted": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Optional body for `POST /api/agents/:id/sessions/:sid/load`.
#[derive(serde::Deserialize, Default)]
pub(in crate::server) struct LoadSessionBody {
    /// Workspace the session ran in. Falls back to the server's cwd when absent.
    #[serde(default)]
    pub(in crate::server) cwd: Option<String>,
}

/// `POST /api/agents/:id/sessions/:sid/load` — warm-resume an ACP agent's own
/// prior session (ACP `session/load`), restoring its context. Returns
/// `{ supported, modes, models, configOptions }`; `supported: false` for agents
/// that don't advertise the `loadSession` capability.
#[utoipa::path(
    post,
    path = "/api/agents/{id}/sessions/{sid}/load",
    tag = "Agents",
    summary = "Resume an ACP agent session (session/load)",
    params(
        ("id" = String, Path, description = "Agent id"),
        ("sid" = String, Path, description = "Session id")
    ),
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "OK", body = serde_json::Value),
        (status = 403, description = "Agent edit permission required", body = serde_json::Value)
    )
)]
pub(in crate::server) async fn load_acp_session_handler(
    State(state): State<ServerState>,
    axum::Extension(caller): axum::Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path((agent_id, sid)): Path<(String, String)>,
    body: Option<Json<LoadSessionBody>>,
) -> axum::response::Response {
    let spawn_cmd = match resolve_acp_spawn_cmd_authorized(
        &state,
        &caller,
        crate::identity_verify::permissions::AGENT_EDIT,
        &agent_id,
    )
    .await
    {
        Ok(spawn_cmd) => spawn_cmd,
        Err(response) => return response,
    };
    let Some(spawn_cmd) = spawn_cmd else {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "not an ACP agent" })),
        )
            .into_response();
    };
    let cwd = body
        .and_then(|b| b.0.cwd)
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_default();
    match crate::sidecar::adapters::acp::load_acp_session(spawn_cmd, sid, cwd).await {
        Ok(value) => Json(value).into_response(),
        Err(e) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "supported": false, "error": e.to_string() })),
        )
            .into_response(),
    }
}

/// Resolve the npm package that backs an agent (for version/update checks). The
/// flagship `ryu` agent's runtime is the managed Pi engine; every other ACP agent
/// self-fetches via `npx -y <pkg>`, so the package is parsed from its spawn cmd.
pub(in crate::server) async fn agent_npm_package(
    state: &ServerState,
    agent_id: &str,
) -> Option<String> {
    if agent_id == "ryu" {
        return Some(crate::sidecar::adapters::acp::PI_ENGINE_NPM.to_owned());
    }
    let spawn_cmd = crate::sidecar::adapters::resolve_acp_spawn_cmd(
        agent_id,
        &state.agents,
        &state.agent_store,
    )
    .await?;
    npx_package_of(&spawn_cmd)
}
