//! JSON-RPC metadata of brokered MCP traffic.
//!
//! A request body that is JSON-RPC 2.0 (a single message or a batch) yields
//! the method, the request id and, for `tools/call`, the tool name. Nothing
//! else is read: `params.arguments`, results, and every other field may carry
//! secrets and never leave the body. Bodies are parsed as the agent sent them
//! (placeholders, before substitution), so a substituted value cannot appear
//! here either.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Largest body parsed for metadata; larger bodies are not inspected.
pub const MAX_PARSE_BYTES: usize = 1024 * 1024;
/// Most messages recorded from one batch.
pub const MAX_CALLS: usize = 16;
const MAX_FIELD_LEN: usize = 128;

/// One JSON-RPC message's metadata.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcCall {
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The tool a `tools/call` names.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
}

/// Keep a short, printable identifier; anything else is dropped.
fn clean(text: &str) -> Option<String> {
    let text = text.trim();
    if text.is_empty()
        || text.len() > MAX_FIELD_LEN
        || !text.chars().all(|c| c.is_ascii_graphic() || c == ' ')
    {
        return None;
    }
    Some(text.to_owned())
}

fn call(message: &Value) -> Option<RpcCall> {
    let object = message.as_object()?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return None;
    }
    let method = clean(object.get("method")?.as_str()?)?;
    let id = match object.get("id") {
        Some(Value::String(id)) => clean(id),
        Some(Value::Number(id)) => Some(id.to_string()),
        _ => None,
    };
    let tool = (method == "tools/call")
        .then(|| object.get("params")?.get("name")?.as_str().and_then(clean))
        .flatten();
    Some(RpcCall { method, id, tool })
}

/// Whether a `Content-Type` is JSON (`application/json`, `…+json`).
pub(crate) fn is_json(content_type: Option<&str>) -> bool {
    content_type
        .and_then(|value| value.split(';').next())
        .map(|essence| essence.trim().to_ascii_lowercase())
        .is_some_and(|essence| essence == "application/json" || essence.ends_with("+json"))
}

/// The JSON-RPC calls in a request body, if it is uncompressed JSON-RPC.
pub fn parse(
    content_type: Option<&str>,
    content_encoding: Option<&str>,
    body: &[u8],
) -> Vec<RpcCall> {
    let encoded = content_encoding
        .map(str::trim)
        .is_some_and(|encoding| !encoding.is_empty() && !encoding.eq_ignore_ascii_case("identity"));
    if encoded || body.is_empty() || body.len() > MAX_PARSE_BYTES || !is_json(content_type) {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return Vec::new();
    };
    match &value {
        Value::Array(batch) => batch.iter().filter_map(call).take(MAX_CALLS).collect(),
        message => call(message).into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: Option<&str> = Some("application/json; charset=utf-8");

    #[test]
    fn tool_calls_yield_the_tool_and_id_but_never_arguments() {
        let body = br#"{"jsonrpc":"2.0","id":7,"method":"tools/call",
            "params":{"name":"create_issue","arguments":{"token":"__GH_TOKEN__","body":"secret"}}}"#;
        let calls = parse(JSON, None, body);
        assert_eq!(
            calls,
            vec![RpcCall {
                method: "tools/call".into(),
                id: Some("7".into()),
                tool: Some("create_issue".into()),
            }]
        );
        let serialized = serde_json::to_string(&calls).unwrap();
        assert!(!serialized.contains("__GH_TOKEN__"));
        assert!(!serialized.contains("secret"));
    }

    #[test]
    fn batches_and_other_methods_are_recorded_without_tools() {
        let body = br#"[{"jsonrpc":"2.0","id":"a","method":"initialize","params":{}},
            {"jsonrpc":"2.0","method":"notifications/initialized"},
            {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search"}}]"#;
        let calls = parse(Some("application/json"), None, body);
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[0].id.as_deref(), Some("a"));
        assert_eq!(calls[0].tool, None);
        assert_eq!(calls[1].id, None);
        assert_eq!(calls[2].tool.as_deref(), Some("search"));
    }

    #[test]
    fn non_json_rpc_bodies_yield_nothing() {
        let rpc = br#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        assert!(parse(Some("text/plain"), None, rpc).is_empty());
        assert!(parse(None, None, rpc).is_empty());
        assert!(parse(JSON, Some("gzip"), rpc).is_empty());
        assert_eq!(parse(JSON, Some("identity"), rpc).len(), 1);
        assert!(parse(JSON, None, br#"{"method":"tools/list"}"#).is_empty());
        assert!(parse(JSON, None, b"not json").is_empty());
        let huge = vec![b' '; MAX_PARSE_BYTES + 1];
        assert!(parse(JSON, None, &huge).is_empty());
        assert_eq!(parse(Some("application/vnd.api+json"), None, rpc).len(), 1);
    }

    #[test]
    fn odd_names_and_ids_are_dropped_and_batches_are_capped() {
        let long = "x".repeat(MAX_FIELD_LEN + 1);
        let body = format!(
            r#"{{"jsonrpc":"2.0","id":"{long}","method":"tools/call","params":{{"name":"a\nb"}}}}"#
        );
        let calls = parse(JSON, None, body.as_bytes());
        assert_eq!(calls[0].id, None);
        assert_eq!(calls[0].tool, None);
        let batch: Vec<String> = (0..40)
            .map(|id| format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"ping"}}"#))
            .collect();
        let body = format!("[{}]", batch.join(","));
        assert_eq!(parse(JSON, None, body.as_bytes()).len(), MAX_CALLS);
    }
}
