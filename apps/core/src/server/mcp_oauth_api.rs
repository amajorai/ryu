//! Metadata-only HTTP API for Core-owned remote MCP OAuth connections.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    Extension, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use super::ServerState;
use crate::identity::ConnectionAccessLevel;
use crate::identity_verify::VerifiedCaller;
use crate::mcp_oauth::{CallbackMode, ConnectSpec};

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct HostedCallbackQuery {
    code: Option<String>,
    state: Option<String>,
    iss: Option<String>,
    error: Option<String>,
}

/// Public OAuth redirect target for remote/headless nodes. Authorization codes
/// are immediately exchanged by Core with its local PKCE verifier; no token is
/// reflected into the browser response.
pub async fn hosted_callback(Query(query): Query<HostedCallbackQuery>) -> impl IntoResponse {
    let completion = crate::mcp_oauth::global()
        .complete_hosted_callback(query.code, query.state, query.iss, query.error)
        .await;
    let (status, heading, detail) = match completion {
        Ok(()) => (
            StatusCode::OK,
            "Connected",
            "You can close this window and return to Ryu.",
        ),
        Err(_) => (
            StatusCode::BAD_REQUEST,
            "Connection failed",
            "Return to Ryu for details and try connecting again.",
        ),
    };
    let body = format!(
        "<!doctype html><meta name=\"referrer\" content=\"no-referrer\"><title>{heading}</title><h1>{heading}</h1><p>{detail}</p>"
    );
    (
        status,
        [
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
            ("x-content-type-options", "nosniff"),
        ],
        Html(body),
    )
}

/// Public OAuth Client ID Metadata Document for this node. It exists only when
/// the node has a stable HTTPS public URL, and contains no per-user state.
pub async fn client_metadata() -> impl IntoResponse {
    let Some(client_id) = crate::mcp_oauth::hosted_client_metadata_url() else {
        return error(
            StatusCode::NOT_FOUND,
            "this node has no HTTPS public OAuth callback",
        );
    };
    let Some(redirect_uri) = crate::mcp_oauth::hosted_redirect_uri() else {
        return error(StatusCode::NOT_FOUND, "OAuth callback is unavailable");
    };
    (
        StatusCode::OK,
        [("cache-control", "public, max-age=300")],
        Json(json!({
            "client_id": client_id,
            "client_name": "Ryu",
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        })),
    )
        .into_response()
}

fn error(status: StatusCode, message: impl std::fmt::Display) -> axum::response::Response {
    (status, Json(json!({ "error": message.to_string() }))).into_response()
}

fn owner(caller: Option<&VerifiedCaller>) -> Result<String, axum::response::Response> {
    crate::mcp_oauth::owner_for_caller(caller)
        .map_err(|message| error(StatusCode::UNAUTHORIZED, message))
}

async fn manifest(
    state: &ServerState,
    plugin_id: &str,
) -> Result<crate::plugin_manifest::PluginManifest, axum::response::Response> {
    state
        .app_manifests
        .read()
        .await
        .iter()
        .find(|manifest| manifest.id == plugin_id)
        .cloned()
        .ok_or_else(|| error(StatusCode::NOT_FOUND, "plugin not found"))
}

async fn ensure_oauth_grants(
    state: &ServerState,
    manifest: &crate::plugin_manifest::PluginManifest,
) -> Result<(), axum::response::Response> {
    let required = ["mcp:server", "identity.read"];
    if required.iter().any(|grant| {
        !manifest
            .permission_grants
            .iter()
            .any(|value| value == grant)
    }) {
        return Err(error(
            StatusCode::FORBIDDEN,
            "plugin does not declare the MCP OAuth grants",
        ));
    }
    if crate::plugins::builtins::tier_for_manifest(manifest)
        == crate::plugin_manifest::PluginTier::Core
    {
        return Ok(());
    }
    let record = state
        .app_store
        .get_record(&manifest.id)
        .await
        .map_err(|message| error(StatusCode::INTERNAL_SERVER_ERROR, message))?
        .ok_or_else(|| error(StatusCode::CONFLICT, "plugin is not installed"))?;
    if !record.enabled {
        return Err(error(StatusCode::CONFLICT, "plugin is disabled"));
    }
    if required
        .iter()
        .any(|grant| !record.approved_grants.iter().any(|value| value == grant))
    {
        return Err(error(
            StatusCode::FORBIDDEN,
            "the required MCP OAuth grants have not been approved",
        ));
    }
    Ok(())
}

