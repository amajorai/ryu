//! `/api/presence` — the desktop's availability heartbeat and gaming-mode settings.
//!
//! The desktop reports its resolved availability so Core can make agent
//! questions non-blocking while nobody is there to answer, and reads back the
//! effective status (which includes Core-detected gaming).
//!
//! Presence is a single-user, node-local signal: it pauses the node's local
//! models and changes how every conversation's questions behave. On a node bound
//! to an organization, several members share the node, so no single member may
//! set it; the writes are refused there and questions keep blocking as before.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;

use super::ServerState;
use crate::gaming::GamingSettings;
use crate::presence::streaming::StreamingSettings;
use crate::presence::{PresenceSnapshot, PresenceStatus};

/// Body for `PUT /api/presence`.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct PresenceReport {
    /// The desktop's resolved availability.
    pub status: PresenceStatus,
    /// Stable per-window id. Each window has its own idle clock, so Core keeps
    /// one report per window and merges them.
    #[serde(default)]
    pub client_id: Option<String>,
}

/// Refuse presence writes on a node shared by an organization.
fn refuse_on_bound_node() -> Option<Response> {
    super::node_org_id().map(|_| {
        (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "code": "presence_unavailable_on_org_node",
                "error": "presence, gaming, and streaming modes are only available on a personal node"
            })),
        )
            .into_response()
    })
}

/// `GET /api/presence` — effective presence, question policy, and gaming state.
#[utoipa::path(
    get,
    path = "/api/presence",
    tag = "Presence",
    summary = "Effective user presence, gaming, and streaming mode",
    responses((status = 200, description = "OK", body = PresenceSnapshot))
)]
pub async fn get_presence() -> Json<PresenceSnapshot> {
    Json(crate::presence::snapshot())
}

/// `PUT /api/presence` — heartbeat the desktop's resolved availability.
#[utoipa::path(
    put,
    path = "/api/presence",
    tag = "Presence",
    summary = "Report the desktop's availability",
    description = "Heartbeat from one desktop window. Reports are kept per window and merged; once every report is older than 150 seconds the user counts as away, so agent questions stop blocking when the desktop goes quiet. On organization-bound nodes, a Streaming report enables only the node-wide Connect suggestion privacy guard; other presence writes are refused and question routing is unchanged.",
    request_body = PresenceReport,
    responses(
        (status = 200, description = "OK", body = PresenceSnapshot),
        (status = 403, description = "The node is bound to an organization")
    )
)]
pub async fn put_presence(Json(body): Json<PresenceReport>) -> Response {
    if super::node_org_id().is_some() {
        let streaming = body.status == PresenceStatus::Streaming;
        crate::presence::report_streaming_privacy(body.client_id.as_deref(), streaming);
        if streaming {
            return Json(crate::presence::snapshot()).into_response();
        }
    }
    if let Some(refused) = refuse_on_bound_node() {
        return refused;
    }
    Json(crate::presence::report(
        body.client_id.as_deref(),
        body.status,
    ))
    .into_response()
}

/// `GET /api/presence/gaming` — persisted gaming-mode preferences.
#[utoipa::path(
    get,
    path = "/api/presence/gaming",
    tag = "Presence",
    summary = "Gaming mode settings",
    responses((status = 200, description = "OK", body = GamingSettings))
)]
pub async fn get_gaming_settings() -> Json<GamingSettings> {
    Json(crate::gaming::settings())
}

/// `PUT /api/presence/gaming` — update gaming-mode preferences.
#[utoipa::path(
    put,
    path = "/api/presence/gaming",
    tag = "Presence",
    summary = "Update gaming mode settings",
    request_body = GamingSettings,
    responses(
        (status = 200, description = "OK", body = GamingSettings),
        (status = 403, description = "The node is bound to an organization"),
        (status = 500, description = "Settings could not be saved")
    )
)]
pub async fn put_gaming_settings(Json(body): Json<GamingSettings>) -> Response {
    if let Some(refused) = refuse_on_bound_node() {
        return refused;
    }
    match crate::gaming::set_settings(body) {
        Ok(saved) => Json(saved).into_response(),
        Err(error) => {
            tracing::warn!("gaming mode settings save failed: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": "could not save gaming mode settings" })),
            )
                .into_response()
        }
    }
}

/// `GET /api/presence/streaming` — persisted Streaming detection preferences.
#[utoipa::path(
    get,
    path = "/api/presence/streaming",
    tag = "Presence",
    summary = "Streaming mode settings",
    responses(
        (status = 200, description = "OK", body = StreamingSettings),
        (status = 403, description = "The node is bound to an organization")
    )
)]
pub async fn get_streaming_settings() -> Response {
    if let Some(refused) = refuse_on_bound_node() {
        return refused;
    }
    Json(crate::presence::streaming::settings()).into_response()
}

/// `PUT /api/presence/streaming` — update Streaming detection preferences.
#[utoipa::path(
    put,
    path = "/api/presence/streaming",
    tag = "Presence",
    summary = "Update Streaming mode settings",
    description = "Idempotently replace node-local Streaming detector settings. The process-name list is capped at 64 entries and 128 characters per entry; blank names are discarded. Unknown JSON fields are ignored. Settings are stored locally and never include credentials.",
    request_body = StreamingSettings,
    responses(
        (status = 200, description = "OK", body = StreamingSettings),
        (status = 400, description = "Unsupported settings schema version"),
        (status = 403, description = "The node is bound to an organization"),
        (status = 500, description = "Settings could not be saved")
    )
)]
pub async fn put_streaming_settings(Json(body): Json<StreamingSettings>) -> Response {
    if let Some(refused) = refuse_on_bound_node() {
        return refused;
    }
    match crate::presence::streaming::set_settings(body) {
        Ok(saved) => Json(saved).into_response(),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "code": "unsupported_streaming_settings_version",
                "error": "unsupported Streaming settings version"
            })),
        )
            .into_response(),
        Err(error) => {
            tracing::warn!("streaming mode settings save failed: {error}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "code": "streaming_settings_write_failed",
                    "error": "could not save Streaming mode settings"
                })),
            )
                .into_response()
        }
    }
}

/// Presence routes, merged onto the authenticated API router.
pub fn routes() -> Router<ServerState> {
    Router::new()
        .route("/api/presence", get(get_presence).put(put_presence))
        .route(
            "/api/presence/gaming",
            get(get_gaming_settings).put(put_gaming_settings),
        )
        .route(
            "/api/presence/streaming",
            get(get_streaming_settings).put(put_streaming_settings),
        )
}
