//! Native moves requested by the user in a selected workspace. A collision is
//! refused atomically: a check followed by ordinary rename would overwrite a
//! file created between those operations. Failures are coded
//! [`FsCommandError`]s; the raw OS error rides in `detail` for the logs.
use crate::fs_command_error::{FsCommandError, FsCommandErrorCode as Code};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use nix::libc;
use std::path::{Component, Path};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::ffi::OsStrExt,
};

fn relative_components(path: &Path) -> Result<Vec<std::ffi::OsString>, FsCommandError> {
    let components: Vec<_> = path.components().collect();
    if components.is_empty()
        || path
            .as_os_str()
            .to_string_lossy()
            .chars()
            .any(char::is_control)
        || components
            .iter()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(FsCommandError::with_detail(
            Code::InvalidName,
            "workspace item must be a nonempty relative path without traversal",
        ));
    }
    #[cfg(target_os = "windows")]
    if components.iter().any(|part| {
        let name = part.as_os_str().to_string_lossy();
        let stem = name
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let device_alias = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || stem.strip_prefix("COM").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            })
            || stem.strip_prefix("LPT").is_some_and(|suffix| {
                matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9")
            });
        name.chars()
            .any(|character| matches!(character, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
            || name.ends_with('.')
            || name.ends_with(' ')
            || device_alias
    }) {
        return Err(FsCommandError::with_detail(
            Code::InvalidName,
            "workspace item contains a reserved Windows path component",
        ));
    }
    Ok(components
        .into_iter()
        .map(|part| part.as_os_str().to_owned())
        .collect())
}

