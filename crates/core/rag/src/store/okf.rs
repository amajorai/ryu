//! OKF bundle ingest, removal, links and concept reconstruction.

use super::*;

impl RetrievalStore {
    /// Ingest a parsed OKF [`Bundle`](ryu_knowledge::Bundle) into the retrieval
    /// index so an agent can read it as grounded knowledge.
    ///
    /// Each concept's body is chunked, embedded via the store's configured
    /// embedder (reusing the same path as [`index_chunk`](Self::index_chunk)),
    /// and indexed as `Space`-source chunks scoped to a synthetic space whose id
    /// is `bundle_id` — so the existing `space_ids` retrieval filter can target a
    /// single bundle. Alongside each chunk a row is written to `okf_chunks` with
    /// the filterable metadata `{ okf_type, tags, resource, source_bundle_id,
    /// concept_path }` plus the concept's cross-links (preserved as edges for
    /// progressive disclosure).
    ///
    /// **Idempotent on `concept_path`**: the call first removes any previously
    /// ingested chunks for `bundle_id` (via [`remove_okf_bundle`](Self::remove_okf_bundle)),
    /// then re-inserts. Re-ingesting an updated bundle therefore replaces stale
    /// chunks and drops concepts that no longer exist — no orphans accumulate.
    ///
    /// `org_id` is the installing node's registered org (`None` on an unbound
    /// node). OKF content has no single user owner, so every chunk is stamped
    /// `owner_user_id = NULL`, `owner_org_id = org_id`, `visibility = "org"` when
    /// bound — an EXPLICIT shared stamp `space_tenancy_allows` recognizes, rather
    /// than relying on a bare-unowned chunk being treated as shared (that fallback
    /// is fail-closed on a bound node; see the predicate's doc comment). `None`
    /// leaves the chunk fully unattributed, matching the unbound no-op.
    pub async fn ingest_okf_bundle(
        &self,
        bundle_id: &str,
        bundle: &ryu_knowledge::Bundle,
        org_id: Option<&str>,
    ) -> Result<OkfIngestSummary> {
        self.ingest_okf_bundle_with_chunking(bundle_id, bundle, org_id, &ChunkingStrategy::Default)
            .await
    }

