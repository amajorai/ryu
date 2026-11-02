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
