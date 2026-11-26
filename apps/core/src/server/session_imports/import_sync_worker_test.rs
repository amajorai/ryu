//! TC-9: what the folder sync worker's import does with a skill, driven through
//! `apply_sync_worker_selections` with the answer to "may this installed skill
//! be replaced" given by the test.

use crate::import::{kind, ImportSelection};
use crate::server::{apply_sync_worker_selections, isolated_plugin_hook_test_state};

/// Points the skills directory at a temp folder for one test and puts the
/// environment back, also when the test panics.
struct SkillsHome {
    home: std::path::PathBuf,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl SkillsHome {
    fn new(base: &std::path::Path) -> Self {
        let lock = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let home = base.join("skills-home");
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("RYU_SKILLS_DIR", &home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", base.join("active.json"));
        Self { home, _lock: lock }
    }
}

impl Drop for SkillsHome {
    fn drop(&mut self) {
        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
    }
}

fn skill_selection(rel: &str) -> ImportSelection {
    ImportSelection {
        kind: kind::SKILL.into(),
        id: format!("{}/{rel}", kind::SKILL),
    }
}

#[tokio::test]
async fn an_installed_skill_is_kept_unless_the_worker_may_replace_it() {
    let base = tempfile::tempdir().unwrap();
    // Built before the skills lock is taken, so nothing it does can wait on it.
    let state = isolated_plugin_hook_test_state(base.path());
    let skills = SkillsHome::new(base.path());
    let installed = skills.home.join("demo");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("SKILL.md"), "---\nname: demo\n---\nMINE").unwrap();
    std::fs::write(installed.join("notes.md"), "keep me").unwrap();
    let root = base.path().join("synced");
    std::fs::create_dir_all(root.join("other")).unwrap();
    std::fs::write(
        root.join("other").join("SKILL.md"),
        "---\nname: demo\nalways-on: true\n---\nTHEIRS",
    )
    .unwrap();

    let never = |_: &ImportSelection, _: &std::path::Path| false;
    let kept =
        apply_sync_worker_selections(&state, &root, vec![skill_selection("other")], &never).await;
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].outcome.status, "skipped", "{:?}", kept[0].outcome);
    assert!(kept[0].outcome.already_exists);
    assert!(kept[0].installed_skill_dir.is_none());
    assert_eq!(
        std::fs::read_to_string(installed.join("SKILL.md")).unwrap(),
        "---\nname: demo\n---\nMINE"
    );
    assert_eq!(
        std::fs::read_to_string(installed.join("notes.md")).unwrap(),
        "keep me"
    );

    let always = |_: &ImportSelection, _: &std::path::Path| true;
    let replaced =
        apply_sync_worker_selections(&state, &root, vec![skill_selection("other")], &always).await;
    assert_eq!(
        replaced[0].outcome.status, "imported",
        "{:?}",
        replaced[0].outcome
    );
    assert_eq!(
        replaced[0].installed_skill_dir.as_deref(),
        Some(installed.as_path())
    );
    let text = std::fs::read_to_string(installed.join("SKILL.md")).unwrap();
    assert!(text.contains("THEIRS"), "{text}");
    let record = ryu_skills::parse_skill_md("demo", &text).unwrap();
    assert!(
        !record.always_on,
        "a skill installed with nobody present must not be always-on: {text}"
    );
}
