//! SSH certificate authority.
//!
//! An SSH CA holds an Ed25519, RSA, or ECDSA signing key sealed with the
//! vault keyring (see [`ca_keys`]).
//! Roles bind a CA to a certificate type (user or host), the principals a
//! certificate may name (globs), TTL bounds, and default extensions. Signing a
//! caller's public key returns an OpenSSH certificate
//! (`*-cert-v01@openssh.com`) valid for the requested principals and TTL.
//! Servers trust the CA's public key (`TrustedUserCAKeys`), so access is
//! short-lived. Signed serials are recorded, so a certificate can also be
//! revoked before it expires and published in the CA's KRL (see [`krl`]).
//!
//! OTP roles issue one-time passwords for a target host instead of
//! certificates; the host's helper consumes each one once (see [`otp`]).
//!
//! The certificate encoding follows OpenSSH's `PROTOCOL.certkeys`; the subject
//! key's fields are fully parsed and canonically encoded, so RSA, ECDSA,
//! and Ed25519 user keys are all supported whatever the CA's key type.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::audit::{AuditActor, AuditEntry};
use super::policy::glob_matches;
use super::{now_millis, random_bytes, VaultError};
use crate::plugin_secrets::PluginSecretStore;

mod ca_keys;
#[cfg(test)]
mod ca_keys_tests;
mod krl;
#[cfg(test)]
mod krl_tests;
mod otp;
#[cfg(test)]
mod otp_tests;

use self::ca_keys::CaKey;
pub use self::ca_keys::SshCaKeyType;
pub use self::krl::SshRevocation;
pub use self::otp::SshOtpRole;

/// Hard upper bound on any certificate lifetime (30 days).
pub const MAX_TTL_SECS: i64 = 30 * 24 * 3600;
const MAX_PRINCIPALS: usize = 32;
const SUPPORTED_KEY_TYPES: [&str; 6] = [
    "ssh-ed25519",
    "ssh-rsa",
    "ecdsa-sha2-nistp256",
    "ecdsa-sha2-nistp384",
    "ecdsa-sha2-nistp521",
    "sk-ssh-ed25519@openssh.com",
];

/// Certificate type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CertType {
    User,
    Host,
}

impl CertType {
    fn code(self) -> u32 {
        match self {
            Self::User => 1,
            Self::Host => 2,
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Host => "host",
        }
    }
}

/// An SSH signing role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshRole {
    pub name: String,
    pub ca: String,
    pub cert_type: CertType,
    pub allowed_principals: Vec<String>,
    pub default_ttl_secs: i64,
    pub max_ttl_secs: i64,
    /// Extension names (e.g. `permit-pty`), user certificates only.
    #[serde(default)]
    pub extensions: Vec<String>,
}

/// A signed certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedCertificate {
    pub certificate: String,
    pub serial: u64,
    pub key_id: String,
    pub principals: Vec<String>,
    pub valid_after: i64,
    pub valid_before: i64,
}

/// Create the SSH tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_ssh_cas (
             name        TEXT PRIMARY KEY,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             key_version INTEGER NOT NULL DEFAULT 0,
             public_key  TEXT NOT NULL,
             created_at  INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_ssh_roles (
             name       TEXT PRIMARY KEY,
             definition TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );",
    )
    .context("initializing ssh schema")?;
    otp::init_otp_schema(conn)?;
    krl::init_krl_schema(conn)
}

fn put_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn read_string<'a>(input: &mut &'a [u8]) -> Result<&'a [u8]> {
    if input.len() < 4 {
        bail!("truncated ssh string");
    }
    let len = u32::from_be_bytes(input[..4].try_into().expect("4 bytes")) as usize;
    if input.len() < 4 + len {
        bail!("truncated ssh string");
    }
    let value = &input[4..4 + len];
    *input = &input[4 + len..];
    Ok(value)
}

fn ed25519_blob(public: &[u8; 32]) -> Vec<u8> {
    let mut blob = Vec::new();
    put_string(&mut blob, b"ssh-ed25519");
    put_string(&mut blob, public);
    blob
}

/// Parse an OpenSSH public-key line into `(key_type, blob)`.
pub fn parse_public_key(line: &str) -> Result<(String, Vec<u8>)> {
    let mut parts = line.split_whitespace();
    let declared = parts
        .next()
        .ok_or_else(|| VaultError::Invalid("empty public key".into()))?;
    let encoded = parts
        .next()
        .ok_or_else(|| VaultError::Invalid("public key has no body".into()))?;
    let blob = B64
        .decode(encoded)
        .map_err(|_| VaultError::Invalid("public key body is not base64".into()))?;
    Ok((
        declared.to_owned(),
        canonical_subject_blob(declared, &blob)?,
    ))
}

