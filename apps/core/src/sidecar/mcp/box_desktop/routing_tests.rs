//! Tests for the canonical schema checks in [`super`].

use super::*;

#[test]
fn json_types_are_checked_against_the_schema_property() {
    assert!(matches_type(&json!({"type": "integer"}), &json!(3)));
    assert!(!matches_type(&json!({"type": "integer"}), &json!(3.5)));
    assert!(matches_type(&json!({"type": "number"}), &json!(3.5)));
    assert!(!matches_type(&json!({"type": "string"}), &json!(1)));
    assert!(matches_type(&json!({"type": "boolean"}), &json!(false)));
    assert!(!matches_type(&json!({"type": "object"}), &json!([])));
    let strings = json!({"type": "array", "items": {"type": "string"}});
    assert!(matches_type(&strings, &json!(["a", "b"])));
    assert!(!matches_type(&strings, &json!(["a", 1])));
    assert!(matches_type(&json!({}), &json!(null)));
}

#[test]
fn a_model_cannot_name_a_box_or_a_url_outside_the_verb_schema() {
    let error = plan(
        "computer.click",
        &json!({"x": 1, "y": 2, "box_id": "other"}),
    )
    .err()
    .expect("an undeclared field is refused");
    assert!(error.to_string().contains("box_id"), "{error}");
    assert!(plan("memory.search", &json!({"query": "q"})).is_err());
    assert!(plan("computer.click", &json!("click")).is_err());
}

#[test]
fn webmcp_verbs_go_to_the_box_browser_and_keep_their_annotations() {
    let body = json!({
        "tab_id": "T1",
        "tool_name": "search_flights",
        "arguments": {"from": "SFO"}
    });
    assert_eq!(
        plan("browser.execute_webmcp_tool", &body).unwrap(),
        Planned::Browser {
            verb: "execute_webmcp_tool",
            body: body.clone(),
        }
    );
    assert_eq!(
        plan("browser.list_webmcp_tools", &json!({"tab_id": "T1"})).unwrap(),
        Planned::Browser {
            verb: "list_webmcp_tools",
            body: json!({"tab_id": "T1"}),
        }
    );
    assert!(plan("browser.execute_webmcp_tool", &json!({"tab_id": "T1"})).is_err());
    assert!(plan(
        "browser.execute_webmcp_tool",
        &json!({"tab_id": "T1", "tool_name": "x", "expression": "1"})
    )
    .is_err());
    let rows = capability_tools::session_box_tools(&[]);
    let read_only = |id: &str| {
        let row = rows.iter().find(|row| row.id == id).expect("listed for a Box");
        row.annotations.as_ref().expect("annotated")["readOnlyHint"].as_bool()
    };
    assert_eq!(read_only("browser.list_webmcp_tools"), Some(true));
    assert_eq!(read_only("browser.execute_webmcp_tool"), Some(false));
}