//! OTel GenAI agent-turn and tool-execution spans for Core.
//!
//! - `invoke_agent {agent}` wraps one native agent turn (the governed chat loop);
//!   the Gateway's model-call spans and Core's tool spans nest under it.
//! - `execute_tool {tool}` wraps each tool call the agent requests.
//! - `tools/call {tool}` wraps the registry dispatch every plane (chat, ACP, PTC,
//!   workflows) reaches, following the OTel MCP conventions; MCP requests made
//!   inside it carry its `traceparent` in `params._meta`.
//!
//! Attributes are written straight onto the OTel span
//! (`OpenTelemetrySpanExt::set_attribute`), not as `tracing` fields, so they never
//! reach the local fmt log; only `otel.name`/`otel.kind` are fields. Every
//! constructor returns `Span::none()` unless diagnostics export consent is on, so
//! the off path is one atomic load and nothing is built. Tool arguments/results
//! are added only in content mode (`telemetry::content_enabled()`, which is
//! itself false without consent), capped per span by
//! `telemetry::max_content_bytes()`.

use std::pin::Pin;
use std::task::{Context, Poll};

use futures_util::Stream;
use opentelemetry::trace::Status;
use opentelemetry::KeyValue;
#[cfg(test)]
use opentelemetry::Value as OtelValue;
use serde_json::Value;
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

use crate::telemetry::content::{truncate_tool_content, CONTENT_TRUNCATED_ATTR};

/// `gen_ai.operation.name` of an agent turn.
pub const INVOKE_AGENT: &str = "invoke_agent";
/// `gen_ai.operation.name` of a tool call.
pub const EXECUTE_TOOL: &str = "execute_tool";
/// `error.type` of a failed tool call.
pub const TOOL_ERROR: &str = "tool_error";
/// The id/name used for the default agent when a turn names none.
pub const DEFAULT_AGENT: &str = "ryu";

/// `gen_ai.tool.type`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolType {
    /// A function the client/model declared (browser client tools).
    Function,
    /// A tool served by an MCP server or app extension.
    Extension,
    /// A retrieval tool over a local store.
    Datastore,
}

impl ToolType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Extension => "extension",
            Self::Datastore => "datastore",
        }
    }
}

/// Identity of one agent turn.
#[derive(Debug, Clone, Copy, Default)]
pub struct AgentTurn<'a> {
    pub agent_id: Option<&'a str>,
    pub agent_name: Option<&'a str>,
    /// The conversation (thread) id → `gen_ai.conversation.id`.
    pub conversation_id: Option<&'a str>,
    /// Ryu's session id → `ryu.session.id` (the conversation id when absent).
    pub session_id: Option<&'a str>,
    pub request_model: Option<&'a str>,
}

/// Identity of one tool call.
#[derive(Debug, Clone, Copy)]
pub struct ToolCall<'a> {
    pub name: &'a str,
    pub call_id: Option<&'a str>,
    pub tool_type: ToolType,
    pub description: Option<&'a str>,
    pub mcp_server: Option<&'a str>,
}

impl<'a> ToolCall<'a> {
    /// A registry tool id (`<server>.<tool>`): an MCP extension tool whose
    /// server is the id's prefix; the conversation-search store is a datastore.
    pub fn registry(tool_id: &'a str, call_id: Option<&'a str>) -> Self {
        let mcp_server = mcp_server_of(tool_id);
        let tool_type =
            if mcp_server == Some(crate::sidecar::mcp::search_conversations::SERVER_NAME) {
                ToolType::Datastore
            } else {
                ToolType::Extension
            };
        Self {
            name: tool_id,
            call_id,
            tool_type,
            description: None,
            mcp_server,
        }
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.trim().is_empty())
}

/// The MCP server of a registry tool id (`<server>.<tool>` → `server`).
pub fn mcp_server_of(tool_id: &str) -> Option<&str> {
    tool_id
        .split_once('.')
        .map(|(server, _)| server)
        .filter(|server| !server.is_empty())
}

/// `invoke_agent {agent}`.
pub fn invoke_agent_span_name(agent_name: &str) -> String {
    format!("{INVOKE_AGENT} {agent_name}")
}

/// `execute_tool {tool}`.
pub fn execute_tool_span_name(tool: &str) -> String {
    format!("{EXECUTE_TOOL} {tool}")
}

/// `tools/call {tool}` (OTel MCP convention: `{mcp.method.name} {target}`).
pub fn mcp_tools_call_span_name(tool: &str) -> String {
    format!("tools/call {tool}")
}

