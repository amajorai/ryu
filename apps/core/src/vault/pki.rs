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
            certificate,
            ca_chain: split_chain(&ca_chain),
            not_after,
        })
    }

    /// Generate a self-signed root CA.
    pub async fn pki_create_root(
        &self,
        name: &str,
        common_name: &str,
        ttl_secs: i64,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        if !super::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid issuer name".into()).into());
        }
        let common_name = common_name.trim();
        if common_name.is_empty() || common_name.len() > 64 {
            return Err(VaultError::Invalid("commonName must be 1-64 characters".into()).into());
        }
        if !(3600..=MAX_ROOT_TTL_SECS).contains(&ttl_secs) {
            return Err(
                VaultError::Invalid("root TTL must be between 1 hour and 10 years".into()).into(),
            );
        }
        let key = KeyPair::generate().map_err(pki_error)?;
        let now = OffsetDateTime::now_utc();
        let not_after = now + Duration::seconds(ttl_secs);
        let mut params = ca_params(common_name, now - Duration::minutes(1), not_after);
        params.serial_number = Some(fresh_serial().0);
        let certificate = params.self_signed(&key).map_err(pki_error)?.pem();
        let (key_version, nonce, ciphertext) = self.seal_row(&key.serialize_der())?;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_pki_issuers
                (name, common_name, nonce, ciphertext, key_version, certificate, not_after, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                name,
                common_name,
                nonce,
                ciphertext,
                key_version,
                certificate,
                not_after.unix_timestamp() * 1000,
                now_millis()
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("PKI issuer `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.root.create", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": common_name })),
        );
        Ok(IssuerInfo {
            name: name.to_owned(),
            common_name: common_name.to_owned(),
            certificate,
            not_after: not_after.unix_timestamp() * 1000,
            kind: "root".into(),
            ca_chain: Vec::new(),
            csr: None,
        })
    }

    pub async fn pki_list_issuers(&self) -> Result<Vec<IssuerInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT name FROM vault_pki_issuers ORDER BY name")?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names
            .iter()
            .map(|name| issuer_info_locked(&conn, name))
            .collect()
    }

    /// Generate an intermediate CA key and return its CSR. The issuer stays
    /// pending (unusable) until [`Self::pki_set_signed`]. Calling it again for
    /// a still-pending issuer replaces the key and CSR.
    pub async fn pki_generate_intermediate(
        &self,
        name: &str,
        common_name: &str,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        if !super::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid issuer name".into()).into());
        }
        let common_name = common_name.trim();
        if common_name.is_empty() || common_name.len() > 64 {
            return Err(VaultError::Invalid("commonName must be 1-64 characters".into()).into());
        }
        let key = KeyPair::generate().map_err(pki_error)?;
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, common_name);
        params.distinguished_name = dn;
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let csr = params
            .serialize_request(&key)
            .map_err(pki_error)?
            .pem()
            .map_err(pki_error)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&key.serialize_der())?;
        let conn = self.conn.lock().await;
        let pending: Option<Option<String>> = conn
            .query_row(
                "SELECT csr FROM vault_pki_issuers WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?;
        if matches!(pending, Some(None)) {
            return Err(VaultError::Conflict(format!("PKI issuer `{name}` exists")).into());
        }
        conn.execute(
            "INSERT INTO vault_pki_issuers
                (name, common_name, nonce, ciphertext, key_version, certificate, not_after,
                 created_at, kind, ca_chain, csr)
             VALUES (?1, ?2, ?3, ?4, ?5, '', 0, ?6, 'intermediate', '', ?7)
             ON CONFLICT(name) DO UPDATE SET common_name = excluded.common_name,
                 nonce = excluded.nonce, ciphertext = excluded.ciphertext,
                 key_version = excluded.key_version, csr = excluded.csr",
            params![
                name,
                common_name,
                nonce,
                ciphertext,
                key_version,
                now_millis(),
                csr
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.intermediate.generate", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": common_name })),
        );
        issuer_info_locked(&conn, name)
    }

    /// Install the signed certificate of a pending intermediate. It must be a
    /// currently valid CA certificate for the pending key; `ca_chain` (PEM,
    /// nearest first) must start with its signer when given.
    pub async fn pki_set_signed(
        &self,
        name: &str,
        certificate_pem: &str,
        ca_chain: Option<&str>,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        let ca = parse_ca_certificate(certificate_pem)?;
        let chain = parse_chain(&ca.pem, ca_chain)?;
        let conn = self.conn.lock().await;
        let row: Option<(Vec<u8>, Vec<u8>, u32, Option<String>)> = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version, csr FROM vault_pki_issuers WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let (nonce, ciphertext, key_version, csr) =
            row.ok_or_else(|| VaultError::NotFound(format!("PKI issuer `{name}`")))?;
        if csr.is_none() {
            return Err(VaultError::Conflict(format!(
                "PKI issuer `{name}` is not waiting for a signed certificate"
            ))
            .into());
        }
        let der = self.open_row(key_version, &nonce, &ciphertext)?;
        let key = KeyPair::try_from(der.as_slice()).map_err(pki_error)?;
        if rcgen::PublicKeyData::subject_public_key_info(&key) != ca.spki {
            return Err(VaultError::Invalid(
                "the certificate does not match the pending intermediate key".into(),
            )
            .into());
        }
        conn.execute(
            "UPDATE vault_pki_issuers SET certificate = ?1, not_after = ?2, common_name = ?3,
                 ca_chain = ?4, csr = NULL WHERE name = ?5",
            params![ca.pem, ca.not_after, ca.common_name, chain.concat(), name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.intermediate.set_signed", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": ca.common_name })),
        );
        issuer_info_locked(&conn, name)
    }

    /// Import an existing CA certificate and its private key (PEM, PKCS#8).
    pub async fn pki_import_issuer(
        &self,
        name: &str,
        certificate_pem: &str,
        private_key_pem: &str,
        ca_chain: Option<&str>,
        actor: &AuditActor,
    ) -> Result<IssuerInfo> {
        if !super::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid issuer name".into()).into());
        }
        let ca = parse_ca_certificate(certificate_pem)?;
        let chain = parse_chain(&ca.pem, ca_chain)?;
        let key = KeyPair::from_pem(private_key_pem).map_err(|_| {
            VaultError::Invalid("privateKey must be a PKCS#8 PEM private key".into())
        })?;
        if rcgen::PublicKeyData::subject_public_key_info(&key) != ca.spki {
            return Err(VaultError::Invalid(
                "the private key does not match the certificate".into(),
            )
            .into());
        }
        let (key_version, nonce, ciphertext) = self.seal_row(&key.serialize_der())?;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_pki_issuers
                (name, common_name, nonce, ciphertext, key_version, certificate, not_after,
                 created_at, kind, ca_chain)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'imported', ?9)",
            params![
                name,
                ca.common_name,
                nonce,
                ciphertext,
                key_version,
                ca.pem,
                ca.not_after,
                now_millis(),
                chain.concat()
            ],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("PKI issuer `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.issuer.import", "ok")
                .details(serde_json::json!({ "issuer": name, "commonName": ca.common_name })),
        );
        issuer_info_locked(&conn, name)
    }

    /// Sign an intermediate CA's CSR with `issuer_name` (path length 0). The
    /// subject is `common_name`; only the CSR's public key is used.
    pub async fn pki_sign_intermediate(
        &self,
        issuer_name: &str,
        csr_pem: &str,
        common_name: &str,
        ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<IssuedCertificate> {
        let csr = CertificateSigningRequestParams::from_pem(csr_pem).map_err(|_| {
            VaultError::Invalid("CSR is not a valid, self-signed PEM request".into())
        })?;
        let common_name = common_name.trim();
        if common_name.is_empty() || common_name.len() > 64 {
            return Err(VaultError::Invalid("commonName must be 1-64 characters".into()).into());
        }
        let ttl = ttl_secs.unwrap_or(DEFAULT_INTERMEDIATE_TTL_SECS);
        if !(3600..=MAX_ROOT_TTL_SECS).contains(&ttl) {
            return Err(VaultError::Invalid(
                "intermediate TTL must be between 1 hour and 10 years".into(),
            )
            .into());
        }
        let conn = self.conn.lock().await;
        let issuer = self.load_issuer(&conn, issuer_name)?;
        let path_len_zero = pem_certificates(&issuer.certificate)?
            .first()
            .and_then(|der| {
                let (_, cert) = x509_parser::parse_x509_certificate(der).ok()?;
                let constraints = cert.basic_constraints().ok().flatten()?;
                Some(constraints.value.path_len_constraint == Some(0))
            })
            .unwrap_or(false);
        if path_len_zero {
            return Err(VaultError::Denied(format!(
                "PKI issuer `{issuer_name}` has path length 0 and cannot sign CAs"
            ))
            .into());
        }
        let now = OffsetDateTime::now_utc();
        let not_after = (now + Duration::seconds(ttl)).min(datetime(issuer.not_after));
        if not_after < now + Duration::seconds(3600) {
            return Err(VaultError::Invalid(
                "the issuing CA has less than an hour of validity left".into(),
            )
            .into());
        }
        let mut params = ca_params(common_name, now - Duration::minutes(1), not_after);
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.use_authority_key_identifier_extension = true;
        let (serial, serial_hex) = fresh_serial();
        params.serial_number = Some(serial);
        let certificate = params
            .signed_by(&csr.public_key, &issuer.signer()?)
            .map_err(pki_error)?
            .pem();
        let not_after_millis = not_after.unix_timestamp() * 1000;
        self.record_cert(
            &conn,
            &serial_hex,
            issuer_name,
            common_name,
            not_after_millis,
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.intermediate.sign", "ok").details(serde_json::json!({
                "issuer": issuer_name, "serial": serial_hex, "commonName": common_name,
            })),
        );
        Ok(IssuedCertificate {
            certificate,
            private_key: None,
            issuing_ca: issuer.certificate.clone(),
            ca_chain: issuer.chain(),
            serial: serial_hex,
            not_after: not_after_millis,
        })
    }

    /// Forget certificates (revoked or not) that expired more than
    /// `safety_buffer_secs` ago; they can no longer appear on a CRL.
    pub async fn pki_tidy(&self, safety_buffer_secs: i64, actor: &AuditActor) -> Result<usize> {
        const MAX_SAFETY_BUFFER_SECS: i64 = 10 * 365 * 24 * 3600;
        if !(0..=MAX_SAFETY_BUFFER_SECS).contains(&safety_buffer_secs) {
            return Err(VaultError::Invalid(format!(
                "safetyBufferSecs must be between 0 and {MAX_SAFETY_BUFFER_SECS}"
            ))
            .into());
        }
        let now = now_millis();
        let cutoff = safety_buffer_secs
            .checked_mul(1000)
            .and_then(|buffer| now.checked_sub(buffer))
            .ok_or_else(|| VaultError::Invalid("safetyBufferSecs is out of range".into()))?;
        let conn = self.conn.lock().await;
        // `not_after < now` guarantees an unexpired certificate is never tidied,
        // whatever the cutoff, so a revocation can not drop off the CRL early.
        let removed = conn.execute(
            "DELETE FROM vault_pki_certs WHERE not_after < ?1 AND not_after < ?2",
            params![cutoff, now],
        )?;
        if removed > 0 {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "pki.tidy", "ok").details(serde_json::json!({
                    "removed": removed, "safetyBufferSecs": safety_buffer_secs,
                })),
            );
        }
        Ok(removed)
    }

    pub async fn pki_put_role(&self, role: &PkiRole, actor: &AuditActor) -> Result<()> {
        validate_role(role)?;
        let conn = self.conn.lock().await;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_pki_issuers WHERE name = ?1",
            params![role.issuer],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(VaultError::NotFound(format!("PKI issuer `{}`", role.issuer)).into());
        }
        conn.execute(
            "INSERT INTO vault_pki_roles (name, definition, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET definition = excluded.definition",
            params![role.name, serde_json::to_string(role)?, now_millis()],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.role.put", "ok")
                .details(serde_json::json!({ "role": role.name })),
        );
        Ok(())
    }

    pub async fn pki_list_roles(&self) -> Result<Vec<PkiRole>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT definition FROM vault_pki_roles ORDER BY name")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    pub async fn pki_delete_role(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed =
            conn.execute("DELETE FROM vault_pki_roles WHERE name = ?1", params![name])? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.role.delete", "ok")
                .details(serde_json::json!({ "role": name })),
        );
        Ok(removed)
    }

    fn load_role(conn: &Connection, name: &str) -> Result<PkiRole> {
        let definition: String = conn
            .query_row(
                "SELECT definition FROM vault_pki_roles WHERE name = ?1",
                params![name],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("PKI role `{name}`")))?;
        Ok(serde_json::from_str(&definition)?)
    }

    fn leaf_params(
        role: &PkiRole,
        common_name: &str,
        alt_names: &[String],
        ip_sans: &[String],
        ttl_secs: Option<i64>,
        issuer_not_after: i64,
    ) -> Result<(CertificateParams, String, i64)> {
        let mut dns: Vec<String> = Vec::new();
        for name in std::iter::once(common_name.to_owned()).chain(alt_names.iter().cloned()) {
            let name = name.trim().to_ascii_lowercase();
            if name.is_empty() || dns.contains(&name) {
                continue;
            }
            if !validate_dns_name(&name) || !domain_allowed(&role.allowed_domains, &name) {
                return Err(VaultError::Denied(format!(
                    "`{name}` is not allowed by role `{}`",
                    role.name
                ))
                .into());
            }
            dns.push(name);
        }
        if dns.len() + ip_sans.len() > MAX_SANS {
            return Err(VaultError::Invalid("too many subject alternative names".into()).into());
        }
        let mut sans = Vec::new();
        for name in &dns {
            sans.push(SanType::DnsName(
                name.clone()
                    .try_into()
                    .map_err(|_| VaultError::Invalid("invalid DNS name".into()))?,
            ));
        }
        for ip in ip_sans {
            if !role.allow_ip_sans {
                return Err(
                    VaultError::Denied("IP SANs are not allowed by this role".into()).into(),
                );
            }
            let parsed: IpAddr = ip
                .parse()
                .map_err(|_| VaultError::Invalid(format!("invalid IP SAN `{ip}`")))?;
            sans.push(SanType::IpAddress(parsed));
        }
        let ttl = ttl_secs.unwrap_or(role.default_ttl_secs);
        if ttl < 60 || ttl > role.max_ttl_secs {
            return Err(VaultError::Invalid(format!(
                "ttl must be between 60 and {} seconds",
                role.max_ttl_secs
            ))
            .into());
        }
        let now = OffsetDateTime::now_utc();
        // A leaf never outlives its issuer.
        let not_after = (now + Duration::seconds(ttl)).min(datetime(issuer_not_after));
        // An expired (or nearly expired) issuer would yield a certificate that
        // is invalid on arrival; refuse before a key or serial is created.
        if not_after < now + Duration::seconds(60) {
            return Err(VaultError::Invalid(
                "the issuing CA has expired or has less than a minute of validity left".into(),
            )
            .into());
        }
        let mut params = CertificateParams::default();
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, common_name.trim());
        params.distinguished_name = dn;
        params.subject_alt_names = sans;
        params.not_before = now - Duration::minutes(1);
        params.not_after = not_after;
        params.key_usages = vec![
            KeyUsagePurpose::DigitalSignature,
            KeyUsagePurpose::KeyEncipherment,
        ];
        if role.server_flag {
            params
                .extended_key_usages
                .push(ExtendedKeyUsagePurpose::ServerAuth);
        }
        if role.client_flag {
            params
                .extended_key_usages
                .push(ExtendedKeyUsagePurpose::ClientAuth);
        }
        params.use_authority_key_identifier_extension = true;
        params.key_identifier_method = KeyIdMethod::Sha256;
        let (serial, serial_hex) = fresh_serial();
        params.serial_number = Some(serial);
        Ok((params, serial_hex, not_after.unix_timestamp() * 1000))
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

    /// Issue a certificate and a fresh private key under `role`.
    #[allow(clippy::too_many_arguments)]
    pub async fn pki_issue(
        &self,
        role_name: &str,
        common_name: &str,
        alt_names: &[String],
        ip_sans: &[String],
        ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<IssuedCertificate> {
        let conn = self.conn.lock().await;
        let role = Self::load_role(&conn, role_name)?;
        let issuer = self.load_issuer(&conn, &role.issuer)?;
        let (params, serial, not_after) = Self::leaf_params(
            &role,
            common_name,
            alt_names,
            ip_sans,
            ttl_secs,
            issuer.not_after,
        )?;
        let leaf_key = KeyPair::generate().map_err(pki_error)?;
        let certificate = params
            .signed_by(&leaf_key, &issuer.signer()?)
            .map_err(pki_error)?
            .pem();
        self.record_cert(&conn, &serial, &role.issuer, common_name.trim(), not_after)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.issue", "ok").details(serde_json::json!({
                "role": role_name, "serial": serial, "commonName": common_name.trim(),
            })),
        ) {
            // The certificate record stays so the serial can still be revoked;
            // the private key is never released.
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(IssuedCertificate {
            certificate,
            private_key: Some(leaf_key.serialize_pem()),
            ca_chain: issuer.chain(),
            issuing_ca: issuer.certificate,
            serial,
            not_after,
        })
    }

    /// Sign a PEM CSR under `role`. Only the CSR's public key is used; names
    /// come from `common_name`/`alt_names` and are checked against the role.
    #[allow(clippy::too_many_arguments)]
    pub async fn pki_sign_csr(
        &self,
        role_name: &str,
        csr_pem: &str,
        common_name: &str,
        alt_names: &[String],
        ip_sans: &[String],
        ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<IssuedCertificate> {
        let csr = CertificateSigningRequestParams::from_pem(csr_pem).map_err(|_| {
            VaultError::Invalid("CSR is not a valid, self-signed PEM request".into())
        })?;
        let conn = self.conn.lock().await;
        let role = Self::load_role(&conn, role_name)?;
        let issuer = self.load_issuer(&conn, &role.issuer)?;
        let (params, serial, not_after) = Self::leaf_params(
            &role,
            common_name,
            alt_names,
            ip_sans,
            ttl_secs,
            issuer.not_after,
        )?;
        let certificate = params
            .signed_by(&csr.public_key, &issuer.signer()?)
            .map_err(pki_error)?
            .pem();
        self.record_cert(&conn, &serial, &role.issuer, common_name.trim(), not_after)?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.sign", "ok").details(serde_json::json!({
                "role": role_name, "serial": serial, "commonName": common_name.trim(),
            })),
        );
        Ok(IssuedCertificate {
            certificate,
            private_key: None,
            ca_chain: issuer.chain(),
            issuing_ca: issuer.certificate,
            serial,
            not_after,
        })
    }

    /// Revoke a certificate by serial (hex). Idempotent.
    pub async fn pki_revoke(&self, serial: &str, actor: &AuditActor) -> Result<CertRecord> {
        let serial = serial.trim().to_ascii_lowercase().replace(':', "");
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE vault_pki_certs SET revoked_at = COALESCE(revoked_at, ?1) WHERE serial = ?2",
            params![now_millis(), serial],
        )?;
        let record = conn
            .query_row(
                "SELECT serial, issuer, common_name, not_after, revoked_at FROM vault_pki_certs
                 WHERE serial = ?1",
                params![serial],
                |row| {
                    Ok(CertRecord {
                        serial: row.get(0)?,
                        issuer: row.get(1)?,
                        common_name: row.get(2)?,
                        not_after: row.get(3)?,
                        revoked_at: row.get(4)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("certificate {serial}")))?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "pki.revoke", "ok")
                .details(serde_json::json!({ "serial": serial })),
        );
        Ok(record)
    }

    /// Certificates issued by `issuer`, newest first (bounded).
    pub async fn pki_list_certs(&self, issuer: &str) -> Result<Vec<CertRecord>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT serial, issuer, common_name, not_after, revoked_at FROM vault_pki_certs
             WHERE issuer = ?1 ORDER BY created_at DESC LIMIT 500",
        )?;
        let rows = stmt.query_map(params![issuer], |row| {
            Ok(CertRecord {
                serial: row.get(0)?,
                issuer: row.get(1)?,
                common_name: row.get(2)?,
                not_after: row.get(3)?,
                revoked_at: row.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// A freshly signed CRL (PEM) of unexpired revoked certificates.
    pub async fn pki_crl(&self, issuer_name: &str) -> Result<String> {
        let conn = self.conn.lock().await;
        let issuer = self.load_issuer(&conn, issuer_name)?;
        let revoked: Vec<(String, i64)> = {
            let mut stmt = conn.prepare(
                "SELECT serial, revoked_at FROM vault_pki_certs
                 WHERE issuer = ?1 AND revoked_at IS NOT NULL AND not_after > ?2",
            )?;
            let rows = stmt.query_map(params![issuer_name, now_millis()], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let crl_number: i64 = conn.query_row(
            "UPDATE vault_pki_issuers SET crl_number = crl_number + 1 WHERE name = ?1
             RETURNING crl_number",
            params![issuer_name],
            |row| row.get(0),
        )?;
        let now = OffsetDateTime::now_utc();
        let params = CertificateRevocationListParams {
            this_update: now,
            next_update: now + Duration::seconds(CRL_VALIDITY_SECS),
            crl_number: SerialNumber::from(crl_number as u64),
            issuing_distribution_point: None,
            revoked_certs: revoked
                .into_iter()
                .filter_map(|(serial, at)| {
                    Some(RevokedCertParams {
                        serial_number: SerialNumber::from_slice(&hex::decode(serial).ok()?),
                        revocation_time: datetime(at),
                        reason_code: None,
                        invalidity_date: None,
                    })
                })
                .collect(),
            key_identifier_method: KeyIdMethod::Sha256,
        };
        let crl = params.signed_by(&issuer.signer()?).map_err(pki_error)?;
        crl.pem().map_err(pki_error)
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
                certificate: row.get(2)?,
                not_after: row.get(3)?,
                kind: row.get(4)?,
                ca_chain: split_chain(&row.get::<_, String>(5)?),
                csr: row.get(6)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("PKI issuer `{name}`")).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor() -> AuditActor {
        AuditActor::new("user", Some("ops"))
    }

    async fn setup() -> PluginSecretStore {
        let store = PluginSecretStore::in_memory().unwrap();
        store
            .pki_create_root("internal", "Ryu Internal Root", 30 * 24 * 3600, &actor())
            .await
            .unwrap();
        store
            .pki_put_role(
                &PkiRole {
                    name: "web".into(),
                    issuer: "internal".into(),
                    allowed_domains: vec!["*.svc.local".into(), "svc.local".into()],
                    allow_ip_sans: true,
                    default_ttl_secs: 3600,
                    max_ttl_secs: 86_400,
                    server_flag: true,
                    client_flag: false,
                },
                &actor(),
            )
            .await
            .unwrap();
        store
    }

    #[test]
    fn domain_patterns_match_one_label() {
        let patterns = vec!["*.svc.local".to_owned(), "svc.local".to_owned()];
        assert!(domain_allowed(&patterns, "api.svc.local"));
        assert!(domain_allowed(&patterns, "svc.local"));
        assert!(!domain_allowed(&patterns, "a.b.svc.local"));
        assert!(!domain_allowed(&patterns, "evilsvc.local"));
        assert!(!domain_allowed(&patterns, "api.svc.local.evil.com"));
    }

    #[tokio::test]
    async fn fail_closed_withholds_issued_private_keys() {
        let store = setup().await;
        crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
        let issued = store
            .pki_issue("web", "api.svc.local", &[], &[], None, &actor())
            .await;
        crate::vault::audit_devices::set_fail_closed_for_test(None);
        assert!(matches!(
            issued.unwrap_err().downcast_ref::<VaultError>(),
            Some(VaultError::AuditUnavailable)
        ));
    }

    #[tokio::test]
    async fn issued_certificates_chain_to_the_root_and_respect_the_role() {
        let store = setup().await;
        let issued = store
            .pki_issue(
                "web",
                "api.svc.local",
                &["svc.local".into()],
                &["10.0.0.5".into()],
                None,
                &actor(),
            )
            .await
            .unwrap();
        assert!(issued
            .certificate
            .starts_with("-----BEGIN CERTIFICATE-----"));
        assert!(issued
            .private_key
            .as_deref()
            .unwrap()
            .contains("PRIVATE KEY"));

        // Verify the leaf signature against the issuer with x509-parser.
        let (_, leaf_pem) =
            x509_parser::pem::parse_x509_pem(issued.certificate.as_bytes()).unwrap();
        let leaf = leaf_pem.parse_x509().unwrap();
        let (_, ca_pem) = x509_parser::pem::parse_x509_pem(issued.issuing_ca.as_bytes()).unwrap();
        let ca = ca_pem.parse_x509().unwrap();
        assert_eq!(leaf.issuer(), ca.subject());
        leaf.verify_signature(Some(ca.public_key())).unwrap();
        assert_eq!(hex::encode(leaf.raw_serial()), issued.serial);

        assert!(store
            .pki_issue("web", "api.other.local", &[], &[], None, &actor())
            .await
            .is_err());
        assert!(store
            .pki_issue(
                "web",
                "api.svc.local",
                &[],
                &[],
                Some(10 * 86_400),
                &actor()
            )
            .await
            .is_err());
    }

    #[test]
    fn an_expired_issuer_cannot_issue() {
        let role = PkiRole {
            name: "web".into(),
            issuer: "internal".into(),
            allowed_domains: vec!["svc.local".into()],
            allow_ip_sans: false,
            default_ttl_secs: 3600,
            max_ttl_secs: 86_400,
            server_flag: true,
            client_flag: false,
        };
        let expired = (OffsetDateTime::now_utc() - Duration::days(1)).unix_timestamp() * 1000;
        assert!(
            PluginSecretStore::leaf_params(&role, "svc.local", &[], &[], None, expired).is_err()
        );
        let valid = (OffsetDateTime::now_utc() + Duration::days(1)).unix_timestamp() * 1000;
        assert!(PluginSecretStore::leaf_params(&role, "svc.local", &[], &[], None, valid).is_ok());
    }

    #[tokio::test]
    async fn csr_signing_uses_only_the_request_public_key() {
        let store = setup().await;
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(vec!["evil.example.com".to_owned()]).unwrap();
        params
            .distinguished_name
            .push(DnType::CommonName, "evil.example.com");
        let csr = params.serialize_request(&key).unwrap().pem().unwrap();
        let signed = store
            .pki_sign_csr("web", &csr, "db.svc.local", &[], &[], None, &actor())
            .await
            .unwrap();
        assert!(signed.private_key.is_none());
        let (_, pem) = x509_parser::pem::parse_x509_pem(signed.certificate.as_bytes()).unwrap();
        let cert = pem.parse_x509().unwrap();
        let names: Vec<String> = cert
            .subject_alternative_name()
            .unwrap()
            .unwrap()
            .value
            .general_names
            .iter()
            .map(|name| name.to_string())
            .collect();
        assert_eq!(names, vec!["DNSName(db.svc.local)".to_owned()]);
        assert_eq!(
            cert.public_key().raw,
            rcgen::PublicKeyData::subject_public_key_info(&key).as_slice()
        );
    }

    #[tokio::test]
    async fn revocations_appear_in_the_crl() {
        let store = setup().await;
        let issued = store
            .pki_issue("web", "api.svc.local", &[], &[], None, &actor())
            .await
            .unwrap();
        let revoked = store.pki_revoke(&issued.serial, &actor()).await.unwrap();
        assert!(revoked.revoked_at.is_some());
        let crl_pem = store.pki_crl("internal").await.unwrap();
        let (_, pem) = x509_parser::pem::parse_x509_pem(crl_pem.as_bytes()).unwrap();
        let (_, crl) = <x509_parser::revocation_list::CertificateRevocationList as x509_parser::prelude::FromDer<_>>::from_der(&pem.contents).unwrap();
        let serials: Vec<String> = crl
            .iter_revoked_certificates()
            .map(|entry| hex::encode(entry.raw_serial()))
            .collect();
        assert_eq!(serials, vec![issued.serial]);
    }

    #[tokio::test]
    async fn intermediates_chain_under_a_root_and_issue_leaves() {
        let store = setup().await;
        let pending = store
            .pki_generate_intermediate("issuing", "Ryu Issuing CA", &actor())
            .await
            .unwrap();
        let csr = pending.csr.clone().unwrap();
        assert!(pending.certificate.is_empty());
        // A pending issuer cannot sign anything yet.
        store
            .pki_put_role(
                &PkiRole {
                    name: "leaf".into(),
                    issuer: "issuing".into(),
                    allowed_domains: vec!["*.svc.local".into()],
                    allow_ip_sans: false,
                    default_ttl_secs: 3600,
                    max_ttl_secs: 86_400,
                    server_flag: true,
                    client_flag: true,
                },
                &actor(),
            )
            .await
            .unwrap();
        assert!(store
            .pki_issue("leaf", "a.svc.local", &[], &[], None, &actor())
            .await
            .is_err());

        let signed = store
            .pki_sign_intermediate(
                "internal",
                &csr,
                "Ryu Issuing CA",
                Some(7 * 86_400),
                &actor(),
            )
            .await
            .unwrap();
        let roots = store.pki_list_issuers().await.unwrap();
        let root_pem = roots
            .iter()
            .find(|issuer| issuer.name == "internal")
            .unwrap()
            .certificate
            .clone();
        // A certificate for another key is refused; the chain must sign it.
        let stranger = store
            .pki_issue("web", "x.svc.local", &[], &[], None, &actor())
            .await
            .unwrap();
        assert!(store
            .pki_set_signed("issuing", &stranger.certificate, None, &actor())
            .await
            .is_err());
        assert!(store
            .pki_set_signed(
                "issuing",
                &signed.certificate,
                Some(&stranger.certificate),
                &actor()
            )
            .await
            .is_err());
        let info = store
            .pki_set_signed("issuing", &signed.certificate, Some(&root_pem), &actor())
            .await
            .unwrap();
        assert_eq!(info.kind, "intermediate");
        assert!(info.csr.is_none());
        assert_eq!(info.ca_chain, vec![root_pem.clone()]);
        assert!(store
            .pki_set_signed("issuing", &signed.certificate, None, &actor())
            .await
            .is_err());

        let leaf = store
            .pki_issue("leaf", "a.svc.local", &[], &[], None, &actor())
            .await
            .unwrap();
        assert_eq!(leaf.ca_chain.len(), 2);
        let parse = |pem: &str| {
            let (_, block) = x509_parser::pem::parse_x509_pem(pem.as_bytes()).unwrap();
            block
        };
        let leaf_block = parse(&leaf.certificate);
        let leaf_cert = leaf_block.parse_x509().unwrap();
        let mid_block = parse(&leaf.issuing_ca);
        let mid_cert = mid_block.parse_x509().unwrap();
        let root_block = parse(&root_pem);
        let root_cert = root_block.parse_x509().unwrap();
        assert_eq!(leaf_cert.issuer(), mid_cert.subject());
        leaf_cert
            .verify_signature(Some(mid_cert.public_key()))
            .unwrap();
        mid_cert
            .verify_signature(Some(root_cert.public_key()))
            .unwrap();
        let constraints = mid_cert.basic_constraints().unwrap().unwrap().value;
        assert!(constraints.ca);
        assert_eq!(constraints.path_len_constraint, Some(0));
        // Path length 0: the intermediate cannot sign further CAs.
        let other = store
            .pki_generate_intermediate("deeper", "Deeper CA", &actor())
            .await
            .unwrap();
        assert!(store
            .pki_sign_intermediate("issuing", &other.csr.unwrap(), "Deeper CA", None, &actor())
            .await
            .is_err());
        // CRLs from an intermediate are signed by it.
        store.pki_revoke(&leaf.serial, &actor()).await.unwrap();
        assert!(store.pki_crl("issuing").await.is_ok());
    }

    #[tokio::test]
    async fn imported_issuers_must_match_their_key_and_tidy_forgets_expired() {
        let store = PluginSecretStore::in_memory().unwrap();
        let key = KeyPair::generate().unwrap();
        let now = OffsetDateTime::now_utc();
        let mut params = ca_params(
            "Corp Root",
            now - Duration::minutes(1),
            now + Duration::days(30),
        );
        params.serial_number = Some(fresh_serial().0);
        let certificate = params.self_signed(&key).unwrap().pem();
        let wrong = KeyPair::generate().unwrap();
        assert!(store
            .pki_import_issuer("corp", &certificate, &wrong.serialize_pem(), None, &actor())
            .await
            .is_err());
        let info = store
            .pki_import_issuer("corp", &certificate, &key.serialize_pem(), None, &actor())
            .await
            .unwrap();
        assert_eq!(info.kind, "imported");
        assert_eq!(info.common_name, "Corp Root");
        assert!(store
            .pki_import_issuer("corp", &certificate, &key.serialize_pem(), None, &actor())
            .await
            .is_err());
        store
            .pki_put_role(
                &PkiRole {
                    name: "corp-web".into(),
                    issuer: "corp".into(),
                    allowed_domains: vec!["corp.local".into()],
                    allow_ip_sans: false,
                    default_ttl_secs: 3600,
                    max_ttl_secs: 86_400,
                    server_flag: true,
                    client_flag: false,
                },
                &actor(),
            )
            .await
            .unwrap();
        let issued = store
            .pki_issue("corp-web", "corp.local", &[], &[], None, &actor())
            .await
            .unwrap();
        let (_, leaf) = x509_parser::pem::parse_x509_pem(issued.certificate.as_bytes()).unwrap();
        let leaf = leaf.parse_x509().unwrap();
        let (_, ca) = x509_parser::pem::parse_x509_pem(certificate.as_bytes()).unwrap();
        let ca = ca.parse_x509().unwrap();
        leaf.verify_signature(Some(ca.public_key())).unwrap();
        // A leaf (non-CA) certificate cannot be imported as an issuer.
        assert!(store
            .pki_import_issuer(
                "leafy",
                &issued.certificate,
                &key.serialize_pem(),
                None,
                &actor()
            )
            .await
            .is_err());

        assert_eq!(store.pki_tidy(0, &actor()).await.unwrap(), 0);
        // An oversized buffer is refused instead of wrapping into a future cutoff.
        assert!(store
            .pki_tidy(18_446_744_073_709_552, &actor())
            .await
            .is_err());
        assert!(store.pki_tidy(i64::MAX, &actor()).await.is_err());
        assert_eq!(store.pki_list_certs("corp").await.unwrap().len(), 1);
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE vault_pki_certs SET not_after = ?1",
                params![now_millis() - 4 * 24 * 3600 * 1000],
            )
            .unwrap();
        }
        assert_eq!(
            store
                .pki_tidy(DEFAULT_TIDY_BUFFER_SECS, &actor())
                .await
                .unwrap(),
            1
        );
        assert!(store.pki_list_certs("corp").await.unwrap().is_empty());
    }
}
