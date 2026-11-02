//! The app-inbox feed: user-scoped notification rows.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};

use super::NotifyStore;

impl NotifyStore {
    // ---- notifications (app inbox) ----------------------------------------

    /// Insert a user-scoped notification into the app-inbox feed.
    pub async fn insert_notification(&self, n: &NotificationRow) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO notifications
                 (id, user_id, title, body, level, workflow_run_id, node_id, ack_required, acked, read_at, created_at, source_app_id, archived_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                n.id,
                n.user_id,
                n.title,
                n.body,
                n.level,
                n.workflow_run_id,
                n.node_id,
                n.ack_required as i64,
                n.acked as i64,
                n.read_at,
                n.created_at,
                n.source_app_id,
                n.archived_at,
            ],
        )
        .context("inserting notification")?;
        Ok(())
    }

    /// The most recent notifications for a member, newest first.
    ///
    /// `archived` filters by the archive state: `None` = every row, `Some(true)` =
    /// only archived rows, `Some(false)` (the API default) = only un-archived rows.
    pub async fn list_notifications_for_user(
        &self,
        user_id: &str,
        limit: i64,
        archived: Option<bool>,
    ) -> Result<Vec<NotificationRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, user_id, title, body, level, workflow_run_id, node_id,
                    ack_required, acked, read_at, created_at, source_app_id, archived_at
             FROM notifications
             WHERE user_id = ?1
               AND (?2 = 0 OR archived_at IS NOT NULL)
               AND (?3 = 0 OR archived_at IS NULL)
             ORDER BY created_at DESC
             LIMIT ?4",
        )?;
        let rows = stmt.query_map(
            params![
                user_id,
                (archived == Some(true)) as i64,
                (archived == Some(false)) as i64,
                limit,
            ],
            NotificationRow::from_row,
        )?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Fetch a single notification by id.
    pub async fn get_notification(&self, id: &str) -> Result<Option<NotificationRow>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, user_id, title, body, level, workflow_run_id, node_id,
                        ack_required, acked, read_at, created_at, source_app_id, archived_at
                 FROM notifications WHERE id = ?1",
                params![id],
                NotificationRow::from_row,
            )
            .optional()
            .context("reading notification")?;
        Ok(row)
    }

    /// Mark a notification read (stamps `read_at`). Returns true when a row changed.
    pub async fn mark_notification_read(&self, id: &str) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications SET read_at = ?2 WHERE id = ?1 AND read_at IS NULL",
            params![id, now],
        )?;
        Ok(n > 0)
    }

    /// Mark a notification acknowledged. Returns true when a row changed.
    pub async fn mark_notification_acked(&self, id: &str) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications SET acked = 1, read_at = COALESCE(read_at, ?2) WHERE id = ?1",
            params![id, now],
        )?;
        Ok(n > 0)
    }

    /// Archive a notification (stamps `archived_at`, also marking it read). Returns
    /// true when a row changed. Idempotent: re-archiving an archived row is a no-op.
    pub async fn mark_notification_archived(&self, id: &str) -> Result<bool> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications
                SET archived_at = ?2, read_at = COALESCE(read_at, ?2)
              WHERE id = ?1 AND archived_at IS NULL",
            params![id, now],
        )?;
        Ok(n > 0)
    }

    /// Un-archive a notification (clears `archived_at`). Returns true when a row
    /// changed. Idempotent: un-archiving an already-live row is a no-op.
    pub async fn mark_notification_unarchived(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE notifications SET archived_at = NULL
              WHERE id = ?1 AND archived_at IS NOT NULL",
            params![id],
        )?;
        Ok(n > 0)
    }
}

/// One row of the app-inbox notification feed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NotificationRow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    pub level: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub ack_required: bool,
    pub acked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_at: Option<String>,
    pub created_at: String,
    /// The plugin/app id that raised this notification (an out-of-process app via
    /// the `notify.deliver` kernel capability, or a Core-internal producer that
    /// named itself). `None` for legacy Core producers that did not identify
    /// themselves. The desktop resolves the app's icon/name from this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_app_id: Option<String>,
    /// When the user archived this row. `None` = live in the inbox.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
}

impl NotificationRow {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            id: row.get(0)?,
            user_id: row.get(1)?,
            title: row.get(2)?,
            body: row.get(3)?,
            level: row.get(4)?,
            workflow_run_id: row.get(5)?,
            node_id: row.get(6)?,
            ack_required: row.get::<_, i64>(7)? != 0,
            acked: row.get::<_, i64>(8)? != 0,
            read_at: row.get(9)?,
            created_at: row.get(10)?,
            source_app_id: row.get(11)?,
            archived_at: row.get(12)?,
        })
    }
}
