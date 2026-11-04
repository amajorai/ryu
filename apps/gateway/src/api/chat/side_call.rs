//! Core's governed side-model calls must come back complete.
//!
//! Core's one-shot side calls (`/btw`, the advisor, the learning judge, memory
//! dreaming, recommendations, retrieval expansion, predictions and plugin
//! `host.sideModel`) read the first choice's text and hand it on as the model's
//! whole answer. A refusal, a reply the provider's safety system filtered, one
//! cut off at the token limit, or one with no text is not that answer: attacker
//! text that makes the model refuse, trip a filter, run long or say nothing
//! would otherwise reach the caller
//! as an empty or truncated result that looks like a normal one. For these
//! purposes the Gateway answers 502 instead of the partial text, so the side
//! call fails rather than returning it.
//!
//! The rule is keyed on `x-ryu-purpose`, and the purposes below are exactly the
//! ones Core sends through that governed side-model call. Other tagged work
//! (titles, suggestions, routing, compaction, handoff, workflow prompts,
//! delegation, app streams) reads the response itself and keeps its own rules.
//! Streams are out of scope: no side-model call streams.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

/// The named `x-ryu-purpose` values of Core's governed side-model call.
const SIDE_MODEL_PURPOSES: [&str; 7] = [
    "btw",
    "advisor",
    "learning_judge",
    "memory_dream",
    "recommendations",
    "retrieval_expansion",
    "predict",
];

/// Plugin `host.sideModel` calls are tagged `plugin:<id>`.
const PLUGIN_PURPOSE_PREFIX: &str = "plugin:";

/// Finish reasons under which a reply is not a complete answer.
const INCOMPLETE_FINISH_REASONS: [&str; 4] = ["content_filter", "length", "max_tokens", "refusal"];

/// Whether `purpose` names one of Core's governed side-model calls.
fn is_side_model_purpose(purpose: &str) -> bool {
    SIDE_MODEL_PURPOSES.contains(&purpose) || purpose.starts_with(PLUGIN_PURPOSE_PREFIX)
}

/// Why `response` is not a complete answer, if it is not: a non-empty
/// `message.refusal`, a first choice that stopped on one of
/// [`INCOMPLETE_FINISH_REASONS`], or no text at all (no first choice, or
/// content that is missing, not a string or blank: Core reads that as an
/// empty answer that looks like a normal one). The reason never quotes the
/// model's text, which can echo the request.
fn incomplete_reason(response: &Value) -> Option<String> {
    let choice = &response["choices"][0];
    if choice["message"]["refusal"]
        .as_str()
        .is_some_and(|refusal| !refusal.trim().is_empty())
    {
        return Some("refusal".to_owned());
    }
    if let Some(reason) = choice["finish_reason"].as_str() {
        if let Some(incomplete) = INCOMPLETE_FINISH_REASONS
            .iter()
            .find(|incomplete| reason.eq_ignore_ascii_case(incomplete))
        {
            return Some((*incomplete).to_owned());
        }
    }
    let has_text = choice["message"]["content"]
        .as_str()
        .is_some_and(|text| !text.trim().is_empty());
    (!has_text).then(|| "empty".to_owned())
}

/// The 502 that replaces a refused, filtered or cut-off reply to one of Core's
/// side-model calls, or `None` when the reply goes out unchanged (another
/// purpose, no purpose, or a complete answer).
pub(super) fn incomplete_side_answer(purpose: Option<&str>, response: &Value) -> Option<Response> {
    if !purpose.is_some_and(is_side_model_purpose) {
        return None;
    }
    let reason = incomplete_reason(response)?;
    let message = format!(
        "The model did not return a complete answer (stopped by {reason}); a side-model call needs one."
    );
    Some(
        (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "error": {
                    "message": message,
                    "type": "incomplete_side_answer",
                    "code": "incomplete_side_answer",
                    "reason": reason,
                }
            })),
        )
            .into_response(),
    )
}

#[cfg(test)]
#[path = "side_call_tests.rs"]
mod tests;
