//! Anthropic Messages (`/v1/messages`) ↔ unified OpenAI shape translation.
//!
//! The outbound Anthropic provider (`ryu-gw-providers::anthropic`) already owns
//! the OpenAI → Anthropic direction for the upstream call. These functions own
//! the INBOUND direction: a client that sends an Anthropic Messages request to
//! this gateway gets it normalized to the OpenAI shape the pipeline expects, and
//! the pipeline's OpenAI response is projected back to the Anthropic wire form.
//!
//! The translation is deliberately structural, not semantic: we map fields
//! between the two vocabularies, we never interpret content. `system` hoists to
//! an OpenAI `system` role message (the pipeline's `system_field`-equivalent);
//! Anthropic `content` blocks map to OpenAI message `content`; Anthropic
//! `tool_use`/`tool_result` blocks map to OpenAI `tool_calls`/`tool` messages.

use serde_json::{json, Value};

/// Normalize an Anthropic Messages request body into the unified OpenAI shape
/// the gateway pipeline consumes.
///
/// The pipeline reads `model`, `messages`, `max_tokens`, `temperature`,
/// `top_p`, `stop`, `tools`, `stream`, and the per-provider `ryu_*` private
/// fields. Everything else in the Anthropic request is either mapped onto a
/// field the pipeline reads, or dropped (unknown fields are not forwarded).
pub fn request_to_openai(body: &Value) -> Value {
    let mut out = Value::Object(serde_json::Map::new());

    // Model: required by the pipeline's routing.
    if let Some(model) = body.get("model") {
        out["model"] = model.clone();
    }

    // System prompt: Anthropic carries it top-level as a string OR an array of
    // blocks; the unified shape uses an OpenAI `system` role message. Prepend it
    // so downstream stages (skills injection, firewall, routing) see it exactly
    // like they would a native OpenAI request.
    if let Some(system) = body.get("system") {
        if let Some(text) = text_content(system) {
            let mut messages = messages_to_openai(body);
            messages.insert(0, json!({ "role": "system", "content": text }));
            out["messages"] = Value::Array(messages);
        } else {
            out["messages"] = Value::Array(messages_to_openai(body));
        }
    } else {
        out["messages"] = Value::Array(messages_to_openai(body));
    }

    // Generation params: pass through the ones the pipeline reads, by their
    // OpenAI names. Anthropic's `stop_sequences` → `stop`.
    copy_if_present(body, &mut out, "max_tokens", "max_tokens");
    copy_if_present(body, &mut out, "temperature", "temperature");
    copy_if_present(body, &mut out, "top_p", "top_p");
    if let Some(stop) = body.get("stop_sequences") {
        out["stop"] = stop.clone();
    }

    // Tools: Anthropic's `{name, description, input_schema}` → OpenAI's
    // `{type: "function", function: {name, description, parameters}}`.
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mapped: Vec<Value> = tools.iter().map(tool_to_openai).collect();
        if !mapped.is_empty() {
            out["tools"] = Value::Array(mapped);
        }
    }

    copy_if_present(body, &mut out, "stream", "stream");
    // Anthropic's request-level automatic caching marker. The prompt-cache
    // stage treats it as caller-supplied and the Anthropic adapter forwards it.
    copy_if_present(body, &mut out, "cache_control", "cache_control");

    out
}

/// Flatten an Anthropic `content` value (string or block array) to a single
/// text string for the OpenAI shape. Non-text blocks (images, tool results,
/// tool uses) are dropped here — they are carried by the message mapping below
/// where the vocabulary exists; within a plain content string there is nowhere
/// to put them.
fn content_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(blocks) => {
            let mut text = String::new();
            for b in blocks {
                if b["type"].as_str() == Some("text") {
                    if let Some(t) = b["text"].as_str() {
                        text.push_str(t);
                    }
                }
            }
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

/// Map an Anthropic text `content` (the `system` field, or a user/assistant
/// turn) to OpenAI content.
///
/// Blocks are flattened to one string unless a text block carries a
/// `cache_control` breakpoint. Then the text blocks are kept as OpenAI text
/// parts with their breakpoints, which the prompt-cache stage honours as
/// caller-supplied and the Anthropic adapter forwards block by block. A
/// flattened breakpoint would be lost and the client's cached prefix with it.
fn text_content(content: &Value) -> Option<Value> {
    let has_breakpoint = content.as_array().is_some_and(|blocks| {
        blocks
            .iter()
            .any(|b| b["type"].as_str() == Some("text") && b.get("cache_control").is_some())
    });
    if !has_breakpoint {
        return content_text(content).map(Value::String);
    }
    let parts: Vec<Value> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|b| b["type"].as_str() == Some("text") && b["text"].is_string())
        .map(|b| {
            let mut part = json!({ "type": "text", "text": b["text"] });
            if let Some(cache_control) = b.get("cache_control") {
                part["cache_control"] = cache_control.clone();
            }
            part
        })
        .collect();
    Some(Value::Array(parts))
}

