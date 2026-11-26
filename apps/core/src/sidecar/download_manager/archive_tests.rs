//! Tests for [`super`]; the in-memory archive builders are shared with
//! `archive_flatten_tests`.

use super::*;
use flate2::write::GzEncoder;
use flate2::Compression;
use std::io::Write;

// ── Archive builders (in-memory, hermetic) ──────────────────────────────

/// Append one file entry, writing the name field directly so the write-side
/// `..`/absolute-path rejection is bypassed — this reproduces a *malicious*
/// archive exactly as it would arrive over the wire, which is the input the
/// extractor's traversal guards must defend against.
pub(in crate::sidecar::download_manager) fn append_entry<W: Write>(
    builder: &mut tar::Builder<W>,
    name: &str,
    data: &[u8],
) {
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    // A name that ends in `/` becomes a directory record.
    if name.ends_with('/') {
        header.set_entry_type(tar::EntryType::Directory);
    }
    if let Some(gnu) = header.as_gnu_mut() {
        let bytes = name.as_bytes();
        let n = bytes.len().min(gnu.name.len());
        gnu.name[..n].copy_from_slice(&bytes[..n]);
    }
    header.set_cksum();
    builder.append(&header, data).expect("append tar entry");
}

/// Build a `.tar.gz` from `(path, bytes)` file entries.
pub(in crate::sidecar::download_manager) fn make_tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let gz = GzEncoder::new(Vec::new(), Compression::fast());
    let mut builder = tar::Builder::new(gz);
    for (name, data) in entries {
        append_entry(&mut builder, name, data);
    }
    let gz = builder.into_inner().expect("finish tar");
    gz.finish().expect("finish gz")
}

/// Build a `.tar.bz2` from `(path, bytes)` file entries.
pub(in crate::sidecar::download_manager) fn make_tar_bz2(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use bzip2::write::BzEncoder;
    use bzip2::Compression as BzCompression;
    let bz = BzEncoder::new(Vec::new(), BzCompression::fast());
    let mut builder = tar::Builder::new(bz);
    for (name, data) in entries {
        append_entry(&mut builder, name, data);
    }
    let bz = builder.into_inner().expect("finish tar");
    bz.finish().expect("finish bz2")
}

/// Build a `.zip`. `dir_entries` become directory records (name ends `/`),
/// `file_entries` become file records. Names are written verbatim so tests
/// can inject unsafe paths.
pub(in crate::sidecar::download_manager) fn make_zip(
    dir_entries: &[&str],
    file_entries: &[(&str, &[u8])],
) -> Vec<u8> {
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;
    let mut zw = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default();
    for name in dir_entries {
        // `start_file` with a trailing-slash name writes a directory-shaped
        // record while preserving the raw name (unlike `add_directory`,
        // which normalizes). This lets us inject absolute/`..` dir entries.
        zw.start_file(*name, opts).expect("start dir entry");
    }
    for (name, data) in file_entries {
        zw.start_file(*name, opts).expect("start file entry");
        zw.write_all(data).expect("write file bytes");
    }
    zw.finish().expect("finish zip").into_inner()
}

#[test]
fn archive_entry_paths_must_stay_inside_the_destination() {
    use std::path::Path;
    assert!(is_safe_archive_entry_path(Path::new("bin/llama-server")));
    assert!(is_safe_archive_entry_path(Path::new("./lib/libggml.so")));
    assert!(!is_safe_archive_entry_path(Path::new("../evil")));
    assert!(!is_safe_archive_entry_path(Path::new("/etc/passwd")));
    assert!(!is_safe_archive_entry_path(Path::new("lib/../../evil")));
    #[cfg(windows)]
    {
        assert!(!is_safe_archive_entry_path(Path::new("\\Windows\\Temp\\x")));
        assert!(!is_safe_archive_entry_path(Path::new("C:evil.dll")));
        assert!(!is_safe_archive_entry_path(Path::new("C:\\evil.dll")));
    }
}

// ── extract_from_tar_gz / extract_from_zip (single binary) ──────────────

