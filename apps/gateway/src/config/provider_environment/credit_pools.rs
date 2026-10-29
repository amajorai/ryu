//! Credit-pool provider slots (Cloudflare, Bedrock, Vertex and the donated
//! OpenAI/Anthropic allowances) filled from the captured provider environment.
use super::*;

impl ProviderEnvironment {
    pub(super) fn apply_credit_pool_providers(&self, config: &mut GatewayConfig) {
        // Cloudflare Workers AI — the `cloudflare` credit pool's supply. Both the
        // account id and the token are required because the endpoint embeds the
        // account (`…/accounts/{id}/ai/v1`); absent either, the provider stays off
        // and the id is simply missing from the registry (nothing hardcoded, no
        // default URL, no boot failure). `CLOUDFLARE_BASE_URL` overrides the
        // interpolation wholesale for gateways fronted by a proxy.
        if let Ok(token) = self.var("CLOUDFLARE_API_TOKEN") {
            let account_id = self.var("CLOUDFLARE_ACCOUNT_ID").unwrap_or_default();
            let base_url = self
                .var("CLOUDFLARE_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    (!account_id.trim().is_empty()).then(|| {
                        format!(
                            "https://api.cloudflare.com/client/v4/accounts/{}/ai/v1",
                            account_id.trim()
                        )
                    })
                });
            if let Some(base_url) = base_url {
                if !token.trim().is_empty() {
                    config.providers.cloudflare = Some(CloudflareProviderConfig {
                        api_key: token,
                        api_keys: self.keys("CLOUDFLARE_API_TOKENS"),
                        base_url,
                    });
                }
            }
        }

        // AWS Bedrock — the `bedrock` credit pool's supply. `AWS_BEARER_TOKEN_BEDROCK`
        // is Bedrock's own long-lived API key (not SigV4 credentials), which is what
        // lets the Anthropic-Messages impl talk to it unmodified. Region-scoped, so
        // the URL is interpolated from `AWS_REGION` unless `BEDROCK_BASE_URL` pins it.
        if let Ok(token) = self.var("AWS_BEARER_TOKEN_BEDROCK") {
            let region = self.var("AWS_REGION").unwrap_or_default();
            let base_url = self
                .var("BEDROCK_BASE_URL")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| {
                    (!region.trim().is_empty()).then(|| {
                        format!("https://bedrock-mantle.{}.api.aws/anthropic", region.trim())
                    })
                });
            if let Some(base_url) = base_url {
                if !token.trim().is_empty() {
                    config.providers.bedrock = Some(BedrockProviderConfig {
                        api_key: token,
                        api_keys: self.keys("AWS_BEARER_TOKENS_BEDROCK"),
                        base_url,
                    });
                }
            }
        }

        // Google Cloud Vertex AI — the `vertex` credit pool's supply, on Vertex's
        // OpenAI-compatible surface. Project AND location are both required because
        // the endpoint embeds both; absent either, the provider stays off and the id
        // is simply missing from the registry. `VERTEX_BASE_URL` overrides the
        // interpolation wholesale (global endpoint, a proxy, or a pinned API version).
        //
        // The interpolated form deliberately stops at `/endpoints/openapi` — the
        // OpenAI impl appends `/chat/completions` itself.
        if let Ok(token) = self.var("VERTEX_API_KEY") {
            let project = self.var("VERTEX_PROJECT_ID").unwrap_or_default();
            let location = self.var("VERTEX_LOCATION").unwrap_or_default();
            let base_url = self.var("VERTEX_BASE_URL")
                    .ok()
                    .filter(|s| !s.trim().is_empty())
                    .or_else(|| {
                        (!project.trim().is_empty() && !location.trim().is_empty()).then(|| {
                            format!(
                                "https://{}-aiplatform.googleapis.com/v1/projects/{}/locations/{}/endpoints/openapi",
                                location.trim(),
                                project.trim(),
                                location.trim()
                            )
                        })
                    });
            if let Some(base_url) = base_url {
                if !token.trim().is_empty() {
                    config.providers.vertex = Some(VertexProviderConfig {
                        api_key: token,
                        api_keys: self.keys("VERTEX_API_KEYS"),
                        base_url,
                    });
                }
            }
        }

        // The donated OpenAI allowance — a SEPARATE env var from `OPENAI_API_KEY`
        // on purpose. Reading the same var would tag a BYOK deploy's own key as
        // donated supply, which is the whole failure this slot exists to avoid.
        // Unlike the other three pools the endpoint is not account/region-scoped,
        // so `base_url` keeps its ordinary default and only the key gates the slot.
        if let Ok(key) = self.var("OPENAI_CREDITS_API_KEY") {
            if !key.trim().is_empty() {
                config.providers.openai_credits = Some(OpenAiProviderConfig {
                    api_key: key,
                    api_keys: self.keys("OPENAI_CREDITS_API_KEYS"),
                    base_url: self
                        .var("OPENAI_CREDITS_BASE_URL")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(openai_base_url),
                });
            }
        }
        // Ryu's own first-party Anthropic account — a SEPARATE env var from
        // `ANTHROPIC_API_KEY` so a BYOK deploy's key is never tagged as Ryu supply.
        if let Ok(key) = self.var("ANTHROPIC_CREDITS_API_KEY") {
            if !key.trim().is_empty() {
                config.providers.anthropic_credits = Some(AnthropicProviderConfig {
                    api_key: key,
                    api_keys: self.keys("ANTHROPIC_CREDITS_API_KEYS"),
                    base_url: self
                        .var("ANTHROPIC_CREDITS_BASE_URL")
                        .ok()
                        .filter(|s| !s.trim().is_empty())
                        .unwrap_or_else(anthropic_base_url),
                });
            }
        }
    }
}
