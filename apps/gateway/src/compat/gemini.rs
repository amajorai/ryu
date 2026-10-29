//! Google Gemini (`generateContent` / `streamGenerateContent`) ↔ unified
//! OpenAI shape translation.
//!
//! A Gemini client (Vertex SDKs, `google-genai`, the Gemini CLI) points
//! `base_url` at this gateway and sends `contents: [{role, parts}]`. These
//! functions normalize that request onto the pipeline's OpenAI shape and
//! project the OpenAI response back to Gemini's `candidates`/`parts` form.
//!
//! Role mapping: Gemini uses `user` / `model` (assistant); we map `model` →
//! `assistant` inbound and `assistant` → `model` outbound. Inbound
//! `functionCall` / `functionResponse` parts map to OpenAI `tool_calls` /
//! `tool` messages. `systemInstruction` hoists to an OpenAI `system` message.
//! `generationConfig` fields map to their OpenAI equivalents.

use serde_json::{json, Value};

/// Normalize a Gemini `generateContent` request body into the unified OpenAI
/// chat shape the pipeline consumes.
pub fn request_to_openai(body: &Value) -> Value {
    let mut out = Value::Object(serde_json::Map::new());

    // The model lives on the URL (`models/{model}:generateContent`) for the
    // Gemini protocol. A handler extracts it and injects it here. Allow a body
    // override for convenience.
    if let Some(model) = body.get("model") {
        out["model"] = model.clone();
    }

    let mut messages = contents_to_openai(body);
    // systemInstruction → leading system message.
    if let Some(text) = system_instruction_text(body) {
        messages.insert(0, json!({ "role": "system", "content": text }));
    }
    out["messages"] = Value::Array(messages);

    // generationConfig → OpenAI generation params.
    if let Some(cfg) = body.get("generationConfig") {
        copy_if_present(cfg, &mut out, "temperature", "temperature");
        copy_if_present(cfg, &mut out, "topP", "top_p");
        copy_if_present(cfg, &mut out, "maxOutputTokens", "max_tokens");
        if let Some(stop) = cfg.get("stopSequences") {
            out["stop"] = stop.clone();
        }
    }

    // Gemini tools: `[{functionDeclarations: [{name, description, parameters}]}]`
    // → OpenAI `[{type: "function", function: {...}}]`.
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        let mut mapped: Vec<Value> = Vec::new();
        for tool_group in tools {
            if let Some(decls) = tool_group["functionDeclarations"].as_array() {
                for decl in decls {
                    mapped.push(tool_to_openai(decl));
                }
            }
        }
        if !mapped.is_empty() {
            out["tools"] = Value::Array(mapped);
        }
    }

    // Streaming is selected by the URL suffix (`:streamGenerateContent`), not a
    // body field, in the Gemini protocol. The handler sets it.
    copy_if_present(body, &mut out, "stream", "stream");

    out
}