#[test]
fn extract_from_tar_gz_finds_named_binary() {
    let data = make_tar_gz(&[("junk", b"x"), ("mybin", b"ELF-payload")]);
    let out = extract_from_tar_gz(&data, "mybin").unwrap();
    assert_eq!(out, b"ELF-payload");
}

#[test]
fn extract_from_tar_gz_missing_binary_errors() {
    let data = make_tar_gz(&[("other", b"x")]);
    let err = extract_from_tar_gz(&data, "mybin").unwrap_err();
    assert!(err.to_string().contains("mybin"));
}

#[test]
fn extract_from_zip_matches_exe_suffix() {
    // The zip extractor accepts either the bare name or `<name>.exe`.
    let data = make_zip(&[], &[("dir/mybin.exe", b"win-payload")]);
    let out = extract_from_zip(&data, "mybin").unwrap();
    assert_eq!(out, b"win-payload");
}

#[test]
fn extract_from_zip_missing_binary_errors() {
    let data = make_zip(&[], &[("readme.txt", b"hi")]);
    let err = extract_from_zip(&data, "mybin").unwrap_err();
    assert!(err.to_string().contains("mybin"));
}

// ── extract_tar_gz_to_dir ───────────────────────────────────────────────

#[test]
fn tar_gz_to_dir_preserves_structure() {
    let data = make_tar_gz(&[("a.txt", b"aaa"), ("sub/b.txt", b"bbb")]);
    let tmp = tempfile::tempdir().unwrap();
    let written = extract_tar_gz_to_dir(&data, tmp.path(), None).unwrap();
    assert_eq!(written.len(), 2);
    assert_eq!(std::fs::read(tmp.path().join("a.txt")).unwrap(), b"aaa");
    assert_eq!(
        std::fs::read(tmp.path().join("sub").join("b.txt")).unwrap(),
        b"bbb"
    );
}

#[test]
fn tar_gz_to_dir_rejects_parent_traversal() {
    let data = make_tar_gz(&[("../evil.txt", b"pwn"), ("safe.txt", b"ok")]);
    let tmp = tempfile::tempdir().unwrap();
    let written = extract_tar_gz_to_dir(&data, tmp.path(), None).unwrap();
    // The `..` entry is skipped; only the safe file lands.
    assert_eq!(written, vec!["safe.txt".to_string()]);
    // Nothing escaped into the tempdir's parent.
    let escaped = tmp.path().parent().unwrap().join("evil.txt");
    assert!(!escaped.exists(), "traversal entry escaped the sandbox");
}

#[test]
fn tar_gz_to_dir_enforces_decompression_cap() {
    // Two 100-byte files with a 150-byte cap → the second trips the guard.
    let data = make_tar_gz(&[("a.bin", &[0u8; 100]), ("b.bin", &[0u8; 100])]);
    let tmp = tempfile::tempdir().unwrap();
    let err = extract_tar_gz_to_dir(&data, tmp.path(), Some(150)).unwrap_err();
    assert!(err.to_string().contains("cap"));
}

// ── extract_tar_bz2_to_dir ──────────────────────────────────────────────

#[test]
fn tar_bz2_to_dir_extracts_and_guards() {
    let data = make_tar_bz2(&[("f.txt", b"payload"), ("../nope.txt", b"pwn")]);
    let tmp = tempfile::tempdir().unwrap();
    let written = extract_tar_bz2_to_dir(&data, tmp.path(), None).unwrap();
    assert_eq!(written, vec!["f.txt".to_string()]);
    assert_eq!(std::fs::read(tmp.path().join("f.txt")).unwrap(), b"payload");
}

#[test]
fn tar_bz2_to_dir_enforces_cap() {
    let data = make_tar_bz2(&[("big.bin", &[7u8; 400])]);
    let tmp = tempfile::tempdir().unwrap();
    let err = extract_tar_bz2_to_dir(&data, tmp.path(), Some(100)).unwrap_err();
    assert!(err.to_string().contains("cap"));
}

// ── extract_zip_to_dir ──────────────────────────────────────────────────

