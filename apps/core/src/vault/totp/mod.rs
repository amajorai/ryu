//! TOTP engine: server-held one-time-password seeds (RFC 6238 / RFC 4226).
//!
//! A key is either generated here (a random seed, returned once as an
//! `otpauth://` URL and optional QR code when `exported`) or imported from an
//! `otpauth://totp/...` URL or a Base32 seed. Seeds are sealed with the vault
//! keyring in `vault_totp_keys`, so a sealed vault produces no codes and
//! `rewrap_all` covers them. After creation no route returns a seed: callers
//! ask for the current code (`use`) or validate a code they were given
//! (`use`). Validation rejects a time step at or before the last accepted one,
//! so a code cannot be replayed inside its skew window (RFC 6238 §5.2).
//!
//! [`code_from_seed_value`] lets a key/value secret hold a seed too:
//! `secret:NAME#totp` resolves to the current code instead of the stored value.

pub mod qr;

use anyhow::{Context, Result};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, random_bytes, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// Default seed size for generated keys (160 bits, RFC 4226 §4 R6).
pub const DEFAULT_KEY_BYTES: usize = 20;
/// Smallest accepted imported seed (80 bits, common in the wild).
const MIN_IMPORT_KEY_BYTES: usize = 10;
const MIN_GENERATED_KEY_BYTES: usize = 16;
const MAX_KEY_BYTES: usize = 64;
const MAX_LABEL_LEN: usize = 128;
/// Largest accepted skew in steps either side of now.
pub const MAX_SKEW: u32 = 2;
const MIN_PERIOD_SECS: u64 = 15;
const MAX_PERIOD_SECS: u64 = 300;

type HmacSha1 = Hmac<sha1::Sha1>;
type HmacSha256 = Hmac<sha2::Sha256>;
type HmacSha512 = Hmac<sha2::Sha512>;

/// HMAC hash for code generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum TotpAlgorithm {
    #[default]
    #[serde(rename = "SHA1")]
    Sha1,
    #[serde(rename = "SHA256")]
    Sha256,
    #[serde(rename = "SHA512")]
    Sha512,
}

impl TotpAlgorithm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sha1 => "SHA1",
            Self::Sha256 => "SHA256",
            Self::Sha512 => "SHA512",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.to_ascii_uppercase().as_str() {
            "SHA1" => Some(Self::Sha1),
            "SHA256" => Some(Self::Sha256),
            "SHA512" => Some(Self::Sha512),
            _ => None,
        }
    }

    fn mac(self, key: &[u8], message: &[u8]) -> Vec<u8> {
        // `new_from_slice` accepts any key length for HMAC.
        match self {
            Self::Sha1 => {
                let mut mac = HmacSha1::new_from_slice(key).expect("hmac key");
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            }
            Self::Sha256 => {
                let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            }
            Self::Sha512 => {
                let mut mac = HmacSha512::new_from_slice(key).expect("hmac key");
                mac.update(message);
                mac.finalize().into_bytes().to_vec()
            }
        }
    }
}

/// Code parameters shared by stored keys and `#totp` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TotpParams {
    pub algorithm: TotpAlgorithm,
    pub digits: u32,
    pub period: u64,
}

impl Default for TotpParams {
    fn default() -> Self {
        Self {
            algorithm: TotpAlgorithm::Sha1,
            digits: 6,
            period: 30,
        }
    }
}

impl TotpParams {
    fn validate(&self) -> Result<()> {
        if self.digits != 6 && self.digits != 8 {
            return Err(VaultError::Invalid("digits must be 6 or 8".into()).into());
        }
        if !(MIN_PERIOD_SECS..=MAX_PERIOD_SECS).contains(&self.period) {
            return Err(VaultError::Invalid(format!(
                "period must be {MIN_PERIOD_SECS} to {MAX_PERIOD_SECS} seconds"
            ))
            .into());
        }
        Ok(())
    }

    /// The RFC 6238 time step containing `unix_secs`.
    pub fn step(&self, unix_secs: u64) -> u64 {
        unix_secs / self.period
    }
}

/// RFC 4226 HOTP value for `counter` (dynamic truncation, zero-padded).
pub fn hotp(algorithm: TotpAlgorithm, key: &[u8], counter: u64, digits: u32) -> String {
    let digest = algorithm.mac(key, &counter.to_be_bytes());
    let offset = usize::from(digest[digest.len() - 1] & 0x0f);
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    let modulus = 10u64.pow(digits);
    format!(
        "{:0width$}",
        u64::from(binary) % modulus,
        width = digits as usize
    )
}