/// Map an Anthropic Messages `messages` array onto OpenAI chat messages.
///
/// * `role: "user"`/`"assistant"` content (string or text blocks) → OpenAI
///   `{role, content}`.
/// * `role: "assistant"` content containing `tool_use` blocks (alone or mixed
///   with text/thinking blocks) → OpenAI assistant message with `tool_calls`
///   and the joined text as `content`.
/// * `role: "user"` content containing `tool_result` blocks → OpenAI `role:
///   "tool"` messages keyed by `tool_use_id`, then any text as a `user`
///   message.
fn messages_to_openai(body: &Value) -> Vec<Value> {
    let Some(messages) = body.get("messages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out: Vec<Value> = Vec::new();
    for m in messages {
        let role = m["role"].as_str().unwrap_or("user");
        let content = m.get("content");
        match role {
            "user" => {
                if let Some(tool_results) = content.and_then(|c| tool_results_to_openai(c)) {
                    // One `tool` message per result; each keys on its
                    // `tool_use_id`. The OpenAI shape requires a separate message
                    // per tool result. Leftover text trails as a user message.
                    out.extend(tool_results);
                } else if let Some(text) = content.and_then(text_content) {
                    out.push(json!({ "role": "user", "content": text }));
                }
            }
            "assistant" => {
                if let Some(msg) = content.and_then(tool_uses_to_openai) {
                    out.push(msg);
                } else if let Some(text) = content.and_then(text_content) {
                    out.push(json!({ "role": "assistant", "content": text }));
                }
            }
            _ => {
                // Unknown roles pass through verbatim so the pipeline's own
                // handling (which may support more) is not preempted.
                out.push(json!({ "role": role, "content": content }));
            }
        }
    }
    out
}

/// Extract `tool_result` blocks from a user content array and project each to
/// an OpenAI `role: "tool"` message. Any text blocks in the same turn (Claude
/// Code appends them next to results) follow as one trailing `role: "user"`
/// message: OpenAI requires the tool messages to come directly after the
/// assistant `tool_calls` message, so the text can never sit between them.
/// Returns `None` when the content carries no `tool_result` block.
fn tool_results_to_openai(content: &Value) -> Option<Vec<Value>> {
    let blocks = content.as_array()?;
    let mut out = Vec::new();
    let mut text_blocks: Vec<Value> = Vec::new();
    for b in blocks {
        match b["type"].as_str() {
            Some("tool_result") => {
                let id = b["tool_use_id"].as_str().unwrap_or_default().to_string();
                let text = b.get("content").and_then(content_text).unwrap_or_default();
                let mut message = json!({ "role": "tool", "tool_call_id": id, "content": text });
                // A breakpoint on a tool result is the one Claude Code and other
                // agent loops place on the last block of the last user turn. The
                // Anthropic adapter lifts it back onto the `tool_result` block.
                if let Some(cache_control) = b.get("cache_control") {
                    message["cache_control"] = cache_control.clone();
                }
                out.push(message);
            }
            Some("text") if b["text"].is_string() => text_blocks.push(b.clone()),
            _ => {}
        }
    }
    if out.is_empty() {
        return None;
    }
    // Leftover text keeps its breakpoints (as text parts) exactly like a plain
    // user turn does.
    if let Some(text) = text_content(&Value::Array(text_blocks))
        .filter(|text| text.as_str().is_none_or(|s| !s.is_empty()))
    {
        out.push(json!({ "role": "user", "content": text }));
    }
    Some(out)
}

/// Project an assistant content array that carries `tool_use` blocks to one
/// OpenAI assistant message with `tool_calls`. Text blocks in the same turn
/// (the gateway's own responses put a text block before the tool uses) become
/// the message `content`; thinking and other blocks are skipped. Returns
/// `None` when the content carries no `tool_use` block.
fn tool_uses_to_openai(content: &Value) -> Option<Value> {
    let blocks = content.as_array()?;
    let mut calls = Vec::new();
    let mut text = String::new();
    for b in blocks {
        match b["type"].as_str() {
            Some("tool_use") => {
                let mut call = json!({
                    "id": b["id"],
                    "type": "function",
                    "function": {
                        "name": b["name"],
                        // OpenAI carries arguments as a JSON-encoded *string*.
                        "arguments": b["input"].to_string(),
                    },
                });
                // Carried on the call; the Anthropic adapter puts it back on the
                // `tool_use` block so the breakpoint survives the round trip.
                if let Some(cache_control) = b.get("cache_control") {
                    call["cache_control"] = cache_control.clone();
                }
                calls.push(call);
            }
            Some("text") => {
                if let Some(t) = b["text"].as_str() {
                    text.push_str(t);
                }
            }
            _ => {}
        }
    }
    if calls.is_empty() {
        return None;
    }
    let content = if text.is_empty() {
        Value::Null
    } else {
        Value::String(text)
    };
    Some(json!({ "role": "assistant", "content": content, "tool_calls": calls }))
}

/// Project an Anthropic `{name, description, input_schema}` tool definition to
/// OpenAI's `{type: "function", function: {...}}` shape.
fn tool_to_openai(tool: &Value) -> Value {
    let mut out = json!({
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["input_schema"],
        }
    });
    // A breakpoint on the last tool caches the whole tool list; the Anthropic
    // adapter reads it beside the function body.
    if let Some(cache_control) = tool.get("cache_control") {
        out["cache_control"] = cache_control.clone();
    }
    out
}

