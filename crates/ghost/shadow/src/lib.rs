mod behavioral;
mod config;
mod event;
pub mod journal;
pub mod media;
mod retention;
pub mod seal;
pub mod search;
mod storage;
pub mod timeline;
pub mod vector;
mod workflow_extractor;

use rusqlite::OptionalExtension;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::RwLock;

use log::{error, info};
pub use retention::HistoryPruneReport;
use storage::LogWriter;
use timeline::TimelineIndex;

// Global state — initialized once via init_storage().
// Lock ordering: always acquire STORAGE before TIMELINE before SEARCH to prevent deadlocks.
static STORAGE: OnceLock<Mutex<LogWriter>> = OnceLock::new();
static TIMELINE: OnceLock<Mutex<TimelineIndex>> = OnceLock::new();
static SEARCH: OnceLock<Mutex<search::SearchIndex>> = OnceLock::new();
static VECTOR: OnceLock<Mutex<vector::VectorIndex>> = OnceLock::new();
static DATA_PATHS: OnceLock<config::DataPaths> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum ShadowError {
    #[error("Complete capture preferences are required before enabling capture")]
    CapturePolicyUninitialized,
    #[error("Storage error: {msg}")]
    StorageError { msg: String },
    #[error("Query error: {msg}")]
    QueryError { msg: String },
    #[error("Serialization error: {msg}")]
    SerializationError { msg: String },
    #[error("Index error: {msg}")]
    IndexError { msg: String },
}

mod capture;
mod events;
mod history;
mod hybrid;
mod indexing;
mod keyframes;
mod knowledge;
mod mimicry;
mod segments;
mod sessions;
mod startup;

pub use capture::{
    capture_allowed, capture_control_snapshot, capture_paused, capture_policy_snapshot,
    frame_capture_enabled, set_capture_runtime, update_capture_policy, CapturePolicy,
};
pub use events::{
    get_day_summary, query_journal_snapshot, query_time_range, write_event, write_events_batch,
};
pub use history::{
    default_history_retention_days, get_history_retention_days, get_storage_usage,
    plan_retention_sweep, prune_history_before, run_history_retention_sweep,
    set_history_retention_days,
};
pub use hybrid::{
    get_search_index_stats, get_vector_index_stats, insert_vector_entries, search_hybrid,
    search_hybrid_in_range, search_vector, search_vector_in_range, vector_search,
};
pub use indexing::{
    get_index_checkpoint, index_ocr_text, index_recent_events, index_transcript_text,
    list_transcript_chunks_in_range, list_transcript_chunks_overlapping, search_text,
    set_index_checkpoint,
};
pub use keyframes::{
    delete_keyframe_rows, find_nearest_keyframe, insert_keyframe, keyframes_between,
    list_keyframe_paths, prune_keyframes_before, register_keyframes, update_video_segment_tier,
};
pub use knowledge::{
    deactivate_directive, delete_directive, delete_procedure, delete_semantic_knowledge,
    find_ax_snapshot, insert_ax_snapshot, insert_procedure, query_active_directives,
    query_ax_snapshots, query_procedures, query_semantic_knowledge, record_directive_trigger,
    touch_semantic_knowledge, upsert_directive, upsert_semantic_knowledge,
};
pub use mimicry::{
    count_enriched_clicks, extract_workflows, extract_workflows_for_app, search_behavioral_context,
    top_app_interactions,
};
pub use segments::{
    delete_audio_file, delete_video_file, finalize_audio_segment, finalize_video_segment,
    find_audio_segment, find_video_segment, find_video_segment_by_path, insert_audio_segment,
    insert_video_segment, list_audio_segments, list_audio_segments_after_checkpoint,
    list_orphan_audio_segments, list_video_segments, query_visual_changes, record_visual_change,
    seal_closed_video_segment,
};
pub use sessions::{
    check_integrity, close_focus_interval, finalize_session, find_app_at_timestamp,
    flush_and_rotate, register_session,
};
pub use startup::init_storage;
// timeline.rs tests call it as `crate::migrate_timeline`.
#[cfg(test)]
use startup::migrate_timeline;

fn capture_storage_error(msg: impl Into<String>) -> ShadowError {
    ShadowError::StorageError { msg: msg.into() }
}

fn get_data_paths() -> Result<&'static config::DataPaths, ShadowError> {
    DATA_PATHS.get().ok_or_else(|| ShadowError::StorageError {
        msg: "DataPaths not initialized".into(),
    })
}

/// Return the core library version (useful for verifying the bridge works).
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Current wall clock in Unix microseconds.
fn wall_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

#[cfg(test)]
mod history_retention_tests;
