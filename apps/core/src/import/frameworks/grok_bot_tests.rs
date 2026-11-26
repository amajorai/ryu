//! A staged bot export archive scans as one agent, one memory file, the
//! skills and one "files and chats" item per bot, and nothing a user file
//! holds is offered as setup.

use std::io::Write;

use serde_json::json;

use super::*;
use crate::import::bot_archive::{stage_archive, FORMAT, MANIFEST_FILE, VERSION};
use crate::import::{parse_agent_item, resolve_agent_item, scan_source};

const CHAT: &str = r#"{ "title": "First chat", "messages": [
    { "role": "user", "text": "Hello" }, { "role": "assistant", "text": "Hi" } ] }"#;
const SKILL: &str = "---\nname: paper-summary\ndescription: Sum up a paper\n---\nRead it.\n";
/// Instructions that open with front matter, the shape of a Codex subagent.
const FRONT_MATTER: &str =
    "---\nname: other-name\nmodel: some/model\ntools: [shell]\n---\nYou write.\n";

/// Stage a zip with two full bots and one bot whose key is `memory`. The temp
/// folder is returned so it lives as long as the test.
fn staged() -> (tempfile::TempDir, PathBuf) {
    let manifest = serde_json::to_vec(&json!({
        "format": FORMAT,
        "version": VERSION,
        "source": { "app": "Grok Bot" },
        "bots": [
            {
                "key": "research",
                "name": "Research helper",
                "description": "Finds and sums up papers.",
                "routines": [{ "name": "Morning digest", "schedule": "every day 08:00" }],
                "not_exported": ["older conversations"]
            },
            { "key": "writer", "name": "Writer" },
            { "key": "memory", "name": "Notes" }
        ]
    }))
    .unwrap();
    let entries: &[(&str, &[u8])] = &[
        (MANIFEST_FILE, &manifest),
        ("bots/research/instructions.md", b"You research topics.\n"),
        (
            "bots/research/memories.md",
            b"- Reads on Friday\n- Likes short answers\n",
        ),
        (
            "bots/research/skills/paper-summary/SKILL.md",
            SKILL.as_bytes(),
        ),
        ("bots/research/files/reading-list.md", b"# Reading list\n"),
        ("bots/research/files/tool/SKILL.md", SKILL.as_bytes()),
        (
            "bots/research/files/plugin/manifest.json",
            b"{ \"id\": \"x\", \"name\": \"x\" }",
        ),
        (
            "bots/research/conversations/first-chat.json",
            CHAT.as_bytes(),
        ),
        ("bots/writer/instructions.md", FRONT_MATTER.as_bytes()),
        ("bots/memory/skills/note-taking/SKILL.md", b"Take notes.\n"),
        ("stray.txt", b"ignored"),
    ];
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries.iter().copied() {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    let temp = tempfile::tempdir().unwrap();
    let zip_path = temp.path().join("export.zip");
    fs::write(&zip_path, writer.finish().unwrap().into_inner()).unwrap();
    let staged = stage_archive(&zip_path, &temp.path().join("staging")).unwrap();
    let root = staged.root.canonicalize().unwrap();
    (temp, root)
}

#[test]
fn a_staged_archive_scans_as_agents_memory_skills_and_one_item_per_bot() {
    let (_temp, root) = staged();
    assert_eq!(detect(&root), Some(Framework::GrokBot));
    let scan = scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("grok-bot"));
    let of = |wanted: &str| -> Vec<(String, String)> {
        scan.items
            .iter()
            .filter(|item| item.kind == wanted)
            .map(|item| (item.id.clone(), item.title.clone()))
            .collect()
    };
    assert_eq!(
        of(kind::AGENT),
        vec![
            (
                "agent/bots/research/SOUL.md".to_string(),
                "Agent 'Research helper' from Grok Bot".to_string()
            ),
            (
                "agent/bots/writer/SOUL.md".to_string(),
                "Agent 'Writer' from Grok Bot".to_string()
            ),
        ]
    );
    assert_eq!(
        of(kind::MEMORY),
        vec![(
            "memory/bots/research/MEMORY.md".to_string(),
            "Memory Research helper from Grok Bot (2 entries)".to_string()
        )]
    );
    // The skills of every bot, a bot keyed `memory` included, and nothing
    // from a bot's own files (`files/tool/SKILL.md`).
    let mut skills: Vec<String> = of(kind::SKILL).into_iter().map(|(id, _)| id).collect();
    skills.sort();
    assert_eq!(
        skills,
        vec![
            "skill/bots/memory/skills/note-taking".to_string(),
            "skill/bots/research/skills/paper-summary".to_string(),
        ]
    );
    assert!(of(kind::PLUGIN).is_empty(), "{:?}", of(kind::PLUGIN));
    assert_eq!(
        of(kind::CONVERSATIONS),
        vec![(
            "conversations/bots/research".to_string(),
            "Project 'Research helper' from Grok Bot (1 chat)".to_string()
        )]
    );
    let files_item = scan
        .items
        .iter()
        .find(|item| item.kind == kind::CONVERSATIONS)
        .unwrap();
    assert_eq!(
        files_item.detail.as_deref(),
        Some("Becomes a project folder. Adds 3 knowledge files.")
    );
    let warnings = scan.warnings.join("\n");
    assert!(
        warnings.contains("Morning digest (every day 08:00)"),
        "{warnings}"
    );
    assert!(warnings.contains("older conversations"), "{warnings}");
    assert!(
        warnings.contains("Not part of a bot export and ignored: 1 entry of the zip."),
        "{warnings}"
    );
}

#[test]
fn a_bot_is_named_by_the_manifest_and_its_front_matter_stays_text() {
    let (_temp, root) = staged();
    let agent = |id: &str| {
        let (path, index) = resolve_agent_item(&root, id).unwrap();
        parse_agent_item(&root, &path, index).unwrap()
    };
    let research = agent("agent/bots/research/SOUL.md");
    assert_eq!(research.name, "Research helper");
    assert_eq!(
        research.description.as_deref(),
        Some("Finds and sums up papers.")
    );
    assert!(research.system_prompt.contains("You research topics."));
    assert_eq!(research.model, None);

    let writer = agent("agent/bots/writer/SOUL.md");
    assert_eq!(writer.name, "Writer");
    assert_eq!(
        writer.description.as_deref(),
        Some("Migrated from Grok Bot.")
    );
    assert!(writer.tools.is_empty());
    assert_eq!(writer.model, None);
    assert!(writer.system_prompt.contains("name: other-name"));
    assert!(writer.system_prompt.contains("You write."));
}
