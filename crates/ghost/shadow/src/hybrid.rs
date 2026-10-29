//! Vector index and hybrid (text plus vector) search.

use super::*;

// MARK: - Vector Index

/// Insert a batch of vector embeddings into the vector index.
/// Called by the Swift embedding worker after processing video frames.
/// Returns the number of entries indexed.
pub fn insert_vector_entries(entries: Vec<vector::VectorEntry>) -> Result<u32, ShadowError> {
    if entries.is_empty() {
        return Ok(0);
    }

    let vector = VECTOR.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Vector index not initialized".into(),
    })?;

    let mut vec_idx = vector.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    vec_idx
        .insert_entries(&entries)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to index vector entries: {e}"),
        })
}

/// Search the vector index with a query vector.
/// Returns the top `limit` results sorted by cosine similarity.
pub fn search_vector(
    query_vector: Vec<f32>,
    limit: u32,
) -> Result<Vec<vector::VectorSearchResult>, ShadowError> {
    let vector = VECTOR.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Vector index not initialized".into(),
    })?;

    let vec_idx = vector.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    vec_idx
        .search(&query_vector, limit as usize)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Vector search failed: {e}"),
        })
}

/// Execute a hybrid search combining text and vector retrieval.
/// If `query_vector` is provided, merges text results with vector results.
/// If `query_vector` is empty, behaves identically to `search_text`.
/// Returns deduplicated results sorted by relevance.
pub fn search_hybrid(
    query: String,
    query_vector: Vec<f32>,
    limit: u32,
) -> Result<Vec<search::SearchResult>, ShadowError> {
    // Text search (always)
    let text_results = search_text(query.clone(), limit)?;

    // Vector search (only if query_vector is non-empty)
    if query_vector.is_empty() {
        return Ok(text_results);
    }

    let vector = VECTOR.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Vector index not initialized".into(),
    })?;

    let vec_idx = vector.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    let vector_results =
        vec_idx
            .search(&query_vector, limit as usize)
            .map_err(|e| ShadowError::QueryError {
                msg: format!("Vector search failed: {e}"),
            })?;

    if vector_results.is_empty() {
        return Ok(text_results);
    }

    // Look up app context for vector results and convert to SearchResult format
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let tl_index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Normalize text scores to [0, 1] for fair comparison
    let max_text_score = text_results.iter().map(|r| r.score).fold(0.0f32, f32::max);
    let text_norm = if max_text_score > 0.0 {
        max_text_score
    } else {
        1.0
    };

    let mut all_results: Vec<search::SearchResult> = text_results
        .into_iter()
        .map(|mut r| {
            r.score /= text_norm; // Normalize to [0, 1]
            r
        })
        .collect();

    // Convert vector results to SearchResult format
    for vr in &vector_results {
        let app_ctx = tl_index.find_app_at_timestamp(vr.ts).ok().flatten();
        let app_name = app_ctx
            .as_ref()
            .map(|c| c.app_name.clone())
            .unwrap_or_default();

        all_results.push(search::SearchResult {
            ts: vr.ts,
            app_name,
            window_title: String::new(),
            url: String::new(),
            display_id: Some(vr.display_id),
            event_type: String::new(),
            score: vr.score, // Cosine similarity already in [0, 1] for normalized vectors
            match_reason: "visual".to_string(),
            source_kind: "visual".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        });
    }

    // Sort by score descending (all normalized to ~[0, 1])
    all_results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Dedup using existing logic
    let deduped = search::deduplicate_results_public(all_results, limit as usize);

    Ok(deduped)
}

/// Text-query semantic search: falls back to full-text search since CLIP
/// embeddings require a model that may not be loaded.
pub fn vector_search(
    query: String,
    limit: u32,
) -> Result<Vec<vector::VectorSearchResult>, ShadowError> {
    let text_results = search_text(query, limit)?;
    Ok(text_results
        .into_iter()
        .map(|r| vector::VectorSearchResult {
            ts: r.ts,
            display_id: r.display_id.unwrap_or(0),
            score: r.score,
            file_path: String::new(),
            frame_offset_us: 0,
        })
        .collect())
}

