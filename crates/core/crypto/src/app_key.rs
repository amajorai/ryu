//! App-owned keys: a [`FieldCipher`] whose 32-byte key lives in its OWN OS
//! keychain slot, for a first-party process that is not Core (the desktop
//! shell) and seals stores only it reads.
//!
//! Why not the master key: on macOS a keychain item trusts only the binary that
//! created it, so a second binary reading Core's `master-key{suffix}` item gets a
//! system prompt (and Core gets one if the other binary created the item first).
//! A store read on every desktop launch cannot rely on that, so the desktop keeps
//! a key it created itself, exactly like its existing BYOK keychain entries.
//!
//! Custody follows the master-key ladder (same code path, different slot):
//!
//! 1. `RYU_MASTER_KEY` (operator-supplied; never written anywhere by us);
//! 2. the OS keychain, service `ryu`, account `<slot><profile suffix>`; seeded on
//!    first use;
//! 3. `<data dir>/secrets/<slot>.key` (`0600`) only when no keychain is reachable
//!    (or `RYU_KEYCHAIN=off`) and the host allows the file fallback. A file key
//!    left from such a period is adopted into the keychain once it becomes
//!    reachable, so values sealed meanwhile keep opening.
//!
//! Unlike the master-key ladder it was copied from, a slot that has been used
//! (a key check value in `state/<slot>.kcv.json`, or a sealed file of the slot
//! in `secrets/`) never generates a key while the keychain cannot be read: the
//! call fails and callers treat the key as locked. The recorded key check value
//! also pins the current key when the keychain and the key file disagree; the
//! other one stays a retired key that still opens what it sealed.
//!
//! Every value is an ordinary `enc:v1:` envelope; only the key differs.

use std::cell::Cell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use super::{
    custody, decode_key, host, key_check_value, layout, load_master_key_guarded, read_key_file,
    require_explicit_custody_without_keychain, CryptoHost, DisabledKeychain, FieldCipher, KeyPaths,
    Keychain, KeychainState, MasterKeySource, OsKeychain, ENV_KEYCHAIN, ENV_MASTER_KEY,
    KEYRING_ACCOUNT,
};
use anyhow::{anyhow, Context, Result};

/// Registered app-key slots. The slot is the keychain account prefix and the
/// key-file name: add new names here, never rename one (that orphans the key).
pub mod app_keys {
    /// The desktop shell's own stores (auth vault, license key, CLI-setup
    /// snapshots).
    pub const DESKTOP: &str = "desktop-seal-key";
}

fn validate_slot(slot: &str) -> Result<()> {
    let well_formed = !slot.is_empty()
        && slot.len() <= 64
        && slot
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
    if !well_formed {
        return Err(anyhow!("invalid app key slot {slot:?}"));
    }
    if slot == KEYRING_ACCOUNT || slot.starts_with(&format!("{KEYRING_ACCOUNT}-")) {
        return Err(anyhow!(
            "app key slot {slot:?} collides with the master key"
        ));
    }
    Ok(())
}

fn app_key_paths(host: &dyn CryptoHost, slot: &str) -> KeyPaths {
    let file = layout::secret_path(&host.ryu_dir(), &format!("{slot}.key"));
    // The file is also the "legacy" input: a key generated while no keychain was
    // reachable is moved into the keychain slot the first time it is empty.
    KeyPaths {
        master: file.clone(),
        legacy_memory: file,
    }
}

/// The app key and the other keys this slot has used, which still open values.
#[derive(Clone)]
struct AppKey {
    key: [u8; super::KEY_LEN],
    retired: Vec<[u8; super::KEY_LEN]>,
}

/// `state/<slot>.kcv.json`: the key check value of the key this slot resolved
/// to (never key material). Its presence means the slot has sealed data, so a
/// key may no longer be generated while the keychain cannot be read, and it
/// pins which key is current when the keychain and the file hold different ones.
#[derive(serde::Serialize, serde::Deserialize)]
struct AppKcvRecord {
    v: u32,
    kcv: String,
    custody: String,
}

fn app_kcv_path(dir: &Path, slot: &str) -> PathBuf {
    layout::state_path(dir, &format!("{slot}.kcv.json"))
}

fn read_app_kcv(dir: &Path, slot: &str) -> std::result::Result<Option<String>, String> {
    custody::read_json::<AppKcvRecord>(&app_kcv_path(dir, slot))
        .map(|record| record.map(|record| record.kcv))
        .map_err(|error| format!("{error:#}"))
}

fn write_app_kcv(dir: &Path, slot: &str, kcv: &str, source: MasterKeySource) {
    let record = AppKcvRecord {
        v: 1,
        kcv: kcv.to_owned(),
        custody: source.as_str().to_owned(),
    };
    let written = serde_json::to_vec_pretty(&record)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| custody::write_atomic(&app_kcv_path(dir, slot), &bytes, false));
    if let Err(error) = written {
        tracing::warn!(slot, "could not record the app key check value: {error:#}");
    }
}

