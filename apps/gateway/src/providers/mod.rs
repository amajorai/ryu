//! Provider wiring: the `ProviderRegistry` + config-driven registration + key
//! custody. The concrete provider implementations, the `Provider` trait, the
//! shared provider HTTP helpers, the quota sink, and the video-job value types
//! live in the `ryu-gw-providers` crate (decomposition W6). This module keeps
//! only the "wiring" â€” the registry that reads `ProvidersConfig`, holds the
//! provider keys, and constructs each built-in â€” so a new provider is a drop-in
//! (register a new id) with no enum/struct edit. Re-exported here so existing
//! `crate::providers::{Provider, ProviderRegistry}` paths are byte-unchanged.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::config::{
    ProvidersConfig, ANTHROPIC_CREDITS_PROVIDER_ID, AZURE_CREDITS_PROVIDER_ID, BEDROCK_PROVIDER_ID,
    CLOUDFLARE_PROVIDER_ID, OPENAI_CREDITS_PROVIDER_ID, VERTEX_PROVIDER_ID,
};
use crate::quota::ProviderQuotas;

mod aliased;
mod build_account_policies;
mod build_chat;
mod build_compatible_speech_web;
mod build_credit_pools;
mod build_media;
mod regions;
mod runtime;

use aliased::AliasedProvider;
use regions::provider_regions;
#[cfg(test)]
use regions::region_from_qwen_url;
pub(crate) use regions::sdk_environment;

/// Everything a registration step reads while building a [`ProviderRegistry`].
#[derive(Clone, Copy)]
struct RegistryBuild<'a> {
    config: &'a ProvidersConfig,
    egress: Option<&'a crate::egress::EgressPools>,
    quota: &'a Arc<ProviderQuotas>,
    client: &'a reqwest::Client,
    environment: &'a std::collections::BTreeMap<String, String>,
    custody: crate::custody::GatewayCustody,
}
pub(crate) use runtime::ProviderInputs;
pub use runtime::{BoundRoute, BoundWebRoute, ProviderEpoch, ProviderRuntime, ProviderSnapshot};

pub use ryu_gw_providers::{
    AnthropicProvider, AssemblyAiProvider, BatchProvider, BflProvider, CohereProvider,
    CoreProvider, DeepgramProvider, ElevenLabsProvider, FalProvider, GenAiProvider,
    GoogleTtsAccount, GoogleTtsProvider, InworldProvider, LocalProvider, MiniMaxProvider,
    ModalProvider, OpenAiProvider, OpenRouterOptions, OpenRouterProvider, PollyAccount,
    PollyProvider, Provider, QwenProvider, RecraftProvider, ReplicateProvider, RunwayProvider,
    StabilityProvider, TopazProvider,
};

/// Dynamic, id-keyed provider registry.
///
/// Dispatch is by stable string id (not a closed enum): every provider
/// registers itself under its own [`Provider::name`] and lookups go through the
/// map, so a new provider â€” including an out-of-process / plugin provider â€” can
/// be added by registering a new id without touching any closed enum. This is
/// the gateway-side analogue of Core's `RunnableRegistry`.
///
/// The `order` vector preserves deterministic registration/iteration order
/// (`available_providers`, and thus the model-discovery merge precedence in
/// `/v1/models`, are order-sensitive). Construction of a provider that lacks its
/// key is skipped entirely, so its id is simply absent from the map â€” exactly
/// the old `Option::None` behavior.
pub struct ProviderRegistry {
    account_ids: HashMap<String, Vec<String>>,
    account_policies: ryu_gw_credentials::ProviderAccountPolicies,
    providers: HashMap<String, Arc<dyn Provider>>,
    batch_providers: HashMap<String, Arc<dyn BatchProvider>>,
    order: Vec<String>,
    /// Verified routing-region metadata. Unknown/plugin providers intentionally
    /// have no entry so an effective allowed-regions policy fails closed.
    regions: HashMap<String, String>,
    activation_errors: HashMap<String, String>,
    /// The custody this registry was built for. A config reload rebuilds the
    /// registry with the same custody, which never changes inside a process.
    custody: crate::custody::GatewayCustody,
}

impl ProviderRegistry {
    #[cfg(test)]
    pub(crate) fn clone_for_test(&self) -> Self {
        Self {
            account_ids: self.account_ids.clone(),
            account_policies: self.account_policies.clone(),
            providers: self.providers.clone(),
            batch_providers: self.batch_providers.clone(),
            order: self.order.clone(),
            regions: self.regions.clone(),
            activation_errors: self.activation_errors.clone(),
            custody: self.custody,
        }
    }

