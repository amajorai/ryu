//! A fixture zip staged and read back, and what is left out or ignored.

use std::io::Write;
use std::time::Duration;

use serde_json::json;

use super::names::{classify, is_secret_file, parse_entry_name, EntryKind};
use super::payload::{parse_conversation, CopiedFiles};
use super::stage::{stage_archive_with, Limits};
use super::*;

/// A zip holding `entries` in order. Names are written as given.
pub(super) fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in entries {
        writer.start_file(*name, options).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

/// A manifest in this format that lists `bots`.
pub(super) fn manifest_of(bots: Value) -> Vec<u8> {
    serde_json::to_vec(&json!({
        "format": FORMAT,
        "version": VERSION,
        "source": { "app": "Grok Bot", "exported_at": "2026-11-17T10:00:00Z" },
        "bots": bots,
    }))
    .unwrap()
}

/// Write `bytes` as a zip file and stage it under a fresh temp folder, which
/// is returned so it lives as long as the test.
pub(super) fn stage_bytes(
    bytes: &[u8],
    limits: &Limits,
) -> (tempfile::TempDir, Result<StagedArchive, ArchiveError>) {
    let temp = tempfile::tempdir().unwrap();
    let zip_path = temp.path().join("export.zip");
    fs::write(&zip_path, bytes).unwrap();
    let result = stage_archive_with(&zip_path, &temp.path().join("staging"), limits);
    (temp, result)
}

const CHAT: &str = r#"{ "title": "First chat", "messages": [
    { "role": "user", "text": "Hello", "at": "2026-11-01T09:00:00Z" },
    { "role": "assistant", "text": "Hi", "at": "2026-11-01T09:00:05Z" } ] }"#;

/// Two bots: one with every part, one with instructions only. Plus one entry
/// outside the layout, one for a bot the manifest does not list, and one
/// credential file.
pub(super) fn fixture() -> Vec<u8> {
    let manifest = manifest_of(json!([
        {
            "key": "research",
            "name": "Research helper",
            "description": "Finds and sums up papers.",
            "routines": [{
                "name": "Morning digest",
                "schedule": "every day 08:00",
                "instruction": "Send the digest"
            }],
            "not_exported": ["conversation history before October"]
        },
        { "key": "writer", "name": "Writer" }
    ]));
    let skill =
        "---\nname: paper-summary\ndescription: Sum up a paper\n---\nRead it, then sum it up.\n";
    zip_of(&[
        (MANIFEST_FILE, &manifest),
        ("bots/research/instructions.md", b"You research topics.\n"),
        (
            "bots/research/memories.md",
            b"- The user reads papers on Friday\n- The user prefers short summaries\n",
        ),
        (
            "bots/research/skills/paper-summary/SKILL.md",
            skill.as_bytes(),
        ),
        (
            "bots/research/files/notes/reading-list.md",
            b"# Reading list\n",
        ),
        ("bots/research/files/data.bin", &[0, 159, 146, 150]),
        (
            "bots/research/conversations/first-chat.json",
            CHAT.as_bytes(),
        ),
        ("bots/writer/instructions.md", b"You write.\n"),
        ("README.txt", b"not part of the layout"),
        (
            "bots/ghost/instructions.md",
            b"A bot the manifest does not list.\n",
        ),
        ("bots/research/files/.env", b"API_KEY=1\n"),
    ])
}

