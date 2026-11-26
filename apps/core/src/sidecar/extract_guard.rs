//! No-follow writes for archive extraction.
//!
//! The archive extractors in [`super::download_manager`] write into directories
//! that a sandboxed sidecar may also be able to write (a plugin's own install
//! tree). `create_dir_all` and `fs::write` follow symlinks, so a link planted
//! there (`root/x -> ~/.config/autostart`) would let an archive entry `x/f`
//! land outside the extraction directory, written by the unsandboxed Core.
//! These helpers create every directory below `dest_dir` one component at a
//! time, refuse to traverse a symlink, and never write through a symlink at the
//! leaf.
//!
//! This file also holds the one rule for a name that comes out of an archive
//! ([`check_entry_component`]) and the only way the extractors build a path
//! from such a name ([`append_confined`], [`join_confined`]). On Windows a
//! later component such as `C:x` is a plain name to `Path::components`, yet
//! `push` and `join` treat it as a drive-relative path and drop the base, so
//! `dest/repo` plus `C:x` is `C:x`: a file outside the extraction directory.

use anyhow::{bail, Context};
use std::ffi::OsStr;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

pub(crate) mod names;

/// Windows device names. They are reserved with or without an extension.
const WINDOWS_DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Why `name` may not be one component of an extraction path, or `None` for a
/// plain name. Pure: `windows` picks the rule set, so every OS tests both.
///
/// - `:` anywhere is refused on every OS, so a package behaves the same
///   everywhere. On Windows it makes a drive form (`C:x`) or a stream (`f:s`).
/// - On Windows only: a name that ends in `.` or a space (Windows cuts those
///   off, so two entries become one file) and a device name (`NUL`, `COM1`).
///   Elsewhere these are ordinary names, and skills that hold them install.
pub(crate) fn entry_component_refusal(name: &OsStr, windows: bool) -> Option<&'static str> {
    let bytes = name.as_encoded_bytes();
    if bytes.contains(&b':') {
        return Some("holds ':'");
    }
    if !windows {
        return None;
    }
    if matches!(bytes.last(), Some(b'.' | b' ')) {
        return Some("ends in a dot or a space");
    }
    let stem = bytes.split(|byte| *byte == b'.').next().unwrap_or(bytes);
    let stem = stem.trim_ascii_end();
    WINDOWS_DEVICE_NAMES
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device.as_bytes()))
        .then_some("is a Windows device name")
}

/// The shared rule for one path component that comes from an archive entry, a
/// link target inside an archive, or a bundle entrypoint.
pub(crate) fn check_entry_component(name: &OsStr) -> anyhow::Result<()> {
    match entry_component_refusal(name, cfg!(windows)) {
        Some(why) => bail!(
            "archive entry name '{}' is refused: it {why}",
            name.to_string_lossy()
        ),
        None => Ok(()),
    }
}

/// True when `out` is exactly `base` plus the one component `name`. This is the
/// backstop behind the rule: it does not ask what kind of path `name` turned
/// into. Whatever makes `push` or `join` replace or rewrite the base (a drive
/// form today), the base is then no longer the parent, or the last component is
/// no longer the name.
fn lies_directly_under(base: &Path, out: &Path, name: &OsStr) -> bool {
    out.parent() == Some(base) && out.file_name() == Some(name)
}

/// `base` plus the single entry name `name`, or an error. Every extraction site
/// builds its paths only through this function, so the rule and the backstop
/// cannot be skipped separately. No file system call is made.
pub(crate) fn append_confined(base: &Path, name: impl AsRef<OsStr>) -> anyhow::Result<PathBuf> {
    let name = name.as_ref();
    check_entry_component(name)?;
    let mut parts = Path::new(name).components();
    let single_plain_name = matches!(
        (parts.next(), parts.next()),
        (Some(Component::Normal(part)), None) if part == name
    );
    let out = base.join(name);
    if !single_plain_name || !lies_directly_under(base, &out, name) {
        bail!(
            "archive entry name '{}' is refused: it does not stay under {}",
            name.to_string_lossy(),
            base.display()
        );
    }
    Ok(out)
}

/// `base` plus every component of the relative path `rel`, each one through
/// [`append_confined`]. `.` is dropped; `..`, a root or a prefix is refused.
/// No file system call is made.
pub(crate) fn join_confined(base: &Path, rel: &Path) -> anyhow::Result<PathBuf> {
    let mut out = base.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(name) => out = append_confined(&out, name)?,
            Component::CurDir => {}
            _ => bail!(
                "archive path '{}' is not a plain relative path",
                rel.display()
            ),
        }
    }
    Ok(out)
}

/// True when `dest`, read as a Windows path, has a drive prefix and no root
/// (`C:x`, `D:`): a letter, `:`, then no separator. Pure: `windows` says
/// whether the rule applies, so every OS tests both answers. A relative path
/// with no drive prefix (`data/ryu`) is not such a path.
pub(crate) fn is_drive_relative(dest: &Path, windows: bool) -> bool {
    let bytes = dest.as_os_str().as_encoded_bytes();
    windows
        && bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && !matches!(bytes.get(2), Some(b'/' | b'\\'))
}

