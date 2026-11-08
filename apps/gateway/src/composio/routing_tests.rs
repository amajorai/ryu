//! Request routing: entity selection and tool injection for the action loop.

use serde_json::json;

use crate::composio::ComposioClient;
use crate::config::ComposioConfig;

fn client(actions: &[&str]) -> ComposioClient {
    ComposioClient::new(
        ComposioConfig {
            entity_id: "configured-entity".to_owned(),
            actions: actions.iter().map(|a| (*a).to_owned()).collect(),
            ..Default::default()
        },
        reqwest::Client::new(),
    )
}

#[test]
fn org_less_requests_use_the_caller_or_the_configured_entity() {
    let client = client(&[]);
    assert_eq!(
        client.entity_for_request(None, Some("user-1")).unwrap(),
        "user-1"
    );
    assert_eq!(
        client.entity_for_request(None, Some("  ")).unwrap(),
        "configured-entity"
    );
    assert_eq!(
        client.entity_for_request(None, None).unwrap(),
        "configured-entity"
    );
}

#[test]
fn org_bound_requests_never_fall_back_to_the_configured_entity() {
    let client = client(&[]);
    let entity = client.entity_for_request(Some("org-1"), None).unwrap();
    assert_ne!(entity, "configured-entity");
}

#[test]
fn inject_tools_adds_one_function_per_allowed_action() {
    let client = client(&[]);
    let mut body = json!({ "messages": [] });
    client.inject_tools(
        &mut body,
        &["GMAIL_SEND".to_owned(), "SLACK_POST".to_owned()],
    );
    let names: Vec<&str> = body["tools"]
        .as_array()
        .expect("tools injected")
        .iter()
        .map(|tool| tool["function"]["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["GMAIL_SEND", "SLACK_POST"]);
}

#[test]
fn inject_tools_keeps_caller_tools_and_skips_an_empty_allowlist() {
    let client = client(&[]);
    let mut empty = json!({ "messages": [] });
    client.inject_tools(&mut empty, &[]);
    assert!(empty.get("tools").is_none());

    let existing = json!([{ "type": "function", "function": { "name": "own" } }]);
    let mut body = json!({ "tools": existing.clone() });
    client.inject_tools(&mut body, &["GMAIL_SEND".to_owned()]);
    assert_eq!(body["tools"], existing);
}
