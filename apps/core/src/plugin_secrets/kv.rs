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

/// Character set for generated values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Charset {
    Alphanumeric,
    Hex,
    Base64url,
    Symbols,
}

/// How the scheduler can produce a new value for rotation.
///
/// Wire form: `{ "kind": "random", "length", "charset" }` or
/// `{ "kind": "random", "policy": "<password policy>" }`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(try_from = "GeneratorWire", into = "GeneratorWire")]
pub enum Generator {
    /// A random string of `length` characters from `charset`.
    Random { length: u16, charset: Charset },
    /// A value from a named password policy ([`crate::vault::password_policy`]).
    Policy { policy: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratorWire {
    kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    length: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    charset: Option<Charset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    policy: Option<String>,
}

impl TryFrom<GeneratorWire> for Generator {
    type Error = String;

    fn try_from(wire: GeneratorWire) -> std::result::Result<Self, Self::Error> {
        if wire.kind != "random" {
            return Err(format!("unknown generator kind `{}`", wire.kind));
        }
        match (wire.policy, wire.length, wire.charset) {
            (Some(policy), None, None) => Ok(Self::Policy { policy }),
            (Some(_), _, _) => Err("a policy generator takes no length or charset".into()),
            (None, Some(length), Some(charset)) => Ok(Self::Random { length, charset }),
            (None, _, _) => Err("a random generator needs length and charset, or policy".into()),
        }
    }
}

impl From<Generator> for GeneratorWire {
    fn from(generator: Generator) -> Self {
        let (length, charset, policy) = match generator {
            Generator::Random { length, charset } => (Some(length), Some(charset), None),
            Generator::Policy { policy } => (None, None, Some(policy)),
        };
        Self {
            kind: "random".into(),
            length,
            charset,
            policy,
        }
    }
}

impl Generator {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Random { length, .. } => {
                if !(8..=256).contains(length) {
                    bail!("generated values must be 8 to 256 characters");
                }
            }
            Self::Policy { policy } => {
                if !crate::vault::password_policy::is_valid_name(policy) {
                    bail!("invalid password policy name");
                }
            }
        }
        Ok(())
    }

    /// The password policy this generator uses, if any.
    pub fn policy_name(&self) -> Option<&str> {
        match self {
            Self::Policy { policy } => Some(policy),
            Self::Random { .. } => None,
        }
    }

    /// Produce a fresh value, reading a named policy from `conn`.
    pub fn generate_with(&self, conn: &Connection) -> Result<String> {
        match self {
            Self::Policy { policy } => crate::vault::password_policy::generate_locked(conn, policy),
            Self::Random { .. } => Ok(self.generate()),
        }
    }

    /// Produce a fresh inline value. A policy generator needs the store
    /// ([`Self::generate_with`]); here it yields an empty string, which every
    /// write path rejects, so it fails closed.
    pub fn generate(&self) -> String {
        use rand::Rng;
        match self {
            Self::Policy { .. } => String::new(),
            Self::Random { length, charset } => {
                let alphabet: &[u8] = match charset {
                    Charset::Alphanumeric => {
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
                    }
                    Charset::Hex => b"0123456789abcdef",
                    Charset::Base64url => {
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
                    }
                    Charset::Symbols => {
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!#%+-.:=@^_~"
                    }
                };
                let mut rng = rand::thread_rng();
                (0..*length)
                    .map(|_| alphabet[rng.gen_range(0..alphabet.len())] as char)
                    .collect()
            }
        }
    }
}

/// Non-secret metadata carried by a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadata {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Epoch millis after which the value is not resolved.
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub rotation_period_secs: Option<i64>,
    #[serde(default)]
    pub generator: Option<Generator>,
    #[serde(default)]
    pub expand_references: bool,
    #[serde(default = "default_max_versions")]
    pub max_versions: u32,
    /// Non-secret key/value annotations (KV v2 `custom_metadata`).
    #[serde(default)]
    pub custom_metadata: BTreeMap<String, String>,
    /// Value writes must carry `expectedVersion` (KV v2 `cas_required`).
    #[serde(default)]
    pub cas_required: bool,
    /// Non-current versions older than this are soft-deleted by the scheduler
    /// (KV v2 `delete_version_after`).
    #[serde(default)]
    pub delete_version_after_secs: Option<i64>,
}

fn default_max_versions() -> u32 {
    DEFAULT_MAX_VERSIONS
}

impl Default for SecretMetadata {
    fn default() -> Self {
        Self {
            description: String::new(),
            tags: Vec::new(),
            expires_at: None,
            rotation_period_secs: None,
            generator: None,
            expand_references: false,
            max_versions: DEFAULT_MAX_VERSIONS,
            custom_metadata: BTreeMap::new(),
            cas_required: false,
            delete_version_after_secs: None,
        }
    }
}

fn double_option<'de, D, T>(deserializer: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A partial metadata update. A missing field is unchanged; an explicit
/// `null` on a nullable field clears it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMetadataPatch {
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub expires_at: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub rotation_period_secs: Option<Option<i64>>,
    #[serde(default, deserialize_with = "double_option")]
    pub generator: Option<Option<Generator>>,
    #[serde(default)]
    pub expand_references: Option<bool>,
    #[serde(default)]
    pub max_versions: Option<u32>,
    /// Replaces the whole map; use the metadata merge patch to edit keys.
    #[serde(default)]
    pub custom_metadata: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub cas_required: Option<bool>,
    #[serde(default, deserialize_with = "double_option")]
    pub delete_version_after_secs: Option<Option<i64>>,
}

impl SecretMetadataPatch {
    /// A patch that sets every field to `metadata` (import/copy).
    pub fn from_metadata(metadata: &SecretMetadata) -> Self {
        Self {
            description: Some(metadata.description.clone()),
            tags: Some(metadata.tags.clone()),
            expires_at: Some(metadata.expires_at),
            rotation_period_secs: Some(metadata.rotation_period_secs),
            generator: Some(metadata.generator.clone()),
            expand_references: Some(metadata.expand_references),
            max_versions: Some(metadata.max_versions),
            custom_metadata: Some(metadata.custom_metadata.clone()),
            cas_required: Some(metadata.cas_required),
            delete_version_after_secs: Some(metadata.delete_version_after_secs),
        }
    }

    /// Apply onto `base`, validating the result.
    pub fn apply(&self, base: &SecretMetadata) -> Result<SecretMetadata> {
        let mut out = base.clone();
        if let Some(description) = &self.description {
            out.description = description.trim().to_owned();
        }
        if let Some(tags) = &self.tags {
            let mut unique: Vec<String> = Vec::new();
            for tag in tags {
                let tag = tag.trim().to_owned();
                if !tag.is_empty() && !unique.contains(&tag) {
                    unique.push(tag);
                }
            }
            out.tags = unique;
        }
        if let Some(expires_at) = self.expires_at {
            out.expires_at = expires_at;
        }
        if let Some(period) = self.rotation_period_secs {
            out.rotation_period_secs = period;
        }
        if let Some(generator) = &self.generator {
            out.generator = generator.clone();
        }
        if let Some(expand) = self.expand_references {
            out.expand_references = expand;
        }
        if let Some(max) = self.max_versions {
            out.max_versions = max;
        }
        if let Some(custom) = &self.custom_metadata {
            out.custom_metadata = custom.clone();
        }
        if let Some(required) = self.cas_required {
            out.cas_required = required;
        }
        if let Some(after) = self.delete_version_after_secs {
            out.delete_version_after_secs = after;
        }
        validate_metadata(&out)?;
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self == &Self::default()
    }
}

pub(super) fn validate_metadata(metadata: &SecretMetadata) -> Result<()> {
    if metadata.description.len() > MAX_DESCRIPTION_LEN {
        bail!("description is longer than {MAX_DESCRIPTION_LEN} characters");
    }
    if metadata.tags.len() > MAX_TAGS
        || metadata
            .tags
            .iter()
            .any(|tag| tag.len() > MAX_TAG_LEN || tag.chars().any(char::is_control))
    {
        bail!("at most {MAX_TAGS} tags of up to {MAX_TAG_LEN} characters are allowed");
    }
    if metadata
        .rotation_period_secs
        .is_some_and(|period| period < MIN_ROTATION_PERIOD_SECS)
    {
        bail!("rotation period must be at least {MIN_ROTATION_PERIOD_SECS} seconds");
    }
    if let Some(generator) = &metadata.generator {
        generator.validate()?;
    }
    if !(1..=MAX_MAX_VERSIONS).contains(&metadata.max_versions) {
        bail!("maxVersions must be between 1 and {MAX_MAX_VERSIONS}");
    }
    if metadata.custom_metadata.len() > MAX_CUSTOM_METADATA_KEYS {
        bail!("customMetadata holds at most {MAX_CUSTOM_METADATA_KEYS} keys");
    }
    for (key, value) in &metadata.custom_metadata {
        if key.is_empty()
            || key.len() > MAX_CUSTOM_METADATA_KEY_LEN
            || key.chars().any(char::is_control)
        {
            bail!(
                "customMetadata keys must be 1-{MAX_CUSTOM_METADATA_KEY_LEN} bytes without control characters"
            );
        }
        if value.len() > MAX_CUSTOM_METADATA_VALUE_LEN {
            bail!("customMetadata values are at most {MAX_CUSTOM_METADATA_VALUE_LEN} bytes");
        }
    }
    if metadata.delete_version_after_secs.is_some_and(|after| {
        !(MIN_DELETE_VERSION_AFTER_SECS..=MAX_DELETE_VERSION_AFTER_SECS).contains(&after)
    }) {
        bail!(
            "deleteVersionAfterSecs must be between {MIN_DELETE_VERSION_AFTER_SECS} and {MAX_DELETE_VERSION_AFTER_SECS}"
        );
    }
    Ok(())
}

