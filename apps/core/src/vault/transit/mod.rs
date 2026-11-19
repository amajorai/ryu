//! Transit engine: encryption, signing, and HMAC as a service.
//!
//! Applications send data to be encrypted, decrypted, signed, verified, or
//! HMAC'd with a named key and never see the key itself. Keys are versioned:
//! `rotate` adds a version, new operations use the latest (or a caller-chosen
//! version at or above `minEncryptionVersion`), old ciphertexts keep decrypting
//! down to `minDecryptionVersion`, `trim` permanently drops versions below
//! `minAvailableVersion`, and `rewrap` upgrades a ciphertext to the latest
//! version without exposing the plaintext to the caller. Output strings are
//! `ryu:v<version>:<base64>`.
//!
//! Key types: `aes256-gcm96`, `aes128-gcm96`, and `chacha20-poly1305` (encrypt, decrypt,
//! rewrap, data keys; optionally `derived`, which takes an HKDF-SHA256 subkey
//! per request `context`, and `convergent`, which derives the nonce from the
//! plaintext so equal inputs give equal ciphertexts), `ed25519`, `ecdsa-p256`,
//! `ecdsa-p384` (sign/verify), `rsa-2048/3072/4096` (OAEP-SHA256
//! encrypt/decrypt, PSS or PKCS#1 v1.5 SHA-256 signatures), `hmac`, and
//! `aes128-cmac` / `aes256-cmac` (AES-CMAC per RFC 4493, CMAC only). Every
//! other type can HMAC. `encrypt`, `decrypt`, `rewrap`, `sign`, `verify`,
//! `hmac`, and `cmac` also take a `batchInput` list (see [`batch`]).
//!
//! Lifecycle: `exportable` and `allowPlaintextBackup` are one-way switches that
//! enable `export` and `backup` (both audited); delete is a soft delete that
//! `recover` undoes until the scheduler purges it after
//! `RYU_VAULT_TRANSIT_SOFT_DELETE_DAYS` (default 7); `autoRotatePeriodSecs` is
//! enforced by the scheduler. Bring-your-own-key import unwraps key material
//! sent as `RSA-OAEP-SHA256(wrapping key, ephemeral AES-256 key) ||
//! AES-KWP(ephemeral key, material)` (RFC 5649), as Vault's transit import does.
//!
//! Key material is sealed with the vault keyring in `vault_transit_keys`, so a
//! sealed vault cannot use transit keys and `rewrap_all` covers them.

use std::collections::BTreeMap;

use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt};
use aes::Aes256;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use chacha20poly1305::ChaCha20Poly1305;
use ed25519_dalek::{Signer, Verifier};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
// The P-256/P-384 stack (elliptic-curve 0.14) ships its own pkcs8 0.11 and
// signature 3 traits, distinct from the pkcs8 0.10 / signature 2 traits the
// `rsa` and `ed25519-dalek` crates use below; import them anonymously so both
// generations resolve by method without name clashes.
use p256::ecdsa::signature::{Signer as _, Verifier as _};
use p256::elliptic_curve::Generate;
use p256::pkcs8::{
    DecodePrivateKey as _, EncodePrivateKey as _, EncodePublicKey as _, LineEnding as EcLineEnding,
};
use rand::rngs::OsRng;
use rsa::pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey, LineEnding};
use rsa::signature::{RandomizedSigner, SignatureEncoding};
use rsa::traits::PublicKeyParts;
use rsa::{Oaep, RsaPrivateKey, RsaPublicKey};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, random_bytes, VaultError};
use crate::plugin_secrets::PluginSecretStore;

mod batch;
#[cfg(test)]
mod batch_tests;
mod cmac;
#[cfg(test)]
mod cmac_tests;
mod export;
#[cfg(test)]
mod export_tests;
mod keys;
#[cfg(test)]
mod keys_tests;
mod kwp;
#[cfg(test)]
mod kwp_tests;
mod material;
#[cfg(test)]
mod material_tests;
mod meta;
#[cfg(test)]
mod meta_tests;
mod ops;
#[cfg(test)]
mod ops_tests;
#[cfg(test)]
mod tests;

