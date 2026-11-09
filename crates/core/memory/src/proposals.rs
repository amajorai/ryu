//! Reviewable memory-revision proposals: create, list and get. Review
//! (approve or reject) and rollback live in `proposal_review`.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    detect_sensitive_topics, now_millis, MemoryProposalDraft, MemoryProposalFilter,
    MemoryProposalOperation, MemoryProposalStatus, MemoryRevisionProposal, MemoryScope,
    MemoryStore, NewMemoryProposal,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct MemoryProposalPayload {
    pub(crate) draft: MemoryProposalDraft,
    pub(crate) rationale: String,
}

impl MemoryStore {
    /// Persist a proposed create/revision without changing the active memory set.
    /// The draft and rationale are encrypted; only ownership, operation, and review
    /// state are queryable without opening the payload.
    pub async fn create_proposal(&self, proposal: NewMemoryProposal) -> Result<String> {
        validate_new_proposal(&proposal)?;
        let payload = serde_json::to_vec(&MemoryProposalPayload {
            draft: proposal.draft,
            rationale: proposal.rationale,
        })
        .context("serializing memory proposal")?;
        let (nonce, ciphertext) = self.encrypt(&payload)?;
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_millis();
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_proposals
                (id, owner_user_id, agent_id, target_memory_id, operation, status,
                 nonce, ciphertext, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?8)",
            params![
                id,
                proposal.owner_user_id,
                proposal.agent_id,
                proposal.target_memory_id,
                proposal.operation.as_str(),
                nonce,
                ciphertext,
                now,
            ],
        )
        .context("inserting memory proposal")?;
        Ok(id)
    }

    /// List proposals for one owner. Pending is the default so callers do not
    /// accidentally expose the full historical proposal ledger.
    pub async fn list_proposals(
        &self,
        owner_user_id: &str,
        filter: &MemoryProposalFilter,
    ) -> Result<Vec<MemoryRevisionProposal>> {
        let limit = filter.limit.unwrap_or(100).min(500) as i64;
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, owner_user_id, agent_id, target_memory_id, operation,
                        status, nonce, ciphertext, created_at, updated_at,
                        reviewed_at, reviewed_by, applied_memory_id
                 FROM memory_proposals
                 WHERE owner_user_id = ?1
                   AND (?2 IS NULL OR status = ?2)
                 ORDER BY created_at DESC
                 LIMIT ?3",
            )?;
            let status = filter.status.map(|s| s.as_str());
            let mapped = stmt.query_map(params![owner_user_id, status, limit], proposal_row)?;
            mapped.collect::<std::result::Result<Vec<_>, _>>()?
        };
        rows.into_iter()
            .map(|row| self.decrypt_proposal(row))
            .collect()
    }

    /// Fetch a proposal by id. The Core layer applies the owner/tenancy gate.
    pub async fn get_proposal(&self, id: &str) -> Result<Option<MemoryRevisionProposal>> {
        let row = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT id, owner_user_id, agent_id, target_memory_id, operation,
                        status, nonce, ciphertext, created_at, updated_at,
                        reviewed_at, reviewed_by, applied_memory_id
                 FROM memory_proposals WHERE id = ?1",
                params![id],
                proposal_row,
            )
            .optional()
            .context("reading memory proposal")?
        };
        row.map(|row| self.decrypt_proposal(row)).transpose()
    }

    fn decrypt_proposal(&self, row: ProposalRow) -> Result<MemoryRevisionProposal> {
        let plain = self.decrypt(&row.nonce, &row.ciphertext)?;
        let payload: MemoryProposalPayload =
            serde_json::from_slice(&plain).context("decoding memory proposal payload")?;
        Ok(MemoryRevisionProposal {
            id: row.id,
            owner_user_id: row.owner_user_id,
            agent_id: row.agent_id,
            target_memory_id: row.target_memory_id,
            operation: MemoryProposalOperation::from_str(&row.operation),
            status: MemoryProposalStatus::from_str(&row.status),
            draft: payload.draft,
            rationale: payload.rationale,
            created_at: row.created_at,
            updated_at: row.updated_at,
            reviewed_at: row.reviewed_at,
            reviewed_by: row.reviewed_by,
            applied_memory_id: row.applied_memory_id,
        })
    }
}

struct ProposalRow {
    id: String,
    owner_user_id: String,
    agent_id: String,
    target_memory_id: Option<String>,
    operation: String,
    status: String,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    created_at: i64,
    updated_at: i64,
    reviewed_at: Option<i64>,
    reviewed_by: Option<String>,
    applied_memory_id: Option<String>,
}

fn proposal_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProposalRow> {
    Ok(ProposalRow {
        id: row.get(0)?,
        owner_user_id: row.get(1)?,
        agent_id: row.get(2)?,
        target_memory_id: row.get(3)?,
        operation: row.get(4)?,
        status: row.get(5)?,
        nonce: row.get(6)?,
        ciphertext: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        reviewed_at: row.get(10)?,
        reviewed_by: row.get(11)?,
        applied_memory_id: row.get(12)?,
    })
}

/// Create-time checks for a proposal. An archive only needs a target: its
/// draft is never written, so content, scope and sensitivity are not checked.
fn validate_new_proposal(proposal: &NewMemoryProposal) -> Result<()> {
    let has_target = proposal
        .target_memory_id
        .as_deref()
        .is_some_and(|target| !target.trim().is_empty());
    if proposal.operation == MemoryProposalOperation::Archive {
        if !has_target {
            anyhow::bail!("an archive proposal requires a target memory id");
        }
        return Ok(());
    }
    if proposal.draft.content.trim().is_empty() {
        anyhow::bail!("a memory proposal requires non-empty content");
    }
    if proposal.operation == MemoryProposalOperation::Revise && proposal.target_memory_id.is_none()
    {
        anyhow::bail!("a revision proposal requires a target memory id");
    }
    if matches!(
        proposal.draft.scope,
        MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
    ) && proposal
        .draft
        .scope_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_none()
    {
        anyhow::bail!("an agent-, project-, or org-scope proposal requires a scope id");
    }
    if !detect_sensitive_topics(&proposal.draft.content).is_empty()
        && proposal.draft.scope != MemoryScope::User
    {
        anyhow::bail!(
            "sensitive memory must use user scope; shared and agent scopes are not supported"
        );
    }
    Ok(())
}
