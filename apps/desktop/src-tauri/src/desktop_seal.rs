//! Sealing for the stores only the desktop shell reads.
//!
//! The key is the desktop's OWN OS-keychain key (`ryu_crypto::app_cipher` with
//! [`ryu_crypto::app_keys::DESKTOP`]; service `ryu`, account
//! `desktop-seal-key{profile suffix}`), not Core's master key: a second binary
//! reading Core's keychain item would prompt on macOS, and these stores are read
//! on every launch. Custody follows the master-key ladder (`RYU_MASTER_KEY` →
//! keychain → `secrets/desktop-seal-key.key` only when no keychain is reachable),
//! and every value is an ordinary `enc:v1:` ChaCha20-Poly1305 envelope.
//!
//! What lives here:
//!
//! * [`DesktopSecret`] slots: whole values sealed into one file each under the
//!   data dir's `secrets/` (`desktop-auth-vault.sealed`,
//!   `desktop-license-key.sealed`). The webview reaches them only through the
//!   `desktop_secret_*` commands in `secrets.rs`; nothing else reads them.
//! * [`sealed_opt_string`]: a serde adapter that seals one optional string field
//!   inside a JSON file (the CLI-setup snapshots' `original` copies).
//!
//! Writes fail closed: without a key nothing is written. Reads of a sealed value
//! that will not open are errors, never empty values.
//!
//! This module has no Tauri dependency, so `tools/cli-setup-native-bridge`
//! compiles it next to `cli_setup.rs`.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ryu_crypto::FieldCipher;

/// Install the crypto host this process resolves keys through: the desktop's
/// own data dir and profile suffix (which also honors the `dev-variant` build and
/// the version's channel, not only `RYU_PROFILE`). Call once at startup, before
/// the first seal or open. Idempotent.
pub fn install_crypto_host(data_dir: PathBuf, profile_suffix: String) {
    ryu_crypto::set_global_host(Arc::new(
        ryu_crypto::StandaloneCryptoHost::with_dir_and_suffix(data_dir, profile_suffix),
    ));
}

#[cfg(not(test))]
fn cipher() -> Result<FieldCipher, String> {
    ryu_crypto::app_cipher(ryu_crypto::app_keys::DESKTOP)
        .map_err(|error| format!("The desktop encryption key is unavailable: {error:#}"))
}

/// Unit tests never touch the OS keychain: a fixed key stands in.
#[cfg(test)]
fn cipher() -> Result<FieldCipher, String> {
    Ok(test_cipher())
}

#[cfg(test)]
pub(crate) fn test_cipher() -> FieldCipher {
    FieldCipher::new(&[0x5a; 32])
}

/// Seal `plaintext` as `enc:v1:`. Fails closed when no key is available.
pub fn seal(plaintext: &str) -> Result<String, String> {
    cipher()?
        .seal(plaintext)
        .map_err(|error| format!("Sealing failed: {error:#}"))
}

/// Whether `stored` is a sealed envelope (as opposed to legacy plaintext).
pub fn is_sealed(stored: &str) -> bool {
    FieldCipher::is_sealed(stored)
}

/// Open a stored value. Legacy plaintext passes through unchanged (lazy
/// migration: the next write seals it); a sealed value that will not open is an
/// error.
pub fn open(stored: &str) -> Result<String, String> {
    if !is_sealed(stored) {
        return Ok(stored.to_owned());
    }
    cipher()?
        .open(stored)
        .map_err(|_| "A sealed desktop value could not be opened with this device's key".to_owned())
}

/// Prefix the webview's store names are derived under, so a webview key can
/// never equal a key of the shell's own stores.
const WEBVIEW_STORE_PREFIX: &str = "desktop-webview:";

/// The webview stores that may ask for a content key. A closed set: the command
/// cannot be used to derive keys for arbitrary names.
const WEBVIEW_STORES: &[&str] = &["collaboration", "local-storage"];

