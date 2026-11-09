//! Memory database schema creation and idempotent column migrations.

use anyhow::{Context, Result};
use rusqlite::Connection;

use crate::{working, MemoryStore};

impl MemoryStore {
    pub(crate) fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS memory_entries (
                 id          TEXT PRIMARY KEY,
                 user_id     TEXT NOT NULL,
                 agent_id    TEXT NOT NULL,
                 nonce       BLOB NOT NULL,
                 ciphertext  BLOB NOT NULL,
                 created_at  INTEGER NOT NULL,
                 lifecycle   TEXT NOT NULL DEFAULT 'active',
                 supersedes_id TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_memory_scope
                 ON memory_entries(user_id, agent_id, created_at);
             CREATE TABLE IF NOT EXISTS memory_proposals (
                 id               TEXT PRIMARY KEY,
                 owner_user_id    TEXT NOT NULL,
                 agent_id         TEXT NOT NULL,
                 target_memory_id TEXT,
                 operation        TEXT NOT NULL,
                 status           TEXT NOT NULL DEFAULT 'pending',
                 nonce            BLOB NOT NULL,
                 ciphertext       BLOB NOT NULL,
                 created_at       INTEGER NOT NULL,
                 updated_at       INTEGER NOT NULL,
                 reviewed_at      INTEGER,
                 reviewed_by      TEXT,
                 applied_memory_id TEXT
             );
             CREATE INDEX IF NOT EXISTS idx_memory_proposals_owner
                 ON memory_proposals(owner_user_id, status, created_at);
             CREATE TABLE IF NOT EXISTS memory_settings (
                 user_id                   TEXT PRIMARY KEY,
                 include_sensitive_topics INTEGER NOT NULL DEFAULT 0,
                 updated_at               INTEGER NOT NULL
             );",
        )
        .context("initializing memory schema")?;

        // Multi-level metadata columns (added incrementally; idempotent). Existing
        // rows default to user-level / user_fact / importance 3, keeping prior
        // facts readable and broadly visible.
        Self::add_column_if_missing(conn, "scope", "TEXT NOT NULL DEFAULT 'user'")?;
        Self::add_column_if_missing(conn, "scope_id", "TEXT")?;
        Self::add_column_if_missing(conn, "category", "TEXT NOT NULL DEFAULT 'user_fact'")?;
        Self::add_column_if_missing(conn, "importance", "INTEGER NOT NULL DEFAULT 3")?;
        Self::add_column_if_missing(conn, "tags", "TEXT NOT NULL DEFAULT '[]'")?;
        Self::add_column_if_missing(conn, "updated_at", "INTEGER NOT NULL DEFAULT 0")?;
        Self::add_column_if_missing(conn, "lifecycle", "TEXT NOT NULL DEFAULT 'active'")?;
        Self::add_column_if_missing(conn, "supersedes_id", "TEXT")?;
        // Access tracking, bumped by `mark_recalled` after a turn injects a fact.
        // Nullable so rows written before the columns existed read as never
        // recalled.
        Self::add_column_if_missing(conn, "recall_count", "INTEGER DEFAULT 0")?;
        Self::add_column_if_missing(conn, "last_recalled_at", "INTEGER")?;
        // Rows saved before tracking began read as never recalled, which is
        // unknown rather than true; remember when the clock started.
        Self::record_access_tracking_start(conn)?;

        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_memory_scope_level
                 ON memory_entries(scope, scope_id, category);
             CREATE INDEX IF NOT EXISTS idx_memory_lifecycle
                 ON memory_entries(lifecycle, updated_at);
             CREATE INDEX IF NOT EXISTS idx_memory_category_age
                 ON memory_entries(category, lifecycle, created_at);
             CREATE INDEX IF NOT EXISTS idx_memory_proposals_target
                 ON memory_proposals(target_memory_id, operation, status);",
        )
        .context("creating memory indexes")?;
        working::init_schema(conn)?;
        Ok(())
    }

    /// Add `memory_entries.<name>` when it is not already present. `PRAGMA
    /// table_info` is the in-repo migration pattern (see `agents::AgentStore`).
    fn add_column_if_missing(conn: &Connection, name: &str, decl: &str) -> Result<()> {
        let exists = {
            let mut stmt = conn.prepare("PRAGMA table_info(memory_entries)")?;
            let cols = stmt.query_map([], |row| row.get::<_, String>(1))?;
            let mut found = false;
            for col in cols {
                if col? == name {
                    found = true;
                    break;
                }
            }
            found
        };
        if !exists {
            conn.execute(
                &format!("ALTER TABLE memory_entries ADD COLUMN {name} {decl}"),
                [],
            )
            .with_context(|| format!("adding memory column {name}"))?;
        }
        Ok(())
    }
}
