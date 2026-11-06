//! Node-root epochs for per-org Core relay keys.
//!
//! A relay key is readable by whoever holds root on one of the org's managed
//! nodes. When such a member leaves or is demoted, the control plane bumps the
//! org's node-root epoch (`boxProofKeyEpoch` on the org budget view, the same
//! epoch hosted `gwb1` keys are checked against) and new nodes receive the key
//! derived at it. A relay key whose epoch is not the org's current one is
//! refused, so a departed admin's copied key stops working.

use crate::error::GatewayError;
use crate::pipeline::core_proof::{box_org_budget, BoxBudgetError};
use crate::pipeline::RequestContext;
use crate::state::AppState;

/// The epoch an authenticated org relay key was derived at.
fn presented_epoch(ctx: &RequestContext) -> Option<u64> {
    let key = ctx.key_config.as_ref()?;
    let master = std::env::var(super::ENV_CORE_RELAY_MASTER_KEY).ok()?;
    ryu_gw_credentials::verify_org_core_relay_key(&master, &key.key).map(|(_, epoch)| epoch)
}

/// Whether a key at `presented` may act for an org whose current epoch is
/// `current` (`None`: this Gateway has no control plane, so no epoch can have
/// moved past 0).
pub(crate) fn relay_epoch_admits(presented: u64, current: Option<u64>) -> bool {
    presented == current.unwrap_or(0)
}

/// Refuse a per-org Core relay request whose key was derived at a retired
/// node-root epoch. Fails closed: an unreachable control plane is a
/// retryable 503, and an org it does not know is a 401.
pub(crate) async fn check_relay_key_epoch(
    state: &AppState,
    ctx: &RequestContext,
) -> Result<(), GatewayError> {
    let Some(org_id) = super::bound_forwarder_org(ctx) else {
        return Ok(());
    };
    let retired =
        || GatewayError::Unauthorized("The Core relay credential has been retired".to_owned());
    let presented = presented_epoch(ctx).ok_or_else(retired)?;
    let current = match box_org_budget(&state.http, &state.config.credits, org_id, None).await {
        Ok((budget, _)) => Some(budget.box_proof_key_epoch),
        Err(BoxBudgetError::NotConfigured) => None,
        Err(BoxBudgetError::UnknownOrg | BoxBudgetError::Refused) => return Err(retired()),
        Err(BoxBudgetError::Unavailable) => return Err(GatewayError::StandingUnavailable),
    };
    if relay_epoch_admits(presented, current) {
        return Ok(());
    }
    tracing::warn!(
        org_id,
        presented,
        current = current.unwrap_or(0),
        "org Core relay key derived at a retired node-root epoch; refusing"
    );
    Err(retired())
}
