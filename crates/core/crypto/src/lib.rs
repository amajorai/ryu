//! Shared encryption-at-rest primitive for Ryu (`crates/ryu-crypto`).
//!
//! One crypto path everything hangs off (see `docs/encryption-at-rest.md`). It
//! provides:
//!
//! * [`FieldCipher`] — a ChaCha20-Poly1305 AEAD with a self-describing field
//!   envelope (`enc:v1:<base64(nonce||ciphertext)>`) plus low-level
//!   `encrypt`/`decrypt` for blob columns. [`FieldCipher::open`] transparently
//!   passes through *legacy plaintext* (anything without the `enc:v1:` prefix),
//!   so already-stored rows keep working and upgrade to ciphertext on next write.
//! * [`TenantCipher`] — the bound `enc:v2:` envelope for multi-tenant stores: a
//!   per-tenant HKDF subkey plus AEAD associated data ([`SealContext`]) naming the
//!   record and field, so ciphertext moved between rows or tenants fails to open.
//!   Additive: the `enc:v1:` API above is unchanged.
//! * A swappable **master key** ([`global_cipher`]) resolved, in priority order,
//!   from `RYU_MASTER_KEY` (env) → the OS keychain (default) → a `~/.ryu` file
//!   fallback. The key lives *outside* the data it protects (keychain), so a copy
//!   of `~/.ryu` alone cannot decrypt. Headless-safe: no source prompts.
//!
//! Placement (Core vs Gateway, AGENTS.md §1): at-rest encryption of local
//! orchestration data is part of *what runs*, so it lives in Core. The Gateway's
//! firewall/DLP governs *what is allowed/shared* on egress — a separate layer.
//!
//! ## Kernel seam ([`CryptoHost`])
//!
//! This crate has ZERO dependency on `apps/core`. The two things it needs from
//! the kernel — the profile-scoped keychain-account suffix and the `~/.ryu` data
//! dir — invert through the narrow [`CryptoHost`] trait. Core implements it once
//! (`crate::crypto_host::CoreCryptoHost`) and installs it at boot via
//! [`set_global_host`], BEFORE the first store opens. Key-custody policy
//! (env/keychain/file, legacy migration) stays in-crate; the internal `Keychain`
//! port is the swap seam for a future local-key→KMS backend.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

mod app_key;
pub mod blind_index;
pub mod content;
#[cfg(feature = "sqlite")]
pub mod content_sqlite;
pub mod custody;
pub mod plugin_keys;
mod process_keys;
mod sealed;
pub mod sealed_file;
pub mod sealed_log;
pub mod secret_file;
pub mod vector_index;
#[cfg(test)]
mod vectors_test;

pub use app_key::{app_cipher, app_keys};
pub use blind_index::{
    blind_index, casefold, component_blind_index_for_process, normalize_email,
    plugin_blind_index_for_process, tokenize_terms, BlindIndex,
};
pub use content::{
    app_content_cipher, app_webview_key_bytes, app_webview_keys,
    component_content_cipher_for_process, content_cipher, key_check_value, plugin_content_cipher,
    plugin_content_cipher_for_process, ContentCipher, ContentContext, ContentSealError, KcvMatch,
    OpenedBytes, WebviewKeys, COMPAT_ESCAPE,
};
pub use custody::{master_key_health, KeyProbe, MasterKeyHealth};
pub use sealed_file::{ensure_free_space, seal_file_in_place, SealedFileReader, SealedFileWriter};
pub use sealed_log::SealedLogWriter;
pub use vector_index::{TopK, VectorCoverage, VectorIndex};

pub use process_keys::{
    capture_process_seal_key, component_child_env, component_cipher, component_cipher_for_process,
    components, looks_sealed, plugin_child_env, plugin_cipher_for_process, scrub_seal_env,
    ComponentCipher, KeyScope, SEAL_ENV_VARS, SEAL_KEY_ENV, SEAL_RETIRED_KEYS_ENV, SEAL_SCOPE_ENV,
};
pub use sealed::{
    install_standalone_host, open_str, open_str_tracking, redact, seal_str, GatewayScope,
    MasterScope, Opened, SealScope, SealedString, SecretSealer, StandaloneCryptoHost,
};
pub use secret_file::{read_secret_file, reseal_secret_file, write_secret_file};

use ryu_sidecar_runtime::layout;

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;

/// Field-envelope prefix. Versioned so the scheme can evolve without ambiguity.
const ENVELOPE_PREFIX: &str = "enc:v1:";
/// Field-envelope prefix for values sealed with a **per-plugin subkey**
/// ([`plugin_cipher`]) rather than the master key.
///
/// Deliberately distinct from [`ENVELOPE_PREFIX`]: plugin-sealed values live in
/// the same `TEXT` columns as master-key-sealed ones, and a single prefix would
/// make the two indistinguishable — opening a subkey-sealed value with
/// [`global_cipher`] would surface as an ambiguous auth-tag failure instead of
/// "this isn't yours". The distinct prefix lets a reader separate the three cases
/// it must handle: legacy plaintext (return verbatim), sealed-with-my-subkey
/// (open), sealed-but-not-mine (fail loudly).
const PLUGIN_ENVELOPE_PREFIX: &str = "encp:v1:";
/// Field-envelope prefix for values sealed by a [`TenantCipher`]: a per-tenant
/// subkey plus AEAD associated data naming the record and field the value was
/// written for (see [`SealContext`]).
///
/// Distinct from [`ENVELOPE_PREFIX`] for the same reason `encp:v1:` is: an
/// unbound reader must not mistake a bound value for its own, and a bound reader
/// must be able to tell a legacy value (no binding at all) from a bound value
/// that fails to verify (moved, or sealed for someone else).
const BOUND_ENVELOPE_PREFIX: &str = "enc:v2:";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// HKDF salt for per-plugin subkey derivation. A fixed, non-secret domain
/// separator (HKDF's salt is not required to be secret); the per-plugin
/// separation comes from the `info` string, not this.
const PLUGIN_KDF_SALT: &[u8] = b"ryu-plugin-crypto-v1";
/// HKDF `info` prefix for per-plugin subkey derivation. The plugin's canonical id
/// is appended to bind the subkey to exactly one plugin.
const PLUGIN_KDF_INFO_PREFIX: &[u8] = b"ryu-plugin-crypto-v1:";

/// HKDF salt for per-tenant subkey derivation ([`TenantCipher`]). Non-secret and
/// distinct from [`PLUGIN_KDF_SALT`], so a tenant id can never derive the same
/// subkey as a plugin id with the same spelling.
const TENANT_KDF_SALT: &[u8] = b"ryu-tenant-crypto-v2";
/// HKDF `info` prefix for per-tenant subkeys; the tenant id is appended.
const TENANT_KDF_INFO_PREFIX: &[u8] = b"ryu-tenant-crypto-v2:";
/// Leading label of every `enc:v2:` associated-data string, so the AAD of this
/// scheme can never collide with an AAD some other scheme builds.
const BOUND_AAD_LABEL: &[u8] = b"ryu-bound-seal-v2";

/// OS keychain coordinates for the master key.
const KEYRING_SERVICE: &str = "ryu";
/// Base keychain account for the master key. The *resolved* account is
/// profile-suffixed via [`CryptoHost::keyring_account_suffix`] so a dev stack and
/// a release stack never share the DB-encryption key on one machine.
const KEYRING_ACCOUNT: &str = "master-key";

/// Compute HMAC-SHA256 over arbitrary bytes and return lowercase hexadecimal.
/// This is the shared webhook/signature primitive; app satellites must not copy
/// the block-padding construction into their own request handlers.
pub fn hmac_sha256_hex(key: &[u8], message: &[u8]) -> String {
    use hmac::{Hmac, Mac};

    type HmacSha256 = Hmac<sha2::Sha256>;
    let mut mac = <HmacSha256 as Mac>::new_from_slice(key).expect("HMAC accepts every key length");
    mac.update(message);
    hex::encode(mac.finalize().into_bytes())
}

/// Lowercase hexadecimal SHA-256 of arbitrary bytes. Shared so services that
/// compare digests of bearers (for example the hosted billing status feed)
/// need no hashing dependency of their own.
pub fn sha256_hex(message: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(message))
}

/// Env override carrying a base64-encoded 32-byte master key (for
/// servers/containers/CI, or operator-controlled key injection).
const ENV_MASTER_KEY: &str = "RYU_MASTER_KEY";
/// Explicit headless/test switch. The default remains keychain-first; `off`
/// selects the file fallback without touching the OS credential store.
const ENV_KEYCHAIN: &str = "RYU_KEYCHAIN";

// ── Kernel seam ──────────────────────────────────────────────────────────────

/// The narrow seam this crate needs from `apps/core`'s kernel machinery. It
/// carries ONLY the two profile/path couplings the master-key resolver uses: the
/// profile-scoped keychain-account suffix (`RYU_PROFILE`) and the active `~/.ryu`
/// data dir (where the file-fallback + legacy memory keys live). `apps/core`
/// implements this in its `crypto_host` shim and installs it once at boot via
/// [`set_global_host`], before the first store opens.
pub trait CryptoHost: Send + Sync {
    /// The profile-scoped keychain-account suffix: `""` on the release profile
    /// (byte-identical to a single-stack machine), `"-<profile>"` otherwise
    /// (e.g. `"-dev"`), so a dev stack and a release stack never share the
    /// DB-encryption key slot on one machine.
    fn keyring_account_suffix(&self) -> String;

    /// The active Ryu data dir (`~/.ryu`, or its profile/relocation variant)
    /// where the file-fallback master key and the legacy `memory.key` live.
    fn ryu_dir(&self) -> PathBuf;

    /// Whether the master key may live in `master.key` inside [`Self::ryu_dir`]
    /// — the degraded custody path where a copy of the data dir alone decrypts
    /// it. Defaults to `true` (Core's long-standing behavior). A host that
    /// requires external custody returns `false`: resolution then fails closed
    /// instead of reading, generating, or writing a file key, so the operator
    /// must supply `RYU_MASTER_KEY` or a writable OS keychain.
    fn allow_file_key(&self) -> bool {
        true
    }

    /// Whether this host owns the data folder's key record: it writes
    /// `state/master-key.kcv` the first time it resolves the master key (after
    /// [`Self::probe_master_key`] passes) and the data-format marker before the
    /// first content migration. Core returns `true`; other processes sharing the
    /// folder (desktop shell, standalone Gateway, CLI tools) only CHECK the
    /// record. Defaults to `false`.
    fn records_kcv(&self) -> bool {
        false
    }

    /// Test a candidate master key against data already sealed in the folder
    /// (Core opens up to three sealed message bodies). Defaults to
    /// [`custody::KeyProbe::NoSealedData`].
    fn probe_master_key(&self, _cipher: &FieldCipher) -> custody::KeyProbe {
        custody::KeyProbe::NoSealedData
    }

    /// A short reason when the folder holds sealed data (so a new master key must
    /// never be generated), `None` when it holds none. The crate also checks the
    /// recorded key check value, the retired-key index and (feature `sqlite`)
    /// every `db/*.db` content-seal record. Defaults to `None`.
    fn sealed_data_evidence(&self) -> Option<String> {
        None
    }
}

/// Process-global crypto host, installed once at boot by `apps/core`.
fn host_slot() -> &'static OnceLock<Arc<dyn CryptoHost>> {
    static HOST: OnceLock<Arc<dyn CryptoHost>> = OnceLock::new();
    &HOST
}

/// Install the host implementation. Called once from `apps/core` at startup,
/// unconditionally and BEFORE the first store opens (crypto is a non-optional
/// dep — the session/chat loop and long-term memory encrypt every row in every
/// build, including the lean one). Idempotent: a second call is ignored.
pub fn set_global_host(host: Arc<dyn CryptoHost>) {
    let _ = host_slot().set(host);
}

