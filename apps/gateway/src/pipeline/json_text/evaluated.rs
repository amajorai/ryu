//! The text an output evaluator judges over a buffered stream: each string
//! a client builds, as it merges the deltas of each choice (every string path
//! joined across frames, tool calls by their `index`) and the non-stream
//! evaluator reads it (`response_to_text`, every string of each choice):
//! never choices, or one choice's strings, interleaved in wire order.

use std::collections::BTreeMap;

use serde_json::Value;

use super::{choice_lane, collect_sse_payload_lanes, odd_index, sse_scan_text};

/// Keys whose strings are no model text (`collect_text_fields`): a choice's
/// text comes first, where a judge's bounded head reads it, these after.
const UNRENDERED: [&str; 7] = [
    "id",
    "model",
    "object",
    "role",
    "type",
    "name",
    "finish_reason",
];

/// Where a choice sorts: choices by index, then choices whose index is no
/// lane number (keyed by its raw value).
type LaneKey = (u8, u64, String);

/// A choice's lane, as `collect_sse_payload_lanes` keys it.
fn choice_key(entry: &Value, position: usize) -> LaneKey {
    match entry.get("index") {
        Some(index) if odd_index(entry) => (2, 0, index.to_string()),
        _ => (1, choice_lane(entry, position), String::new()),
    }
}

/// Whether a choice's string path is its text (under `delta` or `message`,
/// below no key `UNRENDERED` names, outside `reasoning_details`).
fn model_text(path: &str) -> bool {
    let mut segments = path.split('/');
    matches!(segments.next(), Some("delta" | "message"))
        && segments.all(|segment| !UNRENDERED.contains(&segment) && segment != "reasoning_details")
}

/// Strings a client gets that judge nothing: a lane-number `index` (a
/// numeric string), token ids, and protocol roles and finish reasons.
fn protocol(path: &str, text: &str) -> bool {
    let value = Value::String(text.to_owned());
    (path == "index" && text.trim().parse::<f64>().is_ok())
        || path.split('/').any(|segment| segment == "token_ids")
        || match path.rsplit('/').next() {
            Some("role") => super::protocol_role(&value),
            Some("finish_reason") => super::protocol_finish_reason(&value),
            Some("native_finish_reason") => super::protocol_native_finish_reason(&value),
            _ => false,
        }
}

/// One choice's strings: each path's fragments in frame order; its logprob
/// strings one by one (a sampled token or an alternative is never joined
/// across frames or positions); and its sampled tokens in order.
#[derive(Default)]
struct Choice {
    paths: BTreeMap<String, Vec<String>>,
    tokens: Vec<String>,
    sequence: String,
}

impl Choice {
    fn feed(&mut self, entry: &Value) {
        let mut own = BTreeMap::new();
        // Under a prefix: the empty-path skip of the frame's own `id` /
        // `model` / `object` must not drop a choice's strings of that name.
        collect_sse_payload_lanes(entry, "/c", &mut own);
        for (path, text) in own {
            let path = path.trim_start_matches("/c/");
            if text.is_empty() || protocol(path, &text) {
                continue;
            }
            if path.split('/').any(|segment| segment == "logprobs") {
                self.tokens.push(text);
            } else {
                self.paths.entry(path.to_owned()).or_default().push(text);
            }
        }
        let mut sequence = BTreeMap::new();
        super::token_sequences(&serde_json::json!({ "choices": [entry] }), &mut sequence);
        for text in sequence.values() {
            self.sequence.push_str(text);
        }
    }

    /// Each path as a client builds it: every fragment joined. Outside the
    /// text, a path whose every frame carried the same value (Azure's
    /// per-frame `severity`, or a name streamed as identical fragments) is
    /// judged both ways, once and joined, so neither reading is missed.
    fn strings(&self, text: bool) -> Vec<String> {
        let mut out = Vec::new();
        for (path, pieces) in &self.paths {
            if model_text(path) != text {
                continue;
            }
            if !text && pieces.len() > 1 && pieces.iter().all(|piece| *piece == pieces[0]) {
                out.push(pieces[0].clone());
            }
            out.push(pieces.concat());
        }
        out
    }
}

fn push_line(out: &mut String, text: &str) {
    if text.is_empty() {
        return;
    }
    if !out.is_empty() {
        out.push('\n');
    }
    out.push_str(text);
}

/// A frame's choice entries in order: an array's, or an object's values
/// (`{"0": {...}}`, which a client still indexes as choice 0).
pub(in crate::pipeline) fn choice_entries(choices: &Value) -> Option<Vec<&Value>> {
    match choices {
        Value::Array(entries) => Some(entries.iter().collect()),
        Value::Object(entries) => Some(entries.values().collect()),
        _ => None,
    }
}

/// The text an output evaluator judges over a stream's (rewritten) frames:
/// every choice's text strings (content, reasoning, tool-call arguments,
/// each joined across frames), choices in index order, then their other
/// strings (tool-call names and ids, a choice-level `text`, annotations),
/// then their logprobs (`Choice`).
/// Frames without `choices` (other provider shapes) come first, in wire
/// order. Only judged, never replayed (`evaluator_sanitized`).
pub(in crate::pipeline) fn evaluated_text(frames: &[Value]) -> String {
    let mut other_shapes = Vec::new();
    let mut choices: BTreeMap<LaneKey, Choice> = BTreeMap::new();
    let mut stray = String::new();
    for frame in frames {
        match frame.get("choices") {
            None => other_shapes.push(frame.clone()),
            Some(value) => match choice_entries(value) {
                Some(entries) => {
                    for (position, entry) in entries.into_iter().enumerate() {
                        choices
                            .entry(choice_key(entry, position))
                            .or_default()
                            .feed(entry);
                    }
                }
                // Any other `choices` value is judged whole (fail closed).
                None => super::collect_json_strings(value, &mut stray),
            },
        }
    }
    let mut judged = sse_scan_text(&other_shapes).0;
    for text in [true, false] {
        for choice in choices.values() {
            for string in choice.strings(text) {
                push_line(&mut judged, &string);
            }
        }
    }
    // Logprobs last: each choice's sampled tokens in order, then every
    // token and alternative on its own, as the non-stream evaluator reads
    // each string.
    for choice in choices.values() {
        push_line(&mut judged, &choice.sequence);
        for token in &choice.tokens {
            push_line(&mut judged, token);
        }
    }
    push_line(&mut judged, &stray);
    judged
}
