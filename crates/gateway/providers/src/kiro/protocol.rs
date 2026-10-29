use super::{invalid, uncertain, ProviderError};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FRAME_LIMIT: usize = 24 * 1024 * 1024;
const OUTPUT_LIMIT: usize = 8 * 1024 * 1024;

fn text(value: &Value) -> Result<String, ProviderError> {
    if let Some(text) = value.as_str() {
        return Ok(text.to_owned());
    }
    if value.is_null() {
        return Ok(String::new());
    }
    let blocks = value
        .as_array()
        .ok_or_else(|| invalid("Kiro content must be text"))?;
    let mut output = Vec::new();
    for block in blocks {
        if block["type"] != "text" {
            return Err(invalid("Kiro HTTP currently accepts text content only"));
        }
        output.push(
            block["text"]
                .as_str()
                .ok_or_else(|| invalid("Invalid text block"))?,
        );
    }
    Ok(output.join("\n"))
}

pub(super) fn request(
    model: &str,
    body: &Value,
    session: Option<&str>,
    profile: Option<&str>,
) -> Result<Value, ProviderError> {
    let messages = body["messages"]
        .as_array()
        .ok_or_else(|| invalid("Kiro requires messages"))?;
    let mut history: Vec<Value> = Vec::new();
    let mut pending = String::new();
    let mut results = Vec::new();
    let mut outstanding = std::collections::HashSet::new();
    for message in messages {
        match message["role"].as_str() {
            Some("system" | "developer" | "user") => {
                if !pending.is_empty() {
                    pending.push_str("\n\n");
                }
                pending.push_str(&text(&message["content"])?);
            }
            Some("tool") => {
                let id = message["tool_call_id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| invalid("Tool result needs an ID"))?;
                if !outstanding.remove(id) {
                    return Err(invalid("Tool result has no matching outstanding call"));
                }
                results.push(json!({"toolUseId":id,"status":"success","content":[{"text":text(&message["content"])?}]}));
            }
            Some("assistant") => {
                if !pending.is_empty() || !results.is_empty() {
                    history.push(user_message(
                        std::mem::take(&mut pending),
                        model,
                        std::mem::take(&mut results),
                    ));
                }
                let mut assistant = json!({"content":text(&message["content"])?});
                if let Some(calls) = message["tool_calls"].as_array() {
                    let mut tools = Vec::new();
                    for call in calls {
                        let id = call["id"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .ok_or_else(|| invalid("Tool call needs an ID"))?;
                        if !outstanding.insert(id.to_owned()) {
                            return Err(invalid("Duplicate tool call ID"));
                        }
                        let name = call["function"]["name"]
                            .as_str()
                            .filter(|v| !v.is_empty())
                            .ok_or_else(|| invalid("Tool call needs a name"))?;
                        let arguments: Value = serde_json::from_str(
                            call["function"]["arguments"]
                                .as_str()
                                .ok_or_else(|| invalid("Tool arguments must be JSON"))?,
                        )
                        .map_err(|_| invalid("Malformed tool arguments"))?;
                        if !arguments.is_object() {
                            return Err(invalid("Tool arguments must be an object"));
                        }
                        tools.push(json!({"toolUseId":id,"name":name,"input":arguments}));
                    }
                    assistant["toolUses"] = json!(tools);
                }
                history.push(json!({"assistantResponseMessage":assistant}));
            }
            _ => return Err(invalid("Unsupported Kiro message role")),
        }
    }
    if pending.is_empty() && results.is_empty() {
        return Err(invalid("Kiro needs a current user message or tool result"));
    }
    if !outstanding.is_empty() {
        return Err(invalid(
            "Tool calls require matching results before the next Kiro turn",
        ));
    }
    let mut current = user_message(pending, model, results);
    if let Some(tools) = body["tools"].as_array() {
        let mut specs = Vec::new();
        for tool in tools {
            let function = &tool["function"];
            let name = function["name"]
                .as_str()
                .filter(|v| !v.is_empty())
                .ok_or_else(|| invalid("Tool definition needs a name"))?;
            specs.push(json!({"toolSpecification":{"name":name,"description":function["description"].as_str().unwrap_or(""),"inputSchema":{"json":function.get("parameters").cloned().unwrap_or(json!({"type":"object","properties":{}}))}}}));
        }
        if !current["userInputMessage"]["userInputMessageContext"].is_object() {
            current["userInputMessage"]["userInputMessageContext"] = json!({});
        }
        current["userInputMessage"]["userInputMessageContext"]["tools"] = json!(specs);
    }
    let mut output = json!({"conversationState":{"chatTriggerType":"MANUAL","conversationId":session.map(str::to_owned).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),"history":history,"currentMessage":current}});
    if let Some(profile) = profile {
        output["profileArn"] = json!(profile);
    }
    if let Some(effort) = body["reasoning_effort"].as_str() {
        if !matches!(effort, "none" | "low" | "medium" | "high" | "xhigh" | "max") {
            return Err(invalid("Invalid Kiro reasoning effort"));
        }
        if effort != "none" {
            if model.starts_with("gpt-5.6") || model.starts_with("gpt-5-6") {
                output["additionalModelRequestFields"] =
                    json!({"reasoning":{"effort":if effort == "max" {"xhigh"} else {effort}}});
            } else if model.contains("4.6")
                || model.contains("4.7")
                || model.contains("4-6")
                || model.contains("4-7")
            {
                output["additionalModelRequestFields"] = json!({"thinking":{"type":"adaptive","display":"summarized"},"output_config":{"effort":if effort == "xhigh" && (model.contains("4.6") || model.contains("4-6")) {"high"} else {effort}}});
            } else {
                let budget = match effort {
                    "low" => 1024,
                    "medium" => 4096,
                    "high" => 16000,
                    _ => 32000,
                };
                let content = output["conversationState"]["currentMessage"]["userInputMessage"]
                    ["content"]
                    .as_str()
                    .unwrap_or("");
                output["conversationState"]["currentMessage"]["userInputMessage"]["content"] = json!(format!("<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>{budget}</max_thinking_length>\n\n{content}"));
            }
        }
    }
    let mut config = json!({});
    for (source, target) in [
        ("max_tokens", "maxTokens"),
        ("temperature", "temperature"),
        ("top_p", "topP"),
    ] {
        if let Some(value) = body.get(source) {
            config[target] = value.clone();
        }
    }
    if config.as_object().is_some_and(|object| !object.is_empty()) {
        output["inferenceConfig"] = config;
    }
    Ok(output)
}

fn user_message(content: String, model: &str, results: Vec<Value>) -> Value {
    let mut value =
        json!({"userInputMessage":{"content":content,"modelId":model,"origin":"AI_EDITOR"}});
    if !results.is_empty() {
        value["userInputMessage"]["userInputMessageContext"] = json!({"toolResults":results});
    }
    value
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0xedb88320u32.wrapping_mul(crc & 1));
        }
    }
    !crc
}

