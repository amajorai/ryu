//! Credit-pool slots, the Vercel lane, classify and region metadata.

use super::*;

#[test]
fn credit_pool_providers_report_their_own_ids_not_the_aliased_impl() {
    // All four reuse an existing impl (`OpenAiProvider` / `AnthropicProvider`),
    // whose `name()` is a hardcoded literal. If the alias leaked, `cloudflare`
    // would REPLACE `openai` in the map and every debit would be attributed to
    // the wrong pool â€” the exact money bug the pool split exists to prevent.
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": { "api_key": "sk-o" },
        "anthropic": { "api_key": "sk-a" },
        "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
        "bedrock": { "api_key": "aws", "base_url": "https://bedrock.example/anthropic" },
        "vertex": { "api_key": "gcp", "base_url": "https://vertex.example/endpoints/openapi" },
        "openai_credits": { "api_key": "sk-donated" }
    }))
    .expect("providers config parses");
    let reg = ProviderRegistry::new(&config, quota());
    assert_eq!(
        reg.get("cloudflare").map(Provider::name),
        Some("cloudflare")
    );
    assert_eq!(reg.get("bedrock").map(Provider::name), Some("bedrock"));
    assert_eq!(reg.get("vertex").map(Provider::name), Some("vertex"));
    assert_eq!(reg.get("openai").map(Provider::name), Some("openai"));
    assert_eq!(reg.get("anthropic").map(Provider::name), Some("anthropic"));
}

#[test]
fn donated_openai_is_a_separate_slot_from_the_byok_openai() {
    // The sharpest alias case: same impl, same endpoint, different KEY. Both
    // ids must exist side by side and each hold its own key, because
    // `credit_pools` tags one and not the other. A single slot would make
    // BYOK traffic debit the donated grant.
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": { "api_key": "sk-byok" },
        "openai_credits": { "api_key": "sk-donated" }
    }))
    .expect("providers config parses");
    let reg = ProviderRegistry::new(&config, quota());
    assert_eq!(reg.get("openai").map(Provider::name), Some("openai"));
    assert_eq!(
        reg.get("openai-credits").map(Provider::name),
        Some("openai-credits")
    );
    assert_eq!(reg.available_providers(), vec!["openai", "openai-credits"]);
}

#[test]
fn donated_openai_does_not_stand_in_for_an_unconfigured_byok_slot() {
    // â€¦nor the reverse. Only the id that was configured registers; a donated
    // allowance must never silently serve pass-through callers who have no key
    // of their own, since that spends donor credit on untagged traffic.
    let donated_only: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai_credits": { "api_key": "sk-donated" }
    }))
    .expect("providers config parses");
    let reg = ProviderRegistry::new(&donated_only, quota());
    assert!(reg.get("openai").is_none());
    assert!(reg.get("openai-credits").is_some());

    let byok_only: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": { "api_key": "sk-byok" }
    }))
    .expect("providers config parses");
    let reg = ProviderRegistry::new(&byok_only, quota());
    assert!(reg.get("openai").is_some());
    assert!(reg.get("openai-credits").is_none());
}

#[test]
fn credit_pool_providers_are_absent_when_unconfigured() {
    // An untagged deploy simply lacks the ids â€” no boot failure, no default
    // endpoint (the account/region/project-scoped base URLs have no sane
    // hardcoded value, and the donated OpenAI slot is gated on its own key).
    let reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
    assert!(reg.get("cloudflare").is_none());
    assert!(reg.get("bedrock").is_none());
    assert!(reg.get("vertex").is_none());
    assert!(reg.get("openai-credits").is_none());
    assert!(reg.get("azure-credits").is_none());
}

#[test]
fn azure_credits_is_its_own_slot_beside_the_byok_and_donated_openai() {
    // Azure's v1 surface reuses `OpenAiProvider`, so the alias must hold: the
    // Azure slot reports `azure-credits`, and neither OpenAI slot is replaced.
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": { "api_key": "sk-byok" },
        "openai_credits": { "api_key": "sk-donated" },
        "azure_credits": {
            "api_key": "azure-ryu",
            "base_url": "https://ryu.openai.azure.com/openai/v1"
        }
    }))
    .expect("providers config parses");
    let reg = ProviderRegistry::new(&config, quota());
    assert_eq!(
        reg.get("azure-credits").map(Provider::name),
        Some("azure-credits")
    );
    assert_eq!(
        reg.available_providers(),
        vec!["openai", "openai-credits", "azure-credits"]
    );
    assert_eq!(reg.region_for("azure-credits").as_deref(), Some("global"));
}

