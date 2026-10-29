//! The hourly capture event log.
//!
//! The open segment `events/<date>/<HH>.msgpack` is an `RYU-SL01` sealed log:
//! one record per MessagePack event, under the [`seal::EVENTS_STORE`] content
//! key's per-segment subkey (`subcipher("<date>/<HH>")`), bound to the logical
//! id `"<date>/<HH>"` (never a path, so moving the data folder keeps it
//! readable). At rotation the log is read, re-framed in the classic
//! `[u32 LE len][msgpack]` layout, zstd-compressed FIRST, and written as an
//! `RYU-SF01` file `<HH>.msgpack.zst` (same id) through a temp file and a
//! rename; only then is the log deleted. A restart within the same hour reopens
//! the log with the appender.
//!
//! Segments written by earlier builds (plaintext `.msgpack` and plaintext zstd
//! `.msgpack.zst`) still read ([`read_segment_events`] checks the magic), and
//! [`sweep_segments`] seals them at startup.
//!
//! In compat mode ([`seal::SealingState::Compat`]) the writer keeps that
//! pre-sealing plaintext format (frames appended to `<HH>.msgpack`, plaintext
//! zstd at rotation); the first start with a key seals them like any legacy
//! segment.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{Local, Timelike};
use ryu_crypto::sealed_file::{open_file_bytes, seal_file_in_place};
use ryu_crypto::sealed_log::{is_sealed_log, open_recovering};
use ryu_crypto::{ContentCipher, ContentContext, SealedFileWriter, SealedLogWriter};

use crate::config::DataPaths;
use crate::seal;

/// Metadata about a completed segment rotation.
pub struct RotationInfo {
    /// Path to the old segment file (deleted after compression).
    pub old_raw_path: String,
    /// Path to the compressed file, if compression occurred.
    pub compressed_path: Option<String>,
}

/// The open segment: a sealed log, or (compat mode only) the pre-sealing
/// plaintext `[u32 LE len][msgpack]` frames.
enum SegmentLog {
    Sealed(SealedLogWriter),
    Plain(fs::File),
}

impl SegmentLog {
    fn append(&mut self, data: &[u8]) -> io::Result<()> {
        match self {
            Self::Sealed(writer) => writer.append(data).map(drop).map_err(io_error),
            Self::Plain(file) => {
                use std::io::Write as _;
                let mut record = Vec::with_capacity(data.len() + 4);
                record.extend_from_slice(&(data.len() as u32).to_le_bytes());
                record.extend_from_slice(data);
                file.write_all(&record)
            }
        }
    }

    fn sync(&mut self) -> io::Result<()> {
        match self {
            Self::Sealed(writer) => writer.sync().map_err(io_error),
            Self::Plain(file) => file.sync_data(),
        }
    }
}

/// Append-only log writer. Writes one sealed record per MessagePack event to
/// hourly segment files.
pub struct LogWriter {
    paths: DataPaths,
    writer: SegmentLog,
    current_date: String,
    current_hour: u32,
    events_written: u64,
    /// Set after rotate() — consumed by caller via take_last_rotation().
    last_rotation: Option<RotationInfo>,
}

fn io_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(error.to_string())
}

/// The logical id of a segment: `"<date>/<HH>"`.
pub fn segment_id(date: &str, hour: u32) -> String {
    format!("{date}/{hour:02}")
}

fn segment_cipher(id: &str) -> io::Result<ContentCipher> {
    Ok(seal::content(seal::EVENTS_STORE)
        .map_err(io_error)?
        .subcipher(id))
}

fn log_context(id: &str) -> ContentContext {
    ContentContext::new("log").with("id", id)
}

fn file_context(id: &str) -> ContentContext {
    ContentContext::new("file").with("id", id)
}