/// The identity of one stored value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretCoords {
    pub scope: SecretScope,
    pub scope_id: String,
    pub environment: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<SecretBinding>,
    pub name: String,
}

impl SecretCoords {
    /// Coordinates in the default environment's root folder.
    pub fn root(
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
    ) -> Self {
        Self {
            scope,
            scope_id: scope_id.trim().to_owned(),
            environment: DEFAULT_ENVIRONMENT.to_owned(),
            path: ROOT_PATH.to_owned(),
            binding: binding.cloned(),
            name: name.to_owned(),
        }
    }

    /// Validate and normalize in place.
    pub fn normalize(mut self) -> Result<Self> {
        if !is_valid_vault_secret_name(&self.name) {
            bail!("invalid vault secret name");
        }
        self.scope_id = self.scope_id.trim().to_owned();
        if !is_valid_scope_id(&self.scope_id) {
            bail!("invalid vault secret scope id");
        }
        if !is_valid_environment(&self.environment) {
            bail!("invalid vault environment");
        }
        self.path =
            normalize_path(&self.path).ok_or_else(|| anyhow!("invalid vault folder path"))?;
        if let Some(binding) = &self.binding {
            binding.validate()?;
        }
        Ok(self)
    }

    pub(super) fn binding_parts(&self) -> (&'static str, &str) {
        self.binding
            .as_ref()
            .map(SecretBinding::storage_parts)
            .unwrap_or(("", ""))
    }

    /// `ENV/folder/NAME` for policy evaluation.
    pub fn policy_key(&self) -> String {
        policy_key(&self.environment, &self.path, &self.name)
    }

    pub(super) fn audit(&self, entry: AuditEntry) -> AuditEntry {
        entry.secret(
            self.scope.as_str(),
            &self.scope_id,
            &self.environment,
            &self.path,
            &self.name,
        )
    }
}

/// Why a version was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VersionSource {
    Write,
    Rollback,
    Rotate,
    Approval,
    Import,
    Migration,
    /// Copied from an external store by a sync source.
    External,
}

impl VersionSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::Rollback => "rollback",
            Self::Rotate => "rotate",
            Self::Approval => "approval",
            Self::Import => "import",
            Self::Migration => "migration",
            Self::External => "external",
        }
    }
}

/// Lifecycle status computed at read time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretStatus {
    Active,
    Expired,
    RotationDue,
    Deleted,
}

impl VaultSecretInfo {
    /// The value's current lifecycle status.
    pub fn status(&self, now: i64) -> SecretStatus {
        if self.deleted_at.is_some() {
            SecretStatus::Deleted
        } else if self.metadata.expires_at.is_some_and(|at| at <= now) {
            SecretStatus::Expired
        } else if self
            .metadata
            .rotation_period_secs
            .is_some_and(|period| self.rotated_at + period * 1000 <= now)
        {
            SecretStatus::RotationDue
        } else {
            SecretStatus::Active
        }
    }

    pub fn coords(&self) -> SecretCoords {
        SecretCoords {
            scope: self.scope,
            scope_id: self.scope_id.clone(),
            environment: self.environment.clone(),
            path: self.path.clone(),
            binding: self.binding.clone(),
            name: self.name.clone(),
        }
    }
}

/// One historical version (no value).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretVersionInfo {
    pub version: i64,
    pub created_at: i64,
    pub created_by: Option<String>,
    pub source: String,
    pub destroyed: bool,
    pub current: bool,
    /// Epoch millis of a per-version soft delete; `None` while live.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<i64>,
}

/// A write of a value and/or metadata.
pub struct WriteRequest<'a> {
    pub coords: SecretCoords,
    /// `None` keeps the current value (metadata-only update) or, for a new
    /// value with a generator, generates one.
    pub value: Option<&'a str>,
    pub patch: SecretMetadataPatch,
    pub actor: &'a AuditActor,
    pub source: VersionSource,
    /// Optimistic concurrency: the version the caller last saw.
    pub expected_version: Option<i64>,
}

/// Write options beyond the value (see [`PluginSecretStore::write_secret_with`]).
#[derive(Debug, Clone, Copy, Default)]
pub struct WriteOptions {
    /// Metadata check-and-set: the `metadataVersion` the caller last saw.
    pub expected_metadata_version: Option<i64>,
}

/// Listing filters.
#[derive(Debug, Clone, Default)]
pub struct ListFilter {
    pub environment: Option<String>,
    pub path: Option<String>,
    pub recursive: bool,
    pub include_deleted: bool,
}

/// An environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub protected: bool,
    #[serde(default = "one")]
    pub required_approvals: u8,
    #[serde(default)]
    pub position: i64,
    /// Every value write here must carry `expectedVersion`.
    #[serde(default)]
    pub cas_required: bool,
}

fn one() -> u8 {
    1
}

/// A folder import: lookups in `(environment, path)` fall back to the source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderImport {
    #[serde(default)]
    pub id: String,
    pub environment: String,
    pub path: String,
    pub source_environment: String,
    pub source_path: String,
    #[serde(default)]
    pub position: i64,
}

pub(super) const INFO_COLUMNS: &str = "id, scope, scope_id, environment, path, binding_kind,
    binding_id, name, version, description, tags, expires_at, rotation_period_secs, generator,
    expand_references, max_versions, created_at, created_by, updated_at, updated_by, rotated_at,
    deleted_at, custom_metadata, cas_required, delete_version_after_secs, metadata_version";

fn binding_from(kind: &str, id: String) -> Option<Option<SecretBinding>> {
    match kind {
        "" => Some(None),
        "mcp" if is_valid_scope_id(&id) => Some(Some(SecretBinding {
            kind: SecretBindingKind::Mcp,
            id,
        })),
        _ => None,
    }
}

/// Map a row selected with [`INFO_COLUMNS`]; unknown scopes/bindings from a
/// newer binary are skipped (`None`).
pub(super) fn info_from_row(row: &Row<'_>) -> rusqlite::Result<Option<(String, VaultSecretInfo)>> {
    let id: String = row.get(0)?;
    let Some(scope) = SecretScope::from_str(&row.get::<_, String>(1)?) else {
        return Ok(None);
    };
    let Some(binding) = binding_from(&row.get::<_, String>(5)?, row.get(6)?) else {
        return Ok(None);
    };
    let tags: String = row.get(10)?;
    let generator: Option<String> = row.get(13)?;
    let metadata = SecretMetadata {
        description: row.get(9)?,
        tags: serde_json::from_str(&tags).unwrap_or_default(),
        expires_at: row.get(11)?,
        rotation_period_secs: row.get(12)?,
        generator: generator.and_then(|g| serde_json::from_str(&g).ok()),
        expand_references: row.get::<_, i64>(14)? != 0,
        max_versions: row.get::<_, i64>(15)?.clamp(1, MAX_MAX_VERSIONS as i64) as u32,
        custom_metadata: serde_json::from_str(&row.get::<_, String>(22)?).unwrap_or_default(),
        cas_required: row.get::<_, i64>(23)? != 0,
        delete_version_after_secs: row.get(24)?,
    };
    Ok(Some((
        id,
        VaultSecretInfo {
            scope,
            scope_id: row.get(2)?,
            environment: row.get(3)?,
            path: row.get(4)?,
            binding,
            name: row.get(7)?,
            version: row.get(8)?,
            metadata,
            created_at: row.get(16)?,
            created_by: row.get(17)?,
            updated_at: row.get(18)?,
            updated_by: row.get(19)?,
            rotated_at: row.get(20)?,
            deleted_at: row.get(21)?,
            metadata_version: row.get(25)?,
        },
    )))
}

pub(super) fn find_row(
    conn: &Connection,
    coords: &SecretCoords,
) -> Result<Option<(String, VaultSecretInfo)>> {
    let (binding_kind, binding_id) = coords.binding_parts();
    let sql = format!(
        "SELECT {INFO_COLUMNS} FROM vault_secrets
         WHERE scope = ?1 AND scope_id = ?2 AND environment = ?3 AND path = ?4
           AND binding_kind = ?5 AND binding_id = ?6 AND name = ?7"
    );
    Ok(conn
        .query_row(
            &sql,
            params![
                coords.scope.as_str(),
                coords.scope_id,
                coords.environment,
                coords.path,
                binding_kind,
                binding_id,
                coords.name
            ],
            info_from_row,
        )
        .optional()
        .context("reading vault secret")?
        .flatten())
}

pub(super) fn actor_id(actor: &AuditActor) -> Option<String> {
    actor
        .id
        .clone()
        .map(|id| format!("{}:{id}", actor.kind))
        .or_else(|| Some(actor.kind.clone()))
}

/// Whether `environment` requires check-and-set on every value write.
pub(super) fn environment_cas_required(conn: &Connection, environment: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT cas_required FROM vault_environments WHERE slug = ?1",
            params![environment],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .is_some_and(|required| required != 0))
}

/// Retention: keep the newest `max_versions` versions of a row whose
/// current version is `current`.
pub(super) fn prune_versions(
    conn: &Connection,
    id: &str,
    current: i64,
    max_versions: u32,
) -> Result<()> {
    conn.execute(
        "DELETE FROM vault_secret_versions
         WHERE secret_id = ?1 AND version <= ?2",
        params![id, current - i64::from(max_versions)],
    )?;
    Ok(())
}

