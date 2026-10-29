//! Persisted experience buffer (`<data dir>/db/experience.db`).
//!
//! The system-of-record for the MetaClaw-style continual-learning loop: one row
//! per captured (user, assistant) turn, optionally scored by a PRM judge. The
//! buffer is populated by *sweeping* the conversation store at cycle time (not on
//! the chat hot path) and is the dataset source for a reward-filtered LoRA
//! retrain. Mirrors the rusqlite store pattern used across the extracted crates.
//!
//! Design constraints (see `docs/continual-learning-metaclaw-spec.md`):
//! - Capture is consent-gated and per-conversation excludable upstream; this
//!   store only persists what the learning layer already decided to keep.
//! - `reward` stays `NULL` until a PRM scores the row; training filters on it.
//! - `base_model` records the model that produced the reply, for lineage — but a
//!   retrain always derives a *fresh* LoRA from the original base, never from a
//!   previous merge (avoids model collapse).
//!
//! Encryption at rest: `user_text` and `assistant_text` are sealed per row as
//! `encb:v1:` under the `experience.db` content key, each bound to the row `id`
//! and its column. Ids, conversation ids, rewards, outcomes and timestamps stay
//! plaintext (the work queues filter and order on them). Legacy plaintext rows
//! are sealed on open; reads skip and count a row that does not open.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::seal::{StoreSeal, STORE};

const USER_TEXT: &str = "experience.user_text";
const ASSISTANT_TEXT: &str = "experience.assistant_text";

fn column_plans() -> Result<Vec<ColumnPlan>> {
    Ok(vec![
        ColumnPlan::text("experience", "user_text", "id", KeyKind::Text)?,
        ColumnPlan::text("experience", "assistant_text", "id", KeyKind::Text)?,
    ])
}

/// One captured turn as the experience buffer records it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Experience {
    /// Stable row id. Derived from the assistant message id so a re-sweep is
    /// idempotent (insert-if-absent never duplicates or clobbers a reward).
    pub id: String,
    /// Conversation this turn belongs to.
    pub conversation_id: String,
    /// Agent that produced the reply (`None` for the default chat model).
    pub agent_id: Option<String>,
    /// The user prompt for this turn.
    pub user_text: String,
    /// The assistant reply for this turn.
    pub assistant_text: String,
    /// `completed` | `failed` — coarse turn outcome.
    pub outcome: String,
    /// PRM score in `[0.0, 1.0]`. `None` until judged.
    pub reward: Option<f64>,
    /// Model id that produced the reply, recorded for lineage.
    pub base_model: Option<String>,
    /// Skill-library generation this sample was captured under. When skill
    /// auto-evolution bumps the generation, stale samples can be flushed
    /// (MAML-style support/query separation, mirrors MetaClaw).
    pub skill_generation: i64,
    /// User-excluded from learning (per-conversation opt-out honored at sweep
    /// time; this is a belt-and-suspenders row-level flag).
    pub excluded: bool,
    pub created_at: String,
}

/// SQLite-backed buffer, safe to clone (shares one connection behind a mutex).
#[derive(Clone)]
pub struct ExperienceStore {
    conn: Arc<Mutex<Connection>>,
    seal: StoreSeal,
}

impl ExperienceStore {
    /// Open (creating if needed) the buffer at the default `<data_dir>/db/experience.db`.
    /// The data dir is resolved via [`crate::data_dir`] (`init_data_dir`), so the
    /// crate has ZERO dependency on Core's `paths` module.
    ///
    /// Also deletes datasets an older build left in `state/learning/` (plaintext
    /// copies of the buffer), once the buffer itself is sealed.
    pub fn open_default() -> Result<Self> {
        let data_dir = crate::data_dir();
        let store = Self::open(ryu_sidecar_runtime::layout::db_file(&data_dir, STORE))?;
        purge_legacy_datasets(&data_dir);
        Ok(store)
    }

    /// Open the buffer at `path`; the content key comes from the process's
    /// crypto host (Core's, or the standalone host the sidecar binary installs).
    /// Fails closed without a key.
    pub fn open(path: PathBuf) -> Result<Self> {
        let cipher =
            ryu_crypto::content_cipher(STORE).context("resolving the experience buffer key")?;
        Self::open_with_cipher(path, cipher)
    }

