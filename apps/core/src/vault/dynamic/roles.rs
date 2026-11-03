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
    target_guard::ensure_writer_column(conn, "vault_dynamic_roles")
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
        (default_ttl_secs, max_ttl_secs): (Option<i64>, Option<i64>),
        writer: RoleWriter,
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
        if let Some((old_nonce, old_ciphertext, old_key_version, old_writer)) = stored {
            let previous = self.open_row(old_key_version, &old_nonce, &old_ciphertext)?;
            let changed = serde_json::from_slice::<Value>(&previous)?
                != serde_json::from_slice::<Value>(&sealed_config)?
                || target_guard::screens_existing_role(old_writer.as_deref(), writer);
            let live: i64 = conn.query_row(
                "SELECT COUNT(*) FROM vault_leases WHERE role = ?1 AND revoked_at IS NULL",
                params![name],
                |row| row.get(0),
            )?;
            if changed && live > 0 {
                return Err(VaultError::Conflict(format!(
                    "role `{name}` has {live} live lease(s); revoke them before changing its provider configuration"
                ))
                .into());
            }
        }
        conn.execute(
            "INSERT INTO vault_dynamic_roles
                 (name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at,
                  nonce, ciphertext, key_version, writer)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(name) DO UPDATE SET provider = excluded.provider,
                 default_ttl_secs = excluded.default_ttl_secs,
                 max_ttl_secs = excluded.max_ttl_secs, summary = excluded.summary,
                 updated_at = excluded.updated_at, nonce = excluded.nonce,
                 ciphertext = excluded.ciphertext, key_version = excluded.key_version,
                 writer = excluded.writer",
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
                writer.label()
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "dynamic.role.put", "ok").details(
                json!({ "role": name, "provider": config.kind(), "writer": writer.label() }),
            ),
        );
        role_info_locked(&conn, name)
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
        Ok((info, config))
    }
}

fn role_info_locked(conn: &Connection, name: &str) -> Result<DynamicRoleInfo> {
    conn.query_row(
        "SELECT name, provider, default_ttl_secs, max_ttl_secs, summary, created_at, updated_at
         FROM vault_dynamic_roles WHERE name = ?1",
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
            })
        },
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("dynamic role `{name}`")).into())
}
