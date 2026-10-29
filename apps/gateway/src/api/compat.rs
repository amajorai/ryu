//! Inbound protocol-compat handlers: Anthropic `/v1/messages` and Google Gemini
//! `generateContent` / `streamGenerateContent`.
//!
//! Each handler authenticates like `/v1/chat/completions`, normalizes the
//! native-format request to the pipeline's OpenAI shape (via the pure functions
//! in `crate::compat`), runs the SAME governed pipeline (budgets, firewall,
//! routing, audit, live traffic), then projects the OpenAI response back to the
//! caller's native format.
//!
//! The streaming variants translate the pipeline's OpenAI SSE byte stream into
//! the native SSE dialect on the fly, reusing the tree's `stream::unfold`
//! chunking convention (no `async-stream` macro).

use std::collections::HashMap;
use std::net::SocketAddr;

use axum::{
    extract::{ConnectInfo, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use tracing::debug;

use crate::{
    compat,
    error::GatewayError,
    pipeline::{self, authenticate, AuthInputs},
    state::SharedState,
};

/// Authenticate a compat request. Compat clients (Claude Code, Gemini SDKs) do
/// not send the full `x-ryu-*` header set, so only the bearer key is threaded;
/// forwarded identity fields default to `None`.
pub(super) async fn authenticate_compat(
    state: &SharedState,
    headers: &HeaderMap,
    query_key: Option<&str>,
) -> Result<pipeline::RequestContext, GatewayError> {
    let raw_key = compat_api_key(headers, query_key);
    authenticate(state, AuthInputs::with_key(raw_key)).await
}

fn compat_api_key<'a>(headers: &'a HeaderMap, query_key: Option<&'a str>) -> Option<&'a str> {
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .or_else(|| headers.get("x-api-key").and_then(|v| v.to_str().ok()))
        .or_else(|| headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()))
        .or(query_key)
}

// ── Anthropic Messages (`POST /v1/messages`) ────────────────────────────────

/// `POST /v1/messages` — Anthropic Messages dialect. Translates the request to
/// the unified OpenAI body, runs the pipeline, and speaks the response back in
/// Anthropic's wire format.
pub async fn anthropic_messages(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    debug!(peer = %peer, "anthropic-compat: messages");
    let ctx = authenticate_compat(&state, &headers, None).await?;

    let requested_model = body["model"].as_str().unwrap_or("unknown").to_string();
    // Typed Anthropic tools are refused before translation, which would turn
    // them into function tools the caller never defined. This route never
    // forwards `anthropic-beta`, so a beta the fleet does not offer is refused
    // rather than silently dropped. Every header line is checked, not just the
    // first.
    let beta = pipeline::upstream_features::beta_header(&headers);
    if let Err(error) =
        pipeline::upstream_features::enforce_native_anthropic_tools(state.custody, &body).and_then(
            |()| pipeline::upstream_features::enforce_beta_header(state.custody, beta.as_deref()),
        )
    {
        pipeline::audit_refused(&state, &ctx, &requested_model, &error);
        return Err(error);
    }
    let is_stream = body["stream"].as_bool().unwrap_or(false);
    let openai_body = compat::anthropic::request_to_openai(&body);
    run_native::<AnthropicStreamState>(
        state,
        ctx,
        openai_body,
        is_stream,
        |response, request_id| {
            compat::anthropic::response_to_anthropic(response, &requested_model, request_id)
        },
    )
    .await
}

// ── Gemini (`generateContent` / `streamGenerateContent`) ─────────────────────

/// `POST /v1beta/models/{model}:generateContent` — Google Gemini dialect. The
/// model is taken from the URL path (Gemini carries it there, not in the body).
/// The whole trailing segment is captured (`{model}:generateContent` /
/// `{model}:streamGenerateContent`) because the operation suffix shares the
/// model's path segment — there is no slash between `gemini-2.0-flash` and
/// `:generateContent`. Streaming is selected by the `:streamGenerateContent`
/// suffix (the Gemini protocol carries it on the URL, not the body).
pub async fn gemini_generate(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    axum::extract::Path(spec): axum::extract::Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Result<Response, GatewayError> {
    let (model, op) = split_gemini_spec(&spec);
    let force_stream = op == "streamGenerateContent";
    // The hosted Gateway never reads a credential from the URL: an `rgw_`
    // token there is refused by the router, and any other `?key=` is ignored,
    // so the caller must authenticate with a header.
    let query_key = state
        .custody
        .accepts_query_credentials()
        .then(|| query.get("key").cloned())
        .flatten();
    gemini_generate_impl(
        state,
        peer,
        model,
        headers,
        query_key.as_deref(),
        body,
        force_stream,
    )
    .await
}

/// Split a captured `{model}:generateContent` path segment into model + op.
/// A spec without a `:` (a bare model) is still usable.
fn split_gemini_spec(spec: &str) -> (String, String) {
    match spec.rsplit_once(':') {
        Some((model, op)) => (model.to_string(), op.to_string()),
        None => (spec.to_string(), String::new()),
    }
}

async fn gemini_generate_impl(
    state: SharedState,
    peer: SocketAddr,
    model: String,
    headers: HeaderMap,
    query_key: Option<&str>,
    mut body: Value,
    force_stream: bool,
) -> Result<Response, GatewayError> {
    debug!(peer = %peer, model = %model, "gemini-compat: generateContent");
    let ctx = authenticate_compat(&state, &headers, query_key).await?;

    // The model lives on the URL; inject it into the normalized body so the
    // pipeline routes it.
    body["model"] = Value::String(model.clone());
    let is_stream = force_stream || body["stream"].as_bool().unwrap_or(false);
    let openai_body = compat::gemini::request_to_openai(&body);
    run_native::<GeminiStreamState>(state, ctx, openai_body, is_stream, |response, _| {
        compat::gemini::response_to_gemini(response, &model)
    })
    .await
}

/// Run a normalized OpenAI body through the governed pipeline and speak the
/// result back in the caller's native dialect: a stream is re-framed on the fly
/// by `S`, a complete response is mapped by `project` (given its request id).
async fn run_native<S: NativeStream>(
    state: SharedState,
    ctx: pipeline::RequestContext,
    mut openai_body: Value,
    is_stream: bool,
    project: impl FnOnce(&Value, &str) -> Value,
) -> Result<Response, GatewayError> {
    // Force the streaming flag on the normalized body.
    openai_body["stream"] = Value::Bool(is_stream);

    if is_stream {
        let output = pipeline::run_stream(state, ctx, openai_body).await?;
        let translated = translate_openai_stream::<S>(output.body);
        let mut response = Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .header("cache-control", "no-cache")
            .header("x-request-id", &output.context.request_id)
            .body(axum::body::Body::from_stream(translated))
            .map_err(|e| GatewayError::Internal(anyhow::anyhow!("response build error: {e}")))?;
        if let Ok(v) = HeaderValue::from_str(&output.model_used) {
            response.headers_mut().insert("x-routed-model", v);
        }
        Ok(response)
    } else {
        let output = pipeline::run(state, ctx, openai_body).await?;
        let native = project(&output.response, &output.context.request_id);
        let mut response = Json(native).into_response();
        if let Ok(v) = HeaderValue::from_str(&output.context.request_id) {
            response.headers_mut().insert("x-request-id", v);
        }
        if let Ok(v) = HeaderValue::from_str(&output.model_used) {
            response.headers_mut().insert("x-routed-model", v);
        }
        Ok(response)
    }
}

// ── SSE dialect translation ──────────────────────────────────────────────────

/// One native SSE dialect the pipeline's OpenAI stream is re-framed into.
trait NativeStream: Default + Send + 'static {
    /// Native events for one parsed OpenAI chunk (empty when none are due).
    fn chunk_events(&mut self, chunk: &Value) -> String;
    /// The terminal native events (empty once the stream has finished).
    fn finish_events(&mut self) -> String;
}

impl NativeStream for AnthropicStreamState {
    fn chunk_events(&mut self, chunk: &Value) -> String {
        anthropic_chunk_events(self, chunk)
    }

    fn finish_events(&mut self) -> String {
        anthropic_finish(self)
    }
}

/// Gemini `streamGenerateContent` chunks. Finish metadata is emitted only on
/// the terminal candidate, and tool-call fragments are accumulated until their
/// arguments form a Gemini object.
impl NativeStream for GeminiStreamState {
    fn chunk_events(&mut self, chunk: &Value) -> String {
        gemini_stream_event(self, chunk).unwrap_or_default()
    }

    fn finish_events(&mut self) -> String {
        gemini_finish(self).unwrap_or_default()
    }
}

#[derive(Default)]
struct AnthropicStreamState {
    finished: bool,
    started: bool,
    next_block_index: usize,
    text_block_index: Option<usize>,
    tool_blocks: Vec<AnthropicToolBlock>,
    saw_tool_call: bool,
    /// The OpenAI `finish_reason`, once seen. OpenAI-compatible upstreams send
    /// usage in a separate chunk after it, so `message_delta`/`message_stop`
    /// wait for that chunk (or `[DONE]` / end of stream).
    finish_reason: Option<String>,
    saw_usage: bool,
    stop_reason: Option<String>,
    message_id: String,
    model: String,
    input_tokens: u64,
    output_tokens: u64,
}

struct AnthropicToolBlock {
    openai_index: u64,
    anthropic_index: usize,
    id: String,
    name: String,
    started: bool,
    closed: bool,
}

fn anthropic_event(event_type: &str, data: Value) -> String {
    format!("event: {event_type}\ndata: {data}\n\n")
}

fn anthropic_block_stop(index: usize) -> String {
    anthropic_event(
        "content_block_stop",
        json!({ "type": "content_block_stop", "index": index }),
    )
}

/// Close every started tool-use block that is still open.
fn anthropic_close_tool_blocks(blocks: &mut [AnthropicToolBlock]) -> String {
    let mut output = String::new();
    for block in blocks
        .iter_mut()
        .filter(|block| block.started && !block.closed)
    {
        output.push_str(&anthropic_block_stop(block.anthropic_index));
        block.closed = true;
    }
    output
}

fn anthropic_start(state: &mut AnthropicStreamState, chunk: &Value) -> String {
    if state.started {
        return String::new();
    }
    state.started = true;
    state.message_id = chunk["id"]
        .as_str()
        .unwrap_or("chatcmpl-compat")
        .to_string();
    state.model = chunk["model"].as_str().unwrap_or_default().to_string();
    anthropic_event(
        "message_start",
        json!({
            "type": "message_start",
            "message": {
                "id": state.message_id,
                "type": "message",
                "role": "assistant",
                "content": [],
                "model": state.model,
                "stop_reason": null,
                "stop_sequence": null,
                "usage": {
                    "input_tokens": state.input_tokens,
                    "output_tokens": state.output_tokens,
                },
            },
        }),
    )
}

/// Close every open text and tool block. Idempotent: closed blocks are marked
/// so the terminal emit never closes them twice.
fn anthropic_close_blocks(state: &mut AnthropicStreamState) -> String {
    let mut output = state
        .text_block_index
        .take()
        .map(anthropic_block_stop)
        .unwrap_or_default();
    output.push_str(&anthropic_close_tool_blocks(&mut state.tool_blocks));
    output
}

/// Terminal emit: close any open blocks, then `message_delta` (stop reason +
/// usage) and `message_stop`, exactly once.
fn anthropic_finish(state: &mut AnthropicStreamState) -> String {
    if state.finished {
        return String::new();
    }
    state.finished = true;
    let reason = match state.finish_reason.as_deref() {
        Some(reason) => compat::anthropic::stop_reason_to_anthropic(Some(reason)),
        None if state.saw_tool_call => "tool_use",
        None => "end_turn",
    };
    state.stop_reason = Some(reason.to_string());

    let mut output = anthropic_close_blocks(state);
    output.push_str(&anthropic_event(
        "message_delta",
        json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": reason,
                "stop_sequence": null,
            },
            // `message_start` goes out before any usage exists, so the input
            // count rides here too.
            "usage": {
                "input_tokens": state.input_tokens,
                "output_tokens": state.output_tokens,
            },
        }),
    ));
    output.push_str(&anthropic_event(
        "message_stop",
        json!({ "type": "message_stop" }),
    ));
    output
}

