//! Registry construction: per-vendor slots, order, credit pools, Vercel lane.

use super::*;

#[test]
fn huggingface_registers_as_a_direct_chat_provider_with_named_accounts() {
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
        "compatible":{"huggingface":{
            "api_key":"hf-primary", "api_keys":["hf-second"],
            "base_url":"https://router.huggingface.co/v1"
        }},
        "account_policies":{"huggingface":{
            (ryu_gw_credentials::provider_account_id("huggingface", "hf-primary")):{
                "name":"Personal", "enabled":true, "priority":2
            },
            (ryu_gw_credentials::provider_account_id("huggingface", "hf-second")):{
                "name":"Work", "enabled":true, "priority":1
            }
        }}
    }))
    .unwrap();
    let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
    assert_eq!(restored.account_keys("huggingface").len(), 2);
    let registry = ProviderRegistry::new(&restored, quota());
    assert_eq!(registry.get("huggingface").unwrap().name(), "huggingface");
    assert_eq!(
        registry.region_for("huggingface").as_deref(),
        Some("global")
    );
}

#[test]
fn direct_compatible_embedding_provider_registers_under_its_own_id() {
    let mut config = ProvidersConfig::default();
    config.compatible.insert(
        "voyage".to_owned(),
        CompatibleProviderConfig {
            api_key: "test-key".to_owned(),
            api_keys: Vec::new(),
            base_url: "https://api.voyageai.com/v1".to_owned(),
        },
    );
    let registry = ProviderRegistry::new(&config, quota());
    assert_eq!(
        registry.get("voyage").map(|provider| provider.name()),
        Some("voyage")
    );
    assert_eq!(registry.region_for("voyage").as_deref(), Some("global"));
}

#[test]
fn named_compatible_vendors_register_distinct_accounts_and_provider_ids() {
    for id in [
        "chutes",
        "hyperbolic",
        "siliconflow",
        "venice",
        "featherless",
    ] {
        let base = ryu_gw_credentials::direct_compatible_provider_url(id).unwrap();
        let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
            "compatible":{(id):{"api_key":"fixture-primary", "api_keys":["fixture-work"], "base_url":base}},
            "account_policies":{(id):{
                (ryu_gw_credentials::provider_account_id(id,"fixture-primary")):{"name":"Personal","enabled":true,"priority":2},
                (ryu_gw_credentials::provider_account_id(id,"fixture-work")):{"name":"Work","enabled":true,"priority":1}
            }}
        })).unwrap();
        let restored: ProvidersConfig = toml::from_str(&toml::to_string(&config).unwrap()).unwrap();
        assert_eq!(restored.account_keys(id).len(), 2);
        let registry = ProviderRegistry::new(&restored, quota());
        assert_eq!(registry.get(id).unwrap().name(), id);
        assert_eq!(registry.region_for(id).as_deref(), Some("global"));
        assert!(registry.get("openai").is_none());
    }
}

#[test]
fn cohere_registers_as_a_native_embedding_provider() {
    let config = ProvidersConfig {
        cohere: Some(CohereProviderConfig {
            api_key: "test-key".to_owned(),
            api_keys: Vec::new(),
            base_url: "https://api.cohere.com".to_owned(),
        }),
        ..ProvidersConfig::default()
    };
    let registry = ProviderRegistry::new(&config, quota());
    assert_eq!(
        registry.get("cohere").map(|provider| provider.name()),
        Some("cohere")
    );
}

#[test]
fn qwen_registers_its_native_stt_adapter_and_region() {
    let mut config = ProvidersConfig::default();
    config.compatible.insert(
        "qwen".to_owned(),
        CompatibleProviderConfig {
            api_key: "first".to_owned(),
            api_keys: vec!["second".to_owned()],
            base_url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1".to_owned(),
        },
    );
    let registry = ProviderRegistry::new(&config, quota());
    assert_eq!(registry.get("qwen").unwrap().name(), "qwen");
    assert!(registry.get("qwen").unwrap().has_rotating_accounts());
    assert_eq!(
        registry.region_for("qwen").as_deref(),
        Some("ap-southeast-1")
    );
    assert_eq!(
        region_from_qwen_url("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"),
        Some("cn-beijing")
    );
    assert_eq!(region_from_qwen_url("https://custom.example/v1"), None);
}

