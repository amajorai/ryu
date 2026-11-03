//! Org governance for hosted `gwb1` Box inference keys (design §7.6).
//!
//! A Box key is signed by its org's Core, not presented with an org `rgw_`
//! credential, so the hosted fleet cannot `/gateway/resolve` it. The org
//! budget route (`/api/gateway/orgs/:orgId/budget?userId=`) therefore also
//! carries the org's `governance`: its effective policy (member layer
//! included), limits, fleet spend, firewall overlays and platform standing,
//! with the same wire meaning as on the resolve. This module turns that view
//! into a [`ResolvedOrg`] so a Box request runs under the same standing,
//! policy, org/team/member caps and abuse-ladder admission as the org's own
//! keys, never under the fleet's own policy snapshot.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Deserializer};

use crate::config::FirewallOverlay;
use crate::error::GatewayError;
use crate::org_limits::{null_as_default, OrgLimits, RateCeiling, RemoteSpend};
use crate::policy::{EffectivePolicy, ResolvedOrg};
use crate::state::AppState;

use crate::pipeline::core_proof::{
    box_hosted_proof_keys, box_org_budget, box_token_org_hint, check_box_identity, BoxBudgetError,
    BoxOrgBudget, BOX_FEATURE,
};
use crate::pipeline::RequestContext;

/// The `governance` object of the org budget view.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoxOrgGovernance {
    #[serde(default)]
    policy: WirePolicy,
    #[serde(default, deserialize_with = "null_as_default")]
    limits: OrgLimits,
    #[serde(default)]
    plan_rate_ceiling: Option<RateCeiling>,
    #[serde(default, deserialize_with = "arc_spend")]
    limits_spend: Option<Arc<RemoteSpend>>,
    #[serde(default)]
    policy_version: Option<String>,
    /// Kept raw so a malformed standing fails closed as unavailable.
    #[serde(default)]
    standing: Option<serde_json::Value>,
    #[serde(default)]
    firewall: Option<FirewallOverlay>,
    #[serde(default)]
    team_firewall: Option<FirewallOverlay>,
    #[serde(default, deserialize_with = "null_as_default")]
    agent_overlays: HashMap<String, FirewallOverlay>,
    /// The Box member's team ids in this org, for team caps.
    #[serde(default, deserialize_with = "null_as_default")]
    team_ids: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct WirePolicy {
    #[serde(default)]
    rules: WireRules,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireRules {
    #[serde(default, deserialize_with = "null_as_default")]
    locked_guardrails: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    approved_models: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    approved_providers: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    allowed_regions: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    allowed_tools: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    denied_tools: Vec<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    allowed_mcp_servers: Vec<String>,
}

fn arc_spend<'de, D>(deserializer: D) -> Result<Option<Arc<RemoteSpend>>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<RemoteSpend>::deserialize(deserializer)?.map(Arc::new))
}

/// The credit fields a `gwb1` tenant is gated on. Mirrors
/// `ResolvedOrg::metered_credit`: on a gateway that bills tenants, "not
/// managed" means "not funded", and an unreadable tier is an accounting
/// outage (503), never an empty wallet.
pub(crate) fn box_tenant_credit(
    budget: &BoxOrgBudget,
    gateway_bills_tenants: bool,
) -> crate::policy::TenantCredit {
    use crate::policy::TenantCredit;
    if !gateway_bills_tenants || (budget.managed_inference && !budget.managed_tier_unavailable) {
        return TenantCredit {
            managed_inference: budget.managed_inference,
            remaining_budget_micro_usd: budget.remaining_budget_micro_usd,
            unrestricted_budget_micro_usd: budget.unrestricted_budget_micro_usd,
            pool_budgets_micro_usd: budget.pool_budgets_micro_usd.clone(),
            accounting_unavailable: false,
        };
    }
    if budget.managed_tier_unavailable {
        return box_accounting_unavailable();
    }
    TenantCredit {
        managed_inference: true,
        remaining_budget_micro_usd: Some(budget.remaining_budget_micro_usd.unwrap_or(0).min(0)),
        unrestricted_budget_micro_usd: Some(0),
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        accounting_unavailable: false,
    }
}

pub(crate) fn box_accounting_unavailable() -> crate::policy::TenantCredit {
    crate::policy::TenantCredit {
        managed_inference: true,
        remaining_budget_micro_usd: None,
        unrestricted_budget_micro_usd: None,
        pool_budgets_micro_usd: std::collections::HashMap::new(),
        accounting_unavailable: true,
    }
}

/// The resolved org a hosted Box request is governed by, plus the member's
/// team ids for its limit scope.
pub(crate) struct BoxGovernance {
    pub(crate) resolved: ResolvedOrg,
    pub(crate) team_ids: Vec<String>,
}

