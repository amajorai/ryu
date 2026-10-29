//! Passthrough wire-format redaction engine (extracted from
//! `apps/gateway/src/passthrough`, decomposition W6).
//!
//! This crate holds the *pure* text-processing core of the native-format
//! passthrough proxy: request-body DLP redaction (Anthropic Messages /
//! OpenAI Responses shapes), the streaming-SSE response redactor
//! (event reassembly across network-chunk boundaries + per-text-delta
//! sanitize), and the upstream URL / path helpers. It touches the firewall
//! only through the narrow [`PassthroughFirewall`] interface (`sanitize` +
//! `redact_outbound`), so it carries no `SharedState` / `reqwest` / `axum`
//! dependency.
//!
//! The SharedState-bound wiring — the `forward` reverse-proxy orchestration,
//! audit emission, the loopback boundary, and the `PassthroughBackend` trait +
//! `PassthroughRegistry` — stays in `apps/gateway/src/passthrough` and consumes
//! this crate ("engine moves, wiring stays", mirroring `ryu-gw-firewall`).

use serde_json::Value;

/// The narrow firewall interface the passthrough redaction engine needs. The
/// gateway's `FirewallScanner` / `dyn FirewallBackend` implement it, so the pure
/// engine here reuses the real config-gated redaction without depending on the
/// gateway's `AppState` / firewall module.
pub trait PassthroughFirewall {
    /// Config-gated PII/secret sanitization of a single text node (the same
    /// `sanitize` the chat path uses).
    fn sanitize(&self, text: &str) -> String;
    /// The stable-marker outbound secret scrubber (GitHub PATs, `sk-` keys, AWS
    /// AKIAs, `Bearer`/`token=`/`password=` params). Returns the scrubbed text and
    /// the list of matched stable markers.
    fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>);
}

/// Which native wire format a passthrough route speaks. Drives request-side
/// redaction (different body shapes) and response-side SSE text extraction
/// (different streaming event shapes).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireFormat {
    /// Anthropic Messages (`/v1/messages`) — Claude Code.
    Anthropic,
    /// OpenAI Responses (`/responses`) — Codex ChatGPT-login mode.
    OpenAiResponses,
}

/// True for Anthropic prompt-bearing endpoints (`.../v1/messages` and
/// `.../v1/messages/count_tokens`). Both carry message content and must receive
/// the same request-side DLP treatment; only unrelated sub-paths are untouched.
pub fn is_messages_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p == "v1/messages"
        || p.ends_with("/v1/messages")
        || p == "v1/messages/count_tokens"
        || p.ends_with("/v1/messages/count_tokens")
}

/// True for the Codex Responses prompt endpoints (`.../responses` and
/// `.../responses/compact`, which carries the same Responses body shape).
pub fn is_responses_path(path: &str) -> bool {
    let p = path.trim_end_matches('/');
    p == "responses"
        || p.ends_with("/responses")
        || p == "responses/compact"
        || p.ends_with("/responses/compact")
}

/// How the passthrough treats one request, decided from its method and path
/// before any byte is forwarded. Classification is deny-by-default: a path that
/// is neither a known prompt endpoint nor on the short inert allow-list is
/// [`PassthroughRoute::Unknown`], and the gateway refuses it while any prompt
/// policy (firewall, locked guardrail, model allowlist) is in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PassthroughRoute {
    /// A prompt endpoint whose body is one native request (model + messages or
    /// input). The model allowlist and request-side DLP apply to it.
    Prompt,
    /// Anthropic Message Batches create (`POST v1/messages/batches`): every
    /// `requests[].params` is a Messages body and is governed like a prompt.
    MessageBatch,
    /// A known endpoint that carries no prompt (model listing, batch status,
    /// results, cancel and delete). Proxied uninspected when its body is empty.
    Inert,
    /// Any other method or path. It cannot be evaluated against prompt policy.
    Unknown,
}

