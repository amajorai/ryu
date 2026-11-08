//! Scoped, consent-gated recall of long-term facts for prompt assembly.

use anyhow::Result;
use rusqlite::params;

use crate::visibility::MEMORY_VISIBLE_PREDICATE;
use crate::{LongTermEntry, MemoryScope, MemoryStore, MemoryVisibility, MAX_MEMORY_QUERY_LIMIT};

impl MemoryStore {
    /// Recall the most recent `limit` long-term entries for `(user_id, agent_id)`,
    /// newest first. Back-compat recency path (agent-scoped); the level-aware
    /// recall is [`recall_scoped`](Self::recall_scoped).
    pub async fn recall(
        &self,
        user_id: &str,
        agent_id: &str,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        self.recall_with_sensitive(user_id, agent_id, limit, true)
            .await
    }

    /// Recall recent entries while applying the sensitive-topic consent gate.
    /// The legacy `recall` method remains an unrestricted crate-level primitive;
    /// Core chat paths use this method with the caller's resolved consent.
    pub async fn recall_with_sensitive(
        &self,
        user_id: &str,
        agent_id: &str,
        limit: usize,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }

        // Sensitive classification lives inside the encrypted payload, so it
        // cannot be expressed in the SQL WHERE clause. Page through the source
        // rows until the caller has `limit` visible facts; a fixed multiplier
        // would return too few (or no) ordinary facts when many sensitive facts
        // happen to be newer.
        let page_size = if include_sensitive { limit } else { 128 };
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(limit);
        loop {
            let rows = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(
                    "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                            category, importance, tags, agent_id, updated_at, user_id,
                            lifecycle, supersedes_id
                     FROM memory_entries
                     WHERE user_id = ?1 AND agent_id = ?2 AND lifecycle = 'active'
                     ORDER BY created_at DESC, rowid DESC
                     LIMIT ?3 OFFSET ?4",
                )?;
                Self::collect_rows(
                    &mut stmt,
                    params![user_id, agent_id, page_size as i64, offset as i64],
                )?
            };
            let row_count = rows.len();
            if row_count == 0 {
                break;
            }
            offset += row_count;
            let page = self.decrypt_rows(rows);
            if include_sensitive {
                entries = page;
                break;
            }
            entries.extend(
                page.into_iter()
                    .filter(|entry| entry.sensitive_topics.is_empty()),
            );
            if entries.len() >= limit {
                break;
            }
        }
        entries.truncate(limit);
        Ok(entries)
    }

    /// Recall recent entries visible to an agent granted `read_levels`, within the
    /// active `project_id`/`agent_id`. Ordered by importance then recency. When
    /// `read_levels` is empty all personal levels are visible.
    /// Project- and agent-scoped facts are only returned when their `scope_id`
    /// matches the active project or agent.
    pub async fn recall_scoped(
        &self,
        read_levels: &[MemoryScope],
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        self.recall_scoped_for_agent(read_levels, None, project_id, limit)
            .await
    }

    /// Recall recent entries across the requested levels, including the narrow
    /// `agent` level when `agent_id` matches its `scope_id`.
    pub async fn recall_scoped_for_agent(
        &self,
        read_levels: &[MemoryScope],
        agent_id: Option<&str>,
        project_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        let levels = Self::effective_levels(read_levels);
        // Inline the level set as quoted literals. Values come from
        // `MemoryScope::as_str()` (a closed set of `'agent'/'user'/'node'/'project'/'org'`), so
        // this is injection-safe and avoids depending on the json1 extension.
        let level_list = levels
            .iter()
            .map(|l| format!("'{}'", l.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id
             FROM memory_entries
             WHERE scope IN ({level_list}) AND lifecycle = 'active'
               AND (scope != 'agent' OR (?1 IS NOT NULL AND scope_id = ?1))
               AND (scope != 'project' OR (?2 IS NOT NULL AND scope_id = ?2))
             ORDER BY importance DESC, created_at DESC, rowid DESC
             LIMIT ?3"
        );
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(&sql)?;
            Self::collect_rows(&mut stmt, params![agent_id, project_id, limit as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// Recall entries across the requested levels while applying the caller's
    /// node-tenancy visibility and sensitive-topic consent, most important
    /// first and then newest first (the same ranking as
    /// [`Self::recall_scoped_for_agent`]), so a small limit keeps the facts the
    /// user marked as mattering most rather than only the latest. This is
    /// the source-store counterpart to the retrieval layer's memory filters:
    /// recency context must not bypass an agent's read levels, active project,
    /// owner, or organization boundary merely because it is assembled before
    /// vector/graph retrieval.
    pub async fn recall_visible_scoped_for_agent(
        &self,
        user_id: &str,
        read_levels: &[MemoryScope],
        agent_id: Option<&str>,
        project_id: Option<&str>,
        visibility: MemoryVisibility<'_>,
        limit: usize,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let levels = Self::effective_levels(read_levels);
        // Values come from the closed MemoryScope enum, so inlining the level
        // literals is injection-safe and keeps this query independent of json1.
        let level_list = levels
            .iter()
            .map(|level| format!("'{}'", level.as_str()))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id
             FROM memory_entries
             WHERE scope IN ({level_list})
               AND lifecycle = 'active'
               AND (scope != 'agent' OR (:agent IS NOT NULL AND scope_id = :agent))
               AND (scope != 'project' OR (:project IS NOT NULL AND scope_id = :project))
               AND (:bound = 1 OR user_id = :owner)
               AND {MEMORY_VISIBLE_PREDICATE}
             ORDER BY importance DESC, created_at DESC, rowid DESC
             LIMIT :limit OFFSET :offset"
        );
        // Sensitive classification is encrypted, so page through source rows
        // until the caller has enough non-sensitive entries instead of allowing
        // newer sensitive rows to starve ordinary context.
        let page_size = if include_sensitive { limit } else { 128 };
        let mut offset = 0usize;
        let mut entries = Vec::with_capacity(limit);
        loop {
            let rows = {
                let conn = self.conn.lock().await;
                let mut stmt = conn.prepare(&sql)?;
                Self::collect_rows(
                    &mut stmt,
                    rusqlite::named_params! {
                        ":owner": user_id,
                        ":agent": agent_id,
                        ":project": project_id,
                        ":bound": i64::from(visibility.node_bound),
                        ":uid": visibility.caller_user_id,
                        ":org": visibility.caller_org_id,
                        ":limit": page_size as i64,
                        ":offset": offset as i64,
                    },
                )?
            };
            let row_count = rows.len();
            if row_count == 0 {
                break;
            }
            offset += row_count;
            let page = self.decrypt_rows(rows);
            if include_sensitive {
                entries = page;
                break;
            }
            entries.extend(
                page.into_iter()
                    .filter(|entry| entry.sensitive_topics.is_empty()),
            );
            if entries.len() >= limit {
                break;
            }
        }
        entries.truncate(limit);
        Ok(entries)
    }

    /// Empty `read_levels` means the four PERSONAL levels (unconfigured agent).
    ///
    /// [`MemoryScope::Org`] is deliberately excluded from this default. Every agent
    /// created before org scope existed has an empty slot, so including it would
    /// silently hand every one of them read access to organization-wide memory the
    /// moment the variant shipped — a privacy default change disguised as a schema
    /// addition. An agent must name `org` in its `read_levels` to see org facts.
    pub(crate) fn effective_levels(read_levels: &[MemoryScope]) -> Vec<MemoryScope> {
        if read_levels.is_empty() {
            vec![
                MemoryScope::Agent,
                MemoryScope::User,
                MemoryScope::Node,
                MemoryScope::Project,
            ]
        } else {
            read_levels.to_vec()
        }
    }
}
