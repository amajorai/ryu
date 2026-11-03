//! Full replacement of provider credentials from a successful fleet vault read.

use super::*;

impl GatewayConfig {
    /// Replace every supported provider credential with the successful fleet
    /// vault response. Required hosted mode uses this instead of a partial
    /// overlay so a stale gateway.toml/env key cannot survive merely because
    /// its provider was omitted from MongoDB.
    pub fn replace_provider_vault_keys(&mut self, keys: &HashMap<String, String>) -> Vec<String> {
        let environment = ProviderEnvironment::capture(&self.egress);
        self.replace_provider_vault_keys_with_environment(keys, &environment)
    }

    pub(crate) fn replace_provider_vault_keys_with_environment(
        &mut self,
        keys: &HashMap<String, String>,
        environment: &ProviderEnvironment,
    ) -> Vec<String> {
        if let Some(config) = self.providers.genai.as_mut() {
            for account in config.accounts.values_mut() {
                account.api_key.clear();
                account.api_keys.clear();
                account.allow_env = false;
            }
            config.clear_fleet_markers();
        }
        if let Some(provider) = self.providers.openai.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.anthropic.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.openrouter.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
            provider.org_api_keys.clear();
        }
        if let Some(provider) = self.providers.replicate.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.fal.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.modal.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.cloudflare.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.bedrock.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.vertex.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.openai_credits.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.anthropic_credits.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        if let Some(provider) = self.providers.vercel.as_mut() {
            provider.api_key.clear();
            provider.api_keys.clear();
        }
        self.composio.api_key = None;
        self.composio.enabled = false;
        self.treg.token = None;
        self.treg.enabled = false;
        let applied = self.apply_provider_vault_keys_with_environment(keys, environment);

        if non_empty_provider_key(keys, "openai").is_none() {
            self.providers.openai = None;
        }
        if non_empty_provider_key(keys, "anthropic").is_none() {
            self.providers.anthropic = None;
        }
        if non_empty_provider_key(keys, "openrouter").is_none() {
            self.providers.openrouter = None;
        }
        if non_empty_provider_key(keys, "replicate").is_none() {
            self.providers.replicate = None;
        }
        if non_empty_provider_key(keys, "fal").is_none() {
            self.providers.fal = None;
        }
        if non_empty_provider_key(keys, "modal").is_none() {
            self.providers.modal = None;
        }
        if non_empty_provider_key(keys, "cloudflare").is_none() {
            self.providers.cloudflare = None;
        }
        if non_empty_provider_key(keys, "bedrock").is_none() {
            self.providers.bedrock = None;
        }
        if non_empty_provider_key(keys, "vertex").is_none() {
            self.providers.vertex = None;
        }
        if non_empty_provider_key(keys, "openai_credits").is_none() {
            self.providers.openai_credits = None;
        }
        if non_empty_provider_key(keys, "anthropic_credits").is_none() {
            self.providers.anthropic_credits = None;
        }
        if non_empty_provider_key(keys, "vercel").is_none() {
            self.providers.vercel = None;
        }

        applied
    }
}

#[cfg(test)]
#[path = "tests/vault_replace_tests.rs"]
mod tests;
