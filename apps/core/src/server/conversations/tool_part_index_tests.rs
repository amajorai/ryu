//! Tool-call parts in the keyword index: rendering bounds, redaction, exact
//! search over a tool-only fact, the parts-update trigger and the one-time
//! re-index of rows indexed before tool text was searchable.

use serde_json::json;

use super::*;

/// A fake API key built at runtime (never a real credential).
fn fake_api_key() -> String {
    format!("sk-{}{}", "zorblaxkey", "7".repeat(24))
}

fn tool_parts(tool: &str, input: Value, output: Value) -> Value {
    json!([
        {"type": "text", "text": "Checked it.", "state": "done"},
        {
            "type": format!("tool-{tool}"),
            "toolCallId": "call-1",
            "state": "output-available",
            "input": input,
            "output": output,
        }
    ])
}

fn fts_store() -> ConversationStore {
    ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(ryu_search::MessageFtsIndex::open_in_memory().unwrap())
}

async fn assistant_with_parts(
    store: &ConversationStore,
    conversation: &str,
    parts: &Value,
) -> String {
    let id = store
        .append_message(conversation, "assistant", "Checked it.", None, None, None)
        .await
        .unwrap();
    store
        .update_message_parts(&id, &parts.to_string())
        .await
        .unwrap();
    id
}

async fn exact_ids(store: &ConversationStore, query: &str) -> Vec<String> {
    store
        .fts_search_messages(query, 10, None)
        .await
        .unwrap()
        .expect("keyword index wired")
        .into_iter()
        .map(|hit| hit.message_id)
        .collect()
}

#[test]
fn renders_tool_id_arguments_and_result_but_not_text_parts() {
    let parts = tool_parts(
        "web_search",
        json!({"query": "quokka ledger totals", "limit": 5}),
        json!({"content": [{"type": "text", "text": "Ledger balance 4210 credits"}]}),
    );
    let text = tool_parts_search_text(&parts);
    assert!(text.starts_with("web_search "), "{text}");
    assert!(text.contains("query: quokka ledger totals"), "{text}");
    assert!(text.contains("limit: 5"), "{text}");
    assert!(text.contains("Ledger balance 4210 credits"), "{text}");
    assert!(
        !text.contains("Checked it."),
        "text parts are indexed as content"
    );

    let dynamic = json!([{
        "type": "dynamic-tool",
        "toolName": "mcp__files__read",
        "toolCallId": "call-2",
        "state": "output-error",
        "input": {"path": "/srv/notes.md"},
        "errorText": "permission denied",
    }]);
    let text = tool_parts_search_text(&dynamic);
    assert!(
        text.starts_with("mcp__files__read path: /srv/notes.md"),
        "{text}"
    );
    assert!(text.ends_with("permission denied"), "{text}");
    // Data parts and stream-frame shapes are not tool calls.
    let other = json!([
        {"type": "data-ryu-stats", "data": {"promptTokens": 10}},
        {"type": "tool-input-available", "toolName": "x"},
    ]);
    assert_eq!(tool_parts_search_text(&other), "");
}

#[test]
fn skips_attachments_and_encoded_blobs() {
    let blob = "QUJD".repeat(80);
    let parts = tool_parts(
        "screenshot",
        json!({"url": "data:image/png;base64,iVBORw0KGgo", "label": "dashboard"}),
        json!({"content": [
            {"type": "image", "data": "iVBORw0KGgo", "mimeType": "image/png", "caption": "hidden"},
            {"type": "text", "text": "captured"},
            {"raw": blob},
        ]}),
    );
    let text = tool_parts_search_text(&parts);
    assert!(text.contains("label: dashboard"), "{text}");
    assert!(text.contains("captured"), "{text}");
    for absent in ["data:image", "iVBORw0KGgo", "hidden", "QUJDQUJD"] {
        assert!(!text.contains(absent), "{absent} leaked into {text}");
    }
}

