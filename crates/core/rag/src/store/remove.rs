//! Removing chunks: whole OKF bundles, single chunks and memory clears.

use super::*;

impl RetrievalStore {
    /// Remove every chunk (and its metadata) that was ingested for `bundle_id`.
    /// Returns the number of metadata rows removed. Safe to call for an unknown
    /// bundle (no-op, returns 0).
    pub async fn remove_okf_bundle(&self, bundle_id: &str) -> Result<usize> {
        let conn = self.conn.lock().await;
        let tx = conn
            .unchecked_transaction()
            .context("opening okf remove transaction")?;
        tx.execute(
            "DELETE FROM chunks WHERE id IN (SELECT chunk_id FROM okf_chunks WHERE bundle_id = ?1)",
            params![bundle_id],
        )
        .context("deleting okf chunks")?;
        let removed = tx
            .execute(
                "DELETE FROM okf_chunks WHERE bundle_id = ?1",
                params![bundle_id],
            )
            .context("deleting okf metadata")?;
        tx.commit().context("committing okf removal")?;
        drop(conn);
        self.drop_partitions(|key| {
            key.source == ChunkSource::Space.as_str() && key.space_id.as_deref() == Some(bundle_id)
        });
        Ok(removed)
    }

    /// Remove a single indexed chunk by id (e.g. when a memory fact is deleted).
    /// Returns whether a row was removed. Safe to call for an unknown id.
    pub async fn remove_chunk(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock().await;
        let previous = Self::partition_of(&conn, id)?;
        let removed = conn.execute("DELETE FROM chunks WHERE id = ?1", params![id])?;
        if let Some(previous) = previous {
            self.vectors.remove(&previous.name(), id);
        }
        Ok(removed > 0)
    }

    /// Remove every derived memory chunk. The encrypted MemoryStore remains the
    /// authority; this clears only its vector/retrieval projection after a full
    /// memory wipe.
    pub async fn clear_memory_chunks(&self) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = conn.execute("DELETE FROM chunks WHERE source = 'memory'", [])?;
        drop(conn);
        self.drop_partitions(|key| key.source == ChunkSource::Memory.as_str());
        Ok(removed as u64)
    }

    /// Remove sensitive memory projections for one owner, or all sensitive
    /// memory projections when the node is unbound. This is used when consent
    /// is revoked; it is deliberately set-based so cleanup is not capped by a
    /// source-store page size.
    pub async fn clear_sensitive_memory_chunks(&self, owner_user_id: Option<&str>) -> Result<u64> {
        let conn = self.conn.lock().await;
        let removed = match owner_user_id {
            Some(owner) => conn.execute(
                "DELETE FROM chunks
                 WHERE source = 'memory' AND mem_sensitive = 1 AND owner_user_id = ?1",
                params![owner],
            )?,
            None => conn.execute(
                "DELETE FROM chunks WHERE source = 'memory' AND mem_sensitive = 1",
                [],
            )?,
        };
        drop(conn);
        if removed > 0 {
            self.drop_partitions(|key| key.source == ChunkSource::Memory.as_str());
        }
        Ok(removed as u64)
    }
}