/// Persist validated metadata and its counter on one row.
pub(super) fn store_metadata(
    conn: &Connection,
    id: &str,
    metadata: &SecretMetadata,
    metadata_version: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE vault_secrets SET description = ?1, tags = ?2, expires_at = ?3,
             rotation_period_secs = ?4, generator = ?5, expand_references = ?6,
             max_versions = ?7, custom_metadata = ?8, cas_required = ?9,
             delete_version_after_secs = ?10, metadata_version = ?11
         WHERE id = ?12",
        params![
            metadata.description,
            serde_json::to_string(&metadata.tags)?,
            metadata.expires_at,
            metadata.rotation_period_secs,
            metadata
                .generator
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?,
            metadata.expand_references as i64,
            metadata.max_versions as i64,
            serde_json::to_string(&metadata.custom_metadata)?,
            metadata.cas_required as i64,
            metadata.delete_version_after_secs,
            metadata_version,
            id
        ],
    )?;
    Ok(())
}

/// What one resolution found.
struct Resolved {
    value: String,
    coords: SecretCoords,
    version: i64,
    expand: bool,
    source: &'static str,
}

impl PluginSecretStore {
    // ── Writes ────────────────────────────────────────────────────────────

    /// Create or update a value and/or its metadata. Returns the new metadata.
    pub async fn write_secret(&self, request: WriteRequest<'_>) -> Result<VaultSecretInfo> {
        self.write_secret_with(request, WriteOptions::default())
            .await
    }

