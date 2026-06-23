use anyhow::Result;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::utils::wall_micros;

/// A persistent behavioral directive.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directive {
    pub id: String,
    pub directive_type: String, // "reminder" | "habit" | "automation" | "watch"
    pub content: String,
    pub trigger_pattern: Option<String>,
    pub action: Option<String>,
    pub priority: u8,
    pub expires_at: Option<u64>,
    pub created_at: u64,
}

/// SQLite-backed directive store.
pub struct DirectiveMemoryStore {
    conn: Connection,
}

impl DirectiveMemoryStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(db_path.parent().unwrap_or(std::path::Path::new(".")))?;
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS directives (
                id TEXT PRIMARY KEY,
                directive_type TEXT NOT NULL,
                content TEXT NOT NULL,
                trigger_pattern TEXT,
                action TEXT,
                priority INTEGER NOT NULL DEFAULT 5,
                expires_at INTEGER,
                created_at INTEGER NOT NULL,
                completed_at INTEGER
            );
            CREATE INDEX IF NOT EXISTS idx_directives_type ON directives(directive_type);
            CREATE INDEX IF NOT EXISTS idx_directives_active ON directives(completed_at) WHERE completed_at IS NULL;",
        )?;
        Ok(Self { conn })
    }

    /// List active (non-expired, non-completed) directives.
    pub fn list_active(&self, type_filter: Option<&str>) -> Result<Vec<Directive>> {
        let now = wall_micros() as i64;
        // Single query for all active directives; filter by type in Rust if needed.
        let mut stmt = self.conn.prepare(
            "SELECT id, directive_type, content, trigger_pattern, action, priority, expires_at, created_at \
             FROM directives WHERE completed_at IS NULL \
             AND (expires_at IS NULL OR expires_at > ?1) \
             ORDER BY priority DESC, created_at DESC",
        )?;
        let mut directives: Vec<Directive> = stmt
            .query_map(rusqlite::params![now], row_to_directive)?
            .filter_map(|r| r.ok())
            .collect();
        if let Some(t) = type_filter {
            directives.retain(|d| d.directive_type == t);
        }
        Ok(directives)
    }

    pub fn create(&self, directive: &Directive) -> Result<()> {
        self.conn.execute(
            "INSERT INTO directives (id, directive_type, content, trigger_pattern, action, priority, expires_at, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                directive.id,
                directive.directive_type,
                directive.content,
                directive.trigger_pattern,
                directive.action,
                directive.priority as i64,
                directive.expires_at.map(|t| t as i64),
                directive.created_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn complete(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE directives SET completed_at = ?1 WHERE id = ?2",
            rusqlite::params![wall_micros() as i64, id],
        )?;
        Ok(())
    }

    /// Check which directives match the given context string.
    pub fn check_triggers(&self, context: &str) -> Result<Vec<Directive>> {
        let active = self.list_active(None)?;
        Ok(active
            .into_iter()
            .filter(|d| {
                d.trigger_pattern
                    .as_deref()
                    .map(|p| context.to_lowercase().contains(&p.to_lowercase()))
                    .unwrap_or(false)
            })
            .collect())
    }
}

fn row_to_directive(row: &rusqlite::Row<'_>) -> rusqlite::Result<Directive> {
    Ok(Directive {
        id: row.get(0)?,
        directive_type: row.get(1)?,
        content: row.get(2)?,
        trigger_pattern: row.get(3)?,
        action: row.get(4)?,
        priority: row.get::<_, i64>(5)? as u8,
        expires_at: row.get::<_, Option<i64>>(6)?.map(|t| t as u64),
        created_at: row.get::<_, i64>(7)? as u64,
    })
}
