//! `tool_search` and `describe` for the hosted broker tools.
//!
//! The broker tools are not registry rows: they exist only on `POST
//! /mcp/:agent_id`, and only for a request that carries the agent's broker
//! credential ([`super::hosted_broker::offered`]). The registry's catalog never
//! sees them, so without this module an agent that follows the transport's own
//! instructions (find a capability with `tool_search`, read its arguments with
//! `describe`) could not find the tools the broker's `403` `proposalHint` names.
//!
//! Both meta-tools consult the same `offered` set the listing uses, so a tool is
//! findable exactly when it is listed and callable: no credential, a narrower
//! allowlist, or a verified-plan-only or read-only posture hides it here too.

use super::*;
use crate::server::vault_broker_api::hosted_mcp;

/// Words too common to count as a match on their own.
const STOPWORDS: &[&str] = &[
    "a", "an", "and", "any", "are", "for", "from", "how", "its", "the", "this", "that", "with",
    "use", "what", "when", "which", "who", "why", "you", "can", "get", "may", "not", "or", "of",
    "to", "in", "on", "is", "it", "by", "be", "as", "at", "if", "do",
];

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| word.len() >= 2)
        .map(str::to_ascii_lowercase)
        .filter(|word| !STOPWORDS.contains(&word.as_str()))
}

/// The share of the query's words a tool's name or description contains, in
/// `(0, 1]`, or `None` when it shares none. An empty query matches everything.
pub(super) fn score(tool: &hosted_mcp::HostedTool, query: &str) -> Option<f32> {
    let haystack: Vec<String> = words(tool.name).chain(words(tool.description)).collect();
    let needles: Vec<String> = words(query).collect();
    if needles.is_empty() {
        return query.trim().is_empty().then_some(0.0);
    }
    let hits = needles
        .iter()
        .filter(|needle| {
            haystack
                .iter()
                .any(|word| word.starts_with(needle.as_str()))
        })
        .count();
    (hits > 0).then(|| hits as f32 / needles.len() as f32)
}

/// The catalog row of one hosted broker tool. Its id is the name the tool is
/// called by on this transport.
pub(super) fn descriptor(
    tool: &hosted_mcp::HostedTool,
    score: Option<f32>,
) -> ryu_tool_registry::ToolDescriptor {
    let (arg_names, arg_descriptions) = ryu_tool_registry::arg_summary(Some(&tool.input_schema));
    ryu_tool_registry::ToolDescriptor {
        id: tool.name.to_owned(),
        name: tool.name.to_owned(),
        description: tool.description.to_owned(),
        kind: ToolKind::Builtin,
        arg_names,
        arg_descriptions,
        score,
        meta: None,
        widget_accessible: false,
        output_template: None,
    }
}

/// The `describe` answer for one hosted broker tool.
pub(super) fn described(tool: &hosted_mcp::HostedTool) -> ryu_tool_registry::DescribedTool {
    ryu_tool_registry::DescribedTool {
        id: tool.name.to_owned(),
        name: tool.name.to_owned(),
        description: tool.description.to_owned(),
        kind: ToolKind::Builtin,
        args: ryu_tool_registry::described_args(Some(&tool.input_schema)),
        shallow: false,
        parameters: Some(tool.input_schema.clone()),
        read_only: tool.read_only,
    }
}

/// Answer `describe` for an offered hosted broker tool, or `None` so any other
/// id (and a broker tool this request may not use) goes to the registry, which
/// answers it as unknown.
pub(super) async fn intercept_describe(
    mcp: &McpRegistry,
    agent_id: &str,
    allowlist: Option<&[String]>,
    arguments: &Value,
    headers: &axum::http::HeaderMap,
) -> Option<Value> {
    let id = arguments.get("id").and_then(Value::as_str)?;
    if !hosted_mcp::is_tool(id) {
        return None;
    }
    let (tools, _) = super::hosted_broker::offered(mcp, agent_id, allowlist, headers).await;
    let tool = tools.iter().find(|tool| tool.name == id)?;
    serde_json::to_value(described(tool)).ok()
}

fn tool_call<'a>(message: &'a Value, tool: &str) -> Option<&'a Value> {
    if message.get("method").and_then(Value::as_str) != Some("tools/call") {
        return None;
    }
    let params = message.get("params")?;
    (params.get("name").and_then(Value::as_str) == Some(tool))
        .then(|| params.get("arguments").unwrap_or(&Value::Null))
}

/// Add the offered hosted broker tools that match a `tool_search` call to its
/// successful answer. Matches lead the results; the requested limit still holds.
pub(super) async fn extend_search(
    mcp: &McpRegistry,
    agent_id: &str,
    allowlist: Option<&[String]>,
    message: &Value,
    headers: &axum::http::HeaderMap,
    mut response: Option<Value>,
) -> Option<Value> {
    let Some(arguments) = tool_call(message, "tool_search") else {
        return response;
    };
    let kind = arguments
        .get("kind")
        .and_then(Value::as_str)
        .and_then(ToolKind::parse_filter);
    if kind.is_some_and(|kind| kind != ToolKind::Builtin) {
        return response;
    }
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, TOOL_SEARCH_MAX_LIMIT))
        .unwrap_or(TOOL_SEARCH_DEFAULT_LIMIT);
    let Some(result) = response.as_mut().and_then(|r| r.get_mut("result")) else {
        return response;
    };
    if result.get("isError").and_then(Value::as_bool) != Some(false) {
        return response;
    }
    let Some(text) = result.pointer_mut("/content/0/text") else {
        return response;
    };
    let Some(Ok(mut envelope)) = text.as_str().map(serde_json::from_str::<Value>) else {
        return response;
    };
    let Some(registry_rows) = envelope.get_mut("results").and_then(Value::as_array_mut) else {
        return response;
    };
    let (tools, _) = super::hosted_broker::offered(mcp, agent_id, allowlist, headers).await;
    let mut matches: Vec<(f32, Value)> = tools
        .iter()
        .filter_map(|tool| {
            let score = score(tool, query)?;
            serde_json::to_value(descriptor(tool, Some(score)))
                .ok()
                .map(|row| (score, row))
        })
        .collect();
    if matches.is_empty() {
        return response;
    }
    matches.sort_by(|left, right| right.0.total_cmp(&left.0));
    let mut merged: Vec<Value> = matches.into_iter().map(|(_, row)| row).collect();
    merged.extend(
        registry_rows
            .drain(..)
            .filter(|row| !row["id"].as_str().is_some_and(hosted_mcp::is_tool)),
    );
    merged.truncate(limit);
    *registry_rows = merged;
    *text = Value::String(envelope.to_string());
    response
}

#[cfg(test)]
#[path = "hosted_broker_catalog_tests.rs"]
mod tests;
