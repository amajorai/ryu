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
//! Key types: `aes256-gcm96` and `chacha20-poly1305` (encrypt, decrypt,
//! rewrap, data keys; optionally `derived`, which takes an HKDF-SHA256 subkey
//! per request `context`, and `convergent`, which derives the nonce from the
//! plaintext so equal inputs give equal ciphertexts), `ed25519`, `ecdsa-p256`,
//! `ecdsa-p384` (sign/verify), `rsa-2048/3072/4096` (OAEP-SHA256
//! encrypt/decrypt, PSS or PKCS#1 v1.5 SHA-256 signatures), and `hmac`. Every
//! type can HMAC.
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
}

impl TransitKeyType {
    const ALL: [Self; 9] = [
        Self::Aes256Gcm96,
        Self::Chacha20Poly1305,
        Self::Ed25519,
        Self::EcdsaP256,
        Self::EcdsaP384,
        Self::Rsa2048,
        Self::Rsa3072,
        Self::Rsa4096,
        Self::Hmac,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Aes256Gcm96 => "aes256-gcm96",
            Self::Chacha20Poly1305 => "chacha20-poly1305",
            Self::Ed25519 => "ed25519",
            Self::EcdsaP256 => "ecdsa-p256",
            Self::EcdsaP384 => "ecdsa-p384",
            Self::Rsa2048 => "rsa-2048",
            Self::Rsa3072 => "rsa-3072",
            Self::Rsa4096 => "rsa-4096",
            Self::Hmac => "hmac",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|kind| kind.as_str() == value)
    }

    /// AEAD types (encrypt/decrypt with nonces; derivation applies).
    fn is_symmetric(self) -> bool {
        matches!(self, Self::Aes256Gcm96 | Self::Chacha20Poly1305)
    }

    fn rsa_bits(self) -> Option<usize> {
        match self {
            Self::Rsa2048 => Some(2048),
            Self::Rsa3072 => Some(3072),
            Self::Rsa4096 => Some(4096),
            _ => None,
        }
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
}

impl TransitExportKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "encryption-key" => Some(Self::EncryptionKey),
            "signing-key" => Some(Self::SigningKey),
            "hmac-key" => Some(Self::HmacKey),
            "public-key" => Some(Self::PublicKey),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::EncryptionKey => "encryption-key",
            Self::SigningKey => "signing-key",
            Self::HmacKey => "hmac-key",
            Self::PublicKey => "public-key",
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

struct Meta {
    key_type: TransitKeyType,
    latest: u32,
    min_decrypt: u32,
    min_encrypt: u32,
    min_available: u32,
    deletion_allowed: bool,
    derived: bool,
    convergent: bool,
    exportable: bool,
    allow_plaintext_backup: bool,
    auto_rotate_period_secs: i64,
    imported: bool,
    created_at: i64,
    deleted_at: Option<i64>,
}

impl Meta {
    /// Lowest version that may decrypt or verify.
    fn decrypt_floor(&self) -> u32 {
        self.min_decrypt.max(self.min_available)
    }

    /// The version to encrypt, sign, or HMAC with.
    fn select_version(&self, requested: Option<u32>) -> Result<u32> {
        // Never encrypt below the decryption floor: that output could not be
        // decrypted, verified, or HMAC-verified.
        let floor = self.min_encrypt.max(self.decrypt_floor()).max(1);
        match requested {
            None | Some(0) => Ok(self.latest),
            Some(version) if (floor..=self.latest).contains(&version) => Ok(version),
            Some(version) => Err(denied(format!(
                "key version {version} is outside the usable range {floor}..={}",
                self.latest
            ))),
        }
    }

    fn check_decryptable(&self, version: u32) -> Result<()> {
        if version < self.decrypt_floor() || version > self.latest {
            return Err(denied(format!(
                "key version {version} is outside the decryptable range"
            )));
        }
        Ok(())
    }
}

const META_COLUMNS: &str = "key_type, latest_version, min_decryption_version,
     min_encryption_version, min_available_version, deletion_allowed, derived, convergent,
     exportable, allow_plaintext_backup, auto_rotate_period_secs, imported, created_at, deleted_at";

fn read_meta(conn: &Connection, name: &str) -> Result<Option<Meta>> {
    let row = conn
        .query_row(
            &format!("SELECT {META_COLUMNS} FROM vault_transit_meta WHERE name = ?1"),
            params![name],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    [
                        row.get::<_, u32>(1)?,
                        row.get::<_, u32>(2)?,
                        row.get::<_, u32>(3)?,
                        row.get::<_, u32>(4)?,
                    ],
                    [
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, i64>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(11)?,
                    ],
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, Option<i64>>(13)?,
                ))
            },
        )
        .optional()?;
    let Some((key_type, versions, flags, auto_rotate, created_at, deleted_at)) = row else {
        return Ok(None);
    };
    Ok(Some(Meta {
        key_type: TransitKeyType::parse(&key_type).ok_or_else(|| anyhow!("unknown key type"))?,
        latest: versions[0],
        min_decrypt: versions[1],
        min_encrypt: versions[2],
        min_available: versions[3].max(1),
        deletion_allowed: flags[0] != 0,
        derived: flags[1] != 0,
        convergent: flags[2] != 0,
        exportable: flags[3] != 0,
        allow_plaintext_backup: flags[4] != 0,
        imported: flags[5] != 0,
        auto_rotate_period_secs: auto_rotate,
        created_at,
        deleted_at,
    }))
}

/// A live (not soft-deleted) key's metadata.
fn meta(conn: &Connection, name: &str) -> Result<Meta> {
    match read_meta(conn, name)? {
        Some(meta) if meta.deleted_at.is_none() => Ok(meta),
        _ => Err(VaultError::NotFound(format!("transit key `{name}`")).into()),
    }
}

fn validate_key_options(key_type: TransitKeyType, options: &TransitKeyOptions) -> Result<()> {
    if (options.derived || options.convergent) && !key_type.is_symmetric() {
        return Err(invalid(
            "derived and convergent keys must be aes256-gcm96 or chacha20-poly1305",
        ));
    }
    if options.convergent && !options.derived {
        return Err(invalid("convergent encryption requires a derived key"));
    }
    validate_auto_rotate(options.auto_rotate_period_secs)
}

fn validate_auto_rotate(period: i64) -> Result<()> {
    if period != 0 && period < MIN_AUTO_ROTATE_SECS {
        return Err(invalid(format!(
            "autoRotatePeriodSecs must be 0 (off) or at least {MIN_AUTO_ROTATE_SECS}"
        )));
    }
    Ok(())
}

// ── Key material ──────────────────────────────────────────────────────────

fn ecdsa_p256(material: &[u8]) -> Result<p256::ecdsa::SigningKey> {
    let secret = p256::SecretKey::from_pkcs8_der(material)
        .map_err(|_| anyhow!("stored ecdsa-p256 key is not PKCS#8"))?;
    Ok(p256::ecdsa::SigningKey::from(secret))
}

fn ecdsa_p384(material: &[u8]) -> Result<p384::ecdsa::SigningKey> {
    let secret = p384::SecretKey::from_pkcs8_der(material)
        .map_err(|_| anyhow!("stored ecdsa-p384 key is not PKCS#8"))?;
    Ok(p384::ecdsa::SigningKey::from(secret))
}

fn rsa_key(material: &[u8]) -> Result<RsaPrivateKey> {
    RsaPrivateKey::from_pkcs8_der(material).map_err(|_| anyhow!("stored RSA key is not PKCS#8"))
}

fn ed25519_seed(material: &[u8]) -> Result<[u8; 32]> {
    material
        .try_into()
        .map_err(|_| anyhow!("ed25519 seed has the wrong length"))
}

fn der_bytes(
    result: std::result::Result<rsa::pkcs8::SecretDocument, rsa::pkcs8::Error>,
) -> Result<Vec<u8>> {
    result
        .map(|doc| doc.as_bytes().to_vec())
        .map_err(|error| anyhow!("encoding private key: {error}"))
}

fn ec_der_bytes(
    result: std::result::Result<p256::pkcs8::SecretDocument, p256::pkcs8::Error>,
) -> Result<Vec<u8>> {
    result
        .map(|doc| doc.as_bytes().to_vec())
        .map_err(|error| anyhow!("encoding private key: {error}"))
}

fn ec_secret<K: Generate>() -> Result<K> {
    K::try_generate().map_err(|error| anyhow!("generating ECDSA key: {error}"))
}

/// Fresh key material and its public key.
fn new_material(key_type: TransitKeyType) -> Result<(Vec<u8>, Option<String>)> {
    let material = match key_type {
        TransitKeyType::Aes256Gcm96
        | TransitKeyType::Chacha20Poly1305
        | TransitKeyType::Hmac
        | TransitKeyType::Ed25519 => random_bytes(32),
        TransitKeyType::EcdsaP256 => ec_der_bytes(ec_secret::<p256::SecretKey>()?.to_pkcs8_der())?,
        TransitKeyType::EcdsaP384 => ec_der_bytes(ec_secret::<p384::SecretKey>()?.to_pkcs8_der())?,
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let bits = key_type.rsa_bits().unwrap_or(2048);
            der_bytes(
                RsaPrivateKey::new(&mut OsRng, bits)
                    .map_err(|error| anyhow!("generating RSA key: {error}"))?
                    .to_pkcs8_der(),
            )?
        }
    };
    let public_key = public_key_of(key_type, &material)?;
    Ok((material, public_key))
}

fn spki_pem(result: std::result::Result<String, rsa::pkcs8::spki::Error>) -> Result<String> {
    result.map_err(|error| anyhow!("encoding public key: {error}"))
}

fn ec_spki_pem(result: std::result::Result<String, p256::pkcs8::spki::Error>) -> Result<String> {
    result.map_err(|error| anyhow!("encoding public key: {error}"))
}

