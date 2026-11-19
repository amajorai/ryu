//! Local records of the share and request links this node created.
//!
//! A share keeps metadata only: its key lived in the link and is gone. A
//! request keeps its P-256 secret until the answer is claimed into the vault,
//! and, if writing the claimed value fails, the decrypted answer too, so a
//! retry does not lose it: the control plane hands an answer out only once.
//!
//! Metadata lives in `vault_share_links` (created on first use; it holds
//! nothing secret). The per-link secrets are sealed with the keyring in the
//! `plugin_secrets` table under [`SECRETS_OWNER`], an id no plugin can claim
//! (plugin ids never contain `:`), so keyring rotation and rewrap cover them.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::plugin_secrets::PluginSecretStore;
use crate::vault::audit::{AuditActor, AuditEntry};
use crate::vault::{now_millis, VaultError};

/// The `plugin_secrets` owner the sealed link secrets are stored under.
pub(crate) const SECRETS_OWNER: &str = "vault:share-links";

/// Create the link table. Idempotent; called before every access.
fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS vault_share_links (
             id          TEXT PRIMARY KEY,
             kind        TEXT NOT NULL,
             label       TEXT,
             target      TEXT,
             created_by  TEXT,
             created_at  INTEGER NOT NULL,
             expires_at  INTEGER NOT NULL,
             status      TEXT NOT NULL
         );",
    )
    .context("initializing share link schema")
}

/// A link as listed (never its secrets).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareLinkInfo {
    pub id: String,
    pub kind: String,
    pub label: Option<String>,
    /// For requests: where the answer is written.
    pub target: Option<Value>,
    pub created_by: Option<String>,
    pub created_at: i64,
    pub expires_at: i64,
    /// `open`, `claimed`, or `revoked` as this node knows it.
    pub status: String,
}

/// Sealed per-link secrets.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkSecrets {
    /// The request's P-256 scalar (base64url).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_key: Option<String>,
    /// A collected answer whose write has not succeeded yet.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_answer: Option<String>,
}

impl LinkSecrets {
    fn is_empty(&self) -> bool {
        self.request_key.is_none() && self.pending_answer.is_none()
    }
}

/// A link to record.
pub struct NewShareLink<'a> {
    pub id: &'a str,
    pub kind: &'a str,
    pub label: Option<&'a str>,
    pub target: Option<Value>,
    pub expires_at: i64,
}

fn row_info(row: &rusqlite::Row<'_>) -> rusqlite::Result<ShareLinkInfo> {
    let target: Option<String> = row.get(3)?;
    Ok(ShareLinkInfo {
        id: row.get(0)?,
        kind: row.get(1)?,
        label: row.get(2)?,
        target: target.and_then(|text| serde_json::from_str(&text).ok()),
        created_by: row.get(4)?,
        created_at: row.get(5)?,
        expires_at: row.get(6)?,
        status: row.get(7)?,
    })
}

const COLUMNS: &str = "id, kind, label, target, created_by, created_at, expires_at, status";

fn audit_kind(kind: &str) -> &'static str {
    if kind == "request" {
        "share_request"
    } else {
        "share"
    }
}

fn info_locked(conn: &Connection, id: &str) -> Result<ShareLinkInfo> {
    init_schema(conn)?;
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM vault_share_links WHERE id = ?1"),
        params![id],
        row_info,
    )
    .optional()?
    .ok_or_else(|| VaultError::NotFound(format!("share link `{id}`")).into())
}

impl PluginSecretStore {
    async fn share_link_secrets_put(&self, id: &str, secrets: &LinkSecrets) -> Result<()> {
        if secrets.is_empty() {
            return self.delete(SECRETS_OWNER, id).await;
        }
        self.set(SECRETS_OWNER, id, &serde_json::to_string(secrets)?)
            .await
    }

    /// Record a link this node just created.
    pub(crate) async fn share_link_record(
        &self,
        link: NewShareLink<'_>,
        secrets: &LinkSecrets,
        actor: &AuditActor,
    ) -> Result<ShareLinkInfo> {
        self.share_link_secrets_put(link.id, secrets).await?;
        let conn = self.conn.lock().await;
        init_schema(&conn)?;
        conn.execute(
            "INSERT INTO vault_share_links
                 (id, kind, label, target, created_by, created_at, expires_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'open')",
            params![
                link.id,
                link.kind,
                link.label,
                link.target.as_ref().map(Value::to_string),
                actor.id,
                now_millis(),
                link.expires_at,
            ],
        )?;
        self.audit_locked(
            &conn,
            &AuditEntry::new(actor, &format!("{}.create", audit_kind(link.kind)), "ok")
                .details(json!({ "linkId": link.id, "target": link.target })),
        );
        info_locked(&conn, link.id)
    }

    /// Links, newest first; only `created_by`'s when given.
    pub async fn share_link_list(&self, created_by: Option<&str>) -> Result<Vec<ShareLinkInfo>> {
        let conn = self.conn.lock().await;
        init_schema(&conn)?;
        let mut stmt = conn.prepare(&format!(
            "SELECT {COLUMNS} FROM vault_share_links
             WHERE (?1 IS NULL OR created_by = ?1) ORDER BY created_at DESC LIMIT 500"
        ))?;
        let rows = stmt.query_map(params![created_by], row_info)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// One link and its sealed secrets.
    pub(crate) async fn share_link_get(&self, id: &str) -> Result<(ShareLinkInfo, LinkSecrets)> {
        let info = {
            let conn = self.conn.lock().await;
            info_locked(&conn, id)?
        };
        let secrets = match self.get(SECRETS_OWNER, id).await? {
            Some(text) => serde_json::from_str(&text)?,
            None => LinkSecrets::default(),
        };
        Ok((info, secrets))
    }

    /// Replace a link's sealed secrets and status.
    pub(crate) async fn share_link_update(
        &self,
        id: &str,
        status: &str,
        secrets: &LinkSecrets,
        actor: &AuditActor,
    ) -> Result<()> {
        let kind = {
            let conn = self.conn.lock().await;
            info_locked(&conn, id)?.kind
        };
        self.share_link_secrets_put(id, secrets).await?;
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE vault_share_links SET status = ?2 WHERE id = ?1",
            params![id, status],
        )?;
        if status != "open" {
            self.audit_locked(
                &conn,
                &AuditEntry::new(actor, &format!("{}.{status}", audit_kind(&kind)), "ok")
                    .details(json!({ "linkId": id })),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
