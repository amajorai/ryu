use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::DataPaths;

pub const DEFAULT_HISTORY_DAYS: u32 = 30;
pub const DEFAULT_HOT_DAYS: u32 = 7;
pub const DEFAULT_MAX_STORAGE_BYTES: u64 = 50 * 1024 * 1024 * 1024;
pub const MAX_HISTORY_DAYS: u32 = 3650;

/// Configurable retention policy. Durations in days.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RetentionPolicy {
    /// Hot tier: full video retained (days). Default: 7.
    pub hot_days: u32,
    /// Warm tier: smart keyframes only (days after hot). Default: 23.
    /// Total warm period = hot_days + warm_days (i.e., keyframes survive until day 30).
    pub warm_days: u32,
    /// Maximum total storage in bytes. 0 = unlimited. Default: 50 GB.
    pub max_storage_bytes: u64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self::from_history_days(DEFAULT_HISTORY_DAYS)
    }
}

impl RetentionPolicy {
    pub fn from_history_days(days: u32) -> Self {
        let total_days = days.clamp(1, MAX_HISTORY_DAYS);
        let hot_days = total_days.min(DEFAULT_HOT_DAYS);
        Self {
            hot_days,
            warm_days: total_days.saturating_sub(hot_days),
            max_storage_bytes: DEFAULT_MAX_STORAGE_BYTES,
        }
    }

    pub fn history_days(&self) -> u32 {
        self.hot_days.saturating_add(self.warm_days)
    }
}

/// Per-component storage usage breakdown.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StorageUsage {
    pub video_bytes: u64,
    pub audio_bytes: u64,
    pub keyframes_bytes: u64,
    pub events_bytes: u64,
    pub indices_bytes: u64,
    pub context_bytes: u64,
    pub total_bytes: u64,
    pub disk_available_bytes: u64,
    pub disk_total_bytes: u64,
}

/// Plan returned by plan_cleanup_sweep for Swift to execute.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupPlan {
    /// Video segments to extract keyframes from, then delete video file (hot -> warm transition).
    pub segments_to_keyframe: Vec<String>,
    /// Source segment paths whose keyframes should be deleted (warm -> cold transition).
    /// The video file is ALREADY gone (deleted during hot -> warm). This step only
    /// deletes keyframe JPEGs and updates the tier to 'cold'.
    pub segments_to_delete_keyframes: Vec<String>,
    /// Audio segments to delete (hot -> warm).
    pub audio_segments_to_delete: Vec<String>,
    /// Whether to run index compaction this sweep.
    pub should_compact_indices: bool,
}

/// Result of a single cleanup sweep.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CleanupResult {
    pub segments_keyframed: u32,
    pub segments_deleted: u32,
    pub audio_segments_deleted: u32,
    pub bytes_freed: u64,
    pub duration_ms: u64,
    pub errors: Vec<String>,
}

/// A keyframe record passed from Swift after extraction.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyframeRecord {
    pub display_id: u32,
    pub ts: u64,
    pub file_path: String,
    pub size_bytes: u64,
}

/// Recursively sum file sizes in a directory. Returns 0 if directory doesn't exist.
fn dir_size(path: &Path) -> u64 {
    let entries = match std::fs::read_dir(path) {
        Ok(e) => e,
        Err(_) => return 0,
    };

    let mut total: u64 = 0;
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if ft.is_dir() {
            total += dir_size(&entry.path());
        } else if ft.is_file() {
            if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
        // Symlinks ignored
    }
    total
}

/// Get disk space stats using libc::statvfs.
/// Returns (available_bytes, total_bytes). Returns (0, 0) on failure.
fn disk_stats(path: &Path) -> (u64, u64) {
    #[cfg(unix)]
    {
        let c_path = match std::ffi::CString::new(path.to_string_lossy().as_bytes()) {
            Ok(p) => p,
            Err(_) => return (0, 0),
        };
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } == 0 {
            let available = stat.f_bavail as u64 * stat.f_frsize as u64;
            let total = stat.f_blocks as u64 * stat.f_frsize as u64;
            (available, total)
        } else {
            (0, 0)
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;

        // kernel32 is implicitly linked by std, so a bare FFI declaration avoids
        // pulling in the `windows`/`winapi` crates (and their license-scan surface).
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }

        // The API wants a wide, NUL-terminated directory name that exists.
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut available: u64 = 0;
        let mut total: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut available,
                &mut total,
                std::ptr::null_mut(),
            )
        };
        if ok != 0 {
            (available, total)
        } else {
            (0, 0)
        }
    }
}

