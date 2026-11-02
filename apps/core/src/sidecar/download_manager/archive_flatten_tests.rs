//! Tests for [`super`].

use super::super::archive::tests::{make_tar_gz, make_zip};
use super::*;
use flate2::write::GzEncoder;
use flate2::Compression;

// ── extract_all_to_dir (flatten) ────────────────────────────────────────

#[test]
fn extract_all_flattens_and_skips_dirs() {
    let data = make_zip(
        &["Release/"],
        &[
            ("Release/whisper-server.exe", b"bin"),
            ("Release/ggml.dll", b"lib"),
        ],
    );
    let tmp = tempfile::tempdir().unwrap();
    let mut written = extract_all_to_dir(&data, tmp.path()).unwrap();
    written.sort();
    assert_eq!(written, vec!["ggml.dll", "whisper-server.exe"]);
    // Flattened: the `Release/` prefix is gone.
    assert!(tmp.path().join("whisper-server.exe").exists());
    assert!(!tmp.path().join("Release").exists());
}

// ── extract_binary_with_libs (tar.gz path) ──────────────────────────────

#[test]
fn binary_with_libs_colocates_shared_libs() {
    let data = make_tar_gz(&[
        ("build/bin/llama-server", b"server"),
        ("build/bin/libggml.dylib", b"lib1"),
        ("build/bin/libllama.so", b"lib2"),
        ("build/bin/other-tool", b"ignored"),
    ]);
    let tmp = tempfile::tempdir().unwrap();
    let bin = extract_binary_with_libs(&data, "llama-server", tmp.path(), false).unwrap();
    assert_eq!(bin, tmp.path().join("llama-server"));
    assert!(tmp.path().join("libggml.dylib").exists());
    assert!(tmp.path().join("libllama.so").exists());
    // Non-lib sibling tools are not co-located.
    assert!(!tmp.path().join("other-tool").exists());
}

#[test]
fn binary_with_libs_missing_binary_errors() {
    let data = make_tar_gz(&[("build/libggml.dylib", b"lib")]);
    let tmp = tempfile::tempdir().unwrap();
    let err = extract_binary_with_libs(&data, "llama-server", tmp.path(), false).unwrap_err();
    assert!(err.to_string().contains("llama-server"));
}

#[test]
fn binary_with_libs_zip_path() {
    let data = make_zip(
        &[],
        &[
            ("bin/llama-server.exe", b"server"),
            ("bin/ggml.dll", b"lib"),
        ],
    );
    let tmp = tempfile::tempdir().unwrap();
    let bin = extract_binary_with_libs(&data, "llama-server", tmp.path(), true).unwrap();
    assert_eq!(bin, tmp.path().join("llama-server.exe"));
    assert!(tmp.path().join("ggml.dll").exists());
}

/// A symlink alias entry (`libfoo.dylib` -> `libfoo.1.dylib`) must be
/// recreated as a link, not written as a 0-byte file that shadows the real
/// versioned lib and breaks `@rpath` resolution at launch.
#[cfg(unix)]
#[test]
fn binary_with_libs_recreates_symlink_alias() {
    // Build a tar with the real versioned lib, a symlink alias, and the bin.
    let gz = GzEncoder::new(Vec::new(), Compression::fast());
    let mut builder = tar::Builder::new(gz);

    let bin = b"server";
    let mut h = tar::Header::new_gnu();
    h.set_size(bin.len() as u64);
    h.set_mode(0o755);
    h.set_cksum();
    builder
        .append_data(&mut h, "bin/llama-server", &bin[..])
        .unwrap();

    let lib = b"real-lib-bytes";
    let mut h = tar::Header::new_gnu();
    h.set_size(lib.len() as u64);
    h.set_mode(0o644);
    h.set_cksum();
    builder
        .append_data(&mut h, "bin/libggml.1.dylib", &lib[..])
        .unwrap();

    // Symlink entry: libggml.dylib -> libggml.1.dylib (no data body).
    let mut h = tar::Header::new_gnu();
    h.set_entry_type(tar::EntryType::Symlink);
    h.set_size(0);
    h.set_link_name("libggml.1.dylib").unwrap();
    h.set_mode(0o777);
    h.set_cksum();
    builder
        .append_link(&mut h, "bin/libggml.dylib", "libggml.1.dylib")
        .unwrap();

    let data = builder.into_inner().unwrap().finish().unwrap();

    let tmp = tempfile::tempdir().unwrap();
    extract_binary_with_libs(&data, "llama-server", tmp.path(), false).unwrap();

    let alias = tmp.path().join("libggml.dylib");
    let meta = std::fs::symlink_metadata(&alias).unwrap();
    assert!(
        meta.file_type().is_symlink(),
        "alias must be a symlink, not a clobbered 0-byte file"
    );
    // The real versioned lib is present and non-empty.
    assert_eq!(
        std::fs::read(tmp.path().join("libggml.1.dylib")).unwrap(),
        lib
    );
}

// ── Pure helpers ────────────────────────────────────────────────────────

#[test]
fn archive_basename_handles_both_separators() {
    assert_eq!(archive_basename("a/b/c.txt"), "c.txt");
    assert_eq!(archive_basename("a\\b\\c.txt"), "c.txt");
    assert_eq!(archive_basename("bare"), "bare");
}

#[test]
fn is_wanted_binary_matches_bare_and_exe() {
    assert!(is_wanted_binary("llama-server", "llama-server"));
    assert!(is_wanted_binary("llama-server.exe", "llama-server"));
    assert!(!is_wanted_binary("llama-serverX", "llama-server"));
    assert!(!is_wanted_binary("libllama.so", "llama-server"));
}

#[test]
fn is_shared_library_recognizes_all_forms() {
    assert!(is_shared_library("libfoo.dylib"));
    assert!(is_shared_library("foo.DLL")); // case-insensitive
    assert!(is_shared_library("libbar.so"));
    assert!(is_shared_library("libbar.so.3")); // versioned soname
    assert!(!is_shared_library("llama-server"));
    assert!(!is_shared_library("notes.txt"));
}

#[test]
fn write_flattened_writes_via_temp_rename() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = write_flattened(tmp.path(), "out.bin", b"data").unwrap();
    assert_eq!(dest, tmp.path().join("out.bin"));
    assert_eq!(std::fs::read(&dest).unwrap(), b"data");
    // The temp sidecar file is cleaned up by the atomic rename.
    assert!(!tmp.path().join("out.download-tmp").exists());
}

#[cfg(unix)]
#[test]
fn write_symlink_flattened_creates_link_to_basename() {
    let tmp = tempfile::tempdir().unwrap();
    // Target given with a path prefix — must be flattened to a bare basename.
    let dest = write_symlink_flattened(tmp.path(), "libfoo.dylib", "sub/libfoo.1.dylib").unwrap();
    let meta = std::fs::symlink_metadata(&dest).unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(
        std::fs::read_link(&dest).unwrap(),
        std::path::PathBuf::from("libfoo.1.dylib")
    );
}

#[cfg(unix)]
#[test]
fn write_symlink_flattened_replaces_stale_entry() {
    let tmp = tempfile::tempdir().unwrap();
    // A pre-existing broken 0-byte file at the alias name.
    std::fs::write(tmp.path().join("libfoo.dylib"), b"").unwrap();
    let dest = write_symlink_flattened(tmp.path(), "libfoo.dylib", "libfoo.1.dylib").unwrap();
    assert!(std::fs::symlink_metadata(&dest)
        .unwrap()
        .file_type()
        .is_symlink());
}
