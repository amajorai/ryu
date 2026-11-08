//! The network MCP surface and the command-approval exec scan: `mcp_http_inner` through `mcp_http_inner`.
// test-exempt: moved verbatim out of server/mod.rs; tests in server/tests/.

use crate::server::*;

pub(in crate::server) async fn mcp_http_inner(
    state: ServerState,
    auth_token: Option<String>,
    resolved: ResolvedAuthorization,
    agent_id: String,
    headers: HeaderMap,
    body: String,
) -> axum::response::Response {
    // An empty token is not a configured token — it would compare equal to a
    // client sending `Bearer `, which is to say to no credential at all.
    let token_configured = auth_token.is_some_and(|t| !t.is_empty());
    // The principal must be EXACT — an id equal to a registry entry or to a stored
    // agent record. NOT `find_by_prefix`, whose rule (`agent_id == e.id ||
    // agent_id.starts_with(&e.id)`) lets the caller pick which agent's posture it
    // is judged against by choosing a string: `ryu-whatever` is admitted by `ryu`.
    // See [`mcp_admission`] §2. The supplied id also stays the principal verbatim
    // (nothing is canonicalized to a matched entry), so every downstream lookup —
    // `allowlist_for`, `agent_capabilities`, the vault bindings below — resolves
    // the record the caller actually named.
    //
    // The store read is gated on the two cheap checks so an unauthenticated or
    // empty-principal request never costs a DB round-trip, and it is the SAME read
    // that supplies `identity_profile_ids` below — one lookup, not two.
    let may_resolve = token_configured && !agent_id.is_empty();
    let record = if may_resolve {
        state.agent_store.get(&agent_id).await.ok().flatten()
    } else {
        None
    };
    let agent_known = may_resolve
        && mcp_principal_resolves(
            &agent_id,
            record.is_some(),
            state.agents.entries.iter().map(|e| e.id.as_str()),
        );
    if let Some((status, message)) = mcp_admission(token_configured, &agent_id, agent_known) {
        return (status, Json(json!({ "ok": false, "error": message }))).into_response();
    }
    if !crate::fleet::is_agent_available(&agent_id) {
        return json_error(StatusCode::FORBIDDEN, "agent is unavailable".to_owned());
    }

    if let Err(response) = enforce_agent_resource_permission(
        &state,
        &resolved.caller,
        crate::identity_verify::permissions::AGENT_RUN,
        &agent_id,
    )
    .await
    {
        return response;
    }

    if let Some(status) = denial_status(authorize_mcp_message(
        &resolved,
        &body,
        crate::pairing::now_secs(),
    )) {
        return (
            status,
            Json(json!({
                "ok": false,
                "error": format!(
                    "missing capability: {}",
                    mcp_message_capability(&body).as_str()
                ),
            })),
        )
            .into_response();
    }

    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) else {
        // JSON-RPC parse error, in the envelope — not an axum 400 body, which a
        // JSON-RPC client cannot read.
        return Json(json!({
            "jsonrpc": "2.0",
            "id": serde_json::Value::Null,
            "error": { "code": -32_700, "message": "invalid JSON" },
        }))
        .into_response();
    };

    // A top-level array is a batch, and this endpoint does not serve one. Refused
    // BEFORE any registry work, so the array never becomes N dispatches — see
    // [`mcp_batch_refusal`] for why refusing is the spec-conformant answer at the
    // revision this server advertises.
    if let Some(refusal) = mcp_batch_refusal(&parsed) {
        return Json(refusal).into_response();
    }

    if !mcp_message_has_method(&parsed) {
        return Json(json!({
            "jsonrpc": "2.0",
            "id": parsed.get("id").cloned().unwrap_or(serde_json::Value::Null),
            "error": { "code": -32_600, "message": "invalid JSON-RPC request: method is required" },
        }))
        .into_response();
    }

    let method = parsed
        .get("method")
        .and_then(serde_json::Value::as_str)
        .expect("mcp_message_has_method checked method");
    let (modern, response_version) = match validate_mcp_http_request(method, &parsed, &headers) {
        Ok(version) => version,
        Err(response) => return (StatusCode::BAD_REQUEST, Json(response)).into_response(),
    };

    if let Err(denial) = authorize_network_agent_configuration_tool(&state.mcp, &parsed, |target| {
        enforce_agent_resource_permission(
            &state,
            &resolved.caller,
            crate::identity_verify::permissions::AGENT_EDIT,
            target,
        )
    })
    .await
    {
        // A rejected notification still has no JSON-RPC response. Requests keep
        // their id and protocol version; neither path reaches the approval queue.
        let mut response = if let Some(id) = parsed.get("id") {
            let invalid_target = denial.status() == StatusCode::BAD_REQUEST;
            (
                denial.status(),
                Json(json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": {
                        "code": if invalid_target { -32602 } else { -32001 },
                        "message": if invalid_target { "agent configuration requires a target agent_id" }
                            else { "insufficient permissions: agent.edit" }
                    }
                })),
            ).into_response()
        } else {
            StatusCode::ACCEPTED.into_response()
        };
        if let Some(version) = response_version {
            if let Ok(value) = HeaderValue::from_str(version) {
                response.headers_mut().insert("MCP-Protocol-Version", value);
            }
        }
        return response;
    }

    let allowlist = resolved_agent_tool_allowlist(&state, &agent_id).await;
    // Per-agent Identity Vault binding (epic #517), read off the SAME record the
    // admission check resolved — otherwise a tool call over this transport silently
    // loses the agent's credential bindings and fails in a way that looks like a
    // broken tool rather than a missing principal.
    let identity_profile_ids = record
        .map(|rec| rec.identity_profile_ids)
        .unwrap_or_default();

    let thread_events_allowed = allowlist
        .as_ref()
        .is_none_or(|tools| tools.iter().any(|tool| tool.starts_with("threads.")));
    let (_, _, _, node_bound) = tenancy_filter_args(&resolved.caller);
    let event_authorization_expires_at = if method == "events/subscribe" {
        mcp_event_authorization_expiry(&resolved).await
    } else {
        None
    };
    if modern {
        if let Some(response) = crate::server::mcp_events::handle_http_jsonrpc(
            &state.conversations,
            &agent_id,
            &resolved.caller,
            node_bound,
            event_authorization_expires_at,
            thread_events_allowed,
            &parsed,
        )
        .await
        {
            let mut output = Json(response).into_response();
            if let Some(version) = response_version {
                if let Ok(value) = HeaderValue::from_str(version) {
                    output.headers_mut().insert("MCP-Protocol-Version", value);
                }
            }
            return output;
        }
    }

    // One message in, at most one response out: a notification (no `id`) is
    // answered with nothing at all, which on HTTP is `202 Accepted` and an empty
    // body. A request is answered with a single JSON object — never a 1-element
    // array, which is what a host that sent an object expects back.
    // Bind the verified member around the dispatch so the org tool policy
    // applies their member layer and guardrails, as `/api/mcp/tools/call` does.
    let dispatch = crate::sidecar::adapters::mcp_bridge::serve_http_jsonrpc_versioned_with_headers(
        Arc::clone(&state.mcp),
        agent_id,
        allowlist,
        identity_profile_ids,
        &parsed,
        modern,
        &headers,
    );
    let response =
        super::verified_dispatch::dispatch_as_verified_caller(resolved.caller.as_ref(), dispatch)
            .await;
    let mut output = match response {
        Some(response)
            if response
                .pointer("/error/code")
                .and_then(serde_json::Value::as_i64)
                == Some(MCP_HEADER_MISMATCH) =>
        {
            (StatusCode::BAD_REQUEST, Json(response)).into_response()
        }
        Some(response) => Json(response).into_response(),
        None => StatusCode::ACCEPTED.into_response(),
    };
    if let Some(version) = response_version {
        if let Ok(value) = HeaderValue::from_str(version) {
            output.headers_mut().insert("MCP-Protocol-Version", value);
        }
    }
    output
}