/// RFC 6238 TOTP value at `unix_secs`.
pub fn totp_at(params: &TotpParams, key: &[u8], unix_secs: u64) -> String {
    hotp(params.algorithm, key, params.step(unix_secs), params.digits)
}

fn unix_now() -> u64 {
    u64::try_from(now_millis() / 1000).unwrap_or(0)
}

// ── Base32 (RFC 4648, no padding on output) ──────────────────────────────

const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Encode bytes as unpadded upper-case Base32.
pub fn base32_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(5) * 8);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for byte in bytes {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(BASE32_ALPHABET[((buffer >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(BASE32_ALPHABET[((buffer << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// Decode Base32, ignoring case, spaces, hyphens, and `=` padding.
pub fn base32_decode(value: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(value.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for character in value.chars() {
        if matches!(character, ' ' | '-' | '=') {
            continue;
        }
        let upper = character.to_ascii_uppercase() as u8;
        let index = BASE32_ALPHABET.iter().position(|c| *c == upper)?;
        buffer = (buffer << 5) | index as u32;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

// ── otpauth:// URLs ──────────────────────────────────────────────────────

/// A parsed `otpauth://totp/...` enrollment URL. `Debug` redacts the seed.
#[derive(Clone, PartialEq, Eq)]
pub struct OtpauthKey {
    pub secret: Vec<u8>,
    pub issuer: String,
    pub account: String,
    pub params: TotpParams,
}

impl std::fmt::Debug for OtpauthKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OtpauthKey")
            .field("secret", &"<redacted>")
            .field("issuer", &self.issuer)
            .field("account", &self.account)
            .field("params", &self.params)
            .finish()
    }
}

impl OtpauthKey {
    /// Parse an `otpauth://totp/Issuer:account?secret=...` URL. HOTP URLs are
    /// refused: counter-based keys are not supported.
    pub fn parse(value: &str) -> Result<Self> {
        let invalid = |message: &str| VaultError::Invalid(message.to_owned());
        let url = url::Url::parse(value.trim()).map_err(|_| invalid("invalid otpauth URL"))?;
        if url.scheme() != "otpauth" {
            return Err(invalid("the URL scheme must be otpauth").into());
        }
        if url.host_str() != Some("totp") {
            return Err(invalid("only otpauth://totp/ keys are supported").into());
        }
        let label = urlencoding::decode(url.path().trim_start_matches('/'))
            .map_err(|_| invalid("invalid otpauth label"))?
            .into_owned();
        let (mut issuer, account) = match label.split_once(':') {
            Some((issuer, account)) => (issuer.trim().to_owned(), account.trim().to_owned()),
            None => (String::new(), label.trim().to_owned()),
        };
        let mut params = TotpParams::default();
        let mut secret = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "secret" => secret = Some(value.into_owned()),
                "issuer" => issuer = value.trim().to_owned(),
                "algorithm" => {
                    params.algorithm = TotpAlgorithm::parse(&value)
                        .ok_or_else(|| invalid("unsupported otpauth algorithm"))?;
                }
                "digits" => {
                    params.digits = value.parse().map_err(|_| invalid("invalid digits"))?;
                }
                "period" => {
                    params.period = value.parse().map_err(|_| invalid("invalid period"))?;
                }
                _ => {}
            }
        }
        let secret = secret.ok_or_else(|| invalid("the otpauth URL has no secret"))?;
        let secret = decode_seed(&secret, MIN_IMPORT_KEY_BYTES)?;
        params.validate()?;
        validate_label(&issuer, "issuer")?;
        validate_label(&account, "account")?;
        Ok(Self {
            secret,
            issuer,
            account,
            params,
        })
    }

    /// Render the enrollment URL (contains the seed).
    pub fn to_url(&self) -> String {
        let label = if self.issuer.is_empty() {
            urlencoding::encode(&self.account).into_owned()
        } else {
            format!(
                "{}:{}",
                urlencoding::encode(&self.issuer),
                urlencoding::encode(&self.account)
            )
        };
        let mut url = format!(
            "otpauth://totp/{label}?secret={}&algorithm={}&digits={}&period={}",
            base32_encode(&self.secret),
            self.params.algorithm.as_str(),
            self.params.digits,
            self.params.period
        );
        if !self.issuer.is_empty() {
            url.push_str("&issuer=");
            url.push_str(&urlencoding::encode(&self.issuer));
        }
        url
    }
}

fn decode_seed(value: &str, min_bytes: usize) -> Result<Vec<u8>> {
    let seed = base32_decode(value)
        .ok_or_else(|| VaultError::Invalid("the TOTP secret must be Base32".into()))?;
    if !(min_bytes..=MAX_KEY_BYTES).contains(&seed.len()) {
        return Err(VaultError::Invalid(format!(
            "the TOTP secret must decode to {min_bytes} to {MAX_KEY_BYTES} bytes"
        ))
        .into());
    }
    Ok(seed)
}

fn validate_label(value: &str, field: &str) -> Result<()> {
    if value.chars().count() > MAX_LABEL_LEN || value.chars().any(char::is_control) {
        return Err(VaultError::Invalid(format!(
            "{field} must be at most {MAX_LABEL_LEN} printable characters"
        ))
        .into());
    }
    Ok(())
}

/// The current code for a key/value secret holding a TOTP seed (an
/// `otpauth://totp/` URL or a Base32 seed with SHA1/6/30 defaults). `None`
/// when the value is not a usable seed, so `secret:NAME#totp` fails closed.
pub fn code_from_seed_value(value: &str, unix_secs: u64) -> Option<String> {
    let value = value.trim();
    let (secret, params) = if value.starts_with("otpauth://") {
        let key = OtpauthKey::parse(value).ok()?;
        (key.secret, key.params)
    } else {
        (
            decode_seed(value, MIN_IMPORT_KEY_BYTES).ok()?,
            TotpParams::default(),
        )
    };
    Some(totp_at(&params, &secret, unix_secs))
}

/// The current code for a `secret:NAME#totp` value at the current time.
pub fn current_code_from_seed_value(value: &str) -> Option<String> {
    code_from_seed_value(value, unix_now())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

// ── Storage ──────────────────────────────────────────────────────────────

/// Create the TOTP table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_totp_keys (
             name           TEXT PRIMARY KEY,
             issuer         TEXT NOT NULL DEFAULT '',
             account        TEXT NOT NULL DEFAULT '',
             algorithm      TEXT NOT NULL,
             digits         INTEGER NOT NULL,
             period         INTEGER NOT NULL,
             skew           INTEGER NOT NULL DEFAULT 1,
             generated      INTEGER NOT NULL DEFAULT 0,
             last_used_step INTEGER NOT NULL DEFAULT -1,
             nonce          BLOB NOT NULL,
             ciphertext     BLOB NOT NULL,
             key_version    INTEGER NOT NULL DEFAULT 0,
             created_at     INTEGER NOT NULL
         );",
    )
    .context("initializing TOTP schema")
}

/// Key metadata (never the seed).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpKeyInfo {
    pub name: String,
    pub issuer: String,
    pub account: String,
    pub algorithm: TotpAlgorithm,
    pub digits: u32,
    pub period: u64,
    pub skew: u32,
    /// Whether the seed was generated by the vault (versus imported).
    pub generated: bool,
    pub created_at: i64,
}

/// QR rendering returned once at generation time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QrFormat {
    Svg,
    Png,
}

/// Create request. Exactly one of `generate`, `url`, or `secret` supplies
/// the seed. Explicit parameters override those parsed from `url`. `Debug`
/// redacts `url` and `secret`, which both carry the seed.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCreateRequest {
    pub name: String,
    #[serde(default)]
    pub generate: bool,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub secret: Option<String>,
    #[serde(default)]
    pub issuer: Option<String>,
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub algorithm: Option<TotpAlgorithm>,
    #[serde(default)]
    pub digits: Option<u32>,
    #[serde(default)]
    pub period: Option<u64>,
    #[serde(default)]
    pub skew: Option<u32>,
    /// Seed size in bytes for generated keys (16–64, default 20).
    #[serde(default)]
    pub key_size: Option<usize>,
    /// Return the enrollment URL (and QR) for a generated key. Default true.
    #[serde(default)]
    pub exported: Option<bool>,
    #[serde(default)]
    pub qr_format: Option<QrFormat>,
    /// Pixels per module for a PNG QR code (1–16, default 6).
    #[serde(default)]
    pub qr_scale: Option<usize>,
}

impl std::fmt::Debug for TotpCreateRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let redact = |value: &Option<String>| value.as_ref().map(|_| "<redacted>");
        f.debug_struct("TotpCreateRequest")
            .field("name", &self.name)
            .field("generate", &self.generate)
            .field("url", &redact(&self.url))
            .field("secret", &redact(&self.secret))
            .field("issuer", &self.issuer)
            .field("account", &self.account)
            .field("algorithm", &self.algorithm)
            .field("digits", &self.digits)
            .field("period", &self.period)
            .field("skew", &self.skew)
            .field("key_size", &self.key_size)
            .field("exported", &self.exported)
            .field("qr_format", &self.qr_format)
            .field("qr_scale", &self.qr_scale)
            .finish()
    }
}

/// Create response. `url` and `qr` appear only for an exported generated key.
/// `Debug` redacts both, since they encode the seed.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCreated {
    pub key: TotpKeyInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// SVG markup, or a base64 PNG, per `qrFormat`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_format: Option<QrFormat>,
}

