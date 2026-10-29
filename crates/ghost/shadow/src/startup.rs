//! Storage startup and the background migrations it launches.

use super::*;
use crate::capture::{load_capture_policy, CAPTURE_POLICY};

/// Initialize the storage engine. Call once at app startup.
pub fn init_storage(data_dir: String) -> Result<(), ShadowError> {
    // Initialize the Rust log backend. Logs to stderr, which macOS routes to
    // unified logging for GUI apps. Filter via RUST_LOG env var (default: info).
    // Inspect with: /usr/bin/log show --predicate 'process == "Shadow"' --last 10m
    // Or in Console.app filtering by process "Shadow".
    // safe to call multiple times — subsequent calls are no-ops.
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    // Until a validated accepted policy is loaded, capture is fail-closed.
    // Cold legacy controls before init_storage remain a separate runtime path.
    set_capture_runtime(Some(true), Some(false), Some(Vec::new()))?;

    let paths = config::DataPaths::new(&data_dir);
    paths.ensure_dirs().map_err(|e| ShadowError::StorageError {
        msg: format!("Failed to create data directories: {e}"),
    })?;

    DATA_PATHS
        .set(paths.clone())
        .map_err(|_| ShadowError::StorageError {
            msg: "DataPaths already initialized".into(),
        })?;

    // Shadow's sealing key: delivered by Core, or derived from RYU_MASTER_KEY.
    // Without one Shadow still starts (health reports `sealing: no-key`) and
    // refuses every capture write, unless an older Core (one that delivers no
    // key) started it on a store that was never sealed: then it keeps the
    // pre-sealing plaintext behaviour (compat mode, `sealing: "waiting for a
    // Ryu update"`) and the first start with a key seals what it wrote.
    if seal::kcv().is_none() {
        seal::resolve_process_key();
    }

    let mut index = TimelineIndex::new(&paths).map_err(|e| ShadowError::StorageError {
        msg: format!("Failed to init timeline index: {e}"),
    })?;
    if seal::kcv().is_some() {
        seal::check_store_keys(&index.conn)?;
    } else if seal::started_by_core() && seal::store_never_sealed(&index.conn, &paths.search_index)
    {
        seal::enter_compat();
    }
    let writable = seal::require_writable().is_ok();
    // Sealed writes and the migrations of legacy plaintext need the key; in
    // compat mode the event log, timeline, and media stay in plaintext and the
    // search index stays closed (events are indexed from their checkpoint once
    // a key arrives).
    let sealing = seal::is_sealing();
    if seal::is_compat() {
        seal::set_progress("search", "paused until Ryu is updated");
    }
    if sealing {
        // A store left `vacuum_pending` by an earlier migration is compacted now,
        // before it serves requests.
        if let Err(error) = ryu_crypto::content_sqlite::run_pending_vacuum(
            &index.conn,
            &paths.timeline_db,
            seal::TIMELINE_STORE,
        ) {
            log::warn!("shadow: timeline.db compaction deferred: {error}");
        }
    }

    let writer = if writable {
        let current = paths.event_segment_path(
            &chrono::Local::now().format("%Y-%m-%d").to_string(),
            chrono::Timelike::hour(&chrono::Local::now()),
        );
        // Only the open segments of past hours are closed before the writer
        // starts; sealing closed legacy segments (the whole retained history)
        // runs in the background (`spawn_segment_sweep`).
        let swept = storage::sweep_open_segments(&paths, Some(&current));
        if swept != storage::SweepReport::default() {
            info!(
                "Closed event segments at startup: {} orphaned, {} failed",
                swept.closed_orphans, swept.failed
            );
        }
        Some(
            LogWriter::new(&paths).map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to init log writer: {e}"),
            })?,
        )
    } else {
        None
    };

    // Main does not start any capture source until this function returns.
    // Present invalid saved policy is fatal; absence alone uses defaults.
    let initial_capture_policy = load_capture_policy(&index.conn)?;
    retention::load_policy(&index.conn).map_err(capture_storage_error)?;

    // Register the initial event segment so all events from startup are tracked
    if let Some(writer) = &writer {
        let initial_path = writer.current_segment_path();
        let now_us = wall_micros();
        index
            .resolve_event_segment(&initial_path, now_us)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to register initial segment: {e}"),
            })?;
    }

    // Initialize the search index (Tantivy) before moving index into TIMELINE,
    // because we may need to reset checkpoints if the search schema was rebuilt.
    // The index holds sealed payloads and blind tokens, so it needs the key.
    let search_idx = if sealing {
        Some(search::SearchIndex::new(&paths.search_index).map_err(|e| {
            ShadowError::StorageError {
                msg: format!("Failed to init search index: {e}"),
            }
        })?)
    } else {
        None
    };

    // If the search index was rebuilt (schema version change), reset all search-related
    // checkpoints so that historical data is re-indexed into the empty index.
    if search_idx.as_ref().is_some_and(|idx| idx.was_rebuilt()) {
        info!("Search index was rebuilt — resetting search_text, ocr, and transcript checkpoints");
        index
            .set_checkpoint("search_text", 0)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to reset search_text checkpoint: {e}"),
            })?;
        index
            .set_checkpoint("ocr", 0)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to reset ocr checkpoint: {e}"),
            })?;
        index
            .set_checkpoint("transcript", 0)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to reset transcript checkpoint: {e}"),
            })?;
    }

    // Initialize the vector index (CLIP embeddings)
    let vector_idx =
        vector::VectorIndex::new(&paths.vector_index).map_err(|e| ShadowError::StorageError {
            msg: format!("Failed to init vector index: {e}"),
        })?;

    // If the vector index was rebuilt (schema version change), reset the vector checkpoint
    if vector_idx.was_rebuilt() {
        info!("Vector index was rebuilt — resetting vector checkpoint");
        index
            .set_checkpoint("vector", 0)
            .map_err(|e| ShadowError::StorageError {
                msg: format!("Failed to reset vector checkpoint: {e}"),
            })?;
    }

    if let Some(writer) = writer {
        STORAGE
            .set(Mutex::new(writer))
            .map_err(|_| ShadowError::StorageError {
                msg: "Storage already initialized".into(),
            })?;
    }

    TIMELINE
        .set(Mutex::new(index))
        .map_err(|_| ShadowError::StorageError {
            msg: "Timeline already initialized".into(),
        })?;

    let mut search_idx = search_idx;
    let search_conversion = search_idx
        .as_mut()
        .and_then(search::SearchIndex::take_legacy_conversion);
    if let Some(search_idx) = search_idx {
        SEARCH
            .set(Mutex::new(search_idx))
            .map_err(|_| ShadowError::StorageError {
                msg: "Search index already initialized".into(),
            })?;
    }

    VECTOR
        .set(Mutex::new(vector_idx))
        .map_err(|_| ShadowError::StorageError {
            msg: "Vector index already initialized".into(),
        })?;

    *CAPTURE_POLICY
        .write()
        .map_err(|_| capture_storage_error("Capture policy lock poisoned"))? =
        initial_capture_policy;

    if sealing {
        spawn_timeline_migration(paths.timeline_db.clone());
        spawn_media_sweep(paths.clone());
        spawn_segment_sweep(paths.clone());
    }
    if let Some(conversion) = search_conversion {
        spawn_search_conversion(conversion);
    }

    info!(
        "shadow-core v{} initialized, data_dir={}",
        env!("CARGO_PKG_VERSION"),
        data_dir
    );
    Ok(())
}

