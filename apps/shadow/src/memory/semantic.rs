use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::utils::wall_micros;

/// A single semantic memory entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryEntry {
    pub id: String,
    pub category: String,
    pub content: String,
    pub confidence: f32,
    pub source_episode_id: Option<String>,
    pub access_count: u32,
    pub last_accessed: u64,
    pub created_at: u64,
}

/// SQLite-backed semantic memory store.
pub struct SemanticMemoryStore {
    conn: Connection,
}

impl SemanticMemoryStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(db_path.parent().unwrap_or(std::path::Path::new(".")))?;
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_entries (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                content TEXT NOT NULL,
                confidence REAL NOT NULL DEFAULT 1.0,
                source_episode_id TEXT,
                access_count INTEGER NOT NULL DEFAULT 0,
                last_accessed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_category ON memory_entries(category);
            CREATE INDEX IF NOT EXISTS idx_memory_created ON memory_entries(created_at DESC);",
        )?;
        Ok(Self { conn })
    }

    /// Query memories by optional category and text substring.
    pub fn query(&self, category: Option<&str>, text: &str) -> Result<Vec<MemoryEntry>> {
        let now = wall_micros();
        let text_pat = format!("%{}%", text.to_lowercase());

        // Use a single query that fetches all matching text entries, then
        // filter by category in Rust to avoid stmt-in-match-arm lifetime issues.
        let mut stmt = self.conn.prepare(
            "SELECT id, category, content, confidence, source_episode_id, \
             access_count, last_accessed, created_at \
             FROM memory_entries WHERE lower(content) LIKE ?1 \
             ORDER BY confidence DESC, access_count DESC LIMIT 50",
        )?;
        let mut entries: Vec<MemoryEntry> = stmt
            .query_map(rusqlite::params![text_pat], row_to_entry)?
            .filter_map(|r| r.ok())
            .collect();

        if let Some(cat) = category {
            entries.retain(|e| e.category == cat);
        }
        entries.truncate(20);

        // Update access counts
        for entry in &entries {
            self.conn.execute(
                "UPDATE memory_entries SET access_count = access_count + 1, last_accessed = ?1 WHERE id = ?2",
                rusqlite::params![now as i64, entry.id],
            ).ok();
        }

        Ok(entries)
    }

    /// Upsert a memory entry. If content+category matches an existing entry, update confidence.
    pub fn upsert(&self, entry: &MemoryEntry) -> Result<()> {
        // Check for duplicate by category + content similarity
        let existing: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM memory_entries WHERE category = ?1 AND content = ?2 LIMIT 1",
                rusqlite::params![entry.category, entry.content],
                |row| row.get(0),
            )
            .ok();

        if let Some(existing_id) = existing {
            // Update existing
            self.conn.execute(
                "UPDATE memory_entries SET confidence = MAX(confidence, ?1), access_count = access_count + 1, last_accessed = ?2 WHERE id = ?3",
                rusqlite::params![entry.confidence as f64, wall_micros() as i64, existing_id],
            )?;
        } else {
            self.conn.execute(
                "INSERT INTO memory_entries (id, category, content, confidence, source_episode_id, access_count, last_accessed, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    entry.id,
                    entry.category,
                    entry.content,
                    entry.confidence as f64,
                    entry.source_episode_id,
                    entry.access_count,
                    entry.last_accessed as i64,
                    entry.created_at as i64,
                ],
            )?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM memory_entries WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn list_by_category(&self, category: &str) -> Result<Vec<MemoryEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, category, content, confidence, source_episode_id, \
             access_count, last_accessed, created_at \
             FROM memory_entries WHERE category = ?1 \
             ORDER BY confidence DESC LIMIT 50",
        )?;
        let entries = stmt
            .query_map([category], row_to_entry)?
            .filter_map(|r| r.ok())
            .collect();
        Ok(entries)
    }
}

fn row_to_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryEntry> {
    Ok(MemoryEntry {
        id: row.get(0)?,
        category: row.get(1)?,
        content: row.get(2)?,
        confidence: row.get::<_, f64>(3)? as f32,
        source_episode_id: row.get(4)?,
        access_count: row.get::<_, i64>(5)? as u32,
        last_accessed: row.get::<_, i64>(6)? as u64,
        created_at: row.get::<_, i64>(7)? as u64,
    })
}