#[test]
fn direct_speech_providers_register_under_distinct_ids() {
    let config = ProvidersConfig {
        deepgram: Some(DeepgramProviderConfig {
            api_key: "test-deepgram".to_owned(),
            api_keys: Vec::new(),
            base_url: "https://api.deepgram.com".to_owned(),
        }),
        assemblyai: Some(AssemblyAiProviderConfig {
            api_key: "test-assemblyai".to_owned(),
            api_keys: Vec::new(),
            base_url: "https://api.assemblyai.com".to_owned(),
            poll_interval_ms: 1500,
            poll_timeout_secs: 180,
        }),
        elevenlabs: Some(ElevenLabsProviderConfig {
            api_key: "test-elevenlabs".to_owned(),
            api_keys: Vec::new(),
            base_url: "https://api.elevenlabs.io".to_owned(),
        }),
        inworld: Some(InworldProviderConfig {
            api_key: "inworld-primary".to_owned(),
            api_keys: vec!["inworld-extra".to_owned()],
            base_url: "https://api.inworld.ai".to_owned(),
        }),
        ..ProvidersConfig::default()
    };
    let registry = ProviderRegistry::new(&config, quota());
    assert_eq!(
        registry.get("deepgram").map(|provider| provider.name()),
        Some("deepgram")
    );
    assert_eq!(
        registry.get("elevenlabs").map(|provider| provider.name()),
        Some("elevenlabs")
    );
    assert_eq!(
        registry.get("assemblyai").map(|provider| provider.name()),
        Some("assemblyai")
    );
    assert_eq!(registry.region_for("assemblyai").as_deref(), Some("global"));
    let inworld = registry.get("inworld").unwrap();
    assert_eq!(inworld.name(), "inworld");
    assert!(inworld.has_rotating_accounts());
    assert_eq!(registry.region_for("inworld").as_deref(), Some("global"));
}

#[test]
fn gemini_accounts_mark_genai_as_rotating_for_response_cache_bypass() {
    let config = ProvidersConfig {
        genai: Some(serde_json::from_value(serde_json::json!({"accounts":{"gemini":{"api_key":"first","api_keys":["second"]}}})).unwrap()),
        ..ProvidersConfig::default()
    };
    let registry = ProviderRegistry::new(&config, quota());
    assert!(registry.get("genai").unwrap().has_rotating_accounts());
}

#[test]
fn modal_endpoint_stays_disabled_until_it_has_an_account() {
    let mut config = ProvidersConfig {
        modal: Some(crate::config::ModalProviderConfig {
            api_key: String::new(),
            api_keys: Vec::new(),
            base_url: "https://deployment.modal.run/v1".to_owned(),
        }),
        ..Default::default()
    };
    assert!(ProviderRegistry::new(&config, quota())
        .get("modal")
        .is_none());
    let modal = config.modal.as_mut().unwrap();
    modal.api_keys = vec!["first".to_owned(), "second".to_owned()];
    let registry = ProviderRegistry::new(&config, quota());
    let modal = registry.get("modal").unwrap();
    assert_eq!(modal.name(), "modal");
    assert!(modal.has_rotating_accounts());
}

#[test]
fn providers_register_in_deterministic_order_and_skip_absent() {
    // openai + anthropic present, everything else absent.
    let config = ProvidersConfig {
        openai: Some(OpenAiProviderConfig {
            api_key: "sk-openai".to_string(),
            api_keys: vec![],
            base_url: "https://api.openai.com/v1".to_string(),
        }),
        anthropic: Some(AnthropicProviderConfig {
            api_key: "sk-anthropic".to_string(),
            api_keys: vec![],
            base_url: "https://api.anthropic.com".to_string(),
        }),
        ..ProvidersConfig::default()
    };
    let reg = ProviderRegistry::new(&config, quota());
    // Registration order is openai-before-anthropic (matches `new`).
    assert_eq!(reg.available_providers(), vec!["openai", "anthropic"]);
    assert!(reg.get("openai").is_some());
    assert!(reg.get("anthropic").is_some());
    // A provider whose config is absent never enters the map.
    assert!(reg.get("local").is_none());
    assert!(reg.get("unknown").is_none());
}

#[test]
fn get_resolves_provider_by_stable_id() {
    let config = ProvidersConfig {
        local: Some(LocalProviderConfig {
            base_url: "http://127.0.0.1:1234".to_string(),
            model_routes: std::collections::HashMap::new(),
        }),
        ..ProvidersConfig::default()
    };
    let reg = ProviderRegistry::new(&config, quota());
    assert_eq!(reg.get("local").map(Provider::name), Some("local"));
}

#[test]
fn every_configured_builtin_registers_in_deterministic_order() {
    // A config with EVERY built-in present exercises each registration branch
    // and pins the deterministic order the /v1/models discovery merge relies on.
    let config: ProvidersConfig = serde_json::from_value(serde_json::json!({
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
        "openai_credits": { "api_key": "sk-donated" }
    }))
    .expect("full providers config parses");
    let reg = ProviderRegistry::new(&config, quota());
    // `classify` and the credit-pool slots are appended LAST: the /v1/models
    // discovery merge is order-sensitive, so a new provider must never be
    // inserted mid-list.
    assert_eq!(
        reg.available_providers(),
        vec![
            "openai",
            "anthropic",
            "local",
            "openrouter",
            "core",
            "kiro",
            "modal",
            "genai",
            "replicate",
            "fal",
            "classify",
            "cloudflare",
            "bedrock",
            "vertex",
            "openai-credits",
        ]
    );
}
