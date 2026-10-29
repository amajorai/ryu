//! Minimal MCP client (JSON-RPC 2.0) over stdio, Streamable HTTP, and the
//! deprecated HTTP+SSE transport.
//!
//! Core already spawns MCP stdio servers (see `tools/ghost/process.rs`); this is
//! the *client* side of the same transport. It implements the stateless 2026
//! request flow, MRTR, routing headers, cache hints, and opt-in Tasks, plus a
//! compatibility path for older servers. The server is connected per request and torn down when
//! the call completes — MCP stdio servers are cheap to start, and a short-lived
//! connection keeps the registry stateless and crash-safe (a wedged server can
//! never leak a long-lived child).
//!
//! Streamable HTTP keeps the request/response body on each POST; that body may
//! be JSON or a request-scoped SSE stream. Legacy HTTP+SSE keeps a long-lived
//! GET stream open after an `endpoint` event and sends JSON-RPC messages to the
//! endpoint supplied by that event. The protocol-agnostic driver below owns
//! correlation, timeouts, and lifecycle; each transport only moves frames.

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::future::Future;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use super::http_headers;
use crate::win_process::NoWindow;

/// Sanitized HTTP failure from a remote MCP endpoint. Authentication callers can
/// downcast this to inspect the status and `WWW-Authenticate` challenge without
/// exposing response headers or bearer values in a string error.
#[derive(Debug)]
pub struct McpHttpFailure {
    pub status: reqwest::StatusCode,
    pub www_authenticate: Option<String>,
    pub body_snippet: String,
}

impl std::fmt::Display for McpHttpFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "remote MCP endpoint returned HTTP {}: {}",
            self.status, self.body_snippet
        )
    }
}

impl std::error::Error for McpHttpFailure {}

/// Structured JSON-RPC failure preserved for protocol-aware callers. Display is
/// intentionally compact; `data` is available only through downcasting.
#[derive(Clone, Debug)]
pub struct McpRpcFailure {
    pub code: i64,
    pub message: String,
    pub data: Option<Value>,
}

impl std::fmt::Display for McpRpcFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "MCP error {}: {}", self.code, self.message)
    }
}

impl std::error::Error for McpRpcFailure {}

/// The MCP protocol version this client offers during a **stdio** `initialize`.
///
/// Elicitation was added in this revision. Legacy servers can negotiate down;
/// line-delimited stdio framing is unchanged.
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";

/// The version offered during an **HTTP** `initialize`.
///
/// Streamable HTTP — one endpoint that answers a POST with either a JSON body or
/// an SSE stream, which is exactly what [`HttpTransport`] implements — arrived in
/// `2025-03-26`. The revision before it defined a *different* HTTP transport
/// (a long-lived `GET /sse` that hands back a separate message endpoint to POST
/// to). Offering `2024-11-05` over HTTP therefore risks the worst outcome
/// available: a server that negotiates down, answers `initialize` happily, and
/// then behaves as the legacy transport we do not implement — a green handshake
/// followed by a wrong-shaped `tools/list`.
///
/// `2025-06-18` additionally requires the negotiated version to be echoed on
/// every subsequent request as `MCP-Protocol-Version`; servers that enforce it
/// reject a request without it. That is what
/// [`HttpTransport::protocol_version`] carries.
const MCP_HTTP_PROTOCOL_VERSION: &str = "2025-06-18";
const MCP_HTTP_STATELESS_PROTOCOL_VERSION: &str = "2026-07-28";
const MCP_STDIO_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
const MCP_MRTR_MAX_ROUNDS: usize = 10;
const MCP_TASKS_EXTENSION_ID: &str = "io.modelcontextprotocol/tasks";

#[derive(Clone, Copy)]
enum HttpProtocolMode {
    Modern,
    LegacyStreamable,
    LegacySse,
}

fn http_protocol_modes() -> &'static tokio::sync::RwLock<BTreeMap<String, HttpProtocolMode>> {
    static MODES: OnceLock<tokio::sync::RwLock<BTreeMap<String, HttpProtocolMode>>> =
        OnceLock::new();
    MODES.get_or_init(|| tokio::sync::RwLock::new(BTreeMap::new()))
}

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
    /// The polymorphic result discriminator. Legacy results that omit this field
    /// are treated as `complete` for protocol compatibility.
    pub result_type: String,
    /// Pending server input for an MRTR response, when present.
    pub input_requests: Option<Value>,
    /// Opaque state to echo byte-for-byte on an MRTR retry.
    pub request_state: Option<String>,
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
        let result_type = raw
            .get("resultType")
            .and_then(Value::as_str)
            .unwrap_or("complete")
            .to_owned();
        let input_requests = raw.get("inputRequests").cloned();
        let request_state = raw
            .get("requestState")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let is_error = raw.get("isError").and_then(Value::as_bool).unwrap_or(false);
        Self {
            result_type,
            input_requests,
            request_state,
            structured_content,
            content,
            meta,
            is_error,
            raw,
        }
    }
}

/// Stable task states from the MCP Tasks extension.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpTaskStatus {
    Working,
    InputRequired,
    Completed,
    Failed,
    Cancelled,
}

impl McpTaskStatus {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "working" => Ok(Self::Working),
            "input_required" => Ok(Self::InputRequired),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            other => anyhow::bail!("unsupported MCP task status '{other}'"),
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

/// A validated task handle or poll result returned by the MCP Tasks extension.
#[derive(Debug, Clone)]
pub struct McpTask {
    pub task_id: String,
    pub status: McpTaskStatus,
    pub status_message: Option<String>,
    pub created_at: String,
    pub last_updated_at: String,
    /// `None` means the server declared no expiry (`ttlMs: null`).
    pub ttl_ms: Option<u64>,
    pub poll_interval_ms: Option<u64>,
    pub input_requests: Option<Value>,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub raw: Value,
}

impl McpTask {
    fn from_result_value(raw: Value, expected_result_type: &str) -> Result<Self> {
        if raw.get("resultType").and_then(Value::as_str) != Some(expected_result_type) {
            anyhow::bail!("MCP task result has an unexpected resultType");
        }
        let task_id = raw
            .get("taskId")
            .and_then(Value::as_str)
            .filter(|task_id| !task_id.trim().is_empty())
            .ok_or_else(|| anyhow!("MCP task is missing taskId"))?
            .to_owned();
        let status = McpTaskStatus::parse(
            raw.get("status")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("MCP task is missing status"))?,
        )?;
        let created_at = raw
            .get("createdAt")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("MCP task is missing createdAt"))?
            .to_owned();
        let last_updated_at = raw
            .get("lastUpdatedAt")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("MCP task is missing lastUpdatedAt"))?
            .to_owned();
        let ttl_ms =
            match raw.get("ttlMs") {
                Some(Value::Null) => None,
                Some(Value::Number(value)) => Some(value.as_u64().ok_or_else(|| {
                    anyhow!("MCP task ttlMs must be a non-negative integer or null")
                })?),
                _ => anyhow::bail!("MCP task is missing ttlMs"),
            };
        let poll_interval_ms = raw
            .get("pollIntervalMs")
            .map(|value| {
                value.as_u64().ok_or_else(|| {
                    anyhow!("MCP task pollIntervalMs must be a non-negative integer")
                })
            })
            .transpose()?;
        let input_requests = raw.get("inputRequests").cloned();
        let result = raw.get("result").cloned();
        let error = raw.get("error").cloned();
        match status {
            McpTaskStatus::InputRequired
                if !input_requests.as_ref().is_some_and(Value::is_object) =>
            {
                anyhow::bail!("input_required MCP task is missing inputRequests")
            }
            McpTaskStatus::Completed if !result.as_ref().is_some_and(Value::is_object) => {
                anyhow::bail!("completed MCP task is missing its result object")
            }
            McpTaskStatus::Failed if !error.as_ref().is_some_and(Value::is_object) => {
                anyhow::bail!("failed MCP task is missing its error object")
            }
            _ => {}
        }
        let status_message = raw
            .get("statusMessage")
            .and_then(Value::as_str)
            .map(str::to_owned);

        Ok(Self {
            task_id,
            status,
            status_message,
            created_at,
            last_updated_at,
            ttl_ms,
            poll_interval_ms,
            input_requests,
            result,
            error,
            raw,
        })
    }
}

/// The outcome of a modern `tools/call` when Tasks are negotiated.
#[derive(Debug, Clone)]
pub enum McpToolCallOutcome {
    Complete(McpToolResult),
    Task(McpTask),
}

/// A response cache policy advertised by a 2026-07-28 cacheable result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpCacheScope {
    Public,
    Private,
}

/// Server-provided freshness and sharing hints. A zero TTL means the response
/// should be considered immediately stale.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct McpCacheHints {
    pub ttl_ms: u64,
    pub scope: McpCacheScope,
}

fn cache_hints_from_result(result: &Value, required: bool) -> Result<Option<McpCacheHints>> {
    let ttl_ms = result.get("ttlMs").and_then(Value::as_u64);
    let scope = match result.get("cacheScope").and_then(Value::as_str) {
        Some("public") => Some(McpCacheScope::Public),
        Some("private") => Some(McpCacheScope::Private),
        _ => None,
    };

    if required && (ttl_ms.is_none() || scope.is_none()) {
        anyhow::bail!("modern MCP cacheable result is missing valid ttlMs/cacheScope fields");
    }
    Ok(ttl_ms
        .zip(scope)
        .map(|(ttl_ms, scope)| McpCacheHints { ttl_ms, scope }))
}

/// `tools/list` data together with the server's cache policy, when present.
#[derive(Debug, Clone)]
pub struct McpToolsList {
    pub tools: Vec<McpTool>,
    pub server_capabilities: Value,
    pub cache_hints: Option<McpCacheHints>,
}

/// `resources/list` data together with the server's cache policy, when present.
#[derive(Debug, Clone)]
pub struct McpResourcesList {
    pub resources: Vec<McpResource>,
    pub cache_hints: Option<McpCacheHints>,
}

/// `resources/read` data together with the server's cache policy, when present.
#[derive(Debug, Clone)]
pub struct McpResourceRead {
    pub contents: Vec<McpResourceContents>,
    pub result_type: String,
    pub input_requests: Option<Value>,
    pub request_state: Option<String>,
    pub cache_hints: Option<McpCacheHints>,
}

/// Read the cacheable result metadata supported by this client.
fn validate_modern_result(method: &str, result: &Value) -> Result<()> {
    let result_type = result
        .get("resultType")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("modern MCP result is missing resultType"))?;

    match result_type {
        "complete" => {}
        "input_required" if matches!(method, "tools/call" | "prompts/get" | "resources/read") => {}
        "task" if method == "tools/call" => {
            McpTask::from_result_value(result.clone(), "task")?;
        }
        other => anyhow::bail!("unsupported modern MCP resultType '{other}'"),
    }

    if method == "tasks/get" && result_type == "complete" {
        McpTask::from_result_value(result.clone(), "complete")?;
    }

    if result_type == "complete"
        && matches!(
            method,
            "tools/list"
                | "prompts/list"
                | "resources/list"
                | "resources/read"
                | "resources/templates/list"
        )
    {
        cache_hints_from_result(result, true)?;
    }
    Ok(())
}

fn validate_mrtr_client_capabilities(client_capabilities: &Value) -> Result<()> {
    if !client_capabilities.is_object() {
        anyhow::bail!("MCP client capabilities must be a JSON object");
    }
    Ok(())
}

fn tasks_client_capabilities() -> Value {
    json!({ "extensions": { "io.modelcontextprotocol/tasks": {} } })
}

fn client_supports_tasks(client_capabilities: &Value) -> bool {
    client_capabilities
        .get("extensions")
        .and_then(Value::as_object)
        .and_then(|extensions| extensions.get(MCP_TASKS_EXTENSION_ID))
        .is_some_and(Value::is_object)
}

fn server_supports_tasks(server_capabilities: &Value) -> bool {
    server_capabilities
        .pointer("/extensions/io.modelcontextprotocol~1tasks")
        .is_some_and(Value::is_object)
}

fn supports_protocol_version(result: &Value, version: &str) -> bool {
    result
        .get("supportedVersions")
        .and_then(Value::as_array)
        .is_some_and(|versions| {
            versions
                .iter()
                .any(|candidate| candidate.as_str() == Some(version))
        })
}

