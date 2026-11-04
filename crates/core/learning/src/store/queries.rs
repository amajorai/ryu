//! Read paths of the experience buffer: listings, work queues and counts.

use std::collections::HashSet;

use anyhow::Result;
use rusqlite::params;
use ryu_crypto::ContentContext;

use super::{Experience, ExperienceStore, ASSISTANT_TEXT, USER_TEXT};
use crate::seal::STORE;

impl ExperienceStore {
    /// Open the sealed texts of a row read from disk; `None` (counted and
    /// logged) when either does not open.
    fn reveal(&self, mut row: Experience) -> Option<Experience> {
        let user = self
            .seal
            .open(&row.user_text, &ContentContext::for_id(USER_TEXT, &row.id));
        let assistant = self.seal.open(
            &row.assistant_text,
            &ContentContext::for_id(ASSISTANT_TEXT, &row.id),
        );
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

    fn collect(
        &self,
        rows: impl Iterator<Item = rusqlite::Result<Experience>>,
    ) -> Result<Vec<Experience>> {
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