    /// [`Self::open`] under an explicit content cipher (tests, tools).
    pub fn open_with_cipher(path: PathBuf, cipher: ContentCipher) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let mut conn = Connection::open(&path)
            .with_context(|| format!("opening experience db {}", path.display()))?;
        Self::init_schema(&conn)?;
        let seal = StoreSeal::prepare(&mut conn, Some(Path::new(&path)), cipher, &column_plans()?)
            .context("sealing the experience buffer")?;
        let conn = Arc::new(Mutex::new(conn));
        seal.defer_compaction(&conn, Some(Path::new(&path)));
        Ok(Self { conn, seal })
    }

    /// Rows skipped by reads because a sealed value did not open (since open).
    pub fn unreadable_rows(&self) -> u64 {
        self.seal.unreadable()
    }

    /// Open the sealed texts of a row read from disk; `None` (counted and
    /// logged) when either does not open.
    fn reveal(&self, mut row: Experience) -> Option<Experience> {
        let user = self
            .seal
            .open(&row.user_text, &ContentContext::for_id(USER_TEXT, &row.id));
        let assistant = self
            .seal
            .open(&row.assistant_text, &ContentContext::for_id(ASSISTANT_TEXT, &row.id));
        match (user, assistant) {
            (Ok(user), Ok(assistant)) => {
                row.user_text = user;
                row.assistant_text = assistant;
                Some(row)
            }
            _ => {
                self.seal.count_unreadable(1);
                tracing::warn!(
                    store = STORE,
                    unreadable = self.seal.unreadable(),
                    "experience buffer skipped a row that does not open"
                );
                None
            }
        }
    }

    fn collect(&self, rows: impl Iterator<Item = rusqlite::Result<Experience>>) -> Result<Vec<Experience>> {
        let mut out = Vec::new();
        for row in rows {
            if let Some(row) = self.reveal(row?) {
                out.push(row);
            }
        }
        Ok(out)
    }

    fn collect_visible(
        &self,
        rows: impl Iterator<Item = rusqlite::Result<Experience>>,
        limit: usize,
        visible_conversation_ids: &HashSet<String>,
    ) -> Result<Vec<Experience>> {
        let mut visible = Vec::new();
        for row in rows {
            let row = row?;
            if !visible_conversation_ids.contains(&row.conversation_id) {
                continue;
            }
            if let Some(row) = self.reveal(row) {
                visible.push(row);
                if visible.len() >= limit {
                    break;
                }
            }
        }
        Ok(visible)
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS experience (
                 id               TEXT PRIMARY KEY,
                 conversation_id  TEXT NOT NULL,
                 agent_id         TEXT,
                 user_text        TEXT NOT NULL,
                 assistant_text   TEXT NOT NULL,
                 outcome          TEXT NOT NULL,
                 reward           REAL,
                 base_model       TEXT,
                 skill_generation INTEGER NOT NULL DEFAULT 0,
                 excluded         INTEGER NOT NULL DEFAULT 0,
                 created_at       TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_experience_created
                 ON experience(created_at DESC);
             CREATE INDEX IF NOT EXISTS idx_experience_reward
                 ON experience(reward);
             CREATE INDEX IF NOT EXISTS idx_experience_conversation
                 ON experience(conversation_id);",
        )
        .context("initializing experience schema")?;
        Ok(())
    }

    /// Insert a captured turn, leaving any existing row (and its reward) intact.
    /// Idempotent on `id`, so re-sweeping the same conversation is safe.
    /// Returns `true` when a new row was inserted.
    pub async fn record_if_absent(&self, exp: &Experience) -> Result<bool> {
        let user_text = self
            .seal
            .seal(&exp.user_text, &ContentContext::for_id(USER_TEXT, &exp.id))?;
        let assistant_text = self
            .seal
            .seal(&exp.assistant_text, &ContentContext::for_id(ASSISTANT_TEXT, &exp.id))?;
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "INSERT OR IGNORE INTO experience
                   (id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    exp.id,
                    exp.conversation_id,
                    exp.agent_id,
                    user_text,
                    assistant_text,
                    exp.outcome,
                    exp.reward,
                    exp.base_model,
                    exp.skill_generation,
                    exp.excluded as i64,
                    exp.created_at,
                ],
            )
            .context("inserting experience row")?;
        Ok(n > 0)
    }

    /// Attach a PRM score to a row.
    pub async fn set_reward(&self, id: &str, reward: f64) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE experience SET reward = ?2 WHERE id = ?1",
                params![id, reward],
            )
            .context("setting experience reward")?;
        Ok(n > 0)
    }

    /// Reset a row's reward to `NULL` (unscored). Used when a human clears a
    /// thumbs vote, so the row reverts to PRM-scorable rather than keeping a stale
    /// human label. No-op when the row is absent.
    pub async fn clear_reward(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE experience SET reward = NULL WHERE id = ?1",
                params![id],
            )
            .context("clearing experience reward")?;
        Ok(n > 0)
    }

    /// Mark every captured turn of a conversation excluded (per-conversation
    /// opt-out applied retroactively).
    pub async fn exclude_conversation(
        &self,
        conversation_id: &str,
        excluded: bool,
    ) -> Result<usize> {
        let conn = self.conn.lock().await;
        let n = conn
            .execute(
                "UPDATE experience SET excluded = ?2 WHERE conversation_id = ?1",
                params![conversation_id, excluded as i64],
            )
            .context("excluding conversation from experience")?;
        Ok(n)
    }

    /// Most recent rows first.
    pub async fn list(&self, limit: usize) -> Result<Vec<Experience>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at
             FROM experience ORDER BY created_at DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        self.collect(rows)
    }

    /// Most recent rows belonging to a caller-visible conversation set.
    ///
    /// The visibility set is produced by Core's conversation ACL query. Keep the
    /// filtering here, next to the durable rows, so an HTTP caller cannot receive
    /// another user's captured text merely by listing the learning buffer.
    pub async fn list_visible(
        &self,
        limit: usize,
        visible_conversation_ids: &HashSet<String>,
    ) -> Result<Vec<Experience>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at
             FROM experience ORDER BY created_at DESC",
        )?;
        let rows = stmt.query_map([], Self::map_row)?;
        self.collect_visible(rows, limit, visible_conversation_ids)
    }

    /// Captured-but-unscored, non-excluded rows — the PRM work queue.
    pub async fn list_unscored(&self, limit: usize) -> Result<Vec<Experience>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at
             FROM experience
             WHERE reward IS NULL AND excluded = 0 AND outcome = 'completed'
             ORDER BY created_at ASC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], Self::map_row)?;
        self.collect(rows)
    }

    /// Captured-but-unscored rows restricted to a caller-visible conversation set.
    pub async fn list_unscored_visible(
        &self,
        limit: usize,
        visible_conversation_ids: &HashSet<String>,
    ) -> Result<Vec<Experience>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at
             FROM experience
             WHERE reward IS NULL AND excluded = 0 AND outcome = 'completed'
             ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], Self::map_row)?;
        self.collect_visible(rows, limit, visible_conversation_ids)
    }

    /// High-reward, non-excluded rows — the reward-filtered training set (RFT).
    pub async fn list_for_training(
        &self,
        min_reward: f64,
        limit: usize,
    ) -> Result<Vec<Experience>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at
             FROM experience
             WHERE reward IS NOT NULL AND reward >= ?1 AND excluded = 0
             ORDER BY reward DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![min_reward, limit as i64], Self::map_row)?;
        self.collect(rows)
    }

    /// High-reward rows restricted to a caller-visible conversation set.
    pub async fn list_for_training_visible(
        &self,
        min_reward: f64,
        limit: usize,
        visible_conversation_ids: &HashSet<String>,
    ) -> Result<Vec<Experience>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, agent_id, user_text, assistant_text, outcome,
                    reward, base_model, skill_generation, excluded, created_at
             FROM experience
             WHERE reward IS NOT NULL AND reward >= ?1 AND excluded = 0
             ORDER BY reward DESC",
        )?;
        let rows = stmt.query_map(params![min_reward], Self::map_row)?;
        self.collect_visible(rows, limit, visible_conversation_ids)
    }

    /// `(total, scored, trainable_at_min)` counts for the buffer overview.
    pub async fn counts(&self, min_reward: f64) -> Result<(usize, usize, usize)> {
        let conn = self.conn.lock().await;
        let total: i64 = conn.query_row("SELECT COUNT(*) FROM experience", [], |r| r.get(0))?;
        let scored: i64 = conn.query_row(
            "SELECT COUNT(*) FROM experience WHERE reward IS NOT NULL",
            [],
            |r| r.get(0),
        )?;
        let trainable: i64 = conn.query_row(
            "SELECT COUNT(*) FROM experience WHERE reward >= ?1 AND excluded = 0",
            params![min_reward],
            |r| r.get(0),
        )?;
        Ok((total as usize, scored as usize, trainable as usize))
    }

    /// Counts for only the conversations visible to a caller.
    pub async fn counts_visible(
        &self,
        min_reward: f64,
        visible_conversation_ids: &HashSet<String>,
    ) -> Result<(usize, usize, usize)> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT conversation_id, reward, excluded FROM experience")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<f64>>(1)?,
                row.get::<_, i64>(2)? != 0,
            ))
        })?;
        let mut total = 0usize;
        let mut scored = 0usize;
        let mut trainable = 0usize;
        for row in rows {
            let (conversation_id, reward, excluded) = row?;
            if !visible_conversation_ids.contains(&conversation_id) {
                continue;
            }
            total += 1;
            if reward.is_some() {
                scored += 1;
            }
            if reward.is_some_and(|value| value >= min_reward) && !excluded {
                trainable += 1;
            }
        }
        Ok((total, scored, trainable))
    }

    fn map_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Experience> {
        Ok(Experience {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            agent_id: row.get(2)?,
            user_text: row.get(3)?,
            assistant_text: row.get(4)?,
            outcome: row.get(5)?,
            reward: row.get(6)?,
            base_model: row.get(7)?,
            skill_generation: row.get(8)?,
            excluded: row.get::<_, i64>(9)? != 0,
            created_at: row.get(10)?,
        })
    }
}

