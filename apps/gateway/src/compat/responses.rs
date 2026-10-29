//! OpenAI Responses create requests mapped onto the Gateway's shared
//! Chat-Completions-shaped inference pipeline.

use super::responses_tools::ToolRegistry;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use uuid::Uuid;

const MAX_INPUT_ITEMS: usize = 4096;
const MAX_FUNCTION_TOOLS: usize = 128;
/// Chat Completions accepts `top_logprobs` in `0..=20`; Responses uses the same bound.
const MAX_TOP_LOGPROBS: u64 = 20;
/// `include` value that projects provider token logprobs onto `output_text`.
pub const INCLUDE_OUTPUT_TEXT_LOGPROBS: &str = "message.output_text.logprobs";
/// `include` hint accepted for Pi compatibility; never returned (see `parse`).
const INCLUDE_REASONING_ENCRYPTED: &str = "reasoning.encrypted_content";

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ResponseInput {
    Text(String),
    Items(Vec<Value>),
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseCreateRequest {
    pub model: String,
    input: ResponseInput,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub previous_response_id: Option<String>,
    #[serde(default)]
    prompt_cache_key: Option<String>,
    #[serde(default)]
    prompt_cache_retention: Option<String>,
    #[serde(default)]
    service_tier: Option<String>,
    #[serde(default)]
    pub stream: bool,
    #[serde(default)]
    pub store: Option<bool>,
    #[serde(default)]
    tools: Vec<Value>,
    #[serde(skip)]
    pub tool_registry: ToolRegistry,
    #[serde(default)]
    tool_choice: Option<Value>,
    #[serde(default)]
    parallel_tool_calls: Option<bool>,
    #[serde(default)]
    temperature: Option<f64>,
    #[serde(default)]
    top_p: Option<f64>,
    #[serde(default)]
    max_output_tokens: Option<u64>,
    #[serde(default)]
    text: Option<Value>,
    #[serde(default)]
    reasoning: Option<Value>,
    #[serde(default)]
    metadata: Option<Value>,
    /// Codex client diagnostics belong to the incoming request, not the
    /// normalized upstream Chat Completions payload or policy authority.
    #[serde(default)]
    client_metadata: Option<Value>,
    #[serde(default)]
    background: Option<bool>,
    #[serde(default)]
    conversation: Option<Value>,
    #[serde(default)]
    prompt: Option<Value>,
    #[serde(default)]
    truncation: Option<String>,
    #[serde(default)]
    include: Vec<String>,
    #[serde(default)]
    max_tool_calls: Option<u64>,
    #[serde(default)]
    top_logprobs: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct ResponseEnvelope {
    pub id: String,
    pub created_at: i64,
    pub previous_response_id: Option<String>,
    pub instructions: Option<String>,
    pub store: bool,
    pub max_output_tokens: Option<u64>,
    pub parallel_tool_calls: bool,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub tool_choice: Value,
    pub tools: Vec<Value>,
    pub text: Value,
    pub reasoning: Option<Value>,
    pub metadata: Value,
    pub service_tier: Option<String>,
    pub tool_registry: ToolRegistry,
    pub hosted_output: Vec<Value>,
    /// Whether provider token logprobs are projected onto `output_text`.
    pub logprobs: bool,
    pub top_logprobs: Option<u64>,
    pub max_tool_calls: Option<u64>,
}

pub struct ResponseResult {
    pub response: Value,
    pub assistant_message: Value,
}

impl ResponseCreateRequest {
    /// Parse and validate the supported Responses create contract at the HTTP
    /// boundary. Unsupported server-hosted features are rejected instead of
    /// silently changing the request's meaning.
    pub fn parse(body: Value) -> Result<Self, String> {
        let mut request: Self = serde_json::from_value(body)
            .map_err(|error| format!("invalid Responses request: {error}"))?;
        if request
            .top_logprobs
            .is_some_and(|top_logprobs| top_logprobs > MAX_TOP_LOGPROBS)
        {
            return Err(format!(
                "top_logprobs must be between 0 and {MAX_TOP_LOGPROBS}"
            ));
        }
        if request.model.trim().is_empty() {
            return Err("model must be a non-empty string".to_owned());
        }
        if request
            .prompt_cache_key
            .as_deref()
            .is_some_and(|key| key.chars().count() > 64)
        {
            return Err("prompt_cache_key must be at most 64 characters".to_owned());
        }
        if request
            .prompt_cache_retention
            .as_deref()
            .is_some_and(|retention| !matches!(retention, "in_memory" | "24h"))
        {
            return Err("prompt_cache_retention must be in_memory or 24h".to_owned());
        }
        if request.service_tier.as_deref().is_some_and(str::is_empty) {
            return Err("service_tier must be a non-empty string".to_owned());
        }
        for (name, metadata) in [
            ("metadata", request.metadata.as_ref()),
            ("client_metadata", request.client_metadata.as_ref()),
        ] {
            if metadata.is_some_and(|metadata| {
                metadata
                    .as_object()
                    .is_none_or(|metadata| metadata.values().any(|value| !value.is_string()))
            }) {
                return Err(format!("{name} must be an object with string values"));
            }
        }
        if request.previous_response_id.as_deref() == Some("") {
            return Err("previous_response_id must be a non-empty string".to_owned());
        }
        if request.background == Some(true) {
            return Err(
                "background responses are not supported by this Gateway; omit background and use stream=true for incremental output, or send a synchronous request"
                    .to_owned(),
            );
        }
        if request
            .conversation
            .as_ref()
            .is_some_and(|value| !value.is_null())
        {
            return Err(
                "conversation is not supported by this Gateway; continue with previous_response_id, or send the full history with store=false"
                    .to_owned(),
            );
        }
        if request
            .prompt
            .as_ref()
            .is_some_and(|value| !value.is_null())
        {
            return Err(
                "prompt templates are not supported by this Gateway; render the template client-side and send it as instructions and input"
                    .to_owned(),
            );
        }
        if request
            .truncation
            .as_deref()
            .is_some_and(|truncation| truncation != "disabled")
        {
            return Err("only truncation=disabled is supported".to_owned());
        }
        if let Some(option) = request.include.iter().find(|option| {
            !matches!(
                option.as_str(),
                INCLUDE_REASONING_ENCRYPTED | INCLUDE_OUTPUT_TEXT_LOGPROBS
            )
        }) {
            return Err(format!(
                "include option {option} is not supported by this Gateway; supported include options are {INCLUDE_OUTPUT_TEXT_LOGPROBS} and {INCLUDE_REASONING_ENCRYPTED}"
            ));
        }
        // pi-ai asks for this optional payload on reasoning models. The shared
        // Chat Completions pipeline has no encrypted-reasoning equivalent, so
        // accept the hint for client compatibility without claiming to return it.
        if let ResponseInput::Items(items) = &request.input {
            if items.len() > MAX_INPUT_ITEMS {
                return Err(format!("input may contain at most {MAX_INPUT_ITEMS} items"));
            }
        }
        if request.tools.len() > MAX_FUNCTION_TOOLS {
            return Err(format!(
                "tools may contain at most {MAX_FUNCTION_TOOLS} functions"
            ));
        }
        if request
            .max_output_tokens
            .is_some_and(|max_output_tokens| max_output_tokens == 0)
        {
            return Err("max_output_tokens must be greater than zero".to_owned());
        }
        if request
            .temperature
            .is_some_and(|value| !(0.0..=2.0).contains(&value))
        {
            return Err("temperature must be between 0 and 2".to_owned());
        }
        if request
            .top_p
            .is_some_and(|value| !(0.0..=1.0).contains(&value))
        {
            return Err("top_p must be between 0 and 1".to_owned());
        }
        validate_text_format(request.text.as_ref())?;
        validate_reasoning(request.reasoning.as_ref())?;
        request.tool_registry = ToolRegistry::parse(&request.tools)?;
        validate_tool_choice(request.tool_choice.as_ref())?;
        if let Some(choice) = request.tool_choice.as_ref() {
            if let Some(name) = choice.get("name").and_then(Value::as_str) {
                request
                    .tool_registry
                    .wire_name(name, choice.get("namespace").and_then(Value::as_str))?;
            }
            if choice.get("type").and_then(Value::as_str) == Some("web_search")
                && request.tool_registry.hosted_web.is_none()
            {
                return Err("web_search tool choice requires a declaration".into());
            }
            if choice.get("type").and_then(Value::as_str) == Some("web_search")
                && request.max_tool_calls == Some(0)
            {
                return Err(
                    "max_tool_calls=0 forbids the hosted web_search that tool_choice requires; raise max_tool_calls or drop the web_search tool_choice"
                        .into(),
                );
            }
        }
        Ok(request)
    }

    /// Whether the caller asked for token logprobs, via
    /// `include: ["message.output_text.logprobs"]` or `top_logprobs`.
    pub fn wants_logprobs(&self) -> bool {
        self.top_logprobs.is_some()
            || self
                .include
                .iter()
                .any(|option| option == INCLUDE_OUTPUT_TEXT_LOGPROBS)
    }

    /// Cap on hosted (Gateway-executed) tool calls for this response.
    pub fn max_tool_calls(&self) -> Option<u64> {
        self.max_tool_calls
    }

    pub fn stores_response(&self) -> bool {
        self.store.unwrap_or(true)
    }

    pub fn to_chat_messages(&self) -> Result<Vec<Value>, String> {
        match &self.input {
            ResponseInput::Text(text) => Ok(vec![json!({ "role": "user", "content": text })]),
            ResponseInput::Items(items) => {
                let normalized = items
                    .iter()
                    .map(|item| match item.get("type").and_then(Value::as_str) {
                        Some("custom_tool_call") => self.tool_registry.input_call(item),
                        Some("function_call") if item.get("namespace").is_some() => {
                            self.tool_registry.input_call(item)
                        }
                        Some("custom_tool_call_output") => {
                            let mut item = item.clone();
                            item["type"] = json!("function_call_output");
                            Ok(item)
                        }
                        _ => Ok(item.clone()),
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                let mut expanded = Vec::new();
                for item in normalized {
                    if item.get("type").and_then(Value::as_str) == Some("web_search_call") {
                        let id = required_string(&item, "id", "web_search_call")?;
                        if !matches!(
                            item.get("status").and_then(Value::as_str),
                            Some("completed" | "failed")
                        ) || item.pointer("/action/type").and_then(Value::as_str)
                            != Some("search")
                        {
                            return Err(
                                "only finished hosted search actions can be replayed".into()
                            );
                        }
                        let query = item
                            .pointer("/action/query")
                            .and_then(Value::as_str)
                            .ok_or("hosted search replay requires query")?;
                        expanded.push(json!({"type":"function_call","call_id":id,"name":"ryu_responses_web_search","arguments":serde_json::to_string(&json!({"query":query})).map_err(|_|"hosted search replay could not be encoded")?}));
                        let result = json!({"results":item.get("results").cloned().or_else(||item.pointer("/action/sources").cloned()).unwrap_or_else(||json!([])),"error":item.get("error").cloned().unwrap_or(Value::Null)});
                        expanded.push(json!({"type":"function_call_output","call_id":id,"output":serde_json::to_string(&result).map_err(|_|"hosted result replay could not be encoded")?}));
                    } else {
                        expanded.push(item);
                    }
                }
                input_items_to_chat(&expanded)
            }
        }
    }

    pub fn to_chat_body(&self, mut messages: Vec<Value>, stream: bool) -> Value {
        if let Some(instructions) = self.instructions.as_deref().filter(|text| !text.is_empty()) {
            messages.insert(0, json!({ "role": "system", "content": instructions }));
        }

        let mut body = json!({
            "model": self.model,
            "messages": messages,
            "stream": stream,
        });
        if !self.tools.is_empty() {
            body["tools"] = Value::Array(self.tool_registry.chat_tools.clone());
        }
        if let Some(tool_choice) = &self.tool_choice {
            let mut choice = tool_choice_to_chat(tool_choice);
            if let Some(name) = tool_choice.get("name").and_then(Value::as_str) {
                if let Ok(wire) = self
                    .tool_registry
                    .wire_name(name, tool_choice.get("namespace").and_then(Value::as_str))
                {
                    choice = json!({"type":"function","function":{"name":wire}});
                }
            }
            if tool_choice.get("type").and_then(Value::as_str) == Some("web_search") {
                choice = json!({"type":"function","function":{"name":"ryu_responses_web_search"}});
            }
            body["tool_choice"] = choice;
        }
        if let Some(parallel_tool_calls) = self.parallel_tool_calls {
            body["parallel_tool_calls"] = Value::Bool(parallel_tool_calls);
        }
        if let Some(temperature) = self.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(top_p) = self.top_p {
            body["top_p"] = json!(top_p);
        }
        if let Some(prompt_cache_key) = &self.prompt_cache_key {
            body["prompt_cache_key"] = Value::String(prompt_cache_key.clone());
        }
        if let Some(prompt_cache_retention) = &self.prompt_cache_retention {
            body["prompt_cache_retention"] = Value::String(prompt_cache_retention.clone());
        }
        if let Some(service_tier) = &self.service_tier {
            body["service_tier"] = Value::String(service_tier.clone());
        }
        if let Some(max_output_tokens) = self.max_output_tokens {
            body["max_completion_tokens"] = json!(max_output_tokens);
        }
        if self.wants_logprobs() {
            body["logprobs"] = Value::Bool(true);
            if let Some(top_logprobs) = self.top_logprobs {
                body["top_logprobs"] = json!(top_logprobs);
            }
        }
        if let Some(reasoning_effort) = self
            .reasoning
            .as_ref()
            .and_then(|reasoning| reasoning.get("effort"))
        {
            body["reasoning_effort"] = reasoning_effort.clone();
        }
        if let Some(text) = &self.text {
            if let Some(response_format) = text_format_to_chat(text) {
                body["response_format"] = response_format;
            }
            if let Some(verbosity) = text.get("verbosity") {
                body["verbosity"] = verbosity.clone();
            }
        }
        body
    }

    pub fn envelope(&self, id: String, created_at: i64) -> ResponseEnvelope {
        ResponseEnvelope {
            id,
            created_at,
            previous_response_id: self.previous_response_id.clone(),
            instructions: self.instructions.clone(),
            store: self.stores_response(),
            max_output_tokens: self.max_output_tokens,
            parallel_tool_calls: self.parallel_tool_calls.unwrap_or(true),
            temperature: self.temperature,
            top_p: self.top_p,
            tool_choice: self.tool_choice.clone().unwrap_or_else(|| json!("auto")),
            tools: self.tools.clone(),
            text: self
                .text
                .clone()
                .unwrap_or_else(|| json!({ "format": { "type": "text" } })),
            reasoning: self.reasoning.clone(),
            metadata: self.metadata.clone().unwrap_or_else(|| json!({})),
            service_tier: self.service_tier.clone(),
            tool_registry: self.tool_registry.clone(),
            hosted_output: Vec::new(),
            logprobs: self.wants_logprobs(),
            top_logprobs: self.top_logprobs,
            max_tool_calls: self.max_tool_calls,
        }
    }
}

fn validate_text_format(text: Option<&Value>) -> Result<(), String> {
    let Some(text) = text else {
        return Ok(());
    };
    let text = text
        .as_object()
        .ok_or_else(|| "text must be an object".to_owned())?;
    if text
        .keys()
        .any(|key| !matches!(key.as_str(), "format" | "verbosity"))
    {
        return Err("text contains an unsupported field".to_owned());
    }
    if let Some(verbosity) = text.get("verbosity") {
        if !matches!(verbosity.as_str(), Some("low" | "medium" | "high")) {
            return Err("text.verbosity must be low, medium, or high".to_owned());
        }
    }
    let Some(format) = text.get("format") else {
        return Ok(());
    };
    let format = format
        .as_object()
        .ok_or_else(|| "text.format must be an object".to_owned())?;
    match format.get("type").and_then(Value::as_str) {
        Some("text" | "json_object") if format.len() == 1 => Ok(()),
        Some("text" | "json_object") => {
            Err("text and json_object formats accept only the type field".to_owned())
        }
        Some("json_schema") => {
            if format.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "type" | "name" | "schema" | "strict" | "description"
                )
            }) {
                return Err("text.format contains an unsupported field".to_owned());
            }
            if format
                .get("name")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
                || !format.get("schema").is_some_and(Value::is_object)
            {
                return Err("text.format json_schema requires name and schema".to_owned());
            }
            if format
                .get("strict")
                .is_some_and(|strict| !strict.is_boolean())
            {
                return Err("text.format json_schema strict must be a boolean".to_owned());
            }
            if format
                .get("description")
                .is_some_and(|description| !description.is_string())
            {
                return Err("text.format json_schema description must be a string".to_owned());
            }
            Ok(())
        }
        Some(other) => Err(format!("text format {other} is not supported")),
        None => Err("text.format.type is required".to_owned()),
    }
}

fn validate_reasoning(reasoning: Option<&Value>) -> Result<(), String> {
    let Some(reasoning) = reasoning else {
        return Ok(());
    };
    let reasoning = reasoning
        .as_object()
        .ok_or_else(|| "reasoning must be an object".to_owned())?;
    if reasoning
        .keys()
        .any(|key| !matches!(key.as_str(), "effort" | "summary"))
    {
        return Err("reasoning contains an unsupported field".to_owned());
    }
    if let Some(summary) = reasoning.get("summary") {
        if !matches!(summary.as_str(), Some("auto" | "concise" | "detailed")) {
            return Err("reasoning.summary must be auto, concise, or detailed".to_owned());
        }
    }
    let Some(effort) = reasoning.get("effort") else {
        return Ok(());
    };
    match effort.as_str() {
        Some("none" | "minimal" | "low" | "medium" | "high" | "xhigh") => Ok(()),
        Some(other) => Err(format!("reasoning effort {other} is not supported")),
        None => Err("reasoning.effort must be a string".to_owned()),
    }
}

fn validate_function_tool(tool: &Value) -> Result<(), String> {
    if tool.as_object().is_none_or(|tool| {
        tool.keys().any(|key| {
            !matches!(
                key.as_str(),
                "type" | "name" | "description" | "parameters" | "strict"
            )
        })
    }) {
        return Err("function tools contain an unsupported field".to_owned());
    }
    if tool.get("type").and_then(Value::as_str) != Some("function") {
        return Err("only custom function tools are supported".to_owned());
    }
    if tool
        .get("name")
        .and_then(Value::as_str)
        .is_none_or(|name| name.trim().is_empty())
    {
        return Err("each function tool requires a non-empty name".to_owned());
    }
    if tool
        .get("description")
        .is_some_and(|description| !description.is_string())
    {
        return Err("function tool description must be a string".to_owned());
    }
    if tool
        .get("strict")
        .is_some_and(|strict| !strict.is_boolean())
    {
        return Err("function tool strict must be a boolean".to_owned());
    }
    if !tool.get("parameters").is_some_and(Value::is_object) {
        return Err("each function tool requires an object parameters schema".to_owned());
    }
    Ok(())
}

fn validate_tool_choice(tool_choice: Option<&Value>) -> Result<(), String> {
    let Some(tool_choice) = tool_choice else {
        return Ok(());
    };
    if let Some(choice) = tool_choice.as_str() {
        return match choice {
            "auto" | "none" | "required" => Ok(()),
            other => Err(format!("tool_choice {other} is not supported")),
        };
    }
    if tool_choice.get("type").and_then(Value::as_str) == Some("web_search") {
        return Ok(());
    }
    if matches!(
        tool_choice.get("type").and_then(Value::as_str),
        Some("function" | "custom")
    ) && tool_choice
        .get("name")
        .and_then(Value::as_str)
        .is_some_and(|name| !name.is_empty())
    {
        Ok(())
    } else {
        Err("tool_choice must be auto, none, required, or a named function".to_owned())
    }
}

fn input_items_to_chat(items: &[Value]) -> Result<Vec<Value>, String> {
    let mut messages = Vec::new();
    let mut pending_tool_calls = Vec::new();
    for item in items {
        if item.get("type").and_then(Value::as_str) == Some("function_call") {
            pending_tool_calls.push(function_call_to_chat(item)?);
            continue;
        }
        if !pending_tool_calls.is_empty() {
            messages.push(json!({
                "role": "assistant",
                "content": null,
                "tool_calls": std::mem::take(&mut pending_tool_calls),
            }));
        }
        messages.push(input_item_to_chat(item)?);
    }
    if !pending_tool_calls.is_empty() {
        messages.push(json!({
            "role": "assistant",
            "content": null,
            "tool_calls": pending_tool_calls,
        }));
    }
    Ok(messages)
}

fn function_call_to_chat(item: &Value) -> Result<Value, String> {
    let call_id = required_string(item, "call_id", "function_call")?;
    let name = required_string(item, "name", "function_call")?;
    let arguments = item
        .get("arguments")
        .ok_or_else(|| "function_call requires arguments".to_owned())?;
    let arguments = match arguments {
        Value::String(value) => value.clone(),
        value => serde_json::to_string(value)
            .map_err(|_| "function_call arguments could not be encoded".to_owned())?,
    };
    Ok(json!({
        "id": call_id,
        "type": "function",
        "function": { "name": name, "arguments": arguments },
    }))
}

fn input_item_to_chat(item: &Value) -> Result<Value, String> {
    match item.get("type").and_then(Value::as_str) {
        Some("function_call_output") => {
            let call_id = required_string(item, "call_id", "function_call_output")?;
            let output = item
                .get("output")
                .ok_or_else(|| "function_call_output requires output".to_owned())?;
            let output = output_to_chat_text(output)?;
            Ok(json!({ "role": "tool", "tool_call_id": call_id, "content": output }))
        }
        Some("message") | None => {
            let role = required_string(item, "role", "message")?;
            if !matches!(role.as_str(), "system" | "developer" | "user" | "assistant") {
                return Err(format!("message role {role} is not supported"));
            }
            let content = item
                .get("content")
                .ok_or_else(|| "message input requires content".to_owned())?;
            Ok(json!({ "role": role, "content": input_content_to_chat(content)? }))
        }
        Some("function_call") => {
            Err("function_call items must be grouped in input order".to_owned())
        }
        Some(other) => Err(format!("input item type {other} is not supported")),
    }
}

fn required_string(item: &Value, field: &str, kind: &str) -> Result<String, String> {
    item.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("{kind} requires a non-empty {field}"))
}

