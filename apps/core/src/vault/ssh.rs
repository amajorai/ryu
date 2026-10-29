//! SSH certificate authority.
//!
//! An SSH CA holds an Ed25519 signing key sealed with the vault keyring.
//! Roles bind a CA to a certificate type (user or host), the principals a
//! certificate may name (globs), TTL bounds, and default extensions. Signing a
//! caller's public key returns an OpenSSH certificate
//! (`*-cert-v01@openssh.com`) valid for the requested principals and TTL.
//! Servers trust the CA's public key (`TrustedUserCAKeys`), so access is
//! short-lived and revocation is expiry, as with Vault's SSH engine.
//!
//! The certificate encoding follows OpenSSH's `PROTOCOL.certkeys`; the subject
//! key's fields are fully parsed and canonically encoded, so RSA, ECDSA,
//! and Ed25519 user keys are all supported while the CA signs with Ed25519.

use anyhow::{anyhow, bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use ed25519_dalek::Signer;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::audit::{AuditActor, AuditEntry};
use super::policy::glob_matches;
use super::{now_millis, random_bytes, VaultError};
use crate::plugin_secrets::PluginSecretStore;

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
    .context("initializing ssh schema")
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
    ca: &ed25519_dalek::SigningKey,
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
    put_string(&mut body, &ed25519_blob(&ca.verifying_key().to_bytes()));
    let signature = ca.sign(&body);
    let mut signature_blob = Vec::new();
    put_string(&mut signature_blob, b"ssh-ed25519");
    put_string(&mut signature_blob, &signature.to_bytes());
    put_string(&mut body, &signature_blob);
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
    /// Create an SSH CA and return its OpenSSH public key line.
    pub async fn ssh_create_ca(&self, name: &str, actor: &AuditActor) -> Result<String> {
        if !super::transit::is_valid_key_name(name) {
            return Err(VaultError::Invalid("invalid CA name".into()).into());
        }
        let seed: [u8; 32] = random_bytes(32).try_into().expect("32 bytes");
        let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
        let public = openssh_public_line(
            &signing.verifying_key().to_bytes(),
            &format!("ryu-ssh-ca-{name}"),
        );
        let (key_version, nonce, ciphertext) = self.seal_row(&seed)?;
        let conn = self.conn.lock().await;
        let inserted = conn.execute(
            "INSERT OR IGNORE INTO vault_ssh_cas (name, nonce, ciphertext, key_version, public_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![name, nonce, ciphertext, key_version, public, now_millis()],
        )?;
        if inserted == 0 {
            return Err(VaultError::Conflict(format!("SSH CA `{name}` exists")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.ca.create", "ok")
                .details(serde_json::json!({ "ca": name })),
        );
        Ok(public)
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
        let seed: [u8; 32] = self
            .open_row(key_version, &nonce, &ciphertext)?
            .try_into()
            .map_err(|_| anyhow!("CA seed has the wrong length"))?;
        let ca = ed25519_dalek::SigningKey::from_bytes(&seed);
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
mod tests {
    use super::*;
    use ed25519_dalek::Verifier;

    fn actor() -> AuditActor {
        AuditActor::new("user", Some("alice"))
    }

    fn user_key() -> String {
        let seed: [u8; 32] = random_bytes(32).try_into().unwrap();
        let key = ed25519_dalek::SigningKey::from_bytes(&seed);
        openssh_public_line(&key.verifying_key().to_bytes(), "alice@laptop")
    }

    async fn setup() -> PluginSecretStore {
        let store = PluginSecretStore::in_memory().unwrap();
        store.ssh_create_ca("ops", &actor()).await.unwrap();
        store
            .ssh_put_role(
                &SshRole {
                    name: "dev".into(),
                    ca: "ops".into(),
                    cert_type: CertType::User,
                    allowed_principals: vec!["deploy".into(), "dev-*".into()],
                    default_ttl_secs: 3600,
                    max_ttl_secs: 7200,
                    extensions: vec!["permit-pty".into(), "permit-agent-forwarding".into()],
                },
                &actor(),
            )
            .await
            .unwrap();
        store
    }

    fn public_line(key_type: &str, blob: &[u8]) -> String {
        format!("{key_type} {} fixture comment", B64.encode(blob))
    }

    #[tokio::test]
    async fn injected_certificate_metadata_is_rejected_at_parser_and_signing_sink() {
        let line = user_key();
        let (_, mut blob) = parse_public_key(&line).unwrap();
        // A forged certificate header followed by a reserved string sized to
        // swallow all legitimate fields appended by the original signer.
        blob.extend_from_slice(&1_u64.to_be_bytes());
        blob.extend_from_slice(&CertType::User.code().to_be_bytes());
        put_string(&mut blob, b"attacker");
        let mut principals = Vec::new();
        put_string(&mut principals, b"root");
        put_string(&mut blob, &principals);
        blob.extend_from_slice(&0_u64.to_be_bytes());
        blob.extend_from_slice(&u64::MAX.to_be_bytes());
        put_string(&mut blob, &[]); // critical options
        put_string(&mut blob, &[]); // extensions
                                    // Generated serial/type, key id, deploy principal, validity,
                                    // critical options, two extensions, and reserved string.
        let generated_length =
            8 + 4 + 4 + 7 + 4 + 4 + 6 + 16 + 4 + 4 + (4 + 23 + 4) + (4 + 10 + 4) + 4;
        blob.extend_from_slice(&(generated_length as u32).to_be_bytes());
        let malicious = public_line("ssh-ed25519", &blob);
        assert!(parse_public_key(&malicious).is_err());
        let ca = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
        assert!(build_certificate(
            &ca,
            "ssh-ed25519",
            &blob,
            1,
            CertType::User,
            "fixture",
            &["deploy".into()],
            0,
            60,
            &[]
        )
        .is_err());
        let store = setup().await;
        assert!(store
            .ssh_sign(
                "dev",
                &malicious,
                &["deploy".into()],
                Some(60),
                Some("fixture"),
                &actor()
            )
            .await
            .is_err());
    }

    #[test]
    fn malformed_algorithm_fields_and_trailing_data_are_rejected() {
        let (_, mut malformed_length) = parse_public_key(&user_key()).unwrap();
        let key_length_offset = 4 + b"ssh-ed25519".len();
        for length in [33_u32, u32::MAX] {
            malformed_length[key_length_offset..key_length_offset + 4]
                .copy_from_slice(&length.to_be_bytes());
            assert!(parse_public_key(&public_line("ssh-ed25519", &malformed_length)).is_err());
        }
        for length in [0, 1, 31, 33] {
            let mut blob = Vec::new();
            put_string(&mut blob, b"ssh-ed25519");
            put_string(&mut blob, &vec![7; length]);
            assert!(parse_public_key(&public_line("ssh-ed25519", &blob)).is_err());
        }
        for integer in [vec![], vec![0], vec![0x80], vec![0, 1]] {
            let mut blob = Vec::new();
            put_string(&mut blob, b"ssh-rsa");
            put_string(&mut blob, &integer);
            put_string(&mut blob, &[1, 2, 3]);
            assert!(parse_public_key(&public_line("ssh-rsa", &blob)).is_err());
        }
        for (curve, point) in [
            ("nistp384", vec![4; 65]),
            ("nistp256", vec![0; 65]),
            ("nistp256", vec![4; 64]),
            ("unknown", vec![4; 65]),
        ] {
            let mut blob = Vec::new();
            put_string(&mut blob, b"ecdsa-sha2-nistp256");
            put_string(&mut blob, curve.as_bytes());
            put_string(&mut blob, &point);
            assert!(parse_public_key(&public_line("ecdsa-sha2-nistp256", &blob)).is_err());
        }
        let (_, blob) = parse_public_key(&user_key()).unwrap();
        assert!(parse_public_key(&public_line("ssh-rsa", &blob)).is_err());
        for length in 0..blob.len() {
            assert!(parse_public_key(&public_line("ssh-ed25519", &blob[..length])).is_err());
        }
        let mut sk_blob = Vec::new();
        put_string(&mut sk_blob, b"sk-ssh-ed25519@openssh.com");
        put_string(&mut sk_blob, &[7; 32]);
        assert!(parse_public_key(&public_line("sk-ssh-ed25519@openssh.com", &sk_blob)).is_err());
        put_string(&mut sk_blob, b"ssh:fixture");
        let key_length_offset = 4 + b"sk-ssh-ed25519@openssh.com".len();
        sk_blob[key_length_offset..key_length_offset + 4].copy_from_slice(&33_u32.to_be_bytes());
        assert!(parse_public_key(&public_line("sk-ssh-ed25519@openssh.com", &sk_blob)).is_err());
    }

    #[tokio::test]
    async fn every_supported_key_signs_only_the_role_fields_and_rejects_trailing_bytes() {
        let store = setup().await;
        let dir = tempfile::tempdir().unwrap();
        let mut lines = vec![user_key()];
        for (kind, bits) in [
            ("rsa", "2048"),
            ("ecdsa", "256"),
            ("ecdsa", "384"),
            ("ecdsa", "521"),
        ] {
            let path = dir.path().join(format!("key-{kind}-{bits}"));
            let output = std::process::Command::new("ssh-keygen")
                .args(["-q", "-t", kind, "-b", bits, "-N", "", "-f"])
                .arg(&path)
                .output()
                .expect("OpenSSH is required for key interoperability proof");
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            lines.push(std::fs::read_to_string(path.with_extension("pub")).unwrap());
        }
        let (_, ed_blob) = parse_public_key(&lines[0]).unwrap();
        let mut cursor = ed_blob.as_slice();
        read_string(&mut cursor).unwrap();
        let mut sk_blob = Vec::new();
        put_string(&mut sk_blob, b"sk-ssh-ed25519@openssh.com");
        put_string(&mut sk_blob, read_string(&mut cursor).unwrap());
        put_string(&mut sk_blob, b"ssh:fixture");
        lines.push(public_line("sk-ssh-ed25519@openssh.com", &sk_blob));
        for (index, line) in lines.iter().enumerate() {
            let (kind, blob) = parse_public_key(line).unwrap();
            assert_eq!(
                parse_public_key(&format!("  {}  comment\n", line.trim()))
                    .unwrap()
                    .1,
                blob
            );
            for suffix in [
                &[0_u8][..],
                &[0, 0, 0, 0][..],
                &[0xff, 0xff, 0xff, 0xff][..],
            ] {
                let mut malformed = blob.clone();
                malformed.extend_from_slice(suffix);
                let malformed_line = public_line(&kind, &malformed);
                assert!(parse_public_key(&malformed_line).is_err(), "{kind}");
                assert!(
                    store
                        .ssh_sign(
                            "dev",
                            &malformed_line,
                            &["deploy".into()],
                            Some(60),
                            Some("fixture"),
                            &actor()
                        )
                        .await
                        .is_err(),
                    "{kind}"
                );
            }
            let cert = store
                .ssh_sign(
                    "dev",
                    line,
                    &["deploy".into()],
                    Some(60),
                    Some("fixture"),
                    &actor(),
                )
                .await
                .unwrap();
            let cert_path = dir.path().join(format!("certificate-{index}.pub"));
            std::fs::write(&cert_path, &cert.certificate).unwrap();
            let output = std::process::Command::new("ssh-keygen")
                .args(["-L", "-f"])
                .arg(cert_path)
                .output()
                .unwrap();
            let text = String::from_utf8_lossy(&output.stdout);
            assert!(
                output.status.success(),
                "{kind}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(text.contains("user certificate"), "{text}");
            assert!(text.contains("deploy"), "{text}");
            assert!(
                !text.contains("forever") && !text.contains("root"),
                "{text}"
            );
            assert_eq!(cert.valid_before - cert.valid_after, 120);
        }
    }

    #[tokio::test]
    async fn signed_certificates_verify_against_the_ca_key() {
        let store = setup().await;
        let cert = store
            .ssh_sign(
                "dev",
                &user_key(),
                &["deploy".into(), "dev-alice".into()],
                None,
                None,
                &actor(),
            )
            .await
            .unwrap();
        assert!(cert
            .certificate
            .starts_with("ssh-ed25519-cert-v01@openssh.com "));
        assert_eq!(cert.valid_before - cert.valid_after, 3600 + 60);

        // Parse back and verify the CA signature over the signed body.
        let blob = B64
            .decode(cert.certificate.split_whitespace().nth(1).unwrap())
            .unwrap();
        let mut cursor = blob.as_slice();
        // Walk to the signature: type, nonce, pk, serial, type, keyid, principals,
        // after, before, critical, extensions, reserved, signature key.
        read_string(&mut cursor).unwrap();
        read_string(&mut cursor).unwrap();
        read_string(&mut cursor).unwrap(); // ed25519 public key
        cursor = &cursor[8 + 4..];
        assert_eq!(read_string(&mut cursor).unwrap(), cert.key_id.as_bytes());
        read_string(&mut cursor).unwrap();
        cursor = &cursor[16..];
        read_string(&mut cursor).unwrap();
        let extensions = read_string(&mut cursor).unwrap();
        let mut ext_cursor = extensions;
        assert_eq!(
            read_string(&mut ext_cursor).unwrap(),
            b"permit-agent-forwarding"
        );
        read_string(&mut cursor).unwrap();
        let ca_blob = read_string(&mut cursor).unwrap();
        let signed_len = blob.len() - cursor.len();
        let signature_blob = read_string(&mut cursor).unwrap();
        assert!(cursor.is_empty());
        let mut ca_cursor = ca_blob;
        read_string(&mut ca_cursor).unwrap();
        let ca_public: [u8; 32] = read_string(&mut ca_cursor).unwrap().try_into().unwrap();
        let mut sig_cursor = signature_blob;
        assert_eq!(read_string(&mut sig_cursor).unwrap(), b"ssh-ed25519");
        let signature =
            ed25519_dalek::Signature::from_slice(read_string(&mut sig_cursor).unwrap()).unwrap();
        ed25519_dalek::VerifyingKey::from_bytes(&ca_public)
            .unwrap()
            .verify(&blob[..signed_len], &signature)
            .unwrap();

        let cas = store.ssh_list_cas().await.unwrap();
        let ca_line_blob = B64
            .decode(cas[0].1.split_whitespace().nth(1).unwrap())
            .unwrap();
        assert_eq!(ca_line_blob, ca_blob);
    }

    #[tokio::test]
    async fn ssh_keygen_accepts_the_certificate_when_available() {
        if std::process::Command::new("ssh-keygen")
            .arg("-?")
            .output()
            .is_err()
        {
            return;
        }
        let store = setup().await;
        let cert = store
            .ssh_sign(
                "dev",
                &user_key(),
                &["deploy".into()],
                Some(600),
                None,
                &actor(),
            )
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("id-cert.pub");
        std::fs::write(&path, &cert.certificate).unwrap();
        let output = std::process::Command::new("ssh-keygen")
            .arg("-L")
            .arg("-f")
            .arg(&path)
            .output()
            .unwrap();
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(text.contains("user certificate"), "{text}");
        assert!(text.contains("deploy"), "{text}");
        assert!(text.contains("permit-pty"), "{text}");
    }

    #[tokio::test]
    async fn principals_and_ttls_are_bounded_by_the_role() {
        let store = setup().await;
        assert!(store
            .ssh_sign("dev", &user_key(), &["root".into()], None, None, &actor())
            .await
            .is_err());
        assert!(store
            .ssh_sign(
                "dev",
                &user_key(),
                &["deploy".into()],
                Some(99_999),
                None,
                &actor()
            )
            .await
            .is_err());
        assert!(store
            .ssh_sign(
                "dev",
                "ssh-dss AAAA",
                &["deploy".into()],
                None,
                None,
                &actor()
            )
            .await
            .is_err());
        assert!(store
            .ssh_put_role(
                &SshRole {
                    name: "bad".into(),
                    ca: "missing".into(),
                    cert_type: CertType::User,
                    allowed_principals: vec!["x".into()],
                    default_ttl_secs: 60,
                    max_ttl_secs: 60,
                    extensions: vec![],
                },
                &actor(),
            )
            .await
            .is_err());
    }
}
