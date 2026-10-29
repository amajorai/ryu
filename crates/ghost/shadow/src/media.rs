//! Sealed capture media: screen video segments, audio recordings and keyframes.
//!
//! An encoder writes a media file in plaintext while it is open (ffmpeg and the
//! WAV writer need a seekable plain file). When the encoder closes the file,
//! Shadow seals it in place as `RYU-SF01` ([`seal_media_file`]) under the
//! [`seal::MEDIA_STORE`] content key's per-file subkey, bound to the file's
//! logical id: its path relative to the `media/` directory (so moving the data
//! folder keeps it readable). A startup sweep ([`sweep_media`]) seals any closed
//! or orphaned plaintext file a crash left behind.
//!
//! In compat mode ([`seal::SealingState::Compat`]) media files stay in
//! plaintext, as before sealing, and the sweep of the first start with a key
//! seals them.
//!
//! Readers open through [`read_media_file`] (whole file) or
//! [`decrypt_media_to`] (an owner-only temp copy for tools that need a path,
//! deleted when the guard drops). Legacy plaintext files still read.
//!
//! User clips (`media/clips/`) are not sealed here: they are a deliberate
//! recording the user exports, and the clip pipeline re-reads them with ffmpeg.

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime};

use ryu_crypto::sealed_file::{is_sealed_file, open_file_bytes, seal_file_in_place, SealInPlace};
use ryu_crypto::{ContentCipher, ContentContext};

use crate::config::DataPaths;
use crate::seal;
use crate::ShadowError;

/// A plaintext media file younger than this may still be open in another
/// live Shadow's encoder. The sweep honours it only when this process could
/// not take the media writer lock (another Shadow holds it); otherwise every
/// plaintext file that is not open in this process is sealed at once.
pub const OPEN_FILE_GRACE: Duration = Duration::from_secs(15 * 60);

/// Paths this process's encoders have open. Guarded together with every seal
/// so the sweep never seals (or deletes the temp of) a file being written or
/// sealed by another thread.
fn open_media() -> MutexGuard<'static, HashSet<PathBuf>> {
    static OPEN: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    OPEN.get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Record that an encoder in this process is about to write `path` in
/// plaintext. Call before the encoder creates the file; the sweep skips it
/// until [`mark_media_closed`]. Blocks while a seal is in progress.
pub fn mark_media_open(path: &Path) {
    open_media().insert(path.to_path_buf());
}

/// The encoder closed `path` (whether or not its seal succeeded): the sweep may
/// seal it from now on.
pub fn mark_media_closed(path: &Path) {
    open_media().remove(path);
}

/// The media writer lock, held for the life of the process once taken.
static WRITER_LOCK: OnceLock<Option<fs::File>> = OnceLock::new();

/// Take Shadow's exclusive media writer lock (`media/.writer.lock`) for the
/// life of the process. Returns whether this process holds it: when it does,
/// no other live Shadow can have a media file open, so leftovers of a dead
/// process are sealed at once rather than after [`OPEN_FILE_GRACE`].
pub fn acquire_writer_lock(media_root: &Path) -> bool {
    WRITER_LOCK
        .get_or_init(|| {
            fs::create_dir_all(media_root).ok()?;
            let file = fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .write(true)
                .open(media_root.join(".writer.lock"))
                .ok()?;
            file.try_lock().ok()?;
            Some(file)
        })
        .is_some()
}

fn holds_writer_lock() -> bool {
    WRITER_LOCK.get().is_some_and(Option::is_some)
}

fn storage_error(error: impl std::fmt::Display) -> ShadowError {
    ShadowError::StorageError {
        msg: error.to_string(),
    }
}

fn media_root() -> Result<PathBuf, ShadowError> {
    crate::get_data_paths().map(|paths| paths.root.join("media"))
}

/// The logical id of a media file: its path relative to `media_root`, with `/`
/// separators. `None` for a path outside the media tree or inside `clips/`.
fn media_id(media_root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(media_root).ok()?;
    let parts: Vec<String> = relative
        .components()
        .map(|component| match component {
            std::path::Component::Normal(part) => part.to_str().map(str::to_owned),
            _ => None,
        })
        .collect::<Option<_>>()?;
    if parts.is_empty() || parts[0] == "clips" {
        return None;
    }
    Some(parts.join("/"))
}

fn cipher_for(id: &str) -> Result<ContentCipher, ShadowError> {
    Ok(seal::content(seal::MEDIA_STORE)?.subcipher(id))
}

fn context_for(id: &str) -> ContentContext {
    ContentContext::new("file").with("id", id)
}

