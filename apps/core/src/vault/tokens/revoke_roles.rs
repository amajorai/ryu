//! Token revocation, identity token settings, token roles and pruning.

use anyhow::Result;
use rusqlite::params;
use serde_json::json;

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::machine::{MachineIdentity, MAX_TOKEN_TTL_SECS};
use crate::vault::{now_millis, VaultError};

use super::*;
use super::{cidr::*, config::*, issue::*, schema::*};

impl PluginSecretStore {
    /// Revoke a token. Without `orphan_children`, its descendants go with it;
    /// with it, direct children become orphans and survive. Every revoked
    /// token's cubbyhole is destroyed and its live leases are revoked at the
    /// provider (a provider failure leaves the lease for the reaper).
    pub async fn token_revoke_tree(
        &self,
        accessor: &str,
        orphan_children: bool,
        actor: &AuditActor,
    ) -> Result<RevokeReport> {
        let (accessors, leases) = {
            let conn = self.conn.lock().await;
            let tx = conn.unchecked_transaction()?;
            let accessors: Vec<String> = if orphan_children {
                tx.execute(
                    "UPDATE vault_tokens SET parent_accessor = NULL, orphan = 1
                     WHERE parent_accessor = ?1",
                    params![accessor],
                )?;
                vec![accessor.to_owned()]
            } else {
                let mut stmt = tx.prepare(
                    "WITH RECURSIVE tree(accessor) AS (
                         SELECT ?1
                         UNION SELECT t.accessor FROM vault_tokens t
                               JOIN tree ON t.parent_accessor = tree.accessor
                     )
                     SELECT accessor FROM tree",
                )?;
                let rows = stmt.query_map(params![accessor], |row| row.get(0))?;
                rows.collect::<rusqlite::Result<_>>()?
            };
            let now = now_millis();
            let mut leases = Vec::new();
            for each in &accessors {
                tx.execute(
                    // Clearing `spent_at` marks the revoke as explicit, so a
                    // request in flight on a spent token records no lease.
                    "UPDATE vault_tokens SET revoked_at = COALESCE(revoked_at, ?1), spent_at = NULL
                     WHERE accessor = ?2",
                    params![now, each],
                )?;
                crate::vault::wrapping::cubbyhole_destroy_locked(&tx, each)?;
                let mut stmt = tx.prepare(
                    "SELECT id FROM vault_leases WHERE token_accessor = ?1 AND revoked_at IS NULL",
                )?;
                let rows = stmt.query_map(params![each], |row| row.get::<_, String>(0))?;
                for lease in rows {
                    leases.push(lease?);
                }
            }
            self.audit_locked(
                &tx,
                &AuditEntry::new(actor, "token.revoke", "ok").details(json!({
                    "accessor": accessor,
                    "descendants": accessors.len().saturating_sub(1),
                    "orphanChildren": orphan_children,
                    "leases": leases.len(),
                })),
            );
            tx.commit()?;
            self.flush_audit(&conn);
            (accessors, leases)
        };
        let mut report = RevokeReport {
            tokens: accessors.len(),
            ..RevokeReport::default()
        };
        for lease in leases {
            match self.dynamic_revoke(&lease, actor).await {
                Ok(_) => report.leases_revoked += 1,
                Err(error) => {
                    report.leases_failed += 1;
                    tracing::warn!("revoking lease {lease} with its token: {error:#}");
                }
            }
        }
        Ok(report)
    }

    /// Set an identity's token settings. Applies to tokens issued afterwards.
    pub async fn machine_set_token_config(
        &self,
        id_or_name: &str,
        config: TokenConfig,
        actor: &AuditActor,
    ) -> Result<MachineIdentity> {
        let config = config.normalize()?;
        let conn = self.conn.lock().await;
        let identity = crate::vault::machine::identity_locked(&conn, id_or_name)?;
        conn.execute(
            "UPDATE vault_machine_identities SET token_config = ?1 WHERE id = ?2",
            params![serde_json::to_string(&config)?, identity.id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "machine.token_config", "ok")
                .details(json!({ "identity": identity.id, "config": config })),
        );
        crate::vault::machine::identity_locked(&conn, &identity.id)
    }

    /// Issue an AppRole secret id with CIDR restrictions.
    pub async fn machine_issue_secret_id_with(
        &self,
        id_or_name: &str,
        options: SecretIdOptions,
        actor: &AuditActor,
    ) -> Result<(String, crate::vault::machine::SecretIdInfo)> {
        let cidr_list = normalize_cidrs(&options.cidr_list)?;
        let token_cidrs = normalize_cidrs(&options.token_bound_cidrs)?;
        let identity = self.machine_get(id_or_name).await?;
        if !cidrs_within(&token_cidrs, &identity.token_config.bound_cidrs) {
            return Err(VaultError::Invalid(
                "tokenBoundCidrs must lie inside the identity's boundCidrs".into(),
            )
            .into());
        }
        let (secret, info) = self
            .machine_issue_secret_id(&identity.id, options.ttl_secs, options.uses, actor)
            .await?;
        if cidr_list.is_empty() && token_cidrs.is_empty() {
            return Ok((secret, info));
        }
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE vault_approle_secret_ids SET cidr_list = ?1, token_bound_cidrs = ?2
             WHERE accessor = ?3",
            params![
                list_json(&cidr_list)?,
                list_json(&token_cidrs)?,
                info.accessor
            ],
        );
        if let Err(error) = updated {
            // Never leave a secret id behind without the bounds it was issued with.
            let _ = conn.execute(
                "DELETE FROM vault_approle_secret_ids WHERE accessor = ?1",
                params![info.accessor],
            );
            return Err(error.into());
        }
        Ok((secret, info))
    }

    /// Create or replace a token role.
    pub async fn token_role_put(&self, role: TokenRole, actor: &AuditActor) -> Result<TokenRole> {
        if !crate::vault::transit::is_valid_key_name(&role.name) {
            return Err(VaultError::Invalid("invalid token role name".into()).into());
        }
        check_range(
            "ttlSecs",
            role.ttl_secs,
            MIN_CHILD_TTL_SECS,
            MAX_TOKEN_TTL_SECS,
        )?;
        let token = role.token.clone().normalize()?;
        let stored = TokenRole {
            token,
            created_at: 0,
            updated_at: 0,
            ..role
        };
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_token_roles (name, config, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET config = excluded.config,
                                              updated_at = excluded.updated_at",
            params![stored.name, serde_json::to_string(&stored)?, now],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "token.role.put", "ok").details(json!({ "role": stored.name })),
        );
        load_role_locked(&conn, &stored.name)
    }

    /// One token role.
    pub async fn token_role_get(&self, name: &str) -> Result<TokenRole> {
        let conn = self.conn.lock().await;
        load_role_locked(&conn, name)
    }

    /// Every token role.
    pub async fn token_role_list(&self) -> Result<Vec<TokenRole>> {
        let conn = self.conn.lock().await;
        let names: Vec<String> = {
            let mut stmt = conn.prepare("SELECT name FROM vault_token_roles ORDER BY name")?;
            let rows = stmt.query_map([], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        names
            .iter()
            .map(|name| load_role_locked(&conn, name))
            .collect()
    }

    /// Delete a token role (tokens minted from it keep their settings).
    pub async fn token_role_delete(&self, name: &str, actor: &AuditActor) -> Result<bool> {
        let conn = self.conn.lock().await;
        let deleted = conn.execute(
            "DELETE FROM vault_token_roles WHERE name = ?1",
            params![name],
        )? > 0;
        self.audit_locked(
            &conn,
            &AuditEntry::new(
                actor,
                "token.role.delete",
                if deleted { "ok" } else { "not_found" },
            )
            .details(json!({ "role": name })),
        );
        Ok(deleted)
    }

    /// Prune wrapping tokens, tombstones, and cubbyholes of dead tokens.
    pub async fn token_lifecycle_prune(&self) -> Result<usize> {
        let conn = self.conn.lock().await;
        crate::vault::wrapping::wrapping_prune_locked(&conn, now_millis())
    }
}
