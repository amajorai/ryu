//! Hosted aggregator and media-host provider configs.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OpenRouterProviderConfig {
    pub api_key: String,
    /// Additional accounts for round-robin rotation (#4). See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "openrouter_base_url")]
    pub base_url: String,
    #[serde(default = "openrouter_site_url")]
    pub site_url: String,
    #[serde(default = "openrouter_site_name")]
    pub site_name: String,
    /// Legacy configuration input. The OpenRouter adapter always sends "deny"
    /// for every plan, regardless of saved caller or operator opt-outs.
    #[serde(default = "openrouter_data_collection")]
    pub data_collection: String,
    /// Legacy configuration input. The OpenRouter adapter always requires ZDR.
    #[serde(default)]
    pub zdr: bool,
    /// Provider sort preference: "price" | "throughput" | "latency". Empty → omit.
    #[serde(default)]
    pub sort: String,
    /// Add the `response-healing` plugin (repairs malformed JSON). Default off
    /// until its billing is confirmed.
    #[serde(default)]
    pub response_healing: bool,
    /// Send the legacy `usage: {include: true}` flag. Current OpenRouter always
    /// returns `usage.cost` (read by `response_cost_micro_usd` for at-cost credit
    /// metering), so this only helps older or OpenRouter-compatible endpoints.
    /// Default on for compatibility; harmless no-op on modern OpenRouter.
    #[serde(default = "default_true")]
    pub usage_accounting: bool,
    /// Reserved: per-org OpenRouter sub-keys minted via the management-key API
    /// (`/api/v1/keys`) so per-tenant spend is capped and attributed at
    /// OpenRouter. Empty today (single shared account key); the per-request key
    /// selection through the pipeline is the follow-up to the provisioning loop.
    #[serde(default)]
    pub org_api_keys: std::collections::HashMap<String, String>,
}

impl OpenRouterProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn openrouter_base_url() -> String {
    "https://openrouter.ai/api/v1".to_string()
}

/// An operator-run LiteLLM proxy. The endpoint is deployment configuration
/// (file or `LITELLM_BASE_URL`), never a caller-chosen URL; the virtual or
/// master key is the provider credential.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LiteLlmProviderConfig {
    pub api_key: String,
    /// Additional virtual keys for round-robin rotation. See
    /// [`OpenAiProviderConfig::api_keys`].
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "litellm_base_url")]
    pub base_url: String,
}

impl LiteLlmProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// LiteLLM's documented default proxy address.
pub(crate) fn litellm_base_url() -> String {
    "http://127.0.0.1:4000/v1".to_string()
}
pub(super) fn openrouter_site_url() -> String {
    "https://ryuhq.com".to_string()
}
pub(super) fn openrouter_site_name() -> String {
    "Ryu".to_string()
}

pub(super) fn openrouter_data_collection() -> String {
    // Empty → the `provider.data_collection` field is omitted, so out-of-the-box
    // behaviour is unchanged and a BYOK caller's own routing is never overridden.
    // Managed nodes opt in to "deny" via env.
    String::new()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CoreProviderConfig {
    #[serde(default = "core_base_url")]
    pub base_url: String,
    pub token: Option<String>,
}

pub(super) fn core_base_url() -> String {
    "http://127.0.0.1:2049".to_string()
}

/// Modal (https://modal.com) — serverless GPU compute. A Ryu Cloud GPU node
/// deploys an OpenAI-compatible inference app (e.g. vLLM) on Modal and points
/// the gateway at it, so heavy local-model inference bursts onto Modal's GPUs
/// (pay-per-second, scale-to-zero) while the always-on orchestration node stays
/// on cheap CPU. Wire-compatible with OpenAI, so the provider is a thin bearer
/// client. There is NO universal default URL — every Modal deployment has its
/// own `*.modal.run` endpoint — so `base_url` is required, and the provider is
/// only constructed when both it and the token are configured (opt-in).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModalProviderConfig {
    /// The Modal proxy-auth token (sent as a bearer). Modal apps gate access
    /// with a token; never hardcoded.
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// The deployed Modal app's OpenAI-compatible base URL (its `*.modal.run`
    /// `/v1` endpoint). Required — no sensible default exists.
    pub base_url: String,
}

