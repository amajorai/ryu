//! SQLite-backed persistence for the kernel notification-delivery store.
//!
//! Four tables live in `~/.ryu/notify.db` — the shared notification-delivery
//! state that USED to live inside the monitors crate but is **kernel** (an
//! adjudicated not-a-capability), so it stays compiled into Core and keeps
//! serving `notifications_api`, `policy_alerts`, `workflow`, and `approvals`
//! even after the monitor ENGINE moves out-of-process:
//!
//!   - `notifications` — the app-inbox feed: user-scoped pings a workflow (or any
//!     Core subsystem) pushes to a specific member. `ack_required` marks a HITL
//!     notification whose ack resumes a suspended workflow run.
//!   - `policy_alert_dedupe` — one row per gateway `dedupe_key`, with the last
//!     time it fired; a short cooldown debounces the same stamp re-read on every
//!     tool-loop iteration so a single turn delivers a policy alert once.
//!   - `alert_delivery` — a single JSON row holding the node-level fan-out
//!     channels + email recipients that policy alerts deliver to.
//!   - `push_tokens` — Expo push tokens registered by mobile devices, so a
//!     triggered alert / user notification can fan out to them.
//!
//! Placement (Core vs Gateway): this stores *what was delivered to whom* — it
//! opens delivery sockets, it does not decide policy — so it is Core kernel.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

use ryu_notify::AlertDeliveryTargets;

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("notify.db")
}

/// SQLite-backed notification-delivery store. Cheap to clone (wraps an `Arc`).
#[derive(Clone)]
pub struct NotifyStore {
    conn: Arc<Mutex<Connection>>,
}

impl NotifyStore {
    /// Open (or create) the store at the default path (`~/.ryu/notify.db`).
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
            .with_context(|| format!("opening notify db {}", path.display()))?;
        Self::init_schema(&conn)?;
        // One-time, best-effort import of the shared delivery state from the
        // pre-decomposition `monitors.db` sibling (see `migrate_from_monitors`).
        let monitors_db = path.parent().map(|p| p.join("monitors.db"));
        Self::migrate_from_monitors(&conn, monitors_db.as_deref());
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// One-time, best-effort import of the shared notification-delivery state
    /// (`alert_delivery` + `push_tokens`) from the pre-decomposition
    /// `monitors.db`, where those rows lived before this store was extracted to
    /// the kernel. Without it, an upgraded node silently drops its configured
    /// policy-alert recipients (webhook / Telegram / email) and registered mobile
    /// push tokens, because the old rows still sit in `monitors.db` but are no
    /// longer read.
    ///
    /// Idempotent and never boot-fatal: it runs only when this store holds NO such
    /// rows yet AND a sibling `monitors.db` exists, and every step is wrapped so a
    /// missing, locked, or old-schema `monitors.db` is logged-and-skipped, never
    /// propagated.
    fn migrate_from_monitors(conn: &Connection, monitors_db: Option<&std::path::Path>) {
        if let Err(e) = Self::try_migrate_from_monitors(conn, monitors_db) {
            tracing::debug!("notify: monitors.db delivery-state migration skipped: {e}");
        }
    }

