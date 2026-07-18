//! Core's implementation of the extracted [`ryu_crypto::CryptoHost`] seam.
//!
//! The `ryu-crypto` crate owns the encryption-at-rest primitive — the
//! `FieldCipher` AEAD, the `enc:v1:` envelope, and the master-key custody ladder
//! (env → OS keychain → file fallback, with legacy `memory.key` migration). What
//! it cannot own — because they are kernel utilities — are the two couplings the
//! key resolver needs: the profile-scoped keychain-account suffix
//! ([`crate::profile::suffix`]) and the active `~/.ryu` data dir
//! ([`crate::paths::ryu_dir`]). This shim implements those two, and Core installs
//! it once at boot via [`ryu_crypto::set_global_host`], BEFORE the first store
//! opens (`ConversationStore::open_default`), so `global_cipher()` never races
//! the install.

use std::path::PathBuf;

use ryu_crypto::CryptoHost;

/// Install [`CoreCryptoHost`] as the process-global crypto host. Idempotent (a
/// second call is a no-op). Called once from `main` at boot, before the first
/// store opens; also from the `#[cfg(test)]` in-memory store constructors, since
/// unit tests never run `main` yet still seal/open at-rest state through the real
/// `global_cipher()` (the host resolves profile + `~/.ryu`, which work fine in a
/// test binary — behaviour identical to before the crypto extraction).
pub fn install() {
    ryu_crypto::set_global_host(std::sync::Arc::new(CoreCryptoHost));
}

/// Core's `CryptoHost` — the kernel side of the crypto seam.
pub struct CoreCryptoHost;

impl CryptoHost for CoreCryptoHost {
    fn keyring_account_suffix(&self) -> String {
        crate::profile::suffix()
    }

    fn ryu_dir(&self) -> PathBuf {
        crate::paths::ryu_dir()
    }
}
