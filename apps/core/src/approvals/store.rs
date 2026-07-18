//! SQLite-backed persistence for the human-in-the-loop approval inbox.
//!
//! One table lives in `~/.ryu/approvals.db`:
//!   - `approvals` — every approval request (the full [`ApprovalRequest`] as
//!     embedded JSON, plus a denormalized `status` + `source_ref` column so
//!     pending-by-source dedup and status filters don't have to scan JSON).
//!
//! A broadcast channel fans freshly-changed requests out to SSE subscribers (the
//! desktop inbox page + the island chip), mirroring `ryu_quests` and
//! the monitors store.
//!
//! Placement note (Core vs Gateway): this stores *what is queued to run and what
//! the user decided* — the queue and the resume machinery decide what runs — so it
//! is Core. Whether an action *required* approval in the first place is the policy
//! question, evaluated upstream (a user-set flag today; a Gateway consult once
//! tool risk-tags land); this module only holds the resulting queue.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{ApprovalEvent, ApprovalRequest, ApprovalStatus};

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("approvals.db")
}

/// SQLite-backed approval store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct ApprovalStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<ApprovalEvent>,
}

impl ApprovalStore {
    /// Open (or create) the store at the default path (`~/.ryu/approvals.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) an in-memory store for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory approvals db")?;
        Self::init_schema(&conn)?;
        let (tx, _rx) = broadcast::channel(128);
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
        })
    }

    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening approvals db {}", path.display()))?;
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
             CREATE TABLE IF NOT EXISTS approvals (
                 id          TEXT PRIMARY KEY,
                 json        TEXT NOT NULL,
                 status      TEXT NOT NULL,
                 source_ref  TEXT,
                 created_at  TEXT NOT NULL,
                 updated_at  TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_approvals_status
                 ON approvals(status, created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_approvals_source
                 ON approvals(source_ref, status);",
        )
        .context("initializing approvals schema")?;
        Ok(())
    }

    /// Insert a new approval request, then broadcast a `Created` event.
    pub async fn insert(&self, req: &ApprovalRequest) -> Result<()> {
        let json = serde_json::to_string(req).context("serializing approval")?;
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "INSERT INTO approvals (id, json, status, source_ref, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    req.id,
                    json,
                    req.status.as_str(),
                    req.source_ref,
                    req.created_at
                ],
            )
            .context("inserting approval")?;
        }
        self.broadcast(ApprovalEvent::Created {
            request: req.clone(),
        });
        Ok(())
    }

    /// Persist an updated request (decision, expiry, error), then broadcast a
    /// `Decided` event. The whole row is rewritten from the (already-mutated)
    /// struct. Unconditional — used for post-decision writes (recording a tool
    /// result/error on an already-decided row). For the pending→decided
    /// **transition** use [`try_transition`](Self::try_transition), which is
    /// atomic against concurrent deciders.
    pub async fn update(&self, req: &ApprovalRequest) -> Result<()> {
        let json = serde_json::to_string(req).context("serializing approval")?;
        let now = chrono::Utc::now().to_rfc3339();
        {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE approvals SET json = ?2, status = ?3, updated_at = ?4 WHERE id = ?1",
                params![req.id, json, req.status.as_str(), now],
            )
            .context("updating approval")?;
        }
        self.broadcast(ApprovalEvent::Decided {
            request: req.clone(),
        });
        Ok(())
    }

    /// **Atomically** transition a row out of `Pending` to `req.status`, writing
    /// `req` as the row's JSON. The `WHERE ... AND status = 'pending'` guard is a
    /// compare-and-swap: exactly one of N concurrent deciders sees a row changed
    /// (`Ok(true)`); the rest see `Ok(false)` and must NOT run side effects. This
    /// closes the read-check-then-write TOCTOU where a double-approve could
    /// double-execute the approved action. Broadcasts `Decided` only on success.
    pub async fn try_transition(&self, req: &ApprovalRequest) -> Result<bool> {
        let json = serde_json::to_string(req).context("serializing approval")?;
        let now = chrono::Utc::now().to_rfc3339();
        let changed = {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE approvals SET json = ?2, status = ?3, updated_at = ?4
                 WHERE id = ?1 AND status = 'pending'",
                params![req.id, json, req.status.as_str(), now],
            )
            .context("transitioning approval")?
        };
        if changed == 1 {
            self.broadcast(ApprovalEvent::Decided {
                request: req.clone(),
            });
        }
        Ok(changed == 1)
    }

    /// Fetch a request by id.
    pub async fn get(&self, id: &str) -> Result<Option<ApprovalRequest>> {
        let conn = self.conn.lock().await;
        let json = conn
            .query_row(
                "SELECT json FROM approvals WHERE id = ?1",
                params![id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .context("reading approval")?;
        match json {
            Some(j) => Ok(Some(
                serde_json::from_str(&j).context("deserializing approval")?,
            )),
            None => Ok(None),
        }
    }

    /// List requests, newest first. When `status` is set, filter to that status.
    pub async fn list(&self, status: Option<ApprovalStatus>) -> Result<Vec<ApprovalRequest>> {
        let conn = self.conn.lock().await;
        let mut out = Vec::new();
        match status {
            Some(s) => {
                let mut stmt = conn.prepare(
                    "SELECT json FROM approvals WHERE status = ?1 ORDER BY created_at DESC",
                )?;
                let rows = stmt.query_map(params![s.as_str()], |row| row.get::<_, String>(0))?;
                for row in rows {
                    if let Ok(req) = serde_json::from_str::<ApprovalRequest>(&row?) {
                        out.push(req);
                    }
                }
            }
            None => {
                let mut stmt =
                    conn.prepare("SELECT json FROM approvals ORDER BY created_at DESC")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                for row in rows {
                    if let Ok(req) = serde_json::from_str::<ApprovalRequest>(&row?) {
                        out.push(req);
                    }
                }
            }
        }
        Ok(out)
    }

    /// Whether a Pending request already exists for `source_ref`. Used to avoid
    /// piling up a fresh approval on every scheduler tick for the same job.
    pub async fn has_pending_for_source(&self, source_ref: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM approvals WHERE source_ref = ?1 AND status = 'pending'",
                params![source_ref],
                |row| row.get(0),
            )
            .context("counting pending approvals for source")?;
        Ok(n > 0)
    }

    /// All currently-pending requests whose `expires_at` is at or before `now`.
    /// The sweep uses this to expire stale requests.
    pub async fn pending_expired(&self, now: &str) -> Result<Vec<ApprovalRequest>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT json FROM approvals WHERE status = 'pending'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            if let Ok(req) = serde_json::from_str::<ApprovalRequest>(&row?) {
                if req.expires_at.as_deref().is_some_and(|exp| exp <= now) {
                    out.push(req);
                }
            }
        }
        Ok(out)
    }

    /// Broadcast an approval event to SSE subscribers.
    pub fn broadcast(&self, event: ApprovalEvent) {
        // A send error just means no live SSE subscribers — not a failure.
        let _ = self.tx.send(event);
    }

    /// Subscribe to live approval events (the SSE endpoint + island).
    pub fn subscribe(&self) -> broadcast::Receiver<ApprovalEvent> {
        self.tx.subscribe()
    }
}
