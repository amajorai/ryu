use serde_json::{json, Value};

use super::agent_events::{
    device_tool_in_title, redact_agent_input, redact_agent_output, HistoryMarks,
};

#[test]
fn bridge_prefixed_titles_resolve_and_lookalikes_do_not() {
    for title in [
        "mcp__ryu__device_location_current",
        "ryu.device_location_current",
        "ryu_device_location_current",
        "device.location.current",
        "device_location_current (ryu)",
    ] {
        assert_eq!(
            device_tool_in_title(title).map(|tool| tool.id.as_str()),
            Some("device.location.current"),
            "{title}"
        );
    }
    for title in [
        "Read file",
        "nodevice_location_current",
        "device_unknown",
        "WebFetch",
    ] {
        assert!(device_tool_in_title(title).is_none(), "{title}");
    }
}

#[test]
fn an_echoed_location_result_keeps_only_the_display_form() {
    let tool = device_tool_in_title("mcp__ryu__device_location_current").unwrap();
    let envelope = json!({ "ok": true, "data": {
        "latitude": 37.7749, "longitude": -122.4194, "horizontal_accuracy_m": 900, "approximate": true,
    }});
    let shapes = [
        envelope.clone(),
        json!([{ "type": "text", "text": format!("<external>{envelope}</external>") }]),
        json!({ "content": [{ "type": "content", "content": { "type": "text", "text": envelope.to_string() } }] }),
    ];
    for shape in shapes {
        let shown = redact_agent_output(tool, Some(shape)).unwrap().to_string();
        assert!(shown.contains("Location shared (approximate)"), "{shown}");
        assert!(
            !shown.contains("37.77") && !shown.contains("122.4"),
            "{shown}"
        );
    }
    let opaque = redact_agent_output(tool, Some(json!("lat 37.7749, lon -122.4194"))).unwrap();
    assert!(!opaque.to_string().contains("37.77"), "{opaque}");
    assert!(redact_agent_output(tool, None).is_none());
}

#[test]
fn an_echoed_contact_input_and_result_drop_contact_details() {
    let tool = device_tool_in_title("mcp__ryu__device_contacts_search").unwrap();
    let input = redact_agent_input(
        tool,
        Some(json!({ "name": "Alex Doe", "fields": ["phones"] })),
    )
    .unwrap();
    assert!(!input.to_string().contains("Alex"), "{input}");
    let output = redact_agent_output(
        tool,
        Some(json!({ "ok": true, "data": { "access": "full", "contacts": [
            { "id": "1", "name": "Alex Doe", "phones": ["+1 555 0100"], "emails": ["alex@example.com"] }
        ]}})),
    )
    .unwrap()
    .to_string();
    assert!(output.contains("Alex Doe"), "names are kept: {output}");
    assert!(
        !output.contains("555") && !output.contains("example.com"),
        "{output}"
    );
}

fn tool_part(name: &str, output: Value) -> Value {
    json!({ "type": format!("tool-{name}"), "toolCallId": "t", "state": "output-available", "output": output })
}

#[test]
fn history_marks_untrusted_output_and_earlier_device_reads() {
    let mut marks = HistoryMarks::default();
    marks.add_message("user", &[json!({ "type": "text", "text": "hi" })]);
    marks.add_message(
        "assistant",
        &[tool_part("device_timer_set", json!({ "ok": true }))],
    );
    assert_eq!(marks, HistoryMarks::default(), "device writes mark nothing");

    marks.add_message(
        "assistant",
        &[tool_part("device_location_current", json!({ "ok": true }))],
    );
    assert_eq!(
        marks.private_read.as_deref(),
        Some("device.location.current")
    );
    assert!(!marks.untrusted);

    let mut web = HistoryMarks::default();
    web.add_message(
        "assistant",
        &[json!({ "type": "dynamic-tool", "toolName": "web_fetch", "toolCallId": "w", "state": "output-available", "output": "page" })],
    );
    assert!(web.untrusted);
    let mut pending = HistoryMarks::default();
    pending.add_message(
        "assistant",
        &[json!({ "type": "tool-web_fetch", "toolCallId": "w", "state": "input-available", "input": {} })],
    );
    assert!(
        !pending.untrusted,
        "a call that never returned brought nothing in"
    );
    let mut tool_role = HistoryMarks::default();
    tool_role.add_message("tool", &[]);
    assert!(tool_role.untrusted);
}

