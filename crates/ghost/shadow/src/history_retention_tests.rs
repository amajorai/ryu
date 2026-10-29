use super::*;
use crate::history::{
    prune_indexed_history, prune_media_files, prune_vector_history, retire_stale_event_segment,
};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

const DAY_US: u64 = 86_400 * 1_000_000;

struct Stores {
    _tmp: tempfile::TempDir,
    paths: config::DataPaths,
    index: TimelineIndex,
    search: search::SearchIndex,
    vector: vector::VectorIndex,
}

fn stores() -> Stores {
    let tmp = tempfile::TempDir::new().unwrap();
    let paths = config::DataPaths::new(tmp.path().to_str().unwrap());
    paths.ensure_dirs().unwrap();
    Stores {
        index: TimelineIndex::new(&paths).unwrap(),
        search: search::SearchIndex::new(&paths.search_index).unwrap(),
        vector: vector::VectorIndex::new(&paths.vector_index).unwrap(),
        paths,
        _tmp: tmp,
    }
}

/// Write a file whose modification time is `ts_us` (Unix microseconds).
fn file_at(path: &Path, ts_us: u64) -> String {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, b"captured").unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_micros(ts_us))
        .unwrap();
    path.to_string_lossy().into_owned()
}

/// Set a directory's modification time to `ts_us` (Unix microseconds).
fn dir_modified_at(dir: &Path, ts_us: u64) {
    let mut options = std::fs::File::options();
    options.read(true);
    // Windows only opens a directory handle with FILE_FLAG_BACKUP_SEMANTICS,
    // and changing its times needs FILE_WRITE_ATTRIBUTES access.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_WRITE_ATTRIBUTES: u32 = 0x0100;
        const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
        options
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS);
    }
    options
        .open(dir)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_micros(ts_us))
        .unwrap();
}

fn insert_event(index: &TimelineIndex, ts: u64, title: &str) {
    index
        .conn
        .execute(
            "INSERT INTO events_index (ts, track, event_type, app_name, window_title, segment_file)
                 VALUES (?1, 3, 'app_switch', 'Notes', ?2, 'seg')",
            rusqlite::params![ts as i64, title],
        )
        .unwrap();
}

fn count(conn: &rusqlite::Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}

fn transcript(ts: u64, text: &str) -> search::TranscriptEntry {
    search::TranscriptEntry {
        audio_segment_id: 1,
        source: "mic".into(),
        ts_start: ts,
        ts_end: ts + 1_000_000,
        text: text.into(),
        confidence: None,
        app_name: None,
        window_title: None,
    }
}

fn ocr(ts: u64, text: &str) -> search::OcrEntry {
    search::OcrEntry {
        ts,
        display_id: Some(1),
        text: text.into(),
        app_name: Some("Notes".into()),
        window_title: None,
        confidence: None,
    }
}

fn embedding(ts: u64, file_path: &str) -> vector::VectorEntry {
    vector::VectorEntry {
        ts,
        display_id: 1,
        file_path: file_path.into(),
        frame_offset_us: 0,
        vector: vec![0.5; 512],
    }
}

fn sweep(s: &mut Stores, cutoff: u64, current_event: &Path) -> HistoryPruneReport {
    let mut report = HistoryPruneReport::new(cutoff);
    let (files, keep) = prune_indexed_history(
        &s.paths,
        current_event,
        &s.index,
        &mut s.search,
        &mut report,
    )
    .unwrap();
    prune_vector_history(&mut s.vector, &mut report);
    prune_media_files(&s.paths, &files, &keep, &mut report);
    report
}