fn open_log(path: &Path, id: &str) -> io::Result<SegmentLog> {
    seal::require_writable().map_err(io_error)?;
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "event segment path has no parent directory",
        )
    })?;
    seal::create_private_dir(parent)?;
    if !seal::is_sealing() {
        return open_plain_log(path).map(SegmentLog::Plain);
    }
    if path.exists() && !is_sealed_log(path)? {
        // A plaintext segment from an earlier build for this same hour.
        convert_legacy_open_segment(path, id)?;
    }
    SealedLogWriter::open_append(path, &segment_cipher(id)?, &log_context(id))
        .map(SegmentLog::Sealed)
        .map_err(io_error)
}

/// Open (or create, owner-only) a plaintext open segment for appending, in
/// compat mode. A torn final frame is cut off first, so new frames stay
/// readable after it.
fn open_plain_log(path: &Path) -> io::Result<fs::File> {
    if path.exists() {
        if is_sealed_log(path)? {
            return Err(io::Error::other(
                "this event segment is sealed; it cannot be appended without the key",
            ));
        }
        let bytes = fs::read(path)?;
        let complete = complete_frames_len(&bytes);
        if complete < bytes.len() {
            fs::OpenOptions::new()
                .write(true)
                .open(path)?
                .set_len(complete as u64)?;
        }
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

/// The length of the complete `[u32 LE len][msgpack]` frames at the start of
/// `bytes`.
fn complete_frames_len(bytes: &[u8]) -> usize {
    let mut position = 0usize;
    while position + 4 <= bytes.len() {
        let len = u32::from_le_bytes(
            bytes[position..position + 4]
                .try_into()
                .expect("4-byte slice"),
        ) as usize;
        match (position + 4).checked_add(len) {
            Some(end) if end <= bytes.len() => position = end,
            _ => break,
        }
    }
    position
}

impl LogWriter {
    pub fn new(paths: &DataPaths) -> io::Result<Self> {
        let now = Local::now();
        let date = now.format("%Y-%m-%d").to_string();
        let hour = now.hour();

        let segment_path = paths.event_segment_path(&date, hour);
        let writer = open_log(&segment_path, &segment_id(&date, hour))?;

        Ok(Self {
            paths: paths.clone(),
            writer,
            current_date: date,
            current_hour: hour,
            events_written: 0,
            last_rotation: None,
        })
    }

    /// Append a raw MessagePack event to the current segment (one sealed record).
    pub fn append(&mut self, data: &[u8]) -> io::Result<()> {
        seal::require_writable().map_err(io_error)?;
        // Check if we need to rotate (new hour)
        let now = Local::now();
        let date = now.format("%Y-%m-%d").to_string();
        let hour = now.hour();

        if hour != self.current_hour || date != self.current_date {
            self.rotate()?;
        }

        if u32::try_from(data.len()).is_err() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "event exceeds 4GB size limit",
            ));
        }
        // One write per record, no fsync: events are small and infrequent, and a
        // torn final record is dropped on reopen.
        self.writer.append(data)?;
        self.events_written += 1;
        Ok(())
    }

    /// Get the path of the current segment file.
    pub fn current_segment_path(&self) -> String {
        self.paths
            .event_segment_path(&self.current_date, self.current_hour)
            .to_string_lossy()
            .to_string()
    }

    /// Close the current segment (compress, seal as `RYU-SF01`), and open a new one.
    pub fn rotate(&mut self) -> io::Result<()> {
        self.writer.sync()?;

        let old_date = self.current_date.clone();
        let old_hour = self.current_hour;
        let old_path = self.paths.event_segment_path(&old_date, old_hour);
        let old_path_str = old_path.to_string_lossy().to_string();

        let compressed_path = self
            .paths
            .event_segment_compressed_path(&old_date, old_hour);
        let compressed = close_segment(
            &old_path,
            &compressed_path,
            &segment_id(&old_date, old_hour),
        )?;
        self.last_rotation = Some(RotationInfo {
            old_raw_path: old_path_str,
            compressed_path: compressed.then(|| compressed_path.to_string_lossy().to_string()),
        });

        // Update to current time
        let now = Local::now();
        self.current_date = now.format("%Y-%m-%d").to_string();
        self.current_hour = now.hour();

        let new_path = self
            .paths
            .event_segment_path(&self.current_date, self.current_hour);
        self.writer = open_log(
            &new_path,
            &segment_id(&self.current_date, self.current_hour),
        )?;
        self.events_written = 0;

        Ok(())
    }

    /// Consume the last rotation info, if any. Called after append/rotate
    /// to learn what happened for segment table updates.
    pub fn take_last_rotation(&mut self) -> Option<RotationInfo> {
        self.last_rotation.take()
    }

    /// Sync the open segment to disk. Call on app quit.
    #[allow(dead_code)]
    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.sync()
    }
}