/// Build the org view a Box request is admitted under. `None` when the
/// control plane sent no governance (an older plane): the caller refuses.
pub(crate) fn box_governance(
    org_id: &str,
    budget: &BoxOrgBudget,
    fetched_at: std::time::Instant,
) -> Option<BoxGovernance> {
    let governance = budget.governance.clone()?;
    let standing = crate::standing::PlatformStanding::from_wire(governance.standing.as_ref());
    // A refuse-all standing never loads as a permissive policy.
    let available = standing.refuses != crate::standing::StandingRefusal::All;
    let rules = governance.policy.rules;
    let limits = Arc::new(governance.limits);
    let billed_limits = match governance.plan_rate_ceiling {
        Some(ceiling) => Arc::new(limits.with_rate_ceiling(ceiling)),
        None => Arc::clone(&limits),
    };
    let mut team_ids: Vec<String> = governance
        .team_ids
        .into_iter()
        .filter(|id| !id.trim().is_empty())
        .collect();
    team_ids.sort_unstable();
    team_ids.dedup();
    let resolved = ResolvedOrg {
        org_id: org_id.to_owned(),
        managed_inference: budget.managed_inference,
        openrouter_routing_enabled: budget.openrouter_routing_enabled,
        remaining_budget_micro_usd: budget.remaining_budget_micro_usd,
        unrestricted_budget_micro_usd: budget.unrestricted_budget_micro_usd,
        pool_budgets_micro_usd: budget.pool_budgets_micro_usd.clone(),
        pool_allowances: HashMap::new(),
        policy: EffectivePolicy {
            zero_data_retention_enabled: true,
            available,
            locked_guardrails: rules.locked_guardrails,
            approved_models: rules.approved_models,
            approved_providers: rules.approved_providers,
            allowed_regions: rules.allowed_regions,
            allowed_tools: rules.allowed_tools,
            denied_tools: rules.denied_tools,
            allowed_mcp_servers: rules.allowed_mcp_servers,
            firewall: governance.firewall,
            team_firewall: governance.team_firewall,
            agent_overlays: governance.agent_overlays,
            // A Box key authorizes inference only, never web services.
            hosted_web_search_enabled: false,
            web_search_debit_reason: false,
        },
        credential_id: None,
        service_account_id: None,
        // A Box key names no project, and its funding source is unknown, so
        // every funding cap gates it.
        project_id: None,
        funding_draw_source: None,
        credential: None,
        identity_salt_epoch: 1,
        team_id: None,
        owner_user_id: None,
        owner_team_ids: None,
        limits,
        billed_limits,
        managed_tier_unavailable: budget.managed_tier_unavailable,
        limits_spend: governance.limits_spend,
        active_gateways: None,
        policy_version: governance
            .policy_version
            .filter(|version| !version.is_empty()),
        fetched_at,
        standing,
        platform_floor: None,
        enforcement_seen: 0,
        credential_created_at: None,
    };
    Some(BoxGovernance { resolved, team_ids })
}

/// A `gwb1` key a local `local-core` forwarder signed, with that forwarder's
/// org. `None` when no local forwarder signed it (try the hosted fleet path);
/// an error when it names another org or another caller than its scope.
pub(crate) fn verify_local_box(
    api_keys: &[crate::config::ApiKeyConfig],
    key: &str,
    user_id: Option<&str>,
    session_id: Option<&str>,
) -> Option<Result<(ryu_gw_credentials::BoxInferenceScope, Option<String>), GatewayError>> {
    let (scope, forwarder_org) = api_keys
        .iter()
        .filter(|entry| entry.name == "local-core" && entry.trusted_forwarder)
        .find_map(|entry| {
            ryu_gw_credentials::BoxInferenceScope::verify(key, &entry.key)
                .ok()
                .map(|scope| (scope, entry.org_id.clone()))
        })?;
    if forwarder_org
        .as_deref()
        .is_some_and(|org| org != scope.org_id)
    {
        return Some(Err(GatewayError::Unauthorized(
            "The Box credential names another organization".to_owned(),
        )));
    }
    if let Err(error) = check_box_identity(&scope, user_id, session_id) {
        return Some(Err(error));
    }
    Some(Ok((scope, forwarder_org)))
}

/// A verified hosted Box key with its org's credit and governance views.
pub(crate) struct HostedBox {
    pub(crate) scope: ryu_gw_credentials::BoxInferenceScope,
    pub(crate) credit: crate::policy::TenantCredit,
    pub(crate) resolved_at: Option<std::time::Instant>,
    pub(crate) openrouter_routing_enabled: bool,
    /// `None` only on a gateway with no control plane at all, which has no
    /// org governance to apply and does not bill tenants.
    pub(crate) governance: Option<BoxGovernance>,
}

