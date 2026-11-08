//! Node-root epochs for per-org Core proof keys.
//!
//! The per-org Core proof key (`gwproof_org_…`) is readable by whoever holds
//! root on one of the org's managed nodes. It proves Core's trusted-forwarder
//! role next to a dynamic `rgw_` bearer: managed provider calls, tool charges
//! and agent route proofs. A pure function of the fleet master and the org id
//! could never be retired, so a removed admin who copied it kept that
//! authority. The proof key is therefore derived at the org's node-root epoch
//! (`boxProofKeyEpoch` on the org budget view, bumped when such a member
//! leaves), as relay and Box keys are: epoch 0 is the original v1 key, and a
//! later epoch is the org's Box proof key at that epoch, which new nodes
//! already receive. Only the key at the org's current epoch is accepted.

use super::{box_org_budget, BoxBudgetError, ENV_CORE_PROOF_KEY_ORG_ID, ENV_CORE_PROOF_MASTER_KEY};
use crate::config::CreditsConfig;
use crate::error::GatewayError;

/// The Core proof key configuration a Gateway was started with.
#[derive(Debug, Default, Clone)]
pub(crate) struct CoreProofEnv {
    /// `GATEWAY_CORE_PROOF_KEY`: the legacy shared (or single-org) key.
    pub(crate) direct: Option<String>,
    /// `GATEWAY_CORE_PROOF_KEY_ORG_ID`: the one org a single-org Gateway serves.
    pub(crate) direct_org: Option<String>,
    /// `GATEWAY_CORE_PROOF_MASTER_KEY`: the fleet master per-org keys derive from.
    pub(crate) master: Option<String>,
}

impl CoreProofEnv {
    pub(crate) fn from_process() -> Self {
        let configured = |name: &str| {
            std::env::var(name)
                .ok()
                .filter(|value| !value.trim().is_empty())
        };
        Self {
            direct: configured("GATEWAY_CORE_PROOF_KEY"),
            direct_org: configured(ENV_CORE_PROOF_KEY_ORG_ID),
            master: configured(ENV_CORE_PROOF_MASTER_KEY),
        }
    }

    fn is_empty(&self) -> bool {
        self.direct.is_none() && self.master.is_none()
    }
}

/// Core proof keys accepted for `org_id` at node-root `epoch`.
///
/// - The master-derived key at `epoch` (epoch 0 is the original v1 key).
/// - The direct key at epoch 0 (nodes provisioned before per-org keys), and
///   past it only on a single-org Gateway configured for `org_id`: on a
///   multi-org fleet the shared key cannot be retired per org.
pub(crate) fn core_proof_keys_at_epoch(
    env: &CoreProofEnv,
    org_id: Option<&str>,
    epoch: u64,
) -> Vec<String> {
    let org_id = org_id.filter(|org| !org.is_empty());
    let mut keys = Vec::new();
    if let Some(direct) = env.direct.as_deref() {
        let single_org = matches!(
            (env.direct_org.as_deref(), org_id),
            (Some(direct_org), Some(org)) if direct_org.trim() == org
        );
        if epoch == 0 || single_org {
            keys.push(direct.to_owned());
        }
    }
    if let (Some(master), Some(org)) = (env.master.as_deref(), org_id) {
        if let Ok(derived) = ryu_gw_credentials::derive_org_box_proof_key(master, org, epoch) {
            keys.push(derived);
        }
    }
    keys
}

/// The Core proof keys accepted for `org_id` now, at the org's current
/// node-root epoch. Fails closed: an unreachable control plane is a retryable
/// 503, and an org it does not know (or an id unsafe for its path) gets no
/// keys. A Gateway with no control plane has no epochs, so epoch 0 applies.
pub(crate) async fn current_core_proof_keys(
    http: &reqwest::Client,
    credits: &CreditsConfig,
    env: &CoreProofEnv,
    org_id: Option<&str>,
) -> Result<Vec<String>, GatewayError> {
    if env.is_empty() {
        return Ok(Vec::new());
    }
    let Some(org) = org_id.filter(|org| !org.is_empty()) else {
        return Ok(core_proof_keys_at_epoch(env, None, 0));
    };
    if !super::valid_box_org_id(org) {
        return Ok(Vec::new());
    }
    let epoch = match box_org_budget(http, credits, org, None).await {
        Ok((budget, _)) => budget.box_proof_key_epoch,
        Err(BoxBudgetError::NotConfigured) => 0,
        Err(BoxBudgetError::UnknownOrg | BoxBudgetError::Refused) => return Ok(Vec::new()),
        Err(BoxBudgetError::Unavailable) => return Err(GatewayError::StandingUnavailable),
    };
    Ok(core_proof_keys_at_epoch(env, Some(org), epoch))
}

/// Keys an agent route proof next to a dynamic `rgw_` for `org_id` must
/// verify under. Without a proof none are needed, so nothing is looked up.
pub(crate) async fn agent_route_proof_keys(
    state: &crate::state::AppState,
    agent_proof: Option<&str>,
    org_id: &str,
) -> Result<Vec<String>, GatewayError> {
    if agent_proof.is_none() {
        return Ok(Vec::new());
    }
    let env = CoreProofEnv::from_process();
    current_core_proof_keys(&state.http, &state.config.credits, &env, Some(org_id)).await
}

/// Whether a dynamically resolved organization bearer is accompanied by Core's
/// separate trusted proof key for that organization at its current node-root
/// epoch. The caller must keep organization and resource scope from the
/// resolved bearer; this header alone is never an auth credential or a source
/// of tenant identity.
pub async fn has_core_proof_key(
    state: &crate::state::AppState,
    headers: &axum::http::HeaderMap,
    org_id: Option<&str>,
) -> Result<bool, GatewayError> {
    let env = CoreProofEnv::from_process();
    has_core_proof_key_with(&state.http, &state.config.credits, &env, headers, org_id).await
}

/// [`has_core_proof_key`] with explicit configuration.
pub(crate) async fn has_core_proof_key_with(
    http: &reqwest::Client,
    credits: &CreditsConfig,
    env: &CoreProofEnv,
    headers: &axum::http::HeaderMap,
    org_id: Option<&str>,
) -> Result<bool, GatewayError> {
    let Some(presented) = headers
        .get("x-ryu-core-key")
        .and_then(|value| value.to_str().ok())
    else {
        return Ok(false);
    };
    let keys = current_core_proof_keys(http, credits, env, org_id).await?;
    Ok(keys
        .iter()
        .any(|expected| super::core_proof_header_matches(presented, expected)))
}

#[cfg(test)]
#[path = "core_proof_epoch_tests.rs"]
mod tests;
