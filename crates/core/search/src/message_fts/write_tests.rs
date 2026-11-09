//! Tests of index writes: idempotence, deletes, clears and what reaches the file.

use super::tests::{contains, file_bytes, holds_token, index, key};
use super::*;

/// Re-indexing the same message id is idempotent (no duplicate rows).
#[tokio::test]
async fn reindex_is_idempotent() {
    let index = index();
    index
        .index_message("m1", "c1", "user", "hello world", 0)
        .await
        .expect("index");
    index
        .index_message("m1", "c1", "user", "hello world", 1)
        .await
        .expect("reindex");
    let ids = index.indexed_ids().await.expect("ids");
    assert_eq!(ids.len(), 1, "re-index must not duplicate the row");
    let hits = index.search("hello", 5, None).await.expect("search");
    assert_eq!(hits.len(), 1);
}

#[tokio::test]
async fn delete_conversation_and_clear_remove_rows() {
    let index = index();
    for (id, conv) in [("m1", "c1"), ("m2", "c1"), ("m3", "c2")] {
        index
            .index_message(id, conv, "user", "orchid greenhouse", 0)
            .await
            .unwrap();
    }
    assert_eq!(index.delete_conversation("c1").await.unwrap(), 2);
    let hits = index.search("orchid", 5, None).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].message_id, "m3");
    index
        .index_message("m4", "c3", "user", "orchid", 0)
        .await
        .unwrap();
    assert_eq!(index.delete_messages(&["m4".to_owned()]).await.unwrap(), 1);
    assert_eq!(index.search("orchid", 5, None).await.unwrap().len(), 1);
    index.clear().await.unwrap();
    assert!(index.indexed_ids().await.unwrap().is_empty());
    assert!(index.search("orchid", 5, None).await.unwrap().is_empty());
}

/// The file and its WAL hold blind tokens, never the words, and the token
/// of an indexed word is present (the blind index still finds the row).
#[tokio::test]
async fn words_never_reach_the_file_or_wal() {
    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(3)).unwrap();
    index
        .index_message("m1", "c1", "user", "quetzalcoatl xylophonist", 0)
        .await
        .unwrap();
    let bytes = file_bytes(&path);
    assert!(!contains(&bytes, "quetzalcoatl"));
    assert!(!contains(&bytes, "xylophonist"));
    assert!(contains(&bytes, &key(3).term_token("quetzalcoatl")));
    assert_eq!(
        index.search("Quetzalcoatl", 5, None).await.unwrap()[0].message_id,
        "m1"
    );
}

/// Deletes remove the postings themselves (FTS5 secure-delete), not just a
/// tombstone: a deleted message's blind tokens are absent from the file and
/// the WAL after a conversation delete, an orphan delete and a clear.
#[tokio::test]
async fn deleted_tokens_leave_the_file_and_wal() {
    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    let terms = key(6);
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(6)).unwrap();
    let docs = [
        ("m1", "c1", "aardvarkone"),
        ("m2", "c1", "bandicoottwo"),
        ("m3", "c2", "capybarathree"),
        ("m4", "c3", "dugongfour"),
    ];
    for (id, conversation, word) in docs {
        index
            .index_message(id, conversation, "user", word, 0)
            .await
            .unwrap();
    }
    let token = |word: &str| terms.term_token(word);
    let bytes = file_bytes(&path);
    for (_, _, word) in docs {
        assert!(holds_token(&bytes, &token(word)), "{word} indexed");
    }
    index.delete_conversation("c1").await.unwrap();
    index.delete_messages(&["m3".to_owned()]).await.unwrap();
    let bytes = file_bytes(&path);
    for word in ["aardvarkone", "bandicoottwo", "capybarathree"] {
        assert!(!holds_token(&bytes, &token(word)), "{word} must be purged");
    }
    assert!(holds_token(&bytes, &token("dugongfour")));
    assert_eq!(
        index.search("dugongfour", 5, None).await.unwrap()[0].message_id,
        "m4"
    );
    index.clear().await.unwrap();
    assert!(!holds_token(&file_bytes(&path), &token("dugongfour")));
    drop(index);

    // A key change empties the index the same way.
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(6)).unwrap();
    index
        .index_message("m5", "c5", "user", "echidnafive", 0)
        .await
        .unwrap();
    drop(index);
    assert!(holds_token(&file_bytes(&path), &token("echidnafive")));
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(8)).unwrap();
    assert!(index.indexed_ids().await.unwrap().is_empty());
    assert!(!holds_token(&file_bytes(&path), &token("echidnafive")));
}

/// A message whose content changes (a streamed reply checkpointed, then
/// completed) is re-indexed: the new text matches, the old does not, and the
/// old token is gone from the file and WAL.
#[tokio::test]
async fn reindexing_changed_content_replaces_the_old_tokens() {
    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    let terms = key(5);
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(5)).unwrap();
    index
        .index_message("m1", "c1", "assistant", "alphabravo", 1)
        .await
        .unwrap();
    index
        .index_message("m2", "c1", "assistant", "otherword", 2)
        .await
        .unwrap();
    assert!(holds_token(
        &file_bytes(&path),
        &terms.term_token("alphabravo")
    ));
    // Re-indexing the same content changes nothing.
    index
        .index_message("m1", "c1", "assistant", "alphabravo", 1)
        .await
        .unwrap();
    assert_eq!(index.search("alphabravo", 5, None).await.unwrap().len(), 1);
    index
        .index_message("m1", "c1", "assistant", "betacharlie", 1)
        .await
        .unwrap();
    assert!(index
        .search("alphabravo", 5, None)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        index.search("betacharlie", 5, None).await.unwrap()[0].message_id,
        "m1"
    );
    assert_eq!(index.indexed_ids().await.unwrap().len(), 2);
    let bytes = file_bytes(&path);
    assert!(!holds_token(&bytes, &terms.term_token("alphabravo")));
    assert!(holds_token(&bytes, &terms.term_token("betacharlie")));
    assert!(holds_token(&bytes, &terms.term_token("otherword")));
}

/// A row's tokens are sorted by token value (not by the words), so no
/// word-ordered token list reaches the file.
#[tokio::test]
async fn rows_store_no_word_ordered_token_list() {
    let terms = key(5);
    let text = "apple banana cherry damson elderberry";
    let document = blind_document(&terms, text);
    let tokens: Vec<&str> = document.split(' ').collect();
    let mut sorted = tokens.clone();
    sorted.sort_unstable();
    assert_eq!(tokens, sorted, "tokens must be in sorted hex order");
    assert_eq!(tokens.len(), 5);

    let dir = crate::test_dir::TestDir::new();
    let path = dir.path().join("message-fts.db");
    let index = MessageFtsIndex::open_with_blind_index(path.clone(), key(5)).unwrap();
    index
        .index_message("m1", "c1", "user", text, 0)
        .await
        .unwrap();
    let bytes = file_bytes(&path);
    // The word-ordered list an older build stored is absent; the row keeps
    // only the token-sorted list (what the inverted index maps anyway).
    assert!(!contains(&bytes, &terms.fts_document(text)));
    assert!(contains(&bytes, &document));
    assert_eq!(
        index.search("cherry", 5, None).await.unwrap()[0].message_id,
        "m1"
    );
    index.delete_messages(&["m1".to_owned()]).await.unwrap();
    assert!(index.search("cherry", 5, None).await.unwrap().is_empty());
}