/// Validate stored-form material and compute its public key.
fn public_key_of(key_type: TransitKeyType, material: &[u8]) -> Result<Option<String>> {
    match key_type {
        TransitKeyType::Aes256Gcm96 | TransitKeyType::Chacha20Poly1305 | TransitKeyType::Hmac => {
            if material.len() != 32 {
                return Err(invalid(format!("{} keys are 32 bytes", key_type.as_str())));
            }
            Ok(None)
        }
        TransitKeyType::Ed25519 => {
            let seed = ed25519_seed(material).map_err(|_| invalid("ed25519 seeds are 32 bytes"))?;
            let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
            Ok(Some(B64.encode(signing.verifying_key().to_bytes())))
        }
        TransitKeyType::EcdsaP256 => {
            let secret = p256::SecretKey::from_pkcs8_der(material)
                .map_err(|_| invalid("ecdsa-p256 keys must be PKCS#8 DER"))?;
            Ok(Some(ec_spki_pem(
                secret.public_key().to_public_key_pem(EcLineEnding::LF),
            )?))
        }
        TransitKeyType::EcdsaP384 => {
            let secret = p384::SecretKey::from_pkcs8_der(material)
                .map_err(|_| invalid("ecdsa-p384 keys must be PKCS#8 DER"))?;
            Ok(Some(ec_spki_pem(
                secret.public_key().to_public_key_pem(EcLineEnding::LF),
            )?))
        }
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let key = RsaPrivateKey::from_pkcs8_der(material)
                .map_err(|_| invalid("RSA keys must be PKCS#8 DER"))?;
            let expected = key_type.rsa_bits().unwrap_or_default();
            if key.size() * 8 != expected {
                return Err(invalid(format!(
                    "{} requires a {expected}-bit modulus",
                    key_type.as_str()
                )));
            }
            Ok(Some(spki_pem(
                RsaPublicKey::from(&key).to_public_key_pem(LineEnding::LF),
            )?))
        }
    }
}

/// Normalize imported material to the stored form (raw bytes for symmetric
/// and HMAC keys and Ed25519 seeds, canonical PKCS#8 DER for ECDSA/RSA).
fn normalize_import(key_type: TransitKeyType, raw: Vec<u8>) -> Result<Vec<u8>> {
    match key_type {
        TransitKeyType::Ed25519 if raw.len() == 48 && raw.starts_with(&ED25519_PKCS8_PREFIX) => {
            Ok(raw[16..].to_vec())
        }
        TransitKeyType::EcdsaP256 => ec_der_bytes(
            p256::SecretKey::from_pkcs8_der(&raw)
                .map_err(|_| invalid("ecdsa-p256 imports must be PKCS#8 DER"))?
                .to_pkcs8_der(),
        ),
        TransitKeyType::EcdsaP384 => ec_der_bytes(
            p384::SecretKey::from_pkcs8_der(&raw)
                .map_err(|_| invalid("ecdsa-p384 imports must be PKCS#8 DER"))?
                .to_pkcs8_der(),
        ),
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => der_bytes(
            RsaPrivateKey::from_pkcs8_der(&raw)
                .map_err(|_| invalid("RSA imports must be PKCS#8 DER"))?
                .to_pkcs8_der(),
        ),
        _ => Ok(raw),
    }
}

/// PKCS#8 PEM of stored ECDSA/RSA material.
fn private_pem(key_type: TransitKeyType, material: &[u8]) -> Result<String> {
    let encode_error = |error: &dyn std::fmt::Display| anyhow!("encoding private key: {error}");
    let pem = match key_type {
        TransitKeyType::EcdsaP256 => p256::SecretKey::from_pkcs8_der(material)
            .map_err(|_| anyhow!("stored key is not PKCS#8"))?
            .to_pkcs8_pem(EcLineEnding::LF)
            .map_err(|error| encode_error(&error))?,
        TransitKeyType::EcdsaP384 => p384::SecretKey::from_pkcs8_der(material)
            .map_err(|_| anyhow!("stored key is not PKCS#8"))?
            .to_pkcs8_pem(EcLineEnding::LF)
            .map_err(|error| encode_error(&error))?,
        _ => rsa_key(material)?
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|error| encode_error(&error))?,
    };
    Ok(pem.as_str().to_owned())
}

fn hkdf_sha256(ikm: &[u8], info: &[u8]) -> Vec<u8> {
    let mut out = [0u8; 32];
    Hkdf::<Sha256>::new(None, ikm)
        .expand(info, &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 length");
    out.to_vec()
}

/// The HMAC key for a version. Raw material for symmetric, HMAC, and Ed25519
/// keys (unchanged from the first release); an HKDF subkey for ECDSA/RSA.
fn hmac_key(key_type: TransitKeyType, material: &[u8]) -> Vec<u8> {
    match key_type {
        TransitKeyType::EcdsaP256
        | TransitKeyType::EcdsaP384
        | TransitKeyType::Rsa2048
        | TransitKeyType::Rsa3072
        | TransitKeyType::Rsa4096 => hkdf_sha256(material, b"ryu-transit-hmac"),
        _ => material.to_vec(),
    }
}

/// The AEAD key and associated data for one operation.
fn aead_key_and_aad(
    meta: &Meta,
    material: &[u8],
    context: Option<Vec<u8>>,
    associated_data: Option<Vec<u8>>,
) -> Result<(Vec<u8>, Vec<u8>)> {
    if meta.derived {
        let context = context
            .filter(|context| !context.is_empty())
            .ok_or_else(|| invalid("derived keys require a `context`"))?;
        Ok((
            hkdf_sha256(material, &context),
            associated_data.unwrap_or_default(),
        ))
    } else {
        if context.is_some() && associated_data.is_some() {
            return Err(invalid(
                "use either `context` or `associatedData` with a non-derived key",
            ));
        }
        Ok((
            material.to_vec(),
            context.or(associated_data).unwrap_or_default(),
        ))
    }
}

fn convergent_nonce(key: &[u8], aad: &[u8], plaintext: &[u8]) -> [u8; 12] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    mac.update(b"ryu-transit-convergent");
    mac.update(&(aad.len() as u64).to_be_bytes());
    mac.update(aad);
    mac.update(plaintext);
    let digest = mac.finalize().into_bytes();
    let mut nonce = [0u8; 12];
    nonce.copy_from_slice(&digest[..12]);
    nonce
}

fn aead_encrypt(
    key_type: TransitKeyType,
    key: &[u8],
    plaintext: &[u8],
    aad: &[u8],
    nonce: Option<[u8; 12]>,
) -> Result<Vec<u8>> {
    let nonce = nonce.map_or_else(|| random_bytes(12), |nonce| nonce.to_vec());
    let payload = Payload {
        msg: plaintext,
        aad,
    };
    let sealed = match key_type {
        TransitKeyType::Chacha20Poly1305 => ChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .encrypt(chacha20poly1305::Nonce::from_slice(&nonce), payload),
        _ => Aes256Gcm::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .encrypt(Nonce::from_slice(&nonce), payload),
    }
    .map_err(|_| anyhow!("transit encryption failed"))?;
    let mut out = nonce;
    out.extend(sealed);
    Ok(out)
}

fn aead_decrypt(key_type: TransitKeyType, key: &[u8], blob: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    if blob.len() < 12 + 16 {
        bail!(VaultError::Invalid(
            "transit ciphertext is too short".into()
        ));
    }
    let (nonce, body) = blob.split_at(12);
    let payload = Payload { msg: body, aad };
    match key_type {
        TransitKeyType::Chacha20Poly1305 => ChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .decrypt(chacha20poly1305::Nonce::from_slice(nonce), payload),
        _ => Aes256Gcm::new_from_slice(key)
            .map_err(|_| anyhow!("bad transit key"))?
            .decrypt(Nonce::from_slice(nonce), payload),
    }
    .map_err(|_| invalid("transit ciphertext failed authentication"))
}

fn rsa_signature_is_pss(algorithm: Option<&str>) -> Result<bool> {
    match algorithm.map(str::trim) {
        None | Some("") | Some("pss") => Ok(true),
        Some("pkcs1v15") => Ok(false),
        Some(other) => Err(invalid(format!(
            "unknown signatureAlgorithm `{other}` (use pss or pkcs1v15)"
        ))),
    }
}

fn reject_algorithm_for_non_rsa(key_type: TransitKeyType, algorithm: Option<&str>) -> Result<()> {
    if key_type.rsa_bits().is_none() && algorithm.is_some_and(|value| !value.trim().is_empty()) {
        return Err(invalid("signatureAlgorithm applies only to RSA keys"));
    }
    Ok(())
}

fn sign_material(
    key_type: TransitKeyType,
    material: &[u8],
    input: &[u8],
    algorithm: Option<&str>,
) -> Result<Vec<u8>> {
    reject_algorithm_for_non_rsa(key_type, algorithm)?;
    Ok(match key_type {
        TransitKeyType::Ed25519 => ed25519_dalek::SigningKey::from_bytes(&ed25519_seed(material)?)
            .sign(input)
            .to_bytes()
            .to_vec(),
        TransitKeyType::EcdsaP256 => {
            let signature: p256::ecdsa::Signature = ecdsa_p256(material)?.sign(input);
            signature.to_der().as_bytes().to_vec()
        }
        TransitKeyType::EcdsaP384 => {
            let signature: p384::ecdsa::Signature = ecdsa_p384(material)?.sign(input);
            signature.to_der().as_bytes().to_vec()
        }
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let key = rsa_key(material)?;
            if rsa_signature_is_pss(algorithm)? {
                rsa::pss::BlindedSigningKey::<Sha256>::new(key)
                    .sign_with_rng(&mut OsRng, input)
                    .to_vec()
            } else {
                rsa::pkcs1v15::SigningKey::<Sha256>::new(key)
                    .sign(input)
                    .to_vec()
            }
        }
        _ => return Err(invalid("this key type cannot sign")),
    })
}

fn verify_material(
    key_type: TransitKeyType,
    material: &[u8],
    input: &[u8],
    signature: &[u8],
    algorithm: Option<&str>,
) -> Result<bool> {
    reject_algorithm_for_non_rsa(key_type, algorithm)?;
    Ok(match key_type {
        TransitKeyType::Ed25519 => {
            let verifying =
                ed25519_dalek::SigningKey::from_bytes(&ed25519_seed(material)?).verifying_key();
            ed25519_dalek::Signature::from_slice(signature)
                .map(|sig| verifying.verify(input, &sig).is_ok())
                .unwrap_or(false)
        }
        TransitKeyType::EcdsaP256 => {
            let signing = ecdsa_p256(material)?;
            p256::ecdsa::Signature::from_der(signature)
                .map(|sig| signing.verifying_key().verify(input, &sig).is_ok())
                .unwrap_or(false)
        }
        TransitKeyType::EcdsaP384 => {
            let signing = ecdsa_p384(material)?;
            p384::ecdsa::Signature::from_der(signature)
                .map(|sig| signing.verifying_key().verify(input, &sig).is_ok())
                .unwrap_or(false)
        }
        TransitKeyType::Rsa2048 | TransitKeyType::Rsa3072 | TransitKeyType::Rsa4096 => {
            let public = RsaPublicKey::from(&rsa_key(material)?);
            if rsa_signature_is_pss(algorithm)? {
                rsa::pss::Signature::try_from(signature)
                    .map(|sig| {
                        rsa::pss::VerifyingKey::<Sha256>::new(public)
                            .verify(input, &sig)
                            .is_ok()
                    })
                    .unwrap_or(false)
            } else {
                rsa::pkcs1v15::Signature::try_from(signature)
                    .map(|sig| {
                        rsa::pkcs1v15::VerifyingKey::<Sha256>::new(public)
                            .verify(input, &sig)
                            .is_ok()
                    })
                    .unwrap_or(false)
            }
        }
        _ => return Err(invalid("this key type cannot verify")),
    })
}

