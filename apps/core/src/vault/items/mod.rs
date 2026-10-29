//! Typed credential items.
//!
//! A key/value secret holds one opaque string. An item groups the fields of
//! one credential (a login's username, password, and TOTP seed, or an API
//! client's id and secret) under a fixed field schema:
//!
//! * the schema is set when the item is created and is immutable; each field
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

pub mod cards;

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

/// Field value type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldType {
    Text,
    Email,
    Url,
    Password,
    Totp,
    Note,
}

impl FieldType {
    /// Types whose values are always sensitive.
    fn always_sensitive(self) -> bool {
        matches!(self, Self::Password | Self::Totp)
    }
}

/// One field definition as submitted.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FieldDefInput {
    pub name: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    #[serde(default)]
    pub required: bool,
    /// Defaults to `true` for `password`/`totp`, `false` otherwise.
    #[serde(default)]
    pub sensitive: Option<bool>,
}

/// One normalized, stored field definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub field_type: FieldType,
    pub required: bool,
    pub sensitive: bool,
}

/// Item status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    PendingCollection,
    Ready,
}

impl ItemStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::PendingCollection => "pending_collection",
            Self::Ready => "ready",
        }
    }

    fn parse(value: &str) -> Self {
        if value == "ready" {
            Self::Ready
        } else {
            Self::PendingCollection
        }
    }
}

/// Where an item lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemCoords {
    pub environment: String,
    pub path: String,
    pub key: String,
}

impl ItemCoords {
    /// Validate and normalize coordinates. `environment` defaults to
    /// `default` and `path` to the root folder.
    pub fn new(environment: Option<&str>, path: Option<&str>, key: &str) -> Result<Self> {
        let environment = environment
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(super::DEFAULT_ENVIRONMENT);
        if !is_valid_environment(environment) {
            return Err(VaultError::Invalid(format!("invalid environment `{environment}`")).into());
        }
        let path = normalize_path(path.unwrap_or(super::ROOT_PATH))
            .ok_or_else(|| VaultError::Invalid("invalid folder path".into()))?;
        if !is_valid_item_key(key) {
            return Err(VaultError::Invalid(
                "item keys are 1-255 characters of letters, digits, `.`, `_`, or `-`".into(),
            )
            .into());
        }
        Ok(Self {
            environment: environment.to_owned(),
            path,
            key: key.to_owned(),
        })
    }

    /// The reserved policy key for this item.
    pub fn policy_key(&self) -> String {
        policy_key(&self.environment, &self.path, &self.key)
    }
}

/// The policy key `sys/items/ENV/folder/KEY` (no slash before a root key).
pub fn policy_key(environment: &str, path: &str, key: &str) -> String {
    format!(
        "{}/items/{}",
        super::SYS_PREFIX,
        super::policy_key(environment, path, key)
    )
}

/// Whether `key` matches `^[a-zA-Z0-9._-]{1,255}$` and is not `.`/`..`.
pub fn is_valid_item_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= MAX_KEY_LEN
        && key != "."
        && key != ".."
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn is_valid_field_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_FIELD_NAME_LEN
        && bytes[0].is_ascii_alphabetic()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn is_valid_kind(kind: &str) -> bool {
    let bytes = kind.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= MAX_KIND_LEN
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'_' | b'-'))
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    VaultError::Invalid(message.into()).into()
}

/// Validate and normalize a submitted schema.
pub fn normalize_fields(fields: &[FieldDefInput]) -> Result<Vec<FieldDef>> {
    if fields.is_empty() || fields.len() > MAX_FIELDS {
        return Err(invalid(format!("an item has 1 to {MAX_FIELDS} fields")));
    }
    let mut seen = BTreeSet::new();
    let mut out = Vec::with_capacity(fields.len());
    for field in fields {
        if !is_valid_field_name(&field.name) {
            return Err(invalid(format!(
                "invalid field name `{}` (a letter, then letters, digits, `_`, or `-`; at most 64)",
                field.name
            )));
        }
        if !seen.insert(field.name.to_ascii_lowercase()) {
            return Err(invalid(format!("duplicate field `{}`", field.name)));
        }
        let label = field
            .label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(str::to_owned);
        if label
            .as_deref()
            .is_some_and(|label| label.chars().count() > MAX_LABEL_LEN)
        {
            return Err(invalid(format!(
                "field `{}` label exceeds {MAX_LABEL_LEN} characters",
                field.name
            )));
        }
        let always = field.field_type.always_sensitive();
        let sensitive = match field.sensitive {
            Some(false) if always => {
                return Err(invalid(format!(
                    "field `{}`: password and totp fields are always sensitive",
                    field.name
                )));
            }
            Some(value) => value,
            None => always,
        };
        out.push(FieldDef {
            name: field.name.clone(),
            label,
            field_type: field.field_type,
            required: field.required,
            sensitive,
        });
    }
    Ok(out)
}

