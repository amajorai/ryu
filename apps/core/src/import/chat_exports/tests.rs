use super::*;
use serde_json::json;

fn temp_tree() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-chat-export-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&dir).unwrap();
    dir.canonicalize().unwrap()
}

fn chatgpt_conversation(id: &str, gizmo: Option<&str>, updated: f64) -> Value {
    json!({
        "title": format!("Chat {id}"),
        "create_time": 1_700_000_000.0,
        "update_time": updated,
        "conversation_id": id,
        "gizmo_id": gizmo,
        "current_node": "a2",
        "mapping": {
            "root": { "id": "root", "message": null, "parent": null, "children": ["sys"] },
            "sys": { "id": "sys", "parent": "root", "children": ["u1"], "message": {
                "author": { "role": "system" },
                "content": { "content_type": "user_editable_context",
                    "user_profile": "The user provided the following information about themselves. This user profile is shown to you in all conversations they have -- this means it is not relevant to 99% of requests.\n```I am a Rust developer in Lisbon.```",
                    "user_instructions": "The user provided the additional info about how they would like you to respond:\n```Be concise.```" },
                "metadata": { "is_visually_hidden_from_conversation": true } } },
            "u1": { "id": "u1", "parent": "sys", "children": ["a1"], "message": {
                "author": { "role": "user" }, "create_time": 1_700_000_001.0,
                "content": { "content_type": "multimodal_text", "parts": [
                    { "content_type": "image_asset_pointer", "asset_pointer": "file-service://x" }, "What is this?" ] } } },
            "a1": { "id": "a1", "parent": "u1", "children": ["a2", "a1b"], "message": {
                "author": { "role": "assistant" }, "create_time": 1_700_000_002.0,
                "content": { "content_type": "thoughts", "thoughts": [] } } },
            "a1b": { "id": "a1b", "parent": "a1", "children": [], "message": {
                "author": { "role": "assistant" }, "content": { "content_type": "text", "parts": ["abandoned branch"] } } },
            "a2": { "id": "a2", "parent": "a1", "children": [], "message": {
                "author": { "role": "assistant" }, "create_time": 1_700_000_003.0,
                "content": { "content_type": "text", "parts": ["It is a cat."] } } }
        }
    })
}

