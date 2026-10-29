//! External secret stores: OpenBao, HashiCorp Vault, and Infisical.
//!
//! A **store** is a connection (address, auth, KV mount or Infisical
//! project/environment). Its credentials (token, AppRole secret id, or
//! universal-auth client secret) are sealed with the vault keyring in
//! `vault_external_stores`, which is listed in [`crate::vault::ENCRYPTED_TABLES`].
//!
//! Values flow two ways, always at **node scope**:
//!
//! * **Sources (pull).** A Ryu `(environment, folder)` is bound to one remote
//!   path. In `live` mode the resolver reads the remote folder at dispatch time
//!   through a per-source TTL cache. When the store cannot be reached the
//!   lookup fails closed (the reference is absent and resolution stops) unless
//!   the source sets `staleIfErrorSecs`, which serves the last good answer for
//!   that long past its TTL. In `sync` mode the scheduler copies the remote
//!   folder into ordinary versioned values tagged `source = external`; a remote
//!   key that is not a valid Ryu name aborts the whole sync. Either way the
//!   folder is read-only for node-scope writes (`409 vault_conflict`); change
//!   the value in the external store. User values still win over a sourced
//!   node folder, as `user > node > team > org` requires.
//! * **Destinations (push).** One-way secrets sync of a Ryu node folder to a
//!   remote path, after every write into the folder and on an interval. KV
//!   destinations are replaced as a whole, except that an empty folder never
//!   wipes a non-empty remote secret; Infisical keys are upserted only, so a
//!   key deleted in Ryu stays in Infisical. A failing destination is retried
//!   with exponential backoff capped at its interval. A folder with a live
//!   source cannot be pushed (its local rows are not its values).
//!
//! Sources and destinations belong to one node scope id: the 409 write guard,
//! the live lookup, sync, and push all match on it.
//!
//! All HTTP goes through [`net`] (https, loopback only by operator opt-in or
//! in the dev profile, DNS-pinned, no redirects, link-local and metadata
//! always refused). No value or credential is logged, returned, or written to
//! the audit log.

pub mod client;
pub mod net;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audit::{AuditActor, AuditEntry};
use super::{is_valid_environment, normalize_path, now_millis, VaultError};
use crate::plugin_secrets::kv::ListFilter;
use crate::plugin_secrets::{
    is_valid_vault_secret_name, PluginSecretStore, SecretCoords, SecretMetadataPatch, SecretScope,
    SecretStatus, VersionSource, WriteRequest, MAX_VAULT_SECRET_VALUE_LEN,
};
use client::{RemoteFolder, Session};

/// Default and bounds for a live source's cache TTL.
pub const DEFAULT_CACHE_TTL_SECS: i64 = 60;
const MIN_CACHE_TTL_SECS: i64 = 5;
const MAX_CACHE_TTL_SECS: i64 = 3600;
/// Upper bound for serving a stale answer during an outage.
const MAX_STALE_IF_ERROR_SECS: i64 = 86_400;
/// Default and bounds for a sync source's poll interval.
pub const DEFAULT_SYNC_INTERVAL_SECS: i64 = 300;
const MIN_SYNC_INTERVAL_SECS: i64 = 10;
const MAX_INTERVAL_SECS: i64 = 86_400;
/// Default and minimum periodic re-push for a destination.
pub const DEFAULT_PUSH_INTERVAL_SECS: i64 = 3600;
const MIN_PUSH_INTERVAL_SECS: i64 = 60;
/// How often the external-store loop wakes without a write.
const LOOP_TICK: Duration = Duration::from_secs(10);
const MAX_ADDRESS_LEN: usize = 512;
const MAX_FIELD_LEN: usize = 256;

/// The external store's product.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreKind {
    Openbao,
    HashicorpVault,
    Infisical,
}

impl StoreKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Openbao => "openbao",
            Self::HashicorpVault => "hashicorp-vault",
            Self::Infisical => "infisical",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "openbao" => Some(Self::Openbao),
            "hashicorp-vault" => Some(Self::HashicorpVault),
            "infisical" => Some(Self::Infisical),
            _ => None,
        }
    }
}

/// How Core authenticates to the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    /// A static token (Vault/OpenBao token or Infisical access token).
    Token,
    /// Vault/OpenBao AppRole `role_id` + `secret_id`.
    Approle,
    /// Vault/OpenBao Kubernetes auth with the pod's service-account JWT.
    Kubernetes,
    /// Infisical universal auth (machine identity client id + secret).
    UniversalAuth,
}

impl AuthMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::Token => "token",
            Self::Approle => "approle",
            Self::Kubernetes => "kubernetes",
            Self::UniversalAuth => "universal-auth",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "token" => Some(Self::Token),
            "approle" => Some(Self::Approle),
            "kubernetes" => Some(Self::Kubernetes),
            "universal-auth" => Some(Self::UniversalAuth),
            _ => None,
        }
    }
}

/// Store credentials. Sealed at rest; never serialized into a response.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_secret: Option<String>,
}

impl std::fmt::Debug for StoreCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StoreCredentials(<redacted>)")
    }
}

fn filled(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.trim().is_empty())
}

/// A store connection (no credentials).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreRecord {
    pub id: String,
    pub name: String,
    pub kind: StoreKind,
    pub address: String,
    pub namespace: Option<String>,
    pub auth_method: AuthMethod,
    pub auth_mount: Option<String>,
    pub role: Option<String>,
    pub mount: String,
    pub path_prefix: String,
    pub kv_version: u8,
    pub project_id: String,
    pub infisical_environment: String,
    pub secret_path: String,
    pub created_at: i64,
    pub updated_at: i64,
}

/// Request to create a store.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInput {
    pub name: String,
    pub kind: StoreKind,
    pub address: String,
    #[serde(default)]
    pub namespace: Option<String>,
    pub auth_method: AuthMethod,
    #[serde(default)]
    pub auth_mount: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    /// Refused: the Kubernetes token location is operator configuration
    /// ([`client::ENV_K8S_JWT_PATH`]), never request input.
    #[serde(default)]
    pub jwt_path: Option<String>,
    #[serde(default)]
    pub mount: Option<String>,
    #[serde(default)]
    pub path_prefix: Option<String>,
    #[serde(default)]
    pub kv_version: Option<u8>,
    #[serde(default)]
    pub project_id: Option<String>,
    /// Infisical environment slug (not a Ryu environment).
    #[serde(default)]
    pub infisical_environment: Option<String>,
    #[serde(default)]
    pub secret_path: Option<String>,
    #[serde(default)]
    pub credentials: StoreCredentials,
}

