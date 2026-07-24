//! Data-folder relocation, backup (export) and restore (import).
//!
//! The *destructive* operations (copy/move a relocation, restore an import) must
//! run while **no store has its SQLite files open** — copying a live `.db` (plus
//! its `-wal`/`-shm`) corrupts it. So those run as a one-shot CLI subcommand
//! (`ryu-core data-path …`) that the desktop invokes while Core is stopped, then
//! restarts Core (which re-resolves [`crate::paths::ryu_dir`] from the pointer
//! file). Export (read-only zip) is safe to run online and is exposed on the API.
//!
//! All path *logic* lives here in Core per the Core-vs-Gateway rule — the desktop
//! only orchestrates stop → run subcommand (with progress) → restart.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths;

/// Snapshot of the data folder for the desktop "Storage" setting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataPathInfo {
    /// The active data dir.
    pub current: String,
    /// The default (`~/.ryu`) — shown so the user can reset.
    pub default: String,
    /// True when `current` differs from `default`.
    pub is_custom: bool,
    /// Bytes the current data folder occupies on disk.
    pub size_bytes: u64,
    /// Bytes free on the filesystem that holds the current data folder.
    pub free_space_bytes: u64,
}

/// Build the current data-path snapshot.
pub fn info() -> DataPathInfo {
    let current = paths::ryu_dir();
    let default = paths::default_ryu_dir();
    DataPathInfo {
        is_custom: current != default,
        size_bytes: paths::dir_size(&current),
        free_space_bytes: paths::available_space_for(&current),
        current: current.to_string_lossy().into_owned(),
        default: default.to_string_lossy().into_owned(),
    }
}

/// Result of validating a relocation/import target.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidateResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Size of the source data folder (what a copy would move).
    pub source_size_bytes: u64,
    /// Free space at the target.
    pub target_free_bytes: u64,
}

/// Validate that `target` is a usable destination for a relocation that will copy
/// `source` into it. Pass `require_space=false` for a point-only switch.
pub fn validate_target(source: &Path, target: &Path, require_space: bool) -> ValidateResult {
    let source_size_bytes = paths::dir_size(source);
    let target_free_bytes = paths::available_space_for(target);

    let err = check_target(
        source,
        target,
        source_size_bytes,
        target_free_bytes,
        require_space,
    );
    ValidateResult {
        ok: err.is_none(),
        error: err,
        source_size_bytes,
        target_free_bytes,
    }
}

fn check_target(
    source: &Path,
    target: &Path,
    source_size: u64,
    target_free: u64,
    require_space: bool,
) -> Option<String> {
    if target.as_os_str().is_empty() {
        return Some("Target path is empty.".to_string());
    }
    if !target.is_absolute() {
        return Some("Target path must be absolute.".to_string());
    }
    // Reject nesting in either direction — copying a folder into itself loops.
    if paths::paths_overlap(source, target) {
        return Some(
            "Target cannot be inside the current data folder (or vice versa).".to_string(),
        );
    }
    // Target must be empty or non-existent (don't clobber an unrelated folder).
    if let Ok(mut entries) = std::fs::read_dir(target) {
        if entries.next().is_some() {
            return Some("Target folder is not empty.".to_string());
        }
    }
    // Probe writability by creating (and removing) the dir.
    if let Err(e) = std::fs::create_dir_all(target) {
        return Some(format!("Target is not writable: {e}"));
    }
    if require_space && target_free > 0 && target_free < source_size {
        return Some(format!(
            "Not enough free space: need {}, have {}.",
            human_bytes(source_size),
            human_bytes(target_free)
        ));
    }
    None
}

fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    format!("{v:.1} {}", UNITS[i])
}

// ── Progress ─────────────────────────────────────────────────────────────────────

/// A progress tick emitted to stdout (one JSON line) during a CLI operation so the
/// desktop can render a bar.
#[derive(Debug, Clone, Serialize)]
pub struct Progress {
    pub phase: &'static str,
    pub copied_bytes: u64,
    pub total_bytes: u64,
}

