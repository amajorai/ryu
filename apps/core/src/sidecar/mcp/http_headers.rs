//! SEP-2243 `x-mcp-header` projection for Streamable HTTP tool calls.

use std::collections::HashSet;

use anyhow::{anyhow, Result};
use axum::http::{HeaderMap, HeaderName};
use base64::Engine as _;
use serde_json::Value;

const MAX_ANNOTATIONS: usize = 50;
const MAX_SCHEMA_DEPTH: usize = 32;
const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
const MAX_HEADER_BYTES_TOTAL: usize = 16 * 1024;
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const BASE64_SENTINEL_PREFIX: &str = "=?base64?";
const BASE64_SENTINEL_SUFFIX: &str = "?=";

#[derive(Debug)]
struct HeaderAnnotation {
    name: String,
    path: Vec<String>,
    value_type: String,
}

/// Build the custom HTTP parameter headers for a tool call from its current
/// `inputSchema`. Invalid annotations reject this tool definition at the client
/// boundary, while unrelated tools remain usable.
pub(super) fn tool_parameter_headers(
    input_schema: Option<&Value>,
    arguments: &Value,
) -> Result<Vec<(String, String)>> {
    let Some(input_schema) = input_schema else {
        return Ok(Vec::new());
    };

    let mut annotations = Vec::new();
    let mut names = HashSet::new();
    collect_annotations(
        input_schema,
        Vec::new(),
        true,
        true,
        0,
        &mut names,
        &mut annotations,
    )?;

    let mut headers: Vec<(String, String)> = Vec::with_capacity(annotations.len());
    for annotation in annotations {
        let Some(value) = value_at_path(arguments, &annotation.path) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let value = encode_parameter(value, &annotation.value_type).map_err(|error| {
            anyhow!(
                "invalid value for x-mcp-header parameter '{}': {error}",
                annotation.path.join(".")
            )
        })?;
        let header_value = encode_mcp_header_value(&value).map_err(|_| {
            anyhow!(
                "x-mcp-header parameter '{}' exceeds the local 8 KiB header-value limit",
                annotation.path.join(".")
            )
        })?;
        let header_name = format!("Mcp-Param-{}", annotation.name);
        let current_header_bytes = headers
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>();
        if current_header_bytes + header_name.len() + header_value.len() > MAX_HEADER_BYTES_TOTAL {
            anyhow::bail!("tool x-mcp-header values exceed the local 16 KiB total limit");
        }
        headers.push((header_name, header_value));
    }
    Ok(headers)
}

/// Validate an inbound modern `tools/call` against the tool's current schema.
/// Header values are decoded before comparison, so Base64 is treated as an
/// encoding only and never as a security boundary.
pub(in crate::sidecar) fn validate_parameter_headers(
    input_schema: Option<&Value>,
    arguments: &Value,
    headers: &HeaderMap,
) -> Result<()> {
    let expected = tool_parameter_headers(input_schema, arguments)?;
    let expected_names = expected
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();

    for name in headers.keys().filter(|name| {
        name.as_str()
            .get(..10)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("Mcp-Param-"))
    }) {
        if !expected_names.contains(&name.as_str().to_ascii_lowercase()) {
            anyhow::bail!("unexpected MCP parameter header '{name}'")
        }
    }

    for (name, expected_value) in expected {
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| anyhow!("invalid MCP parameter header name"))?;
        let values = headers.get_all(&header_name).iter().collect::<Vec<_>>();
        if values.len() != 1 {
            anyhow::bail!("missing or repeated MCP parameter header '{name}'");
        }
        let actual = values[0]
            .to_str()
            .map_err(|_| anyhow!("MCP parameter header '{name}' is not valid ASCII"))?;
        if !actual
            .bytes()
            .all(|byte| byte == b'\t' || (0x20..=0x7e).contains(&byte))
        {
            anyhow::bail!("MCP parameter header '{name}' contains invalid characters");
        }
        if decode_mcp_header_value(actual)? != decode_mcp_header_value(&expected_value)? {
            anyhow::bail!("MCP parameter header '{name}' does not match the request body");
        }
    }
    Ok(())
}

