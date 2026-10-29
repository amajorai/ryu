//! User-selected policy for new provider conversations. Core owns native proxy
//! and direct managed SDK account selection and their sealed credentials.

use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::{preferences::PreferencesStore, ServerState};

const PREF_PREFIX: &str = "oauth-account-pool:";
const MAX_ACCOUNT_RULES: usize = 100;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Strategy {
    #[default]
    Manual,
    RoundRobin,
    QuotaFirst,
    FillFirst,
    ResetFirst,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountRule {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_threshold_percent: Option<u8>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(default)]
    pub strategy: Strategy,
    #[serde(default = "default_drain_threshold")]
    pub drain_threshold_percent: u8,
    #[serde(default)]
    pub accounts: HashMap<String, AccountRule>,
}

fn default_drain_threshold() -> u8 {
    80
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            strategy: Strategy::Manual,
            drain_threshold_percent: default_drain_threshold(),
            accounts: HashMap::new(),
        }
    }
}

impl Policy {
    pub fn allowed(&self, account_id: &str) -> bool {
        self.accounts
            .get(account_id)
            .is_none_or(|rule| rule.enabled)
    }

    pub fn priority(&self, account_id: &str) -> u8 {
        self.accounts
            .get(account_id)
            .map_or(0, |rule| rule.priority)
    }

    pub fn drain_threshold(&self, account_id: &str) -> u8 {
        self.accounts
            .get(account_id)
            .and_then(|rule| rule.drain_threshold_percent)
            .unwrap_or(self.drain_threshold_percent)
    }

