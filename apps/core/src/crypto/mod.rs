//! Shared encryption-at-rest primitives for Core.
//!
//! One crypto path everything hangs off (see `docs/encryption-at-rest.md`). It
//! provides:
//!
//! * [`FieldCipher`] — a ChaCha20-Poly1305 AEAD with a self-describing field
//!   envelope (`enc:v1:<base64(nonce||ciphertext)>`) plus low-level
//!   `encrypt`/`decrypt` for blob columns. [`FieldCipher::open`] transparently
//!   passes through *legacy plaintext* (anything without the `enc:v1:` prefix),
//!   so already-stored rows keep working and upgrade to ciphertext on next write.
//! * A swappable **master key** ([`global_cipher`]) resolved, in priority order,
//!   from `RYU_MASTER_KEY` (env) → the OS keychain (default) → a `~/.ryu` file
//!   fallback. The key lives *outside* the data it protects (keychain), so a copy
//!   of `~/.ryu` alone cannot decrypt. Headless-safe: no source prompts.
//!
//! Placement (Core vs Gateway, CLAUDE.md §1): at-rest encryption of local
//! orchestration data is part of *what runs*, so it lives in Core. The Gateway's
//! firewall/DLP governs *what is allowed/shared* on egress — a separate layer.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use anyhow::{Context, Result};
use base64::Engine as _;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;

/// Field-envelope prefix. Versioned so the scheme can evolve without ambiguity.
const ENVELOPE_PREFIX: &str = "enc:v1:";
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;

/// OS keychain coordinates for the master key.
const KEYRING_SERVICE: &str = "ryu";
const KEYRING_ACCOUNT: &str = "master-key";

/// Env override carrying a base64-encoded 32-byte master key (for
/// servers/containers/CI, or operator-controlled key injection).
const ENV_MASTER_KEY: &str = "RYU_MASTER_KEY";

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::STANDARD
}

/// A reusable AEAD cipher backed by a 32-byte master key. Cheap to clone.
#[derive(Clone)]
pub struct FieldCipher {
    cipher: Arc<ChaCha20Poly1305>,
}

impl FieldCipher {
    /// Build a cipher from an explicit 32-byte key (used by the global loader and
    /// by tests). Production code should use [`global_cipher`].
    pub fn new(key: &[u8; KEY_LEN]) -> Self {
        let key = Key::from_slice(key);
        Self {
            cipher: Arc::new(ChaCha20Poly1305::new(key)),
        }
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

    /// Decrypt a `(nonce, ciphertext)` pair produced by [`Self::encrypt`].
    pub fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        if nonce.len() != NONCE_LEN {
            anyhow::bail!("invalid nonce length {}", nonce.len());
        }
        let nonce = Nonce::from_slice(nonce);
        self.cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| anyhow::anyhow!("decryption failed: {e}"))
    }

    /// Seal a string field into the `enc:v1:` envelope for storage in a `TEXT`
    /// column. The nonce is prepended to the ciphertext, then base64-encoded.
    pub fn seal(&self, plaintext: &str) -> Result<String> {
        let (nonce, ciphertext) = self.encrypt(plaintext.as_bytes())?;
        let mut blob = Vec::with_capacity(nonce.len() + ciphertext.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ciphertext);
        Ok(format!("{ENVELOPE_PREFIX}{}", b64().encode(blob)))
    }

    /// Open a stored field. If it carries the `enc:v1:` prefix it is decrypted;
    /// otherwise it is treated as **legacy plaintext** and returned verbatim. This
    /// is what makes migration lazy: reads accept both forms, writes upgrade.
    pub fn open(&self, stored: &str) -> Result<String> {
        let Some(encoded) = stored.strip_prefix(ENVELOPE_PREFIX) else {
            return Ok(stored.to_string());
        };
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

    /// Whether a stored value is already sealed (carries the envelope prefix).
    pub fn is_sealed(stored: &str) -> bool {
        stored.starts_with(ENVELOPE_PREFIX)
    }
}

/// The process-wide cipher backed by the resolved master key. Lazily initialized
/// on first use from the configured key source.
static GLOBAL: OnceLock<FieldCipher> = OnceLock::new();

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
    let key = load_master_key().context("loading the at-rest master key")?;
    let cipher = FieldCipher::new(&key);
    // First writer wins; a lost race just drops a duplicate equal cipher.
    let _ = GLOBAL.set(cipher.clone());
    Ok(cipher)
}

fn ryu_dir() -> PathBuf {
    crate::paths::ryu_dir()
}

/// Where the file-fallback master key lives (only used when no keychain).
fn master_key_file_path() -> PathBuf {
    ryu_dir().join("master.key")
}

/// The pre-existing memory key. Imported as the master key on first run so
/// already-encrypted `memory_entries` keep decrypting under the unified key.
fn legacy_memory_key_path() -> PathBuf {
    ryu_dir().join("memory.key")
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

fn read_key_file(path: &PathBuf) -> Option<[u8; KEY_LEN]> {
    let encoded = std::fs::read_to_string(path).ok()?;
    decode_key(&encoded)
}

fn write_key_file(path: &PathBuf, key: &[u8; KEY_LEN]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating key dir {}", parent.display()))?;
    }
    std::fs::write(path, b64().encode(key))
        .with_context(|| format!("writing master key {}", path.display()))?;
    restrict_permissions(path);
    Ok(())
}

