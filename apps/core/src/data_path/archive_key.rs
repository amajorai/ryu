//! The export archive format, its passphrase-derived key and the key-bundle wrap.

// ── Export (passphrase-encrypted zip) ──────────────────────────────────────────────
//
// A data-folder export carries `secrets/master.key` (file custody) and every
// store, so it is never written in the clear. The file is:
//
//   "RYU-DX01" | iterations: u32 BE | salt: 16 bytes | RYU-BK01 stream
//
// where the RYU-BK01 stream is `ryu_backup::encryption` (the S3 backup format:
// authenticated 1 MiB AES-256-GCM frames) keyed by PBKDF2-HMAC-SHA256 of the
// operator's passphrase (the vault snapshot KDF). The zip itself only ever exists
// in an anonymous temporary file. Archives written by older builds (a plain zip)
// still import without a passphrase.
//
// An export of the active data folder also carries the master key in every
// custody (keychain or file), the retired keys and the key check value, as one
// `ryu_crypto::custody::seal_key_bundle` value in the archive entry
// [`KEY_BUNDLE_ENTRY`]. It is sealed under a key derived from the archive key, so
// it only exists inside the passphrase-encrypted stream. Import adopts it: when
// the archive key differs from the target's, the archive key becomes current and
// the target's previous key is retired, so data the target already sealed keeps
// opening (see `docs/encryption-at-rest.md`).

/// Archive entry holding the sealed key bundle. Never extracted.
pub(super) const KEY_BUNDLE_ENTRY: &str = "ryu-export/master-key.bundle";
/// Archive entries the key bundle supersedes on import: copying them would
/// overwrite the target's key file or its key records before the target's own
/// key is retired.
pub(super) const KEY_CUSTODY_ENTRIES: &[&str] = &[
    "secrets/master.key",
    "state/master-key.kcv",
    "state/retired-keys.json",
];
/// Domain label for the key-bundle wrapping key (HMAC of the archive key).
const KEY_BUNDLE_WRAP_LABEL: &[u8] = b"ryu-data-export-key-bundle-v1";

pub(super) const EXPORT_MAGIC: &[u8; 8] = b"RYU-DX01";
pub(super) const EXPORT_SALT_LEN: usize = 16;
pub(super) const EXPORT_MIN_ITERATIONS: u32 = 100_000;
pub(super) const EXPORT_MAX_ITERATIONS: u32 = 2_000_000;
/// Minimum passphrase length, matching vault snapshots.
pub(crate) const EXPORT_MIN_PASSPHRASE_CHARS: usize = 12;
/// Env var the `data-path export|import` CLI reads the archive passphrase from
/// (the desktop shell sets it on the child it spawns; never a CLI argument,
/// which other local users could read from the process list).
pub(crate) const ARCHIVE_PASSPHRASE_ENV: &str = "RYU_DATA_ARCHIVE_PASSPHRASE";

pub(super) fn invalid_input(message: impl Into<String>) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidInput, message.into())
}

pub(super) fn check_export_passphrase(passphrase: &str) -> std::io::Result<()> {
    if passphrase.chars().count() < EXPORT_MIN_PASSPHRASE_CHARS {
        return Err(invalid_input(format!(
            "the backup passphrase must be at least {EXPORT_MIN_PASSPHRASE_CHARS} characters"
        )));
    }
    Ok(())
}

pub(super) fn export_key(passphrase: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    crate::vault::snapshot::pbkdf2_sha256(passphrase.as_bytes(), salt, iterations)
}

/// The key that wraps the key bundle inside an archive keyed by `archive_key`.
pub(super) fn key_bundle_wrap(archive_key: &[u8; 32]) -> [u8; 32] {
    use hmac::Mac;
    let mut mac = <hmac::Hmac<sha2::Sha256> as Mac>::new_from_slice(archive_key)
        .expect("HMAC accepts any key length");
    mac.update(KEY_BUNDLE_WRAP_LABEL);
    mac.finalize().into_bytes().into()
}

/// Archive key material chosen before the zip is written, so the key bundle can
/// be wrapped under it.
pub(super) struct ExportKey {
    pub(super) salt: [u8; EXPORT_SALT_LEN],
    pub(super) iterations: u32,
    pub(super) key: [u8; 32],
}

impl ExportKey {
    pub(super) fn generate(passphrase: &str, iterations: u32) -> Self {
        use rand::RngCore;
        let mut salt = [0u8; EXPORT_SALT_LEN];
        rand::thread_rng().fill_bytes(&mut salt);
        let key = export_key(passphrase, &salt, iterations);
        Self {
            salt,
            iterations,
            key,
        }
    }
}
