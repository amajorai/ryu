//! The `[providers]` table: every upstream provider slot.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProvidersConfig {
    /// Explicit opt-in to the unofficial anonymous Edge consumer speech service.
    #[serde(default)]
    pub edge_tts: Option<EdgeTtsConfig>,
    pub google_translate_tts: Option<GoogleTranslateTtsConfig>,
    /// Direct Google Cloud Text-to-Speech with supplied, scoped OAuth tokens.
    #[serde(default)]
    pub google_tts: Option<GoogleTtsProviderConfig>,
    /// Direct Amazon Polly with explicitly supplied SigV4 credentials.
    #[serde(default)]
    pub polly: Option<PollyProviderConfig>,
    /// Authored direct web accounts; never sourced from ambient/plugin credentials.
    #[serde(
        default,
        deserialize_with = "crate::web_config::deserialize_web_providers"
    )]
    pub web: crate::web_config::WebProviderConfigs,
    /// Explicit native source choice. Missing entries preserve legacy imports.
    /// A false entry also prevents environment resurrection after an authored clear.
    #[serde(
        default,
        rename = "environmentImports",
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub environment_imports: HashMap<String, bool>,
    /// Non-secret settings keyed by provider and stable credential identity.
    #[serde(default, rename = "accountPolicies")]
    pub account_policies:
        HashMap<String, HashMap<String, ryu_gw_credentials::ProviderAccountPolicy>>,
    /// New-session account selection for providers with measured quota domains.
    #[serde(
        default,
        rename = "accountStrategies",
        skip_serializing_if = "HashMap::is_empty"
    )]
    pub account_strategies: HashMap<String, ryu_gw_providers::AccountSelectionStrategy>,
    /// Per-provider fill-first drain point (used quota percent). Omitted means 80%.
    #[serde(
        default,
        rename = "accountDrainThresholds",
        skip_serializing_if = "HashMap::is_empty",
        deserialize_with = "deserialize_account_drain_thresholds"
    )]
    pub account_drain_thresholds: HashMap<String, u8>,
    pub openai: Option<OpenAiProviderConfig>,
    pub anthropic: Option<AnthropicProviderConfig>,
    pub local: Option<LocalProviderConfig>,
    /// The **classify tier**: a second OpenAI-compatible local server dedicated
    /// to the tiny always-on classifier model (llama.cpp on
    /// [`DEFAULT_CLASSIFY_PORT`], fed by `RYU_CLASSIFY_LLM_URL`).
    ///
    /// Deliberately its own slot rather than a second `local`, because `local` is
    /// aimed by Core at the resident **chat** engine: sharing one slot would make
    /// the guardrail inspector, the LLM-judge evaluators, and smart routing
    /// contend for — and be circuit-broken alongside — the user's chat model, and
    /// would pin the classifier to whatever chat engine happens to be resident.
    ///
    /// **`Some` is the normal state on a Ryu node, and `None` means "standalone
    /// gateway".** This used to read "`None` is the normal state (the sidecar is
    /// lazy…)" — an inversion worth spelling out, because three units reasoned from
    /// it. The sidecar *process* is indeed lazy, but Core publishes
    /// `RYU_CLASSIFY_LLM_URL` **unconditionally** (`gateway_spawn_env` does not gate
    /// it on the sidecar being installed or running — deliberately, so a classifier
    /// installed later needs no gateway respawn), so every Core-spawned gateway
    /// fills this slot and registers a `classify` provider at boot.
    ///
    /// The consequence to design against: a *cold* tier is `Some(slot)` +
    /// connection-refused, NOT `None`. It surfaces as a `ProviderError` from
    /// `provider.complete`, not as the absent-provider branch — see
    /// [`crate::providers::ProviderRegistry::new`] and
    /// `firewall/inspector.rs`. Both are graceful (fail open), but only the `None`
    /// branch names the provider in its warning.
    pub classify: Option<ClassifyProviderConfig>,
    pub openrouter: Option<OpenRouterProviderConfig>,
    /// LiteLLM proxy (https://docs.litellm.ai/docs/simple_proxy) — an
    /// operator-run OpenAI-compatible router. Registered as the `litellm`
    /// provider and selectable as the routing layer (`backends.router =
    /// "litellm"`). Opt-in: present only when configured or when
    /// `LITELLM_API_KEY` is set.
    #[serde(default)]
    pub litellm: Option<LiteLlmProviderConfig>,
    pub core: Option<CoreProviderConfig>,
    pub modal: Option<ModalProviderConfig>,
    pub genai: Option<GenAiProviderConfig>,
    /// Replicate (https://replicate.com) — cloud image/video generation via an
    /// async prediction API (create → poll → output URL). Opt-in: constructed
    /// only when an API key is present.
    pub replicate: Option<ReplicateProviderConfig>,
    /// Fal (https://fal.ai) — cloud image/video/audio generation via a queued
    /// request API (submit → poll status → result). Opt-in.
    pub fal: Option<FalProviderConfig>,
    pub recraft: Option<RecraftProviderConfig>,
    pub stability: Option<StabilityProviderConfig>,
    pub bfl: Option<BflProviderConfig>,
    pub minimax: Option<MiniMaxProviderConfig>,
    pub runway: Option<RunwayProviderConfig>,
    pub topaz: Option<TopazProviderConfig>,
    /// Cloudflare Workers AI — the cheap open-model supply behind the
    /// `cloudflare` credit pool (see [`crate::credit_pools`]). OpenAI-compatible
    /// dialect, so it needs no impl of its own; see the registration in
    /// [`crate::providers::ProviderRegistry::new`]. Opt-in: absent unless both
    /// `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are set, because the
    /// base URL is account-scoped and there is no sane hardcoded default.
    pub cloudflare: Option<CloudflareProviderConfig>,
    /// AWS Bedrock — the frontier supply behind the `bedrock` credit pool.
    /// Speaks the Anthropic Messages dialect (NOT OpenAI-compatible for Claude);
    /// see the registration for why. Opt-in: absent unless a bearer token and a
    /// region (or explicit base URL) are set, because the endpoint is
    /// region-scoped.
    pub bedrock: Option<BedrockProviderConfig>,
    /// Google Cloud Vertex AI — the supply behind the `vertex` credit pool,
    /// reached through Vertex's OpenAI-compatible Chat Completions surface.
    /// Opt-in: absent unless a bearer token plus a project and a location (or an
    /// explicit base URL) are set, because the endpoint embeds all three.
    pub vertex: Option<VertexProviderConfig>,
    /// The DONATED OpenAI allowance behind the `openai-credits` credit pool —
    /// deliberately a SECOND slot rather than reusing [`Self::openai`].
    ///
    /// Both speak the same dialect against the same endpoint, so the temptation
    /// to fold them together is real; the reason not to is money, not wiring. The
    /// `openai` slot carries a caller's OWN key (BYOK / pass-through) and is
    /// untagged, so its spend falls through to subscription and top-up buckets.
    /// This slot carries the donor's key, and every request served by it debits a
    /// grant. One slot would make the two indistinguishable at the debit site,
    /// and the failure is silent in the expensive direction: BYOK traffic would
    /// start burning donated credit that the user is already paying for
    /// themselves.
    pub openai_credits: Option<OpenAiProviderConfig>,
    /// Ryu's OWN first-party Anthropic account behind the `anthropic-credits`
    /// credit pool — a second slot beside [`Self::anthropic`] for the same
    /// reason `openai_credits` sits beside `openai`. The `anthropic` slot carries
    /// a caller's own key and stays untagged; this slot carries Ryu's key, so
    /// every request it serves debits a pool-restricted grant and burns down
    /// Ryu's own allowance instead of OpenRouter credit bought at retail.
    #[serde(default)]
    pub anthropic_credits: Option<AnthropicProviderConfig>,
    /// Direct OpenAI-compatible upstreams whose endpoint and credential are
    /// explicitly configured. These are distinct provider IDs for routing,
    /// quota, audit, and cache isolation; no third-party router is involved.
    #[serde(default)]
    pub compatible: HashMap<String, CompatibleProviderConfig>,
    /// Vercel AI Gateway, the Ryu-held aggregator lane (managed guardrails
    /// spec 08). Registered only when `resale_permission` records written
    /// approval (`approved:<reference>`); see
    /// [`ryu_gw_providers::vercel`]. Absent by default, and no environment
    /// variable creates it.
    #[serde(default)]
    pub vercel: Option<VercelProviderConfig>,
    pub cohere: Option<CohereProviderConfig>,
    pub deepgram: Option<DeepgramProviderConfig>,
    pub assemblyai: Option<AssemblyAiProviderConfig>,
    pub elevenlabs: Option<ElevenLabsProviderConfig>,
    pub inworld: Option<InworldProviderConfig>,
}