    /// [`Self::write_secret`] with metadata check-and-set. A user write
    /// (`VersionSource::Write`) of a new value to a secret or environment with
    /// `casRequired` must carry `expectedVersion` (`0` to create).
    pub async fn write_secret_with(
        &self,
        request: WriteRequest<'_>,
        options: WriteOptions,
    ) -> Result<VaultSecretInfo> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let info = self.write_secret_locked(&tx, &request, &options)?;
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(info)
    }

    /// [`Self::write_secret_with`] inside a caller-held lock and transaction;
    /// the caller commits and then calls [`Self::flush_audit`].
    fn write_secret_locked(
        &self,
        tx: &Connection,
        request: &WriteRequest<'_>,
        options: &WriteOptions,
    ) -> Result<VaultSecretInfo> {
        let coords = request.coords.clone().normalize()?;
        if let Some(value) = request.value {
            if value.len() > MAX_VAULT_SECRET_VALUE_LEN {
                bail!("vault secret value exceeds the maximum allowed size");
            }
            if value.trim().is_empty() {
                bail!("an empty value is not stored; delete the secret instead");
            }
        }
        if request.source != VersionSource::External {
            crate::vault::external::guard_local_write(tx, &coords)?;
        }
        let existing = find_row(tx, &coords)?;
        if let (Some(expected), Some((_, info))) = (request.expected_version, existing.as_ref()) {
            if info.version != expected {
                return Err(VaultError::Conflict(format!(
                    "the secret is at version {}, not {expected}",
                    info.version
                ))
                .into());
            }
        } else if request.expected_version.is_some_and(|v| v != 0) && existing.is_none() {
            return Err(VaultError::Conflict("the secret no longer exists".into()).into());
        }
        if let Some(expected) = options.expected_metadata_version {
            let current = existing
                .as_ref()
                .map_or(0, |(_, info)| info.metadata_version);
            if current != expected {
                return Err(VaultError::Conflict(format!(
                    "the secret metadata is at version {current}, not {expected}"
                ))
                .into());
            }
        }
        let base = existing
            .as_ref()
            .map(|(_, info)| info.metadata.clone())
            .unwrap_or_default();
        let metadata = request.patch.apply(&base)?;
        if let Some(Generator::Policy { policy }) = &metadata.generator {
            // Check the effective generator (including one inherited from the
            // stored row) so a write fails now, not at the next rotation.
            crate::vault::password_policy::get_locked(&tx, policy)?;
        }
        let now = now_millis();
        let actor = actor_id(request.actor);

        let generated;
        let value: Option<&str> = match (request.value, existing.as_ref()) {
            (Some(value), _) => Some(value),
            (None, Some((_, info))) if info.deleted_at.is_none() => None,
            (None, _) => {
                let Some(generator) = &metadata.generator else {
                    bail!("a value is required");
                };
                generated = generator.generate_with(&tx)?;
                Some(generated.as_str())
            }
        };
        if value.is_some()
            && request.source == VersionSource::Write
            && request.expected_version.is_none()
            && (base.cas_required || environment_cas_required(&tx, &coords.environment)?)
        {
            return Err(VaultError::Invalid(
                "check-and-set is required here: pass expectedVersion (0 to create)".into(),
            )
            .into());
        }
        let metadata_version = match &existing {
            Some((_, info)) if info.metadata == metadata => info.metadata_version,
            Some((_, info)) => info.metadata_version + 1,
            None => 1,
        };

        let (id, version) = match (&existing, value) {
            (Some((id, info)), Some(value)) => {
                let (key_version, nonce, ciphertext) = self.seal_row(value.as_bytes())?;
                let next = info.version + 1;
                tx.execute(
                    "UPDATE vault_secrets SET nonce = ?1, ciphertext = ?2, key_version = ?3,
                         version = ?4, updated_at = ?5, updated_by = ?6, rotated_at = ?5,
                         deleted_at = NULL, deleted_by = NULL
                     WHERE id = ?7",
                    params![nonce, ciphertext, key_version, next, now, actor, id],
                )?;
                tx.execute(
                    "INSERT INTO vault_secret_versions
                        (secret_id, version, nonce, ciphertext, key_version, created_at, created_by, source)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![id, next, nonce, ciphertext, key_version, now, actor, request.source.as_str()],
                )?;
                (id.clone(), next)
            }
            (Some((id, info)), None) => {
                tx.execute(
                    "UPDATE vault_secrets SET updated_at = ?1, updated_by = ?2 WHERE id = ?3",
                    params![now, actor, id],
                )?;
                (id.clone(), info.version)
            }
            (None, Some(value)) => {
                let (key_version, nonce, ciphertext) = self.seal_row(value.as_bytes())?;
                let id = uuid::Uuid::new_v4().simple().to_string();
                let (binding_kind, binding_id) = coords.binding_parts();
                tx.execute(
                    "INSERT INTO vault_secrets
                        (id, scope, scope_id, environment, path, binding_kind, binding_id, name,
                         nonce, ciphertext, key_version, version, created_at, created_by,
                         updated_at, updated_by, rotated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, ?12, ?13, ?12)",
                    params![
                        id,
                        coords.scope.as_str(),
                        coords.scope_id,
                        coords.environment,
                        coords.path,
                        binding_kind,
                        binding_id,
                        coords.name,
                        nonce,
                        ciphertext,
                        key_version,
                        now,
                        actor
                    ],
                )?;
                tx.execute(
                    "INSERT INTO vault_secret_versions
                        (secret_id, version, nonce, ciphertext, key_version, created_at, created_by, source)
                     VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, ?7)",
                    params![id, nonce, ciphertext, key_version, now, actor, request.source.as_str()],
                )?;
                (id, 1)
            }
            (None, None) => unreachable!("a new value always has a value or a generator"),
        };

        store_metadata(&tx, &id, &metadata, metadata_version)?;
        prune_versions(&tx, &id, version, metadata.max_versions)?;
        let action = if value.is_some() {
            if existing.is_some() {
                "secret.update"
            } else {
                "secret.create"
            }
        } else {
            "secret.metadata"
        };
        self.audit_locked(
            tx,
            &coords.audit(AuditEntry::new(request.actor, action, "ok").details(json!({
                "version": version,
                "metadataVersion": metadata_version,
                "source": request.source.as_str(),
                "binding": coords.binding,
            }))),
        );
        let info = find_row(tx, &coords)?
            .map(|(_, info)| info)
            .ok_or_else(|| anyhow!("vault secret write did not persist"))?;
        crate::vault::external::mark_dirty(tx, &coords)?;
        Ok(info)
    }

    /// Store (or replace) one value in the default environment's root folder.
    /// Empty/whitespace-only values clear it, matching the plugin BYOK store's
    /// write-only UI semantics.
    pub async fn set_vault_secret(
        &self,
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
        value: &str,
    ) -> Result<Option<VaultSecretInfo>> {
        let coords = SecretCoords::root(scope, scope_id, binding, name);
        if value.trim().is_empty() {
            self.delete_vault_secret(scope, scope_id, binding, name)
                .await?;
            return Ok(None);
        }
        self.write_secret(WriteRequest {
            coords,
            value: Some(value),
            patch: SecretMetadataPatch::default(),
            actor: &AuditActor::system(),
            source: VersionSource::Write,
            expected_version: None,
        })
        .await
        .map(Some)
    }

    /// Soft-delete one value in the default environment's root folder.
    pub async fn delete_vault_secret(
        &self,
        scope: SecretScope,
        scope_id: &str,
        binding: Option<&SecretBinding>,
        name: &str,
    ) -> Result<()> {
        self.soft_delete(
            SecretCoords::root(scope, scope_id, binding, name),
            &AuditActor::system(),
        )
        .await
        .map(|_| ())
    }

    /// Soft-delete a value: it stops resolving and leaves the listing, but its
    /// history is kept for [`Self::restore`]. Idempotent.
    pub async fn soft_delete(&self, coords: SecretCoords, actor: &AuditActor) -> Result<bool> {
        let coords = coords.normalize()?;
        let conn = self.conn.lock().await;
        crate::vault::external::guard_local_write(&conn, &coords)?;
        let deleted = self.soft_delete_locked(&conn, &coords, actor)?;
        self.flush_audit(&conn);
        Ok(deleted)
    }

    /// [`Self::soft_delete`] on normalized coordinates under a held lock.
    fn soft_delete_locked(
        &self,
        conn: &Connection,
        coords: &SecretCoords,
        actor: &AuditActor,
    ) -> Result<bool> {
        let Some((id, info)) = find_row(conn, coords)? else {
            return Ok(false);
        };
        if info.deleted_at.is_some() {
            return Ok(false);
        }
        conn.execute(
            "UPDATE vault_secrets SET deleted_at = ?1, deleted_by = ?2 WHERE id = ?3",
            params![now_millis(), actor_id(actor), id],
        )?;
        crate::vault::external::mark_dirty(conn, coords)?;
        self.audit_locked(
            conn,
            &coords.audit(AuditEntry::new(actor, "secret.delete", "ok")),
        );
        Ok(true)
    }

    /// Undo a soft delete.
    pub async fn restore(
        &self,
        coords: SecretCoords,
        actor: &AuditActor,
    ) -> Result<VaultSecretInfo> {
        let coords = coords.normalize()?;
        let conn = self.conn.lock().await;
        crate::vault::external::guard_local_write(&conn, &coords)?;
        let Some((id, _)) = find_row(&conn, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        conn.execute(
            "UPDATE vault_secrets SET deleted_at = NULL, deleted_by = NULL, updated_at = ?1,
                 updated_by = ?2 WHERE id = ?3",
            params![now_millis(), actor_id(actor), id],
        )?;
        crate::vault::external::mark_dirty(&conn, &coords)?;
        self.audit_locked(
            &conn,
            &coords.audit(AuditEntry::new(actor, "secret.restore", "ok")),
        );
        find_row(&conn, &coords)?
            .map(|(_, info)| info)
            .ok_or_else(|| anyhow!("restored secret disappeared"))
    }

    /// Permanently destroy versions. `None` destroys the value and its whole
    /// history; `Some(list)` destroys those non-current versions only.
    pub async fn destroy(
        &self,
        coords: SecretCoords,
        versions: Option<&[i64]>,
        actor: &AuditActor,
    ) -> Result<usize> {
        let coords = coords.normalize()?;
        let conn = self.conn.lock().await;
        crate::vault::external::guard_local_write(&conn, &coords)?;
        let Some((id, info)) = find_row(&conn, &coords)? else {
            return Ok(0);
        };
        let tx = conn.unchecked_transaction()?;
        let removed = match versions {
            None => {
                let count = tx.execute(
                    "DELETE FROM vault_secret_versions WHERE secret_id = ?1",
                    params![id],
                )?;
                tx.execute("DELETE FROM vault_secrets WHERE id = ?1", params![id])?;
                crate::vault::external::mark_dirty(&tx, &coords)?;
                count.max(1)
            }
            Some(list) => {
                if list.contains(&info.version) {
                    return Err(VaultError::Invalid(
                        "the current version cannot be destroyed; write a new value first".into(),
                    )
                    .into());
                }
                let mut count = 0;
                for version in list {
                    count += tx.execute(
                        "UPDATE vault_secret_versions SET nonce = NULL, ciphertext = NULL,
                             destroyed = 1 WHERE secret_id = ?1 AND version = ?2 AND destroyed = 0",
                        params![id, version],
                    )?;
                }
                count
            }
        };
        self.audit_locked(
            &tx,
            &coords.audit(
                AuditEntry::new(actor, "secret.destroy", "ok")
                    .details(json!({ "versions": versions })),
            ),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(removed)
    }

    /// Make an old version current again by writing it as a new version.
    pub async fn rollback(
        &self,
        coords: SecretCoords,
        version: i64,
        actor: &AuditActor,
    ) -> Result<VaultSecretInfo> {
        let coords = coords.normalize()?;
        let plaintext = {
            let conn = self.conn.lock().await;
            let Some((id, _)) = find_row(&conn, &coords)? else {
                return Err(VaultError::NotFound("secret".into()).into());
            };
            let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>, u32, Option<i64>)> = conn
                .query_row(
                    "SELECT nonce, ciphertext, key_version, deleted_at FROM vault_secret_versions
                     WHERE secret_id = ?1 AND version = ?2",
                    params![id, version],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            match row {
                Some((_, _, _, Some(_))) => {
                    return Err(VaultError::Invalid(format!(
                        "version {version} is deleted; undelete it first"
                    ))
                    .into())
                }
                Some((Some(nonce), Some(ciphertext), key_version, None)) => {
                    self.open_row(key_version, &nonce, &ciphertext)?
                }
                Some(_) => {
                    return Err(
                        VaultError::Invalid(format!("version {version} was destroyed")).into(),
                    )
                }
                None => return Err(VaultError::NotFound(format!("version {version}")).into()),
            }
        };
        let value = String::from_utf8(plaintext).context("stored value is not UTF-8")?;
        self.write_secret(WriteRequest {
            coords,
            value: Some(&value),
            patch: SecretMetadataPatch::default(),
            actor,
            source: VersionSource::Rollback,
            expected_version: None,
        })
        .await
    }

    // ── Reads (metadata) ──────────────────────────────────────────────────

    /// Metadata for one value, including a soft-deleted one.
    pub async fn secret_info(&self, coords: &SecretCoords) -> Result<Option<VaultSecretInfo>> {
        let coords = coords.clone().normalize()?;
        let conn = self.conn.lock().await;
        Ok(find_row(&conn, &coords)?.map(|(_, info)| info))
    }

    /// Every live value's metadata, all environments. Callers must filter this
    /// projection through their authorization context before returning it.
    pub async fn list_vault_secrets(&self) -> Result<Vec<VaultSecretInfo>> {
        self.list_vault_secrets_filtered(&ListFilter::default())
            .await
    }

    /// Filtered metadata listing. Ciphertext columns are never selected.
    pub async fn list_vault_secrets_filtered(
        &self,
        filter: &ListFilter,
    ) -> Result<Vec<VaultSecretInfo>> {
        let path = match &filter.path {
            Some(path) => Some(normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?),
            None => None,
        };
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT {INFO_COLUMNS} FROM vault_secrets
             ORDER BY updated_at DESC, scope ASC, scope_id ASC, environment ASC, path ASC, name ASC"
        );
        let mut stmt = conn.prepare(&sql).context("preparing vault listing")?;
        let rows = stmt
            .query_map([], info_from_row)
            .context("querying vault listing")?;
        let mut out = Vec::new();
        for row in rows {
            let Some((_, info)) = row.context("reading vault metadata")? else {
                continue;
            };
            if !filter.include_deleted && info.deleted_at.is_some() {
                continue;
            }
            if filter
                .environment
                .as_ref()
                .is_some_and(|env| env != &info.environment)
            {
                continue;
            }
            if let Some(path) = &path {
                let inside = if filter.recursive {
                    path == ROOT_PATH
                        || &info.path == path
                        || info.path.starts_with(&format!("{path}/"))
                } else {
                    &info.path == path
                };
                if !inside {
                    continue;
                }
            }
            out.push(info);
        }
        Ok(out)
    }

    /// Decrypt the current value of every live secret matching `filter`.
    /// Not audited per value: the caller (export, scan) checks `read` and
    /// writes one summary audit row.
    pub(crate) async fn current_values(
        &self,
        filter: &ListFilter,
    ) -> Result<Vec<(VaultSecretInfo, String)>> {
        let wanted = self.list_vault_secrets_filtered(filter).await?;
        let mut out = Vec::with_capacity(wanted.len());
        let conn = self.conn.lock().await;
        for info in wanted {
            let coords = info.coords();
            let (binding_kind, binding_id) = coords.binding_parts();
            let row: Option<(u32, Vec<u8>, Vec<u8>)> = conn
                .query_row(
                    "SELECT key_version, nonce, ciphertext FROM vault_secrets
                     WHERE scope = ?1 AND scope_id = ?2 AND environment = ?3 AND path = ?4
                       AND binding_kind = ?5 AND binding_id = ?6 AND name = ?7",
                    params![
                        coords.scope.as_str(),
                        coords.scope_id,
                        coords.environment,
                        coords.path,
                        binding_kind,
                        binding_id,
                        coords.name
                    ],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((key_version, nonce, ciphertext)) = row else {
                continue;
            };
            let plain = self.open_row(key_version, &nonce, &ciphertext)?;
            out.push((
                info,
                String::from_utf8(plain).context("stored value is not UTF-8")?,
            ));
        }
        Ok(out)
    }

    /// Version history for one value, newest first.
    pub async fn list_versions(&self, coords: &SecretCoords) -> Result<Vec<SecretVersionInfo>> {
        let coords = coords.clone().normalize()?;
        let conn = self.conn.lock().await;
        let Some((id, info)) = find_row(&conn, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        let mut stmt = conn.prepare(
            "SELECT version, created_at, created_by, source, destroyed, deleted_at
             FROM vault_secret_versions WHERE secret_id = ?1 ORDER BY version DESC",
        )?;
        let rows = stmt.query_map(params![id], |row| {
            Ok(SecretVersionInfo {
                version: row.get(0)?,
                created_at: row.get(1)?,
                created_by: row.get(2)?,
                source: row.get(3)?,
                destroyed: row.get::<_, i64>(4)? != 0,
                current: false,
                deleted_at: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut version = row?;
            version.current = version.version == info.version;
            out.push(version);
        }
        Ok(out)
    }

    // ── Reveal ────────────────────────────────────────────────────────────

    /// Decrypt one value (or one historical version) for an authorized
    /// reveal/export. The caller must have checked the `read` capability.
    pub async fn reveal(
        &self,
        coords: &SecretCoords,
        version: Option<i64>,
        actor: &AuditActor,
    ) -> Result<String> {
        let coords = coords.clone().normalize()?;
        let conn = self.conn.lock().await;
        let Some((id, info)) = find_row(&conn, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        if info.deleted_at.is_some() && version.is_none() {
            return Err(VaultError::NotFound("secret is deleted".into()).into());
        }
        let wanted = version.unwrap_or(info.version);
        let plain = self.open_version_locked(&conn, &id, wanted)?;
        if !self.audit_locked(
            &conn,
            &coords.audit(
                AuditEntry::new(actor, "secret.read", "ok").details(json!({ "version": wanted })),
            ),
        ) {
            return Err(VaultError::AuditUnavailable.into());
        }
        String::from_utf8(plain).context("stored value is not UTF-8")
    }

    /// Decrypt one stored version of the row `id`.
    fn open_version_locked(&self, conn: &Connection, id: &str, wanted: i64) -> Result<Vec<u8>> {
        let row: Option<(Option<Vec<u8>>, Option<Vec<u8>>, u32, Option<i64>)> = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version, deleted_at FROM vault_secret_versions
                 WHERE secret_id = ?1 AND version = ?2",
                params![id, wanted],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        match row {
            Some((_, _, _, Some(_))) => {
                Err(VaultError::NotFound(format!("version {wanted} is deleted")).into())
            }
            Some((Some(nonce), Some(ciphertext), key_version, None)) => {
                self.open_row(key_version, &nonce, &ciphertext)
            }
            Some(_) => Err(VaultError::Invalid(format!("version {wanted} was destroyed")).into()),
            None => Err(VaultError::NotFound(format!("version {wanted}")).into()),
        }
    }

    /// Decrypt one version (default: the current one, even of a soft-deleted
    /// value) without a read audit. Only for policy checks of values a write
    /// path is about to put back (rollback, restore); never returned to a caller.
    pub(crate) async fn version_value_unaudited(
        &self,
        coords: &SecretCoords,
        version: Option<i64>,
    ) -> Result<String> {
        let coords = coords.clone().normalize()?;
        let conn = self.conn.lock().await;
        let Some((id, info)) = find_row(&conn, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        let plain = self.open_version_locked(&conn, &id, version.unwrap_or(info.version))?;
        String::from_utf8(plain).context("stored value is not UTF-8")
    }

    // ── Environments, folders, imports ────────────────────────────────────

    pub async fn list_environments(&self) -> Result<Vec<Environment>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT slug, name, protected, required_approvals, position, cas_required
             FROM vault_environments ORDER BY position, slug",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Environment {
                slug: row.get(0)?,
                name: row.get(1)?,
                protected: row.get::<_, i64>(2)? != 0,
                required_approvals: row.get::<_, i64>(3)?.clamp(1, 5) as u8,
                position: row.get(4)?,
                cas_required: row.get::<_, i64>(5)? != 0,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    pub async fn environment(&self, slug: &str) -> Result<Option<Environment>> {
        Ok(self
            .list_environments()
            .await?
            .into_iter()
            .find(|env| env.slug == slug))
    }

    pub async fn put_environment(
        &self,
        environment: &Environment,
        actor: &AuditActor,
    ) -> Result<()> {
        if !is_valid_environment(&environment.slug) {
            bail!("environment slug must match ^[a-z0-9][a-z0-9-]{{0,31}}$");
        }
        let name = environment.name.trim();
        if name.is_empty() || name.len() > 64 {
            bail!("environment name must be 1-64 characters");
        }
        if !(1..=5).contains(&environment.required_approvals) {
            bail!("requiredApprovals must be between 1 and 5");
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_environments
                (slug, name, protected, required_approvals, position, created_at, cas_required)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(slug) DO UPDATE SET name = excluded.name, protected = excluded.protected,
                 required_approvals = excluded.required_approvals, position = excluded.position,
                 cas_required = excluded.cas_required",
            params![
                environment.slug,
                name,
                environment.protected as i64,
                environment.required_approvals as i64,
                environment.position,
                now_millis(),
                environment.cas_required as i64
            ],
        )?;
        let mut entry = AuditEntry::new(actor, "environment.put", "ok").details(json!({
            "protected": environment.protected,
            "requiredApprovals": environment.required_approvals,
            "casRequired": environment.cas_required,
        }));
        entry.environment = Some(environment.slug.clone());
        self.audit_locked(&conn, &entry);
        Ok(())
    }

    /// Delete an environment that holds no secrets and no typed items. The
    /// default environment cannot be deleted.
    pub async fn delete_environment(&self, slug: &str, actor: &AuditActor) -> Result<bool> {
        if slug == DEFAULT_ENVIRONMENT {
            return Err(
                VaultError::Invalid("the default environment cannot be deleted".into()).into(),
            );
        }
        let conn = self.conn.lock().await;
        let used: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_secrets WHERE environment = ?1",
            params![slug],
            |row| row.get(0),
        )?;
        if used > 0 {
            return Err(VaultError::Conflict(format!(
                "environment `{slug}` still holds {used} secret(s)"
            ))
            .into());
        }
        let items: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_items WHERE environment = ?1",
            params![slug],
            |row| row.get(0),
        )?;
        if items > 0 {
            return Err(VaultError::Conflict(format!(
                "environment `{slug}` still holds {items} item(s)"
            ))
            .into());
        }
        conn.execute(
            "DELETE FROM vault_folders WHERE environment = ?1",
            params![slug],
        )?;
        conn.execute(
            "DELETE FROM vault_imports WHERE environment = ?1 OR source_environment = ?1",
            params![slug],
        )?;
        let removed = conn.execute(
            "DELETE FROM vault_environments WHERE slug = ?1",
            params![slug],
        )? > 0;
        let mut entry = AuditEntry::new(actor, "environment.delete", "ok");
        entry.environment = Some(slug.to_owned());
        self.audit_locked(&conn, &entry);
        Ok(removed)
    }

    /// Folders in an environment: explicit folders plus every folder in use.
    pub async fn list_folders(&self, environment: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut folders = BTreeSet::new();
        folders.insert(ROOT_PATH.to_owned());
        for sql in [
            "SELECT path FROM vault_folders WHERE environment = ?1",
            "SELECT DISTINCT path FROM vault_secrets WHERE environment = ?1 AND deleted_at IS NULL",
        ] {
            let mut stmt = conn.prepare(sql)?;
            let rows = stmt.query_map(params![environment], |row| row.get::<_, String>(0))?;
            for row in rows {
                let path = row?;
                // Include every ancestor so the tree is navigable.
                let mut prefix = String::new();
                for segment in path
                    .trim_start_matches('/')
                    .split('/')
                    .filter(|s| !s.is_empty())
                {
                    prefix.push('/');
                    prefix.push_str(segment);
                    folders.insert(prefix.clone());
                }
            }
        }
        Ok(folders.into_iter().collect())
    }

    pub async fn create_folder(&self, environment: &str, path: &str) -> Result<String> {
        if !is_valid_environment(environment) {
            bail!("invalid environment");
        }
        let path = normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR IGNORE INTO vault_folders (environment, path, created_at) VALUES (?1, ?2, ?3)",
            params![environment, path, now_millis()],
        )?;
        Ok(path)
    }

    /// Delete an empty folder (explicit row only).
    pub async fn delete_folder(&self, environment: &str, path: &str) -> Result<bool> {
        let path = normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let conn = self.conn.lock().await;
        let used: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_secrets WHERE environment = ?1
               AND (path = ?2 OR path LIKE ?3) AND deleted_at IS NULL",
            params![environment, path, format!("{path}/%")],
            |row| row.get(0),
        )?;
        if used > 0 {
            return Err(VaultError::Conflict("the folder is not empty".into()).into());
        }
        Ok(conn.execute(
            "DELETE FROM vault_folders WHERE environment = ?1 AND path = ?2",
            params![environment, path],
        )? > 0)
    }

    pub async fn list_imports(&self) -> Result<Vec<FolderImport>> {
        let conn = self.conn.lock().await;
        list_imports_locked(&conn)
    }

    pub async fn add_import(
        &self,
        import: &FolderImport,
        actor: &AuditActor,
    ) -> Result<FolderImport> {
        for env in [&import.environment, &import.source_environment] {
            if !is_valid_environment(env) {
                bail!("invalid environment `{env}`");
            }
        }
        let path = normalize_path(&import.path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let source_path = normalize_path(&import.source_path)
            .ok_or_else(|| anyhow!("invalid source folder path"))?;
        if import.environment == import.source_environment && path == source_path {
            bail!("a folder cannot import itself");
        }
        let stored = FolderImport {
            id: format!("vim_{}", uuid::Uuid::new_v4().simple()),
            environment: import.environment.clone(),
            path,
            source_environment: import.source_environment.clone(),
            source_path,
            position: import.position,
        };
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_imports
                (id, environment, path, source_environment, source_path, position, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                stored.id,
                stored.environment,
                stored.path,
                stored.source_environment,
                stored.source_path,
                stored.position,
                now_millis()
            ],
        )
        .map_err(|_| VaultError::Conflict("this import already exists".into()))?;
        let mut entry = AuditEntry::new(actor, "import.add", "ok").details(json!({
            "sourceEnvironment": stored.source_environment,
            "sourcePath": stored.source_path,
        }));
        entry.environment = Some(stored.environment.clone());
        entry.path = Some(stored.path.clone());
        self.audit_locked(&conn, &entry);
        Ok(stored)
    }

    pub async fn remove_import(&self, id: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM vault_imports WHERE id = ?1", params![id])? > 0;
        if removed {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "import.remove", "ok").details(json!({ "id": id })),
            );
        }
        Ok(removed)
    }

    // ── Resolution ────────────────────────────────────────────────────────

    /// Resolve one `secret:` reference body against the server-derived
    /// context. The first matching candidate wins according to `user > node >
    /// team > org`; within each scope the folder comes before its imports and
    /// an exact MCP binding wins over an unbound value. No caller-supplied
    /// identity is accepted here.
    pub async fn resolve_vault_secret(
        &self,
        body: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        // `secret:NAME#totp` resolves a stored TOTP seed (Base32 or
        // `otpauth://totp/` URL) to its current code; a value that is not a
        // seed is absent rather than sent upstream as the raw value.
        let (body, totp) = match body.strip_suffix(TOTP_SUFFIX) {
            Some(stripped) => (stripped, true),
            None => (body, false),
        };
        let Some(reference) = SecretRef::parse(body) else {
            bail!("invalid vault secret reference");
        };
        let mut visited = Vec::new();
        let value = self
            .resolve_reference(reference, context, 0, &mut visited)
            .await?;
        if !totp {
            return Ok(value);
        }
        Ok(value.and_then(|seed| crate::vault::totp::current_code_from_seed_value(&seed)))
    }

    fn resolve_reference<'a>(
        &'a self,
        reference: SecretRef,
        context: &'a SecretResolutionContext,
        depth: usize,
        visited: &'a mut Vec<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>>> + Send + 'a>>
    {
        Box::pin(async move {
            let active = context
                .environment
                .clone()
                .filter(|env| is_valid_environment(env))
                .unwrap_or_else(crate::vault::active_environment);
            let environment = reference.environment_or(&active);
            let key = policy_key(&environment, &reference.path, &reference.name);
            if visited.contains(&key) || depth > MAX_REFERENCE_DEPTH {
                return Ok(None);
            }
            // `visited` is the current recursion stack, not every key seen: a
            // value may use the same reference twice (`${A}:${A}`) without
            // that being a cycle.
            visited.push(key);
            let result = match self
                .find_for_context(&environment, &reference.path, &reference.name, context)
                .await
            {
                Err(error) => Err(error),
                Ok(None) => Ok(None),
                Ok(Some(found)) if !found.expand => Ok(Some(found.value)),
                Ok(Some(found)) => {
                    self.expand_references(&found, context, depth + 1, visited)
                        .await
                }
            };
            visited.pop();
            result
        })
    }

    async fn expand_references(
        &self,
        found: &Resolved,
        context: &SecretResolutionContext,
        depth: usize,
        visited: &mut Vec<String>,
    ) -> Result<Option<String>> {
        let value = &found.value;
        let mut out = String::with_capacity(value.len());
        let mut rest = value.as_str();
        while let Some(start) = rest.find("${") {
            // `$${` escapes a literal `${`.
            if start > 0 && rest.as_bytes()[start - 1] == b'$' {
                out.push_str(&rest[..start - 1]);
                out.push_str("${");
                rest = &rest[start + 2..];
                continue;
            }
            out.push_str(&rest[..start]);
            let after = &rest[start + 2..];
            let Some(end) = after.find('}') else {
                out.push_str(&rest[start..]);
                rest = "";
                break;
            };
            let inner = after[..end].trim();
            let body = if inner.contains(':') {
                inner.to_owned()
            } else if inner.starts_with('/') || found.coords.path == ROOT_PATH {
                format!("{}:{inner}", found.coords.environment)
            } else {
                format!("{}:{}/{inner}", found.coords.environment, found.coords.path)
            };
            let Some(reference) = SecretRef::parse(&body) else {
                return Ok(None);
            };
            let Some(resolved) = self
                .resolve_reference(reference, context, depth, visited)
                .await?
            else {
                // Fail closed: a partially expanded credential is never sent.
                return Ok(None);
            };
            out.push_str(&resolved);
            rest = &after[end + 1..];
        }
        out.push_str(rest);
        Ok(Some(out))
    }

    /// The folder lookup chain: the folder, then its imports (depth-limited).
    fn folder_chain(
        conn: &Connection,
        environment: &str,
        path: &str,
    ) -> Result<Vec<(String, String)>> {
        let imports = list_imports_locked(conn)?;
        let mut chain = vec![(environment.to_owned(), path.to_owned())];
        let mut frontier = vec![(environment.to_owned(), path.to_owned())];
        for _ in 0..MAX_IMPORT_DEPTH {
            let mut next = Vec::new();
            for (env, folder) in &frontier {
                let mut sources: Vec<&FolderImport> = imports
                    .iter()
                    .filter(|import| &import.environment == env && &import.path == folder)
                    .collect();
                sources.sort_by_key(|import| import.position);
                for import in sources {
                    let pair = (
                        import.source_environment.clone(),
                        import.source_path.clone(),
                    );
                    if !chain.contains(&pair) {
                        chain.push(pair.clone());
                        next.push(pair);
                    }
                }
            }
            if next.is_empty() {
                break;
            }
            frontier = next;
        }
        Ok(chain)
    }

    /// Candidate `(scope, scope_id)` pairs for a dispatch context, in
    /// precedence order ([`SecretScope::precedence`], the contract ladder).
    pub(crate) fn candidate_scopes(
        context: &SecretResolutionContext,
    ) -> Vec<(SecretScope, String)> {
        // A shared value is never resolved without a server-derived user. This
        // prevents a raw node bearer or an agent-less background job from
        // turning an org/team name into a shared-secret read.
        let has_user = context.user_id.is_some();
        let mut scopes: Vec<(SecretScope, String)> = Vec::new();
        for scope in SecretScope::precedence() {
            let scope_id = match scope {
                SecretScope::User => context
                    .user_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value)),
                SecretScope::Node => {
                    Some(context.node_id.as_str()).filter(|value| is_valid_scope_id(value))
                }
                SecretScope::Team if has_user => context
                    .team_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value))
                    .filter(|team| {
                        context
                            .team_authority
                            .as_ref()
                            .is_some_and(|authority| authority.allows(context, team))
                    }),
                SecretScope::Org if has_user => context
                    .org_id
                    .as_deref()
                    .filter(|value| is_valid_scope_id(value)),
                SecretScope::Team | SecretScope::Org => None,
            };
            if let Some(scope_id) = scope_id {
                scopes.push((scope, scope_id.to_owned()));
            }
        }
        scopes
    }

    /// Policy subjects for a dispatch context. Mirrors management's caller
    /// subjects: the user, every verified team of the owner (not only the
    /// conversation's requested team, which selects the Team candidate scope
    /// alone), and the owner's roles. A human broker session adds the role
    /// and team subjects its minter held at mint.
    pub(crate) fn context_subjects(context: &SecretResolutionContext) -> Vec<String> {
        let mut subjects = Vec::new();
        if let Some(user) = &context.user_id {
            subjects.push(format!("user:{user}"));
        }
        if let Some(authority) = &context.team_authority {
            subjects.extend(
                authority
                    .policy_team_ids(context)
                    .iter()
                    .map(|team| format!("team:{team}")),
            );
        }
        subjects.extend(context.roles.iter().map(|role| format!("role:{role}")));
        let minted_by_user = context.user_id.as_ref().is_some_and(|user| {
            context
                .minted_subjects
                .iter()
                .any(|subject| subject.strip_prefix("user:") == Some(user.as_str()))
        });
        if minted_by_user {
            for subject in &context.minted_subjects {
                if (subject.starts_with("role:") || subject.starts_with("team:"))
                    && !subjects.contains(subject)
                {
                    subjects.push(subject.clone());
                }
            }
        }
        subjects
    }

    async fn find_for_context(
        &self,
        environment: &str,
        path: &str,
        name: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<Resolved>> {
        let actor = match &context.user_id {
            Some(user) => AuditActor::new("user", Some(user)),
            None => AuditActor::new("agent", None),
        };
        // Without the owner's verified roles and teams, the `role:`/`team:`
        // denies that bind them cannot be evaluated: fail closed.
        if context.principal_unverified {
            let mut entry = AuditEntry::new(&actor, "secret.use", "denied").details(json!({
                "conversationId": context.conversation_id,
                "mcpIds": context.mcp_ids,
                "reason": "principal_unverified",
            }));
            entry.environment = Some(environment.to_owned());
            entry.path = Some(path.to_owned());
            entry.name = Some(name.to_owned());
            self.audit(&entry).await;
            return Ok(None);
        }
        let scopes = Self::candidate_scopes(context);
        let subjects = Self::context_subjects(context);
        let templates = crate::vault::policy_ext::TemplateContext::from_subjects(&subjects);
        let (chain, policies) = {
            let conn = self.conn.lock().await;
            (
                Self::folder_chain(&conn, environment, path)?,
                policy::policies_for(&conn, &subjects)?,
            )
        };
        let use_only: CapabilitySet = [Capability::Use].into_iter().collect();
        let now = now_millis();
        let mut denied = false;
        for (scope, scope_id) in &scopes {
            if matches!(scope, SecretScope::Team | SecretScope::Org)
                && crate::vault::shared::is_enabled()
            {
                let key = policy_key(environment, path, name);
                if !policy::evaluate_with(&use_only, &policies, &key, &templates)
                    .contains(&Capability::Use)
                {
                    denied = true;
                } else if let Some(shared) = crate::vault::shared::resolve(
                    context,
                    *scope,
                    scope_id,
                    environment,
                    path,
                    name,
                )
                .await
                {
                    let resolved = Resolved {
                        value: shared.value,
                        coords: SecretCoords {
                            scope: *scope,
                            scope_id: scope_id.clone(),
                            environment: shared.environment,
                            path: shared.path,
                            binding: None,
                            name: name.to_owned(),
                        },
                        version: shared.version,
                        expand: shared.expand_references,
                        source: "shared",
                    };
                    if !self.audit_use(&actor, context, &resolved, "ok").await {
                        return Err(VaultError::AuditUnavailable.into());
                    }
                    return Ok(Some(resolved));
                }
            }
            for (folder_env, folder_path) in &chain {
                let key = policy_key(folder_env, folder_path, name);
                if !policy::evaluate_with(&use_only, &policies, &key, &templates)
                    .contains(&Capability::Use)
                {
                    denied = true;
                    continue;
                }
                // A node folder with a live external source resolves only
                // through the store; an outage fails the whole lookup closed.
                if *scope == SecretScope::Node {
                    use crate::vault::external::LiveLookup;
                    match self
                        .external_live_lookup(scope_id, folder_env, folder_path, name)
                        .await?
                    {
                        LiveLookup::NotSourced => {}
                        LiveLookup::Missing => continue,
                        LiveLookup::Found { value, version } => {
                            let resolved = Resolved {
                                value,
                                coords: SecretCoords {
                                    scope: *scope,
                                    scope_id: scope_id.clone(),
                                    environment: folder_env.clone(),
                                    path: folder_path.clone(),
                                    binding: None,
                                    name: name.to_owned(),
                                },
                                version,
                                expand: false,
                                source: "external",
                            };
                            if !self.audit_use(&actor, context, &resolved, "ok").await {
                                return Err(VaultError::AuditUnavailable.into());
                            }
                            return Ok(Some(resolved));
                        }
                        LiveLookup::Unavailable => {
                            let entry = AuditEntry::new(&actor, "secret.use", "unavailable")
                                .secret("node", scope_id, folder_env, folder_path, name)
                                .details(json!({ "conversationId": context.conversation_id }));
                            self.audit(&entry).await;
                            return Ok(None);
                        }
                    }
                }
                let bindings = context
                    .mcp_ids
                    .iter()
                    .filter(|id| is_valid_scope_id(id))
                    .map(|id| {
                        Some(SecretBinding {
                            kind: SecretBindingKind::Mcp,
                            id: id.clone(),
                        })
                    })
                    .chain(std::iter::once(None));
                for binding in bindings {
                    let coords = SecretCoords {
                        scope: *scope,
                        scope_id: scope_id.clone(),
                        environment: folder_env.clone(),
                        path: folder_path.clone(),
                        binding,
                        name: name.to_owned(),
                    };
                    match self.current_value(&coords, now).await? {
                        CurrentValue::Value {
                            value,
                            version,
                            expand,
                        } => {
                            let resolved = Resolved {
                                value,
                                coords,
                                version,
                                expand,
                                source: "local",
                            };
                            if !self.audit_use(&actor, context, &resolved, "ok").await {
                                return Err(VaultError::AuditUnavailable.into());
                            }
                            return Ok(Some(resolved));
                        }
                        CurrentValue::Expired => {
                            let mut entry =
                                coords.audit(AuditEntry::new(&actor, "secret.use", "expired"));
                            entry.details = json!({ "conversationId": context.conversation_id });
                            self.audit(&entry).await;
                        }
                        CurrentValue::Missing => {}
                    }
                }
            }
        }
        let outcome = if denied { "denied" } else { "not_found" };
        let mut entry = AuditEntry::new(&actor, "secret.use", outcome).details(json!({
            "conversationId": context.conversation_id,
            "mcpIds": context.mcp_ids,
        }));
        entry.environment = Some(environment.to_owned());
        entry.path = Some(path.to_owned());
        entry.name = Some(name.to_owned());
        self.audit(&entry).await;
        Ok(None)
    }

    async fn audit_use(
        &self,
        actor: &AuditActor,
        context: &SecretResolutionContext,
        resolved: &Resolved,
        outcome: &str,
    ) -> bool {
        let entry =
            resolved.coords.audit(
                AuditEntry::new(actor, "secret.use", outcome).details(json!({
                    "version": resolved.version,
                    "source": resolved.source,
                    "binding": resolved.coords.binding,
                    "conversationId": context.conversation_id,
                    "mcpIds": context.mcp_ids,
                })),
            );
        let permitted = self.audit(&entry).await;
        crate::vault::shared::forward_gateway_audit(
            &resolved.coords.policy_key(),
            context.user_id.clone(),
            context.conversation_id.clone(),
        );
        permitted
    }

    async fn current_value(&self, coords: &SecretCoords, now: i64) -> Result<CurrentValue> {
        let (binding_kind, binding_id) = coords.binding_parts();
        let row: Option<(u32, Vec<u8>, Vec<u8>, i64, Option<i64>, i64)> = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT key_version, nonce, ciphertext, version, expires_at, expand_references
                 FROM vault_secrets
                 WHERE scope = ?1 AND scope_id = ?2 AND environment = ?3 AND path = ?4
                   AND binding_kind = ?5 AND binding_id = ?6 AND name = ?7
                   AND deleted_at IS NULL",
                params![
                    coords.scope.as_str(),
                    coords.scope_id,
                    coords.environment,
                    coords.path,
                    binding_kind,
                    binding_id,
                    coords.name
                ],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .optional()
            .context("reading vault_secrets")?
        };
        let Some((key_version, nonce, ciphertext, version, expires_at, expand)) = row else {
            return Ok(CurrentValue::Missing);
        };
        if expires_at.is_some_and(|at| at <= now) {
            return Ok(CurrentValue::Expired);
        }
        match self.open_row(key_version, &nonce, &ciphertext) {
            Ok(plain) => Ok(CurrentValue::Value {
                value: String::from_utf8_lossy(&plain).into_owned(),
                version,
                expand: expand != 0,
            }),
            Err(error) => {
                tracing::warn!(
                    scope = coords.scope.as_str(),
                    name = coords.name,
                    "vault secret could not be decrypted; treating it as unset: {error:#}"
                );
                Ok(CurrentValue::Missing)
            }
        }
    }

    /// Resolve `secret:` tokens inside a server-side MCP header or environment
    /// template. Literal text is preserved exactly. If any secret reference is
    /// unavailable, the whole template is absent so a caller never
    /// accidentally sends the literal reference upstream. `secret:op://…` and
    /// `secret:bws://…` resolve through a password-manager account once a
    /// human approved the owner's use (see [`crate::vault::password_managers`]).
    pub async fn resolve_vault_template(
        &self,
        template: &str,
        context: &SecretResolutionContext,
    ) -> Result<Option<String>> {
        let mut out = String::with_capacity(template.len());
        let mut cursor = 0;
        let mut saw_reference = false;

        while cursor < template.len() {
            let rest = &template[cursor..];
            let whitespace_len = rest
                .chars()
                .take_while(|character| character.is_whitespace())
                .map(char::len_utf8)
                .sum::<usize>();
            if whitespace_len > 0 {
                out.push_str(&rest[..whitespace_len]);
                cursor += whitespace_len;
                continue;
            }

            let word_len = rest.find(char::is_whitespace).unwrap_or(rest.len());
            let word = &rest[..word_len];
            cursor += word_len;
            let Some(body) = word.strip_prefix("secret:") else {
                out.push_str(word);
                continue;
            };
            saw_reference = true;
            // `secret:op://…` / `secret:bws://…`: a password-manager reference,
            // resolved behind per-consumer approval (absent while pending).
            let value = if crate::vault::password_managers::has_pm_scheme(body) {
                self.pm_resolve_for_runtime(body, context).await?
            } else {
                self.resolve_vault_secret(body, context).await?
            };
            let Some(value) = value else {
                return Ok(None);
            };
            out.push_str(&value);
        }

        if saw_reference {
            Ok(Some(out))
        } else {
            Ok(Some(template.to_owned()))
        }
    }

    /// The effective local values a context would resolve in one folder (and
    /// its imports), keyed by name, for `export`/`run`. Precedence matches
    /// runtime resolution. Values the context may not `read` are skipped by the
    /// caller through `allow`.
    pub async fn effective_local_values(
        &self,
        context: &SecretResolutionContext,
        environment: &str,
        path: &str,
        allow: impl Fn(&SecretCoords) -> bool,
    ) -> Result<BTreeMap<String, (SecretCoords, String)>> {
        let path = normalize_path(path).ok_or_else(|| anyhow!("invalid folder path"))?;
        let chain = {
            let conn = self.conn.lock().await;
            Self::folder_chain(&conn, environment, &path)?
        };
        let scopes = Self::candidate_scopes(context);
        let now = now_millis();
        let listing = self.list_vault_secrets().await?;
        let mut out: BTreeMap<String, (SecretCoords, String)> = BTreeMap::new();
        for (scope, scope_id) in &scopes {
            for (folder_env, folder_path) in &chain {
                for info in listing.iter().filter(|info| {
                    &info.scope == scope
                        && &info.scope_id == scope_id
                        && &info.environment == folder_env
                        && &info.path == folder_path
                        && info.binding.is_none()
                }) {
                    if out.contains_key(&info.name) {
                        continue;
                    }
                    let coords = info.coords();
                    if !allow(&coords) {
                        continue;
                    }
                    if let CurrentValue::Value { value, .. } =
                        self.current_value(&coords, now).await?
                    {
                        out.insert(info.name.clone(), (coords, value));
                    }
                }
            }
        }
        Ok(out)
    }

    // ── Rotation and rewrap ───────────────────────────────────────────────

    /// Live values with a generator whose rotation period has elapsed.
    pub async fn due_generated_rotations(&self) -> Result<Vec<SecretCoords>> {
        let now = now_millis();
        Ok(self
            .list_vault_secrets()
            .await?
            .into_iter()
            .filter(|info| info.metadata.generator.is_some())
            .filter(|info| info.status(now) == SecretStatus::RotationDue)
            .map(|info| info.coords())
            .collect())
    }

    /// Rotate one generated value now.
    pub async fn rotate_generated(
        &self,
        coords: SecretCoords,
        actor: &AuditActor,
    ) -> Result<VaultSecretInfo> {
        let info = self
            .secret_info(&coords)
            .await?
            .ok_or_else(|| VaultError::NotFound("secret".into()))?;
        let Some(generator) = info.metadata.generator.clone() else {
            return Err(VaultError::Invalid("this secret has no generator".into()).into());
        };
        let value = {
            let conn = self.conn.lock().await;
            generator.generate_with(&conn)?
        };
        self.write_secret(WriteRequest {
            coords,
            value: Some(&value),
            patch: SecretMetadataPatch::default(),
            actor,
            source: VersionSource::Rotate,
            expected_version: None,
        })
        .await
    }

    /// Re-seal every encrypted row with the active key version. Returns the
    /// number of rows rewritten.
    pub async fn rewrap_all(&self, actor: &AuditActor) -> Result<usize> {
        let active = self.keyring.active_version();
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let mut rewritten = 0;
        for table in crate::vault::ENCRYPTED_TABLES {
            let rows: Vec<(i64, u32, Vec<u8>, Vec<u8>)> = {
                let mut stmt = tx.prepare(&format!(
                    "SELECT rowid, key_version, nonce, ciphertext FROM {table}
                     WHERE key_version != ?1 AND nonce IS NOT NULL AND ciphertext IS NOT NULL"
                ))?;
                let mapped = stmt.query_map(params![active], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })?;
                mapped.collect::<rusqlite::Result<Vec<_>>>()?
            };
            for (rowid, key_version, nonce, ciphertext) in rows {
                let plain = self.open_row(key_version, &nonce, &ciphertext)?;
                let (version, nonce, ciphertext) = self.seal_row(&plain)?;
                tx.execute(
                    &format!(
                        "UPDATE {table} SET key_version = ?1, nonce = ?2, ciphertext = ?3 WHERE rowid = ?4"
                    ),
                    params![version, nonce, ciphertext, rowid],
                )?;
                rewritten += 1;
            }
        }
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "sys.rewrap", "ok")
                .details(json!({ "rows": rewritten, "keyVersion": active })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(rewritten)
    }
}

