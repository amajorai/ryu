//! Tests for pure CDP coordinate math and recipe type (de)serialization.

use ghost_core::cdp::viewport_to_screen;
use ghost_core::recipe::types::{
    Recipe, RecipeRunResult, RecipeStep, RecipeStepResult, RecipeWaitCondition,
};

#[test]
fn viewport_to_screen_adds_window_origin_and_toolbar_height() {
    // Toolbar height is a fixed 88px added to the y axis only.
    assert_eq!(viewport_to_screen(0.0, 0.0, 100, 200), (100, 288));
    assert_eq!(viewport_to_screen(50.0, 60.0, 10, 20), (60, 168));
}

#[test]
fn viewport_to_screen_truncates_fractional_viewport_coords() {
    // `as i32` truncates toward zero.
    assert_eq!(viewport_to_screen(10.9, 5.9, 0, 0), (10, 93));
}

#[test]
fn viewport_to_screen_handles_negative_window_origin() {
    // A window partly off the left/top edge yields a shifted origin.
    assert_eq!(viewport_to_screen(20.0, 20.0, -30, -10), (-10, 98));
}

#[test]
fn recipe_serializes_with_snake_case_fields() {
    let r = Recipe {
        schema_version: 2,
        name: "n".to_string(),
        description: "d".to_string(),
        app: None,
        params: None,
        preconditions: None,
        steps: vec![RecipeStep {
            id: 1,
            action: "wait".to_string(),
            target: None,
            params: None,
            wait_after: Some(RecipeWaitCondition {
                condition: "element".to_string(),
                target: None,
                value: None,
                timeout: Some(1.5),
            }),
            note: None,
            on_failure: None,
        }],
        on_failure: None,
    };
    let v: serde_json::Value = serde_json::to_value(&r).expect("serialize");
    // Field renaming must match the ghost-os wire format.
    assert!(v.get("schema_version").is_some());
    assert_eq!(v["steps"][0]["wait_after"]["condition"], "element");
    assert_eq!(v["steps"][0]["wait_after"]["timeout"], 1.5);
}

#[test]
fn recipe_param_type_field_renames_to_type() {
    // `RecipeParam.param_type` serializes as `"type"` (a JSON reserved-ish key).
    let json = r#"{
        "schema_version": 1,
        "name": "r",
        "description": "",
        "params": { "who": { "type": "string", "description": "recipient" } },
        "steps": []
    }"#;
    let r: Recipe = serde_json::from_str(json).expect("parse");
    let params = r.params.as_ref().expect("params");
    assert_eq!(params["who"].param_type, "string");
    // required is optional and absent here.
    assert_eq!(params["who"].required, None);

    // Round-trips back to a `"type"` key, not `"param_type"`.
    let back = serde_json::to_value(&r).expect("serialize");
    assert_eq!(back["params"]["who"]["type"], "string");
    assert!(back["params"]["who"].get("param_type").is_none());
}

#[test]
fn run_result_roundtrips() {
    let result = RecipeRunResult {
        recipe_name: "r".to_string(),
        success: false,
        steps_completed: 1,
        total_steps: 3,
        step_results: vec![RecipeStepResult {
            step_id: 1,
            action: "click".to_string(),
            success: true,
            duration_ms: 42,
            error: None,
            note: Some("ok".to_string()),
        }],
        error: Some("step 2 failed".to_string()),
    };
    let json = serde_json::to_string(&result).expect("serialize");
    let back: RecipeRunResult = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(back.recipe_name, "r");
    assert!(!back.success);
    assert_eq!(back.steps_completed, 1);
    assert_eq!(back.total_steps, 3);
    assert_eq!(back.step_results.len(), 1);
    assert_eq!(back.step_results[0].duration_ms, 42);
    assert_eq!(back.error.as_deref(), Some("step 2 failed"));
}