/// Validate one value against its field type and return the stored form.
/// A TOTP field accepts a Base32 seed or an `otpauth://totp/...` URI and
/// stores the normalized seed.
pub fn normalize_value(field: &FieldDef, value: &str) -> Result<String> {
    if value.is_empty() {
        return Err(invalid(format!(
            "field `{}`: use null to clear a value",
            field.name
        )));
    }
    if value.len() > MAX_VALUE_BYTES {
        return Err(invalid(format!(
            "field `{}` exceeds {MAX_VALUE_BYTES} bytes",
            field.name
        )));
    }
    let single_line = || {
        if value.contains(['\n', '\r', '\0']) {
            Err(invalid(format!("field `{}` must be one line", field.name)))
        } else {
            Ok(())
        }
    };
    match field.field_type {
        FieldType::Note => Ok(value.to_owned()),
        FieldType::Text | FieldType::Password => {
            single_line()?;
            Ok(value.to_owned())
        }
        FieldType::Email => {
            let trimmed = value.trim();
            let valid = trimmed.len() <= 320
                && !trimmed.chars().any(char::is_whitespace)
                && trimmed.split_once('@').is_some_and(|(local, domain)| {
                    !local.is_empty()
                        && !domain.is_empty()
                        && !domain.contains('@')
                        && !domain.starts_with('.')
                        && !domain.ends_with('.')
                });
            if valid {
                Ok(trimmed.to_owned())
            } else {
                Err(invalid(format!(
                    "field `{}` is not an email address",
                    field.name
                )))
            }
        }
        FieldType::Url => {
            single_line()?;
            let parsed = url::Url::parse(value.trim())
                .map_err(|_| invalid(format!("field `{}` is not a URL", field.name)))?;
            if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
                return Err(invalid(format!(
                    "field `{}` must be an http(s) URL",
                    field.name
                )));
            }
            Ok(parsed.to_string())
        }
        FieldType::Totp => normalize_totp_seed(value)
            .ok_or_else(|| invalid(format!("field `{}` is not a Base32 TOTP seed", field.name))),
    }
}

/// Normalize a Base32 TOTP seed or extract it from an `otpauth://totp/` URI.
/// Returns uppercase, unpadded Base32 of at least 16 characters (80 bits).
pub fn normalize_totp_seed(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let raw = if trimmed
        .get(..10)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("otpauth://"))
    {
        let parsed = url::Url::parse(trimmed).ok()?;
        if !parsed.host_str()?.eq_ignore_ascii_case("totp") {
            return None;
        }
        parsed
            .query_pairs()
            .find(|(name, _)| name == "secret")
            .map(|(_, secret)| secret.into_owned())?
    } else {
        trimmed.to_owned()
    };
    let seed: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '-'))
        .collect::<String>()
        .trim_end_matches('=')
        .to_ascii_uppercase();
    let valid = (16..=128).contains(&seed.len())
        && seed
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b));
    valid.then_some(seed)
}

/// Which stored values a `PUT` caller may have compared against the values it
/// supplies when the item already exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PutAccess {
    /// May see non-sensitive values (`use` or `read`).
    pub plain: bool,
    /// May see sensitive values (`read`).
    pub sensitive: bool,
}

impl PutAccess {
    /// Every value may be compared.
    pub const FULL: Self = Self {
        plain: true,
        sensitive: true,
    };

    fn may_compare(self, def: &FieldDef) -> bool {
        if def.sensitive {
            self.sensitive
        } else {
            self.plain || self.sensitive
        }
    }
}

/// Constant-time equality over SHA-256 digests, so the comparison time does
/// not depend on the length or content of either value.
fn digest_eq(left: &str, right: &str) -> bool {
    use sha2::{Digest, Sha256};
    let (left, right) = (
        Sha256::digest(left.as_bytes()),
        Sha256::digest(right.as_bytes()),
    );
    left.iter()
        .zip(right.iter())
        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

/// Which events an item timeline read returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventScope {
    /// Only the item currently at the coordinates (none when there is none).
    CurrentItem,
    /// Every item that has lived at the coordinates, including deleted ones.
    History,
}

