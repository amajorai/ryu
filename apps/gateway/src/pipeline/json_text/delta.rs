//! Classifying streamed delta frames: which frames are plain text in one
//! field (and so can be scanned and redacted as one text), and the scan text
//! of a whole payload.

use serde_json::Value;

use super::{
    collect_sse_payload_text, json_string_projection, protocol_finish_reason, protocol_role,
};

/// Whether a frame carries text only in `choices[0].delta.content`, so the
/// incremental scanner's concatenated text sees all of it. Any other choice
/// or delta field that holds a string (non-null `logprobs`, `text`, `message`,
/// `refusal`, `tool_calls`, `reasoning_content`) is another lane a split match
/// could hide in, so the frame is not simple. Fields that carry no text at all
/// (OpenAI's first chunk sends `"refusal": null`) are not lanes: rejecting them
/// latched every OpenAI stream into whole-response buffering.
pub(in crate::pipeline) fn simple_content_delta(value: &Value) -> bool {
    let Some(choices) = value.get("choices").and_then(Value::as_array) else {
        return false;
    };
    let Some(choice) = (match choices.as_slice() {
        [] => return true,
        [choice] => choice.as_object(),
        _ => None,
    }) else {
        return false;
    };
    let delta_simple = |delta: &Value| {
        delta.as_object().is_some_and(|delta| {
            // Texts across the text fields; vLLM's `reasoning` that repeats
            // `reasoning_content` is one text (scanned once), anything else
            // counts on its own.
            let reasoning_content = delta.get("reasoning_content").and_then(Value::as_str);
            let mut texts = 0;
            let keys_simple = delta.iter().all(|(key, value)| match key.as_str() {
                "content" | "reasoning_content" | "reasoning" => {
                    let text = value.as_str().filter(|text| !text.is_empty());
                    let mirrored =
                        key == "reasoning" && text.is_some() && text == reasoning_content;
                    texts += usize::from(text.is_some() && !mirrored);
                    value.is_string() || value.is_null()
                }
                "role" => protocol_role(value),
                "reasoning_details" => {
                    reasoning_mirror(value, delta.get("reasoning").and_then(Value::as_str))
                }
                _ => json_string_projection(value).is_empty(),
            });
            // One text per frame, so it maps back to its field(s).
            keys_simple && texts <= 1
        })
    };
    choice.iter().all(|(key, value)| match key.as_str() {
        "index" => value.is_null() || value.as_u64() == Some(0),
        "delta" => delta_simple(value),
        "finish_reason" => protocol_finish_reason(value),
        "native_finish_reason" => super::finish::protocol_native_finish_reason(value),
        // vLLM's / SGLang's matched stop: a token id, or the request's stop
        // string, judged as an envelope lane (`EnvelopeLanes::observe_choice`).
        "stop_reason" | "matched_stop" => value.is_null() || value.is_number() || value.is_string(),
        "content_filter_results" | "content_filter_offsets" => filter_annotation(value),
        // Together AI mirrors the delta text in the choice's `text`.
        "text" => {
            value.is_null()
                || value.as_str().is_some_and(|text| {
                    let delta_text = choice
                        .get("delta")
                        .and_then(|delta| delta_text_value(delta))
                        .unwrap_or("");
                    text.is_empty() || text == delta_text
                })
        }
        _ => json_string_projection(value).is_empty(),
    })
}

/// The delta text fields a simple frame may carry its text in (one per
/// frame): the answer, and the reasoning lanes DeepSeek / OpenRouter / Groq
/// stream before it. They are scanned as one text.
pub(in crate::pipeline) const DELTA_TEXT_KEYS: [&str; 3] =
    ["content", "reasoning_content", "reasoning"];

/// OpenRouter's `reasoning_details` when it only mirrors the frame's
/// `reasoning` text: `reasoning.text` entries whose text equals it (or is
/// empty) and whose other fields are protocol values. Rewriting the reasoning
/// rewrites the mirror with it (`redact::apply_segments`).
pub(in crate::pipeline) fn reasoning_mirror(value: &Value, reasoning: Option<&str>) -> bool {
    // One entry at index 0: clients merge entries by `index`, so other
    // indexes (or several entries) would build text the scan never joins.
    value.is_null()
        || value.as_array().is_some_and(|entries| {
            entries.len() <= 1
                && entries.iter().all(|entry| {
                    entry.as_object().is_some_and(|fields| {
                        fields.iter().all(|(key, field)| match key.as_str() {
                            "type" => matches!(
                                field.as_str(),
                                Some(
                                    "reasoning.text" | "reasoning.summary" | "reasoning.encrypted"
                                )
                            ),
                            // Text the entry mirrors (`summary` for OpenAI models).
                            "text" | "summary" => {
                                field.is_null()
                                    || field.as_str().is_some_and(|text| {
                                        text.is_empty() || Some(text) == reasoning
                                    })
                            }
                            // Opaque provider strings, scanned as envelope lanes.
                            "format" | "id" | "signature" | "data" => {
                                field.is_null() || field.is_string()
                            }
                            "index" => field.is_null() || field.as_u64() == Some(0),
                            _ => false,
                        })
                    })
                })
        })
}