/// Read Git-tracked and untracked visible paths, omitting deleted cached entries.
/// Git emits nul separators, so filenames are never parsed as shell commands or
/// split at newlines. The filesystem check reads metadata, never file contents.
pub(crate) fn list_files(root: &Path) -> Result<Vec<String>, FsCommandError> {
    let root = canonical_root(root)?;
    let output = std::process::Command::new("git")
        .args(["-c", "core.fsmonitor=false", "-C"])
        .arg(&root)
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_CONFIG_COUNT")
        .output()
        .map_err(|error| FsCommandError::with_detail(Code::ListFailed, error))?;
    if !output.status.success() {
        return Err(FsCommandError::with_detail(
            Code::ListFailed,
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    let directory = unix_root(&root)?;
    let mut result = Vec::new();
    for raw in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|value| !value.is_empty())
    {
        let name = std::str::from_utf8(raw).map_err(|_| {
            FsCommandError::with_detail(Code::ListFailed, "workspace filename is not valid UTF-8")
        })?;
        // Listing supports newline names; move intentionally refuses control names.
        let parts: Vec<_> = Path::new(name).components().collect();
        if parts.is_empty()
            || parts
                .iter()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(FsCommandError::with_detail(
                Code::ListFailed,
                "git returned a path outside the workspace",
            ));
        }
        let parts: Vec<_> = parts
            .into_iter()
            .map(|part| part.as_os_str().to_owned())
            .collect();
        #[cfg(any(target_os = "linux", target_os = "macos"))]
        let present = {
            let Ok((parent, leaf)) = unix_parent(&directory, &parts) else {
                continue;
            };
            let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
            let success = unsafe {
                libc::fstatat(
                    parent.as_raw_fd(),
                    leaf.as_ptr(),
                    stat.as_mut_ptr(),
                    libc::AT_SYMLINK_NOFOLLOW,
                )
            } == 0;
            success && {
                let mode = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
                mode == libc::S_IFREG || mode == libc::S_IFDIR
            }
        };
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        let present = {
            let mut path = root.clone();
            let mut safe = true;
            for part in &parts {
                path.push(part);
                match std::fs::symlink_metadata(&path) {
                    Ok(metadata) => {
                        #[cfg(target_os = "windows")]
                        {
                            use std::os::windows::fs::MetadataExt;
                            safe &= metadata.file_attributes() & 0x400 == 0;
                        }
                        safe &= !metadata.file_type().is_symlink();
                    }
                    Err(_) => {
                        safe = false;
                        break;
                    }
                }
                if !safe {
                    break;
                }
            }
            safe
        };
        if present {
            result.push(name.to_owned());
        }
    }
    result.sort();
    result.dedup();
    Ok(result)
}

fn canonical_root(root: &Path) -> Result<std::path::PathBuf, FsCommandError> {
    let root = root
        .canonicalize()
        .map_err(|error| FsCommandError::with_detail(Code::WorkspaceUnavailable, error))?;
    if !root.is_dir() {
        return Err(FsCommandError::with_detail(
            Code::WorkspaceUnavailable,
            "workspace root must be a directory",
        ));
    }
    Ok(root)
}

pub(crate) fn move_item(
    root: &Path,
    source: &Path,
    destination: &Path,
) -> Result<(), FsCommandError> {
    let source_parts = relative_components(source)?;
    let destination_parts = relative_components(destination)?;
    if destination.starts_with(source) {
        return Err(FsCommandError::new(Code::IntoDescendant));
    }
    let root = canonical_root(root)?;
    platform_move(&root, &source_parts, &destination_parts)
}

/// Classify the last OS error of a unix lookup or rename. `ELOOP` is what
/// `O_NOFOLLOW` reports for a symlinked parent: the path leaves the project.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn last_os_error(fallback: Code) -> FsCommandError {
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ELOOP) => FsCommandError::with_detail(Code::OutsideProject, error),
        Some(libc::EEXIST | libc::ENOTEMPTY) => {
            FsCommandError::with_detail(Code::DestinationExists, error)
        }
        _ => FsCommandError::from_io(&error, fallback),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn component_name(value: &std::ffi::OsStr) -> Result<CString, FsCommandError> {
    CString::new(value.as_bytes()).map_err(|_| {
        FsCommandError::with_detail(Code::InvalidName, "workspace path contains a null byte")
    })
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_parent(
    root: &OwnedFd,
    parts: &[std::ffi::OsString],
) -> Result<(OwnedFd, CString), FsCommandError> {
    let mut directory = root
        .try_clone()
        .map_err(|error| FsCommandError::with_detail(Code::WorkspaceUnavailable, error))?;
    for part in &parts[..parts.len() - 1] {
        let name = component_name(part)?;
        let raw = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if raw < 0 {
            return Err(last_os_error(Code::ItemUnavailable));
        }
        directory = unsafe { OwnedFd::from_raw_fd(raw) };
    }
    Ok((directory, component_name(parts.last().unwrap())?))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_root(root: &Path) -> Result<OwnedFd, FsCommandError> {
    let root_name = component_name(root.as_os_str())?;
    // Pin the selected canonical root once so both parent walks use the same
    // directory even if another process renames its original path.
    let raw = unsafe {
        libc::open(
            root_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if raw < 0 {
        return Err(FsCommandError::with_detail(
            Code::WorkspaceUnavailable,
            std::io::Error::last_os_error(),
        ));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn platform_move(
    root: &Path,
    source: &[std::ffi::OsString],
    destination: &[std::ffi::OsString],
) -> Result<(), FsCommandError> {
    let root = unix_root(root)?;
    let (source_parent, source_name) = unix_parent(&root, source)?;
    let (destination_parent, destination_name) = unix_parent(&root, destination)?;
    let mut source_stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    if unsafe {
        libc::fstatat(
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            source_stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(last_os_error(Code::ItemUnavailable));
    }
    let mode = unsafe { source_stat.assume_init() }.st_mode & libc::S_IFMT;
    if mode != libc::S_IFREG && mode != libc::S_IFDIR {
        return Err(FsCommandError::new(Code::UnsupportedItem));
    }
    #[cfg(target_os = "linux")]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            destination_parent.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    let result = unsafe {
        libc::renameatx_np(
            source_parent.as_raw_fd(),
            source_name.as_ptr(),
            destination_parent.as_raw_fd(),
            destination_name.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result != 0 {
        // EEXIST/ENOTEMPTY: the destination is occupied. EINVAL here means the
        // filesystem lacks atomic exclusive rename.
        return Err(last_os_error(Code::MoveFailed));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_move(
    root: &Path,
    source: &[std::ffi::OsString],
    destination: &[std::ffi::OsString],
) -> Result<(), FsCommandError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};
    fn confined(
        root: &Path,
        parts: &[std::ffi::OsString],
        existing_leaf: bool,
    ) -> Result<std::path::PathBuf, FsCommandError> {
        let mut path = root.to_path_buf();
        for (index, part) in parts.iter().enumerate() {
            path.push(part);
            if !existing_leaf && index + 1 == parts.len() {
                break;
            }
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| FsCommandError::from_io(&error, Code::ItemUnavailable))?;
            // Windows reparse points can redirect traversal even without a
            // symlink type, so reject both directory junctions and symlinks.
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(FsCommandError::with_detail(
                    Code::OutsideProject,
                    "workspace moves cannot traverse reparse points",
                ));
            }
            let canonical = path
                .canonicalize()
                .map_err(|error| FsCommandError::from_io(&error, Code::ItemUnavailable))?;
            if !canonical.starts_with(root) {
                return Err(FsCommandError::new(Code::OutsideProject));
            }
        }
        Ok(path)
    }
    let source = confined(root, source, true)?;
    let destination = confined(root, destination, false)?;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // No REPLACE_EXISTING and no COPY_ALLOWED: preserve both source and an
    // occupied destination, and refuse cross-device moves instead of copying.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVE_FILE_FLAGS(0),
        )
    }
    .map_err(|error| {
        // HRESULT_FROM_WIN32(ERROR_FILE_EXISTS | ERROR_ALREADY_EXISTS).
        let code = match error.code().0 as u32 {
            0x8007_0050 | 0x8007_00B7 => Code::DestinationExists,
            0x8007_0002 | 0x8007_0003 => Code::ItemUnavailable,
            _ => Code::MoveFailed,
        };
        FsCommandError::with_detail(code, error)
    })
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_move(
    _root: &Path,
    _source: &[std::ffi::OsString],
    _destination: &[std::ffi::OsString],
) -> Result<(), FsCommandError> {
    Err(FsCommandError::with_detail(
        Code::MoveFailed,
        "atomic exclusive workspace moves are unavailable on this platform",
    ))
}

#[cfg(test)]
#[path = "workspace_move_tests.rs"]
mod tests;