#[test]
fn caps_each_part_and_the_parts_per_message() {
    let long = "lorem ipsum dolor ".repeat(2_000);
    let one = tool_parts("read_file", json!({"path": "a.txt"}), json!(long));
    let text = tool_parts_search_text(&one);
    assert!(text.len() <= TOOL_PART_TEXT_CAP, "{} bytes", text.len());
    assert!(text.ends_with("lorem") || text.ends_with("ipsum") || text.ends_with("dolor"));

    let many: Vec<Value> = (0..TOOL_PARTS_PER_MESSAGE + 8)
        .map(|n| json!({"type": "tool-step", "toolCallId": format!("c{n}"), "input": {"n": n}}))
        .collect();
    let text = tool_parts_search_text(&Value::Array(many));
    assert_eq!(text.lines().count(), TOOL_PARTS_PER_MESSAGE);
}

#[test]
fn redacts_secrets_and_never_keeps_a_cut_fragment() {
    let key = fake_api_key();
    let parts = tool_parts(
        "http_request",
        json!({"url": "https://api.example.test/v1", "apiKey": key, "password": "hunter2hunter2"}),
        json!(format!("Authorization uses {key} for the vendor")),
    );
    let text = tool_parts_search_text(&parts);
    assert!(!text.contains("zorblaxkey"), "{text}");
    assert!(!text.contains("hunter2"), "{text}");
    assert!(text.contains("[REDACTED:"), "{text}");
    assert!(text.contains("for the vendor"), "{text}");

    // A secret straddling the raw read limit is dropped whole, not left as a
    // prefix too short for the scanner to recognize. The private key block in
    // front shrinks to a placeholder, so without that rule the prefix would
    // land inside the kept text.
    let mut raw = format!("-----BEGIN {} KEY-----\n", "PRIVATE");
    raw.push_str(&"MIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n".repeat(150));
    raw.push_str(&format!("-----END {} KEY-----\n", "PRIVATE"));
    while raw.len() < RAW_SCAN_CAP - 12 {
        raw.push_str("y ");
    }
    raw.push_str(&key);
    let parts = tool_parts("dump", json!({}), json!(raw));
    let text = tool_parts_search_text(&parts);
    assert!(text.contains("[REDACTED:PRIVATE_KEY]"), "{text}");
    assert!(
        text.ends_with('y'),
        "{}",
        &text[text.len().saturating_sub(40)..]
    );
    assert!(
        !text.contains("zorblax"),
        "{}",
        &text[text.len().saturating_sub(40)..]
    );
}

#[test]
fn a_credential_value_is_redacted_whole_whatever_it_holds() {
    let parts = tool_parts(
        "login",
        json!({
            "username": "bob",
            "password": "correct horse battery staple",
            "client_secret": "abc,def123xyz",
            "auth": {"api_key": ["first half", "second half"]},
            "password_hint": "pet name",
            "max_tokens": 512,
        }),
        json!({"accessToken": "wombat; numbat quoll"}),
    );
    let text = tool_parts_search_text(&parts);
    for leaked in [
        "horse",
        "battery",
        "staple",
        "abc",
        "def123xyz",
        "first",
        "second",
        "wombat",
        "numbat",
        "quoll",
    ] {
        assert!(!text.contains(leaked), "{leaked} leaked into {text}");
    }
    assert!(text.contains("password: [REDACTED:CREDENTIAL]"), "{text}");
    assert!(
        text.contains("client_secret: [REDACTED:CREDENTIAL]"),
        "{text}"
    );
    assert!(
        text.contains("accessToken: [REDACTED:CREDENTIAL]"),
        "{text}"
    );
    // Keys that only mention a credential word keep their values.
    assert!(text.contains("username: bob"), "{text}");
    assert!(text.contains("password_hint: pet name"), "{text}");
    assert!(text.contains("max_tokens: 512"), "{text}");
}

#[tokio::test]
async fn no_word_of_a_multi_word_credential_is_searchable_or_shown() {
    let store = fts_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    let parts = tool_parts(
        "login",
        json!({"username": "dingoadmin", "password": "correct horse battery staple"}),
        json!({"client_secret": "abc,def123xyz"}),
    );
    let id = assistant_with_parts(&store, "conv-login", &parts).await;

    assert_eq!(exact_ids(&store, "dingoadmin").await, vec![id]);
    for query in ["battery staple", "horse", "def123xyz"] {
        assert!(exact_ids(&store, query).await.is_empty(), "{query}");
    }
    let hits = store
        .fts_search_messages("dingoadmin", 5, None)
        .await
        .unwrap()
        .unwrap();
    let snippet = &hits[0].content;
    assert!(
        snippet.contains("password: [REDACTED:CREDENTIAL]"),
        "{snippet}"
    );
    for leaked in ["horse", "battery", "staple", "def123xyz"] {
        assert!(!snippet.contains(leaked), "{leaked} shown in {snippet}");
    }
}

