//! File-tree snapshots with SQLite's online backup API, never a raw WAL copy.
//! Restoration only publishes a complete archive into a previously absent path.

use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Seek, Write},
    path::{Component, Path},
    time::{Duration, Instant},
};

use anyhow::{ensure, Context, Result};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

pub const MAX_ENTRIES: usize = 1_000_000;
pub const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

fn is_sqlite_file(path: &Path) -> Result<bool> {
    let mut header = [0; 16];
    let mut file = File::open(path)?;
    match file.read_exact(&mut header) {
        Ok(()) => Ok(&header == b"SQLite format 3\0"),
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(error) => Err(error.into()),
    }
}

pub fn private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sqlite_snapshot(source: &Path, target: &Path) -> Result<()> {
    let from = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut to = Connection::open(target)?;
    let backup = Backup::new(&from, &mut to)?;
    let started = Instant::now();
    loop {
        ensure!(
            started.elapsed() < Duration::from_secs(300),
            "SQLite snapshot timed out; retry when writes settle"
        );
        match backup.step(256)? {
            StepResult::Done => break,
            StepResult::More => {}
            StepResult::Busy | StepResult::Locked => std::thread::sleep(Duration::from_millis(10)),
            _ => anyhow::bail!("SQLite snapshot could not complete"),
        }
    }
    Ok(())
}

/// `exclude` is supplied by the owning host; no satellite names live here.
///
/// Writes a plaintext zip at `output`. Hosts that hold credentials in the tree
/// should prefer [`snapshot_tree_into`] with an anonymous temporary file and a
/// private scratch directory, so no named plaintext copy outlives the process.
pub fn snapshot_tree(root: &Path, output: &Path, exclude: impl Fn(&Path) -> bool) -> Result<u64> {
    let canonical = root.canonicalize()?;
    ensure!(
        !output.starts_with(&canonical),
        "Backup output must be outside the source tree"
    );
    let scratch = tempfile::tempdir()?;
    let mut zip = ZipWriter::new(File::create(output)?);
    let total = snapshot_tree_into(root, &mut zip, scratch.path(), exclude)?;
    zip.finish()?.sync_all()?;
    Ok(total)
}

/// Zip `root` into an open writer (for example an anonymous `tempfile::tempfile_in`
/// file, which has no name and is reclaimed by the OS even if the process dies).
/// SQLite databases are first copied with the online backup API into a private
/// (`0700`) directory created inside `scratch`; each copy is deleted as soon as it
/// has been zipped and the directory is removed on return. The caller owns
/// `finish()` so it can append further entries.
pub fn snapshot_tree_into<W: Write + Seek>(
    root: &Path,
    zip: &mut ZipWriter<W>,
    scratch: &Path,
    exclude: impl Fn(&Path) -> bool,
) -> Result<u64> {
    let root = root.canonicalize()?;
    private_directory(scratch)?;
    let temporary = tempfile::Builder::new()
        .prefix(".ryu-sqlite-")
        .tempdir_in(scratch)?;
    private_directory(temporary.path())?;
    let mut stack = vec![root.clone()];
    let mut count = 0usize;
    let mut names = HashSet::new();
    let mut total = 0u64;
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let source = entry.path();
            let relative = source.strip_prefix(&root)?;
            if exclude(relative) {
                continue;
            }
            let kind = entry.file_type()?;
            ensure!(
                !kind.is_symlink(),
                "Backup source contains a symbolic link: {}",
                relative.display()
            );
            if kind.is_dir() {
                stack.push(source);
                continue;
            }
            // Unix sockets and other process handles have no restorable state.
            if !kind.is_file() {
                continue;
            }
            let name = relative
                .to_str()
                .context("Backup paths must be UTF-8")?
                .replace('\\', "/");
            safe_path(&name)?;
            ensure!(
                names.insert(name.clone()),
                "Backup paths collide after normalization"
            );
            if let Some(base) = ["-wal", "-shm", "-journal"]
                .iter()
                .find_map(|suffix| name.strip_suffix(suffix))
            {
                let database = root.join(base);
                if database.is_file() && is_sqlite_file(&database)? {
                    continue;
                }
            }
            count += 1;
            ensure!(count <= MAX_ENTRIES, "Too many files in backup");
            let is_sqlite = is_sqlite_file(&source)?;
            let stable = temporary.path().join("database.sqlite");
            let copied = if is_sqlite {
                sqlite_snapshot(&source, &stable)
                    .with_context(|| format!("Snapshotting {name}"))?;
                stable.as_path()
            } else {
                source.as_path()
            };
            let before = std::fs::metadata(copied)?;
            total = total
                .checked_add(before.len())
                .context("Backup size overflow")?;
            ensure!(total <= MAX_ARCHIVE_BYTES, "Backup exceeds 1 TiB");
            zip.start_file(
                name,
                SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .unix_permissions(0o600)
                    .large_file(true),
            )?;
            let actual = std::io::copy(&mut File::open(copied)?, zip)?;
            let after = std::fs::metadata(copied)?;
            ensure!(
                actual == before.len()
                    && after.len() == before.len()
                    && after.modified()? == before.modified()?,
                "A source file changed during backup; retry"
            );
            if is_sqlite {
                std::fs::remove_file(&stable)?;
            }
        }
    }
    Ok(total)
}

pub fn safe_path(name: &str) -> Result<&Path> {
    let path = Path::new(name);
    ensure!(
        !name.is_empty()
            && !name.contains('\\')
            && !name.contains(':')
            && !path.is_absolute()
            && path
                .components()
                .all(|part| matches!(part, Component::Normal(_))),
        "Unsafe backup path"
    );
    Ok(path)
}

