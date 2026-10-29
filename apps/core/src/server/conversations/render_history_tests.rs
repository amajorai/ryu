//! Submitted UI data through the production chat route, sealed SQLite and HTTP history projection.
use super::*;
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::Request,
    routing::get,
    Router,
};
use serde_json::{json, Value};
use tower::ServiceExt;

fn disk_store(path: &std::path::Path) -> ConversationStore {
    let conn = Connection::open(path).unwrap();
    ConversationStore::init_schema(&conn).unwrap();
    ConversationStore {
        conn: Arc::new(Mutex::new(conn)),
        cipher: ryu_crypto::FieldCipher::new(&[0x43; 32]),
        chat_memory_enabled: Arc::new(AtomicBool::new(false)),
        message_index: None,
        message_fts: None,
        realtime: None,
        semantic_backfill: Arc::new(Mutex::new(false)),
        fts_backfill: Arc::new(Mutex::new(false)),
        index_unreadable: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        harness_unreadable: Arc::new(std::sync::atomic::AtomicU64::new(0)),
        content_reads: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        boot_interrupted: Arc::new(std::sync::Mutex::new(Vec::new())),
    }
}

async fn history(
    State(store): State<ConversationStore>,
    Path(id): Path<String>,
    Query(query): Query<crate::server::ConversationMessagesQuery>,
) -> axum::response::Response {
    crate::server::conversation_history_response(&store, None, &id, query).await
}

async fn intruder_history(
    State(store): State<ConversationStore>,
    Path(id): Path<String>,
    Query(query): Query<crate::server::ConversationMessagesQuery>,
) -> axum::response::Response {
    let caller = crate::identity_verify::VerifiedCaller {
        user_id: "intruder".to_owned(),
        email: None,
        email_verified: false,
        org_id: None,
        role: crate::identity_verify::OrgRole::Member,
        teams: Vec::new(),
    };
    crate::server::conversation_history_response(&store, Some(&caller), &id, query).await
}

async fn submit_ui_fixture(store: ConversationStore, conversation_id: &str, message: Value) {
    use crate::sidecar::adapters::{acp::AcpAgentRegistry, route_chat_stream, ChatStreamRequest};
    let request: ChatStreamRequest = serde_json::from_value(json!({
        "conversation_id": conversation_id,
        "messages": [message], "enable_long_term": false, "persist": true,
    }))
    .unwrap();
    let response = route_chat_stream(
        request,
        Arc::new(AcpAgentRegistry::new()),
        store,
        crate::agents::AgentStore::open_in_memory(&AcpAgentRegistry::new()).unwrap(),
        crate::sidecar::SidecarManager::new_noop(),
        crate::server::memory::MemoryStore::open_in_memory().unwrap(),
        Arc::new(Mutex::new(std::collections::HashMap::new())),
        Arc::new(crate::sidecar::mcp::McpRegistry::empty()),
        ryu_skills::SkillRegistry::empty(),
        ryu_tracing::TraceStore::open_in_memory().unwrap(),
        None,
        None,
        crate::routing_policy::reactive::TurnWatch::off(),
        None,
    )
    .await;
    // Persistence happens before the unpolled model stream; no provider is called.
    drop(response);
}

