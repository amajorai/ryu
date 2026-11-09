//! Deleting long-term facts. A delete is a hard delete — the row and its
//! encrypted content are gone — and, in the same transaction, every link that
//! pointed at the row is repaired so nothing dangles:
//!
//! * rows that superseded it keep their content but lose `supersedes_id`;
//! * pending proposals that targeted it are rejected by the system, since no
//!   approval could apply any more;
//! * the payload of each of those proposals, and of any proposal whose draft
//!   became the deleted row, is replaced with a scrubbed copy so the deleted
//!   fact does not survive in the proposal ledger.

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

use crate::proposals::MemoryProposalPayload;
use crate::{
    now_millis, MemoryCategory, MemoryMetadata, MemoryProposalDraft, MemoryScope, MemoryStore,
    DEFAULT_IMPORTANCE,
};

/// `reviewed_by` on a proposal the store rejected on its own.
pub(crate) const SYSTEM_REVIEWER: &str = "system";

/// Rationale of a pending proposal rejected because its target was deleted.
pub(crate) const TARGET_DELETED_RATIONALE: &str =
    "Rejected automatically: the memory this proposal targeted was deleted.";

/// Rationale of a reviewed proposal whose written memory was deleted.
pub(crate) const APPLIED_DELETED_RATIONALE: &str =
    "The memory this proposal wrote was deleted, so its details were removed.";

impl MemoryStore {
    /// Delete a single entry. Returns whether a row was removed. Links to the
    /// id are repaired even when the row was already gone, so a legacy dangling
    /// reference is cleaned up by deleting it again.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting memory delete")?;
        let removed = tx.execute("DELETE FROM memory_entries WHERE id = ?1", params![id])?;
        tx.execute(
            "UPDATE memory_entries SET supersedes_id = NULL WHERE supersedes_id = ?1",
            params![id],
        )?;
        self.release_proposals_of(&tx, id, now_millis())?;
        tx.commit().context("committing memory delete")?;
        Ok(removed > 0)
    }

    /// Delete **every** long-term memory entry (all users/agents). Single-tenant
    /// today (`LOCAL_USER`), so this is the "forget everything" wipe. Returns the
    /// number of rows removed. Proposals and settings go with the entries in one
    /// transaction, so no proposal is left pointing at a deleted row. The
    /// encryption key is untouched, so new memories recorded afterward stay
    /// readable.
    pub async fn clear_all(&self) -> Result<u64> {
        let mut conn = self.conn.lock().await;
        let tx = conn.transaction().context("starting memory wipe")?;
        let removed = tx.execute("DELETE FROM memory_entries", [])?;
        tx.execute("DELETE FROM memory_proposals", [])?;
        tx.execute("DELETE FROM memory_settings", [])?;
        tx.commit().context("committing memory wipe")?;
        Ok(removed as u64)
    }

    /// Reject pending proposals that target `id` and scrub the payload of every
    /// proposal that targeted it while pending or whose draft became it.
    fn release_proposals_of(&self, conn: &Connection, id: &str, now: i64) -> Result<()> {
        let rows = {
            let mut stmt = conn.prepare(
                "SELECT id, status, nonce, ciphertext FROM memory_proposals
                 WHERE (target_memory_id = ?1 AND status = 'pending')
                    OR applied_memory_id = ?1",
            )?;
            let mapped = stmt.query_map(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                ))
            })?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        };
        for (proposal_id, status, nonce, ciphertext) in rows {
            let pending = status == "pending";
            let rationale = if pending {
                TARGET_DELETED_RATIONALE
            } else {
                APPLIED_DELETED_RATIONALE
            };
            let (nonce, ciphertext) = self.scrubbed_payload(&nonce, &ciphertext, rationale)?;
            if pending {
                conn.execute(
                    "UPDATE memory_proposals SET status = 'rejected', updated_at = ?1,
                        reviewed_at = ?1, reviewed_by = ?2, nonce = ?3, ciphertext = ?4
                     WHERE id = ?5 AND status = 'pending'",
                    params![now, SYSTEM_REVIEWER, nonce, ciphertext, proposal_id],
                )?;
            } else {
                conn.execute(
                    "UPDATE memory_proposals SET updated_at = ?1, nonce = ?2, ciphertext = ?3
                     WHERE id = ?4",
                    params![now, nonce, ciphertext, proposal_id],
                )?;
            }
        }
        Ok(())
    }

    /// Re-encrypt a proposal payload with `rationale` and a draft stripped of
    /// its content, usage hint and source excerpts. Scope, category, tags and
    /// the cited message ids stay for audit. A payload that no longer decrypts
    /// is replaced with an empty draft rather than blocking the delete.
    fn scrubbed_payload(
        &self,
        nonce: &[u8],
        ciphertext: &[u8],
        rationale: &str,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        let draft = self
            .decrypt(nonce, ciphertext)
            .ok()
            .and_then(|plain| serde_json::from_slice::<MemoryProposalPayload>(&plain).ok())
            .map(|payload| payload.draft);
        let payload = MemoryProposalPayload {
            draft: scrub_draft(draft),
            rationale: rationale.to_owned(),
        };
        let plain = serde_json::to_vec(&payload).context("serializing scrubbed proposal")?;
        self.encrypt(&plain)
    }
}

/// A draft with every field that could restate the deleted fact cleared.
pub(crate) fn scrub_draft(draft: Option<MemoryProposalDraft>) -> MemoryProposalDraft {
    let Some(mut draft) = draft else {
        return MemoryProposalDraft {
            content: String::new(),
            scope: MemoryScope::default(),
            scope_id: None,
            category: MemoryCategory::default(),
            importance: DEFAULT_IMPORTANCE,
            when_to_use: None,
            tags: Vec::new(),
            author_agent_id: None,
            metadata: MemoryMetadata::default(),
            sources: Vec::new(),
        };
    };
    draft.content.clear();
    draft.when_to_use = None;
    for source in &mut draft.sources {
        source.excerpt.clear();
    }
    draft
}
