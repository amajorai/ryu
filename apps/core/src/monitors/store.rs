//! SQLite-backed persistence for website monitors.
//!
//! Three tables live in `~/.ryu/monitors.db`:
//!   - `monitors`  — the watched-site definitions (url, check type, interval).
//!   - `snapshots` — one row per check, the **cross-run state** that makes a
//!     monitor a monitor: each check compares "now" against the latest snapshot.
//!   - `alerts`    — change events surfaced to the user / pushed to channels.
//!   - `push_tokens` — Expo push tokens registered by mobile devices, so every
//!     triggered alert can fan out to them.
//!
//! A broadcast channel fans freshly-inserted alerts out to SSE subscribers (the
//! desktop in-app feed + OS toast), mirroring [`crate::server::preferences`].
//!
//! Placement note (Core vs Gateway): this stores *what the user is watching and
//! what changed* — it decides what runs, not what is allowed — so it is Core.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{Alert, CheckStatus, Monitor, Snapshot};

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("monitors.db")
}

/// SQLite-backed monitor store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct MonitorStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<Alert>,
}

impl MonitorStore {
    /// Open (or create) the store at the default path (`~/.ryu/monitors.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening monitors db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let (tx, _rx) = broadcast::channel(128);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS monitors (
                 id          TEXT PRIMARY KEY,
                 json        TEXT NOT NULL,
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS snapshots (
                 id           INTEGER PRIMARY KEY AUTOINCREMENT,
                 monitor_id   TEXT NOT NULL,
                 checked_at   TEXT NOT NULL,
                 status       TEXT NOT NULL,
                 http_status  INTEGER,
                 latency_ms   INTEGER,
                 value        TEXT,
                 content_hash TEXT,
                 note         TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_snapshots_monitor
                 ON snapshots(monitor_id, id DESC);
             CREATE TABLE IF NOT EXISTS alerts (
                 id           INTEGER PRIMARY KEY AUTOINCREMENT,
                 monitor_id   TEXT NOT NULL,
                 monitor_name TEXT NOT NULL,
                 created_at   TEXT NOT NULL,
                 title        TEXT NOT NULL,
                 message      TEXT NOT NULL,
                 kind         TEXT NOT NULL,
                 acknowledged INTEGER NOT NULL DEFAULT 0
             );
             CREATE INDEX IF NOT EXISTS idx_alerts_monitor
                 ON alerts(monitor_id, id DESC);
             CREATE TABLE IF NOT EXISTS push_tokens (
                 token       TEXT PRIMARY KEY,
                 platform    TEXT,
                 user_id     TEXT,
                 created_at  TEXT NOT NULL
             );",
        )
        .context("initializing monitors schema")?;
        // Migration for pre-existing DBs: add the user_id column so a token can be
        // scoped to the member who registered it (user-targeted notifications).
        // ALTER errors when the column already exists — that is the "already
        // migrated" case, so it is intentionally ignored.
        let _ = conn.execute("ALTER TABLE push_tokens ADD COLUMN user_id TEXT", []);
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_push_tokens_user
                 ON push_tokens(user_id);
             -- The app-inbox feed: user-scoped notifications a workflow (or any
             -- Core subsystem) pushes to a specific member. `ack_required` marks a
             -- HITL notification whose ack resumes a suspended workflow run.
             CREATE TABLE IF NOT EXISTS notifications (
                 id              TEXT PRIMARY KEY,
                 user_id         TEXT,
                 title           TEXT NOT NULL,
                 body            TEXT,
                 level           TEXT NOT NULL DEFAULT 'info',
                 workflow_run_id TEXT,
                 node_id         TEXT,
                 ack_required    INTEGER NOT NULL DEFAULT 0,
                 acked           INTEGER NOT NULL DEFAULT 0,
                 read_at         TEXT,
                 created_at      TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_notifications_user
                 ON notifications(user_id, created_at DESC);
             -- Policy-alert dedupe: one row per `dedupe_key` the gateway stamped,
             -- with the last time it fired. A short cooldown (checked in
             -- `claim_policy_alert`) debounces the same stamp re-read on every
             -- tool-loop iteration so a single turn delivers a policy alert once.
             CREATE TABLE IF NOT EXISTS policy_alert_dedupe (
                 dedupe_key TEXT PRIMARY KEY,
                 fired_at   TEXT NOT NULL
             );
             -- Node-level alert delivery targets (self-host): a single JSON row
             -- holding the fan-out channels + email recipients that policy alerts
             -- deliver to. Distinct from per-monitor `notify`, which is scoped to
             -- one watched site.
             CREATE TABLE IF NOT EXISTS alert_delivery (
                 id   INTEGER PRIMARY KEY CHECK (id = 1),
                 json TEXT NOT NULL
             );",
        )
        .context("initializing push_tokens/notifications schema")?;
        Ok(())
    }

    // ---- policy alerts (dedupe + delivery targets) ------------------------

    /// Atomically claim a policy-alert `dedupe_key` for delivery. Returns `true`
    /// when the caller may deliver (first fire, or the previous fire is older than
    /// `cooldown_secs`), `false` when it is still within the cooldown window (a
    /// duplicate to suppress). The SELECT + UPSERT run under one connection lock so
    /// concurrent claims of the same key (one per tool-loop iteration) cannot both
    /// win.
    pub async fn claim_policy_alert(&self, dedupe_key: &str, cooldown_secs: i64) -> Result<bool> {
        let now = chrono::Utc::now();
        let conn = self.conn.lock().await;
        let prev: Option<String> = conn
            .query_row(
                "SELECT fired_at FROM policy_alert_dedupe WHERE dedupe_key = ?1",
                params![dedupe_key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading policy alert dedupe")?;
        if let Some(fired_at) = prev {
            if let Ok(prev_ts) = chrono::DateTime::parse_from_rfc3339(&fired_at) {
                if now.signed_duration_since(prev_ts.with_timezone(&chrono::Utc))
                    < chrono::Duration::seconds(cooldown_secs)
                {
                    return Ok(false);
                }
            }
        }
        conn.execute(
            "INSERT INTO policy_alert_dedupe (dedupe_key, fired_at) VALUES (?1, ?2)
             ON CONFLICT(dedupe_key) DO UPDATE SET fired_at = ?2",
            params![dedupe_key, now.to_rfc3339()],
        )
        .context("claiming policy alert dedupe")?;
        Ok(true)
    }

    /// Read the node-level alert delivery targets (empty default when unset).
    pub async fn get_alert_delivery(&self) -> Result<crate::policy_alerts::AlertDeliveryTargets> {
        let conn = self.conn.lock().await;
        let json: Option<String> = conn
            .query_row(
                "SELECT json FROM alert_delivery WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading alert delivery targets")?;
        match json {
            Some(j) => Ok(serde_json::from_str(&j).unwrap_or_default()),
            None => Ok(crate::policy_alerts::AlertDeliveryTargets::default()),
        }
    }

    /// Persist the node-level alert delivery targets (single-row upsert).
    pub async fn set_alert_delivery(
        &self,
        cfg: &crate::policy_alerts::AlertDeliveryTargets,
    ) -> Result<()> {
        let json = serde_json::to_string(cfg).context("serializing alert delivery targets")?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)
             ON CONFLICT(id) DO UPDATE SET json = ?1",
            params![json],
        )
        .context("writing alert delivery targets")?;
        Ok(())
    }

    // ---- monitors ---------------------------------------------------------

    /// Insert or replace a monitor definition.
    pub async fn upsert_monitor(&self, monitor: &Monitor) -> Result<()> {
        let json = serde_json::to_string(monitor).context("serializing monitor")?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO monitors (id, json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET json = ?2, updated_at = ?4",
            params![monitor.id, json, monitor.created_at, monitor.updated_at],
        )
        .context("upserting monitor")?;
        Ok(())
    }

    /// Fetch a monitor by id.
    pub async fn get_monitor(&self, id: &str) -> Result<Option<Monitor>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM monitors WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading monitor")?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("deserializing monitor")?,
            )),
            None => Ok(None),
        }
    }

    /// List all monitors, newest first.
    pub async fn list_monitors(&self) -> Result<Vec<Monitor>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM monitors ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(monitor) = serde_json::from_str::<Monitor>(&row?) {
                out.push(monitor);
            }
        }
        Ok(out)
    }

    /// Delete a monitor and its snapshots + alerts. Returns true when removed.
    pub async fn delete_monitor(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM monitors WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM snapshots WHERE monitor_id = ?1", params![id])?;
        conn.execute("DELETE FROM alerts WHERE monitor_id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ---- snapshots --------------------------------------------------------

    /// The most recent snapshot for a monitor (the comparison baseline).
    pub async fn latest_snapshot(&self, monitor_id: &str) -> Result<Option<Snapshot>> {
        let conn = self.conn.lock().await;
        let row = conn
            .query_row(
                "SELECT id, monitor_id, checked_at, status, http_status, latency_ms, value, content_hash, note
                 FROM snapshots WHERE monitor_id = ?1 ORDER BY id DESC LIMIT 1",
                params![monitor_id],
                Self::map_snapshot,
            )
            .optional()
            .context("reading latest snapshot")?;
        Ok(row)
    }

    /// Insert a snapshot, returning its generated id.
    pub async fn insert_snapshot(&self, s: &Snapshot) -> Result<i64> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO snapshots
               (monitor_id, checked_at, status, http_status, latency_ms, value, content_hash, note)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                s.monitor_id,
                s.checked_at,
                status_str(s.status),
                s.http_status,
                // rusqlite has no ToSql for u64 (it can exceed i64); store as i64.
                s.latency_ms.map(|v| v as i64),
                s.value,
                s.content_hash,
                s.note,
            ],
        )
        .context("inserting snapshot")?;
        Ok(conn.last_insert_rowid())
    }

    /// List recent snapshots for a monitor (newest first, bounded by `limit`).
    pub async fn list_snapshots(&self, monitor_id: &str, limit: u32) -> Result<Vec<Snapshot>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, monitor_id, checked_at, status, http_status, latency_ms, value, content_hash, note
             FROM snapshots WHERE monitor_id = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![monitor_id, limit], Self::map_snapshot)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn map_snapshot(row: &rusqlite::Row) -> rusqlite::Result<Snapshot> {
        Ok(Snapshot {
            id: row.get(0)?,
            monitor_id: row.get(1)?,
            checked_at: row.get(2)?,
            status: status_from_str(&row.get::<_, String>(3)?),
            http_status: row.get(4)?,
            latency_ms: row.get::<_, Option<i64>>(5)?.map(|v| v as u64),
            value: row.get(6)?,
            content_hash: row.get(7)?,
            note: row.get(8)?,
        })
    }

    // ---- alerts -----------------------------------------------------------

    /// Insert an alert, broadcast it to SSE subscribers, and return it with its id.
    pub async fn insert_alert(&self, alert: &Alert) -> Result<Alert> {
        let id = {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO alerts (monitor_id, monitor_name, created_at, title, message, kind, acknowledged)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![
                    alert.monitor_id,
                    alert.monitor_name,
                    alert.created_at,
                    alert.title,
                    alert.message,
                    alert.kind,
                ],
            )
            .context("inserting alert")?;
            conn.last_insert_rowid()
        };
        let stored = Alert {
            id,
            ..alert.clone()
        };
        // A send error just means no live SSE subscribers — not a failure.
        let _ = self.tx.send(stored.clone());
        Ok(stored)
    }

    /// List recent alerts. When `monitor_id` is `None`, returns alerts across all
    /// monitors (the global feed).
    pub async fn list_alerts(&self, monitor_id: Option<&str>, limit: u32) -> Result<Vec<Alert>> {
        let conn = self.conn.lock().await;
        let map = |row: &rusqlite::Row| -> rusqlite::Result<Alert> {
            Ok(Alert {
                id: row.get(0)?,
                monitor_id: row.get(1)?,
                monitor_name: row.get(2)?,
                created_at: row.get(3)?,
                title: row.get(4)?,
                message: row.get(5)?,
                kind: row.get(6)?,
                acknowledged: row.get::<_, i64>(7)? != 0,
            })
        };
        let mut out = Vec::new();
        match monitor_id {
            Some(mid) => {
                let mut stmt = conn.prepare(
                    "SELECT id, monitor_id, monitor_name, created_at, title, message, kind, acknowledged
                     FROM alerts WHERE monitor_id = ?1 ORDER BY id DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![mid, limit], map)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut stmt = conn.prepare(
                    "SELECT id, monitor_id, monitor_name, created_at, title, message, kind, acknowledged
                     FROM alerts ORDER BY id DESC LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit], map)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    /// Mark an alert acknowledged. Returns true when a row changed.
    pub async fn ack_alert(&self, id: i64) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute(
            "UPDATE alerts SET acknowledged = 1 WHERE id = ?1",
            params![id],
        )?;
        Ok(n > 0)
    }

    // ---- push tokens ------------------------------------------------------

    /// Register (or refresh) an Expo push token for mobile notifications.
    ///
    /// `user_id` scopes the token to the member who registered it so a workflow
    /// can push to a specific person's devices. It is optional: an anonymous /
    /// single-user node registers `None` and the token still receives the
    /// broadcast fan-out (monitor alerts), preserving the prior behavior.
    pub async fn register_push_token(
        &self,
        token: &str,
        platform: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO push_tokens (token, platform, user_id, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(token) DO UPDATE SET platform = ?2, user_id = ?3",
            params![token, platform, user_id, now],
        )
        .context("registering push token")?;
        Ok(())
    }

    /// Remove a push token (device opted out / token rotated).
    pub async fn remove_push_token(&self, token: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM push_tokens WHERE token = ?1", params![token])?;
        Ok(n > 0)
    }

    /// All registered Expo push tokens.
    pub async fn push_tokens(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT token FROM push_tokens")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Expo push tokens registered by a specific member. Used to push a
    /// user-targeted notification (e.g. a workflow pinging a teammate) to just
    /// that person's devices rather than the whole-node broadcast.
    pub async fn push_tokens_for_user(&self, user_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT token FROM push_tokens WHERE user_id = ?1")?;
        let rows = stmt.query_map(params![user_id], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Subscribe to live alert events (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<Alert> {
        self.tx.subscribe()
    }

    // ---- notifications (app inbox) ----------------------------------------

    /// Insert a user-scoped notification into the app-inbox feed.
    pub async fn insert_notification(&self, n: &NotificationRow) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO notifications
                 (id, user_id, title, body, level, workflow_run_id, node_id, ack_required, acked, read_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
            ],
        )
        .context("inserting notification")?;
        Ok(())
    }

    /// The most recent notifications for a member, newest first.
    pub async fn list_notifications_for_user(
        &self,
        user_id: &str,
        limit: i64,
    ) -> Result<Vec<NotificationRow>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, user_id, title, body, level, workflow_run_id, node_id,
                    ack_required, acked, read_at, created_at
             FROM notifications
             WHERE user_id = ?1
             ORDER BY created_at DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![user_id, limit], NotificationRow::from_row)?;
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
                        ack_required, acked, read_at, created_at
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
        })
    }
}

