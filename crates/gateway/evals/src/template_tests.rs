use serde_json::{json, Value};

use crate::*;

// ── Variable substitution ────────────────────────────────────────────────

#[test]
fn substitute_vars_replaces_known_and_leaves_unknown() {
    let mut vars = std::collections::HashMap::new();
    vars.insert("name".to_string(), Value::String("Sam".to_string()));
    let out = substitute_vars("Hi {{name}}, meet {{other}}", &vars);
    assert_eq!(out, "Hi Sam, meet {{other}}");
}

#[test]
fn substitute_vars_no_placeholders_is_identity() {
    let vars = std::collections::HashMap::new();
    assert_eq!(substitute_vars("plain text", &vars), "plain text");
}

#[test]
fn render_template_supports_typed_values_and_common_filters() {
    let vars = serde_json::from_value::<std::collections::HashMap<String, Value>>(json!({
        "name": "Sam",
        "premium": true,
        "items": ["one", "two"],
        "profile": {"team": "Ryu"}
    }))
    .unwrap();
    assert_eq!(
        render_template(
            "Hello {{name | upper}} from {{profile.team}} ({{items | join(' / ')}})",
            &vars
        ),
        "Hello SAM from Ryu (one / two)"
    );
    assert_eq!(
        render_template(
            "{% if premium %}Priority{% else %}Standard{% endif %}",
            &vars
        ),
        "Priority"
    );
    assert_eq!(
        render_template("{% for item in items %}[{{item}}]{% endfor %}", &vars),
        "[one][two]"
    );
}
