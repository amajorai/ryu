//! Per-token mirrors of a choice's text (`logprobs`, token ids): dropped
//! whenever the text they mirror is redacted, sanitized or masked.

use serde_json::Value;

use super::redact_json_strings;

/// The per-token mirrors of a choice's text: `logprobs` (tokens and their
/// `bytes`), and token ids (vLLM's `token_ids`, Together's `delta.token_id`).
const TOKEN_MIRRORS: [&str; 2] = ["logprobs", "token_ids"];
const DELTA_TOKEN_MIRRORS: [&str; 2] = ["token_id", "token_ids"];

/// Whether a lane path (`collect_sse_payload_lanes`) is a choice's token
/// mirror: its `logprobs` / `token_ids`, or a delta's or message's token ids.
/// Their entries carry no `index`, so lanes join the N-th token (or
/// alternative) of every frame: text no client renders. They are judged per
/// frame (`json_string_projection`) and per string, and the tokens in
/// sequence (`token_sequences`), never by position; and they are dropped
/// whenever the text they mirror changes.
pub(in crate::pipeline) fn token_mirror_lane(path: &str) -> bool {
    let Some((_, rest)) = path
        .strip_prefix("/choices/")
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let under = |rest: &str, key: &str| {
        rest.strip_prefix(key)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with('/'))
    };
    TOKEN_MIRRORS.iter().any(|key| under(rest, key))
        || ["delta/", "message/"].iter().any(|field| {
            rest.strip_prefix(field)
                .is_some_and(|rest| DELTA_TOKEN_MIRRORS.iter().any(|key| under(rest, key)))
        })
}

/// Each choice's sampled tokens in order (`logprobs.content[*].token`,
/// `logprobs.refusal[*].token`), the text a client concatenating tokens
/// rebuilds, appended to `out` (so frames join in order). Keyed outside
/// `/choices/`, so no lane path (`token_mirror_lane`) can alias one;
/// alternatives (`top_logprobs`) are never joined.
pub(in crate::pipeline) fn token_sequences(
    frame: &Value,
    out: &mut std::collections::BTreeMap<String, String>,
) {
    let Some(choices) = frame
        .get("choices")
        .and_then(super::evaluated::choice_entries)
    else {
        return;
    };
    for (position, choice) in choices.into_iter().enumerate() {
        let Some(logprobs) = choice.get("logprobs") else {
            continue;
        };
        for field in ["content", "refusal"] {
            let Some(entries) = logprobs.get(field).and_then(Value::as_array) else {
                continue;
            };
            let key = format!(
                "\u{2}tokens/{}/{field}",
                super::lane_segment(choice, position)
            );
            for token in entries
                .iter()
                .filter_map(|entry| entry.get("token")?.as_str())
            {
                out.entry(key.clone()).or_default().push_str(token);
            }
        }
    }
}

fn choices_mut(frame: &mut Value) -> Vec<&mut Value> {
    match frame.get_mut("choices") {
        Some(Value::Array(choices)) => choices.iter_mut().collect(),
        Some(Value::Object(choices)) => choices.values_mut().collect(),
        _ => Vec::new(),
    }
}

/// Whether any choice of a frame carries a per-token mirror of its text.
pub(in crate::pipeline) fn has_token_mirrors(frame: &Value) -> bool {
    let mirrored = |choice: &Value| {
        let present =
            |value: &Value, key: &str| value.get(key).is_some_and(|value| !value.is_null());
        TOKEN_MIRRORS.iter().any(|key| present(choice, key))
            || ["delta", "message"].iter().any(|field| {
                choice
                    .get(*field)
                    .is_some_and(|delta| DELTA_TOKEN_MIRRORS.iter().any(|key| present(delta, key)))
            })
    };
    any_choice(frame, mirrored)
}

/// Whether `pred` holds for any choice of a frame, visited in the same order
/// as collecting `choices` (array elements, or object values) would.
fn any_choice(frame: &Value, pred: impl FnMut(&Value) -> bool) -> bool {
    match frame.get("choices") {
        Some(Value::Array(choices)) => choices.iter().any(pred),
        Some(Value::Object(choices)) => choices.values().any(pred),
        _ => false,
    }
}

/// Whether any choice of a frame carries token ids that may run ahead of its
/// text: vLLM's `token_ids` (on the choice or its delta). Together's
/// per-chunk `delta.token_id` stays incremental: its batch drops every
/// frame's mirrors once anything in it changed, which covers an empty-text
/// chunk whose token's text arrives in the next one.
pub(in crate::pipeline) fn token_ids_ahead(frame: &Value) -> bool {
    let present = |value: Option<&Value>| {
        value
            .and_then(|value| value.get("token_ids"))
            .is_some_and(|ids| !ids.is_null())
    };
    any_choice(frame, |choice| {
        present(Some(choice)) || present(choice.get("delta"))
    })
}

/// Drop every choice's per-token mirrors of its text (`logprobs` and token
/// ids). Each token there mirrors a piece of the generated text, so a value
/// redacted, sanitized or masked in the text would survive in them.
pub(in crate::pipeline) fn drop_choice_logprobs(value: &mut Value) {
    match value {
        Value::Array(values) => {
            for value in values {
                drop_choice_logprobs(value);
            }
        }
        Value::Object(_) => {
            for choice in choices_mut(value) {
                let Value::Object(fields) = choice else {
                    continue;
                };
                for key in TOKEN_MIRRORS {
                    if let Some(field) = fields.get_mut(key) {
                        *field = Value::Null;
                    }
                }
                for field in ["delta", "message"] {
                    if let Some(Value::Object(delta)) = fields.get_mut(field) {
                        for key in DELTA_TOKEN_MIRRORS {
                            if let Some(mirror) = delta.get_mut(key) {
                                *mirror = Value::Null;
                            }
                        }
                    }
                }
            }
        }
        _ => {}
    }
}

/// Redact a response's strings, dropping its token mirrors when that changed
/// anything (they would carry the redacted value).
pub(in crate::pipeline) fn redact_with_mirrors(
    value: &mut Value,
    scanner: &dyn crate::firewall::FirewallBackend,
) {
    let before = has_token_mirrors_any(value).then(|| value.clone());
    redact_json_strings(value, scanner);
    if before.is_some_and(|before| before != *value) {
        drop_choice_logprobs(value);
    }
}

fn has_token_mirrors_any(value: &Value) -> bool {
    match value {
        Value::Array(values) => values.iter().any(has_token_mirrors),
        other => has_token_mirrors(other),
    }
}
