//! What the per-device SSE stream writes for each dispatcher frame.

use super::stream::{render_stream_event, STREAM_ROUTE};
use crate::device_tools::frames::{status_frame, DeviceStatus, DeviceUiEvent};
use serde_json::{json, Value};

const KEEP_ALIVE: &str = ": keep-alive\n\n";

fn sse_json(bytes: &[u8]) -> Value {
    let text = std::str::from_utf8(bytes).expect("utf-8 frame");
    let payload = text
        .strip_prefix("data: ")
        .and_then(|rest| rest.strip_suffix("\n\n"))
        .unwrap_or_else(|| panic!("not one SSE data line: {text:?}"));
    serde_json::from_str(payload).expect("json payload")
}

#[test]
fn the_stream_route_is_the_signed_get_template() {
    assert_eq!(STREAM_ROUTE, "/api/device-tools/stream");
}

#[test]
fn data_parts_render_as_one_sse_data_line_with_their_stable_id() {
    let frame = status_frame("call-1", DeviceStatus::Claimed);
    let rendered = sse_json(&render_stream_event(&frame));
    assert_eq!(rendered["type"], "data-device-tool-status");
    assert_eq!(rendered["id"], "devstat-call-1");
    assert_eq!(rendered["data"]["toolCallId"], "call-1");
    assert_eq!(rendered["data"]["state"], "claimed");

    let custom = DeviceUiEvent::Data {
        name: "device-tool-request".to_owned(),
        id: "devreq-x".to_owned(),
        data: json!({ "toolCallId": "x", "tool": "device.calendar.search" }),
    };
    let rendered = sse_json(&render_stream_event(&custom));
    assert_eq!(
        rendered,
        json!({
            "type": "data-device-tool-request",
            "id": "devreq-x",
            "data": { "toolCallId": "x", "tool": "device.calendar.search" },
        })
    );
}

#[test]
fn tool_input_and_output_never_travel_on_the_device_stream() {
    let input = DeviceUiEvent::ToolInput {
        tool_call_id: "call-2".to_owned(),
        tool_name: "device.contacts.search".to_owned(),
        display_input: json!({ "query": "Alex" }),
    };
    let output = DeviceUiEvent::ToolOutput {
        tool_call_id: "call-2".to_owned(),
        display_result: json!({ "contacts": [{ "name": "Alex" }] }),
        is_error: false,
    };
    for event in [input, output] {
        let rendered = render_stream_event(&event);
        assert_eq!(String::from_utf8(rendered).unwrap(), KEEP_ALIVE);
    }
}