/// Refuse to extract into a destination folder that is drive-relative on
/// Windows. Such a folder is not where its caller meant it to be: it comes from
/// joining a name such as `C:x` onto the real folder, which drops that folder.
/// Called by the three extractors and the bundle installer before they read
/// the archive or create anything.
pub(crate) fn check_destination(dest: &Path) -> anyhow::Result<()> {
    if is_drive_relative(dest, cfg!(windows)) {
        bail!(
            "destination folder '{}' is refused: it has a drive prefix and no root",
            dest.display()
        );
    }
    Ok(())
}

/// Create `dest_dir/rel` as a real directory (and any missing parents below
/// `dest_dir`), refusing to traverse or reuse a symlink. A `rel` that is not a
/// plain relative path, or that holds a refused name, is an error.
pub(crate) fn create_dir_confined(dest_dir: &Path, rel: &Path) -> anyhow::Result<PathBuf> {
    // Every name is checked before the first file system call, so a refused
    // path creates nothing, not even its plain leading directories.
    join_confined(dest_dir, rel)?;
    let mut cursor = dest_dir.to_path_buf();
    for component in rel.components() {
        let Component::Normal(name) = component else {
            continue;
        };
        cursor = append_confined(&cursor, name)?;
        match std::fs::symlink_metadata(&cursor) {
            Ok(meta) if meta.file_type().is_symlink() => {
                bail!("refusing to extract through symlink {}", cursor.display())
            }
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => bail!(
                "archive path '{}' has a non-directory parent {}",
                rel.display(),
                cursor.display()
            ),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                // `create_dir` (not `_all`) creates exactly this component; a
                // racing symlink makes it fail with AlreadyExists rather than
                // being followed.
                std::fs::create_dir(&cursor)
                    .with_context(|| format!("creating dir {}", cursor.display()))?;
            }
            Err(e) => {
                return Err(e).with_context(|| format!("inspecting {}", cursor.display()));
            }
        }
    }
    Ok(cursor)
}