fn frame(bytes: &[u8]) -> Result<(String, Value), ProviderError> {
    if bytes.len() < 16 {
        return Err(uncertain("Truncated Kiro frame"));
    }
    let total = u32::from_be_bytes(
        bytes[0..4]
            .try_into()
            .map_err(|_| uncertain("Invalid frame"))?,
    ) as usize;
    let headers = u32::from_be_bytes(
        bytes[4..8]
            .try_into()
            .map_err(|_| uncertain("Invalid frame"))?,
    ) as usize;
    if total != bytes.len() || total > FRAME_LIMIT || headers > 128 * 1024 || headers > total - 16 {
        return Err(uncertain("Invalid Kiro frame bounds"));
    }
    if crc32(&bytes[..8])
        != u32::from_be_bytes(
            bytes[8..12]
                .try_into()
                .map_err(|_| uncertain("Invalid CRC"))?,
        )
        || crc32(&bytes[..total - 4])
            != u32::from_be_bytes(
                bytes[total - 4..]
                    .try_into()
                    .map_err(|_| uncertain("Invalid CRC"))?,
            )
    {
        return Err(uncertain("Kiro frame CRC mismatch"));
    }
    let mut position = 12;
    let end = 12 + headers;
    let mut event = String::new();
    while position < end {
        let name_len = usize::from(bytes[position]);
        position += 1;
        if position + name_len + 3 > end {
            return Err(uncertain("Invalid Kiro event header"));
        }
        let name = &bytes[position..position + name_len];
        position += name_len;
        if bytes[position] != 7 {
            return Err(uncertain("Unsupported Kiro header type"));
        }
        position += 1;
        let length = usize::from(u16::from_be_bytes([bytes[position], bytes[position + 1]]));
        position += 2;
        if position + length > end {
            return Err(uncertain("Invalid Kiro header length"));
        }
        let value = std::str::from_utf8(&bytes[position..position + length])
            .map_err(|_| uncertain("Invalid Kiro header text"))?;
        if name == b":message-type" && matches!(value, "error" | "exception") {
            return Err(uncertain("Kiro returned an upstream event error"));
        }
        if name == b":event-type" {
            event = value.to_owned();
        }
        position += length;
    }
    let payload = serde_json::from_slice(&bytes[end..total - 4])
        .map_err(|_| uncertain("Invalid Kiro event JSON"))?;
    Ok((event, payload))
}