/// Verify a `gwb1` key under its org's derived Core proof key and read the
/// org's budget and governance. Fails closed: whenever a control plane is
/// configured, a request is served only under the org's own governance; an
/// unreachable plane, or one that sends no governance, is a retryable 503.
pub(crate) async fn resolve_hosted_box(
    state: &AppState,
    token: &str,
    user_id: Option<&str>,
    session_id: Option<&str>,
) -> Result<HostedBox, GatewayError> {
    let invalid = || GatewayError::Unauthorized("Invalid Box inference credential".to_owned());
    let org_hint = box_token_org_hint(token).ok_or_else(invalid)?;
    let scope = box_hosted_proof_keys(&org_hint)
        .iter()
        .find_map(|core_key| ryu_gw_credentials::BoxInferenceScope::verify(token, core_key).ok())
        .filter(|scope| scope.org_id == org_hint)
        .ok_or_else(invalid)?;
    check_box_identity(&scope, user_id, session_id)?;
    let bills_tenants = state.config.credits.is_active();
    let member = scope.user_id.as_deref();
    match box_org_budget(&state.http, &state.config.credits, &scope.org_id, member).await {
        Ok((budget, fetched_at)) => {
            let Some(governance) = box_governance(&scope.org_id, &budget, fetched_at) else {
                tracing::warn!(
                    org_id = %scope.org_id,
                    "gwb1: the control plane sent no org governance; refusing"
                );
                return Err(GatewayError::StandingUnavailable);
            };
            Ok(HostedBox {
                credit: box_tenant_credit(&budget, bills_tenants),
                resolved_at: Some(fetched_at),
                openrouter_routing_enabled: budget.openrouter_routing_enabled,
                governance: Some(governance),
                scope,
            })
        }
        Err(BoxBudgetError::UnknownOrg) => Err(invalid()),
        // The scope names someone who is not a current member of its org.
        Err(BoxBudgetError::Refused) => Err(GatewayError::Unauthorized(
            "The Box credential names a user who is not a member of its organization".to_owned(),
        )),
        Err(BoxBudgetError::NotConfigured) if !bills_tenants => Ok(HostedBox {
            credit: box_tenant_credit(&BoxOrgBudget::default(), false),
            resolved_at: None,
            openrouter_routing_enabled: false,
            governance: None,
            scope,
        }),
        Err(error) => {
            tracing::warn!(
                org_id = %scope.org_id,
                error = ?error,
                "gwb1: org budget and governance unavailable; refusing until it recovers"
            );
            Err(GatewayError::StandingUnavailable)
        }
    }
}

/// Fill a hosted Box context from its verified scope, credit and org
/// governance. With governance (whenever a control plane is configured) the
/// request is admitted exactly as an `rgw_` key of the org is: platform
/// standing first, then the org's policy, the org/team/member caps bound to
/// the Box member (whatever the Box id, so a fresh Box never gets a fresh
/// budget) and the abuse ladder; never the fleet's own policy snapshot.
pub(crate) fn finish_hosted_context(
    state: &AppState,
    context: &mut RequestContext,
    hosted: HostedBox,
    token: &str,
) -> Result<(), GatewayError> {
    let HostedBox {
        scope,
        credit,
        resolved_at,
        openrouter_routing_enabled,
        governance,
    } = hosted;
    context.managed_inference = credit.managed_inference;
    context.remaining_budget_micro_usd = credit.remaining_budget_micro_usd;
    context.unrestricted_budget_micro_usd = credit.unrestricted_budget_micro_usd;
    context.pool_budgets_micro_usd = credit.pool_budgets_micro_usd;
    context.credit_accounting_unavailable = credit.accounting_unavailable;
    context.openrouter_routing_enabled = openrouter_routing_enabled;
    context.budget_resolved_at = resolved_at;
    context.owner_binding = ryu_gw_credentials::fingerprint(token);
    context.session_id = Some(scope.session_id);
    context.feature = Some(BOX_FEATURE.to_owned());
    let Some(governance) = governance else {
        return Ok(());
    };
    let resolved = &governance.resolved;
    crate::standing::admit_resolved(resolved, state.custody)?;
    context.resolved_policy = Some(resolved.policy.clone());
    super::org_admission::attach_org_limits_and_ladder(
        state,
        context,
        resolved,
        scope.user_id.clone(),
        governance.team_ids,
        // A Box key proves its session, not an agent id, so no bot budget binds.
        None,
        scope.user_id.as_deref(),
    )
}

/// The user whose personal Composio entity a request may act through. A Box
/// key (`gwb1`) is signed with a node-held key, not by its member, so it
/// proves no member's consent to act through their own connected accounts:
/// it gets only the org-shared entity. Every other caller keeps the identity
/// authentication accepted.
pub(crate) fn composio_entity_user(context: &RequestContext) -> Option<&str> {
    if context.feature.as_deref() == Some(BOX_FEATURE) && context.api_key.starts_with("box:") {
        return None;
    }
    context.user_id.as_deref()
}

#[cfg(test)]
#[path = "box_governance_tests.rs"]
mod tests;