/// Build one new MRTR round from the original request parameters. Responses are
/// per-round and state is echoed as the opaque string supplied by the server.
fn mrtr_retry_params(
    original_params: &Value,
    input_required: &Value,
    input_responses: Value,
    completed_rounds: usize,
) -> Result<Value> {
    if completed_rounds >= MCP_MRTR_MAX_ROUNDS {
        anyhow::bail!("MCP input_required round limit ({MCP_MRTR_MAX_ROUNDS}) exceeded");
    }
    let input_requests = input_required
        .get("inputRequests")
        .and_then(Value::as_object)
        .filter(|requests| !requests.is_empty())
        .ok_or_else(|| anyhow!("MCP input_required result has no inputRequests object"))?;
    let responses = input_responses
        .as_object()
        .ok_or_else(|| anyhow!("MCP input resolver must return an object"))?;
    if responses
        .keys()
        .any(|key| !input_requests.contains_key(key))
    {
        anyhow::bail!("MCP input resolver returned an unknown response key");
    }
    if input_requests
        .keys()
        .any(|key| !responses.contains_key(key))
    {
        anyhow::bail!("MCP input resolver omitted a required response key");
    }
    if input_required.get("requestState").is_some()
        && input_required
            .get("requestState")
            .and_then(Value::as_str)
            .is_none()
    {
        anyhow::bail!("MCP requestState must be an opaque string");
    }

    let mut params = original_params
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("MRTR request parameters must be a JSON object"))?;
    params.remove("requestState");
    params.remove("inputResponses");
    params.insert("inputResponses".to_owned(), input_responses);
    if let Some(request_state) = input_required.get("requestState").and_then(Value::as_str) {
        params.insert("requestState".to_owned(), json!(request_state));
    }
    Ok(Value::Object(params))
}

/// Unwrap a ghost MCP `tools/call` result envelope into structured JSON.
///
/// ghost replies `{ "content": [{ "type": "text", "text": "<json>" }], "isError"?
/// }` (see `apps/ghost/src/mcp/server.rs`): the structured tool value is the
/// stringified JSON inside `content[0].text`. This parses it back, surfaces
/// `isError` as an `Err`, and falls back to the raw text/string when the payload
/// is not JSON.
///
/// Lives here, next to [`McpToolResult::from_result_value`], because it parses the
/// SAME envelope Core's own [`super::McpRegistry`] produces — `isError` + `content`
/// out of a `tools/call` result. Pure: no state, no host, no I/O. Callers are the
/// workflow executor's `Recipe`/`GhostAction` nodes and the recorder shim in
/// `recipes_host`.
pub fn extract_mcp_json(result: &Value) -> Result<Value> {
    let text = result
        .get("content")
        .and_then(|c| c.get(0))
        .and_then(|first| first.get("text"))
        .and_then(Value::as_str);
    if result
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(anyhow!("{}", text.unwrap_or("tool error")));
    }
    match text {
        Some(t) => Ok(serde_json::from_str::<Value>(t).unwrap_or(Value::String(t.to_string()))),
        None => Ok(result.clone()),
    }
}

/// A spawnable MCP stdio server: a command plus its arguments and environment.
#[derive(Debug, Clone)]
pub struct McpStdioCommand {
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Working directory for the child; `None` inherits Core's.
    pub cwd: Option<std::path::PathBuf>,
}

/// A remote MCP server reached over HTTP (MCP's "Streamable HTTP" transport).
///
/// `headers` is the user's verbatim header map — this is the field a pasted
/// Cursor / Claude Desktop entry's `headers: { "Authorization": "Bearer …" }`
/// lands in. It is NOT an env map: a remote server has no process to inherit
/// env, and every hosted MCP provider documents auth as a request header.
#[derive(Debug, Clone)]
pub struct McpHttpEndpoint {
    pub url: String,
    pub headers: BTreeMap<String, String>,
}

/// Where an MCP server lives — the one thing every entry point here is generic
/// over. Everything downstream of [`McpConnection::connect`] (id allocation,
/// correlation, timeout, error unwrapping, and every response *parser*) is
/// transport-blind: it only ever sees `serde_json::Value`.
#[derive(Debug, Clone)]
pub enum McpTarget {
    Stdio(McpStdioCommand),
    Http(McpHttpEndpoint),
    /// A legacy HTTP+SSE server whose configured URL is its SSE endpoint.
    Sse(McpHttpEndpoint),
}

impl McpTarget {
    /// Short human label for error text (`"MCP server 'npx'"` / the endpoint URL).
    ///
    /// The HTTP label is REDACTED, because this string is attached as context to
    /// every failure on the connection (`initialize`, `tools/list`, every call) and
    /// a hosted endpoint's URL routinely carries the operator's credential —
    /// userinfo, or a `?api_key=` query. See `server::redact_url_for_display`.
    fn describe(&self) -> String {
        match self {
            Self::Stdio(cmd) => cmd.command.clone(),
            Self::Http(ep) | Self::Sse(ep) => crate::server::redact_url_for_display(&ep.url),
        }
    }
}

/// One JSON-RPC frame's verdict inside the id-correlation loop.
///
/// Extracted from the loop body so the exact code the driver runs can be
/// asserted directly — notably for the SSE case, where correlation is the whole
/// point (a Streamable-HTTP endpoint may interleave progress notifications and
/// unrelated responses in the same event stream as our answer).
enum FrameVerdict {
    /// Not ours (a notification, another id, or unparseable) — keep reading.
    Skip,
    /// Ours, and it carried a JSON-RPC `error` object.
    Failed(McpRpcFailure),
    /// Ours: the `result` value (`null` when the server omitted it).
    Done(Value),
}

/// Classify one newline- or `data:`-delimited JSON-RPC frame against the id we
/// are waiting for. Pure.
fn classify_frame(raw: &str, id: i64) -> FrameVerdict {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return FrameVerdict::Skip;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return FrameVerdict::Skip;
    };
    classify_value(&value, id)
}

/// Classify either a single JSON-RPC message or a legacy batch response. The
/// 2025-06-18 revision removed client batching, but older servers are still
/// allowed to send batches, so accepting one here materially improves
/// interoperability without changing what Core emits.
fn classify_value(value: &Value, id: i64) -> FrameVerdict {
    if let Some(batch) = value.as_array() {
        for item in batch {
            let verdict = classify_value(item, id);
            if !matches!(verdict, FrameVerdict::Skip) {
                return verdict;
            }
        }
        return FrameVerdict::Skip;
    }
    if value.get("id").and_then(Value::as_i64) != Some(id) {
        return FrameVerdict::Skip;
    }
    if let Some(err) = value.get("error") {
        let code = err.get("code").and_then(Value::as_i64).unwrap_or(-32603);
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .filter(|message| !message.is_empty())
            .unwrap_or("MCP request failed")
            .chars()
            .take(1024)
            .collect();
        return FrameVerdict::Failed(McpRpcFailure {
            code,
            message,
            data: err.get("data").cloned(),
        });
    }
    FrameVerdict::Done(value.get("result").cloned().unwrap_or(Value::Null))
}

use ryu_vault::mcp_sse::{data_frames as sse_data_frames, SseReader};

/// The stdio half, reduced to write-one-line / read-one-line. Everything that
/// used to live here that was *protocol* rather than *transport* now lives in
/// [`McpConnection`].
struct StdioTransport {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
}

/// The HTTP half. Deliberately request/response: `send` performs the POST and
/// buffers whatever frames the response carried; `recv` drains that buffer.
///
/// A JSON body is one frame. A `text/event-stream` body is every `data:` payload
/// it contained, in order — the driver then picks the one whose `id` matches, so
/// interleaved progress notifications cost nothing.
struct HttpTransport {
    url: String,
    headers: BTreeMap<String, String>,
    /// `Mcp-Session-Id`, captured from whichever response first sets it (the
    /// `initialize` response, per the spec) and echoed on every request after.
    /// A stateful endpoint 404s a request that omits it, so this is what makes
    /// `initialize` → `tools/call` work against a session-bearing server.
    session_id: Option<String>,
    /// The version the server settled on in its `initialize` reply, echoed as
    /// `MCP-Protocol-Version` on every request after. `None` until the handshake
    /// completes — the `initialize` POST itself carries no such header, because
    /// nothing has been negotiated yet.
    protocol_version: Option<String>,
    /// Current stateless HTTP protocol: no initialize/session, with per-request
    /// method/name headers and client metadata.
    modern: bool,
    pending: VecDeque<String>,
    streams: VecDeque<SseReader>,
}

/// Response frames read from an HTTP MCP endpoint are capped: a hostile or
/// broken remote must not be able to OOM Core with a multi-GB "SSE stream".
/// A `tools/list` for a large server is tens of KB; 8 MB is ample.
const MAX_MCP_HTTP_BODY_BYTES: u64 = 8 * 1024 * 1024;

/// Configured headers must not override headers generated by the transport.
/// Agent Plugins makes this precedence explicit, and it also avoids ambiguous
/// duplicate `Accept`/`Content-Type` values in reqwest's wire request.
fn configured_headers(
    headers: &BTreeMap<String, String>,
    reserved: &[&str],
) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            !name
                .get(..10)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Mcp-Param-"))
                && !reserved
                    .iter()
                    .any(|reserved| name.eq_ignore_ascii_case(reserved))
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

fn modern_name_header(frame: &Value) -> Option<&str> {
    match frame.get("method").and_then(Value::as_str) {
        Some("tools/call" | "prompts/get") => frame.pointer("/params/name").and_then(Value::as_str),
        Some("resources/read") => frame.pointer("/params/uri").and_then(Value::as_str),
        Some("tasks/get" | "tasks/update" | "tasks/cancel") => {
            frame.pointer("/params/taskId").and_then(Value::as_str)
        }
        _ => None,
    }
}