/// Project the pipeline's unified OpenAI chat response to an Anthropic Messages
/// response. The client asked for Anthropic format, so we must speak it back.
pub fn response_to_anthropic(response: &Value, requested_model: &str, request_id: &str) -> Value {
    let choice = &response["choices"][0];
    let message = &choice["message"];

    let mut blocks: Vec<Value> = Vec::new();
    // Content (string) → a single text block.
    if let Some(text) = message["content"].as_str().filter(|s| !s.is_empty()) {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    // Tool calls → `tool_use` blocks.
    if let Some(calls) = message["tool_calls"].as_array() {
        for c in calls {
            blocks.push(json!({
                "type": "tool_use",
                "id": c["id"],
                "name": c["function"]["name"],
                "input": parse_json_arguments(&c["function"]["arguments"]),
            }));
        }
    }
    // Exotic blocks the OpenAI shape could not carry but a caller supplied.
    if let Some(extra) = message.get("ryu_content_blocks").and_then(Value::as_array) {
        blocks.extend(extra.iter().cloned());
    }

    let usage = &response["usage"];
    let input_tokens = usage["prompt_tokens"].as_u64().unwrap_or(0);
    let output_tokens = usage["completion_tokens"].as_u64().unwrap_or(0);

    json!({
        "id": request_id,
        "type": "message",
        "role": "assistant",
        "model": requested_model,
        "content": blocks,
        "stop_reason": stop_reason_to_anthropic(choice["finish_reason"].as_str()),
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }
    })
}

/// Map an OpenAI finish reason to Anthropic's stop-reason vocabulary.
pub(crate) fn stop_reason_to_anthropic(reason: Option<&str>) -> &'static str {
    match reason {
        Some("tool_calls") => "tool_use",
        Some("length") => "max_tokens",
        Some("content_filter") => "refusal",
        Some("stop") | None => "end_turn",
        _ => "end_turn",
    }
}

/// Decode an OpenAI `function.arguments` JSON-encoded string to the object
/// Anthropic wants for `tool_use.input`. Unparseable → `{}`.
fn parse_json_arguments(arguments: &Value) -> Value {
    match arguments {
        Value::String(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).unwrap_or_else(|_| json!({}))
        }
        Value::Object(_) => arguments.clone(),
        _ => json!({}),
    }
}

