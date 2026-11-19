//! Cutting a machine identity off. Disabling or deleting an identity sends
//! every token it ever held through [`PluginSecretStore::token_revoke_tree`],
//! the same path an explicit revoke takes, so descendants are revoked, their
//! cubbyholes destroyed, and the dynamic-credential leases they hold revoked
//! at the provider. A lease the provider refuses to revoke is reported by id
//! and the caller fails closed: the identity stays disabled (and, for a
//! delete, in place) so the operation can be retried.

use super::*;

/// What cutting an identity off touched.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct IdentityRevocation {
    /// Tokens of the identity and their descendants.
    pub tokens: usize,
    /// Leases revoked at their provider by this call.
    pub leases_revoked: usize,
    /// Leases still live afterwards (the provider refused), by id.
    pub leases_left: Vec<String>,
}

/// Every token the identity holds and every descendant, revoked or not.
const IDENTITY_TREE: &str = "WITH RECURSIVE tree(accessor) AS (
         SELECT accessor FROM vault_tokens WHERE identity_id = ?1
         UNION SELECT t.accessor FROM vault_tokens t
               JOIN tree ON t.parent_accessor = tree.accessor
     )";

impl PluginSecretStore {
    /// Live leases held by any token of `identity_id` or a descendant, by id.
    pub(in crate::vault) async fn machine_live_leases(
        &self,
        identity_id: &str,
    ) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "{IDENTITY_TREE} SELECT id FROM vault_leases
             WHERE revoked_at IS NULL AND token_accessor IN (SELECT accessor FROM tree)
             ORDER BY id"
        ))?;
        let rows = stmt.query_map(params![identity_id], |row| row.get(0))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Revoke every token of `identity_id` with its descendants, cubbyholes
    /// and leases. Tokens already marked revoked are included, so leases a
    /// previous cut-off left live are revoked now.
    pub(in crate::vault) async fn machine_revoke_tokens(
        &self,
        identity_id: &str,
        actor: &AuditActor,
    ) -> Result<IdentityRevocation> {
        let roots: Vec<String> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT accessor FROM vault_tokens WHERE identity_id = ?1 ORDER BY created_at",
            )?;
            let rows = stmt.query_map(params![identity_id], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let mut revocation = IdentityRevocation::default();
        for accessor in &roots {
            let report = self.token_revoke_tree(accessor, false, actor).await?;
            revocation.leases_revoked += report.leases_revoked;
        }
        let conn = self.conn.lock().await;
        revocation.tokens = conn.query_row(
            &format!("{IDENTITY_TREE} SELECT COUNT(*) FROM tree"),
            params![identity_id],
            |row| row.get::<_, i64>(0),
        )? as usize;
        revocation.leases_left = live_leases_locked(&conn, identity_id)?;
        if !revocation.leases_left.is_empty() {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, "machine.revoke", "error").details(json!({
                    "identity": identity_id,
                    "leasesLeft": revocation.leases_left,
                })),
            );
        }
        Ok(revocation)
    }
}

/// Live leases held by any token of the identity or a descendant, by id.
pub(super) fn live_leases_locked(conn: &Connection, identity_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!(
        "{IDENTITY_TREE} SELECT id FROM vault_leases
         WHERE revoked_at IS NULL AND token_accessor IN (SELECT accessor FROM tree)
         ORDER BY id"
    ))?;
    let rows = stmt.query_map(params![identity_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The fail-closed refusal when leases outlived their tokens' revocation.
pub(super) fn leases_left_error(identity: &MachineIdentity, leases: &[String]) -> anyhow::Error {
    VaultError::Conflict(format!(
        "machine identity `{}` is disabled, but {} lease(s) its tokens hold could not be revoked \
         at the provider: {}. Retry once the provider is reachable, or revoke them as leases.",
        identity.name,
        leases.len(),
        leases.join(", ")
    ))
    .into()
}

#[cfg(test)]
#[path = "machine_revoke_tests.rs"]
mod tests;