/// Files under `secrets/` that only exist once `slot` has sealed something:
/// evidence for slots used before their key check value was recorded.
fn sealed_file_prefix(slot: &str) -> Option<&'static str> {
    match slot {
        app_keys::DESKTOP => Some("desktop-"),
        _ => None,
    }
}

fn sealed_file_evidence(dir: &Path, slot: &str) -> Option<String> {
    let prefix = sealed_file_prefix(slot)?;
    let entries = std::fs::read_dir(layout::secrets_dir(dir)).ok()?;
    entries.flatten().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        (name.starts_with(prefix) && name.ends_with(".sealed"))
            .then(|| format!("{name} holds sealed data"))
    })
}

/// A keychain that remembers whether it was unreachable and which key it held,
/// so the generation guard can apply only to the unreachable case and the
/// resolver can tell the keychain key from the file key afterwards.
struct ObservedKeychain<'a> {
    inner: &'a dyn Keychain,
    unavailable: Cell<bool>,
    held: Cell<Option<[u8; super::KEY_LEN]>>,
}

impl Keychain for ObservedKeychain<'_> {
    fn get(&self) -> KeychainState {
        let state = self.inner.get();
        match state {
            KeychainState::Unavailable => self.unavailable.set(true),
            KeychainState::Key(key) => self.held.set(Some(key)),
            KeychainState::Empty | KeychainState::Corrupt => {}
        }
        state
    }
    fn store(&self, key: &[u8; super::KEY_LEN]) -> bool {
        self.inner.store(key)
    }
}

fn resolve_app_key(
    host: &dyn CryptoHost,
    slot: &str,
    env_value: Option<String>,
    keychain: &dyn Keychain,
) -> Result<AppKey> {
    let dir = host.ryu_dir();
    let paths = app_key_paths(host, slot);
    let allow_file = host.allow_file_key();
    let recorded = read_app_kcv(&dir, slot);
    let observed = ObservedKeychain {
        inner: keychain,
        unavailable: Cell::new(false),
        held: Cell::new(None),
    };
    // A key is never generated while the keychain cannot be read (locked, a
    // denied prompt, Secret Service not up yet) once the slot has been used: the
    // new key would replace the keychain key for this launch and orphan every
    // value sealed under it. A reachable but empty keychain may still generate
    // (the entry was deleted; nothing can recover it).
    let evidence = || -> Option<String> {
        if !observed.unavailable.get() {
            return None;
        }
        match &recorded {
            Ok(Some(kcv)) => Some(format!("a key check value is recorded ({kcv})")),
            Ok(None) => sealed_file_evidence(&dir, slot),
            Err(error) => Some(format!("the key check record is unreadable: {error}")),
        }
    };
    let guard = custody::GenerationGuard::new(&evidence);
    let (ladder_key, source) =
        load_master_key_guarded(env_value.clone(), &observed, &paths, allow_file, &guard)?;

    let mut candidates = vec![ladder_key];
    let file_key = if allow_file {
        read_key_file(&paths.master).ok().flatten()
    } else {
        None
    };
    for key in [
        env_value.as_deref().and_then(decode_key),
        observed.held.get(),
        file_key,
    ]
    .into_iter()
    .flatten()
    {
        if !candidates.contains(&key) {
            candidates.push(key);
        }
    }

    let recorded_kcv = recorded.ok().flatten();
    let key = match &recorded_kcv {
        Some(kcv) if *kcv != key_check_value(&ladder_key) && source != MasterKeySource::Env => {
            if let Some(pinned) = candidates
                .iter()
                .copied()
                .find(|candidate| key_check_value(candidate) == *kcv)
            {
                pinned
            } else if source == MasterKeySource::File && observed.unavailable.get() {
                return Err(anyhow!(
                    "the OS keychain is unavailable and the key file in secrets/ is not the key \
                     that sealed this slot (recorded key check value {kcv}); refusing to use it. \
                     Unlock the keychain or provide the key ({ENV_MASTER_KEY})"
                ));
            } else {
                tracing::warn!(
                    slot,
                    "the app key changed and no copy of the recorded key remains; values sealed \
                     under the old key no longer open"
                );
                ladder_key
            }
        }
        _ => ladder_key,
    };
    let kcv = key_check_value(&key);
    if recorded_kcv.as_deref() != Some(kcv.as_str()) {
        write_app_kcv(&dir, slot, &kcv, source);
    }
    let retired = candidates
        .into_iter()
        .filter(|candidate| *candidate != key)
        .collect();
    Ok(AppKey { key, retired })
}