    pub fn new(config: &ProvidersConfig, quota: Arc<ProviderQuotas>) -> Self {
        Self::build(config, None, quota)
    }

    pub fn new_with_egress(
        config: &ProvidersConfig,
        egress: &crate::egress::EgressPools,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::build(config, Some(egress), quota)
    }

    /// Without an explicit custody a registry is built as self-hosted, so
    /// every fleet-only slot (the Vercel lane) stays off.
    fn build(
        config: &ProvidersConfig,
        egress: Option<&crate::egress::EgressPools>,
        quota: Arc<ProviderQuotas>,
    ) -> Self {
        Self::build_with_environment(
            config,
            egress,
            quota,
            &sdk_environment(),
            crate::custody::GatewayCustody::SelfHosted,
        )
    }

    pub(crate) fn build_with_environment(
        config: &ProvidersConfig,
        egress: Option<&crate::egress::EgressPools>,
        quota: Arc<ProviderQuotas>,
        environment: &std::collections::BTreeMap<String, String>,
        custody: crate::custody::GatewayCustody,
    ) -> Self {
        let client = build_client();
        let mut registry = Self {
            account_ids: HashMap::new(),
            account_policies: config.account_policies.clone(),
            providers: HashMap::new(),
            batch_providers: HashMap::new(),
            order: Vec::new(),
            regions: provider_regions(config),
            activation_errors: HashMap::new(),
            custody,
        };

        let build = RegistryBuild {
            config,
            egress,
            quota: &quota,
            client: &client,
            environment,
            custody,
        };
        build_chat::register(&mut registry, &build);
        build_media::register(&mut registry, &build);
        build_credit_pools::register(&mut registry, &build);
        build_compatible_speech_web::register(&mut registry, &build);
        build_account_policies::register(&mut registry, &build);
        registry
    }

    pub fn account_policy_snapshot(&self) -> ryu_gw_credentials::ProviderAccountPolicies {
        self.account_policies.clone()
    }

    pub fn validate_account_policy_updates(
        &self,
        updates: &ryu_gw_credentials::ProviderAccountPolicies,
    ) -> Result<ryu_gw_credentials::ProviderAccountPolicies, String> {
        let count: usize = updates.values().map(HashMap::len).sum();
        if count == 0 || count > 128 {
            return Err("update between 1 and 128 provider accounts per request".to_owned());
        }
        let mut normalized = HashMap::new();
        for (provider, policies) in updates {
            let ids = self
                .account_ids
                .get(provider)
                .ok_or("provider has no active account configuration")?;
            let mut entries = HashMap::new();
            for (id, policy) in policies {
                if !ids.contains(id) {
                    return Err("account no longer exists; refresh the account list".to_owned());
                }
                entries.insert(id.clone(), policy.normalized()?);
            }
            normalized.insert(provider.clone(), entries);
        }
        Ok(normalized)
    }

    /// Register a provider under its own [`Provider::name`] id. Re-registering an
    /// existing id replaces the provider in place while preserving its position
    /// in the iteration order. This is the open extension point for provider
    /// plugins.
    pub fn register(&mut self, provider: Arc<dyn Provider>) {
        let id = provider.name();
        self.insert(id.to_string(), provider);
    }

    /// Register a provider under an **explicit** id instead of its own
    /// [`Provider::name`], for the case where one impl backs two slots (the
    /// classify tier reusing [`LocalProvider`]). The provider is wrapped so its
    /// `name()` reports `id` too â€” see [`AliasedProvider`] for why reporting the
    /// inner name would cross-contaminate the two tiers' metrics and breaker
    /// state. Replacement/order semantics match [`Self::register`].
    pub fn register_as(&mut self, id: &'static str, provider: Arc<dyn Provider>) {
        self.insert(
            id.to_string(),
            Arc::new(AliasedProvider {
                id,
                inner: provider,
            }),
        );
    }

    /// Shared insert: append the id on first registration (preserving iteration
    /// order), then replace in place.
    fn insert(&mut self, id: String, provider: Arc<dyn Provider>) {
        if !self.providers.contains_key(&id) {
            self.order.push(id.clone());
        }
        self.providers.insert(id, provider);
    }

    /// Resolve a provider by its stable string id (e.g. `"openai"`). Returns
    /// `None` for an id with no registered/constructable provider â€” the same
    /// "provider absent/unavailable" signal the old closed match produced.
    pub fn get(&self, id: &str) -> Option<&dyn Provider> {
        self.providers.get(id).map(|p| p.as_ref())
    }

