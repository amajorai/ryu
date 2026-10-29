//! Real-duration OTel GenAI model-call spans.
//!
//! One [`ModelCallSpan`] covers one provider attempt: it opens before the
//! provider call (a child of the inbound `http.server.request` span), stamps the
//! W3C `traceparent` of the model-call span onto the outbound provider request
//! (through `ryu_gw_providers::trace_context`), and closes when the non-streaming
//! response returns, the stream ends, or the call errors. Span name follows the
//! GenAI conventions — `"{gen_ai.operation.name} {gen_ai.request.model}"`, kind
//! CLIENT, status ERROR plus `error.type` on failure.
//!
//! Gates (all three orthogonal, all preserved from the old after-the-fact
//! `emit_gen_ai_span`):
//! - **export** — without the consented OTLP layer the guard holds
//!   `Span::none()`: nothing is built, recorded, or injected, so creation is a
//!   couple of atomic loads when export is off;
//! - **`OTEL_SEMCONV_STABILITY_OPT_IN`** — every `gen_ai.*` attribute (content
//!   included) is set only when the experimental conventions are opted into;
//!   `server.*`, `http.*`, `error.type` and the `ryu.*` attributes are stable
//!   names and are set regardless;
//! - **content mode** — prompts/completions are attached only when
//!   [`super::content_enabled`] (content mode AND the export layer), capped by
//!   [`super::max_content_bytes`] with `ryu.content.truncated` on overflow.
//!
//! Attributes are written with `OpenTelemetrySpanExt::set_attribute`, so they live
//! only on the OTel span: the local `fmt` sink never prints prompt content or
//! the long attribute list on unrelated log lines.

use std::future::Future;
use std::sync::Arc;
use std::time::Instant;

use opentelemetry::trace::Status;
use opentelemetry::{Array, Key, StringValue, Value as OtelValue};
use ryu_gw_providers::trace_context::{self, OutboundTrace};
use serde_json::Value;
use tracing::Instrument as _;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

use super::content::{
    gen_ai_message, gen_ai_output_message, reasoning_part, text_part, tool_call_part,
    tool_call_response_part, truncate_span_content, CONTENT_TRUNCATED_ATTR,
};

/// GenAI well-known `gen_ai.operation.name` values used by the gateway.
pub const OPERATION_CHAT: &str = "chat";
/// Embedding requests.
pub const OPERATION_EMBEDDINGS: &str = "embeddings";
/// Multimodal generation (image / speech synthesis / transcription).
pub const OPERATION_GENERATE_CONTENT: &str = "generate_content";
/// `gen_ai.operation.name` of a tool the gateway's own tool loop runs.
pub const OPERATION_EXECUTE_TOOL: &str = "execute_tool";
/// `error.type` of a model call whose caller went away (client disconnect,
/// server timeout, or a caller-side deadline) before an outcome was recorded.
pub const ERROR_CANCELLED: &str = "cancelled";
/// `error.type` of a failed tool execution.
pub const ERROR_TOOL: &str = "tool_error";
/// Set when the content guard withheld some content (firewall Block policy).
pub const CONTENT_REDACTED_ATTR: &str = "ryu.content.redacted";
/// Streamed `tool_calls[].index` values at or above this are ignored: the index
/// comes from the upstream body and must never size an allocation.
const MAX_STREAM_TOOL_CALLS: usize = 128;

/// Applies the request's outbound firewall/DLP to span content before it is
/// exported. Rewrites the value in place (sanitize/redact) and returns `false`
/// when the content must be withheld entirely (Block policy).
pub type ContentGuard = Arc<dyn Fn(&mut Value) -> bool + Send + Sync>;

/// Which telemetry gates are open for one span. [`SpanGates::current`] reads the
/// process state; tests construct it directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpanGates {
    /// The consented OTLP layer is installed.
    pub export: bool,
    /// `OTEL_SEMCONV_STABILITY_OPT_IN` opts into the `gen_ai.*` conventions.
    pub gen_ai: bool,
    /// Content mode is on (only meaningful with `export`).
    pub content: bool,
    /// Per-span content byte cap.
    pub max_content_bytes: usize,
}

impl SpanGates {
    /// The gates as configured for this process.
    pub fn current() -> Self {
        let export = super::EXPORT_ACTIVE.load(std::sync::atomic::Ordering::Relaxed);
        if !export {
            return Self::closed();
        }
        Self {
            export,
            gen_ai: super::gen_ai_enabled(),
            content: super::content_enabled(),
            max_content_bytes: super::max_content_bytes(),
        }
    }

    /// Everything off: the span is a no-op.
    pub const fn closed() -> Self {
        Self {
            export: false,
            gen_ai: false,
            content: false,
            max_content_bytes: super::DEFAULT_MAX_CONTENT_BYTES,
        }
    }

    fn content(self) -> bool {
        self.export && self.gen_ai && self.content
    }
}

/// What the gateway knows about a model call before it is sent.
#[derive(Debug, Clone, Copy)]
pub struct ModelCallRequest<'a> {
    /// `gen_ai.operation.name` (see the `OPERATION_*` constants).
    pub operation: &'a str,
    /// The Ryu provider id serving the call.
    pub provider: &'a str,
    /// `gen_ai.request.model`.
    pub model: &'a str,
    /// The OpenAI-shaped request body (request parameters and, in content
    /// mode, the input messages).
    pub body: Option<&'a Value>,
    /// Whether the response is streamed (`gen_ai.request.stream`).
    pub stream: bool,
    /// `gen_ai.output.type` when known (`text`, `json`, `image`, `speech`).
    pub output_type: Option<&'a str>,
    /// `ryu.request.id`.
    pub request_id: &'a str,
    /// `gen_ai.conversation.id` (the Ryu session/thread id) when known.
    pub conversation_id: Option<&'a str>,
}