/// Create or confirm an item (`PUT`).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemPut {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    /// Free-form kind slug such as `login` or `api_client`; default `generic`.
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// The field schema. Omitted for `card` items, whose schema is fixed.
    #[serde(default)]
    pub fields: Vec<FieldDefInput>,
    /// Initial values by field name.
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    /// Merchant host allowlist (`card` items only).
    #[serde(default)]
    pub merchants: Option<Vec<String>>,
}

/// Change values or the description (`PATCH`). Field definitions are
/// immutable; omitted fields keep their value and `null` clears one.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemPatch {
    #[serde(default)]
    pub environment: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    pub expected_version: i64,
    pub expected_id: String,
    /// Absent keeps it, `null` clears it.
    #[serde(default, deserialize_with = "present")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub values: BTreeMap<String, Option<String>>,
    /// Replace the merchant host allowlist (`card` items only).
    #[serde(default)]
    pub merchants: Option<Vec<String>>,
}

/// Distinguish an explicit `null` from an absent key.
fn present<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// One field in a read: its definition, whether it has a value, and the
/// value itself only for non-sensitive fields when the caller may see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldView {
    #[serde(flatten)]
    pub def: FieldDef,
    pub has_value: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

/// An item as returned by reads and writes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemView {
    pub id: String,
    pub environment: String,
    pub path: String,
    pub key: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub version: i64,
    pub status: ItemStatus,
    pub fields: Vec<FieldView>,
    /// Operations the item currently supports (`collect` while values are
    /// missing, `reveal` once any value is set).
    pub available_operations: Vec<&'static str>,
    /// Brand, last4, expiry, and merchants of a `card` item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<cards::CardSummary>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A listing row (no values).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemSummary {
    pub id: String,
    pub environment: String,
    pub path: String,
    pub key: String,
    pub kind: String,
    pub version: i64,
    pub status: ItemStatus,
    pub field_count: usize,
    /// Brand, last4, expiry, and merchants of a `card` item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub card: Option<cards::CardSummary>,
    pub updated_at: i64,
}

/// One timeline entry. `data` carries field names, never values.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemEvent {
    pub seq: i64,
    pub item_id: String,
    pub name: String,
    pub version: i64,
    pub actor_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actor_id: Option<String>,
    pub data: Value,
    pub created_at: i64,
}

/// Result of a `PUT`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PutOutcome {
    Created,
    Unchanged,
}

/// Create the item tables. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_items (
             id          TEXT PRIMARY KEY,
             environment TEXT NOT NULL,
             path        TEXT NOT NULL,
             item_key    TEXT NOT NULL,
             kind        TEXT NOT NULL,
             description TEXT,
             fields      TEXT NOT NULL,
             version     INTEGER NOT NULL,
             status      TEXT NOT NULL,
             created_by  TEXT,
             created_at  INTEGER NOT NULL,
             updated_at  INTEGER NOT NULL,
             UNIQUE (environment, path, item_key)
         );
         CREATE TABLE IF NOT EXISTS vault_item_values (
             item_id     TEXT NOT NULL,
             field       TEXT NOT NULL,
             key_version INTEGER NOT NULL,
             nonce       BLOB NOT NULL,
             ciphertext  BLOB NOT NULL,
             updated_at  INTEGER NOT NULL,
             PRIMARY KEY (item_id, field)
         );
         CREATE TABLE IF NOT EXISTS vault_item_events (
             seq         INTEGER PRIMARY KEY AUTOINCREMENT,
             item_id     TEXT NOT NULL,
             environment TEXT NOT NULL,
             path        TEXT NOT NULL,
             item_key    TEXT NOT NULL,
             name        TEXT NOT NULL,
             version     INTEGER NOT NULL,
             actor_kind  TEXT NOT NULL,
             actor_id    TEXT,
             data        TEXT NOT NULL,
             created_at  INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS vault_item_events_coords
             ON vault_item_events (environment, path, item_key, seq);",
    )
    .context("initializing vault item schema")?;
    cards::init_schema(conn)
}

struct ItemRow {
    id: String,
    kind: String,
    description: Option<String>,
    fields: Vec<FieldDef>,
    version: i64,
    status: ItemStatus,
    created_at: i64,
    updated_at: i64,
}

