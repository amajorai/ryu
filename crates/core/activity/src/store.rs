//! SQLite-backed persistence for the unified activity feed.
//!
//! One table lives in `~/.ryu/activity.db`:
//!   - `activity_items` — one row per feed entry (`id`, the serialized JSON, and a
//!     denormalized `created_at` epoch-seconds column for cheap newest-first paging).
//!
//! A broadcast channel fans freshly-recorded items out to SSE subscribers (the
//! desktop activity feed), mirroring [`crate::monitors::store::MonitorStore`].
//!
//! Encryption at rest: `json` (title, body, agent/session ids, metadata) is
//! sealed per row as `encb:v1:` under the `activity.db` content key, bound to the
//! row's `id`. `id` and `created_at` stay plaintext for paging. Legacy plaintext
//! rows are sealed on open; a row that does not open is skipped and counted.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::ActivityItem;
use crate::seal::{StoreSeal, STORE};

const JSON_PURPOSE: &str = "activity_items.json";

fn json_context(id: &str) -> ContentContext {
    ContentContext::for_id(JSON_PURPOSE, id)
}

fn column_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![ColumnPlan::text(
        "activity_items",
        "json",
        "id",
        KeyKind::Text,
    )?])
}

/// SQLite-backed activity store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct ActivityStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<ActivityItem>,
    seal: StoreSeal,
}

impl ActivityStore {
    /// Open (or create) the store at a specific path and run migrations.
    ///
    /// The default-path choice (`~/.ryu/activity.db`) stays Core-side wiring so
    /// this crate has ZERO dependency on `apps/core`.
    ///
    /// The content key comes from the process's crypto host (Core installs it
    /// at boot); without one the open fails closed.
    pub fn open(path: PathBuf) -> Result<Self> {
        let cipher = ryu_crypto::content_cipher(STORE).context("resolving the activity key")?;
        Self::open_with_cipher(path, cipher)
    }