/// Copy a field from the Anthropic request to the OpenAI body when present.
fn copy_if_present(from: &Value, to: &mut Value, from_key: &str, to_key: &str) {
    if let Some(v) = from.get(from_key) {
        to[to_key] = v.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn simple_user_assistant_request_maps_roles_and_content() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "max_tokens": 128,
            "messages": [
                { "role": "user", "content": "Hello" },
                { "role": "assistant", "content": "Hi there" },
            ],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["model"], "claude-3-5-sonnet");
        assert_eq!(out["max_tokens"], 128);
        assert_eq!(out["messages"][0]["role"], "user");
        assert_eq!(out["messages"][0]["content"], "Hello");
        assert_eq!(out["messages"][1]["role"], "assistant");
        assert_eq!(out["messages"][1]["content"], "Hi there");
    }

    #[test]
    fn system_field_hoists_to_a_system_message() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "system": "You are a helpful assistant.",
            "messages": [{ "role": "user", "content": "Hello" }],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["messages"][0]["role"], "system");
        assert_eq!(
            out["messages"][0]["content"],
            "You are a helpful assistant."
        );
        assert_eq!(out["messages"][1]["role"], "user");
    }

    #[test]
    fn cache_breakpoints_survive_translation() {
        let ephemeral = json!({ "type": "ephemeral" });
        let body = json!({
            "model": "claude-sonnet-4-5",
            "cache_control": ephemeral,
            "system": [
                { "type": "text", "text": "Rules." },
                { "type": "text", "text": "Long context.", "cache_control": ephemeral },
            ],
            "tools": [{
                "name": "lookup",
                "description": "Look up a record",
                "input_schema": { "type": "object" },
                "cache_control": ephemeral,
            }],
            "messages": [
                { "role": "user", "content": [
                    { "type": "text", "text": "Doc", "cache_control": ephemeral },
                ] },
                { "role": "assistant", "content": [{ "type": "text", "text": "Read it." }] },
            ],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["cache_control"], ephemeral);
        assert_eq!(
            out["messages"][0]["content"],
            json!([
                { "type": "text", "text": "Rules." },
                { "type": "text", "text": "Long context.", "cache_control": ephemeral },
            ])
        );
        assert_eq!(out["tools"][0]["cache_control"], ephemeral);
        assert_eq!(
            out["messages"][1]["content"],
            json!([{ "type": "text", "text": "Doc", "cache_control": ephemeral }])
        );
        // Without a breakpoint, blocks still flatten to the plain string shape.
        assert_eq!(out["messages"][2]["content"], "Read it.");
    }

    #[test]
    fn tool_loop_breakpoints_survive_translation() {
        let ephemeral = json!({ "type": "ephemeral" });
        let body = json!({
            "model": "claude-sonnet-4-5",
            "system": [{ "type": "text", "text": "Rules.", "cache_control": ephemeral }],
            "messages": [
                { "role": "user", "content": "Find it." },
                { "role": "assistant", "content": [
                    { "type": "tool_use", "id": "tu_1", "name": "lookup", "input": {},
                      "cache_control": ephemeral },
                ] },
                { "role": "user", "content": [
                    { "type": "tool_result", "tool_use_id": "tu_1", "content": "found",
                      "cache_control": ephemeral },
                    { "type": "text", "text": "Now summarize.", "cache_control": ephemeral },
                ] },
            ],
        });
        let out = request_to_openai(&body);
        assert_eq!(
            out["messages"][2]["tool_calls"][0]["cache_control"],
            ephemeral
        );
        assert_eq!(out["messages"][3]["role"], "tool");
        assert_eq!(out["messages"][3]["content"], "found");
        assert_eq!(out["messages"][3]["cache_control"], ephemeral);
        assert_eq!(
            out["messages"][4]["content"],
            json!([{ "type": "text", "text": "Now summarize.", "cache_control": ephemeral }])
        );
        // Without any breakpoint the shapes stay plain.
        let plain = request_to_openai(&json!({
            "model": "claude-sonnet-4-5",
            "messages": [{ "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "tu_1", "content": "found" },
                { "type": "text", "text": "Done." },
            ] }],
        }));
        assert!(plain["messages"][0].get("cache_control").is_none());
        assert_eq!(plain["messages"][1]["content"], "Done.");
    }

    #[test]
    fn stop_sequences_map_to_stop() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "stop_sequences": ["END"],
            "messages": [{ "role": "user", "content": "Hi" }],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["stop"], json!(["END"]));
    }

    #[test]
    fn tools_map_to_openai_function_shape() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "tools": [{
                "name": "get_weather",
                "description": "Get the weather",
                "input_schema": { "type": "object", "properties": {} },
            }],
            "messages": [{ "role": "user", "content": "Weather?" }],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["tools"][0]["type"], "function");
        assert_eq!(out["tools"][0]["function"]["name"], "get_weather");
        assert_eq!(out["tools"][0]["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn content_blocks_map_to_openai() {
        // A content array with text blocks + a tool use.
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [{
                "role": "user",
                "content": [
                    { "type": "text", "text": "What is 2+2?" },
                    { "type": "text", "text": " Please compute." },
                ],
            }],
        });
        let out = request_to_openai(&body);
        assert_eq!(
            out["messages"][0]["content"],
            "What is 2+2? Please compute."
        );
    }

    #[test]
    fn tool_use_and_result_round_trip() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [
                {
                    "role": "assistant",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "add",
                        "input": { "a": 1, "b": 2 },
                    }],
                },
                {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "3",
                    }],
                },
            ],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["messages"][0]["role"], "assistant");
        assert_eq!(
            out["messages"][0]["tool_calls"][0]["function"]["name"],
            "add"
        );
        assert_eq!(out["messages"][1]["role"], "tool");
        assert_eq!(out["messages"][1]["tool_call_id"], "toolu_1");
        assert_eq!(out["messages"][1]["content"], "3");
    }

    #[test]
    fn mixed_text_and_tool_blocks_keep_tool_calls_and_results() {
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "plan", "signature": "s" },
                        { "type": "text", "text": "I'll read the file." },
                        {
                            "type": "tool_use",
                            "id": "toolu_1",
                            "name": "read",
                            "input": { "path": "a.txt" },
                        },
                    ],
                },
                {
                    "role": "user",
                    "content": [
                        { "type": "text", "text": "Here you go." },
                        {
                            "type": "tool_result",
                            "tool_use_id": "toolu_1",
                            "content": [{ "type": "text", "text": "hello" }],
                        },
                    ],
                },
            ],
        });
        let out = request_to_openai(&body);
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["role"], "assistant");
        assert_eq!(messages[0]["content"], "I'll read the file.");
        assert_eq!(messages[0]["tool_calls"][0]["id"], "toolu_1");
        assert_eq!(messages[0]["tool_calls"][0]["function"]["name"], "read");
        // Tool messages come directly after the tool_calls message, before text.
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "toolu_1");
        assert_eq!(messages[1]["content"], "hello");
        assert_eq!(messages[2]["role"], "user");
        assert_eq!(messages[2]["content"], "Here you go.");
    }

    #[test]
    fn gateway_response_feeds_back_as_tool_call_history() {
        let oai = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "Adding.",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "add", "arguments": "{\"a\":1}" },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
        });
        let anthropic = response_to_anthropic(&oai, "claude-3-5-sonnet", "req-1");
        let body = json!({
            "model": "claude-3-5-sonnet",
            "messages": [
                { "role": "assistant", "content": anthropic["content"] },
                {
                    "role": "user",
                    "content": [{ "type": "tool_result", "tool_use_id": "call_1", "content": "1" }],
                },
            ],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["messages"][0]["content"], "Adding.");
        assert_eq!(out["messages"][0]["tool_calls"][0]["id"], "call_1");
        assert_eq!(
            out["messages"][0]["tool_calls"][0]["function"]["arguments"],
            "{\"a\":1}"
        );
        assert_eq!(out["messages"][1]["role"], "tool");
        assert_eq!(out["messages"][1]["tool_call_id"], "call_1");
    }

    #[test]
    fn response_projects_to_anthropic_blocks() {
        let oai = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "The answer is 42.",
                },
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
            }
        });
        let out = response_to_anthropic(&oai, "claude-3-5-sonnet", "req-1");
        assert_eq!(out["type"], "message");
        assert_eq!(out["role"], "assistant");
        assert_eq!(out["id"], "req-1");
        assert_eq!(out["content"][0]["type"], "text");
        assert_eq!(out["content"][0]["text"], "The answer is 42.");
        assert_eq!(out["stop_reason"], "end_turn");
        assert_eq!(out["usage"]["input_tokens"], 10);
        assert_eq!(out["usage"]["output_tokens"], 5);
    }

    #[test]
    fn response_tool_calls_project_to_tool_use_blocks() {
        let oai = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "add",
                            "arguments": "{\"a\":1,\"b\":2}",
                        },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 },
        });
        let out = response_to_anthropic(&oai, "claude-3-5-sonnet", "req-1");
        assert_eq!(out["stop_reason"], "tool_use");
        assert_eq!(out["content"][0]["type"], "tool_use");
        assert_eq!(out["content"][0]["name"], "add");
        assert_eq!(out["content"][0]["input"]["a"], 1);
    }
}
