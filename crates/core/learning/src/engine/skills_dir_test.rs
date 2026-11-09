//! `SkillsDir` against an isolated temp folder: what counts as a taken slug,
//! the atomic write, activation, and the version saved before a replacement.

use super::harness_test::TempSkills;

const SKILL: &str = "---\nname: Reverse a string\ndescription: old\n---\nold steps\n";

#[test]
fn isolated_slug_taken_covers_skills_flat_files_and_bare_dirs() {
    let skills = TempSkills::new("dir-taken");
    skills.seed("learned-reverse", SKILL);
    std::fs::write(skills.root.join("learned-flat.md"), SKILL).unwrap();
    std::fs::create_dir_all(skills.root.join("learned-bare")).unwrap();

    assert!(skills.dir.slug_taken("learned-reverse"));
    assert!(skills.dir.slug_taken("learned-flat"));
    assert!(skills.dir.slug_taken("learned-bare"));
    assert!(!skills.dir.slug_taken("learned-free"));
    assert_eq!(skills.dir.root(), skills.root);
}

#[test]
fn isolated_learned_skills_lists_only_learned_skills_in_the_folder() {
    let skills = TempSkills::new("dir-learned");
    skills.seed("learned-reverse", SKILL);
    skills.seed("web-researcher", SKILL);

    let learned = skills.dir.learned_skills();
    assert_eq!(learned.len(), 1);
    assert_eq!(learned[0].slug, "learned-reverse");
    assert_eq!(learned[0].name, "Reverse a string");
    assert_eq!(learned[0].description, "old");
}

#[tokio::test]
async fn write_creates_the_skill_and_leaves_no_temp_file() {
    let skills = TempSkills::new("dir-write");
    skills.dir.write("learned-new", SKILL).await.unwrap();

    assert_eq!(skills.read("learned-new").as_deref(), Some(SKILL));
    assert!(!skills.root.join("learned-new/SKILL.md.tmp").exists());
}

#[test]
fn isolated_activation_is_recorded_on_the_handle_and_its_clones() {
    let skills = TempSkills::new("dir-active");
    let clone = skills.dir.clone();
    assert!(!skills.dir.is_active("learned-new"));

    clone.activate("learned-new");

    assert!(skills.dir.is_active("learned-new"));
    assert!(!skills.dir.is_active("learned-other"));
}

#[test]
fn snapshot_saves_the_current_source_or_nothing_when_absent() {
    let skills = TempSkills::new("dir-snapshot");
    skills.seed("learned-reverse", SKILL);

    let meta = skills
        .dir
        .snapshot("learned-reverse", "Before learned update")
        .unwrap()
        .expect("a saved version");
    assert_eq!(meta.name, "Reverse a string");
    assert_eq!(
        skills.versions("learned-reverse"),
        vec![(Some("Before learned update".to_string()), SKILL.to_string())]
    );

    assert!(skills
        .dir
        .snapshot("learned-absent", "x")
        .unwrap()
        .is_none());
    assert!(skills.versions("learned-absent").is_empty());
}
