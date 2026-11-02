//! Tests for `workspace_move.rs` (split out to keep that file small).
use super::*;
use crate::fs_command_error::FsCommandErrorCode as Code;
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
    assert_eq!(list_files(root.path()).unwrap_err().code, Code::ListFailed);
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

fn code(result: Result<(), FsCommandError>) -> Code {
    result.unwrap_err().code
}

#[test]
fn refusals_carry_the_code_the_webview_words() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("source"), b"source").unwrap();
    fs::write(root.path().join("occupied"), b"occupied").unwrap();
    fs::create_dir_all(root.path().join("folder/child")).unwrap();
    let path = Path::new;
    assert_eq!(
        code(move_item(root.path(), path("source"), path("occupied"))),
        Code::DestinationExists
    );
    assert_eq!(
        code(move_item(
            root.path(),
            path("folder"),
            path("folder/child/moved")
        )),
        Code::IntoDescendant
    );
    assert_eq!(
        code(move_item(root.path(), path("source"), path("../outside"))),
        Code::InvalidName
    );
    assert_eq!(
        code(move_item(root.path(), path("missing"), path("destination"))),
        Code::ItemUnavailable
    );
    assert_eq!(
        code(move_item(
            root.path(),
            path("source"),
            path("missing/destination")
        )),
        Code::ItemUnavailable
    );
    assert_eq!(
        code(move_item(
            &root.path().join("absent-root"),
            path("source"),
            path("destination")
        )),
        Code::WorkspaceUnavailable
    );
    let occupied = move_item(root.path(), path("source"), path("occupied")).unwrap_err();
    assert!(occupied.detail.is_some(), "the OS cause stays in detail");
}

#[cfg(unix)]
#[test]
fn symlinks_are_refused_as_outside_the_project_or_unsupported() {
    use std::os::unix::fs::symlink;
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    fs::write(root.path().join("source"), b"source").unwrap();
    symlink(outside.path(), root.path().join("escape")).unwrap();
    symlink(root.path().join("source"), root.path().join("link")).unwrap();
    assert_eq!(
        code(move_item(
            root.path(),
            Path::new("source"),
            Path::new("escape/destination")
        )),
        Code::OutsideProject
    );
    assert_eq!(
        code(move_item(
            root.path(),
            Path::new("link"),
            Path::new("moved")
        )),
        Code::UnsupportedItem
    );
}
