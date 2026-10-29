//! Unit tests for the skill authoring store and its legacy snapshot import.

use super::*;

#[test]
fn build_preserves_unknown_front_matter_keys() {
    let existing = "---\nname: Old\nlicense: MIT\nenabled: false\n---\nold body";
    let draft = SkillDraft {
        name: "New Name".to_owned(),
        description: Some("desc".to_owned()),
        allowed_tools: vec!["spider".to_owned()],
        always_on: true,
        body: "new body".to_owned(),
    };
    let out = build_skill_md(Some(existing), &draft).expect("build");
    // Editor-managed keys are patched.
    assert!(out.contains("name: New Name"));
    assert!(out.contains("description: desc"));
    assert!(out.contains("allowed-tools:"));
    assert!(out.contains("always-on: true"));
    // Unknown / unmanaged keys survive.
    assert!(out.contains("license: MIT"));
    assert!(out.contains("enabled: false"));
    assert!(out.trim_end().ends_with("new body"));
    // And it round-trips through the loader.
    let rec = super::super::parse_skill_md("x", &out).expect("round-trip");
    assert_eq!(rec.name, "New Name");
    assert_eq!(rec.instructions, "new body");
    assert!(rec.always_on);
}

#[test]
fn build_clears_optional_keys_when_emptied() {
    let existing = "---\nname: X\ndescription: had one\nalways-on: true\n---\nbody";
    let draft = SkillDraft {
        name: "X".to_owned(),
        description: None,
        allowed_tools: vec![],
        always_on: false,
        body: "body".to_owned(),
    };
    let out = build_skill_md(Some(existing), &draft).expect("build");
    assert!(!out.contains("description:"));
    assert!(!out.contains("always-on"));
}

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
fn create_refuses_an_id_held_by_a_legacy_flat_skill() {
    let _guard = crate::SKILLS_ENV_LOCK.lock().unwrap();
    let temp = tempfile::tempdir().unwrap();
    let skills = temp.path().join("skills");
    std::fs::create_dir_all(&skills).unwrap();
    std::fs::write(skills.join("pdf.md"), "---\nname: PDF\n---\nlegacy body").unwrap();
    std::env::set_var("RYU_SKILLS_DIR", &skills);
    let draft = SkillDraft {
        name: "PDF".to_owned(),
        description: None,
        allowed_tools: vec![],
        always_on: false,
        body: "new body".to_owned(),
    };
    let result = create_skill(&draft);
    std::env::remove_var("RYU_SKILLS_DIR");
    assert!(matches!(result, Err(CreateError::Conflict(ref id)) if id == "pdf"));
    assert!(!skills.join("pdf").exists());
}

#[test]
fn legacy_snapshots_are_imported_sealed_and_their_folder_removed() {
    let temp = tempfile::tempdir().expect("temp dir");
    let legacy_root = temp.path().join("state/skill-versions");
    let history = SourceHistory::new(temp.path().join("files/source-history"));
    let skill_dir = legacy_root.join("my-skill");
    std::fs::create_dir_all(&skill_dir).expect("legacy dir");
    let legacy = SkillVersion {
        id: "0f8b2c4e-1a2b-4c3d-8e9f-0123456789ab".to_owned(),
        skill_id: "my-skill".to_owned(),
        name: "Mine".to_owned(),
        label: Some("Before edit".to_owned()),
        created_at: 1_700_000_000_000,
        source: "---\nname: Mine\n---\nlegacy-skill-marker-9902".to_owned(),
    };
    std::fs::write(
        skill_dir.join(format!("{}.json", legacy.id)),
        serde_json::to_vec(&legacy).expect("json"),
    )
    .expect("write legacy");
    std::fs::write(skill_dir.join("broken.json"), b"{not json").expect("write broken");
    // An unsafe folder name is never imported or deleted.
    let bad_dir = legacy_root.join(unsafe_folder_name());
    std::fs::create_dir_all(&bad_dir).expect("bad dir");

    let report = import_legacy_skill_versions_in(&legacy_root, &history);
    assert_eq!(report.imported, 1);
    assert_eq!(report.discarded, 1);
    assert_eq!(report.kept, 1);
    assert!(!skill_dir.exists(), "plaintext snapshots are removed");
    assert!(bad_dir.exists(), "an unsafe folder is left in place");

    let path = source_history_path("my-skill");
    let versions = history.list(&path, None).expect("list");
    assert_eq!(versions.len(), 1);
    assert_eq!(versions[0].id, "0f8b2c4e1a2b4c3d8e9f0123456789ab");
    assert_eq!(versions[0].created_at, legacy.created_at);
    assert_eq!(versions[0].label.as_deref(), Some("Before edit"));
    assert_eq!(
        history
            .read(&path, &versions[0].id)
            .expect("read")
            .as_deref(),
        Some(legacy.source.as_str())
    );

    // Nothing under the data dir holds the snapshot in the clear.
    let mut stack = vec![temp.path().to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir").flatten() {
            let entry_path = entry.path();
            if entry_path.is_dir() {
                stack.push(entry_path);
            } else {
                let bytes = std::fs::read(&entry_path).expect("read file");
                assert!(
                    !String::from_utf8_lossy(&bytes).contains("legacy-skill-marker-9902"),
                    "{} holds the plaintext snapshot",
                    entry_path.display()
                );
            }
        }
    }

    // A second run is a no-op.
    std::fs::remove_dir_all(&bad_dir).expect("cleanup");
    assert_eq!(
        import_legacy_skill_versions_in(&legacy_root, &history),
        LegacyImportReport::default()
    );
    assert!(!legacy_root.exists());
}

/// A legacy folder name the import must skip. Unix can create a name that
/// `validate_id` rejects (`:`), but Windows forbids every character and name
/// `validate_id` rejects, so there the folder is named with an unpaired UTF-16
/// surrogate, which NTFS accepts but is not valid Unicode and is skipped the
/// same way.
#[cfg(unix)]
fn unsafe_folder_name() -> std::ffi::OsString {
    "bad:name".into()
}

#[cfg(windows)]
fn unsafe_folder_name() -> std::ffi::OsString {
    use std::os::windows::ffi::OsStringExt;
    std::ffi::OsString::from_wide(&[u16::from(b'b'), 0xD800, u16::from(b'd')])
}

#[test]
fn rejects_unsafe_ids() {
    assert!(validate_id("../escape").is_err());
    assert!(validate_id("a/b").is_err());
    assert!(validate_id("a\\b").is_err());
    assert!(validate_id("bad:name").is_err());
    assert!(validate_id(".").is_err());
    assert!(validate_id("..").is_err());
    assert!(validate_id("").is_err());
    assert!(validate_id("ok-id").is_ok());
}