#[tokio::test]
async fn a_tool_call_only_fact_is_found_by_exact_search() {
    let store = fts_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    let parts = tool_parts(
        "lookup_invoice",
        json!({"vendor": "Quokkaledger"}),
        json!({"total": "4210 credits"}),
    );
    let id = assistant_with_parts(&store, "conv-tools", &parts).await;
    store
        .append_message("conv-other", "user", "unrelated chatter", None, None, None)
        .await
        .unwrap();

    assert_eq!(exact_ids(&store, "quokkaledger").await, vec![id.clone()]);
    assert_eq!(exact_ids(&store, "lookup_invoice").await, vec![id.clone()]);
    let hits = store
        .fts_search_messages("quokkaledger", 5, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hits[0].conversation_id, "conv-tools");
    assert!(
        hits[0].content.contains("vendor: Quokkaledger"),
        "the snippet shows the matching tool call: {}",
        hits[0].content
    );
    // A content match keeps the plain content as its snippet.
    let hits = store
        .fts_search_messages("checked", 5, None)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(hits[0].content, "Checked it.");
    // Scoping by conversation applies to tool text unchanged.
    let scoped = store
        .fts_search_messages("quokkaledger", 5, Some(&["conv-other".to_owned()]))
        .await
        .unwrap()
        .unwrap();
    assert!(scoped.is_empty());
}

#[tokio::test]
async fn a_redacted_secret_is_not_searchable() {
    let store = fts_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    let key = fake_api_key();
    let parts = tool_parts(
        "deploy",
        json!({"token": key, "target": "staging"}),
        json!(format!("deployed with {key} to wombatcluster")),
    );
    let id = assistant_with_parts(&store, "conv-secret", &parts).await;

    assert_eq!(exact_ids(&store, "wombatcluster").await, vec![id]);
    assert!(exact_ids(&store, &key).await.is_empty());
    let body = key.trim_start_matches("sk-").to_owned();
    assert!(exact_ids(&store, &body).await.is_empty());
}

#[tokio::test]
async fn parts_written_after_indexing_are_reindexed() {
    let store = fts_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    let id = store
        .append_message("conv-late", "assistant", "Working on it", None, None, None)
        .await
        .unwrap();
    assert!(exact_ids(&store, "platypusreport").await.is_empty());
    let parts = tool_parts("render", json!({"name": "platypusreport"}), json!("ok"));
    store
        .update_message_parts(&id, &parts.to_string())
        .await
        .unwrap();
    assert_eq!(exact_ids(&store, "platypusreport").await, vec![id]);
}

#[tokio::test]
async fn rows_indexed_before_tool_text_are_reindexed_once() {
    let store = fts_store();
    store.set_chat_memory_enabled(true).await.unwrap();
    let parts = tool_parts("archive", json!({"bucket": "narwhalvault"}), json!("ok"));
    let id = assistant_with_parts(&store, "conv-old", &parts).await;
    // Model a row an older build indexed from its content alone, and a
    // database that has not run the tool-parts re-index yet.
    let fts = store.message_fts.clone().unwrap();
    fts.index_message(&id, "conv-old", "assistant", "Checked it.", 1)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute_batch(
            "DELETE FROM message_search_pending;
             DELETE FROM message_search_migrations;",
        )
        .unwrap();
    }
    assert!(exact_ids(&store, "narwhalvault").await.is_empty());

    {
        let conn = store.conn.lock().await;
        ConversationStore::init_tool_part_search(&conn).unwrap();
    }
    assert_eq!(exact_ids(&store, "narwhalvault").await, vec![id.clone()]);

    // Applied once: a later open queues nothing.
    let conn = store.conn.lock().await;
    ConversationStore::init_tool_part_search(&conn).unwrap();
    let queued: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM message_search_pending WHERE kind = 1",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(queued, 0);
}
