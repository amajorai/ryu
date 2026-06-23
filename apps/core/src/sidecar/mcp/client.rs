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
            .kill_on_drop(true);
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
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(tools)
}

/// Invoke a tool on an MCP server (`tools/call`) and return its result value.
pub async fn call_tool(cmd: &McpStdioCommand, tool: &str, arguments: Value) -> Result<Value> {
    let mut conn = McpConnection::connect(cmd).await?;
    let result = conn
        .request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
        )
        .await;
    conn.shutdown().await;
    result
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
        self.conn
            .request(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
            )
            .await
    }

    /// Gracefully close the connection and kill the child process.
    pub async fn shutdown(self) {
        self.conn.shutdown().await;
    }
}
