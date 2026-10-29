//! Retrieval upgrades for Spaces: configurable chunking, hybrid BM25 + vector
//! search, metadata filters, multi-query fusion, and parent-document
//! (small-to-big) expansion.
//!
//! # Chunking
//!
//! A Space stores an optional [`ChunkingStrategy`] in `spaces.chunking` (JSON).
//! `NULL` is [`ChunkingStrategy::Default`], the historical splitter, so every
//! existing Space keeps producing byte-identical chunks. A strategy applies to
//! documents ingested or edited after it is set; existing chunks are not cut
//! again until their document changes. Each chunk stores the splitter's
//! metadata (`index`, `token_count`, and `header_path` for markdown) in
//! `chunks.metadata`.
//!
//! # Keyword index
//!
//! `chunks.content` is sealed at rest, so the keyword ranking cannot index the
//! stored text. BM25 runs over the store's blind term index (`spaces_terms`,
//! the HMAC tokens of each chunk's words, kept current by the store's own
//! triggers and its background fill), exactly the index body search already
//! uses; query words are tokenized the same way, so no plaintext word is
//! stored for it. `chunks.metadata` (splitter metadata, including markdown
//! `header_path` breadcrumbs) is sealed per value like the chunk text it
//! describes (`ryu_seal('chunks.metadata', id, …)`), and every read here goes
//! through `ryu_open_soft`.
//!
//! # Search
//!
//! [`SpaceStore::search_with`] extends `search_ext`: with `hybrid` set, the
//! Space's own ranking (vector KNN, or graph traversal in graph mode) is fused
//! with a BM25 ranking by weighted reciprocal rank (`alpha` weights the
//! semantic side). A `filter` is evaluated against each chunk's metadata
//! overlaid with its document fields *before* ranking, so a filtered search
//! still fills its limit from the matching chunks. `parent` widens each hit to
//! its neighbouring chunks or its whole document after ranking.

use std::collections::{HashMap, HashSet};

use anyhow::{Context, Result};
use rusqlite::{named_params, params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use ryu_rag::hybrid::{bm25_to_relevance, weighted_rrf};
use ryu_rag::{ChunkingStrategy, Embedder, HybridOptions, MetadataFilter, TextChunk};

use crate::{
    link_expansion_default, ChunkMatch, DocFilter, RetrievalMode, SpaceStore,
    DOC_TENANCY_VISIBLE_PREDICATE, MAX_LINK_EXPANDED_CHUNKS, MAX_LINK_EXPANDED_DOCUMENTS,
};

/// Search result cap, shared with `search_ext`.
pub(crate) const RERANK_MAX_CANDIDATES: usize = 50;
/// Candidate over-fetch factor before reranking, shared with `search_ext`.
pub(crate) const RERANK_FANOUT: usize = 4;
/// Most query variants [`SpaceStore::search_multi`] fuses.
pub const MAX_SEARCH_QUERIES: usize = 8;
/// Largest `parent.window` accepted.
pub const MAX_PARENT_WINDOW: usize = 8;
/// Most query words a keyword ranking ORs together.
const MAX_KEYWORD_TERMS: usize = 64;
/// Largest `parent.max_chars` accepted.
pub const MAX_PARENT_CHARS: usize = 32_000;

fn default_window() -> usize {
    1
}

fn default_parent_chars() -> usize {
    8_000
}

fn default_true() -> bool {
    true
}

fn default_limit() -> usize {
    5
}

/// Small-to-big expansion of each hit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ParentExpansion {
    /// The hit plus `window` chunks on each side from the same document.
    Window {
        #[serde(default = "default_window")]
        window: usize,
    },
    /// The hit's whole document (its chunks in order), truncated to
    /// `max_chars`. Hits from the same document collapse into the first.
    Document {
        #[serde(default = "default_parent_chars")]
        max_chars: usize,
    },
}

/// Options for [`SpaceStore::search_with`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceSearchOptions {
    /// Maximum hits returned (clamped to 1..=50).
    #[serde(default = "default_limit")]
    pub limit: usize,
    /// Wiki link expansion override (`None` = the server default).
    #[serde(default)]
    pub link_expansion: Option<bool>,
    /// Fuse a BM25 keyword ranking with the Space's own ranking.
    #[serde(default)]
    pub hybrid: Option<HybridOptions>,
    /// Metadata predicate every hit must satisfy.
    #[serde(default)]
    pub filter: Option<MetadataFilter>,
    /// Widen each hit to its parent context.
    #[serde(default)]
    pub parent: Option<ParentExpansion>,
    /// Re-score candidates with the reranker (default `true`). With `false` the
    /// fused (or native) order is returned as is.
    #[serde(default = "default_true")]
    pub rerank: bool,
}

impl Default for SpaceSearchOptions {
    fn default() -> Self {
        Self {
            limit: default_limit(),
            link_expansion: None,
            hybrid: None,
            filter: None,
            parent: None,
            rerank: true,
        }
    }
}

impl SpaceSearchOptions {
    /// Reject out-of-range knobs.
    pub fn validate(&self) -> Result<()> {
        if let Some(hybrid) = &self.hybrid {
            hybrid.validate()?;
        }
        match self.parent {
            Some(ParentExpansion::Window { window }) => anyhow::ensure!(
                window <= MAX_PARENT_WINDOW,
                "parent.window must be at most {MAX_PARENT_WINDOW}"
            ),
            Some(ParentExpansion::Document { max_chars }) => anyhow::ensure!(
                (1..=MAX_PARENT_CHARS).contains(&max_chars),
                "parent.max_chars must be between 1 and {MAX_PARENT_CHARS}"
            ),
            None => {}
        }
        Ok(())
    }
}