use self::kwp::kwp_unwrap;
#[cfg(test)]
use self::kwp::*;
use self::material::*;
use self::meta::*;

pub use self::batch::{TransitBatchItem, TransitBatchOp, TransitBatchResult, MAX_BATCH_ITEMS};

const PREFIX: &str = "ryu:v";
/// Maximum plaintext/input accepted by one transit call (decoded bytes).
pub const MAX_INPUT_BYTES: usize = 1024 * 1024;
/// Shortest automatic rotation period.
pub const MIN_AUTO_ROTATE_SECS: i64 = 3600;
/// Env var: days a soft-deleted key stays recoverable (`0` purges on the
/// next maintenance pass).
pub const ENV_SOFT_DELETE_DAYS: &str = "RYU_VAULT_TRANSIT_SOFT_DELETE_DAYS";
const DEFAULT_SOFT_DELETE_DAYS: i64 = 7;
/// Internal row name of the BYOK wrapping key. Not a valid transit key name,
/// so it never collides with (or lists as) a user key.
const WRAPPING_KEY_NAME: &str = "_wrapping";
/// Wrapping key size (Vault uses RSA-4096). Tests use 2048 bits because
/// unoptimized 4096-bit key generation takes minutes.
const WRAPPING_KEY_BITS: usize = if cfg!(test) { 2048 } else { 4096 };
const BACKUP_FORMAT: &str = "ryu-transit-backup-v1";
/// DER prefix of a PKCS#8 v1 Ed25519 private key (RFC 8410); the 32-byte
/// seed follows.
const ED25519_PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

/// Transit key type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TransitKeyType {
    /// AES-256-GCM with a 96-bit nonce.
    #[serde(rename = "aes256-gcm96")]
    Aes256Gcm96,
    /// AES-128-GCM with a 96-bit nonce.
    #[serde(rename = "aes128-gcm96")]
    Aes128Gcm96,
    /// ChaCha20-Poly1305 with a 96-bit nonce.
    #[serde(rename = "chacha20-poly1305")]
    Chacha20Poly1305,
    /// Ed25519 signatures.
    #[serde(rename = "ed25519")]
    Ed25519,
    /// ECDSA over P-256 with SHA-256 (ASN.1 DER signatures).
    #[serde(rename = "ecdsa-p256")]
    EcdsaP256,
    /// ECDSA over P-384 with SHA-384 (ASN.1 DER signatures).
    #[serde(rename = "ecdsa-p384")]
    EcdsaP384,
    /// RSA-2048: OAEP-SHA256 encryption, PSS/PKCS#1 v1.5 SHA-256 signatures.
    #[serde(rename = "rsa-2048")]
    Rsa2048,
    /// RSA-3072.
    #[serde(rename = "rsa-3072")]
    Rsa3072,
    /// RSA-4096.
    #[serde(rename = "rsa-4096")]
    Rsa4096,
    /// HMAC-SHA256 only.
    #[serde(rename = "hmac")]
    Hmac,
    /// AES-128-CMAC only.
    #[serde(rename = "aes128-cmac")]
    Aes128Cmac,
    /// AES-256-CMAC only.
    #[serde(rename = "aes256-cmac")]
    Aes256Cmac,
}

