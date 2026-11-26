// TC-9: an install with nobody present (folder sync) keeps an installed skill
// of the same name unless the caller allows the replacement, and never leaves
// `always-on` in the installed copy.

/// A source folder and a skills directory for one test. Holds the skills
/// environment lock and puts the environment back on drop.
struct UnattendedFixture {
    source: PathBuf,
    skills_home: PathBuf,
    _lock: std::sync::MutexGuard<'static, ()>,
}

impl UnattendedFixture {
    fn new(skill_md: &str) -> Self {
        let lock = ryu_skills::SKILLS_ENV_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let base = std::env::temp_dir().join(format!("ryu-unattended-{}", uniq()));
        let source = base.join("source");
        let skills_home = base.join("skills-home");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&skills_home).unwrap();
        std::fs::write(source.join("SKILL.md"), skill_md).unwrap();
        std::env::set_var("RYU_SKILLS_DIR", &skills_home);
        std::env::set_var("RYU_SKILLS_ACTIVE_FILE", base.join("active.json"));
        Self {
            source,
            skills_home,
            _lock: lock,
        }
    }
}

impl Drop for UnattendedFixture {
    fn drop(&mut self) {
        std::env::remove_var("RYU_SKILLS_DIR");
        std::env::remove_var("RYU_SKILLS_ACTIVE_FILE");
        if let Some(base) = self.source.parent() {
            let _ = std::fs::remove_dir_all(base);
        }
    }
}

#[test]
fn unattended_install_keeps_an_installed_skill_unless_allowed() {
    let fixture = UnattendedFixture::new("---\nname: demo\n---\nTHEIRS");
    let installed = fixture.skills_home.join("demo");
    std::fs::create_dir_all(&installed).unwrap();
    std::fs::write(installed.join("SKILL.md"), "---\nname: demo\n---\nMINE").unwrap();

    let kept = install_from_dir_unattended(&fixture.source, &|_| false).unwrap();
    assert!(matches!(kept, UnattendedInstall::Kept { ref slug } if slug == "demo"));
    assert_eq!(
        std::fs::read_to_string(installed.join("SKILL.md")).unwrap(),
        "---\nname: demo\n---\nMINE"
    );

    let asked = std::cell::Cell::new(None);
    let replaced = install_from_dir_unattended(&fixture.source, &|dir| {
        asked.set(Some(dir.to_path_buf()));
        true
    })
    .unwrap();
    assert!(matches!(replaced, UnattendedInstall::Installed(_)));
    assert_eq!(asked.take(), Some(installed.clone()));
    assert!(std::fs::read_to_string(installed.join("SKILL.md"))
        .unwrap()
        .contains("THEIRS"));
}

#[test]
fn unattended_install_drops_always_on_and_keeps_the_rest() {
    let fixture = UnattendedFixture::new(
        "---\nname: demo\ndescription: \"A demo\"\nalways-on: true\n---\nBody with always-on: true in it.\n",
    );

    let result = install_from_dir_unattended(&fixture.source, &|_| false).unwrap();

    assert!(matches!(result, UnattendedInstall::Installed(_)));
    let text = std::fs::read_to_string(fixture.skills_home.join("demo").join("SKILL.md")).unwrap();
    let record = ryu_skills::parse_skill_md("demo", &text).unwrap();
    assert!(!record.always_on, "{text}");
    assert_eq!(record.description.as_deref(), Some("A demo"));
    assert_eq!(record.instructions, "Body with always-on: true in it.");
    // An install a person asks for keeps the flag, as before.
    let attended = install_from_dir(&fixture.source, None).unwrap();
    let text = std::fs::read_to_string(&attended.path).unwrap();
    assert!(ryu_skills::parse_skill_md("demo", &text).unwrap().always_on);
}

#[test]
fn unattended_install_refuses_an_always_on_flag_it_cannot_clear() {
    // A flow mapping has no key line to take out.
    let fixture = UnattendedFixture::new("---\n{name: demo, always-on: true}\n---\nBody");
    let source = std::fs::read_to_string(fixture.source.join("SKILL.md")).unwrap();
    if !parses_as_always_on(&source) {
        // The parser does not read this form as always-on, so there is nothing to refuse.
        return;
    }

    let result = install_from_dir_unattended(&fixture.source, &|_| false);

    assert!(result.is_err(), "the flag would have been installed");
    assert!(!fixture.skills_home.join("demo").exists());
}

#[test]
fn the_always_on_filter_only_touches_front_matter_key_lines() {
    assert_eq!(
        without_always_on_key("---\nname: a\nalways-on: true\n---\nalways-on: true\n"),
        "---\nname: a\n---\nalways-on: true\n"
    );
    assert_eq!(
        without_always_on_key("\n---\r\n'always-on' : yes\r\nname: a\r\n---\r\nBody"),
        "\n---\r\nname: a\r\n---\r\nBody"
    );
    // No front matter: nothing is a key.
    assert_eq!(
        without_always_on_key("always-on: true\nBody"),
        "always-on: true\nBody"
    );
    assert!(is_always_on_key("always-on: true"));
    assert!(is_always_on_key("\"always-on\": true"));
    assert!(!is_always_on_key("always-online: true"));
    assert!(!is_always_on_key("description: always-on: no"));
}
