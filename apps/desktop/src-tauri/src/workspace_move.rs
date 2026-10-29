//! Native moves requested by the user in a selected workspace. A collision is
//! refused atomically: a check followed by ordinary rename would overwrite a
//! file created between those operations.
#[cfg(any(target_os = "linux", target_os = "macos"))]
use nix::libc;
use std::path::{Component, Path};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::{
    ffi::CString,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    os::unix::ffi::OsStrExt,
};

fn relative_components(path: &Path) -> Result<Vec<std::ffi::OsString>, String> {
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
        return Err("Workspace item must be a nonempty relative path without traversal".into());
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
        return Err("Workspace item contains a reserved Windows path component".into());
    }
    Ok(components
        .into_iter()
        .map(|part| part.as_os_str().to_owned())
        .collect())
}

/// Read Git-tracked and untracked visible paths, omitting deleted cached entries.
/// Git emits nul separators, so filenames are never parsed as shell commands or
/// split at newlines. The filesystem check reads metadata, never file contents.
pub(crate) fn list_files(root: &Path) -> Result<Vec<String>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("Invalid workspace root: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace root must be a directory".into());
    }
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
        .map_err(|error| format!("Cannot list workspace files: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot list workspace files: {}",
            String::from_utf8_lossy(&output.stderr).trim()
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
        let name = std::str::from_utf8(raw)
            .map_err(|_| "Workspace filename is not valid UTF-8".to_string())?;
        // Listing supports newline names; move intentionally refuses control names.
        let parts: Vec<_> = Path::new(name).components().collect();
        if parts.is_empty()
            || parts
                .iter()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err("Git returned a path outside the workspace".into());
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

pub(crate) fn move_item(root: &Path, source: &Path, destination: &Path) -> Result<(), String> {
    let source_parts = relative_components(source)?;
    let destination_parts = relative_components(destination)?;
    if destination.starts_with(source) {
        return Err("Cannot move a workspace item into itself or its descendants".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("Invalid workspace root: {error}"))?;
    if !root.is_dir() {
        return Err("Workspace root must be a directory".into());
    }
    platform_move(&root, &source_parts, &destination_parts)
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn component_name(value: &std::ffi::OsStr) -> Result<CString, String> {
    CString::new(value.as_bytes()).map_err(|_| "Workspace path contains a null byte".into())
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_parent(root: &OwnedFd, parts: &[std::ffi::OsString]) -> Result<(OwnedFd, CString), String> {
    let mut directory = root
        .try_clone()
        .map_err(|error| format!("Cannot pin workspace root: {error}"))?;
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
            return Err(format!(
                "Workspace directory is unavailable or a symlink: {}",
                std::io::Error::last_os_error()
            ));
        }
        directory = unsafe { OwnedFd::from_raw_fd(raw) };
    }
    Ok((directory, component_name(parts.last().unwrap())?))
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn unix_root(root: &Path) -> Result<OwnedFd, String> {
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
        return Err(format!(
            "Cannot open workspace root: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn platform_move(
    root: &Path,
    source: &[std::ffi::OsString],
    destination: &[std::ffi::OsString],
) -> Result<(), String> {
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
        return Err(format!(
            "Workspace source is unavailable: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mode = unsafe { source_stat.assume_init() }.st_mode & libc::S_IFMT;
    if mode != libc::S_IFREG && mode != libc::S_IFDIR {
        return Err("Only regular workspace files and directories can be moved".into());
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
        return Err(format!("Workspace move refused (destination must be empty and atomic exclusive rename supported): {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_move(
    root: &Path,
    source: &[std::ffi::OsString],
    destination: &[std::ffi::OsString],
) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVE_FILE_FLAGS};
    fn confined(
        root: &Path,
        parts: &[std::ffi::OsString],
        existing_leaf: bool,
    ) -> Result<std::path::PathBuf, String> {
        let mut path = root.to_path_buf();
        for (index, part) in parts.iter().enumerate() {
            path.push(part);
            if !existing_leaf && index + 1 == parts.len() {
                break;
            }
            let metadata = std::fs::symlink_metadata(&path)
                .map_err(|error| format!("Workspace item unavailable: {error}"))?;
            // Windows reparse points can redirect traversal even without a
            // symlink type, so reject both directory junctions and symlinks.
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Workspace moves cannot traverse reparse points".into());
            }
            let canonical = path.canonicalize().map_err(|error| error.to_string())?;
            if !canonical.starts_with(root) {
                return Err("Workspace item escapes the project folder".into());
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
    .map_err(|error| format!("Workspace move refused: {error}"))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn platform_move(
    _root: &Path,
    _source: &[std::ffi::OsString],
    _destination: &[std::ffi::OsString],
) -> Result<(), String> {
    Err("Atomic exclusive workspace moves are unavailable on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(root: &Path, arguments: &[&str]) {
        let result = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn git_listing_removes_tracked_ghosts_and_preserves_untracked_ignore_semantics() {
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q"]);
        fs::write(root.path().join("tracked.txt"), b"tracked bytes").unwrap();
        fs::write(root.path().join(".gitignore"), b"ignored.txt\n").unwrap();
        git(root.path(), &["add", "tracked.txt", ".gitignore"]);
        fs::write(root.path().join("untracked.txt"), b"untracked").unwrap();
        fs::write(root.path().join("ignored.txt"), b"ignored").unwrap();
        move_item(
            root.path(),
            Path::new("tracked.txt"),
            Path::new("renamed.txt"),
        )
        .unwrap();
        assert_eq!(
            list_files(root.path()).unwrap(),
            vec![".gitignore", "renamed.txt", "untracked.txt"]
        );
        assert_eq!(
            fs::read(root.path().join("renamed.txt")).unwrap(),
            b"tracked bytes"
        );
        fs::remove_file(root.path().join("renamed.txt")).unwrap();
        assert_eq!(
            list_files(root.path()).unwrap(),
            vec![".gitignore", "untracked.txt"]
        );
    }

    #[cfg(unix)]
    #[test]
    fn git_listing_preserves_nul_delimited_names_and_omits_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "-q"]);
        fs::write(root.path().join("line\nbreak.txt"), b"safe").unwrap();
        fs::write(root.path().join("--option.txt"), b"safe").unwrap();
        fs::write(outside.path().join("secret"), b"outside").unwrap();
        symlink(
            outside.path().join("secret"),
            root.path().join("escape.txt"),
        )
        .unwrap();
        assert_eq!(
            list_files(root.path()).unwrap(),
            vec!["--option.txt", "line\nbreak.txt"]
        );
        assert_eq!(fs::read(outside.path().join("secret")).unwrap(), b"outside");
    }

    #[test]
    fn non_git_workspace_listing_reports_error_instead_of_empty_success() {
        let root = tempfile::tempdir().unwrap();
        assert!(list_files(root.path())
            .unwrap_err()
            .contains("Cannot list workspace files"));
    }

    #[test]
    fn file_and_folder_moves_preserve_bytes_and_children() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("archive")).unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/alpha.ts"), b"original\0bytes\n").unwrap();
        move_item(
            root.path(),
            Path::new("src/alpha.ts"),
            Path::new("src/renamed.ts"),
        )
        .unwrap();
        assert!(!root.path().join("src/alpha.ts").exists());
        assert_eq!(
            fs::read(root.path().join("src/renamed.ts")).unwrap(),
            b"original\0bytes\n"
        );
        move_item(root.path(), Path::new("src"), Path::new("archive/moved")).unwrap();
        assert!(!root.path().join("src").exists());
        assert_eq!(
            fs::read(root.path().join("archive/moved/renamed.ts")).unwrap(),
            b"original\0bytes\n"
        );
    }

    #[test]
    fn occupied_file_and_directory_destinations_preserve_every_source() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("source"), b"source").unwrap();
        fs::write(root.path().join("occupied"), b"do not replace").unwrap();
        assert!(move_item(root.path(), Path::new("source"), Path::new("occupied")).is_err());
        fs::create_dir(root.path().join("folder")).unwrap();
        fs::create_dir(root.path().join("occupied-folder")).unwrap();
        assert!(move_item(
            root.path(),
            Path::new("folder"),
            Path::new("occupied-folder")
        )
        .is_err());
        assert_eq!(fs::read(root.path().join("source")).unwrap(), b"source");
        assert_eq!(
            fs::read(root.path().join("occupied")).unwrap(),
            b"do not replace"
        );
        assert!(root.path().join("folder").is_dir());
        assert!(root.path().join("occupied-folder").is_dir());
    }

    #[test]
    fn malformed_escape_and_subtree_moves_do_not_touch_disk() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("source"), b"source").unwrap();
        fs::create_dir_all(root.path().join("folder/child")).unwrap();
        for bad in [
            "",
            "../outside",
            "/absolute",
            "folder/../outside",
            "line\nname",
        ] {
            assert!(
                move_item(root.path(), Path::new("source"), Path::new(bad)).is_err(),
                "{bad}"
            );
            assert!(
                move_item(root.path(), Path::new(bad), Path::new("destination")).is_err(),
                "{bad}"
            );
        }
        assert!(move_item(
            root.path(),
            Path::new("folder"),
            Path::new("folder/child/moved")
        )
        .is_err());
        assert!(move_item(
            root.path(),
            Path::new("source"),
            Path::new("missing/destination")
        )
        .is_err());
        assert_eq!(fs::read(root.path().join("source")).unwrap(), b"source");
        assert!(root.path().join("folder/child").is_dir());
        assert!(!root.path().join("destination").exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlink_parents_sources_and_occupied_links_cannot_escape_or_replace() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(root.path().join("source"), b"source").unwrap();
        fs::write(outside.path().join("protected"), b"outside").unwrap();
        symlink(outside.path(), root.path().join("escape")).unwrap();
        symlink(
            outside.path().join("protected"),
            root.path().join("source-link"),
        )
        .unwrap();
        symlink(
            outside.path().join("absent"),
            root.path().join("occupied-link"),
        )
        .unwrap();
        assert!(move_item(
            root.path(),
            Path::new("source"),
            Path::new("escape/destination")
        )
        .is_err());
        assert!(move_item(
            root.path(),
            Path::new("escape/protected"),
            Path::new("destination")
        )
        .is_err());
        assert!(move_item(
            root.path(),
            Path::new("source-link"),
            Path::new("destination")
        )
        .is_err());
        assert!(move_item(root.path(), Path::new("source"), Path::new("occupied-link")).is_err());
        assert_eq!(fs::read(root.path().join("source")).unwrap(), b"source");
        assert_eq!(
            fs::read(outside.path().join("protected")).unwrap(),
            b"outside"
        );
        assert!(fs::symlink_metadata(root.path().join("occupied-link"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(!outside.path().join("destination").exists());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn device_aliases_streams_and_ambiguous_windows_names_preserve_source() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("source"), b"source").unwrap();
        for name in [
            "CON",
            "con.txt",
            "PRN.log",
            "aux",
            "NuL.bin",
            "COM1",
            "com9.txt",
            "LPT1",
            "lpt9.json",
            "folder/CON.txt",
            "source:stream",
            "trailing.",
            "trailing ",
        ] {
            assert!(
                move_item(root.path(), Path::new("source"), Path::new(name)).is_err(),
                "{name}"
            );
            assert!(
                move_item(root.path(), Path::new(name), Path::new("destination")).is_err(),
                "{name}"
            );
            assert_eq!(fs::read(root.path().join("source")).unwrap(), b"source");
            assert!(!root.path().join("destination").exists());
        }
    }

    // The fixture uses this very production helper in separate OS processes.
    #[test]
    #[ignore = "subprocess fixture; started by external_processes_cannot_overwrite_one_destination"]
    fn exclusive_move_subprocess_fixture() {
        let root = std::env::var_os("RYU_WORKSPACE_MOVE_TEST_ROOT").expect("owned test root");
        let source = std::env::var_os("RYU_WORKSPACE_MOVE_TEST_SOURCE").expect("owned test source");
        let result = move_item(
            Path::new(&root),
            Path::new(&source),
            Path::new("destination"),
        );
        if result.is_ok() {
            println!("MOVE_ACCEPTED");
        } else {
            println!("MOVE_REFUSED");
        }
    }

    #[test]
    fn external_processes_cannot_overwrite_one_destination() {
        use std::process::{Command, Stdio};
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a"), b"a bytes").unwrap();
        fs::write(root.path().join("b"), b"b bytes").unwrap();
        let launch = |source: &str| {
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "exclusive_move_subprocess_fixture",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("RYU_WORKSPACE_MOVE_TEST_ROOT", root.path())
                .env("RYU_WORKSPACE_MOVE_TEST_SOURCE", source)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap()
        };
        let a = launch("a");
        let b = launch("b");
        let outputs = [a.wait_with_output().unwrap(), b.wait_with_output().unwrap()];
        for output in &outputs {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        assert_eq!(
            outputs
                .iter()
                .filter(|output| String::from_utf8_lossy(&output.stdout).contains("MOVE_ACCEPTED"))
                .count(),
            1
        );
        assert_eq!(
            outputs
                .iter()
                .filter(|output| String::from_utf8_lossy(&output.stdout).contains("MOVE_REFUSED"))
                .count(),
            1
        );
        let bytes = fs::read(root.path().join("destination")).unwrap();
        if bytes == b"a bytes" {
            assert!(!root.path().join("a").exists());
            assert_eq!(fs::read(root.path().join("b")).unwrap(), b"b bytes");
        } else {
            assert_eq!(bytes, b"b bytes");
            assert!(!root.path().join("b").exists());
            assert_eq!(fs::read(root.path().join("a")).unwrap(), b"a bytes");
        }
    }
}
