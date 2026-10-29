//! The node's long-term X25519 identity (RHP v1.1 design §5.1 and §7).
//!
//! One static key per node serves both as the Noise static key of the secure
//! session ([`crate::secure`]) and as the node side of pairing v2
//! ([`crate::pairing`]). Devices pin its public half at pairing.
//!
//! The secret never touches disk in the clear: [`crate::store::DeviceStore`] seals
//! it with a [`NodeKeySealer`] that the host supplies (Core implements it with its
//! at-rest field cipher), so this crate keeps zero dependency on `apps/core`. A key
//! that cannot be opened is reported as [`NodeIdentityStatus::Unavailable`] and is
//! never regenerated silently; only an explicit reset replaces it.

use serde::Serialize;
use x25519_dalek::StaticSecret;
use zeroize::Zeroizing;

use crate::noise;
use crate::pair_crypto;

/// Seals and opens the node's secret key at rest. The host supplies the
/// implementation (Core uses its global at-rest cipher).
pub trait NodeKeySealer: Send + Sync {
    /// Seal `plaintext` (the base64url secret key) into an opaque storable string.
    fn seal(&self, plaintext: &str) -> anyhow::Result<String>;
    /// Open a string previously produced by [`NodeKeySealer::seal`].
    fn open(&self, stored: &str) -> anyhow::Result<String>;
}

/// A sealer that stores the key with only a marker prefix. **Tests only**: it
/// provides no confidentiality.
#[doc(hidden)]
#[derive(Clone, Copy, Debug, Default)]
pub struct PlaintextSealerForTests;

impl PlaintextSealerForTests {
    const PREFIX: &'static str = "plaintext-for-tests:";
}

impl NodeKeySealer for PlaintextSealerForTests {
    fn seal(&self, plaintext: &str) -> anyhow::Result<String> {
        Ok(format!("{}{plaintext}", Self::PREFIX))
    }

    fn open(&self, stored: &str) -> anyhow::Result<String> {
        stored
            .strip_prefix(Self::PREFIX)
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("not sealed by PlaintextSealerForTests"))
    }
}

/// Why the node identity could not be produced.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IdentityError {
    /// No [`NodeKeySealer`] was installed with `DeviceStore::set_key_sealer`.
    NoSealer,
    /// The stored key exists but could not be opened or is malformed. The stored
    /// row is left untouched.
    Unavailable(String),
}

impl IdentityError {
    /// Stable machine code (`node_identity_unavailable` for every variant: callers
    /// cannot do anything different for a missing sealer).
    pub fn code(&self) -> &'static str {
        "node_identity_unavailable"
    }
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityError::NoSealer => f.write_str("node identity: no key sealer installed"),
            IdentityError::Unavailable(reason) => write!(f, "node identity unavailable: {reason}"),
        }
    }
}

impl std::error::Error for IdentityError {}

/// The node identity's health, as reported by `GET /api/hardware/devices`. It
/// serializes as `{"status":"ok|unavailable|uninitialized","fingerprint":<string|null>}`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NodeIdentityStatus {
    /// The key exists and opens; `fingerprint` is `xxxx-xxxx-xxxx-xxxx`.
    Ok { fingerprint: String },
    /// A key is stored but cannot be opened (or no sealer is installed).
    Unavailable,
    /// No key has been created yet (it is created lazily on first use).
    Uninitialized,
}

impl NodeIdentityStatus {
    /// The wire status string.
    pub fn as_str(&self) -> &'static str {
        match self {
            NodeIdentityStatus::Ok { .. } => "ok",
            NodeIdentityStatus::Unavailable => "unavailable",
            NodeIdentityStatus::Uninitialized => "uninitialized",
        }
    }

    /// The fingerprint, when the key is available.
    pub fn fingerprint(&self) -> Option<&str> {
        match self {
            NodeIdentityStatus::Ok { fingerprint } => Some(fingerprint),
            _ => None,
        }
    }
}

impl Serialize for NodeIdentityStatus {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("NodeIdentityStatus", 2)?;
        state.serialize_field("status", self.as_str())?;
        state.serialize_field("fingerprint", &self.fingerprint())?;
        state.end()
    }
}

/// The node's static X25519 key pair.
#[derive(Clone)]
pub struct NodeIdentity {
    secret: StaticSecret,
    public: [u8; 32],
}

impl std::fmt::Debug for NodeIdentity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeIdentity")
            .field("fingerprint", &self.fingerprint())
            .finish_non_exhaustive()
    }
}

impl NodeIdentity {
    /// A fresh random identity.
    pub fn generate() -> Self {
        Self::from_secret(StaticSecret::random_from_rng(rand::rngs::OsRng))
    }

