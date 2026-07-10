//! Persisted experience buffer (`~/.ryu/experience.db`).
//!
//! The system-of-record for the MetaClaw-style continual-learning loop: one row
//! per captured (user, assistant) turn, optionally scored by a PRM judge. The
//! buffer is populated by *sweeping* the conversation store at cycle time (not on
//! the chat hot path) and is the dataset source for a reward-filtered LoRA
//! retrain. Mirrors the rusqlite pattern in [`crate::finetune::store`].
//!
//! Design constraints (see `docs/continual-learning-metaclaw-spec.md`):
//! - Capture is consent-gated and per-conversation excludable upstream; this
//!   store only persists what the learning layer already decided to keep.
//! - `reward` stays `NULL` until a PRM scores the row; training filters on it.
//! - `base_model` records the model that produced the reply, for lineage — but a
//!   retrain always derives a *fresh* LoRA from the original base, never from a
//!   previous merge (avoids model collapse).

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

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
}

impl ExperienceStore {
    /// Open (creating if needed) the buffer at the default `~/.ryu/experience.db`.
    pub fn open_default() -> Result<Self> {
        Self::open(crate::paths::ryu_dir().join("experience.db"))
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating db dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("opening experience db {}", path.display()))?;
        Self::init_schema(&conn)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
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
                    exp.user_text,
                    exp.assistant_text,
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
        collect(rows)
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
        collect(rows)
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
        collect(rows)
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

fn collect(rows: impl Iterator<Item = rusqlite::Result<Experience>>) -> Result<Vec<Experience>> {
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
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
}
