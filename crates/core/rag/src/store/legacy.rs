//! One-time migrations of rows written by older builds: legacy OKF ids and owner backfills.

use super::*;

impl RetrievalStore {
    /// Give OKF rows written before sealing a blind chunk id and blind
    /// `concept_path_bi`, sealing their content, vector and metadata under the
    /// new id (opened with the old id's context, sealed with the new one, in
    /// Rust). Idempotent: rows already in the new form are skipped. Rows whose
    /// sealed values do not open are counted and left alone.
    pub(crate) fn seal_legacy_okf_ids(conn: &Connection, keys: &RetrievalKeys) -> Result<()> {
        struct LegacyOkf {
            chunk_id: String,
            bundle_id: String,
            concept_path: String,
            okf_type: String,
            tags: String,
            resource: Option<String>,
            links: String,
            chunk_index: i64,
            bi: Option<String>,
        }
        let rows: Vec<LegacyOkf> = {
            let mut stmt = conn.prepare(
                "SELECT chunk_id, bundle_id, concept_path, tags, resource, links, chunk_index,
                        concept_path_bi, okf_type
                 FROM okf_chunks",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(LegacyOkf {
                    chunk_id: row.get(0)?,
                    bundle_id: row.get(1)?,
                    concept_path: row.get(2)?,
                    tags: row.get(3)?,
                    resource: row.get(4)?,
                    links: row.get(5)?,
                    chunk_index: row.get(6)?,
                    bi: row.get(7)?,
                    okf_type: row.get(8)?,
                })
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let cipher = &keys.cipher;
        let mut renamed = 0usize;
        let mut unreadable = 0usize;
        for row in rows {
            let open = |column: &str, value: &str| {
                cipher.open_text(value, &okf_context(column, &row.chunk_id))
            };
            let opened = (|| -> Result<(String, String, Option<String>, String)> {
                Ok((
                    open("concept_path", &row.concept_path)?.value,
                    open("tags", &row.tags)?.value,
                    row.resource
                        .as_deref()
                        .map(|value| open("resource", value).map(|o| o.value))
                        .transpose()?,
                    open("links", &row.links)?.value,
                ))
            })();
            let Ok((concept_path, tags, resource, links)) = opened else {
                unreadable += 1;
                continue;
            };
            let token = keys.concept_token(&concept_path);
            let new_id = okf_chunk_id(
                &row.bundle_id,
                &token,
                usize::try_from(row.chunk_index.max(0)).unwrap_or(0),
            );
            if new_id == row.chunk_id && row.bi.as_deref() == Some(token.as_str()) {
                continue;
            }
            let tx = conn.unchecked_transaction()?;
            if new_id != row.chunk_id {
                let chunk: Option<(String, Vec<u8>, String)> = tx
                    .query_row(
                        "SELECT content, embedding, embedding_model FROM chunks WHERE id = ?1",
                        params![row.chunk_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                if let Some((content, embedding, model)) = chunk {
                    let opened = cipher
                        .open_text(&content, &content_context(&row.chunk_id))
                        .and_then(|c| {
                            let e = cipher.open_bytes(
                                &embedding,
                                &embedding_context(&row.chunk_id, &model),
                            )?;
                            Ok((c.value, e.value))
                        });
                    let Ok((content, embedding)) = opened else {
                        unreadable += 1;
                        continue;
                    };
                    tx.execute(
                        "INSERT OR REPLACE INTO chunks
                            (id, source, space_id, content, embedding, embedding_model, created_at,
                             mem_scope, mem_scope_id, mem_agent_id, mem_category, mem_importance,
                             mem_sensitive, mem_metadata_ready, owner_user_id, owner_org_id, visibility)
                         SELECT ?1, source, space_id, ?2, ?3, embedding_model, created_at,
                             mem_scope, mem_scope_id, mem_agent_id, mem_category, mem_importance,
                             mem_sensitive, mem_metadata_ready, owner_user_id, owner_org_id, visibility
                         FROM chunks WHERE id = ?4",
                        params![
                            new_id,
                            cipher.seal_text(&content, &content_context(&new_id))?,
                            cipher.seal_bytes(&embedding, &embedding_context(&new_id, &model))?,
                            row.chunk_id
                        ],
                    )?;
                    tx.execute("DELETE FROM chunks WHERE id = ?1", params![row.chunk_id])?;
                }
            }
            tx.execute(
                "DELETE FROM okf_chunks WHERE chunk_id = ?1",
                params![row.chunk_id],
            )?;
            tx.execute(
                "INSERT OR REPLACE INTO okf_chunks
                    (chunk_id, bundle_id, concept_path, okf_type, tags, resource, links,
                     chunk_index, concept_path_bi)
                 VALUES (?1, ?2, ?3, ?9, ?4, ?5, ?6, ?7, ?8)",
                params![
                    new_id,
                    row.bundle_id,
                    cipher.seal_text(&concept_path, &okf_context("concept_path", &new_id))?,
                    cipher.seal_text(&tags, &okf_context("tags", &new_id))?,
                    resource
                        .as_deref()
                        .map(|value| cipher.seal_text(value, &okf_context("resource", &new_id)))
                        .transpose()?,
                    cipher.seal_text(&links, &okf_context("links", &new_id))?,
                    row.chunk_index,
                    token,
                    row.okf_type,
                ],
            )?;
            tx.commit()?;
            renamed += 1;
        }
        if renamed > 0 || unreadable > 0 {
            tracing::info!(
                renamed,
                unreadable,
                "retrieval store: sealed legacy OKF rows"
            );
        }
        Ok(())
    }

    /// Attribute pre-tenancy MEMORY chunks to the local owner once the node binds —
    /// the retrieval twin of `MemoryStore::backfill` / `ConversationStore::backfill_tenancy`.
    ///
    /// Memory chunks indexed before the `owner_user_id` denorm existed carry NULL
    /// (or the pre-attribution `'local'` sentinel, mirrored from `memory_entries`).
    /// On a bound node the user-scope tenancy filter would then hide them from their
    /// real owner (a lockout). This stamps them to the local vault owner. `owner` is
    /// `None` on an unbound node (or a bound node with no signed-in account) →
    /// return immediately without marking, byte-identical. Idempotent via a marker
    /// row in a dedicated `retrieval_meta` table.
    pub(crate) fn backfill_memory_owner(
        conn: &Connection,
        owner: Option<(String, String)>,
    ) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS retrieval_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating retrieval_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM retrieval_meta WHERE key = 'mem_owner_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        // Unbound (personal) node, or bound node with no signed-in account: chunks
        // stay unattributed, by design. Not marked.
        let Some((owner, org_id)) = owner else {
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE chunks SET owner_user_id = ?1, owner_org_id = ?2
                 WHERE source = 'memory'
                   AND (owner_user_id IS NULL OR owner_user_id = 'local')",
                params![owner, org_id],
            )
            .context("backfilling retrieval memory-chunk owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO retrieval_meta (key, value) VALUES ('mem_owner_backfill_v1', ?1)",
            params![owner],
        )?;
        tracing::info!("retrieval memory-owner backfill: attributed {claimed} memory chunk(s)");
        Ok(())
    }

    /// Attribute pre-tenancy OKF SPACE chunks to the node's org once the node
    /// binds — the twin of [`Self::backfill_memory_owner`] for `ChunkSource::Space`.
    ///
    /// OKF chunks ingested before the `owner_org_id`/`visibility` denorm existed
    /// carry NULL/NULL (the old "bare unowned = shared" fallback `space_tenancy_allows`
    /// used to honor). Under the fail-closed default a bare-unowned chunk is now
    /// HIDDEN, so this stamps every unowned chunk that [`ingest_okf_bundle`]
    /// actually produced (identified via its `okf_chunks` sidecar row — the only
    /// reliable signal that a NULL-owner Space chunk is genuinely OKF/node-shared
    /// rather than a legacy manually-indexed chunk of unknown provenance) to the
    /// node's org at `visibility = "org"`. Non-OKF unowned Space chunks are left
    /// alone — deliberately fail-closed, exactly as the memory backfill fails
    /// closed for a bound node with no resolvable account. `owner` is `None` on an
    /// unbound node (or bound with no signed-in account) → skip, byte-identical.
    /// Idempotent via its own marker row in `retrieval_meta`.
    pub(crate) fn backfill_okf_space_owner(
        conn: &Connection,
        owner: Option<(String, String)>,
    ) -> Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS retrieval_meta (key TEXT PRIMARY KEY, value TEXT)",
        )
        .context("creating retrieval_meta")?;
        let done: Option<String> = conn
            .query_row(
                "SELECT value FROM retrieval_meta WHERE key = 'okf_owner_backfill_v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        if done.is_some() {
            return Ok(());
        }
        let Some((_, org_id)) = owner else {
            return Ok(());
        };
        let claimed = conn
            .execute(
                "UPDATE chunks SET owner_org_id = ?1, visibility = 'org'
                 WHERE source = 'space'
                   AND owner_user_id IS NULL
                   AND owner_org_id IS NULL
                   AND id IN (SELECT chunk_id FROM okf_chunks)",
                params![org_id],
            )
            .context("backfilling retrieval OKF space-chunk owner")?;
        conn.execute(
            "INSERT OR REPLACE INTO retrieval_meta (key, value) VALUES ('okf_owner_backfill_v1', ?1)",
            params![org_id],
        )?;
        tracing::info!("retrieval OKF space-owner backfill: attributed {claimed} chunk(s)");
        Ok(())
    }
}
