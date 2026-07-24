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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::{ApprovalKind, ApprovalStatus};

    /// Build a bare pending request with an explicit id / source / expiry so the
    /// store's filters and sweeps have deterministic inputs.
    fn req(id: &str, source: Option<&str>, expires_at: Option<&str>) -> ApprovalRequest {
        ApprovalRequest {
            id: id.to_owned(),
            kind: ApprovalKind::ScheduledRun,
            title: "t".to_owned(),
            summary: "s".to_owned(),
            agent_id: None,
            conversation_id: None,
            source_ref: source.map(str::to_owned),
            risk_tags: Vec::new(),
            status: ApprovalStatus::Pending,
            note: None,
            error: None,
            result: None,
            action: None,
            created_at: "2026-01-01T00:00:00Z".to_owned(),
            decided_at: None,
            expires_at: expires_at.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn insert_get_round_trips_the_full_request() {
        let store = ApprovalStore::open_in_memory().unwrap();
        store.insert(&req("a1", Some("job:1"), None)).await.unwrap();
        let got = store.get("a1").await.unwrap().expect("row present");
        assert_eq!(got.id, "a1");
        assert_eq!(got.source_ref.as_deref(), Some("job:1"));
        // A missing id resolves to None, not an error.
        assert!(store.get("nope").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn list_filters_by_status_and_orders_newest_first() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let mut older = req("old", None, None);
        older.created_at = "2026-01-01T00:00:00Z".to_owned();
        let mut newer = req("new", None, None);
        newer.created_at = "2026-06-01T00:00:00Z".to_owned();
        store.insert(&older).await.unwrap();
        store.insert(&newer).await.unwrap();

        // Unfiltered list: both, newest first.
        let all = store.list(None).await.unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "new");

        // Approve one and confirm the status filter isolates it.
        let mut approved = newer.clone();
        approved.status = ApprovalStatus::Approved;
        store.update(&approved).await.unwrap();
        let pending = store.list(Some(ApprovalStatus::Pending)).await.unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, "old");
        let done = store.list(Some(ApprovalStatus::Approved)).await.unwrap();
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].id, "new");
    }

    #[tokio::test]
    async fn has_pending_for_source_tracks_only_pending_rows() {
        let store = ApprovalStore::open_in_memory().unwrap();
        store.insert(&req("s1", Some("src:x"), None)).await.unwrap();
        assert!(store.has_pending_for_source("src:x").await.unwrap());
        assert!(!store.has_pending_for_source("src:other").await.unwrap());

        // Decide it → no longer counts as pending for the source.
        let mut decided = req("s1", Some("src:x"), None);
        decided.status = ApprovalStatus::Rejected;
        assert!(store.try_transition(&decided).await.unwrap());
        assert!(!store.has_pending_for_source("src:x").await.unwrap());
    }

    #[tokio::test]
    async fn try_transition_only_fires_from_pending() {
        let store = ApprovalStore::open_in_memory().unwrap();
        store.insert(&req("t1", None, None)).await.unwrap();
        let mut approved = req("t1", None, None);
        approved.status = ApprovalStatus::Approved;
        // First transition wins.
        assert!(store.try_transition(&approved).await.unwrap());
        // Second (row already non-pending) is a no-op.
        assert!(!store.try_transition(&approved).await.unwrap());
    }

    #[tokio::test]
    async fn pending_expired_returns_only_stale_pending_rows() {
        let store = ApprovalStore::open_in_memory().unwrap();
        // Expired in the past.
        store
            .insert(&req("past", None, Some("2020-01-01T00:00:00Z")))
            .await
            .unwrap();
        // Expires in the far future.
        store
            .insert(&req("future", None, Some("2999-01-01T00:00:00Z")))
            .await
            .unwrap();
        // No expiry at all → never swept.
        store.insert(&req("never", None, None)).await.unwrap();

        let now = "2026-01-01T00:00:00Z";
        let stale = store.pending_expired(now).await.unwrap();
        let ids: Vec<&str> = stale.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["past"]);
    }

    #[tokio::test]
    async fn insert_broadcasts_a_created_event_to_subscribers() {
        let store = ApprovalStore::open_in_memory().unwrap();
        let mut rx = store.subscribe();
        store.insert(&req("b1", None, None)).await.unwrap();
        match rx.try_recv() {
            Ok(ApprovalEvent::Created { request }) => assert_eq!(request.id, "b1"),
            other => panic!("expected a Created event, got {other:?}"),
        }
    }
}
