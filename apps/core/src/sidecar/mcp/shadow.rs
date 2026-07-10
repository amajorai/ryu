//! Built-in Shadow tool provider (U15).
//!
//! `apps/shadow` + `crates/shadow-core` is a built-but-orphaned screen/audio/input
//! capture + search engine that exposes an HTTP API on `:3030` (Windows-first).
//! This module surfaces Shadow's capture/search capabilities as callable tools
//! through the *same* registry call surface the rest of the tool loop uses
//! (`McpRegistry::list_all_tools` / `call_tool`), so an agent can search what the
//! user has seen and done without any per-user MCP wiring.
//!
//! Placement (CLAUDE.md §1): deciding *what tools run* is Core, so this provider
//! lives in Core next to the MCP registry. It is not an MCP stdio server — Shadow
//! is a long-lived HTTP service — so rather than shipping a stdio→HTTP bridge
//! binary we register Shadow as a reserved server name inside the registry and
//! dispatch its tool calls over HTTP. Tool ids keep the registry's
//! `<server>__<tool>` scheme (`shadow__search`, …) so the allowlist, listing, and
//! single `call_tool` entry all work for free.
//!
//! Windows-first: Shadow's capture stack is Windows-first. The tools are always
//! *listed* so an agent can discover them on any platform; a call simply returns
//! a structured `{ available: false, reason }` result when Shadow is unreachable
//! (not running, or capture unsupported on this OS) instead of erroring out and
//! aborting the agent's turn.

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;

/// Reserved registry server name for the built-in Shadow provider. A user MCP
/// config entry with this name would collide, so the registry treats it as
/// reserved (the built-in provider wins).
pub const SERVER_NAME: &str = "shadow";

/// Default Shadow base URL. Shadow listens on `127.0.0.1:3030` (overridable via
/// its own `SHADOW_PORT`). Override the whole base here with `RYU_SHADOW_URL`.
const DEFAULT_BASE_URL: &str = "http://127.0.0.1:3030";

/// How long to wait for Shadow before declaring it unavailable. Kept short so a
/// stopped Shadow doesn't stall an agent's turn.
const REQUEST_TIMEOUT_SECS: u64 = 10;

/// Resolve the Shadow base URL: `RYU_SHADOW_URL` if set, else the default.
fn base_url() -> String {
    std::env::var("RYU_SHADOW_URL").unwrap_or_else(|_| DEFAULT_BASE_URL.to_owned())
}

/// The set of Shadow tools exposed through the registry. Each maps to a Shadow
/// HTTP endpoint. Kept as a const table so listing needs no I/O and stays in
/// sync with `dispatch`.
struct ShadowToolDef {
    name: &'static str,
    description: &'static str,
    /// JSON-schema for the tool's arguments (object with properties).
    schema: fn() -> Value,
}

fn search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Text to search for across captured screen/audio/input history." },
            "limit": { "type": "integer", "description": "Max results to return (default 20).", "minimum": 1 }
        },
        "required": ["query"]
    })
}

fn semantic_search_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "query": { "type": "string", "description": "Natural-language query matched semantically against captured history." },
            "limit": { "type": "integer", "description": "Max results to return (default 5).", "minimum": 1 }
        },
        "required": ["query"]
    })
}

fn timeline_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "start": { "type": "integer", "description": "Range start, microseconds since the Unix epoch." },
            "end": { "type": "integer", "description": "Range end, microseconds since the Unix epoch." }
        },
        "required": ["start", "end"]
    })
}

fn recent_context_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "minutes": { "type": "integer", "description": "How many minutes back to summarize (default 10).", "minimum": 1 }
        }
    })
}

const TOOLS: &[ShadowToolDef] = &[
    ShadowToolDef {
        name: "search",
        description: "Full-text search over everything Shadow has captured (screen text, audio transcripts, input). Returns matching timeline entries.",
        schema: search_schema,
    },
    ShadowToolDef {
        name: "semantic_search",
        description: "Semantic (vector) search over captured history. Use for fuzzy, meaning-based recall when exact keywords are unknown.",
        schema: semantic_search_schema,
    },
    ShadowToolDef {
        name: "timeline",
        description: "Fetch captured timeline entries within an explicit time range (microseconds since the Unix epoch).",
        schema: timeline_schema,
    },
    ShadowToolDef {
        name: "recent_context",
        description: "Summarize what the user has been doing in the last N minutes, drawn from captured history.",
        schema: recent_context_schema,
    },
];

/// The Shadow tools as `RegistryTool`s, tagged with the reserved server name.
/// Pure (no I/O), so listing always works regardless of whether Shadow is up.
pub fn tools() -> Vec<RegistryTool> {
    TOOLS
        .iter()
        .map(|t| RegistryTool {
            id: format!("{SERVER_NAME}__{}", t.name),
            server: SERVER_NAME.to_owned(),
            name: t.name.to_owned(),
            description: Some(t.description.to_owned()),
            input_schema: Some((t.schema)()),
            ..Default::default()
        })
        .collect()
}