/// One chunk ready to insert: its text, vector, and splitter metadata (JSON).
pub(crate) struct EmbeddedChunk {
    pub(crate) content: String,
    pub(crate) embedding: Vec<f32>,
    pub(crate) metadata: Option<String>,
}

/// Embed split chunks in one batch, keeping their metadata alongside.
pub(crate) async fn embed_text_chunks(
    embedder: &Embedder,
    chunks: Vec<TextChunk>,
) -> Result<Vec<EmbeddedChunk>> {
    let texts: Vec<String> = chunks.iter().map(|c| c.content.clone()).collect();
    let vectors = embedder.embed_batch(&texts).await?;
    anyhow::ensure!(
        vectors.len() == chunks.len(),
        "embedding provider returned {} vectors for {} chunks",
        vectors.len(),
        chunks.len()
    );
    Ok(chunks
        .into_iter()
        .zip(vectors)
        .map(|(chunk, embedding)| EmbeddedChunk {
            metadata: Some(chunk.metadata.to_json().to_string()),
            content: chunk.content,
            embedding,
        })
        .collect())
}

/// Idempotent schema for chunking config and chunk metadata.
pub(crate) fn init_retrieval_schema(conn: &Connection) -> Result<()> {
    let columns = |table: &str| -> Result<HashSet<String>> {
        let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        Ok(names.filter_map(std::result::Result::ok).collect())
    };
    if !columns("spaces")?.contains("chunking") {
        conn.execute_batch("ALTER TABLE spaces ADD COLUMN chunking TEXT")
            .context("adding spaces.chunking")?;
    }
    if !columns("chunks")?.contains("metadata") {
        conn.execute_batch("ALTER TABLE chunks ADD COLUMN metadata TEXT")
            .context("adding chunks.metadata")?;
    }
    // Builds that kept an FTS5 index over the stored chunk text are retired:
    // `chunks.content` is sealed now and keyword ranking uses the blind term
    // index, so the plaintext-derived index is dropped where it exists.
    conn.execute_batch(
        "DROP TRIGGER IF EXISTS chunks_fts_ai;
         DROP TRIGGER IF EXISTS chunks_fts_ad;
         DROP TRIGGER IF EXISTS chunks_fts_au;
         DROP TABLE IF EXISTS chunks_fts;",
    )
    .context("dropping the retired chunk keyword index")?;
    Ok(())
}

/// Parse a stored strategy, falling back to the default on unreadable JSON so a
/// corrupt row cannot block ingest.
fn parse_strategy(raw: Option<String>) -> ChunkingStrategy {
    match raw {
        None => ChunkingStrategy::Default,
        Some(raw) => serde_json::from_str(&raw).unwrap_or_else(|error| {
            tracing::warn!("ignoring unreadable Space chunking config ({error}); using default");
            ChunkingStrategy::Default
        }),
    }
}

/// Join consecutive chunks, dropping text a chunk repeats from its
/// predecessor's tail (chunk overlap), so a parent reads as continuous prose.
fn join_chunks(parts: &[String]) -> String {
    let mut out = String::new();
    for part in parts {
        if out.is_empty() {
            out.push_str(part);
            continue;
        }
        let overlap = overlap_len(&out, part);
        let rest = &part[overlap..];
        if overlap == 0 {
            out.push_str("\n\n");
        }
        out.push_str(rest);
    }
    out
}

/// Byte length of the longest prefix of `next` that is a suffix of `prev`,
/// considering only prefixes of at least 8 bytes that end at a word boundary, so
/// short coincidental matches are ignored.
fn overlap_len(prev: &str, next: &str) -> usize {
    let max = prev.len().min(next.len());
    let mut best = 0;
    for (index, _) in next.char_indices().skip(1) {
        if index > max {
            break;
        }
        if index >= 8
            && next[index..].starts_with(char::is_whitespace)
            && prev.ends_with(&next[..index])
        {
            best = index;
        }
    }
    if max == next.len() && prev.ends_with(next) {
        best = next.len();
    }
    best
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => text[..cut].to_owned(),
        None => text.to_owned(),
    }
}

