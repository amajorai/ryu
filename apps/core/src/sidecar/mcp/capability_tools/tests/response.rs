//! Response mapping into the canonical shape, and failure envelopes.

use super::*;

#[test]
fn response_is_normalized_and_keeps_the_raw_item() {
    let provider = search_provider("@ryu/exa", true, "exa.search");
    let binding = provider.provides[0].tools.get("web.search").unwrap();
    let mapped = map_response(
        binding,
        "@ryu/exa",
        json!({ "results": [{ "title": "T", "url": "https://e", "text": "body", "score": 0.9 }] }),
    );
    assert_eq!(mapped["provider"], json!("@ryu/exa"));
    let first = &mapped["results"][0];
    assert_eq!(first["title"], json!("T"));
    assert_eq!(first["url"], json!("https://e"));
    assert_eq!(first["snippet"], json!("body"));
    // Nothing is destroyed: the provider's own record survives under `raw`.
    assert_eq!(first["raw"]["score"], json!(0.9));
}

#[test]
fn two_providers_normalize_to_the_same_canonical_shape() {
    let exa = search_provider("@ryu/exa", true, "exa.search");
    let exa_binding = exa.provides[0].tools.get("web.search").unwrap();

    // A provider with a different envelope and different field names.
    let mut tavily_binding = CapabilityToolBinding {
        tool: "tavily.search".to_owned(),
        ..Default::default()
    };
    tavily_binding.response = Some(CapabilityResponseMap {
        results: Some("data.items".to_owned()),
        fields: [
            ("title".to_owned(), "name".to_owned()),
            ("url".to_owned(), "link".to_owned()),
            ("snippet".to_owned(), "content.summary".to_owned()),
        ]
        .into_iter()
        .collect(),
    });

    let from_exa = map_response(
        exa_binding,
        "@ryu/exa",
        json!({ "results": [{ "title": "T", "url": "https://e", "text": "body" }] }),
    );
    let from_tavily = map_response(
        &tavily_binding,
        "@ryu/tavily",
        json!({ "data": { "items": [{ "name": "T", "link": "https://e", "content": { "summary": "body" } }] } }),
    );

    for envelope in [&from_exa, &from_tavily] {
        let first = &envelope["results"][0];
        assert_eq!(first["title"], json!("T"));
        assert_eq!(first["url"], json!("https://e"));
        assert_eq!(first["snippet"], json!("body"));
    }
}

#[test]
fn missing_response_map_passes_the_provider_output_through() {
    let binding = CapabilityToolBinding {
        tool: "x".to_owned(),
        ..Default::default()
    };
    let mapped = map_response(&binding, "p", json!({ "anything": 1 }));
    assert_eq!(mapped, json!({ "provider": "p", "raw": { "anything": 1 } }));
}

#[test]
fn the_declarative_response_map_does_not_reshape_a_providers_values() {
    // The field map RENAMES; it does not transform. This used to be untrue: a
    // `collapse_scalar` helper here unwrapped single-element arrays purely
    // because Firecrawl types `metadata.title` as `string | string[]`. One
    // vendor's quirk sitting in shared code that every provider flows through
    // is the wrong place for it — Firecrawl now normalizes that in its own
    // adapter, which is what adapters exist for. Guard the boundary so the next
    // provider-specific transform does not get added here either.
    let mut binding = CapabilityToolBinding {
        tool: "firecrawl.scrape".to_owned(),
        ..Default::default()
    };
    binding.response = Some(CapabilityResponseMap {
        results: Some("data".to_owned()),
        fields: [("title".to_owned(), "metadata.title".to_owned())]
            .into_iter()
            .collect(),
    });

    let scalar = map_response(
        &binding,
        "@ryu/firecrawl",
        json!({ "data": { "metadata": { "title": "Foo" } } }),
    );
    assert_eq!(scalar["results"][0]["title"], json!("Foo"));

    // Verbatim, array and all — no kernel-side unwrapping.
    let array = map_response(
        &binding,
        "@ryu/firecrawl",
        json!({ "data": { "metadata": { "title": ["Foo"] } } }),
    );
    assert_eq!(array["results"][0]["title"], json!(["Foo"]));
}

