//! Argument mapping: renames, batch wrapping, templates, `pref:` tokens and
//! clamps.

use super::*;

#[test]
fn args_are_renamed_dropped_and_defaulted() {
    let mut binding = CapabilityToolBinding {
        tool: "x".to_owned(),
        ..Default::default()
    };
    binding
        .args
        .insert("limit".to_owned(), "num_results".to_owned());
    // This provider cannot express `format` at all.
    binding.args.insert("format".to_owned(), String::new());
    binding
        .arg_defaults
        .insert("use_autoprompt".to_owned(), json!(true));

    let mapped = map_args(
        &binding,
        json!({ "query": "rust", "limit": 5, "format": "markdown" }),
    );
    assert_eq!(
        mapped,
        json!({ "query": "rust", "num_results": 5, "use_autoprompt": true })
    );
}

#[test]
fn a_batch_argument_is_wrapped_declaratively() {
    let mut binding = CapabilityToolBinding {
        tool: "tavily.extract".to_owned(),
        ..Default::default()
    };
    binding.args.insert("url".to_owned(), "urls[]".to_owned());
    assert_eq!(
        map_args(&binding, json!({ "url": "https://e" })),
        json!({ "urls": ["https://e"] })
    );
    // An already-array value is not double-wrapped.
    assert_eq!(
        map_args(&binding, json!({ "url": ["https://a", "https://b"] })),
        json!({ "urls": ["https://a", "https://b"] })
    );
}

#[test]
fn the_binding_grammar_survives_json_deserialization() {
    // Every other grammar test constructs `CapabilityToolBinding` in-process, so
    // NONE of them would catch a serde rename/alias mistake — the manifest field
    // would simply deserialize to empty and the provider would silently stop
    // templating, clamping or substituting. Providers are DATA; parsing them from
    // JSON is the path that actually runs.
    let binding: CapabilityToolBinding = serde_json::from_value(json!({
        "tool": "mem0.add",
        "args": { "limit": "top_k", "scope": "" },
        "arg_defaults": { "user_id": "pref:mem0.user-id" },
        "arg_template": { "messages": [{ "role": "user", "content": "{content}" }] },
        "arg_clamp": { "limit": { "min": 1, "max": 20 } },
        "response": { "results": "results", "fields": { "content": "memory" } }
    }))
    .expect("the manifest form must deserialize");

    assert_eq!(binding.tool, "mem0.add");
    assert_eq!(binding.args.get("limit").map(String::as_str), Some("top_k"));
    assert!(
        !binding.arg_template.is_empty(),
        "arg_template must round-trip"
    );
    assert_eq!(
        referenced_pref_keys(&binding),
        vec!["mem0.user-id".to_owned()],
        "pref: tokens must be discoverable from the parsed form"
    );
    assert_eq!(binding.arg_clamp["limit"].max, Some(20));

    // And the parsed form behaves: template builds the nested body, the clamp
    // narrows, the drop drops.
    let prefs: BTreeMap<String, String> = [("mem0.user-id".to_owned(), "alice".to_owned())]
        .into_iter()
        .collect();
    let mapped = map_args_with_defaults(
        &binding,
        resolve_arg_defaults(&binding, &prefs),
        json!({ "content": "I moved to Berlin", "limit": 99, "scope": "user" }),
    );
    assert_eq!(
        mapped["messages"],
        json!([{ "role": "user", "content": "I moved to Berlin" }])
    );
    assert_eq!(mapped["user_id"], json!("alice"));
    assert_eq!(mapped["top_k"], json!(20), "clamped from 99");
    assert!(mapped.get("scope").is_none(), "dropped");
    assert!(mapped.get("content").is_none(), "consumed by the template");
}

#[test]
fn a_template_builds_the_nested_body_a_flat_rename_cannot() {
    // THE case this exists for: Mem0's write endpoint takes
    // `messages: [{role, content}]`. Renames and the `[]` scalar wrap cannot build
    // an array of objects, which is why the whole write half of that provider —
    // and with it the `mirror` and `sync` kernel bridges — was unbindable.
    let mut binding = CapabilityToolBinding {
        tool: "mem0.add".to_owned(),
        ..Default::default()
    };
    binding.arg_template.insert(
        "messages".to_owned(),
        json!([{ "role": "user", "content": "{content}" }]),
    );

    let mapped = map_args(&binding, json!({ "content": "I moved to Berlin" }));
    assert_eq!(
        mapped["messages"],
        json!([{ "role": "user", "content": "I moved to Berlin" }])
    );
    // The consumed argument must NOT also appear flat, or the provider sees it
    // twice under two names.
    assert!(mapped.get("content").is_none());
}

