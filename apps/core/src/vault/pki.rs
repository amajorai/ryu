//! PKI engine: an internal X.509 certificate authority.
//!
//! An issuer is a self-signed root CA whose private key (PKCS#8, ECDSA P-256)
//! is sealed with the vault keyring. Roles bound to an issuer decide which DNS
//! names and IP SANs a certificate may carry, its TTL bounds, and whether it is
//! for servers, clients, or both. `issue` generates a key pair and returns the
//! private key exactly once; `sign` signs a caller's CSR without ever seeing
//! the private key. Every issued serial is recorded so `revoke` and the CRL
//! (`crl`) work, as with Vault's PKI secrets engine.
//!
//! Besides self-signed roots, an issuer can be an intermediate: Core
//! generates its key and returns a CSR (`generate_intermediate`), an external
//! or Ryu root signs it (`sign_intermediate` signs a CSR as a CA with path
//! length 0), and `set_signed` installs the certificate after checking it
//! matches the pending key. An existing CA certificate and key can also be
//! imported. `tidy` (run daily by the scheduler) forgets certificates expired
//! for longer than a safety buffer.

use std::net::IpAddr;

use anyhow::{anyhow, bail, Context, Result};
use rcgen::{
    BasicConstraints, CertificateParams, CertificateRevocationListParams,
    CertificateSigningRequestParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyIdMethod, KeyPair, KeyUsagePurpose, RevokedCertParams, SanType, SerialNumber,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, random_bytes, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// Longest root lifetime (10 years) and leaf lifetime (1 year).
pub const MAX_ROOT_TTL_SECS: i64 = 10 * 365 * 24 * 3600;
pub const MAX_LEAF_TTL_SECS: i64 = 365 * 24 * 3600;
const CRL_VALIDITY_SECS: i64 = 72 * 3600;
const MAX_SANS: usize = 50;

/// An issuer projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuerInfo {
    pub name: String,
    pub common_name: String,
    /// Empty while an intermediate waits for its signed certificate.
    pub certificate: String,
    pub not_after: i64,
    /// `root`, `intermediate`, or `imported`.
    pub kind: String,
    /// PEM certificates above this issuer, nearest first (empty for roots).
    pub ca_chain: Vec<String>,
    /// The pending CSR of an intermediate awaiting `set-signed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csr: Option<String>,
}

/// A PKI role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PkiRole {
    pub name: String,
    pub issuer: String,
    /// Allowed DNS names: exact (`api.example.com`) or a single-label
    /// wildcard pattern (`*.example.com`).
    pub allowed_domains: Vec<String>,
    #[serde(default)]
    pub allow_ip_sans: bool,
    pub default_ttl_secs: i64,
    pub max_ttl_secs: i64,
    #[serde(default = "yes")]
    pub server_flag: bool,
    #[serde(default)]
    pub client_flag: bool,
}

fn yes() -> bool {
    true
}

/// A newly issued certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuedCertificate {
    pub certificate: String,
    /// Present only for `issue` (never stored).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    pub issuing_ca: String,
    /// The issuing CA followed by its own chain, nearest first.
    pub ca_chain: Vec<String>,
    pub serial: String,
    pub not_after: i64,
}

/// A recorded certificate (no key).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertRecord {
    pub serial: String,
    pub issuer: String,
    pub common_name: String,
    pub not_after: i64,
    pub revoked_at: Option<i64>,
}

/// Create the PKI tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_pki_issuers (
             name        TEXT PRIMARY KEY,
             common_name TEXT NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             certificate TEXT NOT NULL,
             not_after   INTEGER NOT NULL,
             crl_number  INTEGER NOT NULL DEFAULT 0,
             created_at  INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_pki_roles (
             name       TEXT PRIMARY KEY,
             definition TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_pki_certs (
             serial      TEXT PRIMARY KEY,
             issuer      TEXT NOT NULL,
             common_name TEXT NOT NULL,
             not_after   INTEGER NOT NULL,
             revoked_at  INTEGER,
             created_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_vault_pki_certs_issuer ON vault_pki_certs(issuer, revoked_at);",
    )
    .context("initializing pki schema")?;
    super::ensure_columns(
        conn,
        "vault_pki_issuers",
        &[
            ("kind", "TEXT NOT NULL DEFAULT 'root'"),
            ("ca_chain", "TEXT NOT NULL DEFAULT ''"),
            ("csr", "TEXT"),
        ],
    )
    .context("upgrading pki schema")
}

/// Longest intermediate lifetime (5 years by default, at most the root's).
pub const DEFAULT_INTERMEDIATE_TTL_SECS: i64 = 5 * 365 * 24 * 3600;
/// Default `tidy` safety buffer: certificates expired for 72 hours.
pub const DEFAULT_TIDY_BUFFER_SECS: i64 = 72 * 3600;
const MAX_CHAIN_CERTS: usize = 8;

