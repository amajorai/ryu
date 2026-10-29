//! Indexing chunks (memory and Spaces) into the store.

use super::*;

impl RetrievalStore {
    /// Embed and index a chunk so it can be retrieved later. Re-indexing the
    /// same id replaces the previous content and embedding.
    pub async fn index_chunk(
        &self,
        id: &str,
        source: ChunkSource,
        space_id: Option<&str>,
        content: &str,
        owner: RetrievalOwner<'_>,
    ) -> Result<()> {
        self.index_chunk_with_metadata(id, source, space_id, content, owner, None)
            .await
    }

    /// [`Self::index_chunk`] plus a JSON metadata object that
    /// [`RetrievalOptions::filter`] can match. `metadata` must be an object of at
    /// most [`MAX_CHUNK_METADATA_BYTES`] serialized bytes; `None` stores none
    /// (and clears any metadata a previous index of the same id carried). The
    /// metadata is sealed at rest like the content it describes.
    pub async fn index_chunk_with_metadata(
        &self,
        id: &str,
        source: ChunkSource,
        space_id: Option<&str>,
        content: &str,
        owner: RetrievalOwner<'_>,
        metadata: Option<&serde_json::Value>,
    ) -> Result<()> {
        self.upsert_chunk(id, source, space_id, content, owner, metadata, "")
            .await
            .map(|_| ())
    }

    /// [`index_chunk`](Self::index_chunk) for a caller-supplied id
    /// (`POST /api/retrieval/index`). It never replaces a memory projection or
    /// an OKF bundle chunk, and only replaces an existing Space chunk with the
    /// same owner and org as `owner`. The guard runs inside the upsert, so there
    /// is no window between the check and the write. Returns `false` when the id
    /// is taken by a row the caller may not replace.
    pub async fn index_caller_space_chunk(
        &self,
        id: &str,
        space_id: Option<&str>,
        content: &str,
        owner: RetrievalOwner<'_>,
    ) -> Result<bool> {
        self.index_caller_space_chunk_with_metadata(id, space_id, content, owner, None)
            .await
    }

    /// [`index_caller_space_chunk`](Self::index_caller_space_chunk) plus the JSON
    /// metadata object of [`index_chunk_with_metadata`](Self::index_chunk_with_metadata).
    pub async fn index_caller_space_chunk_with_metadata(
        &self,
        id: &str,
        space_id: Option<&str>,
        content: &str,
        owner: RetrievalOwner<'_>,
        metadata: Option<&serde_json::Value>,
    ) -> Result<bool> {
        self.upsert_chunk(
            id,
            ChunkSource::Space,
            space_id,
            content,
            owner,
            metadata,
            " WHERE chunks.source = 'space'
                 AND chunks.id NOT LIKE 'okf:%'
                 AND NOT EXISTS (SELECT 1 FROM okf_chunks o WHERE o.chunk_id = chunks.id)
                 AND chunks.owner_user_id IS excluded.owner_user_id
                 AND chunks.owner_org_id IS excluded.owner_org_id",
        )
        .await
    }

