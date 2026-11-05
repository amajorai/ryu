//! Per-org Box proof-key epochs for hosted `gwb1` keys.
//!
//! The org-derived Core proof key is a pure function of the fleet master and
//! the org id, so anyone who once copied it from a managed node (a removed
//! admin) could mint hosted `gwb1` keys for that org forever. The control
//! plane keeps a per-org Box proof-key epoch, bumps it when such a member
//! leaves, and reports it on the org budget view (`boxProofKeyEpoch`). A hosted
//! `gwb1` is verified under the key derived for the epoch it claims
//! ([`ryu_gw_credentials::derive_org_box_proof_key`]; epoch 0 is the Core proof
//! key itself) and then refused unless that epoch is the org's current one.

use crate::error::GatewayError;

/// The Box proof-key epoch a `gwb1` token claims, read from its payload
/// WITHOUT verifying it. Used only to pick the key the token must verify
/// under; the epoch is trusted only once that signature verifies.
pub(crate) fn box_token_key_epoch_hint(token: &str) -> Option<u64> {
    let payload = token.strip_prefix("gwb1.")?.split('.').next()?;
    let bytes = hex::decode(payload).ok()?;
    let scope: ryu_gw_credentials::BoxInferenceScope = serde_json::from_slice(&bytes).ok()?;
    Some(scope.key_epoch)
}

/// Keys a hosted `gwb1` naming `org_id` at `epoch` must verify under.
pub(crate) fn box_hosted_keys_at_epoch(org_id: &str, epoch: u64) -> Vec<String> {
    if epoch == 0 {
        return super::box_hosted_proof_keys(org_id);
    }
    let master = std::env::var(super::ENV_CORE_PROOF_MASTER_KEY).ok();
    box_hosted_keys_at_epoch_from(master.as_deref(), org_id, epoch)
}

/// The pure half of [`box_hosted_keys_at_epoch`] for epochs above 0. Only the
/// master-derived key verifies a later epoch: the single-org direct key has
/// no epochs and is accepted at epoch 0 only.
pub(crate) fn box_hosted_keys_at_epoch_from(
    master: Option<&str>,
    org_id: &str,
    epoch: u64,
) -> Vec<String> {
    let Some(master) = master.filter(|master| !master.trim().is_empty()) else {
        return Vec::new();
    };
    if org_id.is_empty() {
        return Vec::new();
    }
    ryu_gw_credentials::derive_org_box_proof_key(master, org_id, epoch)
        .map(|key| vec![key])
        .unwrap_or_default()
}

/// Refuse a verified hosted `gwb1` whose signing epoch is not the org's
/// current Box proof-key epoch: its key was retired (a member who could have
/// copied it left the org).
pub(crate) fn check_box_key_epoch(
    scope: &ryu_gw_credentials::BoxInferenceScope,
    current_epoch: u64,
) -> Result<(), GatewayError> {
    if scope.key_epoch == current_epoch {
        return Ok(());
    }
    tracing::warn!(
        org_id = %scope.org_id,
        signed_epoch = scope.key_epoch,
        current_epoch,
        "gwb1: signed with a retired org Box proof key; refusing"
    );
    Err(GatewayError::Unauthorized(
        "The Box credential was signed with a retired organization key".to_owned(),
    ))
}
