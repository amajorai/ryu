//! SQLite-backed persistence for quests (the auto-detected todo list).
//!
//! Two tables live in `~/.ryu/quests.db`:
//!   - `quests`     — the todo/quest definitions (title, completion condition,
//!     status, and the latest detection suggestion as embedded JSON).
//!   - `detections` — an append-only log of every time the judge thought a quest
//!     was done (confidence + reason + a short evidence snippet), so the history
//!     of *why* something was auto-completed survives.
//!
//! A broadcast channel fans freshly-changed quests out to SSE subscribers (the
//! desktop quests page + the island completion chip), mirroring
//! [`crate::monitors::store`] and [`crate::meetings::store`].
//!
//! Placement note (Core vs Gateway): this stores *what the user wants to get done
//! and what was detected as finished* — it decides what runs, not what is allowed
//! — so it is Core. The judge model call it drives routes through the Gateway.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{Quest, QuestEvent};

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("quests.db")
}

/// SQLite-backed quest store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct QuestStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<QuestEvent>,
}

impl QuestStore {
    /// Open (or create) the store at the default path (`~/.ryu/quests.db`).
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
            .with_context(|| format!("opening quests db {}", path.display()))?;
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
             CREATE TABLE IF NOT EXISTS quests (
                 id          TEXT PRIMARY KEY,
                 json        TEXT NOT NULL,
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS detections (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 quest_id    TEXT NOT NULL,
                 detected_at TEXT NOT NULL,
                 confidence  INTEGER NOT NULL,
                 reason      TEXT NOT NULL,
                 evidence    TEXT,
                 disposition TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_detections_quest
                 ON detections(quest_id, id DESC);",
        )
        .context("initializing quests schema")?;
        Ok(())
    }

    // ---- quests -----------------------------------------------------------

    /// Insert or replace a quest definition, then broadcast an `Updated` event.
    pub async fn upsert_quest(&self, quest: &Quest) -> Result<()> {
        let json = serde_json::to_string(quest).context("serializing quest")?;
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO quests (id, json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET json = ?2, updated_at = ?4",
                params![quest.id, json, quest.created_at, quest.updated_at],
            )
            .context("upserting quest")?;
        }
        self.broadcast(QuestEvent::Updated {
            quest: quest.clone(),
        });
        Ok(())
    }

    /// Fetch a quest by id.
    pub async fn get_quest(&self, id: &str) -> Result<Option<Quest>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM quests WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading quest")?;
        match json {
            Some(j) => Ok(Some(serde_json::from_str(&j).context("deserializing quest")?)),
            None => Ok(None),
        }
    }

    /// List all quests, newest first.
    pub async fn list_quests(&self) -> Result<Vec<Quest>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM quests ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(quest) = serde_json::from_str::<Quest>(&row?) {
                out.push(quest);
            }
        }
        Ok(out)
    }

    /// Delete a quest and its detection history, then broadcast a `Deleted` event.
    /// Returns true when removed.
    pub async fn delete_quest(&self, id: &str) -> Result<bool> {
        let removed = {
            let conn = self.conn.lock().await;
            let n = conn.execute("DELETE FROM quests WHERE id = ?1", params![id])?;
            conn.execute("DELETE FROM detections WHERE quest_id = ?1", params![id])?;
            n > 0
        };
        if removed {
            self.broadcast(QuestEvent::Deleted { id: id.to_string() });
        }
        Ok(removed)
    }

    // ---- detections -------------------------------------------------------

    /// Append a detection record (the audit trail of why a quest was flagged done).
    pub async fn insert_detection(
        &self,
        quest_id: &str,
        confidence: u8,
        reason: &str,
        evidence: Option<&str>,
        disposition: &str,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO detections (quest_id, detected_at, confidence, reason, evidence, disposition)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![quest_id, now, confidence as i64, reason, evidence, disposition],
        )
        .context("inserting detection")?;
        Ok(())
    }

    /// Broadcast a quest event (suggested / completed) to SSE subscribers.
    pub fn broadcast(&self, event: QuestEvent) {
        // A send error just means no live SSE subscribers — not a failure.
        let _ = self.tx.send(event);
    }

    /// Subscribe to live quest events (used by the SSE endpoint + island).
    pub fn subscribe(&self) -> broadcast::Receiver<QuestEvent> {
        self.tx.subscribe()
    }
}
