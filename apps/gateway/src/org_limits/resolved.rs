//! Building a request's [`OrgLimitContext`] from a resolved `rgw_` credential.

use std::sync::Arc;

use super::{current_spend_tags, OrgLimitContext};
use crate::policy::ResolvedOrg;

/// Who a dynamically resolved request is for limits, beyond the resolve
/// itself: the caller binding and the verified bot.
#[derive(Debug, Default)]
pub struct ResolvedSubject {
    /// The member the credential is bound to (a personal node's owner).
    pub bound_user_id: Option<String>,
    /// Team scopes of the request inside the org.
    pub team_ids: Vec<String>,
    /// A static key's configured project, used when the resolve names none.
    pub configured_project_id: Option<String>,
    /// The agent id Core proved with its HMAC, or `None`. Callers must never
    /// pass an unverified `x-ryu-agent-id` here.
    pub verified_bot_id: Option<String>,
}

impl OrgLimitContext {
    /// The limit context of a request served under `resolved`.
    pub fn from_resolved(
        resolved: &ResolvedOrg,
        gateway_bills_tenants: bool,
        subject: ResolvedSubject,
    ) -> Self {
        Self {
            org_id: resolved.org_id.clone(),
            limits: Arc::clone(resolved.enforced_limits(gateway_bills_tenants)),
            credential_id: resolved.credential_id.clone(),
            service_account_id: resolved.service_account_id.clone(),
            bound_user_id: subject.bound_user_id,
            team_ids: subject.team_ids,
            remote_spend: resolved.limits_spend.clone(),
            active_gateways: resolved.active_gateways,
            tags: current_spend_tags(),
            project_id: resolved
                .project_id
                .clone()
                .or(subject.configured_project_id)
                .filter(|id| !id.is_empty()),
            bot_id: subject.verified_bot_id.filter(|id| !id.is_empty()),
            funding_draw_source: resolved.funding_draw_source,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::FundingSource;
    use super::*;

    fn resolved(project_id: Option<&str>) -> ResolvedOrg {
        ResolvedOrg {
            org_id: "org1".to_owned(),
            managed_inference: false,
            openrouter_routing_enabled: false,
            remaining_budget_micro_usd: None,
            unrestricted_budget_micro_usd: None,
            pool_budgets_micro_usd: std::collections::HashMap::new(),
            pool_allowances: std::collections::HashMap::new(),
            policy: crate::policy::EffectivePolicy::default(),
            credential_id: Some("cred1".to_owned()),
            service_account_id: None,
            project_id: project_id.map(str::to_owned),
            funding_draw_source: Some(FundingSource::Api),
            credential: None,
            identity_salt_epoch: 1,
            team_id: None,
            owner_user_id: None,
            owner_team_ids: None,
            limits: Arc::default(),
            billed_limits: Arc::default(),
            managed_tier_unavailable: false,
            limits_spend: None,
            active_gateways: None,
            policy_version: None,
            fetched_at: std::time::Instant::now(),
            standing: crate::standing::PlatformStanding::active(),
            platform_floor: None,
            enforcement_seen: 0,
            credential_created_at: None,
        }
    }

    fn subject(configured: Option<&str>, bot: Option<&str>) -> ResolvedSubject {
        ResolvedSubject {
            configured_project_id: configured.map(str::to_owned),
            verified_bot_id: bot.map(str::to_owned),
            ..ResolvedSubject::default()
        }
    }

    #[test]
    fn the_resolved_project_wins_over_the_configured_one() {
        let ctx = OrgLimitContext::from_resolved(
            &resolved(Some("proj_r")),
            false,
            subject(Some("proj_c"), Some("agent_1")),
        );
        assert_eq!(ctx.project_id.as_deref(), Some("proj_r"));
        assert_eq!(ctx.bot_id.as_deref(), Some("agent_1"));
        assert_eq!(ctx.funding_draw_source, Some(FundingSource::Api));
        assert_eq!(ctx.credential_id.as_deref(), Some("cred1"));
    }

    #[test]
    fn falls_back_to_the_configured_project_and_drops_blank_ids() {
        let fallback =
            OrgLimitContext::from_resolved(&resolved(None), false, subject(Some("proj_c"), None));
        assert_eq!(fallback.project_id.as_deref(), Some("proj_c"));
        assert_eq!(fallback.bot_id, None);
        let blank =
            OrgLimitContext::from_resolved(&resolved(Some("")), false, subject(None, Some("")));
        assert_eq!(blank.project_id, None);
        assert_eq!(blank.bot_id, None);
    }
}
