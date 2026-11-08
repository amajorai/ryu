//! The [`MemoryStore`] handle: opening the database, the bind-time owner
//! backfill, and the field cipher it holds.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use tokio::sync::Mutex;

use crate::LOCAL_USER;

/// SQLite-backed long-term memory store. Cheap to clone (wraps `Arc`s).
///
/// Reuses the same on-disk database as the conversation store (a new table),
/// so there is a single `~/.ryu` database file.
#[derive(Clone)]
pub struct MemoryStore {
    pub(crate) conn: Arc<Mutex<Connection>>,
    pub(crate) cipher: ryu_crypto::FieldCipher,
}

impl MemoryStore {
    /// Open (or create) the store at a specific db path. Encryption uses the
    /// shared [`ryu_crypto`] master key.
    ///
    /// The bind-time owner backfill's two Core couplings are injected: `node_bound`
    /// is whether this node is registered to an org (resolved by the Core host from
    /// the control plane), and `owner` is the signed-in local account's user id (from
    /// the account vault). The default-path + resolution wiring lives in
    /// `apps/core/src/memory_host.rs`.
    pub fn open(db_path: PathBuf, node_bound: bool, owner: Option<&str>) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&db_path)
            .with_context(|| format!("opening memory db {}", db_path.display()))?;
        Self::init_schema(&conn)?;
        // One-shot owner backfill: pre-ACL memory rows carry `user_id = 'local'`.
        // Best-effort; never blocks opening the store. Deliberately NOT in
        // `init_schema` (the in-memory test store runs that and must never run the
        // backfill).
        if let Err(e) = Self::backfill_owner(&conn, node_bound, owner) {
            tracing::warn!("memory owner backfill skipped: {e:#}");
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::global_cipher()?,
        })
    }

    /// Attribute pre-ACL `user_id = 'local'` memory rows to the local owner once the
    /// node binds — the memory twin of `ConversationStore::backfill_tenancy`. Note
    /// the transition is `'local' → owner` (memory's single-user sentinel), NOT
    /// `NULL → owner` (memory's `user_id` is NOT NULL).
    ///
    ///   - **Node UNBOUND**: return immediately (no marker). One principal; the node
    ///     token is the boundary — the `'local'` rows stay as they are, and
    ///     `MEMORY_VISIBLE_PREDICATE` (`:bound = 0`) shows them all. Reruns if the
    ///     node later joins an org.
    ///   - **Node ORG-BOUND**: `UPDATE memory_entries SET user_id = <owner> WHERE
    ///     user_id = 'local'`, so the owner keeps recalling their own facts (else a
    ///     `user`-scope `'local'` row matches no real caller → lockout). Idempotent
    ///     via a `memory_meta` marker.
    ///   - **Node ORG-BOUND with no local account**: leave them + warn. Fail closed.
    ///
    /// `node_bound` (org-registration presence) and `owner` (the signed-in local
    /// account id) are resolved Core-side and injected — the control-plane and
    /// account-vault reads live in `apps/core/src/memory_host.rs`, keeping this
    /// crate free of any `apps/core` dependency.
    fn backfill_owner(conn: &Connection, node_bound: bool, owner: Option<&str>) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS memory_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating memory_meta")?;
        let done: Option<String> = {
            let mut stmt =
                conn.prepare("SELECT value FROM memory_meta WHERE key = 'owner_backfill_v1'")?;
            let mut rows = stmt.query([])?;
            match rows.next()? {
                Some(r) => Some(r.get(0)?),
                None => None,
            }
        };
        if done.is_some() {
            return Ok(());
        }
        if !node_bound {
            // Node UNBOUND: one principal; the node token is the boundary. Leave the
            // 'local' rows as-is (reruns if the node later joins an org).
            return Ok(());
        }
        let Some(owner) = owner else {
            tracing::warn!(
                "memory owner backfill: org-bound node with no signed-in local account — \
                 leaving pre-ACL 'local' memory rows unattributed (fail closed)."
            );
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE memory_entries SET user_id = ?1 WHERE user_id = ?2",
                params![owner, LOCAL_USER],
            )
            .context("backfilling memory owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO memory_meta (key, value) VALUES ('owner_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!("memory owner backfill: attributed {claimed} pre-ACL memory row(s)");
        Ok(())
    }

    /// Open an in-memory store with an ephemeral key (used by tests and by Core's
    /// in-memory adapter tests). Never touches the real keychain or `~/.ryu`, and
    /// never runs the owner backfill.
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: ryu_crypto::FieldCipher::new(&[0x22; 32]),
        })
    }
}
