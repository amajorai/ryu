//! Model routing, modalities and provider pools.

use super::*;

/// The modality of a request. The router uses this to pick a provider that
/// supports the requested capability, so an agent's chat, image-gen, TTS, and
/// STT calls can each go to different providers.
#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Modality {
    /// Text chat completion (default).
    #[default]
    Chat,
    /// Image generation.
    Image,
    /// Text-to-speech synthesis.
    Tts,
    /// Speech-to-text transcription.
    Stt,
    /// Video generation. Unlike the other modalities this is job-based: a submit
    /// creates a job the client polls, because cloud video runs for minutes.
    Video,
    /// Audio generation: music and sound effects from a prompt (plus optional
    /// reference media). Job-based like video, because cloud music models run
    /// for tens of seconds to minutes. Distinct from `Tts`, which synthesizes
    /// speech from text through a synchronous call.
    Audio,
}

impl Modality {
    pub fn as_str(&self) -> &'static str {
        match self {
            Modality::Chat => "chat",
            Modality::Image => "image",
            Modality::Tts => "tts",
            Modality::Stt => "stt",
            Modality::Video => "video",
            Modality::Audio => "audio",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct RoutingConfig {
    #[serde(default)]
    pub web: crate::web_config::WebRoutingConfig,
    #[serde(default)]
    pub web_pools: std::collections::BTreeMap<String, crate::web_config::WebPoolConfig>,
    #[serde(default)]
    pub default_provider: ProviderId,

    /// Static model → provider mappings (e.g. "claude-3-5-sonnet" → anthropic)
    #[serde(default)]
    pub model_map: HashMap<String, ModelMapping>,

    /// Fallback chain when the primary provider is unavailable
    #[serde(default)]
    pub fallback_chain: Vec<ProviderId>,

    /// Cost-tier ordering for the fallback chain (#2). Lower = preferred:
    /// subscription (0) → cheap (1) → free (2). After the primary provider, the
    /// chain is stably sorted by tier so a rate-limited/failed primary demotes
    /// down the cost ladder instead of round-robining at random. Absent entries
    /// default to tier 0. Empty map (the default) preserves the flat
    /// `fallback_chain` order exactly — nothing hardcoded.
    #[serde(default)]
    pub provider_tiers: HashMap<ProviderId, u8>,

    /// Named direct-provider chat pools. A route points to `pool:<name>`; each
    /// member carries the exact model accepted by that upstream. Pool selection
    /// happens before budgeting and cache lookup, so those stages see a real
    /// provider/model pair rather than the alias.
    #[serde(default)]
    pub provider_pools: HashMap<String, ProviderPoolConfig>,

    /// Eval-driven (A/B) routing. When enabled, requests are split across a set
    /// of candidate providers and the winner is biased toward whichever candidate
    /// has the better rolling eval score (see `apps/gateway/src/evals`).
    #[serde(default)]
    pub eval_routing: EvalRoutingConfig,

    /// Modality-to-provider mappings. When a request carries a modality other
    /// than `chat`, the router looks here first before falling back to the
    /// model_map / default_provider logic. All entries are swappable; there are
    /// no hardcoded defaults so zero configuration works (every modality falls
    /// back to the default_provider).
    #[serde(default)]
    pub modality_map: HashMap<Modality, ModalityMapping>,

    /// Smart model routing. When enabled, the selected model-router algorithm
    /// picks or preserves a target before normal model→provider routing runs.
    /// Off by default; fully swappable.
    #[serde(default)]
    pub smart_routing: SmartRoutingConfig,
}

pub use ryu_gw_router::pool::PoolStrategy as ProviderPoolStrategy;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProviderPoolConfig {
    #[serde(default)]
    pub strategy: ProviderPoolStrategy,
    /// Number of new round-robin session assignments before advancing.
    #[serde(default = "default_pool_sticky_limit")]
    pub sticky_limit: u8,
    /// Maximum delay for observed member cooldowns before selection fails.
    #[serde(default)]
    pub wait_for_cooldown_ms: u64,
    /// Bounds for multi-target inference. Every target still uses normal Gateway admission.
    #[serde(default)]
    pub execution: PoolExecutionConfig,
    /// Concrete synthesis target required by fusion; it cannot point to a pool.
    #[serde(default)]
    pub judge: Option<PoolJudgeConfig>,
    #[serde(default)]
    pub auto_weights: Option<ryu_gw_router::pool::AutoScoringWeights>,
    pub members: Vec<ProviderPoolMemberConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PoolExecutionConfig {
    #[serde(default = "default_pool_leg_timeout_ms")]
    pub leg_timeout_ms: u64,
    #[serde(default = "default_pool_total_timeout_ms")]
    pub total_timeout_ms: u64,
    #[serde(default = "default_pool_max_output_bytes")]
    pub max_output_bytes: usize,
    #[serde(default = "default_pool_quorum")]
    pub quorum: usize,
    #[serde(default = "default_pool_grace_ms")]
    pub grace_ms: u64,
}

impl Default for PoolExecutionConfig {
    fn default() -> Self {
        Self {
            leg_timeout_ms: default_pool_leg_timeout_ms(),
            total_timeout_ms: default_pool_total_timeout_ms(),
            max_output_bytes: default_pool_max_output_bytes(),
            quorum: default_pool_quorum(),
            grace_ms: default_pool_grace_ms(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PoolJudgeConfig {
    pub provider: ProviderId,
    pub model: String,
}

pub(super) fn default_pool_leg_timeout_ms() -> u64 {
    30_000
}
pub(super) fn default_pool_total_timeout_ms() -> u64 {
    120_000
}
pub(super) fn default_pool_max_output_bytes() -> usize {
    262_144
}
pub(super) fn default_pool_quorum() -> usize {
    2
}
pub(super) fn default_pool_grace_ms() -> u64 {
    250
}

pub(super) fn default_pool_sticky_limit() -> u8 {
    1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProviderPoolMemberConfig {
    pub provider: ProviderId,
    pub model: String,
    #[serde(default)]
    pub priority: u8,
    #[serde(default = "default_pool_weight")]
    pub weight: u16,
    #[serde(default = "default_pool_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub last_resort: bool,
    /// Verified or operator-authored model capacity. Unknown remains absent.
    #[serde(default)]
    pub context_tokens: Option<u64>,
}

pub(super) fn default_pool_weight() -> u16 {
    1
}

pub(super) fn default_pool_enabled() -> bool {
    true
}