/// Read an HTTP error body without allowing a hostile endpoint to grow Core's
/// memory without bound.
async fn read_capped_response_body(mut response: reqwest::Response) -> Result<String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MCP_HTTP_BODY_BYTES)
    {
        return Err(anyhow!(
            "MCP response exceeded the {MAX_MCP_HTTP_BODY_BYTES}-byte body cap"
        ));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_MCP_HTTP_BODY_BYTES {
            return Err(anyhow!(
                "MCP response exceeded the {MAX_MCP_HTTP_BODY_BYTES}-byte body cap"
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Turn a non-success response into the same sanitized error shape for both
/// remote HTTP transports. Configured header values never enter the error text.
fn redact_configured_header_values(
    mut text: String,
    configured: &BTreeMap<String, String>,
) -> String {
    for value in configured.values().filter(|value| !value.is_empty()) {
        text = text.replace(value, "<redacted>");
        for token in value.split_whitespace() {
            text = text.replace(token, "<redacted>");
        }
    }
    text
}

fn ensure_http_success(
    url: &str,
    configured: &BTreeMap<String, String>,
    status: reqwest::StatusCode,
    response_headers: &reqwest::header::HeaderMap,
    body: &str,
) -> Result<()> {
    if status.is_redirection() {
        let location = response_headers
            .get(reqwest::header::LOCATION)
            .and_then(|value| value.to_str().ok())
            .map(crate::server::redact_url_for_display)
            .unwrap_or_else(|| "(no Location header)".to_owned());
        return Err(anyhow!(
            "MCP endpoint {} returned HTTP {status} redirecting to {location}. Redirects are not followed (a redirect could bounce past the SSRF screen) — configure the final URL for this server instead",
            crate::server::redact_url_for_display(url)
        ));
    }
    if status.is_success() {
        return Ok(());
    }

    let snippet = redact_configured_header_values(body.chars().take(300).collect(), configured);
    Err(anyhow!(McpHttpFailure {
        status,
        www_authenticate: response_headers
            .get(reqwest::header::WWW_AUTHENTICATE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .map(|value| redact_configured_header_values(value, configured)),
        body_snippet: snippet,
    }))
    .with_context(|| {
        format!(
            "MCP endpoint {} authentication/HTTP failure",
            crate::server::redact_url_for_display(url)
        )
    })
}

fn matching_http_rpc_error(
    line: &str,
    body: &str,
    configured: &BTreeMap<String, String>,
) -> Option<String> {
    let request = serde_json::from_str::<Value>(line).ok()?;
    let response = serde_json::from_str::<Value>(body).ok()?;
    if request.get("id") != response.get("id")
        || !response.get("error").is_some_and(Value::is_object)
    {
        return None;
    }
    Some(redact_configured_header_values(body.to_owned(), configured))
}

fn same_http_origin(left: &str, right: &str) -> bool {
    let (Ok(left), Ok(right)) = (url::Url::parse(left), url::Url::parse(right)) else {
        return false;
    };
    left.scheme().eq_ignore_ascii_case(right.scheme())
        && left
            .host_str()
            .zip(right.host_str())
            .is_some_and(|(a, b)| a.eq_ignore_ascii_case(b))
        && left.port_or_known_default() == right.port_or_known_default()
}

/// The deprecated HTTP+SSE transport: a long-lived GET carries responses while
/// each client frame is POSTed to the endpoint announced by the first event.
struct LegacySseTransport {
    url: String,
    headers: BTreeMap<String, String>,
    endpoint: String,
    reader: SseReader,
    pending: VecDeque<String>,
}

impl LegacySseTransport {
    async fn connect(url: &str, headers: &BTreeMap<String, String>) -> Result<Self> {
        // Include screening, response headers and error bodies in the setup
        // deadline. The established SSE stream keeps its independent lifetime.
        tokio::time::timeout(RPC_TIMEOUT, Self::connect_inner(url, headers))
            .await
            .map_err(|_| anyhow!("legacy MCP SSE connection timed out"))?
    }

    async fn connect_inner(url: &str, headers: &BTreeMap<String, String>) -> Result<Self> {
        let mut get_headers = configured_headers(headers, &["Accept"]);
        get_headers.push(("Accept".to_owned(), "text/event-stream".to_owned()));
        let response = crate::server::guarded_get_stream_with_headers(url, &get_headers)
            .await
            .map_err(|_| anyhow!("MCP SSE connection failed"))?;
        let status = response.status();
        let response_headers = response.headers().clone();
        if !status.is_success() {
            let body = read_capped_response_body(response).await?;
            ensure_http_success(url, headers, status, &response_headers, &body)?;
            return Err(anyhow!(
                "legacy MCP SSE endpoint returned an unexpected successful status"
            ));
        }
        let content_type = response_headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.contains("text/event-stream") {
            let body = read_capped_response_body(response).await?;
            return Err(anyhow!(
                "legacy MCP endpoint {} did not return text/event-stream (got {content_type:?}): {}",
                crate::server::redact_url_for_display(url),
                redact_configured_header_values(body.chars().take(300).collect(), headers,)
            ));
        }

        let base_url = url::Url::parse(url).with_context(|| {
            format!(
                "invalid legacy MCP SSE URL {}",
                crate::server::redact_url_for_display(url)
            )
        })?;
        let mut reader = SseReader::new(response);
        let endpoint = loop {
            let Some(event) = reader.next_event().await? else {
                return Err(anyhow!(
                    "legacy MCP SSE stream closed before its endpoint event"
                ));
            };
            let is_endpoint_event = event.event.as_deref() == Some("endpoint")
                || (event.event.is_none()
                    && (event.data.starts_with('/')
                        || event.data.starts_with("http://")
                        || event.data.starts_with("https://")));
            if !is_endpoint_event {
                continue;
            }
            let endpoint = event.data.trim();
            if endpoint.is_empty() {
                return Err(anyhow!("legacy MCP SSE endpoint event was empty"));
            }
            let endpoint_url = base_url
                .join(endpoint)
                .context("resolving the legacy MCP SSE endpoint event")?;
            if endpoint_url.username() != "" || endpoint_url.fragment().is_some() {
                return Err(anyhow!(
                    "legacy MCP SSE endpoint event contained credentials or a fragment"
                ));
            }
            break endpoint_url.to_string();
        };

        Ok(Self {
            url: url.to_owned(),
            headers: headers.clone(),
            endpoint,
            reader,
            pending: VecDeque::new(),
        })
    }

    async fn post(&mut self, line: &str) -> Result<()> {
        // Legacy servers normally announce a same-origin message endpoint. If
        // an older server announces a different origin, keep the connection
        // usable but do not forward configured credentials there.
        let mut headers = if same_http_origin(&self.url, &self.endpoint) {
            configured_headers(&self.headers, &["Accept", "Content-Type"])
        } else {
            Vec::new()
        };
        headers.push((
            "Accept".to_owned(),
            "application/json, text/event-stream".to_owned(),
        ));
        headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        let (status, response_headers, body) = crate::server::guarded_post_json(
            &self.endpoint,
            &headers,
            line.to_owned(),
            MAX_MCP_HTTP_BODY_BYTES,
        )
        .await
        .map_err(|_| anyhow!("MCP HTTP request failed"))?;
        ensure_http_success(
            &self.endpoint,
            &self.headers,
            status,
            &response_headers,
            &body,
        )?;
        let content_type = response_headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if content_type.contains("text/event-stream") {
            self.pending.extend(sse_data_frames(&body));
        } else if !body.trim().is_empty() {
            self.pending.push_back(body);
        }
        Ok(())
    }

    async fn recv(&mut self) -> Result<Option<String>> {
        if let Some(frame) = self.pending.pop_front() {
            return Ok(Some(frame));
        }
        loop {
            let Some(event) = self.reader.next_event().await? else {
                return Ok(None);
            };
            if event.event.as_deref() == Some("endpoint") || event.data.trim().is_empty() {
                continue;
            }
            return Ok(Some(event.data));
        }
    }
}

/// The transport-specific half of a connection: move bytes, nothing more.
enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
    Sse(LegacySseTransport),
}

impl Transport {
    /// Write one JSON-RPC frame. For stdio this is a line on the child's stdin;
    /// for Streamable HTTP it is the whole request/response round-trip; for
    /// legacy SSE it POSTs to the announced message endpoint while responses
    /// land on the long-lived GET stream.
    async fn send(&mut self, line: &str, parameter_headers: &[(String, String)]) -> Result<()> {
        match self {
            Self::Stdio(t) => {
                let mut framed = String::with_capacity(line.len() + 1);
                framed.push_str(line);
                framed.push('\n');
                t.stdin.write_all(framed.as_bytes()).await?;
                t.stdin.flush().await?;
                Ok(())
            }
            Self::Http(t) => t.post(line, parameter_headers).await,
            Self::Sse(t) => t.post(line).await,
        }
    }

    /// Read the next frame, or `None` when no more can arrive.
    async fn recv(&mut self) -> Result<Option<String>> {
        match self {
            Self::Stdio(t) => {
                let mut buf = String::new();
                let n = t.stdout.read_line(&mut buf).await?;
                Ok(if n == 0 { None } else { Some(buf) })
            }
            Self::Http(t) => {
                if let Some(frame) = t.pending.pop_front() {
                    return Ok(Some(frame));
                }
                while let Some(reader) = t.streams.front_mut() {
                    if let Some(event) = reader.next_event().await? {
                        if !event.data.trim().is_empty() {
                            return Ok(Some(event.data));
                        }
                    } else {
                        t.streams.pop_front();
                    }
                }
                Ok(None)
            }
            Self::Sse(t) => t.recv().await,
        }
    }

    /// Why no further frame can arrive — the transports fail differently and
    /// the distinction is the whole diagnosis (a crashed child vs. a response
    /// that simply never contained our id).
    fn exhausted_error(&self) -> anyhow::Error {
        match self {
            Self::Stdio(_) => anyhow!("MCP server closed the connection"),
            // Redacted: the URL may carry the operator's credential, and this
            // string is logged and shown. Same rule as `HttpTransport::post`.
            Self::Http(t) => anyhow!(
                "MCP endpoint {} returned no response frame matching the request id",
                crate::server::redact_url_for_display(&t.url)
            ),
            Self::Sse(t) => anyhow!(
                "legacy MCP SSE endpoint {} closed without a response frame matching the request id",
                crate::server::redact_url_for_display(&t.url)
            ),
        }
    }

    async fn shutdown(self) {
        match self {
            Self::Stdio(t) => {
                // Dropping stdin closes the pipe; most servers exit on stdin EOF.
                let StdioTransport {
                    mut child, stdin, ..
                } = t;
                drop(stdin);
                let _ = child.kill().await;
            }
            // Nothing to tear down: a request/response HTTP endpoint holds no
            // Core-side resource.
            // (MCP's `DELETE <url>` session teardown is deliberately not sent —
            // it is optional, servers may reject it, and a stateless per-call
            // connection has nothing to reclaim.)
            Self::Http(t) => {
                if t.url.starts_with("ryu-passport-mcp://") {
                    crate::identity::passport::mcp_close(&t.url).await;
                }
            }
            // Dropping the response body closes the long-lived legacy SSE GET.
            Self::Sse(_) => {}
        }
    }
}

impl HttpTransport {
    /// POST one JSON-RPC frame through Core's SSRF-guarded client and buffer the
    /// response frames.
    ///
    /// The guard is not optional and is not a shared client: see
    /// `server::guarded_post_json`. The moment Core fetches a user-supplied MCP
    /// URL in-process, `http://169.254.169.254/` is Core's own SSRF, so the
    /// resolve → screen → **pin** builder runs per request against this host.
    async fn post(&mut self, line: &str, parameter_headers: &[(String, String)]) -> Result<()> {
        let mut headers = configured_headers(
            &self.headers,
            &[
                "Accept",
                "Content-Type",
                "Mcp-Method",
                "Mcp-Name",
                "Mcp-Session-Id",
                "MCP-Protocol-Version",
            ],
        );
        // Both are required by MCP's Streamable HTTP transport: a server may
        // answer a POST with either a JSON body or an SSE stream, and it picks
        // based on this Accept.
        headers.push((
            "Accept".to_owned(),
            "application/json, text/event-stream".to_owned(),
        ));
        headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
        if self.modern {
            let frame: Value = serde_json::from_str(line).context("parsing outbound MCP frame")?;
            if let Some(method) = frame.get("method").and_then(Value::as_str) {
                headers.push(("Mcp-Method".to_owned(), method.to_owned()));
            }
            let name = modern_name_header(&frame);
            if let Some(name) = name {
                headers.push((
                    "Mcp-Name".to_owned(),
                    http_headers::encode_mcp_header_value(name)?,
                ));
            }
            for (name, value) in parameter_headers {
                headers.push((name.clone(), value.clone()));
            }
        }
        if let Some(session) = &self.session_id {
            headers.push(("Mcp-Session-Id".to_owned(), session.clone()));
        }
        if let Some(version) = &self.protocol_version {
            headers.push(("MCP-Protocol-Version".to_owned(), version.clone()));
        }

        let (status, resp_headers, body) = if self.url.starts_with("ryu-passport-mcp://") {
            crate::identity::passport::mcp_post(&self.url, &headers, line).await?
        } else {
            let response = crate::server::guarded_post_stream_with_headers(
                &self.url,
                &headers,
                line.to_owned(),
                if super::forms::available() {
                    Duration::from_secs(360)
                } else {
                    RPC_TIMEOUT
                },
            )
            .await
            .map_err(|_| anyhow!("MCP HTTP request failed"))?;
            let status = response.status();
            let response_headers = response.headers().clone();
            if status.is_success()
                && response_headers
                    .get(reqwest::header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
            {
                if !self.modern {
                    if let Some(session) = response_headers
                        .get("mcp-session-id")
                        .and_then(|value| value.to_str().ok())
                    {
                        self.session_id = Some(session.to_owned());
                    }
                }
                self.streams.push_back(SseReader::new(response));
                return Ok(());
            }
            (
                status,
                response_headers,
                read_capped_response_body(response).await?,
            )
        };

        if !self.modern {
            if let Some(session) = resp_headers
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
            {
                self.session_id = Some(session);
            }
        }

        if !status.is_success() && !status.is_redirection() && self.modern {
            if let Some(frame) = matching_http_rpc_error(line, &body, &self.headers) {
                self.pending.push_back(frame);
                return Ok(());
            }
        }
        ensure_http_success(&self.url, &self.headers, status, &resp_headers, &body)?;

        let content_type = resp_headers
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if content_type.contains("text/event-stream") {
            self.pending.extend(sse_data_frames(&body));
        } else if !body.trim().is_empty() {
            self.pending.push_back(body);
        }
        Ok(())
    }
}

impl Drop for HttpTransport {
    fn drop(&mut self) {
        if self.url.starts_with("ryu-passport-mcp://") {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                let url = self.url.clone();
                runtime.spawn(async move {
                    crate::identity::passport::mcp_close(&url).await;
                });
            }
        }
    }
}

/// A live connection to an MCP server, over either transport.
///
/// This is the transport-agnostic **driver**: id allocation, the correlation
/// loop, JSON-RPC error unwrapping, and the [`RPC_TIMEOUT`] deadline. It is the
/// only thing that understands the protocol; [`Transport`] only moves bytes.
struct McpConnection {
    transport: Transport,
    next_id: i64,
    modern: bool,
    server_capabilities: Value,
    /// For error text only.
    label: String,
}

impl McpConnection {
    /// Discover a modern server, or fall back to the legacy `initialize` flow.
    async fn connect(target: &McpTarget) -> Result<Self> {
        let cached_http_mode = match target {
            McpTarget::Http(endpoint) => http_protocol_modes()
                .read()
                .await
                .get(&endpoint.url)
                .copied(),
            McpTarget::Stdio(_) | McpTarget::Sse(_) => None,
        };
        let transport = match target {
            McpTarget::Stdio(cmd) => Transport::Stdio(Self::spawn_stdio(cmd).await?),
            McpTarget::Sse(ep) if ep.url.starts_with("ryu-passport-mcp://") => {
                Transport::Http(HttpTransport {
                    url: ep.url.clone(),
                    headers: ep.headers.clone(),
                    session_id: None,
                    protocol_version: None,
                    modern: false,
                    pending: VecDeque::new(),
                    streams: VecDeque::new(),
                })
            }
            McpTarget::Sse(ep) => {
                Transport::Sse(LegacySseTransport::connect(&ep.url, &ep.headers).await?)
            }
            McpTarget::Http(ep) => match cached_http_mode {
                Some(HttpProtocolMode::LegacySse) => {
                    Transport::Sse(LegacySseTransport::connect(&ep.url, &ep.headers).await?)
                }
                _ => Transport::Http(HttpTransport {
                    url: ep.url.clone(),
                    headers: ep.headers.clone(),
                    session_id: None,
                    protocol_version: None,
                    modern: matches!(cached_http_mode, Some(HttpProtocolMode::Modern)),
                    pending: VecDeque::new(),
                    streams: VecDeque::new(),
                }),
            },
        };

        let mut conn = Self {
            transport,
            next_id: 1,
            modern: matches!(cached_http_mode, Some(HttpProtocolMode::Modern)),
            server_capabilities: json!({}),
            label: target.describe(),
        };

        if conn.modern {
            if let Transport::Http(http) = &mut conn.transport {
                http.protocol_version = Some(MCP_HTTP_STATELESS_PROTOCOL_VERSION.to_owned());
            }
            let discovery = conn
                .request("server/discover", json!({}))
                .await
                .context("MCP server/discover")?;
            if !supports_protocol_version(&discovery, MCP_HTTP_STATELESS_PROTOCOL_VERSION) {
                anyhow::bail!("cached MCP server no longer supports protocol 2026-07-28");
            }
            conn.server_capabilities = discovery
                .get("capabilities")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return Ok(conn);
        }

        // Probe modern STDIO and uncached HTTP endpoints. Older STDIO servers may
        // terminate when they receive a method before initialize, so a failed
        // probe gets a fresh process for the legacy handshake.
        let should_discover = matches!(target, McpTarget::Stdio(_))
            || (matches!(target, McpTarget::Http(_)) && cached_http_mode.is_none());
        if should_discover {
            if let Transport::Http(http) = &mut conn.transport {
                http.protocol_version = Some(MCP_HTTP_STATELESS_PROTOCOL_VERSION.to_owned());
                http.modern = true;
            }
            conn.modern = true;

            let discovery = if matches!(target, McpTarget::Stdio(_)) {
                match tokio::time::timeout(
                    MCP_STDIO_DISCOVERY_TIMEOUT,
                    conn.request("server/discover", json!({})),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => Err(anyhow!("MCP server/discover timed out")),
                }
            } else {
                conn.request("server/discover", json!({})).await
            };

            match discovery {
                Ok(result)
                    if supports_protocol_version(&result, MCP_HTTP_STATELESS_PROTOCOL_VERSION) =>
                {
                    conn.server_capabilities = result
                        .get("capabilities")
                        .cloned()
                        .unwrap_or_else(|| json!({}));
                    if let Transport::Http(http) = &mut conn.transport {
                        http.modern = true;
                    }
                    if let McpTarget::Http(endpoint) = target {
                        http_protocol_modes()
                            .write()
                            .await
                            .insert(endpoint.url.clone(), HttpProtocolMode::Modern);
                    }
                    return Ok(conn);
                }
                Ok(_) => {}
                Err(error)
                    if matches!(target, McpTarget::Stdio(_)) || error_proves_legacy(&error) => {}
                Err(error) => return Err(error).context("MCP server/discover"),
            }

            conn.modern = false;
            match target {
                McpTarget::Stdio(command) => {
                    if let Transport::Stdio(stdio) = &mut conn.transport {
                        let _ = stdio.child.kill().await;
                    }
                    conn.transport = Transport::Stdio(Self::spawn_stdio(command).await?);
                }
                McpTarget::Http(endpoint) => {
                    // Preserve the same sealed handle across protocol negotiation.
                    if let Transport::Http(previous) = &mut conn.transport {
                        if previous.url.starts_with("ryu-passport-mcp://") {
                            previous.url.clear();
                        }
                    }
                    conn.transport = Transport::Http(HttpTransport {
                        url: endpoint.url.clone(),
                        headers: endpoint.headers.clone(),
                        session_id: None,
                        protocol_version: None,
                        modern: false,
                        pending: VecDeque::new(),
                        streams: VecDeque::new(),
                    });
                    http_protocol_modes()
                        .write()
                        .await
                        .insert(endpoint.url.clone(), HttpProtocolMode::LegacyStreamable);
                }
                McpTarget::Sse(_) => unreachable!("SSE targets skip discovery"),
            }
            conn.next_id = 1;
        }

        // Legacy initialize → initialized. HTTP versions from the handshake are
        // echoed on every later request; all legacy transports offer elicitation.
        let offered = match target {
            McpTarget::Stdio(_) | McpTarget::Sse(_) => MCP_PROTOCOL_VERSION,
            McpTarget::Http(_) => MCP_HTTP_PROTOCOL_VERSION,
        };
        let initialize_params = |protocol_version: &str| {
            json!({
                "protocolVersion": protocol_version,
                "capabilities": if super::forms::available() { super::forms::capabilities() } else { json!({}) },
                "clientInfo": { "name": "ryu-core", "version": env!("CARGO_PKG_VERSION") },
            })
        };
        let result = conn.request("initialize", initialize_params(offered)).await;
        let result = match result {
            Ok(result) => result,
            Err(error)
                if matches!(target, McpTarget::Http(_)) && error_indicates_legacy_sse(&error) =>
            {
                let McpTarget::Http(endpoint) = target else {
                    unreachable!("guarded by the HTTP match")
                };
                conn.transport = Transport::Sse(
                    LegacySseTransport::connect(&endpoint.url, &endpoint.headers).await?,
                );
                conn.next_id = 1;
                http_protocol_modes()
                    .write()
                    .await
                    .insert(endpoint.url.clone(), HttpProtocolMode::LegacySse);
                conn.request("initialize", initialize_params(MCP_PROTOCOL_VERSION))
                    .await?
            }
            Err(error) => {
                return Err(error).context(format!("MCP initialize ({})", conn.label));
            }
        };

        if let Transport::Http(http) = &mut conn.transport {
            http.protocol_version = Some(
                result
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(offered)
                    .to_owned(),
            );
        }
        conn.server_capabilities = result
            .get("capabilities")
            .cloned()
            .unwrap_or_else(|| json!({}));

        conn.notify("notifications/initialized", json!({})).await?;
        Ok(conn)
    }
    /// Spawn the server process for the stdio transport.
    async fn spawn_stdio(cmd: &McpStdioCommand) -> Result<StdioTransport> {
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
        // Ghost (spawned per call) gets its component subkey so it can open
        // the sealed snapshot an earlier call wrote; every other server none.
        command.envs(crate::sidecar::tools::ghost::mcp_seal_env_for(&cmd.command));
        if let Some(dir) = &cmd.cwd {
            command.current_dir(dir);
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

        Ok(StdioTransport {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        })
    }

    /// Send a JSON-RPC request and await the matching response `result`.
    ///
    /// The whole round-trip — write *and* read — is under [`RPC_TIMEOUT`], not
    /// just the read. For stdio the write is a pipe write and effectively free,
    /// but for HTTP the "write" is the entire request, so a remote that accepts
    /// the connection and then stalls would otherwise hang forever.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.request_with_client_capabilities(method, params, json!({}))
            .await
    }

    async fn request_with_client_capabilities(
        &mut self,
        method: &str,
        params: Value,
        client_capabilities: Value,
    ) -> Result<Value> {
        let parameter_headers = self.tool_parameter_headers(method, &params).await?;
        match self
            .request_with_client_capabilities_and_headers(
                method,
                params.clone(),
                client_capabilities.clone(),
                parameter_headers,
            )
            .await
        {
            Err(error)
                if method == "tools/call"
                    && rpc_failure_from_error(&error)
                        .is_some_and(|failure| failure.code == -32_020) =>
            {
                let parameter_headers = self.tool_parameter_headers(method, &params).await?;
                self.request_with_client_capabilities_and_headers(
                    method,
                    params,
                    client_capabilities,
                    parameter_headers,
                )
                .await
            }
            result => result,
        }
    }

    async fn request_with_client_capabilities_and_headers(
        &mut self,
        method: &str,
        params: Value,
        client_capabilities: Value,
        parameter_headers: Vec<(String, String)>,
    ) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;

        // W3C trace context rides in `params._meta` (MCP's propagation slot) so
        // the server's spans nest under the dispatching span. Empty — and the
        // params untouched — when there is no exportable context (consent off).
        let params = crate::sidecar::gen_ai_spans::with_trace_context_meta(
            params,
            &crate::telemetry::propagation::current_trace_context_fields(),
        );
        let params = if self.modern {
            with_modern_client_meta(params, client_capabilities.clone())?
        } else {
            params
        };
        let frame = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&frame)?;

        let round_trip = async {
            self.transport.send(&line, &parameter_headers).await?;
            loop {
                let Some(raw) = self.transport.recv().await? else {
                    return Err(self.transport.exhausted_error());
                };
                if let Ok(request) = serde_json::from_str::<Value>(&raw) {
                    if matches!(
                        request.get("method").and_then(Value::as_str),
                        Some("elicitation/create" | "openai/elicitation/create")
                    ) && request.get("id").is_some()
                    {
                        let response = match super::forms::elicit(
                            request.get("params").cloned().unwrap_or(Value::Null),
                        )
                        .await
                        {
                            Ok(result) => {
                                json!({ "jsonrpc": "2.0", "id": request["id"], "result": result })
                            }
                            Err(_) => {
                                json!({ "jsonrpc": "2.0", "id": request["id"], "error": { "code": -32602, "message": "Unsupported elicitation form" } })
                            }
                        };
                        self.transport.send(&response.to_string(), &[]).await?;
                        continue;
                    }
                }
                match classify_frame(&raw, id) {
                    FrameVerdict::Skip => continue,
                    FrameVerdict::Failed(err) => return Err(anyhow!(err)),
                    FrameVerdict::Done(result) => {
                        if self.modern {
                            validate_modern_result(method, &result)?;
                            if result.get("resultType").and_then(Value::as_str) == Some("task")
                                && (!client_supports_tasks(&client_capabilities)
                                    || !server_supports_tasks(&self.server_capabilities))
                            {
                                anyhow::bail!(
                                    "MCP server returned a task result without both sides negotiating io.modelcontextprotocol/tasks"
                                );
                            }
                        }
                        if let Transport::Http(http) = &mut self.transport {
                            http.streams.clear();
                        }
                        return Ok(result);
                    }
                }
            }
        };

        let request_timeout = if super::forms::available() {
            Duration::from_secs(360)
        } else {
            RPC_TIMEOUT
        };
        tokio::time::timeout(request_timeout, round_trip)
            .await
            .map_err(|_| anyhow!("MCP request '{method}' timed out"))?
    }

    async fn tool_parameter_headers(
        &mut self,
        method: &str,
        params: &Value,
    ) -> Result<Vec<(String, String)>> {
        if method != "tools/call" || !self.modern || !matches!(&self.transport, Transport::Http(_))
        {
            return Ok(Vec::new());
        }
        let Some(tool_name) = params.get("name").and_then(Value::as_str) else {
            return Ok(Vec::new());
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !arguments.is_object() {
            return Ok(Vec::new());
        }

        // Use the most recently obtained schema without retaining auth-scoped
        // catalog data across this stateless connection.
        let mut cursor: Option<String> = None;
        let mut seen_cursors = HashSet::new();
        for _ in 0..100 {
            let request_params = cursor
                .as_ref()
                .map(|cursor| json!({ "cursor": cursor }))
                .unwrap_or_else(|| json!({}));
            let Ok(result) = self
                .request_with_client_capabilities_and_headers(
                    "tools/list",
                    request_params,
                    json!({}),
                    Vec::new(),
                )
                .await
            else {
                return Ok(Vec::new());
            };
            if let Some(tool) = result
                .get("tools")
                .and_then(Value::as_array)
                .and_then(|tools| {
                    tools
                        .iter()
                        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(tool_name))
                })
            {
                return http_headers::tool_parameter_headers(tool.get("inputSchema"), &arguments);
            }
            let Some(next_cursor) = result
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                return Ok(Vec::new());
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                anyhow::bail!("MCP tools/list returned a repeated pagination cursor");
            }
            cursor = Some(next_cursor);
        }
        anyhow::bail!("MCP tools/list exceeded the 100-page header-schema lookup limit")
    }

    async fn request_with_mrtr<F, Fut>(
        &mut self,
        method: &str,
        params: Value,
        client_capabilities: Value,
        mut resolve_input: F,
    ) -> Result<Value>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        if !self.modern {
            return self.request(method, params).await;
        }
        if !matches!(method, "tools/call" | "prompts/get" | "resources/read") {
            anyhow::bail!("MCP multi-round-trip requests are not supported for '{method}'");
        }
        validate_mrtr_client_capabilities(&client_capabilities)?;

        let original_params = params;
        let mut request_params = original_params.clone();
        let mut completed_rounds = 0;
        loop {
            let result = self
                .request_with_client_capabilities(
                    method,
                    request_params.clone(),
                    client_capabilities.clone(),
                )
                .await?;
            if result.get("resultType").and_then(Value::as_str) != Some("input_required") {
                return Ok(result);
            }

            let requests = result
                .get("inputRequests")
                .and_then(Value::as_object)
                .filter(|requests| !requests.is_empty())
                .ok_or_else(|| anyhow!("MCP input_required result has no inputRequests object"))?;
            if completed_rounds >= MCP_MRTR_MAX_ROUNDS {
                anyhow::bail!("MCP input_required round limit ({MCP_MRTR_MAX_ROUNDS}) exceeded");
            }
            let responses = resolve_input(Value::Object(requests.clone())).await?;
            request_params =
                mrtr_retry_params(&original_params, &result, responses, completed_rounds)?;
            completed_rounds += 1;
        }
    }
    /// Send a JSON-RPC notification (no response expected).
    ///
    /// Over HTTP a notification is still a POST; the server answers `202` with an
    /// empty body, which the transport simply buffers nothing from. A server that
    /// *does* answer with frames has them queued for the next `request`, where
    /// they fail the id match and are skipped — the correlation loop is what
    /// makes that harmless.
    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let line = serde_json::to_string(&frame)?;
        self.transport.send(&line, &[]).await
    }

    /// Best-effort graceful shutdown (stdio: drop stdin to signal EOF, then kill;
    /// HTTP: nothing to release).
    async fn shutdown(self) {
        self.transport.shutdown().await;
    }
}