fn agent_name<'a>(turn: &AgentTurn<'a>) -> &'a str {
    non_empty(turn.agent_name)
        .or(non_empty(turn.agent_id))
        .unwrap_or(DEFAULT_AGENT)
}

/// The metadata attributes of an agent turn span.
pub fn agent_attributes(turn: &AgentTurn<'_>) -> Vec<KeyValue> {
    let name = agent_name(turn);
    let mut attributes = vec![
        KeyValue::new("gen_ai.operation.name", INVOKE_AGENT),
        KeyValue::new(
            "gen_ai.agent.id",
            non_empty(turn.agent_id).unwrap_or(name).to_owned(),
        ),
        KeyValue::new("gen_ai.agent.name", name.to_owned()),
    ];
    if let Some(conversation) = non_empty(turn.conversation_id) {
        attributes.push(KeyValue::new(
            "gen_ai.conversation.id",
            conversation.to_owned(),
        ));
    }
    if let Some(session) = non_empty(turn.session_id).or(non_empty(turn.conversation_id)) {
        attributes.push(KeyValue::new("ryu.session.id", session.to_owned()));
    }
    if let Some(model) = non_empty(turn.request_model) {
        attributes.push(KeyValue::new("gen_ai.request.model", model.to_owned()));
    }
    attributes
}

/// The metadata attributes of a tool span.
pub fn tool_attributes(call: &ToolCall<'_>) -> Vec<KeyValue> {
    let mut attributes = vec![
        KeyValue::new("gen_ai.operation.name", EXECUTE_TOOL),
        KeyValue::new("gen_ai.tool.name", call.name.to_owned()),
        KeyValue::new("gen_ai.tool.type", call.tool_type.as_str()),
    ];
    if let Some(id) = non_empty(call.call_id) {
        attributes.push(KeyValue::new("gen_ai.tool.call.id", id.to_owned()));
    }
    if let Some(description) = non_empty(call.description) {
        attributes.push(KeyValue::new(
            "gen_ai.tool.description",
            description.to_owned(),
        ));
    }
    if let Some(server) = non_empty(call.mcp_server) {
        attributes.push(KeyValue::new("ryu.mcp.server.name", server.to_owned()));
    }
    attributes
}

fn set_attributes(span: &Span, attributes: Vec<KeyValue>) {
    for attribute in attributes {
        span.set_attribute(attribute.key, attribute.value);
    }
}

/// An INFO `invoke_agent {agent}` span for one turn (`Span::none()` without
/// export consent). The caller keeps it alive for the whole turn — e.g. with
/// [`instrument_stream`] — so its duration is the turn's.
pub fn invoke_agent_span(turn: &AgentTurn<'_>) -> Span {
    if !crate::telemetry::is_export_consented() {
        return Span::none();
    }
    let span = tracing::info_span!(
        "invoke_agent",
        otel.name = %invoke_agent_span_name(agent_name(turn)),
        otel.kind = "internal",
    );
    set_attributes(&span, agent_attributes(turn));
    span
}

/// Mark an agent turn failed (`error.type` + ERROR status). The error text is
/// never exported; `error_type` is a short class such as an HTTP status code.
pub fn record_agent_error(span: &Span, error_type: &str) {
    span.set_attribute("error.type", error_type.to_owned());
    span.set_status(Status::error(error_type.to_owned()));
}

/// One tool span plus the content budget left after the arguments.
pub struct ToolSpan {
    pub span: Span,
    content_budget: usize,
}

impl ToolSpan {
    fn new(span: Span, arguments: Option<&Value>) -> Self {
        let mut tool = Self {
            span,
            content_budget: crate::telemetry::max_content_bytes(),
        };
        if let Some(arguments) = arguments {
            if !tool.span.is_none() && crate::telemetry::content_enabled() {
                let text = serde_json::to_string(arguments).unwrap_or_default();
                tool.record_content("gen_ai.tool.call.arguments", &text);
            }
        }
        tool
    }

    fn record_content(&mut self, key: &'static str, text: &str) {
        // Tool payloads never pass the Gateway's inbound firewall before they
        // are recorded here, so apply Core's export redaction (credentials,
        // keys, PII patterns) before anything is attached to the span.
        let redacted = redact_tool_content(text);
        let (kept, truncated) = truncate_tool_content(&redacted, self.content_budget);
        self.content_budget = self.content_budget.saturating_sub(kept.len());
        self.span.set_attribute(key, kept);
        if truncated {
            self.span.set_attribute(CONTENT_TRUNCATED_ATTR, true);
        }
    }

