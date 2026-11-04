use crate::server::parse_acp_selections;

// The `?selections=` param carries the caller's config-option picks into the
// ACP probe, so an agent whose option SET depends on them (opencode advertises
// its reasoning `effort` option only while the model has effort levels) is
// probed as the session the user actually configured.

#[test]
fn parses_a_json_object_of_picks() {
    let got = parse_acp_selections(Some(r#"{"model":"xai/grok-4.6","effort":"high"}"#));
    assert_eq!(got.get("model").map(String::as_str), Some("xai/grok-4.6"));
    assert_eq!(got.get("effort").map(String::as_str), Some("high"));
}

#[test]
fn absent_or_unparseable_degrades_to_no_selections() {
    // A bad param must fall back to the plain `session/new` answer rather than
    // failing the request — the pickers are worth more than the strictness.
    assert!(parse_acp_selections(None).is_empty());
    assert!(parse_acp_selections(Some("not json")).is_empty());
    assert!(
        parse_acp_selections(Some(r#"{"model":{"nested":true}}"#)).is_empty(),
        "values must be plain strings (ACP value ids)"
    );
}
