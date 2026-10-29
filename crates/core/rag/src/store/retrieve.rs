//! Retrieval: local candidate scoring, Spaces recall and the
//! [`RagProvider`] impl.

use super::*;

impl RetrievalStore {
    /// Embed `query`, search memory + the selected Spaces, merge and rank by
    /// cosine relevance, re-rank the expanded candidate pool, and return the
    /// top-K chunks (per `opts`).
    ///
    /// Pipeline: embed → search → filter → cosine rank → rerank top-(top_k × 4)
    /// → final top-K.
    ///
    /// # The Spaces half
    ///
    /// When a [`SpaceRecall`] delegate is wired AND `opts` selects at least one
    /// Space, the selected Spaces are additionally answered **by the Spaces store**,
    /// each under its own `retrieval_mode` (vector KNN or graph traversal), and
    /// those per-Space rankings are merged with this store's list by
    /// [`fuse_ranked_lists`]. Without that delegate — or with `space_ids: Some([])`
    /// — this method behaves exactly as it did before the delegate existed, cosine
    /// scores and all.
    ///
    /// Two consequences worth stating plainly rather than discovering:
    ///
    /// - `opts.min_score` is applied to THIS store's candidates only. A delegated
    ///   Space hit has no comparable score to threshold (see [`fuse_ranked_lists`]),
    ///   so it is not filtered by `min_score`; see the field doc on
    ///   [`RetrievalOptions::min_score`].
    /// - the returned `score` is a fusion score, not a cosine, whenever a Space
    ///   list actually contributes.
    ///
    /// # When a local sidecar is down
    ///
    /// The embed call used to be the first statement and propagated with `?`, which
    /// coupled two halves that do not share a dependency. The default
    /// `embed_base_url` is `http://127.0.0.1:8081`, i.e. non-empty, so the embedder
    /// is [`Embedder::Remote`] on a stock install and [`remote_embed`] returns `Err`
    /// on a connect failure or a non-2xx — and the `llamacpp-embed` sidecar it points
    /// at is started *lazily*. So an embed server that is not up yet took down
    /// **graph-mode Space recall too**, which needs no vector at all: a BFS over
    /// `graph_nodes` seeded from the query's own tokens. On the chat path the error
    /// is swallowed (`auto-recall: memory retrieve failed (skipping)`), so the
    /// user's symptom was an agent that quietly stopped citing an allowlisted Space.
    ///
    /// Now the failure is scoped to the half that genuinely cannot proceed:
    ///
    /// - **Lost:** this store's entire own list — memory *and* OKF — because every
    ///   one of those hits is scored by cosine against the query vector. There is no
    ///   partial answer to salvage there, and none is faked.
    /// - **Kept:** the [`SpaceRecall`] half. A graph-mode Space answers normally; a
    ///   vector-mode Space fails inside the delegate (its own embedder is down too)
    ///   and is skipped per-Space, exactly as the trait already specifies.
    ///
    /// **The rerank pass gets the same treatment, and needed it as much.** The second
    /// pass calls a cross-encoder that is `Reranker::Remote` whenever
    /// `RYU_RERANKER_BASE_URL` is set — which `profile::apply_env_defaults` does on
    /// every non-release `RYU_PROFILE`, so on a dev stack it is the default, pointed
    /// at another lazily-started sidecar. A bare `?` there would have reproduced this
    /// exact defect one sidecar over: Spaces recall dying for want of a service it
    /// never calls. It is routed through the same degraded path, with the same
    /// re-raise-if-nothing-salvaged rule. Note the local list is *dropped*, not
    /// re-ordered by cosine — see [`Self::spaces_only`] for why that
    /// restraint is deliberate.
    ///
    /// **The error is never silently downgraded to an empty result.** If the Spaces
    /// half returns nothing, the sidecar's own message is still what reaches the
    /// caller — prefixed, not replaced (see [`Self::spaces_only`] for why the
    /// prefix is flattened into `Display` rather than attached as an `anyhow` context).
    /// It is only suppressed (to a `warn!`) when there is a real, differently-grounded
    /// answer to return instead.
    pub async fn retrieve(&self, query: &str, opts: &RetrievalOptions) -> Result<Vec<ScoredChunk>> {
        if query.trim().is_empty() || opts.top_k == 0 {
            return Ok(Vec::new());
        }
        // The Spaces half needs nothing from the local half, so both run at once
        // instead of Spaces waiting on the embed, scan and rerank round trips.
        let (local, space_lists) = tokio::join!(
            self.retrieve_local(query, opts),
            self.recall_spaces(query, opts)
        );
        match local {
            Ok(reranked) => Ok(fuse_ranked_lists(reranked, space_lists, opts.top_k)),
            Err(LocalRetrievalError::Store(error)) => Err(error),
            Err(LocalRetrievalError::SidecarUnavailable(local_err)) => {
                Self::spaces_only(space_lists, opts, local_err)
            }
        }
    }

