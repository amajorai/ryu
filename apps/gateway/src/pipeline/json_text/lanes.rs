//! Lane paths: every string leaf of a decoded SSE frame keyed by its JSON
//! path, built in one reused buffer.

use std::{collections::BTreeMap, fmt::Write as _};

use serde_json::Value;

use super::detect::{envelope_lane, may_hold_envelope};
use super::{choice_lane, odd_index};
use crate::pipeline::stream_dlp::envelope::pointer_token;

/// An array entry's lane path segment: its `index` as a lane number, or
/// `~<raw>` for an index that is no lane number, else its position.
pub(in crate::pipeline) fn lane_segment(value: &Value, position: usize) -> String {
    let mut segment = String::new();
    push_lane_segment(&mut segment, value, position);
    segment
}

/// Join each string leaf of `value` under `path` into its lane in `lanes`.
pub(in crate::pipeline) fn collect_sse_payload_lanes(
    value: &Value,
    path: &str,
    lanes: &mut BTreeMap<String, String>,
) {
    walk(value, &mut path.to_owned(), lanes, None);
}

/// `collect_sse_payload_lanes` restricted to the string leaves whose lane
/// path `keep` accepts; every other lane is left out of `lanes`.
pub(in crate::pipeline) fn collect_sse_payload_lanes_where(
    value: &Value,
    path: &str,
    lanes: &mut BTreeMap<String, String>,
    keep: fn(&str) -> bool,
) {
    walk(value, &mut path.to_owned(), lanes, Some(keep));
}

/// `collect_sse_payload_lanes_where(value, "", lanes, envelope_lane)`
/// without walking the `choices` entries that cannot hold an envelope lane
/// (`may_hold_envelope`): the same paths, visited in the same order.
pub(in crate::pipeline) fn collect_envelope_lanes(
    value: &Value,
    lanes: &mut BTreeMap<String, String>,
) {
    let keep: Option<fn(&str) -> bool> = Some(envelope_lane);
    let Value::Object(values) = value else {
        walk(value, &mut String::new(), lanes, keep);
        return;
    };
    let mut path = String::new();
    for (key, value) in values {
        if matches!(key.as_str(), "id" | "model" | "object") {
            continue;
        }
        path.clear();
        path.push('/');
        push_pointer_token(&mut path, key);
        match value {
            Value::Array(entries) if key == "choices" => {
                for (position, entry) in entries.iter().enumerate() {
                    if !may_hold_envelope(entry, position) {
                        continue;
                    }
                    let len = path.len();
                    path.push('/');
                    push_lane_segment(&mut path, entry, position);
                    walk(entry, &mut path, lanes, keep);
                    path.truncate(len);
                }
            }
            value => walk(value, &mut path, lanes, keep),
        }
    }
}

/// `pointer_token(key)` appended to `out`, copying a plain key once.
pub(in crate::pipeline) fn push_pointer_token(out: &mut String, key: &str) {
    if key.contains(['~', '/']) {
        out.push_str(&pointer_token(key));
    } else {
        out.push_str(key);
    }
}

/// The lane walk. `path` holds the current lane path; each child appends its
/// segment and truncates it back, so it always equals `{path}/{segment}`.
fn walk(
    value: &Value,
    path: &mut String,
    lanes: &mut BTreeMap<String, String>,
    keep: Option<fn(&str) -> bool>,
) {
    match value {
        Value::Array(values) => {
            for (position, value) in values.iter().enumerate() {
                // An index a client still merges by (-1, 0.5, "a") but that is
                // not a lane number is keyed by its raw value, so the pieces
                // it joins meet in one lane.
                let len = path.len();
                path.push('/');
                push_lane_segment(path, value, position);
                walk(value, path, lanes, keep);
                path.truncate(len);
            }
        }
        Value::Object(values) => {
            let top = path.is_empty();
            for (key, value) in values {
                if top && matches!(key.as_str(), "id" | "model" | "object") {
                    continue;
                }
                // Escaped (RFC 6901), so a key holding `/` cannot alias
                // another field's lane.
                let len = path.len();
                path.push('/');
                push_pointer_token(path, key);
                walk(value, path, lanes, keep);
                path.truncate(len);
            }
        }
        Value::String(text) => {
            if keep.is_none_or(|keep| keep(path)) {
                match lanes.get_mut(path.as_str()) {
                    Some(lane) => lane.push_str(text),
                    None => {
                        lanes.insert(path.clone(), text.clone());
                    }
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

/// `lane_segment(value, position)` appended to `out`.
fn push_lane_segment(out: &mut String, value: &Value, position: usize) {
    match value.get("index") {
        Some(index) if odd_index(value) => {
            out.push('~');
            push_pointer_token(out, &index.to_string());
        }
        _ => {
            let _ = write!(out, "{}", choice_lane(value, position));
        }
    }
}
