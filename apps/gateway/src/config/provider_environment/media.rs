//! Media and speech provider slots (image, video, TTS, STT) filled from the
//! captured provider environment.
use super::*;

impl ProviderEnvironment {
    pub(super) fn apply_media_providers(&self, config: &mut GatewayConfig) {
        if let Some(key) = self
            .var("BFL_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            config.providers.bfl = Some(BflProviderConfig {
                api_key: key,
                api_keys: self.keys("BFL_API_KEYS"),
                base_url: self
                    .var("BFL_BASE_URL")
                    .ok()
                    .filter(|url| !url.trim().is_empty())
                    .unwrap_or_else(bfl_base_url),
                poll_interval_ms: default_bfl_poll_interval(),
                poll_timeout_secs: default_bfl_poll_timeout(),
            });
        }
        if let Some(key) = self
            .var("STABILITY_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            config.providers.stability = Some(StabilityProviderConfig {
                api_key: key,
                api_keys: self.keys("STABILITY_API_KEYS"),
                base_url: self
                    .var("STABILITY_BASE_URL")
                    .ok()
                    .filter(|url| !url.trim().is_empty())
                    .unwrap_or_else(stability_base_url),
            });
        }
        if let Some(key) = self
            .var("RUNWAY_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            config.providers.runway = Some(RunwayProviderConfig {
                api_key: key,
                api_keys: self.keys("RUNWAY_API_KEYS"),
                base_url: self
                    .var("RUNWAY_BASE_URL")
                    .ok()
                    .filter(|url| !url.trim().is_empty())
                    .unwrap_or_else(runway_base_url),
            });
        }
        if let Some(key) = self
            .var("TOPAZ_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            config.providers.topaz = Some(TopazProviderConfig {
                api_key: key,
                api_keys: self.keys("TOPAZ_API_KEYS"),
                base_url: topaz_base_url(),
            });
        }
        if let Some(key) = self
            .var("MINIMAX_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            config.providers.minimax = Some(MiniMaxProviderConfig {
                api_key: key,
                api_keys: self.keys("MINIMAX_API_KEYS"),
                base_url: self
                    .var("MINIMAX_BASE_URL")
                    .ok()
                    .filter(|url| !url.trim().is_empty())
                    .unwrap_or_else(minimax_base_url),
            });
        }
        if let Some(key) = self
            .var("RECRAFT_API_KEY")
            .ok()
            .filter(|key| !key.trim().is_empty())
        {
            config.providers.recraft = Some(RecraftProviderConfig {
                api_key: key,
                api_keys: self.keys("RECRAFT_API_KEYS"),
                base_url: self
                    .var("RECRAFT_BASE_URL")
                    .ok()
                    .filter(|url| !url.trim().is_empty())
                    .unwrap_or_else(recraft_base_url),
            });
        }
        if let Some(key) = self
            .var("COHERE_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            config.providers.cohere = Some(CohereProviderConfig {
                api_key: key,
                api_keys: self.keys("COHERE_API_KEYS"),
                base_url: self
                    .var("COHERE_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(cohere_base_url),
            });
        }
        if let Some(key) = self
            .var("DEEPGRAM_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            config.providers.deepgram = Some(DeepgramProviderConfig {
                api_key: key,
                api_keys: self.keys("DEEPGRAM_API_KEYS"),
                base_url: self
                    .var("DEEPGRAM_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(deepgram_base_url),
            });
        }
        if let Some(key) = self
            .var("ASSEMBLYAI_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            config.providers.assemblyai = Some(AssemblyAiProviderConfig {
                api_key: key,
                api_keys: self.keys("ASSEMBLYAI_API_KEYS"),
                base_url: self
                    .var("ASSEMBLYAI_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(assemblyai_base_url),
                poll_interval_ms: default_assemblyai_poll_interval_ms(),
                poll_timeout_secs: default_assemblyai_poll_timeout_secs(),
            });
        }
        if let Some(key) = self
            .var("ELEVENLABS_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            config.providers.elevenlabs = Some(ElevenLabsProviderConfig {
                api_key: key,
                api_keys: self.keys("ELEVENLABS_API_KEYS"),
                base_url: self
                    .var("ELEVENLABS_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(elevenlabs_base_url),
            });
        }

        if let Some(key) = self
            .var("INWORLD_API_KEY")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            config.providers.inworld = Some(InworldProviderConfig {
                api_key: key,
                api_keys: self.keys("INWORLD_API_KEYS"),
                base_url: self
                    .var("INWORLD_BASE_URL")
                    .ok()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(inworld_base_url),
            });
        }
    }
}
