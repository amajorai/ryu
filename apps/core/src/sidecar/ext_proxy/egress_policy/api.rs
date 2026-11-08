//! `/api/agents/:id/egress-allowlist`: read, replace or remove one agent's
//! egress allowlist.
//!
//! * `GET` answers `{ "agent_id", "allowlist": [..] | null }`; `null` means the
//!   agent is unrestricted. Needs `agent.view` on the agent.
//! * `PUT { "allowlist": [..] }` replaces the list (normalized, at most
//!   [`super::MAX_PATTERNS`] entries) and `DELETE` removes it. Both need
//!   `agent.edit` on the agent, and the agent must exist in the agent store.
//!
//! The route policy for `/api/agents/*` admits `agents:read` for `GET` and
//! `agents:manage` for writes; these handlers then apply the agent's own ACL.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::identity_verify::permissions::{AGENT_EDIT, AGENT_VIEW};
use crate::identity_verify::VerifiedCaller;
use crate::server::ServerState;

/// The route, merged into the agents router.
pub fn routes() -> Router<ServerState> {
    Router::new().route(
        "/api/agents/:id/egress-allowlist",
        get(get_allowlist)
            .put(put_allowlist)
            .delete(delete_allowlist)
            .layer(axum::extract::DefaultBodyLimit::max(16 * 1024)),
    )
}

/// Body of `PUT /api/agents/:id/egress-allowlist`.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AllowlistBody {
    /// Exact hosts (`example.com`) or `*.` and a domain (`*.example.com`).
    pub allowlist: Vec<String>,
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

fn store_unavailable() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "the agent egress allowlists could not be read",
    )
}

fn answer(agent_id: &str, allowlist: Option<Vec<String>>) -> Response {
    Json(json!({ "agent_id": agent_id, "allowlist": allowlist })).into_response()
}

async fn require_agent(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    permission: &'static str,
    agent_id: &str,
) -> Result<(), Response> {
    if super::validate_agent_id(agent_id).is_err() {
        return Err(error(StatusCode::BAD_REQUEST, "the agent id is not valid"));
    }
    crate::server::enforce_agent_resource_permission(state, caller, permission, agent_id).await?;
    if permission == AGENT_VIEW {
        // Reading never creates anything, so an agent the store does not hold
        // (one served only from the catalog) simply reads as unrestricted.
        return Ok(());
    }
    match state.agent_store.get(agent_id).await {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(error(StatusCode::NOT_FOUND, "agent not found")),
        Err(_) => Err(error(
            StatusCode::SERVICE_UNAVAILABLE,
            "the agent could not be read",
        )),
    }
}

async fn get_allowlist(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> Response {
    if let Err(response) = require_agent(&state, &caller, AGENT_VIEW, &agent_id).await {
        return response;
    }
    match super::global().get(&agent_id) {
        Ok(allowlist) => answer(&agent_id, allowlist),
        Err(error) => {
            tracing::warn!(%error, "agent egress allowlist store unreadable");
            store_unavailable()
        }
    }
}

/// Write `allowlist` (or remove it) for an agent the caller may edit.
pub(crate) async fn write_allowlist(
    state: &ServerState,
    caller: &Option<VerifiedCaller>,
    agent_id: &str,
    allowlist: Option<&[String]>,
) -> Response {
    if let Err(response) = require_agent(state, caller, AGENT_EDIT, agent_id).await {
        return response;
    }
    if let Some(list) = allowlist {
        if let Err(refused) = super::normalize_patterns(list) {
            return error(StatusCode::BAD_REQUEST, &refused.0);
        }
    }
    match super::global().set(agent_id, allowlist) {
        Ok(stored) => answer(agent_id, stored),
        Err(error) => {
            tracing::warn!(%error, "agent egress allowlist store not written");
            store_unavailable()
        }
    }
}

async fn put_allowlist(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(agent_id): Path<String>,
    Json(body): Json<AllowlistBody>,
) -> Response {
    write_allowlist(&state, &caller, &agent_id, Some(body.allowlist.as_slice())).await
}

async fn delete_allowlist(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Path(agent_id): Path<String>,
) -> Response {
    write_allowlist(&state, &caller, &agent_id, None).await
}
