use super::*;

#[test]
fn pool_allowances_gate_on_remaining_and_expiry_and_default_open() {
    let now = chrono::Utc::now();
    let store = PoolAllowances::default();
    // Nothing observed: slot configured is the only condition.
    assert!(store.has_room("bedrock", now));
    store.observe(&std::collections::HashMap::from([
        (
            "bedrock".to_owned(),
            PoolAllowance {
                remaining_micro_usd: Some(0),
                expires_at: None,
            },
        ),
        (
            "vertex".to_owned(),
            PoolAllowance {
                remaining_micro_usd: Some(5),
                expires_at: Some(now - chrono::Duration::days(1)),
            },
        ),
        (
            "cloudflare".to_owned(),
            PoolAllowance {
                remaining_micro_usd: Some(5),
                expires_at: Some(now + chrono::Duration::days(1)),
            },
        ),
    ]));
    assert!(!store.has_room("bedrock", now), "exhausted");
    assert!(!store.has_room("vertex", now), "expired");
    assert!(store.has_room("cloudflare", now));
    assert!(store.has_room("anthropic-credits", now), "not reported");
    // An empty report never wipes the snapshot.
    store.observe(&std::collections::HashMap::new());
    assert!(!store.has_room("bedrock", now));
    // Wire shape: camelCase, ISO expiry, both optional.
    let wire: PoolAllowance = serde_json::from_value(serde_json::json!({
        "remainingMicroUsd": 7,
        "expiresAt": "2030-01-01T00:00:00.000Z"
    }))
    .unwrap();
    assert_eq!(wire.remaining_micro_usd, Some(7));
    assert!(wire.expires_at.is_some());
    let bare: PoolAllowance = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(bare, PoolAllowance::default());
}

#[test]
fn paid_traffic_is_admitted_only_by_an_uncapped_live_pool() {
    let now = chrono::Utc::now();
    // No ceiling (`remainingMicroUsd: null` on the wire), no expiry.
    let uncapped: PoolAllowance = serde_json::from_value(serde_json::json!({
        "remainingMicroUsd": null, "expiresAt": null
    }))
    .unwrap();
    assert!(uncapped.admits_paid(now));
    // Any ceiling, however much is left, is a donated allowance.
    let capped = PoolAllowance {
        remaining_micro_usd: Some(1_000_000_000),
        expires_at: None,
    };
    assert!(capped.has_room(now));
    assert!(!capped.admits_paid(now));
    // A lapsed uncapped pool serves nobody; one lapsing later still does.
    let lapsed = PoolAllowance {
        remaining_micro_usd: None,
        expires_at: Some(now - chrono::Duration::days(1)),
    };
    assert!(!lapsed.admits_paid(now));
    let lapsing = PoolAllowance {
        remaining_micro_usd: None,
        expires_at: Some(now + chrono::Duration::days(1)),
    };
    assert!(lapsing.admits_paid(now));
}

#[test]
fn own_supply_is_every_pool_but_the_retail_pass_through() {
    let slots: Vec<_> = own_supply_slots().map(|(slot, _)| slot).collect();
    assert_eq!(
        slots,
        [
            "azure-credits",
            "cloudflare",
            "vertex",
            "openai-credits",
            "anthropic-credits"
        ]
    );
    assert!(!is_own_supply_pool("openrouter"));
    assert!(!is_own_supply_pool("not-a-pool"));
    assert!(is_ryu_router_slot("openrouter"));
    assert!(!is_ryu_router_slot("anthropic"));
}

/// Core decides a limited agent's default model with the router crate's
/// list of credential-free slots, and the agent provider check here uses
/// it too, so it must name exactly this table's own-supply slots.
#[test]
fn own_supply_slots_match_the_router_crate() {
    let mut ours: Vec<&str> = own_supply_slots().map(|(slot, _)| slot).collect();
    let mut shared = ryu_gw_router::OWN_SUPPLY_SLOTS.to_vec();
    ours.sort_unstable();
    shared.sort_unstable();
    assert_eq!(ours, shared);
    assert_eq!(
        ryu_gw_router::CLASSIFY_SLOT,
        crate::config::CLASSIFY_PROVIDER_ID
    );
}

#[test]
fn no_provider_is_claimed_twice() {
    // Two pools claiming one provider makes attribution ambiguous, and the
    // ambiguity only ever shows up as money in the wrong donor account.
    for (index, (provider, _)) in POOL_BY_GATEWAY_PROVIDER.iter().enumerate() {
        let duplicate = POOL_BY_GATEWAY_PROVIDER
            .iter()
            .skip(index + 1)
            .any(|(other, _)| other == provider);
        assert!(!duplicate, "gateway provider '{provider}' claimed twice");
    }
}

#[test]
fn untagged_providers_are_not_pool_attributed() {
    // The pre-pools billing path, preserved: `openai`/`anthropic`/`local`
    // traffic draws no grant and is attributed to no pool.
    assert_eq!(pool_for_gateway_provider("openai"), None);
    assert_eq!(pool_for_gateway_provider("anthropic"), None);
    assert_eq!(pool_for_gateway_provider("local"), None);
    assert_eq!(pool_for_gateway_provider(""), None);
}

