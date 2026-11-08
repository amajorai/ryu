//! Vault-key overlay for providers that also need a deployment base URL, plus
//! the credit lanes and service integrations.

use super::*;

impl GatewayConfig {
    /// Cloudflare, Bedrock and Vertex: a key applies only with a resolvable base URL.
    pub(super) fn apply_vault_cloud_keys(
        &mut self,
        keys: &HashMap<String, String>,
        environment: &ProviderEnvironment,
        applied: &mut Vec<String>,
    ) {
        if let Some(key) = non_empty_provider_key(keys, "cloudflare") {
            let base_url = self
                .providers
                .cloudflare
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    environment
                        .var("CLOUDFLARE_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    environment
                        .var("CLOUDFLARE_ACCOUNT_ID")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(|account_id| {
                            format!(
                                "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1",
                                account_id.trim()
                            )
                        })
                });
            if let Some(base_url) = base_url {
                let mut provider =
                    self.providers
                        .cloudflare
                        .take()
                        .unwrap_or(CloudflareProviderConfig {
                            api_key: String::new(),
                            api_keys: Vec::new(),
                            base_url,
                        });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.cloudflare = Some(provider);
                applied.push("cloudflare".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Cloudflare key but CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_BASE_URL is missing; Cloudflare remains disabled"
                );
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "bedrock") {
            let base_url = self
                .providers
                .bedrock
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    environment
                        .var("BEDROCK_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    environment
                        .var("AWS_REGION")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(|region| {
                            format!("https://bedrock-mantle.{}.api.aws/anthropic", region.trim())
                        })
                });
            if let Some(base_url) = base_url {
                let mut provider = self
                    .providers
                    .bedrock
                    .take()
                    .unwrap_or(BedrockProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url,
                    });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.bedrock = Some(provider);
                applied.push("bedrock".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Bedrock key but AWS_REGION or BEDROCK_BASE_URL is missing; Bedrock remains disabled"
                );
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "vertex") {
            let base_url = self
                .providers
                .vertex
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    environment.var("VERTEX_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                })
                .or_else(|| {
                    let project = environment.var("VERTEX_PROJECT_ID").ok()?;
                    let location = environment.var("VERTEX_LOCATION").ok()?;
                    if project.trim().is_empty() || location.trim().is_empty() {
                        return None;
                    }
                    Some(format!(
                        "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/endpoints/openapi",
                        location.trim(),
                        project.trim(),
                        location.trim()
                    ))
                });
            if let Some(base_url) = base_url {
                let mut provider = self
                    .providers
                    .vertex
                    .take()
                    .unwrap_or(VertexProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url,
                    });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.vertex = Some(provider);
                applied.push("vertex".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Vertex key but Vertex project/location or VERTEX_BASE_URL is missing; Vertex remains disabled"
                );
            }
        }
    }

    /// Credit lanes, Composio, Treg, an authored Vercel lane, and Modal.
    pub(super) fn apply_vault_service_keys(
        &mut self,
        keys: &HashMap<String, String>,
        environment: &ProviderEnvironment,
        applied: &mut Vec<String>,
    ) {
        if let Some(key) = non_empty_provider_key(keys, "openai_credits") {
            let mut provider =
                self.providers
                    .openai_credits
                    .take()
                    .unwrap_or(OpenAiProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url: openai_base_url(),
                    });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.openai_credits = Some(provider);
            applied.push("openai_credits".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "anthropic_credits") {
            let mut provider =
                self.providers
                    .anthropic_credits
                    .take()
                    .unwrap_or(AnthropicProviderConfig {
                        api_key: String::new(),
                        api_keys: Vec::new(),
                        base_url: anthropic_base_url(),
                    });
            provider.api_key = key.to_owned();
            provider.api_keys.clear();
            self.providers.anthropic_credits = Some(provider);
            applied.push("anthropic_credits".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "azure_credits") {
            // Azure is resource-scoped like Vertex: a vault key applies only
            // when the slot already has an endpoint or the environment names one.
            let base_url = self
                .providers
                .azure_credits
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .filter(|value| !value.trim().is_empty())
                .or_else(|| {
                    environment
                        .var("AZURE_CREDITS_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                        .map(|value| value.trim().trim_end_matches('/').to_owned())
                })
                .or_else(|| {
                    let resource = environment.var("AZURE_CREDITS_RESOURCE").ok()?;
                    (!resource.trim().is_empty())
                        .then(|| format!("https://{}.openai.azure.com/openai/v1", resource.trim()))
                });
            if let Some(base_url) = base_url {
                let mut provider =
                    self.providers
                        .azure_credits
                        .take()
                        .unwrap_or(OpenAiProviderConfig {
                            api_key: String::new(),
                            api_keys: Vec::new(),
                            base_url,
                        });
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                self.providers.azure_credits = Some(provider);
                applied.push("azure_credits".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains an Azure credits key but AZURE_CREDITS_RESOURCE or AZURE_CREDITS_BASE_URL is missing; the Azure pool remains disabled"
                );
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "composio") {
            self.composio.api_key = Some(key.to_owned());
            self.composio.enabled = true;
            applied.push("composio".to_string());
        }

        if let Some(key) = non_empty_provider_key(keys, "treg") {
            self.treg.token = Some(key.to_owned());
            self.treg.enabled = true;
            applied.push("treg".to_string());
        }

        // A vault key only fills an authored Vercel lane. It never creates the
        // slot, because the lane also needs its recorded resale permission.
        if let Some(key) = non_empty_provider_key(keys, "vercel") {
            if let Some(provider) = self.providers.vercel.as_mut() {
                provider.api_key = key.to_owned();
                provider.api_keys.clear();
                applied.push("vercel".to_string());
            }
        }

        if let Some(key) = non_empty_provider_key(keys, "modal") {
            let base_url = self
                .providers
                .modal
                .as_ref()
                .map(|provider| provider.base_url.clone())
                .or_else(|| {
                    environment
                        .var("MODAL_BASE_URL")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                });
            if let Some(base_url) = base_url {
                self.providers.modal = Some(ModalProviderConfig {
                    api_key: key.to_owned(),
                    api_keys: Vec::new(),
                    base_url,
                });
                applied.push("modal".to_string());
            } else {
                tracing::warn!(
                    "provider vault contains a Modal key but MODAL_BASE_URL is missing; Modal remains disabled"
                );
            }
        }
    }
}

#[cfg(test)]
#[path = "tests/vault_keys_cloud_tests.rs"]
mod tests;