/// Map Gemini `contents: [{role, parts}]` onto OpenAI chat messages.
///
/// * `model` turns → an assistant message; `functionCall` parts become
///   `tool_calls` (the part's `id` when present, else a synthesized
///   `call_{turn}_{i}`), and text parts the `content`.
/// * Every other role (`user`, the legacy `function`) → `role: "tool"`
///   messages for `functionResponse` parts, then a `user` message for any text.
///   OpenAI requires the tool messages directly after the assistant
///   `tool_calls` message, so the text always trails them.
///
/// A response whose `id` matches an unanswered call pairs with it. Otherwise
/// (no `id`, or an `id` the model turn never carried) it pairs with the
/// earliest unanswered call of the same name from the preceding model turn,
/// so parallel calls to one function keep distinct ids.
fn contents_to_openai(body: &Value) -> Vec<Value> {
    let Some(contents) = body.get("contents").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    // `(name, id)` of the latest model turn's calls not yet answered.
    let mut pending: Vec<(String, String)> = Vec::new();
    for (turn, c) in contents.iter().enumerate() {
        let parts = c["parts"].as_array().map(Vec::as_slice).unwrap_or_default();
        let text = parts_text(&c["parts"]);
        if c["role"].as_str() == Some("model") {
            pending.clear();
            let mut calls = Vec::new();
            for (i, p) in parts.iter().enumerate() {
                let Some(call) = p.get("functionCall") else {
                    continue;
                };
                let name = call["name"].as_str().unwrap_or_default().to_string();
                let id = call["id"]
                    .as_str()
                    .map_or_else(|| format!("call_{turn}_{i}"), str::to_owned);
                let args = if call["args"].is_null() {
                    "{}".to_string()
                } else {
                    call["args"].to_string()
                };
                calls.push(json!({
                    "id": id,
                    "type": "function",
                    "function": { "name": name, "arguments": args },
                }));
                pending.push((name, id));
            }
            if calls.is_empty() {
                out.push(json!({ "role": "assistant", "content": text.unwrap_or_default() }));
            } else {
                out.push(json!({ "role": "assistant", "content": text, "tool_calls": calls }));
            }
            continue;
        }
        let mut answered = false;
        for (i, p) in parts.iter().enumerate() {
            let Some(response) = p.get("functionResponse") else {
                continue;
            };
            let name = response["name"].as_str().unwrap_or_default();
            let explicit = response["id"].as_str();
            // An id that matches no pending call (the Gemini CLI invents its
            // own when the echoed `functionCall` carried none) falls back to
            // name pairing, so the tool message still answers a real call.
            let slot = explicit
                .and_then(|id| pending.iter().position(|(_, pid)| pid == id))
                .or_else(|| pending.iter().position(|(pname, _)| pname == name));
            let id = slot
                .map(|idx| pending.remove(idx).1)
                .or_else(|| explicit.map(str::to_owned))
                .unwrap_or_else(|| format!("call_{turn}_{i}"));
            out.push(json!({
                "role": "tool",
                "tool_call_id": id,
                "content": response["response"].to_string(),
            }));
            answered = true;
        }
        if !answered || text.is_some() {
            out.push(json!({ "role": "user", "content": text.unwrap_or_default() }));
        }
    }
    out
}

/// Concatenate the `text` fields of a Gemini `parts` array into one string.
fn parts_text(parts: &Value) -> Option<String> {
    let arr = parts.as_array()?;
    let mut text = String::new();
    for p in arr {
        if let Some(t) = p["text"].as_str() {
            text.push_str(t);
        }
    }
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The Gemini `systemInstruction` can be `{parts: [...]}` or `{text: "..."}`.
fn system_instruction_text(body: &Value) -> Option<String> {
    let inst = body.get("systemInstruction")?;
    if let Some(parts) = inst.get("parts") {
        return parts_text(parts);
    }
    inst.get("text").and_then(Value::as_str).map(str::to_owned)
}

/// Project a Gemini `{name, description, parameters}` function declaration to
/// OpenAI's `{type: "function", function: {...}}` shape.
fn tool_to_openai(tool: &Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["parameters"],
        }
    })
}

/// Project the pipeline's unified OpenAI chat response to a Gemini
/// `generateContent` response (`candidates` + `usageMetadata`).
pub fn response_to_gemini(response: &Value, requested_model: &str) -> Value {
    let choice = &response["choices"][0];
    let message = &choice["message"];

    let mut parts: Vec<Value> = Vec::new();
    if let Some(text) = message["content"].as_str().filter(|s| !s.is_empty()) {
        parts.push(json!({ "text": text }));
    }
    // Tool calls → Gemini `functionCall` parts.
    if let Some(calls) = message["tool_calls"].as_array() {
        for c in calls {
            parts.push(json!({
                "functionCall": {
                    "name": c["function"]["name"],
                    "args": parse_json_arguments(&c["function"]["arguments"]),
                }
            }));
        }
    }

    let usage = &response["usage"];
    let input_tokens = usage["prompt_tokens"].as_u64().unwrap_or(0);
    let output_tokens = usage["completion_tokens"].as_u64().unwrap_or(0);

    json!({
        "candidates": [{
            "content": {
                "role": "model",
                "parts": parts,
            },
            "finishReason": finish_reason_to_gemini(choice["finish_reason"].as_str()),
        }],
        "modelVersion": requested_model,
        "usageMetadata": {
            "promptTokenCount": input_tokens,
            "candidatesTokenCount": output_tokens,
            "totalTokenCount": input_tokens + output_tokens,
        }
    })
}