    /// [`Self::open`] under an explicit content cipher (tests, tools).
    pub fn open_with_cipher(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening activity db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let seal = StoreSeal::prepare(&mut conn, Some(Path::new(&path)), cipher, &column_plans()?)
            .context("sealing the activity store")?;
        let (tx, _rx) = broadcast::channel(128);
        let conn = Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, Some(Path::new(&path)));
        Ok(Self { conn, tx, seal })
    }

    /// Rows skipped by list reads because their sealed value did not open
    /// (since this process opened the store). Surfaced as a health item.
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    /// False when the store was sealed under a key this process does not hold:
    /// writes are refused and the data is left untouched.
    pub fn writable(&self) -> bool {
        self.seal.writable()
    }

    /// Open, then parse, one stored `json` value. `None` when it does not open
    /// or parse (the caller skips and counts it).
    fn decode(&self, id: &str, stored: &str) -> Option<ActivityItem> {
        let json = self.seal.open(stored, &json_context(id)).ok()?;
        serde_json::from_str::<ActivityItem>(&json).ok()
    }

    fn decode_rows(&self, rows: Vec<(String, String)>) -> Vec<ActivityItem> {
        let mut out = Vec::with_capacity(rows.len());
        let mut skipped = 0u64;
        for (id, stored) in rows {
            match self.decode(&id, &stored) {
                Some(item) => out.push(item),
                None => skipped += 1,
            }
        }
        self.seal.count_unreadable(skipped);
        out
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
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
        let json = self.seal.seal(&json, &json_context(&item.id))?;
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
        let rows = {
            let conn = self.conn.lock().await;
            let map = |row: &rusqlite::Row| -> rusqlite::Result<(String, String)> {
                Ok((row.get(0)?, row.get(1)?))
            };
            match before {
                Some(cursor) => {
                    let mut stmt = conn.prepare(
                        "SELECT id, json FROM activity_items
                         WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2",
                    )?;
                    let rows = stmt.query_map(params![cursor, limit], map)?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()?
                }
                None => {
                    let mut stmt = conn.prepare(
                        "SELECT id, json FROM activity_items ORDER BY created_at DESC LIMIT ?1",
                    )?;
                    let rows = stmt.query_map(params![limit], map)?;
                    rows.collect::<rusqlite::Result<Vec<_>>>()?
                }
            }
        };
        Ok(self.decode_rows(rows))
    }

    /// List items in an inclusive/exclusive epoch-seconds range, newest first.
    /// This is the bounded read used by period reports; it does not add a new
    /// event source or persist any derived telemetry.
    pub async fn list_between(
        &self,
        start: i64,
        end: i64,
        limit: u32,
    ) -> Result<Vec<ActivityItem>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, json FROM activity_items
                 WHERE created_at >= ?1 AND created_at < ?2
                 ORDER BY created_at DESC LIMIT ?3",
            )?;
            let rows = stmt.query_map(params![start, end, limit], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(self.decode_rows(rows))
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

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[7u8; 32], STORE)
    }

    fn file_contains(path: &std::path::Path, needle: &str) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
            .unwrap_or(false)
    }

    fn raw_json(path: &std::path::Path, id: &str) -> String {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT json FROM activity_items WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn sealed_rows_never_reach_disk_in_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.db");
        let store = ActivityStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        let item = ActivityItem::new("note", "manual", "Lunch with Dr. Quillfeather")
            .with_body(Some("secret-body-marker".into()));
        store.record(item.clone()).await.unwrap();

        assert!(raw_json(&path, &item.id).starts_with("encb:v1:"));
        for file in [path.clone(), dir.path().join("activity.db-wal")] {
            assert!(!file_contains(&file, "Quillfeather"), "{}", file.display());
            assert!(!file_contains(&file, "secret-body-marker"), "{}", file.display());
        }
        let listed = store.list(10, None).await.unwrap();
        assert_eq!(listed[0].title, "Lunch with Dr. Quillfeather");
        assert_eq!(listed[0].body.as_deref(), Some("secret-body-marker"));
    }

    #[tokio::test]
    async fn legacy_plaintext_rows_are_sealed_on_open_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.db");
        let legacy = ActivityItem::new("note", "manual", "legacy-title-marker").with_created_at(5);
        {
            let conn = Connection::open(&path).unwrap();
            ActivityStore::init_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO activity_items (id, json, created_at) VALUES (?1, ?2, ?3)",
                params![legacy.id, serde_json::to_string(&legacy).unwrap(), 5],
            )
            .unwrap();
        }
        let store = ActivityStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        let listed = store.list(10, None).await.unwrap();
        assert_eq!(listed[0].title, "legacy-title-marker");
        let sealed = raw_json(&path, &legacy.id);
        assert!(sealed.starts_with("encb:v1:"));
        drop(store);
        for file in [path.clone(), dir.path().join("activity.db-wal")] {
            assert!(!file_contains(&file, "legacy-title-marker"), "{}", file.display());
        }

        // A second open is a no-op: the sealed value is left byte-identical.
        let store = ActivityStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        assert_eq!(raw_json(&path, &legacy.id), sealed);
        let conn = Connection::open(&path).unwrap();
        ryu_crypto::content_sqlite::assert_all_open(&conn, &test_cipher(), &column_plans().unwrap())
            .unwrap();
        assert_eq!(store.list(10, None).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_value_copied_to_another_row_is_skipped_and_counted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.db");
        let store = ActivityStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        let a = ActivityItem::new("note", "manual", "a").with_created_at(10);
        let b = ActivityItem::new("note", "manual", "b").with_created_at(20);
        store.record(a.clone()).await.unwrap();
        store.record(b.clone()).await.unwrap();
        {
            let conn = store.conn.lock().await;
            let sealed_a: String = conn
                .query_row("SELECT json FROM activity_items WHERE id = ?1", params![a.id], |r| {
                    r.get(0)
                })
                .unwrap();
            conn.execute(
                "UPDATE activity_items SET json = ?1 WHERE id = ?2",
                params![sealed_a, b.id],
            )
            .unwrap();
        }
        let listed = store.list(10, None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, a.id);
        assert_eq!(store.unreadable_rows(), 1);
    }

    #[tokio::test]
    async fn a_store_sealed_under_another_key_refuses_writes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("activity.db");
        let store = ActivityStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        store.record(ActivityItem::new("note", "manual", "kept")).await.unwrap();
        drop(store);
        let other = ContentCipher::from_root(&[9u8; 32], STORE);
        let store = ActivityStore::open_with_cipher(path.clone(), other).unwrap();
        assert!(!store.writable());
        assert!(store.record(ActivityItem::new("note", "manual", "x")).await.is_err());
        let store = ActivityStore::open_with_cipher(path, test_cipher()).unwrap();
        assert_eq!(store.list(10, None).await.unwrap()[0].title, "kept");
    }

    #[tokio::test]
    async fn list_between_is_exact_and_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = ActivityStore::open(dir.path().join("activity.db")).unwrap();
        let before = ActivityItem::new("note", "manual", "before").with_created_at(99);
        let start = ActivityItem::new("note", "manual", "start").with_created_at(100);
        let inside = ActivityItem::new("note", "manual", "inside").with_created_at(150);
        let end = ActivityItem::new("note", "manual", "end").with_created_at(200);
        for item in [before, start, inside, end] {
            store.record(item).await.unwrap();
        }

        let items = store.list_between(100, 200, 10).await.unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].title, "inside");
        assert_eq!(items[1].title, "start");
    }
}
