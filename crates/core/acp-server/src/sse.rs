//! Decoder for Core's chat stream: AI SDK v6 UI-message-stream SSE.
//!
//! Each event is one `data: {json}` line with a `type` discriminator; the stream
//! ends with `data: [DONE]`. This is the same vocabulary `apps/cli`'s
//! `chatStream.ts` and Core's own internal drains read. Only the frames ACP has a
//! home for are decoded; everything else (text-start/end, usage stats, widget and
//! workflow parts) is dropped as [`CoreEvent::Ignored`].
//!
//! A `finish` frame is deliberately NOT terminal: one Core response may carry
//! several assistant messages (e.g. a plugin hook reply followed by the model's
//! turn) but only ever one `[DONE]`.

use agent_client_protocol::schema::v1::ToolCallStatus;
use serde_json::Value;

/// One decoded stream event.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CoreEvent {
    TextDelta(String),
    ReasoningDelta(String),
    /// A tool call opened before its arguments are known.
    ToolInputStart {
        id: String,
        name: String,
    },
    /// A tool call with its arguments (may repeat to refine them).
    ToolInput {
        id: String,
        name: String,
        input: Value,
    },
    /// A tool call progressed or finished. Core sends one of these for every
    /// ACP `tool_call_update`, including non-final ones, so `status` is not
    /// always terminal.
    ToolOutput {
        id: String,
        output: Value,
        status: ToolCallStatus,
    },
    /// A Question card Core minted itself (an elicitation or the `ask_user`
    /// tool), so it registered an answer waiter. Unless `input.async` is true,
    /// Core blocks the agent until `/api/chat/question` answers it. An agent's
    /// own question tool that Core merely reshaped into a Question card has no
    /// waiter and decodes as an ordinary [`CoreEvent::ToolInput`].
    Question {
        id: String,
        input: Value,
    },
    /// Core paused the run for a tool approval. `tool_call` and `options` are the
    /// ACP `ToolCallUpdate` / `PermissionOption[]` JSON Core received.
    Permission {
        request_id: String,
        tool_call: Value,
        options: Value,
    },
    /// A stream-level error; the turn is over.
    Error(String),
    /// `[DONE]`.
    Done,
    Ignored,
}

