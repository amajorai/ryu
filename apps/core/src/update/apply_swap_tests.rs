//! Tests for the self-replace step (`apply_swap.rs`).

use super::*;

#[test]
fn exe_swap_installs_new_binary_and_keeps_backup() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("ryu-core.exe");
    let staged = dir.path().join("staged.bin");
    std::fs::write(&current, b"old binary").unwrap();
    std::fs::write(&staged, b"new binary").unwrap();
    replace_exe_at(&current, &staged).unwrap();
    assert_eq!(std::fs::read(&current).unwrap(), b"new binary");
    assert_eq!(
        std::fs::read(current.with_extension("old")).unwrap(),
        b"old binary"
    );
    assert!(!current.with_extension("new").exists());
    assert!(!staged.exists());
}

#[test]
fn exe_swap_failure_leaves_live_binary_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let current = dir.path().join("ryu-core.exe");
    std::fs::write(&current, b"old binary").unwrap();
    let missing = dir.path().join("does-not-exist.bin");
    assert!(replace_exe_at(&current, &missing).is_err());
    assert_eq!(std::fs::read(&current).unwrap(), b"old binary");
}

#[test]
fn replace_exe_swaps_in_the_new_binary_and_keeps_a_backup() {
    let dir = tempfile::tempdir().unwrap();
    let live = dir.path().join("ryu-core");
    let staged = dir.path().join("staged");
    std::fs::write(&live, b"old").unwrap();
    std::fs::write(&staged, b"new").unwrap();

    replace_exe_at(&live, &staged).unwrap();

    assert_eq!(std::fs::read(&live).unwrap(), b"new");
    assert_eq!(std::fs::read(live.with_extension("old")).unwrap(), b"old");
    assert!(!live.with_extension("new").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&live).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}

#[test]
fn replace_exe_leaves_the_live_binary_when_the_new_one_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let live = dir.path().join("ryu-core");
    std::fs::write(&live, b"old").unwrap();

    assert!(replace_exe_at(&live, &dir.path().join("missing")).is_err());

    assert_eq!(std::fs::read(&live).unwrap(), b"old");
    assert!(!live.with_extension("new").exists());
}
