//! Media and speech provider configs (image, video, TTS, STT).

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RunwayProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "runway_base_url")]
    pub base_url: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TopazProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "topaz_base_url")]
    pub base_url: String,
}
impl TopazProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}
pub(super) fn topaz_base_url() -> String {
    "https://api.topazlabs.com".to_owned()
}
impl RunwayProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}
pub(super) fn runway_base_url() -> String {
    "https://api.dev.runwayml.com/v1".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MiniMaxProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "minimax_base_url")]
    pub base_url: String,
}
impl MiniMaxProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}
pub(super) fn minimax_base_url() -> String {
    "https://api.minimax.io/v1".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RecraftProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "recraft_base_url")]
    pub base_url: String,
}
impl RecraftProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}
pub(super) fn recraft_base_url() -> String {
    "https://external.api.recraft.ai/v1".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BflProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "bfl_base_url")]
    pub base_url: String,
    #[serde(default = "default_bfl_poll_interval")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_bfl_poll_timeout")]
    pub poll_timeout_secs: u64,
}
impl BflProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}
pub(super) fn bfl_base_url() -> String {
    "https://api.bfl.ai/v1".into()
}
pub(super) fn default_bfl_poll_interval() -> u64 {
    500
}
pub(super) fn default_bfl_poll_timeout() -> u64 {
    180
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StabilityProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "stability_base_url")]
    pub base_url: String,
}
impl StabilityProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}
pub(super) fn stability_base_url() -> String {
    "https://api.stability.ai/v2beta".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AssemblyAiProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "assemblyai_base_url")]
    pub base_url: String,
    #[serde(default = "default_assemblyai_poll_interval_ms")]
    pub poll_interval_ms: u64,
    #[serde(default = "default_assemblyai_poll_timeout_secs")]
    pub poll_timeout_secs: u64,
}

impl AssemblyAiProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn assemblyai_base_url() -> String {
    "https://api.assemblyai.com".to_owned()
}

pub(super) fn default_assemblyai_poll_interval_ms() -> u64 {
    1500
}

pub(super) fn default_assemblyai_poll_timeout_secs() -> u64 {
    180
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ElevenLabsProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "elevenlabs_base_url")]
    pub base_url: String,
}

impl ElevenLabsProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn elevenlabs_base_url() -> String {
    "https://api.elevenlabs.io".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct InworldProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "inworld_base_url")]
    pub base_url: String,
}

impl InworldProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn inworld_base_url() -> String {
    "https://api.inworld.ai".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DeepgramProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "deepgram_base_url")]
    pub base_url: String,
}

impl DeepgramProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn deepgram_base_url() -> String {
    "https://api.deepgram.com".to_owned()
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CohereProviderConfig {
    pub api_key: String,
    #[serde(default)]
    pub api_keys: Vec<String>,
    #[serde(default = "cohere_base_url")]
    pub base_url: String,
}

impl CohereProviderConfig {
    pub fn all_keys(&self) -> Vec<String> {
        all_provider_keys(&self.api_key, &self.api_keys)
    }
}

pub(super) fn cohere_base_url() -> String {
    "https://api.cohere.com".to_owned()
}