#[tokio::test]
async fn render_history_submitted_file_and_literal_display_survive_disk_reopen_and_api_pages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("conversation.db");
    let store = disk_store(&path);
    let literal = "The user is working in Ryu and currently has this open. Use it as context for their request.\n\n<page-context>\nThis is literal user text.\n</page-context>\n\nKeep this complete text.";
    let wire = format!("The user is working in Ryu and currently has this open. Use it as context for their request.\n\n<page-context>\nFixture workspace context\n</page-context>\n\n{literal}");
    let parts = json!([
        {"type":"text", "text":wire},
        {"type":"file", "filename":"proof-note.txt", "mediaType":"text/plain", "url":"data:text/plain;base64,SGVsbG8="}
    ]);
    let metadata = json!({"ryuUserText":literal});
    submit_ui_fixture(
        store.clone(),
        "render-history-fixture",
        json!({
            "role": "user", "parts": parts, "metadata": metadata,
        }),
    )
    .await;
    let rows = store.get_messages("render-history-fixture").await.unwrap();
    let user = rows.iter().find(|row| row.role == "user").unwrap();
    assert_eq!(user.parts.as_ref(), Some(&parts));
    assert_eq!(user.metadata.as_ref(), Some(&metadata));
    assert!(user.author_user_id.is_none());
    {
        let conn = store.conn.lock().await;
        let (sealed_parts, sealed_metadata): (String, String) = conn
            .query_row(
                "SELECT parts, metadata FROM messages WHERE id=?1",
                [&user.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!sealed_parts.contains("proof-note"));
        assert!(!sealed_metadata.contains("literal user text"));
    }
    // Finish a fixture reply without calling an external model.
    store
        .append_message(
            "render-history-fixture",
            "assistant",
            "History restored.",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    drop(store);
    let reopened = disk_store(&path);
    let app = Router::new()
        .route("/api/conversations/:id", get(history))
        .with_state(reopened.clone());
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/conversations/render-history-fixture")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["messages"][0]["parts"], parts);
    assert_eq!(body["messages"][0]["metadata"], metadata);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/conversations/render-history-fixture?limit=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let latest: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    let cursor = latest["older_messages_cursor"].as_str().unwrap();
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/conversations/render-history-fixture?limit=1&before={cursor}"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let older: Value = serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(older["messages"][0]["parts"], parts);
    assert_eq!(older["messages"][0]["metadata"], metadata);
    // Optional proof handoff contains only these synthetic messages, never live user data.
    if let Ok(output) = std::env::var("RYU_HISTORY_PROOF_FILE") {
        std::fs::write(output, serde_json::to_vec(&body).unwrap()).unwrap();
    }
}

#[tokio::test]
async fn render_history_legacy_rows_and_corrupt_metadata_keep_readable_content() {
    let store = ConversationStore::open_in_memory().unwrap();
    let id = store
        .append_message("legacy", "user", "Legacy user text", None, None, None)
        .await
        .unwrap();
    store
        .conn
        .lock()
        .await
        .execute("UPDATE messages SET metadata='corrupt' WHERE id=?1", [id])
        .unwrap();
    let rows = store.get_messages("legacy").await.unwrap();
    assert_eq!(rows[0].content, "Legacy user text");
    assert!(rows[0].parts.is_none());
    assert!(rows[0].metadata.is_none());
}

#[tokio::test]
async fn render_history_metadata_does_not_bypass_conversation_acl() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message_as_with_render_data(
            "private",
            "user",
            "Private fixture",
            None,
            Some("owner"),
            None,
            Tenancy::Owned {
                user_id: "owner".into(),
                org_id: None,
            },
            None,
            None,
            None,
            Some(&json!({"author":{"id":"intruder"}})),
        )
        .await
        .unwrap();
    let app = Router::new()
        .route("/api/conversations/:id", get(intruder_history))
        .with_state(store);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/conversations/private")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn render_history_file_only_legacy_parts_use_the_same_persistence_path() {
    let store = ConversationStore::open_in_memory().unwrap();
    let parts = json!([{"type":"file","filename":"only.txt","mediaType":"text/plain","url":"data:text/plain;base64,SGVsbG8="}]);
    submit_ui_fixture(
        store.clone(),
        "file-only",
        json!({"role":"user","content":parts,"metadata":{"ryuUserText":""}}),
    )
    .await;
    let rows = store.get_messages("file-only").await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].content, "");
    assert_eq!(rows[0].parts, Some(parts));
    assert_eq!(rows[0].metadata, Some(json!({"ryuUserText":""})));
}

