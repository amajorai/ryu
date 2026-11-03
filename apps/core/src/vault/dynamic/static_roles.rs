//! Static roles: Vault-managed rotation of credentials that already exist.
//!
//! A dynamic role mints a new credential per lease. A static role instead
//! owns one existing account at a target system and rotates its credential on
//! a schedule (`rotationPeriodSecs`) or on demand:
//!
//! * `postgres`: `ALTER ROLE "{{name}}" WITH PASSWORD '{{password}}'` (or the
//!   role's own rotation statements);
//! * `redis` (alias `valkey`): `ACL SETUSER <user> resetpass ><password>`;
//! * `webhook`: a signed `{action: "rotate", role, username, password}` POST
//!   (same HMAC headers as the dynamic webhook provider). The endpoint may
//!   answer `{value: "..."}` to supply the credential itself, which covers
//!   SaaS API keys that only the vendor can mint;
//! * `aws-iam`: `iam:CreateAccessKey` for the IAM user, then
//!   `iam:DeleteAccessKey` for the previous key. A key whose deletion fails
//!   stays recorded and is retried by the next rotation (before it creates a
//!   key, so AWS's two-key limit cannot wedge the role).
//!
//! The new value is written as a new KV version (`source = rotate`) at the
//! role's target coordinates, so every `secret:NAME` reference keeps working
//! and the previous version stays in history.
//!
//! Rotation is crash-safe in the order that matters: the new credential is
//! sealed into the role row as *pending* before it is applied upstream; it
//! is cleared only after the KV write succeeds. A failed attempt keeps the
//! previous KV version current, records `lastError`, and retries the same
//! pending credential (so a password that may already be live upstream is
//! never lost). The scheduler retries failures after [`RETRY_SECS`].

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::postgres::{self, PostgresConfig};
use super::redis;
use super::target_guard::{self, RoleWriter, TargetEgress};
use super::webhook::{self, WebhookConfig};
use crate::plugin_secrets::kv::Charset;
use crate::plugin_secrets::{
    Generator, PluginSecretStore, SecretCoords, SecretMetadataPatch, VersionSource, WriteRequest,
};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{now_millis, VaultError};

mod rotate;
mod store;
#[cfg(test)]
mod tests;
mod upstream;

use upstream::*;

/// Shortest rotation period (five minutes).
pub const MIN_ROTATION_SECS: i64 = 300;
/// Longest rotation period (one year).
pub const MAX_ROTATION_SECS: i64 = 366 * 24 * 3600;
/// Delay before the scheduler retries a failed rotation.
pub const RETRY_SECS: i64 = 300;
const DEFAULT_PASSWORD_LENGTH: u16 = 32;
const DEFAULT_PG_ROTATION: &str = "ALTER ROLE \"{{name}}\" WITH PASSWORD '{{password}}'";
const IAM_HOST: &str = "iam.amazonaws.com";
const IAM_REGION: &str = "us-east-1";

/// The account a static role manages. Sealed at rest with the role.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StaticProvider {
    #[serde(rename = "postgres", rename_all = "camelCase")]
    Postgres {
        connection_url: String,
        username: String,
        /// Statements with `{{name}}` and `{{password}}`; default
        /// `ALTER ROLE … WITH PASSWORD …`.
        #[serde(default)]
        rotation_statements: Vec<String>,
    },
    #[serde(rename = "redis", alias = "valkey", rename_all = "camelCase")]
    Redis {
        connection_url: String,
        username: String,
    },
    #[serde(rename = "webhook", rename_all = "camelCase")]
    Webhook {
        url: String,
        signing_secret: String,
        username: String,
    },
    #[serde(rename = "aws-iam", rename_all = "camelCase")]
    AwsIam {
        /// Credentials allowed to call `iam:CreateAccessKey` and
        /// `iam:DeleteAccessKey` on the user.
        access_key_id: String,
        secret_access_key: String,
        /// The IAM user whose access key rotates.
        user_name: String,
        /// The user's current key id, deleted after the first rotation.
        #[serde(default)]
        current_access_key_id: Option<String>,
    },
}

