//! Egress proxying and the TTS provider credential shapes.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct EgressConfig {
    /// Pool name to proxy endpoints. Pool names are local operator config.
    #[serde(default)]
    pub pools: HashMap<String, EgressProxyPoolConfig>,
    /// Provider registry ID to pool name. Only assigned providers use a pool;
    /// other providers retain their current direct/ambient-proxy behavior.
    #[serde(default)]
    pub assignments: HashMap<String, String>,
}

impl EgressConfig {
    pub(super) fn is_empty(&self) -> bool {
        self.pools.is_empty() && self.assignments.is_empty()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EgressProxyPoolConfig {
    /// An explicit direct client participating in rotation, with environment
    /// proxies disabled. Opt-in: otherwise the pool uses proxy endpoints only.
    #[serde(default)]
    pub include_direct: bool,
    #[serde(default)]
    pub direct_fallback_only: bool,
    pub endpoints: Vec<EgressProxyEndpointConfig>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct EgressProxyEndpointConfig {
    pub id: String,
    pub url: String,
    #[serde(default = "default_egress_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: u16,
    /// Environment variables containing proxy Basic credentials. Both names
    /// must be present together. Values never enter serialized Gateway config.
    pub username_env: Option<String>,
    pub password_env: Option<String>,
}

pub(super) fn default_egress_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct EdgeTtsConfig {
    #[serde(default)]
    pub anonymous_consumer_opt_in: bool,
}

/// Anonymous consumer Google Translate speech is a separate explicit opt-in.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(deny_unknown_fields)]
pub struct GoogleTranslateTtsConfig {
    #[serde(default)]
    pub anonymous_consumer_opt_in: bool,
}

/// Explicit, currently valid Google Cloud TTS bearer tokens and quota projects.
/// A supplied token is never presented as an OAuth login or refresh source.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoogleTtsProviderConfig {
    pub accounts: Vec<GoogleTtsAccountConfig>,
}

impl std::fmt::Debug for GoogleTtsProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleTtsProviderConfig")
            .field("account_count", &self.accounts.len())
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct GoogleTtsAccountConfig {
    pub access_token: String,
    pub quota_project: String,
    #[serde(default)]
    pub expires_at_unix_secs: Option<u64>,
}

impl std::fmt::Debug for GoogleTtsAccountConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleTtsAccountConfig")
            .field("access_token", &"[REDACTED]")
            .field("quota_project", &self.quota_project)
            .field("expires_at_unix_secs", &self.expires_at_unix_secs)
            .finish()
    }
}

/// Explicit AWS credentials for native Polly synthesis, sharing one region.
/// Ambient AWS credential chains are deliberately excluded.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PollyProviderConfig {
    pub region: String,
    pub accounts: Vec<PollyAccountConfig>,
}

impl std::fmt::Debug for PollyProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PollyProviderConfig")
            .field("region", &self.region)
            .field("account_count", &self.accounts.len())
            .finish()
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PollyAccountConfig {
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
    #[serde(default)]
    pub expires_at_unix_secs: Option<u64>,
}

impl std::fmt::Debug for PollyAccountConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PollyAccountConfig")
            .field("access_key_id", &"[REDACTED]")
            .field("secret_access_key", &"[REDACTED]")
            .field("session_token", &"[REDACTED]")
            .field("expires_at_unix_secs", &self.expires_at_unix_secs)
            .finish()
    }
}

pub(super) fn deserialize_account_drain_thresholds<'de, D>(
    deserializer: D,
) -> Result<HashMap<String, u8>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let thresholds = HashMap::<String, u8>::deserialize(deserializer)?;
    for (provider, percent) in &thresholds {
        if !ryu_gw_credentials::supports_chat_account_routing(provider) {
            return Err(D::Error::custom(format!(
                "account drain threshold is not supported for {provider}"
            )));
        }
        if !(1..=100).contains(percent) {
            return Err(D::Error::custom(format!(
                "account drain threshold for {provider} must be 1–100"
            )));
        }
    }
    Ok(thresholds)
}
