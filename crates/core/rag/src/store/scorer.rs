//! Chunk filters, tenancy predicates, embedding codec and the blocking
//! [`CandidateScorer`].

use super::*;

/// The metadata object a [`MetadataFilter`] sees for one `retrieval.db` chunk:
/// the stored caller metadata, overlaid with the built-in fields (which win, so
/// stored metadata cannot impersonate them).
pub(crate) fn chunk_filter_metadata(
    chunk: &RetrievableChunk,
    stored: Option<&str>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut map = stored
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default();
    map.insert("source".into(), chunk.source.as_str().into());
    if let Some(space_id) = &chunk.space_id {
        map.insert("space_id".into(), space_id.clone().into());
    }
    if chunk.source == ChunkSource::Memory {
        if let Some(scope) = &chunk.mem_scope {
            map.insert("scope".into(), scope.clone().into());
        }
        if let Some(agent_id) = &chunk.mem_agent_id {
            map.insert("agent_id".into(), agent_id.clone().into());
        }
        map.insert("importance".into(), chunk.mem_importance.into());
    }
    map
}

/// Decide whether a chunk is in scope for this retrieval request, merging the
/// memory toggle with the Space selection.
pub(crate) fn chunk_matches(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    match chunk.source {
        ChunkSource::Memory => {
            opts.include_memory
                && (opts.include_sensitive || (chunk.mem_metadata_ready && !chunk.mem_sensitive))
                && memory_level_matches(chunk, opts)
                && memory_tenancy_allows(chunk, opts)
        }
        ChunkSource::Space => {
            let space_selected = match &opts.space_ids {
                // `None` => search all Spaces.
                None => true,
                // A list (possibly empty) => only those Spaces.
                Some(ids) => chunk
                    .space_id
                    .as_ref()
                    .is_some_and(|sid| ids.iter().any(|want| want == sid)),
            };
            space_selected && space_tenancy_allows(chunk, opts)
        }
    }
}

/// Per-caller tenancy for a MEMORY chunk — the retrieval twin of the memory-store
/// visibility predicate. On an UNBOUND node (`node_bound = false`) it is a no-op
/// (byte-identical). On a BOUND node: `node`/`project` scopes are the shared "company
/// brain" (visible to every member), while `agent`/`user`-scope facts are PRIVATE — returned
/// only to their owner. A user-scope chunk whose owner does not equal the caller
/// (including legacy NULL/`'local'` owners the backfill has not yet reached) is
/// hidden. This is the filter that stops one member retrieving another's private
/// memory via `/api/retrieval/search`.
pub(crate) fn memory_tenancy_allows(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    if !opts.node_bound {
        return true;
    }
    let scope = chunk.mem_scope.as_deref().unwrap_or("user");
    match scope {
        "node" | "project" => true,
        // Org scope: visible to a caller in THAT org. Deliberately matched on
        // `mem_scope_id` (which mirrors the store's `scope_id`) rather than the
        // denormalized `owner_org_id`, so this stays the exact twin of
        // `MEMORY_VISIBLE_PREDICATE` — the two must agree, and agreeing is easier to
        // verify when they read the same field. A missing scope id or caller org
        // fails closed.
        "org" => matches!(
            (chunk.mem_scope_id.as_deref(), opts.caller_org_id.as_deref()),
            (Some(chunk_org), Some(caller_org)) if chunk_org == caller_org
        ),
        // user scope (and any unknown scope, treated as user) → owner-only.
        _ => matches!(
            (chunk.owner_user_id.as_deref(), opts.caller_user_id.as_deref()),
            (Some(owner), Some(caller)) if owner == caller
        ),
    }
}

