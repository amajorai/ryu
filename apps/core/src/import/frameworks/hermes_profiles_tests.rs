use super::*;
use crate::import::{parse_agent_item, resolve_agent_item, scan_source};

fn write(dir: &Path, rel: &str, content: &str) {
    let path = dir.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// A Hermes home named `name` under a fresh temp folder. The temp folder is
/// returned too so it lives as long as the test.
fn home(name: &str) -> (tempfile::TempDir, PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(name);
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    (temp, root)
}

/// The default persona plus two bots, one deleted bot and one empty folder.
fn write_home_with_two_bots(root: &Path) {
    write(
        root,
        "config.yaml",
        "model:\n  default: claude-sonnet-4-6\n  provider: anthropic\n",
    );
    write(root, "SOUL.md", "You are the default Hermes persona.\n");
    write(
        root,
        "memories/MEMORY.md",
        "Default fact one\n§\nDefault fact two\n",
    );

    write(
        root,
        "profiles/coder/SOUL.md",
        "You write and review code.\n",
    );
    write(
        root,
        "profiles/coder/profile.yaml",
        "display_name: Coder Bot\ndescription: Reviews pull requests and fixes bugs.\n",
    );
    write(
        root,
        "profiles/coder/config.yaml",
        "model:\n  default: gpt-5\n  provider: openai\n",
    );
    write(
        root,
        "profiles/coder/memories/MEMORY.md",
        "The repo uses bun\n§\nTests run before every commit\n",
    );
    write(
        root,
        "profiles/coder/memories/USER.md",
        "User is called Ada\n",
    );
    write(
        root,
        "profiles/coder/skills/dev/deploy/SKILL.md",
        "---\nname: deploy\ndescription: d\n---\nDeploy.\n",
    );
    write(
        root,
        "profiles/coder/skills/lint/SKILL.md",
        "---\nname: lint\ndescription: d\n---\nLint.\n",
    );
    write(root, "profiles/coder/cron/jobs.json", "[]");
    write(root, "profiles/coder/auth.json", "{}");
    write(root, "profiles/coder/sessions/s1.json", "{}");

    write(root, "profiles/research/SOUL.md", "You research topics.\n");
    write(
        root,
        "profiles/research/profile.yaml",
        "display_name: Research\nui_meta:\n  hermes-bots:\n    title: Research Lead\n",
    );
    write(
        root,
        "profiles/research/memories/MEMORY.md",
        "Prefers primary sources\n",
    );

    // Deleted in Hermes: the folder stays, marked by `profiles/.deleted/<name>`.
    write(root, "profiles/old/SOUL.md", "You are retired.\n");
    write(root, "profiles/.deleted/old", "deleted\n");
    // A profile folder with no persona is not a bot.
    write(root, "profiles/empty/config.yaml", "model: x\n");
}

fn agent(root: &Path, id: &str) -> CodexSubagent {
    let (path, index) = resolve_agent_item(root, id).unwrap();
    parse_agent_item(root, &path, index).unwrap()
}

#[test]
fn each_hermes_bot_becomes_an_agent_with_its_own_name_memory_and_model() {
    let (_temp, root) = home(".hermes");
    write_home_with_two_bots(&root);

    let scan = scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("hermes"));
    let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
    let agents: Vec<&str> = scan
        .items
        .iter()
        .filter(|i| i.kind == kind::AGENT)
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(
        agents,
        vec![
            "agent/SOUL.md",
            "agent/profiles/coder/SOUL.md",
            "agent/profiles/research/SOUL.md",
        ],
        "{ids:?}"
    );

    let titles: Vec<&str> = scan
        .items
        .iter()
        .filter(|i| i.kind == kind::AGENT)
        .map(|i| i.title.as_str())
        .collect();
    assert!(titles[1].contains("Coder Bot"), "{titles:?}");
    assert!(titles[2].contains("Research Lead"), "{titles:?}");

    let default = agent(&root, "agent/SOUL.md");
    assert_eq!(default.name, "hermes");
    assert_eq!(
        default.model.as_deref(),
        Some("anthropic/claude-sonnet-4-6")
    );
    assert!(default
        .description
        .as_deref()
        .unwrap()
        .starts_with("Migrated from Hermes"));

    // `display_name`, its own description and its own model.
    let coder = agent(&root, "agent/profiles/coder/SOUL.md");
    assert_eq!(coder.name, "Coder Bot");
    assert_eq!(
        coder.description.as_deref(),
        Some("Reviews pull requests and fixes bugs.")
    );
    assert_eq!(coder.model.as_deref(), Some("openai/gpt-5"));
    assert!(coder.system_prompt.contains("write and review code"));
    assert!(!coder.system_prompt.contains("default Hermes persona"));

    // The Bot Mode title wins over `display_name`; the model falls back to
    // the one of the Hermes home.
    let research = agent(&root, "agent/profiles/research/SOUL.md");
    assert_eq!(research.name, "Research Lead");
    assert_eq!(
        research.model.as_deref(),
        Some("anthropic/claude-sonnet-4-6")
    );
    assert!(research
        .description
        .as_deref()
        .unwrap()
        .starts_with("Migrated from Hermes"));

    for id in [
        "memory/memories/MEMORY.md",
        "memory/profiles/coder/memories/MEMORY.md",
        "memory/profiles/coder/memories/USER.md",
        "memory/profiles/research/memories/MEMORY.md",
    ] {
        assert!(ids.contains(&id), "{id} missing from {ids:?}");
    }
    let coder_memory =
        parse_markdown_memory(&root.join("profiles/coder/memories/MEMORY.md")).unwrap();
    assert_eq!(
        coder_memory.entries,
        vec!["The repo uses bun", "Tests run before every commit"]
    );
    let coder_user = parse_markdown_memory(&root.join("profiles/coder/memories/USER.md")).unwrap();
    assert_eq!(coder_user.category, ryu_memory::MemoryCategory::UserFact);

    assert!(
        !ids.iter().any(|id| id.contains("profiles/old")),
        "a deleted bot is not offered: {ids:?}"
    );
    assert!(
        !ids.iter().any(|id| id.contains("profiles/empty")),
        "{ids:?}"
    );
}

