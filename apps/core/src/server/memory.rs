//! Two-tier memory for chat (spec unit U11).
//!
//! Ryu assembles two kinds of context for each chat request:
//!
//! * **Short-term memory** — the recent turns of the *current* conversation.
//!   This is derived directly from U10's conversation store
//!   (`ConversationStore::get_recent_messages`) and assembled into a prompt
//!   prefix. It needs no separate storage.
//! * **Long-term memory** — durable facts carried *across* conversations for a
//!   given user/agent. This is **opt-in** per the privacy-by-default principle:
//!   nothing is recorded or recalled unless the request explicitly enables it.
//!
//! Placement rationale (Core vs Gateway, see CLAUDE.md §1): memory is part of
//! *what runs* (orchestration / session state), not *what is allowed, shared,
//! measured, or paid for*, so it belongs in Core alongside the conversation
//! store from U10.
//!
//! Long-term entries are stored **encrypted-at-rest** with ChaCha20-Poly1305 via
//! the shared [`crate::crypto`] master key (resolved from env → OS keychain →
//! file fallback, see `docs/encryption-at-rest.md`). The key thus lives *outside*
//! the data directory where a keychain is available; an existing `~/.ryu/memory.key`
//! is imported as the master key on first run, so prior entries keep decrypting.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Default number of recent turns assembled as short-term context.
pub const DEFAULT_SHORT_TERM_LIMIT: usize = 10;
/// Default number of long-term entries recalled per request.
pub const DEFAULT_LONG_TERM_LIMIT: usize = 5;
/// Sentinel user id used while Core is local-first/single-user.
///
/// `AuthState` only carries a device token, not a stable user id, so long-term
/// memory is scoped by `(LOCAL_USER, agent_id)`. When a real user identity is
/// introduced this constant becomes the request's user id.
pub const LOCAL_USER: &str = "local";

/// A persisted long-term memory entry (decrypted form).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LongTermEntry {
    pub id: String,
    pub content: String,
    /// Unix milliseconds.
    pub created_at: i64,
}

/// SQLite-backed long-term memory store. Cheap to clone (wraps `Arc`s).
///
/// Reuses the same on-disk database as the conversation store (a new table),
/// so there is a single `~/.ryu` database file.
#[derive(Clone)]
pub struct MemoryStore {
    conn: Arc<Mutex<Connection>>,
    cipher: crate::crypto::FieldCipher,
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn default_db_path() -> PathBuf {
    crate::paths::ryu_dir().join("conversations.db")
}

impl MemoryStore {
    /// Open (or create) the long-term memory store at the default path, using the
    /// shared at-rest master key.
    pub fn open_default() -> Result<Self> {
        Self::open(default_db_path())
    }

