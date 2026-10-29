//! No provider calls: exercise the production install/disable/uninstall seams
//! against installed canonical package files and isolated skill/activation roots.
use super::*;

const PACKAGE_SKILLS: &[(&str, &str, &str)] = &[
    (
        "@ryu/writing-style",
        "writing-style",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/writing-style/skills/writing-style/SKILL.md"
        ),
    ),
    (
        "@ryu/llm-wiki",
        "llm-wiki",
        include_str!("../../../../generated/ryu-runtime/plugins-store/plugins/llm-wiki/skills/llm-wiki/SKILL.md"),
    ),
    (
        "@ryu/security-scanner",
        "security-diff-scan",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/skills/security-diff-scan/SKILL.md"
        ),
    ),
    (
        "@ryu/security-scanner",
        "security-fix",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/skills/security-fix/SKILL.md"
        ),
    ),
    (
        "@ryu/security-scanner",
        "security-scan",
        include_str!(
            "../../../../generated/ryu-runtime/plugins-store/plugins/security-scanner/skills/security-scan/SKILL.md"
        ),
    ),
];

const FILTER: &str = "skills_catalog::plugin_skills::installed_runtime_tests::installed_skill_bodies_install_activate_preserve_collisions_and_retry";
const CHILD: &str = "RYU_INSTALLED_SKILLS_RUNTIME_CHILD";

