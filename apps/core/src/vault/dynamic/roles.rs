//! Dynamic-role storage: the role table, create/replace (stamping the
//! role's writer, see [`super::target_guard`]), listing, deletion, and the
//! sealed provider config read back for issue, renew and revoke.
//!
//! test-exempt: moved out of `dynamic/mod.rs` to keep it within the size limits; covered by
//! `dynamic/tests.rs` and `target_guard_test.rs`.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use super::target_guard::{self, RoleWriter};
use super::{DynamicRoleInfo, ProviderConfig, DEFAULT_TTL_SECS, MAX_TTL_SECS};
use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{now_millis, VaultError};

/// Create the dynamic role table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_dynamic_roles (
             name             TEXT PRIMARY KEY,
             provider         TEXT NOT NULL,
             default_ttl_secs INTEGER NOT NULL,
             max_ttl_secs     INTEGER NOT NULL,
             summary          TEXT NOT NULL,
             created_at       INTEGER NOT NULL,
             updated_at       INTEGER NOT NULL,
             nonce            BLOB NOT NULL,
             ciphertext       BLOB NOT NULL,
             key_version      INTEGER NOT NULL DEFAULT 0
         );",
    )
    .context("initializing dynamic role schema")?;
    target_guard::ensure_writer_column(conn, "vault_dynamic_roles")?;
    // A token that changes only when a role's provider config or writer
    // really changes (or the role is recreated), unlike the ciphertext, which
    // every keyring rewrap and identical save reseals.
    let has_generation = conn
        .prepare(
            "SELECT 1 FROM pragma_table_info('vault_dynamic_roles') WHERE name = 'generation'",
        )?
        .exists([])?;
    if !has_generation {
        conn.execute_batch("ALTER TABLE vault_dynamic_roles ADD COLUMN generation TEXT;")?;
    }
    conn.execute(
        "UPDATE vault_dynamic_roles SET generation = lower(hex(randomblob(16)))
         WHERE generation IS NULL",
        [],
    )?;
    super::webhook::redact_stored_summaries(conn, "vault_dynamic_roles")
}

/// Role names share the transit key grammar.
pub fn is_valid_role_name(name: &str) -> bool {
    crate::vault::transit::is_valid_key_name(name)
}

impl PluginSecretStore {
    /// Create or replace a dynamic role as a configuration manager. Test-only:
    /// request handlers must stamp the real writer with the `_as` variant.
    #[cfg(test)]
    pub async fn dynamic_put_role(
        &self,
        name: &str,
        config: &ProviderConfig,
        default_ttl_secs: Option<i64>,
        max_ttl_secs: Option<i64>,
        actor: &AuditActor,
    ) -> Result<DynamicRoleInfo> {
        let ttls = (default_ttl_secs, max_ttl_secs);
        self.dynamic_put_role_as(name, config, ttls, RoleWriter::Manager, actor)
            .await
    }

    /// Create or replace a dynamic role, stamping `writer` on it (see
    /// [`target_guard`]): a delegate's role may only target public hosts.
    pub async fn dynamic_put_role_as(
        &self,
        name: &str,
        config: &ProviderConfig,
        ttls: (Option<i64>, Option<i64>),
        writer: RoleWriter,
        actor: &AuditActor,
    ) -> Result<DynamicRoleInfo> {
        self.dynamic_put_role_with(name, config, ttls, writer, false, actor)
            .await
    }