fn der_to_pem(label: &str, der: &[u8]) -> String {
    use base64::Engine as _;
    let body = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for line in body.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(line).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// rcgen's own `pem()` ends lines with CRLF on Windows; every PEM Core
/// returns goes through [`der_to_pem`] instead, so output is LF everywhere.
fn cert_pem(certificate: &rcgen::Certificate) -> String {
    der_to_pem("CERTIFICATE", certificate.der())
}

/// A stored PEM with LF line endings (rows written on Windows before PEM
/// output was normalized hold CRLF).
fn lf_pem(pem: String) -> String {
    if pem.contains('\r') {
        pem.replace("\r\n", "\n")
    } else {
        pem
    }
}

/// Every certificate in a PEM bundle, as DER.
fn pem_certificates(bundle: &str) -> Result<Vec<Vec<u8>>> {
    let mut out = Vec::new();
    for block in x509_parser::pem::Pem::iter_from_buffer(bundle.as_bytes()) {
        let block =
            block.map_err(|_| VaultError::Invalid("certificate PEM is malformed".into()))?;
        if block.label != "CERTIFICATE" {
            return Err(VaultError::Invalid(format!(
                "expected CERTIFICATE PEM blocks, found `{}`",
                block.label
            ))
            .into());
        }
        out.push(block.contents);
    }
    Ok(out)
}

/// What Core needs from a CA certificate.
struct CaCertificate {
    pem: String,
    common_name: String,
    not_after: i64,
    spki: Vec<u8>,
}

/// Parse and check a CA certificate: a single CERTIFICATE block, a CA
/// basic constraint, and validity covering now.
fn parse_ca_certificate(pem: &str) -> Result<CaCertificate> {
    let mut blocks = pem_certificates(pem)?;
    if blocks.len() != 1 {
        return Err(VaultError::Invalid("provide exactly one CA certificate".into()).into());
    }
    let der = blocks.remove(0);
    let (_, cert) = x509_parser::parse_x509_certificate(&der)
        .map_err(|_| VaultError::Invalid("certificate is not valid X.509".into()))?;
    let is_ca = cert
        .basic_constraints()
        .ok()
        .flatten()
        .is_some_and(|constraints| constraints.value.ca);
    if !is_ca {
        return Err(VaultError::Invalid("certificate is not a CA certificate".into()).into());
    }
    if !cert.validity().is_valid() {
        return Err(VaultError::Invalid("CA certificate is not currently valid".into()).into());
    }
    let common_name = cert
        .subject()
        .iter_common_name()
        .next()
        .and_then(|cn| cn.as_str().ok())
        .unwrap_or_default()
        .to_owned();
    Ok(CaCertificate {
        pem: der_to_pem("CERTIFICATE", &der),
        common_name,
        not_after: cert.validity().not_after.timestamp() * 1000,
        spki: cert.public_key().raw.to_vec(),
    })
}

/// Validate a chain bundle and check that `leaf_pem` is signed by its first
/// certificate. Returns normalized PEMs.
fn parse_chain(leaf_pem: &str, chain: Option<&str>) -> Result<Vec<String>> {
    let Some(chain) = chain.map(str::trim).filter(|chain| !chain.is_empty()) else {
        return Ok(Vec::new());
    };
    let blocks = pem_certificates(chain)?;
    if blocks.is_empty() || blocks.len() > MAX_CHAIN_CERTS {
        return Err(VaultError::Invalid(format!(
            "caChain must hold 1 to {MAX_CHAIN_CERTS} certificates"
        ))
        .into());
    }
    let leaf_der = pem_certificates(leaf_pem)?.remove(0);
    let (_, leaf) = x509_parser::parse_x509_certificate(&leaf_der)
        .map_err(|_| VaultError::Invalid("certificate is not valid X.509".into()))?;
    let (_, parent) = x509_parser::parse_x509_certificate(&blocks[0])
        .map_err(|_| VaultError::Invalid("caChain holds invalid X.509".into()))?;
    if leaf.verify_signature(Some(parent.public_key())).is_err() {
        return Err(VaultError::Invalid(
            "the certificate is not signed by the first caChain certificate".into(),
        )
        .into());
    }
    Ok(blocks
        .iter()
        .map(|der| der_to_pem("CERTIFICATE", der))
        .collect())
}

fn split_chain(stored: &str) -> Vec<String> {
    pem_certificates(stored)
        .unwrap_or_default()
        .iter()
        .map(|der| der_to_pem("CERTIFICATE", der))
        .collect()
}

fn pki_error(error: rcgen::Error) -> anyhow::Error {
    anyhow!("certificate generation failed: {error}")
}

fn datetime(millis: i64) -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(millis / 1000).unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn fresh_serial() -> (SerialNumber, String) {
    let mut bytes = random_bytes(16);
    bytes[0] &= 0x7f; // positive INTEGER
    bytes[0] |= 0x01; // no leading zero byte, keeps the encoding at 16 octets
    (SerialNumber::from_slice(&bytes), hex::encode(&bytes))
}

fn ca_params(
    common_name: &str,
    not_before: OffsetDateTime,
    not_after: OffsetDateTime,
) -> CertificateParams {
    let mut params = CertificateParams::default();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, common_name);
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params.not_before = not_before;
    params.not_after = not_after;
    params.key_identifier_method = KeyIdMethod::Sha256;
    params
}

