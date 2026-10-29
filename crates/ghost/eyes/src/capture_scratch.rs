//! Owner-only scratch space for the raw frame a capture helper writes to disk.
//!
//! On macOS the capture path runs Apple's `screencapture` CLI, which can only write
//! its PNG to a file. That file is a full-resolution, unencrypted screenshot, so it
//! never goes to the shared system temp directory: the host process names an
//! owner-only scratch directory under its data dir with [`set_scratch_dir`] (Shadow:
//! `<data dir>/tmp/shadow`, Ghost: `<data dir>/tmp/ghost`), the target file is
//! pre-created `0600`, and a [`ScratchFile`] guard deletes it on every exit path
//! (success, a failed helper, a read error). [`set_scratch_dir`] also clears what a
//! crash left behind there, and [`remove_legacy_temp_captures`] deletes the
//! `ghost-capture-*.png` files earlier builds left in the system temp dir.
//!
//! A process that never calls [`set_scratch_dir`] falls back to an owner-only
//! (`0700`) `ghost-eyes-capture` directory inside the system temp dir.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

/// File name prefix of a capture frame (also what earlier builds used in temp).
pub const CAPTURE_PREFIX: &str = "ghost-capture-";

static SCRATCH_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Create `dir` owner-only (`0700`, also tightening an existing directory).
fn create_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Delete the capture frames in `dir` (regular files only; links are left alone).
fn remove_captures_in(dir: &Path, owned_by: Option<&fs::Metadata>) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with(CAPTURE_PREFIX) && name.ends_with(".png")) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.file_type().is_file() {
            continue;
        }
        #[cfg(unix)]
        if let Some(owner) = owned_by {
            use std::os::unix::fs::MetadataExt as _;
            if meta.uid() != owner.uid() {
                continue;
            }
        }
        #[cfg(not(unix))]
        let _ = owned_by;
        if fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Use `dir` (under the host's data dir) for capture frames: create it owner-only
/// and clear any frame a crash left there. Call once at startup.
pub fn set_scratch_dir(dir: PathBuf) -> io::Result<()> {
    create_private_dir(&dir)?;
    remove_captures_in(&dir, None);
    if let Ok(mut slot) = SCRATCH_DIR.write() {
        *slot = Some(dir);
    }
    Ok(())
}

/// Delete `ghost-capture-*.png` files that earlier builds left in the system temp
/// dir, owned by this user and only regular files. Returns how many went. Call
/// after [`set_scratch_dir`].
pub fn remove_legacy_temp_captures() -> usize {
    // Ownership is compared with the scratch dir this process owns (no libc).
    let Some(owner) = scratch_dir().and_then(fs::metadata).ok() else {
        return 0;
    };
    remove_captures_in(&std::env::temp_dir(), Some(&owner))
}

fn fallback_dir() -> PathBuf {
    std::env::temp_dir().join("ghost-eyes-capture")
}

/// The owner-only directory capture frames go to (created if missing).
pub fn scratch_dir() -> io::Result<PathBuf> {
    let configured = SCRATCH_DIR.read().ok().and_then(|slot| slot.clone());
    let dir = configured.unwrap_or_else(fallback_dir);
    create_private_dir(&dir)?;
    Ok(dir)
}

/// One capture frame file: pre-created `0600` (the helper overwrites it in place)
/// and deleted when the guard drops, whatever happened in between.
pub struct ScratchFile {
    path: PathBuf,
}

impl ScratchFile {
    /// Create a fresh, empty, owner-only frame file named `<prefix><label>-<n>.png`
    /// in `dir`.
    pub fn create_in(dir: &Path, label: &str) -> io::Result<Self> {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros();
        let path = dir.join(format!(
            "{CAPTURE_PREFIX}{label}-{stamp}-{}-{n}.png",
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        options.open(&path)?;
        Ok(Self { path })
    }

    /// Create a frame file in the configured scratch dir.
    pub fn create(label: &str) -> io::Result<Self> {
        Self::create_in(&scratch_dir()?, label)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

/// Run `write` (which fills the frame file, e.g. by running a capture helper) and
/// read the file back. The file is deleted on every path, including a failed
/// `write` and a read error.
pub fn capture_through_file(
    label: &str,
    write: impl FnOnce(&Path) -> anyhow::Result<()>,
) -> anyhow::Result<Vec<u8>> {
    capture_through_file_in(&scratch_dir()?, label, write)
}

fn capture_through_file_in(
    dir: &Path,
    label: &str,
    write: impl FnOnce(&Path) -> anyhow::Result<()>,
) -> anyhow::Result<Vec<u8>> {
    let file = ScratchFile::create_in(dir, label)?;
    write(file.path())?;
    let bytes = fs::read(file.path())
        .map_err(|e| anyhow::anyhow!("failed to read the capture frame: {e}"))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ghost-eyes-scratch-test-{label}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_frame_lives_under_the_data_dir_owner_only_and_is_removed_after_reading() {
        let root = temp_root("ok");
        let scratch = root.join("tmp").join("shadow");
        create_private_dir(&scratch).unwrap();
        let mut seen = None;
        let bytes = capture_through_file_in(&scratch, "1", |path| {
            assert!(path.starts_with(&scratch), "{}", path.display());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                let mode = fs::metadata(path).unwrap().permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
                let dir_mode = fs::metadata(&scratch).unwrap().permissions().mode() & 0o777;
                assert_eq!(dir_mode, 0o700);
            }
            fs::write(path, b"png-bytes")?;
            seen = Some(path.to_path_buf());
            Ok(())
        })
        .unwrap();
        assert_eq!(bytes, b"png-bytes");
        assert!(
            !seen.unwrap().exists(),
            "the frame must be deleted after reading"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_helper_leaves_no_frame_behind() {
        let root = temp_root("fail");
        let scratch = root.join("tmp").join("ghost");
        create_private_dir(&scratch).unwrap();
        let mut seen = None;
        let result = capture_through_file_in(&scratch, "2", |path| {
            fs::write(path, b"partial screenshot")?;
            seen = Some(path.to_path_buf());
            Err(anyhow::anyhow!("screencapture exited with status 1"))
        });
        assert!(result.is_err());
        assert!(
            !seen.unwrap().exists(),
            "a failed capture must not leave its frame"
        );
        assert_eq!(fs::read_dir(&scratch).unwrap().count(), 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn startup_clears_crash_orphans_but_not_links_or_other_files() {
        let root = temp_root("sweep");
        let scratch = root.join("tmp").join("shadow");
        create_private_dir(&scratch).unwrap();
        fs::write(scratch.join("ghost-capture-0-1.png"), b"orphan").unwrap();
        fs::write(scratch.join("keep.txt"), b"other").unwrap();
        let outside = root.join("outside.png");
        fs::write(&outside, b"target").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, scratch.join("ghost-capture-link.png")).unwrap();
        assert_eq!(remove_captures_in(&scratch, None), 1);
        assert!(!scratch.join("ghost-capture-0-1.png").exists());
        assert!(scratch.join("keep.txt").exists());
        assert!(outside.exists(), "a link's target is never deleted");
        let _ = fs::remove_dir_all(&root);
    }
}