    /// [`Self::dynamic_put_role_as`], where a configuration manager may also
    /// rebind the role's pending retry leases explicitly
    /// (`rebind_retry_leases`). A retry lease is revoked only through the role
    /// it was issued under; after the role changed, a manager's save rebinds
    /// it only if that save changes the provider config or acknowledges the
    /// current one. Anything else (including a manager's identical save,
    /// which only re-stamps the writer) leaves it refused.
    pub async fn dynamic_put_role_with(
        &self,
        name: &str,
        config: &ProviderConfig,
        (default_ttl_secs, max_ttl_secs): (Option<i64>, Option<i64>),
        writer: RoleWriter,
        rebind_retry_leases: bool,
        actor: &AuditActor,
    ) -> Result<DynamicRoleInfo> {
        if !is_valid_role_name(name) {
            return Err(VaultError::Invalid("invalid dynamic role name".into()).into());
        }
        config
            .validate()
            .and_then(|()| match writer {
                RoleWriter::Manager => Ok(()),
                RoleWriter::Delegate => target_guard::precheck_provider(config),
            })
            .map_err(|error| VaultError::Invalid(error.to_string()))?;
        let max = max_ttl_secs.unwrap_or(24 * 3600).clamp(1, MAX_TTL_SECS);
        let default = default_ttl_secs
            .unwrap_or(DEFAULT_TTL_SECS.min(max))
            .clamp(1, max);
        let sealed_config = serde_json::to_vec(config)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&sealed_config)?;
        let now = now_millis();
        if rebind_retry_leases && writer != RoleWriter::Manager {
            return Err(VaultError::Denied(format!(
                "only a configuration manager can rebind the retry leases of role `{name}`"
            ))
            .into());
        }
        let conn = self.conn.lock().await;
        // Renewal and revocation use the role's current provider config, so a
        // config change under live leases would send them to the new target
        // while the old credentials stay active. TTL-only edits are fine.
        // A delegate re-stamping a manager's role also changes where its
        // leases are renewed and revoked from, so it counts as a change.
        let stored: Option<(Vec<u8>, Vec<u8>, u32, Option<String>)> = conn
            .query_row(
                "SELECT nonce, ciphertext, key_version, writer FROM vault_dynamic_roles WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let mut pending_revoke = 0;
        let mut config_changed = false;
        let mut repaired_from: Option<Value> = None;
        if let Some((old_nonce, old_ciphertext, old_key_version, old_writer)) = stored {
            let previous = self.open_row(old_key_version, &old_nonce, &old_ciphertext)?;
            // Compare as parsed configs, so a row stored by an earlier build
            // (a field added since with a default) is not a change.
            let previous_value = match serde_json::from_slice::<ProviderConfig>(&previous) {
                Ok(previous) => serde_json::to_value(previous)?,
                Err(_) => serde_json::from_slice::<Value>(&previous)?,
            };
            let changed = previous_value != serde_json::to_value(config)?
                || target_guard::screens_existing_role(old_writer.as_deref(), writer);
            config_changed = changed;
            let kind_changed =
                previous_value.get("kind").and_then(Value::as_str) != Some(config.kind());
            // Retry leases (credentials never handed out, waiting for their
            // revoke) do not block a configuration manager's change: a failed
            // revoke most often means a wrong config, which must be
            // repairable. A delegate may not make it (the reaper would send
            // the sealed revoke data to a target the delegate chose), and no
            // one may change the provider kind (revoke data sealed for one
            // provider must never reach another). The change is audited with
            // the pending count and the old and new target.
            let (live, pending): (i64, i64) = conn.query_row(
                "SELECT COALESCE(SUM(pending_revoke = 0), 0), COALESCE(SUM(pending_revoke = 1), 0)
                 FROM vault_leases WHERE role = ?1 AND revoked_at IS NULL",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            pending_revoke = pending;
            if changed && live > 0 {
                return Err(VaultError::Conflict(format!(
                    "role `{name}` has {live} live lease(s); revoke them before changing its provider configuration"
                ))
                .into());
            }
            if changed && pending > 0 && writer == RoleWriter::Delegate {
                return Err(VaultError::Conflict(format!(
                    "role `{name}` has credentials waiting for the lease reaper to revoke them; until they are revoked, only a configuration manager can change its provider configuration"
                ))
                .into());
            }
            if changed && pending > 0 && kind_changed {
                return Err(VaultError::Conflict(format!(
                    "role `{name}` has credentials waiting for the lease reaper to revoke them; until they are revoked, its provider kind cannot change"
                ))
                .into());
            }
            if changed && pending > 0 {
                repaired_from = serde_json::from_slice::<ProviderConfig>(&previous)
                    .ok()
                    .map(|config| config.summary());
            }
        }
        // The role, any rebind, and their audit rows commit together.
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "INSERT INTO vault_dynamic_roles
                 (name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at,
                  nonce, ciphertext, key_version, writer, generation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10, ?11)
             ON CONFLICT(name) DO UPDATE SET provider = excluded.provider,
                 default_ttl_secs = excluded.default_ttl_secs,
                 max_ttl_secs = excluded.max_ttl_secs, summary = excluded.summary,
                 updated_at = excluded.updated_at, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, key_version = excluded.key_version,
                 writer = excluded.writer,
                 generation = CASE WHEN ?12 THEN excluded.generation
                                   ELSE vault_dynamic_roles.generation END",
            params![
                name,
                config.kind(),
                default,
                max,
                config.summary().to_string(),
                now,
                nonce,
                ciphertext,
                key_version,
                writer.label(),
                crate::vault::random_token("gen_"),
                config_changed
            ],
        )?;
        if writer == RoleWriter::Manager {
            self.rebind_retry_leases_locked(
                &tx,
                name,
                config,
                repaired_from.clone(),
                (config_changed, rebind_retry_leases),
                actor,
            )?;
        }
        self.audit_locked(
            &tx,
            &AuditEntry::new(actor, "dynamic.role.put", "ok").details(
                json!({ "role": name, "provider": config.kind(), "writer": writer.label(),
                        "pendingRevokeLeases": pending_revoke,
                        "previousTarget": repaired_from,
                        "target": repaired_from.as_ref().map(|_| config.summary()) }),
            ),
        );
        tx.commit()?;
        self.flush_audit(&conn);
        role_info_locked(&conn, name)
    }

