//! Outbox upkeep (excerpt expiry, the excerpt byte cap, the row cap) and the
//! read-only inspection helpers, split from [`super`] by responsibility.

use rusqlite::{params, OptionalExtension};

use super::{lock, now_secs, OutboxMaintenance, ViolationEvent, ViolationOutbox};

impl ViolationOutbox {
    /// Expire old excerpts, hold the excerpt bytes under the cap (oldest
    /// first), and bound the row count. Event metadata and hashes stay until
    /// the row cap is reached.
    pub fn maintain(&self) -> anyhow::Result<OutboxMaintenance> {
        self.maintain_at(now_secs())
    }

    pub(super) fn maintain_at(&self, now: i64) -> anyhow::Result<OutboxMaintenance> {
        let cursor = self.cursor()?;
        let conn = lock(&self.conn);
        let limits = self.limits;
        let mut summary = OutboxMaintenance {
            expired_excerpts: conn.execute(
                "UPDATE violation_event SET excerpt_sealed = NULL, excerpt_bytes = 0
                 WHERE excerpt_sealed IS NOT NULL AND recorded_at <= ?1",
                params![now - limits.excerpt_ttl_secs],
            )? as u64,
            ..OutboxMaintenance::default()
        };
        loop {
            let total: i64 = conn.query_row(
                "SELECT COALESCE(SUM(excerpt_bytes), 0) FROM violation_event",
                [],
                |row| row.get(0),
            )?;
            if total as u64 <= limits.max_excerpt_bytes_total {
                break;
            }
            let dropped = conn.execute(
                "UPDATE violation_event SET excerpt_sealed = NULL, excerpt_bytes = 0
                 WHERE id = (SELECT id FROM violation_event
                             WHERE excerpt_sealed IS NOT NULL ORDER BY id ASC LIMIT 1)",
                [],
            )?;
            if dropped == 0 {
                break;
            }
            summary.capped_excerpts += dropped as u64;
        }
        summary.deleted_rows += conn.execute(
            "DELETE FROM violation_event WHERE id <= ?1 AND recorded_at <= ?2",
            params![cursor, now - limits.acknowledged_retention_secs],
        )? as u64;
        let rows: i64 =
            conn.query_row("SELECT COUNT(*) FROM violation_event", [], |row| row.get(0))?;
        let excess = (rows as u64).saturating_sub(limits.max_rows);
        if excess > 0 {
            // Acknowledged rows go first; only a backlog larger than the cap
            // loses unreported rows, and it says so.
            let acknowledged = conn.execute(
                "DELETE FROM violation_event WHERE id IN (
                     SELECT id FROM violation_event WHERE id <= ?1 ORDER BY id ASC LIMIT ?2)",
                params![cursor, excess as i64],
            )? as u64;
            let remaining = excess.saturating_sub(acknowledged);
            if remaining > 0 {
                tracing::warn!(
                    dropped = remaining,
                    "violation outbox over its row cap: oldest unreported events dropped"
                );
                conn.execute(
                    "DELETE FROM violation_event WHERE id IN (
                         SELECT id FROM violation_event ORDER BY id ASC LIMIT ?1)",
                    params![remaining as i64],
                )?;
            }
            summary.deleted_rows += excess;
        }
        Ok(summary)
    }

    /// Rows in the outbox.
    pub fn len(&self) -> anyhow::Result<u64> {
        let conn = lock(&self.conn);
        Ok(
            conn.query_row("SELECT COUNT(*) FROM violation_event", [], |row| {
                row.get::<_, i64>(0)
            })? as u64,
        )
    }

    pub fn is_empty(&self) -> anyhow::Result<bool> {
        Ok(self.len()? == 0)
    }

    /// Sealed excerpt bytes held.
    pub fn excerpt_bytes(&self) -> anyhow::Result<u64> {
        let conn = lock(&self.conn);
        Ok(conn.query_row(
            "SELECT COALESCE(SUM(excerpt_bytes), 0) FROM violation_event",
            [],
            |row| row.get::<_, i64>(0),
        )? as u64)
    }

    /// Every stored event, oldest first, whatever the cursor says. For local
    /// inspection and tests.
    pub fn all_events(&self) -> anyhow::Result<Vec<ViolationEvent>> {
        let conn = lock(&self.conn);
        let mut statement = conn.prepare("SELECT event_json FROM violation_event ORDER BY id")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .iter()
            .filter_map(|json| serde_json::from_str(json).ok())
            .collect())
    }

    /// Whether `event_id` still holds an excerpt.
    pub fn has_excerpt(&self, event_id: &str) -> anyhow::Result<bool> {
        let conn = lock(&self.conn);
        Ok(conn
            .query_row(
                "SELECT excerpt_sealed IS NOT NULL FROM violation_event WHERE event_id = ?1",
                params![event_id],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false))
    }
}
