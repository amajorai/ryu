//! Keyframe records extracted from (or written instead of) video.

use super::*;

/// Register extracted keyframes for a video segment.
/// Called by Swift after keyframe extraction succeeds. Updates tier to 'warm'.
pub fn register_keyframes(
    source_segment: String,
    keyframes: Vec<retention::KeyframeRecord>,
) -> Result<u32, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    let mut count = 0u32;
    let tx = index
        .conn
        .transaction()
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Transaction failed: {e}"),
        })?;
    for kf in &keyframes {
        tx.execute(
            "INSERT OR IGNORE INTO keyframes (display_id, ts, file_path, source_segment, size_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                kf.display_id,
                kf.ts as i64,
                kf.file_path,
                source_segment,
                kf.size_bytes as i64
            ],
        )
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Insert keyframe failed: {e}"),
        })?;
        count += 1;
    }
    tx.commit().map_err(|e| ShadowError::StorageError {
        msg: format!("Commit failed: {e}"),
    })?;
    // NOTE: Tier update intentionally NOT done here.
    // The Swift caller (RetentionCoordinator.finalizeKeyframes) updates the tier
    // to 'warm' only AFTER successfully deleting the source video file.
    // This prevents orphaned video files if deletion fails.
    Ok(count)
}

/// List keyframe file paths for a source segment.
pub fn list_keyframe_paths(source_segment: String) -> Result<Vec<String>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .list_keyframe_paths_for_segment(&source_segment)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("List keyframe paths failed: {e}"),
        })
}

/// List keyframes captured within [start_us, end_us], ordered oldest→newest.
/// `display_id = None` spans all displays. Ephemeral read used by the "recent
/// activity" bundle; persists nothing.
pub fn keyframes_between(
    display_id: Option<i64>,
    start_us: u64,
    end_us: u64,
) -> Result<Vec<retention::KeyframeRecord>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .keyframes_between(display_id, start_us, end_us)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("keyframes_between failed: {e}"),
        })
}

/// Delete keyframe DB rows for a source segment. Call AFTER deleting files.
pub fn delete_keyframe_rows(source_segment: String) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .delete_keyframe_rows_for_segment(&source_segment)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Delete keyframe rows failed: {e}"),
        })?;
    Ok(())
}

/// Update a video segment's retention tier.
pub fn update_video_segment_tier(file_path: String, tier: String) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .update_video_segment_tier(&file_path, &tier)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Tier update failed: {e}"),
        })
}

/// Insert a keyframe record (display, timestamp, JPEG path on disk).
///
/// Mirrors `insert_video_segment`. Used by the pure-Rust keyframe writer, which
/// saves a JPEG of the screen directly (no MP4/ffmpeg) so the timeline scrubber
/// has frames to show out of the box. `source_segment` is a free-form provenance
/// tag — direct keyframes pass `"direct"` since they have no backing MP4.
pub fn insert_keyframe(
    display_id: u32,
    ts: u64,
    file_path: String,
    source_segment: String,
    size_bytes: Option<u64>,
) -> Result<(), ShadowError> {
    // Keyframes are screen content: a writer that wrote plaintext gets it
    // sealed in place here (a no-op for one written sealed).
    media::seal_media_file(std::path::Path::new(&file_path))?;
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .insert_keyframe(display_id, ts, &file_path, &source_segment, size_bytes)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Insert keyframe failed: {e}"),
        })
}

/// Prune keyframe rows older than `cutoff_ts` (Unix microseconds), returning the
/// JPEG file paths that were removed so the caller can delete them from disk.
pub fn prune_keyframes_before(cutoff_ts: u64) -> Result<Vec<String>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .prune_keyframes_before(cutoff_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Prune keyframes failed: {e}"),
        })
}

/// Find the nearest keyframe to a timestamp for a display.
/// Used by FrameExtractor as fallback when video segment is deleted.
pub fn find_nearest_keyframe(
    display_id: u32,
    timestamp_us: u64,
) -> Result<Option<String>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    index
        .find_nearest_keyframe(display_id, timestamp_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Keyframe lookup failed: {e}"),
        })
}