/// Per-caller tenancy for a SPACE chunk — the retrieval twin of
/// `memory_tenancy_allows`, and FAIL-CLOSED like it. UNBOUND → no-op. BOUND: a
/// chunk is visible to its recorded owner (`owner_user_id == caller_user_id`), or
/// — for content with no specific user owner (OKF bundles, node-shared docs) — to
/// any caller in the org it was EXPLICITLY stamped shared to (`owner_org_id`
/// matches the caller's org AND `visibility` is `org`/`team`). A BARE unowned
/// chunk (no `owner_user_id` AND no matching explicit org/team stamp — pre-tenancy
/// legacy rows the backfill has not reached) is HIDDEN, not shared: unlike memory,
/// Space chunks carry real document CONTENT, so treating "nobody recorded an
/// owner" as "safe to show everyone" was the content-escape gap this closes.
/// Genuinely shared knowledge (OKF bundles) stamps its explicit org/team
/// visibility at index time (see [`RetrievalStore::ingest_okf_bundle`]) so it
/// never depends on the bare-unowned case to stay visible.
pub(crate) fn space_tenancy_allows(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    if !opts.node_bound {
        return true;
    }
    if let Some(owner) = chunk.owner_user_id.as_deref() {
        if opts.caller_user_id.as_deref() == Some(owner) {
            return true;
        }
    }
    matches!(
        (
            chunk.owner_org_id.as_deref(),
            opts.caller_org_id.as_deref(),
            chunk.visibility.as_deref(),
        ),
        (Some(org), Some(caller_org), Some(vis)) if org == caller_org && (vis == "org" || vis == "team")
    )
}