fn fleet_registry(config: &ProvidersConfig) -> ProviderRegistry {
    ProviderRegistry::build_with_environment(
        config,
        None,
        quota(),
        &std::collections::BTreeMap::new(),
        crate::custody::GatewayCustody::Fleet,
    )
}

#[test]
fn vercel_lane_registers_only_under_a_written_resale_permission() {
    // Off by default: no slot, no error.
    let reg = fleet_registry(&ProvidersConfig::default());
    assert!(reg.get("vercel").is_none());
    assert!(reg.activation_error("vercel").is_none());

    let lane = |permission: serde_json::Value, key: &str| -> ProvidersConfig {
        serde_json::from_value(serde_json::json!({
            "vercel": { "api_key": key, "resale_permission": permission }
        }))
        .expect("vercel lane config parses")
    };
    for refused in [
        serde_json::Value::Null,
        serde_json::json!("unreviewed"),
        serde_json::json!("forbidden"),
        serde_json::json!("approved:"),
        serde_json::json!("approved:   "),
    ] {
        let config = lane(refused.clone(), "vercel-fixture-key");
        let reg = fleet_registry(&config);
        assert!(reg.get("vercel").is_none(), "{refused}");
        assert!(
            !reg.available_providers().iter().any(|id| id == "vercel"),
            "{refused}"
        );
        let error = reg.activation_error("vercel").expect("refusal is recorded");
        assert!(error.contains("lane is off"), "{refused}: {error}");
    }

    // An approval without a key builds nothing and records nothing.
    let reg = fleet_registry(&lane(
        serde_json::json!("approved:VERCEL-RESALE-FIXTURE-1"),
        "  ",
    ));
    assert!(reg.get("vercel").is_none());
    assert!(reg.activation_error("vercel").is_none());

    let approved = lane(
        serde_json::json!("approved:VERCEL-RESALE-FIXTURE-1"),
        "vercel-fixture-key",
    );
    let reg = fleet_registry(&approved);
    assert_eq!(reg.get("vercel").map(|p| p.name()), Some("vercel"));
    assert!(reg.activation_error("vercel").is_none());
    assert_eq!(reg.custody(), crate::custody::GatewayCustody::Fleet);
}

#[test]
fn vercel_lane_never_registers_off_the_fleet_even_when_approved() {
    // Off the fleet a caller's `safety_identifier` reaches the adapter
    // unstripped, so the approved lane must not exist there at all.
    let approved: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "vercel": {
            "api_key": "vercel-fixture-key",
            "resale_permission": "approved:VERCEL-RESALE-FIXTURE-1"
        }
    }))
    .expect("vercel lane config parses");
    for custody in [
        crate::custody::GatewayCustody::SelfHosted,
        crate::custody::GatewayCustody::ManagedNode,
    ] {
        let reg = ProviderRegistry::build_with_environment(
            &approved,
            None,
            quota(),
            &std::collections::BTreeMap::new(),
            custody,
        );
        assert!(reg.get("vercel").is_none(), "{custody:?}");
        assert!(
            !reg.available_providers().iter().any(|id| id == "vercel"),
            "{custody:?}"
        );
        let error = reg.activation_error("vercel").expect("refusal is recorded");
        assert!(error.contains("lane is off"), "{custody:?}: {error}");
        assert!(error.contains("fleet"), "{custody:?}: {error}");
    }
    // The plain constructors build as self-hosted, so they fail closed too.
    let reg = ProviderRegistry::new(&approved, quota());
    assert!(reg.get("vercel").is_none());
    assert_eq!(reg.custody(), crate::custody::GatewayCustody::SelfHosted);
}

#[test]
fn classify_registers_as_its_own_provider_distinct_from_local() {
    // Both tiers configured at DIFFERENT urls: the classify slot must not
    // replace `local` (they share the `LocalProvider` impl, whose `name()` is
    // the hardcoded "local"), and each must report its own id so the
    // pipeline's metrics / admission / circuit-breaker keys stay separate.
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "local": { "base_url": "http://127.0.0.1:11434/v1" },
        "classify": { "base_url": "http://127.0.0.1:8083/v1" }
    }))
    .expect("local + classify config parses");
    let reg = ProviderRegistry::new(&config, quota());
    assert_eq!(reg.get("local").map(Provider::name), Some("local"));
    assert_eq!(reg.get("classify").map(Provider::name), Some("classify"));
    assert_eq!(reg.available_providers(), vec!["local", "classify"]);
}

#[test]
fn classify_absent_degrades_gracefully_to_no_provider() {
    // A STANDALONE gateway's state (NOT "the lazy sidecar's normal state" â€” Core
    // publishes RYU_CLASSIFY_LLM_URL unconditionally, so a Core-spawned gateway
    // always has the slot): no URL â‡’ no slot â‡’ no provider. `get` returns None
    // and the inspector fails open with a warn naming the provider â€” the
    // intended posture, not an error, so it is pinned here.
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "local": { "base_url": "http://127.0.0.1:11434/v1" }
    }))
    .expect("local-only config parses");
    let reg = ProviderRegistry::new(&config, quota());
    assert!(reg.get("classify").is_none());
}