    /// [`Self::ingest_okf_bundle`] with an explicit chunking strategy for concept
    /// bodies. [`ChunkingStrategy::Default`] is the historical OKF splitter, so
    /// the plain method is unchanged. Every chunk also stores filterable metadata
    /// (`okf_type`, `concept_path`, `tags`, plus the splitter's `header_path`)
    /// that [`RetrievalOptions::filter`] can match, sealed at rest.
    pub async fn ingest_okf_bundle_with_chunking(
        &self,
        bundle_id: &str,
        bundle: &ryu_knowledge::Bundle,
        org_id: Option<&str>,
        chunking: &ChunkingStrategy,
    ) -> Result<OkfIngestSummary> {
        self.ensure_writable()?;
        chunking.validate()?;
        // Re-index is a full replace: clear the prior generation first so removed
        // concepts and shrunk bodies do not leave orphaned chunks behind.
        self.remove_okf_bundle(bundle_id).await?;
        let cipher = &self.keys.cipher;

        // Embed every chunk up front (no DB lock held during network/CPU work),
        // then commit all rows in a single transaction.
        let mut rows: Vec<OkfRow> = Vec::new();
        let model = self.embedder_snapshot().model_id().to_string();
        let now = chrono::Utc::now().timestamp_millis();
        for concept in &bundle.concepts {
            let header = okf_chunk_header(concept);
            let tags_json =
                serde_json::to_string(&concept.tags).unwrap_or_else(|_| "[]".to_owned());
            let links: Vec<&str> = concept.links.iter().map(|l| l.target.as_str()).collect();
            let links_json = serde_json::to_string(&links).unwrap_or_else(|_| "[]".to_owned());
            let body_chunks: Vec<(String, Vec<String>)> = match chunking {
                ChunkingStrategy::Default => chunk_okf_body(&concept.body)
                    .into_iter()
                    .map(|chunk| (chunk, Vec::new()))
                    .collect(),
                strategy => splitter::split_text_with_embedder(
                    &concept.body,
                    strategy,
                    &self.embedder_snapshot(),
                )
                .await?
                .into_iter()
                .map(|chunk| (chunk.content, chunk.metadata.header_path))
                .collect(),
            };
            // The id carries the concept path's blind token, never the path.
            let concept_token = self.keys.concept_token(&concept.file_path);
            for (idx, (body_chunk, header_path)) in body_chunks.into_iter().enumerate() {
                let mut metadata = serde_json::json!({
                    "okf_type": concept.type_,
                    "concept_path": concept.file_path,
                    "tags": concept.tags,
                });
                if !header_path.is_empty() {
                    metadata["header_path"] = serde_json::json!(header_path);
                }
                // Prepend a header (title/type/description) so each chunk carries
                // enough context to be retrievable on its own.
                let content = if header.is_empty() {
                    body_chunk
                } else if body_chunk.is_empty() {
                    header.clone()
                } else {
                    format!("{header}\n{body_chunk}")
                };
                let embedding = self.embedder_snapshot().embed(&content).await?;
                let chunk_id = okf_chunk_id(bundle_id, &concept_token, idx);
                let blob = cipher.seal_bytes(
                    &encode_embedding(&embedding),
                    &embedding_context(&chunk_id, &model),
                )?;
                rows.push(OkfRow {
                    content: cipher.seal_text(&content, &content_context(&chunk_id))?,
                    blob,
                    concept_path: cipher
                        .seal_text(&concept.file_path, &okf_context("concept_path", &chunk_id))?,
                    concept_path_bi: concept_token.clone(),
                    okf_type: concept.type_.clone(),
                    tags_json: cipher.seal_text(&tags_json, &okf_context("tags", &chunk_id))?,
                    resource: concept
                        .resource
                        .as_deref()
                        .map(|value| cipher.seal_text(value, &okf_context("resource", &chunk_id)))
                        .transpose()?,
                    links_json: cipher.seal_text(&links_json, &okf_context("links", &chunk_id))?,
                    chunk_index: idx as i64,
                    // Filter metadata and the verbatim body carry the concept
                    // path, tags and body text: sealed like their columns.
                    metadata_json: cipher
                        .seal_text(&metadata.to_string(), &metadata_context(&chunk_id))?,
                    concept_body: (idx == 0 && *chunking != ChunkingStrategy::Default)
                        .then(|| {
                            cipher.seal_text(&concept.body, &okf_context("concept_body", &chunk_id))
                        })
                        .transpose()?,
                    chunk_id,
                });
            }
        }

        // No specific user owns OKF content; a bound-node install stamps the
        // installing node's org as an EXPLICIT shared visibility so the fail-closed
        // `space_tenancy_allows` still lets every member read it.
        let okf_visibility = org_id.map(|_| "org");
        let chunk_count = rows.len();
        let concept_count = bundle.concepts.len();
        let conn = self.conn.lock().await;
        let tx = conn
            .unchecked_transaction()
            .context("opening okf ingest transaction")?;
        // Idempotent on concept_path: replace any rows a concurrent ingest left
        // for these concepts (matched by blind token; the path itself is sealed).
        let concept_tokens: HashSet<&str> = rows
            .iter()
            .map(|row| row.concept_path_bi.as_str())
            .collect();
        for token in concept_tokens {
            tx.execute(
                "DELETE FROM chunks WHERE id IN (SELECT chunk_id FROM okf_chunks
                     WHERE bundle_id = ?1 AND concept_path_bi = ?2)",
                params![bundle_id, token],
            )
            .context("deleting re-ingested okf chunks")?;
            tx.execute(
                "DELETE FROM okf_chunks WHERE bundle_id = ?1 AND concept_path_bi = ?2",
                params![bundle_id, token],
            )
            .context("deleting re-ingested okf metadata")?;
        }
        for row in &rows {
            tx.execute(
                "INSERT INTO chunks
                    (id, source, space_id, content, embedding, embedding_model, created_at,
                     owner_org_id, visibility, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET
                     source          = excluded.source,
                     space_id        = excluded.space_id,
                     content         = excluded.content,
                     embedding       = excluded.embedding,
                     embedding_model = excluded.embedding_model,
                     created_at      = excluded.created_at,
                     owner_org_id    = excluded.owner_org_id,
                     visibility      = excluded.visibility,
                     metadata        = excluded.metadata",
                params![
                    row.chunk_id,
                    ChunkSource::Space.as_str(),
                    bundle_id,
                    row.content,
                    row.blob,
                    model,
                    now,
                    org_id,
                    okf_visibility,
                    row.metadata_json,
                ],
            )
            .context("indexing okf chunk")?;
            tx.execute(
                "INSERT INTO okf_chunks (chunk_id, bundle_id, concept_path, okf_type, tags, resource, links, chunk_index, concept_path_bi, concept_body)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(chunk_id) DO UPDATE SET
                     bundle_id    = excluded.bundle_id,
                     concept_path = excluded.concept_path,
                     okf_type     = excluded.okf_type,
                     tags         = excluded.tags,
                     resource     = excluded.resource,
                     links        = excluded.links,
                     chunk_index  = excluded.chunk_index,
                     concept_path_bi = excluded.concept_path_bi,
                     concept_body = excluded.concept_body",
                params![
                    row.chunk_id,
                    bundle_id,
                    row.concept_path,
                    row.okf_type,
                    row.tags_json,
                    row.resource,
                    row.links_json,
                    row.chunk_index,
                    row.concept_path_bi,
                    row.concept_body,
                ],
            )
            .context("indexing okf metadata")?;
        }
        tx.commit().context("committing okf ingest")?;
        drop(conn);
        // The bundle's partition rehydrates from the new rows on next use.
        self.drop_partitions(|key| {
            key.source == ChunkSource::Space.as_str() && key.space_id.as_deref() == Some(bundle_id)
        });

        Ok(OkfIngestSummary {
            bundle_id: bundle_id.to_owned(),
            concepts: concept_count,
            chunks: chunk_count,
        })
    }

