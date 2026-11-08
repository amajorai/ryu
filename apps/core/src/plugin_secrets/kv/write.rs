//! Value writes, deletes, restores, destroys, and rollbacks.

use super::*;

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
    pub(super) fn write_secret_locked(
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
    pub(super) fn soft_delete_locked(
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
}