/// Token usage reported by the provider. `None` fields are omitted rather
/// than reported as 0.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ModelCallUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_write_input_tokens: Option<u64>,
    pub reasoning_output_tokens: Option<u64>,
}

/// Response metadata (and, in content mode, output messages) for the span.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ModelCallResponse {
    pub id: Option<String>,
    pub model: Option<String>,
    pub finish_reasons: Vec<String>,
    pub usage: ModelCallUsage,
    /// GenAI output messages; empty unless content was collected.
    pub output_messages: Vec<Value>,
}

/// Guard for one model-call span. Dropping it ends the span; [`finish`]
/// does the same explicitly.
///
/// [`finish`]: ModelCallSpan::finish
pub struct ModelCallSpan {
    span: tracing::Span,
    gates: SpanGates,
    started: Instant,
    first_chunk_recorded: bool,
    outbound: Option<Arc<OutboundTrace>>,
    system_instructions: Option<Value>,
    input_messages: Vec<Value>,
    output_messages: Vec<Value>,
    content_guard: Option<ContentGuard>,
    outcome_recorded: bool,
    finished: bool,
}

impl ModelCallSpan {
    /// Open a model-call span under the current span with the process gates.
    pub fn start(request: ModelCallRequest<'_>) -> Self {
        Self::start_with(SpanGates::current(), request)
    }

    /// A guard that records nothing.
    pub fn disabled() -> Self {
        Self {
            span: tracing::Span::none(),
            gates: SpanGates::closed(),
            started: Instant::now(),
            first_chunk_recorded: false,
            outbound: None,
            system_instructions: None,
            input_messages: Vec::new(),
            output_messages: Vec::new(),
            content_guard: None,
            outcome_recorded: false,
            finished: false,
        }
    }

    /// Open a model-call span with explicit gates.
    pub fn start_with(gates: SpanGates, request: ModelCallRequest<'_>) -> Self {
        if !gates.export {
            return Self::disabled();
        }
        let name = span_name(request.operation, request.model);
        // INFO so it clears the OTLP layer's INFO+ filter. Only the OTel
        // name/kind/status ride as `tracing` fields; everything else is set on
        // the OTel span directly (see the module docs).
        let span = tracing::info_span!(
            "gen_ai.client.operation",
            "otel.name" = %name,
            "otel.kind" = "client",
        );
        for (key, value) in request_attributes(gates, &request) {
            span.set_attribute(key, value);
        }
        let headers = span.in_scope(super::propagation::current_trace_context_fields);
        let (system_instructions, input_messages) = match request.body {
            Some(body) if gates.content() => input_content(body),
            _ => (None, Vec::new()),
        };
        Self {
            span,
            gates,
            started: Instant::now(),
            first_chunk_recorded: false,
            outbound: Some(OutboundTrace::new(headers)),
            system_instructions,
            input_messages,
            output_messages: Vec::new(),
            content_guard: None,
            outcome_recorded: false,
            finished: false,
        }
    }

    /// Run every exported content attribute through `guard` (the request's
    /// outbound firewall) when the span closes. Content mode only.
    pub fn set_content_guard(&mut self, guard: ContentGuard) {
        if self.gates.content() {
            self.content_guard = Some(guard);
        }
    }

    /// Whether this span records anything (export is on).
    pub fn is_recording(&self) -> bool {
        self.gates.export
    }

    /// Whether output content should be collected for this span.
    pub fn wants_content(&self) -> bool {
        self.gates.content()
    }

    /// Run the provider call inside the span with the outbound trace scope, so
    /// provider HTTP requests carry this span's `traceparent`.
    pub fn instrument<F: Future>(&self, future: F) -> impl Future<Output = F::Output> {
        let span = self.span.clone();
        let outbound = self.outbound.clone().unwrap_or_default();
        trace_context::scope(outbound, future.instrument(span))
    }

    /// Record the first streamed chunk (`gen_ai.response.time_to_first_chunk`).
    pub fn record_first_chunk(&mut self) {
        if self.first_chunk_recorded || !self.gates.export {
            return;
        }
        self.first_chunk_recorded = true;
        if self.gates.gen_ai {
            self.span.set_attribute(
                "gen_ai.response.time_to_first_chunk",
                self.started.elapsed().as_secs_f64(),
            );
        }
    }

    /// Record response metadata, usage and (content mode) output messages.
    pub fn record_response(&mut self, response: ModelCallResponse) {
        if !self.gates.export {
            return;
        }
        self.outcome_recorded = true;
        for (key, value) in response_attributes(self.gates, &response) {
            self.span.set_attribute(key, value);
        }
        if self.gates.content() {
            self.output_messages = response.output_messages;
        }
    }

    /// Mark the call failed: status ERROR and `error.type`.
    pub fn record_error(&mut self, error_type: &str) {
        if !self.gates.export {
            return;
        }
        self.outcome_recorded = true;
        self.span.set_attribute("error.type", error_type.to_owned());
        self.span.set_status(Status::error(error_type.to_owned()));
    }

    /// End the span now.
    pub fn finish(mut self) {
        self.close();
    }