    /// Return the cross-link edges preserved for a bundle: `(concept_path,
    /// link_target)` pairs, deduplicated, for progressive-disclosure traversal.
    pub async fn okf_links(&self, bundle_id: &str) -> Result<Vec<OkfEdge>> {
        // Concept paths and links are sealed: select the bundle's rows, open
        // them, and order and de-duplicate in Rust.
        let raw: Vec<(String, String, String, i64)> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn
                .prepare(
                    "SELECT chunk_id, concept_path, links, chunk_index
                     FROM okf_chunks WHERE bundle_id = ?1",
                )
                .context("preparing okf links query")?;
            let rows = stmt
                .query_map(params![bundle_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .context("querying okf links")?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let cipher = &self.keys.cipher;
        let mut opened = Vec::with_capacity(raw.len());
        let mut unreadable = 0;
        for (chunk_id, concept_path, links, chunk_index) in raw {
            let row = cipher
                .open_text(&concept_path, &okf_context("concept_path", &chunk_id))
                .and_then(|path| {
                    let links = cipher.open_text(&links, &okf_context("links", &chunk_id))?;
                    Ok((path.value, chunk_index, links.value))
                });
            match row {
                Ok(row) => opened.push(row),
                Err(_) => unreadable += 1,
            }
        }
        self.note_unreadable(unreadable, "OKF rows");
        opened.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (concept_path, _, links_json) in opened {
            let targets: Vec<String> = serde_json::from_str(&links_json).unwrap_or_default();
            for target in targets {
                if seen.insert((concept_path.clone(), target.clone())) {
                    out.push(OkfEdge {
                        concept_path: concept_path.clone(),
                        target,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Reconstruct the OKF concepts previously ingested under `bundle_id` so the
    /// bundle can be exported back to an OKF directory.
    ///
    /// Ingest stores each concept's body as one or more chunks, each prefixed
    /// with a context header (`{title} [{type}] {description}`). This reverses
    /// that: rows are grouped by `concept_path` (ordered by `chunk_index`), the
    /// per-chunk header is stripped, and the bodies are rejoined. `title` and
    /// `description` are recovered from the header; `type`, `tags`, `resource`,
    /// and cross-links come from the `okf_chunks` sidecar; `timestamp` from the
    /// chunk's `created_at`.
    ///
    /// This is **lossy by design**: the body is reassembled from normalized
    /// chunks (original paragraph and whitespace boundaries are not perfectly
    /// preserved) and only metadata the index retained survives. It is faithful
    /// enough to re-emit a shareable bundle, not byte-identical to the source.
    pub async fn reconstruct_okf_concepts(
        &self,
        bundle_id: &str,
    ) -> Result<Vec<ryu_knowledge::Concept>> {
        type RawExport = (String, OkfExportRow);
        let raw: Vec<RawExport> = {
            let conn = self.conn.lock().await;
            let mut stmt = conn
                .prepare(
                    "SELECT o.chunk_id, o.concept_path, o.okf_type, o.tags, o.resource, o.links,
                            c.content, c.created_at, o.chunk_index, o.concept_body
                     FROM okf_chunks o JOIN chunks c ON c.id = o.chunk_id
                     WHERE o.bundle_id = ?1",
                )
                .context("preparing okf export query")?;
            let rows = stmt
                .query_map(params![bundle_id], |row| {
                    Ok((
                        row.get(0)?,
                        OkfExportRow {
                            concept_path: row.get(1)?,
                            okf_type: row.get(2)?,
                            tags_json: row.get(3)?,
                            resource: row.get(4)?,
                            links_json: row.get(5)?,
                            content: row.get(6)?,
                            created_at: row.get(7)?,
                            chunk_index: row.get(8)?,
                            concept_body: row.get(9)?,
                        },
                    ))
                })
                .context("querying okf export rows")?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        // Sealed values are opened here; a row that does not open is skipped and
        // counted (one bad chunk never fails the whole export).
        let cipher = &self.keys.cipher;
        let mut rows = Vec::with_capacity(raw.len());
        let mut unreadable = 0;
        for (chunk_id, row) in raw {
            let open = |column: &str, value: &str| {
                cipher
                    .open_text(value, &okf_context(column, &chunk_id))
                    .map(|opened| opened.value)
            };
            let opened = (|| -> Result<OkfExportRow> {
                Ok(OkfExportRow {
                    concept_path: open("concept_path", &row.concept_path)?,
                    okf_type: row.okf_type.clone(),
                    tags_json: open("tags", &row.tags_json)?,
                    resource: row
                        .resource
                        .as_deref()
                        .map(|value| open("resource", value))
                        .transpose()?,
                    links_json: open("links", &row.links_json)?,
                    content: cipher
                        .open_text(&row.content, &content_context(&chunk_id))?
                        .value,
                    created_at: row.created_at,
                    chunk_index: row.chunk_index,
                    concept_body: row
                        .concept_body
                        .as_deref()
                        .map(|value| open("concept_body", value))
                        .transpose()?,
                })
            })();
            match opened {
                Ok(row) => rows.push(row),
                Err(_) => unreadable += 1,
            }
        }
        self.note_unreadable(unreadable, "OKF rows");
        rows.sort_by(|a, b| {
            (&a.concept_path, a.chunk_index).cmp(&(&b.concept_path, b.chunk_index))
        });

        // Rows are ordered by concept_path; collapse contiguous runs into one
        // Concept each.
        let mut concepts: Vec<ryu_knowledge::Concept> = Vec::new();
        let mut group: Vec<OkfExportRow> = Vec::new();
        for row in rows {
            if group
                .first()
                .is_some_and(|f| f.concept_path != row.concept_path)
            {
                concepts.push(concept_from_export_rows(&group));
                group.clear();
            }
            group.push(row);
        }
        if !group.is_empty() {
            concepts.push(concept_from_export_rows(&group));
        }
        Ok(concepts)
    }
}