/// Whether a `Memory` chunk passes the caller's level + active-agent/project filter.
/// Legacy chunks with no `mem_scope` are treated as `"user"` (broadly visible).
/// `read_levels == None` allows every level EXCEPT `"org"` (see below).
/// Agent-scoped chunks require `mem_scope_id == opts.agent_id`; project-scoped
/// chunks require `mem_scope_id == opts.project_id`.
///
/// **Org is opt-in.** `read_levels == None` means "unconfigured", and every agent
/// that predates org scope is unconfigured. Letting the permissive default cover
/// `"org"` would hand all of them organization-wide memory the moment the level
/// shipped — a privacy default change smuggled in as a schema addition. So `"org"`
/// is only ever returned when an agent NAMES it, matching
/// `MemoryStore::effective_levels`, which excludes it from its default set for the
/// same reason. The two defaults must agree or the store and the retrieval index
/// disagree about what an unconfigured agent can see.
pub(crate) fn memory_level_matches(chunk: &RetrievableChunk, opts: &RetrievalOptions) -> bool {
    let scope = chunk.mem_scope.as_deref().unwrap_or("user");
    match &opts.read_levels {
        Some(levels) => {
            if !levels.iter().any(|l| l == scope) {
                return false;
            }
        }
        None if scope == "org" => return false,
        None => {}
    }
    if scope == "agent" {
        return match (chunk.mem_scope_id.as_deref(), opts.agent_id.as_deref()) {
            (Some(memory_agent), Some(active_agent)) => memory_agent == active_agent,
            _ => false,
        };
    }
    if scope == "project" {
        return match (chunk.mem_scope_id.as_deref(), opts.project_id.as_deref()) {
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
    }
    true
}

/// Encode an embedding as little-endian f32 bytes for BLOB storage.
pub(crate) fn encode_embedding(vec: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vec.len() * 4);
    for v in vec {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    bytes
}

/// Decode a little-endian f32 BLOB back into an embedding vector.
/// Count and log rows whose sealed value did not open.
pub(crate) fn note_unreadable(counter: &AtomicU64, count: u64, what: &str) {
    if count == 0 {
        return;
    }
    let total = counter.fetch_add(count, Ordering::Relaxed) + count;
    tracing::warn!(
        skipped = count,
        total,
        "retrieval store: skipped {what} whose sealed value did not open \
         (retrieval.db.unreadable_rows)"
    );
}

/// What a blocking candidate scan needs, detached from the async store.
pub(crate) struct CandidateScorer {
    pub(crate) keys: Arc<RetrievalKeys>,
    pub(crate) vectors: VectorIndex,
    pub(crate) partitions: Arc<StdMutex<HashSet<PartitionKey>>>,
    pub(crate) too_large: Arc<StdMutex<HashSet<PartitionKey>>>,
    pub(crate) unreadable: Arc<AtomicU64>,
}

impl CandidateScorer {
    /// Score every in-scope chunk of the current model (see
    /// `RetrievalStore::score_candidates`).
    pub(crate) fn score(
        &self,
        conn: &Connection,
        model: &str,
        query_embedding: &[f32],
        opts: &RetrievalOptions,
    ) -> Result<Vec<ScoredChunk>> {
        // Metadata pass (no content, no vectors): the tenancy/scope filter
        // decides which chunks are candidates, grouped by vector partition.
        let mut candidates: Vec<(RetrievableChunk, PartitionKey)> = Vec::new();
        // The sealed filter metadata is read (and opened) only for a request
        // that carries a metadata filter.
        let active_filter = opts.filter.as_ref().filter(|f| !f.is_empty());
        let metadata_column = if active_filter.is_some() {
            "metadata"
        } else {
            "NULL"
        };
        let mut stmt = conn
            .prepare(&format!(
                "SELECT id, source, space_id, NULL,                         mem_scope, mem_scope_id, mem_agent_id, mem_importance, mem_sensitive,                         mem_metadata_ready, owner_user_id, owner_org_id, visibility, {metadata_column} FROM chunks                  WHERE embedding_model = ?1"
            ))
            .context("preparing candidate query")?;
        let mut rows = stmt.query(params![model]).context("querying candidates")?;
        let mut unreadable_metadata = 0u64;
        while let Some(row) = rows.next()? {
            let chunk = RetrievableChunk {
                id: row.get(0)?,
                source: ChunkSource::from_str(&row.get::<_, String>(1)?),
                space_id: row.get(2)?,
                content: String::new(),
                mem_scope: row.get(4)?,
                mem_scope_id: row.get(5)?,
                mem_agent_id: row.get(6)?,
                mem_importance: row
                    .get::<_, Option<i32>>(7)?
                    .unwrap_or(DEFAULT_MEM_IMPORTANCE),
                mem_sensitive: row.get::<_, Option<i64>>(8)?.unwrap_or(0) == 1,
                mem_metadata_ready: row.get::<_, Option<i64>>(9)?.unwrap_or(0) == 1,
                owner_user_id: row.get(10)?,
                owner_org_id: row.get(11)?,
                visibility: row.get(12)?,
            };
            if !chunk_matches(&chunk, opts) {
                continue;
            }
            if let Some(filter) = active_filter {
                let stored: Option<String> = row.get(13)?;
                let opened = match stored {
                    Some(sealed) => match self
                        .keys
                        .cipher
                        .open_text(&sealed, &metadata_context(&chunk.id))
                    {
                        Ok(opened) => Some(opened.value),
                        // Fail closed: a chunk whose metadata does not open
                        // cannot be shown to satisfy the filter.
                        Err(_) => {
                            unreadable_metadata += 1;
                            continue;
                        }
                    },
                    None => None,
                };
                if !filter.matches(&chunk_filter_metadata(&chunk, opened.as_deref())) {
                    continue;
                }
            }
            let partition =
                PartitionKey::new(&model, &row.get::<_, String>(1)?, chunk.space_id.as_deref());
            candidates.push((chunk, partition));
        }
        drop(rows);
        drop(stmt);
        note_unreadable(&self.unreadable, unreadable_metadata, "chunk metadata");

        // Score each needed partition (only its candidates) from the in-memory
        // index, hydrated from the sealed vectors on first use.
        let mut wanted: HashMap<PartitionKey, HashSet<String>> = HashMap::new();
        for (chunk, partition) in &candidates {
            wanted
                .entry(partition.clone())
                .or_default()
                .insert(chunk.id.clone());
        }
        let mut scores: HashMap<PartitionKey, HashMap<String, f32>> = HashMap::new();
        for (partition, ids) in &wanted {
            let scored = self.partition_scores(conn, partition, ids, query_embedding)?;
            scores.insert(partition.clone(), scored);
        }

        let mut out = Vec::new();
        for (chunk, partition) in candidates {
            // Missing: the vector did not open, or has another width.
            let Some(mut score) = scores
                .get(&partition)
                .and_then(|scored| scored.get(&chunk.id))
                .copied()
            else {
                continue;
            };
            // Nudge memory chunks by importance so high-value facts break ties.
            if chunk.source == ChunkSource::Memory {
                score +=
                    (chunk.mem_importance - DEFAULT_MEM_IMPORTANCE) as f32 * IMPORTANCE_BOOST_STEP;
            }
            if score >= opts.min_score {
                out.push(ScoredChunk {
                    id: chunk.id,
                    source: chunk.source,
                    space_id: chunk.space_id,
                    content: String::new(),
                    score,
                });
            }
        }
        Ok(out)
    }

    /// Stream one partition's opened vectors through `consume`; rows that do
    /// not open are skipped (and counted when `count_unreadable`). Nothing is
    /// collected here.
    pub(crate) fn with_partition<R>(
        &self,
        conn: &Connection,
        key: &PartitionKey,
        count_unreadable: bool,
        consume: impl FnOnce(&mut dyn Iterator<Item = (String, Vec<f32>)>) -> R,
    ) -> Result<R> {
        let mut stmt = conn.prepare(
            "SELECT id, embedding FROM chunks
             WHERE embedding_model = ?1 AND source = ?2 AND space_id IS ?3",
        )?;
        let mut rows = stmt.query(params![key.model, key.source, key.space_id])?;
        let mut failure: Option<rusqlite::Error> = None;
        let mut unreadable = 0u64;
        let result = {
            let mut opened = std::iter::from_fn(|| loop {
                let row = match rows.next() {
                    Ok(Some(row)) => row,
                    Ok(None) => return None,
                    Err(error) => {
                        failure = Some(error);
                        return None;
                    }
                };
                let read = row
                    .get::<_, String>(0)
                    .and_then(|id| Ok((id, row.get::<_, Vec<u8>>(1)?)));
                let (id, stored) = match read {
                    Ok(read) => read,
                    Err(error) => {
                        failure = Some(error);
                        return None;
                    }
                };
                match self
                    .keys
                    .cipher
                    .open_bytes(&stored, &embedding_context(&id, &key.model))
                {
                    Ok(opened) if opened.value.len() % 4 == 0 => {
                        return Some((id, decode_embedding_blob(&opened.value)));
                    }
                    _ => unreadable += 1,
                }
            });
            consume(&mut opened)
        };
        if let Some(error) = failure {
            return Err(error.into());
        }
        if count_unreadable {
            note_unreadable(&self.unreadable, unreadable, "vectors");
        }
        Ok(result)
    }

    /// Cosine scores of `candidates` in one partition, hydrating it straight
    /// from the row stream on first use. A partition larger than the whole
    /// cache budget is remembered as such and scored from the stream, keeping
    /// only the candidates' scores.
    pub(crate) fn partition_scores(
        &self,
        conn: &Connection,
        key: &PartitionKey,
        candidates: &HashSet<String>,
        query: &[f32],
    ) -> Result<HashMap<String, f32>> {
        let name = key.name();
        let keep = |id: &str| candidates.contains(id);
        let k = candidates.len();
        if let Some(hits) = self.vectors.search_filtered(&name, query, k, &keep) {
            return Ok(hits.into_iter().collect());
        }
        self.partitions
            .lock()
            .expect("partition registry poisoned")
            .insert(key.clone());
        let too_large = self
            .too_large
            .lock()
            .expect("partition registry poisoned")
            .contains(key);
        let mut counted = false;
        if !too_large {
            let hydrated = self.with_partition(conn, key, true, |rows| {
                self.vectors.hydrate_partition(&name, rows)
            })?;
            counted = true;
            match hydrated {
                Ok(()) => {
                    return Ok(self
                        .vectors
                        .search_filtered(&name, query, k, &keep)
                        .unwrap_or_default()
                        .into_iter()
                        .collect())
                }
                Err(error) => {
                    self.too_large
                        .lock()
                        .expect("partition registry poisoned")
                        .insert(key.clone());
                    tracing::warn!("retrieval store: {error}; scoring without the cache");
                }
            }
        }
        self.with_partition(conn, key, !counted, |rows| {
            rows.filter(|(id, vector)| keep(id) && vector.len() == query.len())
                .map(|(id, vector)| {
                    let score = cosine_similarity(query, &vector);
                    (id, score)
                })
                .collect()
        })
    }
}

pub(crate) fn decode_embedding_blob(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
