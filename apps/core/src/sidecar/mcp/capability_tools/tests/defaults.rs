//! Layer defaults, canonical arguments, verb ids, and provider resolution.

use super::*;

#[test]
fn layer_defaults_sit_under_the_caller_but_over_the_provider() {
    let search = verb_by_id("web.search").unwrap();
    let mut defaults = Map::new();
    defaults.insert("limit".to_owned(), json!(25));

    // No caller `limit` → the user's layer default applies.
    let merged = apply_layer_defaults(&defaults, json!({ "query": "rust" }));
    assert_eq!(merged, json!({ "query": "rust", "limit": 25 }));

    // Caller asked for 5 → the caller wins.
    let merged = apply_layer_defaults(&defaults, json!({ "query": "rust", "limit": 5 }));
    assert_eq!(merged["limit"], json!(5));

    // And the layer default outranks the provider's own arg_defaults, because
    // `map_args` merges arg_defaults first and the merged args overwrite them.
    let mut binding = CapabilityToolBinding {
        tool: "exa.search".to_owned(),
        ..Default::default()
    };
    binding.arg_defaults.insert("limit".to_owned(), json!(10));
    let mapped = map_args(
        &binding,
        apply_layer_defaults(&defaults, json!({ "query": "q" })),
    );
    assert_eq!(mapped["limit"], json!(25));

    // Sanity: the key the settings UI must write.
    assert_eq!(
        layer_default_key(search.capability, "limit"),
        "layer.web.search.default.limit"
    );
}

#[test]
fn a_stored_default_is_coerced_to_the_type_the_schema_declares() {
    let search = verb_by_id("web.search").unwrap();
    // `limit` is an integer in the canonical schema; preferences store strings.
    assert_eq!(
        coerce_to_schema_type(search, "limit", "25"),
        Some(json!(25))
    );
    // A string default stays a string.
    assert_eq!(
        coerce_to_schema_type(search, "query", "rust"),
        Some(json!("rust"))
    );
    // Garbage is DROPPED, not forwarded as a string — a malformed preference
    // must not become a malformed upstream request.
    assert_eq!(coerce_to_schema_type(search, "limit", "twenty"), None);
    assert_eq!(coerce_to_schema_type(search, "limit", "  "), None);
}

#[test]
fn booleans_and_unset_defaults_behave() {
    let crawl = verb_by_id("web.crawl").unwrap();
    assert_eq!(coerce_to_schema_type(crawl, "depth", "3"), Some(json!(3)));
    // No defaults at all is a pure pass-through.
    assert_eq!(
        apply_layer_defaults(&Map::new(), json!({ "url": "https://e" })),
        json!({ "url": "https://e" })
    );
}

#[test]
fn every_verb_exposes_its_canonical_args_for_defaulting() {
    // The settings UI enumerates these to know which keys it may offer, so a
    // verb whose schema has no readable properties would silently be
    // un-configurable.
    let search = verb_by_id("web.search").unwrap();
    let mut args = canonical_args(search);
    args.sort();
    assert_eq!(args, vec!["limit".to_owned(), "query".to_owned()]);
}

#[test]
fn legacy_provider_ids_resolve_through_the_canonical_lookup() {
    assert_eq!(
        verb_by_id("web__search").map(|verb| verb.id),
        Some("web.search")
    );
}

#[test]
fn verb_ids_match_their_server_and_name() {
    for v in verbs() {
        assert_eq!(v.id, format!("{}.{}", v.server, v.name), "verb id mismatch");
        assert!(is_server(v.server), "verb {} has unreserved server", v.id);
    }
}

#[test]
fn verb_ids_are_unique() {
    let mut ids: Vec<&str> = verbs().iter().map(|v| v.id).collect();
    ids.sort_unstable();
    let before = ids.len();
    ids.dedup();
    assert_eq!(before, ids.len(), "duplicate verb id in the table");
}

#[test]
fn only_verbs_the_bound_provider_declares_are_listed() {
    let enabled = vec![search_provider("@ryu/exa", true, "exa.search")];
    let resolved = resolve_verbs(&enabled, &BindingConfig::default());
    // exa declares web.search only — no extract/crawl/browser/computer/memory.
    assert_eq!(resolved.len(), 1);
    assert_eq!(resolved[0].verb.id, "web.search");
    assert_eq!(resolved[0].provider_id, "@ryu/exa");
    assert_eq!(resolved[0].binding.tool, "exa.search");

    let rows = tools(&resolved);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "web.search");
    assert_eq!(rows[0].server, "web");
}

#[test]
fn swapping_the_provider_keeps_the_verb_and_changes_only_the_target() {
    let enabled = vec![
        search_provider("@ryu/exa", true, "exa.search"),
        search_provider("@ryu/tavily", false, "tavily.search"),
    ];
    // Zero-config: the declared default wins.
    let before = resolve_verbs(&enabled, &BindingConfig::default());
    assert_eq!(before[0].verb.id, "web.search");
    assert_eq!(before[0].binding.tool, "exa.search");

    // One override later, the model-visible id is identical and only the
    // forwarding target moved.
    let mut cfg = BindingConfig::default();
    cfg.overrides
        .insert(CAP_WEB_SEARCH.to_owned(), "@ryu/tavily".to_owned());
    let after = resolve_verbs(&enabled, &cfg);
    assert_eq!(after[0].verb.id, before[0].verb.id);
    assert_eq!(after[0].binding.tool, "tavily.search");
    assert_eq!(
        tools(&after)[0].input_schema,
        tools(&before)[0].input_schema
    );
}

#[test]
fn unresolvable_capability_advertises_nothing() {
    let resolved = resolve_verbs(&[], &BindingConfig::default());
    assert!(resolved.is_empty());
}
