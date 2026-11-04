//! The network MCP surface and the command-approval exec scan: `validate_mcp_http_request` through `mcp_http`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

/// Check the HTTP metadata required by MCP 2026-07-28. A request without the
/// modern version header stays on the legacy handshake path for older clients.
/// Modern routing headers are checked against the JSON body before the registry
/// can run a tool, so a gateway cannot authorize one method and dispatch another.
pub(in crate::server) fn validate_mcp_http_request(
    method: &str,
    message: &serde_json::Value,
    headers: &HeaderMap,
) -> Result<(bool, Option<&'static str>), serde_json::Value> {
    use crate::sidecar::adapters::mcp_bridge::{MCP_LEGACY_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION};

    let id = message
        .get("id")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let requested = headers
        .get("MCP-Protocol-Version")
        .and_then(|value| value.to_str().ok());
    let Some(version) = requested else {
        // The legacy initialize request precedes version negotiation and carries
        // neither a version header nor a modern metadata envelope.
        if method == "initialize" {
            return Ok((false, None));
        }
        return Err(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": MCP_HEADER_MISMATCH,
                "message": "MCP-Protocol-Version is required after initialize",
            }
        }));
    };

    if version != MCP_PROTOCOL_VERSION && version != MCP_LEGACY_PROTOCOL_VERSION {
        return Err(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": MCP_UNSUPPORTED_PROTOCOL_VERSION,
                "message": "Unsupported MCP protocol version",
                "data": {
                    "supported": [MCP_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSION],
                    "requested": version,
                }
            }
        }));
    }

    if version == MCP_LEGACY_PROTOCOL_VERSION {
        return Ok((false, Some(MCP_LEGACY_PROTOCOL_VERSION)));
    }

    let params = message.get("params").and_then(serde_json::Value::as_object);
    let meta = params
        .and_then(|params| params.get("_meta"))
        .and_then(serde_json::Value::as_object);
    let meta_version = meta
        .and_then(|meta| meta.get(MCP_PROTOCOL_VERSION_KEY))
        .and_then(serde_json::Value::as_str);
    let client_capabilities = meta
        .and_then(|meta| meta.get(MCP_CLIENT_CAPABILITIES_KEY))
        .and_then(serde_json::Value::as_object);
    if meta_version != Some(MCP_PROTOCOL_VERSION) {
        return Err(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": MCP_HEADER_MISMATCH,
                "message": "MCP-Protocol-Version must match params._meta protocolVersion",
            }
        }));
    }
    if client_capabilities.is_none() {
        return Err(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": MCP_INVALID_REQUEST,
                "message": "2026-07-28 requests require protocolVersion and clientCapabilities in params._meta",
            }
        }));
    }

    let method_header = headers
        .get("Mcp-Method")
        .and_then(|value| value.to_str().ok());
    if method_header != Some(method) {
        return Err(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": MCP_HEADER_MISMATCH,
                "message": "Mcp-Method must match the JSON-RPC method",
            }
        }));
    }

    let expected_name = match method {
        "tools/call" => params
            .and_then(|params| params.get("name"))
            .and_then(serde_json::Value::as_str),
        "resources/read" => params
            .and_then(|params| params.get("uri"))
            .and_then(serde_json::Value::as_str),
        "prompts/get" => params
            .and_then(|params| params.get("name"))
            .and_then(serde_json::Value::as_str),
        "tasks/get" | "tasks/update" | "tasks/cancel" => params
            .and_then(|params| params.get("taskId"))
            .and_then(serde_json::Value::as_str),
        _ => None,
    };
    let name_header = match headers
        .get("Mcp-Name")
        .and_then(|value| value.to_str().ok())
    {
        Some(value) => match crate::sidecar::mcp::http_headers::decode_mcp_header_value(value) {
            Ok(decoded) => Some(decoded),
            Err(_) => {
                return Err(json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": {
                        "code": MCP_HEADER_MISMATCH,
                        "message": "Mcp-Name is malformed",
                    }
                }));
            }
        },
        None => None,
    };
    if match expected_name {
        Some(name) => name_header.as_deref() != Some(name),
        None => name_header.is_some(),
    } {
        return Err(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": MCP_HEADER_MISMATCH,
                "message": "Mcp-Name must match a named tool, resource, or prompt request",
            }
        }));
    }

    Ok((true, Some(MCP_PROTOCOL_VERSION)))
}

pub(in crate::server) async fn mcp_event_authorization_expiry(
    resolved: &ResolvedAuthorization,
) -> Option<i64> {
    let context_expiry = resolved
        .context
        .expires_at
        .and_then(|expires_at| i64::try_from(expires_at).ok());
    let jwt_expiry = match resolved.verified_user_jwt.as_deref() {
        Some(token) => verified_caller_with_expiry_from_token(token)
            .await
            .map(|(_, expires_at)| expires_at),
        None => None,
    };
    match (context_expiry, jwt_expiry) {
        (Some(context), Some(jwt)) => Some(context.min(jwt)),
        (Some(context), None) => Some(context),
        (None, Some(jwt)) => Some(jwt),
        (None, None) => None,
    }
}

/// `POST /mcp` — no agent named.
///
/// Registered only so a client configured with the bare base URL gets an
/// actionable 400 instead of a bare 404 from the router (matchit will not match
/// `/mcp` or `/mcp/` against `/mcp/:agent_id`). It shares one code path with the
/// real route by passing an empty id straight into [`mcp_admission`].
pub(in crate::server) async fn mcp_http_no_agent(
    State(state): State<ServerState>,
    axum::Extension(auth_token): axum::Extension<Option<String>>,
    axum::Extension(resolved): axum::Extension<ResolvedAuthorization>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    mcp_http_inner(state, auth_token, resolved, String::new(), headers, body).await
}

/// `POST /mcp/:agent_id` — MCP over stateless JSON-RPC, scoped to one agent.
#[utoipa::path(
    post,
    path = "/mcp/{agent_id}",
    tag = "MCP",
    summary = "Model Context Protocol endpoint (JSON-RPC), scoped to one agent",
    request_body = serde_json::Value,
    responses(
        (status = 200, description = "JSON-RPC response", body = serde_json::Value),
        (status = 202, description = "Notification accepted; no response body"),
        (status = 401, description = "This node has no token configured"),
        (status = 403, description = "Unknown agent"),
    )
)]
pub(in crate::server) async fn mcp_http(
    State(state): State<ServerState>,
    axum::Extension(auth_token): axum::Extension<Option<String>>,
    axum::Extension(resolved): axum::Extension<ResolvedAuthorization>,
    Path(agent_id): Path<String>,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    mcp_http_inner(state, auth_token, resolved, agent_id, headers, body).await
}
