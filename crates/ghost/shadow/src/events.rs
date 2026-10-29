//! Event log writes and the timeline, journal, and day-summary reads.

use super::*;

/// Write a raw MessagePack event to the current log segment.
pub fn write_event(msgpack_data: Vec<u8>) -> Result<(), ShadowError> {
    seal::require_writable()?;
    let storage = STORAGE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Storage not initialized".into(),
    })?;

    let mut writer = storage.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Parse enough to extract timestamp and track for the index
    let header =
        event::parse_event_header(&msgpack_data).map_err(|e| ShadowError::SerializationError {
            msg: format!("Failed to parse event header: {e}"),
        })?;

    // Write raw bytes to the append-only log
    writer
        .append(&msgpack_data)
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Write failed: {e}"),
        })?;

    // Update the timeline index
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Handle rotation if it happened during append
    if let Some(rotation) = writer.take_last_rotation() {
        index
            .seal_current_event_segment(
                header.effective_ts(),
                rotation.compressed_path.as_deref(),
                rotation.compressed_path.as_ref().map(|_| "zstd"),
            )
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Seal segment failed: {e}"),
            })?;
    }

    let segment_path = writer.current_segment_path();
    let segment_id = index
        .resolve_event_segment(&segment_path, header.effective_ts())
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Resolve segment failed: {e}"),
        })?;

    index
        .insert(&header, &segment_path, Some(segment_id))
        .map_err(|e| ShadowError::StorageError {
            msg: format!("Index insert failed: {e}"),
        })?;

    Ok(())
}

/// Write a batch of raw MessagePack events. More efficient than individual writes:
/// storage appends are individual but index inserts are wrapped in one SQLite transaction.
/// Returns the number of events successfully written.
pub fn write_events_batch(events: Vec<Vec<u8>>) -> Result<u32, ShadowError> {
    if events.is_empty() {
        return Ok(0);
    }
    seal::require_writable()?;

    let storage = STORAGE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Storage not initialized".into(),
    })?;

    let mut writer = storage.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;

    let mut index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    // Parse headers and write to storage, tracking per-event segment paths + segment IDs
    let mut items: Vec<(event::EventHeader, String, Option<i64>)> =
        Vec::with_capacity(events.len());

    for event_data in &events {
        let header = match event::parse_event_header(event_data) {
            Ok(h) => h,
            Err(_) => continue,
        };

        writer
            .append(event_data)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Batch write failed: {e}"),
            })?;

        // Handle rotation if it happened during this append
        if let Some(rotation) = writer.take_last_rotation() {
            index
                .seal_current_event_segment(
                    header.effective_ts(),
                    rotation.compressed_path.as_deref(),
                    rotation.compressed_path.as_ref().map(|_| "zstd"),
                )
                .map_err(|e| ShadowError::StorageError {
                    msg: format!("Seal segment failed: {e}"),
                })?;
        }

        let segment_path = writer.current_segment_path();
        let segment_id = index
            .resolve_event_segment(&segment_path, header.effective_ts())
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Resolve segment failed: {e}"),
            })?;

        items.push((header, segment_path, Some(segment_id)));
    }

    // Index all events in one SQLite transaction
    let refs: Vec<(&event::EventHeader, &str, Option<i64>)> =
        items.iter().map(|(h, p, s)| (h, p.as_str(), *s)).collect();

    let batch_count = items.len();
    index.insert_batch(&refs).map_err(|e| {
        error!(
            "Batch index insert failed: {} events lost, error={}",
            batch_count, e
        );
        ShadowError::IndexError {
            msg: format!("Batch index failed: {e}"),
        }
    })?;

    Ok(batch_count as u32)
}

/// Query events in a time range. Returns structured timeline entries.
pub fn query_time_range(
    start_us: u64,
    end_us: u64,
) -> Result<Vec<timeline::TimelineEntry>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .query_range(start_us, end_us)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Query failed: {e}"),
        })
}

/// Build a Dayflow-inspired work journal snapshot from the captured Shadow timeline.
///
/// This is intentionally a derived view over the existing event index: no model call,
/// no raw-screen export, and no extra storage schema. The desktop can use it to show
/// activity cards, standup bullets, and time breakdowns while the raw timeline remains
/// available for replay and inspection.
pub fn query_journal_snapshot(
    start_us: u64,
    end_us: u64,
) -> Result<journal::JournalSnapshot, ShadowError> {
    let entries = query_time_range(start_us, end_us)?;
    Ok(journal::build_journal_snapshot(start_us, end_us, &entries))
}

/// Get a summary of activity for a given day (YYYY-MM-DD format).
pub fn get_day_summary(date_str: String) -> Result<Vec<timeline::ActivityBlock>, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::QueryError {
        msg: "Timeline not initialized".into(),
    })?;

    let index = timeline.lock().map_err(|e| ShadowError::QueryError {
        msg: format!("Lock poisoned: {e}"),
    })?;

    index
        .day_summary(&date_str)
        .map_err(|e| ShadowError::QueryError {
            msg: format!("Summary failed: {e}"),
        })
}