fn seal_at(media_root: &Path, path: &Path) -> Result<bool, ShadowError> {
    let _guard = open_media();
    seal_locked(media_root, path)
}

/// [`seal_at`] for a caller that already holds the [`open_media`] guard.
fn seal_locked(media_root: &Path, path: &Path) -> Result<bool, ShadowError> {
    let Some(id) = media_id(media_root, path) else {
        return Ok(false);
    };
    seal::require_writable()?;
    if !seal::is_sealing() {
        // Compat mode: left in plaintext for the first start with a key.
        return Ok(false);
    }
    match seal_file_in_place(path, &cipher_for(&id)?, &context_for(&id)).map_err(storage_error)? {
        SealInPlace::AlreadySealed => Ok(false),
        SealInPlace::Sealed { .. } => Ok(true),
    }
}

/// Seal a closed media file in place (verified, then renamed over the
/// plaintext). Returns whether it was sealed now. A file outside `media/`, a
/// clip, or an already sealed file is left as is.
pub fn seal_media_file(path: &Path) -> Result<bool, ShadowError> {
    seal_at(&media_root()?, path)
}

fn write_sealed_at(media_root: &Path, path: &Path, bytes: &[u8]) -> Result<(), ShadowError> {
    let id = media_id(media_root, path)
        .ok_or_else(|| storage_error("media file outside the media directory"))?;
    seal::require_writable()?;
    let _guard = open_media();
    let mut temp_name = path.file_name().unwrap_or_default().to_os_string();
    temp_name.push(".sealing");
    let temp = path.with_file_name(temp_name);
    let _ = fs::remove_file(&temp);
    let result = (|| -> Result<(), ShadowError> {
        if seal::is_sealing() {
            let mut writer =
                ryu_crypto::SealedFileWriter::create(&temp, &cipher_for(&id)?, &context_for(&id))
                    .map_err(storage_error)?;
            writer.write_plain(bytes).map_err(storage_error)?;
            writer.finish().map_err(storage_error)?;
        } else {
            // Compat mode: the pre-sealing plaintext file.
            write_private(&temp, bytes).map_err(storage_error)?;
        }
        fs::rename(&temp, path).map_err(storage_error)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

/// Write a complete media file (a keyframe JPEG) directly in sealed form, so
/// its plaintext never touches the disk (in compat mode: in plaintext).
pub fn write_sealed_media(path: &Path, bytes: &[u8]) -> Result<(), ShadowError> {
    write_sealed_at(&media_root()?, path, bytes)
}

/// [`write_sealed_media`] for a writer that knows its `media/` directory (the
/// capture engine's data dir) rather than reading the storage paths.
pub fn write_sealed_media_in(
    media_root: &Path,
    path: &Path,
    bytes: &[u8],
) -> Result<(), ShadowError> {
    write_sealed_at(media_root, path, bytes)
}

/// [`read_media_file`] against an explicit `media/` directory.
pub fn read_media_file_in(media_root: &Path, path: &Path) -> Result<Vec<u8>, ShadowError> {
    read_at(media_root, path)
}

fn read_at(media_root: &Path, path: &Path) -> Result<Vec<u8>, ShadowError> {
    let bytes = fs::read(path).map_err(storage_error)?;
    if !bytes.starts_with(ryu_crypto::content::SEALED_FILE_MAGIC) {
        return Ok(bytes); // legacy plaintext, a clip, or a file still being written
    }
    let id = media_id(media_root, path)
        .ok_or_else(|| storage_error("sealed media file outside the media directory"))?;
    open_file_bytes(&bytes, &cipher_for(&id)?, &context_for(&id)).map_err(storage_error)
}

/// Read a whole media file, opening it when sealed.
pub fn read_media_file(path: &Path) -> Result<Vec<u8>, ShadowError> {
    read_at(&media_root()?, path)
}

/// An owner-only plaintext copy of a media file for a tool that needs a path
/// (ffmpeg, whisper). The copy is deleted when this guard drops.
pub struct TempMedia {
    path: PathBuf,
    owned: bool,
}

impl TempMedia {
    /// The path to hand to the tool.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempMedia {
    fn drop(&mut self) {
        if self.owned {
            let _ = fs::remove_file(&self.path);
        }
    }
}

/// Decrypt `path` into a unique 0600 file under `tmp_dir` (created 0700). A
/// legacy plaintext file is handed back as is (nothing to delete).
pub fn decrypt_media_to(path: &Path, tmp_dir: &Path) -> Result<TempMedia, ShadowError> {
    if !is_sealed_file(path).map_err(storage_error)? {
        return Ok(TempMedia {
            path: path.to_path_buf(),
            owned: false,
        });
    }
    let plain = read_media_file(path)?;
    seal::create_private_dir(tmp_dir).map_err(storage_error)?;
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("bin");
    let unique = format!(
        "media-{}-{}.{extension}",
        std::process::id(),
        TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let temp = tmp_dir.join(unique);
    write_private(&temp, &plain).map_err(storage_error)?;
    Ok(TempMedia {
        path: temp,
        owned: true,
    })
}

static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// What one media sweep did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MediaSweepReport {
    /// Plaintext files sealed.
    pub sealed: u64,
    /// Recent plaintext files left for their encoder (may still be open).
    pub skipped_open: u64,
    /// Files that failed (left untouched; retried at the next start).
    pub failed: u64,
}

/// Seal every closed plaintext file under `media/video`, `media/audio` and
/// `media/keyframes`, and delete interrupted `.sealing` temp files. A file an
/// encoder in this process has open is skipped. A recent file (within
/// [`OPEN_FILE_GRACE`]) is skipped only when another live Shadow holds the
/// media writer lock; a dead process's leftovers are sealed at once. One file
/// at a time; the original is replaced only after its sealed copy verifies.
pub fn sweep_media(paths: &DataPaths) -> MediaSweepReport {
    sweep_media_at(paths, SystemTime::now(), holds_writer_lock())
}

/// Run [`sweep_media`] on a background thread unless one is already running.
/// Called after each closed video segment, so a segment whose own seal failed
/// (or a dead process's leftover) does not wait for the next start.
pub fn spawn_sweep(paths: DataPaths) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static RUNNING: AtomicBool = AtomicBool::new(false);
    if !seal::is_sealing() {
        // Nothing can be sealed (compat mode keeps media in plaintext).
        return;
    }
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let spawned = std::thread::Builder::new()
        .name("shadow-media-seal".into())
        .spawn(move || {
            let report = sweep_media(&paths);
            RUNNING.store(false, Ordering::SeqCst);
            seal::set_progress(
                "media",
                &format!(
                    "{} sealed, {} pending, {} failed",
                    report.sealed, report.skipped_open, report.failed
                ),
            );
        });
    if let Err(error) = spawned {
        RUNNING.store(false, Ordering::SeqCst);
        log::warn!("shadow: could not start the media sealing sweep: {error}");
    }
}

fn sweep_media_at(paths: &DataPaths, now: SystemTime, exclusive: bool) -> MediaSweepReport {
    let media_root = paths.root.join("media");
    let mut report = MediaSweepReport::default();
    let mut stack = vec![
        paths.media_video.clone(),
        paths.media_audio.clone(),
        paths.media_keyframes.clone(),
    ];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for path in entries.flatten().map(|entry| entry.path()) {
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            // Hold the guard for this file only: an encoder opening or closing
            // a segment waits for at most one seal.
            let open = open_media();
            if path.extension().is_some_and(|ext| ext == "sealing") {
                let _ = fs::remove_file(&path);
                continue;
            }
            if open.contains(&path) {
                report.skipped_open += 1;
                continue;
            }
            match is_sealed_file(&path) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
            }
            let recent = fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .map_or(true, |age| age < OPEN_FILE_GRACE);
            if recent && !exclusive {
                report.skipped_open += 1;
                continue;
            }
            match seal_locked(&media_root, &path) {
                Ok(true) => report.sealed += 1,
                Ok(false) => {}
                Err(error) => {
                    report.failed += 1;
                    log::warn!(
                        "shadow: could not seal a media file ({error}); retrying next start"
                    );
                }
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup() -> (TempDir, DataPaths) {
        seal::install_fixed_key_for_tests();
        let tmp = TempDir::new().unwrap();
        let paths = DataPaths::new(tmp.path().to_str().unwrap());
        paths.ensure_dirs().unwrap();
        (tmp, paths)
    }

    #[test]
    fn media_ids_are_relative_and_skip_clips() {
        let root = Path::new("/d/media");
        assert_eq!(
            media_id(root, Path::new("/d/media/video/display-0/x.mp4")).as_deref(),
            Some("video/display-0/x.mp4")
        );
        assert_eq!(media_id(root, Path::new("/d/media/clips/c/clip.mp4")), None);
        assert_eq!(media_id(root, Path::new("/elsewhere/x.mp4")), None);
    }

    #[test]
    fn sealed_media_reads_back_and_hides_its_bytes() {
        let (_tmp, paths) = setup();
        let root = paths.root.join("media");
        let dir = paths.media_keyframes.join("display-0");
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("1700.jpg");
        let plain = b"JPEG-SCREEN-CONTENT-secret".repeat(100);
        fs::write(&file, &plain).unwrap();
        assert!(seal_at(&root, &file).unwrap());
        let on_disk = fs::read(&file).unwrap();
        assert!(on_disk.starts_with(ryu_crypto::content::SEALED_FILE_MAGIC));
        assert!(!on_disk
            .windows(b"SCREEN-CONTENT".len())
            .any(|w| w == b"SCREEN-CONTENT"));
        assert_eq!(read_at(&root, &file).unwrap(), plain);
        // Sealing again is a no-op.
        assert!(!seal_at(&root, &file).unwrap());
        // Bound to its id: the same bytes under another name do not open.
        let moved = dir.join("1701.jpg");
        fs::copy(&file, &moved).unwrap();
        assert!(read_at(&root, &moved).is_err());
    }

    #[test]
    fn keyframes_are_written_sealed() {
        let (_tmp, paths) = setup();
        let root = paths.root.join("media");
        let file = paths.media_keyframes.join("display-1").join("42.jpg");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        write_sealed_at(&root, &file, b"KEYFRAME-PIXELS").unwrap();
        let on_disk = fs::read(&file).unwrap();
        assert!(on_disk.starts_with(ryu_crypto::content::SEALED_FILE_MAGIC));
        assert_eq!(read_at(&root, &file).unwrap(), b"KEYFRAME-PIXELS");
    }

    #[test]
    fn sweep_seals_old_plaintext_and_skips_recent_files() {
        let (_tmp, paths) = setup();
        let old = paths.media_audio.join("2024-01-01T10.wav");
        let fresh = paths
            .media_video
            .join("display-0")
            .join("2024-01-01T11.mp4");
        fs::create_dir_all(fresh.parent().unwrap()).unwrap();
        fs::write(&old, b"RIFF-old-audio").unwrap();
        fs::write(&fresh, b"fresh-video").unwrap();
        fs::write(paths.media_audio.join("x.wav.sealing"), b"torn").unwrap();
        // Pretend "now" is two hours ahead: everything is old.
        let later = SystemTime::now() + Duration::from_secs(2 * 3600);
        let report = sweep_media_at(&paths, later, false);
        assert_eq!(report.sealed, 2);
        assert!(!paths.media_audio.join("x.wav.sealing").exists());
        assert_eq!(
            read_at(&paths.root.join("media"), &old).unwrap(),
            b"RIFF-old-audio"
        );
        // A file written just now may be another live Shadow's open segment.
        let current = paths.media_audio.join("2024-01-01T12.wav");
        fs::write(&current, b"open").unwrap();
        let report = sweep_media_at(&paths, SystemTime::now(), false);
        assert_eq!(report.skipped_open, 1);
        assert_eq!(fs::read(&current).unwrap(), b"open");
    }

    #[test]
    fn sweep_seals_a_dead_process_recent_leftover_but_never_an_open_segment() {
        let (_tmp, paths) = setup();
        let root = paths.root.join("media");
        let dir = paths.media_video.join("display-0");
        fs::create_dir_all(&dir).unwrap();
        // Left by a Shadow that was killed a minute ago.
        let leftover = dir.join("2024-01-01T09.mp4");
        fs::write(&leftover, b"SCREEN-VIDEO-leftover").unwrap();
        // Being written by this process's encoder right now.
        let open = dir.join("2024-01-01T10.mp4");
        mark_media_open(&open);
        fs::write(&open, b"SCREEN-VIDEO-open").unwrap();

        // This process holds the writer lock: no other Shadow is live.
        let report = sweep_media_at(&paths, SystemTime::now(), true);
        assert_eq!(report.sealed, 1);
        assert_eq!(report.skipped_open, 1);
        assert!(is_sealed_file(&leftover).unwrap());
        assert_eq!(read_at(&root, &leftover).unwrap(), b"SCREEN-VIDEO-leftover");
        assert_eq!(fs::read(&open).unwrap(), b"SCREEN-VIDEO-open");

        // Once the encoder closes it, the next sweep seals it.
        mark_media_closed(&open);
        let report = sweep_media_at(&paths, SystemTime::now(), true);
        assert_eq!(report.sealed, 1);
        assert!(is_sealed_file(&open).unwrap());
    }

    #[test]
    fn writer_lock_is_exclusive_across_handles() {
        let tmp = TempDir::new().unwrap();
        assert!(acquire_writer_lock(tmp.path()));
        // Another process (simulated with a second handle) cannot take it.
        let other = fs::OpenOptions::new()
            .write(true)
            .open(tmp.path().join(".writer.lock"))
            .unwrap();
        assert!(other.try_lock().is_err());
    }
}