/// Delete `state/learning/dataset-*.jsonl` files an older build wrote (plaintext
/// copies of buffer rows). Datasets are no longer written to disk: a retrain
/// sends its samples inline.
pub fn purge_legacy_datasets(data_dir: &Path) {
    let dir = ryu_sidecar_runtime::layout::state_path(data_dir, "learning");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("dataset-") && name.ends_with(".jsonl") {
            if let Err(error) = std::fs::remove_file(entry.path()) {
                tracing::warn!(%error, "could not delete a legacy learning dataset");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, reward: Option<f64>) -> Experience {
        Experience {
            id: id.to_string(),
            conversation_id: "conv-1".to_string(),
            agent_id: None,
            user_text: "how do I reverse a string in rust".to_string(),
            assistant_text: "use chars().rev().collect::<String>()".to_string(),
            outcome: "completed".to_string(),
            reward,
            base_model: Some("gemma-4-E2B-it-Q4_K_M".to_string()),
            skill_generation: 0,
            excluded: false,
            created_at: "2026-07-01T00:00:00Z".to_string(),
        }
    }

    async fn open_tmp(tag: &str) -> ExperienceStore {
        // Unique path per test so parallel tests don't share a WAL db (lock).
        let dir = std::env::temp_dir().join(format!("ryu-exp-test-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        ExperienceStore::open(dir.join("experience.db")).expect("open")
    }

    fn test_cipher() -> ContentCipher {
        ContentCipher::from_root(&[3u8; 32], STORE)
    }

    fn file_contains(path: &Path, needle: &str) -> bool {
        std::fs::read(path)
            .map(|bytes| bytes.windows(needle.len()).any(|w| w == needle.as_bytes()))
            .unwrap_or(false)
    }

    fn raw_texts(path: &Path, id: &str) -> (String, String) {
        let conn = Connection::open(path).unwrap();
        conn.query_row(
            "SELECT user_text, assistant_text FROM experience WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn texts_are_sealed_on_disk_and_open_on_read() {
        let dir = tempfile_dir("sealed");
        let path = dir.join("experience.db");
        let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        let mut exp = sample("a", Some(0.9));
        exp.user_text = "my-private-prompt-marker".into();
        exp.assistant_text = "my-private-reply-marker".into();
        store.record_if_absent(&exp).await.unwrap();

        let (user, assistant) = raw_texts(&path, "a");
        assert!(user.starts_with("encb:v1:") && assistant.starts_with("encb:v1:"));
        for file in [path.clone(), dir.join("experience.db-wal")] {
            assert!(!file_contains(&file, "my-private-prompt-marker"));
            assert!(!file_contains(&file, "my-private-reply-marker"));
        }
        let rows = store.list_for_training(0.5, 10).await.unwrap();
        assert_eq!(rows[0].user_text, "my-private-prompt-marker");
        assert_eq!(rows[0].assistant_text, "my-private-reply-marker");
    }

    #[tokio::test]
    async fn legacy_rows_are_sealed_once_and_still_read() {
        let dir = tempfile_dir("legacy");
        let path = dir.join("experience.db");
        {
            let conn = Connection::open(&path).unwrap();
            ExperienceStore::init_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO experience (id, conversation_id, user_text, assistant_text, outcome,
                   skill_generation, excluded, created_at)
                 VALUES ('old', 'conv-1', 'legacy-prompt-marker', 'legacy-reply-marker',
                   'completed', 0, 0, '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let leftover = dir.join("state").join("learning");
        std::fs::create_dir_all(&leftover).unwrap();
        std::fs::write(leftover.join("dataset-1.jsonl"), "legacy-prompt-marker").unwrap();
        std::fs::write(leftover.join("keep.txt"), "x").unwrap();

        let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        purge_legacy_datasets(&dir);
        assert!(!leftover.join("dataset-1.jsonl").exists());
        assert!(leftover.join("keep.txt").exists());
        let rows = store.list_unscored(10).await.unwrap();
        assert_eq!(rows[0].user_text, "legacy-prompt-marker");
        let sealed = raw_texts(&path, "old");
        assert!(sealed.0.starts_with("encb:v1:"));
        drop(store);
        for file in [path.clone(), dir.join("experience.db-wal")] {
            assert!(!file_contains(&file, "legacy-prompt-marker"));
        }
        let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        assert_eq!(raw_texts(&path, "old"), sealed, "second open is a no-op");
        let conn = Connection::open(&path).unwrap();
        ryu_crypto::content_sqlite::assert_all_open(&conn, &test_cipher(), &column_plans().unwrap())
            .unwrap();
        assert_eq!(store.list(10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_text_swapped_between_rows_is_skipped_and_counted() {
        let dir = tempfile_dir("swap");
        let path = dir.join("experience.db");
        let store = ExperienceStore::open_with_cipher(path.clone(), test_cipher()).unwrap();
        store.record_if_absent(&sample("a", None)).await.unwrap();
        store.record_if_absent(&sample("b", None)).await.unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE experience SET user_text = (SELECT user_text FROM experience WHERE id = 'a')
                 WHERE id = 'b'",
                [],
            )
            .unwrap();
        }
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "a");
        assert_eq!(store.unreadable_rows(), 1);
    }

    fn tempfile_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ryu-exp-seal-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn record_is_idempotent_and_preserves_reward() {
        let store = open_tmp("idempotent").await;
        assert!(store.record_if_absent(&sample("a", None)).await.unwrap());
        store.set_reward("a", 0.9).await.unwrap();
        // Re-sweep: same id must NOT clobber the reward.
        assert!(!store.record_if_absent(&sample("a", None)).await.unwrap());
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].reward, Some(0.9));
    }

    #[tokio::test]
    async fn clear_reward_reverts_to_unscored() {
        let store = open_tmp("clear").await;
        store.record_if_absent(&sample("a", None)).await.unwrap();
        store.set_reward("a", 1.0).await.unwrap();
        assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 1);
        // Clearing a human vote reverts the row to unscored (NULL), so it drops
        // out of the training set and re-enters the PRM work queue.
        assert!(store.clear_reward("a").await.unwrap());
        assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 0);
        assert_eq!(store.list_unscored(10).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn filters_unscored_and_trainable() {
        let store = open_tmp("filters").await;
        store.record_if_absent(&sample("a", None)).await.unwrap();
        store.record_if_absent(&sample("b", None)).await.unwrap();
        store.set_reward("b", 0.8).await.unwrap();
        store.record_if_absent(&sample("c", None)).await.unwrap();
        store.set_reward("c", 0.3).await.unwrap();

        let unscored = store.list_unscored(10).await.unwrap();
        assert_eq!(unscored.len(), 1);
        assert_eq!(unscored[0].id, "a");

        let trainable = store.list_for_training(0.7, 10).await.unwrap();
        assert_eq!(trainable.len(), 1);
        assert_eq!(trainable[0].id, "b");

        let (total, scored, train_count) = store.counts(0.7).await.unwrap();
        assert_eq!((total, scored, train_count), (3, 2, 1));
    }

    #[tokio::test]
    async fn exclude_conversation_blocks_training() {
        let store = open_tmp("exclude").await;
        store
            .record_if_absent(&sample("a", Some(0.95)))
            .await
            .unwrap();
        assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 1);
        let n = store.exclude_conversation("conv-1", true).await.unwrap();
        assert_eq!(n, 1);
        assert_eq!(store.list_for_training(0.7, 10).await.unwrap().len(), 0);
    }

    #[tokio::test]
    async fn scoped_queries_hide_other_conversations() {
        let store = open_tmp("scoped").await;
        let mut other = sample("other", Some(0.95));
        other.conversation_id = "conv-2".to_string();
        other.user_text = "private prompt".to_string();
        other.assistant_text = "private reply".to_string();
        store
            .record_if_absent(&sample("visible", Some(0.9)))
            .await
            .unwrap();
        store.record_if_absent(&other).await.unwrap();

        let visible = HashSet::from(["conv-1".to_string()]);
        let rows = store.list_visible(10, &visible).await.unwrap();
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            ["visible"]
        );
        assert_eq!(
            store
                .list_for_training_visible(0.7, 10, &visible)
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            store.counts_visible(0.7, &visible).await.unwrap(),
            (1, 1, 1)
        );
    }
}