/// Project one chunk's OpenAI tool-call deltas onto Anthropic `tool_use`
/// blocks, closing the open text block first.
fn anthropic_tool_call_events(state: &mut AnthropicStreamState, calls: &[Value]) -> String {
    state.saw_tool_call = true;
    let mut output = state
        .text_block_index
        .take()
        .map(anthropic_block_stop)
        .unwrap_or_default();
    for (position, call) in calls.iter().enumerate() {
        let openai_index = call["index"].as_u64().unwrap_or(position as u64);
        let block_position = state
            .tool_blocks
            .iter()
            .position(|block| block.openai_index == openai_index)
            .unwrap_or_else(|| {
                let index = state.next_block_index;
                state.next_block_index += 1;
                state.tool_blocks.push(AnthropicToolBlock {
                    openai_index,
                    anthropic_index: index,
                    id: String::new(),
                    name: String::new(),
                    started: false,
                    closed: false,
                });
                state.tool_blocks.len() - 1
            });
        let block = &mut state.tool_blocks[block_position];
        if let Some(id) = call["id"].as_str() {
            block.id = id.to_string();
        }
        if let Some(name) = call["function"]["name"].as_str() {
            block.name = name.to_string();
        }
        if !block.started {
            block.started = true;
            let id = if block.id.is_empty() {
                format!("toolu_compat_{}", block.openai_index)
            } else {
                block.id.clone()
            };
            let name = if block.name.is_empty() {
                "unknown".to_string()
            } else {
                block.name.clone()
            };
            output.push_str(&anthropic_event(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": block.anthropic_index,
                    "content_block": {
                        "type": "tool_use",
                        "id": id,
                        "name": name,
                        "input": {},
                    },
                }),
            ));
        }
        let arguments = call["function"]["arguments"].as_str();
        if let Some(arguments) = arguments.filter(|arguments| !arguments.is_empty()) {
            output.push_str(&anthropic_event(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": block.anthropic_index,
                    "delta": {
                        "type": "input_json_delta",
                        "partial_json": arguments,
                    },
                }),
            ));
        }
    }
    output
}

