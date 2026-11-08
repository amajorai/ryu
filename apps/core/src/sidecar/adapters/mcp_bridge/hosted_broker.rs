//! Credential-broker tools on the network transport (`POST /mcp/:agent_id`).
//!
//! `ryu_broker_discover`, `ryu_broker_propose` and `ryu_broker_proposal` are
//! offered only on the hosted endpoint, and only when the MCP request carries
//! the agent's own broker credential (`x-ryu-vault-token` or
//! `x-ryu-broker-session`); the in-process ACP plane never lists them. The
//! credential, not the node bearer, is the authority: the calls run through the
//! broker's agent routes and the vault request layer, from the MCP request's
//! client address ([`crate::server::vault_broker_api::hosted_mcp`]).
//!
//! The agent's own gates still apply first: an explicit tool allowlist must
//! name each tool (or `*`), and the agent's lifecycle and safety posture
//! ([`crate::agent_execution::ensure_tool_allowed_with_metadata`]) must admit it,
//! so a verified-plan-only or paused agent is offered and served none of them.

use super::*;
use crate::server::vault_broker_api::hosted_mcp;

fn allowlisted(allowlist: Option<&[String]>, name: &str) -> bool {
    allowlist.is_none_or(|entries| entries.iter().any(|entry| entry == "*" || entry == name))
}

/// The agent's lifecycle and safety posture: a verified-plan-only agent gets
/// none of these tools, and a read-only or trial agent may only read.
async fn posture_allows(mcp: &McpRegistry, agent_id: &str, tool: &hosted_mcp::HostedTool) -> bool {
    let Some(store) = mcp.agent_store.as_ref() else {
        return true;
    };
    let Ok(Some(record)) = store.get(agent_id).await else {
        return false;
    };
    record.safety_profile != crate::agents::AgentSafetyProfile::VerifiedPlanOnly
        && crate::agent_execution::ensure_tool_allowed_for_record_with_metadata(
            &record,
            tool.name,
            None,
            Some(tool.http_method()),
        )
        .is_ok()
}

/// The hosted broker tools this request may use, with the credential headers
/// to call them. Empty when the request carries no broker credential.
pub(super) async fn offered(
    mcp: &McpRegistry,
    agent_id: &str,
    allowlist: Option<&[String]>,
    headers: &axum::http::HeaderMap,
) -> (Vec<hosted_mcp::HostedTool>, Option<axum::http::HeaderMap>) {
    let Some(credentials) = hosted_mcp::agent_headers(headers) else {
        return (Vec::new(), None);
    };
    let mut tools = Vec::new();
    for tool in hosted_mcp::tools() {
        if allowlisted(allowlist, tool.name) && posture_allows(mcp, agent_id, &tool).await {
            tools.push(tool);
        }
    }
    (tools, Some(credentials))
}

/// Answer a `tools/call` for a hosted broker tool, or `None` for any other
/// message (which then goes to the registry as usual).
pub(super) async fn intercept_call(
    mcp: &McpRegistry,
    agent_id: &str,
    allowlist: Option<&[String]>,
    message: &Value,
    modern: bool,
    headers: &axum::http::HeaderMap,
) -> Option<Value> {
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || message.get("method").and_then(Value::as_str) != Some("tools/call")
    {
        return None;
    }
    let id = message.get("id")?.clone();
    let params = message.get("params")?;
    let name = params.get("name").and_then(Value::as_str)?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if name == "describe" {
        let described = super::hosted_broker_catalog::intercept_describe(
            mcp, agent_id, allowlist, &arguments, headers,
        )
        .await?;
        let result = json!({
            "content": [{ "type": "text", "text": described.to_string() }],
            "isError": false,
        });
        return Some(rpc_ok(id, with_modern_result(result, modern)));
    }
    if !hosted_mcp::is_tool(name) {
        return None;
    }
    let (tools, credentials) = offered(mcp, agent_id, allowlist, headers).await;
    let outcome = match credentials {
        None => Err(format!(
            "{name} needs the agent's broker credential on the MCP request: an \
             {} header with its rvb_ session, or an x-ryu-vault-token machine token",
            hosted_mcp::BROKER_SESSION_HEADER
        )),
        Some(_) if !tools.iter().any(|tool| tool.name == name) => {
            Err(format!("tool '{name}' is not allowed for this agent"))
        }
        Some(credentials) => {
            let client = hosted_mcp::HostedClient::of_request(headers);
            hosted_mcp::call(name, arguments, credentials, client).await
        }
    };
    let result = match outcome {
        Ok(value) => json!({
            "content": [{
                "type": "text",
                "text": serde_json::to_string_pretty(&value).unwrap_or_default(),
            }],
            "isError": false,
        }),
        Err(message) => json!({
            "content": [{ "type": "text", "text": message }],
            "isError": true,
        }),
    };
    Some(rpc_ok(id, with_modern_result(result, modern)))
}

/// Add the offered hosted broker tools to a `tools/list` answer.
pub(super) async fn extend_list(
    mcp: &McpRegistry,
    agent_id: &str,
    allowlist: Option<&[String]>,
    message: &Value,
    headers: &axum::http::HeaderMap,
    mut response: Option<Value>,
) -> Option<Value> {
    if message.get("method").and_then(Value::as_str) != Some("tools/list") {
        return response;
    }
    let (tools, _) = offered(mcp, agent_id, allowlist, headers).await;
    if tools.is_empty() {
        return response;
    }
    let Some(listed) = response
        .as_mut()
        .and_then(|response| response.pointer_mut("/result/tools"))
        .and_then(Value::as_array_mut)
    else {
        return response;
    };
    listed.extend(tools.iter().map(hosted_mcp::HostedTool::listing));
    listed.sort_by(|left, right| {
        let name = |tool: &Value| tool["name"].as_str().unwrap_or_default().to_owned();
        name(left).cmp(&name(right))
    });
    response
}

#[cfg(test)]
#[path = "hosted_broker_tests.rs"]
mod tests;
