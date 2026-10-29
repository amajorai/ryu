//! Durable, revisioned primary-bot selection per verified principal.
//!
//! The selection owns its own SQLite file (`primary-bot.db` in Core's database
//! directory), like other single-purpose Core stores. Absence reads as revision
//! zero; clearing keeps a revisioned tombstone so a stale client can never
//! resurrect a cleared choice. Nothing here is broadcast: clients re-read the
//! HTTP readback, so no principal or bot id reaches a shared event stream.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tokio::sync::Mutex;

/// Largest revision a JavaScript client can carry exactly (`Number.MAX_SAFE_INTEGER`).
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone)]
pub struct SelectionStore {
    conn: Arc<Mutex<Connection>>,
}

fn default_db_path() -> PathBuf {
    crate::paths::db_path("primary-bot.db")
}

#[cfg(test)]
tokio::task_local! {
    static TEST_STORE: SelectionStore;
}

/// The node's selection store. Tests scope an isolated store with
/// [`with_test_store`]; production opens one process-wide handle, and a failed
/// open is not cached so a later request can still succeed.
pub fn current() -> Result<SelectionStore> {
    #[cfg(test)]
    if let Ok(store) = TEST_STORE.try_with(Clone::clone) {
        return Ok(store);
    }
    static GLOBAL: OnceLock<SelectionStore> = OnceLock::new();
    if let Some(store) = GLOBAL.get() {
        return Ok(store.clone());
    }
    let store = SelectionStore::open_at(default_db_path())?;
    Ok(GLOBAL.get_or_init(|| store).clone())
}

/// Run `future` against `store` instead of the process-wide selection store.
#[cfg(test)]
pub async fn with_test_store<T>(
    store: SelectionStore,
    future: impl std::future::Future<Output = T>,
) -> T {
    TEST_STORE.scope(store, future).await
}

impl SelectionStore {
    /// Open (or create) the store at `path`. The migration is additive and
    /// idempotent; older Core builds simply never read this file.
    pub fn open_at(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening primary bot db {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS principal_agent_selection (
                 principal TEXT PRIMARY KEY,
                 agent_id  TEXT,
                 revision  INTEGER NOT NULL CHECK(revision > 0)
             );",
        )
        .context("initializing primary bot schema")?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    /// The principal's configured bot (if any) and its revision.
    pub async fn read(&self, principal: &str) -> Result<(Option<String>, u64)> {
        let conn = self.conn.lock().await;
        let (agent_id, revision): (Option<String>, i64) = conn
            .query_row(
                "SELECT agent_id, revision FROM principal_agent_selection WHERE principal = ?1",
                [principal],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .unwrap_or((None, 0));
        Ok((
            agent_id,
            u64::try_from(revision).context("invalid primary selection revision")?,
        ))
    }

    /// Compare-and-set in one immediate SQLite transaction, so independent
    /// handles (and processes) serialize. Returns `false` on a stale revision.
    pub async fn compare_and_set(
        &self,
        principal: &str,
        agent_id: Option<&str>,
        expected: u64,
    ) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let revision: i64 = tx
            .query_row(
                "SELECT revision FROM principal_agent_selection WHERE principal = ?1",
                [principal],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0);
        if u64::try_from(revision).context("invalid primary selection revision")? != expected {
            return Ok(false);
        }
        let next = expected
            .checked_add(1)
            .filter(|next| *next <= MAX_REVISION)
            .context("primary selection revision exhausted")?;
        tx.execute(
            "INSERT INTO principal_agent_selection (principal, agent_id, revision)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(principal) DO UPDATE SET
                 agent_id = excluded.agent_id, revision = excluded.revision",
            params![principal, agent_id, i64::try_from(next)?],
        )?;
        tx.commit()?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn selection_survives_reopen_and_isolates_principals() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("primary-bot.db");
        let store = SelectionStore::open_at(path.clone()).unwrap();
        assert_eq!(store.read("user:alice").await.unwrap(), (None, 0));
        assert!(store
            .compare_and_set("user:alice", Some("scout"), 0)
            .await
            .unwrap());
        drop(store);
        let store = SelectionStore::open_at(path).unwrap();
        assert_eq!(
            store.read("user:alice").await.unwrap(),
            (Some("scout".into()), 1)
        );
        assert_eq!(store.read("user:bob").await.unwrap(), (None, 0));
        assert_eq!(store.read("node-operator").await.unwrap(), (None, 0));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn compare_and_set_serializes_independent_handles_and_keeps_clear_tombstone() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("primary-bot.db");
        let first = SelectionStore::open_at(path.clone()).unwrap();
        let second = SelectionStore::open_at(path).unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let (a_store, a_barrier) = (first.clone(), barrier.clone());
        let a = tokio::spawn(async move {
            a_barrier.wait().await;
            a_store.compare_and_set("user:alice", Some("a"), 0).await
        });
        let b_store = second.clone();
        let b = tokio::spawn(async move {
            barrier.wait().await;
            b_store.compare_and_set("user:alice", Some("b"), 0).await
        });
        let (a, b) = tokio::join!(a, b);
        assert_ne!(a.unwrap().unwrap(), b.unwrap().unwrap());
        assert_eq!(first.read("user:alice").await.unwrap().1, 1);
        assert!(second.compare_and_set("user:alice", None, 1).await.unwrap());
        assert_eq!(first.read("user:alice").await.unwrap(), (None, 2));
        // Neither the pre-clear revision nor the original one can resurrect it.
        assert!(!first
            .compare_and_set("user:alice", Some("stale"), 0)
            .await
            .unwrap());
        assert!(!first
            .compare_and_set("user:alice", Some("stale"), 1)
            .await
            .unwrap());
        assert!(first
            .compare_and_set("node-operator", Some("local"), 0)
            .await
            .unwrap());
        assert_eq!(first.read("user:alice").await.unwrap(), (None, 2));
    }

    #[tokio::test]
    async fn test_scope_overrides_the_process_store_only_inside_the_future() {
        let directory = tempfile::tempdir().unwrap();
        let store = SelectionStore::open_at(directory.path().join("scoped.db")).unwrap();
        with_test_store(store.clone(), async {
            let scoped = current().unwrap();
            assert!(scoped
                .compare_and_set("user:scoped-only", Some("scout"), 0)
                .await
                .unwrap());
        })
        .await;
        assert_eq!(
            store.read("user:scoped-only").await.unwrap(),
            (Some("scout".into()), 1)
        );
    }
}