fn with_modern_client_meta(mut params: Value, client_capabilities: Value) -> Result<Value> {
    if !client_capabilities.is_object() {
        anyhow::bail!("MCP client capabilities must be a JSON object");
    }
    let params = params
        .as_object_mut()
        .ok_or_else(|| anyhow!("MCP request parameters must be a JSON object"))?;
    let meta = params.entry("_meta").or_insert_with(|| json!({}));
    let meta = meta
        .as_object_mut()
        .ok_or_else(|| anyhow!("MCP request _meta must be a JSON object"))?;
    meta.insert(
        "io.modelcontextprotocol/protocolVersion".to_owned(),
        json!(MCP_HTTP_STATELESS_PROTOCOL_VERSION),
    );
    meta.insert(
        "io.modelcontextprotocol/clientInfo".to_owned(),
        json!({
            "name": "ryu-core",
            "version": env!("CARGO_PKG_VERSION")
        }),
    );
    meta.insert(
        "io.modelcontextprotocol/clientCapabilities".to_owned(),
        client_capabilities,
    );
    Ok(Value::Object(params.clone()))
}
fn rpc_failure_from_error(error: &anyhow::Error) -> Option<&McpRpcFailure> {
    error
        .chain()
        .find_map(|cause| cause.downcast_ref::<McpRpcFailure>())
}