#[test]
fn zip_to_dir_extracts_files_and_dirs() {
    let data = make_zip(&["sub/"], &[("sub/x.txt", b"hello"), ("root.txt", b"r")]);
    let tmp = tempfile::tempdir().unwrap();
    let written = extract_zip_to_dir(&data, tmp.path(), None).unwrap();
    assert!(written.iter().any(|w| w == "sub/x.txt"));
    assert_eq!(
        std::fs::read(tmp.path().join("sub").join("x.txt")).unwrap(),
        b"hello"
    );
}

#[test]
fn zip_to_dir_rejects_parent_traversal_file() {
    let data = make_zip(&[], &[("../evil.txt", b"pwn"), ("ok.txt", b"ok")]);
    let tmp = tempfile::tempdir().unwrap();
    let written = extract_zip_to_dir(&data, tmp.path(), None).unwrap();
    assert_eq!(written, vec!["ok.txt".to_string()]);
    assert!(!tmp.path().parent().unwrap().join("evil.txt").exists());
}

#[test]
fn zip_to_dir_enforces_cap() {
    let data = make_zip(&[], &[("a", &[0u8; 100]), ("b", &[0u8; 100])]);
    let tmp = tempfile::tempdir().unwrap();
    let err = extract_zip_to_dir(&data, tmp.path(), Some(150)).unwrap_err();
    assert!(err.to_string().contains("cap"));
}

/// Regression for the zip directory-entry sandbox escape: an **absolute**
/// directory record (`/…/escape/`) must be rejected, not `create_dir_all`'d
/// outside `dest_dir`. `PathBuf::join` replaces the base on an absolute
/// component, so without an `is_absolute()` guard the dir is created outside
/// the sandbox. The file branch already guarded this; the dir branch did not.
#[cfg(unix)]
#[test]
fn zip_to_dir_rejects_absolute_directory_entry() {
    let escape_root = tempfile::tempdir().unwrap();
    let escape_dir = escape_root.path().join("escape");
    // A trailing-slash absolute name → treated as a directory entry.
    let entry = format!("{}/", escape_dir.display());
    let data = make_zip(&[&entry], &[("safe.txt", b"ok")]);

    let dest = tempfile::tempdir().unwrap();
    let written = extract_zip_to_dir(&data, dest.path(), None).unwrap();

    assert!(
        !escape_dir.exists(),
        "absolute zip directory entry escaped the sandbox and was created at {}",
        escape_dir.display()
    );
    assert!(written.iter().any(|w| w == "safe.txt"));
}

#[test]
fn default_extract_cap_is_500mb() {
    assert_eq!(DEFAULT_EXTRACT_CAP_BYTES, 500 * 1024 * 1024);
}

// ── A later component that holds `:` (`repo/C:x`) ───────────────────────
//
// On Windows `dest/repo` joined with `C:x` is `C:x`, a path outside `dest`.
// These tests use a drive letter that is NOT in use on this PC, so code that
// fails to refuse the name can create nothing outside `dest`. Real drive
// letters run only in the child process of the last test. Elsewhere `Q:x`
// is a plain name that such code creates inside `dest`.

/// A drive letter with no volume. Panics, never skips, if none is free.
pub(in crate::sidecar::download_manager) fn unused_drive_letter() -> char {
    if !cfg!(windows) {
        return 'Q';
    }
    ('G'..='Z')
        .rev()
        .find(|letter| !std::path::Path::new(&format!("{letter}:\\")).exists())
        .expect("no free drive letter from Z down to G")
}

/// The four entry shapes: a file, a directory, a file below it, a climb.
fn drive_shapes(l: char) -> [String; 4] {
    [
        format!("repo/{l}:x"),
        format!("repo/{l}:dir/"),
        format!("repo/{l}:dir/file"),
        format!("repo/{l}:../x"),
    ]
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    TarGz,
    TarBz2,
    Zip,
}

fn entry_body(name: &str) -> &'static [u8] {
    if name.ends_with('/') {
        b""
    } else {
        b"tcw1"
    }
}

