//! SSH one-time passwords, as Vault's SSH engine OTP mode.
//!
//! An OTP role names the target hosts (CIDR blocks), the usernames a
//! credential may be for, the SSH port, and how long an unused credential
//! lives. `creds` issues a random one-time password for one host and user;
//! only its SHA-256 hash is stored. The helper on the target host (PAM via
//! `vault-ssh-helper`, or any client of the verify route) presents the OTP to
//! `verify`, which consumes it in the same statement that finds it: a second
//! verify of the same OTP fails, and so does an expired one. Verify returns
//! the username, host and role so the helper can check the login matches.

use std::net::IpAddr;

use sha2::{Digest, Sha256};

use super::*;
use crate::vault::tokens::{ip_allowed, normalize_cidrs};

/// Longest lifetime of an unused OTP (1 hour); the default is 10 minutes.
pub const MAX_OTP_TTL_SECS: i64 = 3600;
const DEFAULT_OTP_TTL_SECS: i64 = 600;
const MAX_USERNAME_LEN: usize = 32;
const MAX_OTP_LEN: usize = 64;

fn default_port() -> u16 {
    22
}

fn default_otp_ttl() -> i64 {
    DEFAULT_OTP_TTL_SECS
}

/// An OTP role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOtpRole {
    pub name: String,
    /// The username when a request names none.
    pub default_user: String,
    /// Other usernames a request may name (globs). The default user is
    /// always allowed.
    #[serde(default)]
    pub allowed_users: Vec<String>,
    /// Target hosts: the requested IP must be inside one of these blocks.
    pub cidr_list: Vec<String>,
    /// Blocks carved out of `cidrList`.
    #[serde(default)]
    pub exclude_cidr_list: Vec<String>,
    #[serde(default = "default_port")]
    pub port: u16,
    /// Lifetime of an unused OTP, 60 to 3600 seconds (default 600).
    #[serde(default = "default_otp_ttl")]
    pub ttl_secs: i64,
}

/// An issued one-time password (shown once).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOtpCredential {
    pub key: String,
    pub key_type: &'static str,
    pub username: String,
    pub ip: String,
    pub port: u16,
    pub expires_at: i64,
}

/// What a consumed OTP was for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshOtpVerification {
    pub username: String,
    pub ip: String,
    pub role_name: String,
    pub port: u16,
}

pub(super) fn init_otp_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_ssh_otp_roles (
             name       TEXT PRIMARY KEY,
             definition TEXT NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_ssh_otps (
             otp_hash   TEXT PRIMARY KEY,
             role       TEXT NOT NULL,
             username   TEXT NOT NULL,
             ip         TEXT NOT NULL,
             port       INTEGER NOT NULL,
             expires_at INTEGER NOT NULL,
             created_at INTEGER NOT NULL
         );",
    )
    .context("initializing ssh otp schema")
}

/// A POSIX-portable login name: `[a-z_][a-z0-9_.-]*`, at most 32 bytes.
fn valid_username(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_USERNAME_LEN
        && (bytes[0].is_ascii_lowercase() || bytes[0] == b'_')
        && bytes.iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'.' | b'-')
        })
}

fn validate_otp_role(role: &mut SshOtpRole) -> Result<()> {
    let invalid = |message: &str| -> anyhow::Error { VaultError::Invalid(message.into()).into() };
    if !crate::vault::transit::is_valid_key_name(&role.name) {
        return Err(invalid("role names must match ^[a-z0-9][a-z0-9_-]{0,63}$"));
    }
    if !valid_username(&role.default_user) {
        return Err(invalid("defaultUser must be a valid login name"));
    }
    if role.allowed_users.len() > MAX_PRINCIPALS
        || role
            .allowed_users
            .iter()
            .any(|pattern| pattern.is_empty() || pattern.len() > 64 || !pattern.is_ascii())
    {
        return Err(invalid(
            "allowedUsers takes up to 32 patterns of 1-64 characters",
        ));
    }
    if role.cidr_list.is_empty() {
        return Err(invalid("cidrList must name at least one target block"));
    }
    role.cidr_list = normalize_cidrs(&role.cidr_list)?;
    role.exclude_cidr_list = normalize_cidrs(&role.exclude_cidr_list)?;
    if role.port == 0 {
        return Err(invalid("port must be 1-65535"));
    }
    if !(60..=MAX_OTP_TTL_SECS).contains(&role.ttl_secs) {
        return Err(invalid("ttlSecs must be between 60 and 3600"));
    }
    Ok(())
}

fn otp_hash(otp: &str) -> String {
    hex::encode(Sha256::digest(otp.as_bytes()))
}