fn validate_pg_username(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 63
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@'))
    {
        bail!("username must be 1-63 letters, digits, or _ - . @");
    }
    Ok(())
}

fn validate_iam_user(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'+' | b'=' | b',' | b'.' | b'@' | b'_' | b'-')
        })
    {
        bail!("userName is not a valid IAM user name");
    }
    Ok(())
}

impl StaticProvider {
    /// Stable provider name.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Postgres { .. } => "postgres",
            Self::Redis { .. } => "redis",
            Self::Webhook { .. } => "webhook",
            Self::AwsIam { .. } => "aws-iam",
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::Postgres {
                connection_url,
                username,
                rotation_statements,
            } => {
                let url = url::Url::parse(connection_url).context("connectionUrl is not a URL")?;
                if !matches!(url.scheme(), "postgres" | "postgresql") {
                    bail!("connectionUrl must be a postgres:// URL");
                }
                validate_pg_username(username)?;
                if !rotation_statements.is_empty()
                    && !rotation_statements
                        .iter()
                        .any(|statement| statement.contains("{{password}}"))
                {
                    bail!("rotationStatements must reference {{{{password}}}}");
                }
                Ok(())
            }
            Self::Redis {
                connection_url,
                username,
            } => {
                redis::validate_connection_url(connection_url)?;
                redis::validate_username(username)
            }
            Self::Webhook {
                url,
                signing_secret,
                username,
            } => {
                WebhookConfig {
                    url: url.clone(),
                    signing_secret: signing_secret.clone(),
                    egress: TargetEgress::default(),
                }
                .validate()?;
                if username.trim().is_empty() || username.len() > 256 {
                    bail!("username must be 1-256 characters");
                }
                Ok(())
            }
            Self::AwsIam {
                access_key_id,
                secret_access_key,
                user_name,
                current_access_key_id,
            } => {
                if access_key_id.trim().is_empty() || secret_access_key.trim().is_empty() {
                    bail!("accessKeyId and secretAccessKey are required");
                }
                validate_iam_user(user_name)?;
                if current_access_key_id
                    .as_deref()
                    .is_some_and(|id| !id.bytes().all(|b| b.is_ascii_alphanumeric()))
                {
                    bail!("currentAccessKeyId is not an access key id");
                }
                Ok(())
            }
        }
    }

    /// The managed account: provider kind plus host/endpoint and user. Two
    /// configurations with the same account rotate the same credential, even
    /// when their admin credentials or statements differ.
    fn account(&self) -> Value {
        match self {
            Self::AwsIam { user_name, .. } => json!({ "kind": "aws-iam", "userName": user_name }),
            other => json!({ "kind": other.kind(), "account": other.summary() }),
        }
    }

    /// Core-managed fields carried over from the stored configuration of the
    /// same account. The AWS `currentAccessKeyId` is rewritten by every
    /// rotation, so a caller's (possibly stale) value is honored only before
    /// Core has recorded one.
    fn with_managed_fields_from(&self, stored: &Self) -> Self {
        let mut merged = self.clone();
        if let (
            Self::AwsIam {
                current_access_key_id,
                ..
            },
            Self::AwsIam {
                current_access_key_id: Some(stored_id),
                ..
            },
        ) = (&mut merged, stored)
        {
            *current_access_key_id = Some(stored_id.clone());
        }
        merged
    }

    /// Non-secret summary for listings.
    fn summary(&self) -> Value {
        match self {
            Self::Postgres {
                connection_url,
                username,
                ..
            } => {
                let target = PostgresConfig {
                    connection_url: connection_url.clone(),
                    creation_statements: Vec::new(),
                    revocation_statements: Vec::new(),
                    username_prefix: None,
                    egress: TargetEgress::default(),
                }
                .redacted_target();
                json!({ "host": target, "username": username })
            }
            Self::Redis {
                connection_url,
                username,
            } => json!({ "host": redis::redacted_target(connection_url), "username": username }),
            Self::Webhook { url, username, .. } => json!({ "url": url, "username": username }),
            Self::AwsIam { user_name, .. } => json!({ "userName": user_name }),
        }
    }
}