impl std::fmt::Debug for TotpCreated {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TotpCreated")
            .field("key", &self.key)
            .field("url", &self.url.as_ref().map(|_| "<redacted>"))
            .field("qr", &self.qr.as_ref().map(|_| "<redacted>"))
            .field("qr_format", &self.qr_format)
            .finish()
    }
}

/// A current code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub period: u64,
    /// Seconds until this code's time step ends.
    pub remaining_secs: u64,
}

struct Resolved {
    key: OtpauthKey,
    skew: u32,
    exported: bool,
    generated: bool,
}

fn resolve_request(request: &TotpCreateRequest) -> Result<Resolved> {
    let invalid = |message: &str| -> anyhow::Error { VaultError::Invalid(message.into()).into() };
    if !super::transit::is_valid_key_name(&request.name) {
        return Err(invalid("invalid TOTP key name"));
    }
    let sources = usize::from(request.generate)
        + usize::from(request.url.is_some())
        + usize::from(request.secret.is_some());
    if sources != 1 {
        return Err(invalid(
            "exactly one of `generate`, `url`, or `secret` is required",
        ));
    }
    let mut key = match (&request.url, &request.secret) {
        (Some(url), _) => OtpauthKey::parse(url)?,
        (None, Some(secret)) => OtpauthKey {
            secret: decode_seed(secret, MIN_IMPORT_KEY_BYTES)?,
            issuer: String::new(),
            account: String::new(),
            params: TotpParams::default(),
        },
        (None, None) => {
            let size = request.key_size.unwrap_or(DEFAULT_KEY_BYTES);
            if !(MIN_GENERATED_KEY_BYTES..=MAX_KEY_BYTES).contains(&size) {
                return Err(invalid("keySize must be 16 to 64 bytes"));
            }
            OtpauthKey {
                secret: random_bytes(size),
                issuer: String::new(),
                account: String::new(),
                params: TotpParams::default(),
            }
        }
    };
    if let Some(issuer) = &request.issuer {
        key.issuer = issuer.trim().to_owned();
    }
    if let Some(account) = &request.account {
        key.account = account.trim().to_owned();
    }
    if let Some(algorithm) = request.algorithm {
        key.params.algorithm = algorithm;
    }
    if let Some(digits) = request.digits {
        key.params.digits = digits;
    }
    if let Some(period) = request.period {
        key.params.period = period;
    }
    key.params.validate()?;
    validate_label(&key.issuer, "issuer")?;
    validate_label(&key.account, "account")?;
    if request.generate && (key.issuer.is_empty() || key.account.is_empty()) {
        return Err(invalid("a generated key needs an issuer and an account"));
    }
    let skew = request.skew.unwrap_or(1);
    if skew > MAX_SKEW {
        return Err(invalid("skew must be 0 to 2 steps"));
    }
    Ok(Resolved {
        key,
        skew,
        exported: request.generate && request.exported.unwrap_or(true),
        generated: request.generate,
    })
}

fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TotpKeyInfo> {
    let algorithm: String = row.get(3)?;
    Ok(TotpKeyInfo {
        name: row.get(0)?,
        issuer: row.get(1)?,
        account: row.get(2)?,
        algorithm: TotpAlgorithm::parse(&algorithm).unwrap_or_default(),
        digits: row.get(4)?,
        period: u64::try_from(row.get::<_, i64>(5)?).unwrap_or(30),
        skew: row.get(6)?,
        generated: row.get::<_, i64>(7)? != 0,
        created_at: row.get(8)?,
    })
}

const INFO_COLUMNS: &str =
    "name, issuer, account, algorithm, digits, period, skew, generated, created_at";

fn info_locked(conn: &Connection, name: &str) -> Result<TotpKeyInfo> {
    conn.query_row(
        &format!("SELECT {INFO_COLUMNS} FROM vault_totp_keys WHERE name = ?1"),
        params![name],
        info_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("TOTP key `{name}`")).into())
}

struct Sealed {
    info: TotpKeyInfo,
    seed: Vec<u8>,
    last_used_step: i64,
}

impl PluginSecretStore {
    fn totp_load(&self, conn: &Connection, name: &str) -> Result<Sealed> {
        let info = info_locked(conn, name)?;
        let (nonce, ciphertext, key_version, last_used_step): (Vec<u8>, Vec<u8>, u32, i64) = conn
            .query_row(
            "SELECT nonce, ciphertext, key_version, last_used_step FROM vault_totp_keys
                 WHERE name = ?1",
            params![name],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;
        let seed = self.open_row(key_version, &nonce, &ciphertext)?;
        Ok(Sealed {
            info,
            seed,
            last_used_step,
        })
    }

    /// Create (generate or import) a TOTP key.
    pub async fn totp_create(
        &self,
        request: &TotpCreateRequest,
        actor: &AuditActor,
    ) -> Result<TotpCreated> {
        let resolved = resolve_request(request)?;
        // Render the enrollment URL and QR before anything is stored: a key
        // whose export fails must not remain behind with an unreachable seed.
        let export = if resolved.exported {
            let url = resolved.key.to_url();
            let qr = match request.qr_format {
                None => None,
                Some(format) => {
                    let code = qr::QrCode::encode(url.as_bytes()).ok_or_else(|| {
                        VaultError::Invalid("the enrollment URL is too long for a QR code".into())
                    })?;
                    Some(match format {
                        QrFormat::Svg => code.to_svg(),
                        QrFormat::Png => base64::engine::general_purpose::STANDARD
                            .encode(code.to_png(request.qr_scale.unwrap_or(6))?),
                    })
                }
            };
            Some((url, qr))
        } else {
            None
        };
        let (key_version, nonce, ciphertext) = self.seal_row(&resolved.key.secret)?;
        let params = resolved.key.params;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_totp_keys
                (name, issuer, account, algorithm, digits, period, skew, generated,
                 nonce, ciphertext, key_version, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                request.name,
                resolved.key.issuer,
                resolved.key.account,
                params.algorithm.as_str(),
                params.digits,
                params.period as i64,
                resolved.skew,
                i64::from(resolved.generated),
                nonce,
                ciphertext,
                key_version,
                now_millis()
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("TOTP key `{}` exists", request.name)).into());
        }
        let permitted = self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "totp.create", "ok").details(serde_json::json!({
                "key": request.name,
                "generated": resolved.generated,
                "exported": resolved.exported,
            })),
        );
        if !permitted && export.is_some() {
            // The otpauth URL and QR carry the seed; withhold them and drop
            // the key so the create can be retried once auditing works.
            conn.execute(
                "DELETE FROM vault_totp_keys WHERE name = ?1",
                params![request.name],
            )?;
            return Err(VaultError::AuditUnavailable.into());
        }
        let info = info_locked(&conn, &request.name)?;
        drop(conn);
        Ok(match export {
            None => TotpCreated {
                key: info,
                url: None,
                qr: None,
                qr_format: None,
            },
            Some((url, qr)) => TotpCreated {
                key: info,
                url: Some(url),
                qr,
                qr_format: request.qr_format,
            },
        })
    }

    /// Every TOTP key (metadata only).
    pub async fn totp_list(&self) -> Result<Vec<TotpKeyInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {INFO_COLUMNS} FROM vault_totp_keys ORDER BY name"
        ))?;
        let rows = stmt.query_map([], info_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One key's metadata.
    pub async fn totp_info(&self, name: &str) -> Result<TotpKeyInfo> {
        let conn = self.conn.lock().await;
        info_locked(&conn, name)
    }

    /// Delete a key and its sealed seed.
    pub async fn totp_delete(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute("DELETE FROM vault_totp_keys WHERE name = ?1", params![name])?;
        if deleted == 0 {
            return Err(VaultError::NotFound(format!("TOTP key `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "totp.delete", "ok")
                .details(serde_json::json!({ "key": name })),
        );
        Ok(())
    }

    /// The current code for a key. Audited without the code.
    pub async fn totp_code(&self, name: &str, actor: &AuditActor) -> Result<TotpCode> {
        self.totp_code_at(name, unix_now(), actor).await
    }

    async fn totp_code_at(&self, name: &str, now: u64, actor: &AuditActor) -> Result<TotpCode> {
        let conn = self.conn.lock().await;
        let sealed = self.totp_load(&conn, name)?;
        let params = TotpParams {
            algorithm: sealed.info.algorithm,
            digits: sealed.info.digits,
            period: sealed.info.period,
        };
        let code = totp_at(&params, &sealed.seed, now);
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "totp.code", "ok").details(serde_json::json!({ "key": name })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(TotpCode {
            code,
            period: params.period,
            remaining_secs: params.period - now % params.period,
        })
    }

    /// Validate a code within the key's skew window. A step at or before the
    /// last accepted step is a replay and fails.
    pub async fn totp_validate(&self, name: &str, code: &str, actor: &AuditActor) -> Result<bool> {
        self.totp_validate_at(name, code, unix_now(), actor).await
    }

    async fn totp_validate_at(
        &self,
        name: &str,
        code: &str,
        now: u64,
        actor: &AuditActor,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let sealed = self.totp_load(&tx, name)?;
        let params = TotpParams {
            algorithm: sealed.info.algorithm,
            digits: sealed.info.digits,
            period: sealed.info.period,
        };
        let code = code.trim();
        let well_formed =
            code.len() == params.digits as usize && code.bytes().all(|b| b.is_ascii_digit());
        let current = params.step(now);
        let skew = u64::from(sealed.info.skew);
        let matched = if well_formed {
            (current.saturating_sub(skew)..=current + skew).find(|&step| {
                let expected = hotp(params.algorithm, &sealed.seed, step, params.digits);
                constant_time_eq(expected.as_bytes(), code.as_bytes())
            })
        } else {
            None
        };
        let outcome = match matched {
            Some(step) if i64::try_from(step).unwrap_or(i64::MAX) <= sealed.last_used_step => {
                "replayed"
            }
            Some(step) => {
                tx.execute(
                    "UPDATE vault_totp_keys SET last_used_step = ?1 WHERE name = ?2",
                    params![i64::try_from(step).unwrap_or(i64::MAX), name],
                )?;
                "ok"
            }
            None => "invalid",
        };
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "totp.validate", outcome)
                .details(serde_json::json!({ "key": name })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(outcome == "ok")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> AuditActor {
        AuditActor::new("operator", None)
    }

    const SEED_SHA1: &[u8] = b"12345678901234567890";
    const SEED_SHA256: &[u8] = b"12345678901234567890123456789012";
    const SEED_SHA512: &[u8] = b"1234567890123456789012345678901234567890123456789012345678901234";

    #[test]
    fn rfc4226_hotp_vectors() {
        let expected = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ];
        for (counter, code) in expected.iter().enumerate() {
            assert_eq!(
                hotp(TotpAlgorithm::Sha1, SEED_SHA1, counter as u64, 6),
                *code
            );
        }
    }

    #[test]
    fn rfc6238_appendix_b_vectors() {
        let rows: [(u64, &str, &str, &str); 6] = [
            (59, "94287082", "46119246", "90693936"),
            (1_111_111_109, "07081804", "68084774", "25091201"),
            (1_111_111_111, "14050471", "67062674", "99943326"),
            (1_234_567_890, "89005924", "91819424", "93441116"),
            (2_000_000_000, "69279037", "90698825", "38618901"),
            (20_000_000_000, "65353130", "77737706", "47863826"),
        ];
        let params = |algorithm| TotpParams {
            algorithm,
            digits: 8,
            period: 30,
        };
        for (time, sha1, sha256, sha512) in rows {
            assert_eq!(totp_at(&params(TotpAlgorithm::Sha1), SEED_SHA1, time), sha1);
            assert_eq!(
                totp_at(&params(TotpAlgorithm::Sha256), SEED_SHA256, time),
                sha256
            );
            assert_eq!(
                totp_at(&params(TotpAlgorithm::Sha512), SEED_SHA512, time),
                sha512
            );
        }
    }

    #[test]
    fn base32_round_trips_and_rejects_garbage() {
        assert_eq!(base32_encode(b"Hello!\xde\xad\xbe\xef"), "JBSWY3DPEHPK3PXP");
        assert_eq!(
            base32_decode("jbsw y3dp-ehpk3pxp====").unwrap(),
            b"Hello!\xde\xad\xbe\xef"
        );
        for len in 0..12 {
            let bytes = random_bytes(len);
            assert_eq!(base32_decode(&base32_encode(&bytes)).unwrap(), bytes);
        }
        assert!(base32_decode("ABC1").is_none());
    }

    #[test]
    fn otpauth_urls_parse_and_render() {
        let key = OtpauthKey::parse(
            "otpauth://totp/ACME%20Co:alice@example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ\
             &issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60",
        )
        .unwrap();
        assert_eq!(key.secret, SEED_SHA1);
        assert_eq!(key.issuer, "ACME Co");
        assert_eq!(key.account, "alice@example.com");
        assert_eq!(
            key.params,
            TotpParams {
                algorithm: TotpAlgorithm::Sha256,
                digits: 8,
                period: 60
            }
        );
        assert_eq!(OtpauthKey::parse(&key.to_url()).unwrap(), key);
        for bad in [
            "otpauth://hotp/x?secret=GEZDGNBVGY3TQOJQ&counter=1",
            "https://totp/x?secret=GEZDGNBVGY3TQOJQ",
            "otpauth://totp/x",
            "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQ&digits=7",
            "otpauth://totp/x?secret=GEZA",
        ] {
            assert!(OtpauthKey::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn seed_values_resolve_to_codes_or_nothing() {
        // "12345678901234567890" in Base32.
        let seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(code_from_seed_value(seed, 59).as_deref(), Some("287082"));
        let url = format!("otpauth://totp/x?secret={seed}&digits=8");
        assert_eq!(code_from_seed_value(&url, 59).as_deref(), Some("94287082"));
        assert_eq!(code_from_seed_value("not a seed!", 59), None);
        assert_eq!(code_from_seed_value("GEZA", 59), None);
    }

    #[tokio::test]
    async fn generated_keys_export_once_and_never_return_the_seed() {
        let store = PluginSecretStore::in_memory().unwrap();
        let created = store
            .totp_create(
                &TotpCreateRequest {
                    name: "github".into(),
                    generate: true,
                    issuer: Some("GitHub".into()),
                    account: Some("bot@example.com".into()),
                    algorithm: Some(TotpAlgorithm::Sha512),
                    digits: Some(8),
                    qr_format: Some(QrFormat::Svg),
                    ..Default::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        let url = created.url.clone().unwrap();
        assert!(url.starts_with("otpauth://totp/GitHub:bot%40example.com?secret="));
        assert!(created.qr.unwrap().starts_with("<svg"));
        let exported = OtpauthKey::parse(&url).unwrap();
        assert_eq!(exported.secret.len(), DEFAULT_KEY_BYTES);

        let code = store.totp_code("github", &actor()).await.unwrap();
        assert_eq!(code.code.len(), 8);
        assert_eq!(
            code.code,
            totp_at(&exported.params, &exported.secret, unix_now())
        );
        let listed = serde_json::to_string(&store.totp_list().await.unwrap()).unwrap();
        assert!(!listed.contains(&base32_encode(&exported.secret)));

        // Not exported: no URL, no QR.
        let hidden = store
            .totp_create(
                &TotpCreateRequest {
                    name: "quiet".into(),
                    generate: true,
                    issuer: Some("X".into()),
                    account: Some("y".into()),
                    exported: Some(false),
                    qr_format: Some(QrFormat::Png),
                    ..Default::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        assert!(hidden.url.is_none() && hidden.qr.is_none());
    }

    #[tokio::test]
    async fn a_qr_that_does_not_fit_stores_nothing() {
        let store = PluginSecretStore::in_memory().unwrap();
        // `@` and `é` percent-encode to 3 and 6 bytes and the issuer appears
        // twice, so the URL exceeds the largest supported QR version.
        let request = TotpCreateRequest {
            name: "long".into(),
            generate: true,
            issuer: Some("@".repeat(MAX_LABEL_LEN)),
            account: Some("é".repeat(MAX_LABEL_LEN)),
            qr_format: Some(QrFormat::Png),
            ..Default::default()
        };
        assert!(store.totp_create(&request, &actor()).await.is_err());
        assert!(store.totp_list().await.unwrap().is_empty());
        assert!(store.totp_info("long").await.is_err());
        // The name is still free, and without a QR the same key is created.
        let created = store
            .totp_create(
                &TotpCreateRequest {
                    qr_format: None,
                    ..request
                },
                &actor(),
            )
            .await
            .unwrap();
        assert!(created.url.is_some() && created.qr.is_none());
    }

    #[test]
    fn debug_output_redacts_seeds() {
        let seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let url = format!("otpauth://totp/x?secret={seed}");
        let request = TotpCreateRequest {
            name: "a".into(),
            secret: Some(seed.into()),
            url: Some(url.clone()),
            ..Default::default()
        };
        let key = OtpauthKey::parse(&url).unwrap();
        for rendered in [format!("{request:?}"), format!("{key:?}")] {
            assert!(!rendered.contains(seed), "{rendered}");
            assert!(!rendered.contains("49, 50, 51"), "{rendered}");
        }
    }

    #[tokio::test]
    async fn create_rejects_bad_requests() {
        let store = PluginSecretStore::in_memory().unwrap();
        let bad = [
            TotpCreateRequest {
                name: "a".into(),
                ..Default::default()
            },
            TotpCreateRequest {
                name: "a".into(),
                generate: true,
                secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
                ..Default::default()
            },
            TotpCreateRequest {
                name: "a".into(),
                generate: true,
                issuer: Some("missing account".into()),
                ..Default::default()
            },
            TotpCreateRequest {
                name: "Bad Name".into(),
                secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
                ..Default::default()
            },
            TotpCreateRequest {
                name: "a".into(),
                secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
                skew: Some(5),
                ..Default::default()
            },
        ];
        for request in &bad {
            assert!(
                store.totp_create(request, &actor()).await.is_err(),
                "{request:?}"
            );
        }
        let import = TotpCreateRequest {
            name: "a".into(),
            secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
            ..Default::default()
        };
        let created = store.totp_create(&import, &actor()).await.unwrap();
        assert!(created.url.is_none() && !created.key.generated);
        assert!(store.totp_create(&import, &actor()).await.is_err());
    }

    #[tokio::test]
    async fn validation_accepts_the_skew_window_once() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .totp_create(
                &TotpCreateRequest {
                    name: "rfc".into(),
                    secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
                    digits: Some(8),
                    ..Default::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        let now = 1_111_111_111;
        assert_eq!(
            store.totp_code_at("rfc", now, &actor()).await.unwrap(),
            TotpCode {
                code: "14050471".into(),
                period: 30,
                remaining_secs: 29,
            }
        );
        // The previous step (07081804 at 1111111109) is inside skew 1.
        assert!(store
            .totp_validate_at("rfc", "07081804", now, &actor())
            .await
            .unwrap());
        // Reusing the same code is a replay.
        assert!(!store
            .totp_validate_at("rfc", "07081804", now, &actor())
            .await
            .unwrap());
        // The current step is later, so it is still accepted once.
        assert!(store
            .totp_validate_at("rfc", "14050471", now, &actor())
            .await
            .unwrap());
        assert!(!store
            .totp_validate_at("rfc", "14050471", now, &actor())
            .await
            .unwrap());
        // Wrong, malformed, and far-future codes fail.
        for code in ["00000000", "1405047", "abcdefgh", "89005924"] {
            assert!(!store
                .totp_validate_at("rfc", code, now + 30, &actor())
                .await
                .unwrap());
        }
        assert!(store
            .totp_validate_at("missing", "123456", now, &actor())
            .await
            .is_err());

        store.totp_delete("rfc", &actor()).await.unwrap();
        assert!(store.totp_code("rfc", &actor()).await.is_err());
        assert!(store.totp_delete("rfc", &actor()).await.is_err());
    }

    #[tokio::test]
    async fn kv_seed_references_resolve_to_the_current_code() {
        use crate::plugin_secrets::{SecretResolutionContext, SecretScope};
        let store = PluginSecretStore::in_memory().unwrap();
        let seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        store
            .set_vault_secret(SecretScope::Node, "node-1", None, "GH_TOTP", seed)
            .await
            .unwrap();
        store
            .set_vault_secret(SecretScope::Node, "node-1", None, "PLAIN", "hunter2")
            .await
            .unwrap();
        let context = SecretResolutionContext::node_only("node-1", Vec::new());
        let resolved = store
            .resolve_vault_template("X-OTP secret:GH_TOTP#totp", &context)
            .await
            .unwrap()
            .unwrap();
        let code = resolved.strip_prefix("X-OTP ").unwrap();
        // The code may straddle a step boundary between resolve and check.
        let now = unix_now();
        assert!(
            [now, now.saturating_sub(5)]
                .iter()
                .any(|at| code_from_seed_value(seed, *at).as_deref() == Some(code)),
            "{code}"
        );
        assert!(!resolved.contains(seed));
        // A value that is not a seed, or a missing value, is absent.
        assert_eq!(
            store
                .resolve_vault_template("secret:PLAIN#totp", &context)
                .await
                .unwrap(),
            None
        );
        assert_eq!(
            store
                .resolve_vault_secret("MISSING#totp", &context)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn a_sealed_vault_produces_no_codes() {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .totp_create(
                &TotpCreateRequest {
                    name: "k".into(),
                    secret: Some("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".into()),
                    ..Default::default()
                },
                &actor(),
            )
            .await
            .unwrap();
        store.keyring.seal();
        assert!(store.totp_code("k", &actor()).await.is_err());
    }
}