#[test]
fn a_whole_string_placeholder_preserves_the_arguments_json_type() {
    let mut binding = CapabilityToolBinding {
        tool: "p.x".to_owned(),
        ..Default::default()
    };
    binding
        .arg_template
        .insert("page".to_owned(), json!({ "size": "{limit}" }));
    let mapped = map_args(&binding, json!({ "limit": 25 }));
    // `25`, not `"25"` — a provider declaring an integer would reject the string.
    assert_eq!(mapped["page"]["size"], json!(25));
    assert!(mapped["page"]["size"].is_i64());
}

#[test]
fn interpolation_inside_a_larger_string_still_works() {
    let mut binding = CapabilityToolBinding {
        tool: "p.x".to_owned(),
        ..Default::default()
    };
    binding
        .arg_template
        .insert("q".to_owned(), json!("site-search: {query}"));
    assert_eq!(
        map_args(&binding, json!({ "query": "rust" }))["q"],
        json!("site-search: rust")
    );
}

#[test]
fn an_absent_placeholder_drops_its_field_instead_of_sending_the_token() {
    // Emitting a literal "{role}" would be sent upstream and treated as real
    // content — the same class of silent-wrongness as an unresolved `pref:` token.
    let mut binding = CapabilityToolBinding {
        tool: "p.x".to_owned(),
        ..Default::default()
    };
    binding.arg_template.insert(
        "messages".to_owned(),
        json!([{ "role": "{role}", "content": "{content}" }]),
    );
    let mapped = map_args(&binding, json!({ "content": "hi" }));
    // The object survives with the field it could fill; the unfillable one is gone.
    assert_eq!(mapped["messages"][0]["content"], json!("hi"));
    assert!(mapped["messages"][0].get("role").is_none());
}

#[test]
fn a_binding_with_no_template_is_completely_unaffected() {
    let mut binding = CapabilityToolBinding {
        tool: "exa.search".to_owned(),
        ..Default::default()
    };
    binding
        .args
        .insert("limit".to_owned(), "num_results".to_owned());
    let mapped = map_args(&binding, json!({ "query": "q", "limit": 3 }));
    assert_eq!(mapped, json!({ "query": "q", "num_results": 3 }));
}

#[test]
fn provider_defaults_can_reference_a_preference_instead_of_hardcoding() {
    // The concrete failure this prevents: Mem0 scopes every read to an entity id
    // that lives inside its `filters` object, which is not (and should not be) a
    // canonical verb argument. Hard-coding it gives every install the same fixed
    // bucket, so the provider returns nothing forever, silently.
    let mut binding = CapabilityToolBinding {
        tool: "mem0.search".to_owned(),
        ..Default::default()
    };
    binding.arg_defaults.insert(
        "filters".to_owned(),
        json!({ "user_id": "pref:mem0.user-id" }),
    );

    assert_eq!(
        referenced_pref_keys(&binding),
        vec!["mem0.user-id".to_owned()],
        "nested tokens must be discoverable so dispatch knows what to read"
    );

    let prefs: BTreeMap<String, String> = [("mem0.user-id".to_owned(), "alice".to_owned())]
        .into_iter()
        .collect();
    let resolved = resolve_arg_defaults(&binding, &prefs);
    assert_eq!(resolved["filters"]["user_id"], json!("alice"));

    // End to end through the mapper.
    let mapped = map_args_with_defaults(&binding, resolved, json!({ "query": "q" }));
    assert_eq!(mapped["filters"]["user_id"], json!("alice"));
    assert_eq!(mapped["query"], json!("q"));
}

