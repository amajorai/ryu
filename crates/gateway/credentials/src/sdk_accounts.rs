//! SDK account normalization. Ambient credentials are imported only explicitly.
use std::collections::BTreeMap;

use crate::{sdk_provider_by_kind, SdkAuthKind, SdkContextKind, SdkEndpointConfig};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Default)]
pub struct GenAiProviderConfig {
    pub accounts: BTreeMap<String, GenAiAccountConfig>,
    #[serde(skip)]
    fleet_accounts: std::collections::BTreeSet<String>,
}

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct GenAiAccountConfig {
    pub api_key: String,
    pub api_keys: Vec<String>,
    pub allow_env: bool,
    pub context: SdkEndpointConfig,
}

impl std::fmt::Debug for GenAiAccountConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GenAiAccountConfig")
            .field("credential_count", &self.all_keys().len())
            .field("allow_env", &self.allow_env)
            .field("context_kind", &self.context.kind())
            .finish()
    }
}

impl std::fmt::Debug for GenAiProviderConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GenAiProviderConfig")
            .field("accounts", &self.accounts)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SdkKeySource {
    Stored,
    Environment,
    Fleet,
}

#[derive(Clone)]
pub struct ResolvedSdkKey {
    pub key: String,
    pub source: SdkKeySource,
}

impl std::fmt::Debug for ResolvedSdkKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolvedSdkKey")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

fn validate_key(key: &str) -> Result<(), String> {
    if key.trim().is_empty()
        || key.chars().any(char::is_whitespace)
        || key.chars().any(char::is_control)
    {
        return Err(
            "SDK credentials must be nonempty and contain no whitespace or control characters"
                .into(),
        );
    }
    Ok(())
}

impl GenAiAccountConfig {
    /// Enumerates stored material only, preserving primary/additional order.
    pub fn all_keys(&self) -> Vec<String> {
        let mut keys = Vec::new();
        for key in std::iter::once(&self.api_key).chain(self.api_keys.iter()) {
            if !key.is_empty() && !keys.contains(key) {
                keys.push(key.clone());
            }
        }
        keys
    }

