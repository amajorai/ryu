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
//! `packages/api/src/lib/core-relay-key.ts` must stay byte-identical (shared
//! test vector).

use anyhow::{bail, Result};

/// Prefix every per-org Core relay key starts with.
pub const ORG_CORE_RELAY_PREFIX: &str = "gwcore_org_";
const ORG_CORE_RELAY_LABEL: &[u8] = b"ryu-core-relay-org-v1\0";
const MAC_HEX_LEN: usize = 64;

/// An org id a relay key may carry: 1-128 of `[A-Za-z0-9_-]`.
pub fn valid_org_core_relay_org(org_id: &str) -> bool {
    !org_id.is_empty()
        && org_id.len() <= 128
        && org_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn org_relay_mac(master: &str, org_id: &str) -> Result<String> {
    use hmac::Mac;
    if master.trim().is_empty() {
        bail!("Core relay master key is empty");
    }
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(master.as_bytes())?;
    mac.update(ORG_CORE_RELAY_LABEL);
    mac.update(org_id.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

/// The Core relay key a managed node of `org_id` holds.
pub fn derive_org_core_relay_key(master: &str, org_id: &str) -> Result<String> {
    if !valid_org_core_relay_org(org_id) {
        bail!("invalid organization id for a Core relay key");
    }
    Ok(format!(
        "{ORG_CORE_RELAY_PREFIX}{}_{org_id}",
        org_relay_mac(master, org_id)?
    ))
}

/// The org a presented per-org relay key is valid for, or `None` when it is
/// not one (wrong shape, or a MAC that does not verify under `master`).
pub fn verify_org_core_relay_key(master: &str, key: &str) -> Option<String> {
    use hmac::Mac;
    let rest = key.strip_prefix(ORG_CORE_RELAY_PREFIX)?;
    let (mac_hex, org) = (rest.get(..MAC_HEX_LEN)?, rest.get(MAC_HEX_LEN..)?);
    let org_id = org.strip_prefix('_')?;
    if !valid_org_core_relay_org(org_id) || master.trim().is_empty() {
        return None;
    }
    let presented = hex::decode(mac_hex).ok()?;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(master.as_bytes()).ok()?;
    mac.update(ORG_CORE_RELAY_LABEL);
    mac.update(org_id.as_bytes());
    mac.verify_slice(&presented).ok()?;
    Some(org_id.to_owned())
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
            verify_org_core_relay_key(MASTER, &key).as_deref(),
            Some("org_a")
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
}