fn input_content_to_chat(content: &Value) -> Result<Value, String> {
    if let Some(text) = content.as_str() {
        return Ok(Value::String(text.to_owned()));
    }
    let parts = content
        .as_array()
        .ok_or_else(|| "message content must be a string or content array".to_owned())?;
    let mut mapped = Vec::with_capacity(parts.len());
    for part in parts {
        match part.get("type").and_then(Value::as_str) {
            Some("input_text" | "output_text") => {
                let text = required_string(part, "text", "text content")?;
                mapped.push(json!({ "type": "text", "text": text }));
            }
            Some("input_image") => {
                let image_url = part
                    .get("image_url")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        "input_image requires image_url; file_id is not supported by this Gateway, so pass the image as an https URL or a base64 data: URL in image_url".to_owned()
                    })?;
                let mut image = json!({ "url": image_url });
                if let Some(detail) = part.get("detail") {
                    image["detail"] = detail.clone();
                }
                mapped.push(json!({ "type": "image_url", "image_url": image }));
            }
            Some(other) => return Err(format!("input content type {other} is not supported")),
            None => return Err("input content part requires a type".to_owned()),
        }
    }
    Ok(Value::Array(mapped))
}

fn output_to_chat_text(output: &Value) -> Result<String, String> {
    match output {
        Value::String(text) => Ok(text.clone()),
        Value::Array(parts) => {
            let mut text = Vec::with_capacity(parts.len());
            for part in parts {
                if part.get("type").and_then(Value::as_str) != Some("input_text")
                    && part.get("type").and_then(Value::as_str) != Some("output_text")
                {
                    return Err("function outputs support text content only".to_owned());
                }
                text.push(
                    part.get("text")
                        .and_then(Value::as_str)
                        .ok_or_else(|| "text function output requires text".to_owned())?,
                );
            }
            Ok(text.join("\n"))
        }
        _ => serde_json::to_string(output)
            .map_err(|_| "function output could not be encoded".to_owned()),
    }
}