/// `GET /api/plugins/:plugin_id/auth` — OAuth-capable MCP servers plus this
/// caller's metadata-only connections.
#[utoipa::path(
    get,
    path = "/api/plugins/{plugin_id}/auth",
    tag = "Plugins",
    params(("plugin_id" = String, Path)),
    responses((status = 200, description = "OAuth MCP servers and metadata-only connections", body = serde_json::Value))
)]
pub async fn list(
    State(state): State<ServerState>,
    Path(plugin_id): Path<String>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> impl IntoResponse {
    let owner = match owner(caller.as_ref()) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    let manifest = match manifest(&state, &plugin_id).await {
        Ok(manifest) => manifest,
        Err(response) => return response,
    };
    let store = match crate::identity::global() {
        Some(store) => store,
        None => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "identity store not initialized",
            )
        }
    };
    let connections = match store.list_mcp_oauth_connections(&owner, &plugin_id).await {
        Ok(connections) => connections,
        Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
    };
    let mut connection_values = Vec::with_capacity(connections.len());
    for connection in &connections {
        let access_level = match store
            .get_connection_access_level(
                &owner,
                crate::connection_policy::MCP_PROVIDER,
                &crate::connection_policy::mcp_connection_key(
                    &connection.profile_id,
                    &connection.plugin_id,
                    &connection.server_name,
                ),
            )
            .await
        {
            Ok(level) => level,
            Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
        };
        let mut value = match serde_json::to_value(connection) {
            Ok(value) => value,
            Err(message) => return error(StatusCode::INTERNAL_SERVER_ERROR, message),
        };
        if let Some(object) = value.as_object_mut() {
            object.insert(
                "access_level".to_owned(),
                Value::String(access_level.as_str().to_owned()),
            );
        }
        connection_values.push(value);
    }
    let servers: Vec<Value> = manifest
        .mcp_servers
        .iter()
        .filter_map(|(name, declaration)| {
            declaration.auth.as_ref().map(|auth| {
                json!({
                    "server_name": name,
                    "resource": declaration.url,
                    "client_id": auth.client_id(),
                    "connections": connection_values
                        .iter()
                        .filter(|connection| {
                            connection
                                .get("server_name")
                                .and_then(Value::as_str)
                                == Some(name.as_str())
                        })
                        .cloned()
                        .collect::<Vec<_>>(),
                })
            })
        })
        .collect();
    (
        StatusCode::OK,
        Json(json!({ "plugin_id": plugin_id, "servers": servers })),
    )
        .into_response()
}

#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ConnectBody {
    #[serde(default = "default_access_level")]
    access_level: String,
    #[serde(default = "default_profile")]
    profile_id: String,
    #[serde(default)]
    callback_mode: Option<CallbackMode>,
}

fn default_profile() -> String {
    crate::mcp_oauth::default_profile_id().to_owned()
}

fn default_access_level() -> String {
    ConnectionAccessLevel::default().as_str().to_owned()
}

