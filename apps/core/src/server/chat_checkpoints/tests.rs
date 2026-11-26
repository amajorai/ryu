use super::*;

#[test]
fn restore_modes_cover_both_halves() {
    assert!(RestoreMode::CodeAndConversation.restores_code());
    assert!(RestoreMode::CodeAndConversation.rewinds_conversation());
    assert!(RestoreMode::Code.restores_code());
    assert!(!RestoreMode::Code.rewinds_conversation());
    assert!(!RestoreMode::Conversation.restores_code());
    assert!(RestoreMode::Conversation.rewinds_conversation());
    let body: RestoreBody =
        serde_json::from_str(r#"{"mode":"codeAndConversation"}"#).expect("mode");
    assert_eq!(body.mode, RestoreMode::CodeAndConversation);
    assert!(serde_json::from_str::<RestoreBody>(r#"{"mode":"all"}"#).is_err());
}

#[test]
fn turn_workspace_prefers_the_worktree() {
    let folder = tempfile::tempdir().expect("folder");
    let worktree = tempfile::tempdir().expect("worktree");
    let cwd = folder.path().to_string_lossy().into_owned();
    assert_eq!(
        turn_workspace(Some(&cwd), Some(worktree.path())),
        Some(worktree.path().to_path_buf())
    );
    assert_eq!(
        turn_workspace(Some(&cwd), None),
        Some(folder.path().to_path_buf())
    );
    assert_eq!(turn_workspace(Some("  "), None), None);
    assert_eq!(turn_workspace(None, None), None);
}

async fn call(
    router: &axum::Router,
    method: &str,
    uri: &str,
    body: Option<serde_json::Value>,
) -> (StatusCode, serde_json::Value) {
    use tower::ServiceExt as _;
    let request = axum::http::Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json")
        .body(match body {
            Some(body) => axum::body::Body::from(body.to_string()),
            None => axum::body::Body::empty(),
        })
        .unwrap();
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .unwrap();
    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

fn snapshot_files(root: &Path) -> std::collections::BTreeMap<String, Vec<u8>> {
    let mut out = std::collections::BTreeMap::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else {
                let relative = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.insert(relative, std::fs::read(&path).unwrap());
            }
        }
    }
    out
}

/// The whole chain through the real HTTP routes: turns are captured, an
/// "agent" edits the folder, a busy folder is refused, code and
/// conversation rewind together, the undo checkpoint reverses it, and a
/// conversation-only rewind leaves files alone.
#[tokio::test]
async fn http_rewind_round_trip() {
    let data = tempfile::tempdir().expect("data");
    let state = super::super::isolated_plugin_hook_test_state(data.path());
    let store = state.conversations.clone();
    let router = axum::Router::new()
        .route(
            "/api/conversations/:id/checkpoints",
            axum::routing::get(list_chat_checkpoints),
        )
        .route(
            "/api/conversations/:id/checkpoints/:checkpoint_id/changes",
            axum::routing::get(chat_checkpoint_changes),
        )
        .route(
            "/api/conversations/:id/checkpoints/:checkpoint_id/restore",
            axum::routing::post(restore_chat_checkpoint),
        )
        .layer(axum::Extension(None::<VerifiedCaller>))
        .with_state(state);

    let workspace = tempfile::tempdir().expect("workspace");
    let root = workspace.path();
    std::fs::write(root.join("main.rs"), b"fn main() {}\n").unwrap();
    std::fs::write(root.join("lib.rs"), b"pub fn lib() {}\n").unwrap();
    let original = snapshot_files(root);

    let conv = format!("conv-e2e-{}", uuid::Uuid::new_v4());
    let first = store
        .append_message(&conv, "user", "refactor main", None, None, None)
        .await
        .unwrap();
    capture_turn(&store, &conv, &first, Some(root.to_path_buf())).await;
    // The agent's first turn.
    std::fs::write(root.join("main.rs"), b"fn main() { run() }\n").unwrap();
    std::fs::remove_file(root.join("lib.rs")).unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/run.rs"), b"pub fn run() {}\n").unwrap();
    let reply = store
        .append_message(&conv, "assistant", "done", None, None, None)
        .await
        .unwrap();
    let second = store
        .append_message(&conv, "user", "now add tests", None, None, None)
        .await
        .unwrap();
    capture_turn(&store, &conv, &second, Some(root.to_path_buf())).await;
    let after_first_turn = snapshot_files(root);
    // The agent's second turn.
    std::fs::write(root.join("tests.rs"), b"#[test] fn t() {}\n").unwrap();
    let after_second_turn = snapshot_files(root);

    let (status, body) = call(
        &router,
        "GET",
        &format!("/api/conversations/{conv}/checkpoints"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let checkpoints = body["checkpoints"].as_array().unwrap();
    assert_eq!(checkpoints.len(), 2);
    assert!(
        checkpoints.iter().all(|cp| cp["hasFiles"] == true),
        "{body}"
    );
    let id_for = |message: &str| {
        checkpoints
            .iter()
            .find(|cp| cp["messageId"] == message)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let first_cp = id_for(&first);
    let second_cp = id_for(&second);

    let (status, body) = call(
        &router,
        "GET",
        &format!("/api/conversations/{conv}/checkpoints/{first_cp}/changes"),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["changes"].as_array().unwrap().len(), 4, "{body}");

    // Another chat running in the same folder blocks a file restore.
    let other = format!("conv-busy-{}", uuid::Uuid::new_v4());
    store
        .append_message(&other, "user", "busy", None, None, None)
        .await
        .unwrap();
    store
        .set_run_metadata(&other, Some(&root.to_string_lossy()), None, None)
        .await
        .unwrap();
    store.set_run_status(&other, "running").await.unwrap();
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{first_cp}/restore"),
        Some(json!({ "mode": "codeAndConversation" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "folder_busy");
    assert_eq!(snapshot_files(root), after_second_turn, "nothing touched");
    store.set_run_status(&other, "completed").await.unwrap();

    // A turn running in this same conversation (any provider, not only
    // ACP) blocks even a conversation-only rewind.
    let leaf_before = store.get_active_messages(&conv).await.unwrap();
    store.set_run_status(&conv, "running").await.unwrap();
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{second_cp}/restore"),
        Some(json!({ "mode": "conversation" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "turn_in_progress");
    let leaf_after = store.get_active_messages(&conv).await.unwrap();
    assert_eq!(
        leaf_after.iter().map(|m| &m.id).collect::<Vec<_>>(),
        leaf_before.iter().map(|m| &m.id).collect::<Vec<_>>(),
        "active thread untouched"
    );
    store.set_run_status(&conv, "completed").await.unwrap();

    // Rewind code and conversation to before the first turn.
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{first_cp}/restore"),
        Some(json!({ "mode": "codeAndConversation" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        snapshot_files(root),
        original,
        "folder is back to before turn 1"
    );
    assert_eq!(body["files"]["skipped"], json!([]));
    assert_eq!(body["conversation"]["rewoundText"], "refactor main");
    assert_eq!(body["conversation"]["resendAsEdit"], true);
    let undo = body["files"]["undoCheckpoint"]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // The undo checkpoint puts every file back.
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{undo}/restore"),
        Some(json!({ "mode": "code" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        snapshot_files(root),
        after_second_turn,
        "undo reversed the rewind"
    );
    // An undo checkpoint has no conversation point.
    let (status, _) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{undo}/restore"),
        Some(json!({ "mode": "conversation" })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // Conversation-only rewind leaves files alone.
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{second_cp}/restore"),
        Some(json!({ "mode": "conversation" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["files"], serde_json::Value::Null);
    assert_eq!(body["conversation"]["activeLeafMessageId"], json!(reply));
    assert_eq!(snapshot_files(root), after_second_turn);
    let active = store.get_active_messages(&conv).await.unwrap();
    assert_eq!(
        active
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        vec!["refactor main", "done"]
    );

    // Code-only rewind to before turn 2 keeps the conversation.
    let (status, body) = call(
        &router,
        "POST",
        &format!("/api/conversations/{conv}/checkpoints/{second_cp}/restore"),
        Some(json!({ "mode": "code" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["conversation"], serde_json::Value::Null);
    assert_eq!(snapshot_files(root), after_first_turn);
}

async fn send_turn(
    store: &ConversationStore,
    conversation_id: &str,
    cwd: &Path,
    text: &str,
    skip_user_append: bool,
) {
    use crate::sidecar::adapters::{acp::AcpAgentRegistry, route_chat_stream, ChatStreamRequest};
    let request: ChatStreamRequest = serde_json::from_value(json!({
        "conversation_id": conversation_id,
        "messages": [{ "role": "user", "parts": [{ "type": "text", "text": text }] }],
        "enable_long_term": false,
        "persist": true,
        "cwd": cwd.to_string_lossy(),
        "skip_user_append": skip_user_append,
    }))
    .unwrap();
    let response = route_chat_stream(
        request,
        std::sync::Arc::new(AcpAgentRegistry::new()),
        store.clone(),
        crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap(),
        crate::sidecar::SidecarManager::new_noop(),
        crate::server::memory::MemoryStore::open_in_memory().unwrap(),
        std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        std::sync::Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
        ryu_skills::SkillRegistry::empty(),
        ryu_tracing::TraceStore::open_in_memory().unwrap(),
        None,
        None,
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await;
    // The checkpoint is taken before the model stream; no provider is called.
    drop(response);
}

/// The production chat route captures a checkpoint for every user turn
/// before any agent runs; a regenerate keeps the original pre-turn state
/// and an edit gets its own checkpoint.
#[tokio::test]
async fn chat_route_captures_a_checkpoint_before_each_turn() {
    let store = ConversationStore::open_in_memory().expect("store");
    let workspace = tempfile::tempdir().expect("workspace");
    let root = workspace.path();
    let conv = format!("conv-route-{}", uuid::Uuid::new_v4());
    std::fs::write(root.join("a.txt"), b"before turn 1").unwrap();

    send_turn(&store, &conv, root, "first", false).await;
    let rows = store.list_chat_checkpoints(&conv, 10).await.unwrap();
    assert_eq!(rows.len(), 1, "one checkpoint per sent turn");
    assert!(rows[0].has_files, "{:?}", rows[0]);
    assert_eq!(rows[0].preview.as_deref(), Some("first"));
    let first_message = rows[0].message_id.clone().unwrap();

    // The "agent" edits, then the turn is regenerated: same user turn.
    std::fs::write(root.join("a.txt"), b"agent output").unwrap();
    store.prepare_regenerate(&conv, &first_message).await.ok();
    send_turn(&store, &conv, root, "first", true).await;
    assert_eq!(
        store.list_chat_checkpoints(&conv, 10).await.unwrap().len(),
        1,
        "a regenerate keeps the original checkpoint"
    );

    // An edit creates a new user version, which gets its own checkpoint.
    let edited = store
        .edit_user_message(&conv, &first_message, "first, edited")
        .await
        .unwrap()
        .unwrap();
    send_turn(&store, &conv, root, "first, edited", true).await;
    let rows = store.list_chat_checkpoints(&conv, 10).await.unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows
        .iter()
        .any(|row| row.message_id.as_deref() == Some(edited.as_str())));

    // The first checkpoint still restores the folder to before turn 1.
    let record = store
        .get_chat_checkpoint(
            &conv,
            &rows
                .iter()
                .find(|r| r.message_id.as_deref() == Some(first_message.as_str()))
                .unwrap()
                .id,
        )
        .await
        .unwrap()
        .unwrap();
    let (workspace_path, commit) = file_snapshot(&record).unwrap();
    checkpoint_store()
        .restore(&workspace_path, &commit)
        .unwrap();
    assert_eq!(std::fs::read(root.join("a.txt")).unwrap(), b"before turn 1");
}

#[tokio::test]
async fn turn_checkpoint_round_trip_rewinds_files_and_thread() {
    let store = ConversationStore::open_in_memory().expect("conversation store");
    let first = store
        .append_message("conv-rewind", "user", "first", None, None, None)
        .await
        .expect("first");
    store
        .append_message("conv-rewind", "assistant", "reply", None, None, None)
        .await
        .expect("reply");
    let second = store
        .append_message("conv-rewind", "user", "second", None, None, None)
        .await
        .expect("second");

    let record = |message: &str| ChatCheckpointRecord {
        id: format!("cp-{message}"),
        conversation_id: "conv-rewind".into(),
        message_id: Some(message.to_owned()),
        kind: ChatCheckpointKind::Turn,
        workspace: None,
        commit_id: None,
        skip_reason: None,
        created_at: 1,
    };
    assert!(store.record_chat_checkpoint(&record(&first)).await.unwrap());
    assert!(store
        .record_chat_checkpoint(&record(&second))
        .await
        .unwrap());
    let mut duplicate = record(&second);
    duplicate.id = "cp-again".into();
    assert!(
        !store.record_chat_checkpoint(&duplicate).await.unwrap(),
        "the first capture of a turn wins"
    );
    let listed = store
        .list_chat_checkpoints("conv-rewind", 10)
        .await
        .unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed
        .iter()
        .any(|checkpoint| checkpoint.preview.as_deref() == Some("second")));

    let rewound = store
        .rewind_to_message("conv-rewind", &second)
        .await
        .unwrap()
        .expect("user message");
    assert!(rewound.active_leaf_message_id.is_some());
    assert_eq!(rewound.text, "second");
    let active = store.get_active_messages("conv-rewind").await.unwrap();
    assert_eq!(
        active
            .iter()
            .map(|m| m.content.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "reply"]
    );
    let first_rewound = store
        .rewind_to_message("conv-rewind", &first)
        .await
        .unwrap()
        .expect("first turn");
    assert_eq!(
        first_rewound.active_leaf_message_id, None,
        "the first turn has no parent to point at"
    );
    assert!(store
        .rewind_to_message("conv-rewind", "missing")
        .await
        .unwrap()
        .is_none());
}
