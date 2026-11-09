//! Access tracking: which memories chat turns actually used, and when. Dream
//! reads it to find facts nobody recalls any more.

use anyhow::{Context, Result};
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

use crate::{now_millis, MemoryStore};

/// `memory_meta` key holding when this database started tracking recalls
/// (Unix ms, as text).
pub(crate) const ACCESS_TRACKING_STARTED_KEY: &str = "access_tracking_started_at";

/// Most distinct ids one [`MemoryStore::mark_recalled`] call bumps. A turn
/// injects a handful of facts; the cap keeps the statement's parameter list
/// bounded whatever a caller passes.
pub const MAX_MARK_RECALLED_IDS: usize = 64;

impl MemoryStore {
    /// Write the access-tracking start time once: the first open that has the
    /// recall columns stamps it and later opens keep it. A database upgraded
    /// from before tracking gets the upgrade time, so its older rows are not
    /// mistaken for facts nobody used.
    pub(crate) fn record_access_tracking_start(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating memory_meta")?;
        conn.execute(
            "INSERT OR IGNORE INTO memory_meta (key, value) VALUES (?1, ?2)",
            params![ACCESS_TRACKING_STARTED_KEY, now_millis().to_string()],
        )
        .context("recording the access-tracking start")?;
        Ok(())
    }

    /// When this database started counting recalls (Unix ms). A row's
    /// `recall_count` of zero only means "never recalled" for the time since
    /// `max(created_at, this)`. A missing or unreadable marker reads as now,
    /// so nothing counts as unused for long.
    pub async fn access_tracking_started_at(&self) -> Result<i64> {
        let conn = self.conn.lock().await;
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM memory_meta WHERE key = ?1",
                params![ACCESS_TRACKING_STARTED_KEY],
                |row| row.get(0),
            )
            .optional()
            .context("reading the access-tracking start")?;
        Ok(value
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or_else(now_millis))
    }

    /// Record that one turn recalled `ids` at `now` (Unix ms): each listed
    /// row's `recall_count` goes up by one and `last_recalled_at` moves to
    /// `now` (never backwards). Only `active` rows change, so a fact archived
    /// or superseded while the turn ran keeps its history as it was. Blank and
    /// repeated ids are ignored and at most [`MAX_MARK_RECALLED_IDS`] distinct
    /// ids are applied, in one statement. `updated_at` is left alone: being
    /// read is not an edit. Returns how many rows changed.
    pub async fn mark_recalled(&self, ids: &[String], now: i64) -> Result<usize> {
        let mut unique: Vec<&str> = Vec::new();
        for id in ids.iter().map(|id| id.trim()) {
            if unique.len() == MAX_MARK_RECALLED_IDS {
                break;
            }
            if !id.is_empty() && !unique.contains(&id) {
                unique.push(id);
            }
        }
        if unique.is_empty() {
            return Ok(0);
        }
        let placeholders = (2..=unique.len() + 1)
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "UPDATE memory_entries
             SET recall_count = COALESCE(recall_count, 0) + 1,
                 last_recalled_at = MAX(COALESCE(last_recalled_at, 0), ?1)
             WHERE lifecycle = 'active' AND id IN ({placeholders})"
        );
        let values = std::iter::once(Value::Integer(now))
            .chain(unique.iter().map(|id| Value::Text((*id).to_owned())));
        let conn = self.conn.lock().await;
        conn.execute(&sql, params_from_iter(values))
            .context("recording memory recall")
    }
}