/// Start authorization for one manifest-owned remote MCP server.
#[utoipa::path(
    post,
    path = "/api/plugins/{plugin_id}/auth/{server_name}/connect",
    tag = "Plugins",
    params(("plugin_id" = String, Path), ("server_name" = String, Path)),
    request_body = ConnectBody,
    responses((status = 200, description = "Browser authorization flow started", body = crate::mcp_oauth::ConnectStarted))
)]
pub async fn connect(
    State(state): State<ServerState>,
    Path((plugin_id, server_name)): Path<(String, String)>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<ConnectBody>,
) -> impl IntoResponse {
    let owner_user_id = match owner(caller.as_ref()) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    if body.profile_id.trim().is_empty() {
        return error(StatusCode::BAD_REQUEST, "profile_id is required");
    }
    let manifest = match manifest(&state, &plugin_id).await {
        Ok(manifest) => manifest,
        Err(response) => return response,
    };
    if let Err(response) = ensure_oauth_grants(&state, &manifest).await {
        return response;
    }
    let Some(declaration) = manifest.mcp_servers.get(&server_name) else {
        return error(StatusCode::NOT_FOUND, "MCP server not found");
    };
    let Some(auth) = declaration.auth.clone() else {
        return error(StatusCode::CONFLICT, "MCP server does not declare OAuth");
    };
    let Some(resource_url) = declaration.url.clone() else {
        return error(StatusCode::CONFLICT, "OAuth MCP server has no remote URL");
    };
    let started = crate::mcp_oauth::global()
        .start_connect(ConnectSpec {
            owner_user_id,
            access_level: ConnectionAccessLevel::from_str(&body.access_level),
            profile_id: body.profile_id,
            plugin_id,
            server_name,
            resource_url,
            auth,
            callback_mode: body.callback_mode.unwrap_or(CallbackMode::Auto),
            static_headers: declaration.headers.clone(),
            challenge: None,
        })
        .await;
    match started {
        Ok(started) => (StatusCode::OK, Json(json!(started))).into_response(),
        Err(message) => error(StatusCode::BAD_GATEWAY, message),
    }
}

/// Poll a browser authorization flow. Credential material is structurally absent.
#[utoipa::path(
    get,
    path = "/api/plugins/{plugin_id}/auth/flows/{flow_id}",
    tag = "Plugins",
    params(("plugin_id" = String, Path), ("flow_id" = String, Path)),
    responses((status = 200, description = "OAuth flow status", body = crate::mcp_oauth::FlowView))
)]
pub async fn flow(
    Path((plugin_id, flow_id)): Path<(String, String)>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> impl IntoResponse {
    let owner_user_id = match owner(caller.as_ref()) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match crate::mcp_oauth::global()
        .flow(&owner_user_id, &flow_id)
        .await
    {
        Ok(flow) if flow.plugin_id == plugin_id => {
            (StatusCode::OK, Json(json!(flow))).into_response()
        }
        Ok(_) => error(StatusCode::NOT_FOUND, "OAuth flow not found"),
        Err(message) => error(StatusCode::NOT_FOUND, message),
    }
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DisconnectQuery {
    #[serde(default = "default_profile")]
    profile_id: String,
}

/// Revoke upstream when possible, then always delete the local sealed binding.
#[utoipa::path(
    delete,
    path = "/api/plugins/{plugin_id}/auth/{server_name}",
    tag = "Plugins",
    params(("plugin_id" = String, Path), ("server_name" = String, Path), DisconnectQuery),
    responses((status = 200, description = "Local binding deleted; revocation status included", body = serde_json::Value))
)]
pub async fn disconnect(
    Path((plugin_id, server_name)): Path<(String, String)>,
    Query(query): Query<DisconnectQuery>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
) -> impl IntoResponse {
    let owner_user_id = match owner(caller.as_ref()) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    match crate::mcp_oauth::global()
        .disconnect(&owner_user_id, &query.profile_id, &plugin_id, &server_name)
        .await
    {
        Ok((deleted, revocation_confirmed)) => (
            StatusCode::OK,
            Json(json!({
                "deleted": deleted,
                "revocation": if revocation_confirmed { "confirmed" } else { "not_confirmed" },
            })),
        )
            .into_response(),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, message),
    }
}