fn error_proves_legacy(error: &anyhow::Error) -> bool {
    if let Some(failure) = rpc_failure_from_error(error) {
        return match failure.code {
            -32601 => true,
            -32022 => {
                let supports_modern = failure
                    .data
                    .as_ref()
                    .and_then(|data| data.get("supported"))
                    .and_then(Value::as_array)
                    .is_some_and(|versions| {
                        versions.iter().any(|version| {
                            version.as_str() == Some(MCP_HTTP_STATELESS_PROTOCOL_VERSION)
                        })
                    });
                !supports_modern
            }
            _ => false,
        };
    }

    error.chain().any(|cause| {
        cause
            .downcast_ref::<McpHttpFailure>()
            .is_some_and(|failure| {
                matches!(
                    failure.status,
                    reqwest::StatusCode::BAD_REQUEST
                        | reqwest::StatusCode::NOT_FOUND
                        | reqwest::StatusCode::METHOD_NOT_ALLOWED
                )
            })
    })
}

/// A failed initialize POST can identify a legacy `/sse` URL. A JSON-RPC
/// `-32601` response means the endpoint did receive a normal request and should
/// stay on the Streamable HTTP initialize path, so do not treat it as SSE.
fn error_indicates_legacy_sse(error: &anyhow::Error) -> bool {
    if error.to_string().contains("-32601") {
        return false;
    }
    error.chain().any(|cause| {
        cause
            .downcast_ref::<McpHttpFailure>()
            .is_some_and(|failure| {
                matches!(
                    failure.status,
                    reqwest::StatusCode::BAD_REQUEST
                        | reqwest::StatusCode::NOT_FOUND
                        | reqwest::StatusCode::METHOD_NOT_ALLOWED
                )
            })
    })
}

/// List the tools an MCP server advertises (`tools/list`).
pub async fn list_tools(target: &McpTarget) -> Result<Vec<McpTool>> {
    Ok(list_tools_with_cache_hints(target).await?.tools)
}

