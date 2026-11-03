//! Overlay of fleet provider-vault keys onto the config.

use super::*;

impl GatewayConfig {
    /// Overlay shared fleet provider keys fetched from the control-plane vault.
    ///
    /// The overlay wins over env/file credentials and clears multi-account or
    /// org-key material from the active config so a hosted gateway has exactly
    /// one backend-owned source of truth. Base URLs and non-secret provider
    /// options remain deployment configuration.
    pub fn apply_provider_vault_keys(&mut self, keys: &HashMap<String, String>) -> Vec<String> {
        let environment = ProviderEnvironment::capture(&self.egress);
        self.apply_provider_vault_keys_with_environment(keys, &environment)
    }

    pub(crate) fn apply_provider_vault_keys_with_environment(
        &mut self,
        keys: &HashMap<String, String>,
        environment: &ProviderEnvironment,
    ) -> Vec<String> {
        let mut applied = Vec::new();
        self.apply_vault_sdk_keys(keys, &mut applied);
        self.apply_vault_llm_keys(keys, environment, &mut applied);
        self.apply_vault_media_keys(keys, &mut applied);
        self.apply_vault_cloud_keys(keys, environment, &mut applied);
        self.apply_vault_service_keys(keys, environment, &mut applied);
        applied
    }

    /// SDK-catalog provider accounts, in catalog order.
    fn apply_vault_sdk_keys(&mut self, keys: &HashMap<String, String>, applied: &mut Vec<String>) {
        for descriptor in ryu_gw_credentials::SDK_PROVIDERS {
            if descriptor.auth_kind == ryu_gw_credentials::SdkAuthKind::NoAuth {
                continue;
            }
            if let Some(key) = non_empty_provider_key(keys, descriptor.account_scope) {
                let config = self.providers.genai.get_or_insert_with(Default::default);
                let account = config
                    .accounts
                    .entry(descriptor.kind.to_owned())
                    .or_default();
                let previous = account.clone();
                account.api_key = key.to_owned();
                account.api_keys.clear();
                account.allow_env = false;
                if account.validate(descriptor.kind).is_err() {
                    *account = previous;
                    continue;
                }
                config.mark_fleet_kind(descriptor.kind);
                applied.push(descriptor.account_scope.to_owned());
            }
        }
    }

    /// OpenAI, Anthropic and OpenRouter.
    fn apply_vault_llm_keys(
        &mut self,
        keys: &HashMap<String, String>,
        environment: &ProviderEnvironment,
        applied: &mut Vec<String>,
    ) {
        if let Some(key) = non_empty_provider_key(keys, "openai") {
            let mut provider = self
                .providers
                .openai
                .take()
                .unwrap_or(OpenAiProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: openai_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.openai = Some(provider);
            applied.push("openai".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "anthropic") {
            let mut provider = self
                .providers
                .anthropic
                .take()
                .unwrap_or(AnthropicProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: anthropic_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.anthropic = Some(provider);
            applied.push("anthropic".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "openrouter") {
            let mut provider =
                self.providers
                    .openrouter
                    .take()
                    .unwrap_or(OpenRouterProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url: openrouter_base_url(),
                        site_url: openrouter_site_url(),
                        site_name: openrouter_site_name(),
                        data_collection: openrouter_data_collection(),
                        zdr: false,
                        sort: String::new(),
                        response_healing: false,
                        usage_accounting: true,
                        org_api_keys: HashMap::new(),
                    });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            provider.org_api_keys.clear();
            // A vault key is Ryu's own managed credential, so the managed privacy
            // default applies unless the operator pinned a policy explicitly.
            if provider.data_collection.trim().is_empty()
                && environment.var("OPENROUTER_DATA_COLLECTION").is_err()
                && std::env::var_os("OPENROUTER_DATA_COLLECTION").is_none()
            {
                provider.data_collection = MANAGED_OPENROUTER_DATA_COLLECTION.to_owned();
            }
            self.providers.openrouter = Some(provider);
            applied.push("openrouter".to_string());
        }
    }

    /// Image and video hosts.
    fn apply_vault_media_keys(
        &mut self,
        keys: &HashMap<String, String>,
        applied: &mut Vec<String>,
    ) {
        if let Some(key) = non_empty_provider_key(keys, "replicate") {
            let mut provider = self
                .providers
                .replicate
                .take()
                .unwrap_or(ReplicateProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: replicate_base_url(),
                    poll_interval_ms: default_media_poll_interval_ms(),
                    poll_timeout_secs: default_media_poll_timeout_secs(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.replicate = Some(provider);
            applied.push("replicate".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "bfl") {
            let mut provider = self.providers.bfl.take().unwrap_or(BflProviderConfig {
                api_key: String::new(),
                api_keys: Vec::new(),
                base_url: bfl_base_url(),
                poll_interval_ms: default_bfl_poll_interval(),
                poll_timeout_secs: default_bfl_poll_timeout(),
            });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.bfl = Some(provider);
            applied.push("bfl".into());
        }
        if let Some(key) = non_empty_provider_key(keys, "stability") {
            let mut provider = self
                .providers
                .stability
                .take()
                .unwrap_or(StabilityProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: stability_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.stability = Some(provider);
            applied.push("stability".to_owned());
        }
        if let Some(key) = non_empty_provider_key(keys, "runway") {
            let mut provider = self
                .providers
                .runway
                .take()
                .unwrap_or(RunwayProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: runway_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.runway = Some(provider);
            applied.push("runway".to_owned());
        }
        if let Some(key) = non_empty_provider_key(keys, "topaz") {
            let mut provider = self.providers.topaz.take().unwrap_or(TopazProviderConfig {
                api_key: String::new(),
                api_keys: Vec::new(),
                base_url: topaz_base_url(),
            });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.topaz = Some(provider);
            applied.push("topaz".to_owned());
        }
        if let Some(key) = non_empty_provider_key(keys, "minimax") {
            let mut provider = self
                .providers
                .minimax
                .take()
                .unwrap_or(MiniMaxProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: minimax_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.minimax = Some(provider);
            applied.push("minimax".to_owned());
        }
        if let Some(key) = non_empty_provider_key(keys, "recraft") {
            let mut provider = self
                .providers
                .recraft
                .take()
                .unwrap_or(RecraftProviderConfig {
                    api_key: String::new(),
                    api_keys: Vec::new(),
                    base_url: recraft_base_url(),
                });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.recraft = Some(provider);
            applied.push("recraft".to_owned());
        }
        if let Some(key) = non_empty_provider_key(keys, "fal") {
            let mut provider = self.providers.fal.take().unwrap_or(FalProviderConfig {
                api_keys: Vec::new(),
                api_key: String::new(),
                base_url: fal_base_url(),
                poll_interval_ms: default_media_poll_interval_ms(),
                poll_timeout_secs: default_media_poll_timeout_secs(),
            });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.fal = Some(provider);
            applied.push("fal".to_string());
        }
    }
}

#[cfg(test)]
#[path = "tests/vault_keys_tests.rs"]
mod tests;