#[test]
fn a_fixture_zip_is_staged_with_the_counts_of_what_was_unpacked() {
    let (_temp, staged) = stage_bytes(&fixture(), &Limits::default());
    let staged = staged.unwrap();
    let summary = &staged.summary;
    assert_eq!(summary.format, FORMAT);
    assert_eq!(summary.version, VERSION);
    assert_eq!(summary.source_app, "Grok Bot");
    assert_eq!(summary.bots.len(), 2);
    let research = &summary.bots[0];
    assert_eq!(research.name, "Research helper");
    assert_eq!(research.description, "Finds and sums up papers.");
    assert!(research.has_instructions);
    assert_eq!(
        (
            research.memories,
            research.skills,
            research.files,
            research.conversations
        ),
        (2, 1, 2, 1)
    );
    assert_eq!(research.routines.len(), 1);
    assert_eq!(research.routines[0].name, "Morning digest");
    assert_eq!(
        research.not_exported,
        vec!["conversation history before October"]
    );
    let writer = &summary.bots[1];
    assert!(writer.has_instructions);
    assert_eq!(
        (
            writer.memories,
            writer.skills,
            writer.files,
            writer.conversations
        ),
        (0, 0, 0, 0)
    );
    // README.txt and the unlisted bot are ignored; the .env file is left out.
    assert_eq!(summary.ignored_entries, 2);
    assert_eq!(summary.left_out_entries, 1);

    let root = &staged.root;
    let bot = root.join("bots").join("research");
    for rel in [
        "SOUL.md",
        "MEMORY.md",
        "skills/paper-summary/SKILL.md",
        ".ryu-payload/files/notes/reading-list.md",
        ".ryu-payload/files/data.bin",
        ".ryu-payload/conversations/first-chat.json",
    ] {
        assert!(bot.join(rel).is_file(), "{rel}");
    }
    assert_eq!(
        fs::read(bot.join(".ryu-payload/files/data.bin")).unwrap(),
        vec![0, 159, 146, 150]
    );
    assert!(!root.join("README.txt").exists());
    assert!(!root.join("bots").join("ghost").exists());
    assert!(!bot.join(".ryu-payload/files/.env").exists());
    assert!(is_staged_root(root));
    assert_eq!(read_staged_summary(root).as_ref(), Some(summary));
}

#[test]
fn the_same_zip_staged_twice_lands_in_the_same_folder() {
    let temp = tempfile::tempdir().unwrap();
    let zip_path = temp.path().join("export.zip");
    fs::write(&zip_path, fixture()).unwrap();
    let base = temp.path().join("staging");
    let first = stage_archive_with(&zip_path, &base, &Limits::default()).unwrap();
    fs::write(first.root.join("stray.txt"), "left by an earlier run").unwrap();
    let second = stage_archive_with(&zip_path, &base, &Limits::default()).unwrap();
    assert_eq!(first.root, second.root);
    assert_eq!(first.summary, second.summary);
    assert!(!second.root.join("stray.txt").exists());
    assert_eq!(fs::read_dir(&base).unwrap().count(), 1);
}

#[test]
fn counts_past_a_per_bot_cap_and_clashing_names_are_left_out() {
    let manifest = manifest_of(json!([{ "key": "a" }]));
    let bytes = zip_of(&[
        (MANIFEST_FILE, &manifest),
        ("bots/a/files/one.txt", b"1"),
        ("bots/a/files/ONE.txt", b"same name in another case"),
        ("bots/a/files/dir", b"a file"),
        ("bots/a/files/dir/inside.txt", b"its folder is a file"),
        ("bots/a/files/two.txt", b"2"),
        ("bots/a/files/three.txt", b"past the cap"),
        ("bots/a/files/con.txt", b"a device name on Windows"),
        ("bots/a/conversations/empty.json", b"{ \"messages\": [] }"),
        ("bots/a/instructions.md", b"  \n"),
    ]);
    let limits = Limits {
        files_per_bot: 3,
        ..Limits::default()
    };
    let (_temp, staged) = stage_bytes(&bytes, &limits);
    let staged = staged.unwrap();
    let bot = &staged.summary.bots[0];
    // one.txt, dir and two.txt fill the cap of 3.
    assert_eq!(bot.files, 3);
    assert_eq!(bot.conversations, 0);
    assert!(!bot.has_instructions);
    // ONE.txt (same name), dir/inside.txt (its folder is a file), three.txt
    // (past the cap), con.txt (not a file name on Windows), empty.json (no
    // message) and instructions.md (blank).
    assert_eq!(staged.summary.left_out_entries, 6);
    assert!(!staged
        .root
        .join("bots/a/.ryu-payload/files/three.txt")
        .exists());
    assert_eq!(staged.summary.ignored_entries, 0);
    assert_eq!(
        fs::read(staged.root.join("bots/a/.ryu-payload/files/one.txt")).unwrap(),
        b"1"
    );
}

