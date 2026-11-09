//! Unit tests for skill version history.

use super::*;

#[test]
fn version_roundtrip_isolated_by_uuid_id() {
    // Use a unique id against the real ryu_dir(), then self-clean (the
    // ryu_dir() OnceLock can't be redirected once resolved).
    let skill_id = format!("test-skill-{}", uuid::Uuid::new_v4().simple());
    let src = "---\nname: T\n---\nhello";
    let meta = save_skill_version(&skill_id, "T", src, Some("v1")).expect("save");
    assert_eq!(meta.skill_id, skill_id);

    let list = list_skill_versions(&skill_id).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].label.as_deref(), Some("v1"));

    let full = load_skill_version(&skill_id, &meta.id)
        .expect("load")
        .expect("some");
    assert_eq!(full.source, src);

    // Git history is immutable; only legacy JSON snapshots are removable.
    assert!(!delete_skill_versions(&skill_id).expect("delete legacy history"));
}

#[test]
fn snapshot_in_saves_the_source_from_an_explicit_root_into_an_explicit_history() {
    let temp = tempfile::tempdir().expect("temp dir");
    let skills_root = temp.path().join("skills");
    let history = SourceHistory::new(temp.path().join("source-history"));
    std::fs::create_dir_all(skills_root.join("my-skill")).expect("skill dir");
    let source = "---\nname: Mine\n---\nprior body\n";
    std::fs::write(skills_root.join("my-skill/SKILL.md"), source).expect("write skill");

    let meta = snapshot_skill_in(&skills_root, &history, "my-skill", Some("Before"))
        .expect("snapshot")
        .expect("a version");
    assert_eq!(meta.name, "Mine");
    assert_eq!(meta.label.as_deref(), Some("Before"));

    let path = source_history_path("my-skill");
    let saved = history.read(&path, &meta.id).expect("read").expect("some");
    assert_eq!(saved, source);
    assert_eq!(history.list(&path, None).expect("list").len(), 1);

    // A skill with no source under the root has nothing to save.
    assert!(snapshot_skill_in(&skills_root, &history, "absent", None)
        .expect("snapshot")
        .is_none());
}