    fn validate(&self) -> Result<(), &'static str> {
        if !(1..=100).contains(&self.drain_threshold_percent) {
            return Err("drainThresholdPercent must be between 1 and 100");
        }
        if self.accounts.len() > MAX_ACCOUNT_RULES {
            return Err("too many account rules");
        }
        for (id, rule) in &self.accounts {
            if rule
                .drain_threshold_percent
                .is_some_and(|percent| percent > 100)
            {
                return Err("account drainThresholdPercent must be between 0 and 100");
            }
            if id.is_empty() || id.len() > 128 || rule.priority > 100 {
                return Err("account id or priority is invalid");
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub strategies: &'static [Strategy],
    pub credential_kinds: Vec<&'static str>,
    pub quota_observations: bool,
}

pub fn capabilities(provider_id: &str) -> Option<Capabilities> {
    if provider_id == "kiro" {
        return Some(Capabilities {
            strategies: &[Strategy::Manual, Strategy::RoundRobin],
            credential_kinds: vec![crate::pi_config::accounts::KIND_OAUTH],
            quota_observations: false,
        });
    }
    const NATIVE: &[Strategy] = &[
        Strategy::Manual,
        Strategy::RoundRobin,
        Strategy::QuotaFirst,
        Strategy::FillFirst,
        Strategy::ResetFirst,
    ];
    const PLAN: &[Strategy] = &[Strategy::Manual, Strategy::RoundRobin];
    if matches!(provider_id, "claude-pro-max" | "chatgpt" | "chatgpt-plan") {
        return Some(Capabilities {
            strategies: if provider_id == "chatgpt-plan" {
                PLAN
            } else {
                NATIVE
            },
            credential_kinds: vec![crate::pi_config::accounts::KIND_OAUTH],
            quota_observations: provider_id != "chatgpt-plan",
        });
    }
    crate::pi_config::sdk_account_routing::supported(provider_id).then(|| Capabilities {
        strategies: crate::pi_config::sdk_account_routing::strategies(provider_id),
        credential_kinds: crate::pi_config::sdk_account_routing::credential_kinds(provider_id),
        quota_observations: crate::pi_config::sdk_account_routing::quota_observations_supported(
            provider_id,
        ),
    })
}

pub fn supported(provider_id: &str) -> bool {
    capabilities(provider_id).is_some()
}

fn pref_key(provider_id: &str) -> String {
    format!("{PREF_PREFIX}{provider_id}")
}

fn strategy_supported(provider_id: &str, strategy: Strategy) -> bool {
    capabilities(provider_id)
        .is_some_and(|capabilities| capabilities.strategies.contains(&strategy))
}

fn policy_supported(provider_id: &str, policy: &Policy) -> bool {
    strategy_supported(provider_id, policy.strategy)
        && (!crate::pi_config::sdk_account_routing::supported(provider_id)
            || crate::pi_config::sdk_account_routing::quota_observations_supported(provider_id)
            || (policy.drain_threshold_percent == default_drain_threshold()
                && policy
                    .accounts
                    .values()
                    .all(|rule| rule.drain_threshold_percent.is_none())))
}

pub async fn load(preferences: &PreferencesStore, provider_id: &str) -> Policy {
    if !supported(provider_id) {
        return Policy::default();
    }
    match preferences.get(&pref_key(provider_id)).await {
        Ok(Some(raw)) => serde_json::from_str::<Policy>(&raw)
            .ok()
            .filter(|policy| policy.validate().is_ok() && policy_supported(provider_id, policy))
            .unwrap_or_default(),
        _ => Policy::default(),
    }
}

#[utoipa::path(
    get,
    path = "/api/pi-config/providers/{id}/account-pool",
    tag = "Agents",
    summary = "Provider account pool policy",
    params(("id" = String, Path, description = "Provider id")),
    responses((status = 200, description = "Policy", body = serde_json::Value),
        (status = 404, description = "Provider has no supported account pool"))
)]
pub async fn get_policy(
    State(state): State<ServerState>,
    Path(provider_id): Path<String>,
) -> Response {
    if !supported(&provider_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    Json(load(&state.preferences, &provider_id).await).into_response()
}

#[utoipa::path(
    put,
    path = "/api/pi-config/providers/{id}/account-pool",
    tag = "Agents",
    summary = "Set provider account pool policy",
    params(("id" = String, Path, description = "Provider id")),
    request_body = serde_json::Value,
    responses((status = 200, description = "Saved policy", body = serde_json::Value),
        (status = 400, description = "Invalid policy"),
        (status = 404, description = "Provider has no supported account pool"),
        (status = 500, description = "Could not save policy"))
)]
pub async fn put_policy(
    State(state): State<ServerState>,
    Path(provider_id): Path<String>,
    Json(policy): Json<Policy>,
) -> Response {
    if !supported(&provider_id) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if let Err(message) = policy.validate() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response();
    }
    if !policy_supported(&provider_id, &policy) {
        let error = if provider_id == "chatgpt-plan" {
            "ChatGPT plan routing supports manual or round robin; quota observations are unavailable"
        } else {
            "SDK account routing supports manual, round robin or fill first; quota/reset/drain observations are unavailable"
        };
        return (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response();
    }
    let serialized = match serde_json::to_string(&policy) {
        Ok(value) => value,
        Err(error) => {
            tracing::error!(%error, "could not encode OAuth account pool policy");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    if let Err(error) = state
        .preferences
        .set(&pref_key(&provider_id), &serialized)
        .await
    {
        tracing::error!(%error, "could not save OAuth account pool policy");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    Json(policy).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_policy_does_not_advertise_unavailable_quota_observations() {
        assert!(supported("chatgpt-plan"));
        assert!(strategy_supported("chatgpt-plan", Strategy::Manual));
        assert!(strategy_supported("chatgpt-plan", Strategy::RoundRobin));
        assert!(!strategy_supported("chatgpt-plan", Strategy::QuotaFirst));
        assert!(!strategy_supported("chatgpt-plan", Strategy::ResetFirst));
        assert!(strategy_supported("chatgpt", Strategy::QuotaFirst));
    }

    #[test]
    fn defaults_to_manual_and_rejects_invalid_thresholds() {
        let mut policy = Policy::default();
        assert_eq!(policy.strategy, Strategy::Manual);
        assert!(policy.validate().is_ok());
        policy.drain_threshold_percent = 0;
        assert!(policy.validate().is_err());
    }

    #[test]
    fn policy_uses_camel_case_account_controls() {
        let policy: Policy = serde_json::from_value(json!({
            "strategy": "fill_first",
            "drainThresholdPercent": 75,
            "accounts": { "second": { "enabled": false, "priority": 10 } }
        }))
        .unwrap();
        assert_eq!(policy.strategy, Strategy::FillFirst);
        assert!(!policy.allowed("second"));
        assert!(policy.allowed("first"));
        assert_eq!(policy.priority("second"), 10);
    }

    #[test]
    fn sdk_capabilities_advertise_only_real_selection_modes_and_credential_kinds() {
        let api_key = capabilities("openai").unwrap();
        assert_eq!(
            api_key.strategies,
            crate::pi_config::sdk_account_routing::STRATEGIES
        );
        assert_eq!(
            api_key.credential_kinds,
            vec![crate::pi_config::accounts::KIND_API_KEY]
        );
        assert!(!api_key.quota_observations);
        let oauth = capabilities("github-copilot").unwrap();
        assert_eq!(
            oauth.credential_kinds,
            vec![crate::pi_config::accounts::KIND_OAUTH]
        );
        assert!(oauth.quota_observations);
        assert!(strategy_supported("github-copilot", Strategy::QuotaFirst));
        assert!(strategy_supported("github-copilot", Strategy::ResetFirst));
        assert!(capabilities("gateway").is_none());
    }

    #[test]
    fn sdk_drain_threshold_is_rejected_without_quota_observations() {
        let mut policy = Policy {
            strategy: Strategy::FillFirst,
            ..Policy::default()
        };
        assert!(policy_supported("xai", &policy));
        policy.drain_threshold_percent = 75;
        assert!(!policy_supported("xai", &policy));
        assert!(policy_supported("claude-pro-max", &policy));
    }

    #[test]
    fn sdk_quota_policies_require_an_account_aware_provider_reader() {
        let policy: Policy = serde_json::from_value(json!({
            "strategy":"reset_first", "drainThresholdPercent":70,
            "accounts":{"work":{"priority":2,"drainThresholdPercent":50}}
        }))
        .unwrap();
        assert!(policy.validate().is_ok());
        for provider in ["openai-codex", "github-copilot"] {
            let capability = capabilities(provider).unwrap();
            assert!(capability.quota_observations);
            assert!(policy_supported(provider, &policy));
            assert!(strategy_supported(provider, Strategy::QuotaFirst));
        }
        for provider in ["openai", "xai", "kimi-coding", "radius"] {
            assert!(!capabilities(provider).unwrap().quota_observations);
            assert!(!policy_supported(provider, &policy));
        }
    }

    #[test]
    fn account_threshold_override_is_fixed_and_null_restores_inheritance() {
        let mut policy: Policy = serde_json::from_value(json!({
            "strategy":"fill_first", "drainThresholdPercent":80,
            "accounts":{"work":{"enabled":true,"priority":0,"drainThresholdPercent":0}}
        }))
        .unwrap();
        assert!(policy.validate().is_ok());
        assert_eq!(policy.drain_threshold("work"), 0);
        policy.drain_threshold_percent = 60;
        assert_eq!(policy.drain_threshold("work"), 0);
        policy
            .accounts
            .get_mut("work")
            .unwrap()
            .drain_threshold_percent = None;
        assert_eq!(policy.drain_threshold("work"), 60);
        let removed: AccountRule =
            serde_json::from_value(json!({"drainThresholdPercent":null})).unwrap();
        assert!(removed.drain_threshold_percent.is_none());
        assert!(serde_json::to_value(removed)
            .unwrap()
            .get("drainThresholdPercent")
            .is_none());
        policy
            .accounts
            .get_mut("work")
            .unwrap()
            .drain_threshold_percent = Some(101);
        assert!(policy.validate().is_err());
        policy
            .accounts
            .get_mut("work")
            .unwrap()
            .drain_threshold_percent = Some(0);
        policy.drain_threshold_percent = default_drain_threshold();
        assert!(!policy_supported("xai", &policy));
    }
}
