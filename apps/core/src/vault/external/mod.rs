//! External secret stores: OpenBao, HashiCorp Vault, and Infisical, plus
//! push-only secret-sync targets (GitHub Actions, Vercel, AWS Secrets Manager,
//! Google Cloud Secret Manager; see [`targets`]).
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
pub mod targets;

#[cfg(test)]
mod schema_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod types_tests;
#[cfg(test)]
mod validate_tests;

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

mod destinations;
mod hooks;
mod scheduler;
mod schema;
mod sources;
mod stores;
mod types;
mod validate;

use client::{RemoteFolder, Session};
#[cfg(test)]
pub(crate) use hooks::age_cache;
use hooks::*;
pub(crate) use hooks::{guard_local_write, mark_dirty};
pub use scheduler::spawn;
pub use schema::init_schema;
use schema::*;
pub use types::*;
use validate::*;

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