/// Seal the legacy plaintext text columns of `timeline.db` in the background
/// (resumable, idempotent; reads accept both forms meanwhile), then scrub freed
/// pages. Runs on its own connection; writers wait for each short batch.
fn spawn_timeline_migration(db_path: std::path::PathBuf) {
    let spawned = std::thread::Builder::new()
        .name("shadow-timeline-seal".into())
        .spawn(move || {
            seal::set_progress("timeline", "sealing");
            let result = migrate_timeline(&db_path);
            match result {
                Ok(report) => {
                    seal::set_progress("timeline", "sealed");
                    if report.sealed > 0 || report.unreadable > 0 {
                        info!(
                            "timeline.db sealing: {} values sealed, {} unreadable",
                            report.sealed, report.unreadable
                        );
                    }
                }
                Err(error) => {
                    seal::set_progress("timeline", "pending (retried at next start)");
                    log::warn!("shadow: timeline.db sealing stopped: {error}");
                }
            }
        });
    if let Err(error) = spawned {
        log::warn!("shadow: could not start timeline.db sealing: {error}");
    }
}

pub(crate) fn migrate_timeline(
    db_path: &std::path::Path,
) -> Result<ryu_crypto::content_sqlite::MigrationReport, String> {
    use ryu_crypto::content_sqlite::{enable_secure_delete, finish_store, migrate_columns};
    let mut conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    enable_secure_delete(&conn).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(30))
        .map_err(|e| e.to_string())?;
    let cipher = seal::content_for_write(seal::TIMELINE_STORE).map_err(|e| e.to_string())?;
    let report = migrate_columns(&mut conn, &cipher, &timeline::column_plans())
        .map_err(|e| e.to_string())?;
    if report.sealed > 0 {
        finish_store(&conn, db_path, seal::TIMELINE_STORE).map_err(|e| e.to_string())?;
    }
    Ok(report)
}