/// Pack `names` (one that ends in `/` is a directory entry, a file holds
/// `tcw1`) into an archive of `kind` and extract it into `dest`.
fn extract_names(
    kind: Kind,
    names: &[&str],
    dest: &std::path::Path,
) -> anyhow::Result<Vec<String>> {
    let all: Vec<(&str, &[u8])> = names.iter().map(|name| (*name, entry_body(name))).collect();
    match kind {
        Kind::TarGz => extract_tar_gz_to_dir(&make_tar_gz(&all), dest, None),
        Kind::TarBz2 => extract_tar_bz2_to_dir(&make_tar_bz2(&all), dest, None),
        Kind::Zip => {
            let (dirs, files): (Vec<_>, Vec<_>) = all
                .iter()
                .copied()
                .partition(|(name, _)| name.ends_with('/'));
            let dirs: Vec<&str> = dirs.iter().map(|(name, _)| *name).collect();
            extract_zip_to_dir(&make_zip(&dirs, &files), dest, None)
        }
    }
}

/// One refused case: the entry is skipped, is not reported as written, and
/// nothing of it is created, not even its leading `repo` directory.
fn assert_refused(kind: Kind, shape: usize) {
    let name = drive_shapes(unused_drive_letter())[shape].clone();
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("dest");
    let result = extract_names(kind, &[name.as_str()], &dest);
    println!("TCW1 {kind:?} {name}: {result:?}");
    let written = result.expect("a refused entry is skipped, it is not an error");
    assert!(written.is_empty(), "{name} was reported: {written:?}");
    let left: Vec<_> = std::fs::read_dir(&dest)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "{name} left {left:?} in the destination");
}

macro_rules! refused_cases {
    ($($test:ident => $kind:ident, $shape:expr;)*) => {$(
        #[test]
        fn $test() {
            assert_refused(Kind::$kind, $shape);
        }
    )*};
}

refused_cases! {
    tar_gz_refuses_a_drive_file_entry => TarGz, 0;
    tar_gz_refuses_a_drive_directory_entry => TarGz, 1;
    tar_gz_refuses_a_file_below_a_drive_directory => TarGz, 2;
    tar_gz_refuses_a_drive_entry_that_climbs => TarGz, 3;
    tar_bz2_refuses_a_drive_file_entry => TarBz2, 0;
    tar_bz2_refuses_a_drive_directory_entry => TarBz2, 1;
    tar_bz2_refuses_a_file_below_a_drive_directory => TarBz2, 2;
    tar_bz2_refuses_a_drive_entry_that_climbs => TarBz2, 3;
    zip_refuses_a_drive_file_entry => Zip, 0;
    zip_refuses_a_drive_directory_entry => Zip, 1;
    zip_refuses_a_file_below_a_drive_directory => Zip, 2;
    zip_refuses_a_drive_entry_that_climbs => Zip, 3;
}

#[test]
fn a_refused_entry_does_not_stop_the_good_ones() {
    let bad = format!("repo/{}:x", unused_drive_letter());
    for kind in [Kind::TarGz, Kind::TarBz2, Kind::Zip] {
        let tmp = tempfile::tempdir().unwrap();
        let result = extract_names(kind, &["repo/ok.txt", bad.as_str()], tmp.path());
        println!("TCW1 {kind:?} mixed: {result:?}");
        assert_eq!(result.unwrap(), vec!["repo/ok.txt".to_string()], "{kind:?}");
        let kept = std::fs::read_dir(tmp.path().join("repo")).unwrap();
        assert_eq!(kept.count(), 1);
    }
}

/// Guard, green before and after the fix: an ordinary nested archive and an
/// entry that starts with `./` extract as they always did.
#[test]
fn ordinary_nested_and_dot_slash_entries_still_extract() {
    for kind in [Kind::TarGz, Kind::TarBz2, Kind::Zip] {
        let tmp = tempfile::tempdir().unwrap();
        let names = ["repo/sub/", "repo/a/b.txt", "repo/sub/c.txt", "./a/b"];
        let written = extract_names(kind, &names, tmp.path()).unwrap();
        assert_eq!(written.len(), 3, "{kind:?}: {written:?}");
        for file in ["repo/a/b.txt", "repo/sub/c.txt", "a/b"] {
            let bytes = std::fs::read(tmp.path().join(file)).unwrap();
            assert_eq!(bytes, b"tcw1", "{kind:?} {file}");
        }
    }
}

