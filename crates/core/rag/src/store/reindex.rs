//! Re-embedding chunks whose stored embedding model is stale.

use super::*;

impl RetrievalStore {
    /// Return the set of `Memory`-source chunk ids already indexed *under the
    /// current embedder*.
    ///
    /// Used by the auto-recall lazy-backfill (mirrors the message-index pattern):
    /// long-term memory facts are bridged into this store on demand so semantic
    /// search can find them, and this lets the backfill embed only NEW facts
    /// instead of re-embedding every fact each turn.
    ///
    /// The filter is `source = 'memory' AND embedding_model = <current>` — NOT just
    /// `source = 'memory'`. Vectors are only comparable within one embedder, and
    /// [`Self::score_candidates`] already filters retrieval to the current
    /// `embedding_model`. If "already indexed" ignored the model, a node that
    /// indexed facts under the local hashing embedder and then installed the embed
    /// server (model id changes) would have its old rows both skipped by backfill
    /// AND filtered out of retrieval — recreating the "semantic memory returns
    /// nothing" bug. Matching the load filter means an embedder swap re-backfills
    /// once (cheap; `index_chunk` upserts via ON CONFLICT).
    pub async fn indexed_memory_ids(&self) -> Result<std::collections::HashSet<String>> {
        let model = self.embedder_snapshot().model_id().to_string();
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT id FROM chunks WHERE source = 'memory' AND embedding_model = ?1")
            .context("preparing indexed-memory-ids query")?;
        let rows = stmt
            .query_map(params![model], |row| row.get::<_, String>(0))
            .context("querying indexed memory ids")?;
        let mut out = std::collections::HashSet::new();
        for row in rows {
            out.insert(row?);
        }
        Ok(out)
    }

    /// Re-embed chunks written by a different embedding model into the current
    /// model's vector space.
    ///
    /// Retrieval intentionally filters stale rows rather than mixing vectors
    /// from incomparable models. This bounded, resumable pass restores those
    /// rows after an embedder swap. Embedding is performed without holding the
    /// SQLite mutex; rows are committed in small batches, so a failed remote
    /// embed leaves the remaining stale rows available for a later retry.
    ///
    /// Returns the number of rows updated. Calling it when all rows already use
    /// the current model is a no-op.
    pub async fn reindex_stale_embeddings(&self) -> Result<usize> {
        let control = StaleEmbeddingReindexControl::new();
        Ok(self
            .reindex_stale_embeddings_with_control(&control)
            .await?
            .updated)
    }

    /// Re-embed stale rows with cooperative cancellation and observable progress.
    ///
    /// The existing [`Self::reindex_stale_embeddings`] method remains the
    /// compatibility entry point. Consumers that need a status/cancel surface
    /// create one [`StaleEmbeddingReindexControl`], pass a clone to their worker,
    /// and poll [`StaleEmbeddingReindexControl::progress`] from their status
    /// handler. Each committed batch is resumable; cancellation never commits a
    /// partially embedded batch.
    pub async fn reindex_stale_embeddings_with_control(
        &self,
        control: &StaleEmbeddingReindexControl,
    ) -> Result<StaleEmbeddingReindexOutcome> {
        let result = self
            .reindex_stale_embeddings_with_control_inner(control)
            .await;
        if let Err(error) = &result {
            let mut progress = control
                .progress
                .lock()
                .expect("stale embedding progress mutex poisoned");
            progress.state = "failed".to_owned();
            progress.error = Some(format!("{error:#}"));
        }
        result
    }

