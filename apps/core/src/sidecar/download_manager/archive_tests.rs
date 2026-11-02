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