fn find_item(conn: &Connection, coords: &ItemCoords) -> Result<Option<ItemRow>> {
    let row = conn
        .query_row(
            "SELECT id, kind, description, fields, version, status, created_at, updated_at
             FROM vault_items WHERE environment = ?1 AND path = ?2 AND item_key = ?3",
            params![coords.environment, coords.path, coords.key],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((id, kind, description, fields, version, status, created_at, updated_at)) = row else {
        return Ok(None);
    };
    Ok(Some(ItemRow {
        id,
        kind,
        description,
        fields: serde_json::from_str(&fields).context("decoding item field definitions")?,
        version,
        status: ItemStatus::parse(&status),
        created_at,
        updated_at,
    }))
}

fn not_found(coords: &ItemCoords) -> anyhow::Error {
    VaultError::NotFound(format!("item `{}`", coords.policy_key())).into()
}

/// Names of fields that currently hold a value.
fn fields_with_values(conn: &Connection, item_id: &str) -> Result<BTreeSet<String>> {
    let mut stmt = conn.prepare("SELECT field FROM vault_item_values WHERE item_id = ?1")?;
    let rows = stmt.query_map(params![item_id], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn status_for(fields: &[FieldDef], present: &BTreeSet<String>) -> ItemStatus {
    if fields
        .iter()
        .filter(|field| field.required)
        .all(|field| present.contains(&field.name))
    {
        ItemStatus::Ready
    } else {
        ItemStatus::PendingCollection
    }
}

fn field_def<'a>(fields: &'a [FieldDef], name: &str) -> Result<&'a FieldDef> {
    fields
        .iter()
        .find(|field| field.name == name)
        .ok_or_else(|| invalid(format!("unknown field `{name}`")))
}

fn append_event(
    conn: &Connection,
    item_id: &str,
    coords: &ItemCoords,
    name: &str,
    version: i64,
    actor: &AuditActor,
    data: &Value,
) -> Result<()> {
    conn.execute(
        "INSERT INTO vault_item_events
             (item_id, environment, path, item_key, name, version, actor_kind, actor_id, data, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            item_id,
            coords.environment,
            coords.path,
            coords.key,
            name,
            version,
            actor.kind,
            actor.id,
            data.to_string(),
            now_millis()
        ],
    )?;
    Ok(())
}

fn audit_entry(
    actor: &AuditActor,
    action: &str,
    coords: &ItemCoords,
    details: Value,
) -> AuditEntry {
    AuditEntry::new(actor, action, "ok").details(json!({
        "item": coords.key,
        "environment": coords.environment,
        "path": coords.path,
        "details": details,
    }))
}

fn notify_events() {
    EVENT_NOTIFY.notify_waiters();
}

impl PluginSecretStore {
    fn seal_value(&self, value: &str) -> Result<(u32, Vec<u8>, Vec<u8>)> {
        self.seal_row(value.as_bytes())
    }

    fn open_value(&self, conn: &Connection, item_id: &str, field: &str) -> Result<Option<String>> {
        let row: Option<(u32, Vec<u8>, Vec<u8>)> = conn
            .query_row(
                "SELECT key_version, nonce, ciphertext FROM vault_item_values
                 WHERE item_id = ?1 AND field = ?2",
                params![item_id, field],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let Some((key_version, nonce, ciphertext)) = row else {
            return Ok(None);
        };
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("item value is not UTF-8"))
    }

    fn put_value(&self, conn: &Connection, item_id: &str, field: &str, value: &str) -> Result<()> {
        let (key_version, nonce, ciphertext) = self.seal_value(value)?;
        conn.execute(
            "INSERT INTO vault_item_values (item_id, field, key_version, nonce, ciphertext, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(item_id, field) DO UPDATE SET key_version = excluded.key_version,
                 nonce = excluded.nonce, ciphertext = excluded.ciphertext,
                 updated_at = excluded.updated_at",
            params![item_id, field, key_version, nonce, ciphertext, now_millis()],
        )?;
        Ok(())
    }

    /// Build the read view. Non-sensitive values are opened only when
    /// `include_values` is set; sensitive values never are.
    fn item_view_locked(
        &self,
        conn: &Connection,
        coords: &ItemCoords,
        row: &ItemRow,
        include_values: bool,
    ) -> Result<ItemView> {
        let present = fields_with_values(conn, &row.id)?;
        let mut fields = Vec::with_capacity(row.fields.len());
        for def in &row.fields {
            let has_value = present.contains(&def.name);
            let value = if include_values && has_value && !def.sensitive {
                self.open_value(conn, &row.id, &def.name)?
            } else {
                None
            };
            fields.push(FieldView {
                def: def.clone(),
                has_value,
                value,
            });
        }
        let mut operations = Vec::new();
        if row.status == ItemStatus::PendingCollection {
            operations.push("collect");
        }
        if !present.is_empty() {
            operations.push("reveal");
        }
        let card = if cards::is_card_item(&row.kind, &row.fields) {
            cards::summary_locked(conn, &row.id, &coords.key)?
        } else {
            None
        };
        Ok(ItemView {
            id: row.id.clone(),
            environment: coords.environment.clone(),
            path: coords.path.clone(),
            key: coords.key.clone(),
            kind: row.kind.clone(),
            description: row.description.clone(),
            version: row.version,
            status: row.status,
            fields,
            available_operations: operations,
            card,
            created_at: row.created_at,
            updated_at: row.updated_at,
        })
    }

    /// A card patch that sets either expiry field must leave a valid,
    /// unexpired expiry.
    fn check_card_patch_expiry(
        &self,
        conn: &Connection,
        row: &ItemRow,
        values: &BTreeMap<String, Option<String>>,
    ) -> Result<()> {
        let touched = [cards::FIELD_EXP_MONTH, cards::FIELD_EXP_YEAR];
        if !touched.iter().any(|name| values.contains_key(*name)) {
            return Ok(());
        }
        let mut current = Vec::with_capacity(2);
        for name in touched {
            let value = match values.get(name) {
                Some(Some(value)) => Some(cards::normalize_card_value(
                    field_def(&row.fields, name)?,
                    value,
                )?),
                Some(None) => None,
                None => self.open_value(conn, &row.id, name)?,
            };
            current.push(value);
        }
        if let [Some(month), Some(year)] = current.as_slice() {
            cards::check_new_expiry(month, year, now_millis())?;
        }
        Ok(())
    }

    /// Idempotent upsert. Creates the item (`Created`), or, when an item with
    /// the same kind, description, and field schema exists and every supplied
    /// value equals the stored one, returns it untouched (`Unchanged`). A
    /// different schema or description, a different supplied value, or a
    /// supplied value `access` does not allow the caller to see is a conflict:
    /// change values with [`Self::item_patch`]. The conflict never names the
    /// field, so `PUT` is not an equality oracle for values the caller could
    /// not otherwise read.
    pub async fn item_put(
        &self,
        key: &str,
        input: ItemPut,
        actor: &AuditActor,
        access: PutAccess,
    ) -> Result<(PutOutcome, ItemView)> {
        let coords = ItemCoords::new(input.environment.as_deref(), input.path.as_deref(), key)?;
        let kind = input.kind.as_deref().map(str::trim).unwrap_or("generic");
        if !is_valid_kind(kind) {
            return Err(invalid(
                "kind is a lowercase slug of at most 32 characters (e.g. `login`)",
            ));
        }
        let description = input
            .description
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned);
        if description
            .as_deref()
            .is_some_and(|text| text.chars().count() > MAX_DESCRIPTION_LEN)
        {
            return Err(invalid(format!(
                "description exceeds {MAX_DESCRIPTION_LEN} characters"
            )));
        }
        let is_card = kind == cards::CARD_KIND;
        let fields = if is_card {
            if !input.fields.is_empty() {
                return Err(invalid("card items have a fixed schema; omit `fields`"));
            }
            if !cards::is_valid_card_key(key) {
                return Err(invalid(
                    "card item keys are 1-40 letters, digits, `_`, or `-` (no `__`, no leading \
                     or trailing `_`)",
                ));
            }
            cards::card_fields()
        } else {
            normalize_fields(&input.fields)?
        };
        let merchants = match (&input.merchants, is_card) {
            (Some(merchants), true) => cards::normalize_merchants(merchants)?,
            (None, true) => Vec::new(),
            (Some(_), false) => return Err(invalid("merchants apply only to card items")),
            (None, false) => Vec::new(),
        };
        let mut values = BTreeMap::new();
        for (name, value) in &input.values {
            let def = field_def(&fields, name)?;
            let value = if is_card {
                cards::normalize_card_value(def, value)?
            } else {
                normalize_value(def, value)?
            };
            values.insert(name.clone(), value);
        }
        if is_card {
            if let (Some(month), Some(year)) = (
                values.get(cards::FIELD_EXP_MONTH),
                values.get(cards::FIELD_EXP_YEAR),
            ) {
                cards::check_new_expiry(month, year, now_millis())?;
            }
        }

        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        if let Some(existing) = find_item(&tx, &coords)? {
            if existing.kind != kind || existing.fields != fields {
                return Err(VaultError::Conflict(format!(
                    "item `{}` exists with a different schema",
                    coords.policy_key()
                ))
                .into());
            }
            if existing.description != description {
                return Err(VaultError::Conflict(format!(
                    "item `{}` exists with a different description; use PATCH",
                    coords.policy_key()
                ))
                .into());
            }
            if is_card
                && input.merchants.is_some()
                && Self::card_merchants_locked(&tx, &existing.id)? != merchants
            {
                return Err(VaultError::Conflict(format!(
                    "item `{}` exists with different merchants; use PATCH",
                    coords.policy_key()
                ))
                .into());
            }
            let values_conflict = || {
                VaultError::Conflict(format!(
                    "item `{}` exists and the supplied values cannot be confirmed; use PATCH",
                    coords.policy_key()
                ))
            };
            let mut matches = true;
            for (name, value) in &values {
                let def = field_def(&existing.fields, name)?;
                // A card number or security code is never confirmed by
                // comparison: repeated PUTs would test guesses (a CVC has
                // at most 10,000) around the per-reveal approval.
                if !access.may_compare(def) || (is_card && cards::is_restricted_field(name)) {
                    return Err(values_conflict().into());
                }
                let stored = self.open_value(&tx, &existing.id, name)?;
                // Visit every supplied field and compare digests in constant
                // time, so neither the response nor its timing says which
                // value differed.
                matches &= stored
                    .as_deref()
                    .is_some_and(|stored| digest_eq(stored, value));
            }
            if !matches {
                return Err(values_conflict().into());
            }
            if !values.is_empty() {
                let confirmed: Vec<&String> = values.keys().collect();
                self.audit_locked(
                    &tx,
                    &audit_entry(
                        actor,
                        "item.put_confirm",
                        &coords,
                        json!({ "fieldsConfirmed": confirmed }),
                    ),
                );
            }
            let view = self.item_view_locked(&tx, &coords, &existing, false)?;
            tx.commit()?;
            self.flush_audit(&conn);
            return Ok((PutOutcome::Unchanged, view));
        }

        let id = random_token("itm_");
        let now = now_millis();
        let present: BTreeSet<String> = values.keys().cloned().collect();
        let status = status_for(&fields, &present);
        tx.execute(
            "INSERT INTO vault_items (id, environment, path, item_key, kind, description, fields,
                 version, status, created_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?10)",
            params![
                id,
                coords.environment,
                coords.path,
                coords.key,
                kind,
                description,
                serde_json::to_string(&fields)?,
                status.as_str(),
                actor.id,
                now
            ],
        )?;
        for (name, value) in &values {
            self.put_value(&tx, &id, name, value)?;
        }
        if is_card {
            self.card_refresh_meta_locked(&tx, &id, &coords, Some(&merchants))?;
        }
        let set: Vec<&String> = values.keys().collect();
        append_event(
            &tx,
            &id,
            &coords,
            "created",
            1,
            actor,
            &json!({ "kind": kind, "fieldsSet": set, "status": status.as_str() }),
        )?;
        self.audit_locked(
            &tx,
            &audit_entry(actor, "item.create", &coords, json!({ "fieldsSet": set })),
        );
        let row = find_item(&tx, &coords)?.ok_or_else(|| not_found(&coords))?;
        let view = self.item_view_locked(&tx, &coords, &row, false)?;
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok((PutOutcome::Created, view))
    }

    /// Read one item. Non-sensitive values are included when
    /// `include_values` is set.
    pub async fn item_get(&self, coords: &ItemCoords, include_values: bool) -> Result<ItemView> {
        let conn = self.conn.lock().await;
        let row = find_item(&conn, coords)?.ok_or_else(|| not_found(coords))?;
        self.item_view_locked(&conn, coords, &row, include_values)
    }

    /// Every item, optionally narrowed to one environment and folder.
    pub async fn item_list(
        &self,
        environment: Option<&str>,
        path: Option<&str>,
    ) -> Result<Vec<ItemSummary>> {
        let path = match path {
            Some(path) => Some(normalize_path(path).ok_or_else(|| invalid("invalid folder path"))?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, environment, path, item_key, kind, version, status, fields, updated_at
             FROM vault_items
             WHERE (?1 IS NULL OR environment = ?1) AND (?2 IS NULL OR path = ?2)
             ORDER BY environment, path, item_key",
        )?;
        let card_summaries = cards::summaries_locked(&conn)?;
        let rows = stmt.query_map(params![environment, path], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, environment, path, key, kind, version, status, fields, updated_at) = row?;
            let fields: Vec<FieldDef> = serde_json::from_str(&fields)?;
            out.push(ItemSummary {
                card: card_summaries.get(&id).cloned(),
                id,
                environment,
                path,
                key,
                kind,
                version,
                status: ItemStatus::parse(&status),
                field_count: fields.len(),
                updated_at,
            });
        }
        Ok(out)
    }

    /// Optimistic partial update. `expected_id` and `expected_version` must
    /// match the stored item; omitted values are kept and `null` clears one.
    /// Clearing a required value moves the item back to `pending_collection`.
    pub async fn item_patch(
        &self,
        key: &str,
        patch: ItemPatch,
        actor: &AuditActor,
    ) -> Result<ItemView> {
        let coords = ItemCoords::new(patch.environment.as_deref(), patch.path.as_deref(), key)?;
        let description = match &patch.description {
            None => None,
            Some(None) => Some(None),
            Some(Some(text)) => {
                let text = text.trim();
                if text.chars().count() > MAX_DESCRIPTION_LEN {
                    return Err(invalid(format!(
                        "description exceeds {MAX_DESCRIPTION_LEN} characters"
                    )));
                }
                Some((!text.is_empty()).then(|| text.to_owned()))
            }
        };
        if description.is_none() && patch.values.is_empty() && patch.merchants.is_none() {
            return Err(invalid("nothing to change"));
        }

        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let row = find_item(&tx, &coords)?.ok_or_else(|| not_found(&coords))?;
        if row.id != patch.expected_id || row.version != patch.expected_version {
            return Err(VaultError::Conflict(format!(
                "item `{}` is at version {} (id {}); re-read it and retry",
                coords.policy_key(),
                row.version,
                row.id
            ))
            .into());
        }
        let is_card = cards::is_card_item(&row.kind, &row.fields);
        let merchants = match (&patch.merchants, is_card) {
            (Some(merchants), true) => Some(cards::normalize_merchants(merchants)?),
            (Some(_), false) => return Err(invalid("merchants apply only to card items")),
            (None, _) => None,
        };
        if is_card {
            self.check_card_patch_expiry(&tx, &row, &patch.values)?;
        }
        let mut set = Vec::new();
        let mut cleared = Vec::new();
        for (name, value) in &patch.values {
            let def = field_def(&row.fields, name)?;
            match value {
                Some(value) => {
                    let value = if is_card {
                        cards::normalize_card_value(def, value)?
                    } else {
                        normalize_value(def, value)?
                    };
                    self.put_value(&tx, &row.id, name, &value)?;
                    set.push(name.clone());
                }
                None => {
                    tx.execute(
                        "DELETE FROM vault_item_values WHERE item_id = ?1 AND field = ?2",
                        params![row.id, name],
                    )?;
                    cleared.push(name.clone());
                }
            }
        }
        if is_card {
            self.card_refresh_meta_locked(&tx, &row.id, &coords, merchants.as_deref())?;
        }
        let present = fields_with_values(&tx, &row.id)?;
        let status = status_for(&row.fields, &present);
        let version = row.version + 1;
        let now = now_millis();
        let description = description.unwrap_or_else(|| row.description.clone());
        tx.execute(
            "UPDATE vault_items SET description = ?1, version = ?2, status = ?3, updated_at = ?4
             WHERE id = ?5",
            params![description, version, status.as_str(), now, row.id],
        )?;
        let data = json!({
            "fieldsSet": set,
            "fieldsCleared": cleared,
            "descriptionChanged": patch.description.is_some(),
            "merchantsChanged": patch.merchants.is_some(),
        });
        append_event(&tx, &row.id, &coords, "updated", version, actor, &data)?;
        if status != row.status {
            append_event(
                &tx,
                &row.id,
                &coords,
                "status_changed",
                version,
                actor,
                &json!({ "from": row.status.as_str(), "to": status.as_str() }),
            )?;
        }
        self.audit_locked(&tx, &audit_entry(actor, "item.update", &coords, data));
        let row = find_item(&tx, &coords)?.ok_or_else(|| not_found(&coords))?;
        let view = self.item_view_locked(&tx, &coords, &row, false)?;
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok(view)
    }

    /// Delete an item and its values. When `expected_version` is set it must
    /// match. The event timeline is kept. Returns `false` if it did not exist.
    pub async fn item_delete(
        &self,
        coords: &ItemCoords,
        expected_version: Option<i64>,
        actor: &AuditActor,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let Some(row) = find_item(&tx, coords)? else {
            return Ok(false);
        };
        if expected_version.is_some_and(|expected| expected != row.version) {
            return Err(VaultError::Conflict(format!(
                "item `{}` is at version {}",
                coords.policy_key(),
                row.version
            ))
            .into());
        }
        tx.execute(
            "DELETE FROM vault_item_values WHERE item_id = ?1",
            params![row.id],
        )?;
        tx.execute("DELETE FROM vault_items WHERE id = ?1", params![row.id])?;
        cards::forget_locked(&tx, &row.id)?;
        append_event(
            &tx,
            &row.id,
            coords,
            "deleted",
            row.version,
            actor,
            &json!({}),
        )?;
        self.audit_locked(&tx, &audit_entry(actor, "item.delete", coords, json!({})));
        tx.commit()?;
        self.flush_audit(&conn);
        notify_events();
        Ok(true)
    }

    /// Reveal one field's plaintext (sensitive or not). Audited and recorded
    /// on the timeline without the value.
    pub async fn item_reveal(
        &self,
        coords: &ItemCoords,
        field: &str,
        actor: &AuditActor,
    ) -> Result<String> {
        let conn = self.conn.lock().await;
        let row = find_item(&conn, coords)?.ok_or_else(|| not_found(coords))?;
        field_def(&row.fields, field)?;
        if cards::is_card_item(&row.kind, &row.fields) && cards::is_restricted_field(field) {
            return Err(VaultError::Denied(
                "a card number or security code is revealed only under a card approval".into(),
            )
            .into());
        }
        let value = self
            .open_value(&conn, &row.id, field)?
            .ok_or_else(|| VaultError::NotFound(format!("field `{field}` has no value")))?;
        let data = json!({ "field": field });
        if !self.audit_locked(
            &conn,
            &audit_entry(actor, "item.reveal", coords, data.clone()),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        append_event(
            &conn,
            &row.id,
            coords,
            "revealed",
            row.version,
            actor,
            &data,
        )?;
        drop(conn);
        notify_events();
        Ok(value)
    }

    fn item_events_locked(
        conn: &Connection,
        coords: &ItemCoords,
        after: i64,
        limit: usize,
        scope: EventScope,
    ) -> Result<Vec<ItemEvent>> {
        let item_id = match scope {
            EventScope::History => None,
            EventScope::CurrentItem => match find_item(conn, coords)? {
                Some(row) => Some(row.id),
                None => return Ok(Vec::new()),
            },
        };
        let mut stmt = conn.prepare(
            "SELECT seq, item_id, name, version, actor_kind, actor_id, data, created_at
             FROM vault_item_events
             WHERE environment = ?1 AND path = ?2 AND item_key = ?3 AND seq > ?4
               AND (?6 IS NULL OR item_id = ?6)
             ORDER BY seq LIMIT ?5",
        )?;
        let rows = stmt.query_map(
            params![
                coords.environment,
                coords.path,
                coords.key,
                after,
                limit as i64,
                item_id
            ],
            |row| {
                Ok(ItemEvent {
                    seq: row.get(0)?,
                    item_id: row.get(1)?,
                    name: row.get(2)?,
                    version: row.get(3)?,
                    actor_kind: row.get(4)?,
                    actor_id: row.get(5)?,
                    data: serde_json::from_str(&row.get::<_, String>(6)?).unwrap_or(Value::Null),
                    created_at: row.get(7)?,
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Events at `coords` with `seq > after`: only the current item's under
    /// [`EventScope::CurrentItem`], or every item's across deletes and
    /// re-creates under [`EventScope::History`]. With `wait_secs > 0` and
    /// nothing new, waits up to that long (at most [`MAX_EVENT_WAIT_SECS`])
    /// for the next event.
    pub async fn item_events(
        &self,
        coords: &ItemCoords,
        after: i64,
        limit: usize,
        wait_secs: u64,
        scope: EventScope,
    ) -> Result<Vec<ItemEvent>> {
        let limit = limit.clamp(1, MAX_EVENT_PAGE);
        let deadline =
            tokio::time::Instant::now() + Duration::from_secs(wait_secs.min(MAX_EVENT_WAIT_SECS));
        loop {
            // Register before reading so an event committed in between wakes us.
            let notified = EVENT_NOTIFY.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let events = {
                let conn = self.conn.lock().await;
                Self::item_events_locked(&conn, coords, after, limit, scope)?
            };
            if !events.is_empty() || tokio::time::Instant::now() >= deadline {
                return Ok(events);
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                let conn = self.conn.lock().await;
                return Self::item_events_locked(&conn, coords, after, limit, scope);
            }
        }
    }
}
