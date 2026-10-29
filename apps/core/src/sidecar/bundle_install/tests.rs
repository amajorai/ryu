use super::*;

/// Build a tar.gz from raw headers so tests can express entries a well-behaved
/// `tar` would never emit (traversal paths, escaping links).
struct TarBuilder {
    builder: tar::Builder<flate2::write::GzEncoder<Vec<u8>>>,
}

impl TarBuilder {
    fn new() -> Self {
        Self {
            builder: tar::Builder::new(flate2::write::GzEncoder::new(
                Vec::new(),
                flate2::Compression::fast(),
            )),
        }
    }

    fn header(path: &str, kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
        let mut header = tar::Header::new_gnu();
        // Write the name bytes directly: `set_path` itself refuses `..`, which is
        // exactly the hostile input these tests need to produce.
        let name = &mut header.as_old_mut().name;
        name[..path.len()].copy_from_slice(path.as_bytes());
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_size(size);
        header
    }

    fn file(mut self, path: &str, mode: u32, body: &[u8]) -> Self {
        let mut header = Self::header(path, tar::EntryType::Regular, mode, body.len() as u64);
        header.set_cksum();
        self.builder.append(&header, body).unwrap();
        self
    }

    fn dir(mut self, path: &str) -> Self {
        let mut header = Self::header(path, tar::EntryType::Directory, 0o755, 0);
        header.set_cksum();
        self.builder.append(&header, io::empty()).unwrap();
        self
    }

    fn symlink(mut self, path: &str, target: &str) -> Self {
        let mut header = Self::header(path, tar::EntryType::Symlink, 0o777, 0);
        let link = &mut header.as_old_mut().linkname;
        link[..target.len()].copy_from_slice(target.as_bytes());
        header.set_cksum();
        self.builder.append(&header, io::empty()).unwrap();
        self
    }

    fn write(self, path: &Path) -> String {
        let bytes = self.builder.into_inner().unwrap().finish().unwrap();
        fs::write(path, &bytes).unwrap();
        sha256_file(path).unwrap()
    }
}

fn app_archive() -> TarBuilder {
    let archive = TarBuilder::new()
        .dir("Demo.app/")
        .dir("Demo.app/Contents/")
        .dir("Demo.app/Contents/MacOS/")
        .file(
            "Demo.app/Contents/MacOS/Demo",
            0o755,
            b"#!/bin/sh\necho bundle-ok\n",
        )
        .dir("Demo.app/Contents/Frameworks/Lib.framework/Versions/A/")
        .file(
            "Demo.app/Contents/Frameworks/Lib.framework/Versions/A/Lib",
            0o644,
            b"lib",
        );
    with_framework_links(archive)
}

/// The macOS framework symlinks. Archive symlinks are a Unix-only contract
/// (`create_symlink` refuses them elsewhere), so the shared fixture carries
/// them only where they can be installed; `windows_refuses_archive_symlinks`
/// pins the refusal.
#[cfg(unix)]
fn with_framework_links(archive: TarBuilder) -> TarBuilder {
    archive
        .symlink(
            "Demo.app/Contents/Frameworks/Lib.framework/Versions/Current",
            "A",
        )
        .symlink(
            "Demo.app/Contents/Frameworks/Lib.framework/Lib",
            "Versions/Current/Lib",
        )
}

#[cfg(not(unix))]
fn with_framework_links(archive: TarBuilder) -> TarBuilder {
    archive
}

const ENTRY: &str = "Demo.app/Contents/MacOS/Demo";

#[test]
fn valid_bundle_installs_atomically_and_its_entrypoint_runs() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("demo.tar.gz");
    let sha = app_archive().write(&archive);
    let dest = tmp.path().join("bin").join("demo.d");

    let exe = install_bundle(&archive, &sha, &dest, ENTRY, "1.2.3").unwrap();
    assert_eq!(exe, dest.join(ENTRY));
    assert_eq!(
        installed_entrypoint(&dest, ENTRY, "1.2.3"),
        Some(exe.clone())
    );
    assert_eq!(
        installed_entrypoint(&dest, ENTRY, "9.9.9"),
        None,
        "stale marker"
    );

    // Framework symlinks survive as symlinks and resolve to the real file.
    #[cfg(unix)]
    {
        let link = dest.join("Demo.app/Contents/Frameworks/Lib.framework/Lib");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(&link).unwrap(), b"lib");
    }

    // No staging or old dirs left beside the install.
    let leftovers: Vec<_> = fs::read_dir(dest.parent().unwrap())
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with('.'))
        .collect();
    assert!(leftovers.is_empty(), "leftover staging dirs: {leftovers:?}");

    // Exec bits preserved: the entrypoint actually spawns.
    #[cfg(unix)]
    {
        let out = std::process::Command::new(&exe).output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "bundle-ok");
    }

    // Re-install (e.g. a version bump) replaces the tree in place.
    let exe2 = install_bundle(&archive, &sha, &dest, ENTRY, "1.2.4").unwrap();
    assert_eq!(installed_entrypoint(&dest, ENTRY, "1.2.4"), Some(exe2));
}

