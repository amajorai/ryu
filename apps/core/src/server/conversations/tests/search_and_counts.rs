//! Conversation store tests: search and counts.

use super::*;

#[tokio::test]
async fn search_messages_backfills_and_finds_existing() {
    // Wire an in-memory index, append messages, then search. Even if the
    // append-time spawned indexing hasn't run, the lazy backfill on the
    // first search embeds the stored (decrypted) messages and finds them.
    // Uses the local (network-free) embedder, so no embed sidecar is needed.
    let index = crate::search_host::in_memory_message_index().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_index(index);
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .append_message(
            "c1",
            "user",
            "rust ownership and lifetimes are tricky",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store
        .append_message(
            "c1",
            "assistant",
            "favourite pizza toppings list",
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let hits = store
        .search_messages("rust lifetimes", 5, None)
        .await
        .unwrap()
        .expect("index wired");
    assert!(!hits.is_empty(), "expected a hit after backfill");
    assert!(
        hits[0].content.contains("ownership"),
        "rust message should rank first, got: {}",
        hits[0].content
    );
    // The decrypted snippet is returned (proves snippet re-read + cipher.open).
    assert!(hits[0].content.contains("lifetimes"));
}

#[tokio::test]
async fn search_messages_opt_out_skips_search_and_backfill() {
    let index = crate::search_host::in_memory_message_index().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_index(index.clone());
    store
        .append_message("c1", "user", "private semantic content", None, None, None)
        .await
        .unwrap();

    let hits = store.search_messages("private", 5, None).await.unwrap();
    assert!(
        hits.is_none(),
        "opted-out semantic search must be unavailable"
    );
    assert!(
        index.indexed_ids().await.unwrap().is_empty(),
        "opted-out semantic search must not backfill the vector index"
    );
}

#[tokio::test]
async fn fts_search_none_without_index() {
    // No FTS index wired (open_in_memory) → search returns None, never errors.
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "hello world", None, None, None)
        .await
        .unwrap();
    let res = store.fts_search_messages("hello", 5, None).await.unwrap();
    assert!(res.is_none());
}

#[tokio::test]
async fn fts_search_backfills_existing_and_returns_decrypted_snippet() {
    // Append messages to an FTS-wired store, then search. The inline lazy
    // backfill on the first search indexes the stored (decrypted) messages and
    // finds them — and the returned snippet is the decrypted plaintext, not the
    // sealed blob. Network-free (no embedder).
    let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(index);
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .append_message(
            "c1",
            "user",
            "rust ownership and lifetimes are tricky",
            None,
            None,
            None,
        )
        .await
        .unwrap();
    store
        .append_message(
            "c2",
            "assistant",
            "favourite pizza toppings pepperoni",
            None,
            None,
            None,
        )
        .await
        .unwrap();

    let hits = store
        .fts_search_messages("pizza", 5, None)
        .await
        .unwrap()
        .expect("fts index wired");
    assert!(!hits.is_empty(), "expected a hit after backfill");
    assert_eq!(hits[0].conversation_id, "c2");
    // Proves snippet re-read + cipher.open (decrypted, not the sealed blob).
    assert!(hits[0].content.contains("pepperoni"));
    assert!(!hits[0].content.starts_with("enc:v1:"));
}

#[tokio::test]
async fn learning_projection_excludes_structured_and_identity_fields() {
    let store = ConversationStore::open_in_memory().unwrap();
    let user_id = store
        .append_message(
            "learning-safe",
            "user",
            "question",
            None,
            Some("verified-user"),
            None,
        )
        .await
        .unwrap();
    let assistant_id = store
        .append_message(
            "learning-safe",
            "assistant",
            "answer",
            Some("agent-1"),
            None,
            None,
        )
        .await
        .unwrap();
    store
        .update_message_parts(
            &assistant_id,
            r#"[{"type":"tool","secret":"do-not-learn"}]"#,
        )
        .await
        .unwrap();

    let messages = store.get_learning_messages("learning-safe").await.unwrap();
    assert_eq!(messages.len(), 2);
    assert_eq!(messages[0].id, user_id);
    assert_eq!(messages[0].content, "question");
    assert_eq!(messages[1].id, assistant_id);
    assert_eq!(messages[1].agent_id.as_deref(), Some("agent-1"));
    assert_eq!(messages[1].content, "answer");

    // The general read still has the identity/structured fields, proving the
    // learning projection—not the fixture—is what excludes them.
    let general = store.get_messages("learning-safe").await.unwrap();
    assert_eq!(general[0].author_user_id.as_deref(), Some("verified-user"));
    assert!(general[1].parts.is_some());
}

#[tokio::test]
async fn fts_search_scopes_to_conversation_ids() {
    let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(index);
    store.set_chat_memory_enabled(true).await.unwrap();
    store
        .append_message("c1", "user", "alpha beta gamma", None, None, None)
        .await
        .unwrap();
    store
        .append_message("c2", "user", "alpha beta gamma", None, None, None)
        .await
        .unwrap();
    let hits = store
        .fts_search_messages("alpha beta", 5, Some(&["c2".to_owned()]))
        .await
        .unwrap()
        .expect("fts index wired");
    assert!(!hits.is_empty());
    assert!(hits.iter().all(|h| h.conversation_id == "c2"));
}

#[tokio::test]
async fn fts_search_opt_out_skips_search_and_backfill() {
    let index = ryu_search::MessageFtsIndex::open_in_memory().unwrap();
    let store = ConversationStore::open_in_memory()
        .unwrap()
        .with_message_fts_index(index.clone());
    store
        .append_message("c1", "user", "private lexical content", None, None, None)
        .await
        .unwrap();

    let hits = store.fts_search_messages("private", 5, None).await.unwrap();
    assert!(hits.is_none(), "opted-out FTS search must be unavailable");
    assert!(
        index.indexed_ids().await.unwrap().is_empty(),
        "opted-out exact search must not backfill the FTS index"
    );
}

#[tokio::test]
async fn message_content_is_encrypted_on_disk() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "my secret diary entry", None, None, None)
        .await
        .unwrap();

    // The stored column must be a sealed envelope, never the plaintext.
    let raw: String = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT content FROM messages WHERE conversation_id = ?1",
            params!["c1"],
            |r| r.get(0),
        )
        .unwrap()
    };
    assert!(
        raw.starts_with("enc:v1:"),
        "expected sealed content, got {raw}"
    );
    assert!(!raw.contains("secret diary"));

    // And it round-trips transparently on read.
    let msgs = store.get_messages("c1").await.unwrap();
    assert_eq!(msgs[0].content, "my secret diary entry");
}

