//! Per-organization Core relay keys.
//!
//! A managed Core authenticates to the hosted Gateway with its Core relay key
//! (`RYU_GATEWAY_CORE_TOKEN`), a trusted-forwarder bearer. Every node once
//! received the one shared `GATEWAY_CORE_RELAY_KEY`, so the tenant holding root
//! on any node held fleet-wide trusted-forwarder authority. The control plane
//! now hands each node `gwcore_org_<HMAC(master, org)>_<org>` instead, and the
//! hosted Gateway re-derives it from `GATEWAY_CORE_RELAY_MASTER_KEY` for the org
//! the key names, binding the request to that org. The org travels in the key
//! so the Gateway knows which org to derive for; only the MAC proves it.
//!
//! The key is derived at the org's node-root epoch (`boxProofKeyEpoch`, bumped
//! when a member who could have read it from a node leaves or is demoted).
//! Epoch 0 keeps the original `gwcore_org_<mac>_<org>` form; a later epoch is
//! `gwcore_org_<HMAC(master, v2 label, org, epoch)>_<org>.<epoch>`, so the
//! Gateway can refuse a key whose epoch is no longer the org's current one.
//!
//! `packages/api/src/lib/core-relay-key.ts` must stay byte-identical (shared
//! test vector).

use anyhow::{bail, Result};

/// Prefix every per-org Core relay key starts with.
pub const ORG_CORE_RELAY_PREFIX: &str = "gwcore_org_";
const ORG_CORE_RELAY_LABEL: &[u8] = b"ryu-core-relay-org-v1\0";
const ORG_CORE_RELAY_EPOCH_LABEL: &[u8] = b"ryu-core-relay-org-v2\0";
const MAC_HEX_LEN: usize = 64;