    /// Resolve a provider's optional asynchronous batch capability.
    pub fn batch_provider(&self, id: &str) -> Option<&dyn BatchProvider> {
        self.batch_providers
            .get(id)
            .map(|provider| provider.as_ref())
    }

    /// Retain a batch capability from the captured provider generation through await.
    pub fn batch_provider_owned(&self, id: &str) -> Option<Arc<dyn BatchProvider>> {
        self.batch_providers.get(id).map(Arc::clone)
    }

    /// Register a separate capability without expanding the normal inference
    /// contract for providers that do not support batches.
    fn register_batch_provider(&mut self, id: &'static str, provider: Arc<dyn BatchProvider>) {
        self.batch_providers.insert(id.to_owned(), provider);
    }

    /// Owned resolution from a captured immutable snapshot.
    pub fn get_owned(&self, id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(id).map(Arc::clone)
    }

    /// The ids of all registered providers, in deterministic registration order.
    pub fn available_providers(&self) -> Vec<String> {
        self.order.clone()
    }

    /// Bind aggregate SDK routes before governance; native owners are unchanged.
    pub fn canonicalize_sdk_route(&self, provider_id: &str, model: &str) -> Option<&'static str> {
        let owner = ryu_gw_providers::sdk_descriptor_for_model(model)?;
        if provider_id != "genai" && provider_id != owner.provider_id {
            return None;
        }
        self.providers
            .contains_key(owner.provider_id)
            .then_some(owner.provider_id)
    }

    pub fn activation_error(&self, provider_id: &str) -> Option<&str> {
        self.activation_errors.get(provider_id).map(String::as_str)
    }

    /// The custody this registry was built for. A reload reuses it.
    pub(crate) fn custody(&self) -> crate::custody::GatewayCustody {
        self.custody
    }

    /// How many accounts each account scope holds, for scopes that back at
    /// least one registered provider. Counts only: the account ids derive from
    /// key material and never leave the registry.
    pub(crate) fn account_counts(&self) -> std::collections::BTreeMap<String, usize> {
        self.account_ids
            .iter()
            .filter(|(scope, _)| {
                self.providers.keys().any(|id| {
                    ryu_gw_credentials::sdk_provider_by_id(id)
                        .map_or(id.as_str(), |descriptor| descriptor.account_scope)
                        == scope.as_str()
                })
            })
            .map(|(scope, ids)| (scope.clone(), ids.len()))
            .collect()
    }

    /// Return the verified region for a provider route. Global and local are
    /// explicit labels for providers whose endpoint is not geography-specific;
    /// Bedrock and Vertex require a region-bearing endpoint. A new provider id
    /// without metadata is deliberately unknown.
    pub fn region_for(&self, id: &str) -> Option<String> {
        if matches!(id, "edge-tts" | "google-translate-tts")
            || ryu_gw_credentials::web::web_provider_by_id(id).is_some()
        {
            return None;
        }
        if ryu_gw_credentials::sdk_provider_by_id(id).is_some() {
            return self.regions.get(id).cloned();
        }
        if id == "qwen" {
            return self.regions.get(id).cloned();
        }
        if ryu_gw_credentials::direct_compatible_provider_url(id).is_some() {
            return Some("global".to_owned());
        }
        self.regions.get(id).cloned().or_else(|| match id {
            "openai" | "anthropic" | "openrouter" | "modal" | "genai" | "cohere" | "deepgram"
            | "assemblyai" | "elevenlabs" | "inworld" | "replicate" | "fal" | "cloudflare"
            | "openai-credits" | "anthropic-credits" | "google-tts" => Some("global".to_string()),
            // Azure resources are regional, but the v1 URL names the resource,
            // not its region, so the slot is treated like the other global
            // first-party accounts.
            "azure-credits" => Some("global".to_string()),
            "local" | "classify" | "core" => Some("local".to_string()),
            _ => None,
        })
    }
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// The 300 s total bounds non-streaming calls; streamed completions lift it per
/// request (`ryu_gw_providers::streaming_request`), so the read timeout is what
/// fails a stalled stream. A short connect timeout classifies an unreachable
/// upstream as a connection failure (safe to fall back), not uncertain delivery.
fn build_client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(ryu_gw_providers::STREAM_READ_TIMEOUT)
        .timeout(Duration::from_secs(300))
        .build()
        .expect("failed to build HTTP client")
}

#[cfg(test)]
mod tests;