fn function_tool_to_chat(tool: &Value) -> Value {
    let mut function = Map::new();
    for key in ["name", "description", "parameters", "strict"] {
        if let Some(value) = tool.get(key) {
            function.insert(key.to_owned(), value.clone());
        }
    }
    json!({ "type": "function", "function": function })
}

fn tool_choice_to_chat(tool_choice: &Value) -> Value {
    if tool_choice.get("type").and_then(Value::as_str) == Some("function") {
        return json!({
            "type": "function",
            "function": { "name": tool_choice["name"] },
        });
    }
    tool_choice.clone()
}

fn text_format_to_chat(text: &Value) -> Option<Value> {
    let format = text.get("format")?;
    match format.get("type")?.as_str()? {
        "json_object" => Some(json!({ "type": "json_object" })),
        "json_schema" => {
            let mut schema = json!({
                "name": format["name"],
                "schema": format["schema"],
                "strict": format.get("strict").cloned().unwrap_or(Value::Bool(false)),
            });
            if let Some(description) = format.get("description") {
                schema["description"] = description.clone();
            }
            Some(json!({ "type": "json_schema", "json_schema": schema }))
        }
        _ => None,
    }
}

pub fn response_shell(envelope: &ResponseEnvelope, model: &str, status: &str) -> Value {
    let mut response = json!({
        "id": envelope.id,
        "object": "response",
        "created_at": envelope.created_at,
        "status": status,
        "completed_at": null,
        "error": null,
        "incomplete_details": null,
        "instructions": envelope.instructions,
        "max_output_tokens": envelope.max_output_tokens,
        "model": model,
        "output": [],
        "parallel_tool_calls": envelope.parallel_tool_calls,
        "previous_response_id": envelope.previous_response_id,
        "reasoning": envelope.reasoning,
        "store": envelope.store,
        "temperature": envelope.temperature,
        "text": envelope.text,
        "tool_choice": envelope.tool_choice,
        "tools": envelope.tools,
        "top_p": envelope.top_p,
        "top_logprobs": envelope.top_logprobs,
        "max_tool_calls": envelope.max_tool_calls,
        "usage": null,
        "metadata": envelope.metadata,
    });
    if let Some(service_tier) = &envelope.service_tier {
        response["service_tier"] = Value::String(service_tier.clone());
    }
    response
}

