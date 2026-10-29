use super::{ProviderId, ProviderKind, RoutingConfig};

/// Provider routing is keyed by open registry-id strings: an existing config
/// naming one of the nine legacy providers deserializes byte-identically, AND
/// a brand-new id (`"acme"`) that no enum variant covers survives round-trip
/// through every routing field — including the `provider_tiers` map KEY, the
/// one spot where a non-transparent newtype Deserialize would silently drop it.
#[test]
fn legacy_and_novel_provider_ids_roundtrip_via_serde() {
    let json = serde_json::json!({
        "default_provider": "acme",
        "fallback_chain": ["openai", "acme"],
        "provider_tiers": { "openai": 0, "acme": 2 },
        "model_map": { "my-model": { "provider": "acme" } }
    });

    let routing: RoutingConfig =
        serde_json::from_value(json).expect("routing config with a novel provider id must parse");

    // Legacy name lowers to the same string it always was (back-compat).
    assert_eq!(routing.default_provider, ProviderId::from("acme"));
    assert_eq!(routing.fallback_chain[0], ProviderKind::OpenAi); // "openai" legacy id
    assert_eq!(routing.fallback_chain[1], ProviderId::from("acme"));

    // The map KEY is the serde trap — both legacy and novel keys must survive.
    assert_eq!(
        routing.provider_tiers.get(&ProviderId::from("openai")),
        Some(&0)
    );
    assert_eq!(
        routing.provider_tiers.get(&ProviderId::from("acme")),
        Some(&2)
    );

    assert_eq!(
        routing.model_map.get("my-model").unwrap().provider,
        ProviderId::from("acme")
    );

    // And it serializes back out as a bare string (no enum-shaped wrapper),
    // so the wire stays identical to the pre-open-id format.
    let back = serde_json::to_value(&routing).expect("serialize");
    assert_eq!(back["default_provider"], "acme");
    assert_eq!(back["fallback_chain"][0], "openai");
}

/// The empty/zero-config case keeps `default_provider = "openai"`, exactly as
/// the former `ProviderKind::default() == OpenAi` produced.
#[test]
fn default_provider_id_is_openai() {
    assert_eq!(ProviderId::default(), ProviderKind::OpenAi);
    assert_eq!(
        RoutingConfig::default().default_provider,
        ProviderKind::OpenAi
    );
}
