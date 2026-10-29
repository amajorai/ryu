//! Editor save (`update_skill`) and version restore (`restore_skill_version`)
//! against a real temp skills dir (`RYU_SKILLS_DIR`) and the managed source
//! history. Skill ids are UUID-unique because the history lives under the
//! process-wide data dir, which cannot be redirected once resolved.

use super::*;

/// Points `RYU_SKILLS_DIR` at a temp dir for one test, holding the crate-wide
/// env lock, and clears the variable on drop (also when an assertion panics).
struct SkillsDirGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    _temp: tempfile::TempDir,
    dir: PathBuf,
}

impl SkillsDirGuard {
    fn new() -> Self {
        let lock = crate::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let temp = tempfile::tempdir().expect("temp dir");
        let dir = temp.path().join("skills");
        std::fs::create_dir_all(&dir).expect("skills dir");
        std::env::set_var("RYU_SKILLS_DIR", &dir);
        Self {
            _lock: lock,
            _temp: temp,
            dir,
        }
    }

    fn write(&self, id: &str, source: &str) -> PathBuf {
        let skill_dir = self.dir.join(id);
        std::fs::create_dir_all(&skill_dir).expect("skill dir");
        let path = skill_dir.join("SKILL.md");
        std::fs::write(&path, source).expect("write SKILL.md");
        path
    }
}

impl Drop for SkillsDirGuard {
    fn drop(&mut self) {
        std::env::remove_var("RYU_SKILLS_DIR");
    }
}

fn unique_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

fn draft(name: &str, body: &str) -> SkillDraft {
    SkillDraft {
        name: name.to_owned(),
        description: Some("Edited description".to_owned()),
        allowed_tools: vec!["web_search".to_owned()],
        always_on: true,
        body: body.to_owned(),
    }
}

#[test]
fn update_rewrites_managed_keys_and_keeps_unmanaged_ones_on_disk() {
    let env = SkillsDirGuard::new();
    let id = unique_id("editor-update");
    let path = env.write(
        &id,
        "---\nname: Old Name\ndescription: old\nenabled: false\nlicense: MIT\nmetadata:\n  owner: team-a\n---\nold body\n",
    );

    let result =
        update_skill(&id, &draft("New Name", "new body")).unwrap_or_else(|_| panic!("update"));
    assert_eq!(result.id, id);
    assert_eq!(result.path, path);

    let on_disk = std::fs::read_to_string(&path).expect("read back");
    assert_eq!(
        on_disk, result.source,
        "the echoed source is what was written"
    );
    let record = crate::parse_skill_md(&id, &on_disk).expect("written file loads");
    assert_eq!(record.name, "New Name");
    assert_eq!(record.description.as_deref(), Some("Edited description"));
    assert_eq!(record.allowed_tools, vec!["web_search".to_owned()]);
    assert!(record.always_on);
    assert_eq!(record.instructions, "new body");
    // Unmanaged keys survive: the skill stays disabled and keeps its license
    // and metadata block.
    assert!(
        !record.enabled,
        "enabled: false must survive an editor save"
    );
    assert!(on_disk.contains("license: MIT"));
    assert!(on_disk.contains("owner: team-a"));
    assert!(!on_disk.contains("Old Name"));
    assert!(!on_disk.contains("old body"));

    // The save is recorded in the skill's source history.
    let versions = list_skill_versions(&id).expect("list versions");
    assert!(versions.iter().any(
        |version| version.label.as_deref() == Some("Skill saved") && version.name == "New Name"
    ));
}

#[test]
fn update_rejects_an_unsafe_id_without_writing() {
    let env = SkillsDirGuard::new();
    for bad in ["../escape", "a/b", "", "..", "c:d"] {
        let result = update_skill(bad, &draft("Escape", "body"));
        assert!(
            matches!(result, Err(CreateError::Io(ref e)) if e.kind() == std::io::ErrorKind::InvalidInput),
            "id {bad:?} must be refused"
        );
    }
    let parent = env.dir.parent().expect("temp root");
    assert!(!parent.join("escape").exists());
    assert_eq!(std::fs::read_dir(&env.dir).expect("list").count(), 0);
}

#[test]
fn update_refuses_a_draft_that_would_not_round_trip() {
    let env = SkillsDirGuard::new();
    let id = unique_id("editor-roundtrip");
    // `enabled` is preserved verbatim by the editor, but the loader needs a bool:
    // writing this draft would leave a skill the registry can no longer read.
    let original = "---\nname: Broken\nenabled: sometimes\n---\nkeep me\n";
    let path = env.write(&id, original);

    let result = update_skill(&id, &draft("Broken Still", "replaced"));
    assert!(
        matches!(result, Err(CreateError::Invalid(ref msg)) if msg.contains("round-trip")),
        "a non-round-tripping draft must be refused"
    );
    assert_eq!(std::fs::read_to_string(&path).expect("read"), original);

    // An empty name is refused too, and the file is still untouched.
    let result = update_skill(&id, &draft("   ", "replaced"));
    assert!(matches!(result, Err(CreateError::Invalid(_))));
    assert_eq!(std::fs::read_to_string(&path).expect("read"), original);
}

#[test]
fn restore_writes_the_captured_source_verbatim_and_records_an_undo_point() {
    let env = SkillsDirGuard::new();
    let id = unique_id("editor-restore");
    // Hand-formatted (comment, quoting, spacing) so a re-render would differ.
    let v1 = "---\n# hand written\nname: 'First'\nlicense:   MIT\n---\n\nfirst body  \n";
    let path = env.write(&id, v1);
    let v1_meta = snapshot_skill(&id, Some("v1"))
        .expect("snapshot")
        .expect("on disk");

    let saved =
        update_skill(&id, &draft("Second", "second body")).unwrap_or_else(|_| panic!("update"));
    assert_ne!(saved.source, v1);

    let restored = restore_skill_version(&id, &v1_meta.id)
        .expect("restore")
        .expect("version exists");
    assert_eq!(restored, v1);
    assert_eq!(
        std::fs::read_to_string(&path).expect("read"),
        v1,
        "restore is lossless"
    );

    // The pre-restore source was recorded first, so the restore can be undone.
    let versions = list_skill_versions(&id).expect("list");
    let undo = versions
        .iter()
        .find(|version| version.label.as_deref() == Some("Before restore"))
        .expect("a 'Before restore' version");
    let undo_source = load_skill_version(&id, &undo.id)
        .expect("load")
        .expect("undo version exists")
        .source;
    assert_eq!(undo_source, saved.source);

    // Undoing the restore brings the edited source back.
    restore_skill_version(&id, &undo.id)
        .expect("undo")
        .expect("undo version exists");
    assert_eq!(std::fs::read_to_string(&path).expect("read"), saved.source);
}

#[test]
fn restore_of_an_unknown_version_is_none_and_leaves_the_skill_alone() {
    let env = SkillsDirGuard::new();
    let id = unique_id("editor-missing");
    let original = "---\nname: Keep\n---\nunchanged\n";
    let path = env.write(&id, original);
    snapshot_skill(&id, Some("only")).expect("snapshot");
    let before = list_skill_versions(&id).expect("list").len();

    for unknown in ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "not-a-version"] {
        assert!(restore_skill_version(&id, unknown)
            .expect("restore")
            .is_none());
    }
    assert_eq!(std::fs::read_to_string(&path).expect("read"), original);
    assert_eq!(list_skill_versions(&id).expect("list").len(), before);
}
