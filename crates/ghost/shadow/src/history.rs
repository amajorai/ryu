//! Retention policy and the "Keep history" sweep.

use super::*;

// MARK: - Retention & Storage Management

pub fn default_history_retention_days() -> u32 {
    retention::DEFAULT_HISTORY_DAYS
}

/// Get current storage usage breakdown.
pub fn get_storage_usage() -> Result<retention::StorageUsage, ShadowError> {
    let paths = get_data_paths()?;
    retention::get_storage_usage(paths).map_err(|e| ShadowError::StorageError {
        msg: format!("Storage scan failed: {e}"),
    })
}

/// Plan a cleanup sweep based on current policy and disk state.
///
/// Only a plan: Shadow does not execute the hot -> warm video tiering yet (it
/// needs keyframe extraction). The "Keep history" window itself is enforced by
/// [`run_history_retention_sweep`].
pub fn plan_retention_sweep() -> Result<retention::CleanupPlan, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    let policy = retention::load_policy(&index.conn).unwrap_or_default();
    retention::plan_cleanup_sweep(&index.conn, &policy)
        .map_err(|e| ShadowError::StorageError { msg: e })
}

pub fn get_history_retention_days() -> Result<u32, ShadowError> {
    let timeline = TIMELINE.get().ok_or_else(|| ShadowError::StorageError {
        msg: "Timeline not initialized".into(),
    })?;
    let index = timeline.lock().map_err(|e| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    })?;
    retention::load_policy(&index.conn)
        .map(|policy| policy.history_days())
        .map_err(|e| ShadowError::StorageError { msg: e })
}

pub fn set_history_retention_days(days: u32) -> Result<u32, ShadowError> {
    update_capture_policy(None, None, None, Some(days)).map(|(_, saved_days)| saved_days)
}

/// Serializes history sweeps: the hourly loop and a sweep started by a
/// retention change must not interleave their file passes.
static HISTORY_SWEEP: Mutex<()> = Mutex::new(());

/// Prune everything captured before the saved "Keep history" window.
///
/// Computes the cutoff from the persisted policy (now minus history days) and
/// runs [`prune_history_before`]. Shadow calls this at startup, hourly, and
/// right after `/capture/control` changes the retention window.
pub fn run_history_retention_sweep() -> Result<retention::HistoryPruneReport, ShadowError> {
    let days = get_history_retention_days()?;
    prune_history_before(retention::history_cutoff_us(wall_micros(), days))
}

/// Delete all captured history older than `cutoff_us` (Unix microseconds):
/// timeline rows (events, app focus, accessibility snapshots, visual-change
/// samples, keyframes, video/audio/event segment records, capture sessions),
/// full-text search documents (window context, passive text, OCR text and
/// transcripts), vector embeddings, and the files behind them (event logs,
/// screen keyframes, video and audio segments).
///
/// Crash-safe order: database and index rows go first, files last. A crash
/// part-way leaves at worst unreferenced files, which the next sweep's
/// modification-time pass removes; missing files are not errors. Locks follow
/// the crate order (STORAGE → TIMELINE → SEARCH); VECTOR is taken on its own
/// because hybrid search acquires it before TIMELINE.
pub fn prune_history_before(cutoff_us: u64) -> Result<retention::HistoryPruneReport, ShadowError> {
    let _sweep = HISTORY_SWEEP
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut report = retention::HistoryPruneReport::new(cutoff_us);
    if cutoff_us == 0 {
        return Ok(report);
    }
    let paths = get_data_paths()?;
    let not_ready = |name: &str| ShadowError::StorageError {
        msg: format!("{name} not initialized"),
    };
    let poisoned = |e: String| ShadowError::StorageError {
        msg: format!("Lock poisoned: {e}"),
    };

    // Stage 1: timeline rows + search documents + event logs. Holding STORAGE
    // keeps the log writer from rotating the hour file the sweep might touch.
    let (files, keep) = {
        let mut writer = STORAGE
            .get()
            .ok_or_else(|| not_ready("Storage"))?
            .lock()
            .map_err(|e| poisoned(e.to_string()))?;
        let mut index = TIMELINE
            .get()
            .ok_or_else(|| not_ready("Timeline"))?
            .lock()
            .map_err(|e| poisoned(e.to_string()))?;
        let mut search = SEARCH
            .get()
            .ok_or_else(|| not_ready("Search index"))?
            .lock()
            .map_err(|e| poisoned(e.to_string()))?;
        retire_stale_event_segment(&mut writer, &mut index, &mut report);
        let current_event_segment = std::path::PathBuf::from(writer.current_segment_path());
        prune_indexed_history(
            paths,
            &current_event_segment,
            &index,
            &mut search,
            &mut report,
        )?
    };

    // Stage 2: vector embeddings (they name video files, so before stage 3).
    match VECTOR.get() {
        Some(vector) => match vector.lock() {
            Ok(mut vector) => prune_vector_history(&mut vector, &mut report),
            Err(e) => report
                .errors
                .push(format!("Vector index lock poisoned: {e}")),
        },
        None => report.errors.push("Vector index not initialized".into()),
    }

    // Stage 3: media files.
    prune_media_files(paths, &files, &keep, &mut report);
    Ok(report)
}