// The same shapes with the letter of the temp folder's own drive, in a child
// process whose current folder is `<temp>/jail/cwd`. Such a path resolves
// against that folder, so code that fails to refuse it writes into
// `<temp>/jail` (`L:../x` climbs one level), never outside `<temp>`.

const JAIL_ROOT: &str = "RYU_TCW1_JAIL_ROOT";
const JAIL_LETTER: &str = "RYU_TCW1_JAIL_LETTER";

/// The child. It does nothing unless the parent test below started it.
#[test]
#[ignore = "started only by drive_relative_entries_stay_out_of_the_current_folder"]
fn tcw1_child_extracts_in_its_jail() {
    use crate::sidecar::bundle_install::{install_bundle, sha256_file};
    let (Some(root), Ok(letter)) = (std::env::var_os(JAIL_ROOT), std::env::var(JAIL_LETTER)) else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let shapes = drive_shapes(letter.chars().next().expect("a drive letter"));
    for (index, name) in shapes.iter().enumerate() {
        for kind in [Kind::TarGz, Kind::TarBz2, Kind::Zip] {
            let dest = root.join("dest").join(format!("{kind:?}-{index}"));
            let result = extract_names(kind, &[name.as_str()], &dest);
            println!("TCW1-JAIL {kind:?} {name}: {result:?}");
        }
        let archive = root.join("in").join(format!("bundle-{index}.tar.gz"));
        let bundle = make_tar_gz(&[(name.as_str(), entry_body(name))]);
        std::fs::write(&archive, bundle).unwrap();
        let sha = sha256_file(&archive).unwrap();
        let dest = root.join("dest").join(format!("Bundle-{index}"));
        let result = install_bundle(&archive, &sha, &dest, "run", "1");
        println!("TCW1-JAIL bundle {name}: {result:?}");
    }
}

/// The drive letter of `root` itself. Panics, never skips, if it has none.
fn drive_letter_of(root: &std::path::Path) -> char {
    use std::path::{Component, Prefix};
    match root.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter as char,
            other => panic!("the temp folder has no drive letter: {other:?}"),
        },
        _ if cfg!(windows) => panic!("the temp folder {root:?} has no drive letter"),
        _ => 'C',
    }
}

fn list_below(root: &std::path::Path, dir: &std::path::Path, found: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        let rel = path.strip_prefix(root).unwrap().to_string_lossy();
        found.push(rel.replace('\\', "/"));
        if path.is_dir() {
            list_below(root, &path, found);
        }
    }
}

#[test]
fn drive_relative_entries_stay_out_of_the_current_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let letter = drive_letter_of(root);
    let cwd = root.join("jail").join("cwd");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(root.join("in")).unwrap();
    let module = module_path!().split_once("::").expect("a module path").1;
    let child = format!("{module}::tcw1_child_extracts_in_its_jail");
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([child.as_str(), "--exact", "--ignored", "--nocapture"])
        .env(JAIL_ROOT, root)
        .env(JAIL_LETTER, letter.to_string())
        .current_dir(&cwd)
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut found = Vec::new();
    list_below(root, root, &mut found);
    found.sort();
    println!(
        "TCW1-JAIL letter {letter}, tree after the child:\n{}\n{stdout}",
        found.join("\n")
    );
    assert!(
        output.status.success() && stdout.matches("TCW1-JAIL bundle").count() == 4,
        "the child did not run to its end: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Allowed: the folders made above, the bundle archives, one EMPTY
    // destination per extractor run. Anything else is a stray entry.
    let allowed = |path: &str| {
        let extractor_dest = path
            .strip_prefix("dest/")
            .is_some_and(|rest| !rest.contains('/') && !rest.contains("undle"));
        ["jail", "jail/cwd", "in", "dest"].contains(&path)
            || path.starts_with("in/bundle-")
            || extractor_dest
    };
    let stray: Vec<_> = found
        .iter()
        .filter(|path| !allowed(path.as_str()))
        .collect();
    assert!(
        stray.is_empty(),
        "entries landed where they must not: {stray:?}"
    );
}
