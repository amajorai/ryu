//! ChatGPT export on disk -> production import handler -> conversation store,
//! including the re-import that only appends new messages and the re-import of
//! a conversation whose earlier prompt was edited in ChatGPT.
use super::*;

fn chatgpt_export(messages: &[(&str, &str)]) -> serde_json::Value {
    let mut mapping = serde_json::Map::new();
    mapping.insert(
        "root".into(),
        json!({ "id": "root", "message": null, "parent": null, "children": ["m0"] }),
    );
    for (index, (role, text)) in messages.iter().enumerate() {
        let id = format!("m{index}");
        let parent = if index == 0 {
            "root".to_string()
        } else {
            format!("m{}", index - 1)
        };
        let children: Vec<String> = if index + 1 < messages.len() {
            vec![format!("m{}", index + 1)]
        } else {
            Vec::new()
        };
        mapping.insert(
            id.clone(),
            json!({ "id": id, "parent": parent, "children": children, "message": {
                "author": { "role": role },
                "create_time": 1_700_000_000.0 + index as f64,
                "content": { "content_type": "text", "parts": [text] } } }),
        );
    }
    json!([{
        "conversation_id": "chatgpt-conv-1",
        "title": "Trip planning",
        "create_time": 1_700_000_000.0,
        "update_time": 1_700_000_100.0,
        "current_node": format!("m{}", messages.len() - 1),
        "mapping": mapping,
    }])
}

#[tokio::test]
async fn chatgpt_export_imports_once_and_reimport_appends_only_new_messages() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("chatgpt-export");
    std::fs::create_dir_all(&source).unwrap();
    let source = source.canonicalize().unwrap();
    let export = source.join("conversations.json");
    std::fs::write(
        &export,
        chatgpt_export(&[("user", "Plan Lisbon"), ("assistant", "Day 1: Alfama")]).to_string(),
    )
    .unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());

    let scan = crate::import::scan_source(&source).unwrap();
    assert_eq!(scan.source, Some("chatgpt"));
    let item = scan
        .items
        .iter()
        .find(|item| item.kind == crate::import::kind::CONVERSATIONS)
        .unwrap();
    let selection = crate::import::ImportSelection {
        kind: crate::import::kind::CONVERSATIONS.into(),
        id: item.id.clone(),
    };

    let first = import_chat_export_item(&state, &None, &source, &selection, None).await;
    assert_eq!(first.status, "imported", "{:?}", first.detail);
    assert!(first
        .detail
        .as_deref()
        .unwrap()
        .starts_with("1 new, 0 updated"));
    let tenancy = caller_tenancy(&None);
    let (conversation, _) = state
        .conversations
        .find_imported_conversation_with_generation("import:chatgpt", "chatgpt-conv-1", &tenancy)
        .await
        .unwrap()
        .expect("imported conversation is findable by its ChatGPT id");
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
        vec![("user", "Plan Lisbon"), ("assistant", "Day 1: Alfama")]
    );

    let again = import_chat_export_item(&state, &None, &source, &selection, None).await;
    assert_eq!(again.status, "skipped");
    assert!(again.already_exists);

    std::fs::write(
        &export,
        chatgpt_export(&[
            ("user", "Plan Lisbon"),
            ("assistant", "Day 1: Alfama"),
            ("user", "Add Sintra"),
        ])
        .to_string(),
    )
    .unwrap();
    let newer = import_chat_export_item(&state, &None, &source, &selection, None).await;
    assert_eq!(newer.status, "imported");
    assert!(newer
        .detail
        .as_deref()
        .unwrap()
        .starts_with("0 new, 1 updated"));
    let messages = state
        .conversations
        .get_messages(&conversation)
        .await
        .unwrap();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[2].content, "Add Sintra");
}

#[tokio::test]
async fn chatgpt_reimport_after_an_edited_prompt_does_not_interleave_branches() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("chatgpt-export");
    std::fs::create_dir_all(&source).unwrap();
    let source = source.canonicalize().unwrap();
    let export = source.join("conversations.json");
    std::fs::write(
        &export,
        chatgpt_export(&[("user", "Plan Lisbon"), ("assistant", "Day 1: Alfama")]).to_string(),
    )
    .unwrap();
    let state = isolated_plugin_hook_test_state(directory.path());
    let selection = crate::import::ImportSelection {
        kind: crate::import::kind::CONVERSATIONS.into(),
        id: "conversations/conversations.json#chats".into(),
    };
    let first = import_chat_export_item(&state, &None, &source, &selection, None).await;
    assert_eq!(first.status, "imported", "{:?}", first.detail);

    // The user edits the first prompt in ChatGPT: the old branch stays in the
    // export's tree, and `current_node` now follows the new one.
    let mut edited = chatgpt_export(&[("user", "Plan Lisbon"), ("assistant", "Day 1: Alfama")]);
    let mapping = edited[0]["mapping"].as_object_mut().unwrap();
    mapping["root"]["children"] = json!(["m0", "e0"]);
    mapping.insert(
        "e0".into(),
        json!({ "id": "e0", "parent": "root", "children": ["e1"], "message": {
            "author": { "role": "user" }, "create_time": 1_700_000_050.0,
            "content": { "content_type": "text", "parts": ["Plan Porto"] } } }),
    );
    mapping.insert(
        "e1".into(),
        json!({ "id": "e1", "parent": "e0", "children": [], "message": {
            "author": { "role": "assistant" }, "create_time": 1_700_000_051.0,
            "content": { "content_type": "text", "parts": ["Day 1: Ribeira"] } } }),
    );
    edited[0]["current_node"] = json!("e1");
    std::fs::write(&export, edited.to_string()).unwrap();

    let again = import_chat_export_item(&state, &None, &source, &selection, None).await;
    assert_eq!(again.status, "skipped", "{:?}", again.detail);
    assert!(
        again
            .detail
            .as_deref()
            .unwrap()
            .contains("1 edited in ChatGPT since the last import"),
        "{:?}",
        again.detail
    );
    let tenancy = caller_tenancy(&None);
    let (conversation, _) = state
        .conversations
        .find_imported_conversation_with_generation("import:chatgpt", "chatgpt-conv-1", &tenancy)
        .await
        .unwrap()
        .unwrap();
    let messages = state
        .conversations
        .get_messages(&conversation)
        .await
        .unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        vec!["Plan Lisbon", "Day 1: Alfama"]
    );
}