/// Write `bytes` to `dest_dir/rel` without following any symlink: parents are
/// created with [`create_dir_confined`], an existing leaf (file or symlink) is
/// unlinked rather than written through, and the new file is opened with
/// `create_new` so a link raced into place makes the write fail instead.
pub(crate) fn write_file_confined(
    dest_dir: &Path,
    rel: &Path,
    bytes: &[u8],
) -> anyhow::Result<PathBuf> {
    let file_name = match rel.components().next_back() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => bail!("archive path '{}' does not name a file", rel.display()),
    };
    // The whole path, the file name included, is checked before a parent
    // directory is created.
    join_confined(dest_dir, rel)?;
    let parent_rel = rel.parent().unwrap_or_else(|| Path::new(""));
    let out_path = append_confined(&create_dir_confined(dest_dir, parent_rel)?, &file_name)?;
    match std::fs::symlink_metadata(&out_path) {
        Ok(meta) if meta.is_dir() => bail!(
            "archive file '{}' collides with directory {}",
            rel.display(),
            out_path.display()
        ),
        Ok(_) => std::fs::remove_file(&out_path)
            .with_context(|| format!("replacing {}", out_path.display()))?,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("inspecting {}", out_path.display())),
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&out_path)
        .with_context(|| format!("writing {}", out_path.display()))?;
    file.write_all(bytes)
        .with_context(|| format!("writing {}", out_path.display()))?;
    Ok(out_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_nested_files_and_overwrites_regular_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_file_confined(tmp.path(), Path::new("a/b/c.txt"), b"one").unwrap();
        assert_eq!(path, tmp.path().join("a/b/c.txt"));
        write_file_confined(tmp.path(), Path::new("./a/b/c.txt"), b"two").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"two");
        assert!(create_dir_confined(tmp.path(), Path::new("a/b/d"))
            .unwrap()
            .is_dir());
    }

    #[test]
    fn rejects_parent_traversal_components() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_file_confined(tmp.path(), Path::new("../x"), b"x").is_err());
        assert!(create_dir_confined(tmp.path(), Path::new("a/../../x")).is_err());
        assert!(!tmp.path().parent().unwrap().join("x").exists());
    }

    #[test]
    fn a_name_that_holds_a_colon_is_refused_on_every_os() {
        for name in ["C:x", "c:", "C:..", "D:dir", "file:stream", "a:b:c", ":"] {
            for windows in [true, false] {
                let why = entry_component_refusal(OsStr::new(name), windows);
                assert_eq!(why, Some("holds ':'"), "{name}");
            }
            assert!(check_entry_component(OsStr::new(name)).is_err(), "{name}");
            assert!(append_confined(Path::new("base"), name).is_err(), "{name}");
            assert!(join_confined(Path::new("base"), &Path::new("repo").join(name)).is_err());
        }
    }

    #[test]
    fn device_names_and_trailing_dots_or_spaces_are_refused_for_windows_only() {
        for name in [
            "NUL",
            "nul.txt",
            "Com1",
            "LPT9.tar.gz",
            "aux .md",
            "notes.",
            "notes ",
        ] {
            let name = OsStr::new(name);
            assert!(entry_component_refusal(name, true).is_some(), "{name:?}");
            assert_eq!(entry_component_refusal(name, false), None, "{name:?}");
            // The live rule follows the OS this build runs on.
            assert_eq!(check_entry_component(name).is_err(), cfg!(windows));
        }
        for name in [
            "SKILL.md",
            ".gitignore",
            "console.rs",
            "com10",
            "nulls",
            "a b",
        ] {
            assert_eq!(entry_component_refusal(OsStr::new(name), true), None);
        }
    }

    #[test]
    fn append_confined_accepts_plain_names_and_keeps_the_base() {
        let base = Path::new("dest").join("repo");
        assert_eq!(append_confined(&base, "a.txt").unwrap(), base.join("a.txt"));
        let deep = join_confined(&base, Path::new("./x/y/z.txt")).unwrap();
        assert_eq!(deep.strip_prefix(&base).unwrap(), Path::new("x/y/z.txt"));
        let from_empty = join_confined(Path::new(""), Path::new("a/b")).unwrap();
        assert_eq!(from_empty, Path::new("a/b"));
        for not_one_plain_name in ["", ".", "..", "a/b"] {
            assert!(append_confined(&base, not_one_plain_name).is_err());
        }
        assert!(join_confined(&base, Path::new("a/../b")).is_err());
        assert!(join_confined(&base, Path::new("/abs")).is_err());
    }

    /// The backstop alone, with the name rule left out: a drive form makes
    /// `join` drop the base, and comparing the result with the base shows it.
    #[cfg(windows)]
    #[test]
    fn the_backstop_alone_catches_a_join_that_drops_the_base() {
        for base in [r"C:\ryu\extract\repo", r"\\?\C:\ryu\extract\repo", "rel"] {
            let base = Path::new(base);
            for name in ["C:x", "D:dir", "C:..", "c:"] {
                let name = OsStr::new(name);
                let joined = base.join(name);
                assert!(!lies_directly_under(base, &joined, name), "{joined:?}");
            }
            let plain = OsStr::new("plain.txt");
            assert!(lies_directly_under(base, &base.join(plain), plain));
        }
    }

    #[test]
    fn a_drive_relative_destination_is_refused_for_windows_only() {
        for dest in ["C:x", "D:", "c:data/ryu", "Z:.."] {
            let dest = Path::new(dest);
            assert!(is_drive_relative(dest, true), "{dest:?}");
            assert!(!is_drive_relative(dest, false), "{dest:?}");
            // The live rule follows the OS this build runs on.
            assert_eq!(check_destination(dest).is_err(), cfg!(windows));
        }
        for dest in [
            "C:\\ryu",
            "C:/ryu",
            r"\\?\C:\ryu",
            r"\\host\share",
            "data/ryu",
            ".",
            "",
            "/tmp/x",
            "ab:x",
            "1:x",
        ] {
            let dest = Path::new(dest);
            assert!(!is_drive_relative(dest, true), "{dest:?}");
            assert!(check_destination(dest).is_ok(), "{dest:?}");
        }
    }

    #[test]
    fn the_guards_refuse_a_colon_name_before_they_create_anything() {
        let tmp = tempfile::tempdir().unwrap();
        // Not a drive form, so even a broken guard would write inside `tmp`.
        let err = write_file_confined(tmp.path(), Path::new("repo/sub/ab:x"), b"x").unwrap_err();
        assert!(
            err.to_string().contains("is refused: it holds ':'"),
            "{err}"
        );
        assert!(create_dir_confined(tmp.path(), Path::new("repo/ab:dir/sub")).is_err());
        let left = std::fs::read_dir(tmp.path()).unwrap().count();
        assert_eq!(left, 0, "a refused path must create nothing");
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_write_through_a_symlinked_directory() {
        let dest = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dest.path().join("x")).unwrap();

        let err = write_file_confined(dest.path(), Path::new("x/evil.desktop"), b"pwn")
            .expect_err("a planted directory symlink must not be followed");
        assert!(err.to_string().contains("symlink"), "got: {err}");
        assert!(!outside.path().join("evil.desktop").exists());
        assert!(create_dir_confined(dest.path(), Path::new("x/sub")).is_err());
        assert!(!outside.path().join("sub").exists());
    }

    #[cfg(unix)]
    #[test]
    fn replaces_a_symlinked_leaf_instead_of_following_it() {
        let dest = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("target");
        std::fs::write(&target, b"original").unwrap();
        std::os::unix::fs::symlink(&target, dest.path().join("f")).unwrap();

        let path = write_file_confined(dest.path(), Path::new("f"), b"archive").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        let meta = std::fs::symlink_metadata(&path).unwrap();
        assert!(meta.file_type().is_file());
        assert_eq!(std::fs::read(&path).unwrap(), b"archive");
    }
}