/// A structured "Shadow is unavailable" tool result. Returned (as `Ok`) instead
/// of an error so a failed/absent Shadow does not abort the agent's turn — the
/// agent sees a clean signal it can reason about and continue.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": "Shadow capture is Windows-first. Ensure the Shadow sidecar is installed and running, then retry."
    })
}

/// Dispatch a Shadow tool call over HTTP. `tool` is the bare tool name (already
/// stripped of the `shadow__` prefix by the registry). Never returns `Err` for a
/// merely-unreachable Shadow: that becomes an `available: false` result so the
/// tool loop continues. `Err` is reserved for genuinely malformed calls
/// (unknown tool, bad arguments).
pub async fn dispatch(client: &reqwest::Client, tool: &str, arguments: Value) -> Result<Value> {
    let base = base_url();
    match tool {
        "search" => {
            let query = require_string(&arguments, "query")?;
            let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(20);
            get_json(
                client,
                &format!("{base}/search"),
                &[("q", query), ("limit", limit.to_string())],
            )
            .await
        }
        "semantic_search" => {
            let query = require_string(&arguments, "query")?;
            let limit = arguments.get("limit").and_then(Value::as_u64).unwrap_or(5);
            get_json(
                client,
                &format!("{base}/search/semantic"),
                &[("q", query), ("limit", limit.to_string())],
            )
            .await
        }
        "timeline" => {
            let start = require_u64(&arguments, "start")?;
            let end = require_u64(&arguments, "end")?;
            get_json(
                client,
                &format!("{base}/timeline"),
                &[("start", start.to_string()), ("end", end.to_string())],
            )
            .await
        }
        "recent_context" => {
            let minutes = arguments
                .get("minutes")
                .and_then(Value::as_u64)
                .unwrap_or(10);
            // Shadow's /context/recent reuses the search query param `q` as the
            // minute window (see apps/shadow/src/server.rs recent_context_handler).
            get_json(
                client,
                &format!("{base}/context/recent"),
                &[("q", minutes.to_string())],
            )
            .await
        }
        other => Err(anyhow::anyhow!("unknown Shadow tool '{other}'")),
    }
}

/// GET a Shadow endpoint with query params and parse the JSON body. A transport
/// failure (Shadow down/unreachable) is mapped to an `available: false` result,
/// not an error.
async fn get_json(client: &reqwest::Client, url: &str, query: &[(&str, String)]) -> Result<Value> {
    let resp = client
        .get(url)
        .query(query)
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(e) => return Ok(unavailable(format!("Shadow is not reachable: {e}"))),
    };

    if !resp.status().is_success() {
        let status = resp.status();
        return Ok(unavailable(format!("Shadow returned HTTP {status}")));
    }

    match resp.json::<Value>().await {
        Ok(body) => Ok(body),
        Err(e) => Ok(unavailable(format!(
            "Shadow returned an invalid response: {e}"
        ))),
    }
}

fn require_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

fn require_u64(args: &Value, key: &str) -> Result<u64> {
    args.get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| anyhow::anyhow!("missing required integer argument '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_all_shadow_tools_with_qualified_ids() {
        let tools = tools();
        assert_eq!(tools.len(), 4);
        let ids: Vec<&str> = tools.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"shadow__search"));
        assert!(ids.contains(&"shadow__semantic_search"));
        assert!(ids.contains(&"shadow__timeline"));
        assert!(ids.contains(&"shadow__recent_context"));
        for t in &tools {
            assert_eq!(t.server, SERVER_NAME);
            assert!(t.input_schema.is_some());
            assert!(t.description.is_some());
        }
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let client = reqwest::Client::new();
        let err = dispatch(&client, "does_not_exist", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn missing_required_argument_is_an_error() {
        let client = reqwest::Client::new();
        let err = dispatch(&client, "search", json!({})).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn unreachable_shadow_yields_unavailable_not_error() {
        // Point at a port nothing is listening on so the request fails fast.
        // SAFETY: single-threaded test process; we set then immediately use.
        unsafe {
            std::env::set_var("RYU_SHADOW_URL", "http://127.0.0.1:1");
        }
        let client = reqwest::Client::new();
        let result = dispatch(&client, "search", json!({ "query": "hello" }))
            .await
            .expect("unreachable Shadow must not be an error");
        assert_eq!(
            result.get("available").and_then(Value::as_bool),
            Some(false)
        );
        assert!(result.get("reason").is_some());
        unsafe {
            std::env::remove_var("RYU_SHADOW_URL");
        }
    }

    #[test]
    fn unavailable_result_shape() {
        let v = unavailable("down");
        assert_eq!(v["available"], json!(false));
        assert_eq!(v["reason"], json!("down"));
    }
}
