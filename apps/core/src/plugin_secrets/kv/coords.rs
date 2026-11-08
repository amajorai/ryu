//! Value coordinates, request/listing types, and the row mappers shared
//! by every store path.

use super::*;

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
        // Project values live only in the control plane: no local row may
        // ever carry the scope, so every store path refuses it here.
        if self.scope == SecretScope::Project {
            return Err(VaultError::Invalid(
                "project values live only in the organization's control plane".into(),
            )
            .into());
        }
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

    pub(in crate::plugin_secrets) fn binding_parts(&self) -> (&'static str, &str) {
        self.binding
            .as_ref()
            .map(SecretBinding::storage_parts)
            .unwrap_or(("", ""))
    }

    /// `ENV/folder/NAME` for policy evaluation.
    pub fn policy_key(&self) -> String {
        policy_key(&self.environment, &self.path, &self.name)
    }

    pub(in crate::plugin_secrets) fn audit(&self, entry: AuditEntry) -> AuditEntry {
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
    pub(super) fn as_str(self) -> &'static str {
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

pub(super) fn one() -> u8 {
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

pub(in crate::plugin_secrets) const INFO_COLUMNS: &str =
    "id, scope, scope_id, environment, path, binding_kind,
    binding_id, name, version, description, tags, expires_at, rotation_period_secs, generator,
    expand_references, max_versions, created_at, created_by, updated_at, updated_by, rotated_at,
    deleted_at, custom_metadata, cas_required, delete_version_after_secs, metadata_version,
    value_type";

pub(super) fn binding_from(kind: &str, id: String) -> Option<Option<SecretBinding>> {
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
pub(in crate::plugin_secrets) fn info_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<Option<(String, VaultSecretInfo)>> {
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
        value_type: ValueType::from_column(&row.get::<_, String>(26)?),
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

pub(in crate::plugin_secrets) fn find_row(
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

pub(in crate::plugin_secrets) fn actor_id(actor: &AuditActor) -> Option<String> {
    actor
        .id
        .clone()
        .map(|id| format!("{}:{id}", actor.kind))
        .or_else(|| Some(actor.kind.clone()))
}

/// Whether `environment` requires check-and-set on every value write.
pub(in crate::plugin_secrets) fn environment_cas_required(
    conn: &Connection,
    environment: &str,
) -> Result<bool> {
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
pub(in crate::plugin_secrets) fn prune_versions(
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
pub(in crate::plugin_secrets) fn store_metadata(
    conn: &Connection,
    id: &str,
    metadata: &SecretMetadata,
    metadata_version: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE vault_secrets SET description = ?1, tags = ?2, expires_at = ?3,
             rotation_period_secs = ?4, generator = ?5, expand_references = ?6,
             max_versions = ?7, custom_metadata = ?8, cas_required = ?9,
             delete_version_after_secs = ?10, metadata_version = ?11, value_type = ?12
         WHERE id = ?13",
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
            metadata.value_type.as_str(),
            id
        ],
    )?;
    Ok(())
}
