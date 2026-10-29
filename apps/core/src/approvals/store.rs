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
//!
//! Encryption at rest: `json` (tool arguments, prompts, message text, results,
//! notes) is sealed per row as `encb:v1:` under the `approvals.db` content key,
//! bound to the row `id`. `status`, `source_ref` and the timestamps stay
//! plaintext for the indexes, dedup and prune. Legacy rows are sealed on open.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

use super::{ApprovalEvent, ApprovalRequest, ApprovalStatus};
use crate::activity::sealed_store::{core_cipher, StoreSeal};

/// Registered store name (content-key input; never rename).
const STORE: &str = "approvals.db";
const JSON_PURPOSE: &str = "approvals.json";

fn json_context(id: &str) -> ContentContext {
    ContentContext::for_id(JSON_PURPOSE, id)
}

fn column_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![ColumnPlan::text(
        "approvals",
        "json",
        "id",
        KeyKind::Text,
    )?])
}

fn default_db_path() -> PathBuf {
    crate::paths::db_path("approvals.db")
}

/// Deletes decided rows last updated before `?1`; seeks `idx_approvals_updated`.
const PRUNE_DECIDED_SQL: &str =
    "DELETE FROM approvals WHERE status != 'pending' AND updated_at < ?1";

/// Most decided (non-pending) rows one list returns. Pending rows are never
/// capped: they are what the inbox, island chip and push flow act on.
pub const LIST_HISTORY_LIMIT: i64 = 200;

/// SQLite-backed approval store. Cheap to clone (wraps `Arc`s).
#[derive(Clone)]
pub struct ApprovalStore {
    conn: Arc<Mutex<Connection>>,
    tx: broadcast::Sender<ApprovalEvent>,
    seal: StoreSeal,
}

