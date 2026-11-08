//! KV v2 folders (Vault-compatible surface).

use super::*;

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

pub(super) fn kv_folder_state_locked(
    conn: &Connection,
    folder: &KvFolder,
) -> Result<KvFolderState> {
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