#[derive(Default)]
struct Output {
    text: String,
    reasoning: String,
    tools: BTreeMap<String, (String, String)>,
    usage: Value,
    stop: Option<String>,
}

impl Output {
    fn event(&mut self, kind: &str, payload: Value) -> Result<(), ProviderError> {
        match kind {
            "assistantResponseEvent" | "codeEvent" => {
                if let Some(content) = payload["content"].as_str() {
                    self.text.push_str(content);
                }
            }
            "reasoningContentEvent" => {
                let reasoning = payload.get("reasoningContentEvent").unwrap_or(&payload);
                if let Some(content) = reasoning.as_str().or_else(|| {
                    reasoning["text"]
                        .as_str()
                        .or_else(|| reasoning["content"].as_str())
                }) {
                    self.reasoning.push_str(content);
                }
            }
            "toolUseEvent" => {
                if let Some(values) = payload.as_array() {
                    for value in values {
                        self.event("toolUseEvent", value.clone())?;
                    }
                    return Ok(());
                }
                let id = payload["toolUseId"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| uncertain("Kiro tool is missing its ID"))?;
                let tool = self.tools.entry(id.into()).or_default();
                if let Some(name) = payload["name"].as_str() {
                    if !tool.0.is_empty() && tool.0 != name {
                        return Err(uncertain("Kiro tool name changed"));
                    }
                    tool.0 = name.into();
                }
                if let Some(input) = payload.get("input") {
                    if let Some(fragment) = input.as_str() {
                        tool.1.push_str(fragment);
                    } else if input.is_object() {
                        tool.1.push_str(&input.to_string());
                    } else {
                        return Err(uncertain("Invalid Kiro tool input"));
                    }
                }
            }
            "messageStopEvent" => {
                self.set_stop(
                    payload["stopReason"]
                        .as_str()
                        .or_else(|| payload["stop_reason"].as_str())
                        .unwrap_or(if self.tools.is_empty() {
                            "end_turn"
                        } else {
                            "tool_use"
                        }),
                );
            }
            "metadataEvent" | "MetadataEvent" => {
                let metadata = payload
                    .get("metadataEvent")
                    .or_else(|| payload.get("metadata"))
                    .unwrap_or(&payload);
                if let Some(stop) = metadata["stopReason"].as_str() {
                    self.set_stop(stop);
                }
            }
            "metricsEvent" => {
                let metrics = payload.get("metricsEvent").unwrap_or(&payload);
                if !self.usage.is_object() {
                    self.usage = json!({});
                }
                for (from, to) in [
                    ("inputTokens", "prompt_tokens"),
                    ("outputTokens", "completion_tokens"),
                    ("cacheReadInputTokens", "cache_read_input_tokens"),
                    ("cacheCreationInputTokens", "cache_creation_input_tokens"),
                ] {
                    if let Some(value) = metrics[from].as_u64() {
                        self.usage[to] = json!(value);
                    }
                }
                if let (Some(input), Some(output)) = (
                    self.usage["prompt_tokens"].as_u64(),
                    self.usage["completion_tokens"].as_u64(),
                ) {
                    self.usage["total_tokens"] = json!(input.saturating_add(output));
                }
            }
            "meteringEvent" => {
                let metering = payload.get("meteringEvent").unwrap_or(&payload);
                if let Some(usage) = metering["usage"]
                    .as_f64()
                    .filter(|v| v.is_finite() && *v >= 0.0)
                {
                    if !self.usage.is_object() {
                        self.usage = json!({});
                    }
                    self.usage["kiro_credits"] = json!(usage);
                }
            }
            _ => {}
        }
        if self.text.len()
            + self.reasoning.len()
            + self
                .tools
                .values()
                .map(|tool| tool.0.len() + tool.1.len())
                .sum::<usize>()
            > OUTPUT_LIMIT
        {
            return Err(uncertain("Kiro output exceeded integrity limit"));
        }
        Ok(())
    }
    fn finish(self, model: &str) -> Result<Value, ProviderError> {
        // Native Kiro also terminates with clean HTTP EOF after complete frames,
        // without messageStopEvent. Match that contract only when usable output
        // exists; frame truncation/body-read errors are rejected by the reader.
        let stop = match self.stop.as_deref() {
            Some(stop) => stop,
            None if !self.tools.is_empty() => "tool_use",
            None if !self.text.is_empty() || !self.reasoning.is_empty() => "end_turn",
            None => return Err(uncertain("Kiro ended without output or a terminal event")),
        };
        let mut finish = match stop {
            "end_turn" | "endTurn" | "stop" => "stop",
            "tool_use" | "toolUse" | "tool_calls" => "tool_calls",
            "max_tokens" | "maxTokens" | "model_context_window_exceeded" => "length",
            _ => return Err(uncertain("Kiro ended with a non-success stop reason")),
        };
        let mut message = json!({"role":"assistant","content":self.text});
        if !self.reasoning.is_empty() {
            message["reasoning_content"] = json!(self.reasoning);
        }
        if !self.tools.is_empty() {
            let mut calls = Vec::new();
            for (id, (name, input)) in self.tools {
                let arguments: Value = serde_json::from_str(&input)
                    .map_err(|_| uncertain("Incomplete Kiro tool JSON"))?;
                if name.is_empty() || !arguments.is_object() {
                    return Err(uncertain("Incomplete Kiro tool call"));
                }
                calls.push(
                    json!({"id":id,"type":"function","function":{"name":name,"arguments":input}}),
                );
            }
            message["tool_calls"] = json!(calls);
            finish = "tool_calls";
        }
        Ok(
            json!({"id":format!("chatcmpl-{}",uuid::Uuid::new_v4()),"object":"chat.completion","created":chrono::Utc::now().timestamp(),"model":model,"choices":[{"index":0,"message":message,"finish_reason":finish}],"usage":self.usage}),
        )
    }
    fn set_stop(&mut self, stop: &str) {
        let success = |value: &str| {
            matches!(
                value,
                "end_turn" | "endTurn" | "stop" | "tool_use" | "toolUse" | "tool_calls"
            )
        };
        if self.stop.as_deref().is_none_or(success) {
            self.stop = Some(stop.into());
        }
    }
}

