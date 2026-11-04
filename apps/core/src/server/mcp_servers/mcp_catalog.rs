//! MCP server CRUD, the MCP catalog and OpenAPI/GraphQL tool import: `delete_mcp_server` through `mcp_updates`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `DELETE /api/mcp/servers/:name` — remove a user-owned server from mcp.json.
pub(in crate::server) async fn delete_mcp_server(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
) -> axum::response::Response {
    if let Err(response) = enforce_mcp_configuration(&state, &caller).await {
        return response;
    }

    let name = name.trim().to_owned();
    let write_result = crate::sidecar::mcp::McpConfigStore::mutate(
        crate::sidecar::mcp::McpRegistry::config_path(),
        move |document| {
            let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;
            if servers.remove(&name).is_none() {
                return Err(format!(
                    "not_found: MCP server '{name}' is not user-configured"
                ));
            }
            Ok((true, ()))
        },
    )
    .await;
    match write_result {
        Ok(()) => {
            state.mcp.reload();
            (StatusCode::OK, Json(json!({ "ok": true }))).into_response()
        }
        Err(error) => {
            let (status, message) = if let Some(message) = error.strip_prefix("not_found: ") {
                (StatusCode::NOT_FOUND, message.to_owned())
            } else if error.contains("malformed") {
                (StatusCode::BAD_REQUEST, error)
            } else {
                (StatusCode::INTERNAL_SERVER_ERROR, error)
            };
            json_error(status, message)
        }
    }
}

/// The active Mcp catalog source (the official MCP registry by default, or a
/// custom registry mirror). See [`crate::catalog_source`].
pub(in crate::server) async fn active_mcp_source(
    state: &ServerState,
) -> Option<crate::catalog_source::Source> {
    let source = state
        .catalog_sources
        .get_active(crate::catalog_source::CatalogKind::Mcp, &state.preferences)
        .await?;
    // BYOK: when the active source is Smithery, inject the user's API key from
    // preferences (preferences-first; the source already env-falls-back). The key
    // is host-scoped inside the source so it can only ever reach the Smithery host.
    if let crate::catalog_source::Source::Smithery(mut s) = source.clone() {
        if let Ok(Some(key)) = state
            .preferences
            .get(crate::catalog_source::SMITHERY_API_KEY_PREF)
            .await
        {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                s.api_key = Some(trimmed.to_string());
            }
        }
        return Some(crate::catalog_source::Source::Smithery(s));
    }
    Some(source)
}

/// `GET /api/mcp/catalog?query=&limit=&cursor=` — browse the active MCP source
/// (the official registry by default). Source-aware (#464): mirrors the model and
/// skill catalog list handlers.
#[utoipa::path(
    get,
    path = "/api/mcp/catalog",
    tag = "MCP",
    summary = "Browse the MCP server catalog",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn mcp_catalog_list(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let query = params.get("query").map(String::as_str).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(40);
    let cursor = params
        .get("cursor")
        .map(String::as_str)
        .filter(|s| !s.is_empty());

    let mut q = crate::catalog_source::CatalogQuery {
        query: query.to_string(),
        limit,
        cursor: cursor.map(str::to_string),
        ..Default::default()
    };
    q.extra.clear();

    match active_mcp_source(&state).await {
        Some(source) => match source.search(&state.client, &q).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                catalog_search_error_status(&e),
                Json(json!({ "error": e.to_string(), "servers": [] })),
            ),
        },
        None => (
            StatusCode::OK,
            Json(json!({ "servers": [], "next_cursor": serde_json::Value::Null })),
        ),
    }
}

/// `GET /api/mcp/catalog/detail?id=<server-name>` — the chosen server's packages
/// and remotes, so a client can review the launch command before installing.
#[utoipa::path(
    get,
    path = "/api/mcp/catalog/detail",
    tag = "MCP",
    summary = "MCP server detail",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn mcp_catalog_detail(
    State(state): State<ServerState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> (StatusCode, Json<serde_json::Value>) {
    let Some(id) = params.get("id").filter(|s| !s.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing required `id` query parameter" })),
        );
    };
    match active_mcp_source(&state).await {
        Some(source) => match source.detail(&state.client, id).await {
            Ok(value) => (StatusCode::OK, Json(value)),
            Err(e) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": e.to_string() })),
            ),
        },
        None => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": "no active MCP source" })),
        ),
    }
}

