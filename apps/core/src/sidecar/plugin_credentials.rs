//! Random, per-plugin credentials for the native sidecar boundary.
//!
//! A sidecar never receives the node owner token. Core creates one independent
//! credential for each plugin, seals it with the node master key, and injects
//! only that credential into the plugin's processes. The filename is a digest of
//! the plugin id, so a manifest id can never escape the credentials directory.

use rand::RngCore;
use ryu_crypto::{global_cipher, FieldCipher};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Error, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const STORE_VERSION: u8 = 1;
const TOKEN_PREFIX: &str = "ryux_";
const MAX_PLUGIN_ID_BYTES: usize = 256;

#[derive(Debug, Serialize, Deserialize)]
struct StoredCredential {
    version: u8,
    plugin_id: String,
    sealed_token: String,
}

enum CachedCredential {
    Active(String),
    Revoked,
}

static TOKEN_CACHE: LazyLock<Mutex<HashMap<String, CachedCredential>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn validate_plugin_id(plugin_id: &str) -> std::io::Result<&str> {
    if plugin_id.chars().any(char::is_control) {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "invalid plugin id for credential",
        ));
    }
    let plugin_id = plugin_id.trim();
    if plugin_id.is_empty() || plugin_id.len() > MAX_PLUGIN_ID_BYTES {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "invalid plugin id for credential",
        ));
    }
    Ok(plugin_id)
}

fn credential_file_name(plugin_id: &str) -> String {
    format!("{}.json", hex::encode(Sha256::digest(plugin_id.as_bytes())))
}

fn credentials_dir() -> PathBuf {
    crate::paths::secret_path("plugin-credentials")
}

fn master_cipher() -> anyhow::Result<FieldCipher> {
    crate::crypto_host::install();
    global_cipher().map_err(Into::into)
}

fn generate_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("{TOKEN_PREFIX}{}", hex::encode(bytes))
}

fn load_from(path: &Path, plugin_id: &str, cipher: &FieldCipher) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    let stored: StoredCredential = serde_json::from_slice(&bytes)
        .map_err(|error| Error::new(ErrorKind::InvalidData, error))?;
    if stored.version != STORE_VERSION || stored.plugin_id != plugin_id {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "plugin credential identity mismatch",
        ));
    }
    cipher
        .open(&stored.sealed_token)
        .map_err(|error| Error::new(ErrorKind::InvalidData, error))
}

fn write_secret(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::new(ErrorKind::InvalidInput, "credential path has no parent"))?;
    std::fs::create_dir_all(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(body)?;
        file.sync_all()?;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path)?;
        file.write_all(body)?;
        file.sync_all()?;
    }
    Ok(())
}

fn persist_new(
    path: &Path,
    plugin_id: &str,
    token: &str,
    cipher: &FieldCipher,
) -> std::io::Result<()> {
    let stored = StoredCredential {
        version: STORE_VERSION,
        plugin_id: plugin_id.to_owned(),
        sealed_token: cipher.seal(token).map_err(Error::other)?,
    };
    let bytes = serde_json::to_vec_pretty(&stored)
        .map_err(|error| Error::new(ErrorKind::InvalidData, error))?;
    write_secret(path, &bytes)
}

fn token_for_with(plugin_id: &str, dir: &Path, cipher: &FieldCipher) -> std::io::Result<String> {
    let plugin_id = validate_plugin_id(plugin_id)?;
    let path = dir.join(credential_file_name(plugin_id));
    match load_from(&path, plugin_id, cipher) {
        Ok(token) => return Ok(token),
        Err(error) if error.kind() != ErrorKind::NotFound => return Err(error),
        Err(_) => {}
    }

    let token = generate_token();
    match persist_new(&path, plugin_id, &token, cipher) {
        Ok(()) => Ok(token),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            load_from(&path, plugin_id, cipher)
        }
        Err(error) => Err(error),
    }
}

/// Return this plugin's credential, creating it once if necessary.
///
/// If secure persistence is unavailable, Core keeps a random process-local
/// credential. That preserves isolation for this run without writing plaintext
/// or falling back to a value derived from the owner token.
pub fn token_for(plugin_id: &str) -> String {
    let key = plugin_id.trim().to_owned();
    let mut cache = TOKEN_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    match cache.get(&key) {
        Some(CachedCredential::Active(token)) => return token.clone(),
        Some(CachedCredential::Revoked) => {
            let token = generate_token();
            cache.insert(key, CachedCredential::Active(token.clone()));
            return token;
        }
        None => {}
    }

    let token = match master_cipher()
        .and_then(|cipher| token_for_with(&key, &credentials_dir(), &cipher).map_err(Into::into))
    {
        Ok(token) => token,
        Err(error) => {
            tracing::warn!(plugin_id = %key, error = %error, "using an ephemeral plugin credential");
            generate_token()
        }
    };
    cache.insert(key, CachedCredential::Active(token.clone()));
    token
}