    /// This store's own half of [`Self::retrieve`]: embed, score, rerank, top-K.
    pub(crate) async fn retrieve_local(
        &self,
        query: &str,
        opts: &RetrievalOptions,
    ) -> std::result::Result<Vec<ScoredChunk>, LocalRetrievalError> {
        // Held, not logged-and-dropped: it is either re-raised or reported as the
        // reason the memory half is missing from an otherwise real answer.
        let query_embedding = self
            .embedder_snapshot()
            .embed(query)
            .await
            .map_err(LocalRetrievalError::SidecarUnavailable)?;

        let mut scored = self
            .score_candidates(&query_embedding, opts)
            .await
            .map_err(LocalRetrievalError::Store)?;

        // First pass: sort by cosine and collect an expanded pool for reranking.
        scored.sort_by(|a, b| b.score.total_cmp(&a.score));
        let rerank_n = opts
            .rerank_candidates
            .unwrap_or(opts.top_k.saturating_mul(4).max(opts.top_k));
        scored.truncate(rerank_n);
        // Content is read only for the survivors; the scan above skips it.
        self.fill_content(&mut scored)
            .await
            .map_err(LocalRetrievalError::Store)?;

        // Second pass: rerank the expanded pool, then take the final top-K. A remote
        // cross-encoder is a second sidecar with the same liveness problem as the
        // embedder (`remote_rerank` propagates on connect failure and on non-2xx), and
        // it is the DEFAULT on every non-release `RYU_PROFILE` — so a bare `?` here
        // would have left the exact defect this method was restructured to close,
        // one sidecar over.
        let mut reranked = self
            .reranker
            .rerank(query, scored)
            .await
            .map_err(LocalRetrievalError::SidecarUnavailable)?;
        reranked.truncate(opts.top_k);
        Ok(reranked)
    }

