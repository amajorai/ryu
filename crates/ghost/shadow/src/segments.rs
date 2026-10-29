//! Video and audio segment records and the visual change log.

use super::*;

/// Delete a video file. Updates the video_segments table.
pub fn delete_video_file(file_path: String) -> Result<u64, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    retention::delete_video_segment(&index.conn, &file_path).map_err(|e| {
        ShadowError::StorageError {
            msg: format!("Delete failed: {e}"),
        }
    })
}

/// Delete an audio file. Updates the audio_segments table.
pub fn delete_audio_file(file_path: String) -> Result<u64, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    retention::delete_audio_segment(&index.conn, &file_path).map_err(|e| {
        ShadowError::StorageError {
            msg: format!("Delete failed: {e}"),
        }
    })
}

/// Find a video segment by file path.
pub fn find_video_segment_by_path(
    file_path: String,
) -> Result<Option<timeline::VideoSegment>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .find_video_segment_by_path(&file_path)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Find video segment by path failed: {e}"),
        })
}

// MARK: - Video Segment Index

/// Register a new video recording segment (called when AVAssetWriter creates a file).
pub fn insert_video_segment(
    display_id: u32,
    start_ts: u64,
    file_path: String,
) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .insert_video_segment(display_id, start_ts, &file_path)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Insert video segment failed: {e}"),
        })
}

/// Finalize a video segment (called when AVAssetWriter finishes writing).
pub fn finalize_video_segment(file_path: String, end_ts: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .finalize_video_segment(&file_path, end_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Finalize video segment failed: {e}"),
        })?;
    drop(index);
    seal_closed_video_segment(std::path::Path::new(&file_path));
    Ok(())
}

/// The encoder closed `path`: seal it now, then sweep in the background so a
/// segment whose seal failed (or a dead process's leftover) is retried without
/// waiting for the next start. The segment stays readable either way.
pub fn seal_closed_video_segment(path: &std::path::Path) {
    media::mark_media_closed(path);
    if let Err(error) = media::seal_media_file(path) {
        log::warn!("shadow: could not seal a closed video segment yet: {error}");
    }
    if let Ok(paths) = get_data_paths() {
        media::spawn_sweep(paths.clone());
    }
}

/// Find the video segment covering a given timestamp for a display.
pub fn find_video_segment(
    display_id: u32,
    timestamp_us: u64,
) -> Result<Option<timeline::VideoSegment>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .find_video_segment(display_id, timestamp_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Find video segment failed: {e}"),
        })
}

/// List all video segments overlapping a time range. Used by OCR worker.
pub fn list_video_segments(
    start_us: u64,
    end_us: u64,
) -> Result<Vec<timeline::VideoSegment>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .list_video_segments_in_range(start_us, end_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("List video segments failed: {e}"),
        })
}

// MARK: - Visual Change Log

/// Record a visual change distance measurement from OCRWorker.
/// Called for every 10-second sample — records distance regardless of whether OCR runs.
pub fn record_visual_change(
    display_id: u32,
    timestamp_us: u64,
    distance: f32,
) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .record_visual_change(display_id, timestamp_us, distance)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Visual change record failed: {e}"),
        })
}

/// Query timestamps where visual change exceeds a threshold within a time range.
/// Returns timestamps in ascending order. Used by keyframe extraction.
pub fn query_visual_changes(
    display_id: u32,
    start_ts: u64,
    end_ts: u64,
    min_distance: f32,
) -> Result<Vec<u64>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .query_visual_changes(display_id, start_ts, end_ts, min_distance)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Visual change query failed: {e}"),
        })
}

// MARK: - Audio Segment Index

/// Register a new audio recording segment.
pub fn insert_audio_segment(
    source: String,
    start_ts: u64,
    file_path: String,
    display_id: Option<u32>,
    sample_rate: Option<u32>,
    channels: Option<u32>,
) -> Result<i64, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .insert_audio_segment(
            &source,
            start_ts,
            &file_path,
            display_id,
            sample_rate,
            channels,
        )
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Insert audio segment failed: {e}"),
        })
}

/// Finalize an audio segment (called when recording stops or rotates).
pub fn finalize_audio_segment(file_path: String, end_ts: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .finalize_audio_segment(&file_path, end_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Finalize audio segment failed: {e}"),
        })?;
    drop(index);
    if let Err(error) = media::seal_media_file(std::path::Path::new(&file_path)) {
        log::warn!("shadow: could not seal a closed audio segment yet: {error}");
    }
    Ok(())
}

/// Find the audio segment covering a given timestamp for a source.
pub fn find_audio_segment(
    source: String,
    timestamp_us: u64,
) -> Result<Option<timeline::AudioSegment>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .find_audio_segment(&source, timestamp_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Find audio segment failed: {e}"),
        })
}

/// List sealed audio segments overlapping a time range.
/// Returns only finalized segments (end_ts > 0) — active recordings are excluded.
/// Used by the transcription worker to discover segments to process.
pub fn list_audio_segments(
    start_us: u64,
    end_us: u64,
) -> Result<Vec<timeline::AudioSegment>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .list_audio_segments_in_range(start_us, end_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("List audio segments failed: {e}"),
        })
}

/// List sealed audio segments after a checkpoint segment_id.
/// Returns segments ordered by segment_id ASC, limited to `limit` results.
/// Used by the transcription worker for skip-safe checkpoint-based pagination.
/// Use segment_id 0 to start from the beginning.
pub fn list_audio_segments_after_checkpoint(
    last_segment_id: i64,
    limit: u32,
) -> Result<Vec<timeline::AudioSegment>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .list_audio_segments_after_checkpoint(last_segment_id, limit)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("List audio segments after checkpoint failed: {e}"),
        })
}

/// Finalize all orphan audio segments (end_ts = 0) from a previous crash.
/// Returns the count of orphans finalized.
pub fn list_orphan_audio_segments() -> Result<u32, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let now = wall_micros();
    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .finalize_orphan_audio_segments(now)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Finalize orphan audio segments failed: {e}"),
        })
}
