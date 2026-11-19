//! Transit key lifecycle: create, list, rotate, configure, trim, delete, recover, purge.

use super::*;

impl PluginSecretStore {
    pub(super) fn transit_material(
        &self,
        conn: &Connection,
        name: &str,
        version: u32,
    ) -> Result<Vec<u8>> {
        let (nonce, ciphertext, key_version): (Vec<u8>, Vec<u8>, u32) = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version FROM vault_transit_keys
                 WHERE name = ?1 AND version = ?2",
                params![name, version],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?
            .ok_or_else(|| {
                VaultError::NotFound(format!("transit key `{name}` version {version}"))
            })?;
        self.open_row(key_version, &nonce, &ciphertext)
    }

    pub(super) fn insert_transit_material(
        &self,
        conn: &Connection,
        name: &str,
        version: u32,
        material: &[u8],
        public_key: Option<&str>,
        created_at: i64,
    ) -> Result<()> {
        let (key_version, nonce, ciphertext) = self.seal_row(material)?;
        conn.execute(
            "INSERT INTO vault_transit_keys
                (name, version, nonce, ciphertext, key_version, public_key, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                name,
                version,
                nonce,
                ciphertext,
                key_version,
                public_key,
                created_at
            ],
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn insert_transit_key_locked(
        &self,
        conn: &Connection,
        name: &str,
        key_type: TransitKeyType,
        options: &TransitKeyOptions,
        imported: bool,
        material: &[u8],
        public_key: Option<&str>,
        actor: &AuditActor,
        event: &str,
    ) -> Result<()> {
        if let Some(existing) = read_meta(conn, name)? {
            let hint = if existing.deleted_at.is_some() {
                " (soft-deleted; recover or purge it first)"
            } else {
                ""
            };
            return Err(VaultError::Conflict(format!("transit key `{name}` exists{hint}")).into());
        }
        let now = now_millis();
        conn.execute(
            "INSERT INTO vault_transit_meta
                (name, key_type, latest_version, created_at, derived, convergent, exportable,
                 allow_plaintext_backup, auto_rotate_period_secs, imported)
             VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                name,
                key_type.as_str(),
                now,
                options.derived,
                options.convergent,
                options.exportable,
                options.allow_plaintext_backup,
                options.auto_rotate_period_secs,
                imported
            ],
        )?;
        self.insert_transit_material(conn, name, 1, material, public_key, now)?;
        self.audit_locked(
            conn,
            &AuditEntry::new(actor, event, "ok").details(serde_json::json!({
                "key": name, "type": key_type.as_str(), "derived": options.derived,
                "convergent": options.convergent, "exportable": options.exportable,
            })),
        );
        Ok(())
    }

    /// Create a named transit key with default options.
    pub async fn transit_create(
        &self,
        name: &str,
        key_type: TransitKeyType,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        self.transit_create_with(name, key_type, &TransitKeyOptions::default(), actor)
            .await
    }

    /// Create a named transit key.
    pub async fn transit_create_with(
        &self,
        name: &str,
        key_type: TransitKeyType,
        options: &TransitKeyOptions,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        if !is_valid_key_name(name) {
            return Err(invalid("invalid transit key name"));
        }
        validate_key_options(key_type, options)?;
        // RSA generation is slow; never hold the store lock across it.
        let (material, public_key) =
            tokio::task::spawn_blocking(move || new_material(key_type)).await??;
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        self.insert_transit_key_locked(
            &tx,
            name,
            key_type,
            options,
            false,
            &material,
            public_key.as_deref(),
            actor,
            "transit.create",
        )?;
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Every live transit key.
    pub async fn transit_list(&self) -> Result<Vec<TransitKeyInfo>> {
        self.transit_list_where("deleted_at IS NULL").await
    }

    /// Soft-deleted keys that `recover` can still restore.
    pub async fn transit_list_deleted(&self) -> Result<Vec<TransitKeyInfo>> {
        self.transit_list_where("deleted_at IS NOT NULL").await
    }

    pub(super) async fn transit_list_where(&self, filter: &str) -> Result<Vec<TransitKeyInfo>> {
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare(&format!(
                "SELECT name FROM vault_transit_meta WHERE {filter} ORDER BY name"
            ))?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        names
            .iter()
            .map(|name| transit_info_locked(&conn, name))
            .collect()
    }

    /// Add a key version and make it the latest.
    pub async fn transit_rotate(&self, name: &str, actor: &AuditActor) -> Result<TransitKeyInfo> {
        let key_type = {
            let conn = self.conn.lock().await;
            meta(&conn, name)?.key_type
        };
        let (material, public_key) =
            tokio::task::spawn_blocking(move || new_material(key_type)).await??;
        let conn = self.conn.lock().await;
        let tx = conn.unchecked_transaction()?;
        let meta = meta(&tx, name)?;
        if meta.key_type != key_type {
            return Err(VaultError::Conflict(format!("transit key `{name}` changed")).into());
        }
        let next = meta.latest + 1;
        self.insert_transit_material(
            &tx,
            name,
            next,
            &material,
            public_key.as_deref(),
            now_millis(),
        )?;
        tx.execute(
            "UPDATE vault_transit_meta SET latest_version = ?1 WHERE name = ?2",
            params![next, name],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.rotate", "ok")
                .details(serde_json::json!({ "key": name, "version": next })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Update `minDecryptionVersion` and `deletionAllowed`.
    pub async fn transit_configure(
        &self,
        name: &str,
        min_decryption_version: Option<u32>,
        deletion_allowed: Option<bool>,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        self.transit_update_config(
            name,
            &TransitConfigUpdate {
                min_decryption_version,
                deletion_allowed,
                ..TransitConfigUpdate::default()
            },
            actor,
        )
        .await
    }

    /// Update key configuration. Validates everything before writing.
    pub async fn transit_update_config(
        &self,
        name: &str,
        update: &TransitConfigUpdate,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if let Some(min) = update.min_decryption_version {
            if min < meta.min_available || min > meta.latest {
                return Err(invalid(
                    "minDecryptionVersion must be between the minimum available and the latest version",
                ));
            }
        }
        if let Some(min) = update.min_encryption_version {
            if min != 0 && (min < meta.min_available || min > meta.latest) {
                return Err(invalid(
                    "minEncryptionVersion must be 0 or between the minimum available and the latest version",
                ));
            }
        }
        let resulting_min_decrypt = update.min_decryption_version.unwrap_or(meta.min_decrypt);
        let resulting_min_encrypt = update.min_encryption_version.unwrap_or(meta.min_encrypt);
        if resulting_min_encrypt != 0 && resulting_min_encrypt < resulting_min_decrypt {
            return Err(invalid(
                "minEncryptionVersion must be 0 or at least minDecryptionVersion",
            ));
        }
        if update.exportable == Some(false) && meta.exportable {
            return Err(invalid("exportable cannot be switched off once enabled"));
        }
        if update.allow_plaintext_backup == Some(false) && meta.allow_plaintext_backup {
            return Err(invalid(
                "allowPlaintextBackup cannot be switched off once enabled",
            ));
        }
        if let Some(period) = update.auto_rotate_period_secs {
            validate_auto_rotate(period)?;
        }
        let tx = conn.unchecked_transaction()?;
        let set = |column: &str, value: &dyn rusqlite::ToSql| -> Result<()> {
            tx.execute(
                &format!("UPDATE vault_transit_meta SET {column} = ?1 WHERE name = ?2"),
                params![value, name],
            )?;
            Ok(())
        };
        if let Some(min) = update.min_decryption_version {
            set("min_decryption_version", &min)?;
        }
        if let Some(min) = update.min_encryption_version {
            set("min_encryption_version", &min)?;
        }
        if let Some(allowed) = update.deletion_allowed {
            set("deletion_allowed", &allowed)?;
        }
        if update.exportable == Some(true) {
            set("exportable", &true)?;
        }
        if update.allow_plaintext_backup == Some(true) {
            set("allow_plaintext_backup", &true)?;
        }
        if let Some(period) = update.auto_rotate_period_secs {
            set("auto_rotate_period_secs", &period)?;
        }
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.configure", "ok").details(serde_json::json!({
                "key": name,
                "minDecryptionVersion": update.min_decryption_version,
                "minEncryptionVersion": update.min_encryption_version,
                "deletionAllowed": update.deletion_allowed,
                "exportable": update.exportable,
                "allowPlaintextBackup": update.allow_plaintext_backup,
                "autoRotatePeriodSecs": update.auto_rotate_period_secs,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Permanently drop versions below `min_available_version`.
    pub async fn transit_trim(
        &self,
        name: &str,
        min_available_version: u32,
        actor: &AuditActor,
    ) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if min_available_version < meta.min_available
            || min_available_version > meta.min_decrypt
            || (meta.min_encrypt != 0 && min_available_version > meta.min_encrypt)
            || min_available_version > meta.latest
        {
            return Err(invalid(
                "minAvailableVersion must not decrease and must not exceed minDecryptionVersion, \
                 minEncryptionVersion (when set), or the latest version",
            ));
        }
        let tx = conn.unchecked_transaction()?;
        let removed = tx.execute(
            "DELETE FROM vault_transit_keys WHERE name = ?1 AND version < ?2",
            params![name, min_available_version],
        )?;
        tx.execute(
            "UPDATE vault_transit_meta SET min_available_version = ?1 WHERE name = ?2",
            params![min_available_version, name],
        )?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.trim", "ok").details(serde_json::json!({
                "key": name, "minAvailableVersion": min_available_version, "removed": removed,
            })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        transit_info_locked(&conn, name)
    }

    /// Soft-delete a key (only when `deletionAllowed`). [`Self::transit_recover`]
    /// restores it until the scheduler purges it.
    pub async fn transit_delete(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let meta = meta(&conn, name)?;
        if !meta.deletion_allowed {
            return Err(denied("set deletionAllowed before deleting a transit key"));
        }
        conn.execute(
            "UPDATE vault_transit_meta SET deleted_at = ?1 WHERE name = ?2",
            params![now_millis(), name],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.delete", "ok")
                .details(serde_json::json!({ "key": name, "soft": true })),
        );
        Ok(())
    }

    /// Restore a soft-deleted key.
    pub async fn transit_recover(&self, name: &str, actor: &AuditActor) -> Result<TransitKeyInfo> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE vault_transit_meta SET deleted_at = NULL
             WHERE name = ?1 AND deleted_at IS NOT NULL",
            params![name],
        )?;
        if updated == 0 {
            return Err(VaultError::NotFound(format!("soft-deleted transit key `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "transit.recover", "ok")
                .details(serde_json::json!({ "key": name })),
        );
        transit_info_locked(&conn, name)
    }

    /// Permanently delete a key (live or soft-deleted; `deletionAllowed`
    /// must be set).
    pub async fn transit_purge(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let meta = read_meta(&conn, name)?
            .ok_or_else(|| VaultError::NotFound(format!("transit key `{name}`")))?;
        if !meta.deletion_allowed {
            return Err(denied("set deletionAllowed before deleting a transit key"));
        }
        let tx = conn.unchecked_transaction()?;
        purge_locked(&tx, name)?;
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "transit.purge", "ok")
                .details(serde_json::json!({ "key": name })),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(())
    }

    /// Purge soft-deleted keys older than the recovery window. Scheduler step.
    pub async fn transit_purge_expired(&self) -> Result<usize> {
        let cutoff = now_millis() - soft_delete_window_millis();
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT name FROM vault_transit_meta
                 WHERE deleted_at IS NOT NULL AND deleted_at <= ?1",
            )?;
            let rows = stmt.query_map(params![cutoff], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let tx = conn.unchecked_transaction()?;
        for name in &names {
            purge_locked(&tx, name)?;
            self.audit_locked(
                &tx,
                &AuditEntry::new(&AuditActor::system(), "transit.purge", "ok")
                    .details(serde_json::json!({ "key": name, "expired": true })),
            );
        }
        tx.commit()?;
        self.flush_audit(&conn);
        Ok(names.len())
    }

    /// Live keys whose latest version is older than their auto-rotation
    /// period. Scheduler step.
    pub async fn transit_due_rotations(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT m.name FROM vault_transit_meta m
             JOIN vault_transit_keys k ON k.name = m.name AND k.version = m.latest_version
             WHERE m.auto_rotate_period_secs > 0 AND m.deleted_at IS NULL
               AND k.created_at + m.auto_rotate_period_secs * 1000 <= ?1
             ORDER BY m.name",
        )?;
        let rows = stmt.query_map(params![now_millis()], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}