    /// Rebind `name`'s pending retry leases that the role's current version
    /// no longer matches (or that have none), when this manager save changes
    /// the provider config or confirms it (`changed`, `confirmed`). Audited in
    /// the caller's transaction with how many, how, and the targets: the
    /// previous one only when this save replaced it (otherwise null).
    fn rebind_retry_leases_locked(
        &self,
        conn: &Connection,
        name: &str,
        config: &ProviderConfig,
        previous_target: Option<Value>,
        (changed, confirmed): (bool, bool),
        actor: &AuditActor,
    ) -> Result<()> {
        if !(changed || confirmed) {
            return Ok(());
        }
        let Some(version) = role_version_locked(conn, name)? else {
            return Ok(());
        };
        let rebound = conn.execute(
            "UPDATE vault_leases SET issued_role_version = ?2
             WHERE role = ?1 AND pending_revoke = 1 AND revoked_at IS NULL
               AND (issued_role_version IS NULL OR issued_role_version != ?2)",
            params![name, version],
        )?;
        if rebound == 0 {
            return Ok(());
        }
        self.audit_locked(
            conn,
            &AuditEntry::new(actor, "dynamic.role.rebind", "ok").details(json!({
                "role": name,
                "reboundRetryLeases": rebound,
                "configChanged": changed,
                "acknowledged": confirmed,
                "previousTarget": previous_target,
                "target": config.summary(),
            })),
        );
        Ok(())
    }

    /// Every dynamic role.
    pub async fn dynamic_list_roles(&self) -> Result<Vec<DynamicRoleInfo>> {
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare("SELECT name FROM vault_dynamic_roles ORDER BY name")?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        names
            .iter()
            .map(|name| role_info_locked(&conn, name))
            .collect()
    }

    /// Delete a role. Live leases stay revocable (their revocation data is
    /// self-contained only for providers that do not need the role config, so
    /// deletion is refused while the role has live leases).
    pub async fn dynamic_delete_role(&self, name: &str, actor: &AuditActor) -> Result<()> {
        let conn = self.conn.lock().await;
        let live: i64 = conn.query_row(
            "SELECT COUNT(*) FROM vault_leases WHERE role = ?1 AND revoked_at IS NULL",
            params![name],
            |row| row.get(0),
        )?;
        if live > 0 {
            return Err(VaultError::Conflict(format!(
                "role `{name}` has {live} live lease(s); revoke them first"
            ))
            .into());
        }
        let removed = conn.execute(
            "DELETE FROM vault_dynamic_roles WHERE name = ?1",
            params![name],
        )?;
        if removed == 0 {
            return Err(VaultError::NotFound(format!("dynamic role `{name}`")).into());
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "dynamic.role.delete", "ok").details(json!({ "role": name })),
        );
        Ok(())
    }

    pub(super) async fn dynamic_role(
        &self,
        name: &str,
    ) -> Result<(DynamicRoleInfo, ProviderConfig)> {
        let (info, config, _) = self.dynamic_role_versioned(name).await?;
        Ok((info, config))
    }

    /// [`Self::dynamic_role`] with the role's version ([`role_version_locked`])
    /// read under the same lock, so a lease can be refused if the role was
    /// rewritten while its credential was being issued.
    pub(super) async fn dynamic_role_versioned(
        &self,
        name: &str,
    ) -> Result<(DynamicRoleInfo, ProviderConfig, String)> {
        let conn = self.conn.lock().await;
        let info = role_info_locked(&conn, name)?;
        let (nonce, ciphertext, key_version, writer): (Vec<u8>, Vec<u8>, u32, Option<String>) =
            conn.query_row(
                "SELECT nonce, ciphertext, key_version, writer FROM vault_dynamic_roles WHERE name = ?1",
                params![name],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        let mut config: ProviderConfig = serde_json::from_slice(&plain)?;
        let table = "vault_dynamic_roles";
        config.set_egress(target_guard::row_egress(
            &conn,
            table,
            name,
            writer.as_deref(),
        )?);
        let version = role_version_locked(&conn, name)?
            .ok_or_else(|| VaultError::NotFound(format!("dynamic role `{name}`")))?;
        Ok((info, config, version))
    }
}

/// A role's version, or `None` when the role is gone: its generation (which
/// changes when its provider config or writer really changes, or when it is
/// deleted and recreated) and its writer. A keyring rewrap or an identical
/// save, which only reseal the config, leave it unchanged.
pub(crate) fn role_version_locked(conn: &Connection, name: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT generation, writer FROM vault_dynamic_roles WHERE name = ?1",
            params![name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    Ok(row.map(|(generation, writer)| {
        format!(
            "{}:{}",
            generation.unwrap_or_default(),
            writer.unwrap_or_default()
        )
    }))
}

fn role_info_locked(conn: &Connection, name: &str) -> Result<DynamicRoleInfo> {
    conn.query_row(
        "SELECT name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at,
                (SELECT COUNT(*) FROM vault_leases l
                 WHERE l.role = r.name AND l.pending_revoke = 1 AND l.revoked_at IS NULL)
         FROM vault_dynamic_roles r WHERE name = ?1",
        params![name],
        |row| {
            Ok(DynamicRoleInfo {
                name: row.get(0)?,
                provider: row.get(1)?,
                default_ttl_secs: row.get(2)?,
                max_ttl_secs: row.get(3)?,
                summary: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or(Value::Null),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                pending_revoke_leases: row.get(7)?,
            })
        },
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("dynamic role `{name}`")).into())
}
