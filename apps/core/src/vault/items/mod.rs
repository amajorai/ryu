//! Typed credential items.
//!
//! A key/value secret holds one opaque string. An item groups the fields of
//! one credential (a login's username, password, and TOTP seed, or an API
//! client's id and secret) under a fixed field schema:
//!
//! * the schema is set when the item is created; existing field definitions
//!   are immutable, and the only change is appending an optional field
//!   ([`PluginSecretStore::item_add_field`]); each field
//!   has a name, an optional label, a type (`text`, `email`, `url`,
//!   `password`, `totp`, `note`), a `required` flag, and a `sensitive` flag
//!   (`password` and `totp` fields are always sensitive);
//! * every field value is sealed separately with the vault keyring, so a
//!   non-sensitive field (a username for prefill) can be returned without
//!   opening the sensitive ones; sensitive values leave the vault only
//!   through an audited reveal;
//! * an item is `pending_collection` until every required field has a value,
//!   then `ready`;
//! * every write bumps a per-item `version`. `PUT` is an idempotent upsert
//!   (created, unchanged, or conflict) and `PATCH` is optimistic: it must name
//!   the item's current `version` and `id`;
//! * an append-only per-item event timeline (names and field names only,
//!   never values) supports an `after` cursor and a bounded long-poll wait.
//!
//! The reserved kind `card` has a fixed payment-card schema, a merchant host
//! allowlist, and per-use spend approvals (see [`cards`]).
//!
//! Items are node-local and authorize against the reserved policy key
//! `sys/items/<environment>/<folder>/<key>` (see [`policy_key`]). Configuration
//! managers and the unbound local operator hold every capability by baseline;
//! anyone else needs a policy.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::{is_valid_environment, normalize_path, now_millis, random_token, VaultError};
use crate::plugin_secrets::PluginSecretStore;

mod add_field;
pub mod cards;
mod model;
mod normalize;
mod put;
mod read;
mod storage;
mod types;
mod write;

pub use model::*;
pub use normalize::*;
pub use storage::*;
pub use types::*;

#[cfg(test)]
mod tests;

/// Maximum number of fields in one item.
pub const MAX_FIELDS: usize = 32;
/// Maximum item key length.
pub const MAX_KEY_LEN: usize = 255;
/// Maximum field name length.
pub const MAX_FIELD_NAME_LEN: usize = 64;
/// Maximum field label length.
pub const MAX_LABEL_LEN: usize = 128;
/// Maximum description length.
pub const MAX_DESCRIPTION_LEN: usize = 512;
/// Maximum item kind length.
pub const MAX_KIND_LEN: usize = 32;
/// Maximum size of one field value in bytes.
pub const MAX_VALUE_BYTES: usize = 64 * 1024;
/// Longest long-poll wait on the event timeline.
pub const MAX_EVENT_WAIT_SECS: u64 = 60;
/// Largest page of events.
pub const MAX_EVENT_PAGE: usize = 500;

/// Wakes event long-polls after any item event is committed.
static EVENT_NOTIFY: LazyLock<tokio::sync::Notify> = LazyLock::new(tokio::sync::Notify::new);
