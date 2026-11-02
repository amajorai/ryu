//! Confinement of the binary sidecar install: `version` cannot steer the install
//! outside `<plugin_dir>/bin`, and symlinks a sandboxed sidecar plants in its own
//! install tree are never written through by Core.

use super::*;
use std::collections::BTreeMap;

fn bin_spec(version: &str, archive: Option<&str>) -> BinarySpec {
    BinarySpec {
        url: "https://example.invalid/dl/engine.tar.gz".to_owned(),
        sha256: Some("a".repeat(64)),
        version: version.to_owned(),
        archive: archive.map(str::to_owned),
        binary_name: archive.map(|_| "engine".to_owned()),
        args: vec![],
        env: BTreeMap::new(),
    }
}

fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    for (path, bytes) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, *bytes).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

#[test]
fn version_dir_rejects_versions_that_leave_the_bin_dir() {
    let plugin_dir = Path::new("/plugins/acme");
    for version in [
        "/tmp/x",
        "/home/u/.config/autostart",
        "../victim/bin/1",
        "..",
        ".",
        "a/b",
        "1.0/",
        "a\\b",
        "",
        " 1.0",
    ] {
        assert!(
            version_dir(plugin_dir, &bin_spec(version, None)).is_err(),
            "{version:?} must be rejected"
        );
    }
    assert_eq!(
        version_dir(plugin_dir, &bin_spec("1.2.3", None)).unwrap(),
        plugin_dir.join("bin").join("1.2.3")
    );
}

#[tokio::test]
async fn ensure_binary_refuses_an_absolute_version_before_writing_anything() {
    let plugin_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("autostart");
    let bin = bin_spec(target.to_str().unwrap(), None);
    let downloads = crate::downloads::DownloadCenter::with_default_client();

    let err = ensure_binary("com.example.evil", &bin, plugin_dir.path(), &downloads)
        .await
        .expect_err("an absolute version must be refused");
    assert!(
        err.to_string().contains("single plain path segment"),
        "got: {err}"
    );
    assert!(
        !target.exists(),
        "nothing may be created outside the plugin dir"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn ensure_binary_refuses_a_symlinked_version_dir() {
    let plugin_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir(plugin_dir.path().join("bin")).unwrap();
    std::os::unix::fs::symlink(outside.path(), plugin_dir.path().join("bin").join("1.0.0"))
        .unwrap();
    let downloads = crate::downloads::DownloadCenter::with_default_client();

    for archive in [None, Some("tar.gz")] {
        let bin = bin_spec("1.0.0", archive);
        let err = ensure_binary("com.example.evil", &bin, plugin_dir.path(), &downloads)
            .await
            .expect_err("a planted version-dir symlink must be refused");
        assert!(err.to_string().contains("symlink"), "got: {err}");
    }
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
}

#[cfg(unix)]
#[test]
fn download_dest_symlinks_are_removed_not_followed() {
    let plugin_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let victim = outside.path().join("victim");
    std::fs::write(&victim, b"original").unwrap();
    let dir = plugin_dir.path().join("bin").join("1.0.0");
    std::fs::create_dir_all(&dir).unwrap();
    let dest = dir.join("engine");
    std::os::unix::fs::symlink(&victim, &dest).unwrap();
    std::os::unix::fs::symlink(&victim, dir.join("engine.part")).unwrap();

    prepare_download_dest(plugin_dir.path(), &dest).unwrap();
    assert!(std::fs::symlink_metadata(&dest).is_err());
    assert!(std::fs::symlink_metadata(dir.join("engine.part")).is_err());
    assert_eq!(std::fs::read(&victim).unwrap(), b"original");
}

#[cfg(unix)]
#[test]
fn a_symlinked_executable_is_not_treated_as_installed() {
    let plugin_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = plugin_dir.path().join("bin").join("1.0.0").join("root");
    std::fs::create_dir_all(&root).unwrap();
    let victim = outside.path().join(".bashrc");
    std::fs::write(&victim, b"rc").unwrap();
    std::os::unix::fs::symlink(&victim, root.join("engine")).unwrap();
    assert!(!is_regular_install(plugin_dir.path(), &root.join("engine")));

    std::fs::remove_file(root.join("engine")).unwrap();
    std::fs::write(root.join("engine"), b"bin").unwrap();
    assert!(is_regular_install(plugin_dir.path(), &root.join("engine")));
}

#[cfg(unix)]
#[tokio::test]
async fn extract_archive_replaces_a_root_with_planted_symlinks() {
    let plugin_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let dir = plugin_dir.path().join("bin").join("1.0.0");
    let root = dir.join("root");
    std::fs::create_dir_all(&root).unwrap();
    // What a sandboxed sidecar could plant before deleting its own executable.
    std::os::unix::fs::symlink(outside.path(), root.join("x")).unwrap();
    let archive_path = dir.join("engine.tar.gz");
    std::fs::write(
        &archive_path,
        tar_gz(&[("engine", b"#!/bin/sh\n"), ("x/evil.desktop", b"pwn")]),
    )
    .unwrap();

    extract_archive("tar.gz", &archive_path, &dir)
        .await
        .unwrap();

    assert!(!outside.path().join("evil.desktop").exists());
    let x = std::fs::symlink_metadata(root.join("x")).unwrap();
    assert!(x.is_dir() && !x.file_type().is_symlink());
    assert_eq!(std::fs::read(root.join("x/evil.desktop")).unwrap(), b"pwn");
    assert!(is_regular_install(plugin_dir.path(), &root.join("engine")));
    assert!(!dir.join(".root-staging").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn extract_archive_refuses_a_symlinked_staging_dir() {
    let plugin_dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let dir = plugin_dir.path().join("bin").join("1.0.0");
    std::fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.join(".root-staging")).unwrap();
    let archive_path = dir.join("engine.tar.gz");
    std::fs::write(&archive_path, tar_gz(&[("engine", b"bin")])).unwrap();

    extract_archive("tar.gz", &archive_path, &dir)
        .await
        .unwrap();

    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    assert!(is_regular_install(
        plugin_dir.path(),
        &dir.join("root").join("engine")
    ));
}
