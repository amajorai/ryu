//! `/btw` asides and subagent child conversations.
// test-exempt: moved verbatim out of conversations.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

use super::*;

impl ConversationStore {
    // ── Side questions (`/btw`) ───────────────────────────────────────────────

    /// Persist a `/btw` side question + answer against its parent conversation.
    /// `question`/`answer` are sealed at rest. Returns the stored entry (with the
    /// plaintext fields, for an immediate echo back to the client).
    pub async fn append_btw(
        &self,
        conversation_id: &str,
        question: &str,
        answer: &str,
        model: Option<&str>,
    ) -> Result<BtwEntry> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let sealed_q = self.cipher.seal(question)?;
        let sealed_a = self.cipher.seal(answer)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO btw_entries (id, conversation_id, kind, question, answer, model, created_at)
             VALUES (?1, ?2, 'btw', ?3, ?4, ?5, ?6)",
            params![id, conversation_id, sealed_q, sealed_a, model, now],
        )
        .context("persisting btw entry")?;
        Ok(BtwEntry {
            id,
            conversation_id: conversation_id.to_owned(),
            kind: "btw".to_owned(),
            question: question.to_owned(),
            answer: answer.to_owned(),
            model: model.map(str::to_owned),
            agent_id: None,
            preset: None,
            child_conversation_id: None,
            created_at: now,
        })
    }

    /// Persist a delegated subagent child under its parent conversation. The row
    /// is intentionally summary-shaped: `question` is the task, `answer` is the
    /// final output or error text, and `child_conversation_id` points at the full
    /// clean-context ACP transcript when a registered agent produced one.
    pub async fn append_subagent_child(
        &self,
        conversation_id: &str,
        task: &str,
        answer: &str,
        agent_id: Option<&str>,
        preset: Option<&str>,
        child_conversation_id: Option<&str>,
    ) -> Result<BtwEntry> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let sealed_task = self.cipher.seal(task)?;
        let sealed_answer = self.cipher.seal(answer)?;
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO btw_entries (
                 id, conversation_id, kind, question, answer, model,
                 agent_id, preset, child_conversation_id, created_at
             )
             VALUES (?1, ?2, 'subagent', ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            params![
                id,
                conversation_id,
                sealed_task,
                sealed_answer,
                agent_id,
                preset,
                child_conversation_id,
                now
            ],
        )
        .context("persisting subagent child entry")?;
        Ok(BtwEntry {
            id,
            conversation_id: conversation_id.to_owned(),
            kind: "subagent".to_owned(),
            question: task.to_owned(),
            answer: answer.to_owned(),
            model: None,
            agent_id: agent_id.map(str::to_owned),
            preset: preset.map(str::to_owned),
            child_conversation_id: child_conversation_id.map(str::to_owned),
            created_at: now,
        })
    }

    /// All child entries for a conversation, newest first.
    pub async fn list_btw(&self, conversation_id: &str) -> Result<Vec<BtwEntry>> {
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, kind, question, answer, model,
                    agent_id, preset, child_conversation_id, created_at
             FROM btw_entries
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC",
        )?;
        let rows = stmt.query_map([conversation_id], |row| {
            Ok(BtwEntry {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                kind: row.get(2)?,
                question: row.get(3)?,
                answer: row.get(4)?,
                model: row.get(5)?,
                agent_id: row.get(6)?,
                preset: row.get(7)?,
                child_conversation_id: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            let mut entry = row?;
            entry.question = self.open_content(std::mem::take(&mut entry.question));
            entry.answer = self.open_content(std::mem::take(&mut entry.answer));
            out.push(entry);
        }
        Ok(out)
    }

    /// Delete a single side question by id. Returns true when a row was removed.
    pub async fn delete_btw(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM btw_entries WHERE id = ?1", params![id])?;
        Ok(removed > 0)
    }
}