/// Close the log writer's current hour file when it was last written before the
/// cutoff. The writer only rotates on its next append, so after a long idle gap
/// (a laptop asleep for days with Shadow running) its "current" file is an old
/// hour of typed input that the sweep would otherwise keep as live. Rotating it
/// compresses that hour (keeping its capture time) and seals its segment row at
/// that time, so the rest of this sweep prunes both. Failures are reported and
/// leave the file in place for the next sweep.
pub(crate) fn retire_stale_event_segment(
    writer: &mut LogWriter,
    index: &mut TimelineIndex,
    report: &mut retention::HistoryPruneReport,
) {
    let current = writer.current_segment_path();
    let Some(last_write_us) = retention::modified_us(std::path::Path::new(&current)) else {
        return;
    };
    if last_write_us >= report.cutoff_us {
        return;
    }
    if let Err(e) = writer.rotate() {
        report
            .errors
            .push(format!("Rotate stale event log {current} failed: {e}"));
        return;
    }
    if let Some(rotation) = writer.take_last_rotation() {
        if let Err(e) = index.seal_current_event_segment(
            last_write_us.max(1),
            rotation.compressed_path.as_deref(),
            rotation.compressed_path.as_ref().map(|_| "zstd"),
        ) {
            report
                .errors
                .push(format!("Seal stale event segment failed: {e}"));
        }
    }
}

/// Stage 1 of the sweep, separated from the global locks for testing. Returns
/// the files the pruned rows referenced and the paths that must survive the
/// directory pass (segments still being written).
pub(crate) fn prune_indexed_history(
    paths: &config::DataPaths,
    current_event_segment: &std::path::Path,
    index: &TimelineIndex,
    search: &mut search::SearchIndex,
    report: &mut retention::HistoryPruneReport,
) -> Result<(Vec<String>, std::collections::HashSet<std::path::PathBuf>), ShadowError> {
    let cutoff_us = report.cutoff_us;
    let files = retention::prune_timeline_before(&index.conn, cutoff_us, report)
        .map_err(|msg| ShadowError::StorageError { msg })?;
    let mut keep: std::collections::HashSet<std::path::PathBuf> =
        retention::open_media_paths(&index.conn)
            .map_err(|msg| ShadowError::StorageError { msg })?
            .into_iter()
            .map(std::path::PathBuf::from)
            .collect();
    keep.insert(current_event_segment.to_path_buf());

    match search.delete_before(cutoff_us) {
        Ok(n) => report.search_docs_deleted += n,
        Err(e) => report.errors.push(format!("Search prune failed: {e}")),
    }

    retention::sweep_stale_files(&paths.events, cutoff_us, &keep, report);
    Ok((files, keep))
}

pub(crate) fn prune_vector_history(
    vector: &mut vector::VectorIndex,
    report: &mut retention::HistoryPruneReport,
) {
    match vector.delete_before(report.cutoff_us) {
        Ok(n) => report.vector_entries_deleted += n,
        Err(e) => report.errors.push(format!("Vector prune failed: {e}")),
    }
}

pub(crate) fn prune_media_files(
    paths: &config::DataPaths,
    files: &[String],
    keep: &std::collections::HashSet<std::path::PathBuf>,
    report: &mut retention::HistoryPruneReport,
) {
    let referenced: Vec<String> = files
        .iter()
        .filter(|f| !keep.contains(std::path::Path::new(f.as_str())))
        .cloned()
        .collect();
    retention::remove_data_files(&paths.root, &referenced, report);
    for dir in [
        &paths.media_video,
        &paths.media_audio,
        &paths.media_keyframes,
    ] {
        retention::sweep_stale_files(dir, report.cutoff_us, keep, report);
    }
}
