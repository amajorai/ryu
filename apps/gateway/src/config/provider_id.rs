//! Provider kinds and the open `ProviderId` newtype.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    #[default]
    OpenAi,
    Anthropic,
    Local,
    OpenRouter,
    Core,
    Modal,
    GenAi,
    Replicate,
    Fal,
}

impl ProviderKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProviderKind::OpenAi => "openai",
            ProviderKind::Anthropic => "anthropic",
            ProviderKind::Local => "local",
            ProviderKind::OpenRouter => "openrouter",
            ProviderKind::Core => "core",
            ProviderKind::Modal => "modal",
            ProviderKind::GenAi => "genai",
            ProviderKind::Replicate => "replicate",
            ProviderKind::Fal => "fal",
        }
    }
}

impl std::str::FromStr for ProviderKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "openai" => Ok(ProviderKind::OpenAi),
            "anthropic" => Ok(ProviderKind::Anthropic),
            "local" => Ok(ProviderKind::Local),
            "openrouter" => Ok(ProviderKind::OpenRouter),
            "core" => Ok(ProviderKind::Core),
            "modal" => Ok(ProviderKind::Modal),
            "genai" => Ok(ProviderKind::GenAi),
            "replicate" => Ok(ProviderKind::Replicate),
            "fal" => Ok(ProviderKind::Fal),
            other => Err(format!("unknown provider kind: {other}")),
        }
    }
}

/// A provider registry id — an arbitrary, open string naming which backend a
/// route resolves to (e.g. `"openai"`, `"anthropic"`, or a novel plugin id like
/// `"acme"`). This is the routing-layer analogue of the string-keyed
/// [`crate::providers::ProviderRegistry`]: routing is no longer pinned to the
/// closed [`ProviderKind`] enum, so a provider registered under a brand-new id
/// is routable purely via config (`default_provider`, `fallback_chain`,
/// `model_map`, `provider_tiers`, modality/eval maps) with no code change. An id
/// with no registered provider simply misses the registry at dispatch and falls
/// through the existing provider-unavailable path (fail-safe).
///
/// `#[serde(transparent)]` makes it (de)serialize as a bare string, so it works
/// as a JSON/TOML map key (`provider_tiers`) and every existing config naming one
/// of the nine legacy providers deserializes byte-identically. `ProviderKind` is
/// retained only as an ergonomic legacy alias that lowers to a `ProviderId` via
/// `From` / cross-type `PartialEq`.
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct ProviderId(pub String);

impl ProviderId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ProviderId {
    /// Mirrors the former `ProviderKind::default() == OpenAi` so zero-config
    /// routing keeps `default_provider = "openai"` (the only Default consumer).
    fn default() -> Self {
        ProviderId("openai".to_string())
    }
}

impl std::fmt::Display for ProviderId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<String> for ProviderId {
    fn from(s: String) -> Self {
        ProviderId(s)
    }
}

impl From<&str> for ProviderId {
    fn from(s: &str) -> Self {
        ProviderId(s.to_string())
    }
}

impl From<ProviderKind> for ProviderId {
    fn from(k: ProviderKind) -> Self {
        ProviderId(k.as_str().to_string())
    }
}

// Cross-type equality keeps `ProviderKind` an ergonomic legacy alias: call sites
// and tests can still write `decision.provider == ProviderKind::Anthropic`, and
// via std's blanket `Vec<A>: PartialEq<Vec<B>>` whole-chain assertions compile
// unchanged.
impl PartialEq<ProviderKind> for ProviderId {
    fn eq(&self, other: &ProviderKind) -> bool {
        self.0 == other.as_str()
    }
}

impl PartialEq<ProviderId> for ProviderKind {
    fn eq(&self, other: &ProviderId) -> bool {
        self.as_str() == other.0
    }
}