impl TransitKeyType {
    const ALL: [Self; 12] = [
        Self::Aes256Gcm96,
        Self::Aes128Gcm96,
        Self::Chacha20Poly1305,
        Self::Ed25519,
        Self::EcdsaP256,
        Self::EcdsaP384,
        Self::Rsa2048,
        Self::Rsa3072,
        Self::Rsa4096,
        Self::Hmac,
        Self::Aes128Cmac,
        Self::Aes256Cmac,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aes256Gcm96 => "aes256-gcm96",
            Self::Aes128Gcm96 => "aes128-gcm96",
            Self::Chacha20Poly1305 => "chacha20-poly1305",
            Self::Ed25519 => "ed25519",
            Self::EcdsaP256 => "ecdsa-p256",
            Self::EcdsaP384 => "ecdsa-p384",
            Self::Rsa2048 => "rsa-2048",
            Self::Rsa3072 => "rsa-3072",
            Self::Rsa4096 => "rsa-4096",
            Self::Hmac => "hmac",
            Self::Aes128Cmac => "aes128-cmac",
            Self::Aes256Cmac => "aes256-cmac",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    /// AEAD types (encrypt/decrypt with nonces; derivation applies).
    fn is_symmetric(self) -> bool {
        matches!(
            self,
            Self::Aes256Gcm96 | Self::Aes128Gcm96 | Self::Chacha20Poly1305
        )
    }

    fn rsa_bits(self) -> Option<usize> {
        match self {
            Self::Rsa2048 => Some(2048),
            Self::Rsa3072 => Some(3072),
            Self::Rsa4096 => Some(4096),
            _ => None,
        }
    }

    /// CMAC key size in bytes, for the CMAC-only types.
    fn cmac_key_bytes(self) -> Option<usize> {
        match self {
            Self::Aes128Cmac => Some(16),
            Self::Aes256Cmac => Some(32),
            _ => None,
        }
    }

    /// Every type but the CMAC-only ones can HMAC.
    fn can_hmac(self) -> bool {
        self.cmac_key_bytes().is_none()
    }

    fn can_encrypt(self) -> bool {
        self.is_symmetric() || self.rsa_bits().is_some()
    }

    fn can_sign(self) -> bool {
        matches!(self, Self::Ed25519 | Self::EcdsaP256 | Self::EcdsaP384)
            || self.rsa_bits().is_some()
    }
}

/// Key metadata (never key material).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitKeyInfo {
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: TransitKeyType,
    pub latest_version: u32,
    pub min_decryption_version: u32,
    /// `0` means any available version may encrypt, sign, or HMAC.
    pub min_encryption_version: u32,
    /// Versions below this were trimmed and are gone.
    pub min_available_version: u32,
    pub deletion_allowed: bool,
    pub derived: bool,
    pub convergent: bool,
    pub exportable: bool,
    pub allow_plaintext_backup: bool,
    /// `0` disables automatic rotation.
    pub auto_rotate_period_secs: i64,
    /// Whether any version was imported (BYOK) rather than generated.
    pub imported: bool,
    pub created_at: i64,
    /// Set while the key is soft-deleted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
    /// Public keys by version: base64 for Ed25519, SPKI PEM for ECDSA/RSA
    /// (empty for symmetric and HMAC keys).
    pub public_keys: Vec<(u32, String)>,
}

/// Options fixed when a key is created or imported.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransitKeyOptions {
    /// Derive a subkey per request `context` (HKDF-SHA256). AEAD types only.
    pub derived: bool,
    /// Deterministic encryption (requires `derived`).
    pub convergent: bool,
    pub exportable: bool,
    pub allow_plaintext_backup: bool,
    pub auto_rotate_period_secs: i64,
}

/// A partial configuration update. `exportable` and `allowPlaintextBackup`
/// can only be switched on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransitConfigUpdate {
    pub min_decryption_version: Option<u32>,
    pub min_encryption_version: Option<u32>,
    pub deletion_allowed: Option<bool>,
    pub exportable: Option<bool>,
    pub allow_plaintext_backup: Option<bool>,
    pub auto_rotate_period_secs: Option<i64>,
}

/// Per-operation options.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransitOpOptions {
    /// Base64. Derived keys: the derivation context (required). Other AEAD
    /// keys: associated data (kept for compatibility).
    pub context: Option<String>,
    /// Base64 associated data authenticated with the ciphertext.
    pub associated_data: Option<String>,
    /// Version to encrypt, sign, or HMAC with (default: latest).
    pub key_version: Option<u32>,
    /// RSA signatures: `pss` (default) or `pkcs1v15`.
    pub signature_algorithm: Option<String>,
}

impl TransitOpOptions {
    /// Options carrying only a `context` (the original API shape).
    pub fn with_context(context: Option<&str>) -> Self {
        Self {
            context: context.map(str::to_owned),
            ..Self::default()
        }
    }
}