pub(crate) fn encode_mcp_header_value(value: &str) -> Result<String> {
    let header_value = if requires_base64(value) {
        let encoded = base64::engine::general_purpose::STANDARD.encode(value.as_bytes());
        format!("{BASE64_SENTINEL_PREFIX}{encoded}{BASE64_SENTINEL_SUFFIX}")
    } else {
        value.to_owned()
    };
    if header_value.len() > MAX_HEADER_VALUE_BYTES {
        anyhow::bail!("MCP header value exceeds the local 8 KiB limit");
    }
    Ok(header_value)
}

pub(crate) fn decode_mcp_header_value(value: &str) -> Result<String> {
    if value.starts_with(BASE64_SENTINEL_PREFIX) && value.ends_with(BASE64_SENTINEL_SUFFIX) {
        let encoded =
            &value[BASE64_SENTINEL_PREFIX.len()..value.len() - BASE64_SENTINEL_SUFFIX.len()];
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| anyhow!("MCP parameter header has invalid Base64"))?;
        if base64::engine::general_purpose::STANDARD.encode(&bytes) != encoded {
            anyhow::bail!("MCP parameter header has non-canonical Base64");
        }
        return String::from_utf8(bytes).map_err(|_| anyhow!("MCP parameter header is not UTF-8"));
    }
    if requires_base64(value) {
        anyhow::bail!("MCP parameter header value must use Base64 sentinel encoding");
    }
    Ok(value.to_owned())
}

fn collect_annotations(
    schema: &Value,
    path: Vec<String>,
    valid_properties_path: bool,
    schema_root: bool,
    depth: usize,
    seen_names: &mut HashSet<String>,
    annotations: &mut Vec<HeaderAnnotation>,
) -> Result<()> {
    if depth > MAX_SCHEMA_DEPTH {
        anyhow::bail!("tool inputSchema exceeds the x-mcp-header nesting limit");
    }

    if let Some(name) = schema.get("x-mcp-header") {
        if !valid_properties_path || schema_root {
            anyhow::bail!(
                "x-mcp-header must be on a property reachable only through properties keys"
            );
        }
        let name = name
            .as_str()
            .filter(|name| !name.is_empty() && name.len() <= 128 && is_http_token(name))
            .ok_or_else(|| anyhow!("x-mcp-header must be a non-empty HTTP token"))?;
        if !seen_names.insert(name.to_ascii_lowercase()) {
            anyhow::bail!("x-mcp-header names must be unique without regard to case");
        }
        let value_type = schema
            .get("type")
            .and_then(Value::as_str)
            .filter(|value_type| matches!(*value_type, "string" | "integer" | "boolean"))
            .ok_or_else(|| {
                anyhow!("x-mcp-header is only valid on string, integer, or boolean parameters")
            })?;
        if annotations.len() >= MAX_ANNOTATIONS {
            anyhow::bail!("tool inputSchema exceeds the 50 x-mcp-header limit");
        }
        annotations.push(HeaderAnnotation {
            name: name.to_owned(),
            path: path.clone(),
            value_type: value_type.to_owned(),
        });
    }

    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (property_name, property_schema) in properties {
            let mut child_path = path.clone();
            child_path.push(property_name.clone());
            collect_annotations(
                property_schema,
                child_path,
                valid_properties_path,
                false,
                depth + 1,
                seen_names,
                annotations,
            )?;
        }
    }

    for keyword in [
        "additionalItems",
        "additionalProperties",
        "contains",
        "contentSchema",
        "else",
        "if",
        "items",
        "not",
        "propertyNames",
        "then",
        "unevaluatedItems",
        "unevaluatedProperties",
    ] {
        if let Some(child) = schema.get(keyword) {
            collect_disallowed_schema_child(child, &path, depth, seen_names, annotations)?;
        }
    }
    for keyword in ["allOf", "anyOf", "oneOf", "prefixItems"] {
        if let Some(Value::Array(children)) = schema.get(keyword) {
            for child in children {
                collect_disallowed_schema_child(child, &path, depth, seen_names, annotations)?;
            }
        }
    }
    for keyword in [
        "$defs",
        "definitions",
        "dependentSchemas",
        "patternProperties",
    ] {
        if let Some(children) = schema.get(keyword).and_then(Value::as_object) {
            for child in children.values() {
                collect_disallowed_schema_child(child, &path, depth, seen_names, annotations)?;
            }
        }
    }
    Ok(())
}

