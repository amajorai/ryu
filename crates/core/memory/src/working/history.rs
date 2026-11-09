//! Working-memory history: the last [`WORKING_MEMORY_HISTORY_LIMIT`] versions
//! of each document.
//!
//! Every successful write snapshots the new version in the same transaction
//! as the document upsert, so the history can never disagree with the stored
//! document. Snapshots are encrypted exactly like the document, are pruned to
//! the cap on each write, and are deleted together with their document.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use ryu_kernel_contracts::ResourceKey;

use super::{normalize_id, WorkingMemory, WorkingMemoryMode, WorkingMemoryScope, WorkingPayload};
use crate::{memory_user_from_key, MemoryStore};

/// How many versions of one working-memory document are kept, the current one
/// included. Older snapshots are pruned on the next write.
pub const WORKING_MEMORY_HISTORY_LIMIT: i64 = 20;

pub(super) fn init_history_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS memory_working_history (
             owner_user_id TEXT NOT NULL,
             scope         TEXT NOT NULL,
             scope_id      TEXT NOT NULL,
             version       INTEGER NOT NULL,
             mode          TEXT NOT NULL,
             nonce         BLOB NOT NULL,
             ciphertext    BLOB NOT NULL,
             created_at    INTEGER NOT NULL,
             updated_at    INTEGER NOT NULL,
             PRIMARY KEY (owner_user_id, scope, scope_id, version)
         );",
    )
    .context("initializing working memory history schema")
}

/// The routing key and encrypted body of one stored version.
pub(super) struct Snapshot<'a> {
    pub owner: &'a str,
    pub scope: WorkingMemoryScope,
    pub id: &'a str,
    pub version: i64,
    pub mode: WorkingMemoryMode,
    pub nonce: &'a [u8],
    pub ciphertext: &'a [u8],
    pub created_at: i64,
    pub updated_at: i64,
}

/// Record `snapshot` and drop versions that fall outside the cap. Call it on
/// the same transaction as the document upsert.
pub(super) fn record_snapshot(conn: &Connection, snapshot: &Snapshot<'_>) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO memory_working_history
             (owner_user_id, scope, scope_id, version, mode, nonce, ciphertext, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            snapshot.owner,
            snapshot.scope.as_str(),
            snapshot.id,
            snapshot.version,
            snapshot.mode.as_str(),
            snapshot.nonce,
            snapshot.ciphertext,
            snapshot.created_at,
            snapshot.updated_at
        ],
    )
    .context("recording working memory history")?;
    conn.execute(
        "DELETE FROM memory_working_history
          WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3 AND version <= ?4",
        params![
            snapshot.owner,
            snapshot.scope.as_str(),
            snapshot.id,
            snapshot.version - WORKING_MEMORY_HISTORY_LIMIT
        ],
    )
    .context("pruning working memory history")?;
    Ok(())
}

/// Delete the history of one document.
pub(super) fn delete_history(
    conn: &Connection,
    owner: &str,
    scope: WorkingMemoryScope,
    id: &str,
) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_working_history
          WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3",
        params![owner, scope.as_str(), id],
    )
    .context("deleting working memory history")?;
    Ok(())
}

/// Delete the history of every thread-scoped document for `thread_id`.
pub(super) fn delete_thread_history(conn: &Connection, thread_id: &str) -> Result<()> {
    conn.execute(
        "DELETE FROM memory_working_history WHERE scope = 'thread' AND scope_id = ?1",
        params![thread_id],
    )
    .context("deleting thread working memory history")?;
    Ok(())
}

impl MemoryStore {
    /// The caller's stored versions of `(scope, id)`, newest first, at most
    /// [`WORKING_MEMORY_HISTORY_LIMIT`]. Empty when the document was never
    /// written or has been deleted.
    pub async fn working_memory_history(
        &self,
        key: &ResourceKey,
        scope: WorkingMemoryScope,
        id: &str,
    ) -> Result<Vec<WorkingMemory>> {
        let id = normalize_id(id)?;
        let owner = memory_user_from_key(key);
        let conn = self.conn.lock().await;
        type Row = (i64, String, Vec<u8>, Vec<u8>, i64, i64);
        let mut statement = conn
            .prepare(
                "SELECT version, mode, nonce, ciphertext, created_at, updated_at
                   FROM memory_working_history
                  WHERE owner_user_id = ?1 AND scope = ?2 AND scope_id = ?3
                  ORDER BY version DESC
                  LIMIT ?4",
            )
            .context("reading working memory history")?;
        let rows = statement
            .query_map(
                params![owner, scope.as_str(), id, WORKING_MEMORY_HISTORY_LIMIT],
                |row| -> rusqlite::Result<Row> {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                    ))
                },
            )
            .context("reading working memory history")?
            .collect::<rusqlite::Result<Vec<Row>>>()
            .context("reading working memory history")?;
        let mut versions = Vec::with_capacity(rows.len());
        for (version, mode, nonce, ciphertext, created_at, updated_at) in rows {
            let plain = self.decrypt(&nonce, &ciphertext)?;
            let payload: WorkingPayload = serde_json::from_slice(&plain)
                .context("decoding working memory history payload")?;
            versions.push(WorkingMemory {
                scope,
                id: id.to_owned(),
                mode: WorkingMemoryMode::from_db(&mode),
                content: payload.content,
                data: payload.data,
                template: payload.template,
                schema: payload.schema,
                version,
                created_at,
                updated_at,
            });
        }
        Ok(versions)
    }
}
