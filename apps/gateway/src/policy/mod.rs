//! Control-plane policy distribution and enforcement (U28).
//!
//! The gateway is the local data plane. On startup it authenticates to the
//! control plane with its own gateway key (the `rgw_` credential issued by
//! U27's `/orgs/:id/gateway-keys`) and fetches the **effective policy** for its
//! organization via `GET {control_plane}/api/control-plane/gateway/resolve`.
//! The control plane has already cascaded org/team/project/user layers and
//! honoured admin locks, so the data plane receives one resolved policy and
//! enforces it on every model call — it never re-derives the cascade and never
//! lets a lower level override an admin-locked field (that decision was made
//! upstream).
//!
//! Enforcement points (in `pipeline::pre_process`):
//!   - `approved_models`: if non-empty, the requested model must be on the list.
//!   - `locked_guardrails`: guardrails the org requires stay on (the firewall is
//!     forced enabled when any are present).
//!   - `allowed_regions`: provider/data regions permitted (carried for callers;
//!     region tagging of providers is future work, kept in scope as data).

use std::time::Duration;

use serde::Deserialize;

/// Env var with the control-plane base URL (no trailing `/api`).
const ENV_CONTROL_PLANE_URL: &str = "CONTROL_PLANE_URL";
/// Env var with this gateway's `rgw_` key used to authenticate to the control
/// plane.
const ENV_GATEWAY_KEY: &str = "GATEWAY_KEY";

/// The effective policy the data plane enforces. Mirrors the control plane's
/// `EffectivePolicy.rules` plus the locked-field list (advisory here: the
/// cascade already applied the locks).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct EffectivePolicy {
    /// Guardrail names that must stay enabled (e.g. "pii", "secrets").
    #[serde(default)]
    pub locked_guardrails: Vec<String>,
    /// Allowlist of model ids the gateway may route to. Empty = no restriction.
    #[serde(default)]
    pub approved_models: Vec<String>,
    /// Provider/data regions permitted (e.g. "us", "eu"). Empty = no restriction.
    #[serde(default)]
    pub allowed_regions: Vec<String>,
}

impl EffectivePolicy {
    /// Whether a model id is permitted. An empty allowlist permits everything.
    pub fn allows_model(&self, model: &str) -> bool {
        self.approved_models.is_empty() || self.approved_models.iter().any(|m| m == model)
    }

    /// Whether the firewall must be force-enabled to honour locked guardrails.
    pub fn requires_firewall(&self) -> bool {
        !self.locked_guardrails.is_empty()
    }
}

/// Shape of the control plane's `/gateway/resolve` response (subset).
#[derive(Debug, Deserialize)]
struct ResolveResponse {
    #[serde(default)]
    policy: ResolvePolicy,
}

/// The `policy` field of the resolve response: `{ rules, lockedFields }`.
#[derive(Debug, Default, Deserialize)]
struct ResolvePolicy {
    #[serde(default)]
    rules: ResolveRules,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveRules {
    #[serde(default)]
    locked_guardrails: Vec<String>,
    #[serde(default)]
    approved_models: Vec<String>,
    #[serde(default)]
    allowed_regions: Vec<String>,
}

/// Configuration the gateway needs to reach its control plane.
pub struct PolicySource {
    control_plane_url: String,
    gateway_key: String,
}

impl PolicySource {
    /// Build from environment. Returns `None` when the gateway is not bound to a
    /// control plane (no URL or no key) — a standalone/local gateway runs with
    /// no distributed policy and enforces nothing extra.
    pub fn from_env() -> Option<Self> {
        let url = std::env::var(ENV_CONTROL_PLANE_URL)
            .ok()
            .filter(|s| !s.is_empty())?;
        let key = std::env::var(ENV_GATEWAY_KEY)
            .ok()
            .filter(|s| !s.is_empty())?;
        Some(Self {
            control_plane_url: url.trim_end_matches('/').to_string(),
            gateway_key: key,
        })
    }

    /// Fetch and parse the effective policy from the control plane. Errors are
    /// surfaced to the caller, which decides whether to fail open (default,
    /// keep serving with no extra policy) or closed.
    pub async fn fetch(&self, http: &reqwest::Client) -> anyhow::Result<EffectivePolicy> {
        let endpoint = format!(
            "{}/api/control-plane/gateway/resolve",
            self.control_plane_url
        );
        let resp = http
            .get(&endpoint)
            .header("x-gateway-key", &self.gateway_key)
            .timeout(Duration::from_secs(5))
            .send()
            .await?;
        if !resp.status().is_success() {
            anyhow::bail!("control plane returned HTTP {}", resp.status());
        }
        let parsed: ResolveResponse = resp.json().await?;
        Ok(EffectivePolicy {
            locked_guardrails: parsed.policy.rules.locked_guardrails,
            approved_models: parsed.policy.rules.approved_models,
            allowed_regions: parsed.policy.rules.allowed_regions,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_allowlist_permits_any_model() {
        let policy = EffectivePolicy::default();
        assert!(policy.allows_model("gpt-4o"));
        assert!(policy.allows_model("claude-3-5-sonnet"));
    }

    #[test]
    fn allowlist_restricts_to_listed_models() {
        let policy = EffectivePolicy {
            approved_models: vec!["gpt-4o".to_string()],
            ..Default::default()
        };
        assert!(policy.allows_model("gpt-4o"));
        assert!(!policy.allows_model("gpt-4o-mini"));
    }

    #[test]
    fn locked_guardrails_force_firewall() {
        let none = EffectivePolicy::default();
        assert!(!none.requires_firewall());

        let locked = EffectivePolicy {
            locked_guardrails: vec!["pii".to_string()],
            ..Default::default()
        };
        assert!(locked.requires_firewall());
    }

    #[test]
    fn parses_resolve_response_shape() {
        let body = serde_json::json!({
            "organization": { "id": "o1", "name": "Acme", "slug": "acme" },
            "policy": {
                "rules": {
                    "lockedGuardrails": ["pii", "secrets"],
                    "approvedModels": ["gpt-4o"],
                    "allowedRegions": ["eu"]
                },
                "lockedFields": ["approvedModels"]
            }
        });
        let parsed: ResolveResponse = serde_json::from_value(body).unwrap();
        assert_eq!(parsed.policy.rules.approved_models, vec!["gpt-4o"]);
        assert_eq!(parsed.policy.rules.locked_guardrails.len(), 2);
        assert_eq!(parsed.policy.rules.allowed_regions, vec!["eu"]);
    }

    #[test]
    fn from_env_requires_both_url_and_key() {
        // With neither set in this test process, the source is None.
        if std::env::var(ENV_CONTROL_PLANE_URL).is_err() && std::env::var(ENV_GATEWAY_KEY).is_err()
        {
            assert!(PolicySource::from_env().is_none());
        }
    }
}