pub(super) async fn read(
    mut response: reqwest::Response,
    model: &str,
) -> Result<Value, ProviderError> {
    let mut buffer = Vec::new();
    let mut output = Output::default();
    let mut total = 0usize;
    loop {
        let chunk = tokio::time::timeout(std::time::Duration::from_secs(60), response.chunk())
            .await
            .map_err(|_| uncertain("Kiro stream stalled"))?
            .map_err(|_| uncertain("Kiro stream read failed"))?;
        let Some(chunk) = chunk else {
            break;
        };
        total = total.saturating_add(chunk.len());
        if total > 64 * 1024 * 1024 || buffer.len() + chunk.len() > FRAME_LIMIT {
            return Err(uncertain("Kiro stream exceeded protocol limit"));
        }
        buffer.extend_from_slice(&chunk);
        while buffer.len() >= 12 {
            let length = u32::from_be_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]) as usize;
            if !(16..=FRAME_LIMIT).contains(&length) {
                return Err(uncertain("Invalid Kiro frame size"));
            }
            if buffer.len() < length {
                break;
            }
            let (kind, payload) = frame(&buffer[..length])?;
            output.event(&kind, payload)?;
            buffer.drain(..length);
        }
    }
    if !buffer.is_empty() {
        return Err(uncertain("Truncated Kiro event stream"));
    }
    output.finish(model)
}

