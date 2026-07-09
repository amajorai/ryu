//! Built-in Research tool provider — drives the autoresearch sidecar.
//!
//! Surfaces the research sidecar's HTTP contract (`apps/research-sidecar`, Python
//! stdlib on :8087) as callable tools through the same registry call surface the
//! rest of the tool loop uses (`McpRegistry::list_all_tools` / `call_tool`), so a
//! workflow `agent`/`tool` node can run the loop: init a workspace, read/edit the
//! mutable files, run one attempt, keep-if-improved-else-reset, and log the
//! ledger. Tool ids keep the registry's `<server>__<tool>` scheme
//! (`research__run`) so the allowlist, listing, and single `call_tool` entry all
//! work for free.
//!
//! ## Architecture (Core-vs-Gateway)
//!
//! Deciding *what runs* (which experiment) is Core, so this provider lives here.
//! It is an HTTP-backed provider (like Shadow): dispatch forwards to the sidecar.
//!
//! ## Graceful degradation
//!
//! Every tool is always *listed* so an agent can discover it. A call returns a
//! structured `{ available: false, reason }` result (never `Err`) when the sidecar
//! is not running, so the agent's turn continues (mirrors `spider.rs`).

use anyhow::Result;
use serde_json::{json, Value};

use super::RegistryTool;
use crate::sidecar::tools::research::research_base_url;

/// Reserved registry server name for the built-in Research provider.
pub const SERVER_NAME: &str = "research";

/// A structured "sidecar unavailable" result. Returned (as `Ok`) instead of an
/// error so a stopped sidecar does not abort the agent's turn.
fn unavailable(reason: impl Into<String>) -> Value {
    json!({
        "available": false,
        "reason": reason.into(),
        "hint": "Install the Research sidecar from the Store (or run `python -m ryu_research`) to enable autoresearch."
    })
}

fn tool(name: &str, description: &str, schema: Value) -> RegistryTool {
    RegistryTool {
        id: format!("{SERVER_NAME}__{name}"),
        server: SERVER_NAME.to_owned(),
        name: name.to_owned(),
        description: Some(description.to_owned()),
        input_schema: Some(schema),
    }
}

fn ws_prop() -> Value {
    json!({ "type": "string", "description": "The workspace id returned by init_workspace." })
}