/// On-disk key file locations. Grouped so the resolution logic can be unit-tested
/// against a temp dir instead of the real `~/.ryu`.
struct KeyPaths {
    /// File-fallback master key (used only when no keychain is reachable).
    master: PathBuf,
    /// Pre-existing memory key, imported as the master key on first run.
    legacy_memory: PathBuf,
}

fn default_key_paths() -> KeyPaths {
    KeyPaths {
        master: master_key_file_path(),
        legacy_memory: legacy_memory_key_path(),
    }
}

/// What the keychain holds for our master-key slot. Distinguishes "reachable but
/// empty" (we should seed it) from "unavailable" (fall back to a file).
enum KeychainState {
    Key([u8; KEY_LEN]),
    Empty,
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
/// Secret Service) via the `keyring` crate.
struct OsKeychain;

impl Keychain for OsKeychain {
    fn get(&self) -> KeychainState {
        let entry = match keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
            Ok(entry) => entry,
            Err(e) => {
                tracing::warn!("keychain unavailable ({e}); falling back to file key");
                return KeychainState::Unavailable;
            }
        };
        match entry.get_password() {
            Ok(stored) => match decode_key(&stored) {
                Some(key) => KeychainState::Key(key),
                // Malformed entry: treat as empty so it gets reseeded.
                None => {
                    tracing::warn!("keychain master key malformed; reseeding");
                    KeychainState::Empty
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
        match keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT) {
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

/// Resolve the 32-byte master key: env → keychain → file fallback, importing a
/// legacy `memory.key` so existing encrypted memory keeps working.
fn load_master_key() -> Result<[u8; KEY_LEN]> {
    load_master_key_with(
        std::env::var(ENV_MASTER_KEY).ok(),
        &OsKeychain,
        &default_key_paths(),
    )
}

/// Testable core of [`load_master_key`]: the env value, keychain, and paths are
/// injected so every branch — including the data-loss-critical `memory.key`
/// migration — can be exercised in unit tests.
fn load_master_key_with(
    env_value: Option<String>,
    keychain: &dyn Keychain,
    paths: &KeyPaths,
) -> Result<[u8; KEY_LEN]> {
    // 1. Env override (highest priority; never written to disk/keychain by us).
    if let Some(encoded) = env_value {
        match decode_key(&encoded) {
            Some(key) => return Ok(key),
            None => tracing::warn!("{ENV_MASTER_KEY} is not a base64 32-byte key; ignoring"),
        }
    }

    // A pre-existing memory key is adopted as the master key so prior entries
    // keep decrypting under the unified key.
    let legacy = read_key_file(&paths.legacy_memory);

    // 2. OS keychain (default where reachable).
    match keychain.get() {
        KeychainState::Key(key) => return Ok(key),
        KeychainState::Empty => {
            let key = legacy.unwrap_or_else(generate_key);
            if keychain.store(&key) {
                return Ok(key);
            }
            // Keychain reachable but unwritable: persist to the file fallback.
            write_key_file(&paths.master, &key)?;
            return Ok(key);
        }
        KeychainState::Unavailable => {}
    }

    // 3. File fallback (headless box with no keychain): current security level.
    if let Some(key) = read_key_file(&paths.master) {
        return Ok(key);
    }
    let key = legacy.unwrap_or_else(generate_key);
    write_key_file(&paths.master, &key)?;
    Ok(key)
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

#[cfg(test)]
mod tests {
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
            match self.start {
                KeychainState::Key(k) => KeychainState::Key(k),
                KeychainState::Empty => KeychainState::Empty,
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
        let got =
            load_master_key_with(Some(b64().encode(want)), &kc, &paths_in(dir.path())).unwrap();
        assert_eq!(got, want);
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
        let got = load_master_key_with(None, &kc, &paths).unwrap();

        assert_eq!(got, legacy, "must adopt the legacy memory key");
        assert_eq!(
            *kc.stored.borrow(),
            Some(legacy),
            "must promote the legacy key into the keychain"
        );
    }

    #[test]
    fn keychain_key_is_used_and_no_file_written() {
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let existing = [5u8; KEY_LEN];
        let kc = FakeKeychain::new(KeychainState::Key(existing), true);

        let got = load_master_key_with(None, &kc, &paths).unwrap();
        assert_eq!(got, existing);
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

        let first = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .unwrap();
        assert!(paths.master.exists(), "file fallback must persist the key");
        let second = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .unwrap();
        assert_eq!(first, second, "the persisted key must reload identically");
    }

    /// Empirically confirms the REAL OS keychain on this host: a clean slot reads
    /// back `NoEntry`, a stored value round-trips, and delete works. Uses a unique
    /// throwaway account (never the production `master-key` slot) and cleans up.
    /// `#[ignore]` so normal runs/CI don't touch the OS credential store — run with
    /// `cargo test -p ryu-core -- --ignored real_os_keychain`.
    #[test]
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
    fn keychain_unwritable_falls_back_to_file() {
        // Keychain reachable but write fails: the chosen key must still persist to
        // the file so it survives a restart.
        let dir = tempfile::tempdir().unwrap();
        let paths = paths_in(dir.path());
        let kc = FakeKeychain::new(KeychainState::Empty, false);

        let first = load_master_key_with(None, &kc, &paths).unwrap();
        assert!(paths.master.exists());
        let second = load_master_key_with(
            None,
            &FakeKeychain::new(KeychainState::Unavailable, false),
            &paths,
        )
        .unwrap();
        assert_eq!(first, second);
    }
}
