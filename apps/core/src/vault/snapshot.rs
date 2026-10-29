//! Encrypted vault snapshots for backup, restore, and moving between nodes.
//!
//! A snapshot holds every live value's coordinates, metadata, and current
//! plaintext, serialized as JSON and sealed with AES-256-GCM under a key
//! derived from an operator passphrase (PBKDF2-HMAC-SHA256). It is
//! independent of this node's master key, so it restores on another machine.
//! Version history, audit rows, and engine keys are not included: a snapshot
//! is a portable copy of the secrets, not a disk image.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::Sha256;

use super::audit::{AuditActor, AuditEntry};
use super::{random_bytes, VaultError};
use crate::plugin_secrets::kv::ListFilter;
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretMetadata, SecretMetadataPatch, VersionSource,
    WriteRequest,
};

const FORMAT: &str = "ryu-vault-snapshot";
const AAD: &[u8] = b"ryu-vault-snapshot/v1";
/// PBKDF2 iterations for new snapshots (OWASP 2023 guidance for SHA-256).
pub const DEFAULT_ITERATIONS: u32 = 600_000;
const MIN_ITERATIONS: u32 = 100_000;
/// Upper bound on an imported envelope's work factor. Envelopes are untrusted
/// input, and PBKDF2 runs synchronously, so an unbounded count would let one
/// import tie up a runtime worker indefinitely.
const MAX_ITERATIONS: u32 = 2_000_000;
const MIN_PASSPHRASE_LEN: usize = 12;

/// Sealed envelope written to disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub format: String,
    pub version: u32,
    pub created_at: String,
    pub kdf: Kdf,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kdf {
    pub alg: String,
    pub iterations: u32,
    pub salt: String,
}

/// One secret inside a snapshot.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub coords: SecretCoords,
    pub value: String,
    pub metadata: SecretMetadata,
}

/// How import treats a value that already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OnConflict {
    #[default]
    Skip,
    Overwrite,
}

/// Import result counts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub unchanged: usize,
}

/// PBKDF2-HMAC-SHA256 producing 32 bytes.
pub(crate) fn pbkdf2_sha256(passphrase: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let prf = <Hmac<Sha256> as Mac>::new_from_slice(passphrase).expect("any key length");
    let mut block = prf.clone();
    block.update(salt);
    block.update(&1u32.to_be_bytes());
    let mut u: [u8; 32] = block.finalize().into_bytes().into();
    let mut out = u;
    for _ in 1..iterations {
        let mut next = prf.clone();
        next.update(&u);
        u = next.finalize().into_bytes().into();
        for (acc, byte) in out.iter_mut().zip(u.iter()) {
            *acc ^= byte;
        }
    }
    out
}

/// Seal entries with `passphrase`.
pub fn seal(entries: &[Entry], passphrase: &str, iterations: u32) -> Result<Envelope> {
    if passphrase.chars().count() < MIN_PASSPHRASE_LEN {
        return Err(VaultError::Invalid(format!(
            "the passphrase must be at least {MIN_PASSPHRASE_LEN} characters"
        ))
        .into());
    }
    let salt = random_bytes(16);
    let key = pbkdf2_sha256(passphrase.as_bytes(), &salt, iterations);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("bad key"))?;
    let nonce = random_bytes(12);
    let plaintext = serde_json::to_vec(entries)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: AAD,
            },
        )
        .map_err(|_| anyhow!("snapshot encryption failed"))?;
    Ok(Envelope {
        format: FORMAT.to_owned(),
        version: 1,
        created_at: chrono::Utc::now().to_rfc3339(),
        kdf: Kdf {
            alg: "pbkdf2-sha256".to_owned(),
            iterations,
            salt: B64.encode(salt),
        },
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    })
}

/// Open an envelope with `passphrase`.
pub fn open(envelope: &Envelope, passphrase: &str) -> Result<Vec<Entry>> {
    if envelope.format != FORMAT || envelope.version != 1 {
        bail!("not a Ryu vault snapshot");
    }
    if envelope.kdf.alg != "pbkdf2-sha256"
        || !(MIN_ITERATIONS..=MAX_ITERATIONS).contains(&envelope.kdf.iterations)
    {
        bail!("unsupported snapshot key derivation");
    }
    let salt = B64.decode(&envelope.kdf.salt).context("snapshot salt")?;
    let nonce = B64.decode(&envelope.nonce).context("snapshot nonce")?;
    let ciphertext = B64
        .decode(&envelope.ciphertext)
        .context("snapshot ciphertext")?;
    if nonce.len() != 12 {
        bail!("malformed snapshot nonce");
    }
    let key = pbkdf2_sha256(passphrase.as_bytes(), &salt, envelope.kdf.iterations);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| anyhow!("bad key"))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: AAD,
            },
        )
        .map_err(|_| VaultError::Denied("wrong passphrase or corrupted snapshot".into()))?;
    Ok(serde_json::from_slice(&plaintext)?)
}