/// List tools and expose the server's cache policy for callers that cache catalogs.
pub async fn list_tools_with_cache_hints(target: &McpTarget) -> Result<McpToolsList> {
    let mut conn = McpConnection::connect(target).await?;
    let server_capabilities = conn.server_capabilities.clone();
    let cache_hints_required = conn.modern;
    let validate_http_headers = conn.modern && matches!(&conn.transport, Transport::Http(_));
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
                    let input_schema = t.get("inputSchema").cloned();
                    if validate_http_headers {
                        if let Err(error) = http_headers::tool_parameter_headers(
                            input_schema.as_ref(),
                            &json!({}),
                        ) {
                        tracing::warn!(tool = %name, %error, "excluding MCP tool with invalid x-mcp-header annotations");
                        return None;
                        }
                    }
                    Some(McpTool {
                        name,
                        description: t
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        input_schema,
                        output_schema: t.get("outputSchema").cloned(),
                        annotations: super::ui_extensions::annotations_with_title(t),
                        meta: t.get("_meta").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(McpToolsList {
        tools,
        server_capabilities,
        cache_hints: cache_hints_from_result(&result, cache_hints_required)?,
    })
}
/// Invoke a tool on an MCP server (`tools/call`) and return its result value.
pub async fn call_tool(target: &McpTarget, tool: &str, arguments: Value) -> Result<Value> {
    Ok(call_tool_full(target, tool, arguments).await?.raw)
}

/// Invoke a tool and return the typed [`McpToolResult`] (structured channels
/// preserved). [`call_tool`] delegates here and returns only `.raw`.
pub async fn call_tool_full(
    target: &McpTarget,
    tool: &str,
    arguments: Value,
) -> Result<McpToolResult> {
    call_tool_full_with_meta(target, tool, arguments, None).await
}

/// Invoke an MCP tool with request-scoped, host-supplied metadata. MCP `_meta`
/// stays outside the tool's public argument schema; Ryu uses it for trusted
/// local display context such as the Ghost computer-use cursor identity.
pub async fn call_tool_with_meta(
    target: &McpTarget,
    tool: &str,
    arguments: Value,
    meta: Value,
) -> Result<Value> {
    Ok(
        call_tool_full_with_meta(target, tool, arguments, Some(meta))
            .await?
            .raw,
    )
}

/// Typed variant of [`call_tool_with_meta`].
pub async fn call_tool_full_with_meta(
    target: &McpTarget,
    tool: &str,
    arguments: Value,
    meta: Option<Value>,
) -> Result<McpToolResult> {
    let params = tool_call_params(tool, arguments, meta)?;
    let mut conn = McpConnection::connect(target).await?;
    let result = conn.request("tools/call", params).await;
    conn.shutdown().await;
    Ok(McpToolResult::from_result_value(result?))
}

tokio::task_local! { static HOST_TOOL_METADATA: Value; }

/// Carry host-verified tool metadata through a conversation-scoped MCP form call.
/// The scope is task-local, so another caller cannot inherit cursor identity.
pub async fn with_tool_metadata<F, T>(meta: Value, call: F) -> Result<T>
where
    F: Future<Output = Result<T>>,
{
    if !meta.is_object() {
        anyhow::bail!("MCP request metadata must be an object");
    }
    HOST_TOOL_METADATA.scope(meta, call).await
}

fn tool_call_params(tool: &str, arguments: Value, meta: Option<Value>) -> Result<Value> {
    let meta = meta.or_else(|| HOST_TOOL_METADATA.try_with(Clone::clone).ok());
    if meta.as_ref().is_some_and(|value| !value.is_object()) {
        return Err(anyhow!("MCP request metadata must be an object"));
    }
    Ok(match meta {
        Some(meta) => json!({ "name": tool, "arguments": arguments, "_meta": meta }),
        None => json!({ "name": tool, "arguments": arguments }),
    })
}

/// Invoke a tool with the MCP Tasks extension negotiated. A server may return
/// either the normal tool result or a durable task handle; callers can persist
/// `task_id` and resume with [`get_task`], [`update_task`], or [`cancel_task`].
pub async fn call_tool_full_with_tasks(
    target: &McpTarget,
    tool: &str,
    arguments: Value,
) -> Result<McpToolCallOutcome> {
    let mut conn = McpConnection::connect(target).await?;
    if !conn.modern {
        anyhow::bail!("the MCP Tasks extension requires protocol 2026-07-28");
    }
    if !server_supports_tasks(&conn.server_capabilities) {
        anyhow::bail!("the MCP server does not advertise io.modelcontextprotocol/tasks");
    }
    let result = conn
        .request_with_client_capabilities(
            "tools/call",
            json!({ "name": tool, "arguments": arguments }),
            tasks_client_capabilities(),
        )
        .await;
    conn.shutdown().await;
    let result = result?;
    if result.get("resultType").and_then(Value::as_str) == Some("task") {
        Ok(McpToolCallOutcome::Task(McpTask::from_result_value(
            result, "task",
        )?))
    } else {
        Ok(McpToolCallOutcome::Complete(
            McpToolResult::from_result_value(result),
        ))
    }
}

/// Read the current state of a durable MCP task. The returned task ID can be
/// stored by the caller and reused after reconnecting.
pub async fn get_task(target: &McpTarget, task_id: &str) -> Result<McpTask> {
    let result = task_request(target, "tasks/get", json!({ "taskId": task_id })).await?;
    McpTask::from_result_value(result, "complete")
}

/// Supply responses to task `inputRequests`. The server acknowledges with an
/// empty `complete` result; use [`get_task`] to observe the next state.
pub async fn update_task(target: &McpTarget, task_id: &str, input_responses: Value) -> Result<()> {
    if !input_responses.is_object() {
        anyhow::bail!("MCP task inputResponses must be a JSON object");
    }
    task_request(
        target,
        "tasks/update",
        json!({ "taskId": task_id, "inputResponses": input_responses }),
    )
    .await?;
    Ok(())
}

/// Signal cooperative cancellation for a durable MCP task.
pub async fn cancel_task(target: &McpTarget, task_id: &str) -> Result<()> {
    task_request(target, "tasks/cancel", json!({ "taskId": task_id })).await?;
    Ok(())
}

async fn task_request(target: &McpTarget, method: &str, params: Value) -> Result<Value> {
    let mut conn = McpConnection::connect(target).await?;
    if !conn.modern {
        anyhow::bail!("the MCP Tasks extension requires protocol 2026-07-28");
    }
    if !server_supports_tasks(&conn.server_capabilities) {
        anyhow::bail!("the MCP server does not advertise io.modelcontextprotocol/tasks");
    }
    let result = conn
        .request_with_client_capabilities(method, params, tasks_client_capabilities())
        .await;
    conn.shutdown().await;
    result
}

/// Invoke a tool and drive modern MRTR requests through a caller-owned resolver.
/// The resolver receives the current round's `inputRequests` object and must
/// return matching `inputResponses`. Capabilities are included on every request;
/// only declare handlers the caller can actually fulfill.
pub async fn call_tool_full_with_mrtr<F, Fut>(
    target: &McpTarget,
    tool: &str,
    arguments: Value,
    client_capabilities: Value,
    resolve_input: F,
) -> Result<McpToolResult>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let params = tool_call_params(tool, arguments, None)?;
    let mut conn = McpConnection::connect(target).await?;
    let result = conn
        .request_with_mrtr("tools/call", params, client_capabilities, resolve_input)
        .await;
    conn.shutdown().await;
    Ok(McpToolResult::from_result_value(result?))
}

/// List the resources an MCP server advertises (`resources/list`). Mirrors
/// [`list_tools`] (connect → request → shutdown). A server without resources
/// support errors on the request; callers treat that as an empty list.
pub async fn list_resources(target: &McpTarget) -> Result<Vec<McpResource>> {
    Ok(list_resources_with_cache_hints(target).await?.resources)
}

/// List resources and expose the server's cache policy for callers that cache catalogs.
pub async fn list_resources_with_cache_hints(target: &McpTarget) -> Result<McpResourcesList> {
    let mut conn = McpConnection::connect(target).await?;
    let cache_hints_required = conn.modern;
    let result = conn.request("resources/list", json!({})).await;
    conn.shutdown().await;
    let result = result?;

    let resources = result
        .get("resources")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|resource| {
                    let uri = resource.get("uri")?.as_str()?.to_owned();
                    Some(McpResource {
                        uri,
                        name: resource
                            .get("name")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        mime_type: resource
                            .get("mimeType")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        description: resource
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        meta: resource.get("_meta").cloned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(McpResourcesList {
        resources,
        cache_hints: cache_hints_from_result(&result, cache_hints_required)?,
    })
}
fn resource_read_from_result(
    result: &Value,
    uri: &str,
    cache_hints_required: bool,
) -> Result<McpResourceRead> {
    let result_type = result
        .get("resultType")
        .and_then(Value::as_str)
        .unwrap_or("complete")
        .to_owned();
    let input_requests = result.get("inputRequests").cloned();
    let request_state = result
        .get("requestState")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let cache_hints_required = cache_hints_required && result_type == "complete";
    let contents = result
        .get("contents")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|content| McpResourceContents {
                    uri: content
                        .get("uri")
                        .and_then(Value::as_str)
                        .unwrap_or(uri)
                        .to_owned(),
                    mime_type: content
                        .get("mimeType")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    text: content
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    blob: content
                        .get("blob")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    meta: content.get("_meta").cloned(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(McpResourceRead {
        contents,
        result_type,
        input_requests,
        request_state,
        cache_hints: cache_hints_from_result(result, cache_hints_required)?,
    })
}
/// Read one resource by URI (`resources/read`). Returns every contents entry the
/// server sends back. An MRTR result is surfaced as an explicit error; use
/// [`read_resource_with_mrtr`] when the caller can fulfill its input requests.
pub async fn read_resource(target: &McpTarget, uri: &str) -> Result<Vec<McpResourceContents>> {
    let result = read_resource_with_cache_hints(target, uri).await?;
    if result.result_type == "input_required" {
        anyhow::bail!("MCP resources/read requires client input; use read_resource_with_mrtr");
    }
    Ok(result.contents)
}

/// Read a resource and expose its result/cache metadata.
pub async fn read_resource_with_cache_hints(
    target: &McpTarget,
    uri: &str,
) -> Result<McpResourceRead> {
    let mut conn = McpConnection::connect(target).await?;
    let cache_hints_required = conn.modern;
    let result = conn.request("resources/read", json!({ "uri": uri })).await;
    conn.shutdown().await;
    resource_read_from_result(&result?, uri, cache_hints_required)
}

/// Read a resource while driving modern MRTR input rounds through a caller-owned
/// resolver. The caller must declare only client capabilities it can fulfill.
pub async fn read_resource_with_mrtr<F, Fut>(
    target: &McpTarget,
    uri: &str,
    client_capabilities: Value,
    resolve_input: F,
) -> Result<McpResourceRead>
where
    F: FnMut(Value) -> Fut,
    Fut: Future<Output = Result<Value>>,
{
    let mut conn = McpConnection::connect(target).await?;
    let result = conn
        .request_with_mrtr(
            "resources/read",
            json!({ "uri": uri }),
            client_capabilities,
            resolve_input,
        )
        .await;
    let modern = conn.modern;
    conn.shutdown().await;
    resource_read_from_result(&result?, uri, modern)
}
/// A persistent connection to an MCP server.
///
/// Unlike [`call_tool`] — which connects, negotiates, calls, and tears down a
/// fresh connection for *every* invocation (keeping the registry stateless) — an
/// `McpSession` holds one open across multiple `tools/call`s. That is
/// required for **stateful** tools whose effect spans two calls against the same
/// process: ghost's recording flow (`ghost_learn_start` … `ghost_learn_stop`)
/// holds an in-process input tap between the two calls, so they MUST hit the same
/// ghost subprocess. Drop or [`shutdown`](Self::shutdown) the session to kill the
/// child (the connection also `kill_on_drop`s its child as a backstop). Legacy
/// HTTP sessions carry `Mcp-Session-Id`; modern HTTP stays stateless and does not
/// create a protocol session.
pub struct McpSession {
    conn: McpConnection,
}

impl McpSession {
    /// Open the transport, negotiate its protocol, and keep it open for later calls.
    pub async fn connect(target: &McpTarget) -> Result<Self> {
        Ok(Self {
            conn: McpConnection::connect(target).await?,
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

    /// Drive modern MRTR input rounds on the live connection.
    pub async fn call_tool_full_with_mrtr<F, Fut>(
        &mut self,
        tool: &str,
        arguments: Value,
        client_capabilities: Value,
        resolve_input: F,
    ) -> Result<McpToolResult>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = Result<Value>>,
    {
        let raw = self
            .conn
            .request_with_mrtr(
                "tools/call",
                json!({ "name": tool, "arguments": arguments }),
                client_capabilities,
                resolve_input,
            )
            .await?;
        Ok(McpToolResult::from_result_value(raw))
    }

    /// Gracefully close the connection and kill the child process.
    pub async fn shutdown(self) {
        self.conn.shutdown().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ghost_cursor_identity_stays_in_mcp_meta_outside_tool_arguments() {
        let arguments = json!({ "x": 420, "y": 180 });
        let meta = json!({
            "ryu/ghostCursor": {
                "agentId": "@ryu/codex",
                "agentName": "Codex",
                "sessionTitle": "Polish the computer-use cursor",
            }
        });
        let params = tool_call_params("ghost_click", arguments.clone(), Some(meta.clone()))
            .expect("valid MCP metadata");

        assert_eq!(params["arguments"], arguments);
        assert_eq!(params["_meta"], meta);
        assert_eq!(params["name"], "ghost_click");
    }

    #[test]
    fn mcp_request_metadata_must_be_an_object() {
        let error = tool_call_params("ghost_click", json!({}), Some(json!("bad metadata")))
            .expect_err("metadata must be an object");
        assert!(error.to_string().contains("must be an object"));
    }

    #[tokio::test]
    async fn host_tool_metadata_concurrent_scopes_do_not_bleed() {
        let barrier = tokio::sync::Barrier::new(2);
        let first_meta = json!({ "ryu/ghostCursor": { "agentId": "agent-a" } });
        let second_meta = json!({ "ryu/ghostCursor": { "agentId": "agent-b" } });
        let first = with_tool_metadata(first_meta.clone(), async {
            barrier.wait().await;
            tokio::task::yield_now().await;
            Ok(tool_call_params("ghost_click", json!({ "x": 1 }), None)?)
        });
        let second = with_tool_metadata(second_meta.clone(), async {
            barrier.wait().await;
            tokio::task::yield_now().await;
            Ok(tool_call_params("ghost_click", json!({ "x": 2 }), None)?)
        });
        let (first, second) = tokio::join!(first, second);
        assert_eq!(first.expect("first scope")["_meta"], first_meta);
        assert_eq!(second.expect("second scope")["_meta"], second_meta);
        assert!(tool_call_params("ghost_click", json!({}), None)
            .expect("unscoped call")
            .get("_meta")
            .is_none());
    }

    #[tokio::test]
    async fn host_tool_metadata_nested_scopes_restore_outer_after_success_and_error() {
        let outer = json!({ "ryu/ghostCursor": { "agentId": "outer" } });
        let inner = json!({ "ryu/ghostCursor": { "agentId": "inner" } });
        with_tool_metadata(outer.clone(), async {
            with_tool_metadata(inner.clone(), async {
                assert_eq!(
                    tool_call_params("ghost_click", json!({}), None)?["_meta"],
                    inner
                );
                Ok(())
            })
            .await?;
            assert_eq!(
                tool_call_params("ghost_click", json!({}), None)?["_meta"],
                outer
            );
            let error = with_tool_metadata(inner.clone(), async {
                tokio::task::yield_now().await;
                assert_eq!(
                    tool_call_params("ghost_click", json!({}), None)?["_meta"],
                    inner
                );
                Err::<(), _>(anyhow!("caller failed"))
            })
            .await
            .expect_err("inner failure must propagate");
            assert_eq!(error.to_string(), "caller failed");
            assert_eq!(
                tool_call_params("ghost_click", json!({}), None)?["_meta"],
                outer
            );
            Ok(())
        })
        .await
        .expect("outer scope");
        assert!(tool_call_params("ghost_click", json!({}), None)
            .expect("after success")
            .get("_meta")
            .is_none());
        with_tool_metadata(outer, async { Err::<(), _>(anyhow!("outer failed")) })
            .await
            .expect_err("outer failure");
        assert!(tool_call_params("ghost_click", json!({}), None)
            .expect("after error")
            .get("_meta")
            .is_none());
    }

    #[tokio::test]
    async fn invalid_host_tool_metadata_never_polls_caller_future() {
        use std::sync::atomic::{AtomicBool, Ordering};
        for invalid in [Value::Null, json!("cursor"), json!([]), json!(42)] {
            let polled = AtomicBool::new(false);
            let error = with_tool_metadata(invalid, async {
                polled.store(true, Ordering::SeqCst);
                Ok(())
            })
            .await
            .expect_err("non-object metadata must fail");
            assert!(error.to_string().contains("must be an object"));
            assert!(
                !polled.load(Ordering::SeqCst),
                "invalid metadata executed caller"
            );
            assert!(tool_call_params("ghost_click", json!({}), None)
                .expect("unscoped after rejection")
                .get("_meta")
                .is_none());
        }
    }

    #[tokio::test]
    async fn stdio_server_script_resolves_against_its_declared_cwd() {
        // A plugin declares `python3 server.py` (or `node server.mjs`) with a path
        // relative to its package. The spawn must run in that directory; from any
        // other cwd the relative script does not exist and the server never starts.
        let package = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            package.path().join("server.py"),
            r#"
import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    if method == 'server/discover':
        result = {'resultType': 'complete', 'supportedVersions': [sys.argv[1]], 'capabilities': {'tools': {}}}
    elif method == 'tools/list':
        result = {'resultType': 'complete', 'ttlMs': 0, 'cacheScope': 'private', 'tools': [{'name': 'relative_ok', 'inputSchema': {'type': 'object'}}]}
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'unsupported method'}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"#,
        )
        .expect("write server script");
        let target_in = |cwd: Option<std::path::PathBuf>| {
            McpTarget::Stdio(McpStdioCommand {
                command: "python3".to_owned(),
                args: vec![
                    "-u".to_owned(),
                    "server.py".to_owned(),
                    MCP_HTTP_STATELESS_PROTOCOL_VERSION.to_owned(),
                ],
                env: Vec::new(),
                cwd,
            })
        };

        let tools = list_tools(&target_in(Some(package.path().to_path_buf())))
            .await
            .expect("the relative script runs from its package directory");
        assert_eq!(
            tools
                .iter()
                .map(|tool| tool.name.as_str())
                .collect::<Vec<_>>(),
            ["relative_ok"]
        );

        let elsewhere = tempfile::tempdir().expect("tempdir");
        assert!(
            list_tools(&target_in(Some(elsewhere.path().to_path_buf())))
                .await
                .is_err(),
            "from another directory the relative script is not found"
        );
    }

    #[tokio::test]
    async fn host_tool_metadata_survives_stdio_mrtr_elicitation_round_trip() {
        // A real stdio MCP peer drives discovery, input_required and retry through
        // the production client. Echoed wire params prove _meta survives the
        // actual transport rather than merely testing the retry builder.
        let script = r#"
import json, sys
first = None
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request.get('method')
    params = request.get('params', {})
    if method == 'server/discover':
        result = {'resultType': 'complete', 'supportedVersions': [sys.argv[1]], 'capabilities': {'tools': {}}}
    elif method == 'tools/call' and first is None:
        first = params
        result = {'resultType': 'input_required', 'requestState': 'opaque-form-state', 'inputRequests': {'confirm': {'type': 'elicitation', 'mode': 'form', 'message': 'Confirm click', 'requestedSchema': {'type': 'object', 'properties': {'approved': {'type': 'boolean'}}, 'required': ['approved']}}}}
    elif method == 'tools/call':
        result = {'resultType': 'complete', 'content': [], 'structuredContent': {'first': first, 'retry': params}}
    else:
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'error': {'code': -32601, 'message': 'unsupported method'}}), flush=True)
        continue
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"#;
        let target = McpTarget::Stdio(McpStdioCommand {
            command: "python3".to_owned(),
            args: vec![
                "-u".to_owned(),
                "-c".to_owned(),
                script.to_owned(),
                MCP_HTTP_STATELESS_PROTOCOL_VERSION.to_owned(),
            ],
            env: Vec::new(),
            cwd: None,
        });
        let meta = json!({ "ryu/ghostCursor": { "agentId": "agent-form", "sessionTitle": "Scoped click" } });
        let arguments = json!({ "x": 420, "y": 180 });
        let mut resolved = 0;
        let result = with_tool_metadata(meta.clone(), async {
            call_tool_full_with_mrtr(
                &target,
                "ghost_click",
                arguments.clone(),
                json!({ "elicitation": { "form": {} } }),
                |requests| {
                    resolved += 1;
                    assert_eq!(requests["confirm"]["type"], "elicitation");
                    assert_eq!(requests["confirm"]["requestedSchema"]["properties"]["approved"]["type"], "boolean");
                    assert_eq!(tool_call_params("ghost_click", json!({}), None).expect("resolver scope")["_meta"], meta);
                    async { Ok(json!({ "confirm": { "action": "accept", "content": { "approved": true } } })) }
                },
            ).await
        }).await.expect("MCP elicitation completes");
        assert_eq!(resolved, 1);
        let captured = result
            .structured_content
            .expect("peer captured actual requests");
        for round in ["first", "retry"] {
            assert_eq!(
                captured[round]["_meta"]["ryu/ghostCursor"],
                meta["ryu/ghostCursor"]
            );
            assert_eq!(
                captured[round]["_meta"]["io.modelcontextprotocol/protocolVersion"],
                MCP_HTTP_STATELESS_PROTOCOL_VERSION
            );
            assert_eq!(
                captured[round]["_meta"]["io.modelcontextprotocol/clientCapabilities"]
                    ["elicitation"],
                json!({ "form": {} })
            );
            assert_eq!(captured[round]["arguments"], arguments);
            assert!(captured[round]["arguments"].get("_meta").is_none());
            assert_eq!(captured[round]["name"], "ghost_click");
        }
        assert!(captured["first"].get("inputResponses").is_none());
        assert_eq!(captured["retry"]["requestState"], "opaque-form-state");
        assert_eq!(
            captured["retry"]["inputResponses"]["confirm"]["content"]["approved"],
            true
        );
        assert!(tool_call_params("ghost_click", json!({}), None)
            .expect("after MRTR completion")
            .get("_meta")
            .is_none());
    }

    #[tokio::test]
    async fn guarded_transport_errors_do_not_expose_endpoint_query_secrets() {
        let endpoint = "https://169.254.169.254/mcp?api_key=never-leak-this";
        let mut transport = HttpTransport {
            url: endpoint.to_owned(),
            headers: BTreeMap::new(),
            session_id: None,
            protocol_version: None,
            modern: true,
            pending: VecDeque::new(),
            streams: VecDeque::new(),
        };
        let error = transport
            .post(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call"}"#, &[])
            .await
            .expect_err("private endpoint must fail");
        assert!(!error.to_string().contains("never-leak-this"));

        let error = LegacySseTransport::connect(endpoint, &BTreeMap::new())
            .await
            .err()
            .expect("private SSE endpoint must fail");
        assert!(!error.to_string().contains("never-leak-this"));
    }

    #[test]
    fn modern_mcp_name_header_maps_only_standard_named_parameters() {
        assert_eq!(
            modern_name_header(&json!({
                "method": "tools/call",
                "params": { "name": "search" },
            })),
            Some("search")
        );
        assert_eq!(
            modern_name_header(&json!({
                "method": "resources/read",
                "params": { "uri": "file:///guide.md" },
            })),
            Some("file:///guide.md")
        );
        assert_eq!(
            modern_name_header(&json!({
                "method": "tasks/get",
                "params": { "taskId": "task-123" },
            })),
            Some("task-123")
        );
        assert_eq!(
            modern_name_header(&json!({
                "method": "events/subscribe",
                "params": { "name": "thread.run_status_changed" },
            })),
            None
        );
    }

    #[test]
    fn modern_requests_merge_required_protocol_metadata_without_dropping_custom_meta() {
        let params = with_modern_client_meta(
            json!({
                "name": "send_email",
                "_meta": {
                    "traceparent": "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
                    "custom/vendor-key": "preserved",
                    "io.modelcontextprotocol/protocolVersion": "stale",
                },
            }),
            json!({}),
        )
        .expect("modern request metadata");

        assert_eq!(
            params.pointer("/_meta/io.modelcontextprotocol~1protocolVersion"),
            Some(&json!("2026-07-28"))
        );
        assert_eq!(
            params.pointer("/_meta/io.modelcontextprotocol~1clientInfo/name"),
            Some(&json!("ryu-core"))
        );
        assert_eq!(
            params
                .get("_meta")
                .and_then(|meta| { meta.get("io.modelcontextprotocol/clientCapabilities") }),
            Some(&json!({}))
        );
        assert_eq!(
            params.pointer("/_meta/custom~1vendor-key"),
            Some(&json!("preserved"))
        );
        assert!(params.pointer("/_meta/traceparent").is_some());
        assert!(params.get("clientInfo").is_none());
    }

    #[test]
    fn modern_meta_rejects_non_object_params_and_capabilities() {
        assert!(with_modern_client_meta(json!([]), json!({})).is_err());
        assert!(with_modern_client_meta(json!({}), json!([])).is_err());
    }

    #[test]
    fn discovery_selects_only_a_supported_modern_protocol_version() {
        let modern = json!({
            "resultType": "complete",
            "supportedVersions": ["2025-11-25", "2026-07-28"],
        });
        let legacy_only = json!({
            "resultType": "complete",
            "supportedVersions": ["2025-11-25"],
        });
        assert!(supports_protocol_version(&modern, "2026-07-28"));
        assert!(!supports_protocol_version(&legacy_only, "2026-07-28"));
        assert!(!supports_protocol_version(&json!({}), "2026-07-28"));
    }

    #[test]
    fn discovery_fallback_distinguishes_legacy_from_modern_protocol_errors() {
        let method_not_found = anyhow!(McpRpcFailure {
            code: -32601,
            message: "method not found".to_owned(),
            data: None,
        });
        assert!(error_proves_legacy(&method_not_found));

        let unsupported_legacy_version = anyhow!(McpRpcFailure {
            code: -32022,
            message: "unsupported version".to_owned(),
            data: Some(json!({ "supported": ["2025-11-25"] })),
        });
        assert!(error_proves_legacy(&unsupported_legacy_version));

        let header_mismatch = anyhow!(McpRpcFailure {
            code: -32020,
            message: "header mismatch".to_owned(),
            data: None,
        });
        assert!(!error_proves_legacy(&header_mismatch));
    }

    #[test]
    fn modern_result_types_and_cache_hints_are_checked_at_the_protocol_boundary() {
        let listed = json!({
            "resultType": "complete",
            "ttlMs": 5000,
            "cacheScope": "public",
        });
        validate_modern_result("tools/list", &listed).expect("valid modern list result");
        assert_eq!(
            cache_hints_from_result(&listed, true).expect("cache hints"),
            Some(McpCacheHints {
                ttl_ms: 5000,
                scope: McpCacheScope::Public,
            })
        );

        assert!(validate_modern_result(
            "tools/list",
            &json!({
                "resultType": "complete",
            })
        )
        .is_err());
        validate_modern_result(
            "server/discover",
            &json!({ "resultType": "complete", "supportedVersions": ["2026-07-28"] }),
        )
        .expect("discovery is not a cacheable result");
        validate_modern_result(
            "resources/read",
            &json!({ "resultType": "input_required", "inputRequests": { "x": {} } }),
        )
        .expect("input_required is not a cacheable completion");
        assert!(validate_modern_result("tools/call", &json!({})).is_err());
        let task = json!({
            "resultType": "task",
            "taskId": "task-123",
            "status": "working",
            "createdAt": "2026-09-30T00:00:00Z",
            "lastUpdatedAt": "2026-09-30T00:00:00Z",
            "ttlMs": null,
            "pollIntervalMs": 1000,
        });
        validate_modern_result("tools/call", &task).expect("task result is valid");
        assert!(validate_modern_result("tasks/get", &task).is_err());
        assert!(validate_modern_result(
            "tools/call",
            &json!({ "resultType": "task", "taskId": "task-123" })
        )
        .is_err());
    }

    #[test]
    fn task_capability_is_opt_in_and_included_as_an_extension() {
        assert!(validate_mrtr_client_capabilities(&json!({})).is_ok());
        let capabilities = tasks_client_capabilities();
        assert!(validate_mrtr_client_capabilities(&capabilities).is_ok());
        assert!(client_supports_tasks(&capabilities));
        assert!(!client_supports_tasks(&json!({})));
        assert!(server_supports_tasks(&json!({
            "extensions": { "io.modelcontextprotocol/tasks": {} }
        })));
        assert!(!server_supports_tasks(&json!({ "tools": {} })));
    }

    #[test]
    fn task_poll_results_validate_status_payloads_and_terminal_states() {
        let task = McpTask::from_result_value(
            json!({
                "resultType": "complete",
                "taskId": "task-123",
                "status": "completed",
                "createdAt": "2026-09-30T00:00:00Z",
                "lastUpdatedAt": "2026-09-30T00:00:02Z",
                "ttlMs": 30_000,
                "result": { "content": [] },
            }),
            "complete",
        )
        .expect("completed task");
        assert_eq!(task.status, McpTaskStatus::Completed);
        assert!(task.status.is_terminal());
        assert_eq!(task.result, Some(json!({ "content": [] })));
        assert!(McpTask::from_result_value(
            json!({
                "resultType": "complete",
                "taskId": "task-123",
                "status": "input_required",
                "createdAt": "2026-09-30T00:00:00Z",
                "lastUpdatedAt": "2026-09-30T00:00:02Z",
                "ttlMs": 30_000,
            }),
            "complete",
        )
        .is_err());
    }

    #[test]
    fn legacy_cache_hints_are_optional_and_private_is_preserved() {
        assert_eq!(
            cache_hints_from_result(&json!({}), false).expect("legacy result"),
            None
        );
        assert_eq!(
            cache_hints_from_result(&json!({ "ttlMs": 0, "cacheScope": "private" }), false,)
                .expect("private no-cache hint"),
            Some(McpCacheHints {
                ttl_ms: 0,
                scope: McpCacheScope::Private,
            })
        );
    }

    #[test]
    fn mrtr_retries_echo_request_state_and_replace_responses_per_round() {
        let original = json!({
            "name": "collect",
            "arguments": { "topic": "MCP" },
            "inputResponses": { "stale": { "action": "accept" } },
            "requestState": "stale-state",
        });
        let first_result = json!({
            "resultType": "input_required",
            "inputRequests": { "topic": { "type": "elicitation" } },
            "requestState": "opaque state / round one",
        });
        let first = mrtr_retry_params(
            &original,
            &first_result,
            json!({ "topic": { "action": "accept", "content": { "topic": "MCP" } } }),
            0,
        )
        .expect("first MRTR retry");
        assert_eq!(first["requestState"], "opaque state / round one");
        assert_eq!(first["inputResponses"]["topic"]["action"], "accept");
        assert!(first["inputResponses"].get("stale").is_none());

        let second_result = json!({
            "resultType": "input_required",
            "inputRequests": { "confirm": { "type": "elicitation" } },
            "requestState": "opaque state / round two",
        });
        let second = mrtr_retry_params(
            &original,
            &second_result,
            json!({ "confirm": { "action": "accept" } }),
            1,
        )
        .expect("second MRTR retry");
        assert_eq!(second["requestState"], "opaque state / round two");
        assert_eq!(
            second["inputResponses"],
            json!({ "confirm": { "action": "accept" } })
        );
        assert!(second["inputResponses"].get("topic").is_none());
        assert_eq!(second["arguments"], original["arguments"]);
    }

    #[test]
    fn mrtr_retry_limit_and_response_keys_are_enforced() {
        let result = json!({
            "resultType": "input_required",
            "inputRequests": { "ok": { "type": "elicitation" } },
        });
        assert!(mrtr_retry_params(
            &json!({ "name": "tool" }),
            &result,
            json!({ "ok": { "action": "accept" } }),
            MCP_MRTR_MAX_ROUNDS,
        )
        .is_err());
        assert!(mrtr_retry_params(
            &json!({ "name": "tool" }),
            &result,
            json!({ "unknown": { "action": "accept" } }),
            0,
        )
        .is_err());
        assert!(mrtr_retry_params(&json!({ "name": "tool" }), &result, json!([]), 0,).is_err());
    }

    #[test]
    fn legacy_tool_results_default_to_complete_and_modern_results_keep_the_discriminator() {
        let legacy = McpToolResult::from_result_value(json!({ "content": [] }));
        assert_eq!(legacy.result_type, "complete");
        let modern = McpToolResult::from_result_value(json!({
            "resultType": "input_required",
            "inputRequests": { "name": { "type": "elicitation" } },
            "requestState": "opaque",
        }));
        assert_eq!(modern.result_type, "input_required");
        assert_eq!(modern.raw["requestState"], "opaque");
    }

    #[test]
    fn modern_http_json_rpc_errors_are_correlated_and_redacted() {
        let request = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "server/discover",
            "params": {},
        })
        .to_string();
        let body = json!({
            "jsonrpc": "2.0",
            "id": 7,
            "error": { "code": -32020, "message": "echoed synthetic-secret" },
        })
        .to_string();
        let configured =
            BTreeMap::from([("Authorization".to_owned(), "synthetic-secret".to_owned())]);

        let frame = matching_http_rpc_error(&request, &body, &configured)
            .expect("the matching in-band error");
        assert!(!frame.contains("synthetic-secret"));
        assert_eq!(
            serde_json::from_str::<Value>(&frame).expect("redacted JSON-RPC error")["error"]
                ["code"],
            -32020
        );

        let wrong_id = json!({
            "jsonrpc": "2.0",
            "id": 8,
            "error": { "code": -32020, "message": "wrong response" },
        })
        .to_string();
        assert!(matching_http_rpc_error(&request, &wrong_id, &configured).is_none());
    }
    /// The SSRF screen the HTTP transport runs before it POSTs anything.
    ///
    /// Asserted through [`crate::server::screen_egress_url_with`] — the env-free
    /// core of the screen — rather than by setting `RYU_AGENT_EGRESS_ALLOW_HOSTS`
    /// in the process. Core's tests all share ONE bin-target process, so a
    /// `set_var` here would race every other test in the binary: it would pass
    /// alone and flake in the suite, which is worse than no test at all.
    ///
    /// A literal IP needs no DNS, so neither of these touches the network.
    #[tokio::test]
    async fn http_target_rejects_metadata_ip() {
        // The cloud-metadata endpoint. This is THE reason the guard exists: the
        // moment Core fetches a user-supplied MCP URL in-process, an entry
        // pointing here would read the host's instance credentials.
        let err = crate::server::screen_egress_url_with("http://169.254.169.254/mcp", true, None)
            .await
            .expect_err("the link-local metadata address must be refused");
        let msg = err.to_string();
        assert!(
            msg.contains("169.254.169.254"),
            "the refusal must name the host it blocked: {msg}"
        );
        assert!(
            msg.contains("RYU_AGENT_EGRESS_ALLOW_HOSTS"),
            "the refusal must name the documented escape hatch: {msg}"
        );

        // Not allowlisted by a DIFFERENT host, either — the allowlist is exact.
        assert!(
            crate::server::screen_egress_url_with(
                "http://169.254.169.254/mcp",
                true,
                Some("127.0.0.1")
            )
            .await
            .is_err(),
            "an allowlist entry for another host must not unblock metadata"
        );
    }

    /// `http://127.0.0.1:3000/mcp` is the single most common remote-MCP dev
    /// target, and it is blocked by default *by design* (loopback is exactly what
    /// SSRF reaches for). The allowlist is the one supported way through, and it
    /// must actually work — a screen with no usable escape hatch makes the whole
    /// feature look broken to the first developer who tries it.
    #[tokio::test]
    async fn http_target_allows_loopback_when_allowlisted() {
        // Blocked without the allowlist…
        assert!(
            crate::server::screen_egress_url_with("http://127.0.0.1:3000/mcp", true, None)
                .await
                .is_err(),
            "loopback must be refused by default"
        );

        // …allowed with it, and `http` (not just `https`) must survive the scheme
        // check, since a local dev MCP server is never TLS.
        let url = crate::server::screen_egress_url_with(
            "http://127.0.0.1:3000/mcp",
            true,
            Some("example.com, 127.0.0.1"),
        )
        .await
        .expect("an allowlisted loopback host must pass the screen");
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.port(), Some(3000));

        // A non-http(s) scheme is refused regardless of the allowlist — the
        // allowlist widens which HOSTS are reachable, never which protocols.
        assert!(
            crate::server::screen_egress_url_with("file:///etc/passwd", true, Some("*"))
                .await
                .is_err()
        );
    }

    #[test]
    fn legacy_sse_origin_policy_distinguishes_cross_origin_endpoints() {
        let base = url::Url::parse("https://mcp.example.com/sse").unwrap();
        let same = url::Url::parse("https://mcp.example.com/message").unwrap();
        let different_host = url::Url::parse("https://messages.example.com/post").unwrap();
        let different_port = url::Url::parse("https://mcp.example.com:8443/post").unwrap();

        assert!(same_http_origin(base.as_str(), same.as_str()));
        assert!(!same_http_origin(base.as_str(), different_host.as_str()));
        assert!(!same_http_origin(base.as_str(), different_port.as_str()));
    }

    #[test]
    fn http_failures_redact_all_configured_header_values() {
        let configured = BTreeMap::from([
            (
                "Authorization".to_owned(),
                "Bearer bearer-secret".to_owned(),
            ),
            ("X-API-Key".to_owned(), "api-secret".to_owned()),
        ]);
        let mut response_headers = reqwest::header::HeaderMap::new();
        response_headers.insert(
            reqwest::header::WWW_AUTHENTICATE,
            reqwest::header::HeaderValue::from_static("Bearer bearer-secret"),
        );

        let error = ensure_http_success(
            "https://mcp.example.com/mcp",
            &configured,
            reqwest::StatusCode::UNAUTHORIZED,
            &response_headers,
            "echoed api-secret and bearer-secret",
        )
        .expect_err("an unauthorized response must fail");
        let failure = error
            .downcast_ref::<McpHttpFailure>()
            .expect("the sanitized failure should remain downcastable");

        assert!(!failure.body_snippet.contains("api-secret"));
        assert!(!failure.body_snippet.contains("bearer-secret"));
        assert!(!failure
            .www_authenticate
            .as_deref()
            .unwrap_or_default()
            .contains("bearer-secret"));
    }

    /// A Streamable-HTTP endpoint may answer one POST with an event stream that
    /// interleaves progress notifications and unrelated responses around our
    /// answer. Correlation by JSON-RPC `id` — not "take the first frame" — is what
    /// makes that safe, and this asserts the exact pair of functions the transport
    /// runs: [`sse_data_frames`] to split the body, [`classify_frame`] to pick.
    #[test]
    fn sse_response_frame_is_correlated_by_id() {
        let body = "event: message\n\
                    data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\",\"params\":{}}\n\
                    \n\
                    event: message\n\
                    data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"stale\":true}}\n\
                    \n\
                    : a comment line the parser ignores\n\
                    data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"tools\":[]}}\n\
                    \n";

        let frames = sse_data_frames(body);
        assert_eq!(frames.len(), 3, "one frame per `data:` event: {frames:?}");

        // The frame we asked for is the third one; the notification (no id) and
        // the response to a different id must both be skipped, not returned.
        let mut answered = None;
        for frame in &frames {
            match classify_frame(frame, 7) {
                FrameVerdict::Skip => continue,
                FrameVerdict::Failed(e) => panic!("unexpected error frame: {e}"),
                FrameVerdict::Done(result) => {
                    answered = Some(result);
                    break;
                }
            }
        }
        assert_eq!(
            answered,
            Some(json!({ "tools": [] })),
            "the id-7 result must win over the earlier id-1 frame"
        );

        // A JSON-RPC error carrying OUR id is surfaced, not skipped.
        let err_frames =
            sse_data_frames("data: {\"jsonrpc\":\"2.0\",\"id\":3,\"error\":{\"code\":-32601}}\n\n");
        let FrameVerdict::Failed(msg) = classify_frame(&err_frames[0], 3) else {
            panic!("an error frame with a matching id must fail the request");
        };
        assert_eq!(msg.code, -32601);
    }

    /// A stream whose last event has no trailing blank line still yields its
    /// frame. Dropping it would hang the caller until the 60 s RPC deadline for
    /// what is a perfectly well-formed response.
    #[test]
    fn sse_last_frame_without_trailing_blank_line_is_kept() {
        let frames = sse_data_frames("data: {\"id\":1,\"result\":42}");
        assert_eq!(frames, vec!["{\"id\":1,\"result\":42}".to_owned()]);
    }

    #[tokio::test]
    async fn http_form_request_is_received_before_the_result_stream_closes() {
        use tokio::io::AsyncReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (release, released) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            // Read through the end of the request headers: one read can return
            // only part of them.
            let mut request = Vec::new();
            let mut chunk = [0_u8; 4096];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = socket.read(&mut chunk).await.unwrap();
                assert!(read > 0, "the client closed before sending its request");
                request.extend_from_slice(&chunk[..read]);
            }
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n").await.unwrap();
            let event = "data: {\"jsonrpc\":\"2.0\",\"id\":\"form-1\",\"method\":\"openai/elicitation/create\",\"params\":{\"mode\":\"form\"}}\n\n";
            socket
                .write_all(format!("{:x}\r\n{event}\r\n", event.len()).as_bytes())
                .await
                .unwrap();
            socket.flush().await.unwrap();
            released.await.unwrap();
            socket.write_all(b"0\r\n\r\n").await.unwrap();
        });
        // Only the test fixture constructs its raw response. Production POSTs
        // retain the guarded URL/pinning/redirect boundary.
        let response = reqwest::get(format!("http://{address}")).await.unwrap();
        let mut transport = Transport::Http(HttpTransport {
            url: format!("http://{address}"),
            headers: BTreeMap::new(),
            session_id: None,
            protocol_version: None,
            modern: false,
            pending: VecDeque::new(),
            streams: VecDeque::from([SseReader::new(response)]),
        });
        let frame = tokio::time::timeout(Duration::from_secs(2), transport.recv())
            .await
            .expect("elicitation must be read while the HTTP result is still pending")
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&frame).unwrap()["method"],
            "openai/elicitation/create"
        );
        release.send(()).unwrap();
        assert!(transport.recv().await.unwrap().is_none());
        server.await.unwrap();
    }

    #[test]
    fn batch_response_is_correlated_by_id() {
        let frame = r#"[
            {"jsonrpc":"2.0","id":2,"result":{"stale":true}},
            {"jsonrpc":"2.0","id":9,"result":{"ok":true}}
        ]"#;
        assert!(matches!(
            classify_frame(frame, 9),
            FrameVerdict::Done(result) if result == json!({"ok": true})
        ));
        assert!(matches!(classify_frame(frame, 7), FrameVerdict::Skip));
    }

    /// Multi-line `data:` payloads join with `\n`, per the SSE grammar — a server
    /// that pretty-prints its JSON must still parse.
    #[test]
    fn sse_multiline_data_frames_are_joined() {
        let frames = sse_data_frames("data: {\"id\":1,\ndata: \"result\":42}\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(&frames[0]).expect("joined payload is valid JSON")["id"],
            json!(1)
        );
    }

    #[test]
    fn extract_unwraps_text_json() {
        let env = json!({ "content": [{ "type": "text", "text": "{\"a\":1}" }] });
        assert_eq!(extract_mcp_json(&env).unwrap(), json!({ "a": 1 }));
    }

    #[test]
    fn extract_surfaces_is_error() {
        let env =
            json!({ "content": [{ "type": "text", "text": "Error: boom" }], "isError": true });
        let err = extract_mcp_json(&env).unwrap_err().to_string();
        assert!(err.contains("boom"), "unexpected error: {err}");
    }

    #[test]
    fn extract_falls_back_to_plain_text() {
        let env = json!({ "content": [{ "type": "text", "text": "not json" }] });
        assert_eq!(extract_mcp_json(&env).unwrap(), json!("not json"));
    }

    #[test]
    fn extract_returns_whole_result_when_no_content() {
        // No `content` array ⇒ the raw result is returned verbatim.
        let env = json!({ "some": "value" });
        assert_eq!(extract_mcp_json(&env).unwrap(), env);
    }

    #[test]
    fn extract_returns_clone_when_text_missing() {
        let env = json!({ "content": [{ "type": "image" }] });
        assert_eq!(extract_mcp_json(&env).unwrap(), env);
    }

    #[test]
    fn extract_is_error_without_text_uses_default_message() {
        let env = json!({ "content": [{ "type": "text" }], "isError": true });
        let err = extract_mcp_json(&env).unwrap_err().to_string();
        assert!(err.contains("tool error"), "unexpected: {err}");
    }

    #[test]
    fn from_result_value_splits_all_channels() {
        let raw = json!({
            "content": [{ "type": "text", "text": "hello" }],
            "structuredContent": { "answer": 42 },
            "_meta": { "ryu/outputTemplate": "ui://widget" },
            "isError": false,
        });
        let result = McpToolResult::from_result_value(raw.clone());
        assert_eq!(
            result.content,
            Some(json!([{ "type": "text", "text": "hello" }]))
        );
        assert_eq!(result.structured_content, Some(json!({ "answer": 42 })));
        assert_eq!(
            result.meta,
            Some(json!({ "ryu/outputTemplate": "ui://widget" }))
        );
        assert!(!result.is_error);
        // The raw value is preserved untouched.
        assert_eq!(result.raw, raw);
    }

    #[test]
    fn from_result_value_defaults_missing_channels_to_none() {
        let result = McpToolResult::from_result_value(json!({}));
        assert!(result.structured_content.is_none());
        assert!(result.content.is_none());
        assert!(result.meta.is_none());
        assert!(!result.is_error, "isError defaults to false when absent");
    }

    #[test]
    fn from_result_value_reads_is_error_true() {
        let result = McpToolResult::from_result_value(json!({
            "content": [{ "type": "text", "text": "boom" }],
            "isError": true,
        }));
        assert!(result.is_error);
        assert!(result.content.is_some());
    }

    #[test]
    fn from_result_value_ignores_non_bool_is_error() {
        // A non-boolean `isError` (spec violation) must not be coerced to true;
        // `as_bool` returns None and the field falls back to the false default.
        let result = McpToolResult::from_result_value(json!({ "isError": "yes" }));
        assert!(!result.is_error);
    }

    #[test]
    fn from_result_value_tolerates_non_object_raw() {
        // A non-object result (e.g. the server returned a bare array) yields all
        // None channels rather than panicking, and preserves the raw value.
        let raw = json!(["not", "an", "object"]);
        let result = McpToolResult::from_result_value(raw.clone());
        assert!(result.structured_content.is_none());
        assert!(result.content.is_none());
        assert!(result.meta.is_none());
        assert!(!result.is_error);
        assert_eq!(result.raw, raw);
    }
}
