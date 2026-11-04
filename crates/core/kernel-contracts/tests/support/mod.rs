//! Shared rendering for the blessed-file guards.
//!
//! serde_json's object order is a Cargo feature: with `preserve_order` (which any
//! crate in the same build can switch on through feature unification) maps keep
//! insertion order, without it they sort their keys. The checked-in files must not
//! depend on which other crates were built alongside this one, so every snapshot
//! is rendered with its object keys sorted, which is the order the blessed files
//! already use.

use serde_json::{Map, Value};

/// `value` with every object's keys in sorted order, recursively.
pub fn sorted_keys(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            let mut sorted = Map::new();
            for (key, child) in entries {
                sorted.insert(key, sorted_keys(child));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted_keys).collect()),
        other => other,
    }
}

/// The blessed-file form of `value`: sorted keys, pretty JSON, trailing newline.
pub fn blessed_json(value: Value) -> String {
    let mut pretty =
        serde_json::to_string_pretty(&sorted_keys(value)).expect("value serialises to JSON");
    pretty.push('\n');
    pretty
}
