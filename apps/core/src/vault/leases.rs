//! Leases for dynamic credentials.
//!
//! Every dynamic credential is issued under a lease: an id, a TTL, an optional
//! maximum lifetime, and the provider data needed to revoke it (sealed with the
//! keyring, since it can carry usernames or provider handles). The scheduler
//! revokes expired leases; callers can renew (up to the max TTL) or revoke
//! early. A lease row is kept after revocation so the audit trail and the
//! "who holds what" view stay answerable.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;

use super::audit::{AuditActor, AuditEntry};
use super::{now_millis, random_token, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// Lease metadata (never the credential or its revocation data).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseInfo {
    pub id: String,
    pub role: String,
    pub provider: String,
    pub issued_to: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    pub max_expires_at: i64,
    pub renewable: bool,
    pub revoked_at: Option<i64>,
}

impl LeaseInfo {
    /// Remaining seconds before expiry (0 once expired or revoked).
    pub fn ttl_secs(&self, now: i64) -> i64 {
        if self.revoked_at.is_some() {
            return 0;
        }
        ((self.expires_at - now) / 1000).max(0)
    }
}

/// Create the lease table. Idempotent.
pub fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_leases (
             id             TEXT PRIMARY KEY,
             role           TEXT NOT NULL,
             provider       TEXT NOT NULL,
             issued_to      TEXT,
             created_at     INTEGER NOT NULL,
             expires_at     INTEGER NOT NULL,
             max_expires_at INTEGER NOT NULL,
             renewable      INTEGER NOT NULL DEFAULT 1,
             revoked_at     INTEGER,
             nonce          BLOB NOT NULL,
             ciphertext     BLOB NOT NULL,
             key_version    INTEGER NOT NULL DEFAULT 0,
             revoke_attempts INTEGER NOT NULL DEFAULT 0,
             next_revoke_at INTEGER
         );
         CREATE INDEX IF NOT EXISTS vault_leases_expiry
             ON vault_leases (expires_at) WHERE revoked_at IS NULL;
         CREATE INDEX IF NOT EXISTS vault_leases_role ON vault_leases (role);",
    )
    .context("initializing lease schema")?;
    for (column, definition) in [
        ("revoke_attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("next_revoke_at", "INTEGER"),
    ] {
        let exists = conn
            .prepare("SELECT 1 FROM pragma_table_info('vault_leases') WHERE name = ?1")?
            .exists(params![column])?;
        if !exists {
            conn.execute_batch(&format!(
                "ALTER TABLE vault_leases ADD COLUMN {column} {definition};"
            ))
            .with_context(|| format!("adding lease column {column}"))?;
        }
    }
    Ok(())
}

/// First reaper retry delay after a failed revocation; it doubles per
/// failure up to [`REVOKE_RETRY_MAX_MS`].
const REVOKE_RETRY_BASE_MS: i64 = 60_000;
const REVOKE_RETRY_MAX_MS: i64 = 3_600_000;

pub(super) const COLUMNS: &str =
    "id, role, provider, issued_to, created_at, expires_at, max_expires_at, renewable, revoked_at";

pub(super) fn lease_from_row(row: &Row<'_>) -> rusqlite::Result<LeaseInfo> {
    Ok(LeaseInfo {
        id: row.get(0)?,
        role: row.get(1)?,
        provider: row.get(2)?,
        issued_to: row.get(3)?,
        created_at: row.get(4)?,
        expires_at: row.get(5)?,
        max_expires_at: row.get(6)?,
        renewable: row.get::<_, i64>(7)? != 0,
        revoked_at: row.get(8)?,
    })
}

/// Parameters for a new lease.
pub struct NewLease<'a> {
    pub role: &'a str,
    pub provider: &'a str,
    pub issued_to: Option<&'a str>,
    pub ttl_secs: i64,
    pub max_ttl_secs: i64,
    pub renewable: bool,
    /// Provider data needed to revoke (sealed at rest).
    pub revoke_data: &'a Value,
}

