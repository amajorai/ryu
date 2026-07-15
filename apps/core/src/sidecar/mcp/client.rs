//! Minimal MCP stdio client (JSON-RPC 2.0 over a child process's stdin/stdout).
//!
//! Core already spawns MCP stdio servers (see `tools/ghost/process.rs`); this is
//! the *client* side of the same transport. It implements just the slice the
//! registry needs: `initialize`, `tools/list`, and `tools/call`. The server is
//! spawned per request and torn down when the call completes — MCP stdio servers
//! are cheap to start, and a short-lived connection keeps the registry stateless
//! and crash-safe (a wedged server can never leak a long-lived child).

use std::process::Stdio;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::win_process::NoWindow;

/// The MCP protocol version this client speaks during `initialize`.
const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

/// How long to wait for any single JSON-RPC response before giving up. MCP
/// servers spawned via `npx` can be slow to start, so this is generous.
const RPC_TIMEOUT: Duration = Duration::from_secs(60);

/// A tool advertised by an MCP server (`tools/list` entry).
#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: Option<String>,
    pub input_schema: Option<Value>,
    /// `outputSchema`, verbatim (JSON Schema for `structuredContent`).
    pub output_schema: Option<Value>,
    /// `annotations`, verbatim (MCP tool annotations).
    pub annotations: Option<Value>,
    /// `_meta`, verbatim — carries the Ryu/OpenAI widget keys (`ryu/outputTemplate`,
    /// `openai/outputTemplate`, `ryu/widgetAccessible`, `ryu/toolInvocation`, …).
    pub meta: Option<Value>,
}

/// A resource advertised by an MCP server (`resources/list` entry).
#[derive(Debug, Clone)]
pub struct McpResource {
    pub uri: String,
    pub name: Option<String>,
    pub mime_type: Option<String>,
    pub description: Option<String>,
    pub meta: Option<Value>,
}

/// The contents of one resource read via `resources/read`.
#[derive(Debug, Clone)]
pub struct McpResourceContents {
    pub uri: String,
    pub mime_type: Option<String>,
    /// Text payload (`text` field) when the resource is textual.
    pub text: Option<String>,
    /// Base64 blob (`blob` field) when the resource is binary.
    pub blob: Option<String>,
    pub meta: Option<Value>,
}

/// A typed `tools/call` result that preserves the structured channels an MCP
/// server returns alongside the human-readable `content` (needed for widgets:
/// `structuredContent` feeds `toolOutput`, `_meta` feeds `toolResponseMetadata`).
#[derive(Debug, Clone)]
pub struct McpToolResult {
    /// `structuredContent`, verbatim.
    pub structured_content: Option<Value>,
    /// `content` array, verbatim.
    pub content: Option<Value>,
    /// `_meta`, verbatim.
    pub meta: Option<Value>,
    /// `isError`, defaulting to `false`.
    pub is_error: bool,
    /// The whole raw result value, untouched (what `call_tool` returns today).
    pub raw: Value,
}

impl McpToolResult {
    /// Split a raw `tools/call` result value into its typed channels.
    pub fn from_result_value(raw: Value) -> Self {
        let structured_content = raw.get("structuredContent").cloned();
        let content = raw.get("content").cloned();
        let meta = raw.get("_meta").cloned();
        let is_error = raw
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        Self {
            structured_content,
            content,
            meta,
            is_error,
            raw,
        }
    }
}

/// A spawnable MCP stdio server: a command plus its arguments and environment.
#[derive(Debug, Clone)]
pub struct McpStdioCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// A live connection to an MCP stdio server. Holds the child process and a
/// buffered reader over its stdout; each request writes one JSON-RPC line and
/// reads response lines until the matching `id` arrives.
struct McpConnection {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    next_id: i64,
}

