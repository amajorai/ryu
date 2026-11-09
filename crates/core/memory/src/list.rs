//! Listing, lookup and counting of long-term facts. Deletion lives in
//! `delete`.

use anyhow::Result;
use rusqlite::params;

use crate::visibility::MEMORY_VISIBLE_PREDICATE;
use crate::{LongTermEntry, MemoryFilter, MemoryStore, MemoryVisibility, MAX_MEMORY_QUERY_LIMIT};

impl MemoryStore {
    /// Enumerate up to `limit` entries (all scopes) for backfilling the retrieval
    /// index; per-agent filtering happens at retrieve time.
    pub async fn all_for_backfill(&self, limit: usize) -> Result<Vec<LongTermEntry>> {
        self.all_for_backfill_page(limit, 0).await
    }

    /// Enumerate one stable page of active entries for a bounded backfill pass.
    /// The ordering matches [`Self::all_for_backfill`], so callers can walk past
    /// an already-indexed head and eventually reach older facts.
    pub async fn all_for_backfill_page(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = limit.min(MAX_MEMORY_QUERY_LIMIT);
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at, user_id,
                        lifecycle, supersedes_id, recall_count, last_recalled_at
                 FROM memory_entries
                 WHERE lifecycle = 'active'
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT ?1 OFFSET ?2",
            )?;
            Self::collect_rows(&mut stmt, params![limit as i64, offset as i64])?
        };
        Ok(self.decrypt_rows(rows))
    }

    /// List entries for the management UI, filtered and newest-first. **Unfiltered
    /// by tenancy** — the in-process / unbound full listing. See
    /// [`list_visible`](Self::list_visible) for the per-caller form.
    pub async fn list(&self, filter: &MemoryFilter) -> Result<Vec<LongTermEntry>> {
        self.list_visible(filter, MemoryVisibility::unrestricted())
            .await
    }

    /// List entries the caller may READ, applying [`MEMORY_VISIBLE_PREDICATE`].
    /// On an UNBOUND node this is byte-identical to [`list`](Self::list) (`:bound = 0`
    /// disables the owner filter). On a BOUND node a `user`-scope fact is returned
    /// only to its owner; `node`/`project`-scope facts stay visible to every member
    /// (the shared "company brain"); an `org`-scope fact is visible only to a caller
    /// whose org matches the fact's `scope_id`.
    pub async fn list_visible(
        &self,
        filter: &MemoryFilter,
        vis: MemoryVisibility<'_>,
    ) -> Result<Vec<LongTermEntry>> {
        self.list_visible_with_sensitive(filter, vis, true).await
    }

    /// List visible entries while omitting special-category facts unless the
    /// caller's current consent allows them. The source rows stay encrypted; the
    /// filter runs after decryption so legacy rows are classified conservatively.
    pub async fn list_visible_with_sensitive(
        &self,
        filter: &MemoryFilter,
        vis: MemoryVisibility<'_>,
        include_sensitive: bool,
    ) -> Result<Vec<LongTermEntry>> {
        let limit = filter
            .limit
            .unwrap_or(MAX_MEMORY_QUERY_LIMIT)
            .min(MAX_MEMORY_QUERY_LIMIT);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let sql = format!(
            "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                    category, importance, tags, agent_id, updated_at, user_id,
                    lifecycle, supersedes_id, recall_count, last_recalled_at
             FROM memory_entries
             WHERE (:scope IS NULL OR scope = :scope)
               AND (:scope_id IS NULL OR scope_id = :scope_id)
               AND (:category IS NULL OR category = :category)
               AND (:lifecycle IS NULL OR lifecycle = :lifecycle)
             AND {MEMORY_VISIBLE_PREDICATE}
             ORDER BY created_at DESC, rowid DESC
             LIMIT :limit OFFSET :offset"
        );
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
                        ":scope": filter.scope.map(|s| s.as_str()),
                        ":scope_id": filter.scope_id.as_deref(),
                        ":category": filter.category.map(|c| c.as_str()),
                        ":lifecycle": filter.lifecycle.map(|l| l.as_str()),
                        ":bound": i64::from(vis.node_bound),
                        ":uid": vis.caller_user_id,
                        ":org": vis.caller_org_id,
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

    /// Fetch a single entry by id.
    pub async fn get(&self, id: &str) -> Result<Option<LongTermEntry>> {
        let rows = {
            let conn = self.conn.lock().await;
            let mut stmt = conn.prepare(
                "SELECT id, nonce, ciphertext, created_at, scope, scope_id,
                        category, importance, tags, agent_id, updated_at, user_id,
                        lifecycle, supersedes_id, recall_count, last_recalled_at
                 FROM memory_entries WHERE id = ?1",
            )?;
            Self::collect_rows(&mut stmt, params![id])?
        };
        Ok(self.decrypt_rows(rows).into_iter().next())
    }

    /// The ids of every entry carrying `tag` (an exact element of the plaintext
    /// `tags` JSON array). The array is stored as `["a","b"]`, so a quoted-substring
    /// match is exact per element. Used to find (and then delete + un-index) the
    /// prior feedback-derived facts for a message before re-recording, so a changed
    /// or cleared thumbs vote never leaves contradictory facts. `tags` is a
    /// non-encrypted column, so this needs no decryption.
    pub async fn ids_with_tag(&self, tag: &str) -> Result<Vec<String>> {
        let needle = format!("%{}%", serde_json::Value::String(tag.to_string()));
        let conn = self.conn.lock().await;
        let mut stmt = conn.prepare("SELECT id FROM memory_entries WHERE tags LIKE ?1")?;
        let rows = stmt.query_map(params![needle], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Total number of stored long-term memory entries across every scope.
    /// Backs the danger-zone count preview.
    pub async fn count(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM memory_entries", [], |r| r.get(0))?;
        Ok(n.max(0) as u64)
    }
}
