//! Startup loading for the hosted fleet provider-key vault.
//!
//! Provider credentials are control-plane data, not gateway deployment
//! configuration. The gateway fetches the sealed values' plaintext over the
//! private internal route once at boot, applies them only in memory, and never
//! writes them to gateway.toml, logs, or child-process environment.

use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use anyhow::{bail, Context};
use serde::Deserialize;

use crate::config::GatewayConfig;

const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";
const ENV_VAULT_SECRET: &str = "RYU_VAULT_INTERNAL_SECRET";
const ENV_REQUIRED: &str = "RYU_PROVIDER_VAULT_REQUIRED";

pub fn required_from_env() -> bool {
    env_bool(ENV_REQUIRED)
}

#[derive(Deserialize)]
struct VaultResponse {
    #[serde(default)]
    keys: HashMap<String, String>,
}

/// Successful startup custody, retained only in memory for live rebuilds.
#[derive(Clone)]
pub(crate) struct VaultSourceSnapshot {
    keys: HashMap<String, String>,
    required: bool,
    identity: [u8; 32],
    applied_scopes: Vec<String>,
}

impl fmt::Debug for VaultSourceSnapshot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("VaultSourceSnapshot")
            .field("key_count", &self.keys.len())
            .field("required", &self.required)
            .finish_non_exhaustive()
    }
}

impl VaultSourceSnapshot {
    fn new(keys: HashMap<String, String>, required: bool, applied_scopes: Vec<String>) -> Self {
        let mut hash = Sha256::new();
        hash.update([u8::from(required)]);
        let ordered: std::collections::BTreeMap<_, _> = keys.iter().collect();
        for (name, value) in ordered {
            hash.update(name.len().to_be_bytes());
            hash.update(name.as_bytes());
            hash.update(value.len().to_be_bytes());
            hash.update(value.as_bytes());
        }
        Self {
            keys,
            required,
            identity: hash.finalize().into(),
            applied_scopes,
        }
    }

    pub(crate) fn identity(&self) -> [u8; 32] {
        self.identity
    }
    pub(crate) fn applied_scopes(&self) -> &[String] {
        &self.applied_scopes
    }

    pub(crate) fn apply(
        &self,
        config: &mut GatewayConfig,
        environment: &crate::config::ProviderEnvironment,
    ) -> anyhow::Result<Vec<String>> {
        let applied = if self.required {
            config.replace_provider_vault_keys_with_environment(&self.keys, environment)
        } else {
            config.apply_provider_vault_keys_with_environment(&self.keys, environment)
        };
        if self.required && (applied.is_empty() || applied.len() < self.keys.len()) {
            bail!("Captured required provider vault cannot activate its configured entries");
        }
        Ok(applied)
    }
}

/// Fetch and apply the fleet provider vault when configured.
///
/// Local standalone gateways remain unchanged when neither vault variable is
/// set. A managed fleet sets RYU_PROVIDER_VAULT_REQUIRED=1; in that mode a
/// missing secret, failed fetch, empty vault, or malformed control-plane URL is
/// a startup error rather than a fallback to raw provider env.
pub async fn apply_from_env(
    config: &mut GatewayConfig,
    http: &reqwest::Client,
) -> anyhow::Result<Vec<String>> {
    let required = required_from_env();
    let secret = std::env::var(ENV_VAULT_SECRET)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let control_plane_url = std::env::var(ENV_CONTROL_PLANE_URL)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    if secret.is_none() && control_plane_url.is_none() {
        if required {
            bail!(
                "provider vault is required but CONTROL_PLANE_URL and RYU_VAULT_INTERNAL_SECRET are not configured"
            );
        }
        return Ok(Vec::new());
    }

    let secret = secret.ok_or_else(|| {
        anyhow::anyhow!(
            "provider vault is partially configured: RYU_VAULT_INTERNAL_SECRET is missing"
        )
    })?;
    let control_plane_url = control_plane_url.ok_or_else(|| {
        anyhow::anyhow!("provider vault is partially configured: CONTROL_PLANE_URL is missing")
    })?;
    let endpoint = vault_endpoint(&control_plane_url)?;

    let response = http
        .get(endpoint)
        .header("x-ryu-internal-secret", secret)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .context("provider vault request failed")?;
    if !response.status().is_success() {
        bail!("provider vault returned HTTP {}", response.status());
    }

    let payload: VaultResponse = response
        .json()
        .await
        .context("provider vault returned invalid JSON")?;
    let keys: HashMap<String, String> = payload
        .keys
        .into_iter()
        .filter(|(_, value)| !value.trim().is_empty())
        .collect();
    if keys.is_empty() {
        if required {
            bail!("provider vault is reachable but contains no provider keys");
        }
        tracing::warn!("provider vault is reachable but contains no provider keys");
        return Ok(Vec::new());
    }

    // Required fleet mode replaces the supported provider credentials instead
    // of merely overlaying present entries. Otherwise a key omitted from the
    // vault could silently survive from gateway.toml or the process env.
    let applied = if required {
        config.replace_provider_vault_keys(&keys)
    } else {
        config.apply_provider_vault_keys(&keys)
    };
    if applied.is_empty() && required {
        bail!("provider vault returned no supported provider keys");
    }
    if applied.len() < keys.len() {
        if required {
            bail!(
                "provider vault returned unsupported or incomplete provider keys (fetched {}, applied {})",
                keys.len(),
                applied.len()
            );
        }
        tracing::warn!(
            fetched = keys.len(),
            applied = applied.len(),
            "provider vault returned keys that this gateway does not use"
        );
    }
    config.provider_vault_source = Some(Arc::new(VaultSourceSnapshot::new(
        keys,
        required,
        applied.clone(),
    )));
    Ok(applied)
}

