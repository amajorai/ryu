//! Generated-value rotation, keyring rewrap, retired data-key pruning, and the
//! scheduled data-key rotation.

use super::*;

impl PluginSecretStore {
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
        let pruned = self.prune_keyring_locked(&tx, now_millis())?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "sys.rewrap", "ok").details(
                json!({ "rows": rewritten, "keyVersion": active, "prunedKeyVersions": pruned }),
            ),
        );
        tx.commit()?;
        self.keyring.forget_versions(&pruned);
        self.flush_audit(&conn);
        Ok(rewritten)
    }

    /// Delete retired data keys no sealed row references (see
    /// [`crate::vault::keyring::PRUNE_GRACE_MILLIS`]) on `conn`, the caller's
    /// transaction. Returns the deleted versions; the caller drops them from
    /// memory with `forget_versions` once the transaction commits.
    fn prune_keyring_locked(&self, conn: &Connection, now: i64) -> Result<Vec<u32>> {
        let referenced = referenced_key_versions(conn)?;
        let prunable = self.keyring.prunable_versions(
            conn,
            &referenced,
            now,
            crate::vault::keyring::PRUNE_GRACE_MILLIS,
        )?;
        self.keyring.delete_versions(conn, &prunable)?;
        Ok(prunable)
    }

    /// Delete retired data keys nothing references any more. Audited when
    /// anything was deleted.
    pub async fn prune_keyring(&self, actor: &AuditActor) -> Result<Vec<u32>> {
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let pruned = self.prune_keyring_locked(&tx, now_millis())?;
        if !pruned.is_empty() {
            self.audit_locked(
                &tx,
                &AuditEntry::new(actor, "sys.keyring.prune", "ok")
                    .details(json!({ "prunedKeyVersions": pruned })),
            );
        }
        tx.commit()?;
        self.keyring.forget_versions(&pruned);
        self.flush_audit(&conn);
        Ok(pruned)
    }

    /// Scheduled keyring upkeep: rotate the data key when the active version
    /// is at least `period_millis` old (then rewrap every row onto it), and
    /// prune retired versions. A non-positive period only prunes.
    pub async fn keyring_maintain(&self, period_millis: i64) -> Result<KeyringMaintenance> {
        let actor = AuditActor::system();
        let rotated = {
            let conn = self.conn.lock().await;
            if self
                .keyring
                .rotation_due(&conn, now_millis(), period_millis)?
            {
                let version = self.keyring.rotate(&conn)?;
                self.audit_locked(
                    &conn,
                    &AuditEntry::new(&actor, "sys.rotate", "ok")
                        .details(json!({ "keyVersion": version, "scheduled": true })),
                );
                self.flush_audit(&conn);
                Some(version)
            } else {
                None
            }
        };
        let before = self.keyring.status().key_versions;
        let rewrapped = match rotated {
            Some(_) => self.rewrap_all(&actor).await?,
            None => {
                self.prune_keyring(&actor).await?;
                0
            }
        };
        let after = self.keyring.status().key_versions;
        Ok(KeyringMaintenance {
            rotated,
            rewrapped,
            pruned: before.into_iter().filter(|v| !after.contains(v)).collect(),
        })
    }
}

/// What one [`PluginSecretStore::keyring_maintain`] pass did.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct KeyringMaintenance {
    /// The new active version, when the data key was rotated.
    pub rotated: Option<u32>,
    /// Rows rewrapped onto the new version.
    pub rewrapped: usize,
    /// Retired versions deleted.
    pub pruned: Vec<u32>,
}

/// Key versions some sealed row in [`crate::vault::ENCRYPTED_TABLES`] uses.
fn referenced_key_versions(conn: &Connection) -> Result<BTreeSet<u32>> {
    let mut versions = BTreeSet::new();
    for table in crate::vault::ENCRYPTED_TABLES {
        let mut stmt = conn.prepare(&format!(
            "SELECT DISTINCT key_version FROM {table}
             WHERE nonce IS NOT NULL AND ciphertext IS NOT NULL"
        ))?;
        let rows = stmt.query_map([], |row| row.get::<_, u32>(0))?;
        for version in rows {
            versions.insert(version?);
        }
    }
    Ok(versions)
}

#[cfg(test)]
#[path = "rotation_test.rs"]
mod tests;
