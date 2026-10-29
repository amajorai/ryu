//! Usage windows in the violation outbox (managed guardrails spec 04.4).
//!
//! A closed per-credential minute is queued here as the JSON the ingest route
//! receives, beside violation events in `violations.db` and with its own
//! delivery cursor, so a window acknowledgement never moves the event cursor
//! and the other way round.
//!
//! - A window is stored once per `(gatewayInstance, credentialId, minute)`,
//!   the control plane's own row key, and is never rewritten: the control
//!   plane keeps the first payload for that key, so a resend must be the
//!   same bytes under the same instance id.
//! - Each row keeps the instance id it was closed under. The Gateway's
//!   instance id is random per process, so a window queued before a restart
//!   is resent under its original id and the control plane sees a retry, not
//!   a new window.
//! - Unreported rows past [`DEFAULT_MAX_WINDOW_ROWS`] drop oldest first and
//!   say so. Windows feed baselines and detectors, never strikes, so losing
//!   the oldest backlog is acceptable; violation events are never dropped
//!   for a window backlog because they live in their own table.

use rusqlite::{params, Connection, OptionalExtension};

use super::{lock, now_secs, ViolationOutbox};

/// Name of the usage window cursor, separate from the violation cursor.
pub const USAGE_WINDOW_REPORT_CURSOR: &str = "usage_window_ingest";
/// Most unreported windows the outbox holds (spec 04.4).
pub const DEFAULT_MAX_WINDOW_ROWS: u64 = 50_000;
/// Acknowledged windows are kept this long for local inspection.
pub const ACKNOWLEDGED_WINDOW_RETENTION_SECS: i64 = 24 * 3600;

pub(super) const WINDOW_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS usage_window (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        instance_id    TEXT    NOT NULL,
        credential_id  TEXT    NOT NULL,
        minute         TEXT    NOT NULL,
        recorded_at    INTEGER NOT NULL,
        window_json    TEXT    NOT NULL,
        UNIQUE (instance_id, credential_id, minute)
    );
";

/// One closed window ready to queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRecord {
    pub credential_id: String,
    /// The closed UTC minute as the wire carries it (`...T10:01:00Z`).
    pub minute: String,
    /// The window's JSON exactly as it is sent.
    pub json: String,
}

/// One queued window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowRow {
    pub id: i64,
    pub instance_id: String,
    pub json: String,
}

/// What one window maintenance pass removed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WindowMaintenance {
    pub acknowledged_deleted: u64,
    /// Unreported windows dropped because the backlog passed the cap.
    pub unreported_dropped: u64,
}

fn window_cursor(conn: &Connection) -> rusqlite::Result<i64> {
    Ok(conn
        .query_row(
            "SELECT last_id FROM violation_report_cursors WHERE name = ?1",
            params![USAGE_WINDOW_REPORT_CURSOR],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0))
}

