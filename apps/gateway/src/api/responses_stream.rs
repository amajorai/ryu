//! Translate Chat Completions SSE chunks into Responses semantic events.

use std::{
    collections::BTreeMap,
    io,
    time::{SystemTime, UNIX_EPOCH},
};

use axum::body::{Body, Bytes};
use futures_util::{stream, Stream, StreamExt};
use serde_json::{json, Value};

use crate::{
    compat::responses::{
        chat_incomplete_reason, chat_usage_to_responses, missing_logprobs_error, response_item_id,
        response_shell, ResponseEnvelope,
    },
    responses_store::{ResponseOwner, ResponsesStore},
};

struct MessageState {
    item_id: String,
    output_index: usize,
    text: String,
    refusal: String,
    text_index: Option<usize>,
    refusal_index: Option<usize>,
    next_content_index: usize,
}

#[derive(Clone, Copy)]
enum ContentKind {
    Text,
    Refusal,
}

struct FunctionCallState {
    item_id: String,
    call_id: String,
    name: String,
    arguments: String,
    output_index: Option<usize>,
}

struct ResponsesStreamState {
    envelope: ResponseEnvelope,
    model_used: String,
    history: Vec<Value>,
    owner: ResponseOwner,
    store: ResponsesStore,
    output_items: BTreeMap<usize, Value>,
    message: Option<MessageState>,
    function_calls: BTreeMap<usize, FunctionCallState>,
    next_output_index: usize,
    sequence_number: u64,
    usage: Option<Value>,
    finish_reason: Option<String>,
    /// Provider token logprobs for the output text, kept only when requested.
    /// `None` until the provider sends any.
    text_logprobs: Option<Vec<Value>>,
    started: bool,
    finished: bool,
}

impl ResponsesStreamState {
    fn new(
        envelope: ResponseEnvelope,
        model_used: String,
        history: Vec<Value>,
        owner: ResponseOwner,
        store: ResponsesStore,
    ) -> Self {
        Self {
            envelope,
            model_used,
            history,
            owner,
            store,
            output_items: BTreeMap::new(),
            message: None,
            function_calls: BTreeMap::new(),
            next_output_index: 0,
            sequence_number: 0,
            usage: None,
            finish_reason: None,
            text_logprobs: None,
            started: false,
            finished: false,
        }
    }

    fn start_events(&mut self) -> String {
        let response = response_shell(&self.envelope, &self.model_used, "in_progress");
        let mut output = self.event("response.created", json!({ "response": response }));
        let response = response_shell(&self.envelope, &self.model_used, "in_progress");
        output.push_str(&self.event("response.in_progress", json!({ "response": response })));
        for item in self.envelope.hosted_output.clone() {
            let index = self.allocate_output_index();
            let mut pending = item.clone();
            pending["status"] = json!("in_progress");
            output.push_str(&self.event(
                "response.output_item.added",
                json!({"output_index":index,"item":pending}),
            ));
            if item["status"] == "completed" {
                output.push_str(&self.event(
                    "response.web_search_call.searching",
                    json!({"item_id":item["id"],"output_index":index}),
                ));
            }
            self.output_items.insert(index, item.clone());
            output.push_str(&self.event(
                "response.output_item.done",
                json!({"output_index":index,"item":item}),
            ));
        }
        output
    }

    fn event(&mut self, event_type: &str, mut fields: Value) -> String {
        self.sequence_number = self.sequence_number.saturating_add(1);
        fields["type"] = Value::String(event_type.to_owned());
        fields["sequence_number"] = json!(self.sequence_number);
        format!("event: {event_type}\ndata: {fields}\n\n")
    }

    fn accept_chunk(&mut self, chunk: &Value) -> String {
        if let Some(usage) = chunk.get("usage") {
            self.usage = Some(usage.clone());
        }
        let Some(choice) = chunk
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|choices| choices.first())
        else {
            return String::new();
        };
        let delta = choice.get("delta").unwrap_or(&Value::Null);
        let mut output = String::new();
        let chunk_logprobs = if self.envelope.logprobs {
            choice
                .pointer("/logprobs/content")
                .and_then(Value::as_array)
                .cloned()
        } else {
            None
        };
        if let Some(entries) = &chunk_logprobs {
            self.text_logprobs
                .get_or_insert_with(Vec::new)
                .extend(entries.iter().cloned());
        }