fn cache() -> &'static Mutex<HashMap<String, AppKey>> {
    static CACHE: OnceLock<Mutex<HashMap<String, AppKey>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The [`FieldCipher`] for an app-owned key slot (see [`app_keys`]). Resolved
/// once per process and cached. **Fails closed**: an error means nothing may be
/// sealed or opened, never that plaintext is acceptable. Values sealed under a
/// key this slot used earlier (a file key from a keychainless period next to a
/// different keychain key) still open.
pub fn app_cipher(slot: &str) -> Result<FieldCipher> {
    resolve_cached(slot).map(|app| FieldCipher::new(&app.key).with_retired(&app.retired))
}

/// The raw app key of `slot` and the slot's earlier keys, for content-key
/// derivation inside this crate.
pub(crate) fn app_key_bytes(
    slot: &str,
) -> Result<([u8; super::KEY_LEN], Vec<[u8; super::KEY_LEN]>)> {
    resolve_cached(slot).map(|app| (app.key, app.retired))
}

fn resolve_cached(slot: &str) -> Result<AppKey> {
    validate_slot(slot)?;
    if let Some(cached) = cache()
        .lock()
        .map_err(|_| anyhow!("app key cache poisoned"))?
        .get(slot)
    {
        return Ok(cached.clone());
    }
    let host = host()?;
    let env_value = std::env::var(ENV_MASTER_KEY).ok();
    let keychain_disabled = matches!(
        std::env::var(ENV_KEYCHAIN),
        Ok(value) if value.trim().eq_ignore_ascii_case("off")
    );
    if !cfg!(feature = "os-keychain") {
        require_explicit_custody_without_keychain(env_value.is_some(), keychain_disabled)?;
    }
    let os_keychain = OsKeychain {
        account: format!("{slot}{}", host.keyring_account_suffix()),
    };
    let keychain: &dyn Keychain = if keychain_disabled {
        &DisabledKeychain
    } else {
        &os_keychain
    };
    // An error is not cached: the next call tries again (the keychain may have
    // been unlocked meanwhile).
    let app = resolve_app_key(&*host, slot, env_value, keychain)
        .with_context(|| format!("loading the {slot} key"))?;
    cache()
        .lock()
        .map_err(|_| anyhow!("app key cache poisoned"))?
        .insert(slot.to_owned(), app.clone());
    Ok(app)
}

#[cfg(test)]
mod tests {
    use super::super::{write_key_file, KEY_LEN};
    use super::*;
    use std::cell::RefCell;
    use std::path::PathBuf;

    struct TestHost(PathBuf);

    impl CryptoHost for TestHost {
        fn keyring_account_suffix(&self) -> String {
            "-test".to_owned()
        }
        fn ryu_dir(&self) -> PathBuf {
            self.0.clone()
        }
    }

    struct FakeKeychain {
        held: RefCell<Option<[u8; KEY_LEN]>>,
        reachable: bool,
    }

    impl Keychain for FakeKeychain {
        fn get(&self) -> KeychainState {
            if !self.reachable {
                return KeychainState::Unavailable;
            }
            match *self.held.borrow() {
                Some(key) => KeychainState::Key(key),
                None => KeychainState::Empty,
            }
        }
        fn store(&self, key: &[u8; KEY_LEN]) -> bool {
            if self.reachable {
                *self.held.borrow_mut() = Some(*key);
            }
            self.reachable
        }
    }

    #[test]
    fn slot_names_are_validated_and_never_alias_the_master_key() {
        assert!(validate_slot(app_keys::DESKTOP).is_ok());
        assert!(validate_slot("").is_err());
        assert!(validate_slot("Desktop").is_err());
        assert!(validate_slot("../escape").is_err());
        assert!(validate_slot("master-key").is_err());
        assert!(validate_slot("master-key-dev").is_err());
    }