    /// The degraded path of [`Self::retrieve`]: this store's own half could not be
    /// produced (the embed sidecar or the rerank sidecar is down), so answer from the
    /// Spaces delegate alone — or re-raise `local_err` if that yields nothing.
    ///
    /// `local_err` is threaded in by value rather than logged at the call site
    /// precisely so this function has the option of returning it. A
    /// sidecar-unavailable error that becomes `Ok(vec![])` is the failure mode this
    /// whole change exists to avoid recreating one layer down: the chat path already
    /// swallows a retrieval error into a `warn!`, and an empty-and-silent result
    /// there is indistinguishable from "nothing was relevant".
    ///
    /// Note this does **not** fall back to cosine order on a rerank failure — it
    /// drops the local list entirely, exactly as the bare `?` did. Falling open to
    /// cosine (what the Spaces path does) would be a different, larger decision about
    /// what `POST /api/retrieval/search` returns; all that changes here is that one
    /// dead sidecar no longer takes down a Space that never needed it.
    ///
    /// There is no `fuse_ranked_lists` no-op subtlety here: with an empty primary and
    /// at least one non-empty Space list, fusion ranks by RRF position exactly as it
    /// would have, and the `score` field is a fusion score — the same scale the
    /// caller would have seen had the local half participated.
    ///
    /// # Why the prefix is formatted in, and not `.context(…)`
    ///
    /// `anyhow::Error::context` puts the new string *in front of* the cause in the
    /// chain, and `Display` renders only the head: `format!("{e}")` and `e.to_string()`
    /// on a context-wrapped error yield the context ALONE. Only the alternate form
    /// `{e:#}` walks the chain. That distinction is not academic here, because the two
    /// production callers of [`Self::retrieve`] disagree about which they use:
    ///
    /// - chat auto-recall (`sidecar::adapters`) logs `{e:#}` — chain visible;
    /// - `POST /api/retrieval/search` (`server::mod`) answers `500` with
    ///   `e.to_string()` — chain **invisible**.
    ///
    /// So wrapping with `.context` here would have deleted "connection refused to the
    /// embed sidecar" from the one surface an operator actually reads, and replaced it
    /// with a sentence that names no service — a regression in exactly the case this
    /// degraded path exists to keep diagnosable. Formatting `{local_err:#}` into a
    /// single message keeps the cause in `Display` for both callers. Nothing
    /// `downcast`s a retrieval error (checked across `server/mod.rs`,
    /// `sidecar/adapters/mod.rs` and this crate), so collapsing the chain costs
    /// nothing that is read.
    pub(crate) fn spaces_only(
        space_lists: Vec<Vec<ScoredChunk>>,
        opts: &RetrievalOptions,
        local_err: anyhow::Error,
    ) -> Result<Vec<ScoredChunk>> {
        let fused = fuse_ranked_lists(Vec::new(), space_lists, opts.top_k);
        if fused.is_empty() {
            return Err(anyhow::anyhow!(
                "retrieval: the local half failed and no Space answered without it:                  {local_err:#}"
            ));
        }
        tracing::warn!(
            "retrieval: local retrieval unavailable ({local_err:#}); answered from Spaces              only — memory and OKF chunks are MISSING from this result"
        );
        Ok(fused)
    }

    /// The Spaces half of [`Self::retrieve`]: ask the [`SpaceRecall`] delegate for
    /// one ranked list per selected Space. Returns an empty `Vec` — which makes
    /// [`fuse_ranked_lists`] a structural no-op — in every case where the delegation
    /// does not apply:
    ///
    /// - no delegate wired (the default, and every test that does not wire one);
    /// - `space_ids: Some([])`, i.e. "no Spaces" — the default agent's allowlist and
    ///   therefore the overwhelming majority of chat turns, which must stay free of
    ///   any `spaces.db` work;
    /// - the delegate could not resolve the Space set (warn + continue; the memory
    ///   and OKF half of the answer is unaffected, and there is no risk of silently
    ///   answering a graph-mode Space with vector hits, because this store holds no
    ///   rows for a real Space at all).
    ///
    /// `per_space_limit = opts.top_k`: each Space may fill the whole budget, and the
    /// fusion truncates the merged ranking back to `top_k`.
    pub(crate) async fn recall_spaces(
        &self,
        query: &str,
        opts: &RetrievalOptions,
    ) -> Vec<Vec<ScoredChunk>> {
        let Some(delegate) = self.spaces.as_ref() else {
            return Vec::new();
        };
        if opts.space_ids.as_ref().is_some_and(Vec::is_empty) {
            return Vec::new();
        }
        match delegate.recall(query, opts, opts.top_k).await {
            Ok(lists) => lists,
            Err(e) => {
                tracing::warn!("retrieval: Spaces delegate failed (skipping Spaces): {e:#}");
                Vec::new()
            }
        }
    }

