//! Selection for new SDK conversations. Existing sealed conversation bindings
//! are resolved before this chooser is called. Quota evidence is scoped to the
//! captured credential generation and uses the shared account-pool policy.

use std::collections::BTreeMap;

use crate::server::oauth_pool_policy::{Policy, Strategy};
use crate::server::oauth_pool_usage::{Candidate, PoolCursor};

pub(crate) const STRATEGIES: &[Strategy] =
    &[Strategy::Manual, Strategy::RoundRobin, Strategy::FillFirst];

/// These SDK transports have account-specific, read-only provider quota readers.
/// API credit balances and vendor-global CLI state are not account quota evidence.
pub(crate) fn quota_observations_supported(provider_id: &str) -> bool {
    matches!(provider_id, "openai-codex" | "github-copilot")
}

pub(crate) fn strategies(provider_id: &str) -> &'static [Strategy] {
    if quota_observations_supported(provider_id) {
        &[
            Strategy::Manual,
            Strategy::RoundRobin,
            Strategy::QuotaFirst,
            Strategy::FillFirst,
            Strategy::ResetFirst,
        ]
    } else {
        STRATEGIES
    }
}

/// The sealed SDK credentials supported by the current managed Pi transport.
/// Native proxy providers retain their existing account-pool implementations.
pub(crate) fn supported(provider_id: &str) -> bool {
    match super::provider_meta(provider_id) {
        Some(meta) => {
            meta.credit_pool.is_empty()
                && !meta.auth_key.is_empty()
                && (meta.auth_kind == "api-key"
                    || super::session_accounts::is_sdk_oauth_auth_key(meta.auth_key))
        }
        None => super::custom_provider_ids()
            .iter()
            .any(|known| known == provider_id),
    }
}

pub(crate) fn credential_kinds(provider_id: &str) -> Vec<&'static str> {
    if !supported(provider_id) {
        return Vec::new();
    }
    let mut kinds = Vec::new();
    if super::provider_meta(provider_id).is_none_or(|meta| meta.auth_kind == "api-key") {
        kinds.push(super::accounts::KIND_API_KEY);
    }
    if super::provider_meta(provider_id)
        .is_some_and(|meta| super::session_accounts::is_sdk_oauth_auth_key(meta.auth_key))
    {
        kinds.push(super::accounts::KIND_OAUTH);
    }
    kinds
}

#[derive(Default)]
pub(crate) struct AccountChooser {
    last_round_robin: BTreeMap<String, String>,
    quota_cursors: BTreeMap<String, PoolCursor>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UnsupportedStrategy;

impl std::fmt::Display for UnsupportedStrategy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Quota routing requires a supported provider and captured account credential generations")
    }
}

impl std::error::Error for UnsupportedStrategy {}

impl AccountChooser {
    /// Only new conversations reach this chooser. Existing bindings never
    /// rerank after a quota refresh, login rotation, or account-picker change.
    pub(crate) fn select_captured(
        &mut self,
        provider_id: &str,
        candidates: &[Candidate<'_>],
        active: Option<&str>,
        policy: &Policy,
    ) -> Result<Option<String>, UnsupportedStrategy> {
        if !strategies(provider_id).contains(&policy.strategy) {
            return Err(UnsupportedStrategy);
        }
        let mut ordered: Vec<_> = candidates.iter().collect();
        ordered.sort_unstable_by_key(|candidate| candidate.account_id);
        ordered.dedup_by_key(|candidate| candidate.account_id);
        if !quota_observations_supported(provider_id)
            || matches!(policy.strategy, Strategy::Manual | Strategy::RoundRobin)
        {
            let ids: Vec<_> = ordered
                .iter()
                .map(|candidate| candidate.account_id)
                .collect();
            return self.select(provider_id, &ids, active, policy);
        }
        let captured: Vec<_> = ordered
            .iter()
            .map(|candidate| Candidate {
                account_id: candidate.account_id,
                revision: candidate.revision,
            })
            .collect();
        let cursor = self
            .quota_cursors
            .entry(provider_id.to_owned())
            .or_default();
        Ok(cursor
            .select(provider_id, &captured, active.unwrap_or_default(), policy)
            .map(|index| captured[index].account_id.to_owned()))
    }

    /// `candidates` contains only accounts with a usable captured credential.
    /// Policy flags select new conversations; this never changes active picker
    /// state, refreshes a credential, or retries an agent turn.
    pub(crate) fn select(
        &mut self,
        provider_id: &str,
        candidates: &[&str],
        active: Option<&str>,
        policy: &Policy,
    ) -> Result<Option<String>, UnsupportedStrategy> {
        if !STRATEGIES.contains(&policy.strategy) {
            return Err(UnsupportedStrategy);
        }
        let mut eligible: Vec<&str> = candidates
            .iter()
            .copied()
            .filter(|id| policy.allowed(id))
            .collect();
        eligible.sort_unstable();
        eligible.dedup();
        if eligible.is_empty() {
            return Ok(None);
        }
        if policy.strategy == Strategy::Manual {
            return Ok(active
                .filter(|id| eligible.contains(id))
                .or_else(|| eligible.first().copied())
                .map(str::to_owned));
        }
        let priority = eligible
            .iter()
            .map(|id| policy.priority(id))
            .min()
            .expect("eligible accounts are nonempty");
        eligible.retain(|id| policy.priority(id) == priority);
        let selected = if policy.strategy == Strategy::FillFirst {
            // Fill the first usable account in the highest-priority group.
            // It changes only when eligibility or priority changes. A missing
            // quota observation cannot establish that an account is drained.
            eligible[0]
        } else {
            let last = self.last_round_robin.get(provider_id);
            let next = last
                .and_then(|last| eligible.iter().position(|id| *id > last.as_str()))
                .unwrap_or(0);
            let selected = eligible[next];
            self.last_round_robin
                .insert(provider_id.to_owned(), selected.to_owned());
            selected
        };
        Ok(Some(selected.to_owned()))
    }
}

#[cfg(test)]
#[path = "sdk_account_routing_quota_tests.rs"]
mod quota_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::oauth_pool_policy::AccountRule;

