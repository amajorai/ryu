//! Input validation, canonicalization and hashing for device calls.
//!
//! Core validates every call against the catalog schema (a closed subset of
//! JSON Schema: `type`, `required`, `additionalProperties:false`, string and
//! number bounds, `enum`, `maxItems`, `format:date-time`) and the limits in
//! design §3.4, then freezes the canonical input. `input_sha256` is computed
//! over a key-sorted serialization, so the approval, the claim and the result
//! all bind to the same bytes.

use chrono::{DateTime, Duration, FixedOffset, NaiveDateTime, TimeZone};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use super::catalog::CatalogTool;
use super::codes::DeviceErrorCode;

/// Clock and device facts the limits are evaluated in.
#[derive(Clone, Copy, Debug)]
pub(crate) struct ValidationContext {
    pub(crate) now_ms: i64,
    /// The device's declared UTC offset, used for times without an offset.
    pub(crate) utc_offset_min: i32,
}

/// A validation failure: the stable code plus a model-facing detail.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct InputError {
    pub(crate) code: DeviceErrorCode,
    pub(crate) detail: String,
}

fn invalid(detail: impl Into<String>) -> InputError {
    InputError {
        code: DeviceErrorCode::InvalidInput,
        detail: detail.into(),
    }
}

fn out_of_range(detail: impl Into<String>) -> InputError {
    InputError {
        code: DeviceErrorCode::OutOfRange,
        detail: detail.into(),
    }
}

const MAX_CALENDAR_RANGE_DAYS: i64 = 14;
const ALARM_WINDOW_HOURS: i64 = 24;

/// Validate `input` for `tool` and return the frozen canonical input.
pub(crate) fn validate_and_canonicalize(
    tool: &CatalogTool,
    input: &Value,
    ctx: ValidationContext,
) -> Result<Value, InputError> {
    let input = if input.is_null() {
        Value::Object(Map::new())
    } else {
        input.clone()
    };
    check_schema(&tool.input_schema, &input, "input")?;
    let mut canonical = input;
    normalize_times(&tool.input_schema, &mut canonical, ctx)?;
    apply_tool_rules(&tool.id, &mut canonical, ctx)?;
    Ok(canonical)
}

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "number" => value.is_number(),
        _ => false,
    }
}

fn check_schema(schema: &Value, value: &Value, at: &str) -> Result<(), InputError> {
    match schema.get("type") {
        Some(Value::String(kind)) if !type_matches(kind, value) => {
            return Err(invalid(format!("{at} must be a {kind}")));
        }
        Some(Value::Array(kinds))
            if !kinds
                .iter()
                .filter_map(Value::as_str)
                .any(|kind| type_matches(kind, value)) =>
        {
            return Err(invalid(format!("{at} has the wrong type")));
        }
        _ => {}
    }
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            return Err(invalid(format!("{at} is not an allowed value")));
        }
    }
    match value {
        Value::Object(map) => check_object(schema, map, at),
        Value::Array(items) => {
            let max = schema.get("maxItems").and_then(Value::as_u64);
            if max.is_some_and(|max| items.len() as u64 > max) {
                return Err(out_of_range(format!("{at} has too many items")));
            }
            if let Some(item_schema) = schema.get("items") {
                for (index, item) in items.iter().enumerate() {
                    check_schema(item_schema, item, &format!("{at}[{index}]"))?;
                }
            }
            Ok(())
        }
        Value::String(text) => check_string(schema, text, at),
        Value::Number(number) => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            let min = schema.get("minimum").and_then(Value::as_f64);
            let max = schema.get("maximum").and_then(Value::as_f64);
            if min.is_some_and(|min| n < min) || max.is_some_and(|max| n > max) || n.is_nan() {
                return Err(out_of_range(format!("{at} is out of range")));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn check_object(schema: &Value, map: &Map<String, Value>, at: &str) -> Result<(), InputError> {
    let properties = schema.get("properties").and_then(Value::as_object);
    for required in schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        if !map.contains_key(required) {
            return Err(invalid(format!("{at}.{required} is required")));
        }
    }
    for (key, child) in map {
        let Some(child_schema) = properties.and_then(|props| props.get(key)) else {
            // Every catalog object is closed; unknown keys are never forwarded.
            return Err(invalid(format!("{at}.{key} is not allowed")));
        };
        check_schema(child_schema, child, &format!("{at}.{key}"))?;
    }
    Ok(())
}

fn check_string(schema: &Value, text: &str, at: &str) -> Result<(), InputError> {
    let chars = text.chars().count() as u64;
    let min = schema.get("minLength").and_then(Value::as_u64);
    let max = schema.get("maxLength").and_then(Value::as_u64);
    if min.is_some_and(|min| (text.trim().chars().count() as u64) < min) {
        return Err(invalid(format!("{at} is too short")));
    }
    if max.is_some_and(|max| chars > max) {
        return Err(out_of_range(format!("{at} is too long")));
    }
    if text
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(invalid(format!("{at} contains control characters")));
    }
    if schema.get("format").and_then(Value::as_str) == Some("date-time")
        && parse_time(text, 0).is_none()
    {
        return Err(invalid(format!("{at} must be an ISO 8601 date-time")));
    }
    Ok(())
}