pub fn chat_response_to_responses(
    chat_response: &Value,
    envelope: &ResponseEnvelope,
    model_used: &str,
    completed_at: i64,
) -> Result<ResponseResult, String> {
    let choice = chat_response
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| "provider returned no completion choice".to_owned())?;
    let message = choice
        .get("message")
        .filter(|message| message.is_object())
        .ok_or_else(|| "provider returned no assistant message".to_owned())?;
    let mut assistant_message = message.clone();
    assistant_message["role"] = Value::String("assistant".to_owned());

    let mut output = envelope.hosted_output.clone();
    let refusal = message.get("refusal").and_then(Value::as_str);
    let content = message.get("content");
    if let Some(refusal) = refusal.filter(|text| !text.is_empty()) {
        output.push(json!({
            "id": response_item_id("msg"),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "refusal", "refusal": refusal }],
        }));
    } else if let Some(text) = output_text(content) {
        if !text.is_empty() {
            let mut part = json!({ "type": "output_text", "text": text, "annotations": [] });
            if envelope.logprobs {
                part["logprobs"] =
                    Value::Array(chat_logprobs(choice).ok_or_else(missing_logprobs_error)?);
            }
            output.push(json!({
                "id": response_item_id("msg"),
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": [part],
            }));
        }
    }

    if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
        for (index, call) in tool_calls.iter().enumerate() {
            let name = call
                .pointer("/function/name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "provider returned a function call without a name".to_owned())?;
            let call_id = call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| response_item_id("call"));
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}");
            if let Some(assistant_tool_call) =
                assistant_message.pointer_mut(&format!("/tool_calls/{index}"))
            {
                assistant_tool_call["id"] = Value::String(call_id.clone());
                assistant_tool_call["function"]["arguments"] = Value::String(arguments.to_owned());
            }
            let mut item = json!({
                "id": response_item_id("fc"),
                "type": "function_call",
                "status": "completed",
                "call_id": call_id,
                "name": name,
                "arguments": arguments,
            });
            envelope.tool_registry.output_call(&mut item)?;
            output.push(item);
        }
    }

    let finish_reason = choice.get("finish_reason").and_then(Value::as_str);
    let incomplete_reason = finish_reason.and_then(chat_incomplete_reason);
    let status = if incomplete_reason.is_some() {
        "incomplete"
    } else {
        "completed"
    };
    let usage = chat_usage_to_responses(chat_response.get("usage"));
    let mut response = response_shell(envelope, model_used, status);
    if let Some(service_tier) = chat_response.get("service_tier") {
        if service_tier.is_string() {
            response["service_tier"] = service_tier.clone();
        }
    }
    response["completed_at"] = json!(completed_at);
    response["output"] = Value::Array(output);
    response["usage"] = usage;
    if status == "incomplete" {
        response["incomplete_details"] = json!({ "reason": incomplete_reason });
    }

    Ok(ResponseResult {
        response,
        assistant_message,
    })
}

