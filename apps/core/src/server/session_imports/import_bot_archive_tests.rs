//! A fixture zip, staged, then imported through the production handlers:
//! agents, memory, the files and the chats of a bot. A second import of the
//! same zip adds nothing.

use std::io::Write;

use super::*;
use crate::import::bot_archive::{stage_archive, FORMAT, MANIFEST_FILE, ORIGIN, VERSION};
use crate::import::{kind, scan_source, ImportSelection};
use crate::server::memory::MemoryFilter;

const CHAT: &str = r#"{ "title": "First chat", "messages": [
    { "role": "user", "text": "Hello", "at": "2026-11-01T09:00:00Z" },
    { "role": "assistant", "text": "Hi", "at": "2026-11-01T09:00:05Z" } ] }"#;

/// A staged archive with two bots. The first has every part.
fn staged(directory: &std::path::Path) -> std::path::PathBuf {
    let manifest = serde_json::to_vec(&json!({
        "format": FORMAT,
        "version": VERSION,
        "source": { "app": "Grok Bot" },
        "bots": [
            { "key": "research", "name": "Archive Research Helper", "description": "Sums up papers." },
            { "key": "writer", "name": "Archive Writer" }
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
            "bots/research/files/notes/reading-list.md",
            b"# Reading list\n",
        ),
        (
            "bots/research/conversations/first-chat.json",
            CHAT.as_bytes(),
        ),
        ("bots/writer/instructions.md", b"You write.\n"),
    ];
    let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries.iter().copied() {
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    let zip_path = directory.join("export.zip");
    std::fs::write(&zip_path, writer.finish().unwrap().into_inner()).unwrap();
    let staged = stage_archive(&zip_path, &directory.join("staging")).unwrap();
    staged.root.canonicalize().unwrap()
}

#[tokio::test]
async fn a_staged_archive_imports_once_and_a_second_run_adds_nothing() {
    let directory = tempfile::tempdir().unwrap();
    let root = staged(directory.path());
    let projects = directory.path().join("projects");
    let mut state = isolated_plugin_hook_test_state(directory.path());
    state.agent_store = crate::agents::AgentStore::open_in_memory(&state.agents).unwrap();
    let agents_before = state.agent_store.list().await.unwrap().len();

    let scan = scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("grok-bot"));
    let selections = |wanted: &[&str]| -> Vec<ImportSelection> {
        scan.items
            .iter()
            .filter(|item| wanted.contains(&item.kind))
            .map(|item| ImportSelection {
                kind: item.kind.to_string(),
                id: item.id.clone(),
            })
            .collect()
    };
    let setup = selections(&[kind::AGENT, kind::MEMORY]);
    assert_eq!(setup.len(), 3, "{setup:?}");
    let files = selections(&[kind::CONVERSATIONS]);
    assert_eq!(files.len(), 1, "{files:?}");
    assert_eq!(files[0].id, "conversations/bots/research");

    let first = apply_import_selections(&state, &None, &root, setup.clone()).await;
    assert!(
        first.iter().all(|outcome| outcome.status == "imported"),
        "{first:?}"
    );
    let agents = state.agent_store.list().await.unwrap();
    assert_eq!(agents.len(), agents_before + 2);
    for name in ["Archive Research Helper", "Archive Writer"] {
        assert!(agents.iter().any(|agent| agent.name == name), "{name}");
    }
    let memories = state.memory.list(&MemoryFilter::default()).await.unwrap();
    assert_eq!(memories.len(), 2, "{memories:?}");

    let imported =
        import_bot_archive_item_into(&state, &None, &root, &files[0], Some(projects.clone())).await;
    assert_eq!(imported.status, "imported", "{:?}", imported.detail);
    let folder = std::path::PathBuf::from(imported.folder_path.clone().unwrap());
    assert_eq!(folder, projects.join("Archive Research Helper"));
    assert_eq!(
        std::fs::read_to_string(folder.join("files/notes/reading-list.md")).unwrap(),
        "# Reading list\n"
    );
    let agents_md = std::fs::read_to_string(folder.join("AGENTS.md")).unwrap();
    assert!(agents_md.contains("Imported from Grok Bot."), "{agents_md}");
    let tenancy = caller_tenancy(&None);
    let (conversation, _) = state
        .conversations
        .find_imported_conversation_with_generation(ORIGIN, "research/first-chat", &tenancy)
        .await
        .unwrap()
        .expect("the chat is findable by its archive id");
    let messages = state
        .conversations
        .get_messages(&conversation)
        .await
        .unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| (m.role.as_str(), m.content.as_str()))
            .collect::<Vec<_>>(),
        vec![("user", "Hello"), ("assistant", "Hi")]
    );

    // The same archive again: no new agent, memory, chat or file.
    let second = apply_import_selections(&state, &None, &root, setup).await;
    assert!(
        second
            .iter()
            .all(|outcome| outcome.status == "skipped" && outcome.already_exists),
        "{second:?}"
    );
    assert_eq!(
        state.agent_store.list().await.unwrap().len(),
        agents_before + 2
    );
    assert_eq!(
        state
            .memory
            .list(&MemoryFilter::default())
            .await
            .unwrap()
            .len(),
        2
    );
    let again =
        import_bot_archive_item_into(&state, &None, &root, &files[0], Some(projects.clone())).await;
    assert_eq!(again.status, "skipped", "{:?}", again.detail);
    assert!(again.already_exists);
    assert_eq!(std::fs::read_dir(&projects).unwrap().count(), 1);
}

#[tokio::test]
async fn an_item_that_names_no_bot_of_the_archive_fails_without_writing() {
    let directory = tempfile::tempdir().unwrap();
    let root = staged(directory.path());
    let projects = directory.path().join("projects");
    let state = isolated_plugin_hook_test_state(directory.path());
    for id in [
        "conversations/bots/ghost",
        "conversations/bots/../research",
        "conversations/conversations.json#chats",
    ] {
        let selection = ImportSelection {
            kind: kind::CONVERSATIONS.to_string(),
            id: id.to_string(),
        };
        let outcome =
            import_bot_archive_item_into(&state, &None, &root, &selection, Some(projects.clone()))
                .await;
        assert_eq!(outcome.status, "failed", "{id}");
    }
    assert!(!projects.exists());
}
