//! MCP server CRUD, the MCP catalog and OpenAPI/GraphQL tool import: `create_mcp_server` through `update_mcp_server`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// `POST /api/mcp/servers` — append a new user-defined MCP server to
/// `~/.ryu/mcp.json` and reload the registry so tools are immediately
/// discoverable without restarting Core.
///
/// Validation:
/// - `name` must be non-empty and must not contain `__` (the legacy tool-id separator
///   that `split_tool_id` uses to route calls).
/// - exactly one of `command` (stdio) or `url` (remote) must be non-empty.
/// - `name` must not already be registered (built-ins included).
///
/// Write strategy: read the current `mcp.json` user map (parse-fail → 400 to
/// avoid clobbering a hand-edited file), insert the new entry, write back
/// atomically via `write_secret_file` + rename, then call `McpRegistry::reload`
/// so the change takes effect without a restart.
#[utoipa::path(
    post,
    path = "/api/mcp/servers",
    tag = "MCP",
    summary = "Register an MCP server",
    request_body = serde_json::Value,
    responses((status = 200, description = "OK", body = serde_json::Value))
)]
pub(in crate::server) async fn create_mcp_server(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Json(body): Json<CreateMcpServerBody>,
) -> axum::response::Response {
    use crate::sidecar::mcp::McpServerConfig;

    if let Err(response) = enforce_mcp_configuration(&state, &caller).await {
        return response;
    }

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "name is required".to_owned());
    }
    // The legacy `__` separator is accepted only at the compatibility ingress;
    // rejecting it keeps an mcp.json key unambiguous when old ids are read.
    if name.contains("__") {
        return json_error(
            StatusCode::BAD_REQUEST,
            "name must not contain '__' (reserved legacy tool-id separator)".to_owned(),
        );
    }

    // command XOR url: a stdio server needs something to spawn, a remote server
    // needs somewhere to POST, and an entry naming both is ambiguous rather than
    // clever — refuse it here rather than silently picking one at connect time.
    let command = body
        .command
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    let url = body
        .url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .map(str::to_owned);
    match (&command, &url) {
        (None, None) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "either `command` (stdio) or `url` (remote) is required".to_owned(),
            );
        }
        (Some(_), Some(_)) => {
            return json_error(
                StatusCode::BAD_REQUEST,
                "`command` and `url` are mutually exclusive — a server is either stdio or remote"
                    .to_owned(),
            );
        }
        _ => {}
    }
    // Reject a remote URL Core could never reach before it is written to disk, so
    // the failure surfaces at add-time with the URL in hand rather than as an
    // opaque tool error on first use. This is the SAME screen the transport
    // applies per request (`guarded_post_json` → `screen_agent_egress_url`), not
    // a second policy: the guard at the fetch seam remains authoritative, since a
    // hand-edited `mcp.json` never passes through here at all.
    if let Some(url) = &url {
        if let Err(e) = screen_agent_egress_url(url).await {
            return json_error(StatusCode::BAD_REQUEST, format!("{e}"));
        }
    }

    // Reject duplicates — check both the in-memory registry (built-ins) and the
    // user file that will be written.
    if state.mcp.contains_server(&name) {
        return json_error(
            StatusCode::CONFLICT,
            format!("MCP server '{name}' is already registered"),
        );
    }

    let new_cfg = McpServerConfig {
        command,
        transport: body.transport,
        url,
        headers: body.headers,
        auth: None,
        owner_plugin_id: None,
        owner_server_name: None,
        cwd: None,
        args: body.args,
        env: body.env,
        description: body.description,
        enabled: true,
        version: None,
        catalog_id: None,
    };
    let config_name = name.clone();
    let write_result = crate::sidecar::mcp::McpConfigStore::mutate(
        crate::sidecar::mcp::McpRegistry::config_path(),
        move |document| {
            let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;
            if servers.contains_key(&config_name) {
                return Err(format!(
                    "conflict: MCP server '{config_name}' is already in mcp.json"
                ));
            }
            crate::sidecar::mcp::McpConfigStore::replace_server(servers, config_name, &new_cfg)?;
            Ok((true, ()))
        },
    )
    .await;
    if let Err(error) = write_result {
        let status = if error.starts_with("conflict:") {
            StatusCode::CONFLICT
        } else if error.contains("malformed") {
            StatusCode::BAD_REQUEST
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        return json_error(
            status,
            error
                .strip_prefix("conflict: ")
                .unwrap_or(&error)
                .to_owned(),
        );
    }

    // Reload the in-memory registry so the new server appears in subsequent
    // GET /api/mcp/servers and GET /api/mcp/tools calls without a restart.
    state.mcp.reload();
    let server = state
        .mcp
        .server_summaries()
        .into_iter()
        .find(|summary| summary.name == name);

    (
        StatusCode::CREATED,
        Json(json!({
            "ok": true,
            "server": server,
        })),
    )
        .into_response()
}

/// A partial update for a user-owned MCP server. Values from `env` and
/// `headers` equal to `MCP_MASKED_SECRET` keep their existing secret; Core never
/// returns those values to the desktop.
#[derive(serde::Deserialize)]
pub(in crate::server) struct UpdateMcpServerBody {
    #[serde(default)]
    pub(in crate::server) command: Option<String>,
    #[serde(default, rename = "type")]
    pub(in crate::server) transport: Option<String>,
    #[serde(default)]
    pub(in crate::server) url: Option<String>,
    #[serde(default)]
    pub(in crate::server) headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub(in crate::server) args: Option<Vec<String>>,
    #[serde(default)]
    pub(in crate::server) env: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub(in crate::server) description: Option<String>,
    #[serde(default)]
    pub(in crate::server) enabled: Option<bool>,
}

