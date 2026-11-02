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
pub mod k8s_origin;
pub mod net;

mod destinations;
mod live_cache;
mod records;
mod sources;
mod stores;
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

#[cfg(test)]
pub(crate) use live_cache::age_cache;
use live_cache::*;
pub(crate) use live_cache::{guard_local_write, mark_dirty};
pub use records::init_schema;
use records::*;

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
