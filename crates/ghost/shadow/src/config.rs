use std::fs;
use std::io;
use std::path::PathBuf;

/// All data directory paths derived from a single root.
#[derive(Debug, Clone)]
pub struct DataPaths {
    pub root: PathBuf,
    pub events: PathBuf,
    pub media_video: PathBuf,
    pub media_audio: PathBuf,
    pub media_keyframes: PathBuf,
    pub indices: PathBuf,
    pub timeline_db: PathBuf,
    pub search_index: PathBuf,
    pub vector_index: PathBuf,
    pub context: PathBuf,
}

impl DataPaths {
    pub fn new(root: &str) -> Self {
        let root = PathBuf::from(root);
        Self {
            events: root.join("events"),
            media_video: root.join("media").join("video"),
            media_audio: root.join("media").join("audio"),
            media_keyframes: root.join("media").join("keyframes"),
            indices: root.join("indices"),
            timeline_db: root.join("indices").join("timeline.db"),
            search_index: root.join("indices").join("search"),
            vector_index: root.join("indices").join("vector"),
            context: root.join("context"),
            root,
        }
    }

    /// Create all required directories if they don't exist.
    pub fn ensure_dirs(&self) -> io::Result<()> {
        fs::create_dir_all(&self.events)?;
        fs::create_dir_all(&self.media_video)?;
        fs::create_dir_all(&self.media_audio)?;
        fs::create_dir_all(&self.media_keyframes)?;
        fs::create_dir_all(&self.indices)?;
        fs::create_dir_all(&self.context)?;
        Ok(())
    }

    /// Path for an event log segment: events/YYYY-MM-DD/HH.msgpack
    pub fn event_segment_path(&self, date: &str, hour: u32) -> PathBuf {
        self.events.join(date).join(format!("{:02}.msgpack", hour))
    }

    /// Path for a compressed event log segment: events/YYYY-MM-DD/HH.msgpack.zst
    pub fn event_segment_compressed_path(&self, date: &str, hour: u32) -> PathBuf {
        self.events
            .join(date)
            .join(format!("{:02}.msgpack.zst", hour))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    // Unique temp root per test — cargo runs tests in parallel threads within one
    // process, so a shared path (or one keyed only on pid) would collide. No `uuid`
    // dep here, so use pid + a monotonic counter.
    static SEQ: AtomicU64 = AtomicU64::new(0);
    fn temp_root() -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("ghost-shadow-cfg-{}-{}", std::process::id(), n))
    }

    #[test]
    fn new_derives_all_paths_under_root() {
        let paths = DataPaths::new("/data/shadow");
        let root = PathBuf::from("/data/shadow");
        assert_eq!(paths.root, root);
        assert_eq!(paths.events, root.join("events"));
        assert_eq!(paths.media_video, root.join("media").join("video"));
        assert_eq!(paths.media_audio, root.join("media").join("audio"));
        assert_eq!(paths.media_keyframes, root.join("media").join("keyframes"));
        assert_eq!(paths.indices, root.join("indices"));
        assert_eq!(paths.timeline_db, root.join("indices").join("timeline.db"));
        assert_eq!(paths.search_index, root.join("indices").join("search"));
        assert_eq!(paths.vector_index, root.join("indices").join("vector"));
        assert_eq!(paths.context, root.join("context"));
    }

    #[test]
    fn media_dirs_are_nested_under_a_single_media_parent() {
        let paths = DataPaths::new("/root");
        // All three media dirs must share the same "media" parent.
        assert_eq!(paths.media_video.parent(), paths.media_audio.parent());
        assert_eq!(paths.media_audio.parent(), paths.media_keyframes.parent());
        assert_eq!(
            paths.media_video.parent().unwrap(),
            PathBuf::from("/root").join("media")
        );
    }

    #[test]
    fn db_and_index_paths_live_under_indices() {
        let paths = DataPaths::new("/root");
        for p in [&paths.timeline_db, &paths.search_index, &paths.vector_index] {
            assert_eq!(p.parent().unwrap(), paths.indices);
        }
    }

    #[test]
    fn event_segment_path_zero_pads_hour() {
        let paths = DataPaths::new("/root");
        let p = paths.event_segment_path("2026-07-22", 9);
        assert!(p.ends_with("09.msgpack"), "got {:?}", p);
        assert_eq!(
            p,
            PathBuf::from("/root")
                .join("events")
                .join("2026-07-22")
                .join("09.msgpack")
        );
    }

    #[test]
    fn event_segment_path_handles_two_digit_and_zero_hour() {
        let paths = DataPaths::new("/root");
        assert!(paths
            .event_segment_path("2026-07-22", 0)
            .ends_with("00.msgpack"));
        assert!(paths
            .event_segment_path("2026-07-22", 23)
            .ends_with("23.msgpack"));
    }

    #[test]
    fn compressed_segment_path_matches_uncompressed_plus_zst() {
        let paths = DataPaths::new("/root");
        let plain = paths.event_segment_path("2026-01-01", 5);
        let zst = paths.event_segment_compressed_path("2026-01-01", 5);
        assert_eq!(zst.file_name().unwrap(), "05.msgpack.zst");
        // Same directory, filename is the plain name with a `.zst` suffix.
        assert_eq!(plain.parent(), zst.parent());
        assert_eq!(
            format!("{}.zst", plain.file_name().unwrap().to_str().unwrap()),
            zst.file_name().unwrap().to_str().unwrap()
        );
    }

    #[test]
    fn ensure_dirs_creates_all_declared_directories() {
        let root = temp_root();
        let paths = DataPaths::new(root.to_str().unwrap());
        paths.ensure_dirs().expect("ensure_dirs");

        for d in [
            &paths.events,
            &paths.media_video,
            &paths.media_audio,
            &paths.media_keyframes,
            &paths.indices,
            &paths.context,
        ] {
            assert!(d.is_dir(), "expected dir to exist: {:?}", d);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_dirs_is_idempotent() {
        let root = temp_root();
        let paths = DataPaths::new(root.to_str().unwrap());
        paths.ensure_dirs().expect("first");
        // Second call must not error even though everything already exists.
        paths.ensure_dirs().expect("second");
        let _ = std::fs::remove_dir_all(&root);
    }
}
