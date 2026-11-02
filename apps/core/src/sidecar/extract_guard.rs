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

use anyhow::{bail, Context};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

/// Create `dest_dir/rel` as a real directory (and any missing parents below
/// `dest_dir`), refusing to traverse or reuse a symlink. `rel` must already be
/// a traversal-safe relative path.
pub(crate) fn create_dir_confined(dest_dir: &Path, rel: &Path) -> anyhow::Result<PathBuf> {
    let mut cursor = dest_dir.to_path_buf();
    for component in rel.components() {
        match component {
            Component::Normal(name) => cursor.push(name),
            Component::CurDir => continue,
            _ => bail!(
                "archive path '{}' is not a plain relative path",
                rel.display()
            ),
        }
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
    let parent_rel = rel.parent().unwrap_or_else(|| Path::new(""));
    let out_path = create_dir_confined(dest_dir, parent_rel)?.join(file_name);
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