/// Always restore to a new directory. Extraction is private and disposable until
/// every CRC, path and size has been checked; no partial result is published.
pub fn restore_tree(archive: &Path, destination: &Path) -> Result<()> {
    restore_tree_from(File::open(archive)?, destination)
}

/// [`restore_tree`] from an open archive, so a host can decrypt into an
/// anonymous temporary file instead of a named plaintext `snapshot.zip`.
pub fn restore_tree_from<R: Read + Seek>(archive: R, destination: &Path) -> Result<()> {
    ensure!(
        !destination.try_exists()?,
        "Recovery directory already exists"
    );
    let parent = destination
        .parent()
        .context("Recovery directory needs a parent")?;
    ensure!(
        parent.is_dir() && !std::fs::symlink_metadata(parent)?.file_type().is_symlink(),
        "Invalid recovery parent"
    );
    let staging = tempfile::Builder::new()
        .prefix(".ryu-restore-")
        .tempdir_in(parent)?;
    private_directory(staging.path())?;
    let mut zip = ZipArchive::new(archive)?;
    ensure!(zip.len() <= MAX_ENTRIES, "Too many backup entries");
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        let name = entry.name()?.trim_end_matches('/').to_owned();
        let relative = safe_path(&name)?;
        ensure!(seen.insert(name.clone()), "Duplicate backup path");
        ensure!(
            entry
                .unix_mode()
                .is_none_or(|mode| mode & 0o170000 != 0o120000),
            "Backup contains a symbolic link"
        );
        total = total
            .checked_add(entry.size())
            .context("Backup size overflow")?;
        ensure!(total <= MAX_ARCHIVE_BYTES, "Backup exceeds 1 TiB");
        let target = staging.path().join(relative);
        if entry.is_dir() {
            private_directory(&target)?;
            continue;
        }
        private_directory(target.parent().context("Missing parent")?)?;
        let mut output =
            tempfile::NamedTempFile::new_in(target.parent().context("Missing parent")?)?;
        let length = entry.size();
        let actual = std::io::copy(&mut (&mut entry).take(length + 1), &mut output)?;
        ensure!(actual == length, "Invalid backup entry length");
        output.flush()?;
        output.as_file().sync_all()?;
        output.persist(&target)?;
    }
    // rename cannot replace a nonempty directory. A second check also rejects an
    // operator-created empty directory rather than intentionally overwriting it.
    ensure!(
        !destination.try_exists()?,
        "Recovery directory already exists"
    );
    std::fs::rename(staging.path(), destination)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshots_committed_wal_rows_and_restores_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        private_directory(&root).unwrap();
        let db = Connection::open(root.join("rows.db")).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE rows(value); INSERT INTO rows VALUES ('committed');").unwrap();
        std::fs::write(root.join("blob"), b"binary\0content").unwrap();
        std::fs::write(root.join("notes-wal"), b"ordinary user data").unwrap();
        std::fs::write(root.join("core.token"), b"secret").unwrap();
        let archive = temp.path().join("backup.zip");
        snapshot_tree(&root, &archive, |p| p == Path::new("core.token")).unwrap();
        let target = temp.path().join("recovery");
        restore_tree(&archive, &target).unwrap();
        assert!(!target.join("rows.db-wal").exists());
        let restored = Connection::open(target.join("rows.db")).unwrap();
        assert_eq!(
            restored
                .query_row("SELECT value FROM rows", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "committed"
        );
        assert_eq!(
            std::fs::read(target.join("blob")).unwrap(),
            b"binary\0content"
        );
        assert!(!target.join("core.token").exists());
        assert_eq!(
            std::fs::read(target.join("notes-wal")).unwrap(),
            b"ordinary user data"
        );
        assert!(restore_tree(&archive, &target).is_err());
    }

    #[test]
    fn snapshot_into_an_anonymous_file_leaves_no_named_plaintext() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("data");
        private_directory(&root).unwrap();
        let db = Connection::open(root.join("prefs.db")).unwrap();
        db.execute_batch("CREATE TABLE p(v); INSERT INTO p VALUES ('sk-live-raw-credential');")
            .unwrap();
        drop(db);
        let scratch = temp.path().join("scratch");
        let mut zip = ZipWriter::new(tempfile::tempfile().unwrap());
        snapshot_tree_into(&root, &mut zip, &scratch, |_| false).unwrap();
        let mut archive = zip.finish().unwrap();
        // The scratch dir is private and holds no leftover SQLite copy.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&scratch).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        assert_eq!(std::fs::read_dir(&scratch).unwrap().count(), 0);
        archive.rewind().unwrap();
        let target = temp.path().join("recovery");
        restore_tree_from(archive, &target).unwrap();
        let restored = Connection::open(target.join("prefs.db")).unwrap();
        assert_eq!(
            restored
                .query_row("SELECT v FROM p", [], |row| row.get::<_, String>(0))
                .unwrap(),
            "sk-live-raw-credential"
        );
    }

    #[test]
    fn unsafe_archive_never_publishes_partial_recovery() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("bad.zip");
        let mut zip = ZipWriter::new(File::create(&archive).unwrap());
        zip.start_file("ok.txt", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"safe").unwrap();
        zip.start_file("../escape", SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"unsafe").unwrap();
        zip.finish().unwrap();
        let target = temp.path().join("recovery");
        assert!(restore_tree(&archive, &target).is_err());
        assert!(!target.exists());
        assert!(!temp.path().join("escape").exists());
    }
}
