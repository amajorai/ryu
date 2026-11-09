use super::{skill_approved_message, skill_in_library};

#[test]
fn an_approved_revision_reports_an_update_and_a_new_skill_an_addition() {
    assert_eq!(
        skill_approved_message("learned-reverse-text", true).render("en"),
        "Updated the skill \"learned-reverse-text\" in your library."
    );
    assert_eq!(
        skill_approved_message("learned-reverse-text", false).render("en"),
        "Added the skill \"learned-reverse-text\" to your library."
    );
}

#[test]
fn the_skill_result_renders_in_the_requested_locale() {
    assert_eq!(
        skill_approved_message("learned-reverse-text", true).render("de"),
        "Der Skill „learned-reverse-text“ in Ihrer Bibliothek wurde aktualisiert."
    );
    assert_eq!(
        skill_approved_message("learned-reverse-text", false).render("ja"),
        "スキル「learned-reverse-text」をライブラリに追加しました。"
    );
}

#[test]
fn only_a_skill_with_a_skill_md_counts_as_already_in_the_library() {
    let dir = tempfile::tempdir().unwrap();
    assert!(!skill_in_library(dir.path(), "learned-reverse-text"));

    // An empty directory left behind is not a skill to replace.
    std::fs::create_dir_all(dir.path().join("learned-reverse-text")).unwrap();
    assert!(!skill_in_library(dir.path(), "learned-reverse-text"));

    std::fs::write(
        dir.path().join("learned-reverse-text").join("SKILL.md"),
        "---\nname: Reverse text\n---\nsteps",
    )
    .unwrap();
    assert!(skill_in_library(dir.path(), "learned-reverse-text"));
    assert!(!skill_in_library(dir.path(), "learned-other"));
}
