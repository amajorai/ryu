use super::*;
use crate::store::*;
use std::sync::atomic::AtomicU64 as Counter;

struct TestDir(PathBuf);

impl TestDir {
    fn new() -> Self {
        static NEXT: Counter = Counter::new(0);
        let path = std::env::temp_dir().join(format!(
            "ryu-rag-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const DIMS: usize = 64;

fn keys() -> RetrievalKeys {
    RetrievalKeys::from_root(&[21; 32])
}

fn open_file(path: &Path) -> RetrievalStore {
    RetrievalStore::open_with_keys(
        path.to_path_buf(),
        Embedder::Local { dims: DIMS },
        Reranker::Local,
        "reranker".to_owned(),
        None,
        keys(),
    )
    .unwrap()
}

fn file_bytes(path: &Path) -> Vec<u8> {
    let mut bytes = std::fs::read(path).unwrap_or_default();
    let mut wal = path.as_os_str().to_owned();
    wal.push("-wal");
    bytes.extend(std::fs::read(PathBuf::from(wal)).unwrap_or_default());
    bytes
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn bundle() -> ryu_knowledge::Bundle {
    let concept = ryu_knowledge::Concept::parse(
        "secret/zanzibar-plan.md",
        "---\ntype: Playbook\ntitle: Quetzal\ntags:\n- hushhush\nresource: https://example.invalid/r\n---\n\
         Marmalade ledger reconciliation. See [Other](/secret/other-note.md).\n",
    )
    .unwrap();
    ryu_knowledge::Bundle {
        root: PathBuf::from("/tmp/bundle"),
        concepts: vec![concept],
        index: None,
        log: None,
        okf_version: Some("0.1".to_owned()),
        warnings: Vec::new(),
    }
}

/// Content, vectors and OKF metadata are sealed on disk: none of the words,
/// paths or raw vector bytes reach the file or its WAL, the concept path's
/// blind token is there, and retrieval and export still work.
#[tokio::test]
async fn chunks_and_okf_rows_are_sealed_on_disk() {
    let dir = TestDir::new();
    let path = dir.0.join("retrieval.db");
    let store = open_file(&path);
    store
        .index_memory_chunk(
            "mem-1",
            "the vault combination is periwinkle",
            "user",
            None,
            "fact",
            3,
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    store
        .ingest_okf_bundle("b1", &bundle(), None)
        .await
        .unwrap();
    let vector = Embedder::Local { dims: DIMS }
        .embed("the vault combination is periwinkle")
        .await
        .unwrap();
    let bytes = file_bytes(&path);
    for word in [
        "periwinkle",
        "zanzibar",
        "Marmalade",
        "hushhush",
        "other-note",
        "example.invalid",
    ] {
        assert!(!contains(&bytes, word.as_bytes()), "{word} leaked");
    }
    let raw = encode_embedding(&vector);
    let probe = raw
        .chunks_exact(4)
        .position(|c| c != [0, 0, 0, 0])
        .map(|i| raw[i * 4..i * 4 + 8].to_vec())
        .unwrap();
    assert!(!contains(&bytes, &probe));
    let token = keys().concept_token("secret/zanzibar-plan.md");
    assert!(contains(&bytes, token.as_bytes()));
    {
        let conn = store.conn.lock().await;
        content_sqlite::assert_all_open(&conn, &keys().cipher, &seal_plans().unwrap()).unwrap();
    }

    let hits = store
        .retrieve("vault combination", &RetrievalOptions::default())
        .await
        .unwrap();
    assert!(hits[0].content.contains("periwinkle"));
    let concepts = store.reconstruct_okf_concepts("b1").await.unwrap();
    assert_eq!(concepts.len(), 1);
    assert_eq!(concepts[0].file_path, "secret/zanzibar-plan.md");
    assert_eq!(concepts[0].tags, vec!["hushhush".to_owned()]);
    assert_eq!(
        concepts[0].resource.as_deref(),
        Some("https://example.invalid/r")
    );
    assert!(concepts[0].body.contains("Marmalade"));
    let edges = store.okf_links("b1").await.unwrap();
    assert_eq!(edges[0].target, "/secret/other-note.md");
    // Re-ingest replaces by blind concept token.
    store
        .ingest_okf_bundle("b1", &bundle(), None)
        .await
        .unwrap();
    assert_eq!(store.reconstruct_okf_concepts("b1").await.unwrap().len(), 1);
}

/// A sealed value copied onto another row does not open there (AAD binds
/// the row id): the row is dropped from results and counted, never
/// returned empty, and an export skips it too.
#[tokio::test]
async fn a_value_swapped_to_another_row_does_not_open() {
    let store = RetrievalStore::open_in_memory_with_keys(
        Embedder::Local { dims: DIMS },
        "reranker".to_owned(),
        keys(),
    )
    .unwrap();
    for (id, text) in [("a", "amber lantern story"), ("b", "amber harbor story")] {
        store
            .index_chunk(
                id,
                ChunkSource::Memory,
                None,
                text,
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
    }
    store
        .ingest_okf_bundle("b1", &bundle(), None)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        let content: String = conn
            .query_row("SELECT content FROM chunks WHERE id = 'a'", [], |r| {
                r.get(0)
            })
            .unwrap();
        conn.execute("UPDATE chunks SET content = ?1 WHERE id = 'b'", [content])
            .unwrap();
        conn.execute(
            "UPDATE okf_chunks SET tags = (SELECT links FROM okf_chunks LIMIT 1)",
            [],
        )
        .unwrap();
    }
    let hits = store
        .retrieve("amber story", &RetrievalOptions::default())
        .await
        .unwrap();
    assert!(hits.iter().any(|hit| hit.id == "a"));
    assert!(
        !hits.iter().any(|hit| hit.id == "b"),
        "swapped content must not open"
    );
    assert!(store
        .reconstruct_okf_concepts("b1")
        .await
        .unwrap()
        .is_empty());
    assert!(store.unreadable_rows() >= 2);
}

/// A store written by an older build (plaintext content, vectors, OKF
/// metadata, and concept paths inside chunk ids) is migrated on open: every
/// value is sealed under its row (OKF rows under new blind ids), the
/// plaintext is gone from the file and WAL, legacy values read throughout,
/// and a second migration changes nothing.
#[tokio::test]
async fn legacy_plaintext_rows_are_sealed_and_still_read() {
    let dir = TestDir::new();
    let path = dir.0.join("retrieval.db");
    let embedder = Embedder::Local { dims: DIMS };
    let memory_vec = embedder.embed("legacy fact about cardamom").await.unwrap();
    let okf_vec = embedder
        .embed("Legacy okf body about saffron")
        .await
        .unwrap();
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE chunks (id TEXT PRIMARY KEY, source TEXT NOT NULL, space_id TEXT,
                 content TEXT NOT NULL, embedding BLOB NOT NULL,
                 embedding_model TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL);
             CREATE TABLE okf_chunks (chunk_id TEXT PRIMARY KEY, bundle_id TEXT NOT NULL,
                 concept_path TEXT NOT NULL, okf_type TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
                 resource TEXT, links TEXT NOT NULL DEFAULT '[]', chunk_index INTEGER NOT NULL);
             CREATE INDEX idx_okf_concept ON okf_chunks(bundle_id, concept_path);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (id, source, content, embedding, embedding_model, created_at)
             VALUES ('mem-legacy', 'memory', 'legacy fact about cardamom', ?1, 'local-hashing', 1)",
            params![encode_embedding(&memory_vec)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO chunks (id, source, space_id, content, embedding, embedding_model, created_at)
             VALUES ('okf:b9:legacy/saffron-notes.md#0', 'space', 'b9',
                     'Saffron [Note]\nLegacy okf body about saffron', ?1, 'local-hashing', 2)",
            params![encode_embedding(&okf_vec)],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO okf_chunks VALUES ('okf:b9:legacy/saffron-notes.md#0', 'b9',
                 'legacy/saffron-notes.md', 'Note', '[\"spicetag\"]', NULL, '[\"/legacy/x.md\"]', 0)",
            [],
        )
        .unwrap();
    }
    assert!(contains(&file_bytes(&path), b"cardamom"));

    let store = open_file(&path);
    {
        let conn = store.conn.lock().await;
        content_sqlite::assert_all_open(&conn, &keys().cipher, &seal_plans().unwrap()).unwrap();
        let ids: Vec<String> = conn
            .prepare("SELECT chunk_id FROM okf_chunks")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(ids.len(), 1);
        assert!(!ids[0].contains("saffron"));
    }
    let hits = store
        .retrieve(
            "cardamom fact",
            // Legacy memory rows predate the metadata-ready flag.
            &RetrievalOptions {
                include_sensitive: true,
                ..RetrievalOptions::default()
            },
        )
        .await
        .unwrap();
    let legacy = hits
        .iter()
        .find(|hit| hit.id == "mem-legacy")
        .expect("legacy memory row");
    assert!(legacy.content.contains("cardamom"));
    let concepts = store.reconstruct_okf_concepts("b9").await.unwrap();
    assert_eq!(concepts.len(), 1);
    assert_eq!(concepts[0].file_path, "legacy/saffron-notes.md");
    assert_eq!(concepts[0].tags, vec!["spicetag".to_owned()]);
    assert!(concepts[0].body.contains("saffron"));
    drop(store);

    let bytes = file_bytes(&path);
    for word in ["cardamom", "saffron", "spicetag", "/legacy/x.md"] {
        assert!(!contains(&bytes, word.as_bytes()), "{word} leaked");
    }
    // A second migration is a no-op.
    let report = RetrievalStore::migrate_file(&path, &keys()).unwrap();
    assert_eq!(report.sealed, 0);
    assert_eq!(report.unreadable, 0);
}

/// The stale-reindex compare-and-set compares the stored ciphertext: a
/// reseal of identical text (new nonce) counts as a change.
#[tokio::test]
async fn stale_reindex_compares_the_stored_ciphertext() {
    let store = RetrievalStore::open_in_memory_with_keys(
        Embedder::Local { dims: DIMS },
        "reranker".to_owned(),
        keys(),
    )
    .unwrap();
    store
        .index_chunk(
            "c1",
            ChunkSource::Memory,
            None,
            "same text",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let stored: String = conn
        .query_row("SELECT content FROM chunks WHERE id = 'c1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    conn.execute("UPDATE chunks SET embedding_model = 'old'", [])
        .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    let resealed = keys()
        .cipher
        .seal_text("same text", &content_context("c1"))
        .unwrap();
    assert_eq!(
        update_stale_embedding_if_unchanged(
            &tx,
            &keys().cipher,
            "c1",
            &resealed,
            &[1.0; DIMS],
            "m"
        )
        .unwrap(),
        0
    );
    assert_eq!(
        update_stale_embedding_if_unchanged(&tx, &keys().cipher, "c1", &stored, &[1.0; DIMS], "m")
            .unwrap(),
        1
    );
}

/// A store sealed under another key refuses writes and is never resealed.
#[tokio::test]
async fn a_foreign_key_refuses_writes() {
    let dir = TestDir::new();
    let path = dir.0.join("retrieval.db");
    let store = open_file(&path);
    store
        .index_chunk(
            "c1",
            ChunkSource::Memory,
            None,
            "first",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    drop(store);
    let foreign = RetrievalStore::open_unmigrated(
        path.clone(),
        Embedder::Local { dims: DIMS },
        Reranker::Local,
        "reranker".to_owned(),
        None,
        RetrievalKeys::from_root(&[1; 32]),
    )
    .unwrap();
    assert!(foreign
        .index_chunk(
            "c2",
            ChunkSource::Memory,
            None,
            "second",
            RetrievalOwner::shared()
        )
        .await
        .is_err());
    assert!(RetrievalStore::migrate_file(&path, &RetrievalKeys::from_root(&[1; 32])).is_err());
}