#[test]
fn byok_anthropic_is_never_attributed_to_ryus_own_pool() {
    // Same rule as OpenAI: `anthropic` serves callers' own keys; only the
    // `anthropic-credits` slot (Ryu's first-party account) draws the pool.
    assert_eq!(pool_for_gateway_provider("anthropic"), None);
    assert_eq!(
        pool_for_gateway_provider("anthropic-credits"),
        Some("anthropic-credits")
    );
}

#[test]
fn byok_openai_is_never_attributed_to_the_donated_pool() {
    // `untagged_providers_are_not_pool_attributed` covers the same `openai`
    // string, but for a weaker reason (nobody has tagged it yet). Since the
    // donated OpenAI allowance landed, that assertion carries real money:
    // `openai` is the slot serving callers' OWN keys, so tagging it would
    // start debiting the donation for spend the donor never funded. Only the
    // separate `openai-credits` slot draws it, and the two must never merge.
    assert_eq!(pool_for_gateway_provider("openai"), None);
    assert_eq!(
        pool_for_gateway_provider("openai-credits"),
        Some("openai-credits")
    );
    // The same shape one level over: `genai` is the own-key Gemini surface,
    // `vertex` is the donated one. Same models, different account.
    assert_eq!(pool_for_gateway_provider("genai"), None);
    assert_eq!(pool_for_gateway_provider("vertex"), Some("vertex"));
}

#[test]
fn pooled_providers_resolve_to_their_pool() {
    assert_eq!(pool_for_gateway_provider("cloudflare"), Some("cloudflare"));

    assert_eq!(pool_for_gateway_provider("openrouter"), Some("openrouter"));
    assert_eq!(pool_for_gateway_provider("vertex"), Some("vertex"));
    assert_eq!(
        pool_for_gateway_provider("openai-credits"),
        Some("openai-credits")
    );
    assert_eq!(
        pool_for_gateway_provider("azure-credits"),
        Some("azure-credits")
    );
}

#[test]
fn byok_openai_is_never_attributed_to_the_azure_pool() {
    // Azure's slot reuses the OpenAI adapter, but only the `azure-credits`
    // registry id draws the Azure pool, and it is Ryu's own supply.
    assert_eq!(pool_for_gateway_provider("openai"), None);
    assert_eq!(pool_for_gateway_provider("azure"), None);
    assert!(is_own_supply_pool("azure-credits"));
    assert!(is_ryu_router_slot("azure-credits"));
}

#[test]
fn pool_ids_all_resolve_in_the_registry() {
    // The failure mode this guards: a tagged provider that no longer
    // registers stops drawing grant money SILENTLY instead of erroring.
    //
    // Scope it honestly. Every row but `openrouter` is const-backed
    // (`config::{CLOUDFLARE,BEDROCK,VERTEX,OPENAI_CREDITS,ANTHROPIC_CREDITS}_PROVIDER_ID`), so a
    // typo there is already a compile error and this test adds nothing for
    // them. What it actually catches is (a) the bare `"openrouter"` literal
    // and (b) any id's registry SLOT being deleted or renamed out from under
    // the table — which the consts cannot catch, because they would still
    // agree with each other.
    let config: crate::config::ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": { "api_key": "sk-o" },
        "anthropic": { "api_key": "sk-a" },
        "local": { "base_url": "http://127.0.0.1:1234" },
        "openrouter": { "api_key": "sk-or" },
        "core": { "base_url": "http://127.0.0.1:7979", "token": "t" },
        "modal": { "api_key": "sk-m", "base_url": "https://modal.example" },
        "genai": { "keys": { "gemini": "sk-g" } },
        "replicate": { "api_key": "sk-r" },
        "fal": { "api_key": "sk-f" },
        "classify": { "base_url": "http://127.0.0.1:8083/v1" },
        "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
        "bedrock": { "api_key": "aws", "base_url": "https://bedrock.example/anthropic" },
        "vertex": { "api_key": "gcp", "base_url": "https://vertex.example/endpoints/openapi" },
        "openai_credits": { "api_key": "sk-donated" },
        "anthropic_credits": { "api_key": "sk-ant-ryu" },
        "azure_credits": { "api_key": "az", "base_url": "https://ryu.openai.azure.com/openai/v1" }
    }))
    .expect("full providers config parses");
    let registry = crate::providers::ProviderRegistry::new(
        &config,
        std::sync::Arc::new(crate::quota::ProviderQuotas::default()),
    );
    for (provider, pool) in POOL_BY_GATEWAY_PROVIDER {
        assert!(
            registry.get(provider).is_some(),
            "credit pool '{pool}' bills gateway provider '{provider}', which no longer registers"
        );
    }
}

#[test]
fn bedrock_is_no_longer_own_supply() {
    // Ryu's AWS credit pays for VMs, not free inference: Bedrock traffic draws
    // no grant and never routes as own supply.
    assert_eq!(pool_for_gateway_provider("bedrock"), None);
    assert!(!is_own_supply_pool("bedrock"));
    assert!(own_supply_slots().all(|(slot, _)| slot != "bedrock"));
    // Still Ryu's AWS credential: masked as Ryu Router and kept out of BYOK
    // fallback chains.
    assert!(is_ryu_router_slot("bedrock"));
    assert!(is_ryu_held_slot("bedrock"));
    assert!(!is_ryu_held_slot("openrouter"));
    assert!(!is_ryu_held_slot("anthropic"));
}
