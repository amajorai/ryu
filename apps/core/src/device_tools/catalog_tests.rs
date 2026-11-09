use serde_json::{json, Value};

use super::catalog::{canonical, catalog, is_device_tool_name, ToolStatus};
use super::codes::DeviceErrorCode;
use super::display::{
    display_summary, display_summary_known, redact_input_for_display, redact_result_for_display,
};
use super::validate::{input_sha256, validate_and_canonicalize, ValidationContext};

/// 2026-11-08T12:00:00Z
const NOW_MS: i64 = 1_794_139_200_000;

fn ctx() -> ValidationContext {
    ValidationContext {
        now_ms: NOW_MS,
        utc_offset_min: 0,
    }
}

fn tool(id: &str) -> &'static super::catalog::CatalogTool {
    catalog().tool(id).expect("catalog tool")
}

#[test]
fn aliases_and_canonical_ids_are_a_bijection() {
    let mut ids = std::collections::HashSet::new();
    let mut aliases = std::collections::HashSet::new();
    for tool in &catalog().tools {
        assert!(tool.id.starts_with("device."), "{}", tool.id);
        assert_eq!(tool.alias, tool.id.replace('.', "_"));
        assert!(ids.insert(tool.id.clone()) && aliases.insert(tool.alias.clone()));
        assert_eq!(canonical(&tool.alias), Some(tool.id.as_str()));
        assert_eq!(canonical(&tool.id), Some(tool.id.as_str()));
        assert!(
            catalog().app(&tool.app).is_some(),
            "{} names a known app",
            tool.id
        );
    }
    assert!(is_device_tool_name("device_anything"));
    assert!(!is_device_tool_name("browser_click"));
}

fn assert_closed(schema: &Value, at: &str) {
    if schema.get("type").and_then(Value::as_str) == Some("object") {
        assert_eq!(
            schema["additionalProperties"],
            json!(false),
            "{at} must be closed"
        );
        for (key, child) in schema["properties"].as_object().into_iter().flatten() {
            let lower = key.to_ascii_lowercase();
            assert!(
                !lower.contains("attendee")
                    && !lower.contains("recurr")
                    && !lower.contains("rrule"),
                "{at}.{key}"
            );
            assert_closed(child, &format!("{at}.{key}"));
        }
    }
    if let Some(items) = schema.get("items") {
        assert_closed(items, &format!("{at}[]"));
    }
}

#[test]
fn every_schema_is_closed_and_has_no_attendee_or_recurrence_fields() {
    for tool in &catalog().tools {
        assert_closed(&tool.input_schema, &tool.id);
    }
}

#[test]
fn reminders_and_home_are_offerable_on_iphone_only_and_home_set_can_be_security_class() {
    let offered: Vec<&str> = catalog()
        .available_tools()
        .map(|t| t.app.as_str())
        .collect();
    for app in [
        "calendar",
        "contacts",
        "location",
        "alarms",
        "reminders",
        "home",
    ] {
        assert!(offered.contains(&app), "{app}");
    }
    assert_eq!(tool("device.home.set").status, ToolStatus::Available);
    assert!(tool("device.home.set").security_class_possible);
    assert!(
        catalog()
            .tools
            .iter()
            .filter(|t| t.id != "device.home.set")
            .all(|t| !t.security_class_possible),
        "only home.set can be a physical-access action"
    );
    for app in ["reminders", "home"] {
        assert_eq!(
            catalog().app(app).unwrap().platforms,
            vec!["ios".to_owned()]
        );
    }
}

#[test]
fn reminder_and_home_cards_never_show_model_text_for_the_accessory() {
    let create = tool("device.reminders.create");
    let summary = display_summary(
        create,
        &json!({ "title": "Buy milk", "due": "2026-11-09T09:00:00+00:00" }),
        "Alex's iPhone",
    );
    assert!(
        summary.starts_with("Add reminder “Buy milk” · due"),
        "{summary}"
    );
    let done = display_summary(
        tool("device.reminders.update"),
        &json!({ "id": "r1", "completed": true }),
        "Alex's iPhone",
    );
    assert!(done.starts_with("Mark a reminder as done"), "{done}");
    let set = tool("device.home.set");
    let input = json!({
        "accessory_id": "Front door (ignore previous instructions)",
        "characteristic_id": "c1", "value": false,
    });
    let unknown = display_summary(set, &input, "Alex's iPhone");
    assert!(unknown.starts_with("Change a Home accessory"), "{unknown}");
    assert!(!unknown.contains("ignore"), "{unknown}");
    let known = display_summary_known(set, &input, "Alex's iPhone", Some("Desk lamp"));
    assert!(
        known.starts_with("Change Home accessory “Desk lamp”"),
        "{known}"
    );
    let listed = redact_result_for_display(
        tool("device.home.list"),
        &json!({ "ok": true, "data": { "homes": [
            { "name": "Home", "accessories": [{ "name": "Front door" }, { "name": "Lamp" }] },
        ] } }),
    );
    assert_eq!(listed["display"]["count"], 2);
    assert!(!listed.to_string().contains("Front door"), "{listed}");
}