/// The keys the desktop webview seals one of its own stores with (`wenc:v1:`
/// values, Yjs snapshot records), as the `desktop_content_key` command returns
/// them: `{ "key": [32 bytes], "retired": [[32 bytes], ...] }`.
///
/// `key` is derived from the desktop app key
/// (`ryu_crypto::app_webview_keys`, store `desktop-webview:<store>`), so it
/// follows that key's keychain custody and is never written anywhere. `retired`
/// holds the same derivation under each desktop key the app used earlier (a
/// file key from a launch without a reachable keychain next to the keychain
/// key): the webview only opens with them, and reseals what they opened under
/// `key`. The webview imports every key as a non-extractable `CryptoKey`.
/// Host-only: no `Debug`, never log it.
#[derive(serde::Serialize)]
pub struct WebviewContentKeys {
    key: Vec<u8>,
    retired: Vec<Vec<u8>>,
}

/// The webview content keys of `store` (see [`WebviewContentKeys`]).
///
/// Fails (never generates a different key) when the desktop key is unavailable,
/// for example while the keychain is locked: the webview treats that as
/// "locked", not as data that failed to decrypt.
pub fn webview_content_key(store: &str) -> Result<WebviewContentKeys, String> {
    webview_content_key_with(store, |name| {
        ryu_crypto::app_webview_keys(ryu_crypto::app_keys::DESKTOP, name)
            .map(|keys| (keys.current, keys.retired))
            .map_err(|error| format!("The desktop encryption key is unavailable: {error:#}"))
    })
}

type WebviewKeyBytes = ([u8; 32], Vec<[u8; 32]>);

fn webview_content_key_with(
    store: &str,
    derive: impl FnOnce(&str) -> Result<WebviewKeyBytes, String>,
) -> Result<WebviewContentKeys, String> {
    if !WEBVIEW_STORES.contains(&store) {
        return Err("Unknown webview content store".to_owned());
    }
    derive(&format!("{WEBVIEW_STORE_PREFIX}{store}")).map(|(key, retired)| WebviewContentKeys {
        key: key.to_vec(),
        retired: retired.iter().map(|key| key.to_vec()).collect(),
    })
}

/// A whole secret the desktop keeps sealed in its own file under `secrets/`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DesktopSecret {
    /// The multi-account Better Auth vault (accounts with bearer tokens and the
    /// active account id), as the JSON the webview's auth client owns.
    AuthVault,
    /// The paid desktop license key.
    LicenseKey,
}

impl DesktopSecret {
    /// Parse the slot name the webview passes. Only these names exist: the
    /// commands cannot be used to read or write any other file.
    pub fn parse(name: &str) -> Result<Self, String> {
        match name {
            "auth-vault" => Ok(Self::AuthVault),
            "license-key" => Ok(Self::LicenseKey),
            _ => Err("Unknown desktop secret".to_owned()),
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::AuthVault => "auth-vault",
            Self::LicenseKey => "license-key",
        }
    }

    fn file_name(self) -> &'static str {
        match self {
            Self::AuthVault => "desktop-auth-vault.sealed",
            Self::LicenseKey => "desktop-license-key.sealed",
        }
    }

    /// `<data dir>/secrets/<file>` through the shared data-dir layout.
    pub fn path(self, data_dir: &Path) -> PathBuf {
        ryu_sidecar_runtime::layout::secret_path(data_dir, self.file_name())
    }
}

/// Upper bound for one sealed secret (a vault of many accounts is a few KiB).
const MAX_SECRET_BYTES: usize = 256 * 1024;

/// Read and open a sealed secret file. `Ok(None)` when it does not exist. The
/// file must hold a sealed envelope: these files were never written in
/// plaintext, so anything else is tampering or corruption and is refused.
pub fn read_secret_file(path: &Path) -> Result<Option<String>, String> {
    let stored = match std::fs::read_to_string(path) {
        Ok(stored) => stored,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Reading a desktop secret failed: {error}")),
    };
    let stored = stored.trim();
    if !is_sealed(stored) {
        return Err("A desktop secret file is not sealed; refusing to use it".to_owned());
    }
    open(stored).map(Some)
}

