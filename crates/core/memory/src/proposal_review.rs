//! Reviewing proposals: approve or reject a pending proposal, and roll back an
//! applied one. Every lifecycle transition runs in one transaction and is
//! row-count checked, so a race can never leave two active versions of a fact.

use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};

use crate::crypto::{encode_payload, encode_tags};
use crate::{
    detect_sensitive_topics, now_millis, MemoryLifecycle, MemoryProposalOperation,
    MemoryProposalStatus, MemoryRevisionProposal, MemoryScope, MemoryStore,
};

impl MemoryStore {
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
        if proposal.operation == MemoryProposalOperation::Archive {
            let Some(target_id) = proposal.target_memory_id.as_deref() else {
                anyhow::bail!("archive proposal target is missing");
            };
            // The draft is never written, so its content and scope are not
            // re-validated; only the target's lifecycle changes.
            {
                let mut conn = self.conn.lock().await;
                let tx = conn.transaction().context("starting archive approval")?;
                approve_archive(tx, id, target_id, now, reviewer)?;
            }
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
        if proposal.operation == MemoryProposalOperation::Archive {
            {
                let mut conn = self.conn.lock().await;
                let tx = conn.transaction().context("starting archive rollback")?;
                rollback_archive(tx, id, applied_id, now, reviewer)?;
            }
            return self.get_proposal(id).await;
        }
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
}

/// Apply a pending archive proposal inside `tx`: move the target from
/// `active` to `archived` and mark the proposal applied, recording the target
/// as `applied_memory_id`. The target update must change exactly one row, so a
/// target that was revised, archived, or deleted since the proposal was made
/// aborts the approval and leaves everything as it was. A proposal that is no
/// longer pending (a concurrent review won) is left untouched.
fn approve_archive(
    tx: rusqlite::Transaction<'_>,
    id: &str,
    target_id: &str,
    now: i64,
    reviewer: Option<&str>,
) -> Result<()> {
    if proposal_status(&tx, id)? != MemoryProposalStatus::Pending {
        tx.rollback()?;
        return Ok(());
    }
    let archived = tx.execute(
        "UPDATE memory_entries SET lifecycle = 'archived', updated_at = ?1
         WHERE id = ?2 AND lifecycle = 'active'",
        params![now, target_id],
    )?;
    if archived != 1 {
        let lifecycle = entry_lifecycle(&tx, target_id)?;
        tx.rollback()?;
        if lifecycle.is_none() {
            anyhow::bail!("target memory no longer exists");
        }
        anyhow::bail!("target memory is no longer active");
    }
    tx.execute(
        "UPDATE memory_proposals SET status = 'applied', updated_at = ?1,
            reviewed_at = ?1, reviewed_by = ?2, applied_memory_id = ?3
         WHERE id = ?4 AND status = 'pending'",
        params![now, reviewer, target_id, id],
    )?;
    tx.commit().context("committing archive approval")
}

/// Reverse an applied archive inside `tx`: the archived row becomes active
/// again and the proposal is marked rolled back. Refused, with nothing
/// changed, when the row was deleted or is no longer archived.
fn rollback_archive(
    tx: rusqlite::Transaction<'_>,
    id: &str,
    archived_id: &str,
    now: i64,
    reviewer: Option<&str>,
) -> Result<()> {
    if proposal_status(&tx, id)? != MemoryProposalStatus::Applied {
        // A concurrent rollback already finished; report its result.
        tx.rollback()?;
        return Ok(());
    }
    let restored = tx.execute(
        "UPDATE memory_entries SET lifecycle = 'active', updated_at = ?1
         WHERE id = ?2 AND lifecycle = 'archived'",
        params![now, archived_id],
    )?;
    if restored != 1 {
        let lifecycle = entry_lifecycle(&tx, archived_id)?;
        tx.rollback()?;
        if lifecycle.is_none() {
            anyhow::bail!("archived memory no longer exists");
        }
        anyhow::bail!("archived memory is no longer archived");
    }
    tx.execute(
        "UPDATE memory_proposals SET status = 'rolled_back', updated_at = ?1,
            reviewed_at = ?1, reviewed_by = ?2 WHERE id = ?3 AND status = 'applied'",
        params![now, reviewer, id],
    )?;
    tx.commit().context("committing archive rollback")
}

fn proposal_status(conn: &rusqlite::Connection, id: &str) -> Result<MemoryProposalStatus> {
    let status: String = conn.query_row(
        "SELECT status FROM memory_proposals WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )?;
    Ok(MemoryProposalStatus::from_str(&status))
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