    fn close(&mut self) {
        if self.finished || !self.gates.export {
            return;
        }
        self.finished = true;
        if let Some(outbound) = &self.outbound {
            let observed = outbound.observed();
            if let Some(address) = observed.server_address {
                self.span.set_attribute("server.address", address);
            }
            if let Some(port) = observed.server_port {
                self.span.set_attribute("server.port", i64::from(port));
            }
            if let Some(status) = observed.status {
                self.span
                    .set_attribute("http.response.status_code", i64::from(status));
            }
        }
        if self.gates.content() {
            let mut system = self.system_instructions.take();
            let mut input = std::mem::take(&mut self.input_messages);
            let mut output = std::mem::take(&mut self.output_messages);
            if let Some(guard) = &self.content_guard {
                let mut withheld = false;
                if let Some(value) = system.as_mut() {
                    if !guard(value) {
                        system = None;
                        withheld = true;
                    }
                }
                for messages in [&mut input, &mut output] {
                    if messages.is_empty() {
                        continue;
                    }
                    let mut value = Value::Array(std::mem::take(messages));
                    if guard(&mut value) {
                        if let Value::Array(kept) = value {
                            *messages = kept;
                        }
                    } else {
                        withheld = true;
                    }
                }
                if withheld {
                    self.span.set_attribute(CONTENT_REDACTED_ATTR, true);
                }
            }
            let content = truncate_span_content(
                system.as_ref(),
                &input,
                &output,
                self.gates.max_content_bytes,
            );
            if let Some(system) = content.system_instructions {
                self.span
                    .set_attribute("gen_ai.system_instructions", system);
            }
            if let Some(input) = content.input_messages {
                self.span.set_attribute("gen_ai.input.messages", input);
            }
            if let Some(output) = content.output_messages {
                self.span.set_attribute("gen_ai.output.messages", output);
            }
            if content.truncated {
                self.span.set_attribute(CONTENT_TRUNCATED_ATTR, true);
            }
        }
        // Replacing the handle drops the last reference the guard holds, which
        // closes the span (the `instrument` clone is gone once the call returned).
        self.span = tracing::Span::none();
    }
}

impl Drop for ModelCallSpan {
    fn drop(&mut self) {
        // Dropped before any outcome was recorded: the caller went away (client
        // disconnect, server timeout, or a deadline) mid-call. Never export
        // that as a normal-looking successful span.
        if !self.finished && !self.outcome_recorded {
            self.record_error(ERROR_CANCELLED);
        }
        self.close();
    }
}

/// An INFO `execute_tool {tool}` span (kind INTERNAL) for a tool the gateway's
/// own tool loop executes; `Span::none()` without the consented exporter.
/// Metadata only: the call's arguments and result reach telemetry as the next
/// model call's (firewall-guarded) input messages.
pub fn execute_tool_span(tool: &str, call_id: &str, tool_type: &str) -> tracing::Span {
    let gates = SpanGates::current();
    if !gates.export {
        return tracing::Span::none();
    }
    let span = tracing::info_span!(
        "execute_tool",
        "otel.name" = %format!("{OPERATION_EXECUTE_TOOL} {tool}"),
        "otel.kind" = "internal",
    );
    for (key, value) in tool_attributes(gates, tool, call_id, tool_type) {
        span.set_attribute(key, value);
    }
    span
}

/// The metadata attributes of a gateway `execute_tool` span.
pub fn tool_attributes(
    gates: SpanGates,
    tool: &str,
    call_id: &str,
    tool_type: &str,
) -> Vec<(Key, OtelValue)> {
    let mut attributes = Vec::new();
    if let Some((server, _)) = tool
        .split_once('.')
        .filter(|(server, _)| !server.is_empty())
    {
        attributes.push((
            Key::from_static_str("ryu.mcp.server.name"),
            server.to_owned().into(),
        ));
    }
    if !gates.gen_ai {
        return attributes;
    }
    attributes.push((
        Key::from_static_str("gen_ai.operation.name"),
        OPERATION_EXECUTE_TOOL.into(),
    ));
    attributes.push((
        Key::from_static_str("gen_ai.tool.name"),
        tool.to_owned().into(),
    ));
    attributes.push((
        Key::from_static_str("gen_ai.tool.type"),
        tool_type.to_owned().into(),
    ));
    if !call_id.is_empty() {
        attributes.push((
            Key::from_static_str("gen_ai.tool.call.id"),
            call_id.to_owned().into(),
        ));
    }
    attributes
}

/// Mark a tool span failed (`error.type = tool_error`) when `result` is an
/// error envelope (`{"error": ..}` or `{"isError": true}`).
pub fn record_tool_result(span: &tracing::Span, result: &Value) {
    if span.is_none() {
        return;
    }
    let failed = result.get("error").is_some_and(|error| !error.is_null())
        || result.get("isError").and_then(Value::as_bool) == Some(true);
    if failed {
        span.set_attribute("error.type", ERROR_TOOL);
        span.set_status(Status::error(ERROR_TOOL));
    }
}

/// `"{operation} {model}"`, or just the operation when the model is unknown.
pub fn span_name(operation: &str, model: &str) -> String {
    if model.is_empty() {
        operation.to_owned()
    } else {
        format!("{operation} {model}")
    }
}

/// Map a Ryu provider id to the GenAI well-known `gen_ai.provider.name` where
/// one exists; any other provider reports its Ryu id.
pub fn gen_ai_provider_name(provider: &str) -> &str {
    match provider {
        "anthropic" | "genai-anthropic" => "anthropic",
        "openai" | "openai-credits" | "genai-openai" | "genai-openai-resp" => "openai",
        "bedrock" | "genai-bedrock-api" => "aws.bedrock",
        "vertex" | "genai-vertex" => "gcp.vertex_ai",
        "genai" | "gemini" => "gcp.gemini",
        "azure" | "azure-openai" => "azure.ai.openai",
        "cohere" | "genai-cohere" => "cohere",
        "deepseek" | "genai-deepseek" => "deepseek",
        "groq" | "genai-groq" => "groq",
        "mistral" => "mistral_ai",
        "xai" | "genai-xai" => "x_ai",
        "perplexity" => "perplexity",
        other => other,
    }
}

fn int(value: u64) -> OtelValue {
    OtelValue::I64(i64::try_from(value).unwrap_or(i64::MAX))
}

fn string_array(values: Vec<String>) -> OtelValue {
    OtelValue::Array(Array::String(
        values.into_iter().map(StringValue::from).collect(),
    ))
}