/// Fetch the installed host, erroring if [`set_global_host`] was never called.
fn host() -> Result<Arc<dyn CryptoHost>> {
    host_slot()
        .get()
        .cloned()
        .ok_or_else(|| anyhow!("crypto host not initialized"))
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// A reusable AEAD cipher backed by a 32-byte master key. Cheap to clone.
#[derive(Clone)]
pub struct FieldCipher {
    cipher: Arc<ChaCha20Poly1305>,
    /// Retired master keys: tried, in order, when the current key fails to
    /// decrypt. Never used to seal.
    retired: Arc<Vec<ChaCha20Poly1305>>,
}

impl FieldCipher {
    /// Build a cipher from an explicit 32-byte key (used by the global loader and
    /// by tests). Production code should use [`global_cipher`].
    pub fn new(key: &[u8; KEY_LEN]) -> Self {
        let key = Key::from_slice(key);
        Self {
            cipher: Arc::new(ChaCha20Poly1305::new(key)),
            retired: Arc::new(Vec::new()),
        }
    }

    /// The same cipher, also opening values sealed under `retired` keys (they
    /// open with `needs_reseal = true` through [`Self::open_detailed`]).
    #[must_use]
    pub fn with_retired(mut self, retired: &[[u8; KEY_LEN]]) -> Self {
        self.retired = Arc::new(
            retired
                .iter()
                .map(|key| ChaCha20Poly1305::new(Key::from_slice(key)))
                .collect(),
        );
        self
    }

    /// Decrypt with the current key, then each retired key. The flag is true
    /// when a retired key opened it.
    fn decrypt_tracking(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<(Vec<u8>, bool)> {
        if nonce.len() != NONCE_LEN {
            anyhow::bail!("invalid nonce length {}", nonce.len());
        }
        let nonce = Nonce::from_slice(nonce);
        if let Ok(plain) = self.cipher.decrypt(nonce, ciphertext) {
            return Ok((plain, false));
        }
        for retired in self.retired.iter() {
            if let Ok(plain) = retired.decrypt(nonce, ciphertext) {
                return Ok((plain, true));
            }
        }
        Err(anyhow::anyhow!("decryption failed: aead::Error"))
    }

    /// Open a stored `enc:v1:` field, reporting whether it should be sealed
    /// again: legacy plaintext (non-empty) or a value only a retired key opened.
    pub fn open_detailed(&self, stored: &str) -> Result<Opened> {
        let Some(encoded) = stored.strip_prefix(ENVELOPE_PREFIX) else {
            return Ok(Opened {
                value: stored.to_owned(),
                needs_reseal: !stored.is_empty(),
            });
        };
        let blob = b64()
            .decode(encoded.trim())
            .context("decoding sealed field")?;
        if blob.len() < NONCE_LEN {
            anyhow::bail!("sealed field shorter than nonce");
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let (plain, retired) = self.decrypt_tracking(nonce, ciphertext)?;
        Ok(Opened {
            value: String::from_utf8_lossy(&plain).into_owned(),
            needs_reseal: retired,
        })
    }

    /// Encrypt raw bytes, returning `(nonce, ciphertext)`. Low-level entry point
    /// for blob columns (e.g. the long-term memory store).
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| anyhow::anyhow!("encryption failed: {e}"))?;
        Ok((nonce_bytes.to_vec(), ciphertext))
    }

    /// Decrypt a `(nonce, ciphertext)` pair produced by [`Self::encrypt`]. Falls
    /// back to retired keys (see [`Self::with_retired`]) on an AEAD failure.
    pub fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        self.decrypt_tracking(nonce, ciphertext)
            .map(|(plain, _)| plain)
    }

    /// [`Self::encrypt`] with AEAD associated data, returned as one
    /// `nonce||ciphertext` blob. Private: [`TenantCipher`] owns the AAD layout.
    fn encrypt_blob_with_aad(&self, plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
        use chacha20poly1305::aead::Payload;
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad,
                },
            )
            .map_err(|e| anyhow::anyhow!("encryption failed: {e}"))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        Ok(blob)
    }

    /// Open a `nonce||ciphertext` blob sealed by [`Self::encrypt_blob_with_aad`].
    /// `None` means the tag did not verify for this key and associated data.
    fn decrypt_blob_with_aad(&self, blob: &[u8], aad: &[u8]) -> Option<Vec<u8>> {
        use chacha20poly1305::aead::Payload;
        if blob.len() < NONCE_LEN {
            return None;
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        self.cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: ciphertext,
                    aad,
                },
            )
            .ok()
    }

    /// Seal a string field into the `enc:v1:` envelope for storage in a `TEXT`
    /// column. The nonce is prepended to the ciphertext, then base64-encoded.
    pub fn seal(&self, plaintext: &str) -> Result<String> {
        self.seal_with_prefix(ENVELOPE_PREFIX, plaintext)
    }

    /// Seal under an explicit envelope prefix. Private because the prefix is a
    /// *scheme* choice, not a caller choice: [`seal`](Self::seal) owns
    /// `enc:v1:` (master key) and [`PluginCipher`] owns `encp:v1:` (subkey).
    fn seal_with_prefix(&self, prefix: &str, plaintext: &str) -> Result<String> {
        let (nonce, ciphertext) = self.encrypt(plaintext.as_bytes())?;
        let mut blob = Vec::with_capacity(nonce.len() + ciphertext.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ciphertext);
        Ok(format!("{prefix}{}", b64().encode(blob)))
    }

    /// Decrypt the base64 `nonce||ciphertext` body of an envelope (prefix already
    /// stripped). Shared by both envelope schemes.
    fn open_body(&self, encoded: &str) -> Result<String> {
        let blob = b64()
            .decode(encoded.trim())
            .context("decoding sealed field")?;
        if blob.len() < NONCE_LEN {
            anyhow::bail!("sealed field shorter than nonce");
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let plain = self.decrypt(nonce, ciphertext)?;
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }

    /// Open a stored field. If it carries the `enc:v1:` prefix it is decrypted;
    /// otherwise it is treated as **legacy plaintext** and returned verbatim. This
    /// is what makes migration lazy: reads accept both forms, writes upgrade.
    pub fn open(&self, stored: &str) -> Result<String> {
        let Some(encoded) = stored.strip_prefix(ENVELOPE_PREFIX) else {
            return Ok(stored.to_string());
        };
        self.open_body(encoded)
    }

    /// Whether a stored value is already sealed (carries the envelope prefix).
    pub fn is_sealed(stored: &str) -> bool {
        stored.starts_with(ENVELOPE_PREFIX)
    }
}

/// The process-wide cipher backed by the resolved master key. Lazily initialized
/// on first use from the configured key source.
static GLOBAL: OnceLock<FieldCipher> = OnceLock::new();

/// Which of the three custody paths the process-wide key ACTUALLY came from.
/// Set together with [`GLOBAL`], so it always describes the key in use rather
/// than a configured preference — the two diverge, since a headless box that
/// cannot reach a keychain lands on `File` with no configuration change at all.
static GLOBAL_SOURCE: OnceLock<MasterKeySource> = OnceLock::new();

/// Where the resolved master key came from, in the resolver's priority order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MasterKeySource {
    /// `RYU_MASTER_KEY` — operator-injected, never written to disk by us.
    Env,
    /// The OS keychain (Windows Credential Manager / macOS Keychain / Linux
    /// Secret Service). The key lives OUTSIDE the data dir it protects.
    Keychain,
    /// `<data dir>/secrets/master.key` — the degraded fallback, used when no keychain is
    /// reachable or writable. The key sits NEXT TO the data it protects, so a
    /// copy of the data dir alone is enough to decrypt it.
    File,
}

impl MasterKeySource {
    /// Stable wire name for the HTTP/status surface.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Env => "env",
            Self::Keychain => "keychain",
            Self::File => "file",
        }
    }
}

/// Non-secret description of master-key custody, for status/diagnostic surfaces.
/// Deliberately carries NO key material — not the key, not a prefix, not a hash.
pub struct KeyCustody {
    /// The custody path the running process resolved to.
    pub source: MasterKeySource,
    /// Env var consulted first (reported so a UI can name the override).
    pub env_var: &'static str,
    /// Keychain service name for the master-key slot.
    pub keychain_service: &'static str,
    /// Profile-scoped keychain account (`master-key` / `master-key-dev`).
    pub keychain_account: String,
    /// Path of the file-fallback key — `Some` ONLY when it is the live source,
    /// so the UI can point at the exact file that weakens the guarantee.
    pub key_file: Option<PathBuf>,
    /// Whether a legacy `memory.key` is still present in the data dir.
    pub legacy_memory_key_present: bool,
}

/// Describe how the running process holds its at-rest master key. Resolves the
/// key first (via [`global_cipher`]) so the answer reflects the key actually in
/// use; returns an error when the key cannot be loaded at all (same fail-closed
/// posture as every store).
pub fn key_custody() -> Result<KeyCustody> {
    // Force resolution so `GLOBAL_SOURCE` is populated. Cheap after first call.
    let _ = global_cipher()?;
    let host = host()?;
    let paths = default_key_paths(&*host);
    let source = *GLOBAL_SOURCE
        .get()
        .ok_or_else(|| anyhow::anyhow!("master key source not recorded"))?;
    Ok(KeyCustody {
        source,
        env_var: ENV_MASTER_KEY,
        keychain_service: KEYRING_SERVICE,
        keychain_account: format!("{KEYRING_ACCOUNT}{}", host.keyring_account_suffix()),
        key_file: match source {
            MasterKeySource::File => Some(
                GLOBAL_KEY
                    .get()
                    .and_then(|key| key_file_copy(key, &paths))
                    .unwrap_or_else(|| paths.master.clone()),
            ),
            _ => None,
        },
        legacy_memory_key_present: paths.legacy_memory.exists(),
    })
}

/// Return the process-wide [`FieldCipher`]. The master key is resolved once
/// (env → keychain → file) and cached.
///
/// **Fails closed.** If the master key cannot be loaded this returns an error
/// rather than silently using an ephemeral key — using a throwaway key would make
/// every existing encrypted row unreadable *and* write new rows that die on the
/// next restart, i.e. silent data corruption. Refusing to open the store is the
/// safer failure. The file fallback generates+persists a key on first use, so this
/// only errors on a genuine filesystem failure.
pub fn global_cipher() -> Result<FieldCipher> {
    if let Some(cipher) = GLOBAL.get() {
        return Ok(cipher.clone());
    }
    let host = host()?;
    let resolution = match custody::resolve_for_host(&*host) {
        Ok(resolution) => resolution,
        Err(error) => {
            if error.downcast_ref::<custody::KeyMismatch>().is_some() {
                custody::set_health(custody::MasterKeyHealth::Mismatch);
            }
            return Err(error.context("loading the at-rest master key"));
        }
    };
    if let custody::MasterKeyHealth::RecoveredFrom(from) = &resolution.health {
        tracing::warn!(
            "master key: recovered from {from}; run `ryu-core keys status` and `keys adopt` to \
             make the custody permanent"
        );
    }
    custody::set_health(resolution.health.clone());
    let (key, source) = (resolution.key, resolution.source);
    let cipher = FieldCipher::new(&key).with_retired(&resolution.retired);
    // Retired keys first: `resolved_master_and_retired` reads them after
    // observing `GLOBAL_KEY`.
    let _ = RETIRED_KEYS.set(resolution.retired);
    // ORDER MATTERS. `GLOBAL_KEY` is set BEFORE `GLOBAL`, because the early return
    // above keys off `GLOBAL` alone: a thread that observes `GLOBAL` set must also
    // observe `GLOBAL_KEY` set, or `plugin_cipher` (which forces resolution through
    // here, then reads `GLOBAL_KEY`) could race to a spurious "master key not
    // recorded". `OnceLock`'s release/acquire ordering makes this order sufficient.
    let _ = GLOBAL_KEY.set(key);
    // First writer wins; a lost race just drops a duplicate equal cipher.
    let _ = GLOBAL.set(cipher.clone());
    let _ = GLOBAL_SOURCE.set(effective_source(source, &key, &default_key_paths(&*host)));
    Ok(cipher)
}

