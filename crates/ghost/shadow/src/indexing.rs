//! Full-text search index: queries, indexing passes, and checkpoints.

use super::*;

// MARK: - Search Index

/// Execute a text search query. Returns top `limit` results ordered by relevance.
pub fn search_text(query: String, limit: u32) -> Result<Vec<search::SearchResult>, ShadowError> {
    let search = SEARCH.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Search index not initialized".into(),
    })?;

    let index = search.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .search(&query, limit as usize)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Search failed: {e}"),
        })
}

/// Index events that have been captured since the last checkpoint.
/// Call periodically (e.g., every 30 seconds) to keep the search index current.
/// Returns the number of events indexed.
pub fn index_recent_events() -> Result<u32, ShadowError> {
    // Lock timeline first (lock ordering: TIMELINE before SEARCH)
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut tl_index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Read checkpoint
    let checkpoint =
        tl_index
            .get_checkpoint("search_text")
            .map_err(|e| ShadowError::QueryError {
                msg: format!("Failed to read checkpoint: {e}"),
            })?;

    // Query events since checkpoint
    let now_us = wall_micros();
    let entries =
        tl_index
            .query_range(checkpoint + 1, now_us)
            .map_err(|e| ShadowError::QueryError {
                msg: format!("Failed to query events for indexing: {e}"),
            })?;

    if entries.is_empty() {
        return Ok(0);
    }

    // Lock search index (while holding timeline — allowed by lock ordering)
    let search = SEARCH.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Search index not initialized".into(),
    })?;

    let mut search_idx = search.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Index the entries
    let count = search_idx
        .index_entries(&entries)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to index entries: {e}"),
        })?;

    // Update checkpoint to the timestamp of the last entry
    if let Some(last) = entries.last() {
        tl_index
            .set_checkpoint("search_text", last.ts)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to update checkpoint: {e}"),
            })?;
    }

    Ok(count)
}

/// Index a batch of OCR text entries into the search index.
/// Called by the Swift OCR worker after processing video frames.
/// Returns the number of entries indexed.
pub fn index_ocr_text(entries: Vec<search::OcrEntry>) -> Result<u32, ShadowError> {
    if entries.is_empty() {
        return Ok(0);
    }

    let search = SEARCH.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Search index not initialized".into(),
    })?;

    let mut search_idx = search.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    search_idx
        .index_ocr_entries(&entries)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to index OCR entries: {e}"),
        })
}

/// Index a batch of transcript chunk entries into the search index.
/// Called by the Swift transcription worker after processing audio segments.
/// Returns the number of entries indexed.
pub fn index_transcript_text(entries: Vec<search::TranscriptEntry>) -> Result<u32, ShadowError> {
    if entries.is_empty() {
        return Ok(0);
    }

    let search = SEARCH.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Search index not initialized".into(),
    })?;

    let mut search_idx = search.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    search_idx
        .index_transcript_entries(&entries)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to index transcript entries: {e}"),
        })
}

/// List transcript chunks within a time range, with pagination.
/// Returns up to `limit` results starting at `offset`, sorted by ts_start ascending.
/// Used by the meeting summarization pipeline to retrieve all transcript text
/// within a time window without loading the entire index into memory.
pub fn list_transcript_chunks_in_range(
    start_us: u64,
    end_us: u64,
    limit: u32,
    offset: u32,
) -> Result<Vec<search::TranscriptChunkResult>, ShadowError> {
    let search = SEARCH.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Search index not initialized".into(),
    })?;

    let index = search.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .list_transcript_chunks_in_range(start_us, end_us, limit, offset)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("List transcript chunks failed: {e}"),
        })
}

/// Read whole speech windows that overlap the requested time range.
pub fn list_transcript_chunks_overlapping(
    start_us: u64,
    end_us: u64,
    limit: u32,
    offset: u32,
) -> Result<Vec<search::TranscriptChunkResult>, ShadowError> {
    let search = SEARCH.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Search index not initialized".into(),
    })?;
    let index = search.lock().map_err(|_| ShadowError::QueryError {
        msg: "Search index lock unavailable".into(),
    })?;
    index
        .list_transcript_chunks_overlapping(start_us, end_us, limit, offset)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("List transcript chunks failed: {e}"),
        })
}

/// Get the last checkpoint timestamp for a named index.
/// Used by Swift workers to determine where to resume processing.
pub fn get_index_checkpoint(index_name: String) -> Result<u64, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .get_checkpoint(&index_name)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Failed to read checkpoint: {e}"),
        })
}

/// Set the checkpoint timestamp for a named index.
/// Used by Swift workers to persist progress.
pub fn set_index_checkpoint(index_name: String, last_ts: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .set_checkpoint(&index_name, last_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to set checkpoint: {e}"),
        })
}
