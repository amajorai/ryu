//! Tests for the recipe engine: `{{param}}` substitution and param validation.

use std::collections::HashMap;

use ghost_core::recipe::engine::{substitute, substitute_step, validate_params};
use ghost_core::recipe::types::{Locator, Recipe, RecipeParam, RecipeStep};

fn params(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

#[test]
fn substitutes_multiple_and_repeated_placeholders() {
    let p = params(&[("x", "1"), ("y", "2")]);
    assert_eq!(substitute("{{x}}-{{y}}-{{x}}", &p), "1-2-1");
}

#[test]
fn adjacent_placeholders_have_no_separator() {
    let p = params(&[("a", "foo"), ("b", "bar")]);
    assert_eq!(substitute("{{a}}{{b}}", &p), "foobar");
}

#[test]
fn unknown_placeholder_is_left_verbatim() {
    let p = params(&[("known", "yes")]);
    assert_eq!(substitute("{{known}} {{unknown}}", &p), "yes {{unknown}}");
}

#[test]
fn template_without_placeholders_is_unchanged() {
    let p = params(&[("x", "1")]);
    assert_eq!(substitute("plain text", &p), "plain text");
}

#[test]
fn single_braces_are_not_treated_as_placeholders() {
    let p = params(&[("x", "1")]);
    // The pattern is exactly `{{name}}`; single braces stay literal.
    assert_eq!(substitute("{x} {{x}}", &p), "{x} 1");
}

#[test]
fn substitute_step_rewrites_action_target_and_params() {
    let step = RecipeStep {
        id: 7,
        action: "type into {{field}}".to_string(),
        target: Some(Locator {
            query: Some("{{field}} box".to_string()),
            role: Some("textbox".to_string()),
            dom_id: Some("id-{{field}}".to_string()),
            dom_class: None,
            identifier: None,
            app: Some("{{app}}".to_string()),
        }),
        params: Some(params(&[("value", "hello {{name}}")])),
        wait_after: None,
        note: Some("untouched {{field}}".to_string()),
        on_failure: None,
    };
    let p = params(&[("field", "email"), ("app", "mail"), ("name", "alice")]);
    let out = substitute_step(&step, &p);

    assert_eq!(out.id, 7);
    assert_eq!(out.action, "type into email");
    let target = out.target.expect("target present");
    assert_eq!(target.query.as_deref(), Some("email box"));
    assert_eq!(target.role.as_deref(), Some("textbox"));
    assert_eq!(target.dom_id.as_deref(), Some("id-email"));
    assert_eq!(target.app.as_deref(), Some("mail"));
    assert_eq!(out.params.expect("params")["value"], "hello alice");
    // `note` is intentionally NOT substituted by the engine.
    assert_eq!(out.note.as_deref(), Some("untouched {{field}}"));
}

fn recipe_with_params(defs: &[(&str, bool)]) -> Recipe {
    let mut param_map = HashMap::new();
    for (name, required) in defs {
        param_map.insert(
            (*name).to_string(),
            RecipeParam {
                param_type: "string".to_string(),
                description: String::new(),
                required: Some(*required),
            },
        );
    }
    Recipe {
        schema_version: 2,
        name: "r".to_string(),
        description: String::new(),
        app: None,
        params: Some(param_map),
        preconditions: None,
        steps: vec![],
        on_failure: None,
    }
}

#[test]
fn validate_params_ok_when_all_required_present() {
    let r = recipe_with_params(&[("a", true), ("b", false)]);
    assert!(validate_params(&r, &params(&[("a", "x")])).is_ok());
}

#[test]
fn validate_params_errors_listing_each_missing_required() {
    let r = recipe_with_params(&[("a", true), ("b", true), ("c", false)]);
    let err = validate_params(&r, &params(&[])).unwrap_err();
    let msg = err.to_string();
    assert!(msg.contains("Missing required params"), "{msg}");
    assert!(msg.contains('a'), "{msg}");
    assert!(msg.contains('b'), "{msg}");
    // `c` is optional and must not be reported.
    assert!(!msg.contains('c'), "{msg}");
}

#[test]
fn validate_params_ok_when_recipe_declares_no_params() {
    let r = Recipe {
        schema_version: 2,
        name: "no-params".to_string(),
        description: String::new(),
        app: None,
        params: None,
        preconditions: None,
        steps: vec![],
        on_failure: None,
    };
    assert!(validate_params(&r, &params(&[])).is_ok());
}

#[test]
fn validate_params_treats_absent_required_flag_as_optional() {
    // `required: None` must not force the param to be present.
    let mut param_map = HashMap::new();
    param_map.insert(
        "maybe".to_string(),
        RecipeParam {
            param_type: "string".to_string(),
            description: String::new(),
            required: None,
        },
    );
    let r = Recipe {
        schema_version: 2,
        name: "r".to_string(),
        description: String::new(),
        app: None,
        params: Some(param_map),
        preconditions: None,
        steps: vec![],
        on_failure: None,
    };
    assert!(validate_params(&r, &params(&[])).is_ok());
}