fn env_bool(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|value| match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(false)
}

/// Build the fixed vault route from the operator-supplied control-plane origin.
///
/// CONTROL_PLANE_URL historically means an origin without /api; accepting an
/// existing /api suffix makes the vault safe with the gateway TOML-style base
/// URL too. Remote HTTP is rejected so the internal secret cannot cross an
/// unencrypted link; loopback HTTP remains useful for local development.
fn vault_endpoint(base: &str) -> anyhow::Result<reqwest::Url> {
    control_plane_endpoint(base, "key-vault/keys")
}

/// A fixed internal control-plane route (`/api/<api_path>`) under the
/// operator-supplied origin, with the same scheme/userinfo/HTTPS rules as the
/// vault: every such route carries the fleet internal secret.
pub(crate) fn control_plane_endpoint(base: &str, api_path: &str) -> anyhow::Result<reqwest::Url> {
    let mut url = reqwest::Url::parse(base).context("CONTROL_PLANE_URL is not a valid URL")?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("CONTROL_PLANE_URL must use http or https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("CONTROL_PLANE_URL must not contain userinfo");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("CONTROL_PLANE_URL must not contain a query or fragment");
    }
    if url.scheme() == "http" {
        let host = url.host_str().unwrap_or_default();
        if !matches!(host, "127.0.0.1" | "localhost" | "::1") {
            bail!("the fleet control plane requires HTTPS for a non-loopback host");
        }
    }

    let path = url.path().trim_end_matches('/');
    let endpoint_path = if path == "/api" || path.ends_with("/api") {
        format!("{path}/{api_path}")
    } else if path.is_empty() {
        format!("/api/{api_path}")
    } else {
        format!("{path}/api/{api_path}")
    };
    url.set_path(&endpoint_path);
    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use crate::config::{
        ComposioConfig, FalProviderConfig, GatewayConfig, ModalProviderConfig,
        OpenRouterProviderConfig, ReplicateProviderConfig,
    };

    use super::vault_endpoint;

    #[test]
    fn appends_api_path_to_an_origin() {
        assert_eq!(
            vault_endpoint("https://control.example").unwrap().as_str(),
            "https://control.example/api/key-vault/keys"
        );
    }

    #[test]
    fn accepts_the_existing_api_suffix() {
        assert_eq!(
            vault_endpoint("https://control.example/api/")
                .unwrap()
                .as_str(),
            "https://control.example/api/key-vault/keys"
        );
    }

    #[test]
    fn permits_loopback_http_for_local_development() {
        assert!(vault_endpoint("http://127.0.0.1:3000").is_ok());
        assert!(vault_endpoint("http://control.example").is_err());
    }

    #[test]
    fn rejects_control_plane_userinfo() {
        assert!(vault_endpoint("https://user:pass@control.example").is_err());
    }

    #[test]
    fn required_fleet_vault_replaces_raw_supported_provider_credentials() {
        let mut config = GatewayConfig::default();
        config.providers.openrouter = Some(OpenRouterProviderConfig {
            api_key: "raw-openrouter".to_owned(),
            api_keys: vec!["raw-extra".to_owned()],
            base_url: "https://openrouter.example/v1".to_owned(),
            site_url: String::new(),
            site_name: String::new(),
            data_collection: "deny".to_owned(),
            zdr: false,
            sort: String::new(),
            response_healing: false,
            usage_accounting: true,
            org_api_keys: HashMap::from([(String::from("org"), String::from("raw-org"))]),
        });
        config.providers.replicate = Some(ReplicateProviderConfig {
            api_keys: Vec::new(),
            api_key: "raw-replicate".to_owned(),
            base_url: "https://replicate.example/v1".to_owned(),
            poll_interval_ms: 1,
            poll_timeout_secs: 1,
        });
        config.composio = ComposioConfig {
            enabled: true,
            api_key: Some("raw-composio".to_owned()),
            ..ComposioConfig::default()
        };
        config.treg.token = Some("raw-treg".to_owned());
        config.treg.enabled = true;

        let applied = config.replace_provider_vault_keys(&HashMap::from([
            (String::from("openrouter"), String::from("vault-openrouter")),
            (String::from("composio"), String::from("vault-composio")),
            (String::from("treg"), String::from("vault-treg")),
        ]));

        assert_eq!(applied, vec!["openrouter", "composio", "treg"]);
        assert_eq!(
            config
                .providers
                .openrouter
                .as_ref()
                .map(|provider| provider.api_key.as_str()),
            Some("vault-openrouter")
        );
        assert!(config.providers.replicate.is_none());
        assert_eq!(config.composio.api_key.as_deref(), Some("vault-composio"));
        assert_eq!(config.treg.token.as_deref(), Some("vault-treg"));
        assert!(config.treg.enabled);
    }

    fn raw_media_providers(config: &mut GatewayConfig) {
        config.providers.fal = Some(FalProviderConfig {
            api_key: "raw-fal".to_owned(),
            api_keys: vec!["raw-fal-2".to_owned(), "raw-fal-3".to_owned()],
            base_url: "https://fal.example".to_owned(),
            poll_interval_ms: 1,
            poll_timeout_secs: 1,
        });
        config.providers.replicate = Some(ReplicateProviderConfig {
            api_key: "raw-replicate".to_owned(),
            api_keys: vec!["raw-replicate-2".to_owned()],
            base_url: "https://replicate.example/v1".to_owned(),
            poll_interval_ms: 1,
            poll_timeout_secs: 1,
        });
        config.providers.modal = Some(ModalProviderConfig {
            api_key: "raw-modal".to_owned(),
            api_keys: vec!["raw-modal-2".to_owned()],
            base_url: "https://modal.example/v1".to_owned(),
        });
    }

    fn vault_media_keys() -> HashMap<String, String> {
        HashMap::from([
            (String::from("fal"), String::from("vault-fal")),
            (String::from("replicate"), String::from("vault-replicate")),
            (String::from("modal"), String::from("vault-modal")),
        ])
    }

    fn assert_only_vault_media_keys(config: &GatewayConfig) {
        let providers = &config.providers;
        assert_eq!(providers.fal.as_ref().unwrap().all_keys(), ["vault-fal"]);
        assert_eq!(
            providers.replicate.as_ref().unwrap().all_keys(),
            ["vault-replicate"]
        );
        assert_eq!(
            providers.modal.as_ref().unwrap().all_keys(),
            ["vault-modal"]
        );
    }

    fn vercel_lane(key: &str, permission: Option<&str>) -> crate::config::VercelProviderConfig {
        serde_json::from_value(serde_json::json!({
            "api_key": key,
            "resale_permission": permission,
        }))
        .expect("vercel lane config parses")
    }

    #[test]
    fn a_vault_vercel_key_never_creates_the_lane_without_an_authored_entry() {
        let vault = HashMap::from([(String::from("vercel"), String::from("vault-vercel"))]);
        let mut config = GatewayConfig::default();
        let applied = config.replace_provider_vault_keys(&vault);
        assert!(!applied.iter().any(|provider| provider == "vercel"));
        assert!(config.providers.vercel.is_none());

        // An authored lane keeps its recorded decision and takes the vault key.
        config.providers.vercel = Some(vercel_lane(
            "raw-vercel",
            Some("approved:VERCEL-RESALE-FIXTURE-1"),
        ));
        let applied = config.replace_provider_vault_keys(&vault);
        assert!(applied.iter().any(|provider| provider == "vercel"));
        let lane = config.providers.vercel.as_ref().expect("lane kept");
        assert_eq!(lane.all_keys(), vec!["vault-vercel".to_owned()]);
        assert_eq!(
            lane.resale_permission.as_deref(),
            Some("approved:VERCEL-RESALE-FIXTURE-1")
        );
    }

    #[test]
    fn required_fleet_vault_drops_raw_extra_keys_from_media_rotation() {
        let mut config = GatewayConfig::default();
        raw_media_providers(&mut config);
        config.replace_provider_vault_keys(&vault_media_keys());
        assert_only_vault_media_keys(&config);
    }

    #[test]
    fn vault_overlay_clears_multi_account_media_material() {
        let mut config = GatewayConfig::default();
        raw_media_providers(&mut config);
        config.apply_provider_vault_keys(&vault_media_keys());
        assert_only_vault_media_keys(&config);
    }

    #[test]
    fn a_required_vault_without_a_vercel_key_drops_a_raw_lane_key() {
        let mut config = GatewayConfig::default();
        config.providers.vercel = Some(vercel_lane(
            "raw-vercel",
            Some("approved:VERCEL-RESALE-FIXTURE-1"),
        ));
        config.replace_provider_vault_keys(&HashMap::new());
        assert!(config.providers.vercel.is_none());
    }
}
