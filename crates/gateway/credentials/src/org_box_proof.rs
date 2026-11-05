//! Per-organization Box proof keys, rotatable per org.
//!
//! A hosted `gwb1` Box inference key is a complete credential: it names the
//! org to bill and is signed with a key every managed node of that org holds.
//! The org-derived Core proof key ([`crate::derive_org_core_proof_key`]) is a
//! pure function of the fleet master and the org id, so a former admin who
//! copied it from a node could mint `gwb1` keys for that org forever. The Box
//! signing key therefore carries a per-org epoch the control plane bumps when
//! a member who could hold node root leaves: epoch 0 is the Core proof key
//! itself (so nodes provisioned before epochs existed keep working), and every
//! later epoch is an independent key. The hosted Gateway refuses a `gwb1`
//! whose signed `keyEpoch` is not the org's current epoch.
//!
//! `packages/api/src/lib/core-proof-key.ts` must stay byte-identical (shared
//! test vector).

use anyhow::{bail, Result};

const ORG_BOX_PROOF_LABEL: &[u8] = b"ryu-core-box-org-v2\0";

/// Serde helper: an epoch of 0 is left out of a signed scope payload, so a
/// `gwb1` signed at epoch 0 is byte-identical to one from before epochs.
#[allow(clippy::trivially_copy_pass_by_ref)]
pub(crate) fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// The key a managed Core signs hosted `gwb1` keys with at `epoch`.
pub fn derive_org_box_proof_key(master: &str, org_id: &str, epoch: u64) -> Result<String> {
    use hmac::Mac;
    if master.trim().is_empty() {
        bail!("Core proof master key is empty");
    }
    if epoch == 0 {
        return crate::derive_org_core_proof_key(master, org_id);
    }
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(master.as_bytes())?;
    mac.update(ORG_BOX_PROOF_LABEL);
    mac.update(org_id.as_bytes());
    mac.update(b"\0");
    mac.update(epoch.to_string().as_bytes());
    Ok(format!(
        "gwproof_box_{}",
        hex::encode(mac.finalize().into_bytes())
    ))
}

#[cfg(test)]
mod tests {
    use super::derive_org_box_proof_key;
    use crate::{derive_org_core_proof_key, BoxInferenceScope};

    const MASTER: &str = "gwproof_master_cross_language_vector";

    #[test]
    fn epoch_zero_is_the_org_core_proof_key() {
        assert_eq!(
            derive_org_box_proof_key(MASTER, "org_123", 0).unwrap(),
            derive_org_core_proof_key(MASTER, "org_123").unwrap()
        );
    }

    #[test]
    fn later_epochs_match_the_control_plane_vector_and_are_independent() {
        let first = derive_org_box_proof_key(MASTER, "org_123", 1).unwrap();
        assert_eq!(
            first,
            "gwproof_box_11ccd7bbedfd757b2188d73c9110423683ddc295e7d4d8138c93831d3e899757"
        );
        let second = derive_org_box_proof_key(MASTER, "org_123", 2).unwrap();
        assert_ne!(first, second);
        assert_ne!(
            first,
            derive_org_box_proof_key(MASTER, "org_124", 1).unwrap()
        );
        assert!(derive_org_box_proof_key(" ", "org_123", 1).is_err());
    }

    #[test]
    fn the_epoch_is_signed_and_omitted_at_zero() {
        let now = 1_800_000_000;
        let mut scope = BoxInferenceScope {
            org_id: "org_1".into(),
            user_id: None,
            session_id: "conv_1".into(),
            box_id: "bx_1".into(),
            lease_epoch: 0,
            expires_at: now + 600,
            key_epoch: 0,
        };
        let payload = serde_json::to_string(&scope).unwrap();
        assert!(!payload.contains("keyEpoch"));
        scope.key_epoch = 2;
        let token = scope
            .sign_at("core-proof-key-0123456789abcdef", now)
            .unwrap();
        let verified =
            BoxInferenceScope::verify_at(&token, "core-proof-key-0123456789abcdef", now).unwrap();
        assert_eq!(verified.key_epoch, 2);
        // The epoch is covered by the signature.
        let (_, signature) = token.rsplit_once('.').unwrap();
        scope.key_epoch = 3;
        let payload = hex::encode(serde_json::to_vec(&scope).unwrap());
        assert!(BoxInferenceScope::verify_at(
            &format!("gwb1.{payload}.{signature}"),
            "core-proof-key-0123456789abcdef",
            now
        )
        .is_err());
    }
}