    fn try_migrate_from_monitors(
        conn: &Connection,
        monitors_db: Option<&std::path::Path>,
    ) -> Result<()> {
        let Some(monitors_db) = monitors_db else {
            return Ok(());
        };
        if !monitors_db.exists() {
            return Ok(());
        }

        // Idempotency: only seed a store with NO delivery rows yet, so a later user
        // edit (or a prior migration) is never clobbered or double-applied. Once
        // `alert_delivery` OR `push_tokens` holds anything, this is a no-op forever.
        let have_delivery: i64 = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM alert_delivery WHERE id = 1)",
            [],
            |r| r.get(0),
        )?;
        let have_tokens: i64 =
            conn.query_row("SELECT EXISTS(SELECT 1 FROM push_tokens)", [], |r| r.get(0))?;
        if have_delivery != 0 || have_tokens != 0 {
            return Ok(());
        }

        // Open the legacy db read-write (the monitors sidecar has not spawned yet at
        // Core boot, so there is no contention; read-write also sidesteps the WAL
        // read-only "unable to open" failure that would skip a valid migration).
        let old = Connection::open(monitors_db)
            .with_context(|| format!("opening legacy monitors db {}", monitors_db.display()))?;

        // `alert_delivery` is a single JSON row (id = 1). The type is byte-identical
        // across the extraction, so the raw JSON round-trips.
        if let Some(json) = old
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .context("reading legacy alert_delivery")?
        {
            conn.execute(
                "INSERT OR IGNORE INTO alert_delivery (id, json) VALUES (1, ?1)",
                params![json],
            )
            .context("seeding alert_delivery")?;
        }

        // `push_tokens` is column-based; copy every row verbatim.
        let mut stmt = old
            .prepare("SELECT token, platform, user_id, created_at FROM push_tokens")
            .context("preparing legacy push_tokens read")?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .context("reading legacy push_tokens")?;
        let mut copied = 0usize;
        for row in rows {
            let (token, platform, user_id, created_at) =
                row.context("row from legacy push_tokens")?;
            conn.execute(
                "INSERT OR IGNORE INTO push_tokens (token, platform, user_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![token, platform, user_id, created_at],
            )
            .context("seeding push_token")?;
            copied += 1;
        }
        tracing::info!("notify: migrated delivery state from monitors.db ({copied} push tokens)");
        Ok(())
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS push_tokens (
                 token       TEXT PRIMARY KEY,
                 platform    TEXT,
                 user_id     TEXT,
                 created_at  TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_push_tokens_user
                 ON push_tokens(user_id);
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
             CREATE TABLE IF NOT EXISTS policy_alert_dedupe (
                 dedupe_key TEXT PRIMARY KEY,
                 fired_at   TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS alert_delivery (
                 id   INTEGER PRIMARY KEY CHECK (id = 1),
                 json TEXT NOT NULL
             );",
        )
        .context("initializing notify schema")?;
        Ok(())
    }

    // ---- policy alerts (dedupe + delivery targets) ------------------------

    /// Atomically claim a policy-alert `dedupe_key` for delivery. Returns `true`
    /// when the caller may deliver (first fire, or the previous fire is older than
    /// `cooldown_secs`), `false` when it is still within the cooldown window. The
    /// SELECT + UPSERT run under one connection lock so concurrent claims of the
    /// same key (one per tool-loop iteration) cannot both win.
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
    pub async fn get_alert_delivery(&self) -> Result<AlertDeliveryTargets> {
        let conn = self.conn.lock().await;
        let json: Option<String> = conn
            .query_row("SELECT json FROM alert_delivery WHERE id = 1", [], |row| {
                row.get::<_, String>(0)
            })
            .optional()
            .context("reading alert delivery targets")?;
        match json {
            Some(j) => Ok(serde_json::from_str(&j).unwrap_or_default()),
            None => Ok(AlertDeliveryTargets::default()),
        }
    }

    /// Persist the node-level alert delivery targets (single-row upsert).
    pub async fn set_alert_delivery(&self, cfg: &AlertDeliveryTargets) -> Result<()> {
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

    // ---- push tokens ------------------------------------------------------

    /// Register (or refresh) an Expo push token for mobile notifications.
    ///
    /// `user_id` scopes the token to the member who registered it so a workflow
    /// can push to a specific person's devices. It is optional: an anonymous /
    /// single-user node registers `None` and the token still receives the
    /// broadcast fan-out (monitor alerts).
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
    /// user-targeted notification to just that person's devices rather than the
    /// whole-node broadcast.
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

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_notify::NotifyTarget;

    /// A NotifyStore in a fresh, unique temp DIRECTORY. The directory matters: the
    /// one-time migration reads a `monitors.db` sibling of the store path, so an
    /// isolated dir guarantees no stray legacy db leaks into these tests.
    fn temp_dir() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("ryu-notify-test-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn temp_store() -> NotifyStore {
        NotifyStore::open(temp_dir().join("notify.db")).expect("open temp store")
    }

    #[tokio::test]
    async fn policy_alert_claim_debounces_within_cooldown() {
        let store = temp_store();
        assert!(store.claim_policy_alert("k1", 300).await.unwrap());
        assert!(!store.claim_policy_alert("k1", 300).await.unwrap());
        assert!(store.claim_policy_alert("k2", 300).await.unwrap());
        assert!(store.claim_policy_alert("k1", 0).await.unwrap());
    }

    #[tokio::test]
    async fn alert_delivery_roundtrips() {
        let store = temp_store();
        let empty = store.get_alert_delivery().await.unwrap();
        assert!(empty.emails.is_empty() && empty.targets.is_empty());
        let cfg = AlertDeliveryTargets {
            targets: vec![NotifyTarget::Webhook {
                url: "https://example.test/hook".to_string(),
            }],
            emails: vec!["ops@example.test".to_string()],
        };
        store.set_alert_delivery(&cfg).await.unwrap();
        let read = store.get_alert_delivery().await.unwrap();
        assert_eq!(read.emails, vec!["ops@example.test".to_string()]);
        assert_eq!(read.targets.len(), 1);
    }

    #[tokio::test]
    async fn notification_roundtrips_and_acks() {
        let store = temp_store();
        let row = NotificationRow {
            id: "ntf_1".into(),
            user_id: Some("u1".into()),
            title: "hi".into(),
            body: None,
            level: "info".into(),
            workflow_run_id: None,
            node_id: None,
            ack_required: false,
            acked: false,
            read_at: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        store.insert_notification(&row).await.unwrap();
        let list = store.list_notifications_for_user("u1", 10).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(store.mark_notification_read("ntf_1").await.unwrap());
        assert!(store.mark_notification_acked("ntf_1").await.unwrap());
    }

    /// Seed a legacy `monitors.db` with the two pre-decomposition tables + rows.
    fn seed_legacy_monitors_db(dir: &std::path::Path) {
        let old = Connection::open(dir.join("monitors.db")).expect("open legacy db");
        old.execute_batch(
            "CREATE TABLE alert_delivery (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
             CREATE TABLE push_tokens (
                 token TEXT PRIMARY KEY, platform TEXT, user_id TEXT, created_at TEXT NOT NULL);",
        )
        .expect("create legacy tables");
        old.execute(
            "INSERT INTO alert_delivery (id, json) VALUES (1, ?1)",
            params![r#"{"targets":[{"kind":"webhook","url":"https://x.test/h"}],"emails":["ops@x.test"]}"#],
        )
        .unwrap();
        old.execute(
            "INSERT INTO push_tokens (token, platform, user_id, created_at)
             VALUES ('tok1', 'ios', 'u1', 't')",
            [],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn migrates_delivery_state_from_legacy_monitors_db() {
        let dir = temp_dir();
        seed_legacy_monitors_db(&dir);

        // First open of a fresh, empty notify.db sibling → migration fires.
        let store = NotifyStore::open(dir.join("notify.db")).unwrap();
        let cfg = store.get_alert_delivery().await.unwrap();
        assert_eq!(cfg.emails, vec!["ops@x.test".to_string()]);
        assert_eq!(cfg.targets.len(), 1);
        assert_eq!(store.push_tokens().await.unwrap(), vec!["tok1".to_string()]);

        // Idempotent: a NEW token appears in the legacy db, but reopening notify.db
        // must NOT re-import (the delivery row is already present).
        {
            let old = Connection::open(dir.join("monitors.db")).unwrap();
            old.execute(
                "INSERT INTO push_tokens (token, platform, user_id, created_at)
                 VALUES ('tok2', 'ios', 'u1', 't')",
                [],
            )
            .unwrap();
        }
        let store2 = NotifyStore::open(dir.join("notify.db")).unwrap();
        assert_eq!(
            store2.push_tokens().await.unwrap(),
            vec!["tok1".to_string()]
        );
    }

    #[tokio::test]
    async fn migration_is_a_noop_without_a_legacy_db() {
        // No sibling monitors.db → the migration is a clean no-op, store stays empty.
        let store = temp_store();
        let cfg = store.get_alert_delivery().await.unwrap();
        assert!(cfg.emails.is_empty() && cfg.targets.is_empty());
        assert!(store.push_tokens().await.unwrap().is_empty());
    }
}