/// The text a delta carries in its first non-empty text field, if any.
pub(in crate::pipeline) fn delta_text_value(delta: &Value) -> Option<&str> {
    DELTA_TEXT_KEYS.iter().find_map(|key| {
        delta
            .get(*key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    })
}

/// The delta text field a frame's first choice carries text in, if any
/// (`choice_text::primary_text_keys` reads choice 0 by `index` instead).
fn delta_text_key(frame: &Value) -> Option<&'static str> {
    let delta = frame.get("choices")?.as_array()?.first()?.get("delta")?;
    DELTA_TEXT_KEYS.iter().copied().find(|key| {
        delta
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty())
    })
}

/// What the scan text carries between two delta text fields (reasoning to
/// answer). No built-in pattern can match across it: every class that takes
/// a newline (`\s`, `[-.\s]`, ...) is followed by one that takes neither a
/// newline nor NUL, and every class that takes NUL (`.`, `[^\s]`, ...) takes
/// no newline, so a match on `a + FIELD_SEPARATOR + b` is a match on `a` or
/// on `b`, as each field is its own string in a non-streamed response. Its
/// edges are non-word characters, so `\b` behaves as at a string end. NUL is
/// outside the private-use sentinel alphabet of the text-level split and is
/// kept by `normalize_for_scan`. Everything that reads it back does so by
/// position (`FIELD_SEPARATOR.len()`), never by searching for it.
pub(in crate::pipeline) const FIELD_SEPARATOR: &str = "\n\u{0}\n";

/// The scan text of a whole SSE payload's frames, with [`FIELD_SEPARATOR`]
/// wherever the delta text field changes (reasoning to answer): each field is
/// its own text to the patterns, as it is in a non-streamed response.
/// Returns the text, each frame's end offset, and whether a separator was
/// inserted before each frame. Every choice's text is joined in wire order,
/// so this is the scan text only of payloads whose entries are all choice 0
/// (the text-level rewrite's simple frames); the verdict and the per-string
/// check read each choice on its own (`choice_scan_texts`).
pub(in crate::pipeline) fn sse_scan_text(frames: &[Value]) -> (String, Vec<usize>, Vec<bool>) {
    let mut text = String::new();
    let mut ends = Vec::with_capacity(frames.len());
    let mut separated = Vec::with_capacity(frames.len());
    let mut field = None;
    for frame in frames {
        let key = delta_text_key(frame);
        let switch = key.is_some() && field.is_some() && key != field;
        if switch {
            text.push_str(FIELD_SEPARATOR);
        }
        if key.is_some() {
            field = key;
        }
        collect_sse_payload_text(frame, &mut text);
        ends.push(text.len());
        separated.push(switch);
    }
    (text, ends, separated)
}

/// Azure custom blocklist results: `filtered` verdicts and blocklist ids
/// (short operator-chosen names, never model output), either as an object
/// with `details` or as the older bare list.
fn blocklist_annotation(value: &Value) -> bool {
    let entry = |entry: &Value| {
        entry.as_object().is_some_and(|fields| {
            fields.iter().all(|(key, field)| match key.as_str() {
                "filtered" => field.is_boolean() || field.is_null(),
                "id" => field.as_str().is_some_and(|id| {
                    id.len() <= 64
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
                }),
                _ => false,
            })
        })
    };
    match value {
        Value::Array(entries) => entries.iter().all(entry),
        Value::Object(fields) => fields.iter().all(|(key, field)| match key.as_str() {
            "filtered" => field.is_boolean() || field.is_null(),
            "details" => field
                .as_array()
                .is_some_and(|entries| entries.iter().all(entry)),
            _ => false,
        }),
        _ => false,
    }
}