#[test]
fn chatgpt_export_groups_projects_and_walks_the_visible_branch() {
    let root = temp_tree();
    let export = json!([
        chatgpt_conversation("c1", None, 10.0),
        chatgpt_conversation("c2", Some("g-p-abcdef123456"), 20.0),
        chatgpt_conversation("c3", Some("g-p-abcdef123456"), 5.0),
        chatgpt_conversation("c4", Some("g-abc"), 1.0),
    ]);
    fs::write(root.join("conversations.json"), export.to_string()).unwrap();
    assert_eq!(detect(&root), Some(ExportSource::ChatGpt));

    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("chatgpt"));
    let ids: Vec<&str> = scan.items.iter().map(|i| i.id.as_str()).collect();
    assert!(
        ids.contains(&"conversations/conversations.json#chats"),
        "{ids:?}"
    );
    assert!(
        ids.contains(&"conversations/conversations.json#g-p-abcdef123456"),
        "{ids:?}"
    );
    assert!(
        ids.contains(&"memory/conversations.json#saved-context"),
        "{ids:?}"
    );
    let chats = scan
        .items
        .iter()
        .find(|i| i.id.ends_with("#chats"))
        .unwrap();
    assert_eq!(chats.title, "Chats from ChatGPT (2)");

    let group = read_group(&root, ExportSource::ChatGpt, UNGROUPED).unwrap();
    assert_eq!(group.len(), 2);
    let first = &group[0];
    assert_eq!(first.messages.len(), 2);
    assert_eq!(first.messages[0].role, "user");
    assert_eq!(first.messages[0].content, "[image]\n\nWhat is this?");
    assert_eq!(first.messages[0].created_at, Some(1_700_000_001_000));
    assert_eq!(first.messages[1].content, "It is a cat.");

    let context = saved_context(&root, ExportSource::ChatGpt);
    assert_eq!(
        context[0],
        ("I am a Rust developer in Lisbon.".to_string(), true)
    );
    assert_eq!(context[1].0, "How the user wants responses: Be concise.");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn claude_export_reads_projects_docs_memories_and_messages() {
    let root = temp_tree();
    let export = json!([
        { "uuid": "conv-1", "name": "Plan the launch", "created_at": "2026-01-02T03:04:05Z",
          "chat_messages": [
            { "uuid": "m1", "sender": "human", "text": "Help me plan", "created_at": "2026-01-02T03:04:05Z",
              "content": [{ "type": "text", "text": "Help me plan" }],
              "attachments": [{ "file_name": "brief.pdf", "extracted_content": "..." }] },
            { "uuid": "m2", "sender": "assistant", "text": "", "created_at": "2026-01-02T03:04:09.500Z",
              "content": [{ "type": "text", "text": "Here is a plan." }, { "type": "tool_use", "name": "web_search" }] }
          ] },
        { "uuid": "conv-2", "name": "Project chat", "project_uuid": "proj-1",
          "chat_messages": [{ "sender": "human", "text": "Hi", "content": [] }] }
    ]);
    fs::write(root.join("conversations.json"), export.to_string()).unwrap();
    fs::write(
            root.join("projects.json"),
            json!([
                { "uuid": "proj-1", "name": "Research / Notes", "description": "Papers",
                  "prompt_template": "Cite sources.", "docs": [{ "filename": "reading.md", "content": "# List" }] },
                { "uuid": "proj-2", "name": "Empty", "prompt_template": "", "docs": [] }
            ])
            .to_string(),
        )
        .unwrap();
    fs::write(
        root.join("memories.json"),
        json!([{ "conversations_memory": "- Works at Acme\n- Prefers tables", "account_uuid": "x",
                     "project_memories": { "proj-1": "Focus on 2025 papers." } }])
        .to_string(),
    )
    .unwrap();
    assert_eq!(detect(&root), Some(ExportSource::Claude));
    let scan = super::super::scan_source(&root).unwrap();
    assert_eq!(scan.source, Some("claude-ai"));
    let titles: Vec<&str> = scan.items.iter().map(|i| i.title.as_str()).collect();
    assert!(titles.contains(&"Chats from Claude (1)"), "{titles:?}");
    assert!(
        titles.contains(&"Project 'Research / Notes' from Claude (1 chat)"),
        "{titles:?}"
    );
    assert!(
        titles.contains(&"Project 'Empty' from Claude"),
        "{titles:?}"
    );
    assert!(titles.contains(&"Claude memory"), "{titles:?}");

    let chats = read_group(&root, ExportSource::Claude, UNGROUPED).unwrap();
    assert_eq!(
        chats[0].messages[0].content,
        "Help me plan\n\n[attached: brief.pdf]"
    );
    assert_eq!(
        chats[0].messages[1].content,
        "Here is a plan.\n\n[used web_search]"
    );
    assert_eq!(chats[0].messages[1].created_at, Some(1_767_323_049_500));

    let memories = saved_context(&root, ExportSource::Claude);
    assert_eq!(
        memories.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>(),
        vec!["Works at Acme", "Prefers tables"]
    );

    let base = root.join("out");
    let project = project_for(&root, ExportSource::Claude, "proj-1").unwrap();
    let folder = ensure_project_folder(&base, ExportSource::Claude, &project)
        .unwrap()
        .path;
    assert_eq!(folder, base.join("Research - Notes"));
    let agents = fs::read_to_string(folder.join("AGENTS.md")).unwrap();
    assert!(agents.contains("Cite sources.") && agents.contains("knowledge/reading.md"));
    assert!(agents.contains("## Project memory") && agents.contains("Focus on 2025 papers."));
    assert_eq!(
        fs::read_to_string(folder.join("knowledge/reading.md")).unwrap(),
        "# List"
    );
    // Re-import reuses the owned folder; an unrelated same-name folder is never touched.
    assert_eq!(
        ensure_project_folder(&base, ExportSource::Claude, &project)
            .unwrap()
            .path,
        folder
    );
    fs::create_dir_all(base.join("Empty")).unwrap();
    let empty = project_for(&root, ExportSource::Claude, "proj-2").unwrap();
    let other = ensure_project_folder(&base, ExportSource::Claude, &empty)
        .unwrap()
        .path;
    assert_eq!(other, base.join("Empty (Claude 2)"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn reimport_refreshes_unedited_project_files_and_keeps_user_edits() {
    let base = temp_tree();
    let mut project = ExportProject {
        id: "proj-1".to_string(),
        name: "Research".to_string(),
        instructions: "Cite sources.".to_string(),
        docs: vec![("reading.md".to_string(), "# List".to_string())],
        ..ExportProject::default()
    };
    let first = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
    assert!(first.kept.is_empty());
    let folder = first.path;

    // Untouched since the last import: a newer export refreshes it.
    project.instructions = "Cite primary sources.".to_string();
    let again = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
    assert_eq!(again.path, folder);
    assert!(again.kept.is_empty());
    let agents = fs::read_to_string(folder.join("AGENTS.md")).unwrap();
    assert!(agents.contains("Cite primary sources."), "{agents}");

    // Edited by the user: later imports leave it, even with no changes.
    fs::write(folder.join("AGENTS.md"), "# My own guidance\n").unwrap();
    fs::write(folder.join("knowledge/reading.md"), "# My notes").unwrap();
    for instructions in ["Cite primary sources.", "Cite everything."] {
        project.instructions = instructions.to_string();
        let reimport = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
        assert_eq!(reimport.path, folder);
        assert_eq!(reimport.kept, vec!["AGENTS.md", "knowledge/reading.md"]);
        assert_eq!(
            fs::read_to_string(folder.join("AGENTS.md")).unwrap(),
            "# My own guidance\n"
        );
        assert_eq!(
            fs::read_to_string(folder.join("knowledge/reading.md")).unwrap(),
            "# My notes"
        );
    }

    // Deleted by the user: the next import writes it again.
    fs::remove_file(folder.join("AGENTS.md")).unwrap();
    let restored = ensure_project_folder(&base, ExportSource::Claude, &project).unwrap();
    assert_eq!(restored.kept, vec!["knowledge/reading.md"]);
    assert!(fs::read_to_string(folder.join("AGENTS.md"))
        .unwrap()
        .contains("Cite everything."));
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn split_chatgpt_export_names_an_existing_saved_context_file() {
    let root = temp_tree();
    fs::write(
        root.join("conversations-000.json"),
        json!([chatgpt_conversation("c1", None, 10.0)]).to_string(),
    )
    .unwrap();
    fs::write(
        root.join("conversations-001.json"),
        json!([chatgpt_conversation("c2", Some("g-p-abcdef123456"), 20.0)]).to_string(),
    )
    .unwrap();
    assert_eq!(detect(&root), Some(ExportSource::ChatGpt));
    let scan = super::super::scan_source(&root).unwrap();
    let saved = scan
        .items
        .iter()
        .find(|item| item.kind == kind::MEMORY)
        .expect("custom instructions are offered");
    assert_eq!(saved.id, "memory/conversations-000.json#saved-context");
    assert!(super::super::resolve_item_path(&root, &saved.id).is_ok());

    // Both groups come from one pass over both parts.
    let groups = BTreeSet::from([UNGROUPED.to_string(), "g-p-abcdef123456".to_string()]);
    let read = read_groups(&root, ExportSource::ChatGpt, &groups).unwrap();
    assert_eq!(read[UNGROUPED][0].id, "c1");
    assert_eq!(read["g-p-abcdef123456"][0].id, "c2");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn split_export_size_limit_covers_all_parts_together() {
    let root = temp_tree();
    // Each part is under the limit on its own; together they are over it.
    // Sparse files: nothing is read because the total is checked first.
    for part in ["conversations-000.json", "conversations-001.json"] {
        let file = fs::File::create(root.join(part)).unwrap();
        file.set_len(MAX_EXPORT_BYTES / 2 + 1).unwrap();
    }
    let error = conversations(&root).unwrap_err().to_string();
    assert!(error.contains("conversation files total"), "{error}");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn chatgpt_records_messages_on_branches_the_user_left() {
    let conversation = parse_chatgpt(&chatgpt_conversation("c1", None, 10.0)).unwrap();
    assert_eq!(conversation.messages.len(), 2);
    assert!(conversation.is_superseded("assistant", "abandoned branch", 123));
    assert!(!conversation.is_superseded("assistant", "It is a cat.", 1_700_000_003_000));
    assert!(!conversation.is_superseded("user", "abandoned branch", 123));
}

#[test]
fn unrelated_conversations_json_is_not_an_export() {
    let root = temp_tree();
    fs::write(root.join("conversations.json"), r#"{"conversations": []}"#).unwrap();
    assert_eq!(detect(&root), None);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn chatgpt_scan_items_and_warnings_carry_core_messages() {
    use crate::i18n::messages;
    let root = temp_tree();
    let export = json!([
        chatgpt_conversation("c1", None, 10.0),
        chatgpt_conversation("c2", Some("g-p-abcdef123456"), 20.0),
        chatgpt_conversation("c3", Some("g-p-abcdef123456"), 5.0),
    ]);
    fs::write(root.join("conversations.json"), export.to_string()).unwrap();
    let scan = super::super::scan_source(&root).unwrap();
    let source = |message: &Message| message.source().to_owned();
    let template = |t: crate::i18n::Template| Message::new(t).source().to_owned();

    // Every title travels as a message whose English rendering is the title.
    for item in &scan.items {
        let title = item.title_i18n.as_ref().expect("title message");
        assert_eq!(super::super::english(title), item.title, "{}", item.id);
    }
    let chats = scan
        .items
        .iter()
        .find(|i| i.id.ends_with("#chats"))
        .unwrap();
    assert_eq!(
        source(chats.title_i18n.as_ref().unwrap()),
        template(messages::IMPORT_EXPORT_CHATS_TITLE_MESSAGE)
    );
    let project = scan
        .items
        .iter()
        .find(|i| i.id.ends_with("#g-p-abcdef123456"))
        .unwrap();
    assert_eq!(
        source(project.title_i18n.as_ref().unwrap()),
        template(messages::IMPORT_EXPORT_PROJECT_CHATS_TITLE_MESSAGE)
    );
    let details: Vec<String> = project.detail_i18n.iter().map(source).collect();
    assert_eq!(
        details,
        [
            template(messages::IMPORT_LATEST_CHAT_DETAIL_MESSAGE),
            template(messages::IMPORT_PROJECT_FOLDER_DETAIL_MESSAGE),
        ]
    );
    assert_eq!(
        project.detail.as_deref(),
        Some("Latest chat: “Chat c2”. Becomes a project folder.")
    );
    let saved = scan
        .items
        .iter()
        .find(|i| i.id.ends_with("#saved-context"))
        .unwrap();
    assert_eq!(saved.title, "ChatGPT custom instructions");

    // Warnings keep their English strings and add the same text as messages.
    let notices: Vec<String> = scan
        .warning_notices
        .iter()
        .map(|notice| source(notice.i18n.as_ref().unwrap()))
        .collect();
    assert_eq!(
        notices,
        [
            template(messages::IMPORT_CHATGPT_NO_PROJECTS_WARNING_MESSAGE),
            template(messages::IMPORT_EXPORT_PLACEHOLDERS_WARNING_MESSAGE),
        ]
    );
    let english: Vec<&str> = scan
        .warning_notices
        .iter()
        .map(|n| n.message.as_str())
        .collect();
    assert_eq!(scan.warnings, english);

    // The wire form: the English fields plus `{ message, args }` objects.
    let wire = serde_json::to_value(&scan).unwrap();
    let item = wire["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["id"].as_str().unwrap().ends_with("#g-p-abcdef123456"))
        .unwrap();
    assert_eq!(item["title_i18n"]["args"]["count"]["number"], json!(2.0));
    assert_eq!(item["title_i18n"]["args"]["source"], json!("ChatGPT"));
    assert_eq!(item["detail_i18n"][0]["args"]["title"], json!("Chat c2"));
    assert_eq!(
        wire["warning_notices"][1]["i18n"]["args"]["source"],
        json!("ChatGPT")
    );
    let _ = fs::remove_dir_all(&root);
}