pub fn chat_incomplete_reason(finish_reason: &str) -> Option<&'static str> {
    match finish_reason {
        "length" => Some("max_output_tokens"),
        "content_filter" => Some("content_filter"),
        _ => None,
    }
}

/// Token logprobs from a Chat Completions choice (`choice.logprobs.content`),
/// already in the Responses `output_text.logprobs` shape (`token`, `logprob`,
/// `bytes`, `top_logprobs`). `None` when the provider returned none.
pub fn chat_logprobs(choice: &Value) -> Option<Vec<Value>> {
    choice
        .pointer("/logprobs/content")
        .and_then(Value::as_array)
        .cloned()
}

/// Logprobs were requested but the routed provider path did not return them.
/// Reported instead of returning text with an empty, misleading projection.
pub fn missing_logprobs_error() -> String {
    "the routed provider did not return token logprobs; route this request to a provider that returns Chat Completions logprobs, or omit top_logprobs and include=message.output_text.logprobs".to_owned()
}

pub fn response_item_id(prefix: &str) -> String {
    format!("{prefix}_{}", Uuid::new_v4().simple())
}

pub fn chat_usage_to_responses(usage: Option<&Value>) -> Value {
    let empty = Value::Null;
    let usage = usage.unwrap_or(&empty);
    let input_tokens = usage["prompt_tokens"].as_u64().unwrap_or(0);
    let output_tokens = usage["completion_tokens"].as_u64().unwrap_or(0);
    let cached_tokens = usage["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or_else(|| usage["input_tokens_details"]["cached_tokens"].as_u64())
        .or_else(|| usage["cache_read_input_tokens"].as_u64());
    let cache_write_tokens = usage["prompt_tokens_details"]["cache_write_tokens"]
        .as_u64()
        .or_else(|| usage["input_tokens_details"]["cache_write_tokens"].as_u64())
        .or_else(|| usage["cache_write_tokens"].as_u64())
        .or_else(|| usage["cache_creation_input_tokens"].as_u64());
    let reasoning_tokens = usage["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .unwrap_or(0);
    let mut input_tokens_details = serde_json::Map::new();
    // Responses clients require this counter even when upstream usage is absent.
    input_tokens_details.insert(
        "cached_tokens".to_owned(),
        json!(cached_tokens.unwrap_or(0)),
    );
    if let Some(cache_write_tokens) = cache_write_tokens {
        input_tokens_details.insert("cache_write_tokens".to_owned(), json!(cache_write_tokens));
    }
    json!({
        "input_tokens": input_tokens,
        "input_tokens_details": input_tokens_details,
        "output_tokens": output_tokens,
        "output_tokens_details": { "reasoning_tokens": reasoning_tokens },
        "total_tokens": usage["total_tokens"].as_u64().unwrap_or(input_tokens.saturating_add(output_tokens)),
    })
}

fn output_text(content: Option<&Value>) -> Option<String> {
    match content? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<String>();
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::{chat_response_to_responses, chat_usage_to_responses, ResponseCreateRequest};

    fn parse(value: Value) -> ResponseCreateRequest {
        ResponseCreateRequest::parse(value).expect("valid Responses request")
    }

    #[test]
    fn namespace_and_custom_call_inputs_and_outputs_roundtrip() {
        let request = parse(json!({"model":"local","input":[
            {"type":"function_call","namespace":"multi_agent_v1","name":"spawn_agent","call_id":"n","arguments":"{}"},
            {"type":"function_call_output","call_id":"n","output":"agent started"},
            {"type":"custom_tool_call","name":"patch","call_id":"c","input":"line \"one\"\nline two"},
            {"type":"custom_tool_call_output","call_id":"c","output":"patched"}],
            "tools":[{"type":"namespace","name":"multi_agent_v1","tools":[{"type":"function","name":"spawn_agent","parameters":{}}]},{"type":"custom","name":"patch","format":{"type":"text"}}]}));
        let messages = request.to_chat_messages().unwrap();
        assert_eq!(messages[1]["tool_call_id"], "n");
        assert_eq!(messages[3]["content"], "patched");
        let response = json!({"choices":[{"message":messages[2],"finish_reason":"tool_calls"}]});
        let result =
            chat_response_to_responses(&response, &request.envelope("resp".into(), 1), "local", 2)
                .unwrap();
        assert_eq!(result.response["output"][0]["type"], "custom_tool_call");
        assert_eq!(
            result.response["output"][0]["input"],
            "line \"one\"\nline two"
        );
    }
    #[test]
    fn finished_hosted_search_replays_statelessly_without_requesting_new_search() {
        let request = parse(
            json!({"model":"local","input":[{"type":"web_search_call","id":"ws_cached","status":"failed","action":{"type":"search","query":"fixture query"},"results":[],"error":{"code":"cached_web_search_unavailable"}},{"type":"message","role":"assistant","content":[{"type":"output_text","text":"No cached results"}]}]}),
        );
        let messages = request.to_chat_messages().unwrap();
        assert_eq!(messages[0]["tool_calls"][0]["id"], "ws_cached");
        assert_eq!(messages[1]["tool_call_id"], "ws_cached");
        assert!(messages[1]["content"]
            .as_str()
            .unwrap()
            .contains("cached_web_search_unavailable"));
        assert_eq!(messages[2]["role"], "assistant");
    }

    #[test]
    fn string_input_and_instructions_normalize_to_chat_messages() {
        let request = parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "instructions": "be concise"
        }));
        let messages = request.to_chat_messages().unwrap();
        let body = request.to_chat_body(messages.clone(), false);

        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "be concise" })
        );
        assert_eq!(
            body["messages"][1],
            json!({ "role": "user", "content": "hello" })
        );
        assert_eq!(body["stream"], false);
        assert_eq!(
            messages.len(),
            1,
            "top-level instructions are not stored as conversation history"
        );
    }

    #[test]
    fn function_call_and_output_items_map_to_chat_tool_turns() {
        let request = parse(json!({
            "model": "gpt-4o",
            "input": [
                { "type": "function_call", "call_id": "call_1", "name": "lookup", "arguments": r#"{"q":"x"}"# },
                { "type": "function_call_output", "call_id": "call_1", "output": "found" }
            ],
            "tools": [{ "type": "function", "name": "lookup", "parameters": { "type": "object" } }],
            "tool_choice": { "type": "function", "name": "lookup" }
        }));
        let messages = request.to_chat_messages().unwrap();
        let body = request.to_chat_body(messages, false);

        assert_eq!(body["messages"][0]["tool_calls"][0]["id"], "call_1");
        assert_eq!(body["messages"][1]["tool_call_id"], "call_1");
        assert_eq!(body["tools"][0]["function"]["name"], "lookup");
        assert_eq!(body["tool_choice"]["function"]["name"], "lookup");
    }

    #[test]
    fn function_call_output_text_parts_keep_their_boundaries() {
        let request = parse(json!({
            "model": "gpt-4o",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_1",
                "output": [
                    { "type": "input_text", "text": "first" },
                    { "type": "output_text", "text": "second" }
                ]
            }]
        }));

        assert_eq!(
            request.to_chat_messages().unwrap()[0]["content"],
            "first\nsecond"
        );
    }

    #[test]
    fn image_input_maps_to_openai_chat_image_url() {
        let request = parse(json!({
            "model": "gpt-4o",
            "input": [{
                "role": "user",
                "content": [
                    { "type": "input_text", "text": "describe" },
                    { "type": "input_image", "image_url": "https://example.test/image.png", "detail": "low" }
                ]
            }]
        }));
        let messages = request.to_chat_messages().unwrap();
        assert_eq!(messages[0]["content"][1]["type"], "image_url");
        assert_eq!(messages[0]["content"][1]["image_url"]["detail"], "low");
    }

    #[test]
    fn pi_responses_parameters_survive_normalization() {
        let request = parse(json!({
            "model": "gpt-5",
            "input": "think carefully",
            "max_output_tokens": 1024,
            "stream": true,
            "store": false,
            "reasoning": { "effort": "high", "summary": "auto" },
            "include": ["reasoning.encrypted_content"],
            "text": { "verbosity": "low" },
            "prompt_cache_key": "session_1",
            "prompt_cache_retention": "24h",
            "service_tier": "priority"
        }));
        let body = request.to_chat_body(request.to_chat_messages().unwrap(), true);
        let envelope = request.envelope("resp_test".to_owned(), 1);

        assert_eq!(body["stream"], true);
        assert!(
            body.get("store").is_none(),
            "store controls Gateway response state"
        );
        assert_eq!(body["reasoning_effort"], "high");
        assert_eq!(body["max_completion_tokens"], 1024);
        assert_eq!(body["verbosity"], "low");
        assert_eq!(body["prompt_cache_key"], "session_1");
        assert_eq!(body["prompt_cache_retention"], "24h");
        assert_eq!(body["service_tier"], "priority");
        assert_eq!(envelope.store, false);
        assert_eq!(envelope.service_tier.as_deref(), Some("priority"));
    }

    #[test]
    fn codex_client_metadata_is_validated_without_changing_upstream_messages() {
        let request = parse(json!({
            "model": "proof-model",
            "input": "hello",
            "client_metadata": {
                "session_id": "local-session",
                "x-codex-turn-metadata": "{\"request_kind\":\"turn\"}"
            }
        }));
        let body = request.to_chat_body(request.to_chat_messages().unwrap(), true);
        assert_eq!(
            body["messages"],
            json!([{ "role": "user", "content": "hello" }])
        );
        assert!(body.get("client_metadata").is_none());
        for invalid in [json!("text"), json!([]), json!({"session_id": 42})] {
            assert!(ResponseCreateRequest::parse(json!({
                "model": "proof-model", "input": "hello", "client_metadata": invalid
            }))
            .is_err());
        }
    }

    #[test]
    fn max_output_tokens_uses_the_current_chat_completion_parameter() {
        let request = parse(json!({
            "model": "gpt-5",
            "input": "hello",
            "max_output_tokens": 128
        }));
        let body = request.to_chat_body(request.to_chat_messages().unwrap(), false);

        assert_eq!(body["max_completion_tokens"], 128);
        assert!(body.get("max_tokens").is_none());
    }

    #[test]
    fn unsupported_request_fields_are_not_silently_ignored() {
        let unknown_field = ResponseCreateRequest::parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "safety_identifier": "end-user-1"
        }))
        .expect_err("unknown request fields must fail at the boundary");
        assert!(unknown_field.contains("safety_identifier"));

        let unsupported_parameter = ResponseCreateRequest::parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "background": true
        }))
        .expect_err("unsupported Responses parameters must fail explicitly");
        assert!(unsupported_parameter.contains("stream=true"));
    }

    #[test]
    fn logprobs_requests_map_to_chat_and_project_onto_output_text() {
        let request = parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "top_logprobs": 2,
            "include": ["message.output_text.logprobs"],
            "max_tool_calls": 3
        }));
        let body = request.to_chat_body(request.to_chat_messages().unwrap(), false);
        assert_eq!(body["logprobs"], true);
        assert_eq!(body["top_logprobs"], 2);
        assert!(body.get("max_tool_calls").is_none());
        let envelope = request.envelope("resp_test".to_owned(), 1);
        let entry = json!({"token":"hi","logprob":-0.1,"bytes":[104,105],"top_logprobs":[]});
        let result = chat_response_to_responses(
            &json!({"choices":[{"message":{"role":"assistant","content":"hi"},"logprobs":{"content":[entry]},"finish_reason":"stop"}]}),
            &envelope,
            "m",
            2,
        )
        .unwrap();
        assert_eq!(
            result.response["output"][0]["content"][0]["logprobs"][0]["token"],
            "hi"
        );
        assert_eq!(result.response["top_logprobs"], 2);
        assert_eq!(result.response["max_tool_calls"], 3);

        let missing = chat_response_to_responses(
            &json!({"choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}),
            &envelope,
            "m",
            2,
        );
        assert!(missing.is_err_and(|error| error.contains("did not return token logprobs")));
        assert!(ResponseCreateRequest::parse(
            json!({"model":"gpt-4o","input":"hello","top_logprobs":21})
        )
        .is_err());
    }

    #[test]
    fn zero_max_tool_calls_cannot_force_hosted_search() {
        let error = ResponseCreateRequest::parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "max_tool_calls": 0,
            "tools": [{"type": "web_search"}],
            "tool_choice": {"type": "web_search"}
        }))
        .expect_err("contradictory limits are rejected");
        assert!(error.contains("max_tool_calls=0"));
    }

    #[test]
    fn unsupported_include_options_are_rejected() {
        let error = ResponseCreateRequest::parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "include": ["code_interpreter_call.outputs"]
        }))
        .expect_err("unsupported output projection must be reported");
        assert!(error.contains("code_interpreter_call.outputs is not supported"));
        assert!(error.contains("message.output_text.logprobs"));
    }

    #[test]
    fn metadata_values_must_be_strings() {
        let error = ResponseCreateRequest::parse(json!({
            "model": "gpt-4o",
            "input": "hello",
            "metadata": { "attempt": 1 }
        }))
        .expect_err("metadata follows the Responses string-map contract");
        assert!(error.contains("metadata must be an object with string values"));
    }

    #[test]
    fn unsupported_hosted_tool_fails_instead_of_being_dropped() {
        let error = ResponseCreateRequest::parse(json!({
            "model": "gpt-4o",
            "input": "search",
            "tools": [{ "type": "file_search" }]
        }))
        .expect_err("unsupported hosted tools are rejected before inference");
        assert!(error.contains("supported"));
    }

    #[test]
    fn provider_tool_calls_project_to_responses_output_items() {
        let request = parse(json!({ "model": "gpt-4o", "input": "lookup" }));
        let envelope = request.envelope("resp_test".to_owned(), 1);
        let result = chat_response_to_responses(
            &json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_1",
                            "function": { "name": "lookup", "arguments": r#"{"q":"x"}"# }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }],
                "usage": { "prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5 }
            }),
            &envelope,
            "routed-model",
            2,
        )
        .unwrap();

        assert_eq!(result.response["object"], "response");
        assert_eq!(result.response["status"], "completed");
        assert_eq!(result.response["output"][0]["type"], "function_call");
        assert_eq!(result.response["output"][0]["call_id"], "call_1");
        assert_eq!(result.response["model"], "routed-model");
        assert_eq!(result.response["usage"]["total_tokens"], 5);
        assert_eq!(result.assistant_message["tool_calls"][0]["id"], "call_1");
    }

    #[test]
    fn generated_call_ids_are_saved_in_continuation_history() {
        let request = parse(json!({ "model": "gpt-4o", "input": "lookup" }));
        let envelope = request.envelope("resp_test".to_owned(), 1);
        let result = chat_response_to_responses(
            &json!({
                "choices": [{
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "type": "function",
                            "function": { "name": "lookup", "arguments": "{}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            &envelope,
            "routed-model",
            2,
        )
        .unwrap();

        assert_eq!(
            result.assistant_message["tool_calls"][0]["id"],
            result.response["output"][0]["call_id"]
        );
    }

    #[test]
    fn content_filter_finish_reason_maps_to_incomplete_response() {
        let request = parse(json!({ "model": "gpt-4o", "input": "hello" }));
        let envelope = request.envelope("resp_test".to_owned(), 1);
        let result = chat_response_to_responses(
            &json!({
                "choices": [{
                    "message": { "role": "assistant", "content": null },
                    "finish_reason": "content_filter"
                }]
            }),
            &envelope,
            "routed-model",
            2,
        )
        .unwrap();

        assert_eq!(result.response["status"], "incomplete");
        assert_eq!(
            result.response["incomplete_details"]["reason"],
            "content_filter"
        );
    }

    #[test]
    fn responses_usage_preserves_reported_cache_reads_and_writes() {
        let usage = chat_usage_to_responses(Some(&json!({
            "prompt_tokens": 1000,
            "completion_tokens": 50,
            "prompt_tokens_details": {
                "cached_tokens": 800,
                "cache_write_tokens": 100
            }
        })));
        assert_eq!(usage["input_tokens_details"]["cached_tokens"], 800);
        assert_eq!(usage["input_tokens_details"]["cache_write_tokens"], 100);

        let uncached = chat_usage_to_responses(Some(&json!({
            "prompt_tokens": 10,
            "completion_tokens": 2
        })));
        assert_eq!(uncached["input_tokens_details"]["cached_tokens"], 0);
        assert!(uncached["input_tokens_details"]
            .get("cache_write_tokens")
            .is_none());
    }

    #[test]
    fn responses_usage_without_upstream_metrics_satisfies_required_client_counters() {
        #[derive(serde::Deserialize)]
        struct ClientUsage {
            input_tokens_details: ClientInputTokensDetails,
        }
        #[derive(serde::Deserialize)]
        struct ClientInputTokensDetails {
            cached_tokens: u64,
        }

        for upstream in [None, Some(Value::Null), Some(json!({}))] {
            let usage = chat_usage_to_responses(upstream.as_ref());
            let encoded = serde_json::to_vec(&usage).unwrap();
            let decoded: ClientUsage = serde_json::from_slice(&encoded).unwrap();
            assert_eq!(decoded.input_tokens_details.cached_tokens, 0);
            assert!(usage["input_tokens_details"]
                .get("cache_write_tokens")
                .is_none());
        }
    }
}