    #[test]
    fn keychain_held_key_is_seeded_once_and_never_written_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let keychain = FakeKeychain {
            held: RefCell::new(None),
            reachable: true,
        };
        let first = resolve_app_key(&host, app_keys::DESKTOP, None, &keychain)
            .unwrap()
            .key;
        let second = resolve_app_key(&host, app_keys::DESKTOP, None, &keychain)
            .unwrap()
            .key;
        assert_eq!(first, second);
        assert_eq!(*keychain.held.borrow(), Some(first));
        assert!(!layout::secret_path(dir.path(), "desktop-seal-key.key").exists());
    }

    #[test]
    fn file_key_from_a_keychainless_period_is_adopted_by_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let offline = FakeKeychain {
            held: RefCell::new(None),
            reachable: false,
        };
        let file_key = resolve_app_key(&host, app_keys::DESKTOP, None, &offline)
            .unwrap()
            .key;
        let file = layout::secret_path(dir.path(), "desktop-seal-key.key");
        assert!(file.exists());
        let sealed = FieldCipher::new(&file_key).seal("value").unwrap();

        let online = FakeKeychain {
            held: RefCell::new(None),
            reachable: true,
        };
        let adopted = resolve_app_key(&host, app_keys::DESKTOP, None, &online)
            .unwrap()
            .key;
        assert_eq!(adopted, file_key);
        assert_eq!(
            FieldCipher::new(&adopted).open(&sealed).unwrap(),
            "value",
            "values sealed under the file key must keep opening"
        );
    }

    #[test]
    fn env_key_wins_and_is_not_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let keychain = FakeKeychain {
            held: RefCell::new(None),
            reachable: true,
        };
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode([9u8; KEY_LEN]);
        let key = resolve_app_key(&host, app_keys::DESKTOP, Some(encoded), &keychain)
            .unwrap()
            .key;
        assert_eq!(key, [9u8; KEY_LEN]);
        assert!(keychain.held.borrow().is_none());
        assert!(!layout::secret_path(dir.path(), "desktop-seal-key.key").exists());
    }

    fn keychain(held: Option<[u8; KEY_LEN]>, reachable: bool) -> FakeKeychain {
        FakeKeychain {
            held: RefCell::new(held),
            reachable,
        }
    }

    #[test]
    fn a_used_slot_never_generates_a_key_while_the_keychain_is_unreachable() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let online = keychain(None, true);
        let original = resolve_app_key(&host, app_keys::DESKTOP, None, &online)
            .unwrap()
            .key;

        // A denied prompt, a locked keychain, or Secret Service not up yet.
        let offline = keychain(None, false);
        let error = resolve_app_key(&host, app_keys::DESKTOP, None, &offline)
            .err()
            .expect("must refuse instead of generating a different key");
        assert!(format!("{error:#}").contains("refusing to generate"));
        assert!(
            !layout::secret_path(dir.path(), "desktop-seal-key.key").exists(),
            "no replacement key file may be written"
        );

        // The next launch with the keychain back gets the original key.
        let again = resolve_app_key(&host, app_keys::DESKTOP, None, &online)
            .unwrap()
            .key;
        assert_eq!(again, original);
    }

    #[test]
    fn sealed_desktop_files_count_as_use_before_a_key_check_value_exists() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let vault = layout::secret_path(dir.path(), "desktop-auth-vault.sealed");
        std::fs::create_dir_all(vault.parent().unwrap()).unwrap();
        std::fs::write(&vault, "enc:v1:sealed").unwrap();
        let offline = keychain(None, false);
        assert!(resolve_app_key(&host, app_keys::DESKTOP, None, &offline).is_err());
        assert!(!layout::secret_path(dir.path(), "desktop-seal-key.key").exists());
    }

    #[test]
    fn a_stray_file_key_is_refused_while_the_keychain_is_locked_and_opens_as_retired_later() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let keychain_key = [3u8; KEY_LEN];
        let online = keychain(Some(keychain_key), true);
        assert_eq!(
            resolve_app_key(&host, app_keys::DESKTOP, None, &online)
                .unwrap()
                .key,
            keychain_key
        );
        // A file key an older build generated during an earlier locked launch.
        let stray = [7u8; KEY_LEN];
        let file = layout::secret_path(dir.path(), "desktop-seal-key.key");
        write_key_file(&file, &stray).unwrap();
        let sealed_by_stray = FieldCipher::new(&stray)
            .seal("from the locked launch")
            .unwrap();

        let offline = keychain(None, false);
        assert!(
            resolve_app_key(&host, app_keys::DESKTOP, None, &offline).is_err(),
            "the file key is not the key this slot recorded"
        );

        let app = resolve_app_key(&host, app_keys::DESKTOP, None, &online).unwrap();
        assert_eq!(app.key, keychain_key);
        assert_eq!(app.retired, vec![stray]);
        let cipher = FieldCipher::new(&app.key).with_retired(&app.retired);
        assert_eq!(
            cipher.open(&sealed_by_stray).unwrap(),
            "from the locked launch"
        );
    }

    #[test]
    fn the_recorded_key_stays_current_when_keychain_and_file_disagree() {
        let dir = tempfile::tempdir().unwrap();
        let host = TestHost(dir.path().to_path_buf());
        let offline = keychain(None, false);
        let file_key = resolve_app_key(&host, app_keys::DESKTOP, None, &offline)
            .unwrap()
            .key;
        // The keychain turns up holding a different key (say, from another
        // install): the recorded key keeps sealing, the keychain key opens.
        let other = [4u8; KEY_LEN];
        let online = keychain(Some(other), true);
        let app = resolve_app_key(&host, app_keys::DESKTOP, None, &online).unwrap();
        assert_eq!(app.key, file_key);
        assert_eq!(app.retired, vec![other]);
    }
}