impl McpConnection {
    /// Spawn the server process and complete the MCP `initialize` handshake.
    async fn connect(cmd: &McpStdioCommand) -> Result<Self> {
        let mut command = Command::new(&cmd.command);
        command
            .args(&cmd.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .no_window();
        // Env-scrub (security): an MCP stdio server has no business inheriting
        // Core's full env (provider keys, gateway/credits tokens). `env_clear`
        // first is load-bearing (a bare `Command` inherits the parent env);
        // then pass ONLY a small benign allowlist (PATH/HOME/XDG_*/...) and
        // finally layer the server config's own declared env on top.
        command.env_clear();
        command.envs(crate::sidecar::env_scrub::mcp_safe_env(std::env::vars()));
        for (k, v) in &cmd.env {
            command.env(k, v);
        }

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn MCP server '{}'", cmd.command))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("MCP server stdin unavailable"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("MCP server stdout unavailable"))?;

        // Forward the server's stderr to tracing so failures are diagnosable.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "mcp", "{line}");
                }
            });
        }

        let mut conn = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        };

        // `initialize` request → `initialized` notification, per the MCP spec.
        conn.request(
            "initialize",
            json!({
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": "ryu-core", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
        .await
        .context("MCP initialize")?;
        conn.notify("notifications/initialized", json!({})).await?;

        Ok(conn)
    }

    /// Send a JSON-RPC request and await the matching response `result`.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_string(&frame)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;

        // Read newline-delimited JSON frames until the one with our `id`.
        // Notifications and unrelated responses are skipped.
        let read = async {
            loop {
                let mut buf = String::new();
                let n = self.stdout.read_line(&mut buf).await?;
                if n == 0 {
                    return Err(anyhow!("MCP server closed the connection"));
                }
                let trimmed = buf.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                if value.get("id").and_then(Value::as_i64) != Some(id) {
                    continue;
                }
                if let Some(err) = value.get("error") {
                    return Err(anyhow!("MCP error: {err}"));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
        };

        tokio::time::timeout(RPC_TIMEOUT, read)
            .await
            .map_err(|_| anyhow!("MCP request '{method}' timed out"))?
    }

    /// Send a JSON-RPC notification (no response expected).
    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut line = serde_json::to_string(&frame)?;
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    /// Best-effort graceful shutdown: drop stdin to signal EOF, then kill.
    async fn shutdown(mut self) {
        // Dropping stdin closes the pipe; most servers exit on stdin EOF.
        drop(self.stdin);
        let _ = self.child.kill().await;
    }
}

/// List the tools an MCP server advertises (`tools/list`).
pub async fn list_tools(cmd: &McpStdioCommand) -> Result<Vec<McpTool>> {
    let mut conn = McpConnection::connect(cmd).await?;
    let result = conn.request("tools/list", json!({})).await;
    conn.shutdown().await;
    let result = result?;

    let tools = result
        .get("tools")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let name = t.get("name")?.as_str()?.to_owned();
                    Some(McpTool {
                        name,
                        description: t
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        input_schema: t.get("inputSchema").cloned(),
                        output_schema: t.get("outputSchema").cloned(),
                        annotations: t.get("annotations").cloned(),
                        meta: t.get("_meta").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(tools)
}

/// Invoke a tool on an MCP server (`tools/call`) and return its result value.
pub async fn call_tool(cmd: &McpStdioCommand, tool: &str, arguments: Value) -> Result<Value> {
    Ok(call_tool_full(cmd, tool, arguments).await?.raw)
}

/// Invoke a tool and return the typed [`McpToolResult`] (structured channels
/// preserved). [`call_tool`] delegates here and returns only `.raw`.
pub async fn call_tool_full(
    cmd: &McpStdioCommand,
    tool: &str,
    arguments: Value,
) -> Result<McpToolResult> {
    let mut conn = McpConnection::connect(cmd).await?;
    let result = conn
        .request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
        .await;
    conn.shutdown().await;
    Ok(McpToolResult::from_result_value(result?))
}

/// List the resources an MCP server advertises (`resources/list`). Mirrors
/// [`list_tools`] (connect → request → shutdown). A server without resources
/// support errors on the request; callers treat that as an empty list.
pub async fn list_resources(cmd: &McpStdioCommand) -> Result<Vec<McpResource>> {
    let mut conn = McpConnection::connect(cmd).await?;
    let result = conn.request("resources/list", json!({})).await;
    conn.shutdown().await;
    let result = result?;

    let resources = result
        .get("resources")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|r| {
                    let uri = r.get("uri")?.as_str()?.to_owned();
                    Some(McpResource {
                        uri,
                        name: r.get("name").and_then(Value::as_str).map(str::to_owned),
                        mime_type: r.get("mimeType").and_then(Value::as_str).map(str::to_owned),
                        description: r
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        meta: r.get("_meta").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(resources)
}

/// Read one resource by URI (`resources/read`). Returns every contents entry the
/// server sends back.
pub async fn read_resource(cmd: &McpStdioCommand, uri: &str) -> Result<Vec<McpResourceContents>> {
    let mut conn = McpConnection::connect(cmd).await?;
    let result = conn
        .request("resources/read", json!({ "uri": uri }))
        .await;
    conn.shutdown().await;
    let result = result?;

    let contents = result
        .get("contents")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|c| McpResourceContents {
                    uri: c
                        .get("uri")
                        .and_then(Value::as_str)
                        .unwrap_or(uri)
                        .to_owned(),
                    mime_type: c.get("mimeType").and_then(Value::as_str).map(str::to_owned),
                    text: c.get("text").and_then(Value::as_str).map(str::to_owned),
                    blob: c.get("blob").and_then(Value::as_str).map(str::to_owned),
                    meta: c.get("_meta").cloned(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(contents)
}

/// A persistent connection to an MCP stdio server.
///
/// Unlike [`call_tool`] — which spawns, initializes, calls, and tears down a
/// fresh child for *every* invocation (keeping the registry stateless) — an
/// `McpSession` keeps one child alive across multiple `tools/call`s. That is
/// required for **stateful** tools whose effect spans two calls against the same
/// process: ghost's recording flow (`ghost_learn_start` … `ghost_learn_stop`)
/// holds an in-process input tap between the two calls, so they MUST hit the same
/// ghost subprocess. Drop or [`shutdown`](Self::shutdown) the session to kill the
/// child (the connection also `kill_on_drop`s its child as a backstop).
pub struct McpSession {
    conn: McpConnection,
}

impl McpSession {
    /// Spawn the server and complete the MCP `initialize` handshake, leaving the
    /// child running for subsequent [`call_tool`](Self::call_tool)s.
    pub async fn connect(cmd: &McpStdioCommand) -> Result<Self> {
        Ok(Self {
            conn: McpConnection::connect(cmd).await?,
        })
    }

    /// Invoke a tool on the live connection (`tools/call`) and return its result.
    pub async fn call_tool(&mut self, tool: &str, arguments: Value) -> Result<Value> {
        Ok(self.call_tool_full(tool, arguments).await?.raw)
    }

    /// Invoke a tool on the live connection and return the typed result.
    pub async fn call_tool_full(&mut self, tool: &str, arguments: Value) -> Result<McpToolResult> {
        let raw = self
            .conn
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await?;
        Ok(McpToolResult::from_result_value(raw))
    }

    /// Gracefully close the connection and kill the child process.
    pub async fn shutdown(self) {
        self.conn.shutdown().await;
    }
}