/// Pull mode for a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceMode {
    /// Read-through at resolve time with a TTL cache.
    Live,
    /// Scheduled copy into versioned local values.
    Sync,
}

impl SourceMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Live => "live",
            Self::Sync => "sync",
        }
    }
}

/// A folder bound to a remote path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecord {
    pub id: String,
    pub store_id: String,
    pub environment: String,
    pub path: String,
    pub remote_path: String,
    pub mode: SourceMode,
    pub scope_id: String,
    pub cache_ttl_secs: i64,
    pub stale_if_error_secs: i64,
    pub sync_interval_secs: i64,
    pub last_sync_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_count: i64,
    pub created_at: i64,
}

/// Request to bind a folder to a remote path.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInput {
    pub store_id: String,
    pub environment: String,
    pub path: String,
    #[serde(default)]
    pub remote_path: String,
    pub mode: SourceMode,
    #[serde(default)]
    pub cache_ttl_secs: Option<i64>,
    #[serde(default)]
    pub stale_if_error_secs: Option<i64>,
    #[serde(default)]
    pub sync_interval_secs: Option<i64>,
}

/// A folder pushed one-way to a remote path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationRecord {
    pub id: String,
    pub store_id: String,
    pub environment: String,
    pub path: String,
    pub remote_path: String,
    pub scope_id: String,
    pub interval_secs: i64,
    pub dirty: bool,
    pub last_push_at: Option<i64>,
    pub last_status: Option<String>,
    pub last_error: Option<String>,
    pub last_count: i64,
    /// Consecutive failed pushes; drives the retry backoff.
    pub failures: i64,
    pub created_at: i64,
}

/// Request to push a folder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DestinationInput {
    pub store_id: String,
    pub environment: String,
    pub path: String,
    #[serde(default)]
    pub remote_path: String,
    #[serde(default)]
    pub interval_secs: Option<i64>,
}

/// Result of one sync.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub written: usize,
    pub removed: usize,
    pub unchanged: usize,
}

/// Result of one loop pass.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickReport {
    pub synced: usize,
    pub pushed: usize,
    pub failed: usize,
}

/// What a live lookup found for one name in one folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LiveLookup {
    /// The folder has no live source; resolve locally.
    NotSourced,
    Found {
        value: String,
        version: i64,
    },
    /// The folder is sourced and the remote has no such key.
    Missing,
    /// The store is unreachable (or the vault sealed) and no usable stale
    /// answer exists. Resolution fails closed.
    Unavailable,
}

/// Create the external-store tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_external_stores (
             id                    TEXT PRIMARY KEY,
             name                  TEXT NOT NULL UNIQUE,
             kind                  TEXT NOT NULL,
             address               TEXT NOT NULL,
             namespace             TEXT,
             auth_method           TEXT NOT NULL,
             auth_mount            TEXT,
             role                  TEXT,
             mount                 TEXT NOT NULL DEFAULT '',
             path_prefix           TEXT NOT NULL DEFAULT '',
             kv_version            INTEGER NOT NULL DEFAULT 2,
             project_id            TEXT NOT NULL DEFAULT '',
             infisical_environment TEXT NOT NULL DEFAULT '',
             secret_path           TEXT NOT NULL DEFAULT '/',
             nonce                 BLOB NOT NULL,
             ciphertext            BLOB NOT NULL,
             key_version           INTEGER NOT NULL DEFAULT 0,
             created_at            INTEGER NOT NULL,
             updated_at            INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS vault_external_sources (
             id                  TEXT PRIMARY KEY,
             store_id            TEXT NOT NULL,
             environment         TEXT NOT NULL,
             path                TEXT NOT NULL,
             remote_path         TEXT NOT NULL DEFAULT '',
             mode                TEXT NOT NULL,
             scope_id            TEXT NOT NULL,
             cache_ttl_secs      INTEGER NOT NULL,
             stale_if_error_secs INTEGER NOT NULL DEFAULT 0,
             sync_interval_secs  INTEGER NOT NULL,
             last_sync_at        INTEGER,
             last_status         TEXT,
             last_error          TEXT,
             last_count          INTEGER NOT NULL DEFAULT 0,
             created_at          INTEGER NOT NULL,
             UNIQUE (scope_id, environment, path)
         );
         CREATE TABLE IF NOT EXISTS vault_external_destinations (
             id            TEXT PRIMARY KEY,
             store_id      TEXT NOT NULL,
             environment   TEXT NOT NULL,
             path          TEXT NOT NULL,
             remote_path   TEXT NOT NULL DEFAULT '',
             scope_id      TEXT NOT NULL,
             interval_secs INTEGER NOT NULL,
             dirty         INTEGER NOT NULL DEFAULT 1,
             last_push_at  INTEGER,
             last_status   TEXT,
             last_error    TEXT,
             last_count    INTEGER NOT NULL DEFAULT 0,
             failures      INTEGER NOT NULL DEFAULT 0,
             created_at    INTEGER NOT NULL,
             UNIQUE (store_id, remote_path)
         );",
    )
    .context("initializing external-store schema")
}

// ── Validation ────────────────────────────────────────────────────────────

/// Store names: `^[a-z0-9][a-z0-9_-]{0,63}$`.
pub fn is_valid_store_name(name: &str) -> bool {
    super::transit::is_valid_key_name(name)
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

fn bounded(value: Option<String>, field: &str) -> Result<Option<String>> {
    match value.map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
        Some(v) if v.len() > MAX_FIELD_LEN || v.chars().any(char::is_control) => {
            Err(invalid(format!("`{field}` is invalid")))
        }
        other => Ok(other),
    }
}

/// Normalize a remote path (`a/b`), validating every segment.
fn normalize_remote(value: &str) -> Result<String> {
    client::join_remote_path(&[value])
        .map(|segments| segments.join("/"))
        .map_err(|error| invalid(error.to_string()))
}

