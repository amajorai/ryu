//! At-rest content sealing for an app satellite: which key it holds, and how
//! each of its stores relates to that key (the satellite key states).
//!
//! Every Rust app satellite that seals content re-exports this module as its
//! `seal_keys` (satellites never depend on `apps/core`; they reach it through
//! this crate).
//!
//! Key resolution, once per process ([`PluginKeys::resolve`]):
//!
//! 1. Core delivered the plugin subkey (`RYU_SEAL_KEY` with scope
//!    `plugin:<id>`, needs the `crypto:seal` sidecar grant) → seal;
//! 2. `RYU_MASTER_KEY` is set → this plugin's subkey of it (the key Core would
//!    deliver) → seal;
//! 3. run by Core (`RYU_PLUGIN_DATA_DIR` set) with no key: an older Core that
//!    delivers no keys → **compat mode**: a store that was never sealed keeps its
//!    plaintext behaviour (health `sealing: "waiting for a Ryu update"`); a store
//!    that holds sealed data refuses writes and keeps its data;
//! 4. standalone (no `RYU_PLUGIN_DATA_DIR`): a generated root in
//!    `<plugin data dir>/secrets/standalone-root.key` (0600).
//!
//! Standalone runs pin the root's key check value in
//! `secrets/standalone-root.kcv.json`; a later different `RYU_MASTER_KEY` or a
//! lost root file is refused instead of silently sealing under another key.
//!
//! Per store ([`PluginKeys::store_state`]): a store records the key check value
//! of the key that sealed it. A store whose recorded key is neither the current
//! nor a retired key is unhealthy and refuses writes; it is never resealed or
//! reset.

use std::path::Path;
use std::sync::OnceLock;

use anyhow::{bail, Result};
use base64::Engine as _;

use crate::{BlindIndex, ContentCipher, KcvMatch, PluginCipher};

mod files;
#[cfg(feature = "sqlite-functions")]
pub mod sql;
#[cfg(feature = "sqlite")]
mod sqlite;
mod store_seal;
#[cfg(test)]
mod tests;

pub use files::write_private_file;
use files::{load_or_create_standalone_root, pin_standalone_kcv};
#[cfg(feature = "sqlite")]
pub use sqlite::{ensure_compat_write, reopen_plaintext_items, sqlite_store_seal};
pub use store_seal::StoreSeal;

/// Env var Core sets to the plugin's data dir; its presence means "run by Core".
pub const PLUGIN_DATA_DIR_ENV: &str = "RYU_PLUGIN_DATA_DIR";
/// Operator master key (base64, 32 bytes) for runs without Core.
pub const MASTER_KEY_ENV: &str = "RYU_MASTER_KEY";
/// Standalone root key file, under `<plugin data dir>/secrets/`.
pub const STANDALONE_ROOT_FILE: &str = "standalone-root.key";
/// Key check value of the root a standalone run sealed with.
pub const STANDALONE_KCV_FILE: &str = "standalone-root.kcv.json";
/// Health text while a never-sealed store waits for a Core that delivers keys.
pub const COMPAT_HEALTH: &str = "waiting for a Ryu update";

static DELIVERED: OnceLock<bool> = OnceLock::new();

/// Read the key Core delivered and remove it from the environment. Call first
/// thing in a plain `fn main`, before the async runtime starts any thread.
pub fn capture() -> Result<bool> {
    if let Some(delivered) = DELIVERED.get() {
        return Ok(*delivered);
    }
    let delivered = crate::capture_process_seal_key()?;
    let _ = DELIVERED.set(delivered);
    Ok(delivered)
}

/// Where the root key came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeySource {
    /// Delivered by Core.
    Delivered,
    /// Derived from `RYU_MASTER_KEY`.
    Master,
    /// The standalone root file.
    Standalone,
}

/// This process's keys, resolved once at startup.
#[derive(Clone)]
pub struct PluginKeys {
    cipher: Option<PluginCipher>,
    source: Option<KeySource>,
}

impl std::fmt::Debug for PluginKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginKeys")
            .field("source", &self.source)
            .finish_non_exhaustive()
    }
}

impl PluginKeys {
    /// Resolve the process's key (see the module docs). `data_dir` is the
    /// plugin data dir (`secrets/` lives under it for standalone runs).
    pub fn resolve(plugin_id: &str, data_dir: &Path) -> Result<Self> {
        let delivered = capture()?;
        let under_core = std::env::var(PLUGIN_DATA_DIR_ENV)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let has_master = std::env::var(MASTER_KEY_ENV)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        Self::resolve_with(
            plugin_id,
            data_dir,
            delivered,
            under_core,
            has_master,
            || crate::plugin_cipher_for_process(plugin_id),
        )
    }