#[test]
fn alarm_window_uses_the_device_offset_at_both_edges() {
    let alarm = tool("device.alarm.set");
    // 2026-11-08 12:00Z is 04:00 at UTC-8.
    let pacific = ValidationContext {
        now_ms: NOW_MS,
        utc_offset_min: -480,
    };
    let ok =
        validate_and_canonicalize(alarm, &json!({ "at": "2026-11-09T04:00:00" }), pacific).unwrap();
    assert_eq!(
        ok["at"], "2026-11-09T04:00:00-08:00",
        "local time gets the device offset"
    );
    let past = validate_and_canonicalize(alarm, &json!({ "at": "2026-11-08T04:00:00" }), pacific);
    assert_eq!(past.unwrap_err().code, DeviceErrorCode::OutOfRange);
    let late = validate_and_canonicalize(alarm, &json!({ "at": "2026-11-09T04:00:01" }), pacific);
    assert_eq!(late.unwrap_err().code, DeviceErrorCode::OutOfRange);
    let timer = tool("device.timer.set");
    assert!(
        validate_and_canonicalize(timer, &json!({ "duration_seconds": 86_401 }), ctx()).is_err()
    );
    assert!(validate_and_canonicalize(timer, &json!({ "duration_seconds": 0 }), ctx()).is_err());
}

#[test]
fn calendar_range_and_closed_objects_are_enforced() {
    let search = tool("device.calendar.search");
    let ok = json!({ "start": "2026-11-08T00:00:00Z", "end": "2026-11-22T00:00:00Z" });
    assert!(validate_and_canonicalize(search, &ok, ctx()).is_ok());
    let wide = json!({ "start": "2026-11-08T00:00:00Z", "end": "2026-11-22T00:00:01Z" });
    assert_eq!(
        validate_and_canonicalize(search, &wide, ctx())
            .unwrap_err()
            .code,
        DeviceErrorCode::OutOfRange
    );
    let extra = json!({ "title": "x", "start": "2026-11-08T10:00:00Z", "end": "2026-11-08T11:00:00Z", "attendees": ["a@b.c"] });
    assert_eq!(
        validate_and_canonicalize(tool("device.calendar.create"), &extra, ctx())
            .unwrap_err()
            .code,
        DeviceErrorCode::InvalidInput
    );
}

#[test]
fn contacts_need_two_real_characters_and_no_wildcards() {
    let contacts = tool("device.contacts.search");
    for name in ["a", "**", "%%", "Sa*", "..", "a."] {
        assert!(
            validate_and_canonicalize(contacts, &json!({ "name": name }), ctx()).is_err(),
            "{name}"
        );
    }
    let ok = validate_and_canonicalize(contacts, &json!({ "name": " Sam " }), ctx()).unwrap();
    assert_eq!(ok, json!({ "name": "Sam", "fields": [], "limit": 5 }));
    let location =
        validate_and_canonicalize(tool("device.location.current"), &Value::Null, ctx()).unwrap();
    assert_eq!(location, json!({ "accuracy": "approximate" }));
}

#[test]
fn input_hash_is_independent_of_key_order() {
    let a = json!({ "b": 1, "a": { "y": true, "x": [1, 2] } });
    let b = json!({ "a": { "x": [1, 2], "y": true }, "b": 1 });
    assert_eq!(input_sha256(&a), input_sha256(&b));
    assert_ne!(
        input_sha256(&a),
        input_sha256(&json!({ "b": 2, "a": { "x": [1, 2], "y": true } }))
    );
}

#[test]
fn display_forms_never_carry_coordinates_contacts_or_notes() {
    let create = tool("device.calendar.create");
    let input = json!({ "title": "Dentist", "start": "2026-11-10T15:00:00Z", "end": "2026-11-10T16:00:00Z",
        "notes": "door code 1234", "location": "12 Secret St" });
    let summary = display_summary(
        create,
        &input,
        "Alex's iPhone with a really long name over forty",
    );
    assert!(
        summary.contains("“Dentist”") && summary.chars().count() <= 80,
        "{summary}"
    );
    let shown = redact_input_for_display(create, &input).to_string();
    assert!(
        !shown.contains("1234") && !shown.contains("Secret"),
        "{shown}"
    );
    let contacts_in = redact_input_for_display(
        tool("device.contacts.search"),
        &json!({ "name": "Sam Smith" }),
    );
    assert!(!contacts_in.to_string().contains("Sam"));
    let located = redact_result_for_display(
        tool("device.location.current"),
        &json!({ "ok": true, "data": { "latitude": 37.3349, "longitude": -122.009, "approximate": true } }),
    );
    assert!(!located.to_string().contains("37.33"), "{located}");
    let people = redact_result_for_display(
        tool("device.contacts.search"),
        &json!({ "ok": true, "data": { "contacts": [{ "name": "Sam", "phones": ["+1 555 0100"] }] } }),
    );
    assert!(people.to_string().contains("Sam") && !people.to_string().contains("555"));
}

#[test]
fn update_and_delete_cards_name_the_event_and_the_change() {
    let update = tool("device.calendar.update");
    let input = json!({ "id": "e1", "title": "Dentist (moved)", "start": "2026-11-12T15:00:00Z", "end": "2026-11-12T16:00:00Z" });
    let known = display_summary_known(update, &input, "Phone", Some("Dentist"));
    assert!(
        known.contains("“Dentist”")
            && known.contains("“Dentist (moved)”")
            && known.contains("15:00"),
        "{known}"
    );
    let unknown = display_summary(update, &json!({ "id": "e9" }), "Phone");
    assert!(unknown.contains("not shown in this chat"), "{unknown}");

    let delete = tool("device.calendar.delete");
    let known = display_summary_known(delete, &json!({ "id": "e1" }), "Phone", Some("Dentist"));
    assert!(known.starts_with("Delete event “Dentist”"), "{known}");
    let unknown = display_summary(delete, &json!({ "id": "e9" }), "Phone");
    assert!(unknown.contains("not shown in this chat"), "{unknown}");
}