    /// Record the outcome. `Err` (or an `{"isError": true}` result) marks the
    /// span `error.type = tool_error`; in content mode the result is attached,
    /// cut from the end to fit the remaining per-span budget.
    pub fn record_result(mut self, result: Result<&Value, &str>) {
        if self.span.is_none() {
            return;
        }
        let failed = match result {
            Ok(value) => is_error_result(value),
            Err(_) => true,
        };
        if failed {
            record_tool_error(&self.span);
        }
        if crate::telemetry::content_enabled() {
            let text = match result {
                Ok(Value::String(text)) => text.clone(),
                Ok(value) => value.to_string(),
                Err(message) => message.to_owned(),
            };
            self.record_content("gen_ai.tool.call.result", &text);
        }
    }
}

/// Core's locked export redaction applied to tool content before it is
/// exported: recognized secrets and PII become `[REDACTED:<KIND>]`.
pub fn redact_tool_content(text: &str) -> String {
    let mut counts = crate::server::conversation_history::redaction::RedactionCounts::default();
    crate::server::conversation_history::redaction::redact_text(text, &mut counts)
}

/// The `description` of tool `name` in an OpenAI `tools[]` array offered to
/// the model (`gen_ai.tool.description`).
pub fn tool_description<'a>(tools: &'a [Value], name: &str) -> Option<&'a str> {
    tools
        .iter()
        .map(|tool| &tool["function"])
        .find(|function| function["name"].as_str() == Some(name))
        .and_then(|function| function["description"].as_str())
        .filter(|description| !description.trim().is_empty())
}

/// Whether a tool result value reports failure (`{"isError": true}`).
pub fn is_error_result(value: &Value) -> bool {
    value.get("isError").and_then(Value::as_bool) == Some(true)
}

fn record_tool_error(span: &Span) {
    span.set_attribute("error.type", TOOL_ERROR);
    span.set_status(Status::error(TOOL_ERROR));
}

/// An INFO `execute_tool {tool}` span for one agent-requested tool call.
/// `arguments` are attached only in content mode.
pub fn execute_tool_span(call: &ToolCall<'_>, arguments: Option<&Value>) -> ToolSpan {
    if !crate::telemetry::is_export_consented() {
        return ToolSpan::new(Span::none(), None);
    }
    let span = tracing::info_span!(
        "execute_tool",
        otel.name = %execute_tool_span_name(call.name),
        otel.kind = "internal",
    );
    set_attributes(&span, tool_attributes(call));
    ToolSpan::new(span, arguments)
}

/// An INFO `tools/call {tool}` span around the registry dispatch. MCP requests
/// issued while it is current carry its `traceparent` in `params._meta`.
pub fn mcp_tools_call_span(tool_id: &str) -> Span {
    if !crate::telemetry::is_export_consented() {
        return Span::none();
    }
    let span = tracing::info_span!(
        "mcp.tools_call",
        otel.name = %mcp_tools_call_span_name(tool_id),
        otel.kind = "internal",
    );
    let mut attributes = tool_attributes(&ToolCall::registry(tool_id, None));
    attributes.push(KeyValue::new("mcp.method.name", "tools/call"));
    set_attributes(&span, attributes);
    span
}

/// Record a registry dispatch outcome on a [`mcp_tools_call_span`]: `None`
/// (the dispatch failed) or an `{"isError": true}` result is a `tool_error`.
pub fn record_dispatch_result(span: &Span, result: Option<&Value>) {
    if span.is_none() {
        return;
    }
    if result.is_none_or(is_error_result) {
        record_tool_error(span);
    }
}

/// Merge the current span's W3C trace-context fields into an MCP request's
/// `params._meta` (`traceparent`/`tracestate`). A key the caller already set is
/// kept, so a forwarded frame stays under its originator. Non-object params, or
/// no fields (no exportable context — consent off), leave `params` unchanged.
pub fn with_trace_context_meta(mut params: Value, fields: &[(String, String)]) -> Value {
    if fields.is_empty() {
        return params;
    }
    let Some(object) = params.as_object_mut() else {
        return params;
    };
    let meta = object
        .entry("_meta")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if let Some(meta) = meta.as_object_mut() {
        for (key, value) in fields {
            meta.entry(key.clone())
                .or_insert_with(|| Value::String(value.clone()));
        }
    }
    params
}

/// Keep `span` current while `stream` is polled (each poll only — never across
/// an await) and alive until the stream is dropped, so the span's duration is
/// the stream's and spans created inside it are its children.
pub fn instrument_stream<S>(stream: S, span: Span) -> impl Stream<Item = S::Item>
where
    S: Stream,
{
    InstrumentedStream {
        inner: Box::pin(stream),
        span,
    }
}

struct InstrumentedStream<S> {
    inner: Pin<Box<S>>,
    span: Span,
}