impl ProvidersConfig {
    pub fn account_keys(&self, provider: &str) -> Vec<String> {
        match provider {
            "openai" => self
                .openai
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "anthropic" => self
                .anthropic
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "openrouter" => self
                .openrouter
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "modal" => self
                .modal
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "cohere" => self
                .cohere
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "deepgram" => self
                .deepgram
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "assemblyai" => self
                .assemblyai
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "elevenlabs" => self
                .elevenlabs
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "inworld" => self
                .inworld
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "replicate" => self
                .replicate
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "bfl" => self.bfl.as_ref().map(|c| c.all_keys()).unwrap_or_default(),
            "runway" => self
                .runway
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "topaz" => self
                .topaz
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "minimax" => self
                .minimax
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "stability" => self
                .stability
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "recraft" => self
                .recraft
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "fal" => self.fal.as_ref().map(|c| c.all_keys()).unwrap_or_default(),
            "litellm" => self
                .litellm
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "cloudflare" => self
                .cloudflare
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "bedrock" => self
                .bedrock
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "vertex" => self
                .vertex
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "openai-credits" => self
                .openai_credits
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "anthropic-credits" => self
                .anthropic_credits
                .as_ref()
                .map(|c| c.all_keys())
                .unwrap_or_default(),
            "gemini" => self
                .genai
                .as_ref()
                .and_then(|c| c.accounts.get("gemini"))
                .map(GenAiAccountConfig::all_keys)
                .unwrap_or_default(),
            id if ryu_gw_credentials::sdk_provider_by_id(id).is_some() => self
                .genai
                .as_ref()
                .and_then(|config| {
                    ryu_gw_credentials::sdk_provider_by_id(id)
                        .and_then(|descriptor| config.accounts.get(descriptor.kind))
                })
                .map(GenAiAccountConfig::all_keys)
                .unwrap_or_default(),
            id => self
                .compatible
                .get(id)
                .map(|c| c.all_keys())
                .unwrap_or_default(),
        }
    }

    pub fn policies_for(&self, provider: &str) -> Vec<ryu_gw_credentials::ProviderAccountPolicy> {
        self.account_keys(provider)
            .iter()
            .map(|key| {
                self.account_policies
                    .get(provider)
                    .and_then(|settings| {
                        settings.get(&ryu_gw_credentials::provider_account_id(provider, key))
                    })
                    .cloned()
                    .unwrap_or_default()
            })
            .collect()
    }
}