/// Scan all data directories and compute storage usage breakdown.
pub fn get_storage_usage(paths: &DataPaths) -> Result<StorageUsage, std::io::Error> {
    let video = dir_size(&paths.media_video);
    let audio = dir_size(&paths.media_audio);
    let keyframes = dir_size(&paths.media_keyframes);
    let events = dir_size(&paths.events);
    let indices = dir_size(&paths.indices);
    let context = dir_size(&paths.context);
    let total = video + audio + keyframes + events + indices + context;
    let (available, disk_total) = disk_stats(&paths.root);

    Ok(StorageUsage {
        video_bytes: video,
        audio_bytes: audio,
        keyframes_bytes: keyframes,
        events_bytes: events,
        indices_bytes: indices,
        context_bytes: context,
        total_bytes: total,
        disk_available_bytes: available,
        disk_total_bytes: disk_total,
    })
}

pub fn load_policy(conn: &rusqlite::Connection) -> Result<RetentionPolicy, String> {
    let default = RetentionPolicy::default();
    let hot_days = read_u32_config(conn, "hot_days")?.unwrap_or(default.hot_days);
    let warm_days = read_u32_config(conn, "warm_days")?.unwrap_or(default.warm_days);
    let max_storage_bytes =
        read_u64_config(conn, "max_storage_bytes")?.unwrap_or(default.max_storage_bytes);

    Ok(RetentionPolicy {
        hot_days,
        warm_days,
        max_storage_bytes,
    })
}

pub fn save_policy(conn: &rusqlite::Connection, policy: &RetentionPolicy) -> Result<(), String> {
    write_config(conn, "hot_days", &policy.hot_days.to_string())?;
    write_config(conn, "warm_days", &policy.warm_days.to_string())?;
    write_config(
        conn,
        "max_storage_bytes",
        &policy.max_storage_bytes.to_string(),
    )?;
    Ok(())
}

fn read_u32_config(conn: &rusqlite::Connection, key: &str) -> Result<Option<u32>, String> {
    let raw = read_config(conn, key)?;
    raw.map(|value| {
        value
            .parse::<u32>()
            .map_err(|e| format!("Invalid retention_config value for {key}: {e}"))
    })
    .transpose()
}

fn read_u64_config(conn: &rusqlite::Connection, key: &str) -> Result<Option<u64>, String> {
    let raw = read_config(conn, key)?;
    raw.map(|value| {
        value
            .parse::<u64>()
            .map_err(|e| format!("Invalid retention_config value for {key}: {e}"))
    })
    .transpose()
}

fn read_config(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM retention_config WHERE key = ?1")
        .map_err(|e| format!("Prepare failed: {e}"))?;
    match stmt.query_row(rusqlite::params![key], |row| row.get(0)) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("Query failed: {e}")),
    }
}

fn write_config(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO retention_config (key, value)
         VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )
    .map_err(|e| format!("Write failed: {e}"))?;
    Ok(())
}