/// Map an OpenAI finish reason to Gemini's `FINISH_REASON` vocabulary.
pub(crate) fn finish_reason_to_gemini(reason: Option<&str>) -> &'static str {
    match reason {
        Some("tool_calls") => "STOP", // tools are a normal completion to Gemini
        Some("length") => "MAX_TOKENS",
        Some("content_filter") => "BLOCKLIST",
        Some("stop") | None => "STOP",
        _ => "STOP",
    }
}

/// Decode an OpenAI `function.arguments` JSON-encoded string to the object
/// Gemini wants for `functionCall.args`. Unparseable → `{}`.
pub(crate) fn parse_json_arguments(arguments: &Value) -> Value {
    match arguments {
        Value::String(s) if !s.trim().is_empty() => {
            serde_json::from_str(s).unwrap_or_else(|_| json!({}))
        }
        Value::Object(_) => arguments.clone(),
        _ => json!({}),
    }
}

/// Copy a field when present.
fn copy_if_present(from: &Value, to: &mut Value, from_key: &str, to_key: &str) {
    if let Some(v) = from.get(from_key) {
        to[to_key] = v.clone();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contents_map_roles_and_parts() {
        let body = json!({
            "contents": [
                { "role": "user", "parts": [{ "text": "Hello" }] },
                { "role": "model", "parts": [{ "text": "Hi there" }] },
            ],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["messages"][0]["role"], "user");
        assert_eq!(out["messages"][0]["content"], "Hello");
        assert_eq!(out["messages"][1]["role"], "assistant");
        assert_eq!(out["messages"][1]["content"], "Hi there");
    }

    #[test]
    fn function_call_and_response_round_trip_to_tool_messages() {
        let body = json!({
            "contents": [
                { "role": "user", "parts": [{ "text": "Read both" }] },
                {
                    "role": "model",
                    "parts": [
                        { "text": "Reading." },
                        { "functionCall": { "name": "read_file", "args": { "path": "a" } } },
                        { "functionCall": { "name": "read_file", "args": { "path": "b" } } },
                    ],
                },
                {
                    "role": "user",
                    "parts": [
                        { "functionResponse": { "name": "read_file", "response": { "text": "A" } } },
                        { "functionResponse": { "name": "read_file", "response": { "text": "B" } } },
                        { "text": "Thanks" },
                    ],
                },
            ],
        });
        let out = request_to_openai(&body);
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 5);
        let assistant = &messages[1];
        assert_eq!(assistant["role"], "assistant");
        assert_eq!(assistant["content"], "Reading.");
        let calls = assistant["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["function"]["name"], "read_file");
        assert_eq!(calls[0]["function"]["arguments"], "{\"path\":\"a\"}");
        assert_ne!(calls[0]["id"], calls[1]["id"]);
        // Parallel same-name calls pair by position, not just by name.
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[2]["tool_call_id"], calls[0]["id"]);
        assert_eq!(messages[2]["content"], "{\"text\":\"A\"}");
        assert_eq!(messages[3]["role"], "tool");
        assert_eq!(messages[3]["tool_call_id"], calls[1]["id"]);
        assert_eq!(messages[4]["role"], "user");
        assert_eq!(messages[4]["content"], "Thanks");
    }

    #[test]
    fn function_role_and_explicit_ids_map_to_tool_messages() {
        let body = json!({
            "contents": [
                {
                    "role": "model",
                    "parts": [{ "functionCall": { "id": "fc_9", "name": "add", "args": { "a": 1 } } }],
                },
                {
                    "role": "function",
                    "parts": [{ "functionResponse": { "id": "fc_9", "name": "add", "response": { "result": 1 } } }],
                },
            ],
        });
        let out = request_to_openai(&body);
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], Value::Null);
        assert_eq!(messages[0]["tool_calls"][0]["id"], "fc_9");
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "fc_9");
    }

    #[test]
    fn unmatched_response_id_falls_back_to_name_pairing() {
        // The gateway emits `functionCall` without an id; the Gemini CLI then
        // answers with its own `{name}-{timestamp}-{rand}` id.
        let body = json!({
            "contents": [
                {
                    "role": "model",
                    "parts": [
                        { "functionCall": { "name": "read_file", "args": { "path": "a" } } },
                        { "functionCall": { "name": "list_dir", "args": {} } },
                    ],
                },
                {
                    "role": "user",
                    "parts": [
                        { "functionResponse": { "id": "list_dir-1760-xyz", "name": "list_dir", "response": { "entries": [] } } },
                        { "functionResponse": { "id": "read_file-1760-abc", "name": "read_file", "response": { "text": "A" } } },
                    ],
                },
            ],
        });
        let out = request_to_openai(&body);
        let messages = out["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 3);
        let calls = messages[0]["tool_calls"].as_array().unwrap();
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], calls[1]["id"]);
        assert_eq!(messages[2]["role"], "tool");
        assert_eq!(messages[2]["tool_call_id"], calls[0]["id"]);
    }

    #[test]
    fn system_instruction_hoists_to_system_message() {
        let body = json!({
            "systemInstruction": { "parts": [{ "text": "Be brief." }] },
            "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["messages"][0]["role"], "system");
        assert_eq!(out["messages"][0]["content"], "Be brief.");
    }

    #[test]
    fn generation_config_maps_params() {
        let body = json!({
            "generationConfig": {
                "temperature": 0.7,
                "topP": 0.9,
                "maxOutputTokens": 256,
                "stopSequences": ["END"],
            },
            "contents": [{ "role": "user", "parts": [{ "text": "Hi" }] }],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["temperature"], 0.7);
        assert_eq!(out["top_p"], 0.9);
        assert_eq!(out["max_tokens"], 256);
        assert_eq!(out["stop"], json!(["END"]));
    }

    #[test]
    fn tools_flat_map_function_declarations() {
        let body = json!({
            "tools": [{
                "functionDeclarations": [{
                    "name": "get_weather",
                    "description": "Get weather",
                    "parameters": { "type": "object" },
                }],
            }],
            "contents": [{ "role": "user", "parts": [{ "text": "Weather?" }] }],
        });
        let out = request_to_openai(&body);
        assert_eq!(out["tools"][0]["type"], "function");
        assert_eq!(out["tools"][0]["function"]["name"], "get_weather");
    }

    #[test]
    fn response_projects_candidates_and_usage() {
        let oai = json!({
            "choices": [{
                "message": { "role": "assistant", "content": "The answer is 42." },
                "finish_reason": "stop",
            }],
            "usage": { "prompt_tokens": 10, "completion_tokens": 5 },
        });
        let out = response_to_gemini(&oai, "gemini-2.0-flash");
        assert_eq!(out["candidates"][0]["content"]["role"], "model");
        assert_eq!(
            out["candidates"][0]["content"]["parts"][0]["text"],
            "The answer is 42."
        );
        assert_eq!(out["candidates"][0]["finishReason"], "STOP");
        assert_eq!(out["usageMetadata"]["promptTokenCount"], 10);
        assert_eq!(out["usageMetadata"]["candidatesTokenCount"], 5);
    }

    #[test]
    fn response_tool_calls_project_to_function_call_parts() {
        let oai = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "function": { "name": "add", "arguments": "{\"a\":1,\"b\":2}" },
                    }],
                },
                "finish_reason": "tool_calls",
            }],
            "usage": { "prompt_tokens": 1, "completion_tokens": 1 },
        });
        let out = response_to_gemini(&oai, "gemini-2.0-flash");
        assert_eq!(
            out["candidates"][0]["content"]["parts"][0]["functionCall"]["name"],
            "add"
        );
        assert_eq!(
            out["candidates"][0]["content"]["parts"][0]["functionCall"]["args"]["a"],
            1
        );
    }
}
