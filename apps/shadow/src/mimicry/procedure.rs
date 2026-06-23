use anyhow::Result;
use rusqlite::Connection;

use super::types::ProcedureTemplate;
use crate::utils::wall_micros;

/// SQLite-backed procedure store.
pub struct ProcedureStore {
    conn: Connection,
}

impl ProcedureStore {
    pub fn new(db_path: &std::path::Path) -> Result<Self> {
        std::fs::create_dir_all(db_path.parent().unwrap_or(std::path::Path::new(".")))?;
        let conn = Connection::open(db_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS procedures (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                app_name TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                steps_json TEXT NOT NULL DEFAULT '[]',
                preconditions_json TEXT NOT NULL DEFAULT '[]',
                success_count INTEGER NOT NULL DEFAULT 0,
                failure_count INTEGER NOT NULL DEFAULT 0,
                last_used INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_procedures_app ON procedures(app_name);
            CREATE INDEX IF NOT EXISTS idx_procedures_success ON procedures(success_count DESC);",
        )?;
        Ok(Self { conn })
    }

    pub fn save(&self, proc: &ProcedureTemplate) -> Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO procedures \
             (id, name, app_name, description, steps_json, preconditions_json, \
              success_count, failure_count, last_used, created_at) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                proc.id,
                proc.name,
                proc.app_name,
                proc.description,
                serde_json::to_string(&proc.steps).unwrap_or_default(),
                serde_json::to_string(&proc.preconditions).unwrap_or_default(),
                proc.success_count,
                proc.failure_count,
                proc.last_used as i64,
                proc.created_at as i64,
            ],
        )?;
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<ProcedureTemplate>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, app_name, description, steps_json, preconditions_json, \
             success_count, failure_count, last_used, created_at \
             FROM procedures ORDER BY success_count DESC LIMIT 100",
        )?;
        let rows = stmt
            .query_map([], row_to_procedure)?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    pub fn get(&self, id: &str) -> Result<Option<ProcedureTemplate>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, app_name, description, steps_json, preconditions_json, \
             success_count, failure_count, last_used, created_at \
             FROM procedures WHERE id = ?1",
        )?;
        let result = stmt
            .query_map([id], row_to_procedure)?
            .next()
            .and_then(|r| r.ok());
        Ok(result)
    }

    pub fn find_by_name(&self, name: &str) -> Result<Option<ProcedureTemplate>> {
        let name_pat = format!("%{}%", name.to_lowercase());
        let mut stmt = self.conn.prepare(
            "SELECT id, name, app_name, description, steps_json, preconditions_json, \
             success_count, failure_count, last_used, created_at \
             FROM procedures WHERE lower(name) LIKE ?1 OR lower(description) LIKE ?1 \
             ORDER BY success_count DESC LIMIT 1",
        )?;
        let result = stmt
            .query_map([&name_pat], row_to_procedure)?
            .next()
            .and_then(|r| r.ok());
        Ok(result)
    }

    pub fn record_success(&self, id: &str) -> Result<()> {
        let now = wall_micros() as i64;
        self.conn.execute(
            "UPDATE procedures SET success_count = success_count + 1, last_used = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )?;
        Ok(())
    }

    pub fn record_failure(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE procedures SET failure_count = failure_count + 1 WHERE id = ?1",
            [id],
        )?;
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM procedures WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Find procedures whose name or description matches any keyword in `description`.
    /// Returns up to `limit` results ordered by success count descending.
    pub fn find_similar(&self, description: &str, limit: usize) -> Result<Vec<ProcedureTemplate>> {
        let keywords: Vec<String> = description
            .split_whitespace()
            .filter(|w| w.len() > 3)
            .map(|w| w.to_lowercase())
            .collect();

        if keywords.is_empty() {
            return Ok(vec![]);
        }

        // Load all and filter in Rust; procedure stores are small (<1000 rows)
        let mut stmt = self.conn.prepare(
            "SELECT id, name, app_name, description, steps_json, preconditions_json, \
             success_count, failure_count, last_used, created_at \
             FROM procedures ORDER BY success_count DESC",
        )?;

        let mut results: Vec<ProcedureTemplate> = stmt
            .query_map([], row_to_procedure)?
            .filter_map(|r| r.ok())
            .filter(|p| {
                let name_lower = p.name.to_lowercase();
                let desc_lower = p.description.to_lowercase();
                keywords
                    .iter()
                    .any(|kw| name_lower.contains(kw.as_str()) || desc_lower.contains(kw.as_str()))
            })
            .take(limit)
            .collect();

        Ok(results)
    }
}

fn row_to_procedure(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProcedureTemplate> {
    Ok(ProcedureTemplate {
        id: row.get(0)?,
        name: row.get(1)?,
        app_name: row.get(2)?,
        description: row.get(3)?,
        steps: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
        preconditions: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default(),
        success_count: row.get::<_, i64>(6)? as u32,
        failure_count: row.get::<_, i64>(7)? as u32,
        last_used: row.get::<_, i64>(8)? as u64,
        created_at: row.get::<_, i64>(9)? as u64,
    })
}
