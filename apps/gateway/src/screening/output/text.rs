//! The text the output role reads: a buffered response's choices and a
//! stream frame's deltas, side channels included.

use serde_json::Value;

/// Text a provider returns beside `content` that the gateway still forwards
/// to the caller: reasoning (`reasoning`, `reasoning_content`,
/// `reasoning_details[].text` and `.summary`), a `refusal`, and the legacy
/// `function_call.arguments`. A model can be walked through hazardous text
/// there, so the output role reads it too. `sep` follows each piece (a newline
/// in a buffered response, nothing between stream deltas).
pub(super) fn push_side_channels(holder: &Value, out: &mut String, sep: &str) {
    let mut push = |text: &str| {
        out.push_str(text);
        out.push_str(sep);
    };
    for key in ["reasoning", "reasoning_content", "refusal"] {
        if let Some(text) = holder[key].as_str() {
            push(text);
        }
    }
    for detail in holder["reasoning_details"].as_array().into_iter().flatten() {
        for key in ["text", "summary"] {
            if let Some(text) = detail[key].as_str() {
                push(text);
            }
        }
    }
    if let Some(arguments) = holder["function_call"]["arguments"].as_str() {
        push(arguments);
    }
}

/// The assistant text of a buffered chat response: every choice's content,
/// tool call arguments and side channels (reasoning, refusal, legacy
/// function call).
pub fn response_text(response: &Value) -> String {
    let mut out = String::new();
    for choice in response["choices"].as_array().into_iter().flatten() {
        let message = &choice["message"];
        push_content(&message["content"], &mut out);
        push_side_channels(message, &mut out, "\n");
        for call in message["tool_calls"].as_array().into_iter().flatten() {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                out.push_str(arguments);
                out.push('\n');
            }
        }
        if let Some(text) = choice["text"].as_str() {
            out.push_str(text);
            out.push('\n');
        }
    }
    out
}

pub(super) fn push_content(content: &Value, out: &mut String) {
    match content {
        Value::String(s) => {
            out.push_str(s);
            out.push('\n');
        }
        Value::Array(parts) => {
            for part in parts {
                if let Some(text) = part["text"].as_str() {
                    out.push_str(text);
                    out.push('\n');
                }
            }
        }
        _ => {}
    }
}

/// Text deltas in one SSE chunk: chat `delta.content`, tool call argument
/// deltas, reasoning, refusal and legacy function-call deltas, legacy `text`,
/// and Responses `delta` strings.
pub(super) fn delta_text(frame: &Value, out: &mut String) {
    for choice in frame["choices"].as_array().into_iter().flatten() {
        let delta = &choice["delta"];
        push_content(&delta["content"], out);
        push_side_channels(delta, out, "");
        for call in delta["tool_calls"].as_array().into_iter().flatten() {
            if let Some(arguments) = call["function"]["arguments"].as_str() {
                out.push_str(arguments);
            }
        }
        if let Some(text) = choice["text"].as_str() {
            out.push_str(text);
        }
    }
    if let Some(delta) = frame["delta"].as_str() {
        out.push_str(delta);
    }
}

#[cfg(test)]
mod side_channel_tests {
    use super::*;
    use serde_json::json;

    /// Reasoning, refusal and legacy function-call text reach the caller, so
    /// the output role reads them like `content`.
    #[test]
    fn a_buffered_response_exposes_reasoning_refusal_and_function_call_text() {
        let response = json!({ "choices": [{ "message": {
            "role": "assistant",
            "content": "visible",
            "reasoning": "reasoning-marker",
            "reasoning_content": "reasoning-content-marker",
            "reasoning_details": [
                { "type": "reasoning.text", "text": "detail-text-marker" },
                { "type": "reasoning.summary", "summary": "detail-summary-marker" }
            ],
            "refusal": "refusal-marker",
            "function_call": { "name": "f", "arguments": "{\"legacy\":\"function-call-marker\"}" }
        } }] });
        let text = response_text(&response);
        for marker in [
            "visible",
            "reasoning-marker",
            "reasoning-content-marker",
            "detail-text-marker",
            "detail-summary-marker",
            "refusal-marker",
            "function-call-marker",
        ] {
            assert!(text.contains(marker), "{marker} missing from {text:?}");
        }
    }

    #[test]
    fn a_stream_frame_exposes_reasoning_deltas() {
        let frame = json!({ "choices": [{ "delta": {
            "content": "c",
            "reasoning": "r1",
            "reasoning_content": "r2",
            "reasoning_details": [{ "text": "r3" }],
            "refusal": "r4",
            "function_call": { "arguments": "r5" }
        } }] });
        let mut out = String::new();
        delta_text(&frame, &mut out);
        for delta in ["c", "r1", "r2", "r3", "r4", "r5"] {
            assert!(out.contains(delta), "{delta} missing from {out:?}");
        }
    }

    #[test]
    fn a_response_without_side_channels_is_unchanged() {
        let response = json!({ "choices": [{ "message": { "content": "only" } }] });
        assert_eq!(response_text(&response), "only\n");
    }
}