    pub fn validate(&self, kind: &str) -> Result<(), String> {
        let descriptor = sdk_provider_by_kind(kind).ok_or("unknown SDK provider kind")?;
        if !self.api_key.is_empty() {
            validate_key(&self.api_key)?;
        }
        for key in &self.api_keys {
            validate_key(key)?;
        }
        if descriptor.auth_kind == SdkAuthKind::NoAuth
            && (!self.all_keys().is_empty() || self.allow_env)
        {
            return Err(
                "NoAuth SDK providers do not accept credentials or environment imports".into(),
            );
        }
        if self.context.kind() != SdkContextKind::Default
            && self.context.kind() != descriptor.context_kind
        {
            return Err("SDK endpoint context does not match provider kind".into());
        }
        let valid_segment = |value: &str| {
            !value.is_empty()
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        };
        match &self.context {
            SdkEndpointConfig::Vertex { project, location }
                if !valid_segment(project) || !valid_segment(location) =>
            {
                return Err("invalid Vertex project or location".into())
            }
            SdkEndpointConfig::BedrockApi { region } if !valid_segment(region) => {
                return Err("invalid Bedrock region".into())
            }
            SdkEndpointConfig::Ollama { base_url } => {
                let url = url::Url::parse(base_url).map_err(|_| "invalid Ollama endpoint URL")?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err("Ollama endpoint must be an HTTP URL without credentials, query or fragment".into());
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Missing required context is an activation error, not a ready account.
    pub fn activation_diagnostic(&self, kind: &str) -> Option<String> {
        if let Err(error) = self.validate(kind) {
            return Some(error);
        }
        let descriptor = sdk_provider_by_kind(kind)?;
        if self.context.kind() != descriptor.context_kind {
            return Some("required SDK endpoint context is missing".into());
        }
        if descriptor.auth_kind != SdkAuthKind::NoAuth
            && self.all_keys().is_empty()
            && !self.allow_env
        {
            return Some("SDK provider has no configured credentials".into());
        }
        None
    }
}

impl GenAiProviderConfig {
    pub fn mark_fleet_kind(&mut self, kind: &str) {
        self.fleet_accounts.insert(kind.to_owned());
    }

    pub fn clear_fleet_markers(&mut self) {
        self.fleet_accounts.clear();
    }
    pub fn resolve_keys(
        &self,
        kind: &str,
        environment: &BTreeMap<String, String>,
    ) -> Result<Vec<ResolvedSdkKey>, String> {
        let descriptor = sdk_provider_by_kind(kind).ok_or("unknown SDK provider kind")?;
        let Some(account) = self.accounts.get(kind) else {
            return Ok(Vec::new());
        };
        account.validate(kind)?;
        let mut result: Vec<_> = account
            .all_keys()
            .into_iter()
            .map(|key| ResolvedSdkKey {
                key,
                source: if self.fleet_accounts.contains(kind) {
                    SdkKeySource::Fleet
                } else {
                    SdkKeySource::Stored
                },
            })
            .collect();
        if account.allow_env {
            if let Some(key) = descriptor
                .default_env
                .and_then(|name| environment.get(name))
                .filter(|key| !key.is_empty())
            {
                validate_key(key)?;
                if !result.iter().any(|entry| entry.key == *key) {
                    result.push(ResolvedSdkKey {
                        key: key.clone(),
                        source: SdkKeySource::Environment,
                    });
                }
            }
        }
        Ok(result)
    }
}

impl<'de> Deserialize<'de> for GenAiProviderConfig {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            accounts: Option<BTreeMap<String, GenAiAccountConfig>>,
            #[serde(default)]
            keys: BTreeMap<String, String>,
            #[serde(default)]
            gemini_api_keys: Vec<String>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let legacy = wire.accounts.is_none();
        let mut accounts = wire.accounts.unwrap_or_default();
        for (kind, api_key) in wire.keys {
            if accounts.contains_key(&kind) {
                return Err(serde::de::Error::custom(
                    "conflicting canonical and legacy SDK account entries",
                ));
            }
            accounts.insert(
                kind,
                GenAiAccountConfig {
                    api_key,
                    ..Default::default()
                },
            );
        }
        if !wire.gemini_api_keys.is_empty() {
            if !legacy && accounts.contains_key("gemini") {
                return Err(serde::de::Error::custom(
                    "conflicting canonical and legacy Gemini account entries",
                ));
            }
            accounts.entry("gemini".into()).or_default().api_keys = wire.gemini_api_keys;
        }
        if legacy {
            accounts.entry("gemini".into()).or_default().allow_env = true;
        }
        for (kind, account) in &accounts {
            account.validate(kind).map_err(serde::de::Error::custom)?;
        }
        Ok(Self {
            accounts,
            ..Default::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_preserves_order_and_canonical_roundtrip() {
        let config: GenAiProviderConfig = serde_json::from_value(serde_json::json!({"keys":{"gemini":"primary", "groq":"groq-secret"},"gemini_api_keys":["extra","primary","extra"]})).unwrap();
        assert_eq!(config.accounts["gemini"].all_keys(), ["primary", "extra"]);
        assert!(config.accounts["gemini"].allow_env);
        let value = serde_json::to_value(&config).unwrap();
        assert!(value.get("keys").is_none());
        assert!(value.get("gemini_api_keys").is_none());
        assert!(value.get("accounts").is_some());
        assert!(!format!("{config:?}").contains("groq-secret"));
    }
    #[test]
    fn canonical_clear_disables_legacy_environment_import() {
        let environment = BTreeMap::from([("GEMINI_API_KEY".into(), "env-secret".into())]);
        let legacy: GenAiProviderConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(
            legacy.resolve_keys("gemini", &environment).unwrap()[0].source,
            SdkKeySource::Environment
        );
        let cleared: GenAiProviderConfig = serde_json::from_str(r#"{"accounts":{}}"#).unwrap();
        assert!(cleared
            .resolve_keys("gemini", &environment)
            .unwrap()
            .is_empty());
        assert!(legacy.accounts["gemini"].all_keys().is_empty());
    }
    #[test]
    fn rejects_conflicts_unknown_kinds_and_invalid_inputs_without_secret_echo() {
        for value in [
            serde_json::json!({"accounts":{"groq":{"api_key":"one"}},"keys":{"groq":"two"}}),
            serde_json::json!({"accounts":{"unknown":{"api_key":"secret"}}}),
            serde_json::json!({"accounts":{"groq":{"api_keys":[""]}}}),
            serde_json::json!({"accounts":{"groq":{"api_key":"sensitive\nsecret"}}}),
            serde_json::json!({"accounts":{"ollama":{"api_key":"secret"}}}),
            serde_json::json!({"accounts":{"groq":{"context":{"kind":"vertex","project":"p","location":"l"}}}}),
            serde_json::json!({"accounts":{"vertex":{"context":{"kind":"vertex","project":"p/escape","location":"l"}}}}),
        ] {
            let error = serde_json::from_value::<GenAiProviderConfig>(value)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("sensitive"));
        }
    }
    #[test]
    fn required_endpoint_has_explicit_activation_diagnostic() {
        let config: GenAiProviderConfig =
            serde_json::from_value(serde_json::json!({"accounts":{"vertex":{"api_key":"token"}}}))
                .unwrap();
        assert_eq!(
            config.accounts["vertex"]
                .activation_diagnostic("vertex")
                .as_deref(),
            Some("required SDK endpoint context is missing")
        );
    }
}