fn domain_allowed(patterns: &[String], name: &str) -> bool {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    patterns.iter().any(|pattern| {
        let pattern = pattern.to_ascii_lowercase();
        match pattern.strip_prefix("*.") {
            Some(suffix) => name
                .strip_suffix(suffix)
                .and_then(|head| head.strip_suffix('.'))
                .is_some_and(|label| !label.is_empty() && !label.contains('.')),
            None => pattern == name,
        }
    })
}

fn validate_dns_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'*')
        })
}

fn validate_role(role: &PkiRole) -> Result<()> {
    if !super::transit::is_valid_key_name(&role.name)
        || !super::transit::is_valid_key_name(&role.issuer)
    {
        bail!("role and issuer names must match ^[a-z0-9][a-z0-9_-]{{0,63}}$");
    }
    if role.allowed_domains.is_empty() && !role.allow_ip_sans {
        bail!("a role must allow at least one domain pattern or IP SANs");
    }
    for domain in &role.allowed_domains {
        if !validate_dns_name(domain) || (domain.contains('*') && !domain.starts_with("*.")) {
            bail!("invalid allowed domain `{domain}`");
        }
    }
    if role.default_ttl_secs < 60
        || role.max_ttl_secs < role.default_ttl_secs
        || role.max_ttl_secs > MAX_LEAF_TTL_SECS
    {
        bail!("TTLs must satisfy 60 <= default <= max <= {MAX_LEAF_TTL_SECS}");
    }
    if !role.server_flag && !role.client_flag {
        bail!("a role must allow server or client usage");
    }
    Ok(())
}

struct LoadedIssuer {
    key: KeyPair,
    certificate: String,
    ca_chain: Vec<String>,
    not_after: i64,
}

impl LoadedIssuer {
    /// An rcgen issuer whose subject and key identifier come from the stored
    /// certificate, so roots, intermediates, and imports all sign correctly.
    fn signer(&self) -> Result<Issuer<'static, &KeyPair>> {
        Issuer::from_ca_cert_pem(&self.certificate, &self.key).map_err(pki_error)
    }

    /// The issuing CA and its chain, nearest first.
    fn chain(&self) -> Vec<String> {
        std::iter::once(self.certificate.clone())
            .chain(self.ca_chain.iter().cloned())
            .collect()
    }
}

impl PluginSecretStore {
    fn load_issuer(&self, conn: &Connection, name: &str) -> Result<LoadedIssuer> {
        #[allow(clippy::type_complexity)]
        let (nonce, ciphertext, key_version, certificate, not_after, ca_chain, csr): (
            Vec<u8>,
            Vec<u8>,
            u32,
            String,
            i64,
            String,
            Option<String>,
        ) = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version, certificate, not_after, ca_chain, csr
                 FROM vault_pki_issuers WHERE name = ?1",
                params![name],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                },
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("PKI issuer `{name}`")))?;
        if csr.is_some() {
            return Err(VaultError::Invalid(format!(
                "PKI issuer `{name}` is waiting for its signed certificate (set-signed)"
            ))
            .into());
        }
        let der = self.open_row(key_version, &nonce, &ciphertext)?;
        let key = KeyPair::try_from(der.as_slice()).map_err(pki_error)?;
        Ok(LoadedIssuer {
            key,
            certificate: lf_pem(certificate),
            ca_chain: split_chain(&ca_chain),
            not_after,
        })
    }

    fn record_cert(
        &self,
        conn: &Connection,
        serial: &str,
        issuer: &str,
        common_name: &str,
        not_after: i64,
    ) -> Result<()> {
        conn.execute(
            "INSERT INTO vault_pki_certs (serial, issuer, common_name, not_after, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![serial, issuer, common_name, not_after, now_millis()],
        )?;
        Ok(())
    }
}

fn issuer_info_locked(conn: &Connection, name: &str) -> Result<IssuerInfo> {
    conn.query_row(
        "SELECT name, common_name, certificate, not_after, kind, ca_chain, csr
         FROM vault_pki_issuers WHERE name = ?1",
        params![name],
        |row| {
            Ok(IssuerInfo {
                name: row.get(0)?,
                common_name: row.get(1)?,
                certificate: lf_pem(row.get(2)?),
                not_after: row.get(3)?,
                kind: row.get(4)?,
                ca_chain: split_chain(&row.get::<_, String>(5)?),
                csr: row.get::<_, Option<String>>(6)?.map(lf_pem),
            })
        },
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("PKI issuer `{name}`")).into())
}

mod certs;
mod issuers;

#[cfg(test)]
mod tests;