/// Attributes known before the call. `gen_ai.*` only when opted in.
pub fn request_attributes(
    gates: SpanGates,
    request: &ModelCallRequest<'_>,
) -> Vec<(Key, OtelValue)> {
    let mut attributes: Vec<(Key, OtelValue)> = vec![
        (
            Key::from_static_str("ryu.request.id"),
            request.request_id.to_owned().into(),
        ),
        (
            Key::from_static_str("ryu.provider.id"),
            request.provider.to_owned().into(),
        ),
    ];
    if !gates.gen_ai {
        return attributes;
    }
    let mut push = |key: &'static str, value: OtelValue| {
        attributes.push((Key::from_static_str(key), value));
    };
    push("gen_ai.operation.name", request.operation.to_owned().into());
    push(
        "gen_ai.provider.name",
        gen_ai_provider_name(request.provider).to_owned().into(),
    );
    push("gen_ai.request.model", request.model.to_owned().into());
    push("gen_ai.request.stream", request.stream.into());
    if let Some(output_type) = request.output_type {
        push("gen_ai.output.type", output_type.to_owned().into());
    }
    if let Some(conversation) = request.conversation_id.filter(|id| !id.is_empty()) {
        push("gen_ai.conversation.id", conversation.to_owned().into());
    }
    let Some(body) = request.body else {
        return attributes;
    };
    if let Some(max_tokens) = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .and_then(Value::as_u64)
    {
        push("gen_ai.request.max_tokens", int(max_tokens));
    }
    for (field, key) in [
        ("temperature", "gen_ai.request.temperature"),
        ("top_p", "gen_ai.request.top_p"),
        ("frequency_penalty", "gen_ai.request.frequency_penalty"),
        ("presence_penalty", "gen_ai.request.presence_penalty"),
    ] {
        if let Some(value) = body.get(field).and_then(Value::as_f64) {
            push(key, value.into());
        }
    }
    if let Some(top_k) = body.get("top_k").and_then(Value::as_f64) {
        push("gen_ai.request.top_k", top_k.into());
    }
    if let Some(seed) = body.get("seed").and_then(Value::as_i64) {
        push("gen_ai.request.seed", seed.into());
    }
    if let Some(count) = body.get("n").and_then(Value::as_u64).filter(|n| *n != 1) {
        push("gen_ai.request.choice.count", int(count));
    }
    let stop: Vec<String> = match body.get("stop") {
        Some(Value::String(stop)) => vec![stop.clone()],
        Some(Value::Array(stops)) => stops
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    if !stop.is_empty() {
        push("gen_ai.request.stop_sequences", string_array(stop));
    }
    attributes
}

/// Attributes known once the response (or stream) is complete.
pub fn response_attributes(
    gates: SpanGates,
    response: &ModelCallResponse,
) -> Vec<(Key, OtelValue)> {
    let mut attributes = Vec::new();
    if !gates.gen_ai {
        return attributes;
    }
    let mut push = |key: &'static str, value: OtelValue| {
        attributes.push((Key::from_static_str(key), value));
    };
    if let Some(id) = response.id.as_ref().filter(|id| !id.is_empty()) {
        push("gen_ai.response.id", id.clone().into());
    }
    if let Some(model) = response.model.as_ref().filter(|model| !model.is_empty()) {
        push("gen_ai.response.model", model.clone().into());
    }
    if !response.finish_reasons.is_empty() {
        push(
            "gen_ai.response.finish_reasons",
            string_array(response.finish_reasons.clone()),
        );
    }
    let usage = response.usage;
    for (key, value) in [
        ("gen_ai.usage.input_tokens", usage.input_tokens),
        ("gen_ai.usage.output_tokens", usage.output_tokens),
        (
            "gen_ai.usage.cache_read.input_tokens",
            usage.cache_read_input_tokens,
        ),
        (
            "gen_ai.usage.cache_write.input_tokens",
            usage.cache_write_input_tokens,
        ),
        (
            "gen_ai.usage.reasoning.output_tokens",
            usage.reasoning_output_tokens,
        ),
    ] {
        if let Some(value) = value {
            push(key, int(value));
        }
    }
    attributes
}

// ─── OpenAI-shape → GenAI message conversion ─────────────────────────────────