#[test]
fn manifest_text_is_cut_to_one_bounded_line() {
    let manifest = manifest_of(json!([{
        "key": "a",
        "name": format!("Line one\nline two\u{7} {}", "x".repeat(200)),
        "description": "d".repeat(900),
        "not_exported": ["  spaced \t out  ", "", 7]
    }]));
    let (_temp, staged) = stage_bytes(&zip_of(&[(MANIFEST_FILE, &manifest)]), &Limits::default());
    let staged = staged.unwrap();
    let bot = &staged.summary.bots[0];
    assert_eq!(
        super::manifest::clean_line(" a\r\n\tb\u{7} c ", 10),
        "a b c"
    );
    assert!(bot.name.starts_with("Line one line two x"));
    assert_eq!(bot.name.chars().count(), 80);
    assert!(!bot.name.chars().any(char::is_control));
    assert_eq!(bot.description.chars().count(), 500);
    assert_eq!(bot.not_exported, vec!["spaced out"]);
}

#[test]
fn entry_names_are_refused_left_out_or_classified() {
    let parts = |name: &str| parse_entry_name(name).unwrap().unwrap();
    assert_eq!(parts("./bots//a/instructions.md").len(), 3);
    assert_eq!(parse_entry_name("bots/a/files/con.txt").unwrap(), None);
    assert_eq!(parse_entry_name("bots/a/files/a:b").unwrap(), None);
    assert_eq!(parse_entry_name("bots/a/files/trailing.").unwrap(), None);
    assert_eq!(parse_entry_name(&"a/".repeat(20)).unwrap(), None);
    assert_eq!(parse_entry_name(&"a".repeat(300)).unwrap(), None);
    assert!(matches!(
        parse_entry_name("bots\\a\\..\\..\\x"),
        Err(ArchiveError::PathTraversal(_))
    ));
    assert!(matches!(
        parse_entry_name("c:/x"),
        Err(ArchiveError::AbsolutePath(_))
    ));

    assert_eq!(classify(&parts(MANIFEST_FILE)), EntryKind::Manifest);
    assert_eq!(
        classify(&parts("bots/a/skills/s-1/SKILL.md")),
        EntryKind::Skill {
            bot: "a".to_string(),
            skill: "s-1".to_string()
        }
    );
    for unknown in [
        "nested/ryu-export.json",
        "bots/a/skills/s/extra/SKILL.md",
        "bots/a/skills/s/run.sh",
        "bots/a b/instructions.md",
        "bots/a/conversations/deep/x.json",
        "bots/a/conversations/x.txt",
        "bots/a/files",
        "bots/a/INSTRUCTIONS.md",
    ] {
        assert_eq!(classify(&parts(unknown)), EntryKind::Unknown, "{unknown}");
    }
    for secret in [
        ".env",
        ".env.local",
        "id_rsa",
        "server.pem",
        "Credentials.json",
    ] {
        assert!(is_secret_file(&[secret.to_string()]), "{secret}");
    }
    assert!(!is_secret_file(&["environment.md".to_string()]));
}

#[test]
fn a_transcript_keeps_user_and_assistant_text_only() {
    let transcript = parse_conversation(
        br#"{ "title": " Plan\nthe week ", "messages": [
            { "role": "system", "text": "hidden" },
            { "role": "User", "text": " Hello ", "at": 1700000000 },
            { "role": "assistant", "text": "" },
            { "role": "assistant", "text": "Hi", "at": "not a time" },
            { "role": "assistant", "text": 5 } ] }"#,
    )
    .unwrap();
    assert_eq!(transcript.title, "Plan the week");
    assert_eq!(transcript.messages.len(), 2);
    assert_eq!(transcript.messages[0].role, "user");
    assert_eq!(transcript.messages[0].content, "Hello");
    assert_eq!(transcript.messages[0].created_at, Some(1_700_000_000_000));
    assert_eq!(transcript.messages[1].created_at, None);
    assert!(parse_conversation(b"[]").is_none());
    assert!(
        parse_conversation(b"{ \"messages\": [{ \"role\": \"system\", \"text\": \"x\" }] }")
            .is_none()
    );
    assert!(parse_conversation(b"not json").is_none());
}

