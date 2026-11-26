//! The signed readiness proof a managed Gateway hands to Core, and the rule
//! Core applies before it trusts that Gateway.
//!
//! Core used to refuse any Gateway whose release version was not identical to
//! its own, so the two could never be updated one at a time. The proof now also
//! carries the protocol range the Gateway speaks (`ryu-protocol`). Core accepts
//! a Gateway when the two ranges share a number and only logs a warning when
//! the release versions differ.

use anyhow::{bail, Result};
use ryu_protocol::{negotiate, ProtocolRange, LEGACY_PROTOCOL};

use crate::fingerprint;

const READINESS_PROTOCOL: &str = "ryu-gateway-readiness-v1";

/// Authenticate a readiness challenge without disclosing the admin bearer to
/// a listener whose identity Core has not verified yet. Request and response
/// MACs use distinct messages so a response cannot authorize another challenge.
pub fn readiness_request_signature(nonce: &str, admin: &str) -> Result<String> {
    use hmac::Mac;
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
    mac.update(b"ryu-gateway-readiness-request-v1:");
    mac.update(nonce.as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

pub fn verify_readiness_request(nonce: &str, signature: &str, admin: &str) -> Result<()> {
    use hmac::Mac;
    if nonce.len() != 64
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        || signature.len() != 64
    {
        bail!("invalid readiness request proof");
    }
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
    mac.update(b"ryu-gateway-readiness-request-v1:");
    mac.update(nonce.as_bytes());
    mac.verify_slice(&hex::decode(signature)?)
        .map_err(|_| anyhow::anyhow!("invalid readiness request proof"))
}

/// Signed, non-secret startup facts. Listener is the bound socket address supplied
/// by the host after TcpListener::bind, never a caller-controlled HTTP authority.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct Readiness {
    pub protocol: String,
    pub version: String,
    pub nonce: String,
    pub listener: std::net::SocketAddr,
    pub require_auth: bool,
    pub inference_keys: Vec<String>,
    pub core_keys: Vec<String>,
}

/// The protocol range a Gateway speaks, signed with the admin credential and
/// bound to the readiness nonce so it cannot be replayed into another proof.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct ProtocolClaim {
    pub range: ProtocolRange,
    pub signature: String,
}

impl ProtocolClaim {
    fn mac(range: ProtocolRange, nonce: &str, admin: &str) -> Result<hmac::Hmac<sha2::Sha256>> {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
        mac.update(b"ryu-gateway-protocol-range-v1:");
        mac.update(nonce.as_bytes());
        mac.update(format!(":{}:{}", range.min, range.max).as_bytes());
        Ok(mac)
    }

    fn sign(range: ProtocolRange, nonce: &str, admin: &str) -> Result<Self> {
        use hmac::Mac;
        let mac = Self::mac(range, nonce, admin)?;
        Ok(Self {
            range,
            signature: hex::encode(mac.finalize().into_bytes()),
        })
    }