// ── AES key wrap with padding (RFC 5649) ──────────────────────────────────

const KWP_IV: [u8; 4] = [0xA6, 0x59, 0x59, 0xA6];

fn kw_cipher(kek: &[u8]) -> Result<Aes256> {
    Aes256::new_from_slice(kek).map_err(|_| invalid("key-wrapping keys are 32 bytes"))
}

/// The RFC 3394 wrapping function W over 64-bit blocks `r` with IV `a`.
fn kw_wrap_blocks(cipher: &Aes256, mut a: [u8; 8], r: &mut [[u8; 8]]) -> [u8; 8] {
    let n = r.len();
    for j in 0..6 {
        for (i, block) in r.iter_mut().enumerate() {
            let mut b = GenericArray::from([0u8; 16]);
            b[..8].copy_from_slice(&a);
            b[8..].copy_from_slice(block);
            cipher.encrypt_block(&mut b);
            let t = ((n * j) + i + 1) as u64;
            for (k, mask) in t.to_be_bytes().iter().enumerate() {
                a[k] = b[k] ^ mask;
            }
            block.copy_from_slice(&b[8..]);
        }
    }
    a
}

/// The RFC 3394 unwrapping function W⁻¹; returns the recovered IV.
fn kw_unwrap_blocks(cipher: &Aes256, mut a: [u8; 8], r: &mut [[u8; 8]]) -> [u8; 8] {
    let n = r.len();
    for j in (0..6).rev() {
        for i in (0..n).rev() {
            let t = ((n * j) + i + 1) as u64;
            let mut b = GenericArray::from([0u8; 16]);
            for (k, mask) in t.to_be_bytes().iter().enumerate() {
                b[k] = a[k] ^ mask;
            }
            b[8..].copy_from_slice(&r[i]);
            cipher.decrypt_block(&mut b);
            a.copy_from_slice(&b[..8]);
            r[i].copy_from_slice(&b[8..]);
        }
    }
    a
}

fn to_blocks(bytes: &[u8]) -> Vec<[u8; 8]> {
    bytes
        .chunks(8)
        .map(|chunk| {
            let mut block = [0u8; 8];
            block[..chunk.len()].copy_from_slice(chunk);
            block
        })
        .collect()
}

/// AES-256 key wrap with padding (RFC 5649).
pub fn kwp_wrap(kek: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    if plaintext.is_empty() || plaintext.len() > MAX_INPUT_BYTES {
        return Err(invalid("key material must be 1 byte to 1 MiB"));
    }
    let cipher = kw_cipher(kek)?;
    let mut aiv = [0u8; 8];
    aiv[..4].copy_from_slice(&KWP_IV);
    aiv[4..].copy_from_slice(&(plaintext.len() as u32).to_be_bytes());
    let mut blocks = to_blocks(plaintext);
    if blocks.len() == 1 {
        let mut b = GenericArray::from([0u8; 16]);
        b[..8].copy_from_slice(&aiv);
        b[8..].copy_from_slice(&blocks[0]);
        cipher.encrypt_block(&mut b);
        return Ok(b.to_vec());
    }
    let a = kw_wrap_blocks(&cipher, aiv, &mut blocks);
    let mut out = a.to_vec();
    for block in blocks {
        out.extend_from_slice(&block);
    }
    Ok(out)
}

/// Inverse of [`kwp_wrap`]; fails on any integrity or padding mismatch.
pub fn kwp_unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>> {
    let bad = || invalid("wrapped key material failed AES-KWP integrity checks");
    if wrapped.len() < 16 || wrapped.len() % 8 != 0 {
        return Err(bad());
    }
    let cipher = kw_cipher(kek)?;
    let n = wrapped.len() / 8 - 1;
    let (a, blocks) = if n == 1 {
        let mut b = GenericArray::clone_from_slice(wrapped);
        cipher.decrypt_block(&mut b);
        let mut a = [0u8; 8];
        a.copy_from_slice(&b[..8]);
        (a, to_blocks(&b[8..]))
    } else {
        let mut a = [0u8; 8];
        a.copy_from_slice(&wrapped[..8]);
        let mut blocks = to_blocks(&wrapped[8..]);
        let a = kw_unwrap_blocks(&cipher, a, &mut blocks);
        (a, blocks)
    };
    if a[..4] != KWP_IV {
        return Err(bad());
    }
    let mli = u32::from_be_bytes([a[4], a[5], a[6], a[7]]) as usize;
    if mli <= 8 * (n - 1) || mli > 8 * n {
        return Err(bad());
    }
    let plain: Vec<u8> = blocks.concat();
    if plain[mli..].iter().any(|byte| *byte != 0) {
        return Err(bad());
    }
    Ok(plain[..mli].to_vec())
}

// ── Backups ───────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupDoc {
    format: String,
    name: String,
    #[serde(rename = "type")]
    key_type: TransitKeyType,
    latest_version: u32,
    min_decryption_version: u32,
    min_encryption_version: u32,
    min_available_version: u32,
    deletion_allowed: bool,
    derived: bool,
    convergent: bool,
    exportable: bool,
    allow_plaintext_backup: bool,
    auto_rotate_period_secs: i64,
    imported: bool,
    created_at: i64,
    versions: Vec<BackupVersion>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupVersion {
    version: u32,
    /// Base64 stored-form key material.
    material: String,
    created_at: i64,
}

