//! SQLite-backed persistence for the unified activity feed.
//!
//! One table lives in `~/.ryu/activity.db`:
//!   - `activity_items` — one row per feed entry (`id`, the serialized JSON, and a
//!     denormalized `created_at` epoch-seconds column for cheap newest-first paging).
//!
//! A broadcast channel fans freshly-recorded items out to SSE subscribers (the
//! desktop activity feed), mirroring [`crate::monitors::store::MonitorStore`].

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::ActivityItem;

/// SQLite-backed activity store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct ActivityStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<ActivityItem>,
}

impl ActivityStore {
    /// Open (or create) the store at a specific path and run migrations.
    ///
    /// The default-path choice (`~/.ryu/activity.db`) stays Core-side wiring so
    /// this crate has ZERO dependency on `apps/core`.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening activity db {}", path.display()))?;
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
             CREATE TABLE IF NOT EXISTS activity_items (
                 id          TEXT PRIMARY KEY,
                 json        TEXT NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_activity_created_at
                 ON activity_items(created_at DESC);",
        )
        .context("initializing activity schema")?;
        Ok(())
    }

    /// Persist an item, broadcast it to SSE subscribers, and return it.
    pub async fn record(&self, item: ActivityItem) -> Result<ActivityItem> {
        let json = serde_json::to_string(&item).context("serializing activity item")?;
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT OR REPLACE INTO activity_items (id, json, created_at)
                 VALUES (?1, ?2, ?3)",
                params![item.id, json, item.created_at],
            )
            .context("inserting activity item")?;
        }
        // A send error just means no live SSE subscribers — not a failure.
        let _ = self.tx.send(item.clone());
        Ok(item)
    }

    /// List recent items, newest first. `before` (epoch seconds), when set, filters
    /// to `created_at < before` for cursor paging.
    pub async fn list(&self, limit: u32, before: Option<i64>) -> Result<Vec<ActivityItem>> {
        let conn = self.conn.lock().await;
        let map = |row: &rusqlite::Row| -> rusqlite::Result<String> { row.get::<_, String>(0) };
        let mut out = Vec::new();
        match before {
            Some(cursor) => {
                let mut stmt = conn.prepare(
                    "SELECT json FROM activity_items
                     WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![cursor, limit], map)?;
                for row in rows {
                    if let Ok(item) = serde_json::from_str::<ActivityItem>(&row?) {
                        out.push(item);
                    }
                }
            }
            None => {
                let mut stmt = conn
                    .prepare("SELECT json FROM activity_items ORDER BY created_at DESC LIMIT ?1")?;
                let rows = stmt.query_map(params![limit], map)?;
                for row in rows {
                    if let Ok(item) = serde_json::from_str::<ActivityItem>(&row?) {
                        out.push(item);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Subscribe to live activity items (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<ActivityItem> {
        self.tx.subscribe()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ActivityLevel;

    #[tokio::test]
    async fn record_then_list_newest_first_with_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let store = ActivityStore::open(dir.path().join("activity.db")).unwrap();

        let older = ActivityItem::new("note", "manual", "older").with_created_at(100);
        let newer = ActivityItem::new("note", "manual", "newer")
            .with_level(ActivityLevel::Success)
            .with_created_at(200);
        store.record(older.clone()).await.unwrap();
        store.record(newer.clone()).await.unwrap();

        // Newest first.
        let all = store.list(10, None).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, newer.id);
        assert_eq!(all[1].id, older.id);
        assert_eq!(all[0].level, ActivityLevel::Success);

        // Cursor paging: `before` filters to strictly-older items.
        let page = store.list(10, Some(200)).await.unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].id, older.id);
    }

    #[tokio::test]
    async fn record_broadcasts_to_subscribers() {
        let dir = tempfile::tempdir().unwrap();
        let store = ActivityStore::open(dir.path().join("activity.db")).unwrap();
        let mut rx = store.subscribe();
        let item = ActivityItem::new("run", "runs", "did a thing");
        store.record(item.clone()).await.unwrap();
        let got = rx.recv().await.unwrap();
        assert_eq!(got.id, item.id);
    }
}