impl ModalProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
            .into_iter()
            .filter(|key| !key.is_empty())
            .collect()
    }
}

/// The Vercel AI Gateway lane. Every attempt spends Ryu's Vercel credit, so
/// the slot needs a recorded written resale permission before the registry
/// builds it (spec 08.2 and 08.4). The default decision is none: the lane is off.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VercelProviderConfig {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// OpenAI-compatible Chat Completions base URL.
    #[serde(default = "vercel_chat_base_url")]
    pub base_url: String,
    /// Anthropic-compatible Messages base URL, used for `anthropic/*` models.
    #[serde(default = "vercel_messages_base_url")]
    pub messages_base_url: String,
    /// The recorded resale decision. Only `approved:<written reference>`
    /// registers the lane; anything else, absent included, keeps it off.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resale_permission: Option<String>,
}

impl VercelProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
            .into_iter()
            .filter(|key| !key.trim().is_empty())
            .collect()
    }
}

pub(super) fn vercel_chat_base_url() -> String {
    ryu_gw_providers::vercel::VERCEL_CHAT_BASE_URL.to_owned()
}

pub(super) fn vercel_messages_base_url() -> String {
    ryu_gw_providers::vercel::VERCEL_MESSAGES_BASE_URL.to_owned()
}

pub use ryu_gw_credentials::{
    GenAiAccountConfig, GenAiProviderConfig, ResolvedSdkKey, SdkKeySource,
};

/// Replicate (https://replicate.com) — cloud generative media over an async
/// prediction API. A request creates a prediction (`POST /predictions` with a
/// versioned model or `POST /models/{owner}/{name}/predictions`), then the
/// gateway polls the returned prediction until it reaches a terminal state and
/// exposes the `output` (usually a URL, or list of URLs). Image gen blocks and
/// polls inline (fast enough); video gen submits a job the client polls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReplicateProviderConfig {
    /// Replicate API token (sent as `Authorization: Bearer <token>`).
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "replicate_base_url")]
    pub base_url: String,
    /// Poll interval in milliseconds while a prediction is running. Default: 1500.
    #[serde(default = "default_media_poll_interval_ms")]
    pub poll_interval_ms: u64,
    /// Max seconds to block-and-poll an inline (image) prediction before giving
    /// up. Video never blocks this long — it returns a job id. Default: 120.
    #[serde(default = "default_media_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

pub(super) fn replicate_base_url() -> String {
    "https://api.replicate.com/v1".to_string()
}

impl ReplicateProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

/// Fal (https://fal.ai) — cloud generative media over a queued request API. A
/// request submits to `https://queue.fal.run/{model}` and receives a
/// `request_id` + status/response URLs; the gateway polls the status URL until
/// `COMPLETED`, then fetches the response. Image gen blocks and polls inline;
/// video gen submits a job the client polls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct FalProviderConfig {
    /// Fal API key (sent as `Authorization: Key <key>`).
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    /// Queue base URL (model id is appended per request). Default:
    /// `https://queue.fal.run`.
    #[serde(default = "fal_base_url")]
    pub base_url: String,
    /// Poll interval in milliseconds while a request is queued/in-progress.
    #[serde(default = "default_media_poll_interval_ms")]
    pub poll_interval_ms: u64,
    /// Max seconds to block-and-poll an inline (image) request. Default: 120.
    #[serde(default = "default_media_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

pub(super) fn fal_base_url() -> String {
    "https://queue.fal.run".to_string()
}

impl FalProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn default_media_poll_interval_ms() -> u64 {
    1500
}
pub(super) fn default_media_poll_timeout_secs() -> u64 {
    120
}