/// Plan a cleanup sweep based on the current policy and segment state.
/// Returns lists of file paths grouped by the action Swift should take.
pub fn plan_cleanup_sweep(
    conn: &rusqlite::Connection,
    policy: &RetentionPolicy,
) -> Result<CleanupPlan, String> {
    let now_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as u64;

    let hot_cutoff_us = now_us - (policy.hot_days as u64 * 86_400 * 1_000_000);
    let warm_cutoff_us =
        now_us - ((policy.hot_days + policy.warm_days) as u64 * 86_400 * 1_000_000);

    // Hot -> Warm: video segments in hot tier older than hot_cutoff
    let segments_to_keyframe: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT file_path FROM video_segments
                 WHERE retention_tier = 'hot' AND end_ts > 0 AND end_ts < ?1
                   AND deleted_at IS NULL
                 ORDER BY end_ts ASC",
            )
            .map_err(|e| format!("Prepare failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![hot_cutoff_us as i64], |row| row.get(0))
            .map_err(|e| format!("Query failed: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Warm -> Cold: segments already at warm tier, older than warm_cutoff
    let segments_to_delete_keyframes: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT file_path FROM video_segments
                 WHERE retention_tier = 'warm' AND end_ts > 0 AND end_ts < ?1
                   AND deleted_at IS NOT NULL
                 ORDER BY end_ts ASC",
            )
            .map_err(|e| format!("Prepare failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![warm_cutoff_us as i64], |row| row.get(0))
            .map_err(|e| format!("Query failed: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Audio segments to delete (hot tier, older than hot_cutoff).
    // Safety: only delete segments whose transcripts have been fully indexed.
    // The transcript checkpoint stores the last-processed segment_id (not timestamp)
    // in index_checkpoints.last_ts (despite the column name).
    let audio_segments_to_delete: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT file_path FROM audio_segments
                 WHERE (retention_tier = 'hot' OR retention_tier IS NULL)
                   AND end_ts > 0 AND end_ts < ?1
                   AND deleted_at IS NULL
                   AND segment_id <= (
                       SELECT COALESCE(
                           (SELECT last_ts FROM index_checkpoints WHERE index_name = 'transcript'),
                           0
                       )
                   )
                 ORDER BY end_ts ASC",
            )
            .map_err(|e| format!("Prepare failed: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![hot_cutoff_us as i64], |row| row.get(0))
            .map_err(|e| format!("Query failed: {e}"))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    let should_compact = should_compact_indices(conn);

    Ok(CleanupPlan {
        segments_to_keyframe,
        segments_to_delete_keyframes,
        audio_segments_to_delete,
        should_compact_indices: should_compact,
    })
}

/// Check whether weekly index compaction should run.
fn should_compact_indices(conn: &rusqlite::Connection) -> bool {
    let last_compact: i64 = conn
        .query_row(
            "SELECT COALESCE(
                (SELECT CAST(value AS INTEGER) FROM retention_config WHERE key = 'last_compact_ts'),
                0
            )",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64;

    let week_us: i64 = 7 * 86_400 * 1_000_000;
    now - last_compact > week_us
}

/// Delete a video file from disk and mark it as deleted in the database.
/// Returns the number of bytes freed.
pub fn delete_video_segment(
    conn: &rusqlite::Connection,
    file_path: &str,
) -> Result<u64, std::io::Error> {
    let path = std::path::Path::new(file_path);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    std::fs::remove_file(path)?;

    let now_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64;

    let _ = conn.execute(
        "UPDATE video_segments SET deleted_at = ?1 WHERE file_path = ?2",
        rusqlite::params![now_us, file_path],
    );

    Ok(size)
}

/// Delete an audio file from disk and mark it as deleted in the database.
/// Returns the number of bytes freed.
pub fn delete_audio_segment(
    conn: &rusqlite::Connection,
    file_path: &str,
) -> Result<u64, std::io::Error> {
    let path = std::path::Path::new(file_path);
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    std::fs::remove_file(path)?;

    let now_us = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_micros() as i64;

    let _ = conn.execute(
        "UPDATE audio_segments SET retention_tier = 'warm', deleted_at = ?1 WHERE file_path = ?2",
        rusqlite::params![now_us, file_path],
    );

    Ok(size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_dir_size_empty() {
        let tmp = TempDir::new().unwrap();
        assert_eq!(dir_size(tmp.path()), 0);
    }

    #[test]
    fn test_dir_size_with_files() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("a.txt"), "hello").unwrap();
        fs::create_dir_all(tmp.path().join("sub")).unwrap();
        fs::write(tmp.path().join("sub/b.txt"), "world!").unwrap();
        let size = dir_size(tmp.path());
        assert_eq!(size, 11); // "hello" (5) + "world!" (6)
    }

    #[test]
    fn test_dir_size_nonexistent() {
        let path = Path::new("/tmp/definitely_does_not_exist_shadow_test");
        assert_eq!(dir_size(path), 0);
    }

    #[test]
    fn test_disk_stats() {
        let tmp = TempDir::new().unwrap();
        let (available, total) = disk_stats(tmp.path());
        assert!(total > 0, "Total disk should be > 0");
        assert!(available > 0, "Available disk should be > 0");
        assert!(available <= total, "Available should be <= total");
    }

    #[test]
    fn test_get_storage_usage() {
        let tmp = TempDir::new().unwrap();
        let paths = crate::config::DataPaths::new(tmp.path().to_str().unwrap());
        paths.ensure_dirs().unwrap();

        // Create some test files
        fs::write(paths.media_video.join("test.mp4"), vec![0u8; 1000]).unwrap();
        fs::write(paths.media_audio.join("test.m4a"), vec![0u8; 500]).unwrap();
        fs::write(paths.events.join("test.msgpack"), vec![0u8; 200]).unwrap();

        let usage = get_storage_usage(&paths).unwrap();
        assert_eq!(usage.video_bytes, 1000);
        assert_eq!(usage.audio_bytes, 500);
        assert_eq!(usage.events_bytes, 200);
        assert_eq!(usage.keyframes_bytes, 0);
        assert_eq!(usage.total_bytes, 1700);
        assert!(usage.disk_total_bytes > 0);
    }

    #[test]
    fn test_retention_policy_default() {
        let policy = RetentionPolicy::default();
        assert_eq!(policy.hot_days, 7);
        assert_eq!(policy.warm_days, 23);
        assert_eq!(policy.history_days(), 30);
        assert_eq!(policy.max_storage_bytes, 50 * 1024 * 1024 * 1024);
    }

    #[test]
    fn test_retention_policy_from_history_days() {
        let short_policy = RetentionPolicy::from_history_days(3);
        assert_eq!(short_policy.hot_days, 3);
        assert_eq!(short_policy.warm_days, 0);
        assert_eq!(short_policy.history_days(), 3);

        let long_policy = RetentionPolicy::from_history_days(45);
        assert_eq!(long_policy.hot_days, 7);
        assert_eq!(long_policy.warm_days, 38);
        assert_eq!(long_policy.history_days(), 45);
    }

    #[test]
    fn test_retention_policy_persists_to_config_table() {
        use crate::timeline::TimelineIndex;

        let tmp = TempDir::new().unwrap();
        let paths = crate::config::DataPaths::new(tmp.path().to_str().unwrap());
        paths.ensure_dirs().unwrap();
        let index = TimelineIndex::new(&paths).unwrap();

        let policy = RetentionPolicy::from_history_days(45);
        save_policy(&index.conn, &policy).unwrap();

        let loaded = load_policy(&index.conn).unwrap();
        assert_eq!(loaded.hot_days, 7);
        assert_eq!(loaded.warm_days, 38);
        assert_eq!(loaded.history_days(), 45);
        assert_eq!(loaded.max_storage_bytes, DEFAULT_MAX_STORAGE_BYTES);
    }

    #[test]
    fn test_plan_cleanup_sweep() {
        use crate::timeline::TimelineIndex;

        let tmp = TempDir::new().unwrap();
        let paths = crate::config::DataPaths::new(tmp.path().to_str().unwrap());
        paths.ensure_dirs().unwrap();
        let mut index = TimelineIndex::new(&paths).unwrap();

        // Create old segments (timestamps from 30+ days ago)
        let thirty_days_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
            - (30 * 86_400 * 1_000_000);

        index
            .insert_video_segment(1, thirty_days_ago, "/tmp/old.mp4")
            .unwrap();
        index
            .finalize_video_segment("/tmp/old.mp4", thirty_days_ago + 3_600_000_000)
            .unwrap();

        // Create recent segment (should NOT be included)
        let recent = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
            - 3_600_000_000; // 1 hour ago
        index
            .insert_video_segment(1, recent, "/tmp/recent.mp4")
            .unwrap();
        index
            .finalize_video_segment("/tmp/recent.mp4", recent + 1_000_000)
            .unwrap();

        // Plan with policy: hot_days=7
        let policy = RetentionPolicy {
            hot_days: 7,
            warm_days: 23,
            max_storage_bytes: 0,
        };
        let plan = plan_cleanup_sweep(&index.conn, &policy).unwrap();
        assert_eq!(plan.segments_to_keyframe.len(), 1);
        assert_eq!(plan.segments_to_keyframe[0], "/tmp/old.mp4");
        assert!(plan.segments_to_delete_keyframes.is_empty());
    }

    #[test]
    fn test_warm_to_cold_requires_deleted_at() {
        use crate::timeline::TimelineIndex;

        let tmp = TempDir::new().unwrap();
        let paths = crate::config::DataPaths::new(tmp.path().to_str().unwrap());
        paths.ensure_dirs().unwrap();
        let mut index = TimelineIndex::new(&paths).unwrap();

        // Create a segment from 60 days ago
        let sixty_days_ago = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64
            - (60 * 86_400 * 1_000_000);

        index
            .insert_video_segment(1, sixty_days_ago, "/tmp/warm_test.mp4")
            .unwrap();
        index
            .finalize_video_segment("/tmp/warm_test.mp4", sixty_days_ago + 3_600_000_000)
            .unwrap();

        // Set tier to 'warm' but do NOT set deleted_at (simulating bug scenario)
        index
            .update_video_segment_tier("/tmp/warm_test.mp4", "warm")
            .unwrap();

        // Plan with default policy — warm_cutoff would include this segment (60 days old > 30 days)
        let policy = RetentionPolicy {
            hot_days: 7,
            warm_days: 23,
            max_storage_bytes: 0,
        };
        let plan = plan_cleanup_sweep(&index.conn, &policy).unwrap();

        // Should NOT be in segments_to_delete_keyframes because deleted_at IS NULL
        assert!(
            plan.segments_to_delete_keyframes.is_empty(),
            "Warm segment without deleted_at should NOT be candidate for cold transition"
        );

        // Now simulate video deletion by setting deleted_at
        index
            .conn
            .execute(
                "UPDATE video_segments SET deleted_at = ?1 WHERE file_path = ?2",
                rusqlite::params![sixty_days_ago as i64, "/tmp/warm_test.mp4"],
            )
            .unwrap();

        // Re-plan — now it should be included
        let plan2 = plan_cleanup_sweep(&index.conn, &policy).unwrap();
        assert_eq!(
            plan2.segments_to_delete_keyframes.len(),
            1,
            "Warm segment with deleted_at should be candidate for cold transition"
        );
    }
}