/// Search the vector index within a timestamp range.
/// Returns the top `limit` results where `ts_wall_us` is between `start_us` and `end_us`.
pub fn search_vector_in_range(
    query_vector: Vec<f32>,
    start_us: u64,
    end_us: u64,
    limit: u32,
) -> Result<Vec<vector::VectorSearchResult>, ShadowError> {
    let vector = VECTOR.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Vector index not initialized".into(),
    })?;

    let vec_idx = vector.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    vec_idx
        .search_in_range(&query_vector, start_us, end_us, limit as usize)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Vector range search failed: {e}"),
        })
}

/// Execute a hybrid search within a timestamp range.
/// Combines text search (Tantivy) with vector search (CLIP), both filtered to [start_us, end_us].
/// If `query_vector` is empty, only text search is performed.
/// Returns deduplicated results sorted by relevance.
pub fn search_hybrid_in_range(
    query: String,
    query_vector: Vec<f32>,
    start_us: u64,
    end_us: u64,
    limit: u32,
) -> Result<Vec<search::SearchResult>, ShadowError> {
    // Text search within range
    let search = SEARCH.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Search index not initialized".into(),
    })?;

    let search_idx = search.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    let text_results = search_idx
        .search_in_range(&query, start_us, end_us, limit as usize)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Text range search failed: {e}"),
        })?;

    drop(search_idx); // Release lock before acquiring vector lock

    // Vector search within range (only if query_vector is non-empty)
    if query_vector.is_empty() {
        return Ok(text_results);
    }

    let vector = VECTOR.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Vector index not initialized".into(),
    })?;

    let vec_idx = vector.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    let vector_results = vec_idx
        .search_in_range(&query_vector, start_us, end_us, limit as usize)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Vector range search failed: {e}"),
        })?;

    drop(vec_idx);

    if vector_results.is_empty() {
        return Ok(text_results);
    }

    // Look up app context for vector results
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let tl_index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Normalize text scores to [0, 1]
    let max_text_score = text_results.iter().map(|r| r.score).fold(0.0f32, f32::max);
    let text_norm = if max_text_score > 0.0 {
        max_text_score
    } else {
        1.0
    };

    let mut all_results: Vec<search::SearchResult> = text_results
        .into_iter()
        .map(|mut r| {
            r.score /= text_norm;
            r
        })
        .collect();

    for vr in &vector_results {
        let app_ctx = tl_index.find_app_at_timestamp(vr.ts).ok().flatten();
        let app_name = app_ctx
            .as_ref()
            .map(|c| c.app_name.clone())
            .unwrap_or_default();

        all_results.push(search::SearchResult {
            ts: vr.ts,
            app_name,
            window_title: String::new(),
            url: String::new(),
            display_id: Some(vr.display_id),
            event_type: String::new(),
            score: vr.score,
            match_reason: "visual".to_string(),
            source_kind: "visual".to_string(),
            snippet: String::new(),
            audio_segment_id: None,
            audio_source: String::new(),
            ts_end: 0,
            confidence: None,
        });
    }

    all_results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let deduped = search::deduplicate_results_public(all_results, limit as usize);
    Ok(deduped)
}

/// Get vector index statistics for diagnostics.
pub fn get_vector_index_stats() -> Result<vector::VectorIndexStats, ShadowError> {
    let vector = VECTOR.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Vector index not initialized".into(),
    })?;

    let vec_idx = vector.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    vec_idx.stats().map_err(|e| ShadowError::QueryError {
        msg: format!("Vector index stats failed: {e}"),
    })
}

/// Get search index statistics for diagnostics.
pub fn get_search_index_stats() -> Result<search::SearchIndexStats, ShadowError> {
    let search = SEARCH.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Search index not initialized".into(),
    })?;

    let index = search.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    Ok(index.stats())
}
