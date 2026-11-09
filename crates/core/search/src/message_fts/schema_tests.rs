//! Tests of opening the index: legacy files, older row formats and key changes.

use rusqlite::{params, Connection};

use super::tests::{contains, file_bytes, holds_token, key};
use super::*;

/// A plaintext index written by an older build is deleted on open (it is
/// rebuilt from the sealed messages), and a key change empties the index.
#[tokio::test]
async fn legacy_plaintext_files_and_foreign_keys_are_discarded() {
    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE fts_messages (rowid INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL,
                 conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE VIRTUAL TABLE message_fts USING fts5(body, content='');
             INSERT INTO fts_messages VALUES (1, 'm1', 'c1', 'user', 0);
             INSERT INTO message_fts (rowid, body) VALUES (1, 'zanzibar legacyword');",
        )
        .unwrap();
    }
    assert!(contains(&file_bytes(&path), "zanzibar"));
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(3)).unwrap();
    assert!(index.indexed_ids().await.unwrap().is_empty());
    assert!(!contains(&file_bytes(&path), "zanzibar"));
    index
        .index_message("m2", "c1", "user", "lantern", 0)
        .await
        .unwrap();
    drop(index);
    // Same key: rows survive a reopen.
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(3)).unwrap();
    assert_eq!(index.indexed_ids().await.unwrap().len(), 1);
    drop(index);
    // Different key: tokens are useless, so the index is emptied for a rebuild.
    let index = MessageFtsIndex::open_with_blind_index(path, key(4)).unwrap();
    assert!(index.indexed_ids().await.unwrap().is_empty());
}

/// An index in the older row format (a regular FTS5 table storing each
/// row's word-ordered token list) is dropped and rebuilt on open.
#[tokio::test]
async fn older_row_format_is_dropped_and_scrubbed() {
    let terms = key(6);
    let text = "falcon gazelle heron";
    let old_document = terms.fts_document(text);
    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE fts_messages (rowid INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL,
                 conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE VIRTUAL TABLE message_terms USING fts5(terms, detail=none, tokenize='ascii');
             INSERT INTO fts_messages VALUES (1, 'm1', 'c1', 'user', 0);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO fts_meta VALUES ('key_check', ?1)",
            params![terms.term_token(KEY_CHECK_INPUT)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message_terms (rowid, terms) VALUES (1, ?1)",
            params![old_document],
        )
        .unwrap();
    }
    assert!(contains(&file_bytes(&path), &old_document));
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(6)).unwrap();
    assert!(index.indexed_ids().await.unwrap().is_empty());
    assert!(!contains(&file_bytes(&path), &old_document));
    index
        .index_message("m1", "c1", "user", text, 0)
        .await
        .unwrap();
    drop(index);
    // The marker is recorded: a reopen keeps the rebuilt rows.
    let index = MessageFtsIndex::open_with_blind_index(path, key(6)).unwrap();
    assert_eq!(index.indexed_ids().await.unwrap().len(), 1);
}

/// The contentless format (v1) could only tombstone deletes, so its file
/// may still hold the postings of deleted messages: it is dropped and
/// rebuilt on open, and those tokens leave the file and the WAL.
#[tokio::test]
async fn contentless_format_with_tombstoned_postings_is_rebuilt() {
    let terms = key(9);
    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    let gone = terms.term_token("gerenuksix");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE fts_messages (rowid INTEGER PRIMARY KEY, message_id TEXT UNIQUE NOT NULL,
                 conversation_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
             CREATE TABLE fts_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO fts_meta VALUES ('doc_format', 'contentless-sorted-tokens-v1');
             CREATE VIRTUAL TABLE message_terms USING fts5(terms, content='',
                 contentless_delete=1, detail=none, tokenize='ascii');
             INSERT INTO fts_messages VALUES (1, 'm1', 'c1', 'user', 0);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO fts_meta VALUES ('key_check', ?1)",
            params![terms.term_token(KEY_CHECK_INPUT)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message_terms (rowid, terms) VALUES (1, ?1)",
            params![gone],
        )
        .unwrap();
        conn.execute_batch(
            "DELETE FROM message_terms WHERE rowid = 1;
             DELETE FROM fts_messages WHERE rowid = 1;",
        )
        .unwrap();
    }
    assert!(
        holds_token(&file_bytes(&path), &gone),
        "a contentless delete leaves the postings"
    );
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(9)).unwrap();
    assert!(!holds_token(&file_bytes(&path), &gone));
    index
        .index_message("m2", "c2", "user", "hyraxseven", 0)
        .await
        .unwrap();
    index.delete_conversation("c2").await.unwrap();
    assert!(!holds_token(
        &file_bytes(&path),
        &terms.term_token("hyraxseven")
    ));
}