/// End the stream with an Anthropic `error` event carrying `error` as sent.
/// The 00.7 code and detail (an appeal link, a retry hint) stay intact, and
/// the stream is marked finished so no `message_delta` or `message_stop`
/// follows: a refused stream never reads as a completed turn.
fn anthropic_error(state: &mut AnthropicStreamState, error: &Value) -> String {
    state.finished = true;
    anthropic_event("error", json!({ "type": "error", "error": error }))
}

fn anthropic_chunk_events(state: &mut AnthropicStreamState, chunk: &Value) -> String {
    if state.finished {
        return String::new();
    }
    // An in-band error frame (a mid-stream standing refusal, or an upstream
    // stream error) ends the stream instead of being read as an empty chunk.
    if let Some(error) = chunk.get("error").filter(|error| error.is_object()) {
        return anthropic_error(state, error);
    }
    let mut output = anthropic_start(state, chunk);
    let choice = &chunk["choices"][0];
    let delta = &choice["delta"];

    if let Some(usage) = chunk.get("usage").filter(|usage| usage.is_object()) {
        state.saw_usage = true;
        state.input_tokens = usage["prompt_tokens"]
            .as_u64()
            .unwrap_or(state.input_tokens);
        state.output_tokens = usage["completion_tokens"]
            .as_u64()
            .unwrap_or(state.output_tokens);
    }
    if state.finish_reason.is_some() {
        // Blocks are already closed; only the trailing usage chunk matters.
        if state.saw_usage {
            output.push_str(&anthropic_finish(state));
        }
        return output;
    }

    if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
        output.push_str(&anthropic_close_tool_blocks(&mut state.tool_blocks));
        let index = *state.text_block_index.get_or_insert_with(|| {
            let index = state.next_block_index;
            state.next_block_index += 1;
            output.push_str(&anthropic_event(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": index,
                    "content_block": { "type": "text", "text": "" },
                }),
            ));
            index
        });
        output.push_str(&anthropic_event(
            "content_block_delta",
            json!({
                "type": "content_block_delta",
                "index": index,
                "delta": { "type": "text_delta", "text": text },
            }),
        ));
    }

    if let Some(calls) = delta["tool_calls"].as_array() {
        output.push_str(&anthropic_tool_call_events(state, calls));
    }

    if let Some(reason) = choice["finish_reason"].as_str() {
        state.finish_reason = Some(reason.to_string());
        output.push_str(&anthropic_close_blocks(state));
        // Usage that arrived before or with the finish chunk (the GenAI path)
        // finishes now; otherwise wait for the trailing usage chunk.
        if state.saw_usage {
            output.push_str(&anthropic_finish(state));
        }
    }
    output
}

