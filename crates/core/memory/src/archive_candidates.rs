//! Archive candidates: the queries Dream uses to find memories worth retiring
//! and to keep it from proposing an archive the owner already declined. Both
//! are answered in SQL, so neither depends on how many memories or proposals
//! an owner has accumulated.

use std::collections::HashSet;

use anyhow::{Context, Result};
use rusqlite::params_from_iter;
use rusqlite::types::Value;

use crate::visibility::MEMORY_VISIBLE_PREDICATE;
use crate::{LongTermEntry, MemoryStore, MemoryVisibility, MAX_MEMORY_QUERY_LIMIT};

/// The one definition of "an archive must not be proposed for this target",
/// over a `memory_proposals` row aliased `p` whose owner is bound to
/// `:archive_owner`: a proposal of any kind still waiting for review (only one
/// could apply), or an archive the owner rejected or rolled back, however long
/// ago. `idx_memory_proposals_target` serves it.
const ARCHIVE_BLOCKING_PROPOSAL: &str = "p.owner_user_id = :archive_owner
     AND (p.status = 'pending'
          OR (p.operation = 'archive' AND p.status IN ('rejected', 'rolled_back')))";

/// Most target ids bound into one [`MemoryStore::archive_blocked_targets`]
/// statement, well under SQLite's parameter limit.
const BLOCKED_TARGET_CHUNK: usize = 400;

/// Rows decrypted per page while sensitive entries are being filtered out.
const UNUSED_EVENT_PAGE: usize = 128;

/// Which never-recalled `event` memories [`MemoryStore::unused_event_memories`]
/// returns.
#[derive(Debug, Clone, Copy)]
pub struct UnusedEventQuery<'a> {
    /// Unix ms. A row qualifies only when it was saved before this and recall
    /// tracking had started before this too: a zero recall count says nothing
    /// about the time before the database counted recalls.
    pub idle_before: i64,
    /// Only rows this user owns (`user_id`), or every owner when `None`.
    pub owner_user_id: Option<&'a str>,
    /// Leave out rows this user may not be asked to archive again: see
    /// [`MemoryStore::archive_blocked_targets`].
    pub archive_owner: &'a str,
    /// Most rows returned, capped at [`MAX_MEMORY_QUERY_LIMIT`].
    pub limit: usize,
}

impl MemoryStore {
    /// Active `event` memories the caller can see that no turn has recalled
    /// since they were saved, oldest first: saved and tracked since before
    /// `query.idle_before`, owned by `query.owner_user_id` when set, and not
    /// blocked from an archive proposal for `query.archive_owner`. The limit
    /// applies to these candidates, not to all events, so an old candidate is
    /// never hidden behind newer or ineligible rows. Without
    /// `include_sensitive`, special-category rows are skipped and the next
    /// candidates take their place.
    pub async fn unused_event_memories(
        &self,
        query: &UnusedEventQuery<'_>,
        vis: MemoryVisibility<'_>,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = query.limit.min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 || self.access_tracking_started_at().await? >= query.idle_before {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id, recall_count, last_recalled_at
             FROM memory_entries
             WHERE lifecycle = 'active'
               AND category = 'event'
               AND COALESCE(recall_count, 0) = 0
               AND last_recalled_at IS NULL
               AND created_at < :idle_before
               AND (:owner IS NULL OR user_id = :owner)
               AND {MEMORY_VISIBLE_PREDICATE}
               AND NOT EXISTS (
                   SELECT 1 FROM memory_proposals p
                   WHERE p.target_memory_id = memory_entries.id
                     AND {ARCHIVE_BLOCKING_PROPOSAL})
             ORDER BY created_at ASC, rowid ASC
             LIMIT :limit OFFSET :offset"
        );
        let page_size = if include_sensitive {
            limit
        } else {
            UNUSED_EVENT_PAGE
        };
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(limit);
        while entries.len() < limit {
            let rows = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(&sql)?;
                Self::collect_rows(
                    &mut stmt,
                    rusqlite::named_params! {
                        ":idle_before": query.idle_before,
                        ":owner": query.owner_user_id,
                        ":archive_owner": query.archive_owner,
                        ":bound": i64::from(vis.node_bound),
                        ":uid": vis.caller_user_id,
                        ":org": vis.caller_org_id,
                        ":limit": page_size as i64,
                        ":offset": offset as i64,
                    },
                )
                .context("listing unused event memories")?
            };
            if rows.is_empty() {
                break;
            }
            offset += rows.len();
            entries.extend(
                self.decrypt_rows(rows)
                    .into_iter()
                    .filter(|entry| include_sensitive || entry.sensitive_topics.is_empty()),
            );
        }
        entries.truncate(limit);
        Ok(entries)
    }

    /// The ids among `target_ids` that must not get a new archive proposal for
    /// `owner_user_id`: those with a proposal of any kind still waiting for
    /// review, or an archive the owner rejected or rolled back. A lookup by
    /// target, so a decline is remembered however many proposals came after it.
    pub async fn archive_blocked_targets(
        &self,
        owner_user_id: &str,
        target_ids: &[String],
    ) -> Result<HashSet<String>> {
        let mut blocked = HashSet::new();
        let conn = self.conn.lock().await;
        for chunk in target_ids.chunks(BLOCKED_TARGET_CHUNK) {
            let placeholders = (2..=chunk.len() + 1)
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT DISTINCT p.target_memory_id FROM memory_proposals p
                 WHERE p.target_memory_id IN ({placeholders})
                   AND {}",
                ARCHIVE_BLOCKING_PROPOSAL.replace(":archive_owner", "?1")
            );
            let values = std::iter::once(Value::Text(owner_user_id.to_owned()))
                .chain(chunk.iter().map(|id| Value::Text(id.clone())));
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt
                .query_map(params_from_iter(values), |row| row.get::<_, String>(0))
                .context("reading archive-blocked memory targets")?;
            for row in rows {
                blocked.insert(row?);
            }
        }
        Ok(blocked)
    }
}