#[test]
fn an_unresolved_pref_token_drops_its_field_rather_than_sending_the_token() {
    // Sending a literal `"pref:mem0.user-id"` upstream would be treated as a real
    // entity id and silently match nothing. A missing field at least makes the
    // provider say so.
    let mut binding = CapabilityToolBinding {
        tool: "mem0.search".to_owned(),
        ..Default::default()
    };
    binding.arg_defaults.insert(
        "filters".to_owned(),
        json!({ "user_id": "pref:mem0.user-id", "app_id": "fixed" }),
    );

    let resolved = resolve_arg_defaults(&binding, &BTreeMap::new());
    assert!(resolved["filters"].get("user_id").is_none());
    // A literal sibling is untouched — only the token is conditional.
    assert_eq!(resolved["filters"]["app_id"], json!("fixed"));

    // An empty stored value counts as unset, not as an empty entity id.
    let blank: BTreeMap<String, String> = [("mem0.user-id".to_owned(), "   ".to_owned())]
        .into_iter()
        .collect();
    assert!(resolve_arg_defaults(&binding, &blank)["filters"]
        .get("user_id")
        .is_none());
}

#[test]
fn a_binding_with_no_tokens_is_untouched_by_resolution() {
    let mut binding = CapabilityToolBinding {
        tool: "exa.search".to_owned(),
        ..Default::default()
    };
    binding
        .arg_defaults
        .insert("use_autoprompt".to_owned(), json!(true));
    assert!(referenced_pref_keys(&binding).is_empty());
    assert_eq!(
        resolve_arg_defaults(&binding, &BTreeMap::new())["use_autoprompt"],
        json!(true)
    );
}

#[test]
fn a_provider_ceiling_clamps_instead_of_failing_the_call() {
    // The real case: `web.search.limit` allows up to 100, but Brave's `count`
    // maxes at 20. Without clamping, selecting Brave turns a valid `limit: 50`
    // into an upstream 4xx and the swap stops being transparent.
    let mut binding = CapabilityToolBinding {
        tool: "brave.search".to_owned(),
        ..Default::default()
    };
    binding.args.insert("limit".to_owned(), "count".to_owned());
    binding.arg_clamp.insert(
        "limit".to_owned(),
        crate::plugin_manifest::ArgBounds {
            min: Some(1),
            max: Some(20),
        },
    );

    // Over the ceiling → clamped, and renamed. Still an integer, not 20.0.
    let mapped = map_args(&binding, json!({ "query": "rust", "limit": 50 }));
    assert_eq!(mapped["count"], json!(20));
    assert!(
        mapped["count"].is_i64(),
        "clamping must not float-ify an integer"
    );

    // Inside the range → untouched.
    assert_eq!(
        map_args(&binding, json!({ "query": "rust", "limit": 5 }))["count"],
        json!(5)
    );
    // Below the floor → raised.
    assert_eq!(
        map_args(&binding, json!({ "query": "rust", "limit": 0 }))["count"],
        json!(1)
    );
}

#[test]
fn clamping_is_keyed_by_the_canonical_name_and_ignores_the_irrelevant() {
    let mut binding = CapabilityToolBinding {
        tool: "p.search".to_owned(),
        ..Default::default()
    };
    binding.arg_clamp.insert(
        "limit".to_owned(),
        crate::plugin_manifest::ArgBounds {
            min: None,
            max: Some(20),
        },
    );
    // A non-numeric value under a clamped key is left for the provider to reject
    // rather than silently coerced.
    assert_eq!(
        map_args(&binding, json!({ "limit": "lots" }))["limit"],
        json!("lots")
    );
    // An absent argument is not invented.
    assert!(map_args(&binding, json!({ "query": "q" }))
        .get("limit")
        .is_none());
    // A binding with no clamps is a pure pass-through.
    let plain = CapabilityToolBinding {
        tool: "p.x".to_owned(),
        ..Default::default()
    };
    assert_eq!(map_args(&plain, json!({ "limit": 99 }))["limit"], json!(99));
}

#[test]
fn caller_arguments_beat_provider_defaults() {
    let mut binding = CapabilityToolBinding {
        tool: "x".to_owned(),
        ..Default::default()
    };
    binding.arg_defaults.insert("limit".to_owned(), json!(10));
    let mapped = map_args(&binding, json!({ "limit": 3 }));
    assert_eq!(mapped, json!({ "limit": 3 }));
}
