//! Rate limits, gateway auth and API-key config.

use super::*;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RateLimitConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,

    /// Token-based limit per minute per API key (approximate). Omitted from a
    /// partial `[rate_limit]` section ⇒ the `Default` value, NOT unlimited.
    #[serde(default = "default_tokens_per_minute")]
    pub tokens_per_minute: Option<u64>,

    /// Request count limit per minute per API key. Same partial-section
    /// semantics as `tokens_per_minute`.
    #[serde(default = "default_requests_per_minute")]
    pub requests_per_minute: Option<u64>,

    /// Maximum requests per second per key before bot-detection triggers (0 = disabled).
    #[serde(default = "default_burst_rps")]
    pub max_burst_per_second: u32,
}

pub(super) fn default_burst_rps() -> u32 {
    10
}

pub(super) fn default_tokens_per_minute() -> Option<u64> {
    Some(100_000)
}

pub(super) fn default_requests_per_minute() -> Option<u64> {
    Some(500)
}

impl Default for RateLimitConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            tokens_per_minute: default_tokens_per_minute(),
            requests_per_minute: default_requests_per_minute(),
            max_burst_per_second: default_burst_rps(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AuthConfig {
    /// Authentication is required unless explicitly disabled for local development.
    #[serde(default = "default_true")]
    pub require_auth: bool,

    /// Statically configured API keys
    #[serde(default)]
    pub api_keys: Vec<ApiKeyConfig>,

    /// A single master key that bypasses all per-key limits
    pub master_key: Option<String>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            require_auth: true,
            api_keys: Vec::new(),
            master_key: None,
        }
    }
}

impl AuthConfig {
    pub(super) fn add_relay(
        &mut self,
        key: String,
        name: &str,
        trusted_forwarder: bool,
    ) -> anyhow::Result<()> {
        ryu_gw_credentials::validate(&key)?;
        anyhow::ensure!(
            self.master_key.as_deref() != Some(&key),
            "Gateway relay and admin keys must differ"
        );
        if let Some(existing) = self.api_keys.iter().find(|entry| entry.key == key) {
            anyhow::ensure!(
                existing.trusted_forwarder == trusted_forwarder,
                "Gateway relay credential has conflicting authority"
            );
            return Ok(());
        }
        self.api_keys.push(ApiKeyConfig {
            key,
            allowed_operations: default_api_key_operations(),
            name: name.to_owned(),
            org_id: None,
            team_id: None,
            channel_id: None,
            project_id: None,
            requests_per_minute: None,
            tokens_per_minute: None,
            token_budget_total: None,
            downgrade_to: None,
            trusted_forwarder,
        });
        Ok(())
    }

    /// Bootstrap only at service startup, never during config serialization.
    /// Existing explicit credentials are validated rather than silently replaced.
    /// Create or load the generated admin (`gateway-admin.key`) and inference
    /// (`gateway-relay.key`) keys beside `gateway.toml`, sealed with the
    /// Gateway's sealing key when this process holds one.
    pub fn bootstrap(&mut self, directory: &std::path::Path) -> anyhow::Result<()> {
        let sealer = ryu_gw_credentials::sealed_config::config_sealer().ok();
        self.bootstrap_with(directory, sealer.as_deref())
    }

    /// [`Self::bootstrap`] with an explicit sealer. `None` (a standalone Gateway
    /// started with no `RYU_MASTER_KEY` and no delivered key) keeps the
    /// pre-sealing behavior: an owner-only plaintext file, with a warning, and a
    /// sealed file it cannot open is an error rather than a new key.
    pub fn bootstrap_with(
        &mut self,
        directory: &std::path::Path,
        sealer: Option<&dyn ryu_crypto::SecretSealer>,
    ) -> anyhow::Result<()> {
        if let Some(key) = &self.master_key {
            ryu_gw_credentials::validate(key)?;
        }
        for entry in &self.api_keys {
            ryu_gw_credentials::validate(&entry.key)?;
        }
        if !self.require_auth {
            return Ok(());
        }
        if self.master_key.is_none() {
            self.master_key = Some(load_generated_credential(
                &directory.join(ADMIN_KEY_FILE),
                "gwadm_",
                sealer,
            )?);
        }
        let relay_file = directory.join(RELAY_KEY_FILE);
        if self.api_keys.is_empty() || relay_file.exists() {
            let relay = load_generated_credential(&relay_file, "gwrelay_", sealer)?;
            self.add_relay(relay, "local-inference", false)?;
        }
        anyhow::ensure!(
            self.api_keys
                .iter()
                .all(|entry| Some(&entry.key) != self.master_key.as_ref()),
            "Gateway relay and admin keys must differ"
        );
        Ok(())
    }
}