#[test]
fn installed_skill_bodies_install_activate_preserve_collisions_and_retry() {
    if std::env::var_os(CHILD).is_none() {
        let root = tempfile::tempdir().expect("isolated skill fixture");
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([FILTER, "--exact", "--nocapture"])
            .env(CHILD, "1")
            .env("RYU_PROFILE", "dev")
            .env("RYU_KEYCHAIN", "off")
            .env("RYU_DIR", root.path().join("data"))
            .env("RYU_PLUGINS_DIR", root.path().join("plugins"))
            .env("RYU_SKILLS_DIR", root.path().join("skills"))
            .env("RYU_SKILLS_ACTIVE_FILE", root.path().join("active.json"))
            .status()
            .expect("start isolated skill fixture");
        assert!(result.success(), "skill fixture failed: {result}");
        return;
    }
    let root = ryu_skills::SkillRegistry::skills_dir();
    let active = PathBuf::from(std::env::var_os("RYU_SKILLS_ACTIVE_FILE").unwrap());
    std::fs::create_dir_all(&root).unwrap();
    for owner in [
        "@ryu/writing-style",
        "@ryu/llm-wiki",
        "@ryu/security-scanner",
    ] {
        assert!(plugin_skills_root(owner).is_none());
        assert!(
            install_plugin_skills(owner).is_empty(),
            "absent installed package is a no-op"
        );
        let expected: Vec<_> = PACKAGE_SKILLS
            .iter()
            .filter(|(id, _, _)| *id == owner)
            .collect();
        assert!(!expected.is_empty());
        for (_, slug, body) in &expected {
            let source = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
                .join(crate::plugin_manifest::plugin_dir_name(owner))
                .join("skills")
                .join(slug);
            std::fs::create_dir_all(&source).unwrap();
            std::fs::write(source.join("SKILL.md"), body).unwrap();
        }
        let mut installed = install_plugin_skills(owner);
        installed.sort();
        let mut slugs: Vec<_> = expected
            .iter()
            .map(|(_, slug, _)| (*slug).to_owned())
            .collect();
        slugs.sort();
        assert_eq!(installed, slugs);
        for (_, slug, body) in &expected {
            assert_eq!(
                std::fs::read_to_string(root.join(slug).join("SKILL.md")).unwrap(),
                *body
            );
            assert_eq!(marker_owner(&root.join(slug)).as_deref(), Some(owner));
            assert!(ryu_skills::load_active_set().contains(*slug));
            let registry = ryu_skills::SkillRegistry::empty();
            registry.reload();
            let records = registry.list_all();
            let record = records
                .iter()
                .find(|record| record.id == *slug)
                .expect("installed skill in real scanner");
            assert!(record.is_loadable(), "{slug} is actually loadable");
        }
        assert_eq!(install_plugin_skills(owner).len(), expected.len());
        assert_eq!(deactivate_plugin_skills(owner).len(), expected.len());
        for (_, slug, body) in &expected {
            assert!(!ryu_skills::load_active_set().contains(*slug));
            assert_eq!(
                std::fs::read_to_string(root.join(slug).join("SKILL.md")).unwrap(),
                *body
            );
        }
        assert_eq!(install_plugin_skills(owner).len(), expected.len());
        assert_eq!(remove_plugin_skills(owner).len(), expected.len());
        for (_, slug, _) in &expected {
            assert!(!root.join(slug).exists());
            assert!(!ryu_skills::load_active_set().contains(*slug));
        }
        assert!(remove_plugin_skills(owner).is_empty());
    }

    let owner = "@ryu/writing-style";
    let dest = root.join("writing-style");
    std::fs::create_dir_all(&dest).unwrap();
    std::fs::write(dest.join("SKILL.md"), "user-owned body").unwrap();
    assert!(install_plugin_skills(owner).is_empty());
    assert!(deactivate_plugin_skills(owner).is_empty());
    assert!(remove_plugin_skills(owner).is_empty());
    assert_eq!(
        std::fs::read_to_string(dest.join("SKILL.md")).unwrap(),
        "user-owned body"
    );
    std::fs::write(dest.join(OWNER_MARKER), "@fixture/other-plugin").unwrap();
    assert!(install_plugin_skills(owner).is_empty());
    assert!(remove_plugin_skills(owner).is_empty());
    assert_eq!(
        marker_owner(&dest).as_deref(),
        Some("@fixture/other-plugin")
    );
    std::fs::remove_dir_all(&dest).unwrap();

    // Partial body failure remains owned and retryable, never activated.
    std::fs::create_dir_all(dest.join("SKILL.md")).unwrap();
    std::fs::write(dest.join(OWNER_MARKER), owner).unwrap();
    assert!(install_plugin_skills(owner).is_empty());
    assert!(!ryu_skills::load_active_set().contains("writing-style"));
    assert_eq!(marker_owner(&dest).as_deref(), Some(owner));
    std::fs::remove_dir(dest.join("SKILL.md")).unwrap();
    assert_eq!(install_plugin_skills(owner), vec!["writing-style"]);

    // Activation corruption is retained and reports no completed installation,
    // disable or removal. Repairing it permits an explicit retry.
    std::fs::write(&active, "corrupt activation store").unwrap();
    assert!(install_plugin_skills(owner).is_empty());
    assert!(deactivate_plugin_skills(owner).is_empty());
    assert!(remove_plugin_skills(owner).is_empty());
    assert!(dest.join("SKILL.md").is_file());
    assert_eq!(
        std::fs::read_to_string(&active).unwrap(),
        "corrupt activation store"
    );
    std::fs::write(&active, "[]").unwrap();
    assert_eq!(install_plugin_skills(owner), vec!["writing-style"]);
    assert!(ryu_skills::load_active_set().contains("writing-style"));
    assert_eq!(remove_plugin_skills(owner), vec!["writing-style"]);
    assert!(!dest.exists());

    // Refresh reads the actual installed package body rather than catalog metadata.
    let source = crate::plugin_manifest::PluginManifestLoader::plugins_dir()
        .join(crate::plugin_manifest::plugin_dir_name(owner))
        .join("skills/writing-style");
    std::fs::create_dir_all(&source).unwrap();
    let custom = "---\nname: Installed writing style\n---\nUpdated installed package body\n";
    std::fs::write(source.join("SKILL.md"), custom).unwrap();
    assert_eq!(install_plugin_skills(owner), vec!["writing-style"]);
    assert_eq!(
        std::fs::read_to_string(dest.join("SKILL.md")).unwrap(),
        custom
    );
    assert_eq!(remove_plugin_skills(owner), vec!["writing-style"]);
    assert!(install_plugin_skills("../outside").is_empty());
}