#[test]
fn the_acp_filter_redacts_device_frames_and_taints_on_other_agent_tools() {
    use super::agent_events::AgentToolFilter;
    let decl = serde_json::from_value(json!({
        "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
        "foreground": true, "catalog_version": 1, "tools": [{ "app": "location", "permission": "granted" }],
    }))
    .unwrap();
    let offer = std::sync::Arc::new(crate::device_tools::DeviceOffer::new(
        "conv-filter".into(),
        crate::device_tools::identity::DevicePrincipal::LocalOwner,
        decl,
        crate::approvals::policy::ApprovalMode::Smart,
    ));
    let mut filter = AgentToolFilter::new(Some(offer.clone()));
    let (title, input) = filter.on_call(
        "call-1",
        "mcp__ryu__device_location_current".into(),
        "other",
        Some(json!({ "accuracy": "approximate" })),
    );
    assert_eq!(title, "device_location_current");
    assert_eq!(input.unwrap()["tool"], "device.location.current");
    assert!(
        !offer.tainted_input(),
        "the device call itself is not untrusted input"
    );
    let (output, _) = filter.on_result(
        "call-1",
        Some(json!({ "rawOutput": { "ok": true, "data": { "latitude": 37.7749, "longitude": -122.4194 } } })),
        Some(json!({ "accuracy": "approximate", "note": "home 37.7749" })),
        true,
    );
    let shown = output.unwrap().to_string();
    assert!(shown.contains("Location shared (approximate)"), "{shown}");
    assert!(!shown.contains("37.77"), "{shown}");

    let (_, untouched) = filter.on_result("other", Some(json!("plain")), None, true);
    assert!(untouched.is_none());
    filter.on_call("call-2", "Thinking".into(), "think", None);
    assert!(!offer.tainted_input());
    let (title, input) = filter.on_call(
        "call-3",
        "WebFetch https://example.com".into(),
        "fetch",
        Some(json!({ "url": "https://example.com" })),
    );
    assert_eq!(title, "WebFetch https://example.com");
    assert_eq!(input.unwrap()["url"], "https://example.com");
    assert!(offer.tainted_input(), "an agent's own fetch marks the turn");
}

fn contacts_offer() -> std::sync::Arc<crate::device_tools::DeviceOffer> {
    let decl = serde_json::from_value(json!({
        "device_id": uuid::Uuid::new_v4().to_string(), "app": "ryu-bot", "platform": "ios",
        "foreground": true, "catalog_version": 1,
        "tools": [{ "app": "contacts", "permission": "granted" }],
    }))
    .unwrap();
    std::sync::Arc::new(crate::device_tools::DeviceOffer::new(
        "conv-correlate".into(),
        crate::device_tools::identity::DevicePrincipal::LocalOwner,
        decl,
        crate::approvals::policy::ApprovalMode::Smart,
    ))
}

#[test]
fn a_device_call_the_agent_titles_freely_is_redacted_by_bridge_correlation() {
    use super::agent_events::AgentToolFilter;
    use super::catalog::catalog;
    let offer = contacts_offer();
    let mut filter = AgentToolFilter::new(Some(offer.clone()));
    let args = json!({ "name": "Jane Roe", "fields": ["phones"] });
    // The agent announces the call under its own title BEFORE the bridge
    // runs it: the input already has a contacts-search shape, so it is shown
    // redacted (no contact name) and does not taint the turn yet.
    let (title, shown) = filter.on_call(
        "agent-7",
        "Looking someone up".into(),
        "other",
        Some(json!({ "name": "Jane Roe", "fields": ["phones"] })),
    );
    assert_eq!(title, "Looking someone up");
    let shown = shown.unwrap().to_string();
    assert!(!shown.contains("Jane"), "{shown}");
    assert!(!offer.tainted_input());
    // The bridge dispatches it and records arguments and envelope.
    let tool = catalog().tool("device.contacts.search").unwrap();
    let slot = offer.bridge_calls.record_args(tool, &args);
    let envelope = json!({ "ok": true, "data": { "contacts": [
        { "name": "Jane Roe", "phones": ["+1 555 0100"] },
    ] } });
    offer.bridge_calls.record_result(slot, &envelope);
    // The agent's final update echoes the full result.
    let (output, input) = filter.on_result(
        "agent-7",
        Some(json!([{ "type": "text", "text": envelope.to_string() }])),
        None,
        true,
    );
    let output = output.unwrap().to_string();
    assert!(!output.contains("555"), "{output}");
    assert!(output.contains("Jane Roe"), "names only: {output}");
    let input = input.expect("the opening frame is corrected").to_string();
    assert!(
        input.contains("device.contacts.search") && !input.contains("Jane"),
        "{input}"
    );
    assert!(!offer.tainted_input());

    // A call announced AFTER the bridge recorded it is recognized at once,
    // even wrapped in another object.
    let (title, input) = filter.on_call(
        "agent-8",
        "tool".into(),
        "other",
        Some(json!({ "server": "ryu", "arguments": { "name": "Jane Roe", "fields": ["phones"] } })),
    );
    assert_eq!(title, "device_contacts_search");
    assert!(!input.unwrap().to_string().contains("Jane"));
}

#[test]
fn a_shape_alike_agent_tool_that_never_reached_the_bridge_taints_the_turn() {
    use super::agent_events::AgentToolFilter;
    let offer = contacts_offer();
    let mut filter = AgentToolFilter::new(Some(offer.clone()));
    let (_, shown) = filter.on_call(
        "agent-9",
        "Search names".into(),
        "search",
        Some(json!({ "name": "Jane Roe" })),
    );
    assert!(!shown.unwrap().to_string().contains("Jane"));
    let (output, _) = filter.on_result("agent-9", Some(json!("3 matches")), None, false);
    assert_eq!(output, Some(json!("3 matches")));
    assert!(!offer.tainted_input(), "not settled yet");
    filter.on_result("agent-9", Some(json!("3 matches")), None, true);
    assert!(offer.tainted_input(), "it was the agent's own tool");
}