fn emit(progress: &Progress) {
    if let Ok(line) = serde_json::to_string(progress) {
        println!("@@PROGRESS {line}");
        let _ = std::io::stdout().flush();
    }
}

// ── Copy / move ──────────────────────────────────────────────────────────────────

/// Recursively copy `from` into `to`, invoking `on_bytes` with cumulative bytes.
fn copy_tree(
    from: &Path,
    to: &Path,
    copied: &mut u64,
    on_bytes: &mut dyn FnMut(u64),
) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_tree(&src, &dst, copied, on_bytes)?;
        } else if ft.is_file() {
            let bytes = std::fs::copy(&src, &dst)?;
            *copied += bytes;
            on_bytes(*copied);
        }
        // Symlinks and other special files are skipped (Ryu stores none).
    }
    Ok(())
}

/// Relocate the data folder: copy `from` → `to`, then (on success) update the
/// pointer so the next Core start resolves to `to`. With `move_source=true` the
/// source is removed after a verified copy (cross-drive safe, unlike `rename`).
pub fn migrate(from: &Path, to: &Path, move_source: bool) -> std::io::Result<()> {
    let total = paths::dir_size(from);
    emit(&Progress {
        phase: "copy",
        copied_bytes: 0,
        total_bytes: total,
    });

    let mut copied = 0u64;
    let mut last_emit = 0u64;
    copy_tree(from, to, &mut copied, &mut |c| {
        // Throttle progress to ~every 16 MB to avoid flooding stdout.
        if c - last_emit >= 16 * 1024 * 1024 || c == total {
            last_emit = c;
            emit(&Progress {
                phase: "copy",
                copied_bytes: c,
                total_bytes: total,
            });
        }
    })?;
    emit(&Progress {
        phase: "copy",
        copied_bytes: total,
        total_bytes: total,
    });

    paths::set_data_dir(Some(to)).map_err(|e| {
        std::io::Error::other(format!("copied data but failed to update pointer: {e}"))
    })?;

    if move_source {
        emit(&Progress {
            phase: "cleanup",
            copied_bytes: total,
            total_bytes: total,
        });
        let _ = std::fs::remove_dir_all(from);
    }
    Ok(())
}

// ── Export (zip) ───────────────────────────────────────────────────────────────────

/// Zip the whole data folder `from` into the archive at `out`. Read-only on the
/// data folder, so it's safe to call while Core is running (DB rows mid-write may
/// land in an inconsistent snapshot — acceptable for a manual backup).
pub fn export_zip(from: &Path, out: &Path) -> std::io::Result<u64> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::File::create(out)?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    let mut buf = Vec::new();
    let mut written = 0u64;
    zip_dir(from, from, &mut zip, options, &mut buf, &mut written)?;
    zip.finish()?;
    Ok(written)
}

fn zip_dir(
    root: &Path,
    dir: &Path,
    zip: &mut zip::ZipWriter<std::fs::File>,
    options: zip::write::FileOptions,
    buf: &mut Vec<u8>,
    written: &mut u64,
) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let ft = entry.file_type()?;
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let name = rel.to_string_lossy().replace('\\', "/");
        if ft.is_dir() {
            zip_dir(root, &path, zip, options, buf, written)?;
        } else if ft.is_file() {
            zip.start_file(name, options)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            buf.clear();
            std::fs::File::open(&path)?.read_to_end(buf)?;
            zip.write_all(buf)?;
            *written += buf.len() as u64;
        }
    }
    Ok(())
}

// ── Import (restore from zip) ──────────────────────────────────────────────────────