#[test]
fn skills_inside_a_bot_are_found_once_even_below_the_shared_walk() {
    let (_temp, root) = home(".hermes");
    write_home_with_two_bots(&root);

    let scan = scan_source(&root).unwrap();
    let skills: Vec<&str> = scan
        .items
        .iter()
        .filter(|i| i.kind == kind::SKILL)
        .map(|i| i.id.as_str())
        .collect();
    // `profiles/coder/skills/dev/deploy` is five levels down, past the shared
    // walk; `profiles/coder/skills/lint` is reached by both walks.
    assert_eq!(
        skills
            .iter()
            .filter(|id| **id == "skill/profiles/coder/skills/dev/deploy")
            .count(),
        1,
        "{skills:?}"
    );
    assert_eq!(
        skills
            .iter()
            .filter(|id| **id == "skill/profiles/coder/skills/lint")
            .count(),
        1,
        "{skills:?}"
    );
    let path =
        crate::import::resolve_item_path(&root, "skill/profiles/coder/skills/dev/deploy").unwrap();
    assert!(path.join("SKILL.md").is_file());
}

#[test]
fn a_bot_with_routines_sign_ins_or_chats_is_noted_for_review() {
    use crate::i18n::messages;
    let (_temp, root) = home(".hermes");
    write_home_with_two_bots(&root);
    assert!(!root.join("cron").exists() && !root.join("auth.json").exists());

    let scan = scan_source(&root).unwrap();
    let found: Vec<String> = scan
        .warning_notices
        .iter()
        .filter_map(|notice| notice.i18n.as_ref())
        .map(|message| message.source().to_owned())
        .collect();
    for expected in [
        messages::IMPORT_HERMES_CRON_WARNING_MESSAGE,
        messages::IMPORT_HERMES_AUTH_WARNING_MESSAGE,
        messages::IMPORT_HERMES_SESSIONS_WARNING_MESSAGE,
    ] {
        let expected = Message::new(expected).source().to_owned();
        assert_eq!(
            found.iter().filter(|source| **source == expected).count(),
            1,
            "{found:?}"
        );
    }
}

#[test]
fn a_windows_shaped_home_is_detected() {
    // `%LOCALAPPDATA%\hermes`: no leading dot in the folder name.
    let (_temp, root) = home("AppData/Local/hermes");
    write_home_with_two_bots(&root);
    assert_eq!(detect(&root), Some(Framework::Hermes));
    let scan = scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("hermes"));
    assert_eq!(
        scan.items.iter().filter(|i| i.kind == kind::AGENT).count(),
        3
    );

    // A home that holds only bots: no root persona and no root memory.
    let (_temp, bots_only) = home("AppData/Local/hermes");
    write(&bots_only, "config.yaml", "model: x\n");
    write(&bots_only, "profiles/coder/SOUL.md", "You write code.\n");
    assert_eq!(detect(&bots_only), Some(Framework::Hermes));
    let scan = scan_source(&bots_only).unwrap();
    let agents: Vec<&str> = scan
        .items
        .iter()
        .filter(|i| i.kind == kind::AGENT)
        .map(|i| i.id.as_str())
        .collect();
    assert_eq!(agents, vec!["agent/profiles/coder/SOUL.md"]);
    // With no `profile.yaml` the bot is named after its folder.
    assert_eq!(
        agent(&bots_only, "agent/profiles/coder/SOUL.md").name,
        "coder"
    );
}

#[test]
fn an_unrelated_folder_with_profiles_is_not_hermes() {
    // The same files in a folder not named `hermes` stay undetected, so a
    // project with `config.yaml` and `profiles/` is never read as Hermes.
    let (_temp, project) = home("my-app");
    write(&project, "config.yaml", "model: x\n");
    write(&project, "profiles/coder/SOUL.md", "You write code.\n");
    assert_eq!(detect(&project), None);

    // A folder named `hermes` with no `config.yaml` is not a home either.
    let (_temp, bare) = home("hermes");
    write(&bare, "profiles/coder/SOUL.md", "You write code.\n");
    assert_eq!(detect(&bare), None);
}

#[test]
fn profile_names_and_descriptions_are_bounded_text() {
    let (_temp, root) = home(".hermes");
    write(&root, "config.yaml", "model: x\n");
    write(&root, "profiles/long/SOUL.md", "Persona.\n");
    write(
        &root,
        "profiles/long/profile.yaml",
        &format!(
            "display_name: \"{}\"\ndescription: \"{}\"\n",
            "n".repeat(300),
            "d".repeat(2000)
        ),
    );
    let long = agent(&root, "agent/profiles/long/SOUL.md");
    assert_eq!(long.name.chars().count(), 80);
    assert_eq!(long.description.unwrap().chars().count(), 500);

    // An unreadable `profile.yaml` costs the friendly name, not the bot.
    write(&root, "profiles/broken/SOUL.md", "Persona.\n");
    write(&root, "profiles/broken/profile.yaml", ": : not yaml [\n");
    assert_eq!(agent(&root, "agent/profiles/broken/SOUL.md").name, "broken");
}