/// What is sealed in the role row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedState {
    provider: StaticProvider,
    /// A credential generated (or created upstream) but not yet written to
    /// KV. Reused by the next attempt.
    #[serde(default)]
    pending: Option<String>,
    /// AWS access key ids that a rotation replaced but could not delete.
    /// They stay live at AWS until deleted, so each later rotation retries
    /// them (first before creating a key, so AWS's two-key limit cannot
    /// wedge the role).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    retired_access_keys: Vec<String>,
    /// How the target is reached (from the role's writer; never stored).
    #[serde(skip)]
    egress: TargetEgress,
}

/// A static role (no secrets).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRoleInfo {
    pub name: String,
    pub provider: String,
    pub summary: Value,
    pub target: SecretCoords,
    pub rotation_period_secs: i64,
    pub password_length: u16,
    pub next_rotation_at: i64,
    pub last_rotated_at: Option<i64>,
    pub last_error: Option<String>,
    /// A rotation was started and is waiting to be retried.
    pub pending: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Create or replace input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaticRoleInput {
    pub provider: StaticProvider,
    pub rotation_period_secs: i64,
    #[serde(default)]
    pub password_length: Option<u16>,
}

/// Create the static role table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_static_roles (
             name                 TEXT PRIMARY KEY,
             provider             TEXT NOT NULL,
             summary              TEXT NOT NULL,
             target               TEXT NOT NULL,
             rotation_period_secs INTEGER NOT NULL,
             password_length      INTEGER NOT NULL,
             next_rotation_at     INTEGER NOT NULL,
             last_rotated_at      INTEGER,
             last_error           TEXT,
             pending              INTEGER NOT NULL DEFAULT 0,
             created_at           INTEGER NOT NULL,
             updated_at           INTEGER NOT NULL,
             nonce                BLOB NOT NULL,
             ciphertext           BLOB NOT NULL,
             key_version          INTEGER NOT NULL DEFAULT 0
         );",
    )
    .context("initializing static role schema")?;
    target_guard::ensure_writer_column(conn, "vault_static_roles")
}

const INFO_COLUMNS: &str = "name, provider, summary, target, rotation_period_secs, password_length,
     next_rotation_at, last_rotated_at, last_error, pending, created_at, updated_at";

fn info_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StaticRoleInfo> {
    let conversion = |index: usize, error: serde_json::Error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    };
    Ok(StaticRoleInfo {
        name: row.get(0)?,
        provider: row.get(1)?,
        summary: serde_json::from_str(&row.get::<_, String>(2)?).unwrap_or(Value::Null),
        target: serde_json::from_str(&row.get::<_, String>(3)?).map_err(|e| conversion(3, e))?,
        rotation_period_secs: row.get(4)?,
        password_length: row.get(5)?,
        next_rotation_at: row.get(6)?,
        last_rotated_at: row.get(7)?,
        last_error: row.get(8)?,
        pending: row.get::<_, i64>(9)? != 0,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn info_locked(conn: &Connection, name: &str) -> Result<StaticRoleInfo> {
    conn.query_row(
        &format!("SELECT {INFO_COLUMNS} FROM vault_static_roles WHERE name = ?1"),
        params![name],
        info_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("static role `{name}`")).into())
}

/// Serializes rotations so the scheduler and an on-demand rotate never race
/// on one role's pending credential.
fn rotation_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

fn password_generator(length: u16) -> Generator {
    Generator::Random {
        length,
        charset: Charset::Alphanumeric,
    }
}

/// Summary map of provider names for docs and listings.
pub fn provider_kinds() -> BTreeMap<&'static str, &'static str> {
    BTreeMap::from([
        ("postgres", "ALTER ROLE password rotation"),
        ("redis", "ACL SETUSER resetpass rotation (alias valkey)"),
        ("webhook", "signed rotate call; may supply the value"),
        ("aws-iam", "CreateAccessKey then DeleteAccessKey"),
    ])
}