    /// An identity from raw secret bytes (clamped by X25519 on use).
    pub fn from_secret_bytes(secret: [u8; 32]) -> Self {
        let secret = Zeroizing::new(secret);
        Self::from_secret(StaticSecret::from(*secret))
    }

    fn from_secret(secret: StaticSecret) -> Self {
        let public = noise::public_key(&secret);
        Self { secret, public }
    }

    /// The public key devices pin.
    pub fn public(&self) -> [u8; 32] {
        self.public
    }

    /// The public key as unpadded base64url (the REST/BLE form).
    pub fn public_b64u(&self) -> String {
        pair_crypto::b64u_encode(&self.public)
    }

    /// `hex(SHA256(pub)[0..8])` grouped as `xxxx-xxxx-xxxx-xxxx`.
    pub fn fingerprint(&self) -> String {
        pair_crypto::fingerprint(&self.public)
    }

    /// X25519 with a peer public key; `None` for an all-zero (low-order) result.
    pub(crate) fn dh(&self, peer_public: &[u8; 32]) -> Option<Zeroizing<[u8; 32]>> {
        noise::x25519(&self.secret, peer_public).ok()
    }

    /// The static secret, for the Noise responder.
    pub(crate) fn static_secret(&self) -> StaticSecret {
        self.secret.clone()
    }

    /// The secret encoded for sealing (base64url, wrapped so it is wiped on drop).
    pub(crate) fn secret_for_sealing(&self) -> Zeroizing<String> {
        let bytes = Zeroizing::new(self.secret.to_bytes());
        Zeroizing::new(pair_crypto::b64u_encode(bytes.as_ref()))
    }

    /// Rebuild an identity from an opened secret, checking it against the stored
    /// public key.
    pub(crate) fn from_opened(
        opened: &str,
        expected_public_b64u: &str,
    ) -> Result<Self, IdentityError> {
        let bytes = pair_crypto::b64u_decode(opened)
            .map(Zeroizing::new)
            .ok_or_else(|| IdentityError::Unavailable("sealed key is not base64url".into()))?;
        let secret: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| IdentityError::Unavailable("sealed key has the wrong length".into()))?;
        let identity = Self::from_secret_bytes(secret);
        if identity.public_b64u() != expected_public_b64u {
            return Err(IdentityError::Unavailable(
                "sealed key does not match the stored public key".into(),
            ));
        }
        Ok(identity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_matches_vector() {
        // node static key from the vectors: SHA256("ryu-rhp-v1.1 test node static").
        let sk = noise::sha256(&[b"ryu-rhp-v1.1 test node static"]);
        let id = NodeIdentity::from_secret_bytes(sk);
        assert_eq!(
            hex::encode(id.public()),
            "34320797fd27003b6e3efe24dfeb45bbf66e8a8e6e2921691e014e6bbf48ab7e"
        );
        assert_eq!(id.fingerprint(), "7a7f-b905-d3ff-9444");
        assert!(!format!("{id:?}").contains(&hex::encode(sk)));
    }

    #[test]
    fn dh_rejects_low_order_and_reopen_checks_public() {
        let id = NodeIdentity::generate();
        assert!(id.dh(&[0u8; 32]).is_none());
        let sealed = id.secret_for_sealing();
        let reopened = NodeIdentity::from_opened(&sealed, &id.public_b64u()).unwrap();
        assert_eq!(reopened.public(), id.public());
        let other = NodeIdentity::generate();
        assert!(matches!(
            NodeIdentity::from_opened(&sealed, &other.public_b64u()),
            Err(IdentityError::Unavailable(_))
        ));
        assert!(NodeIdentity::from_opened("!!", &id.public_b64u()).is_err());
    }

    #[test]
    fn plaintext_sealer_roundtrips() {
        let sealer = PlaintextSealerForTests;
        let sealed = sealer.seal("abc").unwrap();
        assert_eq!(sealer.open(&sealed).unwrap(), "abc");
        assert!(sealer.open("abc").is_err());
    }

    #[test]
    fn status_serializes_with_status_tag() {
        let ok = NodeIdentityStatus::Ok {
            fingerprint: "a-b".into(),
        };
        assert_eq!(
            serde_json::to_value(ok).unwrap(),
            serde_json::json!({"status": "ok", "fingerprint": "a-b"})
        );
        assert_eq!(
            serde_json::to_value(NodeIdentityStatus::Uninitialized).unwrap(),
            serde_json::json!({"status": "uninitialized", "fingerprint": null})
        );
    }
}
