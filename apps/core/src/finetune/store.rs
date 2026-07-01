//! Persisted fine-tune job store (`~/.ryu/finetune.db`).
//!
//! Core's durable record of every fine-tune job it has started. The job itself
//! runs *in the sidecar* (a separate process), so live progress is streamed from
//! there; this store is the system-of-record for the job list and survives a Core
//! restart (the sidecar's in-process registry does not). Mirrors the rusqlite
//! pattern in [`crate::monitors::store`].

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// One fine-tune job as Core records it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinetuneJob {
    /// Sidecar-assigned job id (also the row primary key).
    pub id: String,
    /// HF repo id of the base model being tuned.
    pub base_model: String,
    /// Stem the trained adapter is saved under (`None` until known).
    pub output_name: Option<String>,
    /// Coarse lifecycle state, mirrored from the sidecar:
    /// `queued | running | succeeded | failed | cancelled`.
    pub state: String,
    /// Where the job runs: `local` | `remote` (Unit 5).
    pub target: String,
    /// For a remote job: the remote node's base URL (e.g. `https://node.example`).
    /// Safe to expose; Core proxies status/stream/cancel here. `None` for local.
    pub remote_url: Option<String>,
    /// For a remote job: the bearer token for that node. Persisted so Core can
    /// proxy on the job's behalf, but NEVER serialized back to API clients.
    #[serde(skip_serializing, default)]
    pub remote_token: Option<String>,
    /// On-disk path/ref of the produced adapter once finished (`None` otherwise).
    pub output_ref: Option<String>,
    /// Terminal error message when `state == "failed"`.
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// SQLite-backed job store, safe to clone (shares one connection behind a mutex).
#[derive(Clone)]
pub struct FinetuneStore {
    conn: Arc<Mutex<Connection>>,
}

impl FinetuneStore {
    /// Open (creating if needed) the store at the default `~/.ryu/finetune.db`.
    pub fn open_default() -> Result<Self> {
        Self::open(crate::paths::ryu_dir().join("finetune.db"))
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening finetune db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS finetune_jobs (
                 id           TEXT PRIMARY KEY,
                 base_model   TEXT NOT NULL,
                 output_name  TEXT,
                 state        TEXT NOT NULL,
                 target       TEXT NOT NULL,
                 remote_url   TEXT,
                 remote_token TEXT,
                 output_ref   TEXT,
                 error        TEXT,
                 created_at   TEXT NOT NULL,
                 updated_at   TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_finetune_created
                 ON finetune_jobs(created_at DESC);",
        )
        .context("initializing finetune schema")?;
        // Idempotent migration for stores created before the remote columns
        // existed (the feature is new, but a dev db may predate them). Ignore the
        // "duplicate column" error that fires when they're already present.
        for col in ["remote_url", "remote_token"] {
            let _ = conn.execute(
                &format!("ALTER TABLE finetune_jobs ADD COLUMN {col} TEXT"),
                [],
            );
        }
        Ok(())
    }

    /// Insert a freshly-started job. Idempotent on `id` (re-insert replaces).
    pub async fn record(&self, job: &FinetuneJob) -> Result<()> {
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT OR REPLACE INTO finetune_jobs
               (id, base_model, output_name, state, target, remote_url, remote_token,
                output_ref, error, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                job.id,
                job.base_model,
                job.output_name,
                job.state,
                job.target,
                job.remote_url,
                job.remote_token,
                job.output_ref,
                job.error,
                job.created_at,
                job.updated_at,
            ],
        )
        .context("inserting finetune job")?;
        Ok(())
    }

    /// Update the mutable fields of a job after a status poll or terminal event.
    pub async fn update_state(
        &self,
        id: &str,
        state: &str,
        output_ref: Option<&str>,
        error: Option<&str>,
        updated_at: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE finetune_jobs
                 SET state = ?2,
                     output_ref = COALESCE(?3, output_ref),
                     error = COALESCE(?4, error),
                     updated_at = ?5
                 WHERE id = ?1",
                params![id, state, output_ref, error, updated_at],
            )
            .context("updating finetune job")?;
        Ok(n > 0)
    }

    pub async fn get(&self, id: &str) -> Result<Option<FinetuneJob>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, base_model, output_name, state, target, remote_url, remote_token, output_ref, error, created_at, updated_at
             FROM finetune_jobs WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], Self::map_row)?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }

    pub async fn list(&self) -> Result<Vec<FinetuneJob>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, base_model, output_name, state, target, remote_url, remote_token, output_ref, error, created_at, updated_at
             FROM finetune_jobs ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::map_row)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FinetuneJob> {
        Ok(FinetuneJob {
            id: row.get(0)?,
            base_model: row.get(1)?,
            output_name: row.get(2)?,
            state: row.get(3)?,
            target: row.get(4)?,
            remote_url: row.get(5)?,
            remote_token: row.get(6)?,
            output_ref: row.get(7)?,
            error: row.get(8)?,
            created_at: row.get(9)?,
            updated_at: row.get(10)?,
        })
    }
}
