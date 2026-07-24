//! Provider wiring: the `ProviderRegistry` + config-driven registration + key
//! custody. The concrete provider implementations, the `Provider` trait, the
//! shared provider HTTP helpers, the quota sink, and the video-job value types
//! live in the `ryu-gw-providers` crate (decomposition W6). This module keeps
//! only the "wiring" — the registry that reads `ProvidersConfig`, holds the
//! provider keys, and constructs each built-in — so a new provider is a drop-in
//! (register a new id) with no enum/struct edit. Re-exported here so existing
//! `crate::providers::{Provider, ProviderRegistry}` paths are byte-unchanged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::config::ProvidersConfig;
use crate::quota::ProviderQuotas;

pub use ryu_gw_providers::{
    AnthropicProvider, CoreProvider, FalProvider, GenAiProvider, LocalProvider, ModalProvider,
    OpenAiProvider, OpenRouterOptions, OpenRouterProvider, Provider, ReplicateProvider,
};

/// Dynamic, id-keyed provider registry.
///
/// Dispatch is by stable string id (not a closed enum): every provider
/// registers itself under its own [`Provider::name`] and lookups go through the
/// map, so a new provider — including an out-of-process / plugin provider — can
/// be added by registering a new id without touching any closed enum. This is
/// the gateway-side analogue of Core's `RunnableRegistry`.
///
/// The `order` vector preserves deterministic registration/iteration order
/// (`available_providers`, and thus the model-discovery merge precedence in
/// `/v1/models`, are order-sensitive). Construction of a provider that lacks its
/// key is skipped entirely, so its id is simply absent from the map — exactly
/// the old `Option::None` behavior.
pub struct ProviderRegistry {
    providers: HashMap<String, Arc<dyn Provider>>,
    order: Vec<String>,
}

impl ProviderRegistry {
    pub fn new(config: &ProvidersConfig, quota: Arc<ProviderQuotas>) -> Self {
        let client = build_client();
        let mut registry = Self {
            providers: HashMap::new(),
            order: Vec::new(),
        };

        // Register built-ins in the same deterministic order as before so
        // `available_providers()` iteration (and the /v1/models discovery merge
        // that depends on it) is byte-for-byte identical. A provider whose config
        // is absent is not constructed, so its id never enters the map.
        if let Some(c) = config.openai.as_ref() {
            registry.register(Arc::new(OpenAiProvider::new(
                client.clone(),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.anthropic.as_ref() {
            registry.register(Arc::new(AnthropicProvider::new(
                client.clone(),
                c.all_keys(),
                c.base_url.clone(),
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.local.as_ref() {
            registry.register(Arc::new(LocalProvider::new(
                client.clone(),
                c.base_url.clone(),
            )));
        }

        if let Some(c) = config.openrouter.as_ref() {
            let options = OpenRouterOptions {
                data_collection: (!c.data_collection.is_empty()).then(|| c.data_collection.clone()),
                zdr: c.zdr.then_some(true),
                sort: (!c.sort.is_empty()).then(|| c.sort.clone()),
                response_healing: c.response_healing,
                usage_accounting: c.usage_accounting,
            };
            registry.register(Arc::new(OpenRouterProvider::new(
                client.clone(),
                c.all_keys(),
                c.base_url.clone(),
                c.site_url.clone(),
                c.site_name.clone(),
                options,
                Arc::clone(&quota),
            )));
        }

        if let Some(c) = config.core.as_ref() {
            registry.register(Arc::new(CoreProvider::new(
                client.clone(),
                c.base_url.clone(),
                c.token.clone(),
            )));
        }

        if let Some(c) = config.modal.as_ref() {
            registry.register(Arc::new(ModalProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
            )));
        }

        if let Some(c) = config.genai.as_ref() {
            registry.register(Arc::new(GenAiProvider::new(c.keys.clone())));
        }

        if let Some(c) = config.replicate.as_ref() {
            registry.register(Arc::new(ReplicateProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )));
        }

        if let Some(c) = config.fal.as_ref() {
            registry.register(Arc::new(FalProvider::new(
                client.clone(),
                c.api_key.clone(),
                c.base_url.clone(),
                c.poll_interval_ms,
                c.poll_timeout_secs,
            )));
        }

        registry
    }

    /// Register a provider under its own [`Provider::name`] id. Re-registering an
    /// existing id replaces the provider in place while preserving its position
    /// in the iteration order. This is the open extension point for provider
    /// plugins.
    pub fn register(&mut self, provider: Arc<dyn Provider>) {
        let id = provider.name().to_string();
        if !self.providers.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.providers.insert(id, provider);
    }

    /// Resolve a provider by its stable string id (e.g. `"openai"`). Returns
    /// `None` for an id with no registered/constructable provider — the same
    /// "provider absent/unavailable" signal the old closed match produced.
    pub fn get(&self, id: &str) -> Option<&dyn Provider> {
        self.providers.get(id).map(|p| p.as_ref())
    }

    /// The ids of all registered providers, in deterministic registration order.
    pub fn available_providers(&self) -> Vec<String> {
        self.order.clone()
    }
}

fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()
        .expect("failed to build HTTP client")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{
        AnthropicProviderConfig, LocalProviderConfig, OpenAiProviderConfig, ProvidersConfig,
    };
    use serde_json::Value;
    use std::pin::Pin;

    fn quota() -> Arc<ProviderQuotas> {
        Arc::new(ProviderQuotas::new())
    }

    /// A no-op provider used to exercise registry mechanics (register / replace /
    /// order) without any network.
    struct StubProvider(&'static str);
    impl Provider for StubProvider {
        fn name(&self) -> &'static str {
            self.0
        }
        fn complete<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<Output = Result<Value, ryu_gw_providers::ProviderError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move { Err(ryu_gw_providers::ProviderError::Provider("stub".into())) })
        }
        fn complete_stream<'a>(
            &'a self,
            _model: &'a str,
            _body: &'a Value,
        ) -> Pin<
            Box<
                dyn std::future::Future<
                        Output = Result<axum::body::Body, ryu_gw_providers::ProviderError>,
                    > + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                Err(ryu_gw_providers::ProviderError::Provider("stub".into()))
            })
        }
    }

    #[test]
    fn empty_config_registers_no_providers() {
        let reg = ProviderRegistry::new(&ProvidersConfig::default(), quota());
        assert!(reg.available_providers().is_empty());
        assert!(reg.get("openai").is_none());
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
            "fal": { "api_key": "sk-f" }
        }))
        .expect("full providers config parses");
        let reg = ProviderRegistry::new(&config, quota());
        assert_eq!(
            reg.available_providers(),
            vec![
                "openai",
                "anthropic",
                "local",
                "openrouter",
                "core",
                "modal",
                "genai",
                "replicate",
                "fal",
            ]
        );
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
}
