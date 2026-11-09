use serde_json::json;

use super::bridge_calls::BridgeCallLedger;
use super::catalog::{catalog, CatalogTool};

fn tool(id: &str) -> &'static CatalogTool {
    catalog().tool(id).expect("catalog tool")
}

fn matched_id(found: Option<&'static CatalogTool>) -> Option<&'static str> {
    found.map(|tool| tool.id.as_str())
}

#[test]
fn recorded_arguments_match_as_is_wrapped_or_as_a_json_string() {
    let ledger = BridgeCallLedger::default();
    let args = json!({ "query": "dentist", "limit": 5 });
    let slot = ledger.record_args(tool("device.calendar.search"), &args);
    assert_eq!(slot, Some(0));

    assert_eq!(
        matched_id(ledger.match_input(&args)),
        Some("device.calendar.search")
    );
    assert_eq!(
        matched_id(ledger.match_input(&json!({ "arguments": args.clone() }))),
        Some("device.calendar.search")
    );
    assert_eq!(
        matched_id(ledger.match_input(&json!({ "raw": args.to_string() }))),
        Some("device.calendar.search")
    );
    assert_eq!(
        matched_id(ledger.match_input(&json!({ "query": "something else", "limit": 5 }))),
        None
    );
}

#[test]
fn uninformative_arguments_never_correlate() {
    let ledger = BridgeCallLedger::default();
    ledger.record_args(tool("device.location.current"), &json!({}));
    ledger.record_args(tool("device.home.list"), &json!(null));

    assert_eq!(matched_id(ledger.match_input(&json!({}))), None);
    assert_eq!(matched_id(ledger.match_input(&json!(null))), None);
    assert_eq!(
        matched_id(ledger.match_input(&json!({ "wrapped": {} }))),
        None
    );
}

#[test]
fn arguments_nested_deeper_than_the_limit_are_not_found() {
    let ledger = BridgeCallLedger::default();
    let args = json!({ "query": "deep" });
    ledger.record_args(tool("device.contacts.search"), &args);

    let shallow = json!({ "a": { "b": { "c": args.clone() } } });
    assert_eq!(
        matched_id(ledger.match_input(&shallow)),
        Some("device.contacts.search")
    );
    let too_deep = json!({ "a": { "b": { "c": { "d": { "e": args } } } } });
    assert_eq!(matched_id(ledger.match_input(&too_deep)), None);
}

#[test]
fn output_matches_only_the_exact_recorded_envelope() {
    let ledger = BridgeCallLedger::default();
    let search = ledger.record_args(tool("device.calendar.search"), &json!({ "query": "a" }));
    let contacts = ledger.record_args(tool("device.contacts.search"), &json!({ "query": "b" }));
    let envelope = json!({ "ok": true, "result": { "events": [] } });
    ledger.record_result(contacts, &envelope);

    assert_eq!(
        matched_id(ledger.match_output(&envelope)),
        Some("device.contacts.search")
    );
    assert_eq!(
        matched_id(ledger.match_output(&json!({ "ok": true }))),
        None
    );

    let other = json!({ "ok": false, "error": "denied" });
    ledger.record_result(search, &other);
    assert_eq!(
        matched_id(ledger.match_output(&other)),
        Some("device.calendar.search")
    );
}

#[test]
fn results_for_missing_or_unknown_slots_are_ignored() {
    let ledger = BridgeCallLedger::default();
    let envelope = json!({ "ok": true });
    ledger.record_result(None, &envelope);
    ledger.record_result(Some(7), &envelope);
    assert_eq!(matched_id(ledger.match_output(&envelope)), None);
}

#[test]
fn the_ledger_stops_recording_at_its_cap() {
    let ledger = BridgeCallLedger::default();
    let search = tool("device.calendar.search");
    for index in 0..32 {
        assert_eq!(
            ledger.record_args(search, &json!({ "query": index })),
            Some(index)
        );
    }
    assert_eq!(
        ledger.record_args(search, &json!({ "query": "over" })),
        None
    );
    assert_eq!(
        matched_id(ledger.match_input(&json!({ "query": "over" }))),
        None
    );
    assert_eq!(
        matched_id(ledger.match_input(&json!({ "query": 31 }))),
        Some("device.calendar.search")
    );
}
