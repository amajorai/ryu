//! What telemetry, traces, OTLP and push may carry about a device call
//! (design §0.9, §2.2 "Telemetry").
//!
//! A device span records the canonical tool id, the app, the outcome code and
//! the latency, never arguments or results; the OTel `execute_tool` span is
//! opened without arguments, and its result is the outcome envelope only.
//! Push bodies for device approvals are always content-free.

use serde_json::{json, Value};

use super::catalog::catalog;

/// Whether `tool_id` (canonical or alias) names a device tool.
pub(crate) fn is_device_tool_id(tool_id: Option<&str>) -> bool {
    tool_id.is_some_and(super::catalog::is_device_tool_name)
}

/// The only attributes a device span or audit row may carry.
pub(crate) fn span_attributes(canonical_id: &str, outcome: &str, latency_ms: i64) -> Value {
    let tool = catalog().tool(canonical_id);
    let app = tool.map(|tool| tool.app.as_str()).unwrap_or("unknown");
    let risk = tool.map(super::catalog::risk_tags).unwrap_or_default();
    json!({
        "device.tool": canonical_id,
        "device.app": app,
        "device.risk": risk,
        "device.outcome": outcome,
        "device.latency_ms": latency_ms.max(0),
    })
}

/// The outcome code of a device result envelope (`ok` or its error code).
pub(crate) fn outcome_code(result: &Value) -> String {
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        "ok".to_owned()
    } else {
        result
            .get("code")
            .and_then(Value::as_str)
            .and_then(super::codes::DeviceErrorCode::parse)
            .map_or("os_error", super::codes::DeviceErrorCode::as_str)
            .to_owned()
    }
}

/// Record a finished device call on the OTel span and the log, content-free.
pub(crate) fn record_call(
    span: crate::sidecar::gen_ai_spans::ToolSpan,
    canonical_id: &str,
    result: &Value,
    latency_ms: i64,
) {
    let outcome = outcome_code(result);
    let attributes = span_attributes(canonical_id, &outcome, latency_ms);
    span.record_result(Ok(&attributes));
    tracing::info!(
        tool = canonical_id,
        outcome = %outcome,
        latency_ms,
        "device tool call finished"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn span_attributes_never_carry_arguments_or_results() {
        let result = json!({
            "ok": true,
            "data": { "latitude": 37.33, "longitude": -122.03, "contacts": [{ "name": "Sam" }] }
        });
        let outcome = outcome_code(&result);
        let attributes = span_attributes("device.location.current", &outcome, 42);
        let text = attributes.to_string();
        assert!(!text.contains("37.33") && !text.contains("Sam"), "{text}");
        assert_eq!(attributes["device.app"], "location");
        assert_eq!(attributes["device.outcome"], "ok");
        assert_eq!(
            attributes["device.risk"],
            json!(["device.read", "personal_data"])
        );
        let failed = json!({ "ok": false, "code": "made_up <script>", "message": "x" });
        assert_eq!(outcome_code(&failed), "os_error");
        assert!(is_device_tool_id(Some("device_calendar_create")));
        assert!(is_device_tool_id(Some("device.home.set")));
        assert!(!is_device_tool_id(Some("web.fetch")));
        assert!(!is_device_tool_id(None));
    }
}