impl SpaceStore {
    /// The Space's chunking strategy (`Default` when unset), or `None` when the
    /// Space does not exist.
    pub async fn chunking(&self, space_id: &str) -> Result<Option<ChunkingStrategy>> {
        let conn = self.conn.lock().await;
        let row: Option<Option<String>> = conn
            .query_row(
                "SELECT chunking FROM spaces WHERE id = ?1",
                params![space_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading space chunking")?;
        Ok(row.map(parse_strategy))
    }

    /// Set (or, with `None`, reset to default) the Space's chunking strategy.
    /// Returns `false` when the Space does not exist. Applies to documents
    /// ingested or edited afterwards.
    pub async fn set_chunking(
        &self,
        space_id: &str,
        strategy: Option<&ChunkingStrategy>,
    ) -> Result<bool> {
        let encoded = match strategy {
            None | Some(ChunkingStrategy::Default) => None,
            Some(strategy) => {
                strategy.validate()?;
                Some(serde_json::to_string(strategy)?)
            }
        };
        let conn = self.conn.lock().await;
        let changed = conn
            .execute(
                "UPDATE spaces SET chunking = ?1 WHERE id = ?2",
                params![encoded, space_id],
            )
            .context("updating space chunking")?;
        Ok(changed > 0)
    }

    async fn chunking_for_document(&self, doc_id: &str) -> Result<ChunkingStrategy> {
        let conn = self.conn.lock().await;
        let raw: Option<Option<String>> = conn
            .query_row(
                "SELECT s.chunking FROM documents d JOIN spaces s ON s.id = d.space_id
                 WHERE d.id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .optional()
            .context("reading document chunking")?;
        Ok(parse_strategy(raw.flatten()))
    }

    /// Split `text` with the Space's strategy (default for an unknown Space; the
    /// caller reports a missing Space itself).
    pub(crate) async fn split_for_space(
        &self,
        space_id: &str,
        text: &str,
    ) -> Result<Vec<TextChunk>> {
        let strategy = self.chunking(space_id).await?.unwrap_or_default();
        self.split_with(&strategy, text).await
    }

    /// Split `text` with the strategy of the Space that holds `doc_id`.
    pub(crate) async fn split_for_document(
        &self,
        doc_id: &str,
        text: &str,
    ) -> Result<Vec<TextChunk>> {
        let strategy = self.chunking_for_document(doc_id).await?;
        self.split_with(&strategy, text).await
    }

    async fn split_with(&self, strategy: &ChunkingStrategy, text: &str) -> Result<Vec<TextChunk>> {
        if strategy.needs_embedder() {
            let embedder = self.embedder_snapshot().await;
            ryu_rag::splitter::split_text_with_embedder(text, strategy, &embedder).await
        } else {
            Ok(ryu_rag::splitter::split_text(text, strategy))
        }
    }

    /// Search a Space with hybrid fusion, a metadata filter, and parent
    /// expansion. `filter` is the caller's tenancy filter, exactly as for
    /// [`Self::search_ext`] (which is this method with default options).
    pub async fn search_with(
        &self,
        space_id: &str,
        query: &str,
        opts: &SpaceSearchOptions,
        filter: DocFilter<'_>,
    ) -> Result<Vec<ChunkMatch>> {
        self.search_multi(space_id, &[query.to_owned()], opts, filter)
            .await
    }

    /// [`Self::search_with`] over several query texts (an original query plus
    /// its multi-query or HyDE expansions). Each text gathers its own
    /// candidates; the lists are fused by reciprocal rank, then reranked and
    /// expanded against the first (original) query.
    pub async fn search_multi(
        &self,
        space_id: &str,
        queries: &[String],
        opts: &SpaceSearchOptions,
        filter: DocFilter<'_>,
    ) -> Result<Vec<ChunkMatch>> {
        opts.validate()?;
        let Some(original) = queries.first() else {
            return Ok(Vec::new());
        };
        anyhow::ensure!(
            queries.len() <= MAX_SEARCH_QUERIES,
            "at most {MAX_SEARCH_QUERIES} query texts may be fused"
        );
        let limit = opts.limit.clamp(1, RERANK_MAX_CANDIDATES);
        let candidate_limit = limit
            .saturating_mul(RERANK_FANOUT)
            .clamp(limit, RERANK_MAX_CANDIDATES);

        let allowed = match opts.filter.as_ref().filter(|f| !f.is_empty()) {
            Some(predicate) => {
                let allowed = self.filter_allowlist(space_id, predicate, &filter).await?;
                if allowed.is_empty() {
                    return Ok(Vec::new());
                }
                Some(allowed)
            }
            None => None,
        };

        let mut lists = Vec::with_capacity(queries.len());
        for query in queries {
            lists.push(
                self.collect_candidates(
                    space_id,
                    query,
                    candidate_limit,
                    opts,
                    &filter,
                    allowed.as_ref(),
                )
                .await?,
            );
        }
        let mut candidates = if lists.len() == 1 {
            lists.remove(0)
        } else {
            weighted_rrf(
                lists.into_iter().map(|list| (1.0, list)).collect(),
                |hit: &ChunkMatch| hit.chunk_id.clone(),
                candidate_limit,
            )
            .into_iter()
            .map(|(hit, score)| ChunkMatch {
                score: Some(score),
                ..hit
            })
            .collect()
        };

        if opts.link_expansion.unwrap_or_else(link_expansion_default) {
            self.add_link_expansions(space_id, &mut candidates, &filter, allowed.as_ref())
                .await;
        }

        let mut hits = if opts.rerank {
            self.apply_reranking(original, candidates, limit).await
        } else {
            candidates.truncate(limit);
            candidates
        };
        self.attach_chunk_metadata(&mut hits).await?;
        if let Some(parent) = opts.parent {
            hits = self.expand_parents(hits, parent).await?;
        }
        Ok(hits)
    }

    /// One query's candidates: the Space's native ranking, fused with BM25 when
    /// `hybrid` is set, restricted to `allowed` chunks when a filter is active.
    async fn collect_candidates(
        &self,
        space_id: &str,
        query: &str,
        candidate_limit: usize,
        opts: &SpaceSearchOptions,
        filter: &DocFilter<'_>,
        allowed: Option<&HashMap<String, i64>>,
    ) -> Result<Vec<ChunkMatch>> {
        let allowed_rowids: Option<String> = allowed.map(|map| {
            serde_json::to_string(&map.values().copied().collect::<Vec<i64>>())
                .unwrap_or_else(|_| "[]".to_owned())
        });
        let mode = self.space_mode(space_id).await?;
        let native = match mode {
            RetrievalMode::Vector => {
                self.vector_search(
                    space_id,
                    query,
                    candidate_limit,
                    filter,
                    allowed_rowids.as_deref(),
                )
                .await?
            }
            RetrievalMode::Graph => {
                // Graph traversal has no rowid predicate; widen the walk when a
                // filter will discard part of it.
                let walk = if allowed.is_some() {
                    RERANK_MAX_CANDIDATES
                } else {
                    candidate_limit
                };
                let mut hits = self.graph_search(space_id, query, walk, filter).await?;
                if let Some(allowed) = allowed {
                    hits.retain(|hit| allowed.contains_key(&hit.chunk_id));
                }
                hits.truncate(candidate_limit);
                hits
            }
        };
        let Some(hybrid) = opts.hybrid else {
            return Ok(native);
        };
        let keyword = self
            .keyword_search(
                space_id,
                query,
                candidate_limit,
                filter,
                allowed_rowids.as_deref(),
            )
            .await?;
        Ok(weighted_rrf(
            vec![(hybrid.alpha, native), (1.0 - hybrid.alpha, keyword)],
            |hit: &ChunkMatch| hit.chunk_id.clone(),
            candidate_limit,
        )
        .into_iter()
        .map(|(hit, score)| ChunkMatch {
            score: Some(score),
            ..hit
        })
        .collect())
    }

    /// BM25 keyword search over the Space's chunks via the blind term index
    /// (`spaces_terms`; any query word matches). `score` is a bounded relevance
    /// derived from `bm25()`; `distance` is `0.0` (keyword hits have no vector
    /// distance).
    pub(crate) async fn keyword_search(
        &self,
        space_id: &str,
        query: &str,
        limit: usize,
        filter: &DocFilter<'_>,
        allowed_rowids: Option<&str>,
    ) -> Result<Vec<ChunkMatch>> {
        let tokens = self.seal.keys.terms.term_tokens(query);
        if tokens.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let expression = tokens
            .iter()
            .take(MAX_KEYWORD_TERMS)
            .map(String::as_str)
            .collect::<Vec<_>>()
            .join(" OR ");
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT c.id, c.document_id, ryu_open_soft('chunks.content', c.id, c.content), t.score
             FROM (SELECT rowid AS term_rowid, bm25(spaces_terms) AS score
                   FROM spaces_terms WHERE spaces_terms MATCH :expression) t
             JOIN spaces_terms_map m ON m.term_rowid = t.term_rowid AND m.kind = 'chunk'
             JOIN chunks c ON c.id = m.ref_id
             JOIN documents d ON d.id = c.document_id
             WHERE c.space_id = :space_id
               AND {DOC_TENANCY_VISIBLE_PREDICATE}
               AND (:allowed IS NULL OR c.rowid IN (SELECT value FROM json_each(:allowed)))
             ORDER BY t.score, c.id
             LIMIT :limit"
        );
        let mut stmt = conn.prepare(&sql).context("preparing keyword search")?;
        let rows = stmt.query_map(
            named_params! {
                ":expression": expression,
                ":space_id": space_id,
                ":allowed": allowed_rowids,
                ":limit": limit as i64,
                ":bound": filter.bound_flag(),
                ":uid": filter.owner_user_id,
                ":org": filter.org_id,
                ":teams": filter.team_ids_json.as_str(),
            },
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )?;
        let mut out = Vec::new();
        for row in rows {
            let (chunk_id, document_id, content, bm25) = row.context("running keyword search")?;
            // A chunk whose sealed text does not open is skipped (and counted
            // by `ryu_open_soft`), never returned empty.
            let Some(content) = content else {
                continue;
            };
            out.push(ChunkMatch {
                chunk_id,
                document_id,
                content,
                distance: 0.0,
                score: Some(bm25_to_relevance(bm25)),
                ..Default::default()
            });
        }
        Ok(out)
    }

    /// Chunks of `space_id` the caller may read whose metadata matches
    /// `predicate`, as `chunk_id → rowid`. The metadata a predicate sees is the
    /// chunk's splitter metadata overlaid with `source` (`"space"`), `space_id`,
    /// `document_id`, `title`, `kind`, `mime`, `ordinal`, `created_at` and
    /// `updated_at`.
    async fn filter_allowlist(
        &self,
        space_id: &str,
        predicate: &MetadataFilter,
        filter: &DocFilter<'_>,
    ) -> Result<HashMap<String, i64>> {
        let conn = self.conn.lock().await;
        let sql = format!(
            "SELECT c.rowid, c.id, c.document_id, c.ordinal,
                    ryu_open_soft('chunks.metadata', c.id, c.metadata),
                    ryu_open_soft('documents.title', d.id, d.title),
                    d.kind, d.mime, d.created_at, d.updated_at
             FROM chunks c
             JOIN documents d ON d.id = c.document_id
             WHERE c.space_id = :space_id AND {DOC_TENANCY_VISIBLE_PREDICATE}"
        );
        let mut stmt = conn.prepare(&sql).context("preparing filter scan")?;
        let mut rows = stmt.query(named_params! {
            ":space_id": space_id,
            ":bound": filter.bound_flag(),
            ":uid": filter.owner_user_id,
            ":org": filter.org_id,
            ":teams": filter.team_ids_json.as_str(),
        })?;
        let mut allowed = HashMap::new();
        while let Some(row) = rows.next()? {
            let stored: Option<String> = row.get(4)?;
            let mut metadata = stored
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|value| match value {
                    serde_json::Value::Object(map) => Some(map),
                    _ => None,
                })
                .unwrap_or_default();
            let chunk_id: String = row.get(1)?;
            // A title that does not open (counted by `ryu_open_soft`) leaves the
            // chunk out of the allowlist.
            let Some(title) = row.get::<_, Option<String>>(5)? else {
                continue;
            };
            // `source` and `space_id` match the built-in fields `retrieval.db`
            // chunks expose, so one `/api/retrieval/search` filter reads the
            // same on both halves of a unified search.
            metadata.insert("source".into(), "space".into());
            metadata.insert("space_id".into(), space_id.into());
            metadata.insert("document_id".into(), row.get::<_, String>(2)?.into());
            metadata.insert("ordinal".into(), row.get::<_, i64>(3)?.into());
            metadata.insert("title".into(), title.into());
            metadata.insert("kind".into(), row.get::<_, String>(6)?.into());
            if let Some(mime) = row.get::<_, Option<String>>(7)? {
                metadata.insert("mime".into(), mime.into());
            }
            metadata.insert("created_at".into(), row.get::<_, i64>(8)?.into());
            metadata.insert("updated_at".into(), row.get::<_, i64>(9)?.into());
            if predicate.matches(&metadata) {
                allowed.insert(chunk_id, row.get::<_, i64>(0)?);
            }
        }
        Ok(allowed)
    }

    /// Wiki link expansion (as in `search_ext`), restricted to `allowed`.
    async fn add_link_expansions(
        &self,
        space_id: &str,
        candidates: &mut Vec<ChunkMatch>,
        filter: &DocFilter<'_>,
        allowed: Option<&HashMap<String, i64>>,
    ) {
        const LINK_HOPS: usize = 2;
        const LINK_PER_DOC_CHUNKS: usize = 3;
        let mut seed_doc_ids: Vec<String> = Vec::new();
        let mut seen_docs: HashSet<String> = HashSet::new();
        for hit in candidates.iter() {
            if seen_docs.insert(hit.document_id.clone()) {
                seed_doc_ids.push(hit.document_id.clone());
            }
        }
        match self
            .expand_by_links(
                space_id,
                &seed_doc_ids,
                LINK_HOPS,
                LINK_PER_DOC_CHUNKS,
                MAX_LINK_EXPANDED_DOCUMENTS,
                MAX_LINK_EXPANDED_CHUNKS
                    .min(RERANK_MAX_CANDIDATES.saturating_sub(candidates.len())),
                filter,
            )
            .await
        {
            Ok(extra) => {
                let mut existing: HashSet<String> =
                    candidates.iter().map(|c| c.chunk_id.clone()).collect();
                for hit in extra {
                    if allowed.is_some_and(|allowed| !allowed.contains_key(&hit.chunk_id)) {
                        continue;
                    }
                    if existing.insert(hit.chunk_id.clone()) {
                        candidates.push(hit);
                        if candidates.len() >= RERANK_MAX_CANDIDATES {
                            break;
                        }
                    }
                }
            }
            Err(e) => tracing::debug!("Spaces link-expansion skipped ({e:#})"),
        }
    }

    /// Fill `metadata` (splitter metadata plus `ordinal`) on each hit.
    async fn attach_chunk_metadata(&self, hits: &mut [ChunkMatch]) -> Result<()> {
        if hits.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT ordinal, ryu_open_soft('chunks.metadata', id, metadata)
                 FROM chunks WHERE id = ?1",
            )
            .context("preparing chunk metadata lookup")?;
        for hit in hits.iter_mut() {
            let row: Option<(i64, Option<String>)> = stmt
                .query_row(params![hit.chunk_id], |row| Ok((row.get(0)?, row.get(1)?)))
                .optional()?;
            let Some((ordinal, stored)) = row else {
                continue;
            };
            let mut metadata = stored
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|value| match value {
                    serde_json::Value::Object(map) => Some(map),
                    _ => None,
                })
                .unwrap_or_default();
            metadata.insert("ordinal".into(), ordinal.into());
            hit.metadata = Some(serde_json::Value::Object(metadata));
        }
        Ok(())
    }

    /// Small-to-big: widen each hit to its neighbouring chunks or whole
    /// document. Document mode keeps only the first hit per document.
    async fn expand_parents(
        &self,
        hits: Vec<ChunkMatch>,
        parent: ParentExpansion,
    ) -> Result<Vec<ChunkMatch>> {
        let conn = self.conn.lock().await;
        let mut ordinal_stmt = conn.prepare("SELECT ordinal FROM chunks WHERE id = ?1")?;
        let mut range_stmt = conn.prepare(
            "SELECT ryu_open_soft('chunks.content', id, content) FROM chunks
             WHERE document_id = ?1 AND ordinal BETWEEN ?2 AND ?3
             ORDER BY ordinal",
        )?;
        let mut seen_documents: HashSet<String> = HashSet::new();
        let mut out = Vec::with_capacity(hits.len());
        for mut hit in hits {
            let (low, high, max_chars) = match parent {
                ParentExpansion::Window { window } => {
                    let Some(ordinal) = ordinal_stmt
                        .query_row(params![hit.chunk_id], |row| row.get::<_, i64>(0))
                        .optional()?
                    else {
                        out.push(hit);
                        continue;
                    };
                    let window = window as i64;
                    (ordinal - window, ordinal + window, MAX_PARENT_CHARS)
                }
                ParentExpansion::Document { max_chars } => {
                    if !seen_documents.insert(hit.document_id.clone()) {
                        continue;
                    }
                    (i64::MIN, i64::MAX, max_chars)
                }
            };
            // Chunks whose sealed text does not open are left out of the parent.
            let parts: Vec<String> = range_stmt
                .query_map(params![hit.document_id, low, high], |row| {
                    row.get::<_, Option<String>>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect();
            hit.parent_content = Some(truncate_chars(&join_chunks(&parts), max_chars));
            out.push(hit);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::DocOwner;

    fn plain() -> SpaceSearchOptions {
        SpaceSearchOptions {
            limit: 10,
            link_expansion: Some(false),
            rerank: false,
            ..Default::default()
        }
    }

    async fn store_with_space() -> (SpaceStore, String) {
        let store = SpaceStore::open_in_memory().unwrap();
        let space = store
            .create_space("Docs", None, &DocOwner::unattributed())
            .await
            .unwrap();
        (store, space)
    }

    async fn chunk_rows(store: &SpaceStore, doc_id: &str) -> Vec<(String, Option<String>)> {
        let conn = store.conn.lock().await;
        let mut stmt = conn
            .prepare(
                "SELECT ryu_open('chunks.content', id, content),
                        ryu_open('chunks.metadata', id, metadata)
                 FROM chunks WHERE document_id = ?1 ORDER BY ordinal",
            )
            .unwrap();
        stmt.query_map(params![doc_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[tokio::test]
    async fn default_chunking_is_unchanged_and_configurable_per_space() {
        let (store, space) = store_with_space().await;
        assert_eq!(
            store.chunking(&space).await.unwrap(),
            Some(ChunkingStrategy::Default)
        );
        assert_eq!(store.chunking("missing").await.unwrap(), None);
        let body = format!("{}\n\nTail paragraph.", "lorem ipsum ".repeat(150));
        let doc = store
            .ingest_document(&space, "Plain", &body, &DocOwner::unattributed())
            .await
            .unwrap();
        let rows = chunk_rows(&store, &doc).await;
        let legacy = ryu_rag::splitter::legacy_word_chunks(&body, crate::CHUNK_CHAR_SIZE);
        assert_eq!(
            rows.iter().map(|(c, _)| c.clone()).collect::<Vec<_>>(),
            legacy
        );

        let markdown = ChunkingStrategy::Markdown {
            chunk_size: 400,
            chunk_overlap: 0,
            include_header_path: false,
        };
        assert!(store.set_chunking(&space, Some(&markdown)).await.unwrap());
        assert_eq!(store.chunking(&space).await.unwrap(), Some(markdown));
        assert!(!store
            .set_chunking("missing", Some(&ChunkingStrategy::Default))
            .await
            .unwrap());
        let invalid = ChunkingStrategy::Recursive {
            chunk_size: 10,
            chunk_overlap: 10,
            separators: None,
        };
        assert!(store.set_chunking(&space, Some(&invalid)).await.is_err());

        let doc = store
            .ingest_document(
                &space,
                "Guide",
                "# Guide\n\nOverview text.\n\n## Install\n\nRun the zephyr installer.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let rows = chunk_rows(&store, &doc).await;
        assert_eq!(rows.len(), 2);
        let meta: serde_json::Value = serde_json::from_str(rows[1].1.as_deref().unwrap()).unwrap();
        assert_eq!(meta["header_path"], serde_json::json!(["Guide", "Install"]));

        // Editing re-chunks with the Space's strategy too.
        store
            .update_document(&doc, "Guide", "# A\n\none\n\n# B\n\ntwo\n\n# C\n\nthree")
            .await
            .unwrap();
        assert_eq!(chunk_rows(&store, &doc).await.len(), 3);

        // Resetting restores the default splitter for later ingests.
        assert!(store.set_chunking(&space, None).await.unwrap());
        assert_eq!(
            store.chunking(&space).await.unwrap(),
            Some(ChunkingStrategy::Default)
        );
    }

    #[tokio::test]
    async fn keyword_index_follows_inserts_and_deletes() {
        let (store, space) = store_with_space().await;
        let doc = store
            .ingest_document(
                &space,
                "Zephyr",
                "The zephyr protocol handshake.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        let hits = store
            .keyword_search(&space, "zephyr", 5, &DocFilter::unrestricted(), None)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].score.unwrap() > 0.0);
        assert!(store.delete_document(&doc).await.unwrap());
        assert!(store
            .keyword_search(&space, "zephyr", 5, &DocFilter::unrestricted(), None)
            .await
            .unwrap()
            .is_empty());
        // Syntax-only queries produce no match expression and no error.
        assert!(store
            .keyword_search(&space, "\"*:", 5, &DocFilter::unrestricted(), None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn chunk_text_and_metadata_are_sealed_and_the_retired_fts_index_is_dropped() {
        let (store, space) = store_with_space().await;
        let doc = store
            .ingest_document(
                &space,
                "Old",
                "Legacy quokka notes.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        {
            let conn = store.conn.lock().await;
            let (content, metadata): (String, Option<String>) = conn
                .query_row(
                    "SELECT content, metadata FROM chunks WHERE document_id = ?1",
                    params![doc],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!(content.starts_with("encb:v1:"), "{content}");
            assert!(!content.contains("quokka"));
            let metadata = metadata.expect("splitter metadata is stored");
            assert!(metadata.starts_with("encb:v1:"), "{metadata}");
            // A build that kept a plaintext-derived FTS index is cleaned up.
            conn.execute_batch(
                "CREATE VIRTUAL TABLE chunks_fts
                     USING fts5(content, content='chunks', content_rowid='rowid');
                 CREATE TRIGGER chunks_fts_ai AFTER INSERT ON chunks BEGIN
                     INSERT INTO chunks_fts(rowid, content) VALUES (new.rowid, new.content);
                 END;",
            )
            .unwrap();
            init_retrieval_schema(&conn).unwrap();
            let retired: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'chunks_fts%'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(retired, 0);
        }
        let hits = store
            .keyword_search(&space, "quokka", 5, &DocFilter::unrestricted(), None)
            .await
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "Legacy quokka notes.");
    }

    #[tokio::test]
    async fn hybrid_alpha_moves_between_keyword_and_vector_rankings() {
        let (store, space) = store_with_space().await;
        for (title, body) in [
            ("a", "Kestrel migration routes across the valley."),
            ("b", "Valley weather and valley rivers in the valley."),
            ("c", "Unrelated cooking notes about bread."),
        ] {
            store
                .ingest_document(&space, title, body, &DocOwner::unattributed())
                .await
                .unwrap();
        }
        let keyword_only = store
            .search_with(
                &space,
                "kestrel",
                &SpaceSearchOptions {
                    hybrid: Some(HybridOptions { alpha: 0.0 }),
                    ..plain()
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        // Pure keyword ranking: only the chunk containing the term.
        assert_eq!(keyword_only.len(), 1);
        assert!(keyword_only[0].content.contains("Kestrel"));
        assert!(keyword_only[0].score.is_some());

        let vector_only = store
            .search_with(
                &space,
                "kestrel",
                &SpaceSearchOptions {
                    hybrid: Some(HybridOptions { alpha: 1.0 }),
                    ..plain()
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        // Pure vector ranking: every chunk is a KNN neighbour.
        assert_eq!(vector_only.len(), 3);

        let balanced = store
            .search_with(
                &space,
                "kestrel valley",
                &SpaceSearchOptions {
                    hybrid: Some(HybridOptions::default()),
                    ..plain()
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        assert_eq!(balanced.len(), 3);
        // A chunk both rankings agree on beats one only the vector side found.
        assert!(balanced[2].content.contains("bread"));
        assert!(balanced.iter().all(|h| h.score.is_some()));
    }

    #[tokio::test]
    async fn metadata_filter_is_applied_before_ranking() {
        let (store, space) = store_with_space().await;
        store
            .set_chunking(
                &space,
                Some(&ChunkingStrategy::Markdown {
                    chunk_size: 400,
                    chunk_overlap: 0,
                    include_header_path: false,
                }),
            )
            .await
            .unwrap();
        let guide = store
            .ingest_document(
                &space,
                "Guide",
                "# Install\n\nAlpine setup steps.\n\n# Usage\n\nAlpine usage steps.",
                &DocOwner::unattributed(),
            )
            .await
            .unwrap();
        store
            .ingest_document(&space, "Notes", "Alpine notes.", &DocOwner::unattributed())
            .await
            .unwrap();
        let search = |filter: serde_json::Value| {
            let store = &store;
            let space = &space;
            async move {
                store
                    .search_with(
                        space,
                        "alpine steps",
                        &SpaceSearchOptions {
                            limit: 1,
                            filter: Some(MetadataFilter::parse(&filter).unwrap()),
                            ..plain()
                        },
                        DocFilter::unrestricted(),
                    )
                    .await
                    .unwrap()
            }
        };
        let usage = search(serde_json::json!({"header_path": "Usage"})).await;
        assert_eq!(usage.len(), 1);
        assert!(usage[0].content.contains("usage"));
        assert_eq!(
            usage[0].metadata.as_ref().unwrap()["header_path"],
            serde_json::json!(["Usage"])
        );
        let notes = search(serde_json::json!({"title": {"$ne": "Guide"}})).await;
        assert_eq!(notes.len(), 1);
        assert!(notes[0].content.contains("notes"));
        let by_doc =
            search(serde_json::json!({"$and": [{"document_id": guide}, {"ordinal": {"$gt": 0}}]}))
                .await;
        assert!(by_doc[0].content.contains("usage"));
        assert!(search(serde_json::json!({"kind": "file"})).await.is_empty());
        // The unified-retrieval built-ins read the same as on retrieval.db chunks.
        assert_eq!(
            search(serde_json::json!({"source": "space", "space_id": space.clone()}))
                .await
                .len(),
            1
        );
        assert!(search(serde_json::json!({"source": "memory"}))
            .await
            .is_empty());
        // Hybrid keyword hits honour the filter too.
        let hybrid = store
            .search_with(
                &space,
                "alpine",
                &SpaceSearchOptions {
                    hybrid: Some(HybridOptions { alpha: 0.0 }),
                    filter: Some(
                        MetadataFilter::parse(&serde_json::json!({"title": "Notes"})).unwrap(),
                    ),
                    ..plain()
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        assert_eq!(hybrid.len(), 1);
        assert!(hybrid[0].content.contains("notes"));
    }

    #[tokio::test]
    async fn keyword_and_filtered_search_respect_tenancy() {
        let store = SpaceStore::open_in_memory().unwrap();
        let alice = DocOwner::owned(Some("alice"), Some("org1"));
        let space = store.create_space("Shared", None, &alice).await.unwrap();
        store
            .ingest_document(&space, "Secret", "Private ocelot plans.", &alice)
            .await
            .unwrap();
        let as_bob = DocFilter::for_caller(Some("bob"), Some("org1"), true);
        assert!(store
            .keyword_search(&space, "ocelot", 5, &as_bob, None)
            .await
            .unwrap()
            .is_empty());
        let hits = store
            .search_with(
                &space,
                "ocelot",
                &SpaceSearchOptions {
                    hybrid: Some(HybridOptions::default()),
                    filter: Some(
                        MetadataFilter::parse(&serde_json::json!({"title": "Secret"})).unwrap(),
                    ),
                    ..plain()
                },
                as_bob,
            )
            .await
            .unwrap();
        assert!(hits.is_empty());
        let as_alice = DocFilter::for_caller(Some("alice"), Some("org1"), true);
        assert_eq!(
            store
                .keyword_search(&space, "ocelot", 5, &as_alice, None)
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn parent_expansion_returns_neighbours_or_the_whole_document() {
        let (store, space) = store_with_space().await;
        store
            .set_chunking(
                &space,
                Some(&ChunkingStrategy::Recursive {
                    chunk_size: 40,
                    chunk_overlap: 0,
                    separators: Some(vec!["\n\n".to_owned()]),
                }),
            )
            .await
            .unwrap();
        let body = "First paragraph about apples.\n\nSecond paragraph about walrus.\n\nThird paragraph about pears.\n\nFourth paragraph about plums.";
        store
            .ingest_document(&space, "Fruit", body, &DocOwner::unattributed())
            .await
            .unwrap();
        let keyword = SpaceSearchOptions {
            limit: 1,
            hybrid: Some(HybridOptions { alpha: 0.0 }),
            ..plain()
        };
        let window = store
            .search_with(
                &space,
                "walrus",
                &SpaceSearchOptions {
                    parent: Some(ParentExpansion::Window { window: 1 }),
                    ..keyword.clone()
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        assert_eq!(window[0].content, "Second paragraph about walrus.");
        assert_eq!(
            window[0].parent_content.as_deref(),
            Some("First paragraph about apples.\n\nSecond paragraph about walrus.\n\nThird paragraph about pears.")
        );
        let document = store
            .search_with(
                &space,
                "walrus",
                &SpaceSearchOptions {
                    parent: Some(ParentExpansion::Document { max_chars: 10_000 }),
                    ..keyword
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        assert_eq!(document[0].parent_content.as_deref(), Some(body));
    }

    #[tokio::test]
    async fn multi_query_search_fuses_each_query() {
        let (store, space) = store_with_space().await;
        for (title, body) in [
            ("a", "Narwhal tusks are teeth."),
            ("b", "Axolotl regeneration facts."),
            ("c", "Plain filler text."),
        ] {
            store
                .ingest_document(&space, title, body, &DocOwner::unattributed())
                .await
                .unwrap();
        }
        let hits = store
            .search_multi(
                &space,
                &["narwhal".to_owned(), "axolotl".to_owned()],
                &SpaceSearchOptions {
                    limit: 2,
                    hybrid: Some(HybridOptions { alpha: 0.0 }),
                    ..plain()
                },
                DocFilter::unrestricted(),
            )
            .await
            .unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|h| h.content.contains("Narwhal")));
        assert!(hits.iter().any(|h| h.content.contains("Axolotl")));
        let too_many: Vec<String> = (0..=MAX_SEARCH_QUERIES).map(|i| format!("q{i}")).collect();
        assert!(store
            .search_multi(&space, &too_many, &plain(), DocFilter::unrestricted())
            .await
            .is_err());
    }

    #[test]
    fn join_chunks_removes_overlap_and_separates_disjoint_parts() {
        let parts = vec![
            "The quick brown fox jumps over".to_owned(),
            "fox jumps over the lazy dog.".to_owned(),
            "Unrelated paragraph.".to_owned(),
        ];
        assert_eq!(
            join_chunks(&parts),
            "The quick brown fox jumps over the lazy dog.\n\nUnrelated paragraph."
        );
    }

    #[test]
    fn truncate_respects_char_boundaries() {
        assert_eq!(truncate_chars("héllo", 2), "hé");
        assert_eq!(truncate_chars("hi", 10), "hi");
    }

    #[test]
    fn options_validation() {
        let mut opts = SpaceSearchOptions {
            parent: Some(ParentExpansion::Window { window: 99 }),
            ..Default::default()
        };
        assert!(opts.validate().is_err());
        opts.parent = Some(ParentExpansion::Document { max_chars: 0 });
        assert!(opts.validate().is_err());
        opts.parent = None;
        opts.hybrid = Some(HybridOptions { alpha: 2.0 });
        assert!(opts.validate().is_err());
        let parsed: SpaceSearchOptions = serde_json::from_value(serde_json::json!({
            "limit": 3,
            "hybrid": {},
            "parent": {"mode": "window"},
            "filter": {"kind": "page"}
        }))
        .unwrap();
        assert_eq!(parsed.hybrid.unwrap().alpha, 0.5);
        assert_eq!(parsed.parent, Some(ParentExpansion::Window { window: 1 }));
        assert!(parsed.rerank);
    }
}