/// Decode every algorithm field and require EOF before signing any key material.
fn canonical_subject_blob(key_type: &str, blob: &[u8]) -> Result<Vec<u8>> {
    let key = ssh_key::PublicKey::from_bytes(blob)
        .map_err(|error| VaultError::Invalid(format!("invalid public key: {error}")))?;
    if key.algorithm().as_str() != key_type || !SUPPORTED_KEY_TYPES.contains(&key_type) {
        return Err(
            VaultError::Invalid(format!("unsupported public key type `{key_type}`")).into(),
        );
    }
    if let ssh_key::public::KeyData::Rsa(rsa) = key.key_data() {
        for integer in [&rsa.e, &rsa.n] {
            if !integer
                .as_positive_bytes()
                .is_some_and(|bytes| bytes.iter().any(|byte| *byte != 0))
            {
                return Err(VaultError::Invalid("RSA key fields must be positive".into()).into());
            }
        }
    }
    let canonical = key
        .to_bytes()
        .map_err(|error| VaultError::Invalid(format!("invalid public key: {error}")))?;
    if canonical != blob {
        return Err(VaultError::Invalid("noncanonical public key fields".into()).into());
    }
    Ok(canonical)
}

fn certificate_key_type(key_type: &str) -> String {
    format!(
        "{}-cert-v01@openssh.com",
        key_type.strip_suffix("@openssh.com").unwrap_or(key_type)
    )
}

fn openssh_public_line(public: &[u8; 32], comment: &str) -> String {
    format!("ssh-ed25519 {} {comment}", B64.encode(ed25519_blob(public)))
}

#[allow(clippy::too_many_arguments)]
fn build_certificate(
    ca: &CaKey,
    key_type: &str,
    subject_blob: &[u8],
    serial: u64,
    cert_type: CertType,
    key_id: &str,
    principals: &[String],
    valid_after: u64,
    valid_before: u64,
    extensions: &[String],
) -> Result<Vec<u8>> {
    let canonical = canonical_subject_blob(key_type, subject_blob)?;
    let mut cursor = canonical.as_slice();
    read_string(&mut cursor)?; // key type, replaced by the cert type
    let mut body = Vec::new();
    put_string(&mut body, certificate_key_type(key_type).as_bytes());
    put_string(&mut body, &random_bytes(32));
    body.extend_from_slice(cursor);
    body.extend_from_slice(&serial.to_be_bytes());
    body.extend_from_slice(&cert_type.code().to_be_bytes());
    put_string(&mut body, key_id.as_bytes());
    let mut packed = Vec::new();
    for principal in principals {
        put_string(&mut packed, principal.as_bytes());
    }
    put_string(&mut body, &packed);
    body.extend_from_slice(&valid_after.to_be_bytes());
    body.extend_from_slice(&valid_before.to_be_bytes());
    put_string(&mut body, &[]); // critical options
    let mut sorted = extensions.to_vec();
    sorted.sort();
    sorted.dedup();
    let mut packed = Vec::new();
    for extension in &sorted {
        put_string(&mut packed, extension.as_bytes());
        put_string(&mut packed, &[]);
    }
    put_string(&mut body, &packed);
    put_string(&mut body, &[]); // reserved
    put_string(&mut body, &ca.public_blob()?);
    let signature = ca.sign(&body);
    put_string(&mut body, &signature);
    Ok(body)
}

fn validate_role(role: &SshRole) -> Result<()> {
    if !super::transit::is_valid_key_name(&role.name)
        || !super::transit::is_valid_key_name(&role.ca)
    {
        bail!("role and CA names must match ^[a-z0-9][a-z0-9_-]{{0,63}}$");
    }
    if role.allowed_principals.is_empty() || role.allowed_principals.len() > MAX_PRINCIPALS {
        bail!("a role needs 1 to {MAX_PRINCIPALS} allowed principal patterns");
    }
    if role.default_ttl_secs < 60
        || role.max_ttl_secs < role.default_ttl_secs
        || role.max_ttl_secs > MAX_TTL_SECS
    {
        bail!("TTLs must satisfy 60 <= default <= max <= {MAX_TTL_SECS}");
    }
    for extension in &role.extensions {
        if extension.is_empty() || extension.len() > 64 || !extension.is_ascii() {
            bail!("invalid extension name");
        }
    }
    if role.cert_type == CertType::Host && !role.extensions.is_empty() {
        bail!("host certificates do not carry extensions");
    }
    Ok(())
}

impl PluginSecretStore {
    /// Create an Ed25519 SSH CA and return its OpenSSH public key line.
    pub async fn ssh_create_ca(&self, name: &str, actor: &AuditActor) -> Result<String> {
        self.ssh_create_ca_with(name, SshCaKeyType::Ed25519, None, actor)
            .await
    }