#[tokio::test]
async fn render_history_saved_temporary_messages_and_forks_preserve_display_data() {
    let store = ConversationStore::open_in_memory().unwrap();
    let parts = json!([{"type":"text","text":"Full model context"},{"type":"file","filename":"note.txt","mediaType":"text/plain","url":"data:text/plain;base64,SGVsbG8="}]);
    let metadata = json!({"ryuUserText":"Original request"});
    store
        .save_temporary_conversation(
            "temporary-render",
            None,
            None,
            &[TemporaryConversationMessage {
                role: "user".into(),
                content: "Full model context".into(),
                agent_id: None,
                author_user_id: None,
                parts: Some(parts.clone()),
                metadata: Some(metadata.clone()),
                created_at: 123,
            }],
            Tenancy::Unattributed,
        )
        .await
        .unwrap();
    let fork = store
        .fork_conversation("temporary-render", None, Tenancy::Unattributed)
        .await
        .unwrap()
        .unwrap();
    for id in ["temporary-render", &fork.id] {
        let rows = store.get_messages(id).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].parts, Some(parts.clone()));
        assert_eq!(rows[0].metadata, Some(metadata.clone()));
    }
}

#[tokio::test]
async fn render_history_additive_migration_preserves_legacy_rows_and_is_idempotent() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message(
            "old-schema",
            "user",
            "Older saved request",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute_batch("ALTER TABLE messages DROP COLUMN metadata;")
            .unwrap();
        ConversationStore::init_schema(&conn).unwrap();
        ConversationStore::init_schema(&conn).unwrap();
    }
    let rows = store.get_messages("old-schema").await.unwrap();
    assert_eq!(rows[0].content, "Older saved request");
    assert!(rows[0].metadata.is_none());
}

#[tokio::test]
async fn render_history_hook_handled_ui_turn_preserves_parts_metadata_and_verified_author() {
    use crate::sidecar::adapters::{persist_handled_ui_turn, ChatStreamRequest};
    let store = ConversationStore::open_in_memory().unwrap();
    let parts = json!([{"type":"file","filename":"handled.txt","mediaType":"text/plain","url":"data:text/plain;base64,SGVsbG8="}]);
    let metadata = json!({"ryuUserText":"Original handled request","author":{"id":"forged"}});
    let mut request: ChatStreamRequest = serde_json::from_value(
        json!({"messages":[{"role":"user","parts":parts,"metadata":metadata}]}),
    )
    .unwrap();
    request.author_user_id = Some("verified-owner".to_owned());
    persist_handled_ui_turn(
        &store,
        &request,
        "handled-ui",
        "Effective hook prompt",
        "Hook reply",
        None,
    )
    .await
    .unwrap();
    let rows = store.get_messages("handled-ui").await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].parts, Some(parts));
    assert_eq!(rows[0].metadata, Some(metadata));
    assert_eq!(rows[0].author_user_id.as_deref(), Some("verified-owner"));
    assert_eq!(rows[1].content, "Hook reply");
}

#[tokio::test]
async fn render_history_hook_handled_temporary_turn_stays_private_and_regeneration_skips_user() {
    use crate::sidecar::adapters::{persist_handled_ui_turn, ChatStreamRequest};
    let store = ConversationStore::open_in_memory().unwrap();
    let mut request: ChatStreamRequest = serde_json::from_value(json!({"persist":false,"messages":[{"role":"user","parts":[{"type":"text","text":"Temporary request"}],"metadata":{"ryuUserText":"Temporary request"}}]})).unwrap();
    assert!(persist_handled_ui_turn(
        &store,
        &request,
        "temporary-hook",
        "Temporary request",
        "Reply",
        None
    )
    .await
    .is_none());
    assert!(store
        .get_messages("temporary-hook")
        .await
        .unwrap()
        .is_empty());
    request.persist = true;
    request.skip_user_append = true;
    store
        .append_message(
            "regenerated-hook",
            "user",
            "Existing request",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    persist_handled_ui_turn(
        &store,
        &request,
        "regenerated-hook",
        "Existing request",
        "Regenerated reply",
        None,
    )
    .await
    .unwrap();
    let rows = store.get_messages("regenerated-hook").await.unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(
        rows.iter().filter(|message| message.role == "user").count(),
        1
    );
}
