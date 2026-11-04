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

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use ryu_crypto::content_sqlite::{ColumnPlan, KeyKind};
use ryu_crypto::{ContentCipher, ContentContext};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::seal::{StoreSeal, STORE};

mod queries;

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
        let assistant_text = self.seal.seal(
            &exp.assistant_text,
            &ContentContext::for_id(ASSISTANT_TEXT, &exp.id),
        )?;
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
mod queries_tests;
#[cfg(test)]
mod tests;
