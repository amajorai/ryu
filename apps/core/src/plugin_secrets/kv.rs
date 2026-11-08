//! Versioned key/value engine for user-managed vault values.
//!
//! A value is identified by `(scope, scope_id, environment, path, binding,
//! name)` ([`SecretCoords`]). Every write appends a row to
//! `vault_secret_versions`; the current ciphertext is also kept on the
//! `vault_secrets` row so dispatch-time resolution is one indexed read. Deletes
//! are soft (the row keeps its history and can be restored) until destroyed.
//!
//! KV v2 metadata parity (custom metadata, check-and-set, per-version soft
//! delete, merge patches, subkeys, paginated listing) lives in
//! [`super::kv_meta`].
//!
//! Resolution (`secret:` references) is scope-major: `user > node > team >
//! org`, and inside each scope the folder itself, then its imports in order,
//! with an exact MCP binding before an unbound value. Expired values, deny
//! policies, and a sealed vault all resolve to "absent", never to an error the
//! model could observe. Every resolution, reveal, and mutation is audited
//! without the value.
//!
//! A value's [`ValueType`] decides whether its plaintext may leave the vault:
//! `config` and `secret` values can be revealed and exported with `read`, a
//! `sealed` value resolves like any other but is never revealed or exported,
//! and it stays sealed.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::json;

use super::{
    is_valid_scope_id, is_valid_vault_secret_name, PluginSecretStore, SecretBinding,
    SecretBindingKind, SecretResolutionContext, SecretScope, VaultSecretInfo,
    MAX_VAULT_SECRET_VALUE_LEN,
};
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::policy::{self, Capability, CapabilitySet};
use crate::vault::{
    is_valid_environment, normalize_path, now_millis, policy_key, SecretRef, VaultError,
    DEFAULT_ENVIRONMENT, ROOT_PATH,
};

/// Default and maximum retained versions per value.
pub const DEFAULT_MAX_VERSIONS: u32 = 20;
pub const MAX_MAX_VERSIONS: u32 = 100;
/// Minimum rotation period.
pub const MIN_ROTATION_PERIOD_SECS: i64 = 300;
/// Maximum `${...}` expansion depth.
pub const MAX_REFERENCE_DEPTH: usize = 5;
/// Maximum import chain depth.
pub const MAX_IMPORT_DEPTH: usize = 3;
/// Reference suffix that resolves a stored TOTP seed to its current code.
pub const TOTP_SUFFIX: &str = "#totp";
const MAX_TAGS: usize = 16;
const MAX_TAG_LEN: usize = 32;
const MAX_DESCRIPTION_LEN: usize = 512;
/// `customMetadata` limits (KV v2 `custom_metadata` parity). Custom metadata is
/// never secret: it is returned by every metadata listing.
pub const MAX_CUSTOM_METADATA_KEYS: usize = 64;
pub const MAX_CUSTOM_METADATA_KEY_LEN: usize = 128;
pub const MAX_CUSTOM_METADATA_VALUE_LEN: usize = 512;
/// Bounds for `deleteVersionAfterSecs`: one minute to ten years.
pub const MIN_DELETE_VERSION_AFTER_SECS: i64 = 60;
pub const MAX_DELETE_VERSION_AFTER_SECS: i64 = 10 * 365 * 24 * 3600;

mod coords;
mod environments;
mod kv_folder;
mod metadata;
mod read;
mod resolve;
mod resolve_context;
mod rotation;
mod write;

pub use coords::*;
use environments::*;
pub use kv_folder::*;
pub use metadata::*;
use resolve::*;

#[cfg(test)]
#[path = "kv_tests_audit.rs"]
mod audit_tests;
#[cfg(test)]
#[path = "kv_tests_dispatch.rs"]
mod dispatch_tests;
#[cfg(test)]
mod project_scope_tests;
#[cfg(test)]
#[path = "kv_tests.rs"]
mod tests;
#[cfg(test)]
mod value_type_tests;
