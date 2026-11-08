//! Per-version soft delete and undelete, and `deleteVersionAfterSecs`.

use super::*;

impl PluginSecretStore {
    /// Soft-delete chosen non-current versions: they stop being revealable or
    /// usable as a rollback source until undeleted. Returns the versions that
    /// changed (already deleted, destroyed, and unknown versions are skipped).
    pub async fn delete_versions(
        &self,
        coords: SecretCoords,
        versions: &[i64],
        actor: &AuditActor,
    ) -> Result<Vec<i64>> {
        self.set_versions_deleted(coords, versions, true, actor)
            .await
    }

    /// Undo [`Self::delete_versions`]. Destroyed versions cannot be undeleted.
    pub async fn undelete_versions(
        &self,
        coords: SecretCoords,
        versions: &[i64],
        actor: &AuditActor,
    ) -> Result<Vec<i64>> {
        self.set_versions_deleted(coords, versions, false, actor)
            .await
    }

    async fn set_versions_deleted(
        &self,
        coords: SecretCoords,
        versions: &[i64],
        deleted: bool,
        actor: &AuditActor,
    ) -> Result<Vec<i64>> {
        let coords = coords.normalize()?;
        let wanted: BTreeSet<i64> = versions.iter().copied().collect();
        if wanted.is_empty() || wanted.len() > MAX_MAX_VERSIONS as usize {
            return Err(VaultError::Invalid(format!(
                "versions must list 1 to {MAX_MAX_VERSIONS} version numbers"
            ))
            .into());
        }
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let Some((id, info)) = find_row(&tx, &coords)? else {
            return Err(VaultError::NotFound("secret".into()).into());
        };
        if deleted && wanted.contains(&info.version) {
            return Err(VaultError::Invalid(
                "the current version cannot be deleted; delete the secret or write a new value first"
                    .into(),
            )
            .into());
        }
        let now = now_millis();
        let by = actor_id(actor);
        let mut changed = Vec::new();
        for version in wanted {
            let count = if deleted {
                tx.execute(
                    "UPDATE vault_secret_versions SET deleted_at = ?1, deleted_by = ?2
                     WHERE secret_id = ?3 AND version = ?4 AND deleted_at IS NULL
                       AND destroyed = 0",
                    params![now, by, id, version],
                )?
            } else {
                tx.execute(
                    "UPDATE vault_secret_versions SET deleted_at = NULL, deleted_by = NULL
                     WHERE secret_id = ?1 AND version = ?2 AND deleted_at IS NOT NULL
                       AND destroyed = 0",
                    params![id, version],
                )?
            };
            if count > 0 {
                changed.push(version);
            }
        }
        let action = if deleted {
            "secret.version.delete"
        } else {
            "secret.version.undelete"
        };
        self.audit_locked(
            &tx,
            &coords.audit(AuditEntry::new(actor, action, "ok").details(json!({
                "versions": changed,
            }))),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(changed)
    }

    /// Soft-delete non-current versions older than their value's
    /// `deleteVersionAfterSecs`. Called by the vault scheduler; needs no key
    /// material. Returns the number of versions deleted.
    pub async fn enforce_delete_version_after(&self) -> Result<usize> {
        let now = now_millis();
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let due: Vec<(String, i64)> = {
            let mut stmt = tx.prepare(
                "SELECT v.secret_id, v.version FROM vault_secret_versions v
                 JOIN vault_secrets s ON s.id = v.secret_id
                 WHERE s.delete_version_after_secs IS NOT NULL AND v.version != s.version
                   AND v.deleted_at IS NULL AND v.destroyed = 0
                   AND v.created_at + s.delete_version_after_secs * 1000 <= ?1
                 ORDER BY v.secret_id, v.version",
            )?;
            let rows = stmt.query_map(params![now], |row| Ok((row.get(0)?, row.get(1)?)))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        let mut by_secret: BTreeMap<String, Vec<i64>> = BTreeMap::new();
        for (id, version) in due {
            by_secret.entry(id).or_default().push(version);
        }
        let system = AuditActor::system();
        let by = actor_id(&system);
        let mut total = 0;
        for (id, versions) in by_secret {
            for version in &versions {
                total += tx.execute(
                    "UPDATE vault_secret_versions SET deleted_at = ?1, deleted_by = ?2
                     WHERE secret_id = ?3 AND version = ?4 AND deleted_at IS NULL",
                    params![now, by, id, version],
                )?;
            }
            let info = tx
                .query_row(
                    &format!("SELECT {INFO_COLUMNS} FROM vault_secrets WHERE id = ?1"),
                    params![id],
                    info_from_row,
                )?
                .map(|(_, info)| info);
            let entry = AuditEntry::new(&system, "secret.version.delete", "ok").details(json!({
                "versions": versions,
                "reason": "deleteVersionAfter",
            }));
            let entry = match &info {
                Some(info) => info.coords().audit(entry),
                None => entry,
            };
            self.audit_locked(&tx, &entry);
        }
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(total)
    }
}