#[test]
fn history_sweep_removes_rows_index_entries_and_files_older_than_the_window() {
    let mut s = stores();
    let now = wall_micros();
    let cutoff = retention::history_cutoff_us(now, 3);
    let old = now - 30 * DAY_US;
    let recent = now - DAY_US;

    // Timeline rows on both sides of the cutoff.
    insert_event(&s.index, old, "old secret");
    insert_event(&s.index, recent, "recent note");
    s.index
        .insert_ax_snapshot(old, "app", "Notes", None, Some(1), 1, 1, None)
        .unwrap();
    s.index.record_visual_change(1, old, 0.5).unwrap();
    s.index.record_visual_change(1, recent, 0.5).unwrap();

    // Screen keyframes: one old, one recent.
    let old_jpg = file_at(&s.paths.media_keyframes.join("display-1/old.jpg"), old);
    let new_jpg = file_at(&s.paths.media_keyframes.join("display-1/new.jpg"), recent);
    s.index
        .insert_keyframe(1, old, &old_jpg, "direct", None)
        .unwrap();
    s.index
        .insert_keyframe(1, recent, &new_jpg, "direct", None)
        .unwrap();

    // A finished old video segment, one still recording, and one a past
    // session left open (`end_ts = 0`) that was last written long ago.
    let old_mp4 = file_at(&s.paths.media_video.join("display-1/old.mp4"), old);
    s.index.insert_video_segment(1, old, &old_mp4).unwrap();
    s.index
        .finalize_video_segment(&old_mp4, old + 3_600_000_000)
        .unwrap();
    let open_mp4 = file_at(&s.paths.media_video.join("display-1/open.mp4"), recent);
    s.index.insert_video_segment(1, recent, &open_mp4).unwrap();
    let abandoned_mp4 = file_at(&s.paths.media_video.join("display-1/abandoned.mp4"), old);
    s.index
        .insert_video_segment(1, old - 3_600_000_000, &abandoned_mp4)
        .unwrap();

    // A registered old audio segment, and an unregistered hourly mic WAV.
    let old_wav = file_at(&s.paths.media_audio.join("old-registered.wav"), old);
    s.index
        .insert_audio_segment("mic", old, &old_wav, None, None, None)
        .unwrap();
    s.index
        .finalize_audio_segment(&old_wav, old + 60_000_000)
        .unwrap();
    let stray_wav = file_at(&s.paths.media_audio.join("2020-01-01T09.wav"), old);
    let new_wav = file_at(&s.paths.media_audio.join("recent.wav"), recent);

    // Event logs: a sealed old hour, plus the writer's current hour file that
    // has gone untouched for longer than the window (capture paused).
    let old_log = file_at(&s.paths.event_segment_compressed_path("2020-01-01", 9), old);
    // The date directory was last written when that hour was captured.
    dir_modified_at(&s.paths.events.join("2020-01-01"), old);
    let seg = s.index.register_segment("events", old, &old_log).unwrap();
    s.index
        .update_segment(seg, "sealed", Some(old + 3_600_000_000), None, None)
        .unwrap();
    let current_log = PathBuf::from(file_at(&s.paths.event_segment_path("2020-01-02", 10), old));

    // A row pointing outside Shadow's data dir is pruned but its file is not touched.
    let outside_dir = tempfile::TempDir::new().unwrap();
    let outside = file_at(&outside_dir.path().join("elsewhere.jpg"), old);
    s.index
        .insert_keyframe(2, old, &outside, "direct", None)
        .unwrap();

    // Full-text and vector entries.
    s.search
        .index_transcript_entries(&[transcript(old, "oldword"), transcript(recent, "newword")])
        .unwrap();
    s.search
        .index_ocr_entries(&[ocr(old, "oldscreen"), ocr(recent, "newscreen")])
        .unwrap();
    s.vector
        .insert_entries(&[embedding(old, &old_mp4), embedding(recent, &open_mp4)])
        .unwrap();

    let report = sweep(&mut s, cutoff, &current_log);
    assert!(report.errors.is_empty(), "{:?}", report.errors);

    // Rows.
    assert_eq!(report.events_deleted, 1);
    assert_eq!(count(&s.index.conn, "events_index"), 1);
    assert_eq!(count(&s.index.conn, "ax_snapshots"), 0);
    assert_eq!(count(&s.index.conn, "visual_change_log"), 1);
    assert_eq!(report.keyframes_deleted, 2);
    assert_eq!(count(&s.index.conn, "keyframes"), 1);
    assert_eq!(report.video_segments_deleted, 2, "finished + abandoned");
    assert_eq!(
        count(&s.index.conn, "video_segments"),
        1,
        "segment still recording kept"
    );
    let open_video_mirrors: i64 = s
        .index
        .conn
        .query_row(
            "SELECT COUNT(*) FROM segments WHERE kind = 'video'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        open_video_mirrors, 1,
        "abandoned segment mirror sealed and pruned"
    );
    assert_eq!(report.audio_segments_deleted, 1);
    assert_eq!(count(&s.index.conn, "audio_segments"), 0);

    // Search: transcripts and OCR before the cutoff are gone, recent stay.
    assert_eq!(report.search_docs_deleted, 2);
    assert!(s.search.search("oldword", 10).unwrap().is_empty());
    assert!(s.search.search("oldscreen", 10).unwrap().is_empty());
    assert_eq!(s.search.search("newword", 10).unwrap().len(), 1);
    assert_eq!(s.search.search("newscreen", 10).unwrap().len(), 1);
    assert!(s
        .search
        .list_transcript_chunks_in_range(0, cutoff, 100, 0)
        .unwrap()
        .is_empty());

    // Vectors.
    assert_eq!(report.vector_entries_deleted, 1);
    assert_eq!(s.vector.stats().unwrap().total_embeddings, 1);

    // Files.
    for gone in [
        &old_jpg,
        &old_mp4,
        &abandoned_mp4,
        &old_wav,
        &stray_wav,
        &old_log,
    ] {
        assert!(!Path::new(gone).exists(), "{gone} should be deleted");
    }
    for kept in [&new_jpg, &open_mp4, &new_wav, &outside] {
        assert!(Path::new(kept).exists(), "{kept} should be kept");
    }
    assert!(current_log.exists(), "the writer's open hour file is kept");
    assert!(
        !s.paths.events.join("2020-01-01").exists(),
        "an emptied stale date directory is removed"
    );
    assert!(
        s.paths.media_audio.exists() && s.paths.media_keyframes.join("display-1").exists(),
        "directories written inside the window are kept"
    );

    // Indexers resume at the window, never inside pruned time.
    assert_eq!(s.index.get_checkpoint("search_text").unwrap(), cutoff - 1);

    // A second sweep is a no-op.
    let again = sweep(&mut s, cutoff, &current_log);
    assert_eq!(again.total_removed(), 0, "{again:?}");
}