/// Azure's per-choice content-filter annotations: known categories whose
/// leaves are booleans, numbers or severity levels, so they carry no text.
fn filter_annotation(value: &Value) -> bool {
    let leaf = |key: &str, value: &Value| {
        value.is_null()
            || value.is_boolean()
            || value.is_number()
            || (key == "severity"
                && matches!(value.as_str(), Some("safe" | "low" | "medium" | "high")))
    };
    value.as_object().is_some_and(|fields| {
        fields.iter().all(|(key, value)| match key.as_str() {
            "check_offset" | "start_offset" | "end_offset" => value.is_number(),
            // Operator-defined blocklists: a verdict and the blocklist names.
            "custom_blocklists" => blocklist_annotation(value),
            "hate"
            | "self_harm"
            | "sexual"
            | "violence"
            | "jailbreak"
            | "profanity"
            | "protected_material_text"
            | "protected_material_code"
            | "indirect_attack" => value.as_object().is_some_and(|result| {
                let protected = key.starts_with("protected_material_");
                result.iter().all(|(key, value)| match key.as_str() {
                    // Protected material's source: an envelope lane
                    // (`EnvelopeLanes::observe_choice`), there only.
                    "citation" => {
                        protected
                            && value.as_object().is_some_and(|citation| {
                                citation.iter().all(|(key, value)| {
                                    matches!(key.as_str(), "URL" | "license")
                                        && (value.is_string() || value.is_null())
                                })
                            })
                    }
                    _ => {
                        matches!(key.as_str(), "filtered" | "detected" | "severity")
                            && leaf(key, value)
                    }
                })
            }),
            _ => false,
        })
    })
}

/// vLLM's reasoning parsers end the reasoning and start the answer in one
/// delta when `</think>` falls inside a multi-token step. Such a frame is
/// split into a reasoning frame and an answer frame (clients join each
/// field across deltas, so the result is the same text), each simple, so
/// the answer keeps streaming. `None` for any other frame.
pub(in crate::pipeline) fn split_boundary(frame: &Value) -> Option<[Value; 2]> {
    split_boundary_with(frame, None)
}

/// [`split_boundary`], given `has_token_mirrors(frame)` when the caller has
/// it already (`mirrors`). The guards are pure early `None`s: the cheap
/// delta ones go first.
pub(in crate::pipeline) fn split_boundary_with(
    frame: &Value,
    mirrors: Option<bool>,
) -> Option<[Value; 2]> {
    let choice = match frame.get("choices")?.as_array()?.as_slice() {
        [choice] => choice,
        _ => return None,
    };
    let delta = choice.get("delta")?.as_object()?;
    let text = |key: &str| {
        delta
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
    };
    text("content")?;
    let (reasoning_content, reasoning) = (text("reasoning_content"), text("reasoning"));
    if reasoning_content.is_none() && reasoning.is_none()
        || reasoning_content.is_some() && reasoning.is_some() && reasoning != reasoning_content
    {
        return None;
    }
    if ["text", "logprobs"]
        .iter()
        .any(|key| choice.get(*key).is_some_and(|value| !value.is_null()))
    {
        return None;
    }
    // Token mirrors (logprobs, token ids) cover the whole step and cannot
    // be split between the halves.
    if mirrors.unwrap_or_else(|| super::has_token_mirrors(frame)) {
        return None;
    }
    let mut first = frame.clone();
    let mut second = frame.clone();
    // `choices` is a one-element array (above), so these get chains read
    // what `pointer_mut("/choices/0/delta")` would.
    if let Some(delta) = first
        .get_mut("choices")
        .and_then(|choices| choices.get_mut(0))
        .and_then(|choice| choice.get_mut("delta"))
        .and_then(Value::as_object_mut)
    {
        delta.remove("content");
    }
    // Every other string the provider sent once stays once, on the answer
    // half (finish_reason, stop_reason, annotations, usage, a fingerprint):
    // a copy on both halves would be judged twice wherever lanes join the
    // frames.
    if let Some(choice) = first
        .get_mut("choices")
        .and_then(|choices| choices.get_mut(0))
        .and_then(Value::as_object_mut)
    {
        choice.retain(|key, _| matches!(key.as_str(), "index" | "delta" | "logprobs"));
    }
    if let Some(object) = first.as_object_mut() {
        object.retain(|key, _| {
            matches!(
                key.as_str(),
                "id" | "object" | "created" | "model" | "choices"
            )
        });
    }
    if let Some(delta) = second
        .get_mut("choices")
        .and_then(|choices| choices.get_mut(0))
        .and_then(|choice| choice.get_mut("delta"))
        .and_then(Value::as_object_mut)
    {
        for key in [
            "reasoning_content",
            "reasoning",
            "reasoning_details",
            "role",
        ] {
            delta.remove(key);
        }
    }
    (simple_content_delta(&first) && simple_content_delta(&second)).then_some([first, second])
}
