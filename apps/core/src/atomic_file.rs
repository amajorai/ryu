//! Crash-safe replacement of small state/config files.
//!
//! `std::fs::write` truncates the destination before writing, so a crash or
//! power loss mid-write leaves an empty or half-written file that later reads
//! as corrupt (and most loaders then fall back to defaults, silently dropping
//! the user's state). [`write_atomic`] writes a sibling temporary file, flushes
//! it to disk, and renames it over the destination, so readers only ever see
//! the old contents or the new contents.

use std::io::Write;
use std::path::Path;

/// Atomically replace `path` with `bytes`, creating parent directories.
///
/// The temporary file is created by `tempfile`, which uses mode `0o600` on
/// Unix, so the replaced file is owner-only — suitable for secrets as well as
/// ordinary state.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    // Make the rename itself durable. Best-effort: some filesystems refuse
    // fsync on a directory handle, and the data is already in place.
    #[cfg(unix)]
    if let Ok(directory) = std::fs::File::open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

/// Read the non-empty trimmed contents of `path`, or atomically create it with
/// `mint()` when it is missing or blank. First writer wins: when another writer
/// (possibly another process) creates the file concurrently, its value is read
/// back and returned instead, so every party converges on one value and no
/// reader ever observes a partially written file.
pub(crate) fn read_or_create_secret(
    path: &Path,
    mint: impl FnOnce() -> String,
) -> std::io::Result<String> {
    let read_existing = || {
        std::fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    if let Some(existing) = read_existing() {
        return Ok(existing);
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let value = mint();
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(value.as_bytes())?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(path) {
        Ok(_) => Ok(value),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if let Some(existing) = read_existing() {
                return Ok(existing);
            }
            // A pre-existing blank file: replace it.
            write_atomic(path, value.as_bytes())?;
            Ok(value)
        }
        // No-clobber persist is unsupported on some filesystems (no hard
        // links); degrade to a plain atomic replace rather than fail to start.
        Err(_) => {
            write_atomic(path, value.as_bytes())?;
            Ok(value)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{read_or_create_secret, write_atomic};

    #[test]
    fn read_or_create_secret_keeps_the_first_value() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("token");
        let first = read_or_create_secret(&path, || "alpha".to_owned()).unwrap();
        let second = read_or_create_secret(&path, || "bravo".to_owned()).unwrap();
        assert_eq!(first, "alpha");
        assert_eq!(second, "alpha");
        std::fs::write(&path, "  \n").unwrap();
        assert_eq!(
            read_or_create_secret(&path, || "charlie".to_owned()).unwrap(),
            "charlie"
        );
    }

    #[test]
    fn replaces_contents_and_leaves_no_temporaries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("state.json");
        write_atomic(&path, b"first").unwrap();
        write_atomic(&path, b"second").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second");
        let entries: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("state.json")]);
    }

    #[cfg(unix)]
    #[test]
    fn replaced_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secret.json");
        std::fs::write(&path, b"old").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_atomic(&path, b"new").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