#[test]
fn traversal_entry_is_rejected_and_nothing_is_installed() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("evil.tar.gz");
    let sha = app_archive()
        .file("../escaped", 0o644, b"pwned")
        .write(&archive);
    let dest = tmp.path().join("bin").join("demo.d");

    let err = install_bundle(&archive, &sha, &dest, ENTRY, "1").unwrap_err();
    assert!(
        err.to_string().contains("unsafe archive entry path"),
        "{err}"
    );
    assert!(!tmp.path().join("bin").join("escaped").exists());
    assert!(!tmp.path().join("escaped").exists());
    assert!(!dest.exists(), "a refused archive must not install");
    assert_eq!(fs::read_dir(tmp.path().join("bin")).unwrap().count(), 0);
}

#[test]
fn symlink_escape_is_rejected() {
    let tmp = tempfile::tempdir().unwrap();
    let dest = tmp.path().join("bin").join("demo.d");

    // A link pointing out of the root.
    let archive = tmp.path().join("escape.tar.gz");
    let sha = app_archive()
        .symlink("Demo.app/out", "../../..")
        .write(&archive);
    let err = install_bundle(&archive, &sha, &dest, ENTRY, "1").unwrap_err();
    assert!(err.to_string().contains("escapes the bundle root"), "{err}");
    assert!(!dest.exists());

    // An absolute link.
    let archive = tmp.path().join("abs.tar.gz");
    let sha = app_archive()
        .symlink("Demo.app/etc", "/etc")
        .write(&archive);
    assert!(install_bundle(&archive, &sha, &dest, ENTRY, "1").is_err());

    // A link that is itself inside, followed by an entry written through it.
    let archive = tmp.path().join("through.tar.gz");
    let sha = app_archive()
        .symlink("Demo.app/hop", "Contents")
        .file("Demo.app/hop/planted", 0o644, b"x")
        .write(&archive);
    let err = install_bundle(&archive, &sha, &dest, ENTRY, "1").unwrap_err();
    // Without archive symlinks (not Unix) the link itself is the refusal.
    let refusal = if cfg!(unix) {
        "through a symlink"
    } else {
        "is not supported on this platform"
    };
    assert!(err.to_string().contains(refusal), "{err}");
    assert!(!dest.exists());

    // A chain whose lexical reading stays inside but whose real target escapes:
    // `a/up -> ..` is the root, so `x -> a/up/..` is the root's parent.
    let archive = tmp.path().join("chain.tar.gz");
    let sha = app_archive()
        .dir("a/")
        .symlink("a/up", "..")
        .symlink("x", "a/up/..")
        .write(&archive);
    assert!(install_bundle(&archive, &sha, &dest, ENTRY, "1").is_err());
    assert!(!dest.exists());
}

#[test]
fn checksum_mismatch_is_rejected_before_extraction() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("demo.tar.gz");
    app_archive().write(&archive);
    let dest = tmp.path().join("bin").join("demo.d");
    let err = install_bundle(&archive, &"0".repeat(64), &dest, ENTRY, "1").unwrap_err();
    assert!(err.to_string().contains("checksum mismatch"), "{err}");
    assert!(!dest.exists());
}

#[test]
fn missing_entrypoint_is_an_error_and_keeps_the_previous_install() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("demo.tar.gz");
    let sha = app_archive().write(&archive);
    let dest = tmp.path().join("bin").join("demo.d");
    install_bundle(&archive, &sha, &dest, ENTRY, "1").unwrap();

    let err =
        install_bundle(&archive, &sha, &dest, "Demo.app/Contents/MacOS/Nope", "2").unwrap_err();
    assert!(err.to_string().contains("declared entrypoint"), "{err}");
    // The failed upgrade left the working install untouched.
    assert!(installed_entrypoint(&dest, ENTRY, "1").is_some());
}

/// Where archive symlinks are unsupported, a bundle that carries one, even one
/// that stays inside the root, is refused and nothing is installed.
#[cfg(not(unix))]
#[test]
fn windows_refuses_archive_symlinks() {
    let tmp = tempfile::tempdir().unwrap();
    let archive = tmp.path().join("linked.tar.gz");
    let sha = app_archive()
        .symlink(
            "Demo.app/Contents/Frameworks/Lib.framework/Versions/Current",
            "A",
        )
        .write(&archive);
    let dest = tmp.path().join("bin").join("demo.d");
    let err = install_bundle(&archive, &sha, &dest, ENTRY, "1").unwrap_err();
    assert!(
        err.to_string()
            .contains("is not supported on this platform"),
        "{err}"
    );
    assert!(!dest.exists(), "a refused archive must not install");
    assert_eq!(fs::read_dir(tmp.path().join("bin")).unwrap().count(), 0);
}