fn validate_store(input: StoreInput) -> Result<(StoreRecord, StoreCredentials)> {
    if !is_valid_store_name(&input.name) {
        return Err(invalid("invalid store name"));
    }
    if input.address.len() > MAX_ADDRESS_LEN {
        return Err(invalid("address is too long"));
    }
    let address = net::validate_address(&input.address, net::Egress::from_env())
        .map_err(|error| invalid(error.to_string()))?;
    let infisical = input.kind == StoreKind::Infisical;
    let allowed = if infisical {
        matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::UniversalAuth
        )
    } else {
        matches!(
            input.auth_method,
            AuthMethod::Token | AuthMethod::Approle | AuthMethod::Kubernetes
        )
    };
    if !allowed {
        return Err(invalid(format!(
            "{} does not support {} auth",
            input.kind.as_str(),
            input.auth_method.as_str()
        )));
    }
    let credentials = input.credentials;
    let complete = match input.auth_method {
        AuthMethod::Token => filled(&credentials.token),
        AuthMethod::Approle => filled(&credentials.role_id) && filled(&credentials.secret_id),
        AuthMethod::UniversalAuth => {
            filled(&credentials.client_id) && filled(&credentials.client_secret)
        }
        AuthMethod::Kubernetes => filled(&input.role),
    };
    if !complete {
        return Err(invalid(format!(
            "{} auth is missing its credentials",
            input.auth_method.as_str()
        )));
    }
    if filled(&input.jwt_path) {
        return Err(invalid(format!(
            "`jwtPath` is not accepted; set {} on the Core host instead",
            client::ENV_K8S_JWT_PATH
        )));
    }
    let namespace = bounded(input.namespace, "namespace")?;
    if let Some(ns) = &namespace {
        normalize_remote(ns)?;
    }
    let auth_mount = bounded(input.auth_mount, "authMount")?
        .map(|mount| normalize_remote(&mount))
        .transpose()?;
    let kv_version = input.kv_version.unwrap_or(2);
    if !matches!(kv_version, 1 | 2) {
        return Err(invalid("`kvVersion` must be 1 or 2"));
    }
    let mount = normalize_remote(input.mount.as_deref().unwrap_or("secret"))?;
    if !infisical && mount.is_empty() {
        return Err(invalid("`mount` is required"));
    }
    let project_id = bounded(input.project_id, "projectId")?.unwrap_or_default();
    let infisical_environment =
        bounded(input.infisical_environment, "infisicalEnvironment")?.unwrap_or_default();
    if infisical && (project_id.is_empty() || infisical_environment.is_empty()) {
        return Err(invalid(
            "Infisical stores need `projectId` and `infisicalEnvironment`",
        ));
    }
    let now = now_millis();
    Ok((
        StoreRecord {
            id: format!("xs_{}", uuid::Uuid::new_v4().simple()),
            name: input.name,
            kind: input.kind,
            address: address.as_str().trim_end_matches('/').to_owned(),
            namespace,
            auth_method: input.auth_method,
            auth_mount,
            role: bounded(input.role, "role")?,
            mount,
            path_prefix: normalize_remote(input.path_prefix.as_deref().unwrap_or(""))?,
            kv_version,
            project_id,
            infisical_environment,
            secret_path: normalize_remote(input.secret_path.as_deref().unwrap_or("/"))?,
            created_at: now,
            updated_at: now,
        },
        credentials,
    ))
}

fn folder(environment: &str, path: &str) -> Result<(String, String)> {
    if !is_valid_environment(environment) {
        return Err(invalid("invalid environment"));
    }
    let path = normalize_path(path).ok_or_else(|| invalid("invalid folder path"))?;
    Ok((environment.to_owned(), path))
}

fn in_range(value: Option<i64>, default: i64, min: i64, max: i64, field: &str) -> Result<i64> {
    let value = value.unwrap_or(default);
    if value < min || value > max {
        return Err(invalid(format!(
            "`{field}` must be between {min} and {max}"
        )));
    }
    Ok(value)
}

// ── Rows ──────────────────────────────────────────────────────────────────

const STORE_COLUMNS: &str = "id, name, kind, address, namespace, auth_method, auth_mount, role,
    mount, path_prefix, kv_version, project_id, infisical_environment, secret_path,
    created_at, updated_at";

fn store_from_row(row: &Row<'_>) -> rusqlite::Result<Option<StoreRecord>> {
    let (Some(kind), Some(auth_method)) = (
        StoreKind::parse(&row.get::<_, String>(2)?),
        AuthMethod::parse(&row.get::<_, String>(5)?),
    ) else {
        return Ok(None);
    };
    Ok(Some(StoreRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        kind,
        address: row.get(3)?,
        namespace: row.get(4)?,
        auth_method,
        auth_mount: row.get(6)?,
        role: row.get(7)?,
        mount: row.get(8)?,
        path_prefix: row.get(9)?,
        kv_version: row.get(10)?,
        project_id: row.get(11)?,
        infisical_environment: row.get(12)?,
        secret_path: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    }))
}

const SOURCE_COLUMNS: &str = "id, store_id, environment, path, remote_path, mode, scope_id,
    cache_ttl_secs, stale_if_error_secs, sync_interval_secs, last_sync_at, last_status,
    last_error, last_count, created_at";

fn source_from_row(row: &Row<'_>) -> rusqlite::Result<SourceRecord> {
    let mode: String = row.get(5)?;
    Ok(SourceRecord {
        id: row.get(0)?,
        store_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        remote_path: row.get(4)?,
        mode: if mode == "sync" {
            SourceMode::Sync
        } else {
            SourceMode::Live
        },
        scope_id: row.get(6)?,
        cache_ttl_secs: row.get(7)?,
        stale_if_error_secs: row.get(8)?,
        sync_interval_secs: row.get(9)?,
        last_sync_at: row.get(10)?,
        last_status: row.get(11)?,
        last_error: row.get(12)?,
        last_count: row.get(13)?,
        created_at: row.get(14)?,
    })
}

const DESTINATION_COLUMNS: &str = "id, store_id, environment, path, remote_path, scope_id,
    interval_secs, dirty, last_push_at, last_status, last_error, last_count, created_at,
    failures";