/// The data-folder file (`secrets/master.key`, then the legacy `memory.key`)
/// that holds a copy of `key`, if any.
fn key_file_copy(key: &[u8; KEY_LEN], paths: &KeyPaths) -> Option<PathBuf> {
    [&paths.master, &paths.legacy_memory]
        .into_iter()
        .find(|path| matches!(read_key_file(path), Ok(Some(copy)) if copy == *key))
        .cloned()
}

/// The custody to REPORT for a resolved key. Keychain custody means the key
/// lives outside the data folder; a key file adopted into the keychain is kept
/// as a recovery copy (deleting the only on-disk copy would make a keychain that
/// later loses its entry unrecoverable), so while a copy of the same key sits
/// in the data folder the honest custody is `file`. Removing the file (after
/// `ryu-core keys status` shows the keychain holding the same fingerprint)
/// upgrades the report to `keychain`.
pub(crate) fn effective_source(
    source: MasterKeySource,
    key: &[u8; KEY_LEN],
    paths: &KeyPaths,
) -> MasterKeySource {
    if source == MasterKeySource::Keychain && key_file_copy(key, paths).is_some() {
        MasterKeySource::File
    } else {
        source
    }
}

/// Seal the active master key into an encrypted disaster-recovery archive.
/// This is host-only: never expose it through plugin crypto, HTTP or logs.
/// The wrapping cipher must use the operator's separate backup recovery key.
pub fn seal_backup_master_key(wrapping_cipher: &FieldCipher) -> Result<String> {
    let _ = global_cipher()?;
    let key = GLOBAL_KEY.get().context("master key not recorded")?;
    wrapping_cipher.seal(&base64::engine::general_purpose::STANDARD.encode(key))
}

// ── Per-plugin subkeys (the opt-in sealing primitive) ─────────────────────────

/// A cipher bound to ONE plugin, derived from the master key and usable only by
/// that plugin. Handed out by [`plugin_cipher`]; carries no key material a caller
/// can read, which is the point — an app seals and opens its own data without the
/// key ever crossing the sandbox boundary.
///
/// **Isolation.** Two plugins get two different subkeys, so app B opening app A's
/// ciphertext is an AEAD authentication failure, not a decrypt. That is enforced
/// by the KDF, not by a check a caller could skip.
#[derive(Clone)]
pub struct PluginCipher {
    inner: FieldCipher,
    plugin_id: String,
    /// The subkey, kept to derive this plugin's content keys and blind indexes.
    subkey: [u8; KEY_LEN],
    /// This plugin's subkeys under retired master keys: open only, never seal.
    retired: Vec<[u8; KEY_LEN]>,
}

impl PluginCipher {
    /// The plugin this cipher is bound to (diagnostics; carries no key material).
    pub fn plugin_id(&self) -> &str {
        &self.plugin_id
    }

    /// Seal a string into the `encp:v1:` envelope under this plugin's subkey.
    pub fn seal(&self, plaintext: &str) -> Result<String> {
        self.inner
            .seal_with_prefix(PLUGIN_ENVELOPE_PREFIX, plaintext)
    }

    /// Open a value sealed by [`Self::seal`].
    ///
    /// Three cases, matching the lazy-migration convention the rest of the crate
    /// uses:
    /// * carries `encp:v1:` → decrypt (fails if it was sealed by a *different*
    ///   plugin — the AEAD tag will not verify);
    /// * carries the master-key `enc:v1:` prefix → refuse loudly, because that
    ///   value is not this plugin's to read;
    /// * anything else → legacy plaintext, returned verbatim, so a store that
    ///   predates opt-in keeps reading and upgrades on next write.
    pub fn open(&self, stored: &str) -> Result<String> {
        if let Some(encoded) = stored.strip_prefix(PLUGIN_ENVELOPE_PREFIX) {
            return self.inner.open_body(encoded).with_context(|| {
                format!(
                    "opening a value sealed for a different plugin than '{}'",
                    self.plugin_id
                )
            });
        }
        if stored.starts_with(ENVELOPE_PREFIX) {
            anyhow::bail!(
                "value is sealed with the master key, not plugin '{}''s subkey",
                self.plugin_id
            );
        }
        Ok(stored.to_string())
    }

    /// Whether a stored value is sealed under a plugin subkey.
    pub fn is_sealed(stored: &str) -> bool {
        stored.starts_with(PLUGIN_ENVELOPE_PREFIX)
    }
}

/// The raw master key, recorded alongside [`GLOBAL`] so subkeys can be derived
/// from it. Private: no accessor exposes these bytes outside the crate.
static GLOBAL_KEY: OnceLock<[u8; KEY_LEN]> = OnceLock::new();
/// Retired master keys of this process (see [`custody`]). Private like
/// [`GLOBAL_KEY`].
static RETIRED_KEYS: OnceLock<Vec<[u8; KEY_LEN]>> = OnceLock::new();

/// The resolved master key and the retired keys, for content and subkey
/// derivation. Forces resolution. Crate-private: no key material leaves it.
pub(crate) fn resolved_master_and_retired() -> Result<([u8; KEY_LEN], Vec<[u8; KEY_LEN]>)> {
    let _ = global_cipher()?;
    let master = *GLOBAL_KEY
        .get()
        .ok_or_else(|| anyhow!("master key not recorded"))?;
    Ok((master, RETIRED_KEYS.get().cloned().unwrap_or_default()))
}

/// Derive the sealing cipher for one plugin: `HKDF-SHA256(master_key, salt,
/// info = "ryu-plugin-crypto-v1:<plugin_id>")`.
///
/// **`plugin_id` must be the CANONICAL id.** Ids were rescoped to `@scope/name`
/// with an alias map keeping legacy ids valid, and callers on the outside edge
/// (a sidecar presenting whatever its manifest said at spawn) still send legacy
/// forms. The id is the KDF's `info`, so deriving from a legacy id at one call
/// site and the canonical id at another yields two different subkeys — and every
/// previously sealed value becomes permanently unreadable, with no error beyond
/// an auth-tag failure. Kernel callers canonicalize before calling in
/// (`plugin_manifest::canonical_plugin_id`); this crate cannot, having no
/// dependency on `apps/core`.
///
/// Fails closed for the same reason [`global_cipher`] does: no key, no cipher.
pub fn plugin_cipher(plugin_id: &str) -> Result<PluginCipher> {
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() {
        anyhow::bail!("a plugin subkey cannot be derived for an empty plugin id");
    }
    // Force master-key resolution; also the fail-closed gate.
    let (master, retired) = resolved_master_and_retired()?;
    let retired: Vec<[u8; KEY_LEN]> = retired
        .iter()
        .map(|key| process_keys::derive_plugin_key(key, plugin_id))
        .collect();
    Ok(PluginCipher::from_subkeys(
        plugin_id,
        process_keys::derive_plugin_key(&master, plugin_id),
        retired,
    ))
}

/// The pure half of [`plugin_cipher`]: master key + id in, subkey cipher out. Split
/// out so the derivation's properties (per-id separation, determinism) are testable
/// without installing a process-global [`CryptoHost`].
#[cfg(test)]
fn derive_plugin_cipher(master: &[u8; KEY_LEN], plugin_id: &str) -> Result<PluginCipher> {
    Ok(PluginCipher::from_subkeys(
        plugin_id,
        process_keys::derive_plugin_key(master, plugin_id),
        Vec::new(),
    ))
}

// ── Tenant-bound envelopes (`enc:v2:`) ────────────────────────────────────────

/// Where a bound value belongs: a fixed purpose (which table and column, or
/// which record kind and field) plus labelled identifiers of the record. Every
/// component, together with the tenant id of the [`TenantCipher`], is
/// authenticated as AEAD associated data, so a value opens only for the exact
/// record and field it was sealed for.
///
/// Choose identifiers that are stable for the life of the record and that the
/// consumer relies on (an id, and the destination a credential is sent to): if
/// one of them changes, the value no longer opens and must be sealed again.
/// Labels are `&'static str` because they are schema, not data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SealContext {
    purpose: String,
    fields: Vec<(&'static str, String)>,
}

impl SealContext {
    /// Start a context for one purpose, for example
    /// `"ryu-vault.connections.encrypted_state"`.
    pub fn new(purpose: impl Into<String>) -> Self {
        Self {
            purpose: purpose.into(),
            fields: Vec::new(),
        }
    }

    /// Bind one more labelled identifier. Order is significant.
    #[must_use]
    pub fn with(mut self, label: &'static str, value: impl Into<String>) -> Self {
        self.fields.push((label, value.into()));
        self
    }

    /// The canonical associated data: every component length-prefixed, so no
    /// choice of tenant id or field value can make two different contexts
    /// encode to the same bytes (`"a|b" + "c"` vs `"a" + "b|c"`).
    fn associated_data(&self, tenant: &str) -> Vec<u8> {
        fn push(out: &mut Vec<u8>, part: &[u8]) {
            out.extend_from_slice(&(part.len() as u64).to_be_bytes());
            out.extend_from_slice(part);
        }
        let mut out = Vec::with_capacity(
            64 + tenant.len()
                + self.purpose.len()
                + self
                    .fields
                    .iter()
                    .map(|(label, value)| 16 + label.len() + value.len())
                    .sum::<usize>(),
        );
        push(&mut out, BOUND_AAD_LABEL);
        push(&mut out, b"tenant");
        push(&mut out, tenant.as_bytes());
        push(&mut out, b"purpose");
        push(&mut out, self.purpose.as_bytes());
        for (label, value) in &self.fields {
            push(&mut out, label.as_bytes());
            push(&mut out, value.as_bytes());
        }
        out
    }
}

/// Why a [`TenantCipher`] refused a stored value. Carries no key or plaintext
/// material; callers can downcast an `anyhow::Error` to it to tell a moved or
/// foreign value apart from an infrastructure failure.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BoundSealError {
    /// The value is not in the `enc:v2:` envelope (legacy `enc:v1:`, legacy
    /// plaintext, or another scheme), so it carries no binding to verify.
    Unbound,
    /// The value is an `enc:v2:` envelope whose tag does not verify for this
    /// tenant and context: it was moved from another record, field, or tenant,
    /// altered, or sealed under a different master key.
    Mismatch,
    /// The value carries the `enc:v2:` prefix but its body is not valid base64
    /// or is shorter than a nonce.
    Malformed,
}

impl std::fmt::Display for BoundSealError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unbound => {
                "sealed value is not bound to a tenant and record (legacy or unknown envelope); \
                 refusing to open it"
            }
            Self::Mismatch => {
                "sealed value does not belong to this tenant, record, and field (it was moved, \
                 altered, or sealed under another master key); refusing to open it"
            }
            Self::Malformed => "sealed value has a malformed enc:v2 envelope",
        })
    }
}

impl std::error::Error for BoundSealError {}

/// Result of [`TenantCipher::open_allowing_legacy`].
#[derive(Clone, PartialEq, Eq)]
pub enum OpenedField {
    /// The value was a verified `enc:v2:` envelope for this tenant and context.
    Bound(String),
    /// The value was a legacy `enc:v1:` envelope under the master key and
    /// carried no binding. The caller should seal it again with
    /// [`TenantCipher::seal`] and stop accepting the legacy form.
    Legacy(String),
}