enum CurrentValue {
    Value {
        value: String,
        version: i64,
        expand: bool,
    },
    Expired,
    Missing,
}

fn list_imports_locked(conn: &Connection) -> Result<Vec<FolderImport>> {
    let mut stmt = conn.prepare(
        "SELECT id, environment, path, source_environment, source_path, position
         FROM vault_imports ORDER BY environment, path, position, created_at",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(FolderImport {
            id: row.get(0)?,
            environment: row.get(1)?,
            path: row.get(2)?,
            source_environment: row.get(3)?,
            source_path: row.get(4)?,
            position: row.get(5)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

// ── KV v2 folders (Vault-compatible surface) ──────────────────────────────

/// A node folder addressed as one KV v2 secret by the Vault-compatible API.
#[derive(Debug, Clone)]
pub struct KvFolder {
    pub scope_id: String,
    pub environment: String,
    pub path: String,
}

/// A KV v2 folder's node keys (including soft-deleted ones) and its version.
#[derive(Debug, Clone)]
pub struct KvFolderState {
    pub keys: Vec<VaultSecretInfo>,
    /// Monotonic: every KV v2 replace advances it by one, and a direct write
    /// to any key in the folder advances it too.
    pub version: i64,
}

/// One atomic KV v2 replace of a folder's key set.
pub struct KvFolderReplace<'a> {
    pub folder: KvFolder,
    /// Keys to write, with their coordinates already in `folder`.
    pub writes: Vec<(SecretCoords, String)>,
    /// Live keys absent from `writes` that the caller may remove. A live key
    /// outside this set (it appeared after the caller authorized) fails the
    /// replace instead of being removed unchecked.
    pub removable: BTreeSet<String>,
    /// KV v2 check-and-set: the folder version the caller last saw (`0`:
    /// create only).
    pub cas: Option<i64>,
    pub actor: &'a AuditActor,
}

fn kv_folder_state_locked(conn: &Connection, folder: &KvFolder) -> Result<KvFolderState> {
    let sql = format!(
        "SELECT {INFO_COLUMNS} FROM vault_secrets
         WHERE scope = ?1 AND scope_id = ?2 AND environment = ?3 AND path = ?4
           AND binding_kind = '' AND binding_id = ''
         ORDER BY name"
    );
    let mut stmt = conn.prepare(&sql).context("preparing kv folder read")?;
    let rows = stmt
        .query_map(
            params![
                SecretScope::Node.as_str(),
                folder.scope_id,
                folder.environment,
                folder.path
            ],
            info_from_row,
        )
        .context("querying kv folder")?;
    let mut keys = Vec::new();
    for row in rows {
        if let Some((_, info)) = row.context("reading kv folder key")? {
            keys.push(info);
        }
    }
    let key_sum: i64 = keys.iter().map(|info| info.version).sum();
    let stored: Option<(i64, i64)> = conn
        .query_row(
            "SELECT version, key_sum FROM vault_kv_folder_versions
             WHERE scope_id = ?1 AND environment = ?2 AND path = ?3",
            params![folder.scope_id, folder.environment, folder.path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .context("reading kv folder version")?;
    // Every per-key write raises the key-version sum, so writes made outside
    // this surface still advance the folder version.
    let version = match stored {
        Some((version, at_sum)) => version + (key_sum - at_sum).max(0),
        None => key_sum,
    };
    Ok(KvFolderState { keys, version })
}

impl PluginSecretStore {
    /// A KV v2 folder's keys and version, read under one lock.
    pub async fn kv_folder_state(&self, folder: &KvFolder) -> Result<KvFolderState> {
        let conn = self.conn.lock().await;
        kv_folder_state_locked(&conn, folder)
    }

    /// Replace a KV v2 folder's key set atomically: the check-and-set
    /// comparison, every write and removal, and the version bump run in one
    /// transaction under the store lock, so concurrent replaces serialize
    /// and a failure leaves the folder unchanged.
    pub async fn kv_folder_replace(&self, request: KvFolderReplace<'_>) -> Result<KvFolderState> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let before = kv_folder_state_locked(&tx, &request.folder)?;
        if request.cas.is_some_and(|cas| cas != before.version) {
            return Err(VaultError::Conflict(
                "check-and-set parameter did not match the current version".into(),
            )
            .into());
        }
        let written: BTreeSet<&str> = request
            .writes
            .iter()
            .map(|(coords, _)| coords.name.as_str())
            .collect();
        let mut removals = Vec::new();
        for info in before.keys.iter().filter(|info| info.deleted_at.is_none()) {
            if written.contains(info.name.as_str()) {
                continue;
            }
            if !request.removable.contains(&info.name) {
                return Err(VaultError::Conflict(
                    "the secret changed concurrently; retry the write".into(),
                )
                .into());
            }
            removals.push(info.coords());
        }
        for (coords, value) in &request.writes {
            // A matched folder-level `cas` is the request's check-and-set, so
            // each key carries its current version (0 to create) and a
            // `casRequired` secret or environment accepts the write. Without
            // `cas` the key-level gate still refuses it.
            let expected_version = match request.cas {
                Some(_) => Some(
                    find_row(&tx, &coords.clone().normalize()?)?
                        .map_or(0, |(_, info)| info.version),
                ),
                None => None,
            };
            self.write_secret_locked(
                &tx,
                &WriteRequest {
                    coords: coords.clone(),
                    value: Some(value),
                    patch: SecretMetadataPatch::default(),
                    actor: request.actor,
                    source: VersionSource::Write,
                    expected_version,
                },
                &WriteOptions::default(),
            )?;
        }
        for coords in removals {
            crate::vault::external::guard_local_write(&tx, &coords)?;
            self.soft_delete_locked(&tx, &coords.normalize()?, request.actor)?;
        }
        let after = kv_folder_state_locked(&tx, &request.folder)?;
        let version = before.version + 1;
        let key_sum: i64 = after.keys.iter().map(|info| info.version).sum();
        tx.execute(
            "INSERT INTO vault_kv_folder_versions (scope_id, environment, path, version, key_sum)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (scope_id, environment, path)
             DO UPDATE SET version = excluded.version, key_sum = excluded.key_sum",
            params![
                request.folder.scope_id,
                request.folder.environment,
                request.folder.path,
                version,
                key_sum
            ],
        )?;
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(KvFolderState {
            keys: after.keys,
            version,
        })
    }

    /// Forget a KV v2 folder's version after its keys were destroyed, so a
    /// recreated secret starts again at version 1 (KV v2 metadata delete).
    pub async fn kv_folder_forget(&self, folder: &KvFolder) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "DELETE FROM vault_kv_folder_versions
             WHERE scope_id = ?1 AND environment = ?2 AND path = ?3",
            params![folder.scope_id, folder.environment, folder.path],
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "kv_tests.rs"]
mod tests;