    fn verify(&self, nonce: &str, admin: &str) -> Result<()> {
        use hmac::Mac;
        if self.range.min > self.range.max {
            bail!("Gateway reported a protocol range that is out of order");
        }
        Self::mac(self.range, nonce, admin)?
            .verify_slice(&hex::decode(&self.signature)?)
            .map_err(|_| anyhow::anyhow!("Gateway protocol range signature is invalid"))
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ReadinessProof {
    pub readiness: Readiness,
    pub signature: String,
    /// Absent in a proof from a Gateway that predates the protocol number. The
    /// readiness signature above does not cover it, so a Core that predates it
    /// still verifies this proof exactly as before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol: Option<ProtocolClaim>,
}

impl ReadinessProof {
    /// Sign the readiness facts and state the protocol range this build speaks.
    pub fn sign(readiness: Readiness, admin: &str) -> Result<Self> {
        Self::sign_with_range(readiness, admin, ProtocolRange::CURRENT)
    }

    /// Sign as a Gateway that speaks `range`.
    pub fn sign_with_range(
        readiness: Readiness,
        admin: &str,
        range: ProtocolRange,
    ) -> Result<Self> {
        let protocol = ProtocolClaim::sign(range, &readiness.nonce, admin)?;
        let mut proof = Self::sign_legacy(readiness, admin)?;
        proof.protocol = Some(protocol);
        Ok(proof)
    }

    /// Sign the way a Gateway that predates the protocol number does: the
    /// readiness facts only, with no protocol range.
    pub fn sign_legacy(readiness: Readiness, admin: &str) -> Result<Self> {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
        mac.update(&serde_json::to_vec(&readiness)?);
        Ok(Self {
            readiness,
            signature: hex::encode(mac.finalize().into_bytes()),
            protocol: None,
        })
    }

    /// `version` is the release version of the Core that verifies the proof.
    pub fn verify(
        &self,
        admin: &str,
        nonce: &str,
        listener: std::net::SocketAddr,
        version: &str,
        relay: &str,
        core: &str,
    ) -> Result<()> {
        use hmac::Mac;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(admin.as_bytes())?;
        mac.update(&serde_json::to_vec(&self.readiness)?);
        mac.verify_slice(&hex::decode(&self.signature)?)
            .map_err(|_| anyhow::anyhow!("Gateway readiness signature is invalid"))?;
        let ready = &self.readiness;
        if ready.protocol != READINESS_PROTOCOL
            || ready.nonce != nonce
            || ready.listener != listener
            || !ready.require_auth
        {
            bail!("Gateway readiness does not match this listener, nonce, or authenticated configuration");
        }
        self.negotiated_protocol(admin, version)?;
        let relay = fingerprint(relay);
        let core = fingerprint(core);
        let admin = fingerprint(admin);
        if relay == core
            || relay == admin
            || core == admin
            || !ready.inference_keys.contains(&relay)
            || !ready.core_keys.contains(&core)
            || ready.core_keys.contains(&relay)
            || ready.inference_keys.contains(&core)
            || ready.inference_keys.contains(&admin)
            || ready.core_keys.contains(&admin)
        {
            bail!("Gateway readiness credential roles do not match the managed configuration");
        }
        Ok(())
    }

    /// The highest protocol this Core and the proving Gateway share.
    ///
    /// With no shared number the error names the side to update. A Gateway
    /// that predates the protocol number reports no range; only the identical
    /// release is known to speak the same calls, so the old rule still applies
    /// to it and nothing that worked before this rule stops working.
    pub fn negotiated_protocol(&self, admin: &str, version: &str) -> Result<u32> {
        let ready = &self.readiness;
        let Some(claim) = &self.protocol else {
            if ready.version != version {
                bail!(
                    "Gateway {} reports no protocol range and is not Core's release {version}; update the Gateway",
                    ready.version
                );
            }
            return Ok(LEGACY_PROTOCOL);
        };
        claim.verify(&ready.nonce, admin)?;
        match negotiate(ProtocolRange::CURRENT, claim.range) {
            Ok(protocol) => {
                if ready.version != version {
                    tracing::warn!(
                        gateway_version = %ready.version,
                        core_version = %version,
                        protocol,
                        "Gateway and Core are different releases; continuing on their shared protocol"
                    );
                }
                Ok(protocol)
            }
            Err(refused) => bail!(
                "Gateway {} refused, {}",
                ready.version,
                refused.describe("Core", "the Gateway")
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LISTENER: &str = "127.0.0.1:1234";

    fn readiness(version: &str) -> Readiness {
        Readiness {
            protocol: READINESS_PROTOCOL.into(),
            version: version.into(),
            nonce: "nonce".into(),
            listener: LISTENER.parse().unwrap(),
            require_auth: true,
            inference_keys: vec![fingerprint("relay")],
            core_keys: vec![fingerprint("core")],
        }
    }

    fn verify(proof: &ReadinessProof, core_version: &str) -> Result<()> {
        proof.verify(
            "admin",
            "nonce",
            LISTENER.parse().unwrap(),
            core_version,
            "relay",
            "core",
        )
    }

    #[test]
    fn a_gateway_of_another_release_with_the_same_protocol_is_accepted() {
        let proof = ReadinessProof::sign(readiness("0.5.0"), "admin").unwrap();
        verify(&proof, "0.5.1").unwrap();
        assert_eq!(
            proof.negotiated_protocol("admin", "0.5.1").unwrap(),
            ryu_protocol::PROTOCOL_MAX
        );
        // The identical release still passes.
        verify(&proof, "0.5.0").unwrap();
    }

    #[test]
    fn an_older_gateway_with_no_shared_protocol_names_the_gateway() {
        let old = ProtocolRange::new(LEGACY_PROTOCOL, LEGACY_PROTOCOL);
        let proof = ReadinessProof::sign_with_range(readiness("0.4.0"), "admin", old).unwrap();
        let error = verify(&proof, "0.5.1").unwrap_err().to_string();
        assert!(error.contains("no shared protocol"), "{error}");
        assert!(error.ends_with("update the Gateway"), "{error}");
        // The identical release version does not rescue a range that is disjoint.
        assert!(verify(&proof, "0.4.0").is_err());
    }

    #[test]
    fn a_newer_gateway_with_no_shared_protocol_names_core() {
        let newer = ProtocolRange::new(
            ryu_protocol::PROTOCOL_MAX + 1,
            ryu_protocol::PROTOCOL_MAX + 2,
        );
        let proof = ReadinessProof::sign_with_range(readiness("9.0.0"), "admin", newer).unwrap();
        let error = verify(&proof, "0.5.1").unwrap_err().to_string();
        assert!(error.contains("no shared protocol"), "{error}");
        assert!(error.ends_with("update Core"), "{error}");
    }

    #[test]
    fn an_overlapping_range_picks_the_highest_shared_protocol() {
        let wide = ProtocolRange::new(LEGACY_PROTOCOL, ryu_protocol::PROTOCOL_MAX + 3);
        let proof = ReadinessProof::sign_with_range(readiness("9.0.0"), "admin", wide).unwrap();
        assert_eq!(
            proof.negotiated_protocol("admin", "0.5.1").unwrap(),
            ryu_protocol::PROTOCOL_MAX
        );
    }

    #[test]
    fn a_gateway_without_a_range_keeps_the_identical_release_rule() {
        let proof = ReadinessProof::sign_legacy(readiness("0.5.1"), "admin").unwrap();
        verify(&proof, "0.5.1").unwrap();
        assert_eq!(
            proof.negotiated_protocol("admin", "0.5.1").unwrap(),
            LEGACY_PROTOCOL
        );
        let error = verify(&proof, "0.5.2").unwrap_err().to_string();
        assert!(error.ends_with("update the Gateway"), "{error}");
    }

    #[test]
    fn the_protocol_range_cannot_be_changed_or_replayed() {
        let mut proof = ReadinessProof::sign(readiness("0.5.0"), "admin").unwrap();
        // Signed with another credential.
        let forged = ProtocolClaim::sign(ProtocolRange::CURRENT, "nonce", "not-admin").unwrap();
        proof.protocol = Some(forged);
        assert!(verify(&proof, "0.5.1").is_err());
        // Signed for another challenge.
        let replayed = ProtocolClaim::sign(ProtocolRange::CURRENT, "other-nonce", "admin").unwrap();
        proof.protocol = Some(replayed);
        assert!(verify(&proof, "0.5.1").is_err());
        // Widened after signing.
        let mut widened = ProtocolClaim::sign(ProtocolRange::new(7, 9), "nonce", "admin").unwrap();
        widened.range = ProtocolRange::CURRENT;
        proof.protocol = Some(widened);
        assert!(verify(&proof, "0.5.1").is_err());
        // Out of order.
        let unordered = ProtocolClaim::sign(ProtocolRange::new(2, 1), "nonce", "admin").unwrap();
        proof.protocol = Some(unordered);
        assert!(verify(&proof, "0.5.1").is_err());
    }

    #[test]
    fn a_proof_from_an_older_gateway_still_deserializes() {
        let signed = ReadinessProof::sign_legacy(readiness("0.5.1"), "admin").unwrap();
        let wire = serde_json::to_value(&signed).unwrap();
        assert!(wire.get("protocol").is_none(), "{wire}");
        let parsed: ReadinessProof = serde_json::from_value(wire).unwrap();
        verify(&parsed, "0.5.1").unwrap();

        let current = ReadinessProof::sign(readiness("0.5.1"), "admin").unwrap();
        let wire = serde_json::to_value(&current).unwrap();
        assert_eq!(
            wire["protocol"]["range"],
            serde_json::json!({"min": ryu_protocol::PROTOCOL_MIN, "max": ryu_protocol::PROTOCOL_MAX})
        );
        let parsed: ReadinessProof = serde_json::from_value(wire).unwrap();
        verify(&parsed, "0.5.3").unwrap();
    }
}
