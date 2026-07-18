//! SQLite-backed persistence for meeting notes.
//!
//! Two tables live in `~/.ryu/meetings.db`:
//!   - `meetings` — one row per recorded/detected meeting (stored as JSON, the
//!     same shape as the REST surface), including the generated notes once
//!     finalized.
//!   - `segments` — the live transcript: one row per transcribed audio chunk,
//!     time-ordered, that accumulates while a meeting records.
//!
//! A broadcast channel fans meeting events (detection, a new transcript segment,
//! status changes, finalized notes) out to SSE subscribers — the desktop
//! Meetings page and the island "start notes?" prompt — mirroring
//! [`crate::monitors::store`].
//!
//! Placement note (Core vs Gateway): this stores *what was said and the notes we
//! derived* — it decides what runs, not what is allowed — so it is Core. Audio
//! *capture* is a device-bound sensor and lives in Shadow; Core only ingests the
//! resulting chunks.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{Meeting, MeetingEvent, Segment};

fn default_db_path() -> PathBuf {
    crate::data_dir().join("meetings.db")
}

/// SQLite-backed meeting store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct MeetingStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<MeetingEvent>,
}

impl MeetingStore {
    /// Open (or create) the store at the default path (`~/.ryu/meetings.db`).
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
            .with_context(|| format!("opening meetings db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let (tx, _rx) = broadcast::channel(256);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS meetings (
                 id          TEXT PRIMARY KEY,
                 json        TEXT NOT NULL,
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS segments (
                 id          INTEGER PRIMARY KEY AUTOINCREMENT,
                 meeting_id  TEXT NOT NULL,
                 t_offset_ms INTEGER NOT NULL,
                 speaker     TEXT,
                 text        TEXT NOT NULL,
                 created_at  TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_segments_meeting
                 ON segments(meeting_id, id);",
        )
        .context("initializing meetings schema")?;
        Ok(())
    }

    // ---- meetings ---------------------------------------------------------

    /// Insert or replace a meeting definition.
    pub async fn upsert_meeting(&self, meeting: &Meeting) -> Result<()> {
        let json = serde_json::to_string(meeting).context("serializing meeting")?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO meetings (id, json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET json = ?2, updated_at = ?4",
            params![meeting.id, json, meeting.created_at, meeting.updated_at],
        )
        .context("upserting meeting")?;
        Ok(())
    }

    /// Fetch a meeting by id.
    pub async fn get_meeting(&self, id: &str) -> Result<Option<Meeting>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM meetings WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading meeting")?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("deserializing meeting")?,
            )),
            None => Ok(None),
        }
    }

    /// List all meetings, newest first.
    pub async fn list_meetings(&self) -> Result<Vec<Meeting>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM meetings ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(meeting) = serde_json::from_str::<Meeting>(&row?) {
                out.push(meeting);
            }
        }
        Ok(out)
    }

    /// Rename a meeting (manual). Marks the title user-chosen so the background
    /// auto-namer leaves it alone. Returns the updated meeting, or `None` when no
    /// such meeting exists.
    pub async fn set_title(&self, id: &str, title: &str) -> Result<Option<Meeting>> {
        let Some(mut meeting) = self.get_meeting(id).await? else {
            return Ok(None);
        };
        meeting.title = title.to_string();
        meeting.title_custom = true;
        meeting.updated_at = chrono::Utc::now().to_rfc3339();
        self.upsert_meeting(&meeting).await?;
        Ok(Some(meeting))
    }

    /// Apply an auto-generated title from the transcript, but only when the user
    /// hasn't chosen one (`title_custom == false`). Does not set `title_custom`,
    /// so an auto title stays replaceable and a later manual rename still locks
    /// it. Returns the updated meeting when it wrote, else `None`.
    pub async fn auto_set_title(&self, id: &str, title: &str) -> Result<Option<Meeting>> {
        let Some(mut meeting) = self.get_meeting(id).await? else {
            return Ok(None);
        };
        if meeting.title_custom {
            return Ok(None);
        }
        meeting.title = title.to_string();
        meeting.updated_at = chrono::Utc::now().to_rfc3339();
        self.upsert_meeting(&meeting).await?;
        Ok(Some(meeting))
    }

    /// Delete a meeting and its transcript segments. Returns true when removed.
    pub async fn delete_meeting(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn.execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM segments WHERE meeting_id = ?1", params![id])?;
        Ok(n > 0)
    }

    // ---- segments ---------------------------------------------------------

    /// Append a transcript segment, returning it with its generated id.
    pub async fn insert_segment(
        &self,
        meeting_id: &str,
        t_offset_ms: i64,
        speaker: Option<&str>,
        text: &str,
    ) -> Result<Segment> {
        let now = chrono::Utc::now().to_rfc3339();
        let id = {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO segments (meeting_id, t_offset_ms, speaker, text, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![meeting_id, t_offset_ms, speaker, text, now],
            )
            .context("inserting segment")?;
            conn.last_insert_rowid()
        };
        Ok(Segment {
            id,
            meeting_id: meeting_id.to_string(),
            t_offset_ms,
            speaker: speaker.map(str::to_string),
            text: text.to_string(),
            created_at: now,
        })
    }

    /// Set (or overwrite) a segment's speaker label — used by diarization once the
    /// finished recording has been split into speaker turns.
    pub async fn set_segment_speaker(&self, segment_id: i64, speaker: &str) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "UPDATE segments SET speaker = ?2 WHERE id = ?1",
            params![segment_id, speaker],
        )
        .context("updating segment speaker")?;
        Ok(())
    }

    /// All transcript segments for a meeting, in capture order (oldest first).
    pub async fn list_segments(&self, meeting_id: &str) -> Result<Vec<Segment>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, meeting_id, t_offset_ms, speaker, text, created_at
             FROM segments WHERE meeting_id = ?1 ORDER BY id ASC",
        )?;
        let rows = stmt.query_map(params![meeting_id], |row| {
            Ok(Segment {
                id: row.get(0)?,
                meeting_id: row.get(1)?,
                t_offset_ms: row.get(2)?,
                speaker: row.get(3)?,
                text: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    // ---- events -----------------------------------------------------------

    /// Broadcast a meeting event to SSE subscribers. A send error just means no
    /// live subscribers — not a failure.
    pub fn emit(&self, event: MeetingEvent) {
        let _ = self.tx.send(event);
    }

    /// Subscribe to live meeting events (used by the SSE endpoint).
    pub fn subscribe(&self) -> broadcast::Receiver<MeetingEvent> {
        self.tx.subscribe()
    }
}
