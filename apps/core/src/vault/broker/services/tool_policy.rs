//! Per-tool MCP allow and deny lists for a broker service.
//!
//! A service that fronts an MCP server may name the tools agents may call
//! through it. The broker reads every JSON-RPC message of a request body (as
//! the agent sent it, before substitution) and refuses the whole request when
//! any `tools/call` names a tool the policy does not permit, before a
//! credential is resolved. A body the broker cannot read (compressed, too
//! large, not JSON, not JSON-RPC) is refused while a policy is set, so a
//! policy cannot be stepped around by encoding the body.
//!
//! A pattern is an exact tool name or a prefix ending in `*` (`github_*`).
//! Deny wins over allow. An absent `allow` permits every tool not denied; an
//! empty `allow` permits none.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Most patterns in one list.
pub const MAX_PATTERNS: usize = 256;
const MAX_PATTERN_LEN: usize = 128;
/// Largest body inspected for tool calls; larger bodies are refused.
pub const MAX_INSPECT_BYTES: usize = 1024 * 1024;

/// Which MCP tools a service lets agents call.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolPolicy {
    /// Tools agents may call; `None` permits every tool not denied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allow: Option<Vec<String>>,
    /// Tools agents may never call.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub deny: Vec<String>,
}

fn valid_pattern(pattern: &str) -> bool {
    let bare = pattern.strip_suffix('*').unwrap_or(pattern);
    !pattern.is_empty()
        && pattern.len() <= MAX_PATTERN_LEN
        && !bare.contains('*')
        && pattern.chars().all(|c| c.is_ascii_graphic())
}

fn matches(pattern: &str, tool: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => tool.starts_with(prefix),
        None => pattern == tool,
    }
}

impl McpToolPolicy {
    /// Check pattern shape and list sizes, and sort and dedup both lists.
    pub fn normalize(mut self) -> Result<Self> {
        for list in self.allow.iter_mut().chain(std::iter::once(&mut self.deny)) {
            if list.len() > MAX_PATTERNS {
                bail!("mcpTools lists hold at most {MAX_PATTERNS} patterns");
            }
            for pattern in list.iter_mut() {
                *pattern = pattern.trim().to_owned();
                if !valid_pattern(pattern) {
                    bail!(
                        "mcpTools pattern `{pattern}` must be a tool name or a prefix ending in `*`"
                    );
                }
            }
            list.sort();
            list.dedup();
        }
        Ok(self)
    }

    /// Whether agents may call `tool`.
    pub fn permits(&self, tool: &str) -> bool {
        if self.deny.iter().any(|pattern| matches(pattern, tool)) {
            return false;
        }
        self.allow
            .as_ref()
            .is_none_or(|allow| allow.iter().any(|pattern| matches(pattern, tool)))
    }
}

/// One `tools/call` in a request body.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    /// The request id exactly as sent (`None` for a notification).
    pub id: Option<Value>,
    /// The tool name, when it is a string.
    pub name: Option<String>,
}

/// Why a body could not be checked against a policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Uninspectable {
    Encoded,
    TooLarge,
    NotJson,
    NotJsonRpc,
}

/// The ids of every message in a body that carries one (for batch errors).
pub fn message_ids(body: &[u8]) -> Vec<Value> {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    let messages = match value {
        Value::Array(batch) => batch,
        message => vec![message],
    };
    messages
        .iter()
        .filter_map(|message| message.get("id").filter(|id| !id.is_null()).cloned())
        .collect()
}

/// Every `tools/call` in a request body. Unlike the logged metadata, this
/// reads every message of a batch, keeps names exactly as sent, and fails on
/// anything it cannot read. An empty body has no calls.
pub fn tool_calls(
    content_type: Option<&str>,
    content_encoding: Option<&str>,
    body: &[u8],
) -> std::result::Result<Vec<ToolCall>, Uninspectable> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let encoded = content_encoding
        .map(str::trim)
        .is_some_and(|encoding| !encoding.is_empty() && !encoding.eq_ignore_ascii_case("identity"));
    if encoded {
        return Err(Uninspectable::Encoded);
    }
    if body.len() > MAX_INSPECT_BYTES {
        return Err(Uninspectable::TooLarge);
    }
    if !super::super::jsonrpc::is_json(content_type) {
        return Err(Uninspectable::NotJson);
    }
    let value: Value = serde_json::from_slice(body).map_err(|_| Uninspectable::NotJson)?;
    let messages = match value {
        Value::Array(batch) => batch,
        message => vec![message],
    };
    let mut calls = Vec::new();
    for message in &messages {
        let object = message.as_object().ok_or(Uninspectable::NotJsonRpc)?;
        match object.get("method") {
            None => continue,
            Some(Value::String(method)) if method == "tools/call" => {}
            Some(Value::String(_)) => continue,
            Some(_) => return Err(Uninspectable::NotJsonRpc),
        }
        calls.push(ToolCall {
            id: object.get("id").filter(|id| !id.is_null()).cloned(),
            name: object
                .get("params")
                .and_then(|params| params.get("name"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        });
    }
    Ok(calls)
}

#[cfg(test)]
#[path = "tool_policy_tests.rs"]
mod tests;