        if let Some(text) = delta.get("content").and_then(Value::as_str) {
            if !text.is_empty() {
                output.push_str(&self.push_text(text, chunk_logprobs));
            }
        }
        if let Some(refusal) = delta.get("refusal").and_then(Value::as_str) {
            if !refusal.is_empty() {
                output.push_str(&self.push_refusal(refusal));
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
            for (position, call) in calls.iter().enumerate() {
                output.push_str(
                    &self.push_function_call(
                        call,
                        call.get("index")
                            .and_then(Value::as_u64)
                            .unwrap_or(position as u64) as usize,
                    ),
                );
            }
        }
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }
        output
    }

    fn ensure_message(&mut self) -> String {
        if self.message.is_some() {
            return String::new();
        }

        let output_index = self.allocate_output_index();
        let item_id = response_item_id("msg");
        let item = json!({
            "id": item_id,
            "type": "message",
            "status": "in_progress",
            "role": "assistant",
            "content": [],
        });
        self.output_items.insert(output_index, item.clone());
        self.message = Some(MessageState {
            item_id: item_id.clone(),
            output_index,
            text: String::new(),
            refusal: String::new(),
            text_index: None,
            refusal_index: None,
            next_content_index: 0,
        });
        self.event(
            "response.output_item.added",
            json!({ "output_index": output_index, "item": item }),
        )
    }

    fn ensure_content_part(&mut self, kind: ContentKind) -> (String, usize, String, usize) {
        let mut output = self.ensure_message();
        let (output_index, item_id, existing_index, content_index) = {
            let message = self.message.as_mut().expect("message was initialized");
            let existing_index = match kind {
                ContentKind::Text => message.text_index,
                ContentKind::Refusal => message.refusal_index,
            };
            let content_index = existing_index.unwrap_or_else(|| {
                let index = message.next_content_index;
                message.next_content_index += 1;
                match kind {
                    ContentKind::Text => message.text_index = Some(index),
                    ContentKind::Refusal => message.refusal_index = Some(index),
                }
                index
            });
            (
                message.output_index,
                message.item_id.clone(),
                existing_index,
                content_index,
            )
        };
        if existing_index.is_none() {
            let part = match kind {
                ContentKind::Text => {
                    json!({ "type": "output_text", "text": "", "annotations": [] })
                }
                ContentKind::Refusal => json!({ "type": "refusal", "refusal": "" }),
            };
            if let Some(item) = self.output_items.get_mut(&output_index) {
                item["content"]
                    .as_array_mut()
                    .expect("message content array")
                    .push(part.clone());
            }
            output.push_str(&self.event(
                "response.content_part.added",
                json!({
                    "item_id": item_id,
                    "output_index": output_index,
                        "content_index": content_index,
                        "part": part,
                }),
            ));
        }
        (output, output_index, item_id, content_index)
    }

    fn push_text(&mut self, text: &str, logprobs: Option<Vec<Value>>) -> String {
        let (mut output, output_index, item_id, content_index) =
            self.ensure_content_part(ContentKind::Text);
        if let Some(message) = &mut self.message {
            message.text.push_str(text);
        }
        let mut fields = json!({
            "item_id": item_id,
            "output_index": output_index,
            "content_index": content_index,
            "delta": text,
        });
        if self.envelope.logprobs {
            fields["logprobs"] = Value::Array(logprobs.unwrap_or_default());
        }
        output.push_str(&self.event("response.output_text.delta", fields));
        output
    }

    fn push_refusal(&mut self, text: &str) -> String {
        let (mut output, output_index, item_id, content_index) =
            self.ensure_content_part(ContentKind::Refusal);
        if let Some(message) = &mut self.message {
            message.refusal.push_str(text);
        }
        output.push_str(&self.event(
            "response.refusal.delta",
            json!({
                "item_id": item_id,
                "output_index": output_index,
                "content_index": content_index,
                "delta": text,
            }),
        ));
        output
    }

    fn push_function_call(&mut self, call: &Value, index: usize) -> String {
        {
            let state = self
                .function_calls
                .entry(index)
                .or_insert_with(|| FunctionCallState {
                    item_id: response_item_id("fc"),
                    call_id: String::new(),
                    name: String::new(),
                    arguments: String::new(),
                    output_index: None,
                });
            if let Some(id) = call.get("id").and_then(Value::as_str) {
                if !id.is_empty() {
                    state.call_id = id.to_owned();
                }
            }
            if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                state.name.push_str(name);
            }
            let arguments = call
                .pointer("/function/arguments")
                .and_then(Value::as_str)
                .unwrap_or_default();
            state.arguments.push_str(arguments);
        }
        let arguments = call
            .pointer("/function/arguments")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut output = String::new();

        let should_start = self.function_calls.get(&index).is_some_and(|state| {
            state.output_index.is_none()
                && !state.call_id.is_empty()
                && !state.name.is_empty()
                && !state.arguments.is_empty()
        });
        if should_start {
            let output_index = self.allocate_output_index();
            let (item_id, call_id, name, accumulated_arguments) = {
                let state = self
                    .function_calls
                    .get_mut(&index)
                    .expect("call was inserted");
                state.output_index = Some(output_index);
                (
                    state.item_id.clone(),
                    state.call_id.clone(),
                    state.name.clone(),
                    state.arguments.clone(),
                )
            };
            let mut item = json!({
                "id": item_id,
                "type": "function_call",
                "status": "in_progress",
                "call_id": call_id,
                "name": name,
                "arguments": "",
            });
            self.envelope.tool_registry.output_start(&mut item);
            self.output_items.insert(output_index, item.clone());
            let mut output = self.event(
                "response.output_item.added",
                json!({ "output_index": output_index, "item": item }),
            );
            if !accumulated_arguments.is_empty() && !self.envelope.tool_registry.custom_wire(&name)
            {
                output.push_str(&self.function_arguments_delta(
                    item_id,
                    output_index,
                    &accumulated_arguments,
                ));
            }
            return output;
        }

        if let Some((output_index, item_id)) = self.function_calls.get(&index).and_then(|state| {
            state
                .output_index
                .map(|index| (index, state.item_id.clone()))
        }) {
            if !arguments.is_empty()
                && !self
                    .function_calls
                    .get(&index)
                    .is_some_and(|state| self.envelope.tool_registry.custom_wire(&state.name))
            {
                output.push_str(&self.function_arguments_delta(item_id, output_index, arguments));
            }
        }
        output
    }

    fn function_arguments_delta(
        &mut self,
        item_id: String,
        output_index: usize,
        delta: &str,
    ) -> String {
        self.event(
            "response.function_call_arguments.delta",
            json!({ "item_id": item_id, "output_index": output_index, "delta": delta }),
        )
    }

    fn allocate_output_index(&mut self) -> usize {
        let index = self.next_output_index;
        self.next_output_index = self.next_output_index.saturating_add(1);
        index
    }

    fn complete(&mut self) -> String {
        if self.finished {
            return String::new();
        }

        let text_logprobs = if self.envelope.logprobs
            && self
                .message
                .as_ref()
                .is_some_and(|message| !message.text.is_empty())
        {
            match self.text_logprobs.take() {
                Some(entries) => Some(entries),
                None => return self.fail(&missing_logprobs_error()),
            }
        } else {
            None
        };
        let mut output = String::new();
        let mut assistant = json!({ "role": "assistant", "content": "" });
        if let Some(message) = self.message.take() {
            assistant["content"] = if !message.text.is_empty() {
                Value::String(message.text.clone())
            } else if !message.refusal.is_empty() {
                Value::String(message.refusal.clone())
            } else {
                Value::Null
            };
            let mut parts = Vec::new();
            if let Some(index) = message.text_index {
                let mut part = json!({
                    "type": "output_text",
                    "text": message.text,
                    "annotations": [],
                });
                if let Some(entries) = &text_logprobs {
                    part["logprobs"] = Value::Array(entries.clone());
                }
                parts.push((index, part));
            }
            if let Some(index) = message.refusal_index {
                parts.push((
                    index,
                    json!({ "type": "refusal", "refusal": message.refusal }),
                ));
            }
            parts.sort_by_key(|(index, _)| *index);
            for (content_index, part) in &parts {
                if part["type"] == "output_text" {
                    let mut fields = json!({
                        "item_id": message.item_id,
                        "output_index": message.output_index,
                        "content_index": content_index,
                        "text": part["text"],
                    });
                    if let Some(entries) = part.get("logprobs") {
                        fields["logprobs"] = entries.clone();
                    }
                    output.push_str(&self.event("response.output_text.done", fields));
                } else {
                    output.push_str(&self.event(
                        "response.refusal.done",
                        json!({
                            "item_id": message.item_id,
                            "output_index": message.output_index,
                            "content_index": content_index,
                            "refusal": part["refusal"],
                        }),
                    ));
                }
                output.push_str(&self.event(
                    "response.content_part.done",
                    json!({
                        "item_id": message.item_id,
                        "output_index": message.output_index,
                        "content_index": content_index,
                        "part": part,
                    }),
                ));
            }
            let content = parts.into_iter().map(|(_, part)| part).collect::<Vec<_>>();
            let item = json!({
                "id": message.item_id,
                "type": "message",
                "status": "completed",
                "role": "assistant",
                "content": content,
            });
            self.output_items.insert(message.output_index, item.clone());
            output.push_str(&self.event(
                "response.output_item.done",
                json!({ "output_index": message.output_index, "item": item }),
            ));
        }

        let pending_calls = self
            .function_calls
            .iter()
            .filter_map(|(index, state)| state.output_index.is_none().then_some(*index))
            .collect::<Vec<_>>();
        for index in pending_calls {
            let (item_id, mut call_id, name, arguments) = {
                let state = self.function_calls.get(&index).expect("call index exists");
                (
                    state.item_id.clone(),
                    state.call_id.clone(),
                    state.name.clone(),
                    state.arguments.clone(),
                )
            };
            if name.trim().is_empty() {
                return self.fail("upstream returned a function call without a name");
            }
            if call_id.is_empty() {
                call_id = response_item_id("call");
            }
            let output_index = self.allocate_output_index();
            if let Some(state) = self.function_calls.get_mut(&index) {
                state.output_index = Some(output_index);
                state.call_id = call_id.clone();
            }
            let mut item = json!({
                "id": item_id,
                "type": "function_call",
                "status": "in_progress",
                "call_id": call_id,
                "name": name,
                "arguments": "",
            });
            self.envelope.tool_registry.output_start(&mut item);
            self.output_items.insert(output_index, item.clone());
            output.push_str(&self.event(
                "response.output_item.added",
                json!({ "output_index": output_index, "item": item }),
            ));
            if !arguments.is_empty() && !self.envelope.tool_registry.custom_wire(&name) {
                output.push_str(&self.function_arguments_delta(item_id, output_index, &arguments));
            }
        }

        let mut function_calls = self
            .function_calls
            .iter()
            .filter_map(|(index, state)| {
                state
                    .output_index
                    .map(|output_index| (*index, output_index))
            })
            .collect::<Vec<_>>();
        function_calls.sort_by_key(|(_, output_index)| *output_index);
        for (index, output_index) in function_calls {
            let (item_id, call_id, name, arguments) = {
                let state = self.function_calls.get(&index).expect("call index exists");
                (
                    state.item_id.clone(),
                    state.call_id.clone(),
                    state.name.clone(),
                    state.arguments.clone(),
                )
            };
            let mut item = json!({
                "id": item_id,
                "type": "function_call",
                "status": "completed",
                "call_id": call_id,
                "name": name,
                "arguments": arguments,
            });
            if let Err(error) = self.envelope.tool_registry.output_call(&mut item) {
                return self.fail(&error);
            }
            let mut tool_calls = assistant
                .get("tool_calls")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            tool_calls.push(json!({
                "id": call_id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": arguments,
                },
            }));
            assistant["tool_calls"] = Value::Array(tool_calls);
            self.output_items.insert(output_index, item.clone());
            if item["type"] == "custom_tool_call" {
                let input = item["input"].clone();
                output.push_str(&self.event(
                    "response.custom_tool_call_input.delta",
                    json!({"item_id":item_id,"output_index":output_index,"delta":input}),
                ));
                output.push_str(&self.event(
                    "response.custom_tool_call_input.done",
                    json!({"item_id":item_id,"output_index":output_index,"input":input}),
                ));
            } else {
                output.push_str(&self.event(
                    "response.function_call_arguments.done",
                    json!({"item_id":item_id,"output_index":output_index,"arguments":arguments}),
                ));
            }
            output.push_str(&self.event(
                "response.output_item.done",
                json!({ "output_index": output_index, "item": item }),
            ));
        }

        self.history.push(assistant);
        let incomplete_reason = self
            .finish_reason
            .as_deref()
            .and_then(chat_incomplete_reason);
        let status = if incomplete_reason.is_some() {
            "incomplete"
        } else {
            "completed"
        };
        let mut response = response_shell(&self.envelope, &self.model_used, status);
        response["completed_at"] = json!(unix_time());
        response["output"] = Value::Array(self.output_items.values().cloned().collect());
        response["usage"] = chat_usage_to_responses(self.usage.as_ref());
        if let Some(reason) = incomplete_reason {
            response["incomplete_details"] = json!({ "reason": reason });
        }
        if self.envelope.store
            && !self.store.insert(
                self.envelope.id.clone(),
                self.owner.clone(),
                self.history.clone(),
            )
        {
            response["store"] = Value::Bool(false);
        }
        let event = if status == "incomplete" {
            "response.incomplete"
        } else {
            "response.completed"
        };
        output.push_str(&self.event(event, json!({ "response": response })));
        self.finished = true;
        output
    }

    fn fail(&mut self, message: &str) -> String {
        self.failed(json!({ "code": "upstream_error", "message": message }))
    }

    /// End the response with a standing refusal the gateway sent in band.
    /// Only the 00.7 fields are copied, so the client sees the same code,
    /// message and appeal or retry detail a refused request would carry.
    fn refuse(&mut self, error: &serde_json::Map<String, Value>) -> String {
        let mut detail = serde_json::Map::new();
        for field in REFUSAL_FIELDS {
            if let Some(value) = error.get(*field) {
                detail.insert((*field).to_owned(), value.clone());
            }
        }
        self.failed(Value::Object(detail))
    }

    fn failed(&mut self, error: Value) -> String {
        if self.finished {
            return String::new();
        }
        let mut response = response_shell(&self.envelope, &self.model_used, "failed");
        response["completed_at"] = json!(unix_time());
        response["error"] = error;
        let event = self.event("response.failed", json!({ "response": response }));
        self.finished = true;
        event
    }
}