/// Emit text only after its complete frame passes both CRCs. Tool arguments stay
/// private until their JSON and the terminal disposition have been validated.
pub(super) fn stream(response: reqwest::Response, model: &str) -> axum::body::Body {
    struct State {
        response: reqwest::Response,
        model: String,
        id: String,
        buffer: Vec<u8>,
        output: Output,
        total: usize,
        finished: bool,
    }
    let state = State {
        response,
        model: model.into(),
        id: format!("chatcmpl-{}", uuid::Uuid::new_v4()),
        buffer: Vec::new(),
        output: Output::default(),
        total: 0,
        finished: false,
    };
    axum::body::Body::from_stream(futures_util::stream::try_unfold(
        state,
        |mut state| async move {
            if state.finished {
                return Ok::<_, std::io::Error>(None);
            }
            let failure = |error: ProviderError| std::io::Error::other(error.to_string());
            loop {
                if state.buffer.len() >= 12 {
                    let length = u32::from_be_bytes([
                        state.buffer[0],
                        state.buffer[1],
                        state.buffer[2],
                        state.buffer[3],
                    ]) as usize;
                    if !(16..=FRAME_LIMIT).contains(&length) {
                        return Err(failure(uncertain("Invalid Kiro frame size")));
                    }
                    if state.buffer.len() >= length {
                        let (kind, payload) = frame(&state.buffer[..length]).map_err(failure)?;
                        state.buffer.drain(..length);
                        state
                            .output
                            .event(&kind, payload.clone())
                            .map_err(failure)?;
                        let delta = match kind.as_str() {
                            "assistantResponseEvent" | "codeEvent" => payload["content"]
                                .as_str()
                                .map(|text| json!({"role":"assistant","content":text})),
                            "reasoningContentEvent" => {
                                let reasoning =
                                    payload.get("reasoningContentEvent").unwrap_or(&payload);
                                reasoning
                                    .as_str()
                                    .or_else(|| reasoning["text"].as_str())
                                    .or_else(|| reasoning["content"].as_str())
                                    .map(
                                        |text| json!({"role":"assistant","reasoning_content":text}),
                                    )
                            }
                            _ => None,
                        };
                        if let Some(delta) = delta {
                            let event = json!({"id":state.id,"object":"chat.completion.chunk","model":state.model,"choices":[{"index":0,"delta":delta,"finish_reason":null}]});
                            return Ok(Some((
                                bytes::Bytes::from(format!("data: {event}\n\n")),
                                state,
                            )));
                        }
                        continue;
                    }
                }
                let chunk = tokio::time::timeout(
                    std::time::Duration::from_secs(60),
                    state.response.chunk(),
                )
                .await
                .map_err(|_| failure(uncertain("Kiro stream stalled")))?
                .map_err(|_| failure(uncertain("Kiro stream read failed")))?;
                if let Some(chunk) = chunk {
                    state.total = state.total.saturating_add(chunk.len());
                    if state.total > 64 * 1024 * 1024
                        || state.buffer.len() + chunk.len() > FRAME_LIMIT
                    {
                        return Err(failure(uncertain("Kiro stream exceeded protocol limit")));
                    }
                    state.buffer.extend_from_slice(&chunk);
                    continue;
                }
                if !state.buffer.is_empty() {
                    return Err(failure(uncertain("Truncated Kiro event stream")));
                }
                let value = std::mem::take(&mut state.output)
                    .finish(&state.model)
                    .map_err(failure)?;
                let mut delta = json!({});
                if let Some(calls) = value["choices"][0]["message"]["tool_calls"].as_array() {
                    let mut calls = calls.clone();
                    for (index, call) in calls.iter_mut().enumerate() {
                        call["index"] = json!(index);
                    }
                    delta["tool_calls"] = json!(calls);
                }
                let last = json!({"id":state.id,"object":"chat.completion.chunk","model":state.model,"choices":[{"index":0,"delta":delta,"finish_reason":value["choices"][0]["finish_reason"]}],"usage":value["usage"]});
                state.finished = true;
                return Ok(Some((
                    bytes::Bytes::from(format!("data: {last}\n\ndata: [DONE]\n\n")),
                    state,
                )));
            }
        },
    ))
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;

    pub(crate) fn encode(kind: &str, payload: Value) -> Vec<u8> {
        let mut headers = Vec::new();
        for (name, value) in [(":message-type", "event"), (":event-type", kind)] {
            headers.push(name.len() as u8);
            headers.extend_from_slice(name.as_bytes());
            headers.push(7);
            headers.extend_from_slice(&(value.len() as u16).to_be_bytes());
            headers.extend_from_slice(value.as_bytes());
        }
        let payload = payload.to_string();
        let total = 16 + headers.len() + payload.len();
        let mut frame = Vec::new();
        frame.extend_from_slice(&(total as u32).to_be_bytes());
        frame.extend_from_slice(&(headers.len() as u32).to_be_bytes());
        frame.extend_from_slice(&crc32(&frame).to_be_bytes());
        frame.extend_from_slice(&headers);
        frame.extend_from_slice(payload.as_bytes());
        frame.extend_from_slice(&crc32(&frame).to_be_bytes());
        frame
    }

    #[test]
    fn checks_both_crc_and_bounds_before_json() {
        let valid = encode("assistantResponseEvent", json!({"content":"hello"}));
        assert_eq!(frame(&valid).unwrap().0, "assistantResponseEvent");
        for position in [0, 8, valid.len() - 5, valid.len() - 1] {
            let mut corrupt = valid.clone();
            corrupt[position] ^= 1;
            assert!(frame(&corrupt).is_err());
        }
        assert!(frame(&valid[..valid.len() - 1]).is_err());
    }

    #[test]
    fn native_request_keeps_tool_history_system_and_profile() {
        let input = json!({"messages":[{"role":"system","content":"Follow rules"},{"role":"user","content":"lookup"},{"role":"assistant","content":null,"tool_calls":[{"id":"call1","function":{"name":"lookup","arguments":"{\"q\":\"x\"}"}}]},{"role":"tool","tool_call_id":"call1","content":"found"}],"tools":[{"type":"function","function":{"name":"lookup","parameters":{"type":"object"}}}]});
        let native = request(
            "claude-sonnet-4",
            &input,
            Some("stable"),
            Some("arn:aws:codewhisperer:us-east-1:123:profile/a"),
        )
        .unwrap();
        assert_eq!(native["conversationState"]["conversationId"], "stable");
        assert_eq!(
            native["conversationState"]["history"][0]["userInputMessage"]["content"],
            "Follow rules\n\nlookup"
        );
        assert_eq!(
            native["conversationState"]["history"][1]["assistantResponseMessage"]["toolUses"][0]
                ["input"],
            json!({"q":"x"})
        );
        assert_eq!(
            native["conversationState"]["currentMessage"]["userInputMessage"]
                ["userInputMessageContext"]["toolResults"][0]["toolUseId"],
            "call1"
        );
        assert!(native.get("systemPrompt").is_none());
    }

    #[test]
    fn fragmented_tools_require_valid_json_and_explicit_stop() {
        let mut output = Output::default();
        output
            .event(
                "toolUseEvent",
                json!({"toolUseId":"t","name":"lookup","input":"{\"q\":"}),
            )
            .unwrap();
        output
            .event(
                "toolUseEvent",
                json!({"toolUseId":"t","input":"\"x\"}","stop":true}),
            )
            .unwrap();
        output
            .event("messageStopEvent", json!({"stopReason":"tool_use"}))
            .unwrap();
        assert_eq!(
            output.finish("m").unwrap()["choices"][0]["message"]["tool_calls"][0]["function"]
                ["arguments"],
            "{\"q\":\"x\"}"
        );
        assert!(Output::default().finish("m").is_err());
        let mut eof = Output::default();
        eof.event("assistantResponseEvent", json!({"content":"clean EOF"}))
            .unwrap();
        assert_eq!(
            eof.finish("m").unwrap()["choices"][0]["finish_reason"],
            "stop"
        );
        let mut cancelled = Output::default();
        cancelled
            .event("messageStopEvent", json!({"stopReason":"cancelled"}))
            .unwrap();
        assert!(cancelled.finish("m").is_err());
    }

    #[test]
    fn usage_is_only_observed_not_estimated() {
        let mut output = Output::default();
        output.event("messageStopEvent", json!({})).unwrap();
        assert!(output.finish("m").unwrap()["usage"].is_null());
        let mut output = Output::default();
        output
            .event(
                "metricsEvent",
                json!({"inputTokens":8,"outputTokens":3,"cacheReadInputTokens":2}),
            )
            .unwrap();
        output.event("messageStopEvent", json!({})).unwrap();
        assert_eq!(output.finish("m").unwrap()["usage"]["total_tokens"], 11);
    }
}