/// The set of Research tools exposed through the registry.
pub fn tools() -> Vec<RegistryTool> {
    vec![
        tool(
            "list_experiments",
            "List the available autoresearch experiment kinds (id, gpu_required, budget_s, mutable_files).",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        tool(
            "init_workspace",
            "Create a fresh git-versioned workspace for an experiment kind. Returns workspace_id, the mutable_files you may edit, and program_md (the researcher instructions).",
            json!({
                "type": "object",
                "properties": { "experiment": { "type": "string", "description": "Experiment kind id, e.g. 'toy' or 'nanochat'." } },
                "required": ["experiment"]
            }),
        ),
        tool(
            "read_file",
            "Read a file from the workspace (typically a mutable train.py).",
            json!({
                "type": "object",
                "properties": { "workspace_id": ws_prop(), "path": { "type": "string", "description": "Workspace-relative file path." } },
                "required": ["workspace_id", "path"]
            }),
        ),
        tool(
            "write_file",
            "Overwrite a file in the workspace with new content (your proposed edit).",
            json!({
                "type": "object",
                "properties": {
                    "workspace_id": ws_prop(),
                    "path": { "type": "string", "description": "Workspace-relative file path." },
                    "content": { "type": "string", "description": "Full new file content." }
                },
                "required": ["workspace_id", "path", "content"]
            }),
        ),
        tool(
            "run",
            "Commit the current state and run one experiment attempt under a wall-clock budget. Returns {score (lower=better, or null), memory_gb, status: ok|crash|timeout, commit, logs_tail}.",
            json!({
                "type": "object",
                "properties": {
                    "workspace_id": ws_prop(),
                    "budget_s": { "type": "integer", "description": "Optional wall-clock cap in seconds; defaults to the experiment's budget_s." }
                },
                "required": ["workspace_id"]
            }),
        ),
        tool(
            "keep",
            "Keep the last attempt (advance the git ledger). Use when the score improved.",
            json!({ "type": "object", "properties": { "workspace_id": ws_prop() }, "required": ["workspace_id"] }),
        ),
        tool(
            "reset",
            "Discard the last attempt (git reset --hard HEAD~1). Use when the score did not improve, or the run crashed/timed out.",
            json!({ "type": "object", "properties": { "workspace_id": ws_prop() }, "required": ["workspace_id"] }),
        ),
        tool(
            "ledger",
            "Read the results ledger (no extra fields), OR append a row when commit/score/memory_gb/status/description are provided. Lower score = better.",
            json!({
                "type": "object",
                "properties": {
                    "workspace_id": ws_prop(),
                    "commit": { "type": "string", "description": "Commit sha of the attempt (append mode)." },
                    "score": { "type": "number", "description": "Parsed metric, lower=better (append mode)." },
                    "memory_gb": { "type": "number", "description": "Peak memory of the attempt (append mode)." },
                    "status": { "type": "string", "description": "ok|crash|timeout (append mode)." },
                    "description": { "type": "string", "description": "What the attempt changed + its outcome (append mode)." }
                },
                "required": ["workspace_id"]
            }),
        ),
    ]
}

/// Dispatch a Research tool call by forwarding to the sidecar over HTTP.
///
/// `tool` is the bare tool name (already stripped of the `research__` prefix by
/// the registry). Never returns `Err` for a merely-unreachable sidecar — that
/// becomes an `available: false` result so the tool loop continues. `Err` is
/// reserved for genuinely malformed calls (unknown tool, missing argument).
pub async fn dispatch(client: &reqwest::Client, tool: &str, arguments: Value) -> Result<Value> {
    let base = research_base_url();
    match tool {
        "list_experiments" => get(client, &format!("{base}/experiments")).await,
        "init_workspace" => {
            let experiment = require_string(&arguments, "experiment")?;
            post(client, &format!("{base}/workspace/init"), json!({ "experiment": experiment })).await
        }
        "read_file" => {
            let ws = require_string(&arguments, "workspace_id")?;
            let path = require_string(&arguments, "path")?;
            get(
                client,
                &format!("{base}/workspace/{ws}/file?path={}", urlencoding_encode(&path)),
            )
            .await
        }
        "write_file" => {
            let ws = require_string(&arguments, "workspace_id")?;
            let path = require_string(&arguments, "path")?;
            let content = arguments
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            put(
                client,
                &format!("{base}/workspace/{ws}/file"),
                json!({ "path": path, "content": content }),
            )
            .await
        }
        "run" => {
            let ws = require_string(&arguments, "workspace_id")?;
            let mut body = json!({});
            if let Some(b) = arguments.get("budget_s") {
                body["budget_s"] = b.clone();
            }
            post(client, &format!("{base}/workspace/{ws}/run"), body).await
        }
        "keep" => git_action(client, &base, &arguments, "advance").await,
        "reset" => git_action(client, &base, &arguments, "reset").await,
        "ledger" => {
            let ws = require_string(&arguments, "workspace_id")?;
            // Append mode when the caller supplies a commit/score/status; else read.
            let appends = arguments.get("commit").is_some()
                || arguments.get("score").is_some()
                || arguments.get("status").is_some();
            if appends {
                let body = json!({
                    "commit": arguments.get("commit").cloned().unwrap_or(json!("")),
                    "score": arguments.get("score").cloned().unwrap_or(Value::Null),
                    "memory_gb": arguments.get("memory_gb").cloned().unwrap_or(Value::Null),
                    "status": arguments.get("status").cloned().unwrap_or(json!("")),
                    "description": arguments.get("description").cloned().unwrap_or(json!("")),
                });
                post(client, &format!("{base}/workspace/{ws}/ledger"), body).await
            } else {
                get(client, &format!("{base}/workspace/{ws}/ledger")).await
            }
        }
        other => Err(anyhow::anyhow!("unknown Research tool '{other}'")),
    }
}

async fn git_action(
    client: &reqwest::Client,
    base: &str,
    arguments: &Value,
    action: &str,
) -> Result<Value> {
    let ws = require_string(arguments, "workspace_id")?;
    post(
        client,
        &format!("{base}/workspace/{ws}/git"),
        json!({ "action": action }),
    )
    .await
}

async fn get(client: &reqwest::Client, url: &str) -> Result<Value> {
    match client.get(url).send().await {
        Ok(r) => parse(r).await,
        Err(e) => Ok(unavailable(format!("research sidecar not reachable: {e}"))),
    }
}

async fn post(client: &reqwest::Client, url: &str, body: Value) -> Result<Value> {
    match client.post(url).json(&body).send().await {
        Ok(r) => parse(r).await,
        Err(e) => Ok(unavailable(format!("research sidecar not reachable: {e}"))),
    }
}

async fn put(client: &reqwest::Client, url: &str, body: Value) -> Result<Value> {
    match client.put(url).json(&body).send().await {
        Ok(r) => parse(r).await,
        Err(e) => Ok(unavailable(format!("research sidecar not reachable: {e}"))),
    }
}

async fn parse(resp: reqwest::Response) -> Result<Value> {
    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let value: Value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| json!({ "raw": String::from_utf8_lossy(&bytes) }));
    if !status.is_success() {
        // Surface the sidecar's error body but keep the turn alive.
        return Ok(json!({
            "available": true,
            "error": format!("research sidecar returned {status}"),
            "detail": value
        }));
    }
    Ok(value)
}

/// Minimal percent-encoding for a query value (path arg). Encodes the handful of
/// characters that matter for a `?path=` value; keeps the dep surface at zero.
fn urlencoding_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn require_string(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("missing required string argument '{key}'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_eight_research_tools_with_qualified_ids() {
        let tools = tools();
        assert_eq!(tools.len(), 8);
        assert!(tools.iter().all(|t| t.server == SERVER_NAME));
        assert!(tools.iter().all(|t| t.id.starts_with("research__")));
        assert!(tools.iter().any(|t| t.name == "run"));
        assert!(tools.iter().any(|t| t.name == "init_workspace"));
    }

    #[tokio::test]
    async fn unknown_tool_is_an_error() {
        let client = reqwest::Client::new();
        assert!(dispatch(&client, "does_not_exist", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn missing_argument_is_an_error() {
        let client = reqwest::Client::new();
        assert!(dispatch(&client, "init_workspace", json!({})).await.is_err());
        assert!(dispatch(&client, "run", json!({})).await.is_err());
    }

    #[test]
    fn encodes_query_values() {
        assert_eq!(urlencoding_encode("train.py"), "train.py");
        assert_eq!(urlencoding_encode("a b"), "a%20b");
        assert_eq!(urlencoding_encode("x=1&y"), "x%3D1%26y");
    }
}