/// Seal legacy plaintext closed event segments in the background (resumable:
/// a segment not yet sealed is picked up at the next start).
fn spawn_segment_sweep(paths: config::DataPaths) {
    let spawned = std::thread::Builder::new()
        .name("shadow-segment-seal".into())
        .spawn(move || {
            seal::set_progress("segments", "sealing");
            let swept = storage::seal_closed_segments(&paths);
            if swept.failed > 0 {
                seal::set_progress("segments", "pending (retried at next start)");
            } else {
                seal::set_progress("segments", "sealed");
            }
            if swept != storage::SweepReport::default() {
                info!(
                    "Sealed closed event segments: {} sealed, {} failed",
                    swept.sealed_closed, swept.failed
                );
            }
        });
    if let Err(error) = spawned {
        log::warn!("shadow: could not start event segment sealing: {error}");
    }
}

/// Convert a plaintext (v4) search index into the live sealed one in the
/// background, batch by batch (each batch briefly locks the live index).
/// Resumes at the next start if stopped.
fn spawn_search_conversion(conversion: search::LegacyConversion) {
    let spawned = std::thread::Builder::new()
        .name("shadow-search-convert".into())
        .spawn(move || {
            seal::set_progress("search", "converting");
            let result = conversion.run(
                |docs| {
                    let search = SEARCH.get().ok_or_else(|| {
                        search::SearchError::IndexIO("search index not initialized".into())
                    })?;
                    let mut index = search.lock().map_err(|_| {
                        search::SearchError::IndexIO("search index lock poisoned".into())
                    })?;
                    index.add_converted(docs)
                },
                |done, total| seal::set_progress("search", &format!("converting {done}/{total}")),
            );
            match result {
                Ok(_) => seal::set_progress("search", "converted"),
                Err(error) => {
                    seal::set_progress("search", "pending (retried at next start)");
                    log::warn!("shadow: search index conversion stopped: {error}");
                }
            }
        });
    if let Err(error) = spawned {
        log::warn!("shadow: could not start the search index conversion: {error}");
    }
}

/// Seal closed or orphaned plaintext media files in the background. Takes the
/// media writer lock first: holding it means no other Shadow is live, so a
/// killed process's recent leftovers are sealed now, not after a grace period.
fn spawn_media_sweep(paths: config::DataPaths) {
    if !media::acquire_writer_lock(&paths.root.join("media")) {
        log::warn!("shadow: another Shadow holds the media writer lock; recent media files are left for it");
    }
    media::spawn_sweep(paths);
}
