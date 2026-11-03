//! OpenAI-compatible, first-party and cloud LLM provider configs.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CompatibleProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl CompatibleProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenAiProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4, multi-account). When a
    /// key hits an upstream 429 the provider rotates to the next before failing
    /// over to the cost-tier chain. Empty → single-account (uses `api_key`).
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "openai_base_url")]
    pub base_url: String,
}

impl OpenAiProviderConfig {
    /// The full account rotation set: the extra `api_keys` when present, else the
    /// single `api_key`. Empty strings are dropped.
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn openai_base_url() -> String {
    "https://api.openai.com/v1".to_string()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AnthropicProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "anthropic_base_url")]
    pub base_url: String,
}

impl AnthropicProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn anthropic_base_url() -> String {
    "https://api.anthropic.com".to_string()
}

/// Cloudflare Workers AI, reached through its OpenAI-compatibility surface.
///
/// No `#[serde(default)]` on `base_url` on purpose: the endpoint embeds the
/// account id (`…/accounts/{account_id}/ai/v1`), so a compiled-in default would
/// be wrong for every deployment. The env overlay in [`GatewayConfig::load`]
/// interpolates it — serde default fns take no arguments and so cannot.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CloudflareProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl CloudflareProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// AWS Bedrock, reached through its Anthropic-Messages-compatible surface.
///
/// Same "no default base URL" reasoning as [`CloudflareProviderConfig`]: the
/// endpoint is region-scoped (`https://bedrock-mantle.{region}.api.aws/anthropic`).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BedrockProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl BedrockProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// Google Cloud Vertex AI, reached through its OpenAI-compatible Chat
/// Completions surface (`…/endpoints/openapi/chat/completions`, bearer auth) —
/// byte-for-byte what [`crate::providers::OpenAiProvider`] already sends.
///
/// Same "no default base URL" reasoning as [`CloudflareProviderConfig`], only
/// more so: the endpoint embeds the project AND the location
/// (`https://{loc}-aiplatform.googleapis.com/v1/projects/{project}/locations/{loc}/endpoints/openapi`).
///
/// **`api_key` must be a LONG-LIVED credential, not a pasted access token.** The
/// obvious way to get a Vertex bearer is `gcloud auth print-access-token`, and it
/// expires in about an hour. On a donated pool that failure is nasty: the
/// provider keeps registering, every request 401s, and the pool looks *dead*
/// rather than misconfigured. Use a Vertex AI API key (express-mode) or a
/// credential broker that hands the gateway something durable.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VertexProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    pub base_url: String,
}

impl VertexProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// Merge a primary key + an optional extra-accounts list into the rotation set,
/// preferring the explicit list and always including the primary. Blank entries
/// are dropped so a stray empty string never becomes a "key". Falls back to a
/// single empty string only if nothing is configured (keeps the provider
/// constructible; the upstream call then fails auth as before).
pub(super) fn all_provider_keys(primary: &str, extra: &[String]) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    if !primary.is_empty() {
        keys.push(primary.to_string());
    }
    for k in extra {
        if !k.is_empty() && !keys.contains(k) {
            keys.push(k.clone());
        }
    }
    if keys.is_empty() {
        keys.push(String::new());
    }
    keys
}