/// What `export` returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransitExportKind {
    EncryptionKey,
    SigningKey,
    HmacKey,
    PublicKey,
    CmacKey,
}

impl TransitExportKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "encryption-key" => Some(Self::EncryptionKey),
            "signing-key" => Some(Self::SigningKey),
            "hmac-key" => Some(Self::HmacKey),
            "public-key" => Some(Self::PublicKey),
            "cmac-key" => Some(Self::CmacKey),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::EncryptionKey => "encryption-key",
            Self::SigningKey => "signing-key",
            Self::HmacKey => "hmac-key",
            Self::PublicKey => "public-key",
            Self::CmacKey => "cmac-key",
        }
    }
}

/// Exported key material by version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitExport {
    pub name: String,
    #[serde(rename = "type")]
    pub key_type: TransitKeyType,
    pub kind: TransitExportKind,
    /// Version (as a string, like Vault) to base64 raw key or PKCS#8/SPKI PEM.
    pub keys: BTreeMap<String, String>,
}

/// Create the transit tables. Idempotent; adds columns introduced after the
/// first release.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_transit_meta (
             name                   TEXT PRIMARY KEY,
             key_type               TEXT NOT NULL,
             latest_version         INTEGER NOT NULL,
             min_decryption_version INTEGER NOT NULL DEFAULT 1,
             deletion_allowed       INTEGER NOT NULL DEFAULT 0,
             created_at             INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_transit_keys (
             name        TEXT NOT NULL,
             version     INTEGER NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             public_key  TEXT,
             created_at  INTEGER NOT NULL,
             PRIMARY KEY (name, version)
         );",
    )
    .context("initializing transit schema")?;
    super::ensure_columns(
        conn,
        "vault_transit_meta",
        &[
            ("min_encryption_version", "INTEGER NOT NULL DEFAULT 0"),
            ("min_available_version", "INTEGER NOT NULL DEFAULT 1"),
            ("derived", "INTEGER NOT NULL DEFAULT 0"),
            ("convergent", "INTEGER NOT NULL DEFAULT 0"),
            ("exportable", "INTEGER NOT NULL DEFAULT 0"),
            ("allow_plaintext_backup", "INTEGER NOT NULL DEFAULT 0"),
            ("auto_rotate_period_secs", "INTEGER NOT NULL DEFAULT 0"),
            ("imported", "INTEGER NOT NULL DEFAULT 0"),
            ("deleted_at", "INTEGER"),
        ],
    )
    .context("upgrading transit schema")
}

/// Transit key names: `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_valid_key_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'_' || *b == b'-')
}

fn encode(version: u32, bytes: &[u8]) -> String {
    format!("{PREFIX}{version}:{}", B64.encode(bytes))
}

fn decode(value: &str) -> Result<(u32, Vec<u8>)> {
    let rest = value
        .trim()
        .strip_prefix(PREFIX)
        .ok_or_else(|| VaultError::Invalid("value is not a Ryu transit string".into()))?;
    let (version, body) = rest
        .split_once(':')
        .ok_or_else(|| VaultError::Invalid("malformed transit string".into()))?;
    let version: u32 = version
        .parse()
        .map_err(|_| VaultError::Invalid("malformed transit key version".into()))?;
    let bytes = B64
        .decode(body)
        .map_err(|_| VaultError::Invalid("transit string is not valid base64".into()))?;
    Ok((version, bytes))
}

fn decode_input(value: &str) -> Result<Vec<u8>> {
    let bytes = B64
        .decode(value.trim())
        .map_err(|_| VaultError::Invalid("input must be base64".into()))?;
    if bytes.len() > MAX_INPUT_BYTES {
        return Err(VaultError::Invalid("input is too large".into()).into());
    }
    Ok(bytes)
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn denied(message: impl Into<String>) -> anyhow::Error {
    VaultError::Denied(message.into()).into()
}

fn soft_delete_window_millis() -> i64 {
    std::env::var(ENV_SOFT_DELETE_DAYS)
        .ok()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|days| *days >= 0)
        .unwrap_or(DEFAULT_SOFT_DELETE_DAYS)
        * 24
        * 3600
        * 1000
}
