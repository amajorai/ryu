use super::*;

#[test]
fn openai_listing_keeps_chat_models_only() {
    let body = json!({"data": [
        {"id": "gpt-5"}, {"id": "gpt-5-2025-08-07"}, {"id": "o3"}, {"id": "o4-mini"},
        {"id": "chatgpt-4o-latest"}, {"id": "gpt-4o-audio-preview"},
        {"id": "gpt-4o-realtime-preview"}, {"id": "text-embedding-3-large"},
        {"id": "gpt-image-1"}, {"id": "omni-moderation-latest"}, {"id": "dall-e-3"},
        {"id": "gpt-4o-mini-tts"}, {"id": "gpt-4o-search-preview"}
    ]});
    let ids: Vec<String> = openai_models(&body).into_iter().map(|m| m.id).collect();
    assert_eq!(
        ids,
        [
            "gpt-5",
            "gpt-5-2025-08-07",
            "o3",
            "o4-mini",
            "chatgpt-4o-latest"
        ]
    );
}

#[test]
fn anthropic_listing_groups_dated_ids_under_the_alias() {
    let pages = vec![
        json!({"data": [
            {"id": "claude-sonnet-4-5-20250929", "display_name": "Claude Sonnet 4.5"},
            {"id": "claude-opus-4-5-20251101"}
        ], "has_more": true, "last_id": "claude-opus-4-5-20251101"}),
        json!({"data": [{"id": "claude-haiku-4-5-20251001"}], "has_more": false}),
    ];
    let models = anthropic_models(&pages);
    assert_eq!(models.len(), 3);
    assert_eq!(models[0].id, "claude-sonnet-4-5");
    assert_eq!(models[0].evidence_ids, ["claude-sonnet-4-5-20250929"]);
    assert_eq!(models[0].display_name.as_deref(), Some("Claude Sonnet 4.5"));
    assert_eq!(
        anthropic_alias("claude-3-7-sonnet-latest"),
        "claude-3-7-sonnet-latest"
    );
}

#[test]
fn cloudflare_and_bedrock_urls_derive_from_the_dispatch_base() {
    assert_eq!(
        cloudflare_search_url("https://api.cloudflare.com/client/v4/accounts/abc/ai/v1"),
        Some("https://api.cloudflare.com/client/v4/accounts/abc/ai/models/search".to_owned())
    );
    assert_eq!(cloudflare_search_url("https://proxy.example/v1"), None);
    assert_eq!(
        cloudflare_models(
            &json!({"success": true, "result": [{"name": "@cf/meta/llama-3.1-8b-instruct"}]})
        )[0]
        .id,
        "@cf/meta/llama-3.1-8b-instruct"
    );
    assert_eq!(
        bedrock_models_url("https://bedrock-mantle.us-east-1.api.aws/anthropic"),
        Some("https://bedrock-mantle.us-east-1.api.aws/v1/models".to_owned())
    );
    assert_eq!(bedrock_models_url("https://bedrock.example/v1"), None);
    assert_eq!(
        bedrock_region("https://bedrock-mantle.eu-west-1.api.aws/anthropic").as_deref(),
        Some("eu-west-1")
    );
}

#[test]
fn the_report_carries_no_key_material() {
    let access = SlotAccess {
        slot: "cloudflare",
        api_key: "cf-SECRET-TOKEN-1234567890".to_owned(),
        base_url: "https://api.cloudflare.com/client/v4/accounts/acct-777/ai/v1".to_owned(),
    };
    let report = build_report(
        "instance",
        &access,
        Listing::Error(status_line(
            "request failed: error sending request for url (https://api.cloudflare.com/client/v4/accounts/acct-777/ai/models/search)",
        )),
        vec![CanaryReport {
            upstream: "@cf/meta/llama-3.1-8b-instruct".to_owned(),
            ok: false,
            error: Some(status_line("HTTP 404 at https://api.cloudflare.com/client/v4/accounts/acct-777/ai/v1")),
        }],
        vec![("@cf/meta/llama-3.1-8b-instruct".to_owned(), 2)],
    );
    let wire = serde_json::to_string(&report).unwrap();
    assert!(!wire.contains("SECRET"), "{wire}");
    assert!(!wire.contains("acct-777"), "{wire}");
    assert!(wire.contains(&key_fingerprint(&access.api_key)));
    assert_eq!(key_fingerprint(&access.api_key).len(), 16);
    assert!(wire.contains("\"status\":\"error\""));
    assert!(wire.contains(
        "\"quarantines\":[{\"upstream\":\"@cf/meta/llama-3.1-8b-instruct\",\"count\":2}]"
    ));
}

#[test]
fn jitter_stays_within_ten_percent() {
    for _ in 0..50 {
        let value = jittered(Duration::from_secs(1000)).as_secs();
        assert!((900..=1100).contains(&value), "{value}");
    }
}

#[test]
fn the_azure_pool_is_discovered_and_canaried_like_any_own_slot() {
    let config: crate::config::ProvidersConfig = serde_json::from_value(json!({
        "openai": { "api_key": "sk-byok" },
        "azure_credits": {
            "api_key": "azure-ryu",
            "base_url": "https://ryu.openai.azure.com/openai/v1"
        }
    }))
    .expect("providers config parses");
    let slots: Vec<_> = slot_access(&config)
        .into_iter()
        .map(|access| (access.slot, access.base_url))
        .collect();
    assert_eq!(
        slots,
        [(
            "azure-credits",
            "https://ryu.openai.azure.com/openai/v1".to_owned()
        )]
    );
}

#[test]
fn the_listing_module_parses_an_openai_shaped_azure_listing() {
    let models = listing::openai_models(&json!({"data": [
        {"id": "gpt-5-mini"},
        {"id": "text-embedding-3-large"}
    ]}));
    assert_eq!(
        models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["gpt-5-mini"]
    );
}

#[test]
fn bedrock_is_never_discovered_or_canaried() {
    let config: crate::config::ProvidersConfig = serde_json::from_value(json!({
        "bedrock": {
            "api_key": "aws",
            "base_url": "https://bedrock-mantle.us-east-1.api.aws/anthropic"
        }
    }))
    .expect("providers config parses");
    assert!(slot_access(&config).is_empty());
}