    fn policy(strategy: Strategy) -> Policy {
        Policy {
            strategy,
            ..Policy::default()
        }
    }

    #[test]
    fn sdk_capabilities_cover_api_keys_and_sdk_oauth_without_native_proxies() {
        // Core's catalog is authoritative. SDK-only names become routable
        // through a registered custom provider, not an invented builtin row.
        for provider in super::super::PROVIDERS
            .iter()
            .filter(|provider| provider.auth_kind == "api-key")
        {
            assert!(supported(provider.id), "{}", provider.id);
        }
        for provider in [
            "openai-codex",
            "github-copilot",
            "kimi-coding",
            "radius",
            "openrouter",
            "xai",
        ] {
            assert!(supported(provider), "{provider}");
        }
        for provider in ["claude-pro-max", "chatgpt", "chatgpt-plan", "gateway"] {
            assert!(!supported(provider), "{provider}");
        }
    }

    #[test]
    fn round_robin_is_stable_across_input_order_and_provider_scopes() {
        let mut chooser = AccountChooser::default();
        let policy = policy(Strategy::RoundRobin);
        assert_eq!(
            chooser
                .select("xai", &["work", "personal"], None, &policy)
                .unwrap()
                .as_deref(),
            Some("personal")
        );
        assert_eq!(
            chooser
                .select("xai", &["personal", "work"], None, &policy)
                .unwrap()
                .as_deref(),
            Some("work")
        );
        assert_eq!(
            chooser
                .select("copilot", &["work", "personal"], None, &policy)
                .unwrap()
                .as_deref(),
            Some("personal")
        );
        assert_eq!(
            chooser
                .select("xai", &["personal", "work"], None, &policy)
                .unwrap()
                .as_deref(),
            Some("personal")
        );
    }

    #[test]
    fn disabled_accounts_and_lower_priority_groups_do_not_receive_new_work() {
        let mut chooser = AccountChooser::default();
        let mut policy = policy(Strategy::RoundRobin);
        for (id, enabled, priority) in [
            ("a", false, 0),
            ("b", true, 3),
            ("c", true, 1),
            ("d", true, 1),
        ] {
            policy.accounts.insert(
                id.into(),
                AccountRule {
                    drain_threshold_percent: None,
                    enabled,
                    priority,
                },
            );
        }
        let candidates = ["a", "b", "c", "d"];
        assert_eq!(
            chooser
                .select("provider", &candidates, Some("a"), &policy)
                .unwrap()
                .as_deref(),
            Some("c")
        );
        assert_eq!(
            chooser
                .select("provider", &candidates, Some("b"), &policy)
                .unwrap()
                .as_deref(),
            Some("d")
        );
        assert_eq!(
            chooser
                .select("provider", &candidates, None, &policy)
                .unwrap()
                .as_deref(),
            Some("c")
        );
    }

    #[test]
    fn fill_first_stays_until_the_first_account_is_no_longer_eligible() {
        let mut chooser = AccountChooser::default();
        let mut policy = policy(Strategy::FillFirst);
        for _ in 0..3 {
            assert_eq!(
                chooser
                    .select("provider", &["a", "b"], Some("b"), &policy)
                    .unwrap()
                    .as_deref(),
                Some("a")
            );
        }
        policy.accounts.insert(
            "a".into(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: false,
                priority: 0,
            },
        );
        assert_eq!(
            chooser
                .select("provider", &["a", "b"], None, &policy)
                .unwrap()
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            chooser
                .select("provider", &["b"], None, &policy)
                .unwrap()
                .as_deref(),
            Some("b")
        );
    }

    #[test]
    fn manual_keeps_the_active_eligible_account_without_advancing_rotation() {
        let mut chooser = AccountChooser::default();
        assert_eq!(
            chooser
                .select(
                    "provider",
                    &["a", "b"],
                    Some("b"),
                    &policy(Strategy::Manual)
                )
                .unwrap()
                .as_deref(),
            Some("b")
        );
        assert_eq!(
            chooser
                .select("provider", &["a", "b"], None, &policy(Strategy::RoundRobin))
                .unwrap()
                .as_deref(),
            Some("a")
        );
    }

    #[test]
    fn no_eligible_account_is_an_explicit_empty_selection() {
        let mut chooser = AccountChooser::default();
        let mut policy = policy(Strategy::FillFirst);
        policy.accounts.insert(
            "a".into(),
            AccountRule {
                drain_threshold_percent: None,
                enabled: false,
                priority: 0,
            },
        );
        assert_eq!(
            chooser
                .select("provider", &["a"], Some("a"), &policy)
                .unwrap(),
            None
        );
        assert_eq!(
            chooser.select("provider", &[], None, &policy).unwrap(),
            None
        );
    }

    #[test]
    fn quota_and_reset_strategies_require_actual_observation_support() {
        let mut chooser = AccountChooser::default();
        for strategy in [Strategy::QuotaFirst, Strategy::ResetFirst] {
            assert_eq!(
                chooser.select("provider", &["a"], None, &policy(strategy)),
                Err(UnsupportedStrategy)
            );
        }
    }
}