/// An org id a relay key may carry: 1-128 of `[A-Za-z0-9_-]`.
pub fn valid_org_core_relay_org(org_id: &str) -> bool {
    !org_id.is_empty()
        && org_id.len() <= 128
        && org_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn relay_mac(master: &str, org_id: &str, epoch: u64) -> Result<hmac::Hmac<sha2::Sha256>> {
    use hmac::Mac;
    if master.trim().is_empty() {
        bail!("Core relay master key is empty");
    }
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(master.as_bytes())?;
    if epoch == 0 {
        mac.update(ORG_CORE_RELAY_LABEL);
        mac.update(org_id.as_bytes());
    } else {
        mac.update(ORG_CORE_RELAY_EPOCH_LABEL);
        mac.update(org_id.as_bytes());
        mac.update(b"\0");
        mac.update(epoch.to_string().as_bytes());
    }
    Ok(mac)
}

/// The Core relay key a managed node of `org_id` holds at epoch 0.
pub fn derive_org_core_relay_key(master: &str, org_id: &str) -> Result<String> {
    derive_org_core_relay_key_at(master, org_id, 0)
}

/// The Core relay key a managed node of `org_id` holds at node-root `epoch`.
pub fn derive_org_core_relay_key_at(master: &str, org_id: &str, epoch: u64) -> Result<String> {
    use hmac::Mac;
    if !valid_org_core_relay_org(org_id) {
        bail!("invalid organization id for a Core relay key");
    }
    let digest = hex::encode(relay_mac(master, org_id, epoch)?.finalize().into_bytes());
    Ok(if epoch == 0 {
        format!("{ORG_CORE_RELAY_PREFIX}{digest}_{org_id}")
    } else {
        format!("{ORG_CORE_RELAY_PREFIX}{digest}_{org_id}.{epoch}")
    })
}

/// The org and epoch a presented per-org relay key is valid for, or `None`
/// when it is not one (wrong shape, or a MAC that does not verify under
/// `master`). The caller must still refuse an epoch that is not the org's
/// current one.
pub fn verify_org_core_relay_key(master: &str, key: &str) -> Option<(String, u64)> {
    use hmac::Mac;
    let rest = key.strip_prefix(ORG_CORE_RELAY_PREFIX)?;
    let (mac_hex, tail) = (rest.get(..MAC_HEX_LEN)?, rest.get(MAC_HEX_LEN..)?);
    let tail = tail.strip_prefix('_')?;
    let (org_id, epoch) = match tail.split_once('.') {
        None => (tail, 0),
        Some((org_id, epoch)) => {
            // Canonical decimal only, so one epoch has exactly one key.
            let parsed: u64 = epoch.parse().ok()?;
            if parsed == 0 || parsed.to_string() != epoch {
                return None;
            }
            (org_id, parsed)
        }
    };
    if !valid_org_core_relay_org(org_id) {
        return None;
    }
    let presented = hex::decode(mac_hex).ok()?;
    relay_mac(master, org_id, epoch)
        .ok()?
        .verify_slice(&presented)
        .ok()?;
    Some((org_id.to_owned(), epoch))
}

#[cfg(test)]
mod tests {
    use super::*;

    const MASTER: &str = "gwcore_master_cross_language_vector";

    #[test]
    fn matches_the_control_plane_vector_and_separates_orgs() {
        assert_eq!(
            derive_org_core_relay_key(MASTER, "org_123").unwrap(),
            "gwcore_org_e411737ec417a55dc6d6cd2ff780041ee77a65bde26806af297e31a96451b407_org_123"
        );
        assert_ne!(
            derive_org_core_relay_key(MASTER, "org_a").unwrap(),
            derive_org_core_relay_key(MASTER, "org_b").unwrap()
        );
    }

    #[test]
    fn verifies_only_its_own_org_under_its_own_master() {
        let key = derive_org_core_relay_key(MASTER, "org_a").unwrap();
        assert_eq!(
            verify_org_core_relay_key(MASTER, &key),
            Some(("org_a".to_owned(), 0))
        );
        // Relabelling the org invalidates the MAC.
        let forged = key.replace("_org_a", "_org_b");
        assert_eq!(verify_org_core_relay_key(MASTER, &forged), None);
        assert_eq!(
            verify_org_core_relay_key("another-master-key-0000000", &key),
            None
        );
        assert_eq!(verify_org_core_relay_key("", &key), None);
        assert_eq!(
            verify_org_core_relay_key(MASTER, "gwcore_shared_key_0000000000"),
            None
        );
        assert_eq!(verify_org_core_relay_key(MASTER, "gwcore_org_00"), None);
    }

    #[test]
    fn refuses_unsafe_org_ids() {
        assert!(derive_org_core_relay_key(MASTER, "").is_err());
        assert!(derive_org_core_relay_key(MASTER, "org a").is_err());
        assert!(derive_org_core_relay_key(MASTER, "org/../b").is_err());
        assert!(derive_org_core_relay_key("  ", "org_a").is_err());
    }

    #[test]
    fn epoch_keys_match_the_control_plane_vector_and_carry_their_epoch() {
        let key = derive_org_core_relay_key_at(MASTER, "org_123", 2).unwrap();
        assert_eq!(
            key,
            "gwcore_org_beb48ed72723b17a5c1fd5787e706728e685968379b3c3c68b553a4f10930560_org_123.2"
        );
        assert_eq!(
            verify_org_core_relay_key(MASTER, &key),
            Some(("org_123".to_owned(), 2))
        );
        // Epoch 0 is the original key; every epoch yields a different key.
        assert_eq!(
            derive_org_core_relay_key_at(MASTER, "org_123", 0).unwrap(),
            derive_org_core_relay_key(MASTER, "org_123").unwrap()
        );
        assert_ne!(
            key,
            derive_org_core_relay_key_at(MASTER, "org_123", 1).unwrap()
        );
    }

    #[test]
    fn an_epoch_cannot_be_relabelled() {
        let retired = derive_org_core_relay_key(MASTER, "org_a").unwrap();
        for forged in [
            format!("{retired}.1"),
            derive_org_core_relay_key_at(MASTER, "org_a", 1)
                .unwrap()
                .replace(".1", ".2"),
            derive_org_core_relay_key_at(MASTER, "org_a", 1)
                .unwrap()
                .replace(".1", ".01"),
            derive_org_core_relay_key_at(MASTER, "org_a", 1)
                .unwrap()
                .replace(".1", ".0"),
        ] {
            assert_eq!(verify_org_core_relay_key(MASTER, &forged), None, "{forged}");
        }
    }
}