impl OpenedField {
    /// Whether the value was legacy and should be sealed again as `enc:v2:`.
    pub fn needs_reseal(&self) -> bool {
        matches!(self, Self::Legacy(_))
    }

    /// The plaintext, whichever envelope it came from.
    pub fn into_plaintext(self) -> String {
        match self {
            Self::Bound(plain) | Self::Legacy(plain) => plain,
        }
    }
}

impl std::fmt::Debug for OpenedField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the plaintext.
        f.write_str(match self {
            Self::Bound(_) => "OpenedField::Bound(<redacted>)",
            Self::Legacy(_) => "OpenedField::Legacy(<redacted>)",
        })
    }
}

/// A cipher for one tenant: seals `enc:v2:` envelopes under a per-tenant subkey
/// (`HKDF-SHA256(master_key, info = "ryu-tenant-crypto-v2:<tenant>")`) with the
/// tenant id and a [`SealContext`] as associated data.
///
/// A value sealed for one tenant, record, or field does not open for another
/// one, even though every tenant shares the master key: the subkey differs per
/// tenant, and the tag covers the context. That is the defence against someone
/// who can write the database but does not hold the key moving ciphertext
/// between rows or tenants.
///
/// It still reads the legacy `enc:v1:` envelope through
/// [`Self::open_allowing_legacy`], so a store can migrate; [`Self::open`] accepts
/// only bound values. The legacy [`FieldCipher`] API is unchanged.
#[derive(Clone)]
pub struct TenantCipher {
    /// The master-key cipher, used only to read legacy `enc:v1:` values.
    legacy: FieldCipher,
    /// The per-tenant subkey cipher for `enc:v2:`.
    bound: FieldCipher,
    tenant: String,
}

impl TenantCipher {
    /// Build a tenant cipher from an explicit 32-byte master key (tests and
    /// offline tools). Production code should use [`tenant_cipher`].
    ///
    /// The tenant id is used verbatim as the KDF input and in the associated
    /// data, so it must be the stable, canonical id. Empty ids, surrounding
    /// whitespace, and control characters are refused rather than normalized,
    /// because normalizing would let two spellings share (or silently fork) a key.
    pub fn new(master_key: &[u8; KEY_LEN], tenant: &str) -> Result<Self> {
        if tenant.is_empty() || tenant.trim() != tenant || tenant.chars().any(char::is_control) {
            anyhow::bail!(
                "a tenant subkey needs a non-empty tenant id without surrounding whitespace \
                 or control characters"
            );
        }
        let mut info = Vec::with_capacity(TENANT_KDF_INFO_PREFIX.len() + tenant.len());
        info.extend_from_slice(TENANT_KDF_INFO_PREFIX);
        info.extend_from_slice(tenant.as_bytes());
        let mut subkey = [0u8; KEY_LEN];
        hkdf::Hkdf::<sha2::Sha256>::new(Some(TENANT_KDF_SALT), master_key)
            .expand(&info, &mut subkey)
            .map_err(|e| anyhow!("deriving the subkey for tenant '{tenant}': {e}"))?;
        Ok(Self {
            legacy: FieldCipher::new(master_key),
            bound: FieldCipher::new(&subkey),
            tenant: tenant.to_owned(),
        })
    }

    /// The tenant this cipher is bound to (diagnostics; carries no key material).
    pub fn tenant(&self) -> &str {
        &self.tenant
    }

    /// Seal `plaintext` into the `enc:v2:` envelope for this tenant and context.
    pub fn seal(&self, plaintext: &str, context: &SealContext) -> Result<String> {
        let blob = self
            .bound
            .encrypt_blob_with_aad(plaintext.as_bytes(), &context.associated_data(&self.tenant))?;
        Ok(format!("{BOUND_ENVELOPE_PREFIX}{}", b64().encode(blob)))
    }

    /// Open a bound value. Refuses anything that is not a verified `enc:v2:`
    /// envelope for this tenant and context with a [`BoundSealError`].
    pub fn open(&self, stored: &str, context: &SealContext) -> Result<String> {
        let Some(encoded) = stored.strip_prefix(BOUND_ENVELOPE_PREFIX) else {
            return Err(BoundSealError::Unbound.into());
        };
        let blob = b64()
            .decode(encoded.trim())
            .map_err(|_| BoundSealError::Malformed)?;
        if blob.len() < NONCE_LEN {
            return Err(BoundSealError::Malformed.into());
        }
        let plain = self
            .bound
            .decrypt_blob_with_aad(&blob, &context.associated_data(&self.tenant))
            .ok_or(BoundSealError::Mismatch)?;
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }

    /// Open a bound value, or a legacy `enc:v1:` one for migration. An `enc:v2:`
    /// value must verify exactly as in [`Self::open`]; an `enc:v1:` value is
    /// opened with the master key and reported as [`OpenedField::Legacy`].
    /// Anything else is refused with [`BoundSealError::Unbound`]: unlike
    /// [`FieldCipher::open`], this never passes a value through as legacy
    /// plaintext, because whoever can write the store could choose it.
    ///
    /// Only an explicit, operator-initiated migration should call this:
    /// accepting legacy values on every open would let anyone who can write the
    /// store plant a captured `enc:v1:` value into another row or tenant.
    pub fn open_allowing_legacy(&self, stored: &str, context: &SealContext) -> Result<OpenedField> {
        if Self::is_sealed(stored) {
            return self.open(stored, context).map(OpenedField::Bound);
        }
        if !FieldCipher::is_sealed(stored) {
            return Err(BoundSealError::Unbound.into());
        }
        self.legacy.open(stored).map(OpenedField::Legacy)
    }

    /// Whether a stored value carries the bound `enc:v2:` envelope.
    pub fn is_sealed(stored: &str) -> bool {
        stored.starts_with(BOUND_ENVELOPE_PREFIX)
    }
}

/// The process-wide [`TenantCipher`] for `tenant`, derived from the resolved
/// master key. Fails closed for the same reason [`global_cipher`] does.
pub fn tenant_cipher(tenant: &str) -> Result<TenantCipher> {
    let _ = global_cipher()?;
    let master = GLOBAL_KEY
        .get()
        .ok_or_else(|| anyhow!("master key not recorded"))?;
    TenantCipher::new(master, tenant)
}

fn generate_key() -> [u8; KEY_LEN] {
    let mut raw = [0u8; KEY_LEN];
    rand::thread_rng().fill_bytes(&mut raw);
    raw
}

fn decode_key(encoded: &str) -> Option<[u8; KEY_LEN]> {
    let raw = b64().decode(encoded.trim()).ok()?;
    <[u8; KEY_LEN]>::try_from(raw.as_slice()).ok()
}

fn read_key_file(path: &PathBuf) -> Result<Option<[u8; KEY_LEN]>> {
    let encoded = match std::fs::read_to_string(path) {
        Ok(encoded) => encoded,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).with_context(|| format!("reading master key {}", path.display()))
        }
    };
    decode_key(&encoded).map(Some).ok_or_else(|| {
        anyhow!(
            "master key {} is corrupt; refusing to replace key material that may protect existing data",
            path.display()
        )
    })
}

/// Publish `key` at `path` unless a key file already exists there, and return
/// the key that the file holds afterwards.
///
/// Several processes (Core, a standalone Gateway, satellites, the desktop shell)
/// can resolve the master key against the same data dir at the same time. The
/// file is published without replacing an existing one (first writer wins); a
/// process that loses the race discards its generated key and adopts the
/// winner's, so no process ever seals data under a key that is not on disk.
fn write_key_file(path: &PathBuf, key: &[u8; KEY_LEN]) -> Result<[u8; KEY_LEN]> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating key dir {}", parent.display()))?;
    }
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("master key path has no parent"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .with_context(|| format!("creating temporary master key in {}", parent.display()))?;
    use std::io::Write;
    temporary
        .as_file_mut()
        .write_all(b64().encode(key).as_bytes())
        .with_context(|| format!("writing temporary master key for {}", path.display()))?;
    temporary
        .as_file_mut()
        .sync_all()
        .with_context(|| format!("syncing temporary master key for {}", path.display()))?;
    match temporary.persist_noclobber(path) {
        Ok(_) => {
            restrict_permissions(path);
            Ok(*key)
        }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            // Another process published first. Its key is the one on disk, so
            // it is the only key anyone may seal under.
            drop(error.file);
            read_key_file(path)?.ok_or_else(|| {
                anyhow!(
                    "master key {} vanished after another process created it",
                    path.display()
                )
            })
        }
        Err(error) => {
            Err(error.error).with_context(|| format!("publishing master key {}", path.display()))
        }
    }
}

/// On-disk key file locations. Grouped so the resolution logic can be unit-tested
/// against a temp dir instead of the real `~/.ryu`.
struct KeyPaths {
    /// File-fallback master key (used only when no keychain is reachable).
    master: PathBuf,
    /// Pre-existing memory key, imported as the master key on first run.
    legacy_memory: PathBuf,
}

/// File-fallback + legacy-memory key locations under the host data dir's
/// `secrets/` (`secrets/master.key`, `secrets/memory.key`). The file-fallback
/// master key is used only when no keychain is reachable; the pre-existing
/// `memory.key` is imported as the master key on first run so already-encrypted
/// `memory_entries` keep decrypting under the unified key.
fn default_key_paths(host: &dyn CryptoHost) -> KeyPaths {
    let dir = host.ryu_dir();
    KeyPaths {
        master: layout::secret_path(&dir, "master.key"),
        legacy_memory: layout::secret_path(&dir, "memory.key"),
    }
}

/// What the keychain holds for our master-key slot. Distinguishes "reachable but
/// empty" (we should seed it) from "unavailable" (fall back to a file). A build
/// without the `os-keychain` feature only ever produces `Unavailable` outside tests.
#[cfg_attr(not(feature = "os-keychain"), allow(dead_code))]
enum KeychainState {
    Key([u8; KEY_LEN]),
    Empty,
    Corrupt,
    Unavailable,
}

/// A keychain port so the resolution logic can be tested without a real OS
/// keychain. The production impl is [`OsKeychain`]; tests inject a fake.
trait Keychain {
    fn get(&self) -> KeychainState;
    /// Store the key, returning whether it persisted.
    fn store(&self, key: &[u8; KEY_LEN]) -> bool;
}

/// The real OS keychain (Windows Credential Manager / macOS Keychain / Linux
/// Secret Service) via the `keyring` crate. `account` is the profile-scoped slot
/// (`master-key{suffix}`), resolved once from the host at construction.
struct OsKeychain {
    #[cfg_attr(not(feature = "os-keychain"), allow(dead_code))]
    account: String,
}

struct DisabledKeychain;

impl Keychain for DisabledKeychain {
    fn get(&self) -> KeychainState {
        KeychainState::Unavailable
    }

    fn store(&self, _key: &[u8; KEY_LEN]) -> bool {
        false
    }
}

#[cfg(feature = "os-keychain")]
impl Keychain for OsKeychain {
    fn get(&self) -> KeychainState {
        let entry = match keyring::Entry::new(KEYRING_SERVICE, &self.account) {
            Ok(entry) => entry,
            Err(e) => {
                tracing::warn!("keychain unavailable ({e}); falling back to file key");
                return KeychainState::Unavailable;
            }
        };
        match entry.get_password() {
            Ok(stored) => match decode_key(&stored) {
                Some(key) => KeychainState::Key(key),
                None => {
                    tracing::error!("keychain master key is malformed; refusing to reseed");
                    KeychainState::Corrupt
                }
            },
            Err(keyring::Error::NoEntry) => KeychainState::Empty,
            Err(e) => {
                tracing::warn!("keychain read failed ({e}); falling back to file key");
                KeychainState::Unavailable
            }
        }
    }