/// File name of the generated administrator key beside `gateway.toml`.
pub const ADMIN_KEY_FILE: &str = "gateway-admin.key";
/// File name of the generated inference key beside `gateway.toml`.
pub const RELAY_KEY_FILE: &str = "gateway-relay.key";

/// Load or mint one generated Gateway key file. Sealed (`encc:v1:`) when a
/// sealer is available; a legacy plaintext file is resealed in place.
pub(super) fn load_generated_credential(
    path: &std::path::Path,
    prefix: &str,
    sealer: Option<&dyn ryu_crypto::SecretSealer>,
) -> anyhow::Result<String> {
    match sealer {
        Some(sealer) => ryu_gw_credentials::load_or_create_sealed(path, prefix, sealer),
        None => {
            tracing::warn!(
                path = %path.display(),
                "no Gateway sealing key: this generated key file stays plaintext (owner-only). \
                 Start the Gateway with RYU_MASTER_KEY (or the RYU_SEAL_KEY/RYU_SEAL_SCOPE \
                 printed by `ryu-core gateway-seal-env`) to seal it"
            );
            ryu_gw_credentials::load_or_create(path, prefix)
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ApiKeyConfig {
    pub key: String,
    pub name: String,
    #[serde(default = "default_api_key_operations")]
    pub allowed_operations: Vec<ApiKeyOperation>,
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub team_id: Option<String>,
    /// Internal control-plane id used only to namespace Core channel sessions.
    /// It is never written to gateway.toml; env-backed configs leave it empty.
    #[serde(skip)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Override the global requests_per_minute limit for this key.
    #[serde(default)]
    pub requests_per_minute: Option<u64>,
    /// Override the global tokens_per_minute limit for this key.
    #[serde(default)]
    pub tokens_per_minute: Option<u64>,
    /// Lifetime token cap for this key (input + output combined). 0 = unlimited.
    #[serde(default)]
    pub token_budget_total: Option<u64>,
    /// Model to downgrade to when token_budget_total is exceeded.
    /// If unset, the request is rejected with BudgetExceeded.
    #[serde(default)]
    pub downgrade_to: Option<String>,
    /// When true, this key is a trusted intermediary (e.g. Ryu Core relaying a
    /// real end-user identity) and the client-supplied `x-ryu-user-id` /
    /// `x-ryu-agent-id` headers are honored for per-user/per-agent budgets.
    /// When false (the default), those headers are ignored and budgets are
    /// keyed to this API key, so an untrusted caller cannot spoof or rotate
    /// identity headers to evade its quota.
    #[serde(default)]
    pub trusted_forwarder: bool,
}

/// Static `api_keys` are data-plane relay credentials. Administrative
/// authority is represented only by `AuthConfig::master_key`, never by a relay
/// token or by `trusted_forwarder`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeyPurpose {
    InferenceRelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApiKeyOperation {
    Inference,
    WebSearch,
    WebFetch,
}

pub(super) fn default_api_key_operations() -> Vec<ApiKeyOperation> {
    vec![ApiKeyOperation::Inference]
}

impl ApiKeyConfig {
    pub fn is_system_relay(&self) -> bool {
        matches!(self.name.as_str(), "local-core" | "local-inference")
    }

    pub const fn purpose(&self) -> ApiKeyPurpose {
        ApiKeyPurpose::InferenceRelay
    }

    pub fn allows_operation(&self, operation: ApiKeyOperation) -> bool {
        self.allowed_operations.contains(&operation)
            && (!self.is_system_relay() || operation == ApiKeyOperation::Inference)
    }

    pub fn validate_operations(&self) -> Result<(), &'static str> {
        if self.allowed_operations.is_empty() || self.allowed_operations.len() > 3 {
            return Err("API key needs one to three explicit operations");
        }
        let mut seen = std::collections::HashSet::new();
        if self
            .allowed_operations
            .iter()
            .any(|operation| !seen.insert(*operation))
        {
            return Err("API key operations must be unique");
        }
        if self.is_system_relay() && self.allowed_operations != [ApiKeyOperation::Inference] {
            return Err("system relays remain inference-only");
        }
        Ok(())
    }
}
