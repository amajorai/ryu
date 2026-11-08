//! Per-user memory settings stored beside the encrypted memory authority.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};

use crate::{now_millis, MemoryStore};

impl MemoryStore {
    /// Read the owning user's sensitive-topic consent for this node.
    ///
    /// The setting is deliberately stored beside the encrypted memory authority
    /// rather than in the node-global generic preferences table. A missing row is
    /// the safe default: sensitive memory is disabled.
    pub async fn include_sensitive_topics(&self, user_id: &str) -> Result<bool> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            return Ok(false);
        }
        let conn = self.conn.lock().await;
        let enabled: Option<i64> = conn
            .query_row(
                "SELECT include_sensitive_topics FROM memory_settings WHERE user_id = ?1",
                params![user_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading sensitive memory setting")?;
        Ok(enabled == Some(1))
    }

    /// Persist the owning user's sensitive-topic consent for this node.
    pub async fn set_include_sensitive_topics(&self, user_id: &str, enabled: bool) -> Result<()> {
        let user_id = user_id.trim();
        if user_id.is_empty() {
            anyhow::bail!("a memory setting requires a user id");
        }
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_settings (user_id, include_sensitive_topics, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(user_id) DO UPDATE SET
                 include_sensitive_topics = excluded.include_sensitive_topics,
                 updated_at = excluded.updated_at",
            params![user_id, i64::from(enabled), now_millis()],
        )
        .context("writing sensitive memory setting")?;
        Ok(())
    }
}