impl<S: Stream> Stream for InstrumentedStream<S> {
    type Item = S::Item;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        let this = self.get_mut();
        let _entered = this.span.enter();
        this.inner.as_mut().poll_next(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_sdk::error::OTelSdkResult;
    use opentelemetry_sdk::trace::{SdkTracerProvider, SpanData, SpanExporter};
    use serde_json::json;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::layer::SubscriberExt as _;

    fn attribute<'a>(attributes: &'a [KeyValue], key: &str) -> Option<&'a OtelValue> {
        attributes
            .iter()
            .find(|attribute| attribute.key.as_str() == key)
            .map(|attribute| &attribute.value)
    }

    #[test]
    fn span_names_follow_gen_ai_conventions() {
        assert_eq!(invoke_agent_span_name("ryu"), "invoke_agent ryu");
        assert_eq!(
            execute_tool_span_name("threads.list_threads"),
            "execute_tool threads.list_threads"
        );
        assert_eq!(
            mcp_tools_call_span_name("github.search"),
            "tools/call github.search"
        );
        assert_eq!(mcp_server_of("github.search_issues"), Some("github"));
        assert_eq!(mcp_server_of("bare"), None);
        assert_eq!(mcp_server_of(".x"), None);
    }

    #[test]
    fn agent_attributes_carry_identity_and_fall_back_to_the_default_agent() {
        let attributes = agent_attributes(&AgentTurn {
            agent_id: Some("agent-7"),
            agent_name: Some("Researcher"),
            conversation_id: Some("conv-1"),
            session_id: None,
            request_model: Some("claude-opus-5-5"),
        });
        assert_eq!(
            attribute(&attributes, "gen_ai.operation.name"),
            Some(&OtelValue::from("invoke_agent"))
        );
        assert_eq!(
            attribute(&attributes, "gen_ai.agent.id"),
            Some(&OtelValue::from("agent-7"))
        );
        assert_eq!(
            attribute(&attributes, "gen_ai.agent.name"),
            Some(&OtelValue::from("Researcher"))
        );
        assert_eq!(
            attribute(&attributes, "gen_ai.conversation.id"),
            Some(&OtelValue::from("conv-1"))
        );
        // The session falls back to the conversation id.
        assert_eq!(
            attribute(&attributes, "ryu.session.id"),
            Some(&OtelValue::from("conv-1"))
        );

        let anonymous = agent_attributes(&AgentTurn::default());
        assert_eq!(
            attribute(&anonymous, "gen_ai.agent.name"),
            Some(&OtelValue::from(DEFAULT_AGENT))
        );
        assert!(attribute(&anonymous, "gen_ai.conversation.id").is_none());
        assert!(attribute(&anonymous, "ryu.session.id").is_none());
    }

    #[test]
    fn tool_attributes_mark_mcp_extensions_and_client_functions() {
        let mcp = tool_attributes(&ToolCall::registry("github.search", Some("call_1")));
        assert_eq!(
            attribute(&mcp, "gen_ai.operation.name"),
            Some(&OtelValue::from("execute_tool"))
        );
        assert_eq!(
            attribute(&mcp, "gen_ai.tool.type"),
            Some(&OtelValue::from("extension"))
        );
        assert_eq!(
            attribute(&mcp, "ryu.mcp.server.name"),
            Some(&OtelValue::from("github"))
        );
        assert_eq!(
            attribute(&mcp, "gen_ai.tool.call.id"),
            Some(&OtelValue::from("call_1"))
        );

        let datastore = tool_attributes(&ToolCall::registry("search_conversations.search", None));
        assert_eq!(
            attribute(&datastore, "gen_ai.tool.type"),
            Some(&OtelValue::from("datastore"))
        );

        let function = tool_attributes(&ToolCall {
            name: "browser_click",
            call_id: None,
            tool_type: ToolType::Function,
            description: Some("Click an element"),
            mcp_server: None,
        });
        assert_eq!(
            attribute(&function, "gen_ai.tool.type"),
            Some(&OtelValue::from("function"))
        );
        assert_eq!(
            attribute(&function, "gen_ai.tool.description"),
            Some(&OtelValue::from("Click an element"))
        );
        assert!(attribute(&function, "ryu.mcp.server.name").is_none());
        assert!(attribute(&function, "gen_ai.tool.call.id").is_none());
    }

    #[test]
    fn tool_content_is_redacted_and_descriptions_resolve() {
        let redacted = redact_tool_content("token ghp_abcdefghijklmnopqrstuvwxyz0123 ok");
        assert!(!redacted.contains("ghp_abcdefghijklmnopqrstuvwxyz0123"));
        assert!(redacted.contains("[REDACTED:GITHUB_TOKEN]"));
        assert!(redacted.ends_with(" ok"));

        let tools = vec![
            json!({"type": "function", "function": {"name": "click", "description": "Click an element"}}),
            json!({"type": "function", "function": {"name": "blank", "description": "  "}}),
        ];
        assert_eq!(tool_description(&tools, "click"), Some("Click an element"));
        assert_eq!(tool_description(&tools, "blank"), None);
        assert_eq!(tool_description(&tools, "missing"), None);
    }

    #[test]
    fn tool_error_results_are_detected() {
        assert!(is_error_result(&json!({ "isError": true, "error": "x" })));
        assert!(!is_error_result(&json!({ "isError": false })));
        assert!(!is_error_result(&json!("plain text")));
    }

    #[test]
    fn trace_context_merges_into_mcp_meta_without_clobbering() {
        let fields = vec![
            (
                "traceparent".to_owned(),
                "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01".to_owned(),
            ),
            ("tracestate".to_owned(), "ryu=1".to_owned()),
        ];
        let params = with_trace_context_meta(json!({ "name": "t", "arguments": {} }), &fields);
        assert_eq!(
            params["_meta"]["traceparent"],
            "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
        );
        assert_eq!(params["_meta"]["tracestate"], "ryu=1");
        assert!(params["arguments"].get("_meta").is_none());

        // Existing host metadata survives; a caller's own traceparent wins.
        let params = with_trace_context_meta(
            json!({ "name": "t", "_meta": { "ryu/ghostCursor": { "agentId": "a" }, "traceparent": "caller" } }),
            &fields,
        );
        assert_eq!(params["_meta"]["traceparent"], "caller");
        assert_eq!(params["_meta"]["ryu/ghostCursor"]["agentId"], "a");
        assert_eq!(params["_meta"]["tracestate"], "ryu=1");

        // No exportable context → byte-identical params.
        let untouched = json!({ "name": "t" });
        assert_eq!(with_trace_context_meta(untouched.clone(), &[]), untouched);
        // Non-object params are left alone.
        assert_eq!(with_trace_context_meta(Value::Null, &fields), Value::Null);
    }

    #[derive(Debug, Clone, Default)]
    struct CapturingExporter(Arc<Mutex<Vec<SpanData>>>);

    impl SpanExporter for CapturingExporter {
        async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
            self.0.lock().expect("captured spans").extend(batch);
            Ok(())
        }
    }

    /// Spans nest under the instrumented stream's span, and an INFO span's
    /// context reaches MCP `_meta` through the foundation propagation helper.
    #[tokio::test]
    async fn instrumented_stream_parents_children_and_feeds_mcp_meta() {
        opentelemetry::global::set_text_map_propagator(
            opentelemetry_sdk::propagation::TraceContextPropagator::new(),
        );
        let exporter = CapturingExporter::default();
        let provider = SdkTracerProvider::builder()
            .with_simple_exporter(exporter.clone())
            .build();
        let subscriber = tracing_subscriber::registry()
            .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("test")));
        let _default = tracing::subscriber::set_default(subscriber);

        let turn = tracing::info_span!("invoke_agent", otel.name = "invoke_agent ryu");
        set_attributes(&turn, agent_attributes(&AgentTurn::default()));
        let stream = instrument_stream(
            futures_util::stream::once(async {
                let tool = tracing::info_span!("execute_tool", otel.name = "execute_tool t");
                let _entered = tool.enter();
                with_trace_context_meta(
                    json!({ "name": "t" }),
                    &crate::telemetry::propagation::current_trace_context_fields(),
                )
            }),
            turn,
        );
        let params = futures_util::StreamExt::collect::<Vec<_>>(stream).await;
        let traceparent = params[0]["_meta"]["traceparent"]
            .as_str()
            .expect("traceparent in _meta")
            .to_owned();
        let _ = provider.force_flush();

        let spans = exporter.0.lock().expect("captured spans").clone();
        let agent = spans
            .iter()
            .find(|span| span.name == "invoke_agent ryu")
            .expect("agent span exported");
        let tool = spans
            .iter()
            .find(|span| span.name == "execute_tool t")
            .expect("tool span exported");
        assert_eq!(tool.parent_span_id, agent.span_context.span_id());
        assert_eq!(tool.span_context.trace_id(), agent.span_context.trace_id());
        assert!(traceparent.contains(&tool.span_context.span_id().to_string()));
        assert!(agent
            .attributes
            .iter()
            .any(|kv| kv.key.as_str() == "gen_ai.agent.name"));
    }
}