/// A random 128-bit OTP in UUID layout, as Vault issues.
fn new_otp() -> String {
    let hex = hex::encode(random_bytes(16));
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

impl PluginSecretStore {
    /// Create or replace an OTP role.
    pub async fn ssh_put_otp_role(
        &self,
        role: &SshOtpRole,
        actor: &AuditActor,
    ) -> Result<SshOtpRole> {
        let mut role = role.clone();
        validate_otp_role(&mut role)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_ssh_otp_roles (name, definition, created_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET definition = excluded.definition",
            params![role.name, serde_json::to_string(&role)?, now_millis()],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.otp_role.put", "ok")
                .details(serde_json::json!({ "role": role.name, "cidrs": role.cidr_list })),
        );
        Ok(role)
    }

    pub async fn ssh_list_otp_roles(&self) -> Result<Vec<SshOtpRole>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT definition FROM vault_ssh_otp_roles ORDER BY name")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(serde_json::from_str(&row?)?);
        }
        Ok(out)
    }

    /// Delete an OTP role and every unused OTP it issued.
    pub async fn ssh_delete_otp_role(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute(
            "DELETE FROM vault_ssh_otp_roles WHERE name = ?1",
            params![name],
        )? > 0;
        conn.execute("DELETE FROM vault_ssh_otps WHERE role = ?1", params![name])?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.otp_role.delete", "ok")
                .details(serde_json::json!({ "role": name })),
        );
        Ok(removed)
    }

    /// Issue a one-time password for `username` (default: the role's) on
    /// host `ip`.
    pub async fn ssh_create_otp(
        &self,
        role_name: &str,
        ip: &str,
        username: Option<&str>,
        actor: &AuditActor,
    ) -> Result<SshOtpCredential> {
        let address: IpAddr = ip
            .trim()
            .parse()
            .map_err(|_| VaultError::Invalid("`ip` must be an IP address".into()))?;
        let conn = self.conn.lock().await;
        let definition: String = conn
            .query_row(
                "SELECT definition FROM vault_ssh_otp_roles WHERE name = ?1",
                params![role_name],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| VaultError::NotFound(format!("SSH OTP role `{role_name}`")))?;
        let role: SshOtpRole = serde_json::from_str(&definition)?;
        let username = username.map(str::trim).filter(|name| !name.is_empty());
        let username = username.unwrap_or(&role.default_user).to_owned();
        if !valid_username(&username) {
            return Err(VaultError::Invalid("invalid username".into()).into());
        }
        if username != role.default_user
            && !role
                .allowed_users
                .iter()
                .any(|pattern| glob_matches(pattern, &username))
        {
            return Err(VaultError::Denied(format!(
                "username `{username}` is not allowed by role `{role_name}`"
            ))
            .into());
        }
        let excluded = !role.exclude_cidr_list.is_empty()
            && ip_allowed(&role.exclude_cidr_list, Some(address));
        if excluded || !ip_allowed(&role.cidr_list, Some(address)) {
            return Err(VaultError::Denied(format!(
                "host {address} is not a target of role `{role_name}`"
            ))
            .into());
        }
        let now = now_millis();
        conn.execute(
            "DELETE FROM vault_ssh_otps WHERE expires_at <= ?1",
            params![now],
        )?;
        let otp = new_otp();
        let expires_at = now + role.ttl_secs * 1000;
        conn.execute(
            "INSERT INTO vault_ssh_otps (otp_hash, role, username, ip, port, expires_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                otp_hash(&otp),
                role_name,
                username,
                address.to_string(),
                role.port,
                expires_at,
                now
            ],
        )?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.otp.create", "ok").details(serde_json::json!({
                "role": role_name, "username": username, "ip": address.to_string(),
            })),
        ) {
            conn.execute(
                "DELETE FROM vault_ssh_otps WHERE otp_hash = ?1",
                params![otp_hash(&otp)],
            )?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(SshOtpCredential {
            key: otp,
            key_type: "otp",
            username,
            ip: address.to_string(),
            port: role.port,
            expires_at,
        })
    }

    /// Consume an OTP. It verifies at most once: the row is deleted by the
    /// statement that reads it.
    pub async fn ssh_verify_otp(
        &self,
        otp: &str,
        actor: &AuditActor,
    ) -> Result<SshOtpVerification> {
        let otp = otp.trim();
        let refused = || -> anyhow::Error { VaultError::Denied("OTP not found".into()).into() };
        if otp.is_empty() || otp.len() > MAX_OTP_LEN {
            return Err(refused());
        }
        let conn = self.conn.lock().await;
        let row: Option<(String, String, String, u16, i64)> = conn
            .query_row(
                "DELETE FROM vault_ssh_otps WHERE otp_hash = ?1
                 RETURNING role, username, ip, port, expires_at",
                params![otp_hash(otp)],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let verified = row.filter(|(.., expires_at)| *expires_at > now_millis());
        let Some((role_name, username, ip, port, _)) = verified else {
            self.audit_locked(&conn, &AuditEntry::new(actor, "ssh.otp.verify", "denied"));
            return Err(refused());
        };
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "ssh.otp.verify", "ok").details(serde_json::json!({
                "role": role_name, "username": username, "ip": ip,
            })),
        );
        Ok(SshOtpVerification {
            username,
            ip,
            role_name,
            port,
        })
    }
}