fn status_str(s: CheckStatus) -> &'static str {
    match s {
        CheckStatus::Ok => "ok",
        CheckStatus::Triggered => "triggered",
        CheckStatus::Error => "error",
    }
}

fn status_from_str(s: &str) -> CheckStatus {
    match s {
        "triggered" => CheckStatus::Triggered,
        "error" => CheckStatus::Error,
        _ => CheckStatus::Ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> MonitorStore {
        let path = std::env::temp_dir().join(format!(
            "ryu-monitor-test-{}.db",
            uuid::Uuid::new_v4().simple()
        ));
        MonitorStore::open(path).expect("open temp store")
    }

    #[tokio::test]
    async fn policy_alert_claim_debounces_within_cooldown() {
        let store = temp_store();
        // First claim of a key wins.
        assert!(store.claim_policy_alert("k1", 300).await.unwrap());
        // A second claim within the cooldown loses (a duplicate to suppress).
        assert!(!store.claim_policy_alert("k1", 300).await.unwrap());
        // A different key is independent.
        assert!(store.claim_policy_alert("k2", 300).await.unwrap());
        // A zero cooldown always re-claims (no debounce window).
        assert!(store.claim_policy_alert("k1", 0).await.unwrap());
    }

    #[tokio::test]
    async fn alert_delivery_roundtrips() {
        let store = temp_store();
        // Default is empty.
        let empty = store.get_alert_delivery().await.unwrap();
        assert!(empty.emails.is_empty() && empty.targets.is_empty());
        // Persist + read back.
        let cfg = crate::policy_alerts::AlertDeliveryTargets {
            targets: vec![super::super::notify::NotifyTarget::Webhook {
                url: "https://example.test/hook".to_string(),
            }],
            emails: vec!["ops@example.test".to_string()],
        };
        store.set_alert_delivery(&cfg).await.unwrap();
        let read = store.get_alert_delivery().await.unwrap();
        assert_eq!(read.emails, vec!["ops@example.test".to_string()]);
        assert_eq!(read.targets.len(), 1);
    }
}
