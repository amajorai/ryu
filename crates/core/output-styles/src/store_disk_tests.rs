//! Disk-backed tests for the user-root writers in [`super`]: create / update / fork /
//! delete against a real tempdir pointed at by `RYU_OUTPUT_STYLES_DIR`, plus the
//! registry effect of a fork and its deletion. The pure builder/slug helpers are
//! covered by `store::tests`; this file proves the files land (and stay) where the
//! design says.

use std::path::Path;

use super::*;
use crate::{
    OutputStyleRegistry, ENV_OUTPUT_STYLES_DIR, ENV_SELECTION_FILE, OUTPUT_STYLES_ENV_LOCK,
};

const PLUGIN_SRC: &str =
    "---\nname: ELI5\ndescription: shipped\nforce-for-plugin: true\n---\nshipped body";

/// Holds [`OUTPUT_STYLES_ENV_LOCK`] and points the user root (and selection file) at a
/// tempdir, restoring the previous values on drop so a failing assertion cannot leak
/// the override into another test in this binary.
struct EnvGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    prev_dir: Option<std::ffi::OsString>,
    prev_selection: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn new(styles_dir: &Path) -> Self {
        let lock = OUTPUT_STYLES_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let guard = Self {
            _lock: lock,
            prev_dir: std::env::var_os(ENV_OUTPUT_STYLES_DIR),
            prev_selection: std::env::var_os(ENV_SELECTION_FILE),
        };
        std::env::set_var(ENV_OUTPUT_STYLES_DIR, styles_dir);
        std::env::set_var(ENV_SELECTION_FILE, styles_dir.join("selection.json"));
        guard
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.prev_dir {
            Some(v) => std::env::set_var(ENV_OUTPUT_STYLES_DIR, v),
            None => std::env::remove_var(ENV_OUTPUT_STYLES_DIR),
        }
        match &self.prev_selection {
            Some(v) => std::env::set_var(ENV_SELECTION_FILE, v),
            None => std::env::remove_var(ENV_SELECTION_FILE),
        }
    }
}

fn draft(name: &str, body: &str) -> OutputStyleDraft {
    OutputStyleDraft {
        name: name.to_owned(),
        description: None,
        keep_coding_instructions: false,
        body: body.to_owned(),
    }
}

fn ok(res: Result<WriteResult, CreateError>) -> WriteResult {
    match res {
        Ok(w) => w,
        Err(CreateError::Conflict(id)) => panic!("unexpected conflict for '{id}'"),
        Err(CreateError::Invalid(msg)) => panic!("unexpected invalid: {msg}"),
        Err(CreateError::Io(e)) => panic!("unexpected io error: {e}"),
    }
}

fn expect_conflict(res: Result<WriteResult, CreateError>) -> String {
    match res {
        Err(CreateError::Conflict(id)) => id,
        Ok(w) => panic!("expected a conflict, but '{}' was written", w.id),
        Err(CreateError::Invalid(msg)) => panic!("expected a conflict, got invalid: {msg}"),
        Err(CreateError::Io(e)) => panic!("expected a conflict, got io error: {e}"),
    }
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).expect("read style file")
}

#[test]
fn create_derives_the_slug_and_refuses_to_clobber() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _guard = EnvGuard::new(dir.path());

    let written = ok(create_style(&draft("I have ADHD", "action first")));
    assert_eq!(written.id, "i-have-adhd");
    assert_eq!(written.path, dir.path().join("i-have-adhd.md"));
    assert_eq!(
        read(&written.path),
        written.source,
        "echoed bytes are on disk"
    );
    let rec = crate::parse_output_style_md("i-have-adhd", &read(&written.path)).expect("parse");
    assert_eq!(rec.name, "I have ADHD");
    assert_eq!(rec.body, "action first");
    assert!(
        !dir.path().join("i-have-adhd.md.tmp").exists(),
        "the tmp file is renamed away"
    );

    // A second create whose name slugs to the same id must not overwrite the first.
    let id = expect_conflict(create_style(&draft("I-HAVE-adhd", "clobbered")));
    assert_eq!(id, "i-have-adhd");
    assert!(read(&written.path).contains("action first"));
    assert!(!read(&written.path).contains("clobbered"));
}