/// Seal `value` and atomically replace the file (owner-only `0600` on Unix via
/// the temp file; the parent `secrets/` dir is created `0700`).
pub fn write_secret_file(path: &Path, value: &str) -> Result<(), String> {
    if value.len() > MAX_SECRET_BYTES {
        return Err("Desktop secret is too large".to_owned());
    }
    let sealed = seal(value)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Desktop secret path has no parent".to_owned())?;
    create_private_dir(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Writing a desktop secret failed: {error}"))?;
    temporary
        .write_all(sealed.as_bytes())
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|error| format!("Writing a desktop secret failed: {error}"))?;
    temporary
        .persist(path)
        .map_err(|error| format!("Writing a desktop secret failed: {}", error.error))?;
    Ok(())
}

/// Remove a secret file. Idempotent.
pub fn delete_secret_file(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Deleting a desktop secret failed: {error}")),
    }
}

fn create_private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("Creating {} failed: {error}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        // Best effort: an existing secrets/ dir created by Core is already 0700.
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Serde adapter for an `Option<String>` field that must be sealed on disk.
/// Serializing seals (and fails closed without a key); deserializing opens a
/// sealed value and accepts legacy plaintext.
pub mod sealed_opt_string {
    use serde::{de::Error as _, ser::Error as _, Deserialize as _, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(
        value: &Option<String>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            None => serializer.serialize_none(),
            Some(plaintext) => {
                let sealed = super::seal(plaintext).map_err(S::Error::custom)?;
                serializer.serialize_some(&sealed)
            }
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<String>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|stored| super::open(&stored).map_err(D::Error::custom))
            .transpose()
    }
}

/// Seal every legacy plaintext `"original"` string inside a JSON document (at
/// any depth). Returns the rewritten document when something changed.
pub fn reseal_json_originals(document: &str) -> Result<Option<String>, String> {
    let mut value: serde_json::Value =
        serde_json::from_str(document).map_err(|error| error.to_string())?;
    let mut changed = false;
    reseal_value(&mut value, &mut changed)?;
    if !changed {
        return Ok(None);
    }
    serde_json::to_string(&value)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn reseal_value(value: &mut serde_json::Value, changed: &mut bool) -> Result<(), String> {
    let serde_json::Value::Object(map) = value else {
        return Ok(());
    };
    for (key, child) in map.iter_mut() {
        match child {
            serde_json::Value::String(text) if key == "original" && !is_sealed(text) => {
                *text = seal(text)?;
                *changed = true;
            }
            serde_json::Value::Object(_) => reseal_value(child, changed)?,
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "ryu-desktop-secret-0123456789";

    #[test]
    fn webview_content_keys_are_a_closed_set_under_their_own_prefix() {
        let mut asked = Vec::new();
        for store in WEBVIEW_STORES {
            let keys = webview_content_key_with(store, |name| {
                asked.push(name.to_owned());
                Ok(([7; 32], Vec::new()))
            })
            .unwrap();
            assert_eq!(keys.key.len(), 32);
            assert!(keys.retired.is_empty());
        }
        assert_eq!(
            asked,
            vec![
                "desktop-webview:collaboration".to_owned(),
                "desktop-webview:local-storage".to_owned()
            ]
        );
        for bad in ["", "auth-vault", "desktop-webview:collaboration", "../x"] {
            assert!(webview_content_key_with(bad, |_| Ok(([7; 32], Vec::new()))).is_err());
        }
        let locked = webview_content_key_with("collaboration", |_| Err("locked".to_owned()));
        assert_eq!(locked.err(), Some("locked".to_owned()));
    }

    #[test]
    fn webview_content_keys_carry_the_retired_keys_as_the_webview_reads_them() {
        let keys =
            webview_content_key_with("local-storage", |_| Ok(([1; 32], vec![[2; 32], [3; 32]])))
                .unwrap();
        let wire = serde_json::to_value(&keys).unwrap();
        assert_eq!(wire["key"], serde_json::json!(vec![1; 32]));
        assert_eq!(
            wire["retired"],
            serde_json::json!([vec![2; 32], vec![3; 32]])
        );
        assert_eq!(wire.as_object().unwrap().len(), 2);
    }

    #[test]
    fn secret_slots_are_a_closed_set_under_secrets() {
        let data = Path::new("/data");
        assert_eq!(
            DesktopSecret::parse("auth-vault"),
            Ok(DesktopSecret::AuthVault)
        );
        assert_eq!(
            DesktopSecret::parse("license-key"),
            Ok(DesktopSecret::LicenseKey)
        );
        assert!(DesktopSecret::parse("../nodes.json").is_err());
        assert!(DesktopSecret::parse("master-key").is_err());
        assert_eq!(
            DesktopSecret::AuthVault.path(data),
            ryu_sidecar_runtime::layout::secret_path(data, "desktop-auth-vault.sealed")
        );
    }

    #[test]
    fn secret_file_round_trips_and_never_holds_the_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = DesktopSecret::AuthVault.path(dir.path());
        assert_eq!(read_secret_file(&path).unwrap(), None);
        write_secret_file(&path, SECRET).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains(SECRET));
        assert!(String::from_utf8_lossy(&bytes).starts_with("enc:v1:"));
        assert_eq!(read_secret_file(&path).unwrap().as_deref(), Some(SECRET));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        delete_secret_file(&path).unwrap();
        delete_secret_file(&path).unwrap();
        assert_eq!(read_secret_file(&path).unwrap(), None);
    }

    #[test]
    fn plaintext_or_foreign_secret_files_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = DesktopSecret::LicenseKey.path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, SECRET).unwrap();
        assert!(read_secret_file(&path).is_err());
        let foreign = FieldCipher::new(&[1; 32]).seal(SECRET).unwrap();
        std::fs::write(&path, foreign).unwrap();
        assert!(read_secret_file(&path).is_err());
    }

    #[derive(serde::Serialize, serde::Deserialize)]
    struct Snapshot {
        #[serde(default, with = "sealed_opt_string")]
        original: Option<String>,
    }

    #[test]
    fn sealed_field_round_trips_and_reads_legacy_plaintext() {
        let saved = serde_json::to_string(&Snapshot {
            original: Some(SECRET.to_owned()),
        })
        .unwrap();
        assert!(!saved.contains(SECRET));
        let back: Snapshot = serde_json::from_str(&saved).unwrap();
        assert_eq!(back.original.as_deref(), Some(SECRET));

        let legacy: Snapshot =
            serde_json::from_str(&format!(r#"{{"original":"{SECRET}"}}"#)).unwrap();
        assert_eq!(legacy.original.as_deref(), Some(SECRET));
        let none: Snapshot = serde_json::from_str(r#"{"original":null}"#).unwrap();
        assert_eq!(none.original, None);
        let missing: Snapshot = serde_json::from_str("{}").unwrap();
        assert_eq!(missing.original, None);

        let wrong_key = FieldCipher::new(&[2; 32]).seal(SECRET).unwrap();
        assert!(
            serde_json::from_str::<Snapshot>(&format!(r#"{{"original":"{wrong_key}"}}"#)).is_err()
        );
    }

    #[test]
    fn reseal_seals_nested_plaintext_originals_once() {
        let legacy = format!(
            r#"{{"settings":{{"original":"{SECRET}","applied_hash":"h"}},"environment":{{"original":null,"applied_hash":"e"}}}}"#
        );
        let resealed = reseal_json_originals(&legacy).unwrap().unwrap();
        assert!(!resealed.contains(SECRET));
        assert!(resealed.contains("\"applied_hash\":\"h\""));
        assert_eq!(reseal_json_originals(&resealed).unwrap(), None);
        let value: serde_json::Value = serde_json::from_str(&resealed).unwrap();
        assert_eq!(
            open(value["settings"]["original"].as_str().unwrap()).unwrap(),
            SECRET
        );
    }
}
