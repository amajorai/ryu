//! Regression tests for the ACP `fs/*` check-then-open race: an agent that
//! swaps a checked workspace directory or leaf for a symlink between Core's
//! path check and its open must not read or write outside the workspace.
//! Each test runs the check step, performs the swap, then runs the open step,
//! so no real race is needed.

use super::*;

struct SwapFixture {
    base: std::path::PathBuf,
    root: std::path::PathBuf,
    outside: std::path::PathBuf,
}

impl SwapFixture {
    fn new(tag: &str) -> Self {
        let base = std::env::temp_dir().join(format!(
            "ryu-acp-swap-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let root = base.join("workspace");
        let outside = base.join("outside");
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        Self {
            base,
            root,
            outside,
        }
    }

    fn roots(&self) -> Vec<std::path::PathBuf> {
        vec![self.root.clone()]
    }

    /// Replace the real `root/d` with a symlink to the outside directory, the
    /// way a confined agent would after Core's check passed.
    fn swap_dir_for_symlink(&self) {
        std::fs::rename(self.root.join("d"), self.root.join("d-decoy")).unwrap();
        std::os::unix::fs::symlink(&self.outside, self.root.join("d")).unwrap();
    }
}

impl Drop for SwapFixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.base);
    }
}

#[test]
fn read_refuses_a_directory_swapped_for_a_symlink_after_the_check() {
    let fx = SwapFixture::new("read");
    std::fs::write(fx.root.join("d/id_rsa"), "decoy").unwrap();
    std::fs::write(fx.outside.join("id_rsa"), "secret").unwrap();

    let target = scoped_existing_target(&fx.roots(), &fx.root.join("d/id_rsa"))
        .expect("the real in-workspace file passes the check");
    fx.swap_dir_for_symlink();

    let content = read_scoped_target(&target, None, None);
    assert_eq!(content, "", "the swapped-in symlink must not be followed");
}

#[test]
fn read_still_serves_an_unswapped_nested_file() {
    let fx = SwapFixture::new("read-ok");
    std::fs::write(fx.root.join("d/notes.txt"), "a\nb\nc").unwrap();

    let target = scoped_existing_target(&fx.roots(), &fx.root.join("d/notes.txt"))
        .expect("in-workspace file passes the check");
    assert_eq!(read_scoped_target(&target, None, None), "a\nb\nc");
    assert_eq!(read_scoped_target(&target, Some(2), Some(1)), "b");
}

#[test]
fn write_refuses_an_ancestor_swapped_for_a_symlink_after_the_check() {
    let fx = SwapFixture::new("write-parent");
    let target = scoped_write_target(&fx.roots(), &fx.root.join("d/x.txt"))
        .expect("the real in-workspace directory passes the check");
    fx.swap_dir_for_symlink();

    assert!(write_scoped_target(&target, "planted").is_err());
    assert!(!fx.outside.join("x.txt").exists());
}

#[test]
fn write_refuses_a_leaf_symlink_planted_after_the_check() {
    let fx = SwapFixture::new("write-leaf");
    let outside_target = fx.outside.join("authorized_keys");
    std::fs::write(&outside_target, "original").unwrap();
    let target = scoped_write_target(&fx.roots(), &fx.root.join("new.txt"))
        .expect("a not-yet-created in-workspace file passes the check");
    std::os::unix::fs::symlink(&outside_target, fx.root.join("new.txt")).unwrap();

    assert!(write_scoped_target(&target, "ssh-ed25519 attacker").is_err());
    assert_eq!(
        std::fs::read_to_string(&outside_target).unwrap(),
        "original"
    );
}

#[test]
fn write_refuses_a_missing_parent_swapped_for_a_symlink_after_the_check() {
    let fx = SwapFixture::new("write-missing");
    let target = scoped_write_target(&fx.roots(), &fx.root.join("made/deep/x.txt"))
        .expect("a missing in-workspace suffix passes the check");
    std::os::unix::fs::symlink(&fx.outside, fx.root.join("made")).unwrap();

    assert!(write_scoped_target(&target, "planted").is_err());
    assert!(!fx.outside.join("deep").exists());
}

#[test]
fn write_creates_missing_parents_and_truncates_existing_files() {
    let fx = SwapFixture::new("write-ok");
    let roots = fx.roots();
    let nested = fx.root.join("made/deep/x.txt");
    let target = scoped_write_target(&roots, &nested).expect("nested write passes the check");
    write_scoped_target(&target, "first, longer content").unwrap();
    write_scoped_target(&target, "second").unwrap();
    assert_eq!(std::fs::read_to_string(&nested).unwrap(), "second");
}
