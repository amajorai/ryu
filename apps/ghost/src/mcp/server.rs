// MCP JSON-RPC server over stdio.
// Transport: auto-detect Content-Length (Claude Code) vs NDJSON (Claude Desktop).
// stdout is used exclusively for MCP protocol. All logging goes to stderr via tracing.

use std::io::{BufRead, BufReader, Write};
use serde_json::{json, Value};

use super::{dispatch, tools};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "ghost";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");

const INSTRUCTIONS: &str = "\
Ghost gives you eyes and hands on any desktop app. \
Call ghost_recipes first for multi-step tasks. \
Call ghost_context before acting on any app. \
Use ghost_find to locate elements. \
Always pass the app parameter to action tools. \
Use ghost_annotate for visual orientation (numbered labels on screenshot). \
Use ghost_ground when AX tree returns generic elements.";

#[derive(Debug, Clone, Copy, PartialEq)]
enum Transport {
    Unknown,
    ContentLength,
    NdJson,
}

pub async fn run() {
    tracing::info!("Ghost MCP server v{SERVER_VERSION} starting");

    let stdin  = std::io::stdin();
    let stdout = std::io::stdout();

    let mut reader  = BufReader::new(stdin.lock());
    let mut out     = stdout.lock();
    let mut transport = Transport::Unknown;

    loop {
        match read_message(&mut reader, &mut transport) {
            None => break,
            Some(msg) => {
                let response = handle_message(msg).await;
                if let Some(resp) = response {
                    write_message(&mut out, &resp, transport);
                }
            }
        }
    }

    tracing::info!("stdin closed, shutting down");
}

async fn handle_message(msg: Value) -> Option<Value> {
    let method = msg["method"].as_str()?;
    let id     = msg.get("id").cloned();
    let params = msg["params"].as_object().cloned().unwrap_or_default();

    match method {
        "initialize" => id.map(|id| json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                "instructions": INSTRUCTIONS,
            }
        })),

        "notifications/initialized" => {
            tracing::info!("MCP client initialized");
            None
        }

        "tools/list" => id.map(|id| json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "tools": tools::definitions() }
        })),

        "tools/call" => {
            let Some(id) = id else { return None };
            let tool_name = params.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let tool_input = params.get("arguments").cloned().unwrap_or(json!({}));

            let result = dispatch::dispatch(tool_name, tool_input).await;
            Some(match result {
                Ok(content) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "content": [{ "type": "text", "text": content.to_string() }] }
                }),
                Err(e) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": format!("Error: {}", e) }],
                        "isError": true
                    }
                }),
            })
        }

        "ping" => id.map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": {} })),

        _ => id.map(|id| json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Method not found: {method}") }
        })),
    }
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

fn read_message(reader: &mut BufReader<impl std::io::Read>, transport: &mut Transport) -> Option<Value> {
    if *transport == Transport::Unknown {
        // Peek first byte to detect transport
        let first = peek_first_byte(reader)?;
        *transport = if first == b'C' { Transport::ContentLength } else { Transport::NdJson };
    }

    match transport {
        Transport::ContentLength => read_content_length(reader),
        Transport::NdJson | Transport::Unknown => read_ndjson(reader),
    }
}

fn peek_first_byte(reader: &mut BufReader<impl std::io::Read>) -> Option<u8> {
    let buf = reader.fill_buf().ok()?;
    buf.first().copied()
}

fn read_content_length(reader: &mut BufReader<impl std::io::Read>) -> Option<Value> {
    // Read header lines until blank line
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');
        if line.is_empty() { break; }
        if let Some(rest) = line.strip_prefix("Content-Length: ") {
            content_length = rest.trim().parse().ok();
        }
    }

    let length = content_length?;
    let mut body = vec![0u8; length];
    use std::io::Read;
    reader.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body).ok()
}

fn read_ndjson(reader: &mut BufReader<impl std::io::Read>) -> Option<Value> {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).ok()?;
        if n == 0 { return None; }
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            return serde_json::from_str(trimmed).ok();
        }
    }
}

fn write_message(out: &mut impl Write, value: &Value, transport: Transport) {
    let data = match serde_json::to_vec(value) {
        Ok(d) => d,
        Err(e) => { tracing::error!("Serialize error: {e}"); return; }
    };

    let result = match transport {
        Transport::ContentLength => {
            write!(out, "Content-Length: {}\r\n\r\n", data.len())
                .and_then(|_| out.write_all(&data))
                .and_then(|_| out.flush())
        }
        _ => {
            out.write_all(&data)
                .and_then(|_| out.write_all(b"\n"))
                .and_then(|_| out.flush())
        }
    };

    if let Err(e) = result {
        tracing::error!("Write error: {e}");
    }
}
