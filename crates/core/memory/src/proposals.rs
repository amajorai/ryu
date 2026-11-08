//! Reviewable memory-revision proposals: create, list, get, review (approve or
//! reject) and rollback.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::crypto::{encode_payload, encode_tags};
use crate::{
    detect_sensitive_topics, now_millis, MemoryLifecycle, MemoryProposalDraft,
    MemoryProposalFilter, MemoryProposalOperation, MemoryProposalStatus, MemoryRevisionProposal,
    MemoryScope, MemoryStore, NewMemoryProposal,
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
        if proposal.draft.content.trim().is_empty() {
            anyhow::bail!("a memory proposal requires non-empty content");
        }
        if proposal.operation == MemoryProposalOperation::Revise
            && proposal.target_memory_id.is_none()
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

    /// Approve or reject a pending proposal. Approval is a transaction: a revision
    /// is inserted, the old row is superseded, and the proposal is marked applied
    /// together. Repeated review is idempotent and returns the current proposal.
    pub async fn review_proposal(
        &self,
        id: &str,
        approve: bool,
        reviewer: Option<&str>,
    ) -> Result<Option<MemoryRevisionProposal>> {
        let Some(proposal) = self.get_proposal(id).await? else {
            return Ok(None);
        };
        if proposal.status != MemoryProposalStatus::Pending {
            return Ok(Some(proposal));
        }
        let now = now_millis();
        if !approve {
            let conn = self.conn.lock().await;
            conn.execute(
                "UPDATE memory_proposals SET status = 'rejected', updated_at = ?1,
                    reviewed_at = ?1, reviewed_by = ?2
                 WHERE id = ?3 AND status = 'pending'",
                params![now, reviewer, id],
            )?;
            drop(conn);
            return self.get_proposal(id).await;
        }

        let proposed_sensitive = detect_sensitive_topics(&proposal.draft.content);
        if matches!(
            proposal.draft.scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && proposal
            .draft
            .scope_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            anyhow::bail!("an agent-, project-, or org-scope proposal requires a scope id");
        }
        if !proposed_sensitive.is_empty() && proposal.draft.scope != MemoryScope::User {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        if proposal.operation == MemoryProposalOperation::Revise
            && proposal.target_memory_id.is_none()
        {
            anyhow::bail!("revision proposal target is missing");
        }

        // The proposal and its target are checked under the transaction so two
        // reviewers cannot apply the same pending row, and two revisions of one
        // target cannot both apply, concurrently. Keep the complete transaction
        // in this synchronous lexical block: `rusqlite::Transaction` borrows the
        // connection, which is not safe to carry across the async reread below.
        {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction().context("starting proposal approval")?;
            let current_status: String = tx.query_row(
                "SELECT status FROM memory_proposals WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )?;
            if MemoryProposalStatus::from_str(&current_status) != MemoryProposalStatus::Pending {
                tx.rollback()?;
            } else {
                // Supersede first and require exactly one row: a target that was
                // superseded, retracted, or deleted since the proposal was made
                // aborts the whole approval rather than adding a second active row.
                if let Some(target_id) = proposal.target_memory_id.as_deref() {
                    let superseded = tx.execute(
                        "UPDATE memory_entries SET lifecycle = 'superseded', updated_at = ?1
                         WHERE id = ?2 AND lifecycle = 'active'",
                        params![now, target_id],
                    )?;
                    if superseded != 1 {
                        let lifecycle = entry_lifecycle(&tx, target_id)?;
                        tx.rollback()?;
                        if lifecycle.is_none() {
                            anyhow::bail!("target memory no longer exists");
                        }
                        anyhow::bail!("target memory is no longer active");
                    }
                }
                let new_id = uuid::Uuid::new_v4().to_string();
                let draft = &proposal.draft;
                let content = draft.content.trim();
                let when = draft
                    .when_to_use
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty());
                let sensitive_topics = detect_sensitive_topics(content);
                let (nonce, ciphertext) = self.encrypt(&encode_payload(
                    content,
                    when,
                    &draft.metadata.provenance,
                    &sensitive_topics,
                ))?;
                let supersedes_id = proposal.target_memory_id.clone();
                tx.execute(
                    "INSERT INTO memory_entries
                        (id, user_id, agent_id, nonce, ciphertext, created_at,
                         scope, scope_id, category, importance, tags, updated_at,
                         lifecycle, supersedes_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?6, 'active', ?12)",
                    params![
                        new_id,
                        proposal.owner_user_id,
                        proposal.agent_id,
                        nonce,
                        ciphertext,
                        now,
                        draft.scope.as_str(),
                        draft.scope_id,
                        draft.category.as_str(),
                        draft.importance.clamp(1, 5),
                        encode_tags(&draft.tags),
                        supersedes_id,
                    ],
                )?;
                tx.execute(
                    "UPDATE memory_proposals SET status = 'applied', updated_at = ?1,
                        reviewed_at = ?1, reviewed_by = ?2, applied_memory_id = ?3
                     WHERE id = ?4 AND status = 'pending'",
                    params![now, reviewer, new_id, id],
                )?;
                tx.commit().context("committing proposal approval")?;
            }
        }
        self.get_proposal(id).await
    }

    /// Reverse an applied proposal without deleting its audit records. The
    /// revision is retracted and its target reactivated in one transaction, and
    /// only when the revision is still the active row: rolling back a revision
    /// that was itself revised (or deleted), or whose target is gone, is refused
    /// so the store never ends up with two active versions of one fact.
    pub async fn rollback_proposal(
        &self,
        id: &str,
        reviewer: Option<&str>,
    ) -> Result<Option<MemoryRevisionProposal>> {
        let Some(proposal) = self.get_proposal(id).await? else {
            return Ok(None);
        };
        if proposal.status != MemoryProposalStatus::Applied {
            return Ok(Some(proposal));
        }
        let Some(applied_id) = proposal.applied_memory_id.as_deref() else {
            anyhow::bail!("applied proposal has no revision id");
        };
        let now = now_millis();
        {
            let mut conn = self.conn.lock().await;
            let tx = conn.transaction().context("starting proposal rollback")?;
            let current_status: String = tx.query_row(
                "SELECT status FROM memory_proposals WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )?;
            if MemoryProposalStatus::from_str(&current_status) != MemoryProposalStatus::Applied {
                // A concurrent rollback already finished; report its result.
                tx.rollback()?;
            } else {
                let retracted = tx.execute(
                    "UPDATE memory_entries SET lifecycle = 'retracted', updated_at = ?1
                     WHERE id = ?2 AND lifecycle = 'active'",
                    params![now, applied_id],
                )?;
                if retracted != 1 {
                    let lifecycle = entry_lifecycle(&tx, applied_id)?;
                    tx.rollback()?;
                    match lifecycle {
                        None => anyhow::bail!("revision memory no longer exists"),
                        Some(MemoryLifecycle::Superseded) => anyhow::bail!(
                            "revision has itself been revised; roll back the later proposal first"
                        ),
                        Some(_) => anyhow::bail!("revision memory is no longer active"),
                    }
                }
                if let Some(target_id) = proposal.target_memory_id.as_deref() {
                    let restored = tx.execute(
                        "UPDATE memory_entries SET lifecycle = 'active', updated_at = ?1
                         WHERE id = ?2 AND lifecycle = 'superseded'",
                        params![now, target_id],
                    )?;
                    if restored != 1 {
                        tx.rollback()?;
                        anyhow::bail!("target memory no longer exists or is not superseded");
                    }
                }
                tx.execute(
                    "UPDATE memory_proposals SET status = 'rolled_back', updated_at = ?1,
                        reviewed_at = ?1, reviewed_by = ?2 WHERE id = ?3 AND status = 'applied'",
                    params![now, reviewer, id],
                )?;
                tx.commit().context("committing proposal rollback")?;
            }
        }
        self.get_proposal(id).await
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

/// The lifecycle of a memory row, or `None` when the row does not exist. Used
/// to explain why a guarded lifecycle transition matched no row.
fn entry_lifecycle(conn: &rusqlite::Connection, id: &str) -> Result<Option<MemoryLifecycle>> {
    let lifecycle: Option<String> = conn
        .query_row(
            "SELECT lifecycle FROM memory_entries WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .context("reading memory lifecycle")?;
    Ok(lifecycle.as_deref().map(MemoryLifecycle::from_str))
}