    /// Shared upsert behind [`index_chunk`](Self::index_chunk). `conflict_guard`
    /// is a static `WHERE` clause on the `DO UPDATE` arm (empty = always
    /// replace). Returns whether a row was inserted or replaced.
    pub(crate) async fn upsert_chunk(
        &self,
        id: &str,
        source: ChunkSource,
        space_id: Option<&str>,
        content: &str,
        owner: RetrievalOwner<'_>,
        metadata: Option<&serde_json::Value>,
        conflict_guard: &'static str,
    ) -> Result<bool> {
        self.ensure_writable()?;
        let metadata_json = match metadata {
            None | Some(serde_json::Value::Null) => None,
            Some(value @ serde_json::Value::Object(_)) => {
                let encoded = serde_json::to_string(value)?;
                anyhow::ensure!(
                    encoded.len() <= MAX_CHUNK_METADATA_BYTES,
                    "chunk metadata exceeds {MAX_CHUNK_METADATA_BYTES} bytes"
                );
                Some(encoded)
            }
            Some(_) => anyhow::bail!("chunk metadata must be a JSON object"),
        };
        let embedder = self.embedder_snapshot();
        let embedding = embedder.embed(content).await?;
        let model = embedder.model_id().to_string();
        let blob = self.keys.cipher.seal_bytes(
            &encode_embedding(&embedding),
            &embedding_context(id, &model),
        )?;
        let sealed_content = self.keys.cipher.seal_text(content, &content_context(id))?;
        let sealed_metadata = metadata_json
            .as_deref()
            .map(|encoded| self.keys.cipher.seal_text(encoded, &metadata_context(id)))
            .transpose()?;
        let now = chrono::Utc::now().timestamp_millis();
        let sql = format!(
            "INSERT INTO chunks
                (id, source, space_id, content, embedding, embedding_model, created_at,
                 mem_metadata_ready, owner_user_id, owner_org_id, visibility, metadata)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, CASE WHEN ?2 = 'memory' THEN 1 ELSE 0 END, ?8, ?9, ?10, ?11)
             ON CONFLICT(id) DO UPDATE SET
                source          = excluded.source,
                space_id        = excluded.space_id,
                content         = excluded.content,
                embedding       = excluded.embedding,
                embedding_model = excluded.embedding_model,
                created_at      = excluded.created_at,
                mem_metadata_ready = excluded.mem_metadata_ready,
                owner_user_id   = excluded.owner_user_id,
                 owner_org_id    = excluded.owner_org_id,
                 visibility      = excluded.visibility,
                 metadata        = excluded.metadata{conflict_guard}"
        );
        let conn = self.conn.lock().await;
        let previous = Self::partition_of(&conn, id)?;
        let changed = conn
            .execute(
                &sql,
                params![
                    id,
                    source.as_str(),
                    space_id,
                    sealed_content,
                    blob,
                    model,
                    now,
                    owner.user_id,
                    owner.org_id,
                    owner.visibility,
                    sealed_metadata,
                ],
            )
            .context("indexing chunk")?;
        if changed > 0 {
            self.place_vector(
                previous,
                &PartitionKey::new(&model, source.as_str(), space_id),
                id,
                &embedding,
            );
        }
        Ok(changed > 0)
    }

    /// Index a memory fact with its scope metadata so the level/project filter can
    /// run in-query. Same upsert semantics as [`index_chunk`](Self::index_chunk)
    /// but for `ChunkSource::Memory`, carrying `mem_scope`/`mem_scope_id`/
    /// `mem_category`/`mem_importance`.
    pub async fn index_memory_chunk(
        &self,
        id: &str,
        content: &str,
        scope: &str,
        scope_id: Option<&str>,
        category: &str,
        importance: i32,
        owner: RetrievalOwner<'_>,
    ) -> Result<()> {
        self.index_memory_chunk_with_metadata(
            id, content, scope, scope_id, category, importance, None, false, owner,
        )
        .await
    }

    /// Index a memory fact with the agent and sensitivity metadata needed by
    /// typed GraphRAG and server-side consent filtering. The legacy wrapper above
    /// remains for external callers that only have the original metadata.
    pub async fn index_memory_chunk_with_metadata(
        &self,
        id: &str,
        content: &str,
        scope: &str,
        scope_id: Option<&str>,
        category: &str,
        importance: i32,
        agent_id: Option<&str>,
        sensitive: bool,
        owner: RetrievalOwner<'_>,
    ) -> Result<()> {
        self.ensure_writable()?;
        let embedder = self.embedder_snapshot();
        let embedding = embedder.embed(content).await?;
        let model = embedder.model_id().to_string();
        let blob = self.keys.cipher.seal_bytes(
            &encode_embedding(&embedding),
            &embedding_context(id, &model),
        )?;
        let sealed_content = self.keys.cipher.seal_text(content, &content_context(id))?;
        let now = chrono::Utc::now().timestamp_millis();
        let conn = self.conn.lock().await;
        let previous = Self::partition_of(&conn, id)?;
        conn.execute(
            "INSERT INTO chunks
                (id, source, space_id, content, embedding, embedding_model, created_at,
                 mem_scope, mem_scope_id, mem_agent_id, mem_category, mem_importance, mem_sensitive,
                 mem_metadata_ready, owner_user_id, owner_org_id, visibility)
             VALUES (?1, 'memory', NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?13, NULL)
             ON CONFLICT(id) DO UPDATE SET
                 source          = 'memory',
                 space_id        = NULL,
                 content         = excluded.content,
                 embedding       = excluded.embedding,
                 embedding_model = excluded.embedding_model,
                 created_at      = excluded.created_at,
                 mem_scope       = excluded.mem_scope,
                 mem_scope_id    = excluded.mem_scope_id,
                 mem_agent_id    = excluded.mem_agent_id,
                 mem_category    = excluded.mem_category,
                 mem_importance  = excluded.mem_importance,
                 mem_sensitive   = excluded.mem_sensitive,
                 mem_metadata_ready = excluded.mem_metadata_ready,
                 owner_user_id   = excluded.owner_user_id,
                 owner_org_id    = excluded.owner_org_id",
            params![
                id,
                sealed_content,
                blob,
                model,
                now,
                scope,
                scope_id,
                agent_id,
                category,
                importance.clamp(1, 5),
                if sensitive { 1_i64 } else { 0_i64 },
                owner.user_id,
                owner.org_id,
            ],
        )
        .context("indexing memory chunk")?;
        self.place_vector(
            previous,
            &PartitionKey::new(&model, ChunkSource::Memory.as_str(), None),
            id,
            &embedding,
        );
        Ok(())
    }

    /// Refresh denormalized memory metadata without re-embedding the content.
    /// This repairs rows written before agent/sensitivity fields existed and keeps
    /// the retrieval copy aligned when a source fact changes classification.
    pub async fn update_memory_metadata(
        &self,
        id: &str,
        scope: &str,
        scope_id: Option<&str>,
        category: &str,
        importance: i32,
        agent_id: Option<&str>,
        sensitive: bool,
        owner: RetrievalOwner<'_>,
    ) -> Result<bool> {
        let conn = self.conn.lock().await;
        let updated = conn.execute(
            "UPDATE chunks
             SET mem_scope = ?1,
                 mem_scope_id = ?2,
                 mem_agent_id = ?3,
                 mem_category = ?4,
                 mem_importance = ?5,
                 mem_sensitive = ?6,
                 mem_metadata_ready = 1,
                 owner_user_id = ?7,
                 owner_org_id = ?8
             WHERE id = ?9 AND source = 'memory'",
            params![
                scope,
                scope_id,
                agent_id,
                category,
                importance.clamp(1, 5),
                if sensitive { 1_i64 } else { 0_i64 },
                owner.user_id,
                owner.org_id,
                id,
            ],
        )?;
        Ok(updated > 0)
    }
}