    /// Score every in-scope chunk against `query_embedding` in one pass.
    ///
    /// Retrieval runs on every auto-recall turn, and all but the top few
    /// candidates are discarded. So the scan reads neither `content` nor an owned
    /// copy of the embedding: it scores straight from the borrowed blob and
    /// [`Self::fill_content`] reads content for the survivors only.
    pub(crate) async fn score_candidates(
        &self,
        query_embedding: &[f32],
        opts: &RetrievalOptions,
    ) -> Result<Vec<ScoredChunk>> {
        // Only consider chunks embedded by the *current* embedder. Mixing vector
        // spaces of equal length (e.g. legacy hashing vs nomic) produces garbage
        // cosine scores, and there is no dim guard to catch it — so we filter by
        // model id here. Chunks from a different/unknown embedder are skipped
        // until re-indexed, rather than silently returned as bad matches.
        let model = self.embedder_snapshot().model_id().to_string();
        // The scan may open every sealed vector of a partition: it runs on a
        // blocking thread with an owned connection guard, never on a runtime
        // worker.
        let conn = Arc::clone(&self.conn).lock_owned().await;
        let scorer = CandidateScorer {
            keys: Arc::clone(&self.keys),
            vectors: self.vectors.clone(),
            partitions: Arc::clone(&self.partitions),
            too_large: Arc::clone(&self.too_large),
            unreadable: Arc::clone(&self.unreadable),
        };
        let query = query_embedding.to_vec();
        let opts = opts.clone();
        tokio::task::spawn_blocking(move || scorer.score(&conn, &model, &query, &opts))
            .await
            .context("retrieval scoring task")?
    }

    /// Read `content` for the chunks that survived scoring, keeping their order.
    /// A chunk deleted between the scan and this read is dropped.
    pub(crate) async fn fill_content(&self, chunks: &mut Vec<ScoredChunk>) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let mut contents = std::collections::HashMap::with_capacity(chunks.len());
        let mut unreadable = 0;
        {
            let conn = self.conn.lock().await;
            // Batched to stay far below SQLite's bound-parameter limit.
            for batch in chunks.chunks(500) {
                let placeholders = vec!["?"; batch.len()].join(",");
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT id, content FROM chunks WHERE id IN ({placeholders})"
                    ))
                    .context("preparing chunk content query")?;
                let rows = stmt
                    .query_map(
                        rusqlite::params_from_iter(batch.iter().map(|chunk| chunk.id.as_str())),
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    )
                    .context("querying chunk content")?;
                for row in rows {
                    let (id, stored) = row?;
                    // A chunk whose sealed content does not open is dropped
                    // from the result (and counted), never returned empty.
                    match self.keys.cipher.open_text(&stored, &content_context(&id)) {
                        Ok(opened) => {
                            contents.insert(id, opened.value);
                        }
                        Err(_) => unreadable += 1,
                    }
                }
            }
        }
        self.note_unreadable(unreadable, "chunks");
        chunks.retain_mut(|chunk| match contents.remove(&chunk.id) {
            Some(content) => {
                chunk.content = content;
                true
            }
            None => false,
        });
        Ok(())
    }
}

/// The in-process default RAG provider: the sqlite-backed vector store with its
/// held embedder + reranker. A bound out-of-process provider (e.g. a GraphRAG
/// sidecar) would implement the same trait and be selected by the Core-side
/// resolver; consumers hold whichever instance the resolver mints.
#[async_trait::async_trait]
impl RagProvider for RetrievalStore {
    async fn embed(&self, text: &str) -> Result<Vec<f32>> {
        self.embedder_snapshot().embed(text).await
    }

    async fn retrieve(&self, query: &str, opts: &RetrievalOptions) -> Result<Vec<ScoredChunk>> {
        RetrievalStore::retrieve(self, query, opts).await
    }

    async fn rerank(&self, query: &str, candidates: Vec<ScoredChunk>) -> Result<Vec<ScoredChunk>> {
        self.reranker.rerank(query, candidates).await
    }
}
