//! Finish reasons as protocol metadata: fixed values only, so split across
//! frames they never spell out a value the scan would match on their own. A
//! released one can still head a lane a later frame completes, so the stream
//! keeps their released tail (`stream_dlp/fixed.rs`).

use serde_json::Value;

/// A `finish_reason` that is null or a protocol value (see `protocol_role`).
pub(in crate::pipeline) fn protocol_finish_reason(value: &Value) -> bool {
    value.is_null()
        || matches!(
            value.as_str(),
            Some(
                "stop"
                    | "length"
                    | "tool_calls"
                    | "content_filter"
                    | "function_call"
                    // Together's and TGI's end of sequence, TGI's stop string,
                    // DeepSeek's and Mistral's own reasons.
                    | "eos"
                    | "eos_token"
                    | "stop_sequence"
                    | "insufficient_system_resource"
                    | "model_length"
                    | "error"
                    // The gateway's own Anthropic translator passes a server
                    // tool pause through (`map_stop_reason`).
                    | "pause_turn"
            )
        )
}

/// OpenRouter's `native_finish_reason`: the upstream provider's own finish
/// reason, protocol metadata like `finish_reason`. A fixed list, so split
/// across frames it can never spell out a value.
pub(in crate::pipeline) fn protocol_native_finish_reason(value: &Value) -> bool {
    protocol_finish_reason(value)
        || matches!(
            value.as_str(),
            Some(
                "end_turn"
                    | "max_tokens"
                    | "tool_use"
                    | "refusal"
                    | "STOP"
                    | "MAX_TOKENS"
                    | "SAFETY"
                    | "RECITATION"
                    | "OTHER"
                    | "BLOCKLIST"
                    | "PROHIBITED_CONTENT"
                    | "SPII"
                    | "MALFORMED_FUNCTION_CALL"
                    | "FINISH_REASON_UNSPECIFIED"
                    | "LANGUAGE"
                    | "IMAGE_SAFETY"
                    | "UNEXPECTED_TOOL_CALL"
                    | "COMPLETE"
                    | "STOP_SEQUENCE"
                    | "TOOL_CALL"
                    | "ERROR"
                    | "model_context_window_exceeded"
                    | "guardrail_intervened"
                    // OpenRouter's Responses-API statuses; Bedrock's and
                    // Gemini's other documented reasons.
                    | "completed"
                    | "incomplete"
                    | "content_filtered"
                    | "malformed_model_output"
                    | "malformed_tool_use"
                    | "IMAGE_PROHIBITED_CONTENT"
                    | "IMAGE_OTHER"
                    | "IMAGE_RECITATION"
                    | "NO_IMAGE"
                    | "TOO_MANY_TOOL_CALLS"
            )
        )
}