#[test]
fn create_rejects_a_name_with_no_safe_slug() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _guard = EnvGuard::new(dir.path());

    assert!(matches!(
        create_style(&draft("//", "body")),
        Err(CreateError::Invalid(_))
    ));
    let entries = std::fs::read_dir(dir.path()).map_or(0, Iterator::count);
    assert_eq!(entries, 0, "nothing is written for an invalid draft");
}

#[test]
fn update_of_a_user_style_preserves_unmanaged_keys() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _guard = EnvGuard::new(dir.path());
    std::fs::write(
        dir.path().join("mine.md"),
        "---\nname: Mine\nsome-future-key: 7\n---\nold body",
    )
    .expect("seed");

    // `inherit_from` is ignored when the user file exists: the user's own file is the base.
    let written = ok(update_style(
        "mine",
        &draft("Mine v2", "new body"),
        Some(PLUGIN_SRC),
    ));
    let on_disk = read(&written.path);
    assert_eq!(on_disk, written.source);
    assert!(on_disk.contains("some-future-key: 7"), "{on_disk}");
    assert!(!on_disk.contains("force-for-plugin"), "{on_disk}");
    let rec = crate::parse_output_style_md("mine", &on_disk).expect("parse");
    assert_eq!(rec.name, "Mine v2");
    assert_eq!(rec.body, "new body");
}

#[test]
fn update_of_a_plugin_style_forks_into_the_user_root_keeping_its_keys() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _guard = EnvGuard::new(dir.path());

    let reg = OutputStyleRegistry::empty();
    reg.register_plugin_style("eli5".to_owned(), PLUGIN_SRC)
        .expect("register");
    let inherit = reg.source_of("eli5").expect("plugin source");

    let written = ok(update_style(
        "eli5",
        &draft("ELI5 (mine)", "my body"),
        Some(&inherit),
    ));
    assert_eq!(written.path, dir.path().join("eli5.md"));
    let on_disk = read(&written.path);
    assert!(on_disk.contains("force-for-plugin: true"), "{on_disk}");
    assert!(
        !on_disk.contains("description:"),
        "cleared description drops"
    );

    reg.reload();
    let eff = reg.get("eli5").expect("eli5");
    assert_eq!(eff.source, crate::OutputStyleSource::User);
    assert_eq!(eff.name, "ELI5 (mine)");
    assert_eq!(eff.body, "my body");
}

#[test]
fn fork_twice_is_a_conflict_and_keeps_the_first_copy() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _guard = EnvGuard::new(dir.path());

    let written = ok(fork_style("eli5", PLUGIN_SRC));
    assert_eq!(read(&written.path), PLUGIN_SRC, "a fork is a verbatim copy");

    std::fs::write(&written.path, "---\nname: Edited\n---\nedited").expect("edit fork");
    let id = expect_conflict(fork_style("eli5", PLUGIN_SRC));
    assert_eq!(id, "eli5");
    assert!(
        read(&written.path).contains("Edited"),
        "second fork must not overwrite"
    );
}

#[test]
fn delete_removes_only_the_user_file_and_unshadows_the_plugin() {
    let dir = tempfile::tempdir().expect("tempdir");
    let _guard = EnvGuard::new(dir.path());

    let reg = OutputStyleRegistry::empty();
    reg.register_plugin_style("eli5".to_owned(), PLUGIN_SRC)
        .expect("register");
    ok(fork_style("eli5", "---\nname: Forked\n---\nmine"));
    reg.reload();
    assert_eq!(reg.get("eli5").expect("forked").name, "Forked");

    assert!(delete_style("eli5").expect("delete"));
    assert!(!dir.path().join("eli5.md").exists());
    reg.reload();
    let eff = reg.get("eli5").expect("plugin original is effective again");
    assert_eq!(eff.source, crate::OutputStyleSource::Plugin);
    assert_eq!(eff.name, "ELI5");

    // Absent in the user root: a no-op reported as such, and the plugin style survives.
    assert!(!delete_style("eli5").expect("second delete"));
    assert!(reg.get("eli5").is_some());
    assert!(
        delete_style("../escape").is_err(),
        "traversal ids are rejected"
    );
}