fn destination_from_row(row: &Row<'_>) -> rusqlite::Result<DestinationRecord> {
    Ok(DestinationRecord {
        id: row.get(0)?,
        store_id: row.get(1)?,
        environment: row.get(2)?,
        path: row.get(3)?,
        remote_path: row.get(4)?,
        scope_id: row.get(5)?,
        interval_secs: row.get(6)?,
        dirty: row.get::<_, i64>(7)? != 0,
        last_push_at: row.get(8)?,
        last_status: row.get(9)?,
        last_error: row.get(10)?,
        last_count: row.get(11)?,
        created_at: row.get(12)?,
        failures: row.get(13)?,
    })
}

/// Milliseconds to wait before retrying a destination after `failures`
/// consecutive failures: one loop tick, doubling, capped at its interval.
fn retry_backoff_ms(failures: i64, interval_secs: i64) -> i64 {
    let tick_ms = LOOP_TICK.as_millis() as i64;
    let exponent = (failures - 1).clamp(0, 20) as u32;
    tick_ms
        .saturating_mul(1_i64 << exponent)
        .min(interval_secs.saturating_mul(1000))
}

/// Whether the loop should push `destination` at `now`.
fn destination_due(destination: &DestinationRecord, now: i64) -> bool {
    let Some(at) = destination.last_push_at else {
        return true;
    };
    let elapsed = now - at;
    if destination.failures > 0 {
        return elapsed >= retry_backoff_ms(destination.failures, destination.interval_secs);
    }
    destination.dirty || elapsed >= destination.interval_secs * 1000
}

fn store_locked(conn: &Connection, id: &str) -> Result<StoreRecord> {
    conn.query_row(
        &format!("SELECT {STORE_COLUMNS} FROM vault_external_stores WHERE id = ?1"),
        params![id],
        store_from_row,
    )
    .optional()?
    .flatten()
    .ok_or_else(|| VaultError::NotFound(format!("external store `{id}`")).into())
}

fn source_locked(conn: &Connection, id: &str) -> Result<SourceRecord> {
    conn.query_row(
        &format!("SELECT {SOURCE_COLUMNS} FROM vault_external_sources WHERE id = ?1"),
        params![id],
        source_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("external source `{id}`")).into())
}

fn destination_locked(conn: &Connection, id: &str) -> Result<DestinationRecord> {
    conn.query_row(
        &format!("SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations WHERE id = ?1"),
        params![id],
        destination_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("external destination `{id}`")).into())
}

fn collect<T>(
    conn: &Connection,
    sql: &str,
    map: impl FnMut(&Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([], map)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ── Write hooks (called from the key/value engine) ─────────────────────────

/// Refuse a local node-scope change in a folder that an external store owns.
/// Called inside the write transaction; sync writes pass `External` and skip it.
pub(crate) fn guard_local_write(conn: &Connection, coords: &SecretCoords) -> Result<()> {
    if coords.scope != SecretScope::Node {
        return Ok(());
    }
    let store: Option<String> = conn
        .query_row(
            "SELECT s.name FROM vault_external_sources src
             JOIN vault_external_stores s ON s.id = src.store_id
             WHERE src.environment = ?1 AND src.path = ?2 AND src.scope_id = ?3",
            params![coords.environment, coords.path, coords.scope_id],
            |row| row.get(0),
        )
        .optional()?;
    match store {
        Some(name) => Err(VaultError::Conflict(format!(
            "folder `{}:{}` is sourced from external store `{name}`; change the value there",
            coords.environment, coords.path
        ))
        .into()),
        None => Ok(()),
    }
}

/// Flag destinations that push `coords`' folder so the loop re-pushes it.
pub(crate) fn mark_dirty(conn: &Connection, coords: &SecretCoords) -> Result<()> {
    if coords.scope != SecretScope::Node || coords.binding.is_some() {
        return Ok(());
    }
    let changed = conn.execute(
        "UPDATE vault_external_destinations SET dirty = 1
         WHERE environment = ?1 AND path = ?2 AND scope_id = ?3",
        params![coords.environment, coords.path, coords.scope_id],
    )?;
    if changed > 0 {
        WAKE.notify_one();
    }
    Ok(())
}

// ── Live cache ────────────────────────────────────────────────────────────

struct CacheEntry {
    fetched: Instant,
    folder: RemoteFolder,
}

static LIVE_CACHE: LazyLock<Mutex<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static WAKE: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
/// One lock per source id, held for a whole sync (remote read through the
/// last local write), so a scheduled and a manual sync of the same source
/// apply their snapshots one after the other instead of interleaving writes
/// from two different remote reads.
static SOURCE_SYNC_LOCKS: LazyLock<Mutex<HashMap<String, SourceSyncLock>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

type SourceSyncLock = std::sync::Arc<tokio::sync::Mutex<()>>;

fn source_sync_lock(id: &str) -> SourceSyncLock {
    let mut locks = SOURCE_SYNC_LOCKS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    // Drop locks nobody holds or waits on, so the map tracks only live syncs.
    locks.retain(|_, lock| std::sync::Arc::strong_count(lock) > 1);
    locks.entry(id.to_owned()).or_default().clone()
}

fn cache_get(source_id: &str, max_age: Duration) -> Option<RemoteFolder> {
    let guard = LIVE_CACHE.lock().ok()?;
    let entry = guard.get(source_id)?;
    (entry.fetched.elapsed() <= max_age).then(|| entry.folder.clone())
}

fn cache_put(source_id: &str, folder: RemoteFolder) {
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        guard.insert(
            source_id.to_owned(),
            CacheEntry {
                fetched: Instant::now(),
                folder,
            },
        );
    }
}

/// Make a cached answer look `by` older (TTL and stale-window tests).
#[cfg(test)]
pub(crate) fn age_cache(source_id: &str, by: Duration) {
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        if let Some(entry) = guard.get_mut(source_id) {
            entry.fetched = entry.fetched.checked_sub(by).unwrap_or(entry.fetched);
        }
    }
}

fn cache_drop(source_id: &str) {
    if let Ok(mut guard) = LIVE_CACHE.lock() {
        guard.remove(source_id);
    }
}

fn secs(value: i64) -> Duration {
    Duration::from_secs(value.max(0) as u64)
}