    fn store(&self, key: &[u8; KEY_LEN]) -> bool {
        match keyring::Entry::new(KEYRING_SERVICE, &self.account) {
            Ok(entry) => match entry.set_password(&b64().encode(key)) {
                Ok(()) => true,
                Err(e) => {
                    tracing::warn!("could not write master key to keychain ({e}); using file key");
                    false
                }
            },
            Err(_) => false,
        }
    }
}

/// A build without the `os-keychain` feature has no OS keychain backend: the slot
/// reads as unreachable and never stores. [`load_master_key`] refuses to treat
/// that as an implicit file fallback (see [`require_explicit_custody_without_keychain`]).
#[cfg(not(feature = "os-keychain"))]
impl Keychain for OsKeychain {
    fn get(&self) -> KeychainState {
        KeychainState::Unavailable
    }

    fn store(&self, _key: &[u8; KEY_LEN]) -> bool {
        false
    }
}

/// Guard for a build compiled without the `os-keychain` feature. Such a build
/// cannot see the keychain, so it cannot know whether the master key already lives
/// there; silently generating a file key would fork custody and make existing
/// rows unreadable. It therefore resolves a key only when the operator chose the
/// source explicitly: `RYU_MASTER_KEY`, or `RYU_KEYCHAIN=off` for the file key.
fn require_explicit_custody_without_keychain(
    env_key_present: bool,
    keychain_disabled: bool,
) -> Result<()> {
    if env_key_present || keychain_disabled {
        return Ok(());
    }
    Err(anyhow!(
        "this build has no OS keychain backend (ryu-crypto feature `os-keychain` is off): \
         set {ENV_MASTER_KEY}, or set {ENV_KEYCHAIN}=off to use the file key"
    ))
}

/// Testable core of the custody ladder: the env value, keychain, and paths are
/// injected so every branch — including the data-loss-critical `memory.key`
/// migration — can be exercised in unit tests.
#[cfg(test)]
fn load_master_key_with(
    env_value: Option<String>,
    keychain: &dyn Keychain,
    paths: &KeyPaths,
) -> Result<([u8; KEY_LEN], MasterKeySource)> {
    load_master_key_with_policy(env_value, keychain, paths, true)
}

/// Error for a host that forbids the file fallback when neither the env key nor
/// a writable keychain is available. Names the remedy, never key material.
fn file_key_refused(paths: &KeyPaths) -> anyhow::Error {
    anyhow!(
        "no external master-key custody: set {ENV_MASTER_KEY} or make the OS keychain \
         available (this host does not use a key file at {})",
        paths.master.display()
    )
}

/// [`load_master_key_with`] plus the host's file-fallback policy. With
/// `allow_file == false` nothing is read from or written to `paths.master`.
#[cfg(test)]
fn load_master_key_with_policy(
    env_value: Option<String>,
    keychain: &dyn Keychain,
    paths: &KeyPaths,
    allow_file: bool,
) -> Result<([u8; KEY_LEN], MasterKeySource)> {
    load_master_key_guarded(
        env_value,
        keychain,
        paths,
        allow_file,
        &custody::GenerationGuard::permissive(),
    )
}

/// The custody ladder. A key is generated only when `guard` allows it (no key
/// check value recorded and no sealed data found); otherwise the ladder refuses
/// instead of minting a key that would orphan the sealed data.
pub(crate) fn load_master_key_guarded(
    env_value: Option<String>,
    keychain: &dyn Keychain,
    paths: &KeyPaths,
    allow_file: bool,
    guard: &custody::GenerationGuard<'_>,
) -> Result<([u8; KEY_LEN], MasterKeySource)> {
    // 1. Env override (highest priority; never written to disk/keychain by us).
    if let Some(encoded) = env_value {
        match decode_key(&encoded) {
            Some(key) => return Ok((key, MasterKeySource::Env)),
            None => return Err(anyhow!("{ENV_MASTER_KEY} is not a base64 32-byte key")),
        }
    }

    // A pre-existing memory key is adopted as the master key so prior entries
    // keep decrypting under the unified key.
    let legacy = read_key_file(&paths.legacy_memory)?;

    // 2. OS keychain (default where reachable).
    match keychain.get() {
        KeychainState::Key(key) => {
            retire_matching_legacy_key(paths, &key)?;
            return Ok((key, MasterKeySource::Keychain));
        }
        KeychainState::Empty => {
            // Adopt a key this folder already uses before ever generating one:
            // the file fallback (written while no keychain was reachable), then
            // the legacy memory key.
            let file_key = if allow_file {
                read_key_file(&paths.master)?
            } else {
                None
            };
            let key = match file_key.or(legacy) {
                Some(existing) => existing,
                None => {
                    if let Err(reason) = guard.may_generate() {
                        return Err(anyhow!(
                            "the key that sealed this data folder is not in the keychain \
                             ({reason}); refusing to generate a new one. Restore the key \
                             (keychain entry or {ENV_MASTER_KEY}) or run `ryu-core keys status`"
                        ));
                    }
                    generate_key()
                }
            };
            if keychain.store(&key) {
                match keychain.get() {
                    KeychainState::Key(persisted) if persisted == key => {
                        // A raw legacy `memory.key` is retired once the keychain
                        // is verified to hold the same bytes. A `master.key`
                        // copy is kept as a recovery copy until the keychain
                        // reads the same bytes back, so custody reports `file`
                        // while it remains.
                        retire_matching_legacy_key(paths, &key)?;
                        if key_file_copy(&key, paths).is_some() {
                            tracing::warn!(
                                "master key adopted into the keychain; the key file in secrets/ is \
                                 kept as a recovery copy, so custody reports `file` until it is \
                                 removed (see `ryu-core keys status`)"
                            );
                        }
                        return Ok((key, MasterKeySource::Keychain));
                    }
                    KeychainState::Key(_) => {
                        return Err(anyhow!(
                            "keychain returned different key material after storing the master key"
                        ));
                    }
                    KeychainState::Corrupt => {
                        return Err(anyhow!("keychain master key was corrupt after storing it"));
                    }
                    KeychainState::Empty | KeychainState::Unavailable => {
                        return Err(anyhow!(
                            "keychain master key could not be verified after storing it"
                        ));
                    }
                }
            }
            if !allow_file {
                return Err(file_key_refused(paths));
            }
            // Keychain reachable but unwritable: persist to the file fallback,
            // adopting a key another process already published there.
            let key = match read_key_file(&paths.master)? {
                Some(existing) => existing,
                None => write_key_file(&paths.master, &key)?,
            };
            return Ok((key, MasterKeySource::File));
        }
        KeychainState::Corrupt => {
            return Err(anyhow!(
                "keychain master key is corrupt; refusing to overwrite it"
            ))
        }
        KeychainState::Unavailable => {}
    }

    // 3. File fallback (headless box with no keychain): current security level.
    if !allow_file {
        return Err(file_key_refused(paths));
    }
    if let Some(key) = read_key_file(&paths.master)? {
        return Ok((key, MasterKeySource::File));
    }
    let generated = match legacy {
        Some(existing) => existing,
        None => {
            if let Err(reason) = guard.may_generate() {
                return Err(anyhow!(
                    "the OS keychain is unavailable and this data folder holds sealed data \
                     ({reason}); refusing to generate a new key. Unlock the keychain or provide \
                     the key ({ENV_MASTER_KEY})"
                ));
            }
            generate_key()
        }
    };
    let key = write_key_file(&paths.master, &generated)?;
    Ok((key, MasterKeySource::File))
}

/// Retire the legacy raw key only after the authoritative keychain value is known
/// to be byte-for-byte identical. A duplicate that differs is NOT the live key,
/// so removing it could destroy the only key for rows sealed under it: it is
/// preserved untouched and stays a retired key the master cipher opens old data
/// with (`custody.rs`), and custody never counts it as keychain-only. A corrupt
/// file still fails closed (`read_key_file`).
fn retire_matching_legacy_key(paths: &KeyPaths, keychain_key: &[u8; KEY_LEN]) -> Result<()> {
    let Some(legacy_key) = read_key_file(&paths.legacy_memory)? else {
        return Ok(());
    };
    if legacy_key != *keychain_key {
        tracing::warn!(
            "legacy memory key {} differs from the keychain master key; keeping it as a \
             retired key (move it out of the data directory once nothing still needs it)",
            paths.legacy_memory.display()
        );
        return Ok(());
    }
    std::fs::remove_file(&paths.legacy_memory).with_context(|| {
        format!(
            "retiring verified legacy memory key {}",
            paths.legacy_memory.display()
        )
    })?;
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        tracing::warn!("could not restrict master key permissions: {e}");
    }
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &PathBuf) {
    // On Windows the file inherits the user-profile ACL; no extra step here.
}

/// Outcome of copying a profile's master key to another profile's slot.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyCopy {
    /// The key was read from the source slot and written to the destination.
    Copied,
    /// The destination slot ALREADY holds a key. Refused: overwriting it would
    /// orphan whatever that profile has already sealed.
    DestinationOccupied,
    /// The source profile has no key in the keychain, so there is nothing to copy
    /// and the destination would generate its own — silently orphaning the data
    /// about to be copied onto it.
    SourceMissing,
    /// The keychain could not be read or written at all.
    Unavailable,
}

/// Copy the master key from one profile's keychain slot to another's.
///
/// **This is what makes copying a data directory between profiles survivable.**
/// Everything sealed at rest — message bodies, long-term memory, plugin secrets,
/// the identity vault — is encrypted with a key held per profile in
/// `master-key{suffix}`. Copy the files without the key and the destination
/// profile generates a fresh one, at which point:
///
///   - every message body reads `[unable to decrypt message]`,
///   - memory rows are silently DROPPED from recall,
///   - plugin secrets read as unset,
///   - the identity vault hard-errors,
///
/// while the profile otherwise boots and looks healthy, because all the metadata
/// (titles, timestamps, ordering) is plaintext. The user experiences it as "the
/// copy lost my chats", not as a key problem. Worse, new writes seal under the new
/// key, so the DB becomes irreversibly mixed-key — there is no rekey path anywhere
/// and the cipher is cached process-wide in a `OnceLock`.
///
/// Note `master.key` on disk is NOT a substitute: it is only consulted when the
/// keychain is unavailable, so on macOS/Windows copying that file achieves
/// nothing. `memory.key` *is* silently adopted, which is an accident of the legacy
/// import path rather than a supported transfer.
///
/// Refuses rather than overwrites when the destination already holds a key: that
/// profile may already have sealed data of its own, and clobbering its key would
/// destroy it in exactly the same silent way.
pub fn copy_master_key_between_profiles(from_suffix: &str, to_suffix: &str) -> KeyCopy {
    let from = OsKeychain {
        account: format!("{KEYRING_ACCOUNT}{from_suffix}"),
    };
    let to = OsKeychain {
        account: format!("{KEYRING_ACCOUNT}{to_suffix}"),
    };
    copy_master_key_with(&from, &to)
}

