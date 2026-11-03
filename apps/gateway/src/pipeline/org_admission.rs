//! The org-scoped admission a resolved tenant request carries: org/team/
//! member caps, the credential identity, the standing guard and the abuse
//! ladder. Shared by `rgw_` keys and hosted `gwb1` Box keys so the two never
//! drift on what an org's governance enforces.

use std::sync::Arc;

use crate::config::ApiKeyOperation;
use crate::error::GatewayError;
use crate::pipeline::RequestContext;
use crate::policy::{CredentialUse, ResolvedOrg};
use crate::state::AppState;

/// Attach the org's caps (bound to `bound_user_id`, `team_ids` and the
/// Core-proven `verified_bot_id`, never an unverified agent header) and admit
/// the fleet's abuse-ladder posture. `ladder_user` is the verified caller
/// the ladder's `user` entries bind to, never a forwarded header.
pub(crate) fn attach_org_limits_and_ladder(
    state: &AppState,
    context: &mut RequestContext,
    resolved: &ResolvedOrg,
    bound_user_id: Option<String>,
    team_ids: Vec<String>,
    verified_bot_id: Option<String>,
    ladder_user: Option<&str>,
) -> Result<(), GatewayError> {
    let bills_tenants = state.config.credits.is_active();
    context.org_limits = Some(Arc::new(crate::org_limits::OrgLimitContext::from_resolved(
        resolved,
        bills_tenants,
        crate::org_limits::ResolvedSubject {
            bound_user_id,
            team_ids,
            configured_project_id: None,
            verified_bot_id,
        },
    )));
    // Ladder L2 and L3 and the new-key limit on the fleet (spec 04.8.1): the
    // posture this request is served under, and the in-flight slots it holds
    // until its last clone (a stream body included) drops.
    context.enforcement = crate::enforcement::Enforcement::admit(state, resolved, ladder_user)?;
    Ok(())
}

/// The resolve purpose an `rgw_` bearer is checked for on `operation`.
pub(crate) fn credential_use_for(operation: ApiKeyOperation) -> CredentialUse {
    match operation {
        ApiKeyOperation::Inference => CredentialUse::GatewayRelay,
        ApiKeyOperation::WebSearch => CredentialUse::GatewayWebSearch,
        ApiKeyOperation::WebFetch => CredentialUse::GatewayWebFetch,
    }
}

/// Finish a resolved `rgw_` context after its identity fields are built.
pub(crate) fn finish_dynamic_context(
    state: &AppState,
    context: &mut RequestContext,
    resolved: &ResolvedOrg,
    token: &str,
    credential_use: CredentialUse,
    bound_user_id: Option<String>,
    team_ids: Vec<String>,
) -> Result<(), GatewayError> {
    context.openrouter_routing_enabled = resolved.openrouter_routing_enabled;
    context.credit_accounting_unavailable = resolved
        .metered_credit(state.config.credits.is_active())
        .accounting_unavailable;
    state.pool_allowances.observe(&resolved.pool_allowances);
    // `api_key` intentionally stays an org label for audit and org-level
    // accounting. Job ownership must still distinguish two valid bearers in
    // the same organization.
    context.owner_binding = ryu_gw_credentials::fingerprint(token);
    // The resolved credential travels with the request so audit rows,
    // events and the upstream subject name it.
    context.identity = Some(Arc::new(crate::identity::RequestIdentity::from_credential(
        resolved.credential.clone(),
        resolved.identity_salt_epoch,
    )));
    // Dates this request's budget figures, so the credit gate can prefer a
    // newer debit report (see `credit_headroom_micro_usd`).
    context.budget_resolved_at = Some(resolved.fetched_at);
    // Lets tool loops and streams check standing again when an enforcement
    // push names this credential mid-request.
    context.standing = Some(Arc::new(crate::standing::StandingGuard::new(
        token.to_owned(),
        credential_use,
        resolved,
    )));
    // `user` ladder entries bind only to the JWT-verified user, never to the
    // forwarded header.
    let ladder_user = context.user_id.clone();
    // Core-proven by the caller (`dynamic_agent_id`).
    let verified_bot_id = context.agent_id.clone();
    attach_org_limits_and_ladder(
        state,
        context,
        resolved,
        bound_user_id,
        team_ids,
        verified_bot_id,
        ladder_user.as_deref(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_operation_resolves_its_own_credential_use() {
        assert!(matches!(
            credential_use_for(ApiKeyOperation::Inference),
            CredentialUse::GatewayRelay
        ));
        assert!(matches!(
            credential_use_for(ApiKeyOperation::WebSearch),
            CredentialUse::GatewayWebSearch
        ));
        assert!(matches!(
            credential_use_for(ApiKeyOperation::WebFetch),
            CredentialUse::GatewayWebFetch
        ));
    }
}