#[derive(Default)]
struct GeminiStreamState {
    finished: bool,
    /// The `finishReason` candidate went out; a trailing usage-only chunk may
    /// still follow it (OpenAI-compatible upstreams send usage last).
    sent_finish: bool,
    saw_usage: bool,
    saw_tool_call: bool,
    tool_calls: Vec<GeminiToolCall>,
}

struct GeminiToolCall {
    index: u64,
    name: String,
    arguments: String,
    emitted: bool,
}

fn gemini_function_call(name: &str, args: Value) -> Value {
    json!({ "functionCall": { "name": name, "args": args } })
}

fn gemini_stream_event(state: &mut GeminiStreamState, chunk: &Value) -> Option<String> {
    if state.finished {
        return None;
    }
    // An in-band error frame (a mid-stream standing refusal, or an upstream
    // stream error) is passed through with its 00.7 code and detail, and the
    // stream is marked finished so no `finishReason: STOP` follows.
    if let Some(error) = chunk.get("error").filter(|error| error.is_object()) {
        state.finished = true;
        return Some(format!("data: {}\n\n", json!({ "error": error })));
    }
    let usage = chunk.get("usage").filter(|usage| usage.is_object());
    if state.sent_finish {
        // Only a trailing usage chunk is still meaningful.
        let usage = usage?;
        state.finished = true;
        return Some(format!(
            "data: {}\n\n",
            json!({ "usageMetadata": gemini_usage_metadata(usage) })
        ));
    }
    if usage.is_some() {
        state.saw_usage = true;
    }
    let choice = &chunk["choices"][0];
    let delta = &choice["delta"];
    let mut parts = Vec::new();
    if let Some(text) = delta["content"].as_str().filter(|text| !text.is_empty()) {
        parts.push(json!({ "text": text }));
    }
    if let Some(calls) = delta["tool_calls"].as_array() {
        state.saw_tool_call = true;
        for (position, call) in calls.iter().enumerate() {
            let index = call["index"].as_u64().unwrap_or(position as u64);
            let call_state = if let Some(existing) =
                state.tool_calls.iter_mut().find(|call| call.index == index)
            {
                existing
            } else {
                state.tool_calls.push(GeminiToolCall {
                    index,
                    name: String::new(),
                    arguments: String::new(),
                    emitted: false,
                });
                state
                    .tool_calls
                    .last_mut()
                    .expect("tool call was just pushed")
            };
            if let Some(name) = call["function"]["name"].as_str() {
                call_state.name = name.to_string();
            }
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                call_state.arguments.push_str(arguments);
            }
            if !call_state.emitted {
                if let Ok(args) = serde_json::from_str::<Value>(&call_state.arguments) {
                    parts.push(gemini_function_call(&call_state.name, args));
                    call_state.emitted = true;
                }
            }
        }
    }

    let reason = choice["finish_reason"].as_str();
    if reason.is_some() {
        for call in &mut state.tool_calls {
            if call.emitted {
                continue;
            }
            let args = compat::gemini::parse_json_arguments(&Value::String(call.arguments.clone()));
            parts.push(gemini_function_call(&call.name, args));
            call.emitted = true;
        }
    }
    if parts.is_empty() && reason.is_none() && usage.is_none() {
        return None;
    }

    let mut candidate = json!({
        "content": { "role": "model", "parts": parts },
    });
    if let Some(reason) = reason {
        state.sent_finish = true;
        // Finished now only when usage already arrived; otherwise a trailing
        // usage chunk may still follow.
        state.finished = state.saw_usage;
        candidate["finishReason"] =
            Value::String(compat::gemini::finish_reason_to_gemini(Some(reason)).to_string());
    }
    let mut response = json!({ "candidates": [candidate] });
    if let Some(usage) = usage {
        response["usageMetadata"] = gemini_usage_metadata(usage);
    }
    Some(format!("data: {response}\n\n"))
}

