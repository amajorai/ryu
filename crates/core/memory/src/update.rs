//! In-place partial updates of an active long-term fact.

use anyhow::{Context, Result};
use rusqlite::params;

use crate::crypto::{encode_payload, encode_tags};
use crate::{
    detect_sensitive_topics, now_millis, LongTermEntry, MemoryLifecycle, MemoryPatch, MemoryScope,
    MemoryStore,
};

impl MemoryStore {
    /// Apply a partial update to an entry. Returns the updated entry, or `None`
    /// when the id does not exist, is no longer active, or was changed by another
    /// writer between this call's read and its write.
    pub async fn update(&self, id: &str, patch: MemoryPatch) -> Result<Option<LongTermEntry>> {
        let Some(existing) = self.get(id).await? else {
            return Ok(None);
        };
        self.update_from(existing, patch).await
    }

    /// Write `patch` over `existing`, a snapshot read earlier. The write is
    /// conditional on the row still being active at the snapshot's `updated_at`,
    /// so a concurrent supersede, retraction, or edit wins and this returns
    /// `None` instead of silently overwriting it (a lost update).
    pub(crate) async fn update_from(
        &self,
        existing: LongTermEntry,
        patch: MemoryPatch,
    ) -> Result<Option<LongTermEntry>> {
        let id = existing.id.clone();
        if existing.lifecycle != MemoryLifecycle::Active {
            // Revisions and retractions are immutable audit records. Updating one
            // in place would let a stale retrieval/index request resurrect it or
            // mutate the history that rollback relies on.
            return Ok(None);
        }
        let content = patch.content.unwrap_or(existing.content);
        let when_to_use = match patch.when_to_use {
            Some(w) => w,
            None => existing.when_to_use,
        };
        let scope = patch.scope.unwrap_or(existing.scope);
        let scope_id = match patch.scope_id {
            Some(s) => s,
            None => existing.scope_id,
        };
        if matches!(
            scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && scope_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            anyhow::bail!("an agent-, project-, or org-scope memory requires a scope_id");
        }
        let category = patch.category.unwrap_or(existing.category);
        let importance = patch.importance.unwrap_or(existing.importance).clamp(1, 5);
        let tags = patch.tags.unwrap_or(existing.tags);

        let when = when_to_use
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let sensitive_topics = detect_sensitive_topics(content.trim());
        if !sensitive_topics.is_empty() && scope != MemoryScope::User {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        let (nonce, ciphertext) = self.encrypt(&encode_payload(
            content.trim(),
            when,
            &existing.provenance,
            &sensitive_topics,
        ))?;
        // `updated_at` is the row's version: it must strictly increase so a
        // second write in the same millisecond still invalidates older snapshots.
        let expected_updated_at = existing.updated_at;
        let now = now_millis().max(expected_updated_at.saturating_add(1));
        let changed = {
            let conn = self.conn.lock().await;
            // Legacy rows store `updated_at = 0` and are read back as
            // `created_at`, so compare against the same effective value.
            conn.execute(
                "UPDATE memory_entries
                 SET nonce = ?1, ciphertext = ?2, scope = ?3, scope_id = ?4,
                     category = ?5, importance = ?6, tags = ?7, updated_at = ?8
                 WHERE id = ?9 AND lifecycle = 'active'
                   AND (CASE WHEN updated_at = 0 THEN created_at ELSE updated_at END) = ?10",
                params![
                    nonce,
                    ciphertext,
                    scope.as_str(),
                    scope_id,
                    category.as_str(),
                    importance,
                    encode_tags(&tags),
                    now,
                    id,
                    expected_updated_at,
                ],
            )
            .context("updating memory entry")?
        };
        if changed == 0 {
            return Ok(None);
        }
        self.get(&id).await
    }
}
