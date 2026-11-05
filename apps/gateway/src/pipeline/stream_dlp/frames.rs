//! Mapping text-level results back onto delta frames.

use serde_json::Value;

/// Whether a frame's text can be rewritten at text level: every choice's
/// `delta.content` is a string, null or absent, and its other strings are
/// protocol values (`role`, `finish_reason`) that cannot carry part of a
/// value. Anything else keeps the per-string path and its cross-lane mask.
pub(in crate::pipeline) fn content_eligible(frame: &Value) -> bool {
    let Some(choices) = frame.get("choices").and_then(Value::as_array) else {
        return false;
    };
    choices.iter().all(|choice| {
        let delta = choice.get("delta");
        super::super::DELTA_TEXT_KEYS.iter().all(|key| {
            delta
                .and_then(|delta| delta.get(*key))
                .is_none_or(|text| text.is_string() || text.is_null())
        }) && delta
            .and_then(|delta| delta.get("role"))
            .is_none_or(super::super::protocol_role)
            && choice
                .get("finish_reason")
                .is_none_or(super::super::protocol_finish_reason)
    })
}

/// The delta field a frame's text lives in: the one text field with text, or
/// else the first one that is a string (an empty `content` can take carried
/// text). Returns the delta and the field's key.
fn text_slot(frame: &mut Value) -> Option<(&mut serde_json::Map<String, Value>, &'static str)> {
    let delta = frame
        .get_mut("choices")
        .and_then(Value::as_array_mut)
        .and_then(|choices| choices.first_mut())
        .and_then(|choice| choice.get_mut("delta"))
        .and_then(Value::as_object_mut)?;
    let key = super::super::DELTA_TEXT_KEYS
        .iter()
        .find(|key| {
            delta
                .get(**key)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.is_empty())
        })
        .or_else(|| {
            super::super::DELTA_TEXT_KEYS
                .iter()
                .find(|key| delta.get(**key).is_some_and(Value::is_string))
        })?;
    Some((delta, key))
}

/// Put each segment into its frame's text field (see [`text_slot`]). Text for
/// a frame without one moves to the next frame that has one. A frame marked
/// `separated` had `FIELD_SEPARATOR` put before its text in the scan text;
/// its segment must still start with it, and the separator is dropped. OpenRouter's
/// mirrored `reasoning_details` text follows the rewritten `reasoning`.
/// `false` when text is left over or a separator was consumed by a match, so
/// the caller masks instead.
pub(in crate::pipeline) fn apply_segments(
    frames: &mut [Value],
    segments: Vec<String>,
    separated: &[bool],
) -> bool {
    if frames.len() != segments.len() || frames.len() != separated.len() {
        return false;
    }
    let mut carry = String::new();
    for ((frame, segment), separated) in frames.iter_mut().zip(segments).zip(separated) {
        let segment = if *separated {
            match segment.strip_prefix(super::super::FIELD_SEPARATOR) {
                Some(rest) => rest.to_owned(),
                None => return false,
            }
        } else {
            segment
        };
        carry.push_str(&segment);
        let mirror_text = first_choice(frame)
            .and_then(|choice| choice.get("text"))
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty());
        if let Some((delta, key)) = text_slot(frame) {
            let text = std::mem::take(&mut carry);
            // A simple frame carries one text, so any non-empty mirror of it
            // follows (whichever field holds it).
            mirror_reasoning(delta, &text);
            // Other text fields mirroring this one (vLLM `reasoning` =
            // `reasoning_content`) follow it.
            let original = delta.get(key).cloned();
            for other in super::super::DELTA_TEXT_KEYS {
                if other != key && original.is_some() && delta.get(other) == original.as_ref() {
                    delta.insert(other.to_owned(), Value::String(text.clone()));
                }
            }
            delta.insert(key.to_owned(), Value::String(text.clone()));
            // Together AI's choice-level `text` mirror follows too.
            if mirror_text {
                if let Some(choice_text) = frame
                    .get_mut("choices")
                    .and_then(Value::as_array_mut)
                    .and_then(|choices| choices.first_mut())
                    .and_then(|choice| choice.get_mut("text"))
                {
                    *choice_text = Value::String(text);
                }
            }
        }
    }
    carry.is_empty()
}

/// Rewrite OpenRouter's mirrored `reasoning_details[].text` to `text`.
fn mirror_reasoning(delta: &mut serde_json::Map<String, Value>, text: &str) {
    if let Some(entries) = delta
        .get_mut("reasoning_details")
        .and_then(Value::as_array_mut)
    {
        for entry in entries {
            for field in ["text", "summary"] {
                if let Some(Value::String(mirror)) = entry.get_mut(field) {
                    if !mirror.is_empty() {
                        text.clone_into(mirror);
                    }
                }
            }
        }
    }
}

fn first_choice(frame: &Value) -> Option<&Value> {
    frame.get("choices")?.as_array()?.first()
}

#[cfg(test)]
#[path = "separator_test.rs"]
mod separator_test;
