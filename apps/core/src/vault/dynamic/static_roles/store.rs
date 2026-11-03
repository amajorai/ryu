//! Static-role storage: create/replace (stamping the role's writer), list,
//! read, delete, and the sealed rotation state.
//!
//! test-exempt: moved out of `static_roles.rs` to keep it within the size limits; covered by
//! `static_roles/tests.rs` and `target_guard_test.rs`.

use super::*;

impl PluginSecretStore {
    /// Create or replace a static role as a configuration manager. Test-only:
    /// request handlers must stamp the real writer with the `_as` variant.
    #[cfg(test)]
    pub async fn static_put_role(
        &self,
        name: &str,
        input: &StaticRoleInput,
        target: SecretCoords,
        actor: &AuditActor,
    ) -> Result<StaticRoleInfo> {
        self.static_put_role_as(name, input, target, RoleWriter::Manager, actor)
            .await
    }

    /// Create or replace a static role, stamping `writer` on it (see
    /// [`target_guard`]). A new or re-targeted role is due at once; the
    /// scheduler (or `static_rotate`) performs the first rotation.
    pub async fn static_put_role_as(
        &self,
        name: &str,
        input: &StaticRoleInput,
        target: SecretCoords,
        writer: RoleWriter,
        actor: &AuditActor,
    ) -> Result<StaticRoleInfo> {
        if !crate::vault::dynamic::is_valid_role_name(name) {
            return Err(VaultError::Invalid("invalid static role name".into()).into());
        }
        input
            .provider
            .validate()
            .and_then(|()| match writer {
                RoleWriter::Manager => Ok(()),
                RoleWriter::Delegate => target_guard::precheck_static(&input.provider),
            })
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        if !(MIN_ROTATION_SECS..=MAX_ROTATION_SECS).contains(&input.rotation_period_secs) {
            return Err(VaultError::Invalid(format!(
                "rotationPeriodSecs must be {MIN_ROTATION_SECS} to {MAX_ROTATION_SECS}"
            ))
            .into());
        }
        let length = input.password_length.unwrap_or(DEFAULT_PASSWORD_LENGTH);
        password_generator(length)
            .validate()
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let target = target
            .normalize()
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let now = now_millis();
        let target_json = serde_json::to_string(&target)?;
        let _guard = rotation_lock().lock().await;
        let conn = self.conn.lock().await;
        // An edit of the same account and target (schedule, admin
        // credentials, statements) keeps the rotation clock, the pending
        // credential, and Core-managed fields; a new account or target
        // rotates from scratch. A pending credential may already be live
        // upstream, so it is never discarded: re-pointing a role while one is
        // pending is refused until the rotation completes.
        let existing: Option<(String, Vec<u8>, Vec<u8>, u32)> = conn
            .query_row(
                "SELECT target, nonce, ciphertext, key_version FROM vault_static_roles WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let mut state = SealedState {
            provider: input.provider.clone(),
            pending: None,
            retired_access_keys: Vec::new(),
            egress: TargetEgress::default(),
        };
        let mut next_rotation_at = now;
        if let Some((old_target, old_nonce, old_ciphertext, old_version)) = existing {
            let old: SealedState = serde_json::from_slice(&self.open_row(
                old_version,
                &old_nonce,
                &old_ciphertext,
            )?)?;
            let same_account =
                old.provider.account() == input.provider.account() && old_target == target_json;
            if same_account {
                state = SealedState {
                    provider: input.provider.with_managed_fields_from(&old.provider),
                    pending: old.pending,
                    retired_access_keys: old.retired_access_keys,
                    egress: TargetEgress::default(),
                };
                let info = info_locked(&conn, name)?;
                next_rotation_at = match info.last_rotated_at {
                    Some(at) => at + input.rotation_period_secs * 1000,
                    None => info.next_rotation_at,
                };
            } else if old.pending.is_some() {
                return Err(VaultError::Conflict(format!(
                    "static role `{name}` has a pending rotation for its current account; \
                     rotate it successfully before changing the account or target"
                ))
                .into());
            } else if !old.retired_access_keys.is_empty() {
                return Err(VaultError::Conflict(format!(
                    "static role `{name}` still has replaced access keys ({}) that could not \
                     be deleted; rotate it successfully (or delete them in AWS and recreate \
                     the role) before changing the account or target",
                    old.retired_access_keys.join(", ")
                ))
                .into());
            }
        }
        let keep_pending = state.pending.is_some();
        let sealed = self.seal_row(&serde_json::to_vec(&state)?)?;
        conn.execute(
            "INSERT INTO vault_static_roles
                 (name, provider, summary, target, rotation_period_secs, password_length,
                  next_rotation_at, pending, created_at, updated_at, nonce, ciphertext, key_version,
                  writer)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(name) DO UPDATE SET provider = excluded.provider,
                 summary = excluded.summary, target = excluded.target,
                 rotation_period_secs = excluded.rotation_period_secs,
                 password_length = excluded.password_length,
                 next_rotation_at = excluded.next_rotation_at, pending = excluded.pending,
                 updated_at = excluded.updated_at, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, key_version = excluded.key_version,
                 writer = excluded.writer",
            params![
                name,
                input.provider.kind(),
                input.provider.summary().to_string(),
                target_json,
                input.rotation_period_secs,
                length,
                next_rotation_at,
                keep_pending as i64,
                now,
                sealed.1,
                sealed.2,
                sealed.0,
                writer.label()
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.role.put", "ok").details(json!({
                "role": name, "provider": input.provider.kind(), "writer": writer.label()
            })),
        );
        info_locked(&conn, name)
    }

    /// Every static role.
    pub async fn static_list_roles(&self) -> Result<Vec<StaticRoleInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {INFO_COLUMNS} FROM vault_static_roles ORDER BY name"
        ))?;
        let rows = stmt.query_map([], info_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One static role.
    pub async fn static_role(&self, name: &str) -> Result<StaticRoleInfo> {
        let conn = self.conn.lock().await;
        info_locked(&conn, name)
    }

    /// Delete a static role. The account and its last KV value stay as they
    /// are; Ryu just stops rotating it.
    pub async fn static_delete_role(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let _guard = rotation_lock().lock().await;
        let conn = self.conn.lock().await;
        let removed = conn.execute(
            "DELETE FROM vault_static_roles WHERE name = ?1",
            params![name],
        )?;
        if removed == 0 {
            return Err(VaultError::NotFound(format!("static role `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "static.role.delete", "ok").details(json!({ "role": name })),
        );
        Ok(())
    }

    /// The current credential (the target's current KV value). The caller
    /// must have checked `read` on the target.
    pub async fn static_read(
        &self,
        name: &str,
        actor: &AuditActor,
    ) -> Result<(StaticRoleInfo, String)> {
        let info = self.static_role(name).await?;
        let value = self
            .reveal(&info.target, None, actor)
            .await
            .map_err(|error| match error.downcast_ref::<VaultError>() {
                Some(VaultError::NotFound(_)) => {
                    VaultError::NotFound(format!("static role `{name}` has not rotated yet")).into()
                }
                _ => error,
            })?;
        Ok((info, value))
    }

    pub(super) fn static_seal_state(
        &self,
        conn: &Connection,
        name: &str,
        state: &SealedState,
    ) -> Result<()> {
        let (key_version, nonce, ciphertext) = self.seal_row(&serde_json::to_vec(state)?)?;
        conn.execute(
            "UPDATE vault_static_roles SET nonce = ?1, ciphertext = ?2, key_version = ?3,
                 pending = ?4, updated_at = ?5 WHERE name = ?6",
            params![
                nonce,
                ciphertext,
                key_version,
                state.pending.is_some() as i64,
                now_millis(),
                name
            ],
        )?;
        Ok(())
    }

    pub(super) async fn static_state(&self, name: &str) -> Result<(StaticRoleInfo, SealedState)> {
        let conn = self.conn.lock().await;
        let info = info_locked(&conn, name)?;
        let (nonce, ciphertext, key_version, writer): (Vec<u8>, Vec<u8>, u32, Option<String>) =
            conn.query_row(
                "SELECT nonce, ciphertext, key_version, writer FROM vault_static_roles WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        let mut state: SealedState = serde_json::from_slice(&plain)?;
        let table = "vault_static_roles";
        state.egress = target_guard::row_egress(&conn, table, name, writer.as_deref())?;
        Ok((info, state))
    }
}