#[test]
fn a_staged_bot_gives_back_its_conversations_and_files() {
    let (temp, staged) = stage_bytes(&fixture(), &Limits::default());
    let root = staged.unwrap().root;
    assert_eq!(bot_key_of_item(&bot_item_id("research")), Some("research"));
    assert_eq!(bot_key_of_item("conversations/bots/../x"), None);
    assert_eq!(
        bot_key_of_item("conversations/conversations.json#chats"),
        None
    );
    assert_eq!(
        staged_bot(&root, "research").unwrap().name,
        "Research helper"
    );
    assert!(staged_bot(&root, "ghost").is_none());

    let conversations = read_bot_conversations(&root, "research");
    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].id, "research/first-chat");
    assert_eq!(conversations[0].title, "First chat");
    assert_eq!(conversations[0].messages.len(), 2);
    assert!(read_bot_conversations(&root, "writer").is_empty());

    assert_eq!(
        bot_files(&root, "research"),
        vec![
            vec!["data.bin".to_string()],
            vec!["notes".to_string(), "reading-list.md".to_string()],
        ]
    );
    let folder = temp.path().join("project");
    fs::create_dir_all(folder.join(FILES_DIR)).unwrap();
    fs::write(
        folder.join(FILES_DIR).join("data.bin"),
        "the user's own file",
    )
    .unwrap();
    let first = copy_bot_files(&root, "research", &folder).unwrap();
    assert_eq!(
        first,
        CopiedFiles {
            copied: 1,
            unchanged: 0,
            kept: vec!["files/data.bin".to_string()],
        }
    );
    assert_eq!(
        fs::read_to_string(folder.join("files/data.bin")).unwrap(),
        "the user's own file"
    );
    assert_eq!(
        fs::read_to_string(folder.join("files/notes/reading-list.md")).unwrap(),
        "# Reading list\n"
    );
    let second = copy_bot_files(&root, "research", &folder).unwrap();
    assert_eq!(
        (second.copied, second.unchanged, second.kept.len()),
        (0, 1, 1)
    );
}

#[test]
fn only_a_staging_folder_is_discarded_and_old_ones_are_swept() {
    let (temp, staged) = stage_bytes(&fixture(), &Limits::default());
    let root = staged.unwrap().root;
    let base = temp.path().join("staging");
    let other = temp.path().join("other");
    fs::create_dir_all(other.join("bots")).unwrap();
    fs::copy(root.join(MANIFEST_FILE), other.join(MANIFEST_FILE)).unwrap();
    let plain = base.join("plain");
    fs::create_dir_all(&plain).unwrap();

    // Outside the staging base, the base itself, and a child that is not staged.
    assert!(!discard_staged(&base, &other));
    assert!(!discard_staged(&base, &base));
    assert!(!discard_staged(&base, &plain));
    assert!(!discard_staged(&base, &root.join("bots")));
    assert!(other.is_dir() && plain.is_dir() && root.is_dir());

    assert_eq!(sweep_stale(&base, Duration::from_secs(3600)), 0);
    assert!(discard_staged(&base, &root));
    assert!(!root.exists());
    fs::write(base.join("upload.part"), "left by an interrupted upload").unwrap();
    assert_eq!(sweep_stale(&base, Duration::ZERO), 2);
    assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
}

#[test]
fn the_migrator_prompt_names_what_this_reader_accepts() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../desktop/src/lib/grok-bot-migrator.ts"
    );
    let prompt = fs::read_to_string(path).expect("the migrator prompt ships with the desktop app");
    for wanted in [
        MANIFEST_FILE.to_string(),
        format!("\"format\": \"{FORMAT}\""),
        format!("\"version\": {VERSION}"),
        "bots/<key>/instructions.md".to_string(),
        "bots/<key>/memories.md".to_string(),
        "bots/<key>/skills/<skill-name>/SKILL.md".to_string(),
        "bots/<key>/files/".to_string(),
        "bots/<key>/conversations/<name>.json".to_string(),
        "\"routines\"".to_string(),
        "\"not_exported\"".to_string(),
    ] {
        assert!(prompt.contains(&wanted), "{wanted}");
    }
    // The paths the prompt shows, with real names filled in, are entries.
    let parts = |name: &str| parse_entry_name(name).unwrap().unwrap();
    for name in [
        "bots/trip-planner/instructions.md",
        "bots/trip-planner/memories.md",
        "bots/trip-planner/skills/pack_list/SKILL.md",
        "bots/trip-planner/files/2026/plan.pdf",
        "bots/trip-planner/conversations/chat-1.json",
    ] {
        assert_ne!(classify(&parts(name)), EntryKind::Unknown, "{name}");
    }
}