pub(in crate::server) const MCP_MASKED_SECRET: &str = "••••••";

pub(in crate::server) fn merge_mcp_secret_map(
    current: &std::collections::BTreeMap<String, String>,
    incoming: std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    incoming
        .into_iter()
        .filter_map(|(key, value)| {
            let key = key.trim().to_owned();
            if key.is_empty() {
                return None;
            }
            if value == MCP_MASKED_SECRET || value.trim().is_empty() {
                current.get(&key).map(|old| (key, old.clone()))
            } else {
                Some((key, value))
            }
        })
        .collect()
}

/// `PUT /api/mcp/servers/:name` — update a user-owned server in `mcp.json`.
/// Plugin-declared, Fleet-managed, and built-in rows are not user-owned and are
/// refused by the file-map ownership check.
pub(in crate::server) async fn update_mcp_server(
    State(state): State<ServerState>,
    Extension(caller): Extension<Option<crate::identity_verify::VerifiedCaller>>,
    Path(name): Path<String>,
    Json(body): Json<UpdateMcpServerBody>,
) -> axum::response::Response {
    use crate::sidecar::mcp::McpServerConfig;

    if let Err(response) = enforce_mcp_configuration(&state, &caller).await {
        return response;
    }

    let name = name.trim().to_owned();
    if name.is_empty() {
        return json_error(StatusCode::BAD_REQUEST, "name is required".to_owned());
    }
    if let Some(url) = body.url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        if let Err(e) = screen_agent_egress_url(url).await {
            return json_error(StatusCode::BAD_REQUEST, format!("{e}"));
        }
    }

    let config_name = name.clone();
    let write_result = crate::sidecar::mcp::McpConfigStore::mutate(
        crate::sidecar::mcp::McpRegistry::config_path(),
        move |document| {
            let servers = crate::sidecar::mcp::McpConfigStore::servers_mut(document)?;
            let current_value = servers
                .get(&config_name)
                .ok_or_else(|| {
                    format!("not_found: MCP server '{config_name}' is not user-configured")
                })?
                .clone();
            let mut current: McpServerConfig =
                serde_json::from_value(current_value).map_err(|error| {
                    format!("bad_request: mcp.json contains an invalid server entry: {error}")
                })?;

            let wants_remote = match body.transport.as_deref() {
                Some("http" | "streamable-http" | "streamable_http" | "sse") => true,
                Some("stdio") => false,
                Some(other) => {
                    return Err(format!("bad_request: unsupported MCP transport '{other}'"));
                }
                None if body.url.is_some() => true,
                None if body.command.is_some() => false,
                None => current.url.is_some(),
            };

            if wants_remote {
                let url = body
                    .url
                    .as_deref()
                    .map(str::trim)
                    .filter(|u| !u.is_empty())
                    .map(str::to_owned)
                    .or_else(|| current.url.clone())
                    .ok_or_else(|| {
                        "bad_request: endpoint URL is required for a remote MCP server".to_owned()
                    })?;
                current.command = None;
                current.url = Some(url);
                current.transport = Some(
                    body.transport
                        .clone()
                        .unwrap_or_else(|| "streamable-http".to_owned()),
                );
            } else {
                let command = body
                    .command
                    .as_deref()
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .map(str::to_owned)
                    .or_else(|| current.command.clone())
                    .ok_or_else(|| {
                        "bad_request: command is required for a stdio MCP server".to_owned()
                    })?;
                current.command = Some(command);
                current.url = None;
                current.transport =
                    Some(body.transport.clone().unwrap_or_else(|| "stdio".to_owned()));
            }

            if let Some(args) = &body.args {
                current.args = args.clone();
            }
            if let Some(env) = body.env.clone() {
                current.env = merge_mcp_secret_map(&current.env, env);
            }
            if let Some(headers) = body.headers.clone() {
                current.headers = merge_mcp_secret_map(&current.headers, headers);
            }
            if let Some(description) = &body.description {
                current.description = if description.trim().is_empty() {
                    None
                } else {
                    Some(description.clone())
                };
            }
            if let Some(enabled) = body.enabled {
                current.enabled = enabled;
            }
            crate::sidecar::mcp::McpConfigStore::replace_server(servers, config_name, &current)?;
            Ok((true, ()))
        },
    )
    .await;
    if let Err(error) = write_result {
        let (status, message) = if let Some(message) = error.strip_prefix("not_found: ") {
            (StatusCode::NOT_FOUND, message.to_owned())
        } else if let Some(message) = error.strip_prefix("bad_request: ") {
            (StatusCode::BAD_REQUEST, message.to_owned())
        } else if error.contains("malformed") {
            (StatusCode::BAD_REQUEST, error)
        } else {
            (StatusCode::INTERNAL_SERVER_ERROR, error)
        };
        return json_error(status, message);
    }

    state.mcp.reload();
    let server = state
        .mcp
        .server_summaries()
        .into_iter()
        .find(|summary| summary.name == name);
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "server": server })),
    )
        .into_response()
}