// The acceptance test for the adapter seam: the shared mapping code must contain no
// provider-specific transform. `collapse_scalar` existed here solely for
// Firecrawl; if a helper like it reappears, the grammar is growing per-vendor
// again and the adapter seam is being bypassed.
#[test]
fn no_vendor_specific_transform_lives_in_the_shared_mapping_code() {
    let source = [
        include_str!("../../capability_tools.rs"),
        include_str!("../defaults.rs"),
        include_str!("../mapping.rs"),
        include_str!("../resolve.rs"),
    ]
    .concat();
    // Assembled at runtime so this guard does not match its OWN source text.
    let needle = format!("fn {}", "collapse_scalar");
    assert!(
        !source.contains(&needle),
        "that helper belongs in the provider's adapter, not in shared kernel code"
    );
}

#[test]
fn a_provider_failure_envelope_is_never_flattened_into_zero_results() {
    // These are the EXACT shapes `tool_exec::finalize_http_result` returns when a
    // declarative http tool fails: the `fail_open` 401/403 envelope (a bad or
    // missing API key) and the generic non-2xx envelope. Reporting either as
    // `results: []` would tell the model "no search results" when the truth is
    // "your key is rejected" — the failure this test exists to prevent.
    let provider = search_provider("@ryu/exa", true, "exa.search");
    let binding = provider.provides[0].tools.get("web.search").unwrap();

    for failure in [
        json!({ "available": false, "reason": "endpoint returned HTTP 401", "hint": "check the key" }),
        json!({ "status": 500, "body": "upstream exploded" }),
    ] {
        let mapped = map_response(binding, "@ryu/exa", failure.clone());
        assert!(
            mapped.get("results").is_none(),
            "a failure envelope must not be presented as a result set: {mapped}"
        );
        assert_eq!(mapped["raw"], failure, "the real payload must survive");
    }
}

#[test]
fn a_pathless_response_map_does_not_turn_a_failure_into_a_result() {
    // The shipped Serper `web.extract` binding maps the WHOLE body as one
    // result (no `results` path), so the missing-path guard above never fires
    // for it. A rejected key must still surface as a failure, not as a single
    // result with no content.
    let manifests = builtins();
    let serper = manifests
        .iter()
        .find(|m| m.id == "@ryu/serper")
        .expect("serper ships");
    let binding = serper
        .provides
        .iter()
        .find_map(|p| p.tools.get("web.extract"))
        .expect("serper serves web.extract");
    assert!(
        binding
            .response
            .as_ref()
            .is_some_and(|r| r.results.is_none()),
        "this test covers the pathless shape"
    );
    for failure in [
        json!({ "available": false, "reason": "endpoint returned HTTP 403", "hint": "check the key" }),
        json!({ "status": 400, "body": { "message": "bad url" } }),
    ] {
        let mapped = map_response(binding, "@ryu/serper", failure.clone());
        assert!(mapped.get("results").is_none(), "{mapped}");
        assert_eq!(mapped["raw"], failure);
    }
    let ok = map_response(
        binding,
        "@ryu/serper",
        json!({ "text": "page", "markdown": "# page" }),
    );
    assert_eq!(ok["results"][0]["content"], json!("page"));
    assert_eq!(ok["results"][0]["markdown"], json!("# page"));
}

#[test]
fn a_genuinely_empty_result_set_still_maps_to_zero_results() {
    // The other side of the coin: a provider that really found nothing returns
    // its envelope with an empty array, and that MUST stay a normal empty result
    // set rather than being mistaken for a failure.
    let provider = search_provider("@ryu/exa", true, "exa.search");
    let binding = provider.provides[0].tools.get("web.search").unwrap();
    let mapped = map_response(binding, "@ryu/exa", json!({ "results": [] }));
    assert_eq!(mapped["results"], json!([]));
}

#[test]
fn the_success_shape_matches_what_an_unwrapped_http_tool_returns() {
    // Every provider manifest sets `unwrap_body: true`, and
    // `tool_exec::finalize_http_result` returns "the parsed upstream body
    // VERBATIM, no envelope" for a 2xx in that mode. So the declared `results`
    // paths are relative to the provider's OWN body — this test pins that
    // assumption, since a wrapped envelope would make every mapping miss.
    let provider = search_provider("@ryu/exa", true, "exa.search");
    let binding = provider.provides[0].tools.get("web.search").unwrap();
    let upstream_body_verbatim = json!({
        "requestId": "abc",
        "results": [{ "title": "T", "url": "https://e", "text": "body" }]
    });
    let mapped = map_response(binding, "@ryu/exa", upstream_body_verbatim);
    assert_eq!(mapped["results"][0]["title"], json!("T"));
    assert_eq!(mapped["results"][0]["snippet"], json!("body"));
}