/// The 00.7 error fields a standing refusal carries into `response.error`.
const REFUSAL_FIELDS: &[&str] = &[
    "code",
    "message",
    "type",
    "layer",
    "remedy",
    "appeal_url",
    "reason_class",
    "until",
    "retry_after",
];

pub(super) fn translate_chat_stream(
    body: Body,
    envelope: ResponseEnvelope,
    model_used: String,
    history: Vec<Value>,
    owner: ResponseOwner,
    store: ResponsesStore,
) -> impl Stream<Item = Result<Bytes, io::Error>> + Send + 'static {
    let inner = body.into_data_stream();
    stream::unfold(
        (
            inner,
            Vec::<u8>::new(),
            ResponsesStreamState::new(envelope, model_used, history, owner, store),
        ),
        |(mut inner, mut pending, mut state)| async move {
            if state.finished {
                return None;
            }
            if !state.started {
                state.started = true;
                let events = state.start_events();
                return Some((Ok(Bytes::from(events)), (inner, pending, state)));
            }

            loop {
                if let Some(split_at) = pending.iter().position(|byte| *byte == b'\n') {
                    let line: Vec<u8> = pending.drain(..=split_at).collect();
                    let line = String::from_utf8_lossy(&line);
                    if let Some(events) = process_sse_line(&mut state, line.trim()) {
                        if !events.is_empty() {
                            return Some((Ok(Bytes::from(events)), (inner, pending, state)));
                        }
                        if state.finished {
                            return None;
                        }
                    }
                    continue;
                }

                match inner.next().await {
                    Some(Ok(chunk)) => pending.extend_from_slice(&chunk),
                    Some(Err(_)) => {
                        let events = state.fail("upstream stream failed");
                        return Some((Ok(Bytes::from(events)), (inner, pending, state)));
                    }
                    None => {
                        if !pending.is_empty() {
                            let line = String::from_utf8_lossy(&pending).to_string();
                            pending.clear();
                            if let Some(events) = process_sse_line(&mut state, line.trim()) {
                                if !events.is_empty() {
                                    return Some((
                                        Ok(Bytes::from(events)),
                                        (inner, pending, state),
                                    ));
                                }
                            }
                        }
                        if state.finished {
                            return None;
                        }
                        if state.finish_reason.is_some() {
                            let events = state.complete();
                            return Some((Ok(Bytes::from(events)), (inner, pending, state)));
                        }
                        let events = state.fail("upstream stream ended before completion");
                        return Some((Ok(Bytes::from(events)), (inner, pending, state)));
                    }
                }
            }
        },
    )
}

fn process_sse_line(state: &mut ResponsesStreamState, line: &str) -> Option<String> {
    let data = line.trim().strip_prefix("data:")?.trim();
    if data == "[DONE]" {
        return Some(state.complete());
    }
    let Ok(chunk) = serde_json::from_str::<Value>(data) else {
        return Some(state.fail("upstream returned an invalid stream event"));
    };
    if let Some(error) = crate::standing::refusal_frame_error(&chunk) {
        // This gateway's own mid-stream standing refusal: keep its 00.7
        // code and detail rather than blaming the upstream.
        return Some(state.refuse(error));
    }
    if chunk.get("error").is_some() {
        return Some(state.fail("upstream returned a stream error"));
    }
    Some(state.accept_chunk(&chunk))
}

fn unix_time() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
#[path = "responses_stream_tests.rs"]
mod tests;