    /// Every CA with its public key line.
    pub async fn ssh_list_cas(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT name, public_key FROM vault_ssh_cas ORDER BY name")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Create or replace a signing role.
    pub async fn ssh_put_role(&self, role: &SshRole, actor: &AuditActor) -> Result<()> {
        validate_role(role)?;
        let conn = self.conn.lock().await;
        let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_ssh_cas WHERE name = ?1",
            params![role.ca],
            |row| row.get(0),
        )?;
        if exists == 0 {
            return Err(VaultError::NotFound(format!("SSH CA `{}`", role.ca)).into());
        }
        conn.execute(
            "INSERT INTO vault_ssh_roles (name, definition, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET definition = excluded.definition",
            params![role.name, serde_json::to_string(role)?, now_millis()],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.role.put", "ok").details(
                serde_json::json!({ "role": role.name, "certType": role.cert_type.as_str() }),
            ),
        );
        Ok(())
    }

    pub async fn ssh_list_roles(&self) -> Result<Vec<SshRole>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT definition FROM vault_ssh_roles ORDER BY name")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    pub async fn ssh_delete_role(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed =
            conn.execute("DELETE FROM vault_ssh_roles WHERE name = ?1", params![name])? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.role.delete", "ok")
                .details(serde_json::json!({ "role": name })),
        );
        Ok(removed)
    }

    /// Sign `public_key` under `role` for `principals` and `ttl_secs`.
    pub async fn ssh_sign(
        &self,
        role_name: &str,
        public_key: &str,
        principals: &[String],
        ttl_secs: Option<i64>,
        key_id: Option<&str>,
        actor: &AuditActor,
    ) -> Result<SignedCertificate> {
        let (key_type, blob) = parse_public_key(public_key)?;
        let conn = self.conn.lock().await;
        let definition: String = conn
            .query_row(
                "SELECT definition FROM vault_ssh_roles WHERE name = ?1",
                params![role_name],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("SSH role `{role_name}`")))?;
        let role: SshRole = serde_json::from_str(&definition)?;
        if principals.is_empty() || principals.len() > MAX_PRINCIPALS {
            return Err(VaultError::Invalid("request 1 to 32 principals".into()).into());
        }
        for principal in principals {
            if principal.is_empty()
                || principal.len() > 256
                || principal.chars().any(char::is_control)
            {
                return Err(VaultError::Invalid("invalid principal".into()).into());
            }
            if !role
                .allowed_principals
                .iter()
                .any(|pattern| glob_matches(pattern, principal))
            {
                return Err(VaultError::Denied(format!(
                    "principal `{principal}` is not allowed by role `{role_name}`"
                ))
                .into());
            }
        }
        let ttl = ttl_secs.unwrap_or(role.default_ttl_secs);
        if ttl < 60 || ttl > role.max_ttl_secs {
            return Err(VaultError::Invalid(format!(
                "ttl must be between 60 and {} seconds",
                role.max_ttl_secs
            ))
            .into());
        }
        let (nonce, ciphertext, key_version): (Vec<u8>, Vec<u8>, u32) = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version FROM vault_ssh_cas WHERE name = ?1",
                params![role.ca],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("SSH CA `{}`", role.ca)))?;
        let ca = CaKey::from_sealed(&self.open_row(key_version, &nonce, &ciphertext)?)?;
        let serial = u64::from_be_bytes(random_bytes(8).try_into().expect("8 bytes"));
        // Backdate by a minute to tolerate clock skew between CA and server.
        let now_secs = now_millis() / 1000;
        let valid_after = (now_secs - 60).max(0) as u64;
        let valid_before = (now_secs + ttl) as u64;
        let key_id = key_id.map(str::to_owned).unwrap_or_else(|| {
            format!(
                "{}-{serial:016x}",
                actor.id.clone().unwrap_or_else(|| actor.kind.clone())
            )
        });
        if key_id.len() > 256 || key_id.chars().any(char::is_control) {
            return Err(VaultError::Invalid("invalid key id".into()).into());
        }
        let certificate = build_certificate(
            &ca,
            &key_type,
            &blob,
            serial,
            role.cert_type,
            &key_id,
            principals,
            valid_after,
            valid_before,
            &role.extensions,
        )?;
        krl::record_certificate(&conn, &role.ca, serial, &key_id, valid_before)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.sign", "ok").details(serde_json::json!({
                "role": role_name,
                "serial": format!("{serial:016x}"),
                "principals": principals,
                "ttl": ttl,
            })),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(SignedCertificate {
            certificate: format!(
                "{} {} {key_id}",
                certificate_key_type(&key_type),
                B64.encode(certificate)
            ),
            serial,
            key_id,
            principals: principals.to_vec(),
            valid_after: valid_after as i64,
            valid_before: valid_before as i64,
        })
    }
}

#[cfg(test)]
mod tests;
