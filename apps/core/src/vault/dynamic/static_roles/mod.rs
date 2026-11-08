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
//!   key, so AWS's two-key limit cannot wedge the role);
//! * `openai`: with an organization Admin API key, create a project service
//!   account (whose API key becomes the value), then delete the service
//!   account the previous rotation created;
//! * `anthropic`: the Admin API cannot mint keys, so the operator stages a
//!   replacement key (`replacementApiKey`) created in the Console. Rotation
//!   confirms it belongs to the organization, writes it, and deactivates the
//!   previous key.
//!
//! Key-minting providers (`aws-iam`, `openai`, `anthropic`) share one flow
//! ([`rotate`]): the new key is sealed as pending before anything else can
//! fail, and a replaced key whose retirement fails stays recorded and is
//! retried by later rotations.
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

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::target_guard::{self, TargetEgress};
use crate::plugin_secrets::kv::Charset;
use crate::plugin_secrets::{Generator, SecretCoords};
use crate::vault::VaultError;

mod ai_keys;
#[cfg(test)]
mod ai_keys_tests;
mod iam;
mod provider;
mod rotate;
mod store;
#[cfg(test)]
mod tests;

pub use provider::StaticProvider;

/// Shortest rotation period (five minutes).
pub const MIN_ROTATION_SECS: i64 = 300;
/// Longest rotation period (one year).
pub const MAX_ROTATION_SECS: i64 = 366 * 24 * 3600;
/// Delay before the scheduler retries a failed rotation.
pub const RETRY_SECS: i64 = 300;
const DEFAULT_PASSWORD_LENGTH: u16 = 32;

/// What is sealed in the role row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedState {
    provider: StaticProvider,
    /// A credential generated (or created upstream) but not yet written to
    /// KV. Reused by the next attempt.
    #[serde(default)]
    pending: Option<String>,
    /// Key ids (AWS access keys, OpenAI service accounts, Anthropic API
    /// keys) that a rotation replaced but could not retire. They stay live
    /// upstream until retired, so each later rotation retries them (first
    /// before minting a key, so AWS's two-key limit cannot wedge the role).
    /// The serialized name predates the AI providers.
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
        (
            "openai",
            "new project service account key, previous one deleted",
        ),
        (
            "anthropic",
            "staged replacement key written, previous one deactivated",
        ),
    ])
}
