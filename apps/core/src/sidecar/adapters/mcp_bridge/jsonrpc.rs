use super::*;

// ── The network transport: stateless JSON-RPC over `POST /mcp/:agent_id` ──────

/// Protocol revisions this server implements. Keep the legacy revision as an
/// explicit compatibility path while new clients use stateless 2026 requests.
pub(crate) const MCP_LEGACY_PROTOCOL_VERSION: &str = "2025-06-18";
pub(crate) const MCP_PROTOCOL_VERSION: &str = "2026-07-28";
pub(super) const MCP_SERVER_NAME: &str = "ryu-core";

// JSON-RPC 2.0 error codes (the subset this server emits).
pub(super) const JSONRPC_INVALID_REQUEST: i64 = -32_600;
pub(super) const JSONRPC_METHOD_NOT_FOUND: i64 = -32_601;
pub(super) const JSONRPC_INVALID_PARAMS: i64 = -32_602;
pub(super) const MCP_HEADER_MISMATCH: i64 = -32_020;

pub(super) fn rpc_ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub(super) fn rpc_err(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

/// Serve one JSON-RPC message against the live registry, as `agent_id`.
///
/// Returns the response to send, or `None` for a **notification** — a message with
/// no `id`, which JSON-RPC requires be answered with nothing at all. The caller
/// (`server::mod`) turns `None` into `202 Accepted` with an empty body.
///
/// Stateless on purpose: no session ids are issued, nothing is carried between
/// requests, and every request is answered with a single JSON response rather than
/// an SSE stream. That is a legal Streamable HTTP server and it means the endpoint
/// cannot accumulate per-client state.
///
/// **One message per call, never a batch.** The route refuses a top-level array
/// before it reaches here (`server::mcp_batch_refusal`): the revision this server
/// advertises, [`MCP_PROTOCOL_VERSION`], removed JSON-RPC batching, and a loop over
/// caller-sized input would turn one authenticated request into N registry
/// dispatches. Do not re-introduce a fan-out here — the refusal is what bounds the
/// work a single request can commission.
///
/// # What this caller is, and is not
///
/// `agent_id` is the principal, resolved and validated by the route before it gets
/// here. The handler is built with `permission_tx: None` and
/// `permission_scope_id: None`, and both are load-bearing rather than defaults
/// left unfilled:
///
/// - **No permission channel ⇒ no interactive ACP prompts.** Agent configuration
///   still requires a persisted operator decision in the Approvals inbox through
///   the shared registry gate; a missing approval engine fails closed.
/// - **No conversation scope ⇒ a fail-closed tool principal.** `permission_scope_id`
///   is the *host conversation id*, and on the ACP plane it is how a tool call is
///   authorized as the owner of the conversation the turn runs in. An HTTP client
///   has no conversation, so it passes `None`, and the conversation-reading tools
///   (`threads.*`, `search_conversations.*`) resolve `Unresolved` and refuse on a
///   bound node. **Do not "fix" that by accepting a conversation id from the
///   request.** It would be client-supplied and unauthenticated — the same trap
///   `CallToolBody::user_id` is documented as, one step worse, because this one
///   names a tenancy principal rather than just an audit label. Bob's node token
///   would read Alice's threads by typing her conversation id.
pub(crate) async fn serve_http_jsonrpc(
    mcp: Arc<McpRegistry>,
    agent_id: String,
    allowlist: Option<Vec<String>>,
    identity_profile_ids: Vec<String>,
    message: &Value,
) -> Option<Value> {
    serve_http_jsonrpc_versioned(
        mcp,
        agent_id,
        allowlist,
        identity_profile_ids,
        message,
        false,
    )
    .await
}

/// Version-aware variant used by the HTTP route after it has checked the modern
/// routing headers and per-request metadata at the network boundary.
pub(crate) async fn serve_http_jsonrpc_versioned(
    mcp: Arc<McpRegistry>,
    agent_id: String,
    allowlist: Option<Vec<String>>,
    identity_profile_ids: Vec<String>,
    message: &Value,
    modern: bool,
) -> Option<Value> {
    serve_http_jsonrpc_versioned_with_headers(
        mcp,
        agent_id,
        allowlist,
        identity_profile_ids,
        message,
        modern,
        &axum::http::HeaderMap::new(),
    )
    .await
}

pub(crate) async fn serve_http_jsonrpc_versioned_with_headers(
    mcp: Arc<McpRegistry>,
    agent_id: String,
    allowlist: Option<Vec<String>>,
    identity_profile_ids: Vec<String>,
    message: &Value,
    modern: bool,
    headers: &axum::http::HeaderMap,
) -> Option<Value> {
    serve_jsonrpc_message(
        message,
        modern,
        headers,
        NETWORK_CLIENT_INSTRUCTIONS,
        || async move {
            // Resolved per request, like everything else on this transport: there is no
            // session here to hang a snapshot on, and a stateless endpoint that cached
            // agent config would be the frozen-snapshot bug again in a second place.
            let caps = mcp.agent_capabilities(&agent_id).await;
            RyuMcpHandler {
                mcp,
                allowlist,
                // Composio actions are a per-agent ACP-session concern (`acp.rs` threads the
                // selected slugs in). An HTTP client discovers them through `tool_search`
                // instead, which pulls Composio live — so nothing is lost by offering none.
                composio_actions: Vec::new(),
                agent_id,
                identity_profile_ids,
                composio_connection_scope: None,
                conversation_scope: None,
                caps,
                permission_tx: None,
                permission_scope_id: None,
            }
        },
    )
    .await
}

pub(super) const NETWORK_CLIENT_INSTRUCTIONS: &str =
    "Ryu's live tool registry, scoped to one agent. `tools/list` is short by \
     design: it offers the agent's granted tools plus the discovery \
     meta-tools. Whole planes — Composio actions and the operations derived \
     from installed apps' OpenAPI documents — are searchable but not listed. \
     Call `tool_search` to find a capability, `describe` for its argument \
     schema, then call the tool by its exact id.";

pub(super) const MANAGED_PI_INSTRUCTIONS: &str =
    "Ryu's live tool registry for this chat. The listed tools are the agent's granted \
     Ryu tools; tools that render an interactive app render it in the chat. Composio \
     actions and operations derived from installed apps are searchable but not listed: \
     find them with this server's `tool_search`, read their arguments with `describe`, \
     then call them by exact id through the `ryu_call_tool` tool.";

/// The server-resolved context of one managed Pi ACP session, as recorded by
/// [`crate::server::acp_tool_broker`] before Pi was spawned. Nothing here comes
/// from the request: the route resolves it from the session capability.
pub(crate) struct AcpSessionMcpScope {
    pub(crate) agent_id: String,
    /// The host conversation. It is the tool principal on the ACP plane — the
    /// same value the in-process bridge receives as `permission_scope_id`.
    pub(crate) conversation_id: String,
    /// Effective allowlist (registry grants + merged `composio.*` ids).
    pub(crate) allowlist: Option<Vec<String>>,
    pub(crate) composio_actions: Vec<String>,
    pub(crate) identity_profile_ids: Vec<String>,
    pub(crate) composio_connection_scope:
        Option<Vec<crate::sidecar::adapters::ComposioConnectionBinding>>,
    pub(crate) conversation_scope: Option<Vec<String>>,
    /// The ACP instance's event channel, when attached: widgets and interactive
    /// permission prompts reach the live turn through it.
    pub(crate) events: Option<tokio::sync::mpsc::UnboundedSender<AcpEvent>>,
}

/// Serve one JSON-RPC message for a managed Pi session's native MCP client.
///
/// This is the in-process ACP bridge, reached over HTTP: the handler is built
/// from the same server-resolved session context `acp.rs` hands
/// [`build_ryu_mcp_server`] for every other ACP agent, so the conversation
/// principal, Composio actions, profile scopes, widget emission, `ask_user`, and
/// the interactive agent-builder approval all apply. Only the transport differs
/// — pi-acp does not forward `session/new` `mcpServers`, so Pi's own MCP client
/// connects here instead.
pub(crate) async fn serve_acp_session_jsonrpc(
    mcp: Arc<McpRegistry>,
    scope: AcpSessionMcpScope,
    message: &Value,
) -> Option<Value> {
    serve_jsonrpc_message(
        message,
        false,
        &axum::http::HeaderMap::new(),
        MANAGED_PI_INSTRUCTIONS,
        || async move {
            let caps = mcp.agent_capabilities(&scope.agent_id).await;
            RyuMcpHandler {
                mcp,
                allowlist: scope.allowlist,
                composio_actions: scope.composio_actions,
                agent_id: scope.agent_id,
                identity_profile_ids: scope.identity_profile_ids,
                composio_connection_scope: scope.composio_connection_scope,
                conversation_scope: scope.conversation_scope,
                caps,
                permission_tx: scope.events,
                permission_scope_id: Some(scope.conversation_id),
            }
        },
    )
    .await
}

pub(super) async fn serve_jsonrpc_message<F, Fut>(
    message: &Value,
    modern: bool,
    headers: &axum::http::HeaderMap,
    instructions: &str,
    build_handler: F,
) -> Option<Value>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = RyuMcpHandler>,
{
    let Some(obj) = message.as_object() else {
        return Some(rpc_err(
            Value::Null,
            JSONRPC_INVALID_REQUEST,
            "request must be a JSON-RPC object",
        ));
    };
    // A notification carries NO `id` key at all — distinct from `"id": null`, which
    // is a (badly-behaved but answerable) request.
    let is_notification = !obj.contains_key("id");
    let id = obj.get("id").cloned().unwrap_or(Value::Null);
    let method = obj.get("method").and_then(Value::as_str);
    let (Some("2.0"), Some(method)) = (obj.get("jsonrpc").and_then(Value::as_str), method) else {
        return Some(rpc_err(
            id,
            JSONRPC_INVALID_REQUEST,
            "not a JSON-RPC 2.0 request",
        ));
    };

    // Answered without touching the registry, so an unknown/handshake method never
    // pays for a `tools_for_agent` pass.
    match method {
        "server/discover" if modern => {
            return Some(rpc_ok(
                id,
                modern_result(json!({
                    "supportedVersions": [MCP_PROTOCOL_VERSION, MCP_LEGACY_PROTOCOL_VERSION],
                    "capabilities": {
                        "tools": { "listChanged": false },
                        "events": {},
                    },
                })),
            ));
        }
        "initialize" => {
            if modern {
                return Some(rpc_err(
                    id,
                    JSONRPC_METHOD_NOT_FOUND,
                    "initialize is unavailable in protocol version 2026-07-28",
                ));
            }
            return Some(rpc_ok(
                id,
                json!({
                    "protocolVersion": MCP_LEGACY_PROTOCOL_VERSION,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": {
                        "name": "ryu-core",
                        "title": "Ryu",
                        "version": env!("CARGO_PKG_VERSION"),
                    },
                    "instructions": instructions,
                }),
            ));
        }
        "ping" if modern => {
            return Some(rpc_err(
                id,
                JSONRPC_METHOD_NOT_FOUND,
                "ping is unavailable in protocol version 2026-07-28",
            ));
        }
        "ping" => return (!is_notification).then(|| rpc_ok(id, json!({}))),
        _ if method.starts_with("notifications/") => return None,
        _ => {}
    }

    let handler = build_handler().await;

    match method {
        "tools/list" => {
            let mut tools = handler.build_tool_list().await;
            tools.sort_by(|left, right| left.name.cmp(&right.name));
            Some(rpc_ok(
                id,
                if modern {
                    modern_cacheable_result(json!({ "tools": tools }), 0, "private")
                } else {
                    json!({ "tools": tools })
                },
            ))
        }
        "tools/call" => {
            let params = obj.get("params").and_then(Value::as_object);
            let Some(name) = params
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .filter(|n| !n.is_empty())
            else {
                return Some(rpc_err(
                    id,
                    JSONRPC_INVALID_PARAMS,
                    "tools/call requires params.name",
                ));
            };
            let args = params
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));
            if modern {
                let input_schema = handler
                    .build_tool_list()
                    .await
                    .into_iter()
                    .find(|tool| tool.name.as_ref() == name)
                    .and_then(|tool| serde_json::to_value(tool).ok())
                    .and_then(|tool| tool.get("inputSchema").cloned());
                if let Err(error) = crate::sidecar::mcp::http_headers::validate_parameter_headers(
                    input_schema.as_ref(),
                    &args,
                    headers,
                ) {
                    return Some(rpc_err(id, MCP_HEADER_MISMATCH, error.to_string()));
                }
            }
            // A tool that RAN and reported a problem is a successful JSON-RPC call
            // carrying `isError: true` — not a JSON-RPC error. Conflating the two
            // makes a refused tool read to the client as a transport fault, and a
            // model driving the client cannot recover from a transport fault.
            match handler.dispatch_tool(name, args).await {
                Ok(text) => Some(rpc_ok(
                    id,
                    with_modern_result(
                        json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                        modern,
                    ),
                )),
                Err(e) => Some(rpc_ok(
                    id,
                    with_modern_result(
                        json!({
                            "content": [{ "type": "text", "text": e.message }],
                            "isError": true,
                        }),
                        modern,
                    ),
                )),
            }
        }
        _ if is_notification => None,
        _ => Some(rpc_err(
            id,
            JSONRPC_METHOD_NOT_FOUND,
            format!("unknown method: {method}"),
        )),
    }
}

pub(super) fn modern_result(mut value: Value) -> Value {
    value["resultType"] = json!("complete");
    value["_meta"] = json!({
        "io.modelcontextprotocol/serverInfo": {
            "name": MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        }
    });
    value
}

pub(super) fn modern_cacheable_result(mut value: Value, ttl_ms: u64, cache_scope: &str) -> Value {
    value["ttlMs"] = json!(ttl_ms);
    value["cacheScope"] = json!(cache_scope);
    modern_result(value)
}

pub(super) fn with_modern_result(value: Value, modern: bool) -> Value {
    if modern {
        modern_result(value)
    } else {
        value
    }
}