fn collect_disallowed_schema_child(
    child: &Value,
    path: &[String],
    depth: usize,
    seen_names: &mut HashSet<String>,
    annotations: &mut Vec<HeaderAnnotation>,
) -> Result<()> {
    match child {
        Value::Object(_) => collect_annotations(
            child,
            path.to_vec(),
            false,
            false,
            depth + 1,
            seen_names,
            annotations,
        ),
        Value::Array(children) => {
            for child in children {
                collect_disallowed_schema_child(child, path, depth + 1, seen_names, annotations)?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn is_http_token(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

fn value_at_path<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, part| current.get(part))
}

fn encode_parameter(value: &Value, value_type: &str) -> Result<String> {
    match (value_type, value) {
        ("string", Value::String(value)) => Ok(value.clone()),
        ("integer", Value::Number(value)) => {
            let integer = value
                .as_i64()
                .or_else(|| value.as_u64().and_then(|value| i64::try_from(value).ok()))
                .ok_or_else(|| anyhow!("expected an integer in the JavaScript safe range"))?;
            if !(-JS_MAX_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&integer) {
                anyhow::bail!("integer is outside the JavaScript safe range");
            }
            Ok(integer.to_string())
        }
        ("boolean", Value::Bool(value)) => Ok(value.to_string()),
        ("integer", _) => Err(anyhow!("expected an integer")),
        ("string", _) => Err(anyhow!("expected a string")),
        ("boolean", _) => Err(anyhow!("expected a boolean")),
        _ => Err(anyhow!("unsupported annotated type")),
    }
}

fn requires_base64(value: &str) -> bool {
    let bytes = value.as_bytes();
    let edge_whitespace =
        matches!(bytes.first(), Some(b' ' | b'\t')) || matches!(bytes.last(), Some(b' ' | b'\t'));
    let invalid_header_character = bytes
        .iter()
        .any(|byte| !(0x20..=0x7e).contains(byte) || matches!(*byte, b'\r' | b'\n' | 0x7f));
    edge_whitespace
        || invalid_header_character
        || (value.starts_with(BASE64_SENTINEL_PREFIX) && value.ends_with(BASE64_SENTINEL_SUFFIX))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{decode_mcp_header_value, tool_parameter_headers};

    #[test]
    fn custom_headers_follow_nested_annotations_and_encode_unsafe_values() {
        use std::collections::BTreeMap;

        let schema = json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "options": {
                    "type": "object",
                    "properties": {
                        "count": { "type": "integer", "x-mcp-header": "Count" },
                        "text": { "type": "string", "x-mcp-header": "Text" },
                        "enabled": { "type": "boolean", "x-mcp-header": "Enabled" }
                    }
                }
            }
        });
        let headers = tool_parameter_headers(
            Some(&schema),
            &json!({
                "region": "us-west1",
                "options": {
                    "count": 42,
                    "text": "line1\nline2",
                    "enabled": false
                }
            }),
        )
        .expect("valid parameter headers")
        .into_iter()
        .collect::<BTreeMap<_, _>>();

        assert_eq!(
            headers.get("Mcp-Param-Region").map(String::as_str),
            Some("us-west1")
        );
        assert_eq!(
            headers.get("Mcp-Param-Count").map(String::as_str),
            Some("42")
        );
        assert_eq!(
            headers.get("Mcp-Param-Enabled").map(String::as_str),
            Some("false")
        );
        assert_eq!(
            headers.get("Mcp-Param-Text").map(String::as_str),
            Some("=?base64?bGluZTEKbGluZTI=?=")
        );
    }

    #[test]
    fn null_missing_and_unsafe_schema_values_are_handled_at_the_boundary() {
        let schema = json!({
            "type": "object",
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" },
                "count": { "type": "integer", "x-mcp-header": "Count" }
            }
        });
        assert!(
            tool_parameter_headers(Some(&schema), &json!({ "region": null }))
                .expect("null and missing are omitted")
                .is_empty()
        );
        assert!(tool_parameter_headers(
            Some(&json!({ "properties": { "id": { "type": "array", "x-mcp-header": "Id" } } })),
            &json!({ "id": [] })
        )
        .is_err());
        for invalid_schema in [
            json!({
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "x-mcp-header": "Region"
                        }
                    }
                }
            }),
            json!({
                "properties": {
                    "location": {
                        "oneOf": [{ "type": "string", "x-mcp-header": "Region" }]
                    }
                }
            }),
            json!({
                "x-mcp-header": "Region",
                "type": "object",
                "properties": {}
            }),
        ] {
            assert!(
                tool_parameter_headers(Some(&invalid_schema), &json!({})).is_err(),
                "invalid annotation nesting must be rejected"
            );
        }
        assert!(tool_parameter_headers(
            Some(&json!({ "properties": {
                "a": { "type": "string", "x-mcp-header": "Region" },
                "b": { "type": "string", "x-mcp-header": "region" }
            }})),
            &json!({ "a": "one", "b": "two" })
        )
        .is_err());
        assert!(tool_parameter_headers(
            Some(&schema),
            &json!({ "count": 9_007_199_254_740_992_i64 })
        )
        .is_err());
    }

    #[test]
    fn base64_sentinel_and_edge_whitespace_are_encoded() {
        let schema = json!({
            "properties": {
                "sentinel": { "type": "string", "x-mcp-header": "Sentinel" },
                "space": { "type": "string", "x-mcp-header": "Space" }
            }
        });
        let headers = tool_parameter_headers(
            Some(&schema),
            &json!({ "sentinel": "=?base64?literal?=", "space": " value " }),
        )
        .expect("encoded headers")
        .into_iter()
        .collect::<std::collections::BTreeMap<_, _>>();
        assert_eq!(
            headers.get("Mcp-Param-Sentinel").map(String::as_str),
            Some("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=")
        );
        assert_eq!(
            headers.get("Mcp-Param-Space").map(String::as_str),
            Some("=?base64?IHZhbHVlIA==?=")
        );
    }

    #[test]
    fn base64_sentinel_decoder_requires_safe_plain_values_and_canonical_utf8() {
        assert_eq!(
            decode_mcp_header_value("=?base64?SGVsbG8sIOS4lueVjA==?=").unwrap(),
            "Hello, 世界"
        );
        assert_eq!(
            decode_mcp_header_value("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=").unwrap(),
            "=?base64?literal?="
        );
        assert!(decode_mcp_header_value("=?base64?not!base64?=").is_err());
        assert!(decode_mcp_header_value("=?base64?Zh==?=").is_err());
        assert!(decode_mcp_header_value("=?base64?/w==?=").is_err());
        assert!(decode_mcp_header_value(" padded ").is_err());
        assert!(decode_mcp_header_value("世界").is_err());
    }

    #[test]
    fn inbound_parameter_headers_must_match_the_schema_and_body() {
        use axum::http::{HeaderMap, HeaderValue};

        let schema = json!({
            "properties": {
                "region": { "type": "string", "x-mcp-header": "Region" }
            }
        });
        let mut headers = HeaderMap::new();
        headers.insert("Mcp-Param-Region", HeaderValue::from_static("us-west1"));
        assert!(super::validate_parameter_headers(
            Some(&schema),
            &json!({ "region": "us-west1" }),
            &headers
        )
        .is_ok());
        assert!(super::validate_parameter_headers(
            Some(&schema),
            &json!({ "region": "eu-west1" }),
            &headers
        )
        .is_err());
        headers.insert(
            "Mcp-Param-Region",
            HeaderValue::from_static("=?base64?SGVsbG8?="),
        );
        assert!(super::validate_parameter_headers(
            Some(&schema),
            &json!({ "region": "Hello" }),
            &headers
        )
        .is_err());
    }
}