fn str_field(frame: &Value, key: &str) -> Option<String> {
    frame.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn non_empty_str_field(frame: &Value, key: &str) -> Option<String> {
    str_field(frame, key).filter(|value| !value.is_empty())
}

/// Decode one SSE line. Non-`data:` lines (comments, `event:`, blanks) and
/// malformed JSON are ignored, matching the CLI's tolerant reader.
pub(crate) fn decode_line(line: &str) -> CoreEvent {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let Some(data) = line.strip_prefix("data:") else {
        return CoreEvent::Ignored;
    };
    let data = data.trim();
    if data.is_empty() {
        return CoreEvent::Ignored;
    }
    if data == "[DONE]" {
        return CoreEvent::Done;
    }
    let Ok(frame) = serde_json::from_str::<Value>(data) else {
        return CoreEvent::Ignored;
    };
    decode_frame(&frame)
}

fn decode_frame(frame: &Value) -> CoreEvent {
    let Some(kind) = frame.get("type").and_then(Value::as_str) else {
        return CoreEvent::Ignored;
    };
    match kind {
        "text-delta" => str_field(frame, "delta")
            .map(CoreEvent::TextDelta)
            .unwrap_or(CoreEvent::Ignored),
        "reasoning-delta" => str_field(frame, "delta")
            .or_else(|| str_field(frame, "reasoning"))
            .map(CoreEvent::ReasoningDelta)
            .unwrap_or(CoreEvent::Ignored),
        "tool-input-start" => match str_field(frame, "toolCallId") {
            Some(id) => CoreEvent::ToolInputStart {
                id,
                name: non_empty_str_field(frame, "toolName").unwrap_or_else(|| "tool".to_owned()),
            },
            None => CoreEvent::Ignored,
        },
        "tool-input-available" => match str_field(frame, "toolCallId") {
            Some(id)
                if str_field(frame, "toolName").as_deref() == Some("Question")
                    && frame.get("input").is_some_and(is_core_question) =>
            {
                CoreEvent::Question {
                    id,
                    input: frame.get("input").cloned().unwrap_or(Value::Null),
                }
            }
            Some(id) => CoreEvent::ToolInput {
                id,
                name: non_empty_str_field(frame, "toolName").unwrap_or_else(|| "tool".to_owned()),
                input: frame.get("input").cloned().unwrap_or(Value::Null),
            },
            None => CoreEvent::Ignored,
        },
        "tool-output-available" => match str_field(frame, "toolCallId") {
            Some(id) => {
                let (output, status) = tool_output(frame);
                CoreEvent::ToolOutput { id, output, status }
            }
            None => CoreEvent::Ignored,
        },
        "tool-output-error" => match str_field(frame, "toolCallId") {
            Some(id) => CoreEvent::ToolOutput {
                id,
                output: Value::String(
                    non_empty_str_field(frame, "errorText")
                        .unwrap_or_else(|| "tool failed".to_owned()),
                ),
                status: ToolCallStatus::Failed,
            },
            None => CoreEvent::Ignored,
        },
        "data-ryu-permission" => {
            let data = frame.get("data").cloned().unwrap_or(Value::Null);
            match data.get("requestId").and_then(Value::as_str) {
                Some(request_id) if !request_id.is_empty() => CoreEvent::Permission {
                    request_id: request_id.to_owned(),
                    tool_call: data.get("toolCall").cloned().unwrap_or(Value::Null),
                    options: data.get("options").cloned().unwrap_or(Value::Null),
                },
                _ => CoreEvent::Ignored,
            }
        }
        "error" => CoreEvent::Error(
            non_empty_str_field(frame, "errorText")
                .or_else(|| non_empty_str_field(frame, "error"))
                .unwrap_or_else(|| "Ryu reported a stream error".to_owned()),
        ),
        _ => CoreEvent::Ignored,
    }
}

/// Whether a Question card's input is one Core minted with an answer waiter:
/// the `ask_user` tool always states `async`, and an elicitation carries its
/// `schema`. A reshaped agent question tool has neither.
fn is_core_question(input: &Value) -> bool {
    input.get("async").is_some_and(Value::is_boolean) || input.get("schema").is_some()
}

/// Split a `tool-output-available` frame into its body and ACP status. The
/// status may sit on the frame or inside the output object (mirrors the CLI's
/// `toolOutputPayload`). Core wraps every ACP `tool_call_update` as
/// `{status, output}`, and non-final updates (`in_progress`, `pending`) must
/// not close the call in the editor. A bare output has no status and is final.
fn tool_output(frame: &Value) -> (Value, ToolCallStatus) {
    let raw = frame.get("output").cloned().unwrap_or(Value::Null);
    if let Some(status) = non_empty_str_field(frame, "status") {
        return (raw, wire_status(&status, true));
    }
    if let Some(object) = raw.as_object() {
        if let Some(status) = object.get("status").and_then(Value::as_str) {
            // Only Core's `{status, output}` wrapper can report a non-final
            // state: a native tool's own result object may carry an unrelated
            // `status` field (e.g. a queued job), which must still end the call.
            let wrapper = object.contains_key("output");
            let body = object.get("output").cloned().unwrap_or_else(|| raw.clone());
            return (body, wire_status(status, wrapper));
        }
        if object.get("isError").and_then(Value::as_bool) == Some(true) {
            return (raw, ToolCallStatus::Failed);
        }
    }
    (raw, ToolCallStatus::Completed)
}

/// Map a Core tool status string to ACP. Unknown strings are terminal
/// successes; `in_progress`/`pending` count only when `allow_open` (the status
/// is known to be Core's own lifecycle field).
fn wire_status(status: &str, allow_open: bool) -> ToolCallStatus {
    match status {
        "failed" | "error" | "output-error" => ToolCallStatus::Failed,
        "in_progress" if allow_open => ToolCallStatus::InProgress,
        "pending" if allow_open => ToolCallStatus::Pending,
        _ => ToolCallStatus::Completed,
    }
}

/// Incremental line splitter over a byte stream. Bytes are buffered until a
/// newline so a multi-byte UTF-8 character split across chunks decodes intact.
#[derive(Default)]
pub(crate) struct LineBuffer {
    pending: Vec<u8>,
}

impl LineBuffer {
    /// Feed a chunk and return every complete line it finished.
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut lines = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.pending.drain(..=newline).collect();
            lines.push(String::from_utf8_lossy(&line[..line.len() - 1]).into_owned());
        }
        lines
    }

    /// The unterminated tail at end of stream, if any.
    pub(crate) fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            return None;
        }
        let tail = std::mem::take(&mut self.pending);
        Some(String::from_utf8_lossy(&tail).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(value: Value) -> String {
        format!("data: {value}")
    }

    #[test]
    fn decodes_text_reasoning_and_done() {
        assert_eq!(
            decode_line(&line(json!({"type":"text-delta","id":"t","delta":"hi"}))),
            CoreEvent::TextDelta("hi".into())
        );
        assert_eq!(
            decode_line(&line(
                json!({"type":"reasoning-delta","id":"r","delta":"hm"})
            )),
            CoreEvent::ReasoningDelta("hm".into())
        );
        assert_eq!(decode_line("data: [DONE]\r"), CoreEvent::Done);
        assert_eq!(
            decode_line(&line(json!({"type":"finish"}))),
            CoreEvent::Ignored
        );
        assert_eq!(decode_line(": keep-alive"), CoreEvent::Ignored);
        assert_eq!(decode_line("data: {not json"), CoreEvent::Ignored);
    }

    #[test]
    fn decodes_tool_lifecycle_and_failure_flags() {
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-input-available","toolCallId":"c1","toolName":"Bash",
                "input":{"command":"ls"}
            }))),
            CoreEvent::ToolInput {
                id: "c1".into(),
                name: "Bash".into(),
                input: json!({"command":"ls"})
            }
        );
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c1",
                "output":{"status":"failed","output":"boom"}
            }))),
            CoreEvent::ToolOutput {
                id: "c1".into(),
                output: json!("boom"),
                status: ToolCallStatus::Failed
            }
        );
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c2","output":{"isError":true}
            }))),
            CoreEvent::ToolOutput {
                id: "c2".into(),
                output: json!({"isError":true}),
                status: ToolCallStatus::Failed
            }
        );
    }

    #[test]
    fn non_final_core_tool_updates_keep_the_call_open() {
        // Core's real wrapper for an ACP `tool_call_update {status: in_progress}`.
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c1",
                "output":{"status":"in_progress","output":null}
            }))),
            CoreEvent::ToolOutput {
                id: "c1".into(),
                output: Value::Null,
                status: ToolCallStatus::InProgress
            }
        );
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c1",
                "output":{"status":"pending","output":null}
            }))),
            CoreEvent::ToolOutput {
                id: "c1".into(),
                output: Value::Null,
                status: ToolCallStatus::Pending
            }
        );
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c1",
                "output":{"status":"completed","output":"done"}
            }))),
            CoreEvent::ToolOutput {
                id: "c1".into(),
                output: json!("done"),
                status: ToolCallStatus::Completed
            }
        );
        // A bare output, or a native result with its own unrelated `status`,
        // is final.
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c2","output":"file.txt"
            }))),
            CoreEvent::ToolOutput {
                id: "c2".into(),
                output: json!("file.txt"),
                status: ToolCallStatus::Completed
            }
        );
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-output-available","toolCallId":"c3",
                "output":{"status":"pending","jobId":"j1"}
            }))),
            CoreEvent::ToolOutput {
                id: "c3".into(),
                output: json!({"status":"pending","jobId":"j1"}),
                status: ToolCallStatus::Completed
            }
        );
    }

    #[test]
    fn question_cards_decode_separately_from_tool_calls() {
        // `ask_user` always states `async`; an elicitation carries its `schema`.
        for input in [
            json!({"toolCallId":"q1","async":false,"questions":[]}),
            json!({"toolCallId":"q1","async":true,"questions":[]}),
            json!({"toolCallId":"q1","questions":[],"schema":{"type":"form"}}),
        ] {
            assert_eq!(
                decode_line(&line(json!({
                    "type":"tool-input-available","toolCallId":"q1","toolName":"Question",
                    "input":input.clone()
                }))),
                CoreEvent::Question {
                    id: "q1".into(),
                    input
                }
            );
        }
    }

    #[test]
    fn agent_question_tools_stay_ordinary_tool_calls() {
        // Core reshapes an agent's own question tool (e.g. AskUserQuestion)
        // into a Question card but registers no answer waiter for it.
        let input = json!({"toolCallId":"c1","questions":[],"totalQuestions":0,"questionIndex":1});
        assert_eq!(
            decode_line(&line(json!({
                "type":"tool-input-available","toolCallId":"c1","toolName":"Question",
                "input":input.clone()
            }))),
            CoreEvent::ToolInput {
                id: "c1".into(),
                name: "Question".into(),
                input
            }
        );
    }

    #[test]
    fn decodes_permission_and_error() {
        let event = decode_line(&line(json!({
            "type":"data-ryu-permission",
            "data":{"requestId":"perm-1","toolCall":{"toolCallId":"c1"},"options":[]}
        })));
        assert_eq!(
            event,
            CoreEvent::Permission {
                request_id: "perm-1".into(),
                tool_call: json!({"toolCallId":"c1"}),
                options: json!([])
            }
        );
        assert_eq!(
            decode_line(&line(json!({"type":"error","errorText":"nope"}))),
            CoreEvent::Error("nope".into())
        );
    }

    #[test]
    fn line_buffer_keeps_split_utf8_intact() {
        let text = "data: é\n";
        let bytes = text.as_bytes();
        let mut buffer = LineBuffer::default();
        assert!(buffer.push(&bytes[..7]).is_empty());
        assert_eq!(buffer.push(&bytes[7..]), vec!["data: é".to_owned()]);
        assert_eq!(buffer.finish(), None);
    }
}