fn lookup(folder: &RemoteFolder, name: &str) -> LiveLookup {
    match folder.values.get(name) {
        Some(value) if !value.trim().is_empty() => LiveLookup::Found {
            value: value.clone(),
            version: folder.version.unwrap_or(0),
        },
        _ => LiveLookup::Missing,
    }
}

fn short_error(error: &anyhow::Error) -> String {
    let mut text = format!("{error:#}");
    text.truncate(300);
    text
}

impl PluginSecretStore {
    // ── Stores ────────────────────────────────────────────────────────────

    /// Create a store; credentials are sealed with the keyring.
    pub async fn external_store_create(
        &self,
        input: StoreInput,
        actor: &AuditActor,
    ) -> Result<StoreRecord> {
        let (record, credentials) = validate_store(input)?;
        let sealed = serde_json::to_vec(&credentials)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&sealed)?;
        let conn = self.conn.lock().await;
        let exists: bool = conn
            .query_row(
                "SELECT 1 FROM vault_external_stores WHERE name = ?1",
                params![record.name],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        if exists {
            return Err(
                VaultError::Conflict(format!("external store `{}` exists", record.name)).into(),
            );
        }
        conn.execute(
            "INSERT INTO vault_external_stores
                (id, name, kind, address, namespace, auth_method, auth_mount, role,
                 mount, path_prefix, kv_version, project_id, infisical_environment, secret_path,
                 nonce, ciphertext, key_version, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16,
                     ?17, ?18, ?18)",
            params![
                record.id,
                record.name,
                record.kind.as_str(),
                record.address,
                record.namespace,
                record.auth_method.as_str(),
                record.auth_mount,
                record.role,
                record.mount,
                record.path_prefix,
                record.kv_version,
                record.project_id,
                record.infisical_environment,
                record.secret_path,
                nonce,
                ciphertext,
                key_version,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.store.create", "ok").details(json!({
                "store": record.name, "kind": record.kind.as_str(),
                "authMethod": record.auth_method.as_str(),
            })),
        );
        Ok(record)
    }

    /// Every store (no credentials).
    pub async fn external_store_list(&self) -> Result<Vec<StoreRecord>> {
        let conn = self.conn.lock().await;
        let rows = collect(
            &conn,
            &format!("SELECT {STORE_COLUMNS} FROM vault_external_stores ORDER BY name"),
            store_from_row,
        )?;
        Ok(rows.into_iter().flatten().collect())
    }

    /// One store (no credentials).
    pub async fn external_store(&self, id: &str) -> Result<StoreRecord> {
        let conn = self.conn.lock().await;
        store_locked(&conn, id)
    }

    /// Delete a store that no source or destination uses.
    pub async fn external_store_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let record = store_locked(&conn, id)?;
        let users: i64 = conn.query_row(
            "SELECT (SELECT COUNT(*) FROM vault_external_sources WHERE store_id = ?1)
                  + (SELECT COUNT(*) FROM vault_external_destinations WHERE store_id = ?1)",
            params![id],
            |row| row.get(0),
        )?;
        if users > 0 {
            return Err(VaultError::Conflict(format!(
                "external store `{}` still has sources or destinations",
                record.name
            ))
            .into());
        }
        conn.execute(
            "DELETE FROM vault_external_stores WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.store.delete", "ok")
                .details(json!({ "store": record.name })),
        );
        Ok(())
    }

    /// The store and its unsealed credentials.
    async fn external_connection(&self, store_id: &str) -> Result<(StoreRecord, StoreCredentials)> {
        if self.keyring.is_sealed() {
            return Err(VaultError::Sealed.into());
        }
        let conn = self.conn.lock().await;
        let record = store_locked(&conn, store_id)?;
        let (key_version, nonce, ciphertext): (u32, Vec<u8>, Vec<u8>) = conn.query_row(
            "SELECT key_version, nonce, ciphertext FROM vault_external_stores WHERE id = ?1",
            params![store_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        let credentials: StoreCredentials =
            serde_json::from_slice(&plain).context("store credentials are malformed")?;
        Ok((record, credentials))
    }

    async fn external_read(&self, store_id: &str, remote_path: &str) -> Result<RemoteFolder> {
        let (record, credentials) = self.external_connection(store_id).await?;
        let session = Session::connect(&record, &credentials).await?;
        session.read(remote_path).await
    }

    /// Log in to a store (and, for KV token auth, look the token up) to check
    /// connectivity and credentials. Never returns a value.
    pub async fn external_store_test(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let result = async {
            let (record, credentials) = self.external_connection(id).await?;
            Session::connect(&record, &credentials).await?.check().await
        }
        .await;
        let outcome = if result.is_ok() { "ok" } else { "error" };
        self.audit(
            &AuditEntry::new(actor, "external.store.test", outcome).details(json!({ "store": id })),
        )
        .await;
        result
    }

    // ── Sources ───────────────────────────────────────────────────────────

    /// Bind a folder to a remote path at node scope `scope_id`.
    pub async fn external_source_create(
        &self,
        input: SourceInput,
        scope_id: &str,
        actor: &AuditActor,
    ) -> Result<SourceRecord> {
        let (environment, path) = folder(&input.environment, &input.path)?;
        let remote_path = normalize_remote(&input.remote_path)?;
        let cache_ttl_secs = in_range(
            input.cache_ttl_secs,
            DEFAULT_CACHE_TTL_SECS,
            MIN_CACHE_TTL_SECS,
            MAX_CACHE_TTL_SECS,
            "cacheTtlSecs",
        )?;
        let stale_if_error_secs = in_range(
            input.stale_if_error_secs,
            0,
            0,
            MAX_STALE_IF_ERROR_SECS,
            "staleIfErrorSecs",
        )?;
        let sync_interval_secs = in_range(
            input.sync_interval_secs,
            DEFAULT_SYNC_INTERVAL_SECS,
            MIN_SYNC_INTERVAL_SECS,
            MAX_INTERVAL_SECS,
            "syncIntervalSecs",
        )?;
        let conn = self.conn.lock().await;
        let store = store_locked(&conn, &input.store_id)?;
        let clash: Option<String> = conn
            .query_row(
                "SELECT 'folder' FROM vault_external_sources
                 WHERE scope_id = ?5 AND environment = ?1 AND path = ?2
                 UNION ALL
                 SELECT 'push' FROM vault_external_destinations
                 WHERE store_id = ?3 AND remote_path = ?4
                 UNION ALL
                 SELECT 'pushed' FROM vault_external_destinations
                 WHERE ?6 = 'live' AND scope_id = ?5 AND environment = ?1 AND path = ?2
                 LIMIT 1",
                params![
                    environment,
                    path,
                    store.id,
                    remote_path,
                    scope_id,
                    input.mode.as_str()
                ],
                |row| row.get(0),
            )
            .optional()?;
        match clash.as_deref() {
            Some("folder") => {
                return Err(VaultError::Conflict(format!(
                    "folder `{environment}:{path}` already has a source"
                ))
                .into())
            }
            Some("pushed") => {
                return Err(VaultError::Conflict(format!(
                    "folder `{environment}:{path}` is pushed to a destination; a live source \
                     would leave the push with no values (use sync mode)"
                ))
                .into())
            }
            Some(_) => {
                return Err(VaultError::Conflict(
                    "that remote path is a push destination; pulling it would loop".into(),
                )
                .into())
            }
            None => {}
        }
        let record = SourceRecord {
            id: format!("xsrc_{}", uuid::Uuid::new_v4().simple()),
            store_id: store.id.clone(),
            environment,
            path,
            remote_path,
            mode: input.mode,
            scope_id: scope_id.to_owned(),
            cache_ttl_secs,
            stale_if_error_secs,
            sync_interval_secs,
            last_sync_at: None,
            last_status: None,
            last_error: None,
            last_count: 0,
            created_at: now_millis(),
        };
        conn.execute(
            "INSERT INTO vault_external_sources
                (id, store_id, environment, path, remote_path, mode, scope_id, cache_ttl_secs,
                 stale_if_error_secs, sync_interval_secs, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                record.id,
                record.store_id,
                record.environment,
                record.path,
                record.remote_path,
                record.mode.as_str(),
                record.scope_id,
                record.cache_ttl_secs,
                record.stale_if_error_secs,
                record.sync_interval_secs,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.source.create", "ok").details(json!({
                "store": store.name, "source": record.id, "mode": record.mode.as_str(),
                "environment": record.environment, "path": record.path,
            })),
        );
        if record.mode == SourceMode::Sync {
            WAKE.notify_one();
        }
        Ok(record)
    }

    /// Every source.
    pub async fn external_source_list(&self) -> Result<Vec<SourceRecord>> {
        let conn = self.conn.lock().await;
        collect(
            &conn,
            &format!(
                "SELECT {SOURCE_COLUMNS} FROM vault_external_sources ORDER BY environment, path"
            ),
            source_from_row,
        )
    }

    /// One source.
    pub async fn external_source(&self, id: &str) -> Result<SourceRecord> {
        let conn = self.conn.lock().await;
        source_locked(&conn, id)
    }

    /// Unbind a folder. Values a sync already copied stay as ordinary local
    /// values (writable again).
    pub async fn external_source_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let record = source_locked(&conn, id)?;
        conn.execute(
            "DELETE FROM vault_external_sources WHERE id = ?1",
            params![id],
        )?;
        cache_drop(id);
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.source.delete", "ok").details(json!({
                "source": id, "environment": record.environment, "path": record.path,
            })),
        );
        Ok(())
    }

    fn record_source_status(
        conn: &Connection,
        id: &str,
        result: &Result<usize>,
    ) -> rusqlite::Result<usize> {
        let (status, error, count) = match result {
            Ok(count) => ("ok", None, *count as i64),
            Err(error) => ("error", Some(short_error(error)), 0),
        };
        conn.execute(
            "UPDATE vault_external_sources
             SET last_sync_at = ?1, last_status = ?2, last_error = ?3,
                 last_count = CASE WHEN ?2 = 'ok' THEN ?4 ELSE last_count END
             WHERE id = ?5",
            params![now_millis(), status, error, count, id],
        )
    }

    /// Resolve `name` through a live source on `(environment, path)` at node
    /// scope `scope_id`. Fails closed when the store is unreachable.
    pub(crate) async fn external_live_lookup(
        &self,
        scope_id: &str,
        environment: &str,
        path: &str,
        name: &str,
    ) -> Result<LiveLookup> {
        let source = {
            let conn = self.conn.lock().await;
            conn.query_row(
                &format!(
                    "SELECT {SOURCE_COLUMNS} FROM vault_external_sources
                     WHERE environment = ?1 AND path = ?2 AND mode = 'live' AND scope_id = ?3"
                ),
                params![environment, path, scope_id],
                source_from_row,
            )
            .optional()?
        };
        let Some(source) = source else {
            return Ok(LiveLookup::NotSourced);
        };
        if self.keyring.is_sealed() {
            return Ok(LiveLookup::Unavailable);
        }
        if let Some(folder) = cache_get(&source.id, secs(source.cache_ttl_secs)) {
            return Ok(lookup(&folder, name));
        }
        let fetched = self
            .external_read(&source.store_id, &source.remote_path)
            .await;
        {
            let conn = self.conn.lock().await;
            let status = fetched
                .as_ref()
                .map(|f| f.values.len())
                .map_err(|e| anyhow!("{e:#}"));
            Self::record_source_status(&conn, &source.id, &status)?;
        }
        match fetched {
            Ok(folder) => {
                let found = lookup(&folder, name);
                cache_put(&source.id, folder);
                Ok(found)
            }
            Err(error) => {
                tracing::warn!(
                    source = source.id,
                    "external store read failed: {}",
                    short_error(&error)
                );
                let stale_window = secs(source.cache_ttl_secs + source.stale_if_error_secs);
                match (source.stale_if_error_secs > 0)
                    .then(|| cache_get(&source.id, stale_window))
                    .flatten()
                {
                    Some(folder) => Ok(lookup(&folder, name)),
                    None => Ok(LiveLookup::Unavailable),
                }
            }
        }
    }

    /// Run one source now: a sync source copies the remote folder into local
    /// versions; a live source refreshes its cache.
    pub async fn external_sync_source(&self, id: &str, actor: &AuditActor) -> Result<SyncReport> {
        let lock = source_sync_lock(id);
        let _serialized = lock.lock().await;
        let source = self.external_source(id).await?;
        let result = self.sync_source_inner(&source, actor).await;
        let counted = result
            .as_ref()
            .map(|report| report.written + report.unchanged)
            .map_err(|error| anyhow!("{error:#}"));
        let conn = self.conn.lock().await;
        Self::record_source_status(&conn, id, &counted)?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                "external.sync",
                if result.is_ok() { "ok" } else { "error" },
            )
            .details(json!({
                "source": id, "environment": source.environment, "path": source.path,
                "report": result.as_ref().ok(),
            })),
        );
        result
    }

    async fn sync_source_inner(
        &self,
        source: &SourceRecord,
        actor: &AuditActor,
    ) -> Result<SyncReport> {
        let remote = self
            .external_read(&source.store_id, &source.remote_path)
            .await?;
        if source.mode == SourceMode::Live {
            let report = SyncReport {
                unchanged: remote.values.len(),
                ..SyncReport::default()
            };
            cache_put(&source.id, remote);
            return Ok(report);
        }
        // Validate everything before writing anything: one bad key aborts.
        for (key, value) in &remote.values {
            if !is_valid_vault_secret_name(key) {
                bail!("remote key `{key}` is not a valid secret name; sync aborted");
            }
            if value.trim().is_empty() || value.len() > MAX_VAULT_SECRET_VALUE_LEN {
                bail!("remote key `{key}` is empty or too large; sync aborted");
            }
        }
        let local: BTreeMap<String, String> = self
            .current_values(&ListFilter {
                environment: Some(source.environment.clone()),
                path: Some(source.path.clone()),
                recursive: false,
                include_deleted: false,
            })
            .await?
            .into_iter()
            .filter(|(info, _)| {
                info.scope == SecretScope::Node
                    && info.scope_id == source.scope_id
                    && info.binding.is_none()
                    && info.environment == source.environment
                    && info.path == source.path
                    && info.status(now_millis()) != SecretStatus::Deleted
            })
            .map(|(info, value)| (info.name, value))
            .collect();
        let mut report = SyncReport::default();
        for (key, value) in &remote.values {
            if local.get(key) == Some(value) {
                report.unchanged += 1;
                continue;
            }
            self.write_secret(WriteRequest {
                coords: self.sourced_coords(source, key),
                value: Some(value),
                patch: SecretMetadataPatch::default(),
                actor,
                source: VersionSource::External,
                expected_version: None,
            })
            .await?;
            report.written += 1;
        }
        let conn = self.conn.lock().await;
        for key in local.keys().filter(|key| !remote.values.contains_key(*key)) {
            let coords = self.sourced_coords(source, key);
            let removed = conn.execute(
                "UPDATE vault_secrets SET deleted_at = ?1, deleted_by = 'external'
                 WHERE scope = 'node' AND scope_id = ?2 AND environment = ?3 AND path = ?4
                   AND binding_kind = '' AND binding_id = '' AND name = ?5
                   AND deleted_at IS NULL",
                params![
                    now_millis(),
                    coords.scope_id,
                    coords.environment,
                    coords.path,
                    coords.name
                ],
            )?;
            if removed > 0 {
                report.removed += 1;
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(actor, "secret.delete", "ok")
                        .secret(
                            "node",
                            &coords.scope_id,
                            &coords.environment,
                            &coords.path,
                            &coords.name,
                        )
                        .details(json!({ "source": "external" })),
                );
                mark_dirty(&conn, &coords)?;
            }
        }
        Ok(report)
    }

    fn sourced_coords(&self, source: &SourceRecord, name: &str) -> SecretCoords {
        SecretCoords {
            scope: SecretScope::Node,
            scope_id: source.scope_id.clone(),
            environment: source.environment.clone(),
            path: source.path.clone(),
            binding: None,
            name: name.to_owned(),
        }
    }

    // ── Destinations ──────────────────────────────────────────────────────

    /// Push a node folder one-way to a remote path.
    pub async fn external_destination_create(
        &self,
        input: DestinationInput,
        scope_id: &str,
        actor: &AuditActor,
    ) -> Result<DestinationRecord> {
        let (environment, path) = folder(&input.environment, &input.path)?;
        let remote_path = normalize_remote(&input.remote_path)?;
        let interval_secs = in_range(
            input.interval_secs,
            DEFAULT_PUSH_INTERVAL_SECS,
            MIN_PUSH_INTERVAL_SECS,
            MAX_INTERVAL_SECS,
            "intervalSecs",
        )?;
        let conn = self.conn.lock().await;
        let store = store_locked(&conn, &input.store_id)?;
        if store.kind != StoreKind::Infisical
            && remote_path.is_empty()
            && store.path_prefix.is_empty()
        {
            return Err(invalid("a KV destination needs a `remotePath`"));
        }
        let clash: Option<String> = conn
            .query_row(
                "SELECT 'source' FROM vault_external_sources WHERE store_id = ?1 AND remote_path = ?2
                 UNION ALL
                 SELECT 'push' FROM vault_external_destinations
                 WHERE store_id = ?1 AND remote_path = ?2
                 UNION ALL
                 SELECT 'live' FROM vault_external_sources
                 WHERE mode = 'live' AND scope_id = ?3 AND environment = ?4 AND path = ?5
                 LIMIT 1",
                params![store.id, remote_path, scope_id, environment, path],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(kind) = clash {
            let message = match kind.as_str() {
                "source" => "that remote path is pulled by a source; pushing to it would loop",
                "live" => {
                    "that folder has a live source, so it holds no local values to push; \
                     use a sync source or push from the store itself"
                }
                _ => "that remote path already has a destination",
            };
            return Err(VaultError::Conflict(message.into()).into());
        }
        let record = DestinationRecord {
            id: format!("xdst_{}", uuid::Uuid::new_v4().simple()),
            store_id: store.id.clone(),
            environment,
            path,
            remote_path,
            scope_id: scope_id.to_owned(),
            interval_secs,
            dirty: true,
            last_push_at: None,
            last_status: None,
            last_error: None,
            last_count: 0,
            failures: 0,
            created_at: now_millis(),
        };
        conn.execute(
            "INSERT INTO vault_external_destinations
                (id, store_id, environment, path, remote_path, scope_id, interval_secs, dirty,
                 created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8)",
            params![
                record.id,
                record.store_id,
                record.environment,
                record.path,
                record.remote_path,
                record.scope_id,
                record.interval_secs,
                record.created_at
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.destination.create", "ok").details(json!({
                "store": store.name, "destination": record.id,
                "environment": record.environment, "path": record.path,
            })),
        );
        WAKE.notify_one();
        Ok(record)
    }

    /// Every destination.
    pub async fn external_destination_list(&self) -> Result<Vec<DestinationRecord>> {
        let conn = self.conn.lock().await;
        collect(
            &conn,
            &format!(
                "SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations
                 ORDER BY environment, path"
            ),
            destination_from_row,
        )
    }

    /// Stop pushing a folder (remote values are left in place).
    pub async fn external_destination_delete(&self, id: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        destination_locked(&conn, id)?;
        conn.execute(
            "DELETE FROM vault_external_destinations WHERE id = ?1",
            params![id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.destination.delete", "ok")
                .details(json!({ "destination": id })),
        );
        Ok(())
    }

    /// Push one destination now. Returns how many keys were pushed.
    pub async fn external_push(&self, id: &str, actor: &AuditActor) -> Result<usize> {
        let destination = {
            let conn = self.conn.lock().await;
            let destination = destination_locked(&conn, id)?;
            // Clear first: a write landing during the push re-flags it.
            conn.execute(
                "UPDATE vault_external_destinations SET dirty = 0 WHERE id = ?1",
                params![id],
            )?;
            destination
        };
        let result = self.push_inner(&destination).await;
        let conn = self.conn.lock().await;
        let (status, error, count) = match &result {
            Ok(count) => ("ok", None, *count as i64),
            Err(error) => ("error", Some(short_error(error)), 0),
        };
        conn.execute(
            "UPDATE vault_external_destinations
             SET last_push_at = ?1, last_status = ?2, last_error = ?3,
                 last_count = CASE WHEN ?2 = 'ok' THEN ?4 ELSE last_count END,
                 dirty = CASE WHEN ?2 = 'ok' THEN dirty ELSE 1 END,
                 failures = CASE WHEN ?2 = 'ok' THEN 0 ELSE failures + 1 END
             WHERE id = ?5",
            params![now_millis(), status, error, count, id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "external.push", status).details(json!({
                "destination": id, "environment": destination.environment,
                "path": destination.path, "count": count,
            })),
        );
        result
    }

    async fn push_inner(&self, destination: &DestinationRecord) -> Result<usize> {
        let now = now_millis();
        // A push runs unattended for no single caller, so a value that a
        // control group gates for anyone stays local (like exports).
        let policies = {
            let conn = self.conn.lock().await;
            super::policy::list_policies(&conn)?
        };
        let values: BTreeMap<String, String> = self
            .current_values(&ListFilter {
                environment: Some(destination.environment.clone()),
                path: Some(destination.path.clone()),
                recursive: false,
                include_deleted: false,
            })
            .await?
            .into_iter()
            .filter(|(info, _)| {
                info.scope == SecretScope::Node
                    && info.scope_id == destination.scope_id
                    && info.binding.is_none()
                    && info.environment == destination.environment
                    && info.path == destination.path
                    && matches!(
                        info.status(now),
                        SecretStatus::Active | SecretStatus::RotationDue
                    )
                    && !super::policy_ext::read_gated_for_anyone(
                        &policies,
                        &info.coords().policy_key(),
                    )
            })
            .map(|(info, value)| (info.name, value))
            .collect();
        let (record, credentials) = self.external_connection(&destination.store_id).await?;
        let session = Session::connect(&record, &credentials).await?;
        // A KV write replaces the whole secret (v1 keeps no history): never let
        // an empty folder (a typo'd path, a cleared folder) wipe remote data.
        if values.is_empty() && record.kind != StoreKind::Infisical {
            let remote = session.read(&destination.remote_path).await?;
            if !remote.values.is_empty() {
                bail!(
                    "the folder is empty and the remote secret is not; refusing to wipe it \
                     (delete it in the store, or delete this destination)"
                );
            }
            return Ok(0);
        }
        session.write(&destination.remote_path, &values).await?;
        Ok(values.len())
    }

    // ── Scheduler ─────────────────────────────────────────────────────────

    /// One loop pass: run due sync sources and dirty or due destinations.
    pub async fn external_tick(&self) -> TickReport {
        let mut report = TickReport::default();
        if self.keyring.is_sealed() {
            return report;
        }
        let now = now_millis();
        let (sources, destinations) = {
            let conn = self.conn.lock().await;
            let sources = collect(
                &conn,
                &format!("SELECT {SOURCE_COLUMNS} FROM vault_external_sources WHERE mode = 'sync'"),
                source_from_row,
            );
            let destinations = collect(
                &conn,
                &format!("SELECT {DESTINATION_COLUMNS} FROM vault_external_destinations"),
                destination_from_row,
            );
            (
                sources.unwrap_or_default(),
                destinations.unwrap_or_default(),
            )
        };
        let actor = AuditActor::new("system", Some("external-store"));
        for source in sources.iter().filter(|source| {
            source
                .last_sync_at
                .is_none_or(|at| now - at >= source.sync_interval_secs * 1000)
        }) {
            match self.external_sync_source(&source.id, &actor).await {
                Ok(_) => report.synced += 1,
                Err(_) => report.failed += 1,
            }
        }
        for destination in destinations
            .iter()
            .filter(|destination| destination_due(destination, now))
        {
            match self.external_push(&destination.id, &actor).await {
                Ok(_) => report.pushed += 1,
                Err(_) => report.failed += 1,
            }
        }
        report
    }
}

/// Start the external-store loop for the process-global store. It wakes every
/// [`LOOP_TICK`] and immediately after a write into a pushed folder.
pub fn spawn(store: &'static PluginSecretStore) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(LOOP_TICK);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                () = WAKE.notified() => {}
            }
            let report = store.external_tick().await;
            if report != TickReport::default() {
                tracing::info!(?report, "vault external stores");
            }
        }
    });
}
