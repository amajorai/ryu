//! Descriptor-relative opens for the ACP client `fs/*` handlers.
//!
//! Core serves `fs/read_text_file` and `fs/write_text_file` outside the agent's
//! OS sandbox, so the path checks in `scoped_fs` are only early refusals: the
//! agent can still swap a checked directory or leaf for a symlink before Core
//! opens it. These helpers therefore re-walk the already-checked relative path
//! from a descriptor for the session root, one component at a time, refusing
//! every symlink (`O_NOFOLLOW`) and every non-regular leaf. Nothing is ever
//! reopened by name after the check.

use std::fs::File;
use std::io;
use std::path::{Component, Path};

/// Split `rel` into plain path components. `.`/`..`, roots and prefixes are
/// refused so the walk cannot climb out of the root descriptor.
fn plain_components(rel: &Path) -> io::Result<Vec<&std::ffi::OsStr>> {
    let mut out = Vec::new();
    for component in rel.components() {
        match component {
            Component::Normal(name) => out.push(name),
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path must stay beneath the session root",
                ))
            }
        }
    }
    if out.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "path names the session root, not a file",
        ));
    }
    Ok(out)
}

fn require_regular_file(file: File) -> io::Result<File> {
    if file.metadata()?.is_file() {
        Ok(file)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "not a regular file",
        ))
    }
}

#[cfg(unix)]
mod imp {
    use super::{plain_components, require_regular_file};
    use std::ffi::{CStr, CString, OsStr};
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    fn c_name(name: &OsStr) -> io::Result<CString> {
        CString::new(name.as_bytes())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "path contains NUL"))
    }

    fn openat(
        dir: Option<&OwnedFd>,
        name: &CStr,
        flags: libc::c_int,
        mode: libc::mode_t,
    ) -> io::Result<OwnedFd> {
        let dirfd = dir.map_or(libc::AT_FDCWD, AsRawFd::as_raw_fd);
        // SAFETY: `name` is a valid NUL-terminated string and `dirfd` is either
        // AT_FDCWD or a descriptor owned by the caller for this call's duration.
        let fd = unsafe {
            libc::openat(
                dirfd,
                name.as_ptr(),
                flags | libc::O_CLOEXEC,
                libc::c_uint::from(mode),
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` is a fresh descriptor this function exclusively owns.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn open_dir_nofollow(dir: &OwnedFd, name: &CStr) -> io::Result<OwnedFd> {
        openat(
            Some(dir),
            name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            0,
        )
    }

    fn mkdirat(dir: &OwnedFd, name: &CStr) -> io::Result<()> {
        // SAFETY: valid descriptor and NUL-terminated name, as in `openat`.
        let rc = unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o777) };
        if rc == 0 {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if err.kind() == io::ErrorKind::AlreadyExists {
            Ok(())
        } else {
            Err(err)
        }
    }

    pub(in super::super) fn open_beneath(root: &Path, rel: &Path, write: bool) -> io::Result<File> {
        let components = plain_components(rel)?;
        let root_name = c_name(root.as_os_str())?;
        let mut dir = openat(
            None,
            &root_name,
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW,
            0,
        )?;
        let (leaf, parents) = components
            .split_last()
            .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        for component in parents {
            let name = c_name(component)?;
            dir = match open_dir_nofollow(&dir, &name) {
                Ok(next) => next,
                Err(err) if write && err.kind() == io::ErrorKind::NotFound => {
                    mkdirat(&dir, &name)?;
                    open_dir_nofollow(&dir, &name)?
                }
                Err(err) => return Err(err),
            };
        }
        let leaf_name = c_name(leaf)?;
        // O_NONBLOCK keeps a FIFO planted at the leaf from blocking the open; it
        // is refused right after by the regular-file check.
        let flags = if write {
            libc::O_WRONLY | libc::O_CREAT | libc::O_NOFOLLOW | libc::O_NONBLOCK
        } else {
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK
        };
        let file = File::from(openat(Some(&dir), &leaf_name, flags, 0o666)?);
        let file = require_regular_file(file)?;
        if write {
            file.set_len(0)?;
        }
        Ok(file)
    }
}

#[cfg(not(unix))]
mod imp {
    use super::{plain_components, require_regular_file};
    use std::fs::File;
    use std::io;
    use std::path::Path;

    /// Non-Unix fallback: path-based, after the same component validation. The
    /// agent OS sandbox that makes the swap race meaningful is Unix-only.
    pub(in super::super) fn open_beneath(root: &Path, rel: &Path, write: bool) -> io::Result<File> {
        plain_components(rel)?;
        let path = root.join(rel);
        if !write {
            return require_regular_file(File::open(path)?);
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let file = require_regular_file(
            std::fs::OpenOptions::new()
                .write(true)
                .create(true)
                .open(&path)?,
        )?;
        file.set_len(0)?;
        Ok(file)
    }
}

/// Open `rel` (plain components only) beneath the canonical `root` without
/// following any symlink. For writes, missing parent directories are created
/// one component at a time and the leaf is created or truncated. The opened
/// target must be a regular file.
pub(super) use imp::open_beneath;