    /// Open (or create) the store at a specific db path. Encryption uses the
    /// shared [`crate::crypto`] master key.
    pub fn open(db_path: PathBuf) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&db_path)
            .with_context(|| format!("opening memory db {}", db_path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::global_cipher()?,
        })
    }

    /// Open an in-memory store with an ephemeral key (used by tests). Never
    /// touches the real keychain or `~/.ryu`.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().context("opening in-memory db")?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            cipher: crate::crypto::FieldCipher::new(&[0x22; 32]),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS memory_entries (
                 id          TEXT PRIMARY KEY,
                 user_id     TEXT NOT NULL,
                 agent_id    TEXT NOT NULL,
                 nonce       BLOB NOT NULL,
                 ciphertext  BLOB NOT NULL,
                 created_at  INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_memory_scope
                 ON memory_entries(user_id, agent_id, created_at);",
        )
        .context("initializing memory schema")?;
        Ok(())
    }

    /// Record a long-term memory entry for `(user_id, agent_id)`. Content is
    /// encrypted before it touches disk. Empty content is ignored.
    pub async fn record(
        &self,
        user_id: &str,
        agent_id: &str,
        content: &str,
    ) -> Result<Option<String>> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        let (nonce, ciphertext) = self.encrypt(trimmed.as_bytes())?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_entries (id, user_id, agent_id, nonce, ciphertext, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, user_id, agent_id, nonce, ciphertext, now],
        )
        .context("inserting memory entry")?;
        Ok(Some(id))
    }

    /// Recall the most recent `limit` long-term entries for `(user_id, agent_id)`,
    /// newest first. Decrypts each entry; rows that fail to decrypt are skipped.
    ///
    /// Recall is recency-based; semantic/vector recall is M4 (out of scope here).
    pub async fn recall(
        &self,
        user_id: &str,
        agent_id: &str,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at
                 FROM memory_entries
                 WHERE user_id = ?1 AND agent_id = ?2
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?3",
            )?;
            let mapped = stmt.query_map(params![user_id, agent_id, limit as i64], |row| {
                let id: String = row.get(0)?;
                let nonce: Vec<u8> = row.get(1)?;
                let ciphertext: Vec<u8> = row.get(2)?;
                let created_at: i64 = row.get(3)?;
                Ok((id, nonce, ciphertext, created_at))
            })?;
            let mut collected = Vec::new();
            for row in mapped {
                collected.push(row?);
            }
            collected
        };

        let mut out = Vec::new();
        for (id, nonce, ciphertext, created_at) in rows {
            match self.decrypt(&nonce, &ciphertext) {
                Ok(plain) => out.push(LongTermEntry {
                    id,
                    content: String::from_utf8_lossy(&plain).into_owned(),
                    created_at,
                }),
                Err(e) => tracing::warn!("skipping undecryptable memory entry {id}: {e}"),
            }
        }
        Ok(out)
    }

    /// Total number of stored long-term memory entries across every scope.
    /// Backs the danger-zone count preview.
    pub async fn count(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }

    /// Delete **every** long-term memory entry (all users/agents). Single-tenant
    /// today (`LOCAL_USER`), so this is the "forget everything" wipe. Returns the
    /// number of rows removed. The encryption key is untouched, so new memories
    /// recorded afterward stay readable.
    pub async fn clear_all(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM memory_entries", [])?;
        Ok(removed as u64)
    }

    fn encrypt(&self, plaintext: &[u8]) -> Result<(Vec<u8>, Vec<u8>)> {
        self.cipher.encrypt(plaintext)
    }

    fn decrypt(&self, nonce: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>> {
        self.cipher.decrypt(nonce, ciphertext)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn record_and_recall_round_trips() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "default", "User prefers dark mode")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "default", "User is based in Singapore")
            .await
            .unwrap();

        let recalled = store.recall(LOCAL_USER, "default", 10).await.unwrap();
        assert_eq!(recalled.len(), 2);
        // Newest first.
        assert_eq!(recalled[0].content, "User is based in Singapore");
        assert_eq!(recalled[1].content, "User prefers dark mode");
    }

    #[tokio::test]
    async fn recall_is_scoped_by_agent() {
        let store = MemoryStore::open_in_memory().unwrap();
        store
            .record(LOCAL_USER, "agent-a", "fact for a")
            .await
            .unwrap();
        store
            .record(LOCAL_USER, "agent-b", "fact for b")
            .await
            .unwrap();

        let a = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].content, "fact for a");

        let none = store.recall(LOCAL_USER, "agent-c", 10).await.unwrap();
        assert!(none.is_empty());
    }

    #[tokio::test]
    async fn clear_all_forgets_every_entry() {
        let store = MemoryStore::open_in_memory().unwrap();
        store.record(LOCAL_USER, "agent-a", "fact a").await.unwrap();
        store.record(LOCAL_USER, "agent-b", "fact b").await.unwrap();
        assert_eq!(store.count().await.unwrap(), 2);

        let removed = store.clear_all().await.unwrap();
        assert_eq!(removed, 2);
        assert_eq!(store.count().await.unwrap(), 0);
        // The key is intact, so new memories still record + recall afterward.
        store.record(LOCAL_USER, "agent-a", "fresh").await.unwrap();
        let recalled = store.recall(LOCAL_USER, "agent-a", 10).await.unwrap();
        assert_eq!(recalled.len(), 1);
        assert_eq!(recalled[0].content, "fresh");
    }

    #[tokio::test]
    async fn empty_content_is_not_recorded() {
        let store = MemoryStore::open_in_memory().unwrap();
        assert!(store
            .record(LOCAL_USER, "default", "   ")
            .await
            .unwrap()
            .is_none());
        assert!(store
            .recall(LOCAL_USER, "default", 10)
            .await
            .unwrap()
            .is_empty());
    }

    #[test]
    fn stored_ciphertext_is_not_plaintext() {
        // The encrypt step must not leave the content readable.
        let store = MemoryStore::open_in_memory().unwrap();
        let secret = b"super secret memory";
        let (nonce, ciphertext) = store.encrypt(secret).unwrap();
        assert_ne!(ciphertext.as_slice(), secret);
        let decrypted = store.decrypt(&nonce, &ciphertext).unwrap();
        assert_eq!(decrypted, secret);
    }
}