impl ViolationOutbox {
    /// Queue closed windows under `instance_id`. A window already queued for
    /// the same instance, credential and minute is left as it is. Returns
    /// how many were new.
    pub fn enqueue_windows(
        &self,
        instance_id: &str,
        windows: &[WindowRecord],
    ) -> anyhow::Result<usize> {
        let mut conn = lock(&self.conn);
        let tx = conn.transaction()?;
        let mut inserted = 0;
        {
            let mut statement = tx.prepare(
                "INSERT OR IGNORE INTO usage_window
                     (instance_id, credential_id, minute, recorded_at, window_json)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            let now = now_secs();
            for window in windows {
                inserted += statement.execute(params![
                    instance_id,
                    window.credential_id,
                    window.minute,
                    now,
                    window.json,
                ])?;
            }
        }
        tx.commit()?;
        Ok(inserted)
    }

    /// The highest window row id the control plane acknowledged.
    pub fn window_cursor(&self) -> anyhow::Result<i64> {
        Ok(window_cursor(&lock(&self.conn))?)
    }

    /// Windows after the window cursor, oldest first, at most `limit`.
    pub fn pending_windows(&self, limit: usize) -> anyhow::Result<Vec<WindowRow>> {
        let conn = lock(&self.conn);
        let cursor = window_cursor(&conn)?;
        let mut statement = conn.prepare(
            "SELECT id, instance_id, window_json FROM usage_window
             WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = statement
            .query_map(params![cursor, limit as i64], |row| {
                Ok(WindowRow {
                    id: row.get(0)?,
                    instance_id: row.get(1)?,
                    json: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Advance the window cursor to `through_id`, never backwards.
    pub fn acknowledge_windows(&self, through_id: i64) -> anyhow::Result<()> {
        lock(&self.conn).execute(
            "INSERT INTO violation_report_cursors (name, last_id) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)",
            params![USAGE_WINDOW_REPORT_CURSOR, through_id],
        )?;
        Ok(())
    }

    /// Delete acknowledged windows past their retention and hold unreported
    /// windows under `max_unreported`, oldest first.
    pub fn maintain_windows(&self, max_unreported: u64) -> anyhow::Result<WindowMaintenance> {
        self.maintain_windows_at(now_secs(), max_unreported)
    }

    fn maintain_windows_at(
        &self,
        now: i64,
        max_unreported: u64,
    ) -> anyhow::Result<WindowMaintenance> {
        let conn = lock(&self.conn);
        let cursor = window_cursor(&conn)?;
        let acknowledged_deleted = conn.execute(
            "DELETE FROM usage_window WHERE id <= ?1 AND recorded_at <= ?2",
            params![cursor, now - ACKNOWLEDGED_WINDOW_RETENTION_SECS],
        )? as u64;
        let unreported: i64 = conn.query_row(
            "SELECT COUNT(*) FROM usage_window WHERE id > ?1",
            params![cursor],
            |row| row.get(0),
        )?;
        let excess = (unreported as u64).saturating_sub(max_unreported);
        if excess > 0 {
            tracing::warn!(
                dropped = excess,
                "usage window outbox over its row cap: oldest unreported windows dropped"
            );
            conn.execute(
                "DELETE FROM usage_window WHERE id IN (
                     SELECT id FROM usage_window WHERE id > ?1 ORDER BY id ASC LIMIT ?2)",
                params![cursor, excess as i64],
            )?;
        }
        Ok(WindowMaintenance {
            acknowledged_deleted,
            unreported_dropped: excess,
        })
    }

    /// Windows held, reported or not.
    pub fn window_count(&self) -> anyhow::Result<u64> {
        let conn = lock(&self.conn);
        Ok(
            conn.query_row("SELECT COUNT(*) FROM usage_window", [], |row| {
                row.get::<_, i64>(0)
            })? as u64,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(credential: &str, minute: &str, requests: u32) -> WindowRecord {
        WindowRecord {
            credential_id: credential.to_owned(),
            minute: minute.to_owned(),
            json: format!(r#"{{"credentialId":"{credential}","requests":{requests}}}"#),
        }
    }

    #[test]
    fn a_window_is_stored_once_per_instance_credential_and_minute() {
        let outbox = ViolationOutbox::in_memory().unwrap();
        let first = record("cred-a", "2026-10-23T10:01:00Z", 3);
        let rewrite = record("cred-a", "2026-10-23T10:01:00Z", 9);
        assert_eq!(outbox.enqueue_windows("inst-1", &[first]).unwrap(), 1);
        assert_eq!(outbox.enqueue_windows("inst-1", &[rewrite]).unwrap(), 0);
        // Another instance closes its own window for the same minute.
        let other = record("cred-a", "2026-10-23T10:01:00Z", 1);
        assert_eq!(outbox.enqueue_windows("inst-2", &[other]).unwrap(), 1);
        let pending = outbox.pending_windows(10).unwrap();
        assert_eq!(pending.len(), 2);
        assert!(
            pending[0].json.contains("\"requests\":3"),
            "first payload kept"
        );
        assert_eq!(pending[0].instance_id, "inst-1");
        assert_eq!(pending[1].instance_id, "inst-2");
    }

    #[test]
    fn the_window_cursor_is_separate_from_the_violation_cursor() {
        let outbox = ViolationOutbox::in_memory().unwrap();
        outbox
            .enqueue_windows(
                "inst-1",
                &[
                    record("cred-a", "2026-10-23T10:01:00Z", 1),
                    record("cred-b", "2026-10-23T10:01:00Z", 1),
                ],
            )
            .unwrap();
        let pending = outbox.pending_windows(10).unwrap();
        outbox.acknowledge_windows(pending[0].id).unwrap();
        assert_eq!(outbox.cursor().unwrap(), 0, "violation cursor untouched");
        assert_eq!(outbox.window_cursor().unwrap(), pending[0].id);
        let rest = outbox.pending_windows(10).unwrap();
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0].id, pending[1].id);
        // Never backwards.
        outbox.acknowledge_windows(0).unwrap();
        assert_eq!(outbox.window_cursor().unwrap(), pending[0].id);
    }

    #[test]
    fn the_unreported_backlog_drops_oldest_first_past_the_cap() {
        let outbox = ViolationOutbox::in_memory().unwrap();
        let windows: Vec<_> = (0..5)
            .map(|minute| record("cred-a", &format!("2026-10-23T10:0{minute}:00Z"), minute))
            .collect();
        outbox.enqueue_windows("inst-1", &windows).unwrap();
        let summary = outbox.maintain_windows_at(now_secs(), 3).unwrap();
        assert_eq!(summary.unreported_dropped, 2);
        let pending = outbox.pending_windows(10).unwrap();
        assert_eq!(pending.len(), 3);
        assert!(pending[0].json.contains("\"requests\":2"), "oldest dropped");
    }

    #[test]
    fn acknowledged_windows_leave_after_their_retention() {
        let outbox = ViolationOutbox::in_memory().unwrap();
        outbox
            .enqueue_windows("inst-1", &[record("cred-a", "2026-10-23T10:01:00Z", 1)])
            .unwrap();
        let id = outbox.pending_windows(1).unwrap()[0].id;
        outbox.acknowledge_windows(id).unwrap();
        let soon = outbox.maintain_windows_at(now_secs(), 10).unwrap();
        assert_eq!(soon.acknowledged_deleted, 0);
        let later = outbox
            .maintain_windows_at(now_secs() + ACKNOWLEDGED_WINDOW_RETENTION_SECS + 1, 10)
            .unwrap();
        assert_eq!(later.acknowledged_deleted, 1);
        assert_eq!(outbox.window_count().unwrap(), 0);
    }
}