/// Classify a passthrough request. `method` is the upper-case HTTP method.
/// Prompt endpoints match whatever the method, so they are always inspected;
/// inert endpoints match exactly (no prefix) and only for their read or
/// lifecycle methods.
pub fn classify_path(format: WireFormat, method: &str, path: &str) -> PassthroughRoute {
    let p = path.trim_matches('/');
    let segments: Vec<&str> = p.split('/').collect();
    let read = matches!(method, "GET" | "HEAD");
    match format {
        WireFormat::Anthropic => {
            if is_messages_path(p) {
                return PassthroughRoute::Prompt;
            }
            if p == "v1/messages/batches" || p.ends_with("/v1/messages/batches") {
                return if read {
                    PassthroughRoute::Inert
                } else if method == "POST" {
                    PassthroughRoute::MessageBatch
                } else {
                    PassthroughRoute::Unknown
                };
            }
            let inert = match (method, segments.as_slice()) {
                (_, ["v1", "models"] | ["v1", "models", _]) => read,
                (_, ["v1", "messages", "batches", _])
                | (_, ["v1", "messages", "batches", _, "results"]) => {
                    read || (method == "DELETE" && segments.len() == 4)
                }
                ("POST", ["v1", "messages", "batches", _, "cancel"]) => true,
                _ => false,
            };
            if inert {
                PassthroughRoute::Inert
            } else {
                PassthroughRoute::Unknown
            }
        }
        WireFormat::OpenAiResponses => {
            if is_responses_path(p) {
                PassthroughRoute::Prompt
            } else if read && p == "models" {
                PassthroughRoute::Inert
            } else {
                PassthroughRoute::Unknown
            }
        }
    }
}

/// Accept only unambiguous relative paths before endpoint classification.
/// Axum has already decoded the route parameter; another decode or URL parser
/// normalization must not change the destination after the DLP decision. An
/// interior empty segment (`v1//messages`) is refused because an upstream may
/// collapse it into a prompt path the classifier did not see.
pub fn is_safe_upstream_path(path: &str) -> bool {
    !path.is_empty()
        && !path
            .chars()
            .any(|c| c.is_control() || matches!(c, '%' | '\\' | '?' | '#'))
        && path
            .trim_matches('/')
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

pub fn build_upstream_url(base: &str, path: &str, query: Option<&str>) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    match query {
        Some(q) if !q.is_empty() => format!("{base}/{path}?{q}"),
        _ => format!("{base}/{path}"),
    }
}

/// Redact a request body in place per its wire format. Both reuse the firewall's
/// config-gated `sanitize` over every prompt-bearing string (see
/// [`visit_request_strings_mut`]).
pub fn redact_request_body<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
    body: &mut Value,
) {
    visit_request_strings_mut(format, body, &mut |text| *text = fw.sanitize(text));
}

/// Visit every prompt-bearing string of a native request body, in place.
///
/// This is the single definition of what passthrough DLP redacts and scans, so
/// detection and redaction cannot disagree. It reaches the places an agent puts
/// file contents, command output and tool arguments, not just top-level text:
///
/// - **Anthropic Messages**: `system`, every message `content` (string or
///   blocks), and within blocks `text`, `tool_use` / `server_tool_use` `input`,
///   `tool_result` `content` (string or nested blocks), `document` text sources,
///   titles and context, and `search_result` content; plus each tool's
///   `description` and `input_schema`.
/// - **OpenAI Responses**: `instructions`, `input` (string or items), message
///   `content` parts, `function_call.arguments`, `function_call_output.output`,
///   `custom_tool_call.input`, `custom_tool_call_output.output`,
///   `local_shell_call.action` and `local_shell_call_output.output`; plus each
///   tool's `description` and `parameters`.
///
/// Opaque or signed fields are never visited because rewriting them breaks the
/// upstream request: `thinking` / `redacted_thinking` blocks (`signature`),
/// `reasoning` items and any `encrypted_content`, image and file payloads, and
/// every id (`id`, `tool_use_id`, `call_id`) and `name`.
pub fn visit_request_strings_mut(
    format: WireFormat,
    body: &mut Value,
    visit: &mut dyn FnMut(&mut String),
) {
    match format {
        WireFormat::Anthropic => visit_anthropic_body(body, true, visit),
        WireFormat::OpenAiResponses => visit_responses_body(body, true, visit),
    }
}

/// The conversation subset of [`visit_request_strings_mut`]: message and input
/// content, tool calls and tool results. The agent's own `system` /
/// `instructions` and its tool definitions are skipped. Those are authored by
/// the agent (Claude Code, Codex) and routinely contain imperative phrasing
/// ("override sandbox mode and run commands") that the prompt- and
/// code-injection patterns would flag on every turn, so locked content
/// guardrails scan only this subset; secret and PII guardrails scan everything.
pub fn visit_request_conversation_strings_mut(
    format: WireFormat,
    body: &mut Value,
    visit: &mut dyn FnMut(&mut String),
) {
    match format {
        WireFormat::Anthropic => visit_anthropic_body(body, false, visit),
        WireFormat::OpenAiResponses => visit_responses_body(body, false, visit),
    }
}