impl ApprovalStore {
    /// Open (or create) the store at the default path (`~/.ryu/approvals.db`).
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) an in-memory store for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let mut conn = Connection::open_in_memory().context("opening in-memory approvals db")?;
        Self::init_schema(&conn)?;
        let seal = StoreSeal::prepare(&mut conn, None, core_cipher(STORE)?, &column_plans()?)?;
        Ok(Self::from_parts(conn, seal))
    }

    /// Open (or create) the store at a specific path and run migrations.
    pub fn open(path: PathBuf) -> Result<Self> {
        Self::open_with_cipher(path, core_cipher(STORE)?)
    }

    /// [`Self::open`] under an explicit content cipher (tests).
    pub fn open_with_cipher(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening approvals db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let seal = StoreSeal::prepare(&mut conn, Some(Path::new(&path)), cipher, &column_plans()?)
            .context("sealing the approvals store")?;
        let store = Self::from_parts(conn, seal);
        store
            .seal
            .defer_compaction(&store.conn, Some(Path::new(&path)));
        Ok(store)
    }

    fn from_parts(conn: Connection, seal: StoreSeal) -> Self {
        let (tx, _rx) = broadcast::channel(128);
        Self {
            conn: Arc::new(Mutex::new(conn)),
            tx,
            seal,
        }
    }

    /// Rows list reads skipped because they did not open (since open).
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    fn seal_request(&self, req: &ApprovalRequest) -> Result<String> {
        let json = serde_json::to_string(req).context("serializing approval")?;
        self.seal.seal(&json, &json_context(&req.id))
    }

    /// Open and parse `(id, json)` rows, skipping (and counting) rows that do
    /// not open or no longer match the current shape.
    fn decode_rows(&self, rows: Vec<(String, String)>) -> Vec<ApprovalRequest> {
        let mut out = Vec::with_capacity(rows.len());
        let mut skipped = 0u64;
        for (id, stored) in rows {
            match self.seal.open(&stored, &json_context(&id)) {
                Ok(json) => {
                    // A legacy shape mismatch is not an unreadable row.
                    if let Ok(req) = serde_json::from_str::<ApprovalRequest>(&json) {
                        out.push(req);
                    }
                }
                Err(_) => skipped += 1,
            }
        }
        self.seal.count_unreadable(skipped);
        out
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
                 ON approvals(source_ref, status);
             -- The 60 s history prune seeks old rows by decision time instead
             -- of scanning every row's JSON under the store lock.
             CREATE INDEX IF NOT EXISTS idx_approvals_updated
                 ON approvals(updated_at);",
        )
        .context("initializing approvals schema")?;
        Ok(())
    }

    /// Insert a new approval request, then broadcast a `Created` event.
    pub async fn insert(&self, req: &ApprovalRequest) -> Result<()> {
        let json = self.seal_request(req)?;
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
        let json = self.seal_request(req)?;
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
        let json = self.seal_request(req)?;
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
            Some(stored) => {
                let j = self.seal.open(&stored, &json_context(id))?;
                Ok(Some(
                    serde_json::from_str(&j).context("deserializing approval")?,
                ))
            }
            None => Ok(None),
        }
    }

    /// List requests, newest first. When `status` is set, filter to that status.
    /// Every pending row is returned; decided rows are capped at the newest
    /// [`LIST_HISTORY_LIMIT`].
    pub async fn list(&self, status: Option<ApprovalStatus>) -> Result<Vec<ApprovalRequest>> {
        let rows = {
            let conn = self.conn.lock().await;
            match status {
                Some(ApprovalStatus::Pending) => json_rows(
                    &conn,
                    "SELECT id, json FROM approvals WHERE status = 'pending'
                     ORDER BY created_at DESC",
                    [],
                )?,
                Some(s) => json_rows(
                    &conn,
                    "SELECT id, json FROM approvals WHERE status = ?1
                     ORDER BY created_at DESC LIMIT ?2",
                    params![s.as_str(), LIST_HISTORY_LIMIT],
                )?,
                None => json_rows(
                    &conn,
                    "SELECT id, json FROM approvals
                     WHERE status = 'pending'
                        OR id IN (SELECT id FROM approvals WHERE status != 'pending'
                                  ORDER BY created_at DESC LIMIT ?1)
                     ORDER BY created_at DESC",
                    params![LIST_HISTORY_LIMIT],
                )?,
            }
        };
        Ok(self.decode_rows(rows))
    }

    /// Delete decided (non-pending) rows last updated before `cutoff`
    /// (RFC 3339, the same format every write stamps into `updated_at`).
    /// Keyed on the decision time, not creation, so a request that sat pending
    /// for weeks is not removed the moment it is decided. Pending rows are never
    /// pruned. Returns the number of rows removed.
    pub async fn prune_decided_before(&self, cutoff: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        conn.execute(PRUNE_DECIDED_SQL, params![cutoff])
            .context("pruning decided approvals")
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
        let rows = {
            let conn = self.conn.lock().await;
            json_rows(
                &conn,
                "SELECT id, json FROM approvals WHERE status = 'pending'",
                [],
            )?
        };
        Ok(self
            .decode_rows(rows)
            .into_iter()
            .filter(|req| req.expires_at.as_deref().is_some_and(|exp| exp <= now))
            .collect())
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

/// Run a `SELECT id, json …` query and return the raw (sealed) rows; the store
/// opens and decodes them outside the connection lock.
fn json_rows<P: rusqlite::Params>(
    conn: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map(params, |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
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
            question: None,
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

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[11u8; 32], STORE)
    }

    fn file_contains(path: &Path, needle: &str) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
            .unwrap_or(false)
    }

    fn raw_json(path: &Path, id: &str) -> String {
        Connection::open(path)
            .unwrap()
            .query_row(
                "SELECT json FROM approvals WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[tokio::test]
    async fn requests_are_sealed_on_disk_through_every_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("approvals.db");
        let store = ApprovalStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        let mut row = req("s1", Some("src:1"), None);
        row.summary = "wire-transfer-marker".to_owned();
        store.insert(&row).await.unwrap();
        row.note = Some("reviewer-note-marker".to_owned());
        row.status = ApprovalStatus::Approved;
        assert!(store.try_transition(&row).await.unwrap());
        row.result = Some("tool-result-marker".to_owned());
        store.update(&row).await.unwrap();

        assert!(raw_json(&path, "s1").starts_with("encb:v1:"));
        for file in [path.clone(), dir.path().join("approvals.db-wal")] {
            for marker in [
                "wire-transfer-marker",
                "reviewer-note-marker",
                "tool-result-marker",
            ] {
                assert!(
                    !file_contains(&file, marker),
                    "{marker} in {}",
                    file.display()
                );
            }
        }
        let got = store.get("s1").await.unwrap().unwrap();
        assert_eq!(got.summary, "wire-transfer-marker");
        assert_eq!(got.note.as_deref(), Some("reviewer-note-marker"));
        assert_eq!(
            store
                .list(Some(ApprovalStatus::Approved))
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn legacy_rows_are_sealed_once_and_still_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("approvals.db");
        let mut legacy = req("old", None, Some("2020-01-01T00:00:00Z"));
        legacy.summary = "legacy-summary-marker".to_owned();
        {
            let conn = Connection::open(&path).unwrap();
            ApprovalStore::init_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO approvals (id, json, status, source_ref, created_at, updated_at)
                 VALUES ('old', ?1, 'pending', NULL, ?2, ?2)",
                params![serde_json::to_string(&legacy).unwrap(), legacy.created_at],
            )
            .unwrap();
        }
        let store = ApprovalStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        assert_eq!(
            store.get("old").await.unwrap().unwrap().summary,
            "legacy-summary-marker"
        );
        assert_eq!(
            store
                .pending_expired("2026-01-01T00:00:00Z")
                .await
                .unwrap()
                .len(),
            1
        );
        let sealed = raw_json(&path, "old");
        assert!(sealed.starts_with("encb:v1:"));
        drop(store);
        for file in [path.clone(), dir.path().join("approvals.db-wal")] {
            assert!(!file_contains(&file, "legacy-summary-marker"));
        }
        let _store = ApprovalStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        assert_eq!(raw_json(&path, "old"), sealed, "second open is a no-op");
        let conn = Connection::open(&path).unwrap();
        ryu_crypto::content_sqlite::assert_all_open(
            &conn,
            &test_cipher(),
            &column_plans().unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn a_request_copied_to_another_row_does_not_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("approvals.db");
        let store = ApprovalStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        store.insert(&req("a", None, None)).await.unwrap();
        store.insert(&req("b", None, None)).await.unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE approvals SET json = (SELECT json FROM approvals WHERE id = 'a')
                 WHERE id = 'b'",
                [],
            )
            .unwrap();
        }
        // Get by id is an error, never an empty result.
        assert!(store.get("b").await.is_err());
        // Lists skip the row and count it.
        let listed = store.list(None).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "a");
        assert_eq!(store.unreadable_rows(), 1);
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
    async fn list_unfiltered_keeps_every_pending_row_and_caps_history() {
        let store = ApprovalStore::open_in_memory().unwrap();
        // Old pending rows sort below all history but must still be returned.
        for index in 0..3 {
            let mut pending = req(&format!("pending-{index}"), None, None);
            pending.created_at = format!("2020-01-0{}T00:00:00Z", index + 1);
            store.insert(&pending).await.unwrap();
        }
        let decided = usize::try_from(LIST_HISTORY_LIMIT).unwrap() + 5;
        for index in 0..decided {
            let mut row = req(&format!("done-{index:04}"), None, None);
            row.created_at = format!("2026-01-01T00:{:02}:{:02}Z", index / 60, index % 60);
            store.insert(&row).await.unwrap();
            row.status = ApprovalStatus::Approved;
            store.update(&row).await.unwrap();
        }

        let listed = store.list(None).await.unwrap();
        let ids: Vec<&str> = listed.iter().map(|row| row.id.as_str()).collect();
        for index in 0..3 {
            assert!(ids.contains(&format!("pending-{index}").as_str()));
        }
        let history = listed
            .iter()
            .filter(|row| row.status != ApprovalStatus::Pending)
            .count();
        assert_eq!(history, usize::try_from(LIST_HISTORY_LIMIT).unwrap());
        for index in 0..5 {
            assert!(!ids.contains(&format!("done-{index:04}").as_str()));
        }
        assert_eq!(ids[0], format!("done-{:04}", decided - 1));
        assert!(listed
            .windows(2)
            .all(|pair| pair[0].created_at >= pair[1].created_at));
        assert_eq!(
            store
                .list(Some(ApprovalStatus::Approved))
                .await
                .unwrap()
                .len(),
            usize::try_from(LIST_HISTORY_LIMIT).unwrap()
        );
    }

    #[tokio::test]
    async fn prune_decided_before_removes_only_old_decided_rows() {
        let store = ApprovalStore::open_in_memory().unwrap();
        store.insert(&req("old-pending", None, None)).await.unwrap();
        for id in ["old-approved", "recent-approved"] {
            let mut row = req(id, None, None);
            store.insert(&row).await.unwrap();
            row.status = ApprovalStatus::Approved;
            store.update(&row).await.unwrap();
        }
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE approvals SET updated_at = '2020-01-01T00:00:00+00:00'
                 WHERE id IN ('old-pending', 'old-approved')",
                [],
            )
            .unwrap();
            // The every-minute prune must seek by decision time, not scan.
            let mut plan = conn
                .prepare(&format!("EXPLAIN QUERY PLAN {PRUNE_DECIDED_SQL}"))
                .unwrap();
            let details: Vec<String> = plan
                .query_map(params!["2025-01-01"], |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            assert!(
                details
                    .iter()
                    .any(|detail| detail.contains("idx_approvals_updated")),
                "{details:?}"
            );
        }

        let removed = store
            .prune_decided_before("2025-01-01T00:00:00+00:00")
            .await
            .unwrap();
        assert_eq!(removed, 1);
        assert!(store.get("old-approved").await.unwrap().is_none());
        assert!(store.get("old-pending").await.unwrap().is_some());
        assert!(store.get("recent-approved").await.unwrap().is_some());
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