/// The pure half of [`copy_master_key_between_profiles`], testable without a real
/// keychain.
fn copy_master_key_with(from: &dyn Keychain, to: &dyn Keychain) -> KeyCopy {
    let key = match from.get() {
        KeychainState::Key(k) => k,
        KeychainState::Empty => return KeyCopy::SourceMissing,
        KeychainState::Corrupt => return KeyCopy::Unavailable,
        KeychainState::Unavailable => return KeyCopy::Unavailable,
    };
    match to.get() {
        // Never clobber a key that already seals something.
        KeychainState::Key(_) => return KeyCopy::DestinationOccupied,
        KeychainState::Corrupt => return KeyCopy::Unavailable,
        KeychainState::Unavailable => return KeyCopy::Unavailable,
        KeychainState::Empty => {}
    }
    if to.store(&key) {
        KeyCopy::Copied
    } else {
        KeyCopy::Unavailable
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn hmac_sha256_hex_matches_rfc4231_case_two() {
        assert_eq!(
            super::hmac_sha256_hex(b"Jefe", b"what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn sha256_hex_matches_the_fips_180_abc_vector() {
        assert_eq!(
            super::sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    use super::*;

    fn test_cipher() -> FieldCipher {
        FieldCipher::new(&[7u8; KEY_LEN])
    }

    #[test]
    fn seal_open_round_trips() {
        let cipher = test_cipher();
        let sealed = cipher.seal("hello secret world").unwrap();
        assert!(FieldCipher::is_sealed(&sealed));
        assert!(sealed.starts_with(ENVELOPE_PREFIX));
        assert_eq!(cipher.open(&sealed).unwrap(), "hello secret world");
    }

    fn test_plugin_cipher(plugin_id: &str) -> PluginCipher {
        derive_plugin_cipher(&[7u8; KEY_LEN], plugin_id).unwrap()
    }

    #[test]
    fn plugin_seal_open_round_trips_under_its_own_prefix() {
        let cipher = test_plugin_cipher("@ryu/notes");
        let sealed = cipher.seal("app secret").unwrap();
        assert!(sealed.starts_with(PLUGIN_ENVELOPE_PREFIX));
        assert!(PluginCipher::is_sealed(&sealed));
        assert!(!sealed.contains("app secret"));
        assert_eq!(cipher.open(&sealed).unwrap(), "app secret");
    }

    #[test]
    fn plugin_envelope_is_distinguishable_from_the_master_envelope() {
        // `encp:v1:` must not be mistaken for `enc:v1:` by a prefix test — a
        // `starts_with` written the other way round would match both.
        let plugin_sealed = test_plugin_cipher("@ryu/notes").seal("x").unwrap();
        assert!(!FieldCipher::is_sealed(&plugin_sealed));
        let master_sealed = test_cipher().seal("x").unwrap();
        assert!(!PluginCipher::is_sealed(&master_sealed));
    }

    #[test]
    fn one_plugin_cannot_open_another_plugins_value() {
        let a = test_plugin_cipher("@ryu/notes");
        let b = test_plugin_cipher("@ryu/mail");
        let sealed = a.seal("only mine").unwrap();
        // Same master key, different subkey => AEAD tag fails. Isolation is
        // enforced by the KDF, not by a check a caller could skip.
        assert!(b.open(&sealed).is_err());
        assert_eq!(a.open(&sealed).unwrap(), "only mine");
    }

    #[test]
    fn plugin_cipher_refuses_master_key_sealed_values() {
        let sealed = test_cipher().seal("core's own row").unwrap();
        let err = test_plugin_cipher("@ryu/notes")
            .open(&sealed)
            .expect_err("a plugin must not read a master-key-sealed value");
        assert!(err.to_string().contains("master key"));
    }

    #[test]
    fn plugin_cipher_passes_through_legacy_plaintext() {
        // Values written before an app opted in keep reading, and upgrade on the
        // next write — same lazy migration the master-key envelope uses.
        let cipher = test_plugin_cipher("@ryu/notes");
        assert_eq!(cipher.open("legacy kv value").unwrap(), "legacy kv value");
    }

    #[test]
    fn plugin_subkey_derivation_is_deterministic_and_id_bound() {
        // Determinism across processes is what makes stored ciphertext readable
        // after a restart.
        let sealed = test_plugin_cipher("@ryu/notes").seal("stable").unwrap();
        assert_eq!(
            test_plugin_cipher("@ryu/notes").open(&sealed).unwrap(),
            "stable"
        );
        // A legacy (non-canonical) id derives a DIFFERENT key. This is the
        // canonicalization trap the `plugin_cipher` docs warn about: callers must
        // pass the canonical id, or previously sealed values stop opening.
        assert!(test_plugin_cipher("notes").open(&sealed).is_err());
    }

    #[test]
    fn plugin_cipher_rejects_an_empty_id() {
        // Guarded in `plugin_cipher` (not the pure half) because an empty id would
        // otherwise derive one shared "anonymous" subkey for every caller.
        assert!(plugin_cipher("   ").is_err());
    }

    // ── Tenant-bound envelope (`enc:v2:`) ────────────────────────────────────

    const MASTER: [u8; KEY_LEN] = [7u8; KEY_LEN];

    fn tenant(id: &str) -> TenantCipher {
        TenantCipher::new(&MASTER, id).unwrap()
    }

    fn row_context(id: &str, domain: &str) -> SealContext {
        SealContext::new("test.connections.encrypted_state")
            .with("id", id)
            .with("domain", domain)
    }

    fn binding_error(error: &anyhow::Error) -> Option<&BoundSealError> {
        error.downcast_ref::<BoundSealError>()
    }

    #[test]
    fn bound_seal_open_round_trips_under_the_v2_prefix() {
        let cipher = tenant("tenant-a");
        let context = row_context("conn_1", "example.com");
        let sealed = cipher.seal("cookie=hunter2", &context).unwrap();
        assert!(sealed.starts_with(BOUND_ENVELOPE_PREFIX));
        assert!(TenantCipher::is_sealed(&sealed));
        assert!(!sealed.contains("hunter2"));
        assert_eq!(cipher.open(&sealed, &context).unwrap(), "cookie=hunter2");
        assert_eq!(
            cipher.open_allowing_legacy(&sealed, &context).unwrap(),
            OpenedField::Bound("cookie=hunter2".to_owned())
        );
        // Empty values round-trip too.
        let empty = cipher.seal("", &context).unwrap();
        assert_eq!(cipher.open(&empty, &context).unwrap(), "");
    }

    #[test]
    fn bound_values_refuse_another_tenant_record_or_field() {
        let a = tenant("tenant-a");
        let context = row_context("conn_1", "example.com");
        let sealed = a.seal("cookie=hunter2", &context).unwrap();
        for (cipher, other) in [
            // Same row, other tenant (same master key).
            (tenant("tenant-b"), row_context("conn_1", "example.com")),
            // Same tenant, other row.
            (tenant("tenant-a"), row_context("conn_2", "example.com")),
            // Same tenant and row, other destination domain.
            (
                tenant("tenant-a"),
                row_context("conn_1", "attacker.example"),
            ),
            // Same identifiers, other purpose (another table or column).
            (
                tenant("tenant-a"),
                SealContext::new("test.other.encrypted_state")
                    .with("id", "conn_1")
                    .with("domain", "example.com"),
            ),
            // Same values under different labels.
            (
                tenant("tenant-a"),
                SealContext::new("test.connections.encrypted_state")
                    .with("row", "conn_1")
                    .with("domain", "example.com"),
            ),
        ] {
            let error = cipher.open(&sealed, &other).unwrap_err();
            assert_eq!(binding_error(&error), Some(&BoundSealError::Mismatch));
            assert!(error.to_string().contains("does not belong"), "{error}");
            // The migration path refuses a moved v2 value just as strictly.
            let error = cipher.open_allowing_legacy(&sealed, &other).unwrap_err();
            assert_eq!(binding_error(&error), Some(&BoundSealError::Mismatch));
        }
        // A different master key with the same tenant id also fails.
        let rekeyed = TenantCipher::new(&[8u8; KEY_LEN], "tenant-a").unwrap();
        assert!(rekeyed.open(&sealed, &context).is_err());
        assert_eq!(a.open(&sealed, &context).unwrap(), "cookie=hunter2");
    }

    #[test]
    fn associated_data_is_unambiguous_across_component_boundaries() {
        // A naive `join("|")` would make these two contexts identical.
        let left = SealContext::new("p").with("id", "a|b").with("domain", "c");
        let right = SealContext::new("p").with("id", "a").with("domain", "b|c");
        assert_ne!(left.associated_data("t"), right.associated_data("t"));
        assert_ne!(
            SealContext::new("p").associated_data("ab"),
            SealContext::new("bp").associated_data("a")
        );
        let sealed = tenant("t").seal("x", &left).unwrap();
        assert!(tenant("t").open(&sealed, &right).is_err());
    }

    #[test]
    fn tenant_subkeys_are_deterministic_and_separate_from_plugin_subkeys() {
        let context = row_context("conn_1", "example.com");
        let sealed = tenant("tenant-a").seal("stable", &context).unwrap();
        // A restart derives the same subkey.
        assert_eq!(
            tenant("tenant-a").open(&sealed, &context).unwrap(),
            "stable"
        );
        // The subkey is not the master key: the master-key cipher cannot open the
        // body even with the right associated data.
        let body = b64()
            .decode(sealed.strip_prefix(BOUND_ENVELOPE_PREFIX).unwrap())
            .unwrap();
        let aad = context.associated_data("tenant-a");
        assert!(FieldCipher::new(&MASTER)
            .decrypt_blob_with_aad(&body, &aad)
            .is_none());
        // Nor is it the plugin subkey for the same spelling.
        let plugin = derive_plugin_cipher(&MASTER, "tenant-a").unwrap();
        assert!(plugin.inner.decrypt_blob_with_aad(&body, &aad).is_none());
    }

    #[test]
    fn strict_open_refuses_legacy_and_malformed_values() {
        let cipher = tenant("tenant-a");
        let context = row_context("conn_1", "example.com");
        let legacy = FieldCipher::new(&MASTER).seal("old").unwrap();
        for stored in [legacy.as_str(), "plaintext cookie", "encp:v1:AAAA"] {
            let error = cipher.open(stored, &context).unwrap_err();
            assert_eq!(binding_error(&error), Some(&BoundSealError::Unbound));
        }
        for stored in ["enc:v2:not base64!", "enc:v2:AAAA"] {
            let error = cipher.open(stored, &context).unwrap_err();
            assert_eq!(binding_error(&error), Some(&BoundSealError::Malformed));
        }
    }

    #[test]
    fn legacy_v1_values_open_for_migration_and_reseal_as_bound() {
        let cipher = tenant("tenant-a");
        let context = row_context("conn_1", "example.com");
        let legacy = FieldCipher::new(&MASTER).seal("session=old").unwrap();
        let opened = cipher.open_allowing_legacy(&legacy, &context).unwrap();
        assert!(opened.needs_reseal());
        assert!(!format!("{opened:?}").contains("session=old"));
        // Unsealed values are never passed through as plaintext: whoever can
        // write the store could choose them.
        for stored in ["pre-encryption", "cookie=attacker-chosen", "encp:v1:AAAA"] {
            let error = cipher.open_allowing_legacy(stored, &context).unwrap_err();
            assert_eq!(binding_error(&error), Some(&BoundSealError::Unbound));
        }
        // A v1 value under a different master key still fails.
        let foreign = FieldCipher::new(&[9u8; KEY_LEN]).seal("x").unwrap();
        assert!(cipher.open_allowing_legacy(&foreign, &context).is_err());

        // Re-sealing on write produces a bound value that only opens in place.
        let resealed = cipher.seal(&opened.into_plaintext(), &context).unwrap();
        assert!(TenantCipher::is_sealed(&resealed));
        assert!(!FieldCipher::is_sealed(&resealed));
        assert_eq!(cipher.open(&resealed, &context).unwrap(), "session=old");
        assert!(!cipher
            .open_allowing_legacy(&resealed, &context)
            .unwrap()
            .needs_reseal());
        assert!(tenant("tenant-b").open(&resealed, &context).is_err());
    }

    #[test]
    fn unbound_readers_are_unchanged_and_do_not_open_bound_values() {
        // `FieldCipher` keeps its v1 behavior; a v2 value is not `enc:v1:`.
        let sealed = tenant("tenant-a")
            .seal("x", &row_context("conn_1", "example.com"))
            .unwrap();
        assert!(!FieldCipher::is_sealed(&sealed));
        assert!(!PluginCipher::is_sealed(&sealed));
        let v1 = FieldCipher::new(&MASTER).seal("x").unwrap();
        assert!(!TenantCipher::is_sealed(&v1));
        assert_eq!(FieldCipher::new(&MASTER).open(&v1).unwrap(), "x");
    }

    #[test]
    fn tenant_ids_must_be_canonical() {
        for bad in ["", " tenant", "tenant ", "ten\nant"] {
            assert!(TenantCipher::new(&MASTER, bad).is_err(), "{bad:?}");
        }
        assert_eq!(tenant("tenant-a").tenant(), "tenant-a");
    }

    #[test]
    fn sealed_value_is_not_plaintext() {
        let cipher = test_cipher();
        let secret = "the password is hunter2";
        let sealed = cipher.seal(secret).unwrap();
        assert!(!sealed.contains("hunter2"));
        assert!(!sealed.contains("password"));
    }

    #[test]
    fn open_passes_through_legacy_plaintext() {
        let cipher = test_cipher();
        // A value written before encryption was introduced (no prefix).
        assert_eq!(
            cipher.open("legacy plaintext row").unwrap(),
            "legacy plaintext row"
        );
        assert!(!FieldCipher::is_sealed("legacy plaintext row"));
    }

    #[test]
    fn each_seal_uses_a_fresh_nonce() {
        let cipher = test_cipher();
        let a = cipher.seal("same input").unwrap();
        let b = cipher.seal("same input").unwrap();
        // Random nonce per seal => different ciphertext for identical plaintext.
        assert_ne!(a, b);
        assert_eq!(cipher.open(&a).unwrap(), cipher.open(&b).unwrap());
    }

    #[test]
    fn wrong_key_fails_to_open() {
        let sealed = FieldCipher::new(&[1u8; KEY_LEN]).seal("secret").unwrap();
        assert!(FieldCipher::new(&[2u8; KEY_LEN]).open(&sealed).is_err());
    }

    #[test]
    fn empty_string_round_trips() {
        let cipher = test_cipher();
        let sealed = cipher.seal("").unwrap();
        assert_eq!(cipher.open(&sealed).unwrap(), "");
    }

    // ── Key custody / migration (the load-bearing part) ──────────────────────

    /// A keychain stub with an explicit starting state, recording writes.
    struct FakeKeychain {
        start: KeychainState,
        stored: std::cell::RefCell<Option<[u8; KEY_LEN]>>,
        store_ok: bool,
    }

    impl FakeKeychain {
        fn new(start: KeychainState, store_ok: bool) -> Self {
            Self {
                start,
                stored: std::cell::RefCell::new(None),
                store_ok,
            }
        }
    }

    impl Keychain for FakeKeychain {
        fn get(&self) -> KeychainState {
            // Like a real keychain, a successful store reads back.
            if let Some(stored) = *self.stored.borrow() {
                return KeychainState::Key(stored);
            }
            match self.start {
                KeychainState::Key(k) => KeychainState::Key(k),
                KeychainState::Empty => KeychainState::Empty,
                KeychainState::Corrupt => KeychainState::Corrupt,
                KeychainState::Unavailable => KeychainState::Unavailable,
            }
        }
        fn store(&self, key: &[u8; KEY_LEN]) -> bool {
            if self.store_ok {
                *self.stored.borrow_mut() = Some(*key);
            }
            self.store_ok
        }
    }

    // ── copy_master_key_between_profiles ────────────────────────────────────
    //
    // The single thing that makes a cross-profile data copy survivable. Every case
    // here is a way the copy can silently produce a profile that boots, looks
    // healthy, and cannot read its own message bodies.

    #[test]
    fn copying_a_key_into_an_empty_slot_succeeds() {
        let key = [7u8; KEY_LEN];
        let from = FakeKeychain::new(KeychainState::Key(key), true);
        let to = FakeKeychain::new(KeychainState::Empty, true);
        assert_eq!(copy_master_key_with(&from, &to), KeyCopy::Copied);
        // The DESTINATION must end up holding the SOURCE's key byte for byte —
        // anything else and the copied ciphertext is undecryptable.
        assert_eq!(*to.stored.borrow(), Some(key));
    }

    #[test]
    fn an_occupied_destination_is_refused_not_overwritten() {
        // That profile may already have sealed data of its own. Clobbering its key
        // destroys it in exactly the same silent way we are trying to prevent.
        let from = FakeKeychain::new(KeychainState::Key([1u8; KEY_LEN]), true);
        let to = FakeKeychain::new(KeychainState::Key([2u8; KEY_LEN]), true);
        assert_eq!(
            copy_master_key_with(&from, &to),
            KeyCopy::DestinationOccupied
        );
        assert_eq!(*to.stored.borrow(), None, "must not write");
    }

    #[test]
    fn a_source_with_no_key_is_reported_not_silently_skipped() {
        // The caller MUST abort here. Proceeding copies files onto a profile that
        // will mint its own key and orphan every one of them.
        let from = FakeKeychain::new(KeychainState::Empty, true);
        let to = FakeKeychain::new(KeychainState::Empty, true);
        assert_eq!(copy_master_key_with(&from, &to), KeyCopy::SourceMissing);
        assert_eq!(*to.stored.borrow(), None);
    }

    #[test]
    fn an_unreachable_keychain_is_reported_on_either_side() {
        let key = [3u8; KEY_LEN];
        let unavailable_src = FakeKeychain::new(KeychainState::Unavailable, true);
        let ok_dst = FakeKeychain::new(KeychainState::Empty, true);
        assert_eq!(
            copy_master_key_with(&unavailable_src, &ok_dst),
            KeyCopy::Unavailable
        );

        let ok_src = FakeKeychain::new(KeychainState::Key(key), true);
        let unavailable_dst = FakeKeychain::new(KeychainState::Unavailable, true);
        assert_eq!(
            copy_master_key_with(&ok_src, &unavailable_dst),
            KeyCopy::Unavailable
        );
    }

    #[test]
    fn a_failed_write_is_never_reported_as_copied() {
        // Reporting Copied here would let the caller proceed with the data copy on
        // the strength of a key that was never persisted.
        let from = FakeKeychain::new(KeychainState::Key([9u8; KEY_LEN]), true);
        let to = FakeKeychain::new(KeychainState::Empty, false);
        assert_eq!(copy_master_key_with(&from, &to), KeyCopy::Unavailable);
    }

    #[test]
    fn a_copied_key_actually_decrypts_the_source_ciphertext() {
        // The end-to-end property the whole feature rests on.
        let key = [42u8; KEY_LEN];
        let sealed = FieldCipher::new(&key)
            .seal("my message body")
            .expect("seal");

        let from = FakeKeychain::new(KeychainState::Key(key), true);
        let to = FakeKeychain::new(KeychainState::Empty, true);
        assert_eq!(copy_master_key_with(&from, &to), KeyCopy::Copied);

        let landed = to.stored.borrow().expect("key landed");
        assert_eq!(
            FieldCipher::new(&landed).open(&sealed).expect("open"),
            "my message body"
        );

        // And a DIFFERENT key — what the destination would have minted for itself —
        // fails outright. This is the silent-failure case in one assertion.
        let minted = [43u8; KEY_LEN];
        assert!(
            FieldCipher::new(&minted).open(&sealed).is_err(),
            "a freshly minted key must NOT open the source's ciphertext"
        );
    }

    fn paths_in(dir: &std::path::Path) -> KeyPaths {
        KeyPaths {
            master: dir.join("master.key"),
            legacy_memory: dir.join("memory.key"),
        }
    }

    #[test]
    fn env_master_key_wins_over_everything() {
        let dir = tempfile::tempdir().unwrap();
        let want = [9u8; KEY_LEN];
        // Keychain even *has* a different key — env must still win.
        let kc = FakeKeychain::new(KeychainState::Key([3u8; KEY_LEN]), true);
        let (got, source) =
            load_master_key_with(Some(b64().encode(want)), &kc, &paths_in(dir.path())).unwrap();
        assert_eq!(got, want);
        assert_eq!(source, MasterKeySource::Env);
    }

    #[test]
    fn malformed_env_key_fails_instead_of_falling_back() {
        let dir = tempfile::tempdir().unwrap();
        let kc = FakeKeychain::new(KeychainState::Key([3u8; KEY_LEN]), true);
        let error = load_master_key_with(Some("not-a-key".to_owned()), &kc, &paths_in(dir.path()))
            .expect_err("an explicit malformed key must stop startup");
        assert!(error.to_string().contains(ENV_MASTER_KEY));
    }

    #[test]
    fn corrupt_file_key_is_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        std::fs::write(&paths.master, "truncated").unwrap();
        let error = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .expect_err("corrupt key material must stop startup");
        assert!(error.to_string().contains("corrupt"));
        assert_eq!(std::fs::read_to_string(&paths.master).unwrap(), "truncated");
    }

    #[test]
    fn publishing_a_key_never_replaces_an_existing_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let winner = write_key_file(&paths.master, &[1u8; KEY_LEN]).unwrap();
        assert_eq!(winner, [1u8; KEY_LEN]);
        let adopted = write_key_file(&paths.master, &[2u8; KEY_LEN]).unwrap();
        assert_eq!(adopted, [1u8; KEY_LEN], "the loser must adopt the winner");
        assert_eq!(read_key_file(&paths.master).unwrap(), Some([1u8; KEY_LEN]));
        // A losing writer leaves no temporary files behind.
        let entries = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(entries, 1);
    }

    #[test]
    fn concurrent_file_key_generators_all_resolve_the_published_key() {
        const GENERATORS: usize = 16;
        for _ in 0..8 {
            let dir = tempfile::tempdir().unwrap();
            let paths = std::sync::Arc::new(paths_in(dir.path()));
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(GENERATORS));
            let handles: Vec<_> = (0..GENERATORS)
                .map(|_| {
                    let paths = std::sync::Arc::clone(&paths);
                    let barrier = std::sync::Arc::clone(&barrier);
                    std::thread::spawn(move || {
                        barrier.wait();
                        load_master_key_with_policy(None, &DisabledKeychain, &paths, true)
                            .expect("every generator must resolve a key")
                    })
                })
                .collect();
            let resolved: Vec<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            let on_disk = read_key_file(&paths.master).unwrap().unwrap();
            for (key, source) in resolved {
                assert_eq!(source, MasterKeySource::File);
                assert_eq!(key, on_disk, "a process kept a key that is not on disk");
            }
        }
    }

    #[test]
    fn keychain_fallback_adopts_a_key_file_another_process_published() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        write_key_file(&paths.master, &[9u8; KEY_LEN]).unwrap();
        let (key, source) = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Empty, false),
            &paths,
        )
        .unwrap();
        assert_eq!(source, MasterKeySource::File);
        assert_eq!(key, [9u8; KEY_LEN]);
    }

    #[test]
    fn corrupt_keychain_entry_is_never_reseeded() {
        let dir = tempfile::tempdir().unwrap();
        let kc = FakeKeychain::new(KeychainState::Corrupt, true);
        let error = load_master_key_with(None, &kc, &paths_in(dir.path()))
            .expect_err("corrupt keychain material must stop startup");
        assert!(error.to_string().contains("corrupt"));
        assert_eq!(*kc.stored.borrow(), None);
    }

    #[test]
    fn legacy_memory_key_is_adopted_as_master() {
        // The migration that protects existing users: an existing memory.key must
        // become the master key (so prior memory_entries still decrypt) and get
        // promoted into the empty keychain.
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let legacy = [42u8; KEY_LEN];
        write_key_file(&paths.legacy_memory, &legacy).unwrap();

        let kc = FakeKeychain::new(KeychainState::Empty, true);
        let (got, source) = load_master_key_with(None, &kc, &paths).unwrap();

        assert_eq!(got, legacy, "must adopt the legacy memory key");
        assert_eq!(
            source,
            MasterKeySource::Keychain,
            "a promoted legacy key now lives in the keychain"
        );
        assert_eq!(
            *kc.stored.borrow(),
            Some(legacy),
            "must promote the legacy key into the keychain"
        );
        assert!(
            !paths.legacy_memory.exists(),
            "verified promotion must retire the raw legacy key"
        );
    }

    #[test]
    fn matching_legacy_duplicate_is_retired_on_later_keychain_boot() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let existing = [17u8; KEY_LEN];
        write_key_file(&paths.legacy_memory, &existing).unwrap();

        let (got, source) = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Key(existing), true),
            &paths,
        )
        .unwrap();
        assert_eq!(got, existing);
        assert_eq!(source, MasterKeySource::Keychain);
        assert!(!paths.legacy_memory.exists());
    }

    /// A keychain that reports a successful write but never keeps it (a locked
    /// or non-persistent Secret Service collection behaves this way).
    struct ForgetfulKeychain;

    impl Keychain for ForgetfulKeychain {
        fn get(&self) -> KeychainState {
            KeychainState::Empty
        }
        fn store(&self, _key: &[u8; KEY_LEN]) -> bool {
            true
        }
    }

    #[test]
    fn unverified_keychain_promotion_keeps_the_legacy_key_and_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let legacy = [21u8; KEY_LEN];
        write_key_file(&paths.legacy_memory, &legacy).unwrap();

        let error = load_master_key_with(None, &ForgetfulKeychain, &paths)
            .expect_err("an unverified promotion must not be reported as keychain custody");
        assert!(error.to_string().contains("verified"), "{error}");
        assert_eq!(
            read_key_file(&paths.legacy_memory).unwrap(),
            Some(legacy),
            "the only durable copy of the key must survive a failed promotion"
        );
        assert!(!paths.master.exists(), "no second raw copy is minted");
    }

    #[test]
    fn mismatched_legacy_duplicate_is_preserved_and_never_removed() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let legacy = [18u8; KEY_LEN];
        write_key_file(&paths.legacy_memory, &legacy).unwrap();

        // Conflicting live keys are not silently reconciled: the keychain key
        // is the master key, and the differing file is kept untouched (it may
        // be the only key for rows sealed under it).
        let (got, source) = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Key([19u8; KEY_LEN]), true),
            &paths,
        )
        .unwrap();
        assert_eq!(got, [19u8; KEY_LEN]);
        assert_eq!(source, MasterKeySource::Keychain);
        assert_eq!(read_key_file(&paths.legacy_memory).unwrap(), Some(legacy));
    }

    #[test]
    fn a_key_file_adopted_into_the_keychain_reports_file_custody_while_it_remains() {
        // An adopted `master.key` is a recovery copy and is kept; while it holds
        // the current key, custody must not claim the key lives outside the
        // folder. A legacy `memory.key` is retired after verified promotion.
        for legacy in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let paths = paths_in(dir.path());
            let key = [17u8; KEY_LEN];
            let file = if legacy {
                &paths.legacy_memory
            } else {
                &paths.master
            };
            write_key_file(file, &key).unwrap();
            let kc = FakeKeychain::new(KeychainState::Empty, true);
            let (got, source) = load_master_key_with(None, &kc, &paths).unwrap();
            assert_eq!(got, key);
            assert_eq!(source, MasterKeySource::Keychain, "the ladder adopts it");
            if legacy {
                // A verified promotion retires the raw legacy `memory.key`.
                assert!(!file.exists(), "the legacy copy is retired");
                assert_eq!(
                    effective_source(source, &got, &paths),
                    MasterKeySource::Keychain
                );
                continue;
            }
            assert!(file.exists(), "the file copy is never deleted");
            assert_eq!(
                effective_source(source, &got, &paths),
                MasterKeySource::File,
                "a copy beside the data is reported as file custody"
            );
            assert_eq!(key_file_copy(&got, &paths).as_ref(), Some(file));
            // A file holding a DIFFERENT key does not downgrade the report.
            std::fs::remove_file(file).unwrap();
            write_key_file(&paths.master, &[18u8; KEY_LEN]).unwrap();
            assert_eq!(
                effective_source(source, &got, &paths),
                MasterKeySource::Keychain
            );
            std::fs::remove_file(&paths.master).unwrap();
            assert_eq!(
                effective_source(source, &got, &paths),
                MasterKeySource::Keychain,
                "once the copy is removed, custody is the keychain"
            );
            // Env and file custody are reported as they are.
            assert_eq!(
                effective_source(MasterKeySource::Env, &got, &paths),
                MasterKeySource::Env
            );
        }
    }

    #[test]
    fn keychain_key_is_used_and_no_file_written() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let existing = [5u8; KEY_LEN];
        let kc = FakeKeychain::new(KeychainState::Key(existing), true);

        let (got, source) = load_master_key_with(None, &kc, &paths).unwrap();
        assert_eq!(got, existing);
        assert_eq!(source, MasterKeySource::Keychain);
        assert!(
            !paths.master.exists(),
            "keychain is authoritative; no file key"
        );
    }

    #[test]
    fn file_fallback_generates_persists_and_reloads_same_key() {
        // No keychain, no files: first call generates+persists; second call must
        // read back the *same* key (else existing data becomes unreadable).
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());

        let (first, first_source) = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .unwrap();
        assert!(paths.master.exists(), "file fallback must persist the key");
        let (second, second_source) = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .unwrap();
        assert_eq!(first, second, "the persisted key must reload identically");
        // Both calls must also AGREE on custody — a status surface that reported
        // `File` on boot and `Keychain` on a later read would be worse than none.
        assert_eq!(first_source, MasterKeySource::File);
        assert_eq!(second_source, MasterKeySource::File);
    }

    /// Empirically confirms the REAL OS keychain on this host: a clean slot reads
    /// back `NoEntry`, a stored value round-trips, and delete works. Uses a unique
    /// throwaway account (never the production `master-key` slot) and cleans up.
    /// `#[ignore]` so normal runs/CI don't touch the OS credential store — run with
    /// `cargo test -p ryu-core -- --ignored real_os_keychain`.
    #[test]
    #[cfg(feature = "os-keychain")]
    #[ignore = "touches the real OS keychain; run explicitly"]
    fn real_os_keychain_round_trips() {
        let account = "master-key-selftest-ryu";
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .expect("keychain must be reachable on this host");
        // Start clean.
        let _ = entry.delete_credential();
        assert!(
            matches!(entry.get_password(), Err(keyring::Error::NoEntry)),
            "empty slot must report NoEntry"
        );
        // Store → read back identically.
        let key = [123u8; KEY_LEN];
        entry
            .set_password(&b64().encode(key))
            .expect("set_password");
        let got = decode_key(&entry.get_password().expect("get_password")).expect("decode");
        assert_eq!(got, key);
        // Clean up.
        entry.delete_credential().expect("delete_credential");
    }

    #[test]
    fn hosts_that_forbid_file_keys_fail_closed_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        for keychain in [
            FakeKeychain::new(KeychainState::Unavailable, false),
            FakeKeychain::new(KeychainState::Empty, false),
        ] {
            let error = load_master_key_with_policy(None, &keychain, &paths, false)
                .expect_err("no env key and no keychain must stop startup");
            assert!(error.to_string().contains(ENV_MASTER_KEY), "{error}");
            assert!(!paths.master.exists(), "no key file may be generated");
        }
        // An existing file key is not silently adopted either.
        write_key_file(&paths.master, &[6u8; KEY_LEN]).unwrap();
        assert!(load_master_key_with_policy(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
            false,
        )
        .is_err());
        // External custody still works under the strict policy.
        let want = [8u8; KEY_LEN];
        let (got, source) = load_master_key_with_policy(
            Some(b64().encode(want)),
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
            false,
        )
        .unwrap();
        assert_eq!((got, source), (want, MasterKeySource::Env));
        let kc = FakeKeychain::new(KeychainState::Empty, true);
        let (_, source) =
            load_master_key_with_policy(None, &kc, &paths_in(dir.path()), false).unwrap();
        assert_eq!(source, MasterKeySource::Keychain);
    }

    #[test]
    fn keychain_unwritable_falls_back_to_file() {
        // Keychain reachable but write fails: the chosen key must still persist to
        // the file so it survives a restart.
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let kc = FakeKeychain::new(KeychainState::Empty, false);

        let (first, first_source) = load_master_key_with(None, &kc, &paths).unwrap();
        assert!(paths.master.exists());
        let (second, second_source) = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .unwrap();
        assert_eq!(first, second);
        // An unwritable keychain is NOT the keychain guarantee — the key landed in
        // the file, and custody must say so rather than flattering the posture.
        assert_eq!(first_source, MasterKeySource::File);
        assert_eq!(second_source, MasterKeySource::File);
    }

    #[test]
    fn an_empty_keychain_never_replaces_an_existing_file_key() {
        // A key file sealed data on an earlier boot. An empty keychain must adopt
        // it (writable) or keep using it unchanged (unwritable) — never generate a
        // fresh key or overwrite the file, which would orphan everything sealed.
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let file_key = [9u8; KEY_LEN];
        write_key_file(&paths.master, &file_key).unwrap();
        write_key_file(&paths.legacy_memory, &[4u8; KEY_LEN]).unwrap();

        for _ in 0..2 {
            let kc = FakeKeychain::new(KeychainState::Empty, false);
            let (got, source) = load_master_key_with(None, &kc, &paths).unwrap();
            assert_eq!((got, source), (file_key, MasterKeySource::File));
            assert_eq!(read_key_file(&paths.master).unwrap(), Some(file_key));
        }

        let kc = FakeKeychain::new(KeychainState::Empty, true);
        let (got, source) = load_master_key_with(None, &kc, &paths).unwrap();
        assert_eq!((got, source), (file_key, MasterKeySource::Keychain));
        assert_eq!(*kc.stored.borrow(), Some(file_key));
        assert_eq!(read_key_file(&paths.master).unwrap(), Some(file_key));
    }

    #[test]
    fn a_keychainless_build_requires_an_explicit_custody_choice() {
        // Neither an env key nor `RYU_KEYCHAIN=off`: refuse instead of silently
        // generating a file key that could fork custody from a keychain-held key.
        let refused = require_explicit_custody_without_keychain(false, false).unwrap_err();
        let message = refused.to_string();
        assert!(message.contains(ENV_MASTER_KEY), "{message}");
        assert!(message.contains(ENV_KEYCHAIN), "{message}");
        // Either explicit choice is accepted.
        assert!(require_explicit_custody_without_keychain(true, false).is_ok());
        assert!(require_explicit_custody_without_keychain(false, true).is_ok());
    }

    /// Runs under `cargo test -p ryu-crypto --no-default-features`.
    #[test]
    #[cfg(not(feature = "os-keychain"))]
    fn a_keychainless_build_reports_the_slot_unreachable() {
        // Without `os-keychain` the slot must read as unreachable and never claim
        // a store, so profile copies and resolution cannot pretend the key landed
        // in a keychain this build cannot see.
        let keychain = OsKeychain {
            account: "master-key-feature-probe-ryu".to_owned(),
        };
        assert!(matches!(keychain.get(), KeychainState::Unavailable));
        assert!(!keychain.store(&[7u8; KEY_LEN]));
        assert!(matches!(
            copy_master_key_between_profiles("-probe-a", "-probe-b"),
            KeyCopy::Unavailable
        ));
    }
}
