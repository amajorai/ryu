//! Admin force-revoke of a retry lease.
//!
//! A retry lease (`pending_revoke = 1`, see `lease_record_for_revoke`) holds a
//! credential that was never handed out and whose revoke keeps failing, and it
//! blocks deleting its role. When the operator has revoked that credential at
//! the provider by hand (or accepts that it may still be live), a configuration
//! manager may mark the retry lease revoked here. Nothing is sent to the
//! provider: the row is closed and the action is audited loudly
//! (`lease.revoke`, reason `forced`, `credentialRevoked: false`). A lease that
//! was handed out is never force-revoked; it is revoked through its provider.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::leases::{lease_locked, LeaseInfo};
use crate::vault::{now_millis, VaultError};

/// The refusal for a caller who is not a configuration manager.
const MANAGER_ONLY: &str = "only a configuration manager can force-revoke a retry lease";

/// The refusal for a request without the acknowledgement.
const ACKNOWLEDGEMENT_REQUIRED: &str = "a forced revoke only marks the retry lease revoked in Ryu and revokes nothing at the provider, so its credential may still be live; revoke the credential at the provider yourself, then send acknowledgeCredentialMayBeLive set to true";

/// A request to force-revoke one retry lease.
pub struct ForceRevoke<'a> {
    /// The caller is a configuration manager (never a delegate or a token).
    pub manager: bool,
    /// The caller acknowledged that the credential may still be live at the
    /// provider.
    pub acknowledged: bool,
    pub actor: &'a AuditActor,
}

impl PluginSecretStore {
    /// Mark retry lease `id` revoked without calling its provider. Refused
    /// for anyone but a configuration manager, without the acknowledgement,
    /// for a lease that is not a retry lease, and for one already revoked.
    /// The row and its audit row commit together.
    pub async fn lease_force_revoke(
        &self,
        id: &str,
        request: ForceRevoke<'_>,
    ) -> Result<LeaseInfo> {
        if !request.manager {
            return Err(VaultError::Denied(MANAGER_ONLY.into()).into());
        }
        if !request.acknowledged {
            return Err(VaultError::Invalid(ACKNOWLEDGEMENT_REQUIRED.into()).into());
        }
        let conn = self.conn.lock().await;
        let lease = lease_locked(&conn, id)?;
        if !lease.pending_revoke {
            return Err(VaultError::Conflict(format!(
                "lease `{id}` is not a retry lease; only a credential that was never handed out can be force-revoked, so revoke this one through its provider"
            ))
            .into());
        }
        if lease.revoked_at.is_some() {
            return Err(
                VaultError::Conflict(format!("retry lease `{id}` is already revoked")).into(),
            );
        }
        // The role's redacted target (a webhook's origin only), so the audit
        // row names where the credential may still be live.
        let target: Option<Value> = conn
            .query_row(
                "SELECT summary FROM vault_dynamic_roles WHERE name = ?1",
                params![lease.role],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .map(|summary| serde_json::from_str(&summary).unwrap_or(Value::Null));
        let actor = request.actor;
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE vault_leases SET revoked_at = ?1
             WHERE id = ?2 AND pending_revoke = 1 AND revoked_at IS NULL",
            params![now_millis(), id],
        )?;
        let details = json!({
            "leaseId": id,
            "retryLeaseId": id,
            "role": lease.role,
            "provider": lease.provider,
            "leaseCreatedAt": lease.created_at,
            "reason": "forced",
            "credentialRevoked": false,
            "acknowledged": true,
            "caller": format!("{}:{}", actor.kind, actor.id.as_deref().unwrap_or_default()),
            "callerAuthority": "configuration-manager",
            "target": target,
        });
        let entry = AuditEntry::new(actor, "lease.revoke", "ok").details(details);
        // The audit row is the only record that the credential may still be
        // live, so the mark never commits without it. `audit_locked` reports a
        // failed append only under fail-closed auditing; the sequence check
        // refuses it in every mode.
        let before = audit_seq(&tx);
        let permitted = self.audit_locked(&tx, &entry);
        let appended =
            matches!((before, audit_seq(&tx)), (Some(before), Some(after)) if after > before);
        if !permitted || !appended {
            // Dropping the transaction rolls the mark back.
            return Err(VaultError::AuditUnavailable.into());
        }
        tx.commit()?;
        self.flush_audit(&conn);
        tracing::warn!(
            lease = id,
            role = %lease.role,
            "retry lease force-revoked without a provider call; its credential may still be live"
        );
        lease_locked(&conn, id)
    }
}

/// The newest audit sequence number: 0 for an empty log, `None` when the log
/// cannot be read.
fn audit_seq(conn: &Connection) -> Option<i64> {
    conn.query_row("SELECT COALESCE(MAX(seq), 0) FROM vault_audit", [], |row| {
        row.get(0)
    })
    .ok()
}

#[cfg(test)]
#[path = "force_revoke_test.rs"]
mod tests;