#[test]
fn history_sweep_tolerates_missing_files_and_keeps_later_checkpoints() {
    let mut s = stores();
    let now = wall_micros();
    let cutoff = retention::history_cutoff_us(now, 7);
    let old = now - 10 * DAY_US;

    // The JPEG was already removed (e.g. an interrupted earlier sweep).
    let missing = s
        .paths
        .media_keyframes
        .join("display-1/gone.jpg")
        .to_string_lossy()
        .into_owned();
    s.index
        .insert_keyframe(1, old, &missing, "direct", None)
        .unwrap();
    s.index.set_checkpoint("search_text", now).unwrap();

    let current = s.paths.event_segment_path("2020-01-01", 0);
    let report = sweep(&mut s, cutoff, &current);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.keyframes_deleted, 1);
    assert_eq!(report.files_deleted, 0);
    assert_eq!(s.index.get_checkpoint("search_text").unwrap(), now);
}

#[test]
fn history_cutoff_saturates() {
    assert_eq!(retention::history_cutoff_us(5, 1), 0);
    assert_eq!(retention::history_cutoff_us(3 * DAY_US, 1), 2 * DAY_US);
}

#[test]
fn history_sweep_retires_an_event_log_hour_left_open_across_an_idle_gap() {
    let mut s = stores();
    let now = wall_micros();
    let cutoff = retention::history_cutoff_us(now, 3);
    let old = now - 10 * DAY_US;

    // The writer's current hour got its last event 10 days ago; with no
    // event since, it has not rotated (a laptop asleep with Shadow running).
    let mut writer = LogWriter::new(&s.paths).unwrap();
    writer.append(b"typed secret").unwrap();
    let stale = writer.current_segment_path();
    s.index.resolve_event_segment(&stale, old).unwrap();
    file_at_existing(Path::new(&stale), old);

    let mut report = HistoryPruneReport::new(cutoff);
    retire_stale_event_segment(&mut writer, &mut s.index, &mut report);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    let compressed = s
        .index
        .conn
        .query_row(
            "SELECT path, end_ts FROM segments WHERE kind = 'events' AND status = 'sealed'",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
        )
        .unwrap();
    assert!(compressed.0.ends_with(".zst"), "{}", compressed.0);
    assert!((compressed.1 as u64) < cutoff, "sealed at the capture time");

    let current = PathBuf::from(writer.current_segment_path());
    let report = sweep(&mut s, cutoff, &current);
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(
        !Path::new(&compressed.0).exists(),
        "old typed input deleted"
    );
    assert!(current.exists(), "the writer's new hour file is kept");
    assert_eq!(count(&s.index.conn, "segments"), 0);
}

#[test]
fn history_sweep_keeps_an_event_log_hour_written_inside_the_window() {
    let mut s = stores();
    let cutoff = retention::history_cutoff_us(wall_micros(), 3);
    let mut writer = LogWriter::new(&s.paths).unwrap();
    writer.append(b"recent").unwrap();
    let current = writer.current_segment_path();

    let mut report = HistoryPruneReport::new(cutoff);
    retire_stale_event_segment(&mut writer, &mut s.index, &mut report);
    assert!(writer.take_last_rotation().is_none(), "no rotation");
    assert_eq!(writer.current_segment_path(), current);
    assert!(Path::new(&current).exists());
}

/// Backdate an existing file's modification time to `ts_us`.
fn file_at_existing(path: &Path, ts_us: u64) {
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(UNIX_EPOCH + Duration::from_micros(ts_us))
        .unwrap();
}

#[test]
fn media_pass_keeps_segments_still_recording() {
    let s = stores();
    let open = file_at(&s.paths.media_video.join("display-1/rec.mp4"), 1);
    let keep: HashSet<PathBuf> = [PathBuf::from(&open)].into_iter().collect();
    let mut report = HistoryPruneReport::new(wall_micros());
    prune_media_files(&s.paths, &[open.clone()], &keep, &mut report);
    assert!(Path::new(&open).exists());
    assert_eq!(report.files_deleted, 0);
}