#[derive(serde::Deserialize)]
pub(in crate::server) struct McpCatalogInstallBody {
    /// The registry server name / id to install.
    pub(in crate::server) id: String,
    /// Overwrite an already-installed server (the update flow) instead of
    /// failing on a name collision. Preserves the server's enabled state + env.
    #[serde(default)]
    pub(in crate::server) force: bool,
    /// Install from this MCP source instead of the active one. The update flow
    /// passes the source its check ran against (the official registry), so an
    /// update still applies when the user has since switched marketplaces.
    #[serde(default)]
    pub(in crate::server) source: Option<String>,
    #[serde(rename = "dryRun", default)]
    pub(in crate::server) dry_run: bool,
}

pub(in crate::server) struct ResolvedMcpEntry {
    pub(in crate::server) command: Option<String>,
    pub(in crate::server) args: Vec<String>,
    pub(in crate::server) transport: Option<String>,
    pub(in crate::server) url: Option<String>,
}

/// Lower a catalog plan into the config shape without introducing a package
/// runner for hosted servers. A remote catalog entry is already a supported
/// MCP transport, so wrapping it in `npx mcp-remote` would reintroduce an
/// unreviewed package-install boundary.
pub(in crate::server) fn resolved_mcp_entry(
    entry: &crate::mcp_catalog::McpEntryPlan,
) -> ResolvedMcpEntry {
    match entry {
        crate::mcp_catalog::McpEntryPlan::Stdio { command, args } => ResolvedMcpEntry {
            command: Some(command.clone()),
            args: args.clone(),
            transport: Some("stdio".to_string()),
            url: None,
        },
        crate::mcp_catalog::McpEntryPlan::Remote { url } => ResolvedMcpEntry {
            command: None,
            args: Vec::new(),
            transport: Some("streamable-http".to_string()),
            url: Some(url.clone()),
        },
    }
}

/// The MCP source `/api/mcp/updates` checks against: the official registry
/// (`latest_versions(None)`), so its updates must be applied there too.
pub(in crate::server) const MCP_UPDATES_SOURCE_ID: &str = "mcp-registry";

/// `GET /api/mcp/updates` — installed MCP servers whose recorded catalog version
/// trails the registry's current version. Only servers installed **through the
/// catalog** carry a version + catalog id (captured at install), so manually
/// added or pre-existing servers never report an update. The registry is fetched
/// once and compared against every installed server. Uses the default registry
/// base (servers from a custom source simply won't match, which is safe).
#[utoipa::path(
    get,
    path = "/api/mcp/updates",
    tag = "MCP",
    summary = "Installed MCP servers with a newer catalog version",
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn mcp_updates(
    State(_state): State<ServerState>,
) -> Json<serde_json::Value> {
    let installed = crate::sidecar::mcp::installed_configs();
    let latest = crate::mcp_catalog::latest_versions(None).await;
    let mut updates = Vec::new();
    for (name, cfg) in installed {
        let (Some(catalog_id), Some(current)) = (cfg.catalog_id, cfg.version) else {
            continue;
        };
        if let Some(latest_v) = latest.get(&catalog_id) {
            // Semver-ordered where both parse, so a rolled-back registry entry is
            // never offered as an "update"; otherwise any difference counts.
            let newer = match (
                semver::Version::parse(current.trim().trim_start_matches(['v', 'V'])),
                semver::Version::parse(latest_v.trim().trim_start_matches(['v', 'V'])),
            ) {
                (Ok(_), Ok(_)) => crate::update::is_newer(&current, latest_v),
                _ => latest_v != &current,
            };
            if newer {
                updates.push(json!({
                    "name": name,
                    "catalog_id": catalog_id,
                    "current_version": current,
                    "latest_version": latest_v,
                    // The source this check ran against, which must apply it.
                    "source": MCP_UPDATES_SOURCE_ID,
                }));
            }
        }
    }
    Json(json!({ "updates": updates }))
}