impl PluginSecretStore {
    /// Export live values matching `filter` and `allow` as a sealed snapshot.
    pub async fn snapshot_export(
        &self,
        filter: &ListFilter,
        allow: impl Fn(&SecretCoords) -> bool,
        passphrase: &str,
        actor: &AuditActor,
    ) -> Result<Envelope> {
        let entries: Vec<Entry> = self
            .current_values(filter)
            .await?
            .into_iter()
            .filter(|(info, _)| allow(&info.coords()))
            .map(|(info, value)| Entry {
                coords: info.coords(),
                value,
                metadata: info.metadata,
            })
            .collect();
        let envelope = seal(&entries, passphrase, DEFAULT_ITERATIONS)?;
        if !self
            .audit(
                &AuditEntry::new(actor, "vault.snapshot.export", "ok")
                    .details(json!({ "secrets": entries.len() })),
            )
            .await
        {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(envelope)
    }

    /// Import a sealed snapshot. `allow` gates each target's `write` given the
    /// value it would write.
    pub async fn snapshot_import(
        &self,
        envelope: &Envelope,
        passphrase: &str,
        on_conflict: OnConflict,
        allow: impl Fn(&SecretCoords, &str) -> bool,
        actor: &AuditActor,
    ) -> Result<ImportReport> {
        let entries = open(envelope, passphrase)?;
        let report = self
            .import_entries(entries, on_conflict, allow, actor)
            .await?;
        self.audit(
            &AuditEntry::new(actor, "vault.snapshot.import", "ok")
                .details(serde_json::to_value(&report)?),
        )
        .await;
        Ok(report)
    }

    /// Write `entries` (from a snapshot or a parsed `.env`).
    pub async fn import_entries(
        &self,
        entries: Vec<Entry>,
        on_conflict: OnConflict,
        allow: impl Fn(&SecretCoords, &str) -> bool,
        actor: &AuditActor,
    ) -> Result<ImportReport> {
        let mut report = ImportReport::default();
        for entry in entries {
            let coords = entry.coords.clone().normalize()?;
            if !allow(&coords, &entry.value) {
                report.skipped += 1;
                continue;
            }
            let existing = self
                .secret_info(&coords)
                .await?
                .filter(|info| info.deleted_at.is_none());
            if existing.is_some() {
                if on_conflict == OnConflict::Skip {
                    report.skipped += 1;
                    continue;
                }
                if self.reveal_unaudited(&coords).await?.as_deref() == Some(entry.value.as_str()) {
                    report.unchanged += 1;
                    continue;
                }
            }
            let patch = SecretMetadataPatch::from_metadata(&entry.metadata);
            self.write_secret(WriteRequest {
                coords,
                value: Some(&entry.value),
                patch,
                actor,
                source: VersionSource::Import,
                expected_version: None,
            })
            .await?;
            if existing.is_some() {
                report.updated += 1;
            } else {
                report.created += 1;
            }
        }
        Ok(report)
    }

    async fn reveal_unaudited(&self, coords: &SecretCoords) -> Result<Option<String>> {
        let filter = ListFilter {
            environment: Some(coords.environment.clone()),
            path: Some(coords.path.clone()),
            recursive: false,
            include_deleted: false,
        };
        Ok(self
            .current_values(&filter)
            .await?
            .into_iter()
            .find(|(info, _)| info.coords() == *coords)
            .map(|(_, value)| value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secrets::SecretScope;

    #[test]
    fn pbkdf2_matches_rfc_7914_vector() {
        // RFC 7914 §11: PBKDF2-HMAC-SHA256("passwd", "salt", 1).
        let key = pbkdf2_sha256(b"passwd", b"salt", 1);
        assert_eq!(
            hex::encode(key),
            "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc"
        );
    }

    #[test]
    fn envelopes_round_trip_and_reject_wrong_passphrases() {
        let entries = vec![Entry {
            coords: SecretCoords::root(SecretScope::User, "u1", None, "TOKEN"),
            value: "v".into(),
            metadata: SecretMetadata::default(),
        }];
        let envelope = seal(&entries, "correct horse battery", MIN_ITERATIONS).unwrap();
        assert_eq!(open(&envelope, "correct horse battery").unwrap(), entries);
        assert!(open(&envelope, "wrong passphrase!!").is_err());
        assert!(seal(&entries, "short", MIN_ITERATIONS).is_err());
        // A crafted work factor is refused before any key derivation runs.
        let mut costly = envelope.clone();
        costly.kdf.iterations = u32::MAX;
        assert!(open(&costly, "correct horse battery").is_err());
    }

    #[tokio::test]
    async fn snapshots_move_values_between_stores() {
        let source = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let coords = SecretCoords::root(SecretScope::User, "u1", None, "API_KEY");
        source
            .write_secret(WriteRequest {
                coords: coords.clone(),
                value: Some("secret-value"),
                patch: SecretMetadataPatch::default(),
                actor: &actor,
                source: VersionSource::Write,
                expected_version: None,
            })
            .await
            .unwrap();
        let mut entries = Vec::new();
        for (info, value) in source.current_values(&ListFilter::default()).await.unwrap() {
            entries.push(Entry {
                coords: info.coords(),
                value,
                metadata: info.metadata,
            });
        }
        let envelope = seal(&entries, "passphrase-123", MIN_ITERATIONS).unwrap();
        let target = PluginSecretStore::in_memory().unwrap();
        let report = target
            .snapshot_import(
                &envelope,
                "passphrase-123",
                OnConflict::Skip,
                |_, _| true,
                &actor,
            )
            .await
            .unwrap();
        assert_eq!(report.created, 1);
        let again = target
            .snapshot_import(
                &envelope,
                "passphrase-123",
                OnConflict::Overwrite,
                |_, _| true,
                &actor,
            )
            .await
            .unwrap();
        assert_eq!(again.unchanged, 1);
        assert_eq!(
            target.reveal(&coords, None, &actor).await.unwrap(),
            "secret-value"
        );
    }
}