impl PluginSecretStore {
    /// Record a lease. Returns the lease metadata.
    pub async fn lease_create(&self, lease: NewLease<'_>, actor: &AuditActor) -> Result<LeaseInfo> {
        let now = now_millis();
        let id = random_token("lease_");
        let max_expires_at = now + lease.max_ttl_secs.max(lease.ttl_secs) * 1000;
        let expires_at = (now + lease.ttl_secs * 1000).min(max_expires_at);
        let sealed = serde_json::to_vec(lease.revoke_data)?;
        let (key_version, nonce, ciphertext) = self.seal_row(&sealed)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO vault_leases
                 (id, role, provider, issued_to, created_at, expires_at, max_expires_at,
                  renewable, nonce, ciphertext, key_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                lease.role,
                lease.provider,
                lease.issued_to,
                now,
                expires_at,
                max_expires_at,
                lease.renewable as i64,
                nonce,
                ciphertext,
                key_version
            ],
        )?;
        // Tie the lease to the requesting token so revoking it revokes this.
        super::tokens::attach_request_token_locked(&conn, &id)?;
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "lease.create", "ok").details(serde_json::json!({
                "leaseId": id, "role": lease.role, "provider": lease.provider,
                "expiresAt": expires_at,
            })),
        ) {
            // Fail-closed: no audit device recorded the issuance, so the lease
            // is ended at once and the caller (dynamic issue) revokes the
            // upstream credential instead of handing it out.
            conn.execute(
                "UPDATE vault_leases SET revoked_at = ?1 WHERE id = ?2",
                params![now_millis(), id],
            )?;
            return Err(VaultError::AuditUnavailable.into());
        }
        lease_locked(&conn, &id)
    }

    /// One lease.
    pub async fn lease_get(&self, id: &str) -> Result<LeaseInfo> {
        let conn = self.conn.lock().await;
        lease_locked(&conn, id)
    }

    /// Leases, newest first. `role` filters; revoked leases are included only
    /// when `include_revoked`.
    pub async fn lease_list(
        &self,
        role: Option<&str>,
        include_revoked: bool,
    ) -> Result<Vec<LeaseInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM vault_leases
             WHERE (?1 IS NULL OR role = ?1) AND (?2 OR revoked_at IS NULL)
             ORDER BY created_at DESC LIMIT 1000"
        ))?;
        let rows = stmt.query_map(params![role, include_revoked], lease_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// The sealed revocation data for a live lease.
    pub(crate) async fn lease_revoke_data(&self, id: &str) -> Result<(LeaseInfo, Value)> {
        let conn = self.conn.lock().await;
        let info = lease_locked(&conn, id)?;
        let (nonce, ciphertext, key_version): (Vec<u8>, Vec<u8>, u32) = conn.query_row(
            "SELECT nonce, ciphertext, key_version FROM vault_leases WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let plain = self.open_row(key_version, &nonce, &ciphertext)?;
        Ok((info, serde_json::from_slice(&plain)?))
    }

    /// Extend a lease by `increment_secs` from now, capped at its max TTL.
    pub async fn lease_extend(
        &self,
        id: &str,
        increment_secs: i64,
        actor: &AuditActor,
    ) -> Result<LeaseInfo> {
        let conn = self.conn.lock().await;
        let info = lease_locked(&conn, id)?;
        let now = now_millis();
        if info.revoked_at.is_some() || info.expires_at <= now {
            return Err(VaultError::Conflict("the lease has expired or was revoked".into()).into());
        }
        if !info.renewable {
            return Err(VaultError::Denied("this lease is not renewable".into()).into());
        }
        let expires_at = (now + increment_secs.max(1) * 1000).min(info.max_expires_at);
        conn.execute(
            "UPDATE vault_leases SET expires_at = ?1 WHERE id = ?2",
            params![expires_at, id],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "lease.renew", "ok").details(serde_json::json!({
                "leaseId": id, "role": info.role, "expiresAt": expires_at,
            })),
        );
        lease_locked(&conn, id)
    }

    /// Mark a lease revoked. Idempotent.
    pub async fn lease_mark_revoked(
        &self,
        id: &str,
        actor: &AuditActor,
        outcome: &str,
    ) -> Result<LeaseInfo> {
        self.lease_mark_revoked_for(id, actor, outcome, None).await
    }

    /// Mark a lease revoked, recording why (`expired` for the reaper) in the
    /// audit row's `reason` detail. Idempotent.
    pub async fn lease_mark_revoked_for(
        &self,
        id: &str,
        actor: &AuditActor,
        outcome: &str,
        reason: Option<&str>,
    ) -> Result<LeaseInfo> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases SET revoked_at = COALESCE(revoked_at, ?1) WHERE id = ?2",
            params![now_millis(), id],
        )?;
        let role = lease_locked(&conn, id).ok().map(|lease| lease.role);
        let mut details = serde_json::json!({ "leaseId": id, "role": role });
        if let Some(reason) = reason {
            details["reason"] = serde_json::json!(reason);
        }
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, "lease.revoke", outcome).details(details),
        );
        lease_locked(&conn, id)
    }

    /// Live leases whose expiry has passed and whose reaper retry is due.
    ///
    /// Leases the reaper has never attempted come first (oldest expiry
    /// first), then due retries in the order they became due. A retried
    /// lease always has an older `expires_at` than a later expiration, so
    /// ordering by expiry alone would let a backlog of failing revocations
    /// (e.g. an unreachable provider that times out) fill every page and
    /// time budget ahead of healthy leases.
    pub async fn lease_expired(&self, now: i64) -> Result<Vec<LeaseInfo>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM vault_leases
             WHERE revoked_at IS NULL AND expires_at <= ?1
               AND (next_revoke_at IS NULL OR next_revoke_at <= ?1)
             ORDER BY revoke_attempts > 0, COALESCE(next_revoke_at, expires_at), expires_at
             LIMIT 200"
        ))?;
        let rows = stmt.query_map(params![now], lease_from_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Push back the reaper's next attempt on a lease whose revocation
    /// failed, with exponential backoff, so permanently failing leases do not
    /// hold the head of [`Self::lease_expired`]. Explicit revocations are not
    /// affected.
    pub async fn lease_defer_revoke(&self, id: &str, now: i64) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE vault_leases
             SET next_revoke_at = ?1 + MIN(?2, ?3 * (1 << MIN(revoke_attempts, 16))),
                 revoke_attempts = revoke_attempts + 1
             WHERE id = ?4 AND revoked_at IS NULL",
            params![now, REVOKE_RETRY_MAX_MS, REVOKE_RETRY_BASE_MS, id],
        )?;
        Ok(())
    }
}

