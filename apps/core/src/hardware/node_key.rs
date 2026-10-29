//! Core's at-rest sealer for the hardware node identity (RHP v1.1 design §7).
//!
//! The `ryu-hardware` crate generates the node's static X25519 key lazily and
//! stores it sealed in `hardware.db`; it has zero dependency on `apps/core`, so the
//! host supplies the sealing through [`ryu_hardware::identity::NodeKeySealer`].
//! Core seals with the same process-wide field cipher every other secret column
//! uses ([`ryu_crypto::global_cipher`]), so the key is protected by the node's
//! master key and is unreadable without it. A key that cannot be opened is
//! reported as unavailable by the crate and is never regenerated silently.

use anyhow::Context;
use ryu_crypto::FieldCipher;
use ryu_hardware::identity::NodeKeySealer;

/// Seals the node key with Core's at-rest cipher.
#[derive(Clone, Default)]
pub struct CoreNodeKeySealer {
    /// An explicit cipher (tests); `None` resolves the global master-key cipher
    /// on every call, so a key loaded after boot is still honoured.
    cipher: Option<FieldCipher>,
}

impl CoreNodeKeySealer {
    /// The production sealer, backed by [`ryu_crypto::global_cipher`].
    pub fn global() -> Self {
        Self { cipher: None }
    }

    /// A sealer over an explicit cipher.
    #[cfg(test)]
    pub fn with_cipher(cipher: FieldCipher) -> Self {
        Self {
            cipher: Some(cipher),
        }
    }

    fn cipher(&self) -> anyhow::Result<FieldCipher> {
        match &self.cipher {
            Some(cipher) => Ok(cipher.clone()),
            None => ryu_crypto::global_cipher().context("loading the at-rest cipher"),
        }
    }
}

impl std::fmt::Debug for CoreNodeKeySealer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreNodeKeySealer")
            .field("explicit_cipher", &self.cipher.is_some())
            .finish()
    }
}

impl NodeKeySealer for CoreNodeKeySealer {
    fn seal(&self, plaintext: &str) -> anyhow::Result<String> {
        self.cipher()?
            .seal(plaintext)
            .context("sealing the hardware node key")
    }

    fn open(&self, stored: &str) -> anyhow::Result<String> {
        self.cipher()?
            .open(stored)
            .context("opening the hardware node key")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens_without_storing_plaintext() {
        let sealer = CoreNodeKeySealer::with_cipher(FieldCipher::new(&[7u8; 32]));
        let secret = "c2VjcmV0LW5vZGUta2V5";
        let sealed = sealer.seal(secret).unwrap();
        assert!(!sealed.contains(secret));
        assert_eq!(sealer.open(&sealed).unwrap(), secret);
    }

    #[test]
    fn a_different_key_cannot_open() {
        let sealed = CoreNodeKeySealer::with_cipher(FieldCipher::new(&[7u8; 32]))
            .seal("node-secret")
            .unwrap();
        let other = CoreNodeKeySealer::with_cipher(FieldCipher::new(&[8u8; 32]));
        assert!(other.open(&sealed).is_err());
    }

    #[tokio::test]
    async fn backs_the_device_store_identity() {
        let path = std::env::temp_dir()
            .join(format!("ryu-core-node-key-{}", uuid::Uuid::new_v4()))
            .join("hardware.db");
        let store = ryu_hardware::DeviceStore::open(path.clone()).unwrap();
        store.set_key_sealer(std::sync::Arc::new(CoreNodeKeySealer::with_cipher(
            FieldCipher::new(&[3u8; 32]),
        )));
        let first = store.node_identity().await.unwrap();

        // A fresh handle over the same db opens the sealed key.
        let reopened = ryu_hardware::DeviceStore::open(path).unwrap();
        reopened.set_key_sealer(std::sync::Arc::new(CoreNodeKeySealer::with_cipher(
            FieldCipher::new(&[3u8; 32]),
        )));
        let second = reopened.node_identity().await.unwrap();
        assert_eq!(first.public(), second.public());
    }
}
