//! GenAI content helpers for content-mode OTLP export.
//!
//! Content mode (`diagnostics-otlp-content-mode = content`) adds
//! `gen_ai.system_instructions`, `gen_ai.input.messages`, `gen_ai.output.messages`
//! and tool arguments/results to exported spans, as JSON strings in the OTel GenAI
//! message format (`{"role": .., "parts": [{"type": "text"|"tool_call"|
//! "tool_call_response"|"reasoning", ..}]}`). Every span's content is capped at
//! `diagnostics-otlp-max-content-bytes` (default 750000): the system prompt is
//! dropped first, then the earliest messages; tool results are cut from the end.
//! A truncated span carries `ryu.content.truncated = true` (see
//! [`CONTENT_TRUNCATED_ATTR`]).
//!
//! These are pure helpers shared by Core and the Gateway (each re-exports them
//! as `telemetry::content`); callers gate on their `telemetry::content_enabled()`
//! before building any content (it is `false` whenever export consent is off).

use serde_json::{json, Value};

/// Span attribute set to `true` when any content attribute was truncated.
pub const CONTENT_TRUNCATED_ATTR: &str = "ryu.content.truncated";

/// A GenAI message: `{"role": role, "parts": parts}`.
pub fn gen_ai_message(role: &str, parts: Vec<Value>) -> Value {
    json!({ "role": role, "parts": parts })
}

/// An output message also carries its `finish_reason`.
pub fn gen_ai_output_message(parts: Vec<Value>, finish_reason: &str) -> Value {
    json!({ "role": "assistant", "parts": parts, "finish_reason": finish_reason })
}

/// `{"type": "text", "content": ..}`.
pub fn text_part(content: &str) -> Value {
    json!({ "type": "text", "content": content })
}

/// `{"type": "reasoning", "content": ..}`.
pub fn reasoning_part(content: &str) -> Value {
    json!({ "type": "reasoning", "content": content })
}

/// `{"type": "tool_call", "id": .., "name": .., "arguments": ..}`.
pub fn tool_call_part(id: &str, name: &str, arguments: Value) -> Value {
    json!({ "type": "tool_call", "id": id, "name": name, "arguments": arguments })
}

/// `{"type": "tool_call_response", "id": .., "response": ..}`.
pub fn tool_call_response_part(id: &str, response: Value) -> Value {
    json!({ "type": "tool_call_response", "id": id, "response": response })
}

/// Content attributes for one model-call span after applying the byte cap.
/// `None` means "omit the attribute".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SpanContent {
    /// `gen_ai.system_instructions` (a JSON array of parts).
    pub system_instructions: Option<String>,
    /// `gen_ai.input.messages` (a JSON array of messages).
    pub input_messages: Option<String>,
    /// `gen_ai.output.messages` (a JSON array of messages).
    pub output_messages: Option<String>,
    /// Whether anything was dropped to fit the cap.
    pub truncated: bool,
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_string(value).map(|s| s.len()).unwrap_or(0)
}

/// Byte length of `[a,b,c]` given each element's serialized length.
fn array_len(sizes: &[usize]) -> usize {
    2 + sizes.iter().sum::<usize>() + sizes.len().saturating_sub(1)
}

fn to_json_array(values: &[Value]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_owned())
}

/// Serialize `messages` as a JSON array that fits in `max_bytes`, dropping the
/// earliest messages first. Returns `(json, truncated)`. When not even the last
/// message fits, the result is `"[]"` with `truncated = true`.
pub fn truncate_messages_json(messages: &[Value], max_bytes: usize) -> (String, bool) {
    let sizes: Vec<usize> = messages.iter().map(serialized_len).collect();
    let mut start = 0;
    while start < messages.len() && array_len(&sizes[start..]) > max_bytes {
        start += 1;
    }
    (to_json_array(&messages[start..]), start > 0)
}

