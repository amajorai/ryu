//! Integrity checks, capture sessions, app focus, and segment rotation.

use super::*;

/// Run segment/index integrity check. Returns a report of consistency issues.
pub fn check_integrity() -> Result<timeline::IntegrityReport, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .check_segment_integrity()
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Integrity check failed: {e}"),
        })
}

/// Register a capture session in the timeline. Call at capture start.
pub fn register_session(session_id: String, start_ts: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .register_session(&session_id, start_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Register session failed: {e}"),
        })?;

    info!("Session registered: {}", session_id);
    Ok(())
}

/// Finalize a capture session. Call at capture shutdown.
pub fn finalize_session(session_id: String, end_ts: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .finalize_session(&session_id, end_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Finalize session failed: {e}"),
        })?;

    info!("Session finalized: {}", session_id);
    Ok(())
}

/// Close any open app focus interval. Call on session end or system sleep.
pub fn close_focus_interval(end_ts: u64) -> Result<(), ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .close_open_focus_interval(end_ts)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Close focus interval failed: {e}"),
        })
}

/// Find which app was focused at a specific timestamp.
/// Returns None if no focus interval covers that timestamp.
/// Used by OCR worker for temporally-accurate app context enrichment.
pub fn find_app_at_timestamp(
    timestamp_us: u64,
) -> Result<Option<timeline::AppContext>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .find_app_at_timestamp(timestamp_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Find app at timestamp failed: {e}"),
        })
}

/// Flush current segment and rotate to a new one.
pub fn flush_and_rotate() -> Result<(), ShadowError> {
    let storage = STORAGE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Storage not initialized".into(),
    })?;

    let mut writer = storage.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    writer.rotate().map_err(|e| ShadowError::StorageError {
        msg: format!("Rotation failed: {e}"),
    })?;

    // Update segment tracking
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    let now_us = wall_micros();

    if let Some(rotation) = writer.take_last_rotation() {
        index
            .seal_current_event_segment(
                now_us,
                rotation.compressed_path.as_deref(),
                rotation.compressed_path.as_ref().map(|_| "zstd"),
            )
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Seal segment failed: {e}"),
            })?;
    }

    // Register the new segment
    let new_path = writer.current_segment_path();
    index
        .resolve_event_segment(&new_path, now_us)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Register new segment failed: {e}"),
        })?;

    info!("Segment rotated, new segment: {}", new_path);
    Ok(())
}