#[test]
fn regional_provider_metadata_is_required_for_region_policy() {
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "bedrock": {
            "api_key": "aws",
            "base_url": "https://bedrock-mantle.eu-west-1.api.aws/anthropic"
        },
        "vertex": {
            "api_key": "gcp",
            "base_url": "https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/endpoints/openapi"
        },
        "openai": { "api_key": "sk-openai" }
    }))
    .expect("regional provider config parses");
    let reg = ProviderRegistry::new(&config, quota());

    assert_eq!(reg.region_for("bedrock").as_deref(), Some("eu-west-1"));
    assert_eq!(reg.region_for("vertex").as_deref(), Some("europe-west4"));
    assert_eq!(reg.region_for("openai").as_deref(), Some("global"));
    assert_eq!(reg.region_for("unregistered-plugin"), None);
}

#[test]
fn register_as_overrides_the_inner_providers_name() {
    // The isolation guarantee `register_as` exists for: the pipeline keys
    // metrics/admission/circuit-breaker off `provider.name()`, so the alias
    // must win over the wrapped provider's own hardcoded name.
    let mut reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
    reg.register_as("aliased", Arc::new(StubProvider("inner")));
    assert_eq!(reg.get("aliased").map(Provider::name), Some("aliased"));
    assert!(reg.get("inner").is_none());
    assert_eq!(reg.available_providers(), vec!["aliased"]);
}

#[test]
fn register_appends_new_id_and_replaces_existing_in_place() {
    let mut reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
    reg.register(Arc::new(StubProvider("alpha")));
    reg.register(Arc::new(StubProvider("beta")));
    assert_eq!(reg.available_providers(), vec!["alpha", "beta"]);

    // Re-registering an existing id replaces the provider WITHOUT changing its
    // position in the iteration order (the open extension point for plugins).
    reg.register(Arc::new(StubProvider("alpha")));
    assert_eq!(
        reg.available_providers(),
        vec!["alpha", "beta"],
        "re-registering must not duplicate or reorder"
    );
}

#[test]
fn each_registration_step_registers_only_its_own_family() {
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "openai": { "api_key": "sk-byok" },
        "cloudflare": { "api_key": "cf", "base_url": "https://cf.example/ai/v1" },
        "azure_credits": {
            "api_key": "azure-ryu",
            "base_url": "https://ryu.openai.azure.com/openai/v1"
        }
    }))
    .expect("providers config parses");
    let quota = quota();
    let client = reqwest::Client::new();
    let environment = std::collections::BTreeMap::new();
    let build = crate::providers::RegistryBuild {
        config: &config,
        egress: None,
        quota: &quota,
        client: &client,
        environment: &environment,
        custody: crate::custody::GatewayCustody::SelfHosted,
    };
    let empty = || ProviderRegistry::new(&ProvidersConfig::default(), quota.clone());

    let mut chat = empty();
    crate::providers::build_chat::register(&mut chat, &build);
    assert_eq!(chat.available_providers(), vec!["openai"]);

    let mut pools = empty();
    crate::providers::build_credit_pools::register(&mut pools, &build);
    assert_eq!(
        pools.available_providers(),
        vec!["cloudflare", "azure-credits"]
    );

    let mut media = empty();
    crate::providers::build_media::register(&mut media, &build);
    crate::providers::build_compatible_speech_web::register(&mut media, &build);
    assert!(media.available_providers().is_empty());

    // The policy step configures accounts on what is registered; it never
    // registers or removes a provider.
    crate::providers::build_account_policies::register(&mut pools, &build);
    assert_eq!(
        pools.available_providers(),
        vec!["cloudflare", "azure-credits"]
    );
}

#[test]
fn an_aliased_provider_reports_its_registry_id_and_regions_come_from_urls() {
    let inner: Arc<dyn Provider> = Arc::new(StubProvider("openai"));
    let aliased = crate::providers::aliased::AliasedProvider {
        id: "azure-credits",
        inner,
    };
    assert_eq!(aliased.name(), "azure-credits");

    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "bedrock": {
            "api_key": "aws",
            "base_url": "https://bedrock-mantle.eu-west-1.api.aws/anthropic"
        }
    }))
    .expect("providers config parses");
    let regions = crate::providers::regions::provider_regions(&config);
    assert_eq!(
        regions.get("bedrock").map(String::as_str),
        Some("eu-west-1")
    );
}
