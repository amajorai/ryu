//! Recording long-term facts.

use anyhow::{Context, Result};
use rusqlite::params;

use crate::crypto::{encode_payload, encode_tags};
use crate::{
    detect_sensitive_topics, now_millis, MemoryMetadata, MemoryScope, MemoryStore, NewMemory,
};

impl MemoryStore {
    /// Record a plain long-term memory entry for `(user_id, agent_id)`, at
    /// user-level with default classification. Content is encrypted before it
    /// touches disk. Empty content is ignored. Back-compat entry point; richer
    /// captures use [`record_full`](Self::record_full).
    pub async fn record(
        &self,
        user_id: &str,
        agent_id: &str,
        content: &str,
    ) -> Result<Option<String>> {
        let mut mem = NewMemory::user_fact(content);
        mem.author_agent_id = Some(agent_id.to_string());
        self.record_full(user_id, agent_id, mem).await
    }

    /// Record a fully-classified long-term fact. Empty content is ignored.
    pub async fn record_full(
        &self,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
    ) -> Result<Option<String>> {
        self.record_full_with_metadata(user_id, agent_id, mem, MemoryMetadata::default())
            .await
    }

    /// Record a fully-classified fact with provenance/lifecycle metadata. This is
    /// the additive path used by reviewed consolidation; legacy callers continue
    /// through [`Self::record_full`] and receive active, user-sourced metadata.
    pub async fn record_full_with_metadata(
        &self,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
        metadata: MemoryMetadata,
    ) -> Result<Option<String>> {
        let id = uuid::Uuid::new_v4().to_string();
        self.record_full_with_id_and_metadata(&id, user_id, agent_id, mem, metadata)
            .await
    }

    /// Record a fully-classified fact under a caller-provided stable id. This is
    /// used by compatibility APIs whose contract is idempotent re-indexing; the
    /// normal memory-authoring path should continue using [`Self::record_full`].
    pub async fn record_full_with_id(
        &self,
        id: &str,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
    ) -> Result<Option<String>> {
        self.record_full_with_id_and_metadata(id, user_id, agent_id, mem, MemoryMetadata::default())
            .await
    }

    async fn record_full_with_id_and_metadata(
        &self,
        id: &str,
        user_id: &str,
        agent_id: &str,
        mem: NewMemory,
        metadata: MemoryMetadata,
    ) -> Result<Option<String>> {
        let id = id.trim();
        if id.is_empty() {
            anyhow::bail!("a memory id cannot be empty");
        }
        let trimmed = mem.content.trim();
        if trimmed.is_empty() {
            return Ok(None);
        }
        // Agent/project/org-scoped facts are read back by matching `scope_id`
        // against the active qualifier. A missing qualifier would be a silent
        // black hole rather than an error, so refuse it at the write instead.
        if matches!(
            mem.scope,
            MemoryScope::Agent | MemoryScope::Project | MemoryScope::Org
        ) && mem
            .scope_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_none()
        {
            anyhow::bail!(
                "an agent-, project-, or org-scope memory requires a scope_id; without one \
                 the fact would be readable by nobody"
            );
        }
        let sensitive_topics = detect_sensitive_topics(trimmed);
        if !sensitive_topics.is_empty() && mem.scope != MemoryScope::User {
            anyhow::bail!(
                "sensitive memory must use user scope; shared and agent scopes are not supported"
            );
        }
        let when = mem
            .when_to_use
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty());
        let (nonce, ciphertext) = self.encrypt(&encode_payload(
            trimmed,
            when,
            &metadata.provenance,
            &sensitive_topics,
        ))?;
        let now = now_millis();
        let importance = mem.importance.clamp(1, 5);
        let tags = encode_tags(&mem.tags);
        let conn = self.conn.lock().await;
        conn.execute(
            "INSERT INTO memory_entries
                (id, user_id, agent_id, nonce, ciphertext, created_at,
                 scope, scope_id, category, importance, tags, updated_at,
                 lifecycle, supersedes_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                id,
                user_id,
                agent_id,
                nonce,
                ciphertext,
                now,
                mem.scope.as_str(),
                mem.scope_id,
                mem.category.as_str(),
                importance,
                tags,
                now,
                metadata.lifecycle.as_str(),
                metadata.supersedes_id,
            ],
        )
        .context("inserting memory entry")?;
        Ok(Some(id.to_owned()))
    }
}