/// Read the events of the open-segment file at `path` (sealed log or legacy
/// plaintext frames), ignoring a torn tail.
fn read_open_segment(path: &Path, id: &str) -> io::Result<Vec<Vec<u8>>> {
    if is_sealed_log(path)? {
        let recovered =
            open_recovering(path, &segment_cipher(id)?, &log_context(id)).map_err(io_error)?;
        return Ok(recovered.records);
    }
    Ok(parse_frames(&fs::read(path)?))
}

/// Split classic `[u32 LE len][msgpack]` frames; a torn final frame is dropped.
fn parse_frames(bytes: &[u8]) -> Vec<Vec<u8>> {
    let mut events = Vec::new();
    let mut position = 0usize;
    while position + 4 <= bytes.len() {
        let len = u32::from_le_bytes(
            bytes[position..position + 4]
                .try_into()
                .expect("4-byte slice"),
        ) as usize;
        let start = position + 4;
        let Some(end) = start.checked_add(len).filter(|end| *end <= bytes.len()) else {
            break;
        };
        events.push(bytes[start..end].to_vec());
        position = end;
    }
    events
}

fn frame(events: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(events.iter().map(|event| event.len() + 4).sum());
    for event in events {
        out.extend_from_slice(&(event.len() as u32).to_le_bytes());
        out.extend_from_slice(event);
    }
    out
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Write `compressed` as an `RYU-SF01` file at `dest` (temp + rename).
fn publish_sealed_file(dest: &Path, compressed: &[u8], id: &str) -> io::Result<()> {
    let temp = with_suffix(dest, ".sealing");
    let _ = fs::remove_file(&temp);
    let result = (|| -> io::Result<()> {
        let mut writer = SealedFileWriter::create(&temp, &segment_cipher(id)?, &file_context(id))
            .map_err(io_error)?;
        writer.write_plain(compressed).map_err(io_error)?;
        writer.finish().map_err(io_error)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    fs::rename(&temp, dest)?;
    Ok(())
}

/// Write `compressed` as a plaintext closed segment at `dest` (temp + rename,
/// owner-only), in compat mode.
fn publish_plain_file(dest: &Path, compressed: &[u8]) -> io::Result<()> {
    let temp = with_suffix(dest, ".sealing");
    let _ = fs::remove_file(&temp);
    let result = (|| -> io::Result<()> {
        use std::io::Write as _;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(compressed)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    fs::rename(&temp, dest)
}

/// Close one open segment: read it, prepend what an existing closed file for
/// the same hour already holds, zstd-compress, seal, publish, delete the log.
/// Returns whether a closed file was written (false for an empty segment).
///
/// The closed copy keeps the open log's modification time, which is when the
/// hour's last event was captured. Rotation runs on the *next* append,
/// possibly days later, and the "Keep history" sweep ages event logs by
/// modification time, so stamping the rotation time would keep old typed input
/// on disk past the window.
fn close_segment(open_path: &Path, dest: &Path, id: &str) -> io::Result<bool> {
    if !open_path.exists() {
        return Ok(false);
    }
    let captured_at = fs::metadata(open_path)?.modified()?;
    let mut events = Vec::new();
    if dest.exists() {
        // The same hour was closed before (clock moved back): keep both.
        events.extend(read_closed_segment(dest, id)?);
    }
    let fresh = read_open_segment(open_path, id)?;
    if fresh.is_empty() && events.is_empty() {
        fs::remove_file(open_path)?;
        return Ok(false);
    }
    events.extend(fresh);
    let compressed = zstd::encode_all(frame(&events).as_slice(), 3)?;
    if seal::is_sealing() {
        publish_sealed_file(dest, &compressed, id)?;
    } else {
        // Compat mode: the pre-sealing plaintext zstd, sealed at the first
        // start with a key.
        seal::require_writable().map_err(io_error)?;
        publish_plain_file(dest, &compressed)?;
    }
    fs::File::options()
        .write(true)
        .open(dest)?
        .set_modified(captured_at)?;
    // The closed copy is published; only now drop the log.
    fs::remove_file(open_path)?;
    Ok(true)
}

fn read_closed_segment(path: &Path, id: &str) -> io::Result<Vec<Vec<u8>>> {
    let bytes = fs::read(path)?;
    let compressed = if bytes.starts_with(ryu_crypto::content::SEALED_FILE_MAGIC) {
        open_file_bytes(&bytes, &segment_cipher(id)?, &file_context(id)).map_err(io_error)?
    } else {
        bytes
    };
    Ok(parse_frames(&zstd::decode_all(compressed.as_slice())?))
}

/// Rewrite a legacy plaintext open segment as a sealed log in place
/// (temp + rename; the plaintext is replaced only after the log is complete).
fn convert_legacy_open_segment(path: &Path, id: &str) -> io::Result<()> {
    let events = parse_frames(&fs::read(path)?);
    let temp = with_suffix(path, ".sealing");
    let _ = fs::remove_file(&temp);
    let result = (|| -> io::Result<()> {
        let mut writer = SealedLogWriter::create(&temp, &segment_cipher(id)?, &log_context(id))
            .map_err(io_error)?;
        for event in &events {
            writer.append(event).map_err(io_error)?;
        }
        writer.sync().map_err(io_error)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    fs::rename(&temp, path)
}

/// Every event of a segment file, in order, whatever its form: sealed log,
/// sealed closed file, legacy plaintext frames or legacy plaintext zstd.
pub fn read_segment_events(path: &Path, date: &str, hour: u32) -> io::Result<Vec<Vec<u8>>> {
    let id = segment_id(date, hour);
    let is_closed = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".msgpack.zst"));
    if is_closed {
        read_closed_segment(path, &id)
    } else {
        read_open_segment(path, &id)
    }
}

/// `(date, hour, closed)` of a segment file name inside `events/<date>/`.
fn parse_segment_name(date_dir: &Path, path: &Path) -> Option<(String, u32, bool)> {
    let date = date_dir.file_name()?.to_str()?.to_owned();
    if chrono::NaiveDate::parse_from_str(&date, "%Y-%m-%d").is_err() {
        return None;
    }
    let name = path.file_name()?.to_str()?;
    let (stem, closed) = if let Some(stem) = name.strip_suffix(".msgpack.zst") {
        (stem, true)
    } else if let Some(stem) = name.strip_suffix(".msgpack") {
        (stem, false)
    } else {
        return None;
    };
    let hour: u32 = stem.parse().ok().filter(|hour| *hour < 24)?;
    Some((date, hour, closed))
}

/// What one startup sweep did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SweepReport {
    /// Legacy plaintext closed segments sealed in place.
    pub sealed_closed: u64,
    /// Open segments of past hours (sealed logs or legacy plaintext) closed.
    pub closed_orphans: u64,
    /// Files that could not be processed (left untouched, retried next start).
    pub failed: u64,
}

/// Startup sweep: seal every legacy plaintext closed segment in place, close
/// every open segment of a past hour (crash orphans and legacy plaintext), and
/// delete interrupted temp files. `current` is the open segment of this hour,
/// which the writer handles. Idempotent; a file that fails is left for the next
/// start. Never deletes plaintext before the sealed copy is published.
pub fn sweep_segments(paths: &DataPaths, current: Option<&Path>) -> SweepReport {
    sweep(paths, current, SweepScope::All)
}

/// The part of [`sweep_segments`] that must finish before the writer starts:
/// close every open segment of a past hour and delete interrupted temp files.
/// Closed legacy plaintext segments are left for
/// [`seal_closed_segments`], which may run in the background.
pub fn sweep_open_segments(paths: &DataPaths, current: Option<&Path>) -> SweepReport {
    sweep(paths, current, SweepScope::Open)
}

/// Seal every legacy plaintext closed segment in place (the long part of the
/// startup sweep: it rewrites the retained event history). Safe beside a live
/// writer: it never touches open segments or temp files, and readers accept
/// both forms while it runs.
pub fn seal_closed_segments(paths: &DataPaths) -> SweepReport {
    sweep(paths, None, SweepScope::Closed)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SweepScope {
    All,
    Open,
    Closed,
}

fn sweep(paths: &DataPaths, current: Option<&Path>, scope: SweepScope) -> SweepReport {
    let mut report = SweepReport::default();
    let Ok(dates) = fs::read_dir(&paths.events) else {
        return report;
    };
    for date_dir in dates.flatten().map(|entry| entry.path()) {
        if !date_dir.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&date_dir) else {
            continue;
        };
        let _ = seal::create_private_dir(&date_dir);
        for path in files.flatten().map(|entry| entry.path()) {
            if path.extension().is_some_and(|ext| ext == "sealing") {
                // A background seal of a closed segment writes one of these.
                if scope != SweepScope::Closed {
                    let _ = fs::remove_file(&path);
                }
                continue;
            }
            if Some(path.as_path()) == current {
                continue;
            }
            let Some((date, hour, closed)) = parse_segment_name(&date_dir, &path) else {
                continue;
            };
            let wanted = match scope {
                SweepScope::All => true,
                SweepScope::Open => !closed,
                SweepScope::Closed => closed,
            };
            if !wanted {
                continue;
            }
            let id = segment_id(&date, hour);
            let result = if closed {
                seal_closed_in_place(&path, &id).map(|sealed| {
                    if sealed {
                        report.sealed_closed += 1;
                    }
                })
            } else {
                let dest = paths.event_segment_compressed_path(&date, hour);
                close_segment(&path, &dest, &id).map(|_| report.closed_orphans += 1)
            };
            if let Err(error) = result {
                report.failed += 1;
                log::warn!(
                    "shadow: could not seal an event segment ({error}); retrying next start"
                );
            }
        }
    }
    report
}

/// Seal a legacy plaintext zstd segment in place. Returns whether it was sealed.
///
/// The sealed copy keeps the plaintext file's modification time (its capture
/// time), so the "Keep history" sweep still ages it out on schedule.
fn seal_closed_in_place(path: &Path, id: &str) -> io::Result<bool> {
    use ryu_crypto::sealed_file::SealInPlace;
    let captured_at = fs::metadata(path)?.modified()?;
    let outcome =
        seal_file_in_place(path, &segment_cipher(id)?, &file_context(id)).map_err(io_error)?;
    let sealed = !matches!(outcome, SealInPlace::AlreadySealed);
    if sealed {
        fs::File::options()
            .write(true)
            .open(path)?
            .set_modified(captured_at)?;
    }
    Ok(sealed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs::File;
    use tempfile::TempDir;

    fn make_test_paths() -> (TempDir, DataPaths) {
        crate::seal::install_fixed_key_for_tests();
        let tmp = TempDir::new().unwrap();
        let paths = DataPaths::new(tmp.path().to_str().unwrap());
        paths.ensure_dirs().unwrap();
        (tmp, paths)
    }

    fn event_bytes(marker: &str) -> Vec<u8> {
        let mut event: HashMap<&str, rmpv::Value> = HashMap::new();
        event.insert("ts", rmpv::Value::from(1708300800000000u64));
        event.insert("track", rmpv::Value::from(3u8));
        event.insert("type", rmpv::Value::from("test"));
        event.insert("window_title", rmpv::Value::from(marker));
        rmp_serde::to_vec(&event).unwrap()
    }

    /// The compat-mode writer keeps the pre-sealing frame format: a torn
    /// tail is cut before appending, the frames read back, and the first
    /// start with a key converts the segment into a sealed log.
    #[test]
    fn plaintext_compat_segment_reads_and_converts_with_a_key() {
        let (_tmp, paths) = make_test_paths();
        let path = paths.event_segment_path("2024-02-19", 7);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // HashMap order varies per call: encode each event once.
        let (first, second) = (event_bytes("first"), event_bytes("second"));
        {
            let mut log = SegmentLog::Plain(open_plain_log(&path).unwrap());
            log.append(&first).unwrap();
            log.sync().unwrap();
        }
        // A crash mid-frame.
        {
            use std::io::Write as _;
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(&[200, 0, 0, 0, 1, 2]).unwrap();
        }
        {
            let mut log = SegmentLog::Plain(open_plain_log(&path).unwrap());
            log.append(&second).unwrap();
            log.sync().unwrap();
        }
        assert!(!is_sealed_log(&path).unwrap());
        let events = read_segment_events(&path, "2024-02-19", 7).unwrap();
        assert_eq!(events, vec![first, second]);

        // Closed in plaintext zstd, as before sealing, and still readable.
        let closed = paths.event_segment_compressed_path("2024-02-19", 7);
        publish_plain_file(
            &closed,
            &zstd::encode_all(frame(&events).as_slice(), 3).unwrap(),
        )
        .unwrap();
        assert_eq!(
            read_segment_events(&closed, "2024-02-19", 7).unwrap(),
            events
        );

        // With a key the open segment becomes a sealed log, events intact.
        match open_log(&path, &segment_id("2024-02-19", 7)).unwrap() {
            SegmentLog::Sealed(_) => {}
            SegmentLog::Plain(_) => panic!("a key opens a sealed log"),
        }
        assert!(is_sealed_log(&path).unwrap());
        assert_eq!(read_segment_events(&path, "2024-02-19", 7).unwrap(), events);
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle)
    }

    #[test]
    fn test_write_and_read_back() {
        let (_tmp, paths) = make_test_paths();
        let mut writer = LogWriter::new(&paths).unwrap();
        let bytes = event_bytes("SecretWindowTitle-123");
        writer.append(&bytes).unwrap();
        writer.flush().unwrap();

        let date = writer.current_date.clone();
        let hour = writer.current_hour;
        let segment = paths.event_segment_path(&date, hour);
        let on_disk = fs::read(&segment).unwrap();
        assert!(on_disk.starts_with(ryu_crypto::content::SEALED_LOG_MAGIC));
        assert!(!contains(&on_disk, b"SecretWindowTitle-123"));
        assert_eq!(
            read_segment_events(&segment, &date, hour).unwrap(),
            vec![bytes]
        );
    }

    #[test]
    fn reopening_in_the_same_hour_appends() {
        let (_tmp, paths) = make_test_paths();
        let first = event_bytes("one");
        let second = event_bytes("two");
        let (date, hour) = {
            let mut writer = LogWriter::new(&paths).unwrap();
            writer.append(&first).unwrap();
            (writer.current_date.clone(), writer.current_hour)
        };
        let mut writer = LogWriter::new(&paths).unwrap();
        if writer.current_hour != hour {
            return; // the hour turned between the two opens
        }
        writer.append(&second).unwrap();
        let segment = paths.event_segment_path(&date, hour);
        assert_eq!(
            read_segment_events(&segment, &date, hour).unwrap(),
            vec![first, second]
        );
    }

    #[test]
    fn closing_compresses_then_seals_and_deletes_the_log() {
        let (_tmp, paths) = make_test_paths();
        let date = "2024-02-19";
        let open = paths.event_segment_path(date, 7);
        let id = segment_id(date, 7);
        let events: Vec<Vec<u8>> = (0..50)
            .map(|n| event_bytes(&format!("TopSecretTitle-{n}")))
            .collect();
        {
            let mut log = open_log(&open, &id).unwrap();
            for event in &events {
                log.append(event).unwrap();
            }
        }
        let dest = paths.event_segment_compressed_path(date, 7);
        assert!(close_segment(&open, &dest, &id).unwrap());
        assert!(!open.exists());
        let sealed = fs::read(&dest).unwrap();
        assert!(sealed.starts_with(ryu_crypto::content::SEALED_FILE_MAGIC));
        assert!(!contains(&sealed, b"TopSecretTitle"));
        assert_eq!(read_segment_events(&dest, date, 7).unwrap(), events);
        // Bound to its logical id: read as another hour it does not open.
        assert!(read_segment_events(&dest, date, 8).is_err());
    }

    #[test]
    fn sweep_seals_legacy_segments_and_is_idempotent() {
        let (_tmp, paths) = make_test_paths();
        let date = "2024-02-18";
        fs::create_dir_all(paths.events.join(date)).unwrap();
        let events = vec![event_bytes("LegacyClosed-A"), event_bytes("LegacyClosed-B")];
        let legacy_closed = paths.event_segment_compressed_path(date, 3);
        fs::write(
            &legacy_closed,
            zstd::encode_all(frame(&events).as_slice(), 3).unwrap(),
        )
        .unwrap();
        let orphan_events = vec![event_bytes("LegacyOpen-C")];
        let legacy_open = paths.event_segment_path(date, 4);
        fs::write(&legacy_open, frame(&orphan_events)).unwrap();

        // Legacy files read before the sweep.
        assert_eq!(
            read_segment_events(&legacy_closed, date, 3).unwrap(),
            events
        );
        assert_eq!(
            read_segment_events(&legacy_open, date, 4).unwrap(),
            orphan_events
        );

        let report = sweep_segments(&paths, None);
        assert_eq!(report.sealed_closed, 1);
        assert_eq!(report.closed_orphans, 1);
        assert_eq!(report.failed, 0);
        assert!(!legacy_open.exists());
        let closed_orphan = paths.event_segment_compressed_path(date, 4);
        for (path, hour, expected) in [
            (&legacy_closed, 3, &events),
            (&closed_orphan, 4, &orphan_events),
        ] {
            let bytes = fs::read(path).unwrap();
            assert!(bytes.starts_with(ryu_crypto::content::SEALED_FILE_MAGIC));
            assert_eq!(&read_segment_events(path, date, hour).unwrap(), expected);
        }
        let again = sweep_segments(&paths, None);
        assert_eq!(again, SweepReport::default());
    }

    #[test]
    fn a_legacy_open_segment_of_this_hour_becomes_a_sealed_log() {
        let (_tmp, paths) = make_test_paths();
        let date = "2024-02-17";
        fs::create_dir_all(paths.events.join(date)).unwrap();
        let path = paths.event_segment_path(date, 9);
        let legacy = vec![event_bytes("PlainBefore")];
        fs::write(&path, frame(&legacy)).unwrap();
        let mut log = open_log(&path, &segment_id(date, 9)).unwrap();
        let next = event_bytes("SealedAfter");
        log.append(&next).unwrap();
        drop(log);
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(ryu_crypto::content::SEALED_LOG_MAGIC));
        assert!(!contains(&bytes, b"PlainBefore"));
        assert_eq!(
            read_segment_events(&path, date, 9).unwrap(),
            vec![legacy[0].clone(), next]
        );
    }

    #[test]
    fn rotation_keeps_the_capture_time_on_the_compressed_hour() {
        let (_tmp, paths) = make_test_paths();
        let mut writer = LogWriter::new(&paths).unwrap();
        writer.append(b"typed text").unwrap();
        let raw = writer.current_segment_path();
        let captured_at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        File::options()
            .write(true)
            .open(&raw)
            .unwrap()
            .set_modified(captured_at)
            .unwrap();

        writer.rotate().unwrap();
        let compressed = writer
            .take_last_rotation()
            .and_then(|rotation| rotation.compressed_path)
            .expect("a non-empty hour is compressed");
        assert_eq!(
            fs::metadata(&compressed).unwrap().modified().unwrap(),
            captured_at
        );
    }
}