impl PluginSecretStore {
    fn transit_material(&self, conn: &Connection, name: &str, version: u32) -> Result<Vec<u8>> {
        let (nonce, ciphertext, key_version): (Vec<u8>, Vec<u8>, u32) = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version FROM vault_transit_keys
                 WHERE name = ?1 AND version = ?2",
                params![name, version],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| {
                VaultError::NotFound(format!("transit key `{name}` version {version}"))
            })?;
        self.open_row(key_version, &nonce, &ciphertext)
    }

    fn insert_transit_material(
        &self,
        conn: &Connection,
        name: &str,
        version: u32,
        material: &[u8],
        public_key: Option<&str>,
        created_at: i64,
    ) -> Result<()> {
        let (key_version, nonce, ciphertext) = self.seal_row(material)?;
        conn.execute(
            "INSERT INTO vault_transit_keys
                (name, version, nonce, ciphertext, key_version, public_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                name,
                version,
                nonce,
                ciphertext,
                key_version,
                public_key,
                created_at
            ],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_transit_key_locked(
        &self,
        conn: &Connection,
        name: &str,
        key_type: TransitKeyType,
        options: &TransitKeyOptions,
        imported: bool,
        material: &[u8],
        public_key: Option<&str>,
        actor: &AuditActor,
        event: &str,
    ) -> Result<()> {
        if let Some(existing) = read_meta(conn, name)? {
            let hint = if existing.deleted_at.is_some() {
                " (soft-deleted; recover or purge it first)"
            } else {
                ""
            };
            return Err(VaultError::Conflict(format!("transit key `{name}` exists{hint}")).into());
        }
        let now = now_millis();
        conn.execute(
            "INSERT INTO vault_transit_meta
                (name, key_type, latest_version, created_at, derived, convergent, exportable,
                 allow_plaintext_backup, auto_rotate_period_secs, imported)
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                name,
                key_type.as_str(),
                now,
                options.derived,
                options.convergent,
                options.exportable,
                options.allow_plaintext_backup,
                options.auto_rotate_period_secs,
                imported
            ],
        )?;
        self.insert_transit_material(conn, name, 1, material, public_key, now)?;
        self.audit_locked(
            conn,
            &AuditEntry::new(actor, event, "ok").details(serde_json::json!({
                "key": name, "type": key_type.as_str(), "derived": options.derived,
                "convergent": options.convergent, "exportable": options.exportable,
            })),
        );
        Ok(())
    }

    /// Create a named transit key with default options.
    pub async fn transit_create(
        &self,
        name: &str,
        key_type: TransitKeyType,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        self.transit_create_with(name, key_type, &TransitKeyOptions::default(), actor)
            .await
    }

    /// Create a named transit key.
    pub async fn transit_create_with(
        &self,
        name: &str,
        key_type: TransitKeyType,
        options: &TransitKeyOptions,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        if !is_valid_key_name(name) {
            return Err(invalid("invalid transit key name"));
        }
        validate_key_options(key_type, options)?;
        // RSA generation is slow; never hold the store lock across it.
        let (material, public_key) =
            tokio::task::spawn_blocking(move || new_material(key_type)).await??;
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        self.insert_transit_key_locked(
            &tx,
            name,
            key_type,
            options,
            false,
            &material,
            public_key.as_deref(),
            actor,
            "transit.create",
        )?;
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Every live transit key.
    pub async fn transit_list(&self) -> Result<Vec<TransitKeyInfo>> {
        self.transit_list_where("deleted_at IS NULL").await
    }

    /// Soft-deleted keys that `recover` can still restore.
    pub async fn transit_list_deleted(&self) -> Result<Vec<TransitKeyInfo>> {
        self.transit_list_where("deleted_at IS NOT NULL").await
    }

    async fn transit_list_where(&self, filter: &str) -> Result<Vec<TransitKeyInfo>> {
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT name FROM vault_transit_meta WHERE {filter} ORDER BY name"
            ))?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        names
            .iter()
            .map(|name| transit_info_locked(&conn, name))
            .collect()
    }

    /// Add a key version and make it the latest.
    pub async fn transit_rotate(&self, name: &str, actor: &AuditActor) -> Result<TransitKeyInfo> {
        let key_type = {
            let conn = self.conn.lock().await;
            meta(&conn, name)?.key_type
        };
        let (material, public_key) =
            tokio::task::spawn_blocking(move || new_material(key_type)).await??;
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let meta = meta(&tx, name)?;
        if meta.key_type != key_type {
            return Err(VaultError::Conflict(format!("transit key `{name}` changed")).into());
        }
        let next = meta.latest + 1;
        self.insert_transit_material(
            &tx,
            name,
            next,
            &material,
            public_key.as_deref(),
            now_millis(),
        )?;
        tx.execute(
            "UPDATE vault_transit_meta SET latest_version = ?1 WHERE name = ?2",
            params![next, name],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.rotate", "ok")
                .details(serde_json::json!({ "key": name, "version": next })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Update `minDecryptionVersion` and `deletionAllowed`.
    pub async fn transit_configure(
        &self,
        name: &str,
        min_decryption_version: Option<u32>,
        deletion_allowed: Option<bool>,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        self.transit_update_config(
            name,
            &TransitConfigUpdate {
                min_decryption_version,
                deletion_allowed,
                ..TransitConfigUpdate::default()
            },
            actor,
        )
        .await
    }

    /// Update key configuration. Validates everything before writing.
    pub async fn transit_update_config(
        &self,
        name: &str,
        update: &TransitConfigUpdate,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if let Some(min) = update.min_decryption_version {
            if min < meta.min_available || min > meta.latest {
                return Err(invalid(
                    "minDecryptionVersion must be between the minimum available and the latest version",
                ));
            }
        }
        if let Some(min) = update.min_encryption_version {
            if min != 0 && (min < meta.min_available || min > meta.latest) {
                return Err(invalid(
                    "minEncryptionVersion must be 0 or between the minimum available and the latest version",
                ));
            }
        }
        let resulting_min_decrypt = update.min_decryption_version.unwrap_or(meta.min_decrypt);
        let resulting_min_encrypt = update.min_encryption_version.unwrap_or(meta.min_encrypt);
        if resulting_min_encrypt != 0 && resulting_min_encrypt < resulting_min_decrypt {
            return Err(invalid(
                "minEncryptionVersion must be 0 or at least minDecryptionVersion",
            ));
        }
        if update.exportable == Some(false) && meta.exportable {
            return Err(invalid("exportable cannot be switched off once enabled"));
        }
        if update.allow_plaintext_backup == Some(false) && meta.allow_plaintext_backup {
            return Err(invalid(
                "allowPlaintextBackup cannot be switched off once enabled",
            ));
        }
        if let Some(period) = update.auto_rotate_period_secs {
            validate_auto_rotate(period)?;
        }
        let tx = conn.unchecked_transaction()?;
        let set = |column: &str, value: &dyn rusqlite::ToSql| -> Result<()> {
            tx.execute(
                &format!("UPDATE vault_transit_meta SET {column} = ?1 WHERE name = ?2"),
                params![value, name],
            )?;
            Ok(())
        };
        if let Some(min) = update.min_decryption_version {
            set("min_decryption_version", &min)?;
        }
        if let Some(min) = update.min_encryption_version {
            set("min_encryption_version", &min)?;
        }
        if let Some(allowed) = update.deletion_allowed {
            set("deletion_allowed", &allowed)?;
        }
        if update.exportable == Some(true) {
            set("exportable", &true)?;
        }
        if update.allow_plaintext_backup == Some(true) {
            set("allow_plaintext_backup", &true)?;
        }
        if let Some(period) = update.auto_rotate_period_secs {
            set("auto_rotate_period_secs", &period)?;
        }
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.configure", "ok").details(serde_json::json!({
                "key": name,
                "minDecryptionVersion": update.min_decryption_version,
                "minEncryptionVersion": update.min_encryption_version,
                "deletionAllowed": update.deletion_allowed,
                "exportable": update.exportable,
                "allowPlaintextBackup": update.allow_plaintext_backup,
                "autoRotatePeriodSecs": update.auto_rotate_period_secs,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Permanently drop versions below `min_available_version`.
    pub async fn transit_trim(
        &self,
        name: &str,
        min_available_version: u32,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if min_available_version < meta.min_available
            || min_available_version > meta.min_decrypt
            || (meta.min_encrypt != 0 && min_available_version > meta.min_encrypt)
            || min_available_version > meta.latest
        {
            return Err(invalid(
                "minAvailableVersion must not decrease and must not exceed minDecryptionVersion, \
                 minEncryptionVersion (when set), or the latest version",
            ));
        }
        let tx = conn.unchecked_transaction()?;
        let removed = tx.execute(
            "DELETE FROM vault_transit_keys WHERE name = ?1 AND version < ?2",
            params![name, min_available_version],
        )?;
        tx.execute(
            "UPDATE vault_transit_meta SET min_available_version = ?1 WHERE name = ?2",
            params![min_available_version, name],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.trim", "ok").details(serde_json::json!({
                "key": name, "minAvailableVersion": min_available_version, "removed": removed,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Soft-delete a key (only when `deletionAllowed`). [`Self::transit_recover`]
    /// restores it until the scheduler purges it.
    pub async fn transit_delete(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.deletion_allowed {
            return Err(denied("set deletionAllowed before deleting a transit key"));
        }
        conn.execute(
            "UPDATE vault_transit_meta SET deleted_at = ?1 WHERE name = ?2",
            params![now_millis(), name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.delete", "ok")
                .details(serde_json::json!({ "key": name, "soft": true })),
        );
        Ok(())
    }

    /// Restore a soft-deleted key.
    pub async fn transit_recover(&self, name: &str, actor: &AuditActor) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE vault_transit_meta SET deleted_at = NULL
             WHERE name = ?1 AND deleted_at IS NOT NULL",
            params![name],
        )?;
        if updated == 0 {
            return Err(VaultError::NotFound(format!("soft-deleted transit key `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.recover", "ok")
                .details(serde_json::json!({ "key": name })),
        );
        transit_info_locked(&conn, name)
    }

    /// Permanently delete a key (live or soft-deleted; `deletionAllowed`
    /// must be set).
    pub async fn transit_purge(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let meta = read_meta(&conn, name)?
            .ok_or_else(|| VaultError::NotFound(format!("transit key `{name}`")))?;
        if !meta.deletion_allowed {
            return Err(denied("set deletionAllowed before deleting a transit key"));
        }
        let tx = conn.unchecked_transaction()?;
        purge_locked(&tx, name)?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.purge", "ok")
                .details(serde_json::json!({ "key": name })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(())
    }

    /// Purge soft-deleted keys older than the recovery window. Scheduler step.
    pub async fn transit_purge_expired(&self) -> Result<usize> {
        let cutoff = now_millis() - soft_delete_window_millis();
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT name FROM vault_transit_meta
                 WHERE deleted_at IS NOT NULL AND deleted_at <= ?1",
            )?;
            let rows = stmt.query_map(params![cutoff], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let tx = conn.unchecked_transaction()?;
        for name in &names {
            purge_locked(&tx, name)?;
            self.audit_locked(
                &tx,
                &AuditEntry::new(&AuditActor::system(), "transit.purge", "ok")
                    .details(serde_json::json!({ "key": name, "expired": true })),
            );
        }
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(names.len())
    }

    /// Live keys whose latest version is older than their auto-rotation
    /// period. Scheduler step.
    pub async fn transit_due_rotations(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT m.name FROM vault_transit_meta m
             JOIN vault_transit_keys k ON k.name = m.name AND k.version = m.latest_version
             WHERE m.auto_rotate_period_secs > 0 AND m.deleted_at IS NULL
               AND k.created_at + m.auto_rotate_period_secs * 1000 <= ?1
             ORDER BY m.name",
        )?;
        let rows = stmt.query_map(params![now_millis()], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Encrypt base64 `plaintext` (optional base64 `context` as AAD).
    pub async fn transit_encrypt(
        &self,
        name: &str,
        plaintext_b64: &str,
        context_b64: Option<&str>,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_encrypt_with(
            name,
            plaintext_b64,
            &TransitOpOptions::with_context(context_b64),
            actor,
        )
        .await
    }

    /// Encrypt base64 `plaintext` with per-operation options.
    pub async fn transit_encrypt_with(
        &self,
        name: &str,
        plaintext_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        // Encryption hands out no secret material, so it never fails closed.
        let (ciphertext, _permitted) = self
            .transit_encrypt_audited(name, plaintext_b64, options, actor, "transit.encrypt")
            .await?;
        Ok(ciphertext)
    }

    /// Encrypt and audit under `action`; also returns the audit verdict.
    async fn transit_encrypt_audited(
        &self,
        name: &str,
        plaintext_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
        action: &str,
    ) -> Result<(String, bool)> {
        let plaintext = decode_input(plaintext_b64)?;
        let context = options.context.as_deref().map(decode_input).transpose()?;
        let associated = options
            .associated_data
            .as_deref()
            .map(decode_input)
            .transpose()?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_encrypt() {
            return Err(invalid("this key type cannot encrypt"));
        }
        let version = meta.select_version(options.key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let out = if meta.key_type.is_symmetric() {
            let (key, aad) = aead_key_and_aad(&meta, &material, context, associated)?;
            let nonce = meta
                .convergent
                .then(|| convergent_nonce(&key, &aad, &plaintext));
            aead_encrypt(meta.key_type, &key, &plaintext, &aad, nonce)?
        } else {
            if context.is_some() || associated.is_some() {
                return Err(invalid("RSA encryption takes no context or associatedData"));
            }
            RsaPublicKey::from(&rsa_key(&material)?)
                .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &plaintext)
                .map_err(|_| invalid("plaintext is too long for this RSA key"))?
        };
        let permitted = self.audit_locked(
            &conn,
            &AuditEntry::new(actor, action, "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        );
        Ok((encode(version, &out), permitted))
    }

    /// Decrypt a transit ciphertext, returning base64 plaintext.
    pub async fn transit_decrypt(
        &self,
        name: &str,
        ciphertext: &str,
        context_b64: Option<&str>,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_decrypt_with(
            name,
            ciphertext,
            &TransitOpOptions::with_context(context_b64),
            actor,
        )
        .await
    }

    /// Decrypt with per-operation options.
    pub async fn transit_decrypt_with(
        &self,
        name: &str,
        ciphertext: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let (version, bytes) = decode(ciphertext)?;
        let context = options.context.as_deref().map(decode_input).transpose()?;
        let associated = options
            .associated_data
            .as_deref()
            .map(decode_input)
            .transpose()?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_encrypt() {
            return Err(invalid("this key type cannot decrypt"));
        }
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let plain = if meta.key_type.is_symmetric() {
            let (key, aad) = aead_key_and_aad(&meta, &material, context, associated)?;
            aead_decrypt(meta.key_type, &key, &bytes, &aad)?
        } else {
            rsa_key(&material)?
                .decrypt(Oaep::new::<Sha256>(), &bytes)
                .map_err(|_| invalid("transit ciphertext failed to decrypt"))?
        };
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.decrypt", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(B64.encode(plain))
    }

    /// Re-encrypt a ciphertext under the latest key version.
    pub async fn transit_rewrap(
        &self,
        name: &str,
        ciphertext: &str,
        context_b64: Option<&str>,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_rewrap_with(
            name,
            ciphertext,
            &TransitOpOptions::with_context(context_b64),
            actor,
        )
        .await
    }

    /// Re-encrypt under `options.key_version` (default latest).
    pub async fn transit_rewrap_with(
        &self,
        name: &str,
        ciphertext: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let plain = self
            .transit_decrypt_with(name, ciphertext, options, actor)
            .await?;
        self.transit_encrypt_with(name, &plain, options, actor)
            .await
    }

    /// Generate a 256-bit data key; return it in plaintext (base64) and
    /// wrapped by the named key (for envelope encryption by the caller).
    pub async fn transit_datakey(
        &self,
        name: &str,
        actor: &AuditActor,
    ) -> Result<(String, String)> {
        self.transit_datakey_with(name, &TransitOpOptions::default(), actor)
            .await
    }

    /// [`Self::transit_datakey`] with options (derived keys need `context`).
    pub async fn transit_datakey_with(
        &self,
        name: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<(String, String)> {
        let data_key = B64.encode(random_bytes(32));
        let (wrapped, permitted) = self
            .transit_encrypt_audited(name, &data_key, options, actor, "transit.datakey")
            .await?;
        if !permitted {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok((data_key, wrapped))
    }

    /// Sign base64 `input` with the latest version of a signing key.
    pub async fn transit_sign(
        &self,
        name: &str,
        input_b64: &str,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_sign_with(name, input_b64, &TransitOpOptions::default(), actor)
            .await
    }

    /// Sign base64 `input` with an Ed25519, ECDSA, or RSA key.
    pub async fn transit_sign_with(
        &self,
        name: &str,
        input_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let input = decode_input(input_b64)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_sign() {
            return Err(invalid("this key type cannot sign"));
        }
        let version = meta.select_version(options.key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let signature = sign_material(
            meta.key_type,
            &material,
            &input,
            options.signature_algorithm.as_deref(),
        )?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.sign", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(encode(version, &signature))
    }

    /// Verify a signature produced by [`Self::transit_sign`].
    pub async fn transit_verify(
        &self,
        name: &str,
        input_b64: &str,
        signature: &str,
        actor: &AuditActor,
    ) -> Result<bool> {
        self.transit_verify_with(
            name,
            input_b64,
            signature,
            &TransitOpOptions::default(),
            actor,
        )
        .await
    }

    /// Verify a signature with options (`signatureAlgorithm` for RSA).
    pub async fn transit_verify_with(
        &self,
        name: &str,
        input_b64: &str,
        signature: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<bool> {
        let input = decode_input(input_b64)?;
        let (version, bytes) = decode(signature)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.key_type.can_sign() {
            return Err(invalid("this key type cannot verify"));
        }
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let valid = verify_material(
            meta.key_type,
            &material,
            &input,
            &bytes,
            options.signature_algorithm.as_deref(),
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.verify", if valid { "ok" } else { "denied" })
                .details(serde_json::json!({ "key": name, "version": version })),
        );
        Ok(valid)
    }

    /// HMAC-SHA256 of base64 `input` with the key's latest version.
    pub async fn transit_hmac(
        &self,
        name: &str,
        input_b64: &str,
        actor: &AuditActor,
    ) -> Result<String> {
        self.transit_hmac_with(name, input_b64, &TransitOpOptions::default(), actor)
            .await
    }

    /// HMAC-SHA256 with options (`keyVersion`).
    pub async fn transit_hmac_with(
        &self,
        name: &str,
        input_b64: &str,
        options: &TransitOpOptions,
        actor: &AuditActor,
    ) -> Result<String> {
        let input = decode_input(input_b64)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        let version = meta.select_version(options.key_version)?;
        let material = self.transit_material(&conn, name, version)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&hmac_key(meta.key_type, &material))
            .expect("any key length");
        mac.update(&input);
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.hmac", "ok")
                .details(serde_json::json!({ "key": name, "version": version })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(encode(version, &mac.finalize().into_bytes()))
    }

    /// Verify an HMAC produced by [`Self::transit_hmac`] (constant time).
    pub async fn transit_verify_hmac(
        &self,
        name: &str,
        input_b64: &str,
        hmac: &str,
        actor: &AuditActor,
    ) -> Result<bool> {
        let input = decode_input(input_b64)?;
        let (version, expected) = decode(hmac)?;
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        meta.check_decryptable(version)?;
        let material = self.transit_material(&conn, name, version)?;
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&hmac_key(meta.key_type, &material))
            .expect("any key length");
        mac.update(&input);
        let valid = mac.verify_slice(&expected).is_ok();
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.verify", if valid { "ok" } else { "denied" })
                .details(serde_json::json!({ "key": name, "version": version, "hmac": true })),
        );
        Ok(valid)
    }

    /// Export key material (`exportable` keys only, except public keys).
    pub async fn transit_export(
        &self,
        name: &str,
        kind: TransitExportKind,
        version: Option<u32>,
        actor: &AuditActor,
    ) -> Result<TransitExport> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        let key_type = meta.key_type;
        let supported = match kind {
            TransitExportKind::EncryptionKey => key_type.can_encrypt(),
            TransitExportKind::SigningKey | TransitExportKind::PublicKey => key_type.can_sign(),
            TransitExportKind::HmacKey => true,
        };
        if !supported {
            return Err(invalid(format!(
                "{} keys have no {}",
                key_type.as_str(),
                kind.as_str()
            )));
        }
        if kind != TransitExportKind::PublicKey && !meta.exportable {
            return Err(denied("this transit key is not exportable"));
        }
        let versions: Vec<u32> = match version {
            Some(version) if (meta.min_available..=meta.latest).contains(&version) => {
                vec![version]
            }
            Some(version) => {
                return Err(
                    VaultError::NotFound(format!("transit key `{name}` version {version}")).into(),
                )
            }
            None => (meta.min_available..=meta.latest).collect(),
        };
        let mut keys = BTreeMap::new();
        for version in versions {
            let value = if kind == TransitExportKind::PublicKey {
                transit_public_key(&conn, name, version)?
            } else {
                let material = self.transit_material(&conn, name, version)?;
                match kind {
                    TransitExportKind::HmacKey => B64.encode(hmac_key(key_type, &material)),
                    _ if key_type.is_symmetric() || key_type == TransitKeyType::Ed25519 => {
                        B64.encode(&material)
                    }
                    _ => private_pem(key_type, &material)?,
                }
            };
            keys.insert(version.to_string(), value);
        }
        if kind != TransitExportKind::PublicKey
            && !self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "transit.export", "ok").details(serde_json::json!({
                    "key": name, "kind": kind.as_str(), "versions": keys.keys().collect::<Vec<_>>(),
                })),
            )
        {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(TransitExport {
            name: name.to_owned(),
            key_type,
            kind,
            keys,
        })
    }

    /// A plaintext backup of every available version and the key's
    /// configuration (base64 JSON). Requires `exportable` and
    /// `allowPlaintextBackup`.
    pub async fn transit_backup(&self, name: &str, actor: &AuditActor) -> Result<String> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.exportable || !meta.allow_plaintext_backup {
            return Err(denied(
                "backups need both exportable and allowPlaintextBackup on the key",
            ));
        }
        let rows: Vec<(u32, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT version, created_at FROM vault_transit_keys
                 WHERE name = ?1 ORDER BY version",
            )?;
            let rows = stmt.query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut versions = Vec::with_capacity(rows.len());
        for (version, created_at) in rows {
            versions.push(BackupVersion {
                version,
                material: B64.encode(self.transit_material(&conn, name, version)?),
                created_at,
            });
        }
        let doc = BackupDoc {
            format: BACKUP_FORMAT.to_owned(),
            name: name.to_owned(),
            key_type: meta.key_type,
            latest_version: meta.latest,
            min_decryption_version: meta.min_decrypt,
            min_encryption_version: meta.min_encrypt,
            min_available_version: meta.min_available,
            deletion_allowed: meta.deletion_allowed,
            derived: meta.derived,
            convergent: meta.convergent,
            exportable: meta.exportable,
            allow_plaintext_backup: meta.allow_plaintext_backup,
            auto_rotate_period_secs: meta.auto_rotate_period_secs,
            imported: meta.imported,
            created_at: meta.created_at,
            versions,
        };
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.backup", "ok")
                .details(serde_json::json!({ "key": name, "versions": doc.versions.len() })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(B64.encode(serde_json::to_vec(&doc)?))
    }

    /// Restore a [`Self::transit_backup`] under its own or a new `name`.
    /// An existing key is replaced only with `force`.
    pub async fn transit_restore(
        &self,
        backup_b64: &str,
        name: Option<&str>,
        force: bool,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let raw = B64
            .decode(backup_b64.trim())
            .map_err(|_| invalid("backup must be base64"))?;
        let doc: BackupDoc =
            serde_json::from_slice(&raw).map_err(|_| invalid("backup is not a transit backup"))?;
        if doc.format != BACKUP_FORMAT {
            return Err(invalid("unsupported transit backup format"));
        }
        let target = name.unwrap_or(&doc.name).to_owned();
        if !is_valid_key_name(&target) {
            return Err(invalid("invalid transit key name"));
        }
        let options = TransitKeyOptions {
            derived: doc.derived,
            convergent: doc.convergent,
            exportable: doc.exportable,
            allow_plaintext_backup: doc.allow_plaintext_backup,
            auto_rotate_period_secs: doc.auto_rotate_period_secs,
        };
        validate_key_options(doc.key_type, &options)?;
        let min_available = doc.min_available_version.max(1);
        let expected: Vec<u32> = (min_available..=doc.latest_version).collect();
        let present: Vec<u32> = doc.versions.iter().map(|v| v.version).collect();
        if expected.is_empty()
            || present != expected
            || doc.min_decryption_version < min_available
            || doc.min_decryption_version > doc.latest_version
            || (doc.min_encryption_version != 0
                && (doc.min_encryption_version < min_available
                    || doc.min_encryption_version > doc.latest_version
                    || doc.min_encryption_version < doc.min_decryption_version))
        {
            return Err(invalid(
                "backup versions or version bounds are inconsistent",
            ));
        }
        let mut materials = Vec::with_capacity(doc.versions.len());
        for version in &doc.versions {
            let material = B64
                .decode(&version.material)
                .map_err(|_| invalid("backup material must be base64"))?;
            let public_key = public_key_of(doc.key_type, &material)?;
            materials.push((version.version, material, public_key, version.created_at));
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        if let Some(existing) = read_meta(&tx, &target)? {
            if !force {
                return Err(VaultError::Conflict(format!(
                    "transit key `{target}` exists (pass force to replace it)"
                ))
                .into());
            }
            // Replacing destroys every version of the existing key, so it is
            // guarded exactly like `transit_purge`.
            if !existing.deletion_allowed {
                return Err(denied("set deletionAllowed before replacing a transit key"));
            }
            purge_locked(&tx, &target)?;
        }
        tx.execute(
            "INSERT INTO vault_transit_meta
                (name, key_type, latest_version, min_decryption_version, min_encryption_version,
                 min_available_version, deletion_allowed, derived, convergent, exportable,
                 allow_plaintext_backup, auto_rotate_period_secs, imported, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                target,
                doc.key_type.as_str(),
                doc.latest_version,
                doc.min_decryption_version,
                doc.min_encryption_version,
                min_available,
                doc.deletion_allowed,
                doc.derived,
                doc.convergent,
                doc.exportable,
                doc.allow_plaintext_backup,
                doc.auto_rotate_period_secs,
                doc.imported,
                doc.created_at
            ],
        )?;
        for (version, material, public_key, created_at) in &materials {
            self.insert_transit_material(
                &tx,
                &target,
                *version,
                material,
                public_key.as_deref(),
                *created_at,
            )?;
        }
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.restore", "ok").details(serde_json::json!({
                "key": target, "from": doc.name, "versions": materials.len(), "force": force,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, &target)
    }

    /// The BYOK wrapping key (SPKI PEM), generated on first use.
    pub async fn transit_wrapping_key(&self) -> Result<String> {
        {
            let conn = self.conn.lock().await;
            if let Some(pem) = transit_public_key_opt(&conn, WRAPPING_KEY_NAME, 1)? {
                return Ok(pem);
            }
        }
        let (material, public_key) = tokio::task::spawn_blocking(|| -> Result<_> {
            let key = RsaPrivateKey::new(&mut OsRng, WRAPPING_KEY_BITS)
                .map_err(|error| anyhow!("generating the wrapping key: {error}"))?;
            let der = der_bytes(key.to_pkcs8_der())?;
            let pem = spki_pem(RsaPublicKey::from(&key).to_public_key_pem(LineEnding::LF))?;
            Ok((der, pem))
        })
        .await??;
        let conn = self.conn.lock().await;
        if let Some(pem) = transit_public_key_opt(&conn, WRAPPING_KEY_NAME, 1)? {
            // Another caller won the race; keep the first key.
            return Ok(pem);
        }
        self.insert_transit_material(
            &conn,
            WRAPPING_KEY_NAME,
            1,
            &material,
            Some(&public_key),
            now_millis(),
        )?;
        Ok(public_key)
    }

    fn unwrap_import(&self, conn: &Connection, ciphertext_b64: &str) -> Result<Vec<u8>> {
        let blob = B64
            .decode(ciphertext_b64.trim())
            .map_err(|_| invalid("ciphertext must be base64"))?;
        if blob.len() > 64 * 1024 {
            return Err(invalid("import ciphertext is too large"));
        }
        if transit_public_key_opt(conn, WRAPPING_KEY_NAME, 1)?.is_none() {
            return Err(invalid(
                "fetch the wrapping key (GET /api/vault/transit/wrapping-key) before importing",
            ));
        }
        let wrapping = rsa_key(&self.transit_material(conn, WRAPPING_KEY_NAME, 1)?)?;
        let split = wrapping.size();
        if blob.len() <= split {
            return Err(invalid(
                "import ciphertext must be the RSA-OAEP wrapped key followed by AES-KWP output",
            ));
        }
        let (wrapped_key, wrapped_material) = blob.split_at(split);
        let ephemeral = wrapping
            .decrypt(Oaep::new::<Sha256>(), wrapped_key)
            .map_err(|_| invalid("the ephemeral key failed RSA-OAEP-SHA256 decryption"))?;
        if ephemeral.len() != 32 {
            return Err(invalid("the ephemeral key must be AES-256"));
        }
        kwp_unwrap(&ephemeral, wrapped_material)
    }

    /// Create a key from wrapped external material (BYOK).
    pub async fn transit_import(
        &self,
        name: &str,
        key_type: TransitKeyType,
        ciphertext_b64: &str,
        options: &TransitKeyOptions,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        if !is_valid_key_name(name) {
            return Err(invalid("invalid transit key name"));
        }
        validate_key_options(key_type, options)?;
        let conn = self.conn.lock().await;
        let material = normalize_import(key_type, self.unwrap_import(&conn, ciphertext_b64)?)?;
        let public_key = public_key_of(key_type, &material)?;
        let tx = conn.unchecked_transaction()?;
        self.insert_transit_key_locked(
            &tx,
            name,
            key_type,
            options,
            true,
            &material,
            public_key.as_deref(),
            actor,
            "transit.import",
        )?;
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Add an imported version to an existing key and make it the latest.
    pub async fn transit_import_version(
        &self,
        name: &str,
        ciphertext_b64: &str,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.imported {
            return Err(invalid("import_version only applies to imported keys"));
        }
        let material = normalize_import(meta.key_type, self.unwrap_import(&conn, ciphertext_b64)?)?;
        let public_key = public_key_of(meta.key_type, &material)?;
        let next = meta.latest + 1;
        let tx = conn.unchecked_transaction()?;
        self.insert_transit_material(
            &tx,
            name,
            next,
            &material,
            public_key.as_deref(),
            now_millis(),
        )?;
        tx.execute(
            "UPDATE vault_transit_meta SET latest_version = ?1, imported = 1 WHERE name = ?2",
            params![next, name],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.import", "ok")
                .details(serde_json::json!({ "key": name, "version": next })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }
}

fn purge_locked(conn: &Connection, name: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_transit_keys WHERE name = ?1",
        params![name],
    )?;
    conn.execute(
        "DELETE FROM vault_transit_meta WHERE name = ?1",
        params![name],
    )?;
    Ok(())
}

fn transit_public_key_opt(conn: &Connection, name: &str, version: u32) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT public_key FROM vault_transit_keys WHERE name = ?1 AND version = ?2",
            params![name, version],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn transit_public_key(conn: &Connection, name: &str, version: u32) -> Result<String> {
    transit_public_key_opt(conn, name, version)?.ok_or_else(|| {
        VaultError::NotFound(format!("public key for `{name}` version {version}")).into()
    })
}

fn transit_info_locked(conn: &Connection, name: &str) -> Result<TransitKeyInfo> {
    let meta = read_meta(conn, name)?
        .ok_or_else(|| VaultError::NotFound(format!("transit key `{name}`")))?;
    let mut stmt = conn.prepare(
        "SELECT version, public_key FROM vault_transit_keys
         WHERE name = ?1 AND public_key IS NOT NULL ORDER BY version",
    )?;
    let public_keys = stmt
        .query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(u32, String)>>>()?;
    Ok(TransitKeyInfo {
        name: name.to_owned(),
        key_type: meta.key_type,
        latest_version: meta.latest,
        min_decryption_version: meta.min_decrypt,
        min_encryption_version: meta.min_encrypt,
        min_available_version: meta.min_available,
        deletion_allowed: meta.deletion_allowed,
        derived: meta.derived,
        convergent: meta.convergent,
        exportable: meta.exportable,
        allow_plaintext_backup: meta.allow_plaintext_backup,
        auto_rotate_period_secs: meta.auto_rotate_period_secs,
        imported: meta.imported,
        created_at: meta.created_at,
        deleted_at: meta.deleted_at,
        public_keys,
    })
}

#[cfg(test)]
mod tests {
    use rsa::pkcs8::DecodePublicKey;

    use super::*;

    fn actor() -> AuditActor {
        AuditActor::new("machine", Some("m1"))
    }

    fn opts(context: Option<&[u8]>) -> TransitOpOptions {
        TransitOpOptions {
            context: context.map(|c| B64.encode(c)),
            ..TransitOpOptions::default()
        }
    }

    #[tokio::test]
    async fn encrypt_decrypt_rotate_and_rewrap() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("orders", TransitKeyType::Aes256Gcm96, &actor())
            .await
            .unwrap();
        let plain = B64.encode(b"card 4242");
        let context = B64.encode(b"tenant-1");
        let v1 = store
            .transit_encrypt("orders", &plain, Some(&context), &actor())
            .await
            .unwrap();
        assert!(v1.starts_with("ryu:v1:"));
        assert_eq!(
            store
                .transit_decrypt("orders", &v1, Some(&context), &actor())
                .await
                .unwrap(),
            plain
        );
        // A different context fails authentication.
        assert!(store
            .transit_decrypt("orders", &v1, Some(&B64.encode(b"tenant-2")), &actor())
            .await
            .is_err());

        store.transit_rotate("orders", &actor()).await.unwrap();
        let v2 = store
            .transit_rewrap("orders", &v1, Some(&context), &actor())
            .await
            .unwrap();
        assert!(v2.starts_with("ryu:v2:"));
        store
            .transit_configure("orders", Some(2), None, &actor())
            .await
            .unwrap();
        assert!(store
            .transit_decrypt("orders", &v1, Some(&context), &actor())
            .await
            .is_err());
        assert_eq!(
            store
                .transit_decrypt("orders", &v2, Some(&context), &actor())
                .await
                .unwrap(),
            plain
        );
    }

    #[tokio::test]
    async fn sign_verify_and_hmac() {
        let store = PluginSecretStore::in_memory().unwrap();
        let info = store
            .transit_create("release", TransitKeyType::Ed25519, &actor())
            .await
            .unwrap();
        assert_eq!(info.public_keys.len(), 1);
        let input = B64.encode(b"artifact digest");
        let signature = store
            .transit_sign("release", &input, &actor())
            .await
            .unwrap();
        assert!(store
            .transit_verify("release", &input, &signature, &actor())
            .await
            .unwrap());
        assert!(!store
            .transit_verify("release", &B64.encode(b"tampered"), &signature, &actor())
            .await
            .unwrap());
        assert!(store
            .transit_encrypt("release", &input, None, &actor())
            .await
            .is_err());
        let a = store
            .transit_hmac("release", &input, &actor())
            .await
            .unwrap();
        let b = store
            .transit_hmac("release", &input, &actor())
            .await
            .unwrap();
        assert_eq!(a, b);
        assert!(store
            .transit_verify_hmac("release", &input, &a, &actor())
            .await
            .unwrap());
        assert!(!store
            .transit_verify_hmac("release", &B64.encode(b"other"), &a, &actor())
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn datakeys_unwrap_to_the_returned_plaintext_and_deletion_is_guarded() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("env", TransitKeyType::Aes256Gcm96, &actor())
            .await
            .unwrap();
        let (plain, wrapped) = store.transit_datakey("env", &actor()).await.unwrap();
        assert_eq!(
            store
                .transit_decrypt("env", &wrapped, None, &actor())
                .await
                .unwrap(),
            plain
        );
        assert!(store.transit_delete("env", &actor()).await.is_err());
        store
            .transit_configure("env", None, Some(true), &actor())
            .await
            .unwrap();
        store.transit_delete("env", &actor()).await.unwrap();
        assert!(store.transit_list().await.unwrap().is_empty());
        assert!(store
            .transit_create("Bad Name", TransitKeyType::Ed25519, &actor())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn soft_delete_hides_the_key_until_recovered_or_purged() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("tmp", TransitKeyType::Chacha20Poly1305, &actor())
            .await
            .unwrap();
        let ciphertext = store
            .transit_encrypt("tmp", &B64.encode(b"x"), None, &actor())
            .await
            .unwrap();
        store
            .transit_configure("tmp", None, Some(true), &actor())
            .await
            .unwrap();
        store.transit_delete("tmp", &actor()).await.unwrap();
        assert!(store
            .transit_decrypt("tmp", &ciphertext, None, &actor())
            .await
            .is_err());
        assert_eq!(store.transit_list_deleted().await.unwrap().len(), 1);
        // The name stays reserved while soft-deleted.
        assert!(store
            .transit_create("tmp", TransitKeyType::Aes256Gcm96, &actor())
            .await
            .is_err());
        store.transit_recover("tmp", &actor()).await.unwrap();
        assert_eq!(
            store
                .transit_decrypt("tmp", &ciphertext, None, &actor())
                .await
                .unwrap(),
            B64.encode(b"x")
        );
        // Inside the window nothing is purged.
        store.transit_delete("tmp", &actor()).await.unwrap();
        assert_eq!(store.transit_purge_expired().await.unwrap(), 0);
        store.transit_purge("tmp", &actor()).await.unwrap();
        assert!(store.transit_list_deleted().await.unwrap().is_empty());
        assert!(store.transit_recover("tmp", &actor()).await.is_err());
    }

    #[tokio::test]
    async fn derived_and_convergent_keys_bind_the_context() {
        let store = PluginSecretStore::in_memory().unwrap();
        let options = TransitKeyOptions {
            derived: true,
            convergent: true,
            ..TransitKeyOptions::default()
        };
        store
            .transit_create_with("pii", TransitKeyType::Aes256Gcm96, &options, &actor())
            .await
            .unwrap();
        let plain = B64.encode(b"alice@example.com");
        // Derived keys require a context.
        assert!(store
            .transit_encrypt_with("pii", &plain, &opts(None), &actor())
            .await
            .is_err());
        let a = store
            .transit_encrypt_with("pii", &plain, &opts(Some(b"tenant-1")), &actor())
            .await
            .unwrap();
        let b = store
            .transit_encrypt_with("pii", &plain, &opts(Some(b"tenant-1")), &actor())
            .await
            .unwrap();
        let c = store
            .transit_encrypt_with("pii", &plain, &opts(Some(b"tenant-2")), &actor())
            .await
            .unwrap();
        assert_eq!(a, b, "convergent encryption is deterministic");
        assert_ne!(a, c, "contexts derive different keys");
        assert_eq!(
            store
                .transit_decrypt_with("pii", &c, &opts(Some(b"tenant-2")), &actor())
                .await
                .unwrap(),
            plain
        );
        assert!(store
            .transit_decrypt_with("pii", &c, &opts(Some(b"tenant-1")), &actor())
            .await
            .is_err());
        // Convergent without derived, or derivation on a signing key, is refused.
        let bad = TransitKeyOptions {
            convergent: true,
            ..TransitKeyOptions::default()
        };
        assert!(store
            .transit_create_with("bad", TransitKeyType::Aes256Gcm96, &bad, &actor())
            .await
            .is_err());
        let bad = TransitKeyOptions {
            derived: true,
            ..TransitKeyOptions::default()
        };
        assert!(store
            .transit_create_with("bad", TransitKeyType::Ed25519, &bad, &actor())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn associated_data_is_authenticated() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("ad", TransitKeyType::Chacha20Poly1305, &actor())
            .await
            .unwrap();
        let with_ad = |ad: &[u8]| TransitOpOptions {
            associated_data: Some(B64.encode(ad)),
            ..TransitOpOptions::default()
        };
        let ciphertext = store
            .transit_encrypt_with("ad", &B64.encode(b"m"), &with_ad(b"row-7"), &actor())
            .await
            .unwrap();
        assert!(store
            .transit_decrypt_with("ad", &ciphertext, &with_ad(b"row-8"), &actor())
            .await
            .is_err());
        assert!(store
            .transit_decrypt_with("ad", &ciphertext, &with_ad(b"row-7"), &actor())
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn min_versions_and_trim_bound_usable_versions() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("v", TransitKeyType::Aes256Gcm96, &actor())
            .await
            .unwrap();
        let plain = B64.encode(b"p");
        let v1 = store
            .transit_encrypt("v", &plain, None, &actor())
            .await
            .unwrap();
        store.transit_rotate("v", &actor()).await.unwrap();
        store.transit_rotate("v", &actor()).await.unwrap();
        let pinned = TransitOpOptions {
            key_version: Some(2),
            ..TransitOpOptions::default()
        };
        assert!(store
            .transit_encrypt_with("v", &plain, &pinned, &actor())
            .await
            .unwrap()
            .starts_with("ryu:v2:"));
        store
            .transit_update_config(
                "v",
                &TransitConfigUpdate {
                    min_encryption_version: Some(3),
                    min_decryption_version: Some(2),
                    ..TransitConfigUpdate::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        assert!(store
            .transit_encrypt_with("v", &plain, &pinned, &actor())
            .await
            .is_err());
        // Trim cannot pass minDecryptionVersion.
        assert!(store.transit_trim("v", 3, &actor()).await.is_err());
        let info = store.transit_trim("v", 2, &actor()).await.unwrap();
        assert_eq!(info.min_available_version, 2);
        assert!(store
            .transit_decrypt("v", &v1, None, &actor())
            .await
            .is_err());
        // Trim never goes backwards; minDecryptionVersion cannot drop below it.
        assert!(store.transit_trim("v", 1, &actor()).await.is_err());
        assert!(store
            .transit_configure("v", Some(1), None, &actor())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn never_encrypts_below_the_decryption_floor() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("floor", TransitKeyType::Aes256Gcm96, &actor())
            .await
            .unwrap();
        store.transit_rotate("floor", &actor()).await.unwrap();
        store.transit_rotate("floor", &actor()).await.unwrap();
        store
            .transit_update_config(
                "floor",
                &TransitConfigUpdate {
                    min_decryption_version: Some(3),
                    ..TransitConfigUpdate::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        let pinned = TransitOpOptions {
            key_version: Some(1),
            ..TransitOpOptions::default()
        };
        let plain = B64.encode(b"p");
        assert!(store
            .transit_encrypt_with("floor", &plain, &pinned, &actor())
            .await
            .is_err());
        // minEncryptionVersion may not sit below minDecryptionVersion.
        assert!(store
            .transit_update_config(
                "floor",
                &TransitConfigUpdate {
                    min_encryption_version: Some(2),
                    ..TransitConfigUpdate::default()
                },
                &actor(),
            )
            .await
            .is_err());
        // Generated keys refuse import_version.
        assert!(store
            .transit_import_version("floor", "AAAA", &actor())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn export_and_backup_are_gated_and_round_trip() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("bk", TransitKeyType::Aes256Gcm96, &actor())
            .await
            .unwrap();
        let plain = B64.encode(b"backup me");
        let ciphertext = store
            .transit_encrypt("bk", &plain, None, &actor())
            .await
            .unwrap();
        assert!(store
            .transit_export("bk", TransitExportKind::EncryptionKey, None, &actor())
            .await
            .is_err());
        assert!(store.transit_backup("bk", &actor()).await.is_err());
        store
            .transit_update_config(
                "bk",
                &TransitConfigUpdate {
                    exportable: Some(true),
                    allow_plaintext_backup: Some(true),
                    ..TransitConfigUpdate::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        // One-way switches.
        assert!(store
            .transit_update_config(
                "bk",
                &TransitConfigUpdate {
                    exportable: Some(false),
                    ..TransitConfigUpdate::default()
                },
                &actor(),
            )
            .await
            .is_err());
        let export = store
            .transit_export("bk", TransitExportKind::EncryptionKey, Some(1), &actor())
            .await
            .unwrap();
        let raw = B64.decode(&export.keys["1"]).unwrap();
        // The exported key decrypts the transit ciphertext locally.
        let (_, blob) = decode(&ciphertext).unwrap();
        let local = aead_decrypt(TransitKeyType::Aes256Gcm96, &raw, &blob, b"").unwrap();
        assert_eq!(B64.encode(local), plain);
        assert!(store
            .transit_export("bk", TransitExportKind::SigningKey, None, &actor())
            .await
            .is_err());

        let backup = store.transit_backup("bk", &actor()).await.unwrap();
        assert!(store
            .transit_restore(&backup, None, false, &actor())
            .await
            .is_err());
        let restored = store
            .transit_restore(&backup, Some("bk-copy"), false, &actor())
            .await
            .unwrap();
        assert!(restored.exportable && restored.allow_plaintext_backup);
        // Forced replacement honours deletion protection.
        assert!(store
            .transit_restore(&backup, None, true, &actor())
            .await
            .is_err());
        assert_eq!(
            store
                .transit_decrypt("bk-copy", &ciphertext, None, &actor())
                .await
                .unwrap(),
            plain
        );
    }

    /// PKCS#8 keys from `openssl genpkey -algorithm EC -pkeyopt
    /// ec_paramgen_curve:P-256|P-384`, with the public key and RFC 6979
    /// signature that the p256/p384 0.13 code path produced for them. Stored
    /// material from before the elliptic-curve 0.14 migration must load, export,
    /// and sign byte-for-byte as it did.
    const LEGACY_EC_KEYS: [(TransitKeyType, &str, &str, &str); 2] = [
        (
            TransitKeyType::EcdsaP256,
            "-----BEGIN PRIVATE KEY-----\n\
             MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgiTf9VvaRQ8zIeW4T\n\
             Jclc3u5TK30CSE8SNyo0nx03e/qhRANCAASvaRvYGkV/Jps0HZRD8X/c7VP4U+k7\n\
             /nEXNof6PHYI2ccnx5BkGU4cFwUaTHlGPhIAdILy6RJMFCCa3lFtiyXQ\n\
             -----END PRIVATE KEY-----\n",
            "-----BEGIN PUBLIC KEY-----\n\
             MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEr2kb2BpFfyabNB2UQ/F/3O1T+FPp\n\
             O/5xFzaH+jx2CNnHJ8eQZBlOHBcFGkx5Rj4SAHSC8ukSTBQgmt5RbYsl0A==\n\
             -----END PUBLIC KEY-----\n",
            "MEYCIQDH4RV3O4ZnA7ZRHu0G1fgOt/WvYAsA49UKYCitLP8THAIhAJ2Q16YS/Krct3IjH5O4+4DqMzZBQHG0aTLg3k0xbVEN",
        ),
        (
            TransitKeyType::EcdsaP384,
            "-----BEGIN PRIVATE KEY-----\n\
             MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDAJ2vAA4SUfcm7Pr8CL\n\
             daUBCcGk5CSNVUIqQBQR6vfCz8nCYlLTZHNplCOBhEkmoxihZANiAATiqRCU5Qq3\n\
             4aA7ZqLU7PFBgIWA3scqk1AzAcfXUd2m5l+UY3G3QsqmELxt3VVya8im7MgiuE+0\n\
             1Z/B10KHEncPIMlVZuAEkXT+qz+uAEylwwbBf4SePpMUN3eEZkxy2hg=\n\
             -----END PRIVATE KEY-----\n",
            "-----BEGIN PUBLIC KEY-----\n\
             MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE4qkQlOUKt+GgO2ai1OzxQYCFgN7HKpNQ\n\
             MwHH11HdpuZflGNxt0LKphC8bd1VcmvIpuzIIrhPtNWfwddChxJ3DyDJVWbgBJF0\n\
             /qs/rgBMpcMGwX+Enj6TFDd3hGZMctoY\n\
             -----END PUBLIC KEY-----\n",
            "MGQCMAMTaqiL3zjnHt/TPrBjJ/SWc8+hO7d4NAJ2z7Hg/CgeO7JuFwteMJF8wf7LTiEhQQIwWK2IhTrU8cBMSs2vbFYSJgELeQZiy64dlzxDEn4EoHvWA8LaH9jfRc7XnlhRaRwJ",
        ),
    ];

    #[test]
    fn legacy_ecdsa_pkcs8_keys_load_export_and_sign_unchanged() {
        let input = b"ryu transit p-curve regression";
        for (kind, private, public, signature) in LEGACY_EC_KEYS {
            let body: String = private
                .lines()
                .filter(|line| !line.starts_with("-----"))
                .collect();
            let der = B64.decode(body).unwrap();
            // Import normalization keeps the stored DER byte-identical.
            let material = normalize_import(kind, der.clone()).unwrap();
            assert_eq!(material, der, "{}", kind.as_str());
            assert_eq!(
                public_key_of(kind, &material).unwrap().as_deref(),
                Some(public),
                "{}",
                kind.as_str()
            );
            assert_eq!(private_pem(kind, &material).unwrap(), private);
            // RFC 6979 signing is deterministic, so the DER signature matches
            // what the previous code path produced.
            let signed = sign_material(kind, &material, input, None).unwrap();
            assert_eq!(B64.encode(&signed), signature, "{}", kind.as_str());
            let legacy = B64.decode(signature).unwrap();
            assert!(verify_material(kind, &material, input, &legacy, None).unwrap());
            assert!(!verify_material(kind, &material, b"forged", &legacy, None).unwrap());
        }
    }

    #[tokio::test]
    async fn ecdsa_keys_sign_and_verify_and_export_public_keys() {
        let store = PluginSecretStore::in_memory().unwrap();
        for (name, kind) in [
            ("p256", TransitKeyType::EcdsaP256),
            ("p384", TransitKeyType::EcdsaP384),
        ] {
            let info = store.transit_create(name, kind, &actor()).await.unwrap();
            assert!(info.public_keys[0]
                .1
                .starts_with("-----BEGIN PUBLIC KEY-----"));
            let input = B64.encode(b"release manifest");
            let signature = store.transit_sign(name, &input, &actor()).await.unwrap();
            assert!(store
                .transit_verify(name, &input, &signature, &actor())
                .await
                .unwrap());
            assert!(!store
                .transit_verify(name, &B64.encode(b"forged"), &signature, &actor())
                .await
                .unwrap());
            let public = store
                .transit_export(name, TransitExportKind::PublicKey, None, &actor())
                .await
                .unwrap();
            assert_eq!(public.keys["1"], info.public_keys[0].1);
            // ECDSA keys cannot encrypt.
            assert!(store
                .transit_encrypt(name, &input, None, &actor())
                .await
                .is_err());
        }
    }

    #[tokio::test]
    async fn rsa_keys_encrypt_and_sign_with_pss_and_pkcs1v15() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .transit_create("rsa", TransitKeyType::Rsa2048, &actor())
            .await
            .unwrap();
        let plain = B64.encode(b"wrapped secret");
        let ciphertext = store
            .transit_encrypt("rsa", &plain, None, &actor())
            .await
            .unwrap();
        assert_eq!(
            store
                .transit_decrypt("rsa", &ciphertext, None, &actor())
                .await
                .unwrap(),
            plain
        );
        for algorithm in ["pss", "pkcs1v15"] {
            let options = TransitOpOptions {
                signature_algorithm: Some(algorithm.into()),
                ..TransitOpOptions::default()
            };
            let signature = store
                .transit_sign_with("rsa", &plain, &options, &actor())
                .await
                .unwrap();
            assert!(store
                .transit_verify_with("rsa", &plain, &signature, &options, &actor())
                .await
                .unwrap());
        }
        let bad = TransitOpOptions {
            signature_algorithm: Some("md5".into()),
            ..TransitOpOptions::default()
        };
        assert!(store
            .transit_sign_with("rsa", &plain, &bad, &actor())
            .await
            .is_err());
    }

    #[test]
    fn aes_key_wrap_matches_rfc_3394_and_kwp_round_trips() {
        // RFC 3394 section 4.6: 256 bits of key data with a 256-bit KEK.
        let kek = hex::decode("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F")
            .unwrap();
        let data = hex::decode("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F")
            .unwrap();
        let cipher = kw_cipher(&kek).unwrap();
        let mut blocks = to_blocks(&data);
        let a = kw_wrap_blocks(&cipher, [0xA6; 8], &mut blocks);
        let mut wrapped = a.to_vec();
        wrapped.extend(blocks.concat());
        assert_eq!(
            hex::encode_upper(&wrapped),
            "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21"
        );
        let mut back = to_blocks(&wrapped[8..]);
        let mut iv = [0u8; 8];
        iv.copy_from_slice(&wrapped[..8]);
        assert_eq!(kw_unwrap_blocks(&cipher, iv, &mut back), [0xA6; 8]);
        assert_eq!(back.concat(), data);

        for len in [1usize, 7, 8, 9, 20, 32, 1218] {
            let material = random_bytes(len);
            let wrapped = kwp_wrap(&kek, &material).unwrap();
            assert_eq!(kwp_unwrap(&kek, &wrapped).unwrap(), material, "len {len}");
            let mut tampered = wrapped.clone();
            tampered[0] ^= 1;
            assert!(kwp_unwrap(&kek, &tampered).is_err());
        }
    }

    #[tokio::test]
    async fn byok_import_unwraps_material_the_caller_can_reproduce() {
        let store = PluginSecretStore::in_memory().unwrap();
        let pem = store.transit_wrapping_key().await.unwrap();
        assert_eq!(store.transit_wrapping_key().await.unwrap(), pem);
        assert!(store.transit_list().await.unwrap().is_empty());
        let public = RsaPublicKey::from_public_key_pem(&pem).unwrap();
        let wrap = |material: &[u8]| {
            let ephemeral = random_bytes(32);
            let mut blob = public
                .encrypt(&mut OsRng, Oaep::new::<Sha256>(), &ephemeral)
                .unwrap();
            blob.extend(kwp_wrap(&ephemeral, material).unwrap());
            B64.encode(blob)
        };
        let material = random_bytes(32);
        let info = store
            .transit_import(
                "byok",
                TransitKeyType::Aes256Gcm96,
                &wrap(&material),
                &TransitKeyOptions::default(),
                &actor(),
            )
            .await
            .unwrap();
        assert!(info.imported);
        let plain = B64.encode(b"customer data");
        let ciphertext = store
            .transit_encrypt("byok", &plain, None, &actor())
            .await
            .unwrap();
        let (_, blob) = decode(&ciphertext).unwrap();
        let local = aead_decrypt(TransitKeyType::Aes256Gcm96, &material, &blob, b"").unwrap();
        assert_eq!(B64.encode(local), plain);

        // A new imported version becomes the latest.
        let info = store
            .transit_import_version("byok", &wrap(&random_bytes(32)), &actor())
            .await
            .unwrap();
        assert_eq!(info.latest_version, 2);
        // Wrong-size material and garbage are rejected.
        assert!(store
            .transit_import_version("byok", &wrap(&random_bytes(16)), &actor())
            .await
            .is_err());
        assert!(store
            .transit_import(
                "junk",
                TransitKeyType::Aes256Gcm96,
                &B64.encode(random_bytes(600)),
                &TransitKeyOptions::default(),
                &actor(),
            )
            .await
            .is_err());
        // Ed25519 accepts a PKCS#8 seed.
        let seed: [u8; 32] = random_bytes(32).try_into().unwrap();
        let mut pkcs8 = ED25519_PKCS8_PREFIX.to_vec();
        pkcs8.extend(seed);
        let info = store
            .transit_import(
                "signer",
                TransitKeyType::Ed25519,
                &wrap(&pkcs8),
                &TransitKeyOptions::default(),
                &actor(),
            )
            .await
            .unwrap();
        let expected = ed25519_dalek::SigningKey::from_bytes(&seed);
        assert_eq!(
            info.public_keys[0].1,
            B64.encode(expected.verifying_key().to_bytes())
        );
    }

    #[tokio::test]
    async fn auto_rotation_is_due_only_after_the_period() {
        let store = PluginSecretStore::in_memory().unwrap();
        let options = TransitKeyOptions {
            auto_rotate_period_secs: 3600,
            ..TransitKeyOptions::default()
        };
        store
            .transit_create_with("auto", TransitKeyType::Hmac, &options, &actor())
            .await
            .unwrap();
        assert!(store.transit_due_rotations().await.unwrap().is_empty());
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_transit_keys SET created_at = created_at - 3601000 WHERE name = 'auto'",
                [],
            )
            .unwrap();
        }
        assert_eq!(store.transit_due_rotations().await.unwrap(), vec!["auto"]);
        assert!(store
            .transit_create_with(
                "fast",
                TransitKeyType::Hmac,
                &TransitKeyOptions {
                    auto_rotate_period_secs: 60,
                    ..TransitKeyOptions::default()
                },
                &actor(),
            )
            .await
            .is_err());
        // HMAC keys only HMAC.
        assert!(store
            .transit_encrypt("auto", &B64.encode(b"x"), None, &actor())
            .await
            .is_err());
        assert!(store
            .transit_hmac("auto", &B64.encode(b"x"), &actor())
            .await
            .is_ok());
    }
}
