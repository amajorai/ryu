//! Working-memory schema mode: RFC 7386 merge patches and the JSON Schema
//! subset a schema-mode document is validated against.

use anyhow::{bail, Result};
use serde_json::{Map, Value};

use super::{invalid, MAX_DEPTH, MAX_WORKING_MEMORY_SPEC_BYTES};

/// Apply an RFC 7386 JSON merge patch: objects merge recursively, `null`
/// removes a key, and any other value replaces the target.
pub fn merge_patch(target: Value, patch: Value, depth: usize) -> Result<Value> {
    if depth > MAX_DEPTH {
        return Err(invalid("working memory is nested too deeply"));
    }
    let Value::Object(patch) = patch else {
        return Ok(patch);
    };
    let mut target = match target {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    for (key, value) in patch {
        if value.is_null() {
            target.remove(&key);
            continue;
        }
        let current = target.remove(&key).unwrap_or(Value::Null);
        target.insert(key, merge_patch(current, value, depth + 1)?);
    }
    Ok(Value::Object(target))
}

pub(super) fn validate_schema_spec(schema: &Value) -> Result<()> {
    let Some(map) = schema.as_object() else {
        bail!("a working memory schema must be a JSON Schema object");
    };
    let encoded_len = serde_json::to_vec(schema).map_or(usize::MAX, |bytes| bytes.len());
    if encoded_len > MAX_WORKING_MEMORY_SPEC_BYTES {
        bail!("working memory schema exceeds {MAX_WORKING_MEMORY_SPEC_BYTES} bytes");
    }
    match map.get("type") {
        None => Ok(()),
        Some(Value::String(kind)) if kind == "object" => Ok(()),
        Some(_) => bail!("a working memory schema must describe an object (`type: \"object\"`)"),
    }
}

fn type_matches(value: &Value, kind: &str) -> bool {
    match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        // Unknown type keywords are not enforced (forward compatible).
        _ => true,
    }
}

/// Validate `value` against the JSON Schema subset working memory enforces:
/// `type` (string or list), `enum`, `const`, `properties`, `required`,
/// `additionalProperties: false | schema`, `items`, and `anyOf`. Unknown
/// keywords are ignored rather than rejected, so a schema produced by zod /
/// valibot / arktype is accepted as-is.
pub(super) fn validate_value(
    value: &Value,
    schema: &Value,
    path: &str,
    depth: usize,
    errors: &mut Vec<String>,
) {
    if depth > MAX_DEPTH || errors.len() >= 8 {
        return;
    }
    let Some(schema) = schema.as_object() else {
        return;
    };
    match schema.get("type") {
        Some(Value::String(kind)) if !type_matches(value, kind) => {
            errors.push(format!("{path} must be {kind}"));
            return;
        }
        Some(Value::Array(kinds)) => {
            let ok = kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| type_matches(value, kind));
            if !ok {
                errors.push(format!("{path} has the wrong type"));
                return;
            }
        }
        _ => {}
    }
    if let Some(Value::Array(options)) = schema.get("enum") {
        if !options.contains(value) {
            errors.push(format!("{path} must be one of the allowed values"));
        }
    }
    if let Some(expected) = schema.get("const") {
        if expected != value {
            errors.push(format!("{path} must equal its constant"));
        }
    }
    if let Some(Value::Array(branches)) = schema.get("anyOf") {
        let matched = branches.iter().any(|branch| {
            let mut scratch = Vec::new();
            validate_value(value, branch, path, depth + 1, &mut scratch);
            scratch.is_empty()
        });
        if !matched {
            errors.push(format!("{path} matches none of the allowed shapes"));
        }
    }
    if let Value::Object(object) = value {
        let properties = schema.get("properties").and_then(Value::as_object);
        if let Some(Value::Array(required)) = schema.get("required") {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    errors.push(format!("{path}.{name} is required"));
                }
            }
        }
        for (name, child) in object {
            let child_path = format!("{path}.{name}");
            match properties.and_then(|props| props.get(name)) {
                Some(child_schema) => {
                    validate_value(child, child_schema, &child_path, depth + 1, errors);
                }
                None => match schema.get("additionalProperties") {
                    Some(Value::Bool(false)) => {
                        errors.push(format!("{child_path} is not an allowed property"));
                    }
                    Some(extra @ Value::Object(_)) => {
                        validate_value(child, extra, &child_path, depth + 1, errors);
                    }
                    _ => {}
                },
            }
        }
    }
    if let (Value::Array(items), Some(item_schema)) = (value, schema.get("items")) {
        for (index, item) in items.iter().enumerate() {
            validate_value(
                item,
                item_schema,
                &format!("{path}[{index}]"),
                depth + 1,
                errors,
            );
        }
    }
}