#[tokio::test]
async fn legacy_plaintext_messages_still_readable() {
    // A row written before encryption was introduced has no envelope prefix.
    let store = ConversationStore::open_in_memory().unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('m1', 'c1', 'user', 'old plaintext message', 0)",
            [],
        )
        .unwrap();
    }
    let msgs = store.get_messages("c1").await.unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].content, "old plaintext message");
}

pub(super) async fn stored_message_count(store: &ConversationStore, id: &str) -> i64 {
    let conn = store.conn.lock().await;
    conn.query_row(
        "SELECT message_count FROM conversations WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn message_count_column_tracks_every_writer() {
    let store = ConversationStore::open_in_memory().unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute_batch(
            "INSERT INTO conversations (id, created_at, updated_at) VALUES ('c1', 0, 0);
                 INSERT INTO conversations (id, created_at, updated_at) VALUES ('c2', 0, 0);
                 INSERT INTO messages (id, conversation_id, role, content, created_at)
                     VALUES ('early', 'c1', 'user', 'x', 0);",
        )
        .unwrap();
    }
    assert_eq!(stored_message_count(&store, "c1").await, 1);

    store
        .append_message("c1", "user", "hello", None, None, None)
        .await
        .unwrap();
    store
        .append_message("c1", "assistant", "hi", None, None, None)
        .await
        .unwrap();
    assert_eq!(stored_message_count(&store, "c1").await, 3);

    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE messages SET conversation_id = 'c2' WHERE id = 'early'",
            [],
        )
        .unwrap();
        // An ignored duplicate insert must not count.
        conn.execute(
            "INSERT OR IGNORE INTO messages (id, conversation_id, role, content, created_at)
                 VALUES ('early', 'c2', 'user', 'x', 0)",
            [],
        )
        .unwrap();
    }
    assert_eq!(stored_message_count(&store, "c1").await, 2);
    assert_eq!(stored_message_count(&store, "c2").await, 1);

    {
        let conn = store.conn.lock().await;
        conn.execute("DELETE FROM messages WHERE conversation_id = 'c1'", [])
            .unwrap();
    }
    assert_eq!(stored_message_count(&store, "c1").await, 0);

    let summaries = store.list_conversations().await.unwrap();
    let c2 = summaries.iter().find(|s| s.id == "c2").unwrap();
    assert_eq!(c2.message_count, 1);
}

pub(super) async fn sync_rev(store: &ConversationStore, id: &str) -> i64 {
    store.sync_revisions().await.unwrap()[id]
}

#[tokio::test]
async fn sync_rev_changes_with_every_synced_field_and_never_repeats() {
    let store = ConversationStore::open_in_memory().unwrap();
    store
        .append_message("c1", "user", "hello", None, None, None)
        .await
        .unwrap();
    let after_append = sync_rev(&store, "c1").await;

    // A streamed reply rewritten in place does not touch `updated_at`, but it
    // is payload content, so the revision must move.
    let message_id: String = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT id FROM messages WHERE conversation_id = 'c1'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    store
        .update_message_content(&message_id, "hello, edited")
        .await
        .unwrap();
    let after_edit = sync_rev(&store, "c1").await;
    assert!(after_edit > after_append);

    store.set_title("c1", "Renamed").await.unwrap();
    let after_title = sync_rev(&store, "c1").await;
    assert!(after_title > after_edit);

    // A column the payload does not carry leaves the revision alone.
    {
        let conn = store.conn.lock().await;
        conn.execute("UPDATE conversations SET pinned = 1 WHERE id = 'c1'", [])
            .unwrap();
    }
    assert_eq!(sync_rev(&store, "c1").await, after_title);

    // Delete and recreate under the same id: the global sequence means the
    // new row can never collide with a revision recorded for the old one.
    store.delete_conversation("c1").await.unwrap();
    store
        .append_message("c1", "user", "again", None, None, None)
        .await
        .unwrap();
    assert!(sync_rev(&store, "c1").await > after_title);
}

#[test]
fn message_count_migration_backfills_existing_rows() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(
        "CREATE TABLE conversations (
                 id TEXT PRIMARY KEY, title TEXT, agent_id TEXT,
                 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
             );
             CREATE TABLE messages (
                 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL,
                 content TEXT NOT NULL, created_at INTEGER NOT NULL
             );
             INSERT INTO conversations (id, created_at, updated_at) VALUES ('old', 0, 0);
             INSERT INTO messages VALUES ('m1', 'old', 'user', 'a', 0);
             INSERT INTO messages VALUES ('m2', 'old', 'assistant', 'b', 1);",
    )
    .unwrap();
    ConversationStore::init_schema(&conn).unwrap();
    // Running the schema again must not double count or fail.
    ConversationStore::init_schema(&conn).unwrap();
    let count: i64 = conn
        .query_row(
            "SELECT message_count FROM conversations WHERE id = 'old'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}