/// Parse an RFC 3339 time, or a local time without an offset in the device's
/// declared offset.
pub(crate) fn parse_time(text: &str, utc_offset_min: i32) -> Option<DateTime<FixedOffset>> {
    if let Ok(time) = DateTime::parse_from_rfc3339(text.trim()) {
        return Some(time);
    }
    let offset = FixedOffset::east_opt(utc_offset_min.saturating_mul(60))?;
    let naive = NaiveDateTime::parse_from_str(text.trim(), "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(text.trim(), "%Y-%m-%dT%H:%M"))
        .ok()?;
    offset.from_local_datetime(&naive).single()
}

/// Rewrite every `date-time` field as RFC 3339 with an explicit offset, so the
/// phone runs exactly the instant Core validated and approved.
fn normalize_times(
    schema: &Value,
    value: &mut Value,
    ctx: ValidationContext,
) -> Result<(), InputError> {
    let (Some(props), Some(map)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object_mut(),
    ) else {
        return Ok(());
    };
    for (key, child) in map.iter_mut() {
        let is_time = props
            .get(key)
            .and_then(|s| s.get("format"))
            .and_then(Value::as_str)
            == Some("date-time");
        if let (true, Some(text)) = (is_time, child.as_str()) {
            let time = parse_time(text, ctx.utc_offset_min)
                .ok_or_else(|| invalid(format!("input.{key} must be an ISO 8601 date-time")))?;
            *child = Value::String(time.to_rfc3339());
        } else if child.is_string() {
            let trimmed = child.as_str().unwrap_or_default().trim().to_owned();
            *child = Value::String(trimmed);
        }
    }
    Ok(())
}

fn time_field(map: &Map<String, Value>, key: &str) -> Option<DateTime<FixedOffset>> {
    map.get(key)
        .and_then(Value::as_str)
        .and_then(|text| DateTime::parse_from_rfc3339(text).ok())
}

fn apply_tool_rules(
    tool_id: &str,
    value: &mut Value,
    ctx: ValidationContext,
) -> Result<(), InputError> {
    let map = value
        .as_object_mut()
        .ok_or_else(|| invalid("input must be an object"))?;
    let now = chrono::Utc
        .timestamp_millis_opt(ctx.now_ms)
        .single()
        .ok_or_else(|| invalid("clock unavailable"))?;
    match tool_id {
        "device.calendar.search" => {
            let (Some(start), Some(end)) = (time_field(map, "start"), time_field(map, "end"))
            else {
                return Err(invalid("start and end are required"));
            };
            if end <= start {
                return Err(out_of_range("end must be after start"));
            }
            if end - start > Duration::days(MAX_CALENDAR_RANGE_DAYS) {
                return Err(out_of_range("the range must be at most 14 days"));
            }
        }
        "device.calendar.create" | "device.calendar.update" => {
            if let (Some(start), Some(end)) = (time_field(map, "start"), time_field(map, "end")) {
                if end < start {
                    return Err(out_of_range("end must not be before start"));
                }
            }
        }
        "device.alarm.set" => {
            let at = time_field(map, "at").ok_or_else(|| invalid("at is required"))?;
            if at <= now || at > now + Duration::hours(ALARM_WINDOW_HOURS) {
                return Err(out_of_range("the alarm must be within the next 24 hours"));
            }
        }
        "device.contacts.search" => {
            let name = map.get("name").and_then(Value::as_str).unwrap_or_default();
            if name.contains(['*', '%', '?']) {
                return Err(invalid("contact names cannot contain wildcards"));
            }
            if name.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
                return Err(invalid("a contact name needs at least 2 letters or digits"));
            }
            map.entry("fields")
                .or_insert_with(|| Value::Array(Vec::new()));
            map.entry("limit").or_insert_with(|| Value::from(5));
        }
        "device.location.current" => {
            map.entry("accuracy")
                .or_insert_with(|| Value::String("approximate".to_owned()));
        }
        _ => {}
    }
    Ok(())
}

/// Serialize with object keys sorted at every level (stable across builds and
/// serde_json feature sets).
pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        Value::String(key.clone()),
                        canonical_json(&map[key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", body.join(","))
        }
        other => other.to_string(),
    }
}

/// Lowercase hex SHA-256 of the canonical serialization.
pub(crate) fn input_sha256(value: &Value) -> String {
    hex::encode(Sha256::digest(canonical_json(value).as_bytes()))
}