/// Apply the per-span cap across all content attributes of a model-call span.
///
/// Drop order (Claude Platform parity): the system instructions first, then the
/// earliest input messages, then the earliest output messages. Empty inputs are
/// omitted (`None`) rather than exported as `[]`.
pub fn truncate_span_content(
    system_instructions: Option<&Value>,
    input_messages: &[Value],
    output_messages: &[Value],
    max_bytes: usize,
) -> SpanContent {
    let input_sizes: Vec<usize> = input_messages.iter().map(serialized_len).collect();
    let output_sizes: Vec<usize> = output_messages.iter().map(serialized_len).collect();
    let system_size = system_instructions.map(serialized_len).unwrap_or(0);

    let section = |sizes: &[usize]| {
        if sizes.is_empty() {
            0
        } else {
            array_len(sizes)
        }
    };
    let mut keep_system = system_instructions.is_some();
    let mut input_start = 0;
    let mut output_start = 0;
    let total = |keep_system: bool, input_start: usize, output_start: usize| {
        (if keep_system { system_size } else { 0 })
            + section(&input_sizes[input_start..])
            + section(&output_sizes[output_start..])
    };

    while total(keep_system, input_start, output_start) > max_bytes {
        if keep_system {
            keep_system = false;
        } else if input_start < input_messages.len() {
            input_start += 1;
        } else if output_start < output_messages.len() {
            output_start += 1;
        } else {
            break;
        }
    }

    let truncated =
        (system_instructions.is_some() && !keep_system) || input_start > 0 || output_start > 0;
    let non_empty = |values: &[Value]| (!values.is_empty()).then(|| to_json_array(values));
    SpanContent {
        system_instructions: system_instructions
            .filter(|_| keep_system)
            .and_then(|value| serde_json::to_string(value).ok()),
        input_messages: non_empty(&input_messages[input_start..]),
        output_messages: non_empty(&output_messages[output_start..]),
        truncated,
    }
}

/// Cap a tool argument/result string at `max_bytes`, dropping from the END (on
/// a UTF-8 char boundary). Returns `(text, truncated)`.
pub fn truncate_tool_content(text: &str, max_bytes: usize) -> (String, bool) {
    if text.len() <= max_bytes {
        return (text.to_owned(), false);
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(text: &str) -> Value {
        gen_ai_message("user", vec![text_part(text)])
    }

    #[test]
    fn messages_fit_untouched() {
        let messages = vec![user("a"), user("b")];
        let (json, truncated) = truncate_messages_json(&messages, 10_000);
        assert!(!truncated);
        assert_eq!(json, serde_json::to_string(&messages).unwrap());
    }

    #[test]
    fn earliest_messages_drop_first() {
        let messages = vec![user(&"x".repeat(100)), user("keep")];
        let keep_len = serde_json::to_string(&messages[1..]).unwrap().len();
        let (json, truncated) = truncate_messages_json(&messages, keep_len);
        assert!(truncated);
        assert!(json.contains("keep"));
        assert!(!json.contains("xxxx"));
        assert!(json.len() <= keep_len);
        // Nothing fits → empty array, still flagged.
        let (json, truncated) = truncate_messages_json(&messages, 1);
        assert_eq!(json, "[]");
        assert!(truncated);
    }

    #[test]
    fn span_content_drops_system_then_earliest_input() {
        let system = json!([text_part(&"s".repeat(200))]);
        let input = vec![user(&"old".repeat(50)), user("new")];
        let output = vec![gen_ai_output_message(vec![text_part("done")], "stop")];

        let all = truncate_span_content(Some(&system), &input, &output, 1_000_000);
        assert!(!all.truncated);
        assert!(all.system_instructions.is_some());

        // Budget fits both input messages + output but not the system prompt.
        let without_system = to_json_array(&input).len() + to_json_array(&output).len();
        let capped = truncate_span_content(Some(&system), &input, &output, without_system);
        assert!(capped.truncated);
        assert!(capped.system_instructions.is_none());
        assert_eq!(
            capped.input_messages.as_deref(),
            Some(to_json_array(&input).as_str())
        );

        // Tighter: the earliest input message goes next; output survives.
        let tight = to_json_array(&input[1..]).len() + to_json_array(&output).len();
        let capped = truncate_span_content(Some(&system), &input, &output, tight);
        assert!(capped.truncated);
        let kept = capped.input_messages.unwrap();
        assert!(kept.contains("new") && !kept.contains("oldold"));
        assert!(capped.output_messages.unwrap().contains("done"));

        // Empty sections are omitted.
        let empty = truncate_span_content(None, &[], &[], 10);
        assert_eq!(empty, SpanContent::default());
    }

    #[test]
    fn tool_content_cuts_from_end_on_char_boundary() {
        assert_eq!(
            truncate_tool_content("hello", 10),
            ("hello".to_owned(), false)
        );
        assert_eq!(truncate_tool_content("hello", 3), ("hel".to_owned(), true));
        // "é" is two bytes; a cut inside it backs off to the boundary.
        assert_eq!(truncate_tool_content("aé", 2), ("a".to_owned(), true));
    }
}