fn lease_locked(conn: &Connection, id: &str) -> Result<LeaseInfo> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM vault_leases WHERE id = ?1"),
        params![id],
        lease_from_row,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("lease `{id}`")).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn leases_renew_within_max_and_revoke() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let data = serde_json::json!({ "username": "ryu_x" });
        let lease = store
            .lease_create(
                NewLease {
                    role: "db",
                    provider: "random",
                    issued_to: Some("user:u1"),
                    ttl_secs: 60,
                    max_ttl_secs: 120,
                    renewable: true,
                    revoke_data: &data,
                },
                &actor,
            )
            .await
            .unwrap();
        assert!(lease.id.starts_with("lease_"));
        assert!(lease.expires_at <= lease.max_expires_at);
        let renewed = store.lease_extend(&lease.id, 10_000, &actor).await.unwrap();
        assert_eq!(renewed.expires_at, lease.max_expires_at);
        let (_, stored) = store.lease_revoke_data(&lease.id).await.unwrap();
        assert_eq!(stored, data);
        let revoked = store
            .lease_mark_revoked(&lease.id, &actor, "ok")
            .await
            .unwrap();
        assert!(revoked.revoked_at.is_some());
        assert!(store.lease_extend(&lease.id, 10, &actor).await.is_err());
        assert!(store.lease_list(None, false).await.unwrap().is_empty());
        assert_eq!(store.lease_list(Some("db"), true).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn expired_leases_are_listed_for_the_reaper() {
        let store = PluginSecretStore::in_memory().unwrap();
        let actor = AuditActor::system();
        let lease = store
            .lease_create(
                NewLease {
                    role: "r",
                    provider: "random",
                    issued_to: None,
                    ttl_secs: 0,
                    max_ttl_secs: 0,
                    renewable: false,
                    revoke_data: &Value::Null,
                },
                &actor,
            )
            .await
            .unwrap();
        let expired = store.lease_expired(now_millis() + 1).await.unwrap();
        assert_eq!(expired[0].id, lease.id);
    }
}