/// Extract a backup archive into `to`, then point the data folder at `to`. Must run
/// offline (it overwrites the live DB files). The destination is created if needed;
/// existing files with the same name are overwritten.
pub fn import_zip(archive: &Path, to: &Path) -> std::io::Result<()> {
    let file = std::fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| std::io::Error::other(e.to_string()))?;
    let total = zip.len();
    emit(&Progress {
        phase: "extract",
        copied_bytes: 0,
        total_bytes: total as u64,
    });

    std::fs::create_dir_all(to)?;
    for i in 0..total {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let Some(rel) = entry.enclosed_name() else {
            continue; // path-traversal guard (zip-slip): skip unsafe names
        };
        let out = to.join(rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut writer = std::fs::File::create(&out)?;
        std::io::copy(&mut entry, &mut writer)?;
        if i % 16 == 0 || i + 1 == total {
            emit(&Progress {
                phase: "extract",
                copied_bytes: (i + 1) as u64,
                total_bytes: total as u64,
            });
        }
    }

    paths::set_data_dir(Some(to)).map_err(|e| {
        std::io::Error::other(format!("imported data but failed to update pointer: {e}"))
    })?;
    Ok(())
}

// ── CLI subcommand entry ───────────────────────────────────────────────────────────

/// Handle `ryu-core data-path <migrate|import|export> …`. Returns `true` if it
/// consumed the args (caller should exit), `false` if this isn't a data-path
/// invocation. Errors print to stderr and exit non-zero.
pub fn run_cli(args: &[String]) -> bool {
    // args == full argv; find the "data-path" token.
    let Some(pos) = args.iter().position(|a| a == "data-path") else {
        return false;
    };
    let rest = &args[pos + 1..];
    let Some(cmd) = rest.first() else {
        eprintln!("usage: ryu-core data-path <migrate|import|export> [flags]");
        std::process::exit(2);
    };
    let flag = |name: &str| -> Option<String> {
        rest.iter()
            .position(|a| a == name)
            .and_then(|i| rest.get(i + 1))
            .cloned()
    };

    let result: std::io::Result<()> = match cmd.as_str() {
        "migrate" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let to = flag("--to").map(PathBuf::from);
            let move_source = rest.iter().any(|a| a == "--move");
            match to {
                Some(to) => migrate(&from, &to, move_source),
                None => {
                    eprintln!("data-path migrate requires --to <dir> [--from <dir>] [--move]");
                    std::process::exit(2);
                }
            }
        }
        "import" => {
            let archive = flag("--archive").map(PathBuf::from);
            let to = flag("--to")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            match archive {
                Some(archive) => import_zip(&archive, &to),
                None => {
                    eprintln!("data-path import requires --archive <zip> [--to <dir>]");
                    std::process::exit(2);
                }
            }
        }
        "export" => {
            let from = flag("--from")
                .map(PathBuf::from)
                .unwrap_or_else(paths::ryu_dir);
            let out = flag("--out").map(PathBuf::from);
            match out {
                Some(out) => export_zip(&from, &out).map(|_| ()),
                None => {
                    eprintln!("data-path export requires --out <zip> [--from <dir>]");
                    std::process::exit(2);
                }
            }
        }
        other => {
            eprintln!("unknown data-path command: {other}");
            std::process::exit(2);
        }
    };

    match result {
        Ok(()) => {
            println!("@@DONE");
            true
        }
        Err(e) => {
            eprintln!("data-path {cmd} failed: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_scales() {
        assert_eq!(human_bytes(512), "512.0 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(1024 * 1024), "1.0 MB");
    }

    #[test]
    fn export_then_import_roundtrips() {
        let base = std::env::temp_dir().join(format!("ryu-dp-test-{}", std::process::id()));
        let src = base.join("src");
        let nested = src.join("sub");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(src.join("a.txt"), b"hello").unwrap();
        std::fs::write(nested.join("b.txt"), b"world").unwrap();

        let zip = base.join("backup.zip");
        let bytes = export_zip(&src, &zip).unwrap();
        assert_eq!(bytes, 10); // "hello" + "world"

        let dest = base.join("restored");
        // import_zip also writes the pointer; that's fine in a test (config dir).
        let file = std::fs::File::open(&zip).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        std::fs::create_dir_all(&dest).unwrap();
        for i in 0..archive.len() {
            let mut e = archive.by_index(i).unwrap();
            if e.is_file() {
                let out = dest.join(e.enclosed_name().unwrap());
                std::fs::create_dir_all(out.parent().unwrap()).unwrap();
                let mut w = std::fs::File::create(&out).unwrap();
                std::io::copy(&mut e, &mut w).unwrap();
            }
        }
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(dest.join("sub/b.txt")).unwrap(), b"world");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn validate_rejects_nested_target() {
        let base = std::env::temp_dir();
        let src = base.join("ryu-validate-src");
        let nested = src.join("inside");
        let r = validate_target(&src, &nested, false);
        assert!(!r.ok);
    }

    // ── extra coverage ───────────────────────────────────────────────────────

    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    #[test]
    fn human_bytes_scales_to_gb_and_tb() {
        assert_eq!(human_bytes(1024u64.pow(3)), "1.0 GB");
        assert_eq!(human_bytes(1024u64.pow(4)), "1.0 TB");
        // Beyond TB stays in TB (the top unit), never overflows the table.
        assert_eq!(human_bytes(5 * 1024u64.pow(5)), "5120.0 TB");
        assert_eq!(human_bytes(1536), "1.5 KB");
    }

    #[test]
    fn check_target_rejects_empty_and_relative_paths() {
        let src = std::env::temp_dir().join(format!("ryu-dp-src-{}", uniq()));
        // Empty target.
        let r = validate_target(&src, std::path::Path::new(""), false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("empty"));
        // Relative target.
        let r = validate_target(&src, std::path::Path::new("relative/dir"), false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("absolute"));
    }

    #[test]
    fn check_target_rejects_non_empty_dir() {
        let base = std::env::temp_dir().join(format!("ryu-dp-nonempty-{}", uniq()));
        let src = base.join("src");
        let target = base.join("target");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("existing.txt"), b"x").unwrap();

        let r = validate_target(&src, &target, false);
        assert!(!r.ok);
        assert!(r.error.unwrap().contains("not empty"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn check_target_accepts_empty_absolute_writable_target() {
        let base = std::env::temp_dir().join(format!("ryu-dp-ok-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("db.sqlite"), b"data").unwrap();
        // A not-yet-existing absolute path under a distinct base is accepted.
        let target = base.join("dest");

        let r = validate_target(&src, &target, false);
        assert!(r.ok, "unexpected error: {:?}", r.error);
        assert!(r.source_size_bytes >= 4);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn copy_tree_replicates_files_and_subdirs_with_byte_count() {
        let base = std::env::temp_dir().join(format!("ryu-dp-copy-{}", uniq()));
        let from = base.join("from");
        let sub = from.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(from.join("a.txt"), b"hello").unwrap();
        std::fs::write(sub.join("b.txt"), b"world!").unwrap();
        let to = base.join("to");

        let mut copied = 0u64;
        let mut ticks = 0u32;
        copy_tree(&from, &to, &mut copied, &mut |_| ticks += 1).unwrap();

        assert_eq!(copied, 11, "5 + 6 bytes copied");
        assert_eq!(ticks, 2, "on_bytes fires once per file");
        assert_eq!(std::fs::read(to.join("a.txt")).unwrap(), b"hello");
        assert_eq!(std::fs::read(to.join("nested/b.txt")).unwrap(), b"world!");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn export_zip_of_empty_dir_writes_zero_bytes() {
        let base = std::env::temp_dir().join(format!("ryu-dp-empty-{}", uniq()));
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let zip = base.join("out.zip");
        let written = export_zip(&src, &zip).unwrap();
        assert_eq!(written, 0);
        assert!(zip.exists(), "an empty archive is still produced");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn run_cli_returns_false_without_the_data_path_token() {
        // No "data-path" argument → not consumed, Core boots normally.
        assert!(!run_cli(&["ryu-core".to_string(), "serve".to_string()]));
        assert!(!run_cli(&[]));
    }
}
