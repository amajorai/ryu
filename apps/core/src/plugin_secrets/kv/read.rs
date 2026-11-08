//! Metadata reads, version listings, and audited reveals.

use super::*;

impl PluginSecretStore {
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
        // A sealed value is use-only: refused (and audited as such) before
        // anything is decrypted, for every caller and every version.
        if !info.metadata.value_type.is_revealable() {
            self.audit_locked(
                &conn,
                &coords.audit(
                    AuditEntry::new(actor, "secret.read", "denied")
                        .details(json!({ "version": wanted, "reason": "sealed" })),
                ),
            );
            return Err(VaultError::Denied(SEALED_USE_ONLY.into()).into());
        }
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
    pub(super) fn open_version_locked(
        &self,
        conn: &Connection,
        id: &str,
        wanted: i64,
    ) -> Result<Vec<u8>> {
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
}