/// Compare a presented sidecar credential without minting a credential for an
/// unknown caller-controlled plugin id.
pub fn verifies(plugin_id: &str, presented: &str) -> bool {
    let Ok(key) = validate_plugin_id(plugin_id).map(str::to_owned) else {
        return false;
    };
    let mut cache = TOKEN_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let expected = match cache.get(&key) {
        Some(CachedCredential::Active(token)) => token.clone(),
        Some(CachedCredential::Revoked) => return false,
        None => {
            let Ok(cipher) = master_cipher() else {
                return false;
            };
            let path = credentials_dir().join(credential_file_name(&key));
            let Ok(token) = load_from(&path, &key, &cipher) else {
                return false;
            };
            cache.insert(key, CachedCredential::Active(token.clone()));
            token
        }
    };
    constant_time_eq(presented, &expected)
}

/// Delete a plugin credential. The next enable/start receives a new random one.
pub fn revoke(plugin_id: &str) -> std::io::Result<bool> {
    revoke_at(plugin_id, &credentials_dir())
}

fn revoke_at(plugin_id: &str, dir: &Path) -> std::io::Result<bool> {
    let plugin_id = validate_plugin_id(plugin_id)?;
    // Serialize file deletion with every cache load. Otherwise a verifier can
    // reload the old file after the cache entry is removed but before unlink,
    // leaving a successfully revoked credential accepted from memory.
    let mut cache = TOKEN_CACHE
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    cache.insert(plugin_id.to_owned(), CachedCredential::Revoked);
    let path = dir.join(credential_file_name(plugin_id));
    match std::fs::remove_file(path) {
        Ok(()) => {
            cache.remove(plugin_id);
            Ok(true)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            cache.remove(plugin_id);
            Ok(false)
        }
        // Keep the tombstone installed. The disable path logs this error and
        // continues; verification must still reject the leaked old bearer, and
        // the next enable receives a fresh process-local credential instead of
        // reloading the stale file.
        Err(error) => Err(error),
    }
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (left, right) in left.iter().zip(right.iter()) {
        difference |= left ^ right;
    }
    difference == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher() -> FieldCipher {
        FieldCipher::new(&[0x72; 32])
    }

    #[test]
    fn credentials_are_random_per_plugin_and_stable_on_disk() {
        let dir = tempfile::tempdir().expect("tempdir");
        let a = token_for_with("com.acme.a", dir.path(), &cipher()).expect("a");
        let again = token_for_with("com.acme.a", dir.path(), &cipher()).expect("a again");
        let b = token_for_with("com.acme.b", dir.path(), &cipher()).expect("b");
        assert_eq!(a, again);
        assert_ne!(a, b);
        assert!(a.starts_with(TOKEN_PREFIX));
        assert_eq!(a.len(), TOKEN_PREFIX.len() + 64);
    }

    #[test]
    fn persisted_file_contains_no_plaintext_credential() {
        let dir = tempfile::tempdir().expect("tempdir");
        let token = token_for_with("com.acme.safe", dir.path(), &cipher()).expect("token");
        let path = dir.path().join(credential_file_name("com.acme.safe"));
        let body = std::fs::read_to_string(path).expect("stored file");
        assert!(body.contains("enc:v1:"));
        assert!(!body.contains(&token));
    }

    #[test]
    fn filename_is_a_digest_not_a_plugin_controlled_path() {
        let name = credential_file_name("@ryu/example");
        assert_eq!(name.len(), 64 + ".json".len());
        assert!(!name.contains('/') && !name.contains('\\'));
        assert!(validate_plugin_id("../bad\n").is_err());
    }

    #[test]
    fn constant_time_comparison_matches_only_equal_tokens() {
        assert!(constant_time_eq("ryux_abc", "ryux_abc"));
        assert!(!constant_time_eq("ryux_abc", "ryux_abd"));
        assert!(!constant_time_eq("short", "longer"));
    }

    #[test]
    fn unlink_failure_keeps_the_old_credential_revoked_in_memory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let plugin_id = format!("com.test.revoke-{}", generate_token());
        let stale_token = generate_token();
        let path = dir.path().join(credential_file_name(&plugin_id));
        std::fs::create_dir(&path).expect("directory makes remove_file fail");

        TOKEN_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                plugin_id.clone(),
                CachedCredential::Active(stale_token.clone()),
            );

        assert!(revoke_at(&plugin_id, dir.path()).is_err());
        assert!(!verifies(&plugin_id, &stale_token));

        let replacement = token_for(&plugin_id);
        assert_ne!(replacement, stale_token);
        assert!(verifies(&plugin_id, &replacement));
        assert!(!verifies(&plugin_id, &stale_token));

        TOKEN_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&plugin_id);
    }
}