    pub(crate) async fn reindex_stale_embeddings_with_control_inner(
        &self,
        control: &StaleEmbeddingReindexControl,
    ) -> Result<StaleEmbeddingReindexOutcome> {
        const BATCH_SIZE: usize = 64;
        let embedder = self.embedder_snapshot();
        let model = embedder.model_id().to_string();
        let mut reindexed = 0;

        let total = {
            let conn = self.conn.lock().await;
            conn.query_row(
                "SELECT COUNT(*) FROM chunks WHERE embedding_model != ?1",
                params![model],
                |row| row.get::<_, i64>(0),
            )?
            .max(0) as usize
        };
        {
            let mut progress = control
                .progress
                .lock()
                .expect("stale embedding progress mutex poisoned");
            *progress = StaleEmbeddingReindexProgress {
                state: if control.is_cancelled() {
                    "cancelled".to_owned()
                } else {
                    "running".to_owned()
                },
                total,
                ..StaleEmbeddingReindexProgress::default()
            };
        }
        if control.is_cancelled() {
            return Ok(StaleEmbeddingReindexOutcome {
                updated: 0,
                cancelled: true,
            });
        }

        // One pass in id order: a row whose content changed while it was being
        // embedded, or whose sealed content does not open, is left stale for
        // the next pass instead of being selected again in this one.
        let mut cursor = String::new();
        loop {
            // (id, opened content, stored content as read, partition)
            let (batch, unreadable): (Vec<(String, String, String, PartitionKey)>, u64) = {
                let conn = self.conn.lock().await;
                let mut stmt = conn
                    .prepare(
                        "SELECT id, content, source, space_id FROM chunks
                         WHERE embedding_model != ?1 AND id > ?2
                         ORDER BY id
                         LIMIT ?3",
                    )
                    .context("preparing stale embedding scan")?;
                let rows = stmt.query_map(params![model, cursor, BATCH_SIZE as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })?;
                let mut batch = Vec::with_capacity(BATCH_SIZE);
                let mut unreadable = 0;
                for row in rows {
                    let (id, stored, source, space_id) = row?;
                    cursor.clone_from(&id);
                    match self.keys.cipher.open_text(&stored, &content_context(&id)) {
                        Ok(opened) => batch.push((
                            id,
                            opened.value,
                            stored,
                            PartitionKey::new(&model, &source, space_id.as_deref()),
                        )),
                        Err(_) => unreadable += 1,
                    }
                }
                (batch, unreadable)
            };
            self.note_unreadable(unreadable, "chunks");

            if batch.is_empty() && unreadable == 0 {
                let mut progress = control
                    .progress
                    .lock()
                    .expect("stale embedding progress mutex poisoned");
                progress.state = "completed".to_owned();
                progress.processed = progress.total;
                progress.updated = reindexed;
                return Ok(StaleEmbeddingReindexOutcome {
                    updated: reindexed,
                    cancelled: false,
                });
            }

            let batch_len = batch.len() + unreadable as usize;
            let mut embedded = Vec::with_capacity(batch.len());
            for group in batch.chunks(EMBED_BATCH_SIZE) {
                if control.is_cancelled() {
                    let mut progress = control
                        .progress
                        .lock()
                        .expect("stale embedding progress mutex poisoned");
                    progress.state = "cancelled".to_owned();
                    progress.updated = reindexed;
                    return Ok(StaleEmbeddingReindexOutcome {
                        updated: reindexed,
                        cancelled: true,
                    });
                }
                let contents: Vec<String> = group
                    .iter()
                    .map(|(_, content, _, _)| content.clone())
                    .collect();
                let vectors = embedder.embed_batch(&contents).await?;
                for ((id, _, stored, partition), vector) in group.iter().zip(vectors) {
                    embedded.push((id.clone(), stored.clone(), partition.clone(), vector));
                }
            }

            if control.is_cancelled() {
                let mut progress = control
                    .progress
                    .lock()
                    .expect("stale embedding progress mutex poisoned");
                progress.state = "cancelled".to_owned();
                progress.updated = reindexed;
                return Ok(StaleEmbeddingReindexOutcome {
                    updated: reindexed,
                    cancelled: true,
                });
            }

            let conn = self.conn.lock().await;
            let tx = conn
                .unchecked_transaction()
                .context("starting embedding reindex transaction")?;
            let mut placed = Vec::new();
            for (id, stored, partition, embedding) in &embedded {
                let changed = update_stale_embedding_if_unchanged(
                    &tx,
                    &self.keys.cipher,
                    id,
                    stored,
                    embedding,
                    &model,
                )?;
                if changed > 0 {
                    placed.push((id, partition, embedding));
                }
                reindexed += changed;
            }
            tx.commit().context("committing embedding reindex batch")?;
            drop(conn);
            for (id, partition, embedding) in placed {
                self.vectors.upsert(&partition.name(), id, embedding);
            }
            let mut progress = control
                .progress
                .lock()
                .expect("stale embedding progress mutex poisoned");
            progress.processed = (progress.processed + batch_len).min(progress.total);
            progress.updated = reindexed;
        }
    }
}

pub(crate) fn update_stale_embedding_if_unchanged(
    tx: &rusqlite::Transaction<'_>,
    cipher: &ContentCipher,
    id: &str,
    stored_content: &str,
    embedding: &[f32],
    model: &str,
) -> Result<usize> {
    // The content predicate is the optimistic-concurrency check. It compares the
    // STORED value read before embedding (sealed values carry a random nonce,
    // so a fresh seal of the same text would never match). A row edited while
    // the remote embedder was running stays stale and is picked up again by the
    // next pass instead of being incorrectly marked current.
    let sealed = cipher.seal_bytes(&encode_embedding(embedding), &embedding_context(id, model))?;
    Ok(tx.execute(
        "UPDATE chunks
         SET embedding = ?1, embedding_model = ?2
         WHERE id = ?3 AND content = ?4 AND embedding_model != ?2",
        params![sealed, model, id, stored_content],
    )?)
}