fn gemini_usage_metadata(usage: &Value) -> Value {
    json!({
        "promptTokenCount": usage["prompt_tokens"].as_u64().unwrap_or(0),
        "candidatesTokenCount": usage["completion_tokens"].as_u64().unwrap_or(0),
        "totalTokenCount": usage["total_tokens"].as_u64().unwrap_or(0),
    })
}

fn gemini_finish(state: &mut GeminiStreamState) -> Option<String> {
    if state.finished {
        return None;
    }
    state.finished = true;
    if state.sent_finish {
        return None;
    }
    let reason = if state.saw_tool_call {
        "tool_calls"
    } else {
        "stop"
    };
    Some(format!(
        "data: {}\n\n",
        json!({
            "candidates": [{
                "content": { "role": "model", "parts": [] },
                "finishReason": compat::gemini::finish_reason_to_gemini(Some(reason)),
            }],
        })
    ))
}

/// Translate the pipeline's OpenAI SSE byte stream into the native SSE
/// dialect `S`, one complete `data:` line at a time.
fn translate_openai_stream<S: NativeStream>(
    body: axum::body::Body,
) -> impl Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send + 'static {
    use futures_util::stream;

    let inner = body.into_data_stream();
    stream::unfold(
        (inner, Vec::<u8>::new(), S::default()),
        |(mut inner, mut pending, mut state)| async move {
            loop {
                match inner.next().await {
                    Some(Ok(bytes)) => {
                        pending.extend_from_slice(&bytes);
                        let split_at = match pending.iter().rposition(|byte| *byte == b'\n') {
                            Some(index) => index + 1,
                            None => continue,
                        };
                        let ready: Vec<u8> = pending.drain(..split_at).collect();
                        let mut output = String::new();
                        for line in String::from_utf8_lossy(&ready).lines() {
                            let Some(data) = line.trim().strip_prefix("data:") else {
                                continue;
                            };
                            let data = data.trim();
                            if data == "[DONE]" {
                                output.push_str(&state.finish_events());
                            } else if let Ok(chunk) = serde_json::from_str::<Value>(data) {
                                output.push_str(&state.chunk_events(&chunk));
                            }
                        }
                        if !output.is_empty() {
                            return Some((Ok(bytes::Bytes::from(output)), (inner, pending, state)));
                        }
                    }
                    Some(Err(error)) => {
                        return Some((
                            Err(std::io::Error::other(error.to_string())),
                            (inner, pending, state),
                        ));
                    }
                    None => {
                        if !pending.is_empty() {
                            let ready = String::from_utf8_lossy(&pending).to_string();
                            pending.clear();
                            if let Some(data) = ready.trim().strip_prefix("data:") {
                                if let Ok(chunk) = serde_json::from_str::<Value>(data.trim()) {
                                    let output = state.chunk_events(&chunk);
                                    if !output.is_empty() {
                                        return Some((
                                            Ok(bytes::Bytes::from(output)),
                                            (inner, pending, state),
                                        ));
                                    }
                                }
                            }
                        }
                        let output = state.finish_events();
                        if !output.is_empty() {
                            return Some((Ok(bytes::Bytes::from(output)), (inner, pending, state)));
                        }
                        return None;
                    }
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compat_auth_accepts_standard_headers_and_query_fallback() {
        let mut headers = HeaderMap::new();
        headers.insert("x-api-key", HeaderValue::from_static("anthropic-key"));
        assert_eq!(
            compat_api_key(&headers, Some("query-key")),
            Some("anthropic-key")
        );

        headers.insert("authorization", HeaderValue::from_static("Bearer auth-key"));
        assert_eq!(
            compat_api_key(&headers, Some("query-key")),
            Some("Bearer auth-key")
        );

        headers.remove("authorization");
        headers.remove("x-api-key");
        headers.insert("x-goog-api-key", HeaderValue::from_static("gemini-key"));
        assert_eq!(
            compat_api_key(&headers, Some("query-key")),
            Some("gemini-key")
        );

        headers.remove("x-goog-api-key");
        assert_eq!(
            compat_api_key(&headers, Some("query-key")),
            Some("query-key")
        );
    }

    #[test]
    fn anthropic_stream_has_stateful_message_and_text_framing() {
        let mut state = AnthropicStreamState::default();
        let start = anthropic_chunk_events(
            &mut state,
            &json!({
                "id": "chatcmpl_1",
                "model": "gpt-compat",
                "choices": [{ "delta": { "role": "assistant" }, "finish_reason": null }],
            }),
        );
        let text = anthropic_chunk_events(
            &mut state,
            &json!({ "choices": [{ "delta": { "content": "Hello" }, "finish_reason": null }] }),
        );
        let finish = anthropic_chunk_events(
            &mut state,
            &json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] }),
        );
        // No usage yet: blocks close, but the message waits for `[DONE]`.
        assert!(finish.contains("event: content_block_stop"));
        assert!(!finish.contains("event: message_stop"));
        let terminal = anthropic_finish(&mut state);

        assert!(start.contains("event: message_start"));
        assert!(text.contains("event: content_block_start"));
        assert!(text.contains("\"type\":\"text_delta\""));
        assert!(!terminal.contains("event: content_block_stop"));
        assert!(terminal.contains("\"stop_reason\":\"end_turn\""));
        assert!(terminal.contains("event: message_stop"));
        assert!(!text.contains("finishReason"));
    }

    #[test]
    fn anthropic_stream_projects_tool_call_deltas() {
        let mut state = AnthropicStreamState::default();
        let events = anthropic_chunk_events(
            &mut state,
            &json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{\"q\":" },
                        }]
                    },
                    "finish_reason": null,
                }],
            }),
        );
        anthropic_chunk_events(
            &mut state,
            &json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] }),
        );
        let terminal = anthropic_finish(&mut state);

        assert!(events.contains("\"type\":\"tool_use\""));
        assert!(events.contains("\"type\":\"input_json_delta\""));
        assert!(terminal.contains("\"stop_reason\":\"tool_use\""));
    }

    #[test]
    fn gemini_stream_keeps_deltas_unfinished_until_terminal_chunk() {
        let mut state = GeminiStreamState::default();
        let text = gemini_stream_event(
            &mut state,
            &json!({ "choices": [{ "delta": { "content": "Hello" }, "finish_reason": null }] }),
        )
        .expect("text chunk should be emitted");
        assert!(text.contains("\"text\":\"Hello\""));
        assert!(!text.contains("finishReason"));

        let tool = gemini_stream_event(
            &mut state,
            &json!({
                "choices": [{
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "function": { "name": "lookup", "arguments": "{\"q\":\"x\"}" },
                        }]
                    },
                    "finish_reason": "tool_calls",
                }],
            }),
        )
        .expect("tool chunk should be emitted");
        assert!(tool.contains("functionCall"));
        assert!(tool.contains("\"finishReason\":\"STOP\""));
        assert!(gemini_finish(&mut state).is_none());
    }

    #[tokio::test]
    async fn stream_translators_consume_openai_sse_fixtures() {
        let fixture = concat!(
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"compat\",\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}\n\n",
            "data: [DONE]\n\n",
        );

        let anthropic_stream =
            translate_openai_stream::<AnthropicStreamState>(axum::body::Body::from(fixture));
        futures_util::pin_mut!(anthropic_stream);
        let mut anthropic = String::new();
        while let Some(Ok(chunk)) = anthropic_stream.next().await {
            anthropic.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(anthropic.contains("event: message_start"));
        assert!(anthropic.contains("event: message_stop"));
        assert!(anthropic.contains("\"output_tokens\":2"));
        assert_eq!(anthropic.matches("event: message_stop").count(), 1);

        let gemini_stream =
            translate_openai_stream::<GeminiStreamState>(axum::body::Body::from(fixture));
        futures_util::pin_mut!(gemini_stream);
        let mut gemini = String::new();
        while let Some(Ok(chunk)) = gemini_stream.next().await {
            gemini.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(gemini.contains("\"text\":\"Hi\""));
        assert!(gemini.contains("\"finishReason\":\"STOP\""));
        assert!(gemini.contains("\"usageMetadata\""));
        assert!(gemini.contains("\"candidatesTokenCount\":2"));
        assert_eq!(gemini.matches("\"finishReason\"").count(), 1);
    }

    #[tokio::test]
    async fn stream_translators_keep_usage_sent_after_finish_reason() {
        // OpenAI ordering with `include_usage`: `usage: null` on content
        // chunks, finish_reason, then a usage-only chunk, then `[DONE]`.
        let fixture = concat!(
            "data: {\"id\":\"chatcmpl_1\",\"model\":\"compat\",\"choices\":[{\"delta\":{\"content\":\"Hi\"},\"finish_reason\":null}],\"usage\":null}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":null}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":8,\"total_tokens\":20}}\n\n",
            "data: [DONE]\n\n",
        );

        let anthropic_stream =
            translate_openai_stream::<AnthropicStreamState>(axum::body::Body::from(fixture));
        futures_util::pin_mut!(anthropic_stream);
        let mut anthropic = String::new();
        while let Some(Ok(chunk)) = anthropic_stream.next().await {
            anthropic.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(anthropic.contains("\"output_tokens\":8"));
        assert!(anthropic.contains("\"input_tokens\":12"));
        assert!(anthropic.contains("\"stop_reason\":\"end_turn\""));
        assert_eq!(anthropic.matches("event: content_block_stop").count(), 1);
        assert_eq!(anthropic.matches("event: message_stop").count(), 1);

        let gemini_stream =
            translate_openai_stream::<GeminiStreamState>(axum::body::Body::from(fixture));
        futures_util::pin_mut!(gemini_stream);
        let mut gemini = String::new();
        while let Some(Ok(chunk)) = gemini_stream.next().await {
            gemini.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert_eq!(gemini.matches("\"finishReason\"").count(), 1);
        assert_eq!(gemini.matches("\"usageMetadata\"").count(), 1);
        assert!(gemini.contains("\"candidatesTokenCount\":8"));
    }
}