    /// [`Self::resolve`] for a second process sharing the store (an IDE's
    /// `mcp` server, a CLI run): it never generates a standalone root, so it
    /// cannot seal under a key the main sidecar does not hold. Without a
    /// delivered key, `RYU_MASTER_KEY` or an existing root file it runs in
    /// compat mode (a sealed store then refuses writes and sealed reads).
    pub fn resolve_existing(plugin_id: &str, data_dir: &Path) -> Result<Self> {
        let delivered = capture()?;
        let has_master = std::env::var(MASTER_KEY_ENV)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let has_root = data_dir.join("secrets").join(STANDALONE_ROOT_FILE).exists();
        if !delivered && !has_master && !has_root {
            return Ok(Self::compat());
        }
        Self::resolve(plugin_id, data_dir)
    }

    /// [`Self::resolve`] with every input explicit (tests).
    pub fn resolve_with(
        plugin_id: &str,
        data_dir: &Path,
        delivered: bool,
        under_core: bool,
        has_master: bool,
        process_cipher: impl FnOnce() -> Result<PluginCipher>,
    ) -> Result<Self> {
        if delivered {
            return Ok(Self::sealing(process_cipher()?, KeySource::Delivered));
        }
        let secrets = data_dir.join("secrets");
        if has_master {
            let cipher = process_cipher()?;
            if !under_core {
                if secrets.join(STANDALONE_ROOT_FILE).exists() {
                    bail!(
                        "this app's standalone data was sealed under {STANDALONE_ROOT_FILE}; \
                         unset {MASTER_KEY_ENV} or move that data aside"
                    );
                }
                pin_standalone_kcv(&secrets, &cipher.kcv(), "master")?;
            }
            return Ok(Self::sealing(cipher, KeySource::Master));
        }
        if under_core {
            tracing::warn!(
                plugin = %plugin_id,
                "no sealing key delivered (an older Ryu, or the crypto:seal grant is missing); \
                 stores that were never sealed keep working unsealed"
            );
            return Ok(Self::compat());
        }
        let root = load_or_create_standalone_root(&secrets)?;
        let cipher = PluginCipher::from_subkey_b64(
            plugin_id,
            &base64::engine::general_purpose::STANDARD.encode(root),
        )?;
        pin_standalone_kcv(&secrets, &cipher.kcv(), "standalone")?;
        Ok(Self::sealing(cipher, KeySource::Standalone))
    }

    /// Keys over an explicit plugin cipher (tests and fixtures).
    pub fn sealing(cipher: PluginCipher, source: KeySource) -> Self {
        Self {
            cipher: Some(cipher),
            source: Some(source),
        }
    }

    /// No key: compat mode.
    pub fn compat() -> Self {
        Self {
            cipher: None,
            source: None,
        }
    }

    /// Whether a key is held.
    pub fn can_seal(&self) -> bool {
        self.cipher.is_some()
    }

    /// Where the key came from (`None` in compat mode).
    pub fn source(&self) -> Option<KeySource> {
        self.source
    }

    /// The plugin cipher (`encp:v1:` secrets and content subkeys; `None` in
    /// compat mode).
    pub fn plugin_cipher(&self) -> Option<&PluginCipher> {
        self.cipher.as_ref()
    }
    /// The content cipher of `store` (`None` in compat mode).
    pub fn content_cipher(&self, store: &str) -> Option<ContentCipher> {
        self.cipher
            .as_ref()
            .map(|cipher| cipher.content_cipher(store))
    }

    /// The blind index of `(store, field)` (`None` in compat mode).
    pub fn blind_index(&self, store: &str, field: &str) -> Option<BlindIndex> {
        self.cipher
            .as_ref()
            .map(|cipher| cipher.blind_index(store, field))
    }

    /// Classify one store from the key check value it recorded (`None` when it
    /// never recorded one) and whether it holds any sealed value.
    pub fn store_state(
        &self,
        store: &str,
        recorded_kcv: Option<&str>,
        holds_sealed: bool,
    ) -> StoreSeal {
        match self.content_cipher(store) {
            Some(cipher) => match recorded_kcv {
                None => StoreSeal::Sealing(cipher),
                Some(recorded) => match cipher.match_kcv(recorded) {
                    KcvMatch::Current | KcvMatch::Retired => StoreSeal::Sealing(cipher),
                    KcvMatch::Unknown => StoreSeal::mismatch(store),
                },
            },
            None if recorded_kcv.is_some() || holds_sealed => StoreSeal::Unhealthy(format!(
                "{store} holds sealed data but this process has no key; writes are refused \
                 and the data is kept"
            )),
            None => StoreSeal::Compat,
        }
    }
}