/// Text of an OpenAI `content` value: a string, or the text parts of an array.
fn content_parts(content: &Value) -> Vec<Value> {
    match content {
        Value::String(text) if !text.is_empty() => vec![text_part(text)],
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| match part["type"].as_str() {
                Some("text" | "input_text" | "output_text") => part["text"].as_str().map(text_part),
                // Remote media is referenced by URI; inline (`data:`) payloads
                // are never copied into telemetry.
                Some("image_url") => part["image_url"]["url"]
                    .as_str()
                    .or_else(|| part["image_url"].as_str())
                    .filter(|url| url.starts_with("http://") || url.starts_with("https://"))
                    .map(
                        |url| serde_json::json!({ "type": "uri", "modality": "image", "uri": url }),
                    ),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Tool-call arguments: JSON when the string parses, else the raw string.
fn tool_arguments(arguments: &Value) -> Value {
    match arguments {
        Value::String(raw) => serde_json::from_str(raw).unwrap_or_else(|_| raw.clone().into()),
        other => other.clone(),
    }
}

fn tool_call_parts(tool_calls: &Value) -> Vec<Value> {
    tool_calls
        .as_array()
        .into_iter()
        .flatten()
        .map(|call| {
            tool_call_part(
                call["id"].as_str().unwrap_or_default(),
                call["function"]["name"].as_str().unwrap_or_default(),
                tool_arguments(&call["function"]["arguments"]),
            )
        })
        .collect()
}

fn reasoning_text(message: &Value) -> Option<&str> {
    message["reasoning_content"]
        .as_str()
        .or_else(|| message["reasoning"].as_str())
        .filter(|text| !text.is_empty())
}

/// Split an OpenAI chat request body into GenAI `system_instructions` (a JSON
/// array of parts) and input messages.
pub fn input_content(body: &Value) -> (Option<Value>, Vec<Value>) {
    let mut system = match &body["system"] {
        Value::Null => Vec::new(),
        other => content_parts(other),
    };
    let mut messages = Vec::new();
    for message in body["messages"].as_array().into_iter().flatten() {
        let role = message["role"].as_str().unwrap_or("user");
        match role {
            "system" | "developer" => system.extend(content_parts(&message["content"])),
            "tool" => {
                let response = match &message["content"] {
                    Value::Array(_) => Value::String(
                        content_parts(&message["content"])
                            .iter()
                            .filter_map(|part| part["content"].as_str())
                            .collect::<Vec<_>>()
                            .join(""),
                    ),
                    other => other.clone(),
                };
                messages.push(gen_ai_message(
                    "tool",
                    vec![tool_call_response_part(
                        message["tool_call_id"].as_str().unwrap_or_default(),
                        response,
                    )],
                ));
            }
            _ => {
                let mut parts = Vec::new();
                if let Some(reasoning) = reasoning_text(message) {
                    parts.push(reasoning_part(reasoning));
                }
                parts.extend(content_parts(&message["content"]));
                parts.extend(tool_call_parts(&message["tool_calls"]));
                messages.push(gen_ai_message(role, parts));
            }
        }
    }
    // Media / embedding routes carry a bare prompt instead of messages.
    if messages.is_empty() {
        if let Some(text) = ["prompt", "input"]
            .iter()
            .find_map(|key| body[*key].as_str())
            .filter(|text| !text.is_empty())
        {
            messages.push(gen_ai_message("user", vec![text_part(text)]));
        }
    }
    let system = (!system.is_empty()).then_some(Value::Array(system));
    (system, messages)
}

fn usage_u64(usage: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter().find_map(|key| usage[*key].as_u64())
}

/// Response metadata from a buffered OpenAI chat completion. Output messages
/// are converted only when `collect_content`.
pub fn chat_response(response: &Value, collect_content: bool) -> ModelCallResponse {
    let choices = response["choices"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let finish_reasons = choices
        .iter()
        .filter_map(|choice| choice["finish_reason"].as_str())
        .map(str::to_owned)
        .collect();
    let output_messages = if collect_content {
        choices
            .iter()
            .map(|choice| {
                let message = &choice["message"];
                let mut parts = Vec::new();
                if let Some(reasoning) = reasoning_text(message) {
                    parts.push(reasoning_part(reasoning));
                }
                parts.extend(content_parts(&message["content"]));
                parts.extend(tool_call_parts(&message["tool_calls"]));
                gen_ai_output_message(parts, choice["finish_reason"].as_str().unwrap_or(""))
            })
            .collect()
    } else {
        Vec::new()
    };
    let usage = &response["usage"];
    ModelCallResponse {
        id: response["id"].as_str().map(str::to_owned),
        model: response["model"].as_str().map(str::to_owned),
        finish_reasons,
        usage: ModelCallUsage {
            input_tokens: usage_u64(usage, &["prompt_tokens", "input_tokens"]),
            output_tokens: usage_u64(usage, &["completion_tokens", "output_tokens"]),
            reasoning_output_tokens: usage["completion_tokens_details"]["reasoning_tokens"]
                .as_u64(),
            ..ModelCallUsage::default()
        },
        output_messages,
    }
}

/// Usage of a non-chat response (embeddings, media): only counts the provider
/// actually reported; absent counts stay `None`.
pub fn reported_usage(response: &Value) -> ModelCallUsage {
    let usage = &response["usage"];
    ModelCallUsage {
        input_tokens: usage_u64(usage, &["prompt_tokens", "input_tokens"]),
        output_tokens: usage_u64(usage, &["completion_tokens", "output_tokens"]),
        ..ModelCallUsage::default()
    }
}

#[derive(Default)]
struct StreamToolCall {
    id: String,
    name: String,
    arguments: String,
}

/// Response metadata from an assembled OpenAI SSE stream. Output text,
/// reasoning and tool calls are assembled only when `collect_content`.
pub fn stream_response(sse: &str, collect_content: bool) -> ModelCallResponse {
    let mut response = ModelCallResponse::default();
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut tool_calls: Vec<StreamToolCall> = Vec::new();
    for line in sse.lines() {
        let Some(data) = line.strip_prefix("data:").map(str::trim) else {
            continue;
        };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if response.id.is_none() {
            response.id = chunk["id"]
                .as_str()
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
        }
        if response.model.is_none() {
            response.model = chunk["model"]
                .as_str()
                .filter(|model| !model.is_empty())
                .map(str::to_owned);
        }
        if let Some(tokens) =
            chunk["usage"]["completion_tokens_details"]["reasoning_tokens"].as_u64()
        {
            response.usage.reasoning_output_tokens = Some(tokens);
        }
        for choice in chunk["choices"].as_array().into_iter().flatten() {
            if let Some(reason) = choice["finish_reason"].as_str() {
                response.finish_reasons.push(reason.to_owned());
            }
            if !collect_content {
                continue;
            }
            let delta = &choice["delta"];
            if let Some(content) = delta["content"].as_str() {
                text.push_str(content);
            }
            if let Some(thinking) = reasoning_text(delta) {
                reasoning.push_str(thinking);
            }
            for call in delta["tool_calls"].as_array().into_iter().flatten() {
                // The index is upstream data: bound it before it sizes the Vec.
                let index = match call["index"].as_u64() {
                    None => tool_calls.len(),
                    Some(index) => match usize::try_from(index) {
                        Ok(index) => index,
                        Err(_) => continue,
                    },
                };
                if index >= MAX_STREAM_TOOL_CALLS {
                    continue;
                }
                if tool_calls.len() <= index {
                    tool_calls.resize_with(index + 1, StreamToolCall::default);
                }
                let slot = &mut tool_calls[index];
                if let Some(id) = call["id"].as_str() {
                    slot.id = id.to_owned();
                }
                if let Some(name) = call["function"]["name"].as_str() {
                    slot.name.push_str(name);
                }
                if let Some(arguments) = call["function"]["arguments"].as_str() {
                    slot.arguments.push_str(arguments);
                }
            }
        }
    }
    if collect_content {
        let mut parts = Vec::new();
        if !reasoning.is_empty() {
            parts.push(reasoning_part(&reasoning));
        }
        if !text.is_empty() {
            parts.push(text_part(&text));
        }
        for call in tool_calls {
            parts.push(tool_call_part(
                &call.id,
                &call.name,
                tool_arguments(&Value::String(call.arguments)),
            ));
        }
        if !parts.is_empty() {
            let finish = response.finish_reasons.last().cloned().unwrap_or_default();
            response.output_messages = vec![gen_ai_output_message(parts, &finish)];
        }
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::{SpanKind, Status, TraceContextExt as _, TracerProvider as _};
    use opentelemetry_sdk::error::OTelSdkResult;
    use opentelemetry_sdk::trace::{SdkTracerProvider, SpanData, SpanExporter};
    use serde_json::json;
    use std::sync::Mutex;
    use tracing_subscriber::layer::SubscriberExt as _;

    #[derive(Debug, Clone, Default)]
    struct Captured(Arc<Mutex<Vec<SpanData>>>);

    impl SpanExporter for Captured {
        fn export(
            &self,
            batch: Vec<SpanData>,
        ) -> impl std::future::Future<Output = OTelSdkResult> + Send {
            self.0.lock().unwrap().extend(batch);
            std::future::ready(Ok(()))
        }
    }

    /// Run `body` under a registry + OTel layer and return the exported spans.
    fn capture(body: impl FnOnce()) -> Vec<SpanData> {
        let exporter = Captured::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("test")));
        tracing::subscriber::with_default(subscriber, body);
        provider.force_flush().unwrap();
        let spans = exporter.0.lock().unwrap().clone();
        spans
    }

    fn attr<'a>(span: &'a SpanData, key: &str) -> Option<&'a OtelValue> {
        span.attributes
            .iter()
            .find(|kv| kv.key.as_str() == key)
            .map(|kv| &kv.value)
    }

    fn open(content: bool) -> SpanGates {
        SpanGates {
            export: true,
            gen_ai: true,
            content,
            max_content_bytes: 750_000,
        }
    }

    fn request<'a>(body: &'a Value) -> ModelCallRequest<'a> {
        ModelCallRequest {
            operation: OPERATION_CHAT,
            provider: "anthropic",
            model: "claude-opus-5-5",
            body: Some(body),
            stream: false,
            output_type: Some("text"),
            request_id: "req-1",
            conversation_id: Some("sess-1"),
        }
    }

    #[test]
    fn span_name_and_provider_mapping() {
        assert_eq!(span_name("chat", "claude-opus-5-5"), "chat claude-opus-5-5");
        assert_eq!(span_name("embeddings", ""), "embeddings");
        assert_eq!(gen_ai_provider_name("genai-anthropic"), "anthropic");
        assert_eq!(gen_ai_provider_name("openai-credits"), "openai");
        assert_eq!(gen_ai_provider_name("bedrock"), "aws.bedrock");
        assert_eq!(gen_ai_provider_name("genai-vertex"), "gcp.vertex_ai");
        assert_eq!(gen_ai_provider_name("genai"), "gcp.gemini");
        assert_eq!(gen_ai_provider_name("azure"), "azure.ai.openai");
        assert_eq!(gen_ai_provider_name("mistral"), "mistral_ai");
        assert_eq!(gen_ai_provider_name("openrouter"), "openrouter");
    }

    #[test]
    fn request_attributes_follow_the_gen_ai_gate() {
        let body = json!({
            "max_tokens": 64, "temperature": 0.2, "top_p": 0.9, "top_k": 40,
            "stop": ["END", "STOP"], "seed": 7,
        });
        let attributes = request_attributes(open(false), &request(&body));
        let get = |key: &str| {
            attributes
                .iter()
                .find(|(k, _)| k.as_str() == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("gen_ai.operation.name"), Some("chat".into()));
        assert_eq!(get("gen_ai.provider.name"), Some("anthropic".into()));
        assert_eq!(get("gen_ai.request.max_tokens"), Some(OtelValue::I64(64)));
        assert_eq!(get("gen_ai.request.temperature"), Some(OtelValue::F64(0.2)));
        assert_eq!(get("gen_ai.request.top_k"), Some(OtelValue::F64(40.0)));
        assert_eq!(get("gen_ai.request.stream"), Some(OtelValue::Bool(false)));
        assert_eq!(get("gen_ai.conversation.id"), Some("sess-1".into()));
        assert_eq!(
            get("gen_ai.request.stop_sequences"),
            Some(string_array(vec!["END".into(), "STOP".into()]))
        );
        assert_eq!(get("ryu.request.id"), Some("req-1".into()));

        // Without the semconv opt-in only the stable ryu.* names remain.
        let gated = SpanGates {
            gen_ai: false,
            ..open(false)
        };
        let attributes = request_attributes(gated, &request(&body));
        assert!(attributes
            .iter()
            .all(|(key, _)| !key.as_str().starts_with("gen_ai.")));
    }

    #[test]
    fn input_and_output_convert_to_gen_ai_messages() {
        let body = json!({"messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": [
                {"type": "text", "text": "hi"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ]},
            {"role": "assistant", "content": null, "tool_calls": [
                {"id": "call_1", "type": "function",
                 "function": {"name": "lookup", "arguments": "{\"q\":1}"}},
            ]},
            {"role": "tool", "tool_call_id": "call_1", "content": "42"},
        ]});
        let (system, messages) = input_content(&body);
        assert_eq!(
            system,
            Some(json!([{"type": "text", "content": "be brief"}]))
        );
        assert_eq!(
            messages,
            vec![
                json!({"role": "user", "parts": [{"type": "text", "content": "hi"}]}),
                json!({"role": "assistant", "parts": [
                    {"type": "tool_call", "id": "call_1", "name": "lookup", "arguments": {"q": 1}},
                ]}),
                json!({"role": "tool", "parts": [
                    {"type": "tool_call_response", "id": "call_1", "response": "42"},
                ]}),
            ]
        );

        let response = json!({
            "id": "chatcmpl-1", "model": "claude-opus-5-5-20261001",
            "choices": [{"finish_reason": "stop",
                         "message": {"role": "assistant", "content": "hello",
                                     "reasoning_content": "think"}}],
            "usage": {"prompt_tokens": 10, "completion_tokens": 3,
                      "completion_tokens_details": {"reasoning_tokens": 2}},
        });
        let parsed = chat_response(&response, true);
        assert_eq!(parsed.id.as_deref(), Some("chatcmpl-1"));
        assert_eq!(parsed.finish_reasons, vec!["stop"]);
        assert_eq!(parsed.usage.input_tokens, Some(10));
        assert_eq!(parsed.usage.reasoning_output_tokens, Some(2));
        assert_eq!(
            parsed.output_messages,
            vec![
                json!({"role": "assistant", "finish_reason": "stop", "parts": [
                    {"type": "reasoning", "content": "think"},
                    {"type": "text", "content": "hello"},
                ]})
            ]
        );
        assert!(chat_response(&response, false).output_messages.is_empty());
    }

    #[test]
    fn stream_assembles_text_tool_calls_and_metadata() {
        let sse = [
            json!({"id": "c1", "model": "m", "choices": [{"delta": {"content": "Hel"}}]}),
            json!({"id": "c1", "choices": [{"delta": {"content": "lo", "tool_calls": [
                {"index": 0, "id": "t1", "function": {"name": "f", "arguments": "{\"a\""}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": ":1}"}}]}, "finish_reason": "tool_calls"}]}),
            json!({"choices": [], "usage": {"completion_tokens_details": {"reasoning_tokens": 5}}}),
        ]
        .iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect::<String>()
            + "data: [DONE]\n\n";
        let parsed = stream_response(&sse, true);
        assert_eq!(parsed.id.as_deref(), Some("c1"));
        assert_eq!(parsed.model.as_deref(), Some("m"));
        assert_eq!(parsed.finish_reasons, vec!["tool_calls"]);
        assert_eq!(parsed.usage.reasoning_output_tokens, Some(5));
        assert_eq!(
            parsed.output_messages,
            vec![
                json!({"role": "assistant", "finish_reason": "tool_calls", "parts": [
                    {"type": "text", "content": "Hello"},
                    {"type": "tool_call", "id": "t1", "name": "f", "arguments": {"a": 1}},
                ]})
            ]
        );
        assert!(stream_response(&sse, false).output_messages.is_empty());
    }

    #[test]
    fn model_call_span_nests_and_carries_attributes() {
        crate::telemetry::install_propagator();
        let body = json!({"messages": [{"role": "user", "content": "hi"}], "max_tokens": 8});
        let spans = capture(|| {
            let parent = tracing::info_span!("http.server.request");
            let _entered = parent.enter();
            let mut call = ModelCallSpan::start_with(open(true), request(&body));
            // The outbound scope carries this span's traceparent.
            let span_id = call.span.context().span().span_context().span_id();
            let headers = call.outbound.as_ref().unwrap().headers();
            assert!(headers
                .iter()
                .any(|(key, value)| key == "traceparent" && value.contains(&span_id.to_string())));
            call.record_response(chat_response(
                &json!({"id": "r1", "model": "m-1",
                        "choices": [{"finish_reason": "stop",
                                     "message": {"content": "yo"}}],
                        "usage": {"prompt_tokens": 4, "completion_tokens": 1}}),
                true,
            ));
            call.finish();
        });
        let model = spans
            .iter()
            .find(|span| span.name == "chat claude-opus-5-5")
            .expect("model-call span exported");
        let server = spans
            .iter()
            .find(|span| span.name == "http.server.request")
            .expect("parent exported");
        assert_eq!(model.span_kind, SpanKind::Client);
        assert_eq!(model.parent_span_id, server.span_context.span_id());
        assert_eq!(
            model.span_context.trace_id(),
            server.span_context.trace_id()
        );
        assert_eq!(attr(model, "gen_ai.response.id"), Some(&"r1".into()));
        assert_eq!(
            attr(model, "gen_ai.usage.input_tokens"),
            Some(&OtelValue::I64(4))
        );
        assert_eq!(
            attr(model, "gen_ai.response.finish_reasons"),
            Some(&string_array(vec!["stop".into()]))
        );
        let input = attr(model, "gen_ai.input.messages").unwrap().as_str();
        assert!(input.contains("\"hi\""));
        let output = attr(model, "gen_ai.output.messages").unwrap().as_str();
        assert!(output.contains("\"yo\""));
        assert!(attr(model, CONTENT_TRUNCATED_ATTR).is_none());
        assert_eq!(model.status, Status::Unset);
    }

    #[test]
    fn usage_uses_semconv_cache_write_name() {
        let response = ModelCallResponse {
            usage: ModelCallUsage {
                cache_read_input_tokens: Some(3),
                cache_write_input_tokens: Some(9),
                ..ModelCallUsage::default()
            },
            ..ModelCallResponse::default()
        };
        let attributes = response_attributes(open(false), &response);
        let get = |key: &str| {
            attributes
                .iter()
                .find(|(k, _)| k.as_str() == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(
            get("gen_ai.usage.cache_write.input_tokens"),
            Some(OtelValue::I64(9))
        );
        assert_eq!(
            get("gen_ai.usage.cache_read.input_tokens"),
            Some(OtelValue::I64(3))
        );
        assert!(get("gen_ai.usage.cache_creation.input_tokens").is_none());
    }

    #[test]
    fn stream_ignores_out_of_range_tool_call_indices() {
        let sse = [
            json!({"choices": [{"delta": {"tool_calls": [
                {"index": 4_000_000_000_u64, "id": "big", "function": {"name": "x"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [
                {"index": u64::MAX, "id": "max", "function": {"name": "y"}}]}}]}),
            json!({"choices": [{"delta": {"tool_calls": [
                {"index": 0, "id": "ok", "function": {"name": "f", "arguments": "{}"}}]},
                "finish_reason": "tool_calls"}]}),
        ]
        .iter()
        .map(|chunk| format!("data: {chunk}\n\n"))
        .collect::<String>();
        let parsed = stream_response(&sse, true);
        assert_eq!(
            parsed.output_messages,
            vec![
                json!({"role": "assistant", "finish_reason": "tool_calls", "parts": [
                    {"type": "tool_call", "id": "ok", "name": "f", "arguments": {}},
                ]})
            ]
        );
    }

    #[test]
    fn dropped_span_without_outcome_is_cancelled() {
        let body = json!({"messages": []});
        let spans = capture(|| {
            let call = ModelCallSpan::start_with(open(false), request(&body));
            drop(call);
        });
        assert_eq!(spans.len(), 1);
        assert_eq!(attr(&spans[0], "error.type"), Some(&"cancelled".into()));
        assert!(matches!(spans[0].status, Status::Error { .. }));
    }

    #[test]
    fn content_guard_redacts_and_withholds_content() {
        let body = json!({"messages": [{"role": "user", "content": "my secret"}]});
        let spans = capture(|| {
            let mut call = ModelCallSpan::start_with(open(true), request(&body));
            // Sanitize everything except a blocked completion.
            call.set_content_guard(Arc::new(|value: &mut Value| {
                let text = value.to_string();
                if text.contains("leaked") {
                    return false;
                }
                *value = serde_json::from_str(&text.replace("secret", "[REDACTED]")).unwrap();
                true
            }));
            call.record_response(chat_response(
                &json!({"choices": [{"finish_reason": "stop",
                                     "message": {"content": "leaked key"}}]}),
                true,
            ));
            call.finish();
        });
        let model = &spans[0];
        let input = attr(model, "gen_ai.input.messages").unwrap().as_str();
        assert!(input.contains("[REDACTED]"));
        assert!(!input.contains("secret"));
        assert!(attr(model, "gen_ai.output.messages").is_none());
        assert_eq!(
            attr(model, CONTENT_REDACTED_ATTR),
            Some(&OtelValue::Bool(true))
        );
    }

    #[test]
    fn tool_spans_carry_metadata_and_errors() {
        let attributes = tool_attributes(open(false), "github.search", "call_1", "extension");
        let get = |key: &str| {
            attributes
                .iter()
                .find(|(k, _)| k.as_str() == key)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("gen_ai.operation.name"), Some("execute_tool".into()));
        assert_eq!(get("gen_ai.tool.name"), Some("github.search".into()));
        assert_eq!(get("gen_ai.tool.call.id"), Some("call_1".into()));
        assert_eq!(get("ryu.mcp.server.name"), Some("github".into()));
        let spans = capture(|| {
            let span = tracing::info_span!("execute_tool", "otel.name" = "execute_tool t");
            record_tool_result(&span, &json!({"error": "denied"}));
            let ok = tracing::info_span!("execute_tool", "otel.name" = "execute_tool ok");
            record_tool_result(&ok, &json!({"content": []}));
        });
        let failed = spans.iter().find(|s| s.name == "execute_tool t").unwrap();
        assert_eq!(attr(failed, "error.type"), Some(&"tool_error".into()));
        let ok = spans.iter().find(|s| s.name == "execute_tool ok").unwrap();
        assert!(attr(ok, "error.type").is_none());
    }

    #[test]
    fn errors_truncation_and_disabled_gates() {
        let body = json!({"messages": [
            {"role": "system", "content": "s".repeat(500)},
            {"role": "user", "content": "short"},
        ]});
        let spans = capture(|| {
            let gates = SpanGates {
                max_content_bytes: 200,
                ..open(true)
            };
            let mut call = ModelCallSpan::start_with(gates, request(&body));
            call.record_first_chunk();
            call.record_error("provider_error");
            drop(call);
            // Export off → nothing is created or exported.
            let mut off = ModelCallSpan::start_with(SpanGates::closed(), request(&body));
            assert!(!off.is_recording());
            off.record_error("ignored");
            // Metadata-only → no content attributes even with export on.
            ModelCallSpan::start_with(open(false), request(&body)).finish();
        });
        assert_eq!(spans.len(), 2);
        let failed = &spans[0];
        assert_eq!(attr(failed, "error.type"), Some(&"provider_error".into()));
        assert!(matches!(failed.status, Status::Error { .. }));
        assert!(attr(failed, "gen_ai.response.time_to_first_chunk").is_some());
        assert_eq!(
            attr(failed, CONTENT_TRUNCATED_ATTR),
            Some(&OtelValue::Bool(true))
        );
        assert!(attr(failed, "gen_ai.system_instructions").is_none());
        assert!(attr(failed, "gen_ai.input.messages").is_some());
        let metadata_only = &spans[1];
        assert!(attr(metadata_only, "gen_ai.input.messages").is_none());
        assert!(attr(metadata_only, "gen_ai.request.model").is_some());
    }
}
