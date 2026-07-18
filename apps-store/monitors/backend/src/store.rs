//! SQLite-backed persistence for website monitors.
//!
//! Three tables live in `~/.ryu/monitors.db`:
//!   - `monitors`  — the watched-site definitions (url, check type, interval).
//!   - `snapshots` — one row per check, the **cross-run state** that makes a
//!     monitor a monitor: each check compares "now" against the latest snapshot.
//!   - `alerts`    — change events surfaced to the user / pushed to channels.
//!
//! A broadcast channel fans freshly-inserted alerts out to SSE subscribers (the
//! desktop in-app feed). The shared notification-delivery state (push tokens,
//! the app-inbox feed, policy-alert dedupe, alert-delivery targets) is **kernel**
//! and lives in Core (`apps/core/src/notify`), not here.
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
    super::data_dir().join("monitors.db")
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
                 ON alerts(monitor_id, id DESC);",
        )
        .context("initializing monitors schema")?;
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

    /// Subscribe to live alert events (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<Alert> {
        self.tx.subscribe()
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
    async fn monitor_roundtrips_and_deletes() {
        let store = temp_store();
        let now = chrono::Utc::now().to_rfc3339();
        let monitor = Monitor {
            id: "mon_1".into(),
            name: "test".into(),
            url: "https://example.test".into(),
            backend: crate::FetchBackend::Http,
            check: crate::CheckType::Uptime {
                expect_status: vec![],
            },
            interval: "5m".into(),
            enabled: true,
            notify: vec![],
            created_at: now.clone(),
            updated_at: now,
            last_check_at: None,
            last_status: None,
            last_value: None,
        };
        store.upsert_monitor(&monitor).await.unwrap();
        assert_eq!(store.list_monitors().await.unwrap().len(), 1);
        assert!(store.get_monitor("mon_1").await.unwrap().is_some());
        assert!(store.delete_monitor("mon_1").await.unwrap());
        assert!(store.get_monitor("mon_1").await.unwrap().is_none());
    }
}