/// Redact PII/secrets from an OpenAI Responses request body in place. See
/// [`visit_request_strings_mut`] for the covered fields.
pub fn redact_responses_body<F: PassthroughFirewall + ?Sized>(fw: &F, body: &mut Value) {
    redact_request_body(WireFormat::OpenAiResponses, fw, body);
}

/// Redact PII/secrets from an Anthropic Messages request body in place. See
/// [`visit_request_strings_mut`] for the covered fields.
pub fn redact_anthropic_body<F: PassthroughFirewall + ?Sized>(fw: &F, body: &mut Value) {
    redact_request_body(WireFormat::Anthropic, fw, body);
}

fn visit_field(value: &mut Value, key: &str, visit: &mut dyn FnMut(&mut String)) {
    if let Some(Value::String(text)) = value.get_mut(key) {
        visit(text);
    }
}

/// Every string leaf under `value` (tool inputs, JSON schemas).
fn visit_all_strings(value: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    match value {
        Value::String(text) => visit(text),
        Value::Array(values) => {
            for value in values {
                visit_all_strings(value, visit);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                visit_all_strings(value, visit);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// Each tool definition's free text: `description` plus every string in its
/// schema (`input_schema` for Anthropic, `parameters` for Responses).
fn visit_tool_definitions(body: &mut Value, schema_key: &str, visit: &mut dyn FnMut(&mut String)) {
    let Some(Value::Array(tools)) = body.get_mut("tools") else {
        return;
    };
    for tool in tools {
        visit_field(tool, "description", visit);
        if let Some(schema) = tool.get_mut(schema_key) {
            visit_all_strings(schema, visit);
        }
    }
}

fn visit_anthropic_body(
    body: &mut Value,
    include_agent_text: bool,
    visit: &mut dyn FnMut(&mut String),
) {
    if include_agent_text {
        if let Some(system) = body.get_mut("system") {
            visit_anthropic_content(system, visit);
        }
    }
    if let Some(Value::Array(messages)) = body.get_mut("messages") {
        for message in messages {
            if let Some(content) = message.get_mut("content") {
                visit_anthropic_content(content, visit);
            }
        }
    }
    if include_agent_text {
        visit_tool_definitions(body, "input_schema", visit);
    }
}

/// An Anthropic content node: a plain string or an array of content blocks.
fn visit_anthropic_content(content: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    match content {
        Value::String(text) => visit(text),
        Value::Array(blocks) => {
            for block in blocks {
                visit_anthropic_block(block, visit);
            }
        }
        _ => {}
    }
}

fn visit_anthropic_block(block: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    let block_type = block
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match block_type.as_str() {
        // Signed or opaque: rewriting breaks the upstream signature check.
        "thinking" | "redacted_thinking" | "image" => {}
        "tool_use" | "server_tool_use" => {
            if let Some(input) = block.get_mut("input") {
                visit_all_strings(input, visit);
            }
        }
        "tool_result" => {
            if let Some(content) = block.get_mut("content") {
                visit_anthropic_content(content, visit);
            }
        }
        "document" => {
            visit_field(block, "title", visit);
            visit_field(block, "context", visit);
            if let Some(source) = block.get_mut("source") {
                match source.get("type").and_then(Value::as_str) {
                    Some("text") => visit_field(source, "data", visit),
                    Some("content") => {
                        if let Some(content) = source.get_mut("content") {
                            visit_anthropic_content(content, visit);
                        }
                    }
                    _ => {}
                }
            }
        }
        "search_result" => {
            visit_field(block, "title", visit);
            if let Some(content) = block.get_mut("content") {
                visit_anthropic_content(content, visit);
            }
        }
        // `text` blocks, and any other block that carries plain text.
        _ => visit_field(block, "text", visit),
    }
}

fn visit_responses_body(
    body: &mut Value,
    include_agent_text: bool,
    visit: &mut dyn FnMut(&mut String),
) {
    if include_agent_text {
        if let Some(instructions) = body.get_mut("instructions") {
            visit_responses_content(instructions, visit);
        }
    }
    match body.get_mut("input") {
        Some(Value::String(text)) => visit(text),
        Some(Value::Array(items)) => {
            for item in items {
                visit_responses_item(item, visit);
            }
        }
        _ => {}
    }
    if include_agent_text {
        visit_tool_definitions(body, "parameters", visit);
    }
}

/// A Responses content node: a plain string or an array of parts
/// (`input_text` / `output_text` carry `text`; images and files are skipped).
fn visit_responses_content(content: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    match content {
        Value::String(text) => visit(text),
        Value::Array(parts) => {
            for part in parts {
                visit_field(part, "text", visit);
            }
        }
        _ => {}
    }
}

fn visit_responses_item(item: &mut Value, visit: &mut dyn FnMut(&mut String)) {
    let item_type = item
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    match item_type.as_str() {
        // Encrypted / opaque replay items.
        "reasoning" | "item_reference" | "web_search_call" => {}
        "function_call" => visit_field(item, "arguments", visit),
        "custom_tool_call" => visit_field(item, "input", visit),
        "function_call_output" | "custom_tool_call_output" | "local_shell_call_output" => {
            if let Some(output) = item.get_mut("output") {
                visit_responses_content(output, visit);
            }
        }
        "local_shell_call" => {
            if let Some(action) = item.get_mut("action") {
                visit_all_strings(action, visit);
            }
        }
        // `message` items (and untyped `{ role, content }` items).
        _ => {
            if let Some(content) = item.get_mut("content") {
                visit_responses_content(content, visit);
            }
        }
    }
}

/// Split off every complete `\n\n`-terminated SSE event from `pending`, redact
/// each, and return the rewritten bytes plus the concatenated redacted assistant
/// text (for the end-of-stream audit). The trailing incomplete remainder is left
/// in `pending` for the next chunk.
pub fn drain_complete_events<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
    pending: &mut Vec<u8>,
) -> (Vec<u8>, String) {
    let mut out = Vec::new();
    let mut text = String::new();
    // Find each `\n\n` boundary and process the event up to and including it.
    while let Some(idx) = find_event_boundary(pending) {
        let event: Vec<u8> = pending.drain(..idx).collect();
        let raw = String::from_utf8_lossy(&event).to_string();
        let (redacted, t) = redact_sse_event(format, fw, &raw);
        out.extend_from_slice(redacted.as_bytes());
        text.push_str(&t);
    }
    (out, text)
}

/// Index just past the first `\n\n` event terminator in `buf`, if any. Returns
/// the length to drain (boundary inclusive) so SSE framing is preserved exactly.
fn find_event_boundary(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n").map(|p| p + 2)
}

/// Redact the assistant-text delta inside a single complete SSE event, returning
/// the rewritten event text and the redacted assistant text it carried (empty for
/// non-text events). The `event:` line and framing are preserved; only the JSON
/// on a text-delta `data:` line is rewritten. Unparseable JSON / non-text events
/// pass through verbatim (fail open).
pub fn redact_sse_event<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
    raw: &str,
) -> (String, String) {
    let mut out = String::with_capacity(raw.len());
    let mut redacted_text = String::new();
    for line in raw.split_inclusive('\n') {
        // Preserve the line's own terminator (split_inclusive keeps it).
        let (content, newline) = match line.strip_suffix('\n') {
            Some(c) => (c, "\n"),
            None => (line, ""),
        };
        let Some(data) = content.strip_prefix("data:") else {
            out.push_str(line);
            continue;
        };
        let trimmed = data.trim();
        if trimmed.is_empty() || trimmed == "[DONE]" {
            out.push_str(line);
            continue;
        }
        match redact_sse_data_json(format, fw, trimmed) {
            Some((rewritten, text)) => {
                redacted_text.push_str(&text);
                // Rebuild the `data:` line, preserving the original separator
                // (`data:` vs `data: `) by re-using the leading whitespace.
                let lead_ws = &data[..data.len() - data.trim_start().len()];
                out.push_str("data:");
                out.push_str(lead_ws);
                out.push_str(&rewritten);
                out.push_str(newline);
            }
            None => out.push_str(line),
        }
    }
    (out, redacted_text)
}

/// Redact a complete SSE response with one contiguous assistant-text pass.
///
/// Streaming one delta at a time is insufficient for credentials split across
/// adjacent deltas. This function collects the text-delta payloads, sanitizes
/// their concatenation, and rewrites the first text event with the redacted
/// result while emptying later text events. Framing and non-text events remain
/// intact, and the caller can bound the input before invoking this helper.
pub fn redact_sse_stream<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
    raw: &str,
) -> (String, String) {
    let mut events = Vec::new();
    let mut text = String::new();
    for event in raw.split_inclusive("\n\n") {
        let event_text = sse_event_text(format, event);
        if let Some(value) = event_text.as_deref() {
            text.push_str(value);
        }
        events.push((event, event_text.is_some()));
    }

    let sanitized = fw.sanitize(&text);
    let (sanitized, _) = fw.redact_outbound(&sanitized);
    let mut inserted = false;
    let mut out = String::with_capacity(raw.len());
    for (event, has_text) in events {
        if !has_text {
            out.push_str(event);
            continue;
        }
        let replacement = if inserted {
            ""
        } else {
            inserted = true;
            sanitized.as_str()
        };
        out.push_str(&rewrite_sse_event_text(format, event, replacement));
    }
    let (out, _) = fw.redact_outbound(&out);
    (out, sanitized)
}

fn sse_event_text(format: WireFormat, raw: &str) -> Option<String> {
    for line in raw.split_inclusive('\n') {
        let content = line.strip_suffix('\n').unwrap_or(line);
        let Some(data) = content.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let json: Value = serde_json::from_str(data).ok()?;
        match format {
            WireFormat::Anthropic if json.get("delta").and_then(|d| d.get("text")).is_some() => {
                return json
                    .get("delta")
                    .and_then(|d| d.get("text"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
            }
            WireFormat::OpenAiResponses
                if json
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.ends_with("output_text.delta")) =>
            {
                return json.get("delta").and_then(Value::as_str).map(str::to_owned);
            }
            _ => {}
        }
    }
    None
}

fn rewrite_sse_event_text(format: WireFormat, raw: &str, replacement: &str) -> String {
    let mut replaced = false;
    let mut out = String::with_capacity(raw.len());
    for line in raw.split_inclusive('\n') {
        let (content, newline) = match line.strip_suffix('\n') {
            Some(value) => (value, "\n"),
            None => (line, ""),
        };
        let Some(data) = content.strip_prefix("data:") else {
            out.push_str(line);
            continue;
        };
        let trimmed = data.trim();
        let Ok(mut json) = serde_json::from_str::<Value>(trimmed) else {
            out.push_str(line);
            continue;
        };
        let is_text = match format {
            WireFormat::Anthropic => json.get("delta").and_then(|d| d.get("text")).is_some(),
            WireFormat::OpenAiResponses => {
                json.get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind.ends_with("output_text.delta"))
                    && json.get("delta").and_then(Value::as_str).is_some()
            }
        };
        if !replaced && is_text {
            match format {
                WireFormat::Anthropic => {
                    json["delta"]["text"] = Value::String(replacement.to_owned())
                }
                WireFormat::OpenAiResponses => {
                    json["delta"] = Value::String(replacement.to_owned())
                }
            }
            replaced = true;
            let lead_ws = &data[..data.len() - data.trim_start().len()];
            out.push_str("data:");
            out.push_str(lead_ws);
            if let Ok(serialized) = serde_json::to_string(&json) {
                out.push_str(&serialized);
                out.push_str(newline);
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

/// Redact the assistant-text field of a single SSE `data:` JSON payload per
/// format. Returns the re-serialized JSON + the redacted text, or `None` if the
/// event is not a text delta or fails to parse (caller passes it through).
fn redact_sse_data_json<F: PassthroughFirewall + ?Sized>(
    format: WireFormat,
    fw: &F,
    data: &str,
) -> Option<(String, String)> {
    let mut json: Value = serde_json::from_str(data).ok()?;
    match format {
        WireFormat::Anthropic => {
            // content_block_delta → { "delta": { "type": "text_delta", "text": … } }
            let text = json
                .get("delta")
                .and_then(|d| d.get("text"))
                .and_then(Value::as_str)?;
            let redacted = fw.sanitize(text);
            let (redacted, _) = fw.redact_outbound(&redacted);
            json["delta"]["text"] = Value::String(redacted.clone());
            Some((serde_json::to_string(&json).ok()?, redacted))
        }
        WireFormat::OpenAiResponses => {
            // response.output_text.delta → top-level `delta` string.
            let is_text_delta = json
                .get("type")
                .and_then(Value::as_str)
                .map(|t| t.ends_with("output_text.delta"))
                .unwrap_or(false);
            if !is_text_delta {
                return None;
            }
            let delta = json.get("delta").and_then(Value::as_str)?;
            let redacted = fw.sanitize(delta);
            let (redacted, _) = fw.redact_outbound(&redacted);
            json["delta"] = Value::String(redacted.clone());
            Some((serde_json::to_string(&json).ok()?, redacted))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trivial [`PassthroughFirewall`] stub proving the SSE framing / reassembly
    /// / passthrough plumbing without depending on the gateway's real
    /// `FirewallScanner` (the behavior-asserting redaction tests that need the real
    /// regex engine stay with the scanner in `apps/gateway`). `sanitize` rewrites a
    /// fixed sentinel token; `redact_outbound` is identity.
    struct StubFirewall;
    impl PassthroughFirewall for StubFirewall {
        fn sanitize(&self, text: &str) -> String {
            text.replace("SECRET", "[REDACTED:test]")
        }
        fn redact_outbound(&self, text: &str) -> (String, Vec<&'static str>) {
            (text.to_string(), Vec::new())
        }
    }

    #[test]
    fn rejects_paths_that_change_after_url_parsing() {
        for path in [
            "responses/.",
            "v1/messages/..",
            "../responses",
            "responses?x",
            "responses#x",
            "v1%2fmessages",
            "v1\\messages",
            "responses\n",
        ] {
            assert!(!is_safe_upstream_path(path), "accepted {path:?}");
        }
        for path in [
            "v1/messages",
            "responses",
            "responses/",
            "v1/messages/count_tokens",
        ] {
            assert!(is_safe_upstream_path(path));
        }
    }

    #[test]
    fn messages_path_detection() {
        assert!(is_messages_path("v1/messages"));
        assert!(is_messages_path("v1/messages/"));
        assert!(is_messages_path("v1/messages/count_tokens"));
        assert!(is_messages_path("proxy/v1/messages/count_tokens/"));
        assert!(!is_messages_path("v1/models"));
    }

    #[test]
    fn responses_path_detection() {
        assert!(is_responses_path("responses"));
        assert!(is_responses_path("responses/"));
        assert!(is_responses_path("v1/responses"));
        assert!(is_responses_path("responses/compact"));
        assert!(!is_responses_path("v1/models"));
        assert!(!is_responses_path("responses/123/cancel"));
    }

    #[test]
    fn path_classification_is_deny_by_default() {
        use PassthroughRoute::*;
        let anthropic = |method, path| classify_path(WireFormat::Anthropic, method, path);
        let codex = |method, path| classify_path(WireFormat::OpenAiResponses, method, path);
        assert_eq!(anthropic("POST", "v1/messages"), Prompt);
        assert_eq!(anthropic("POST", "/v1/messages/count_tokens/"), Prompt);
        assert_eq!(anthropic("GET", "v1/messages"), Prompt);
        assert_eq!(anthropic("POST", "v1/messages/batches"), MessageBatch);
        assert_eq!(anthropic("GET", "v1/messages/batches"), Inert);
        assert_eq!(anthropic("GET", "v1/messages/batches/b1/results"), Inert);
        assert_eq!(anthropic("POST", "v1/messages/batches/b1/cancel"), Inert);
        assert_eq!(anthropic("DELETE", "v1/messages/batches/b1"), Inert);
        assert_eq!(anthropic("GET", "v1/models"), Inert);
        assert_eq!(anthropic("GET", "v1/models/claude-x"), Inert);
        assert_eq!(anthropic("POST", "v1/models"), Unknown);
        assert_eq!(anthropic("POST", "v1/complete"), Unknown);
        assert_eq!(anthropic("POST", "v1/messages/batches/b1"), Unknown);
        assert_eq!(anthropic("PUT", "v1/messages/batches"), Unknown);
        assert_eq!(codex("POST", "responses"), Prompt);
        assert_eq!(codex("POST", "responses/compact"), Prompt);
        assert_eq!(codex("GET", "models"), Inert);
        assert_eq!(codex("POST", "models"), Unknown);
        assert_eq!(codex("POST", "responses/123/cancel"), Unknown);
        assert_eq!(codex("POST", "chat/completions"), Unknown);
    }

    #[test]
    fn interior_empty_segments_are_refused() {
        assert!(!is_safe_upstream_path("v1//messages"));
        assert!(!is_safe_upstream_path("/"));
        assert!(is_safe_upstream_path("/v1/messages/"));
    }

    #[test]
    fn upstream_url_joins_path_and_query() {
        assert_eq!(
            build_upstream_url("https://api.anthropic.com/", "v1/messages", None),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_upstream_url(
                "https://api.anthropic.com",
                "/v1/messages",
                Some("beta=true")
            ),
            "https://api.anthropic.com/v1/messages?beta=true"
        );
    }

    #[test]
    fn request_body_redaction_reaches_the_firewall() {
        let fw = StubFirewall;
        let mut body = serde_json::json!({
            "system": "sentinel SECRET here",
            "messages": [
                { "role": "user", "content": "another SECRET token" }
            ]
        });
        redact_anthropic_body(&fw, &mut body);
        assert!(!body["system"].as_str().unwrap().contains("SECRET"));
        assert!(!body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("SECRET"));
    }

    /// The conversation visitor reads messages and tool traffic but not the
    /// agent-authored `system` / `instructions` or tool definitions.
    #[test]
    fn conversation_visitor_skips_agent_system_and_tool_definitions() {
        let collect = |format: WireFormat, mut body: Value| {
            let mut seen = Vec::new();
            visit_request_conversation_strings_mut(format, &mut body, &mut |text| {
                seen.push(text.clone());
            });
            seen
        };
        let anthropic = collect(
            WireFormat::Anthropic,
            serde_json::json!({
                "system": "agent system",
                "tools": [{ "name": "Bash", "description": "agent tool",
                            "input_schema": { "description": "agent schema" } }],
                "messages": [
                    { "role": "user", "content": "user turn" },
                    { "role": "user", "content": [
                        { "type": "tool_result", "tool_use_id": "t", "content": "tool output" }
                    ] }
                ]
            }),
        );
        assert_eq!(anthropic, ["user turn", "tool output"]);
        let responses = collect(
            WireFormat::OpenAiResponses,
            serde_json::json!({
                "instructions": "agent instructions",
                "tools": [{ "type": "function", "name": "shell", "description": "agent tool" }],
                "input": [
                    { "type": "message", "role": "user", "content": [
                        { "type": "input_text", "text": "user turn" }
                    ] },
                    { "type": "function_call_output", "call_id": "c", "output": "tool output" }
                ]
            }),
        );
        assert_eq!(responses, ["user turn", "tool output"]);
    }

    /// Agent tool traffic carries file contents and command output in
    /// `tool_result` / `tool_use` blocks, documents and tool definitions; all of
    /// it reaches the firewall, while signed and id fields stay byte-identical.
    #[test]
    fn anthropic_redaction_reaches_tool_traffic_and_skips_signed_fields() {
        let fw = StubFirewall;
        let mut body = serde_json::json!({
            "system": [{ "type": "text", "text": "system SECRET" }],
            "messages": [
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "SECRET thought", "signature": "sig-SECRET" },
                    { "type": "redacted_thinking", "data": "SECRET-opaque" },
                    { "type": "tool_use", "id": "toolu_SECRET", "name": "Bash",
                      "input": { "command": "cat .env SECRET", "nested": ["SECRET"] } }
                ] },
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "toolu_SECRET",
                      "content": "AWS SECRET from .env" },
                    { "type": "tool_result", "tool_use_id": "toolu_SECRET",
                      "content": [{ "type": "text", "text": "nested SECRET" }] },
                    { "type": "document", "title": "SECRET title", "context": "SECRET ctx",
                      "source": { "type": "text", "media_type": "text/plain", "data": "doc SECRET" } },
                    { "type": "search_result", "title": "SECRET", "source": "https://example.com",
                      "content": [{ "type": "text", "text": "found SECRET" }] }
                ] }
            ],
            "tools": [{ "name": "Bash", "description": "run SECRET",
                        "input_schema": { "type": "object", "properties": {
                            "command": { "type": "string", "description": "SECRET cmd" } } } }]
        });
        redact_anthropic_body(&fw, &mut body);
        let assistant = &body["messages"][0]["content"];
        assert_eq!(assistant[0]["thinking"], "SECRET thought");
        assert_eq!(assistant[0]["signature"], "sig-SECRET");
        assert_eq!(assistant[1]["data"], "SECRET-opaque");
        assert_eq!(assistant[2]["id"], "toolu_SECRET");
        assert_eq!(
            body["messages"][1]["content"][0]["tool_use_id"],
            "toolu_SECRET"
        );
        // Everything else that mentioned the sentinel was rewritten.
        let mut rest = body.clone();
        rest["messages"][0]["content"][0] = Value::Null;
        rest["messages"][0]["content"][1] = Value::Null;
        rest["messages"][0]["content"][2]["id"] = Value::Null;
        rest["messages"][1]["content"][0]["tool_use_id"] = Value::Null;
        rest["messages"][1]["content"][1]["tool_use_id"] = Value::Null;
        let rest = rest.to_string();
        assert!(!rest.contains("SECRET"), "unredacted prompt text: {rest}");
        assert_eq!(rest.matches("[REDACTED:test]").count(), 12, "{rest}");
    }

    /// Codex replays tool calls and their output as Responses items; arguments,
    /// outputs and tool definitions are redacted, reasoning and ids are not.
    #[test]
    fn responses_redaction_reaches_tool_items_and_skips_opaque_fields() {
        let fw = StubFirewall;
        let mut body = serde_json::json!({
            "instructions": "be careful SECRET",
            "input": [
                { "type": "message", "role": "user",
                  "content": [{ "type": "input_text", "text": "hi SECRET" }] },
                { "type": "reasoning", "id": "rs_SECRET", "encrypted_content": "SECRET-enc",
                  "summary": [{ "type": "summary_text", "text": "SECRET summary" }] },
                { "type": "function_call", "call_id": "call_SECRET", "name": "shell",
                  "arguments": "{\"cmd\":\"cat SECRET\"}" },
                { "type": "function_call_output", "call_id": "call_SECRET", "output": "out SECRET" },
                { "type": "custom_tool_call", "call_id": "call_SECRET", "name": "apply_patch",
                  "input": "patch SECRET" },
                { "type": "custom_tool_call_output", "call_id": "call_SECRET",
                  "output": [{ "type": "input_text", "text": "patched SECRET" }] },
                { "type": "local_shell_call", "call_id": "call_SECRET",
                  "action": { "type": "exec", "command": ["echo", "SECRET"] } },
                { "type": "local_shell_call_output", "call_id": "call_SECRET", "output": "SECRET" }
            ],
            "tools": [{ "type": "function", "name": "shell", "description": "SECRET tool",
                        "parameters": { "type": "object" } }]
        });
        redact_responses_body(&fw, &mut body);
        let items = &body["input"];
        assert_eq!(items[1]["encrypted_content"], "SECRET-enc");
        assert_eq!(items[1]["summary"][0]["text"], "SECRET summary");
        let mut rest = body.clone();
        rest["input"][1] = Value::Null;
        for index in 2..8 {
            assert_eq!(rest["input"][index]["call_id"], "call_SECRET");
            rest["input"][index]["call_id"] = Value::Null;
        }
        let rest = rest.to_string();
        assert!(!rest.contains("SECRET"), "unredacted prompt text: {rest}");
        assert_eq!(rest.matches("[REDACTED:test]").count(), 9, "{rest}");
    }

    /// Feed `raw` through the redactor one chunk at a time (mimicking arbitrary
    /// network-chunk boundaries, including a split mid-event) and return the full
    /// emitted output, asserting nothing is dropped and framing is reassembled.
    fn redact_in_chunks<F: PassthroughFirewall + ?Sized>(
        format: WireFormat,
        fw: &F,
        raw: &[u8],
        chunk: usize,
    ) -> String {
        let mut pending: Vec<u8> = Vec::new();
        let mut out: Vec<u8> = Vec::new();
        for piece in raw.chunks(chunk) {
            pending.extend_from_slice(piece);
            let (emitted, _) = drain_complete_events(format, fw, &mut pending);
            out.extend_from_slice(&emitted);
        }
        if !pending.is_empty() {
            let tail = String::from_utf8_lossy(&pending).to_string();
            let (emitted, _) = redact_sse_event(format, fw, &tail);
            out.extend_from_slice(emitted.as_bytes());
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn sse_text_delta_is_redacted_across_chunk_boundaries() {
        let fw = StubFirewall;
        let transcript = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\"}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"my SECRET ok\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 7);
        assert!(!out.contains("my SECRET ok"), "got: {out}");
        assert!(out.contains("[REDACTED:test]"), "got: {out}");
        // Non-text events pass through verbatim, framing preserved.
        assert!(out.contains("\"type\":\"message_start\""));
        assert!(out.contains("event: content_block_delta\n"));
    }

    #[test]
    fn sse_secret_split_across_text_events_is_redacted() {
        let fw = StubFirewall;
        let transcript = concat!(
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"SECR\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"ET\"}}\n\n",
        );
        let (out, text) = redact_sse_stream(WireFormat::Anthropic, &fw, transcript);
        assert!(!out.contains("SECRET"), "got: {out}");
        assert_eq!(text, "[REDACTED:test]");
    }

    #[test]
    fn non_text_events_pass_through_unchanged() {
        let fw = StubFirewall;
        // A ping + a non-text-delta event: must be byte-identical after redaction.
        let transcript =
            "event: ping\ndata: {\"type\":\"ping\"}\n\ndata: {\"type\":\"response.created\"}\n\n";
        let out = redact_in_chunks(WireFormat::Anthropic, &fw, transcript.as_bytes(), 3);
        assert_eq!(out, transcript);
    }

    #[test]
    fn unparseable_data_line_passes_through() {
        let fw = StubFirewall;
        let event = "data: not-json-at-all\n\n";
        let (out, text) = redact_sse_event(WireFormat::Anthropic, &fw, event);
        assert_eq!(out, event);
        assert!(text.is_empty());
    }
}
